import type {Step} from '@/lib/types';

// ---- 2. Token bucket in Redis -----------------------------------------------------------------------
export const tokenBucketStep: Step = {
  id: 'token-bucket',
  title: 'Per-key token bucket in one Lua round trip',
  concept: 'redis',
  file: 'rate_limit',
  focus: ['client', 'gateway', 'redis'],
  task: `## Task

Every request carries an \`X-API-Key\` header (\`anonymous\` when it is missing). Implement \`allow(api_key)\`
and the middleware that uses it, as a **token bucket** per key stored in Redis:

- State lives in the hash \`bucket:{api_key}\` with fields \`tokens\` and \`ts\` (last refill time).
- Refill **\`rate\` tokens per second** since \`ts\`, capped at **\`burst\`**; then take **one** token if there
  is one. Return whether the request is allowed and how many tokens remain.
- Read-refill-take-write must be **atomic**: put it in a **Lua script** (\`EVAL\`/\`EVALSHA\`) so two gateway
  instances hitting the same key cannot both see the last token.
- Allowed → pass the request through with \`X-RateLimit-Remaining\`. Denied → **429** with \`Retry-After\`
  (seconds until one token refills) and \`X-RateLimit-Remaining: 0\`.

:::widget token-bucket {"rate": 5, "burst": 10}

> \`GET\` then \`SET\` from the client is two round trips and a race. The script runs inside Redis, which
> executes one script at a time — that is what makes the bucket correct with many gateway replicas.`,
  sequence: {
    participants: ['Client', 'gateway', 'Redis'],
    messages: [
      {from: 'Client', to: 'gateway', label: 'GET /items/42 · X-API-Key: k1', kind: 'sync'},
      {from: 'gateway', to: 'Redis', label: 'EVALSHA bucket:k1 rate burst now', kind: 'sync'},
      {from: 'Redis', to: 'gateway', label: '{1, 7}  (allowed, remaining)', kind: 'reply'},
      {from: 'gateway', to: 'Client', label: '200 · X-RateLimit-Remaining: 7', kind: 'reply'},
      {from: 'gateway', to: 'Redis', label: 'EVALSHA bucket:k1 … (burst spent)', kind: 'sync'},
      {from: 'Redis', to: 'gateway', label: '{0, 0}', kind: 'reply'},
      {from: 'gateway', to: 'Client', label: '429 · Retry-After: 1', kind: 'reply'},
    ],
  },
  hints: [
    'The script receives the key in `KEYS[1]` and `rate`, `burst`, `now` in `ARGV`. It reads the two hash fields, computes the refill, writes both fields back, and returns a small table `{allowed, remaining}`.',
    'Refill is `tokens = min(burst, tokens + (now - ts) * rate)`; a missing hash means a full bucket (`tokens = burst`). Then `if tokens >= 1 then tokens = tokens - 1; allowed = 1 end`.',
    'Register/load the script once at start-up (`register_script`, `redis.NewScript`, `scriptLoad`, `script_load`) and call it per request. On deny, `Retry-After` is `ceil(1 / rate)` — the time one token takes to appear.',
  ],
  checks: [
    {
      id: 'key',
      title: 'One bucket per API key',
      detail: 'The Redis key must be `bucket:{api_key}` so each caller has its own budget.',
      match: {
        python: {all: [/f["']bucket:\{api_key\}["']/]},
        go: {all: [/"bucket:"\s*\+\s*apiKey|"bucket:%s"/]},
        scala: {all: [/s"bucket:\$\{?apiKey\}?"/]},
        cpp: {all: [/"bucket:"\s*\+\s*api_key/]},
      },
    },
    {
      id: 'atomic-lua',
      title: 'Refill and take happen atomically in a Lua script',
      detail:
        'The script must read the hash (`HMGET`/`HGET`), write it back (`HSET`) and be run with `EVAL`/`EVALSHA`; a client-side read-modify-write races between gateway replicas.',
      match: {
        python: {
          all: [
            /redis\.call\(\s*['"]HM?GET['"]/,
            /redis\.call\(\s*['"]HSET['"]/,
            /register_script\(|\.eval\(|\.evalsha\(/,
          ],
        },
        go: {
          all: [
            /redis\.call\(\s*['"]HM?GET['"]/,
            /redis\.call\(\s*['"]HSET['"]/,
            /redis\.NewScript\(|\.Eval\(|\.EvalSha\(/,
          ],
        },
        scala: {all: [/redis\.call\(\s*['"]HM?GET['"]/, /redis\.call\(\s*['"]HSET['"]/, /jedis\.eval(sha)?\(/]},
        cpp: {all: [/redis\.call\(\s*['"]HM?GET['"]/, /redis\.call\(\s*['"]HSET['"]/, /redis\.eval(sha)?[<(]/]},
      },
    },
    {
      id: 'refill-capped',
      title: 'Refills by elapsed time, capped at burst',
      detail:
        'Tokens grow by `(now - ts) * rate` and never exceed `burst`; without the cap an idle key could bank an unbounded burst.',
      match: {
        python: {all: [/math\.min\(\s*burst\s*,/, /\(\s*now\s*-\s*ts\s*\)\s*\*\s*rate/]},
        go: {all: [/math\.min\(\s*burst\s*,/, /\(\s*now\s*-\s*ts\s*\)\s*\*\s*rate/]},
        scala: {all: [/math\.min\(\s*burst\s*,/, /\(\s*now\s*-\s*ts\s*\)\s*\*\s*rate/]},
        cpp: {all: [/math\.min\(\s*burst\s*,/, /\(\s*now\s*-\s*ts\s*\)\s*\*\s*rate/]},
      },
    },
    {
      id: 'take-one',
      title: 'Takes exactly one token when available',
      detail: 'A request consumes one token only if `tokens >= 1`; a denied request must not push the bucket negative.',
      match: {
        python: {all: [/tokens\s*>=\s*1/, /tokens\s*-\s*1/]},
        go: {all: [/tokens\s*>=\s*1/, /tokens\s*-\s*1/]},
        scala: {all: [/tokens\s*>=\s*1/, /tokens\s*-\s*1/]},
        cpp: {all: [/tokens\s*>=\s*1/, /tokens\s*-\s*1/]},
      },
    },
    {
      id: 'deny-429',
      title: 'Denies with 429, Retry-After and X-RateLimit-Remaining',
      detail:
        'A denied request answers `429 Too Many Requests` with `Retry-After` and `X-RateLimit-Remaining` so well-behaved clients back off instead of hammering.',
      match: {
        python: {all: [/status_code\s*=\s*429|HTTP_429/, /Retry-After/i, /X-RateLimit-Remaining/i]},
        go: {all: [/http\.StatusTooManyRequests|\b429\b/, /Retry-After/i, /X-RateLimit-Remaining/i]},
        scala: {all: [/StatusCodes\.TooManyRequests|\b429\b/, /Retry-After/i, /X-RateLimit-Remaining/i]},
        cpp: {all: [/status\s*=\s*429/, /Retry-After/i, /X-RateLimit-Remaining/i]},
      },
    },
  ],
  code: {
    python: {
      starter: `import math
import time

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379)

RATE = 5  # tokens per second
BURST = 10  # bucket capacity

SCRIPT = ""  # TODO: Lua — HMGET tokens/ts, refill min(burst, tokens + (now - ts) * rate), take one, HSET, return {allowed, remaining}
take_token = r.register_script(SCRIPT)


def allow(api_key: str) -> tuple[bool, int]:
    """One atomic round trip: refill, take one token, report what is left."""
    key = ...  # TODO: bucket:{api_key}
    # TODO: run take_token with keys=[key], args=[RATE, BURST, time.time()]
    raise NotImplementedError


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    api_key = request.headers.get("x-api-key", "anonymous")
    # TODO: denied → 429 with Retry-After (ceil(1 / RATE)) and X-RateLimit-Remaining: 0
    # TODO: allowed → call_next, then X-RateLimit-Remaining on the response
    return await call_next(request)
`,
      solution: `import math
import time

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379)

RATE = 5  # tokens per second
BURST = 10  # bucket capacity

SCRIPT = """
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local rate, burst, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local tokens = tonumber(bucket[1]) or burst
local ts = tonumber(bucket[2]) or now
tokens = math.min(burst, tokens + (now - ts) * rate)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', KEYS[1], math.ceil(burst / rate) * 2)
return {allowed, math.floor(tokens)}
"""
take_token = r.register_script(SCRIPT)  # EVALSHA, with EVAL as fallback on NOSCRIPT


def allow(api_key: str) -> tuple[bool, int]:
    """One atomic round trip: refill, take one token, report what is left."""
    key = f"bucket:{api_key}"
    allowed, remaining = take_token(keys=[key], args=[RATE, BURST, time.time()])
    return bool(allowed), int(remaining)


@app.middleware("http")
async def rate_limit(request: Request, call_next):
    api_key = request.headers.get("x-api-key", "anonymous")
    allowed, remaining = allow(api_key)
    if not allowed:
        headers = {"Retry-After": str(math.ceil(1 / RATE)), "X-RateLimit-Remaining": "0"}
        return JSONResponse(status_code=429, content={"error": "rate limit exceeded"}, headers=headers)
    response = await call_next(request)
    response.headers["X-RateLimit-Remaining"] = str(remaining)
    return response
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	rate  = 5.0 // tokens per second
	burst = 10.0
)

// TODO: Lua — HMGET tokens/ts, refill min(burst, tokens + (now - ts) * rate), take one, HSET, return {allowed, remaining}
var takeToken = redis.NewScript(\`\`)

// allow refills the caller's bucket, takes one token and reports what is left — atomically.
func allow(ctx context.Context, apiKey string) (bool, int, error) {
	key := "" // TODO: bucket:{apiKey}
	now := float64(time.Now().UnixMicro()) / 1e6
	// TODO: takeToken.Run(ctx, rdb, []string{key}, rate, burst, now).Int64Slice()
	_, _ = key, now
	return true, 0, nil
}

func rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		apiKey := r.Header.Get("X-API-Key")
		if apiKey == "" {
			apiKey = "anonymous"
		}
		// TODO: denied → 429 with Retry-After (ceil(1 / rate)) and X-RateLimit-Remaining: 0
		// TODO: allowed → X-RateLimit-Remaining, then next
		_ = math.Ceil
		_ = strconv.Itoa
		next.ServeHTTP(rw, r)
	})
}
`,
      solution: `package main

import (
	"context"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	rate  = 5.0 // tokens per second
	burst = 10.0
)

// Run uses EVALSHA and falls back to EVAL once when the script is not loaded yet.
var takeToken = redis.NewScript(\`
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local rate, burst, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local tokens = tonumber(bucket[1]) or burst
local ts = tonumber(bucket[2]) or now
tokens = math.min(burst, tokens + (now - ts) * rate)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', KEYS[1], math.ceil(burst / rate) * 2)
return {allowed, math.floor(tokens)}
\`)

// allow refills the caller's bucket, takes one token and reports what is left — atomically.
func allow(ctx context.Context, apiKey string) (bool, int, error) {
	key := "bucket:" + apiKey
	now := float64(time.Now().UnixMicro()) / 1e6
	res, err := takeToken.Run(ctx, rdb, []string{key}, rate, burst, now).Int64Slice()
	if err != nil {
		return false, 0, err
	}
	return res[0] == 1, int(res[1]), nil
}

func rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		apiKey := r.Header.Get("X-API-Key")
		if apiKey == "" {
			apiKey = "anonymous"
		}
		allowed, remaining, err := allow(r.Context(), apiKey)
		if err != nil {
			next.ServeHTTP(rw, r) // fail open: a Redis outage must not take the gateway down with it
			return
		}
		rw.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
		if !allowed {
			rw.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(1/rate))))
			http.Error(rw, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(rw, r)
	})
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Directive0
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object RateLimit {
  val jedis = new JedisPooled("redis", 6379)

  val Rate = 5.0 // tokens per second
  val Burst = 10.0

  // TODO: Lua — HMGET tokens/ts, refill min(burst, tokens + (now - ts) * rate), take one, HSET, return {allowed, remaining}
  val Script: String = ""
  private val sha = jedis.scriptLoad(Script)

  /** One atomic round trip: refill, take one token, report what is left. */
  def allow(apiKey: String): (Boolean, Int) = {
    val key: String = ??? // TODO: bucket:{apiKey}
    val now = System.currentTimeMillis() / 1000.0
    // TODO: jedis.evalsha(sha, keys, args) → List[Long](allowed, remaining)
    (true, 0)
  }

  /** Wraps every route: pass with X-RateLimit-Remaining, or answer 429. */
  val rateLimited: Directive0 =
    optionalHeaderValueByName("X-API-Key").flatMap[Unit] { apiKey =>
      // TODO: denied → 429 with Retry-After (ceil(1 / Rate)) and X-RateLimit-Remaining: 0
      // TODO: allowed → respondWithHeader X-RateLimit-Remaining
      pass
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Directive0
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object RateLimit {
  val jedis = new JedisPooled("redis", 6379)

  val Rate = 5.0 // tokens per second
  val Burst = 10.0

  val Script: String =
    """local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
      |local rate, burst, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
      |local tokens = tonumber(bucket[1]) or burst
      |local ts = tonumber(bucket[2]) or now
      |tokens = math.min(burst, tokens + (now - ts) * rate)
      |local allowed = 0
      |if tokens >= 1 then
      |  tokens = tokens - 1
      |  allowed = 1
      |end
      |redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
      |redis.call('EXPIRE', KEYS[1], math.ceil(burst / rate) * 2)
      |return {allowed, math.floor(tokens)}
      |""".stripMargin
  private val sha = jedis.scriptLoad(Script)

  /** One atomic round trip: refill, take one token, report what is left. */
  def allow(apiKey: String): (Boolean, Int) = {
    val key = s"bucket:$apiKey"
    val now = System.currentTimeMillis() / 1000.0
    val args = List(Rate.toString, Burst.toString, now.toString).asJava
    val reply = jedis.evalsha(sha, List(key).asJava, args).asInstanceOf[java.util.List[java.lang.Long]].asScala
    (reply(0) == 1L, reply(1).toInt)
  }

  /** Wraps every route: pass with X-RateLimit-Remaining, or answer 429. */
  val rateLimited: Directive0 =
    optionalHeaderValueByName("X-API-Key").flatMap[Unit] { apiKey =>
      allow(apiKey.getOrElse("anonymous")) match {
        case (true, remaining) => respondWithHeader(RawHeader("X-RateLimit-Remaining", remaining.toString))
        case (false, _) =>
          val retryAfter = math.ceil(1 / Rate).toInt.toString
          val headers = List(RawHeader("Retry-After", retryAfter), RawHeader("X-RateLimit-Remaining", "0"))
          complete(HttpResponse(StatusCodes.TooManyRequests, headers = headers, entity = "rate limit exceeded"))
      }
    }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cmath>
#include <iterator>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr double kRate = 5.0;  // tokens per second
constexpr double kBurst = 10.0;

// TODO: Lua — HMGET tokens/ts, refill min(burst, tokens + (now - ts) * rate), take one, HSET, return {allowed, remaining}
const std::string kScript = "";
const std::string kScriptSha = redis.script_load(kScript);

struct Decision {
  bool allowed;
  int remaining;
};

// One atomic round trip: refill, take one token, report what is left.
Decision allow(const std::string& api_key) {
  const std::string key = "";  // TODO: bucket:{api_key}
  const double now = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  // TODO: redis.evalsha(kScriptSha, {key}, {rate, burst, now}, std::back_inserter(reply))
  return {true, 0};
}

// Registered with svr.set_pre_routing_handler: runs before every route.
httplib::Server::HandlerResponse rate_limit(const httplib::Request& req, httplib::Response& res) {
  const std::string api_key = req.has_header("X-API-Key") ? req.get_header_value("X-API-Key") : "anonymous";
  // TODO: denied → 429 with Retry-After (ceil(1 / kRate)) and X-RateLimit-Remaining: 0 → Handled
  // TODO: allowed → X-RateLimit-Remaining → Unhandled (continue to the route)
  return httplib::Server::HandlerResponse::Unhandled;
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cmath>
#include <iterator>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr double kRate = 5.0;  // tokens per second
constexpr double kBurst = 10.0;

const std::string kScript = R"lua(
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local rate, burst, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local tokens = tonumber(bucket[1]) or burst
local ts = tonumber(bucket[2]) or now
tokens = math.min(burst, tokens + (now - ts) * rate)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('EXPIRE', KEYS[1], math.ceil(burst / rate) * 2)
return {allowed, math.floor(tokens)}
)lua";
const std::string kScriptSha = redis.script_load(kScript);

struct Decision {
  bool allowed;
  int remaining;
};

// One atomic round trip: refill, take one token, report what is left.
Decision allow(const std::string& api_key) {
  const std::string key = "bucket:" + api_key;
  const double now = std::chrono::duration<double>(std::chrono::system_clock::now().time_since_epoch()).count();
  std::vector<long long> reply;
  redis.evalsha(kScriptSha, {key}, {std::to_string(kRate), std::to_string(kBurst), std::to_string(now)},
                std::back_inserter(reply));
  return {reply[0] == 1, static_cast<int>(reply[1])};
}

// Registered with svr.set_pre_routing_handler: runs before every route.
httplib::Server::HandlerResponse rate_limit(const httplib::Request& req, httplib::Response& res) {
  const std::string api_key = req.has_header("X-API-Key") ? req.get_header_value("X-API-Key") : "anonymous";
  const Decision decision = allow(api_key);
  res.set_header("X-RateLimit-Remaining", std::to_string(decision.remaining));
  if (!decision.allowed) {
    res.status = 429;
    res.set_header("Retry-After", std::to_string(static_cast<int>(std::ceil(1 / kRate))));
    res.set_content("rate limit exceeded", "text/plain");
    return httplib::Server::HandlerResponse::Handled;
  }
  return httplib::Server::HandlerResponse::Unhandled;
}
`,
    },
  },
  debrief: `A token bucket is two numbers and a clock, which is why it fits in a Redis hash and a dozen lines of Lua. Putting the refill and the take in the script is the whole point: Redis runs scripts one at a time, so every replica of the gateway shares one correct counter without a lock. The \`EXPIRE\` keeps idle keys from living forever, and \`Retry-After\` turns a rejection into advice. Real gateways add a per-route and a global bucket, fail open when Redis is unreachable, and pass \`now\` from the client (as here) rather than calling \`TIME\` inside the script so it stays deterministic under replication.`,
};
