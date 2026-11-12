import type {Step} from '@/lib/types';

// ---- 2. Per-minute rate window in Redis ------------------------------------------------------------
export const tenantLimitsStep: Step = {
  id: 'tenant-limits',
  title: 'Rate window: one atomic reservation',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'limits',
  focus: ['router', 'redis'],
  task: `## Task

**Starting point.** The starter is the rate guard in front of \`POST /v1/route\` (\`limit_guard\`, a
dependency / pre-handler / middleware / pre-routing handler, depending on the stack). It takes the
tenant from the bearer token and the cost from \`estimate_tokens(prompt, max_tokens)\`, reads the
hash \`limits:{tenant}:{minute}\` (\`minute = floor(unix_seconds / 60)\`) with \`HGETALL\`, compares
the tokens with \`TOKENS_PER_WINDOW\`, adds to \`requests\` and \`tokens\` with two \`HINCRBY\`
calls, and answers 429 when the request does not fit. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** Two replicas reading the same counters and both spending them,
a window key that stays in Redis after its minute, a 429 the client cannot act on, and a tenant that sends
thousands of tiny requests a minute.

- A request fits when the window holds fewer than **REQUESTS_PER_WINDOW = 60** requests and its
  estimate fits in what is left of **TOKENS_PER_WINDOW = 100 000** tokens.
- Read, compare and both increments run inside **one Lua script** (\`EVAL\` / \`EVALSHA\`). The key
  expires when its minute ends (\`EXPIRE\` with the seconds left in the window, inside the script).
- A rejected request answers **429** with \`Retry-After\` (the key's TTL) and
  \`X-RateLimit-Remaining\` (tokens left; 0 once the requests are spent), spends nothing, and the
  route behind the guard does not run.`,
  sequence: {
    participants: ['Client', 'routerd', 'Redis'],
    messages: [
      {from: 'Client', to: 'routerd', label: 'POST /v1/route · Bearer acme · 164 tokens', kind: 'sync'},
      {from: 'routerd', to: 'Redis', label: 'EVALSHA reserve limits:acme:29861376 164 60 100000 42', kind: 'sync'},
      {from: 'Redis', to: 'routerd', label: '{1, 99836, 42}  (ok, tokens left, ttl)', kind: 'reply'},
      {from: 'routerd', to: 'Client', label: '200 (the route ran)', kind: 'reply'},
      {from: 'routerd', to: 'Redis', label: 'EVALSHA reserve … (window spent)', kind: 'sync'},
      {from: 'Redis', to: 'routerd', label: '{0, 50, 17}', kind: 'reply'},
      {from: 'routerd', to: 'Client', label: '429 · Retry-After: 17 · X-RateLimit-Remaining: 50', kind: 'reply'},
    ],
  },
  hints: [
    "Under load a tenant's window shows more than 100 000 tokens; Redis memory grows by one hash per tenant per minute and does not shrink; clients hammer the router after a 429; a script sending 5 000 one-token requests a minute goes through.",
    'HGETALL, a comparison in the handler and two HINCRBY calls are three round trips: another replica lands in between and passes the same check. Nothing sets an expiry, the 429 carries no headers, and `requests` is incremented but not compared.',
    'Move the read, both comparisons (`requests + 1 > REQUESTS_PER_WINDOW`, `tokens + want > TOKENS_PER_WINDOW`), both HINCRBY calls and an EXPIRE on a key without TTL into one script returning `{ok, remaining, TTL}`; send `Retry-After` and `X-RateLimit-Remaining` with the 429.',
  ],
  checks: [
    {
      id: 'atomic',
      title: 'Reserves inside one Lua script',
      detail:
        'The read, the comparisons and both increments run inside one script (`EVAL` / `EVALSHA`, `register_script`, `defineCommand`, `NewScript`); a client-side HGETALL followed by HINCRBY lets two replicas spend the same window.',
      match: {
        python: {
          all: [/redis\.call\(\s*['"]HINCRBY['"]/, /register_script\(|\.eval\(|\.evalsha\(/],
          none: [/\br\.hincrby\(|\br\.hgetall\(/],
        },
        typescript: {
          all: [/redis\.call\(\s*['"]HINCRBY['"]/, /defineCommand\(|\.eval\(|\.evalsha\(/],
          none: [/redis\.hincrby\(|redis\.hgetall\(/],
        },
        go: {
          all: [/redis\.call\(\s*['"]HINCRBY['"]/, /redis\.NewScript\(|\.Eval\(|\.EvalSha\(/],
          none: [/rdb\.HIncrBy\(|rdb\.HGetAll\(/],
        },
        scala: {
          all: [/redis\.call\(\s*['"]HINCRBY['"]/, /jedis\.eval(sha)?\(/],
          none: [/jedis\.hincrBy\(|jedis\.hgetAll\(/],
        },
        cpp: {
          all: [/redis\.call\(\s*['"]HINCRBY['"]/, /redis\.eval(sha)?[<(]/],
          none: [/redis\.hincrby\(|redis\.hgetall\(/],
        },
      },
    },
    {
      id: 'ttl',
      title: 'The window key expires when its minute ends',
      detail:
        'The script sets `EXPIRE` on the key (the seconds left in the minute) and reports its `TTL`; a key with no expiry stays in Redis after its minute has passed, one per tenant per minute.',
      match: {
        python: {all: [/redis\.call\(\s*['"]P?EXPIRE(AT)?['"]/, /redis\.call\(\s*['"]TTL['"]/]},
        typescript: {all: [/redis\.call\(\s*['"]P?EXPIRE(AT)?['"]/, /redis\.call\(\s*['"]TTL['"]/]},
        go: {all: [/redis\.call\(\s*['"]P?EXPIRE(AT)?['"]/, /redis\.call\(\s*['"]TTL['"]/]},
        scala: {all: [/redis\.call\(\s*['"]P?EXPIRE(AT)?['"]/, /redis\.call\(\s*['"]TTL['"]/]},
        cpp: {all: [/redis\.call\(\s*['"]P?EXPIRE(AT)?['"]/, /redis\.call\(\s*['"]TTL['"]/]},
      },
    },
    {
      id: 'reject-headers',
      title: 'Answers 429 with Retry-After and X-RateLimit-Remaining',
      detail:
        "A request that does not fit answers `429 Too Many Requests` with `Retry-After` (the key's TTL) and `X-RateLimit-Remaining`, spends nothing, and the route behind the guard does not run.",
      match: {
        python: {all: [/Retry-After/, /X-RateLimit-Remaining/]},
        typescript: {all: [/Retry-After/, /X-RateLimit-Remaining/]},
        go: {all: [/Retry-After/, /X-RateLimit-Remaining/]},
        scala: {all: [/Retry-After/, /X-RateLimit-Remaining/]},
        cpp: {all: [/Retry-After/, /X-RateLimit-Remaining/]},
      },
    },
    {
      id: 'request-limit',
      title: 'Holds each tenant to 60 requests a minute',
      detail:
        "The script compares the window's `requests` with `REQUESTS_PER_WINDOW` as well as its tokens: a token budget alone lets a tenant send thousands of tiny requests a minute.",
      match: {
        python: {all: [/REQUESTS_PER_WINDOW(?!\s*=)/]},
        typescript: {all: [/REQUESTS_PER_WINDOW(?!\s*=)/]},
        go: {all: [/requestsPerWindow(?!\s*=)/]},
        scala: {all: [/RequestsPerWindow(?!\s*=)/]},
        cpp: {all: [/kRequestsPerWindow(?!\s*=)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis
from fastapi import HTTPException, Request

from routerd.auth import authenticate
from routerd.tokens import estimate_tokens

r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 60
REQUESTS_PER_WINDOW = 60
TOKENS_PER_WINDOW = 100_000


def limits_key(tenant: str) -> str:
    return f"limits:{tenant}:{int(time.time()) // WINDOW_S}"


# TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
def reserve(tenant: str, tokens: int) -> tuple[bool, int, int]:
    """Take one request and tokens from the tenant's window: (ok, tokens left, seconds until the window resets)."""
    key = limits_key(tenant)
    used = r.hgetall(key)
    spent = int(used.get("tokens", 0))
    if spent + tokens > TOKENS_PER_WINDOW:
        return False, TOKENS_PER_WINDOW - spent, 0
    r.hincrby(key, "requests", 1)
    r.hincrby(key, "tokens", tokens)
    return True, TOKENS_PER_WINDOW - spent - tokens, 0


async def limit_guard(request: Request) -> None:
    """Runs before the route (\`dependencies=[Depends(limit_guard)]\`): reserves or answers 429."""
    tenant = authenticate(request.headers.get("authorization"))
    body = await request.json()
    ok, left, ttl = reserve(tenant, estimate_tokens(body.get("prompt", ""), int(body.get("max_tokens", 256))))
    if not ok:
        raise HTTPException(status_code=429, detail="rate limit exceeded")
`,
      solution: `import time

import redis
from fastapi import HTTPException, Request

from routerd.auth import authenticate
from routerd.tokens import estimate_tokens

r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 60
REQUESTS_PER_WINDOW = 60
TOKENS_PER_WINDOW = 100_000

RESERVE_LUA = """
local requests = tonumber(redis.call('HGET', KEYS[1], 'requests') or '0')
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or '0')
local want = tonumber(ARGV[1])
if requests + 1 > tonumber(ARGV[2]) then
  return {0, 0, redis.call('TTL', KEYS[1])}
end
if tokens + want > tonumber(ARGV[3]) then
  return {0, tonumber(ARGV[3]) - tokens, redis.call('TTL', KEYS[1])}
end
redis.call('HINCRBY', KEYS[1], 'requests', 1)
redis.call('HINCRBY', KEYS[1], 'tokens', want)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return {1, tonumber(ARGV[3]) - tokens - want, redis.call('TTL', KEYS[1])}
"""
reserve_script = r.register_script(RESERVE_LUA)


def limits_key(tenant: str) -> str:
    return f"limits:{tenant}:{int(time.time()) // WINDOW_S}"


def reserve(tenant: str, tokens: int) -> tuple[bool, int, int]:
    """Take one request and tokens from the tenant's window: (ok, tokens left, seconds until the window resets)."""
    seconds_left = WINDOW_S - int(time.time()) % WINDOW_S
    ok, left, ttl = reserve_script(keys=[limits_key(tenant)], args=[tokens, REQUESTS_PER_WINDOW, TOKENS_PER_WINDOW, seconds_left])
    return bool(ok), int(left), int(ttl)


async def limit_guard(request: Request) -> None:
    """Runs before the route (\`dependencies=[Depends(limit_guard)]\`): reserves or answers 429."""
    tenant = authenticate(request.headers.get("authorization"))
    body = await request.json()
    ok, left, ttl = reserve(tenant, estimate_tokens(body.get("prompt", ""), int(body.get("max_tokens", 256))))
    if not ok:
        raise HTTPException(
            status_code=429,
            detail="rate limit exceeded",
            headers={"Retry-After": str(max(ttl, 1)), "X-RateLimit-Remaining": str(left)},
        )
`,
    },
    typescript: {
      starter: `import type {FastifyReply, FastifyRequest} from 'fastify';
import Redis from 'ioredis';
import {authenticate} from 'routerd/auth';
import {estimateTokens} from 'routerd/tokens';

export const WINDOW_S = 60;
export const REQUESTS_PER_WINDOW = 60;
export const TOKENS_PER_WINDOW = 100_000;

const redis = new Redis({host: 'redis', port: 6379});

interface RouteBody {
  prompt?: string;
  max_tokens?: number;
}

function limitsKey(tenant: string): string {
  return \`limits:\${tenant}:\${Math.floor(Date.now() / 1000 / WINDOW_S)}\`;
}

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
/** Take one request and tokens from the tenant's window: [ok, tokens left, seconds until the window resets]. */
export async function reserve(tenant: string, tokens: number): Promise<[boolean, number, number]> {
  const key = limitsKey(tenant);
  const used = await redis.hgetall(key);
  const spent = Number(used.tokens ?? 0);
  if (spent + tokens > TOKENS_PER_WINDOW) return [false, TOKENS_PER_WINDOW - spent, 0];
  await redis.hincrby(key, 'requests', 1);
  await redis.hincrby(key, 'tokens', tokens);
  return [true, TOKENS_PER_WINDOW - spent - tokens, 0];
}

/** The route's preHandler: reserves or answers 429. */
export async function limitGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tenant = authenticate(request.headers.authorization);
  const body = request.body as RouteBody;
  const [ok] = await reserve(tenant, estimateTokens(body.prompt ?? '', body.max_tokens ?? 256));
  if (!ok) reply.code(429).send({error: 'rate limit exceeded'});
}
`,
      solution: `import type {FastifyReply, FastifyRequest} from 'fastify';
import Redis from 'ioredis';
import {authenticate} from 'routerd/auth';
import {estimateTokens} from 'routerd/tokens';

export const WINDOW_S = 60;
export const REQUESTS_PER_WINDOW = 60;
export const TOKENS_PER_WINDOW = 100_000;

const RESERVE_LUA = \`
local requests = tonumber(redis.call('HGET', KEYS[1], 'requests') or '0')
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or '0')
local want = tonumber(ARGV[1])
if requests + 1 > tonumber(ARGV[2]) then
  return {0, 0, redis.call('TTL', KEYS[1])}
end
if tokens + want > tonumber(ARGV[3]) then
  return {0, tonumber(ARGV[3]) - tokens, redis.call('TTL', KEYS[1])}
end
redis.call('HINCRBY', KEYS[1], 'requests', 1)
redis.call('HINCRBY', KEYS[1], 'tokens', want)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return {1, tonumber(ARGV[3]) - tokens - want, redis.call('TTL', KEYS[1])}
\`;

interface LimitsRedis extends Redis {
  reserve(key: string, tokens: number, requests: number, budget: number, ttl: number): Promise<[number, number, number]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as LimitsRedis;
redis.defineCommand('reserve', {numberOfKeys: 1, lua: RESERVE_LUA});

interface RouteBody {
  prompt?: string;
  max_tokens?: number;
}

function limitsKey(tenant: string): string {
  return \`limits:\${tenant}:\${Math.floor(Date.now() / 1000 / WINDOW_S)}\`;
}

/** Take one request and tokens from the tenant's window: [ok, tokens left, seconds until the window resets]. */
export async function reserve(tenant: string, tokens: number): Promise<[boolean, number, number]> {
  const secondsLeft = WINDOW_S - (Math.floor(Date.now() / 1000) % WINDOW_S);
  const [ok, left, ttl] = await redis.reserve(limitsKey(tenant), tokens, REQUESTS_PER_WINDOW, TOKENS_PER_WINDOW, secondsLeft);
  return [ok === 1, left, ttl];
}

/** The route's preHandler: reserves or answers 429. */
export async function limitGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tenant = authenticate(request.headers.authorization);
  const body = request.body as RouteBody;
  const [ok, left, ttl] = await reserve(tenant, estimateTokens(body.prompt ?? '', body.max_tokens ?? 256));
  if (!ok) {
    reply
      .code(429)
      .headers({'Retry-After': String(Math.max(ttl, 1)), 'X-RateLimit-Remaining': String(left)})
      .send({error: 'rate limit exceeded'});
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"routerd/auth"
	"routerd/tokens"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	windowSeconds     = 60
	requestsPerWindow = 60
	tokensPerWindow   = 100_000
)

type routeBody struct {
	Prompt    string \`json:"prompt"\`
	MaxTokens *int   \`json:"max_tokens"\`
}

func limitsKey(tenant string) string {
	return fmt.Sprintf("limits:%s:%d", tenant, time.Now().Unix()/windowSeconds)
}

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
// reserve takes one request and tokens from the tenant's window: ok, tokens left, seconds until the window resets.
func reserve(ctx context.Context, tenant string, want int) (bool, int, int, error) {
	key := limitsKey(tenant)
	used, err := rdb.HGetAll(ctx, key).Result()
	if err != nil {
		return false, 0, 0, err
	}
	spent, _ := strconv.Atoi(used["tokens"])
	if spent+want > tokensPerWindow {
		return false, tokensPerWindow - spent, 0, nil
	}
	if err := rdb.HIncrBy(ctx, key, "requests", 1).Err(); err != nil {
		return false, 0, 0, err
	}
	if err := rdb.HIncrBy(ctx, key, "tokens", int64(want)).Err(); err != nil {
		return false, 0, 0, err
	}
	return true, tokensPerWindow - spent - want, 0, nil
}

// limitGuard wraps the route: reserves or answers 429.
func limitGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		tenant, ok := auth.Tenant(r)
		if !ok {
			http.Error(rw, "missing bearer token", http.StatusUnauthorized)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(raw))
		var body routeBody
		_ = json.Unmarshal(raw, &body)
		maxTokens := 256
		if body.MaxTokens != nil {
			maxTokens = *body.MaxTokens
		}
		allowed, _, _, err := reserve(r.Context(), tenant, tokens.Estimate(body.Prompt, maxTokens))
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		if !allowed {
			http.Error(rw, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(rw, r)
	})
}
`,
      solution: `package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"routerd/auth"
	"routerd/tokens"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	windowSeconds     = 60
	requestsPerWindow = 60
	tokensPerWindow   = 100_000
)

var reserveScript = redis.NewScript(\`
local requests = tonumber(redis.call('HGET', KEYS[1], 'requests') or '0')
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or '0')
local want = tonumber(ARGV[1])
if requests + 1 > tonumber(ARGV[2]) then
  return {0, 0, redis.call('TTL', KEYS[1])}
end
if tokens + want > tonumber(ARGV[3]) then
  return {0, tonumber(ARGV[3]) - tokens, redis.call('TTL', KEYS[1])}
end
redis.call('HINCRBY', KEYS[1], 'requests', 1)
redis.call('HINCRBY', KEYS[1], 'tokens', want)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return {1, tonumber(ARGV[3]) - tokens - want, redis.call('TTL', KEYS[1])}
\`)

type routeBody struct {
	Prompt    string \`json:"prompt"\`
	MaxTokens *int   \`json:"max_tokens"\`
}

func limitsKey(tenant string) string {
	return fmt.Sprintf("limits:%s:%d", tenant, time.Now().Unix()/windowSeconds)
}

// reserve takes one request and tokens from the tenant's window: ok, tokens left, seconds until the window resets.
func reserve(ctx context.Context, tenant string, want int) (bool, int, int, error) {
	secondsLeft := windowSeconds - time.Now().Unix()%windowSeconds
	res, err := reserveScript.Run(ctx, rdb, []string{limitsKey(tenant)}, want, requestsPerWindow, tokensPerWindow, secondsLeft).Int64Slice()
	if err != nil {
		return false, 0, 0, err
	}
	return res[0] == 1, int(res[1]), int(res[2]), nil
}

// limitGuard wraps the route: reserves or answers 429.
func limitGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		tenant, ok := auth.Tenant(r)
		if !ok {
			http.Error(rw, "missing bearer token", http.StatusUnauthorized)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(raw))
		var body routeBody
		_ = json.Unmarshal(raw, &body)
		maxTokens := 256
		if body.MaxTokens != nil {
			maxTokens = *body.MaxTokens
		}
		allowed, left, ttl, err := reserve(r.Context(), tenant, tokens.Estimate(body.Prompt, maxTokens))
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		if !allowed {
			rw.Header().Set("Retry-After", strconv.Itoa(max(ttl, 1)))
			rw.Header().Set("X-RateLimit-Remaining", strconv.Itoa(left))
			http.Error(rw, "rate limit exceeded", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(rw, r)
	})
}
`,
    },
    scala: {
      starter: `import java.time.Instant

import org.apache.pekko.http.scaladsl.model.{HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directive0
import org.apache.pekko.http.scaladsl.server.Directives._
import redis.clients.jedis.JedisPooled
import routerd.{Auth, Tokens}

object Limits {
  val jedis = new JedisPooled("redis", 6379)

  val WindowSeconds = 60L
  val RequestsPerWindow = 60L
  val TokensPerWindow = 100000L

  case class Reservation(ok: Boolean, remaining: Long, ttl: Long)

  def limitsKey(tenant: String): String = s"limits:$tenant:\${Instant.now().getEpochSecond / WindowSeconds}"

  /** What a request may cost, from its body. */
  def wanted(body: String): Long = {
    val json = ujson.read(body)
    Tokens.estimate(json.obj.get("prompt").map(_.str).getOrElse(""), json.obj.get("max_tokens").map(_.num.toInt).getOrElse(256)).toLong
  }

  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  /** Take one request and tokens from the tenant's window. */
  def reserve(tenant: String, tokens: Long): Reservation = {
    val key = limitsKey(tenant)
    val used = jedis.hgetAll(key)
    val spent = Option(used.get("tokens")).map(_.toLong).getOrElse(0L)
    if (spent + tokens > TokensPerWindow) Reservation(ok = false, TokensPerWindow - spent, 0)
    else {
      jedis.hincrBy(key, "requests", 1)
      jedis.hincrBy(key, "tokens", tokens)
      Reservation(ok = true, TokensPerWindow - spent - tokens, 0)
    }
  }

  /** Wraps the route: reserves or answers 429. */
  def limited(tenant: String, body: String): Directive0 = {
    val r = reserve(tenant, wanted(body))
    if (r.ok) pass
    else complete(HttpResponse(StatusCodes.TooManyRequests, entity = "rate limit exceeded"))
  }

  val guarded: Directive0 =
    optionalHeaderValueByName("Authorization").flatMap { authorization =>
      Auth.tenant(authorization) match {
        case None => complete(HttpResponse(StatusCodes.Unauthorized, entity = "missing bearer token"))
        case Some(tenant) => entity(as[String]).flatMap(body => limited(tenant, body))
      }
    }
}
`,
      solution: `import java.time.Instant

import org.apache.pekko.http.scaladsl.model.{HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directive0
import org.apache.pekko.http.scaladsl.server.Directives._
import redis.clients.jedis.JedisPooled
import routerd.{Auth, Tokens}

import scala.jdk.CollectionConverters._

object Limits {
  val jedis = new JedisPooled("redis", 6379)

  val WindowSeconds = 60L
  val RequestsPerWindow = 60L
  val TokensPerWindow = 100000L

  val ReserveLua: String =
    """local requests = tonumber(redis.call('HGET', KEYS[1], 'requests') or '0')
      |local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or '0')
      |local want = tonumber(ARGV[1])
      |if requests + 1 > tonumber(ARGV[2]) then
      |  return {0, 0, redis.call('TTL', KEYS[1])}
      |end
      |if tokens + want > tonumber(ARGV[3]) then
      |  return {0, tonumber(ARGV[3]) - tokens, redis.call('TTL', KEYS[1])}
      |end
      |redis.call('HINCRBY', KEYS[1], 'requests', 1)
      |redis.call('HINCRBY', KEYS[1], 'tokens', want)
      |if redis.call('TTL', KEYS[1]) < 0 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[4])
      |end
      |return {1, tonumber(ARGV[3]) - tokens - want, redis.call('TTL', KEYS[1])}
      |""".stripMargin
  private val sha = jedis.scriptLoad(ReserveLua)

  case class Reservation(ok: Boolean, remaining: Long, ttl: Long)

  def limitsKey(tenant: String): String = s"limits:$tenant:\${Instant.now().getEpochSecond / WindowSeconds}"

  /** What a request may cost, from its body. */
  def wanted(body: String): Long = {
    val json = ujson.read(body)
    Tokens.estimate(json.obj.get("prompt").map(_.str).getOrElse(""), json.obj.get("max_tokens").map(_.num.toInt).getOrElse(256)).toLong
  }

  /** Take one request and tokens from the tenant's window. */
  def reserve(tenant: String, tokens: Long): Reservation = {
    val secondsLeft = WindowSeconds - Instant.now().getEpochSecond % WindowSeconds
    val args = List(tokens, RequestsPerWindow, TokensPerWindow, secondsLeft).map(_.toString).asJava
    val reply = jedis.evalsha(sha, List(limitsKey(tenant)).asJava, args).asInstanceOf[java.util.List[java.lang.Long]].asScala
    Reservation(reply(0) == 1L, reply(1), reply(2))
  }

  /** Wraps the route: reserves or answers 429. */
  def limited(tenant: String, body: String): Directive0 = {
    val r = reserve(tenant, wanted(body))
    if (r.ok) pass
    else {
      val headers = List(RawHeader("Retry-After", math.max(r.ttl, 1L).toString), RawHeader("X-RateLimit-Remaining", r.remaining.toString))
      complete(HttpResponse(StatusCodes.TooManyRequests, headers = headers, entity = "rate limit exceeded"))
    }
  }

  val guarded: Directive0 =
    optionalHeaderValueByName("Authorization").flatMap { authorization =>
      Auth.tenant(authorization) match {
        case None => complete(HttpResponse(StatusCodes.Unauthorized, entity = "missing bearer token"))
        case Some(tenant) => entity(as[String]).flatMap(body => limited(tenant, body))
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <unordered_map>

#include "routerd/auth.h"
#include "routerd/tokens.h"

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kWindowSeconds = 60;
constexpr long long kRequestsPerWindow = 60;
constexpr long long kTokensPerWindow = 100000;

struct Reservation {
  bool ok;
  long long remaining;
  long long ttl;
};

long long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string limits_key(const std::string& tenant) {
  return "limits:" + tenant + ":" + std::to_string(now_seconds() / kWindowSeconds);
}

// What a request may cost, from its body.
long long wanted_tokens(const std::string& body) {
  const auto json = nlohmann::json::parse(body, nullptr, false);
  if (!json.is_object()) return routerd::estimate_tokens("", 256);
  return routerd::estimate_tokens(json.value("prompt", ""), json.value("max_tokens", 256));
}

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
// Take one request and tokens from the tenant's window.
Reservation reserve(const std::string& tenant, long long tokens) {
  const std::string key = limits_key(tenant);
  const auto used = redis.hgetall(key);
  const auto it = used.find("tokens");
  const long long spent = it == used.end() ? 0 : std::stoll(it->second);
  if (spent + tokens > kTokensPerWindow) return {false, kTokensPerWindow - spent, 0};
  redis.hincrby(key, "requests", 1);
  redis.hincrby(key, "tokens", tokens);
  return {true, kTokensPerWindow - spent - tokens, 0};
}

// Registered with svr.set_pre_routing_handler: reserves or answers 429 before the route.
httplib::Server::HandlerResponse limit_guard(const httplib::Request& req, httplib::Response& res) {
  const auto tenant = routerd::tenant(req);
  if (!tenant) {
    res.status = 401;
    res.set_content("missing bearer token", "text/plain");
    return httplib::Server::HandlerResponse::Handled;
  }
  const Reservation r = reserve(*tenant, wanted_tokens(req.body));
  if (!r.ok) {
    res.status = 429;
    res.set_content("rate limit exceeded", "text/plain");
    return httplib::Server::HandlerResponse::Handled;
  }
  return httplib::Server::HandlerResponse::Unhandled;
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <iterator>
#include <string>
#include <vector>

#include "routerd/auth.h"
#include "routerd/tokens.h"

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kWindowSeconds = 60;
constexpr long long kRequestsPerWindow = 60;
constexpr long long kTokensPerWindow = 100000;

const std::string kReserveLua = R"lua(
local requests = tonumber(redis.call('HGET', KEYS[1], 'requests') or '0')
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or '0')
local want = tonumber(ARGV[1])
if requests + 1 > tonumber(ARGV[2]) then
  return {0, 0, redis.call('TTL', KEYS[1])}
end
if tokens + want > tonumber(ARGV[3]) then
  return {0, tonumber(ARGV[3]) - tokens, redis.call('TTL', KEYS[1])}
end
redis.call('HINCRBY', KEYS[1], 'requests', 1)
redis.call('HINCRBY', KEYS[1], 'tokens', want)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
end
return {1, tonumber(ARGV[3]) - tokens - want, redis.call('TTL', KEYS[1])}
)lua";
const std::string kReserveSha = redis.script_load(kReserveLua);

struct Reservation {
  bool ok;
  long long remaining;
  long long ttl;
};

long long now_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string limits_key(const std::string& tenant) {
  return "limits:" + tenant + ":" + std::to_string(now_seconds() / kWindowSeconds);
}

// What a request may cost, from its body.
long long wanted_tokens(const std::string& body) {
  const auto json = nlohmann::json::parse(body, nullptr, false);
  if (!json.is_object()) return routerd::estimate_tokens("", 256);
  return routerd::estimate_tokens(json.value("prompt", ""), json.value("max_tokens", 256));
}

// Take one request and tokens from the tenant's window.
Reservation reserve(const std::string& tenant, long long tokens) {
  const long long seconds_left = kWindowSeconds - now_seconds() % kWindowSeconds;
  std::vector<long long> reply;
  redis.evalsha(kReserveSha, {limits_key(tenant)},
                {std::to_string(tokens), std::to_string(kRequestsPerWindow), std::to_string(kTokensPerWindow),
                 std::to_string(seconds_left)},
                std::back_inserter(reply));
  return {reply[0] == 1, reply[1], reply[2]};
}

// Registered with svr.set_pre_routing_handler: reserves or answers 429 before the route.
httplib::Server::HandlerResponse limit_guard(const httplib::Request& req, httplib::Response& res) {
  const auto tenant = routerd::tenant(req);
  if (!tenant) {
    res.status = 401;
    res.set_content("missing bearer token", "text/plain");
    return httplib::Server::HandlerResponse::Handled;
  }
  const Reservation r = reserve(*tenant, wanted_tokens(req.body));
  if (!r.ok) {
    res.status = 429;
    res.set_header("Retry-After", std::to_string(std::max(r.ttl, 1LL)));
    res.set_header("X-RateLimit-Remaining", std::to_string(r.remaining));
    res.set_content("rate limit exceeded", "text/plain");
    return httplib::Server::HandlerResponse::Handled;
  }
  return httplib::Server::HandlerResponse::Unhandled;
}
`,
    },
  },
  harness: {
    python: `from fastapi import Depends, FastAPI, Request

AUTH = {"Authorization": "Bearer acme"}


def _window_key(ctx, tenant="acme"):
    return f"limits:{tenant}:{int(ctx.clock.time()) // 60}"


def _router(ctx):
    """The guard needs a route to guard: one the harness registers, counting what got through."""
    m = ctx.load("limits")
    app = FastAPI()
    served = []

    @app.post("/v1/route", dependencies=[Depends(m.limit_guard)])
    async def route(request: Request):
        served.append(await request.json())
        return {"id": "d-1", "model": "gpt-4o-mini"}

    m.app, m.served = app, served
    return m


def _body(tokens, prompt_bytes=400):
    """A request worth prompt_bytes / 4 + max_tokens tokens."""
    return {"prompt": "x" * prompt_bytes, "max_tokens": tokens - prompt_bytes // 4, "policy": "auto"}


async def _route(ctx, m, body, headers=AUTH):
    async with ctx.client(m.app) as c:
        return await c.post("/v1/route", json=body, headers=headers)


def _hash(ctx, key):
    return {k: int(v) for k, v in ctx.redis.hgetall(key).items()}


async def check_atomic(ctx):
    m = _router(ctx)
    key = _window_key(ctx)
    ctx.redis.hset(key, mapping={"requests": 10, "tokens": 99000})
    # Another replica lands right after the first command that touches the window, between a
    # client-side read and its increments, and spends every token that is left.
    probe = ctx.redis_after(key, lambda: ctx.redis.hset(key, "tokens", 100000))
    await _route(ctx, m, _body(164))
    assert probe.fired, f"a request from acme never touched {key}: the window lives in limits:{{tenant}}:{{minute}} (keys: {sorted(ctx.redis.keys('limits:*'))})"
    tokens = _hash(ctx, key).get("tokens")
    assert tokens <= 100000, f"{key} holds {tokens} tokens after another replica spent the window between your read and your increments: both requests spent the same tokens. Read, compare and increment inside one Lua script"
    assert tokens == 100000, f"{key} holds {tokens} tokens after another replica set it to 100000 between your commands: the replica's update was lost"
    second = await _route(ctx, m, _body(164))
    assert second.status_code == 429, f"with the window spent by another replica the next request answered {second.status_code}, expected 429"


async def check_ttl(ctx):
    m = _router(ctx)
    key = _window_key(ctx)
    r = await _route(ctx, m, _body(164))
    assert r.status_code == 200, f"the first request of the minute answered {r.status_code}: {r.text}"
    assert ctx.redis.exists(key), f"after a request {key} does not exist (keys: {sorted(ctx.redis.keys('limits:*'))})"
    ttl = ctx.redis.ttl(key)
    left = 60 - int(ctx.clock.time()) % 60
    assert ttl > 0, f"{key} has no expiry (TTL {ttl}): every minute leaves one hash per tenant in Redis for good"
    assert abs(ttl - left) <= 2, f"{key} expires in {ttl} s, expected the {left} s left in its minute"
    ctx.clock.advance(61)
    assert not ctx.redis.exists(key), f"{key} still exists a minute after its window ended"
    r = await _route(ctx, m, _body(164))
    assert r.status_code == 200 and _hash(ctx, _window_key(ctx)).get("tokens") == 164, "the next minute starts a new window"


async def check_reject_headers(ctx):
    m = _router(ctx)
    key = _window_key(ctx)
    ctx.redis.hset(key, mapping={"requests": 3, "tokens": 99950})
    ctx.redis.expire(key, 30)
    r = await _route(ctx, m, _body(164))
    assert r.status_code == 429, f"a request worth 164 tokens against 50 left answered {r.status_code}, expected 429"
    assert m.served == [], "a rejected request must not reach the route behind the guard"
    assert r.headers.get("retry-after") in ("30", "29"), f"Retry-After is {r.headers.get('retry-after')!r}, expected the key's TTL (30 s)"
    assert r.headers.get("x-ratelimit-remaining") == "50", f"X-RateLimit-Remaining is {r.headers.get('x-ratelimit-remaining')!r}, expected 50"
    assert _hash(ctx, key) == {"requests": 3, "tokens": 99950}, f"a rejected request must not spend: {key} holds {_hash(ctx, key)}"
    small = await _route(ctx, m, _body(2, prompt_bytes=4))
    assert small.status_code == 200 and len(m.served) == 1, f"a request that fits (2 tokens of 50) answered {small.status_code}"
    assert _hash(ctx, key) == {"requests": 4, "tokens": 99952}, f"after a 2-token reservation {key} holds {_hash(ctx, key)}, expected 4 requests and 99952 tokens"


async def check_request_limit(ctx):
    m = _router(ctx)
    key = _window_key(ctx)
    ctx.redis.hset(key, mapping={"requests": 59, "tokens": 0})
    ctx.redis.expire(key, 45)
    sixtieth = await _route(ctx, m, _body(2, prompt_bytes=4))
    assert sixtieth.status_code == 200, f"the 60th request of the minute answered {sixtieth.status_code}: {sixtieth.text}"
    sixty_first = await _route(ctx, m, _body(2, prompt_bytes=4))
    assert sixty_first.status_code == 429, f"the 61st request of the minute (2 tokens, the token budget nearly untouched) answered {sixty_first.status_code}, expected 429: the window allows 60 requests"
    assert len(m.served) == 1, f"the route ran {len(m.served)} times, expected once"
    assert sixty_first.headers.get("x-ratelimit-remaining") == "0", f"with the requests spent X-RateLimit-Remaining is {sixty_first.headers.get('x-ratelimit-remaining')!r}, expected 0"
    assert _hash(ctx, key).get("requests") == 60, f"{key} counts {_hash(ctx, key).get('requests')} requests, expected 60"
    other = await _route(ctx, m, _body(2, prompt_bytes=4), headers={"Authorization": "Bearer beta"})
    assert other.status_code == 200, f"beta's first request answered {other.status_code}: each tenant has a window of its own"
`,
    typescript: `import Fastify from 'fastify';

const AUTH = {Authorization: 'Bearer acme'};

const windowKey = (ctx, tenant = 'acme'): string => \`limits:\${tenant}:\${Math.floor(ctx.clock.now() / 1000 / 60)}\`;

/** The guard needs a route to guard: one the harness registers, counting what got through. */
function router(ctx) {
  const m = ctx.load('limits');
  const app = Fastify();
  const served: unknown[] = [];
  app.post('/v1/route', {preHandler: m.limitGuard}, async request => {
    served.push(request.body);
    return {id: 'd-1', model: 'gpt-4o-mini'};
  });
  return {m, served, c: ctx.client(app)};
}

/** A request worth promptBytes / 4 + max_tokens tokens. */
const body = (tokens: number, promptBytes = 400) => ({
  prompt: 'x'.repeat(promptBytes),
  max_tokens: tokens - promptBytes / 4,
  policy: 'auto',
});

const hash = (ctx, key: string): Record<string, number> =>
  Object.fromEntries(Object.entries(ctx.redis.hgetall(key) as Record<string, string>).map(([k, v]) => [k, Number(v)]));

export async function check_atomic(ctx) {
  const {c} = router(ctx);
  const key = windowKey(ctx);
  ctx.redis.hset(key, 'requests', 10, 'tokens', 99000);
  // Another replica lands right after the first command that touches the window, between a
  // client-side read and its increments, and spends every token that is left.
  const probe = ctx.redisAfter(key, () => ctx.redis.hset(key, 'tokens', 100000));
  await c.post('/v1/route', {body: body(164), headers: AUTH});
  assert(probe.fired, \`a request from acme never touched \${key}: the window lives in limits:{tenant}:{minute} (keys: \${JSON.stringify(ctx.redis.keys('limits:*').sort())})\`);
  const tokens = hash(ctx, key).tokens;
  assert(tokens <= 100000, \`\${key} holds \${tokens} tokens after another replica spent the window between your read and your increments: both requests spent the same tokens. Read, compare and increment inside one Lua script\`);
  assert.equal(tokens, 100000, \`\${key} holds \${tokens} tokens after another replica set it to 100000 between your commands: the replica's update was lost\`);
  const second = await c.post('/v1/route', {body: body(164), headers: AUTH});
  assert.equal(second.status, 429, \`with the window spent by another replica the next request answered \${second.status}, expected 429\`);
}

export async function check_ttl(ctx) {
  const {c} = router(ctx);
  const key = windowKey(ctx);
  const r = await c.post('/v1/route', {body: body(164), headers: AUTH});
  assert.equal(r.status, 200, \`the first request of the minute answered \${r.status}: \${r.text}\`);
  assert(ctx.redis.exists(key), \`after a request \${key} does not exist (keys: \${JSON.stringify(ctx.redis.keys('limits:*').sort())})\`);
  const ttl = Number(ctx.redis.ttl(key));
  const left = 60 - (Math.floor(ctx.clock.now() / 1000) % 60);
  assert(ttl > 0, \`\${key} has no expiry (TTL \${ttl}): every minute leaves one hash per tenant in Redis for good\`);
  assert(Math.abs(ttl - left) <= 2, \`\${key} expires in \${ttl} s, expected the \${left} s left in its minute\`);
  ctx.clock.advance(61);
  assert(!ctx.redis.exists(key), \`\${key} still exists a minute after its window ended\`);
  const next = await c.post('/v1/route', {body: body(164), headers: AUTH});
  assert(next.status === 200 && hash(ctx, windowKey(ctx)).tokens === 164, 'the next minute starts a new window');
}

export async function check_reject_headers(ctx) {
  const {c, served} = router(ctx);
  const key = windowKey(ctx);
  ctx.redis.hset(key, 'requests', 3, 'tokens', 99950);
  ctx.redis.expire(key, 30);
  const r = await c.post('/v1/route', {body: body(164), headers: AUTH});
  assert.equal(r.status, 429, \`a request worth 164 tokens against 50 left answered \${r.status}, expected 429\`);
  assert.equal(served.length, 0, 'a rejected request must not reach the route behind the guard');
  assert(['30', '29'].includes(r.headers['retry-after']), \`Retry-After is \${JSON.stringify(r.headers['retry-after'])}, expected the key's TTL (30 s)\`);
  assert.equal(r.headers['x-ratelimit-remaining'], '50', \`X-RateLimit-Remaining is \${JSON.stringify(r.headers['x-ratelimit-remaining'])}, expected 50\`);
  assert.deepStrictEqual(hash(ctx, key), {requests: 3, tokens: 99950}, \`a rejected request must not spend: \${key} holds \${JSON.stringify(hash(ctx, key))}\`);
  const small = await c.post('/v1/route', {body: body(2, 4), headers: AUTH});
  assert(small.status === 200 && served.length === 1, \`a request that fits (2 tokens of 50) answered \${small.status}\`);
  assert.deepStrictEqual(hash(ctx, key), {requests: 4, tokens: 99952}, \`after a 2-token reservation \${key} holds \${JSON.stringify(hash(ctx, key))}, expected 4 requests and 99952 tokens\`);
}

export async function check_request_limit(ctx) {
  const {c, served} = router(ctx);
  const key = windowKey(ctx);
  ctx.redis.hset(key, 'requests', 59, 'tokens', 0);
  ctx.redis.expire(key, 45);
  const sixtieth = await c.post('/v1/route', {body: body(2, 4), headers: AUTH});
  assert.equal(sixtieth.status, 200, \`the 60th request of the minute answered \${sixtieth.status}: \${sixtieth.text}\`);
  const sixtyFirst = await c.post('/v1/route', {body: body(2, 4), headers: AUTH});
  assert.equal(sixtyFirst.status, 429, \`the 61st request of the minute (2 tokens, the token budget nearly untouched) answered \${sixtyFirst.status}, expected 429: the window allows 60 requests\`);
  assert.equal(served.length, 1, \`the route ran \${served.length} times, expected once\`);
  assert.equal(sixtyFirst.headers['x-ratelimit-remaining'], '0', \`with the requests spent X-RateLimit-Remaining is \${JSON.stringify(sixtyFirst.headers['x-ratelimit-remaining'])}, expected 0\`);
  assert.equal(hash(ctx, key).requests, 60, \`\${key} counts \${hash(ctx, key).requests} requests, expected 60\`);
  const other = await c.post('/v1/route', {body: body(2, 4), headers: {Authorization: 'Bearer beta'}});
  assert.equal(other.status, 200, \`beta's first request answered \${other.status}: each tenant has a window of its own\`);
}
`,
    go: `package main

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"leetbuild/harness"
)

// limitsRouter is limitGuard wrapped around a route the harness registers, counting what got through.
type limitsRouter struct {
	served int
	http   *harness.HTTP
}

func newLimitsRouter(ctx *harness.Ctx) *limitsRouter {
	g := &limitsRouter{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/route", func(rw http.ResponseWriter, r *http.Request) {
		g.served++
		rw.Header().Set("Content-Type", "application/json")
		rw.Write([]byte(\`{"id":"d-1","model":"gpt-4o-mini"}\`))
	})
	g.http = ctx.HTTP(limitGuard(mux))
	return g
}

func (g *limitsRouter) route(body, tenant string) *harness.Response {
	return g.http.Post("/v1/route", body, "Authorization", "Bearer "+tenant, "Content-Type", "application/json")
}

func windowKey(ctx *harness.Ctx, tenant string) string {
	return fmt.Sprintf("limits:%s:%d", tenant, ctx.Clock.Now()/1000/60)
}

// limitsBody is a request worth promptBytes / 4 + max_tokens tokens.
func limitsBody(tokens, promptBytes int) string {
	return fmt.Sprintf(\`{"prompt":"%s","max_tokens":%d,"policy":"auto"}\`, strings.Repeat("x", promptBytes), tokens-promptBytes/4)
}

func windowHash(ctx *harness.Ctx, key string) map[string]int {
	out := map[string]int{}
	for k, v := range ctx.Redis.HGetAll(key) {
		out[k], _ = strconv.Atoi(v)
	}
	return out
}

func CheckAtomic(ctx *harness.Ctx) {
	g := newLimitsRouter(ctx)
	key := windowKey(ctx, "acme")
	ctx.Redis.Do("HSET", key, "requests", 10, "tokens", 99000)
	// Another replica lands right after the first command that touches the window, between a
	// client-side read and its increments, and spends every token that is left.
	fired := false
	ctx.Redis.After(key, func() any {
		fired = true
		return ctx.Redis.Do("HSET", key, "tokens", 100000)
	})
	g.route(limitsBody(164, 400), "acme")
	ctx.Assert(fired, "a request from acme never touched %s: the window lives in limits:{tenant}:{minute} (keys: %v)", key, ctx.Redis.Keys("limits:*"))
	tokens := windowHash(ctx, key)["tokens"]
	ctx.Assert(tokens <= 100000, "%s holds %d tokens after another replica spent the window between your read and your increments: both requests spent the same tokens. Read, compare and increment inside one Lua script", key, tokens)
	ctx.Equal(tokens, 100000, "%s tokens after another replica set them to 100000 between your commands (the replica's update was lost)", key)
	second := g.route(limitsBody(164, 400), "acme")
	ctx.Equal(second.Status, 429, "with the window spent by another replica the next request")
}

func CheckTtl(ctx *harness.Ctx) {
	g := newLimitsRouter(ctx)
	key := windowKey(ctx, "acme")
	r := g.route(limitsBody(164, 400), "acme")
	ctx.Equal(r.Status, 200, "the first request of the minute (%s)", r.Text())
	ctx.Assert(ctx.Redis.Exists(key) == 1, "after a request %s does not exist (keys: %v)", key, ctx.Redis.Keys("limits:*"))
	ttl := ctx.Redis.TTL(key)
	left := 60 - (ctx.Clock.Now()/1000)%60
	ctx.Assert(ttl > 0, "%s has no expiry (TTL %d): every minute leaves one hash per tenant in Redis for good", key, ttl)
	ctx.Assert(ttl-left <= 2 && left-ttl <= 2, "%s expires in %d s, expected the %d s left in its minute", key, ttl, left)
	ctx.Clock.Advance(61)
	ctx.Assert(ctx.Redis.Exists(key) == 0, "%s still exists a minute after its window ended", key)
	next := g.route(limitsBody(164, 400), "acme")
	ctx.Assert(next.Status == 200 && windowHash(ctx, windowKey(ctx, "acme"))["tokens"] == 164, "the next minute starts a new window")
}

func CheckRejectHeaders(ctx *harness.Ctx) {
	g := newLimitsRouter(ctx)
	key := windowKey(ctx, "acme")
	ctx.Redis.Do("HSET", key, "requests", 3, "tokens", 99950)
	ctx.Redis.Do("EXPIRE", key, 30)
	r := g.route(limitsBody(164, 400), "acme")
	ctx.Equal(r.Status, 429, "a request worth 164 tokens against 50 left")
	ctx.Equal(g.served, 0, "a rejected request must not reach the route behind the guard; the route ran")
	retry := r.Header.Get("Retry-After")
	ctx.Assert(retry == "30" || retry == "29", "Retry-After is %q, expected the key's TTL (30 s)", retry)
	ctx.Equal(r.Header.Get("X-RateLimit-Remaining"), "50", "X-RateLimit-Remaining")
	ctx.Equal(windowHash(ctx, key), map[string]int{"requests": 3, "tokens": 99950}, "a rejected request must not spend; %s", key)
	small := g.route(limitsBody(2, 4), "acme")
	ctx.Assert(small.Status == 200 && g.served == 1, "a request that fits (2 tokens of 50) answered %d", small.Status)
	ctx.Equal(windowHash(ctx, key), map[string]int{"requests": 4, "tokens": 99952}, "after a 2-token reservation %s", key)
}

func CheckRequestLimit(ctx *harness.Ctx) {
	g := newLimitsRouter(ctx)
	key := windowKey(ctx, "acme")
	ctx.Redis.Do("HSET", key, "requests", 59, "tokens", 0)
	ctx.Redis.Do("EXPIRE", key, 45)
	sixtieth := g.route(limitsBody(2, 4), "acme")
	ctx.Equal(sixtieth.Status, 200, "the 60th request of the minute (%s)", sixtieth.Text())
	sixtyFirst := g.route(limitsBody(2, 4), "acme")
	ctx.Equal(sixtyFirst.Status, 429, "the 61st request of the minute (2 tokens, the token budget nearly untouched; the window allows 60 requests)")
	ctx.Equal(g.served, 1, "the route must run once; the route ran")
	ctx.Equal(sixtyFirst.Header.Get("X-RateLimit-Remaining"), "0", "with the requests spent X-RateLimit-Remaining")
	ctx.Equal(windowHash(ctx, key)["requests"], 60, "%s requests", key)
	other := g.route(limitsBody(2, 4), "beta")
	ctx.Equal(other.Status, 200, "beta's first request (each tenant has a window of its own)")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cstdlib>
#include <map>
#include <string>

namespace {

// limit_guard wrapped around a route the harness registers, counting what got through.
struct LimitsRouter {
  int served = 0;
  httplib::Server svr;
  harness::HTTP http;

  explicit LimitsRouter(harness::Ctx& ctx) : http(ctx.HTTP(svr)) {
    svr.set_pre_routing_handler(limit_guard);
    svr.Post("/v1/route", [this](const httplib::Request&, httplib::Response& res) {
      served++;
      res.set_content(R"({"id":"d-1","model":"gpt-4o-mini"})", "application/json");
    });
  }

  harness::Response route(const std::string& body, const std::string& tenant = "acme") {
    return http.Post("/v1/route", body, "Authorization", "Bearer " + tenant, "Content-Type", "application/json");
  }
};

std::string windowKey(harness::Ctx& ctx, const std::string& tenant = "acme") {
  return "limits:" + tenant + ":" + std::to_string(ctx.Clock.Now() / 1000 / 60);
}

// A request worth prompt_bytes / 4 + max_tokens tokens.
std::string limitsBody(int tokens, int prompt_bytes = 400) {
  return R"({"prompt":")" + std::string(prompt_bytes, 'x') + R"(","max_tokens":)" + std::to_string(tokens - prompt_bytes / 4) +
         R"(,"policy":"auto"})";
}

std::map<std::string, long long> windowHash(harness::Ctx& ctx, const std::string& key) {
  std::map<std::string, long long> out;
  for (const auto& [k, v] : ctx.Redis.HGetAll(key)) out[k] = std::atoll(v.c_str());
  return out;
}

}  // namespace

void CheckAtomic(harness::Ctx& ctx) {
  LimitsRouter g(ctx);
  const std::string key = windowKey(ctx);
  ctx.Redis.Do("HSET", key, "requests", 10, "tokens", 99000);
  // Another replica lands right after the first command that touches the window, between a
  // client-side read and its increments, and spends every token that is left.
  bool fired = false;
  ctx.Redis.After(key, [&] {
    fired = true;
    ctx.Redis.Do("HSET", key, "tokens", 100000);
  });
  g.route(limitsBody(164));
  ctx.Assert(fired, "a request from acme never touched %s: the window lives in limits:{tenant}:{minute} (keys: %v)", key, ctx.Redis.Keys("limits:*"));
  const long long tokens = windowHash(ctx, key)["tokens"];
  ctx.Assert(tokens <= 100000, "%s holds %d tokens after another replica spent the window between your read and your increments: both requests spent the same tokens. Read, compare and increment inside one Lua script", key, tokens);
  ctx.Equal(tokens, 100000LL, "%s tokens after another replica set them to 100000 between your commands (the replica's update was lost)", key);
  const auto second = g.route(limitsBody(164));
  ctx.Equal(second.Status, 429, "with the window spent by another replica the next request");
}

void CheckTtl(harness::Ctx& ctx) {
  LimitsRouter g(ctx);
  const std::string key = windowKey(ctx);
  const auto r = g.route(limitsBody(164));
  ctx.Equal(r.Status, 200, "the first request of the minute (%s)", r.Text());
  ctx.Assert(ctx.Redis.Exists(key) == 1, "after a request %s does not exist (keys: %v)", key, ctx.Redis.Keys("limits:*"));
  const long long ttl = ctx.Redis.TTL(key);
  const long long left = 60 - (ctx.Clock.Now() / 1000) % 60;
  ctx.Assert(ttl > 0, "%s has no expiry (TTL %d): every minute leaves one hash per tenant in Redis for good", key, ttl);
  ctx.Assert(std::llabs(ttl - left) <= 2, "%s expires in %d s, expected the %d s left in its minute", key, ttl, left);
  ctx.Clock.Advance(61);
  ctx.Assert(ctx.Redis.Exists(key) == 0, "%s still exists a minute after its window ended", key);
  const auto next = g.route(limitsBody(164));
  ctx.Assert(next.Status == 200 && windowHash(ctx, windowKey(ctx))["tokens"] == 164, "the next minute starts a new window");
}

void CheckRejectHeaders(harness::Ctx& ctx) {
  LimitsRouter g(ctx);
  const std::string key = windowKey(ctx);
  ctx.Redis.Do("HSET", key, "requests", 3, "tokens", 99950);
  ctx.Redis.Do("EXPIRE", key, 30);
  const auto r = g.route(limitsBody(164));
  ctx.Equal(r.Status, 429, "a request worth 164 tokens against 50 left");
  ctx.Equal(g.served, 0, "a rejected request must not reach the route behind the guard; the route ran");
  const std::string retry = r.HeaderValue("Retry-After");
  ctx.Assert(retry == "30" || retry == "29", "Retry-After is %q, expected the key's TTL (30 s)", retry);
  ctx.Equal(r.HeaderValue("X-RateLimit-Remaining"), "50", "X-RateLimit-Remaining");
  ctx.Assert(windowHash(ctx, key) == std::map<std::string, long long>{{"requests", 3}, {"tokens", 99950}}, "a rejected request must not spend: %s holds %v", key, windowHash(ctx, key));
  const auto small = g.route(limitsBody(2, 4));
  ctx.Assert(small.Status == 200 && g.served == 1, "a request that fits (2 tokens of 50) answered %d", small.Status);
  ctx.Assert(windowHash(ctx, key) == std::map<std::string, long long>{{"requests", 4}, {"tokens", 99952}}, "after a 2-token reservation %s holds %v, expected 4 requests and 99952 tokens", key, windowHash(ctx, key));
}

void CheckRequestLimit(harness::Ctx& ctx) {
  LimitsRouter g(ctx);
  const std::string key = windowKey(ctx);
  ctx.Redis.Do("HSET", key, "requests", 59, "tokens", 0);
  ctx.Redis.Do("EXPIRE", key, 45);
  const auto sixtieth = g.route(limitsBody(2, 4));
  ctx.Equal(sixtieth.Status, 200, "the 60th request of the minute (%s)", sixtieth.Text());
  const auto sixty_first = g.route(limitsBody(2, 4));
  ctx.Equal(sixty_first.Status, 429, "the 61st request of the minute (2 tokens, the token budget nearly untouched; the window allows 60 requests)");
  ctx.Equal(g.served, 1, "the route must run once; the route ran");
  ctx.Equal(sixty_first.HeaderValue("X-RateLimit-Remaining"), "0", "with the requests spent X-RateLimit-Remaining");
  ctx.Equal(windowHash(ctx, key)["requests"], 60LL, "%s requests", key);
  const auto other = g.route(limitsBody(2, 4), "beta");
  ctx.Equal(other.Status, 200, "beta's first request (each tenant has a window of its own)");
}
`,
  },
  debrief: `The script is the fix because Redis runs it alone: between its HGET and its HINCRBY no other replica's command can land, which the three-round-trip version only had in a serial test. Both limits live in one hash under one key, so one script sees and updates them together, and the expiry is set inside it on the first write, so no path creates a key that outlives its minute. Returning \`TTL\` makes \`Retry-After\` the moment the window really resets. A fixed window still lets a tenant spend two windows' worth across a minute boundary; production limiters use a sliding window or a token bucket for that, and refund the unused part of \`max_tokens\` once the model reports what it actually generated.`,
};
