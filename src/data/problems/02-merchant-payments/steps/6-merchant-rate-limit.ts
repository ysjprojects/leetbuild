import type {Step} from '@/lib/types';

// ---- 6. Per-merchant rate limit ------------------------------------------------------------------
export const merchantRateLimitStep: Step = {
  id: 'merchant-rate-limit',
  title: 'Limit each merchant to 100 checkouts a minute',
  concept: 'redis',
  file: 'rate_limiter',
  focus: ['checkout', 'redis'],
  task: `## Task

One merchant's runaway retry loop must not take checkout down for everyone else. Implement a
**fixed-window** limiter that runs before the handler; \`merchant_of(request)\` is provided and returns
the merchant id from the verified API key.

- The window is the current minute: key \`rl:{merchant}:{minute}\` with \`minute = now // 60\`.
- \`INCR\` the key. When the result is **1** the key is new: \`EXPIRE\` it to **120 s** so it disappears on its
  own one window later (an \`INCR\` without an expiry is a memory leak with a merchant id on it).
- Limit **100** per minute. Over it → **429 Too Many Requests** with **\`Retry-After\`** set to the seconds
  left in the window (\`60 - now % 60\`) and **\`X-RateLimit-Remaining: 0\`**.
- Under it, expose the remaining budget so the handler can send \`X-RateLimit-Remaining\` on the success
  response too.

:::widget token-bucket {"rate": 100, "burst": 100}

> A fixed window is the simplest limiter and it has one known flaw: 100 requests at 12:00:59 and 100 more at
> 12:01:00 are both allowed — 200 in two seconds. A token bucket (above) refills continuously and caps the
> burst instead; a sliding window counts the previous window at a fading weight. Fixed windows win on
> cost: one \`INCR\`, one key, no Lua.`,
  sequence: {
    participants: ['Merchant app', 'checkout', 'Redis'],
    messages: [
      {from: 'Merchant app', to: 'checkout', label: 'POST /checkout (merchant m42)', kind: 'sync'},
      {from: 'checkout', to: 'Redis', label: 'INCR rl:m42:29876543', kind: 'sync'},
      {from: 'Redis', to: 'checkout', label: '(integer) 1 → EXPIRE 120', kind: 'reply'},
      {from: 'checkout', to: 'Merchant app', label: '201 · X-RateLimit-Remaining: 99', kind: 'reply'},
      {from: 'Merchant app', to: 'checkout', label: 'POST /checkout (request 101 this minute)', kind: 'sync'},
      {from: 'checkout', to: 'Redis', label: 'INCR rl:m42:29876543 → 101', kind: 'sync'},
      {from: 'checkout', to: 'Merchant app', label: '429 · Retry-After: 17', kind: 'reply'},
    ],
  },
  hints: [
    'Compute `now` once as integer seconds; the minute is `now // 60` and the seconds left in the window are `60 - now % 60`. Both derive from the same `now` so they agree.',
    'INCR returns the new count, which is all you need: `== 1` means you created the key (set the expiry), `> 100` means reject. No GET, no read-modify-write.',
    'Remaining is `max(100 - count, 0)`: on the 101st request it is 0, not −1, and the header on the 429 says so.',
  ],
  checks: [
    {
      id: 'window-key',
      title: 'Keys the counter by merchant and minute',
      detail:
        'The key is `rl:{merchant}:{minute}` with the minute derived from the current time: one counter per merchant per window, and the next window starts from zero without any reset logic.',
      match: {
        python: {all: [/f["']rl:\{merchant\}:\{minute\}["']/, /now\s*\/\/\s*WINDOW_S/]},
        typescript: {all: [/`rl:\$\{merchant\}:\$\{minute\}`/, /Math\.floor\(\s*now\s*\/\s*WINDOW_S\s*\)/]},
        go: {all: [/"rl:%s:%d"/, /now\s*\/\s*windowSeconds/]},
        scala: {all: [/s"rl:\$merchant:\$minute"/, /now\s*\/\s*WindowSeconds/]},
        cpp: {all: [/"rl:"\s*\+\s*merchant\s*\+\s*":"\s*\+\s*std::to_string\(\s*minute\s*\)/, /now\s*\/\s*kWindow/]},
      },
    },
    {
      id: 'incr-expire',
      title: 'INCRs the counter and expires a new key',
      detail:
        'INCR is atomic and returns the count; when it returns 1 the key was just created and gets `EXPIRE 120` so it cleans itself up.',
      match: {
        python: {all: [/count == 1/], order: [/\br\.incr\(\s*\w+\s*\)/, /\.expire\(\s*\w+\s*,\s*KEY_TTL_S\s*\)/]},
        typescript: {
          all: [/count === 1/],
          order: [/\bredis\.incr\(\s*\w+\s*\)/, /\.expire\(\s*\w+\s*,\s*KEY_TTL_S\s*\)/],
        },
        go: {
          all: [/count == 1/],
          order: [/rdb\.Incr\(\s*[\w.()]+\s*,\s*\w+\s*\)/, /rdb\.Expire\(\s*[\w.()]+\s*,\s*\w+\s*,\s*keyTTL\s*\)/],
        },
        scala: {
          all: [/count == 1/],
          order: [/jedis\.incr\(\s*\w+\s*\)/, /jedis\.expire\(\s*\w+\s*,\s*KeyTtlSeconds\s*\)/],
        },
        cpp: {all: [/count == 1/], order: [/redis\.incr\(\s*\w+\s*\)/, /redis\.expire\(\s*\w+\s*,\s*kKeyTtl\s*\)/]},
      },
    },
    {
      id: 'too-many',
      title: 'Rejects the 101st request of the minute with 429',
      detail:
        'When the count is over the limit answer `429 Too Many Requests`; the limit is checked against the value INCR returned, not a separate read.',
      match: {
        python: {all: [/count > LIMIT/, /status_code\s*=\s*429|HTTP_429/]},
        typescript: {all: [/count > LIMIT/, /code\(\s*429\s*\)|status\(\s*429\s*\)/]},
        go: {all: [/count > limit/, /http\.StatusTooManyRequests|\b429\b/]},
        scala: {all: [/count > Limit/, /StatusCodes\.TooManyRequests|\b429\b/]},
        cpp: {all: [/count > kLimit/, /status\s*=\s*429/]},
      },
    },
    {
      id: 'headers',
      title: 'Tells the client when to retry and how much is left',
      detail:
        '`Retry-After` carries the seconds until the window ends and `X-RateLimit-Remaining` the budget left; without them a well-behaved client can only guess.',
      match: {
        python: {all: [/Retry-After/, /WINDOW_S\s*-\s*now\s*%\s*WINDOW_S/, /X-RateLimit-Remaining/]},
        typescript: {all: [/Retry-After/, /WINDOW_S\s*-\s*\(?\s*now\s*%\s*WINDOW_S\s*\)?/, /X-RateLimit-Remaining/]},
        go: {all: [/Retry-After/, /windowSeconds\s*-\s*now\s*%\s*windowSeconds/, /X-RateLimit-Remaining/]},
        scala: {all: [/Retry-After/, /WindowSeconds\s*-\s*now\s*%\s*WindowSeconds/, /X-RateLimit-Remaining/]},
        cpp: {all: [/Retry-After/, /kWindow\s*-\s*now\s*%\s*kWindow/, /X-RateLimit-Remaining/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis
from fastapi import Depends, FastAPI, HTTPException, Request, Response

app = FastAPI()
r = redis.Redis(host="redis", port=6379)

LIMIT = 100  # requests per merchant per minute
WINDOW_S = 60
KEY_TTL_S = 120  # the key outlives its window by one more, then disappears on its own


def merchant_of(request: Request) -> str:
    """Merchant id from the verified API key (authentication is provided)."""
    return request.state.merchant_id


def rate_limit(request: Request) -> int:
    """Dependency: raises 429 when the merchant is over LIMIT this minute; returns the remaining budget."""
    merchant = merchant_of(request)
    now = int(time.time())
    # TODO: key rl:{merchant}:{minute}; INCR it; EXPIRE KEY_TTL_S when the count is 1
    # TODO: count > LIMIT → 429 with Retry-After (seconds left in the window) and X-RateLimit-Remaining: 0
    # TODO: return max(LIMIT - count, 0)
    raise NotImplementedError


@app.post("/checkout")
async def checkout(response: Response, remaining: int = Depends(rate_limit)) -> dict:
    response.headers["X-RateLimit-Remaining"] = str(remaining)
    return {"status": "ok"}  # the real handler is step 1
`,
      solution: `import time

import redis
from fastapi import Depends, FastAPI, HTTPException, Request, Response

app = FastAPI()
r = redis.Redis(host="redis", port=6379)

LIMIT = 100  # requests per merchant per minute
WINDOW_S = 60
KEY_TTL_S = 120  # the key outlives its window by one more, then disappears on its own


def merchant_of(request: Request) -> str:
    """Merchant id from the verified API key (authentication is provided)."""
    return request.state.merchant_id


def rate_limit(request: Request) -> int:
    """Dependency: raises 429 when the merchant is over LIMIT this minute; returns the remaining budget."""
    merchant = merchant_of(request)
    now = int(time.time())
    minute = now // WINDOW_S
    key = f"rl:{merchant}:{minute}"
    count = r.incr(key)
    if count == 1:
        r.expire(key, KEY_TTL_S)  # a brand-new window: make the key clean itself up
    if count > LIMIT:
        retry_after = WINDOW_S - now % WINDOW_S
        raise HTTPException(
            status_code=429,
            detail="rate limit exceeded",
            headers={"Retry-After": str(retry_after), "X-RateLimit-Remaining": "0"},
        )
    return max(LIMIT - count, 0)


@app.post("/checkout")
async def checkout(response: Response, remaining: int = Depends(rate_limit)) -> dict:
    response.headers["X-RateLimit-Remaining"] = str(remaining)
    return {"status": "ok"}  # the real handler is step 1
`,
    },
    typescript: {
      starter: `import Fastify, {type FastifyReply, type FastifyRequest} from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const LIMIT = 100; // requests per merchant per minute
export const WINDOW_S = 60;
export const KEY_TTL_S = 120; // the key outlives its window by one more, then disappears on its own

/** Merchant id from the verified API key (authentication is provided). */
export const auth = {
  merchantOf(request: FastifyRequest): string {
    return (request as FastifyRequest & {merchantId: string}).merchantId;
  },
};

/** preHandler: answers 429 when the merchant is over LIMIT this minute; otherwise sets X-RateLimit-Remaining. */
export async function rateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const merchant = auth.merchantOf(request);
  const now = Math.floor(Date.now() / 1000);
  // TODO: key rl:{merchant}:{minute}; INCR it; EXPIRE KEY_TTL_S when the count is 1
  // TODO: count > LIMIT → 429 with Retry-After (seconds left in the window) and X-RateLimit-Remaining: 0
  // TODO: otherwise reply.header('X-RateLimit-Remaining', max(LIMIT - count, 0)) for the handler's response
  void merchant;
  void now;
  throw new Error('not implemented');
}

app.post('/checkout', {preHandler: rateLimit}, async () => ({status: 'ok'})); // the real handler is step 1

// app.listen({port: 8443, https: {cert, key}})
`,
      solution: `import Fastify, {type FastifyReply, type FastifyRequest} from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const LIMIT = 100; // requests per merchant per minute
export const WINDOW_S = 60;
export const KEY_TTL_S = 120; // the key outlives its window by one more, then disappears on its own

/** Merchant id from the verified API key (authentication is provided). */
export const auth = {
  merchantOf(request: FastifyRequest): string {
    return (request as FastifyRequest & {merchantId: string}).merchantId;
  },
};

/** preHandler: answers 429 when the merchant is over LIMIT this minute; otherwise sets X-RateLimit-Remaining. */
export async function rateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const merchant = auth.merchantOf(request);
  const now = Math.floor(Date.now() / 1000);
  const minute = Math.floor(now / WINDOW_S);
  const key = \`rl:\${merchant}:\${minute}\`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, KEY_TTL_S); // a brand-new window: make the key clean itself up
  }
  if (count > LIMIT) {
    const retryAfter = WINDOW_S - (now % WINDOW_S);
    reply.header('Retry-After', String(retryAfter)).header('X-RateLimit-Remaining', '0');
    await reply.code(429).send({error: 'rate limit exceeded'});
    return;
  }
  reply.header('X-RateLimit-Remaining', String(Math.max(LIMIT - count, 0)));
}

app.post('/checkout', {preHandler: rateLimit}, async () => ({status: 'ok'})); // the real handler is step 1

// app.listen({port: 8443, https: {cert, key}})
`,
    },
    go: {
      starter: `package main

import (
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	limit         int64 = 100 // requests per merchant per minute
	windowSeconds int64 = 60
	keyTTL              = 120 * time.Second // the key outlives its window by one more, then disappears on its own
)

// merchantOf returns the merchant id from the verified API key (authentication is provided).
var merchantOf = func(r *http.Request) string {
	return r.Context().Value(merchantKey{}).(string)
}

type merchantKey struct{}

// checkout is the checkout handler (built in step 1).
var checkout = func(rw http.ResponseWriter, r *http.Request) { panic("not implemented") }

// rateLimit rejects a merchant's requests with 429 once it is over limit this minute.
func rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		merchant := merchantOf(r)
		now := time.Now().Unix()
		// TODO: key rl:{merchant}:{minute}; Incr it; Expire keyTTL when the count is 1
		// TODO: X-RateLimit-Remaining: max(limit - count, 0) on every response
		// TODO: count > limit → 429 with Retry-After = seconds left in the window
		_, _ = merchant, now
		_ = fmt.Sprintf
		_ = strconv.FormatInt
		next.ServeHTTP(rw, r)
	})
}

func main() {
	mux := http.NewServeMux()
	mux.Handle("POST /checkout", rateLimit(http.HandlerFunc(checkout))) // checkout is step 1
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"fmt"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	limit         int64 = 100 // requests per merchant per minute
	windowSeconds int64 = 60
	keyTTL              = 120 * time.Second // the key outlives its window by one more, then disappears on its own
)

// merchantOf returns the merchant id from the verified API key (authentication is provided).
var merchantOf = func(r *http.Request) string {
	return r.Context().Value(merchantKey{}).(string)
}

type merchantKey struct{}

// checkout is the checkout handler (built in step 1).
var checkout = func(rw http.ResponseWriter, r *http.Request) { panic("not implemented") }

// rateLimit rejects a merchant's requests with 429 once it is over limit this minute.
func rateLimit(next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		merchant := merchantOf(r)
		now := time.Now().Unix()
		minute := now / windowSeconds
		key := fmt.Sprintf("rl:%s:%d", merchant, minute)
		ctx := r.Context()
		count, err := rdb.Incr(ctx, key).Result()
		if err != nil {
			next.ServeHTTP(rw, r) // fail open: a Redis outage must not take checkout down
			return
		}
		if count == 1 {
			rdb.Expire(ctx, key, keyTTL) // a brand-new window: make the key clean itself up
		}
		rw.Header().Set("X-RateLimit-Remaining", strconv.FormatInt(max(limit-count, 0), 10))
		if count > limit {
			rw.Header().Set("Retry-After", strconv.FormatInt(windowSeconds-now%windowSeconds, 10))
			http.Error(rw, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(rw, r)
	})
}

func main() {
	mux := http.NewServeMux()
	mux.Handle("POST /checkout", rateLimit(http.HandlerFunc(checkout))) // checkout is step 1
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.{Directive0, Directive1, Route}
import redis.clients.jedis.JedisPooled

object RateLimiter {
  val jedis = new JedisPooled("redis", 6379)

  val Limit = 100L // requests per merchant per minute
  val WindowSeconds = 60L
  val KeyTtlSeconds = 120L // the key outlives its window by one more, then disappears on its own

  /** Merchant id from the verified API key (authentication is provided). */
  def merchantOf: Directive1[String] = ???

  /** Rejects a merchant's requests with 429 once it is over Limit this minute. */
  def rateLimited(merchant: String): Directive0 = {
    val now = System.currentTimeMillis() / 1000
    // TODO: key rl:{merchant}:{minute}; incr it; expire KeyTtlSeconds when the count is 1
    // TODO: count > Limit → complete 429 with Retry-After (seconds left in the window) and X-RateLimit-Remaining: 0
    // TODO: otherwise respondWithHeader X-RateLimit-Remaining: max(Limit - count, 0)
    pass
  }

  val route: Route =
    path("checkout") {
      post {
        merchantOf { merchant =>
          rateLimited(merchant) {
            complete(StatusCodes.Created -> """{"status":"ok"}""") // the real handler is step 1
          }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.{Directive0, Directive1, Route}
import redis.clients.jedis.JedisPooled

object RateLimiter {
  val jedis = new JedisPooled("redis", 6379)

  val Limit = 100L // requests per merchant per minute
  val WindowSeconds = 60L
  val KeyTtlSeconds = 120L // the key outlives its window by one more, then disappears on its own

  /** Merchant id from the verified API key (authentication is provided). */
  def merchantOf: Directive1[String] = ???

  /** Rejects a merchant's requests with 429 once it is over Limit this minute. */
  def rateLimited(merchant: String): Directive0 = {
    val now = System.currentTimeMillis() / 1000
    val minute = now / WindowSeconds
    val key = s"rl:$merchant:$minute"
    val count: Long = jedis.incr(key)
    if (count == 1) jedis.expire(key, KeyTtlSeconds) // a brand-new window: make the key clean itself up
    val remaining = math.max(Limit - count, 0L)
    if (count > Limit) {
      val retryAfter = WindowSeconds - now % WindowSeconds
      complete(
        HttpResponse(
          StatusCodes.TooManyRequests,
          headers = List(RawHeader("Retry-After", retryAfter.toString), RawHeader("X-RateLimit-Remaining", "0")),
          entity = "rate limit exceeded"))
    } else respondWithHeader(RawHeader("X-RateLimit-Remaining", remaining.toString))
  }

  val route: Route =
    path("checkout") {
      post {
        merchantOf { merchant =>
          rateLimited(merchant) {
            complete(StatusCodes.Created -> """{"status":"ok"}""") // the real handler is step 1
          }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kLimit = 100;  // requests per merchant per minute
constexpr long long kWindow = 60;
constexpr std::chrono::seconds kKeyTtl{120};  // the key outlives its window by one more, then disappears on its own

// Merchant id from the verified API key (authentication is provided).
std::string merchant_of(const httplib::Request& req);

// Rejects a merchant's requests with 429 once it is over kLimit this minute.
httplib::Server::HandlerResponse rate_limit(const httplib::Request& req, httplib::Response& res) {
  const std::string merchant = merchant_of(req);
  const long long now =
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  // TODO: key rl:{merchant}:{minute}; incr it; expire kKeyTtl when the count is 1
  // TODO: X-RateLimit-Remaining: max(kLimit - count, 0) on every response
  // TODO: count > kLimit → 429 with Retry-After = seconds left in the window; return Handled
  (void)merchant;
  (void)now;
  return httplib::Server::HandlerResponse::Unhandled;
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");
  svr.set_pre_routing_handler(rate_limit);
  svr.Post("/checkout", [](const httplib::Request&, httplib::Response& res) {
    res.status = 201;
    res.set_content("{\\"status\\":\\"ok\\"}", "application/json");  // the real handler is step 1
  });
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#define CPPHTTPLIB_OPENSSL_SUPPORT
#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kLimit = 100;  // requests per merchant per minute
constexpr long long kWindow = 60;
constexpr std::chrono::seconds kKeyTtl{120};  // the key outlives its window by one more, then disappears on its own

// Merchant id from the verified API key (authentication is provided).
std::string merchant_of(const httplib::Request& req);

// Rejects a merchant's requests with 429 once it is over kLimit this minute.
httplib::Server::HandlerResponse rate_limit(const httplib::Request& req, httplib::Response& res) {
  const std::string merchant = merchant_of(req);
  const long long now =
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long long minute = now / kWindow;
  const std::string key = "rl:" + merchant + ":" + std::to_string(minute);
  const long long count = redis.incr(key);
  if (count == 1) redis.expire(key, kKeyTtl);  // a brand-new window: make the key clean itself up
  res.set_header("X-RateLimit-Remaining", std::to_string(std::max(kLimit - count, 0LL)));
  if (count > kLimit) {
    res.set_header("Retry-After", std::to_string(kWindow - now % kWindow));
    res.status = 429;
    res.set_content("rate limit exceeded", "text/plain");
    return httplib::Server::HandlerResponse::Handled;
  }
  return httplib::Server::HandlerResponse::Unhandled;
}

int main() {
  httplib::SSLServer svr("cert.pem", "key.pem");
  svr.set_pre_routing_handler(rate_limit);
  svr.Post("/checkout", [](const httplib::Request&, httplib::Response& res) {
    res.status = 201;
    res.set_content("{\\"status\\":\\"ok\\"}", "application/json");  // the real handler is step 1
  });
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import time


def _app(ctx):
    m = ctx.load("rate_limiter")
    m.merchant_of = lambda request: request.headers.get("x-merchant", "m42")  # authentication is provided
    return m


def _at(ctx, second):
    """Move the clock so the current minute is at :second (plus half a second); returns int(time.time())."""
    now = time.time()
    target = int(now) - int(now) % 60 + second + 0.5
    if target < now:
        target += 60
    ctx.clock.advance(target - now)
    return int(time.time())


async def _post(c, merchant="m42"):
    return await c.post("/checkout", headers={"X-Merchant": merchant})


async def check_window_key(ctx):
    m = _app(ctx)
    now = _at(ctx, 5)
    minute = now // 60
    async with ctx.client(m.app) as c:
        r = await _post(c)
        assert r.status_code == 200, f"the first request of the minute answered {r.status_code}"
        key = f"rl:m42:{minute}"
        assert ctx.redis.get(key) == "1", f"after one request {key} is {ctx.redis.get(key)!r}, expected '1' (keys: {ctx.redis.keys('rl:*')})"
        await _post(c, "m7")
        assert ctx.redis.get(f"rl:m7:{minute}") == "1", "each merchant has its own counter"
        assert ctx.redis.get(key) == "1", "another merchant's request must not count against m42"
        ctx.clock.advance(60)
        await _post(c)
    assert ctx.redis.get(f"rl:m42:{minute + 1}") == "1", f"a minute later the counter must live under rl:m42:{minute + 1} (keys: {ctx.redis.keys('rl:*')})"
    assert ctx.redis.get(key) == "1", "the previous window's counter is left alone: the key name is the window"


async def check_incr_expire(ctx):
    m = _app(ctx)
    now = _at(ctx, 5)
    key = f"rl:m42:{now // 60}"
    async with ctx.client(m.app) as c:
        for _ in range(3):
            await _post(c)
        assert ctx.redis.get(key) == "3", f"after three requests {key} is {ctx.redis.get(key)!r}, expected '3'"
        ttl = ctx.redis.ttl(key)
        assert 110 <= ttl <= 120, f"{key} has TTL {ttl}, expected 120 s set when the key was created"
        ctx.clock.advance(30)
        await _post(c)
        ttl = ctx.redis.ttl(key)
        assert 80 <= ttl <= 90, f"30 s later {key} has TTL {ttl}: the expiry is set once, when INCR returns 1, not on every request"
        ctx.clock.advance(100)
    assert not ctx.redis.exists(key), f"{key} must have expired 120 s after it was created"


async def check_too_many(ctx):
    m = _app(ctx)
    now = _at(ctx, 5)
    ctx.redis.set(f"rl:m42:{now // 60}", 98)  # 98 checkouts already this minute
    async with ctx.client(m.app) as c:
        r99 = await _post(c)
        r100 = await _post(c)
        r101 = await _post(c)
        r102 = await _post(c)
        other = await _post(c, "m7")
        ctx.clock.advance(60)
        later = await _post(c)
    assert r99.status_code == 200 and r100.status_code == 200, f"requests 99 and 100 are within the limit, got {r99.status_code} and {r100.status_code}"
    assert r101.status_code == 429, f"the 101st request of the minute answered {r101.status_code}, expected 429"
    assert r102.status_code == 429, f"the 102nd request answered {r102.status_code}, expected 429 for the rest of the window"
    assert other.status_code == 200, "one merchant over its limit must not block another"
    assert later.status_code == 200, f"in the next minute the merchant is allowed again, got {later.status_code}"


async def check_headers(ctx):
    m = _app(ctx)
    now = _at(ctx, 43)
    ctx.redis.set(f"rl:m42:{now // 60}", 99)
    async with ctx.client(m.app) as c:
        last_ok = await _post(c)
        over = await _post(c)
        fresh = await _post(c, "m7")
    assert over.status_code == 429
    assert over.headers.get("retry-after") == "17", f"at :43 the 429 must say Retry-After: 17 (seconds left in the window), got {over.headers.get('retry-after')!r}"
    assert over.headers.get("x-ratelimit-remaining") == "0", f"the 429 must carry X-RateLimit-Remaining: 0, got {over.headers.get('x-ratelimit-remaining')!r}"
    assert last_ok.status_code == 200 and last_ok.headers.get("x-ratelimit-remaining") == "0", f"the 100th request is allowed with X-RateLimit-Remaining: 0, got {last_ok.status_code} / {last_ok.headers.get('x-ratelimit-remaining')!r}"
    assert fresh.status_code == 200 and fresh.headers.get("x-ratelimit-remaining") == "99", f"a merchant's first request leaves 99, got X-RateLimit-Remaining {fresh.headers.get('x-ratelimit-remaining')!r}"
`,
    typescript: `/** The learner's app with the provided authentication swapped for the X-Merchant header. */
function api(ctx) {
  const m = ctx.load('rate_limiter');
  m.auth.merchantOf = request => request.headers['x-merchant'] ?? 'm42';
  return m;
}

/** Moves the clock so the current minute is at :second (plus half a second); returns the integer seconds now. */
function at(ctx, second: number): number {
  const now = Date.now() / 1000;
  let target = Math.floor(now) - (Math.floor(now) % 60) + second + 0.5;
  if (target < now) target += 60;
  ctx.clock.advance(target - now);
  return Math.floor(Date.now() / 1000);
}

const post = (c, merchant = 'm42') => c.post('/checkout', {headers: {'X-Merchant': merchant}});

export async function check_window_key(ctx) {
  const m = api(ctx);
  const now = at(ctx, 5);
  const minute = Math.floor(now / 60);
  const c = ctx.client(m.app);
  const r = await post(c);
  assert.equal(r.status, 200, \`the first request of the minute answered \${r.status}\`);
  const key = \`rl:m42:\${minute}\`;
  assert.equal(ctx.redis.get(key), '1', \`after one request \${key} is \${JSON.stringify(ctx.redis.get(key))}, expected '1' (keys: \${JSON.stringify(ctx.redis.keys('rl:*'))})\`);
  await post(c, 'm7');
  assert.equal(ctx.redis.get(\`rl:m7:\${minute}\`), '1', 'each merchant has its own counter');
  assert.equal(ctx.redis.get(key), '1', "another merchant's request must not count against m42");
  ctx.clock.advance(60);
  await post(c);
  assert.equal(ctx.redis.get(\`rl:m42:\${minute + 1}\`), '1', \`a minute later the counter must live under rl:m42:\${minute + 1} (keys: \${JSON.stringify(ctx.redis.keys('rl:*'))})\`);
  assert.equal(ctx.redis.get(key), '1', "the previous window's counter is left alone: the key name is the window");
}

export async function check_incr_expire(ctx) {
  const m = api(ctx);
  const now = at(ctx, 5);
  const key = \`rl:m42:\${Math.floor(now / 60)}\`;
  const c = ctx.client(m.app);
  for (let i = 0; i < 3; i++) await post(c);
  assert.equal(ctx.redis.get(key), '3', \`after three requests \${key} is \${JSON.stringify(ctx.redis.get(key))}, expected '3'\`);
  let ttl = ctx.redis.ttl(key);
  assert(110 <= ttl && ttl <= 120, \`\${key} has TTL \${ttl}, expected 120 s set when the key was created\`);
  ctx.clock.advance(30);
  await post(c);
  ttl = ctx.redis.ttl(key);
  assert(80 <= ttl && ttl <= 90, \`30 s later \${key} has TTL \${ttl}: the expiry is set once, when INCR returns 1, not on every request\`);
  ctx.clock.advance(100);
  assert(!ctx.redis.exists(key), \`\${key} must have expired 120 s after it was created\`);
}

export async function check_too_many(ctx) {
  const m = api(ctx);
  const now = at(ctx, 5);
  ctx.redis.set(\`rl:m42:\${Math.floor(now / 60)}\`, 98); // 98 checkouts already this minute
  const c = ctx.client(m.app);
  const r99 = await post(c);
  const r100 = await post(c);
  const r101 = await post(c);
  const r102 = await post(c);
  const other = await post(c, 'm7');
  ctx.clock.advance(60);
  const later = await post(c);
  assert(r99.status === 200 && r100.status === 200, \`requests 99 and 100 are within the limit, got \${r99.status} and \${r100.status}\`);
  assert.equal(r101.status, 429, \`the 101st request of the minute answered \${r101.status}, expected 429\`);
  assert.equal(r102.status, 429, \`the 102nd request answered \${r102.status}, expected 429 for the rest of the window\`);
  assert.equal(other.status, 200, 'one merchant over its limit must not block another');
  assert.equal(later.status, 200, \`in the next minute the merchant is allowed again, got \${later.status}\`);
}

export async function check_headers(ctx) {
  const m = api(ctx);
  const now = at(ctx, 43);
  ctx.redis.set(\`rl:m42:\${Math.floor(now / 60)}\`, 99);
  const c = ctx.client(m.app);
  const lastOk = await post(c);
  const over = await post(c);
  const fresh = await post(c, 'm7');
  assert.equal(over.status, 429, \`the 101st request answered \${over.status}, expected 429\`);
  assert.equal(over.headers['retry-after'], '17', \`at :43 the 429 must say Retry-After: 17 (seconds left in the window), got \${JSON.stringify(over.headers['retry-after'])}\`);
  assert.equal(over.headers['x-ratelimit-remaining'], '0', \`the 429 must carry X-RateLimit-Remaining: 0, got \${JSON.stringify(over.headers['x-ratelimit-remaining'])}\`);
  assert(lastOk.status === 200 && lastOk.headers['x-ratelimit-remaining'] === '0', \`the 100th request is allowed with X-RateLimit-Remaining: 0, got \${lastOk.status} / \${JSON.stringify(lastOk.headers['x-ratelimit-remaining'])}\`);
  assert(fresh.status === 200 && fresh.headers['x-ratelimit-remaining'] === '99', \`a merchant's first request leaves 99, got X-RateLimit-Remaining \${JSON.stringify(fresh.headers['x-ratelimit-remaining'])}\`);
}
`,
    go: `package main

import (
	"fmt"
	"math"
	"net/http"

	"leetbuild/harness"
)

// limitedAPI is the learner's server with the provided authentication swapped for the X-Merchant
// header, and step 1's checkout for a plain 200.
func limitedAPI(ctx *harness.Ctx) *harness.HTTP {
	merchantOf = func(r *http.Request) string {
		if m := r.Header.Get("X-Merchant"); m != "" {
			return m
		}
		return "m42"
	}
	checkout = func(rw http.ResponseWriter, r *http.Request) {
		rw.Header().Set("Content-Type", "application/json")
		fmt.Fprint(rw, \`{"status":"ok"}\`)
	}
	return ctx.Main(main).HTTP()
}

// minuteAt moves the clock so the current minute is at :second (plus half a second); returns the integer seconds now.
func minuteAt(ctx *harness.Ctx, second float64) int64 {
	now := float64(ctx.Clock.Now()) / 1000
	target := math.Floor(now) - math.Mod(math.Floor(now), 60) + second + 0.5
	if target < now {
		target += 60
	}
	ctx.Clock.Advance(target - now)
	return ctx.Clock.Now() / 1000
}

func merchantPost(c *harness.HTTP, merchant string) *harness.Response {
	return c.Post("/checkout", nil, "X-Merchant", merchant)
}

func counter(ctx *harness.Ctx, key string) any {
	if v, ok := ctx.Redis.Get(key); ok {
		return v
	}
	return nil
}

func CheckWindowKey(ctx *harness.Ctx) {
	c := limitedAPI(ctx)
	now := minuteAt(ctx, 5)
	minute := now / 60
	r := merchantPost(c, "m42")
	ctx.Equal(r.Status, 200, "the first request of the minute")
	key := fmt.Sprintf("rl:m42:%d", minute)
	ctx.Equal(counter(ctx, key), "1", "after one request %s (keys: %v)", key, ctx.Redis.Keys("rl:*"))
	merchantPost(c, "m7")
	ctx.Equal(counter(ctx, fmt.Sprintf("rl:m7:%d", minute)), "1", "each merchant has its own counter")
	ctx.Equal(counter(ctx, key), "1", "another merchant's request must not count against m42")
	ctx.Clock.Advance(60)
	merchantPost(c, "m42")
	ctx.Equal(counter(ctx, fmt.Sprintf("rl:m42:%d", minute+1)), "1", "a minute later the counter must live under rl:m42:%d (keys: %v)", minute+1, ctx.Redis.Keys("rl:*"))
	ctx.Equal(counter(ctx, key), "1", "the previous window's counter is left alone: the key name is the window")
}

func CheckIncrExpire(ctx *harness.Ctx) {
	c := limitedAPI(ctx)
	now := minuteAt(ctx, 5)
	key := fmt.Sprintf("rl:m42:%d", now/60)
	for range 3 {
		merchantPost(c, "m42")
	}
	ctx.Equal(counter(ctx, key), "3", "after three requests %s", key)
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(110 <= ttl && ttl <= 120, "%s has TTL %d, expected 120 s set when the key was created", key, ttl)
	ctx.Clock.Advance(30)
	merchantPost(c, "m42")
	ttl = ctx.Redis.TTL(key)
	ctx.Assert(80 <= ttl && ttl <= 90, "30 s later %s has TTL %d: the expiry is set once, when Incr returns 1, not on every request", key, ttl)
	ctx.Clock.Advance(100)
	ctx.Equal(ctx.Redis.Exists(key), 0, "%s must have expired 120 s after it was created", key)
}

func CheckTooMany(ctx *harness.Ctx) {
	c := limitedAPI(ctx)
	now := minuteAt(ctx, 5)
	ctx.Redis.Set(fmt.Sprintf("rl:m42:%d", now/60), 98) // 98 checkouts already this minute
	r99 := merchantPost(c, "m42")
	r100 := merchantPost(c, "m42")
	r101 := merchantPost(c, "m42")
	r102 := merchantPost(c, "m42")
	other := merchantPost(c, "m7")
	ctx.Clock.Advance(60)
	later := merchantPost(c, "m42")
	ctx.Assert(r99.Status == 200 && r100.Status == 200, "requests 99 and 100 are within the limit, got %d and %d", r99.Status, r100.Status)
	ctx.Equal(r101.Status, 429, "the 101st request of the minute")
	ctx.Equal(r102.Status, 429, "the 102nd request, for the rest of the window,")
	ctx.Equal(other.Status, 200, "one merchant over its limit must not block another")
	ctx.Equal(later.Status, 200, "in the next minute the merchant is allowed again")
}

func CheckHeaders(ctx *harness.Ctx) {
	c := limitedAPI(ctx)
	now := minuteAt(ctx, 43)
	ctx.Redis.Set(fmt.Sprintf("rl:m42:%d", now/60), 99)
	lastOk := merchantPost(c, "m42")
	over := merchantPost(c, "m42")
	fresh := merchantPost(c, "m7")
	ctx.Equal(over.Status, 429, "the 101st request")
	ctx.Equal(over.Header.Get("Retry-After"), "17", "at :43 the 429 must say Retry-After: 17 (seconds left in the window)")
	ctx.Equal(over.Header.Get("X-RateLimit-Remaining"), "0", "the 429 must carry X-RateLimit-Remaining: 0")
	ctx.Assert(lastOk.Status == 200 && lastOk.Header.Get("X-RateLimit-Remaining") == "0", "the 100th request is allowed with X-RateLimit-Remaining: 0, got %d / %q", lastOk.Status, lastOk.Header.Get("X-RateLimit-Remaining"))
	ctx.Assert(fresh.Status == 200 && fresh.Header.Get("X-RateLimit-Remaining") == "99", "a merchant's first request leaves 99, got X-RateLimit-Remaining %q", fresh.Header.Get("X-RateLimit-Remaining"))
}
`,
  },
  debrief: `One atomic \`INCR\` per request is the whole limiter: no read-modify-write race, no Lua, and the window boundary is encoded in the key name so nothing ever has to be reset. The \`EXPIRE\` on the first hit is what keeps Redis from filling with dead windows. Real gateways run the limiter at the edge, size the limit per plan, use a sliding window or a token bucket when the double-burst at the boundary matters, and — as the Go solution does — fail open when Redis is unreachable, because a limiter that turns a cache outage into a checkout outage is worse than no limiter at all.`,
};
