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
func merchantOf(r *http.Request) string {
	return r.Context().Value(merchantKey{}).(string)
}

type merchantKey struct{}

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
func merchantOf(r *http.Request) string {
	return r.Context().Value(merchantKey{}).(string)
}

type merchantKey struct{}

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
  debrief: `One atomic \`INCR\` per request is the whole limiter: no read-modify-write race, no Lua, and the window boundary is encoded in the key name so nothing ever has to be reset. The \`EXPIRE\` on the first hit is what keeps Redis from filling with dead windows. Real gateways run the limiter at the edge, size the limit per plan, use a sliding window or a token bucket when the double-burst at the boundary matters, and — as the Go solution does — fail open when Redis is unreachable, because a limiter that turns a cache outage into a checkout outage is worse than no limiter at all.`,
};
