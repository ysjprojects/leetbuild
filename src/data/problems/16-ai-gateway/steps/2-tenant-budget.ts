import type {Step} from '@/lib/types';

// ---- 2. Daily token budget in Redis ------------------------------------------------------------------
export const tenantBudgetStep: Step = {
  id: 'tenant-budget',
  title: 'Daily budget: one atomic reservation',
  concept: 'redis',
  file: 'budget',
  focus: ['gateway', 'budget'],
  task: `## Task

**Starting point.** The starter is the budget guard in front of the chat route (\`budget_guard\`, a
dependency / pre-handler / middleware / pre-routing handler, depending on the stack). For every
request it takes the tenant from the bearer token, estimates \`ceil(characters / 4) + max_tokens\`,
reads the remaining budget from a Redis key, compares, decrements with \`DECRBY\`, and answers 429
when the request does not fit. The first write seeds the key with \`DAILY_TOKEN_BUDGET\`. It serves
the demo and hides 4 flaws.

**Failure mode the checks target.** Two requests from one tenant land at once and both pass the
same comparison; a key with no expiry so the budget never resets; a 429 the client cannot act on;
and a key that one tenant shares with its own tomorrow.

- The key is \`budget:{tenant}:{yyyymmdd}\` for the UTC day of the current time, holding the tokens
  remaining today.
- Read, compare, decrement and the first write with its expiry run inside **one Lua script**
  (\`EVAL\` / \`EVALSHA\`). The expiry is the time left until midnight UTC, set only when the key is
  created; a later reservation does not extend it.
- A rejected request answers **429** with \`Retry-After\` (the key's TTL in seconds) and
  \`X-RateLimit-Remaining\`, and the route behind the guard does not run.`,
  sequence: {
    participants: ['Client', 'gateway', 'Redis'],
    messages: [
      {from: 'Client', to: 'gateway', label: 'POST /v1/chat · Bearer acme · 164 tokens', kind: 'sync'},
      {from: 'gateway', to: 'Redis', label: 'EVALSHA reserve budget:acme:20261102 164 1000000 ttl', kind: 'sync'},
      {from: 'Redis', to: 'gateway', label: '{1, 999836, 41377}  (ok, remaining, ttl)', kind: 'reply'},
      {from: 'gateway', to: 'Client', label: '200 (the route ran)', kind: 'reply'},
      {from: 'gateway', to: 'Redis', label: 'EVALSHA reserve … (budget spent)', kind: 'sync'},
      {from: 'Redis', to: 'gateway', label: '{0, 50, 3600}', kind: 'reply'},
      {from: 'gateway', to: 'Client', label: '429 · Retry-After: 3600 · X-RateLimit-Remaining: 50', kind: 'reply'},
    ],
  },
  hints: [
    "On a busy day a tenant spends more than its budget and the remaining count goes negative; yesterday's key is still there this morning; a client that got a 429 retries at once.",
    'GET, a comparison, then DECRBY are three round trips: a second request slips in between and passes the same check. A SET with no EX lives forever; a key without the day is the same key tomorrow.',
    'Put GET, the comparison, SET … EX ttl on a missing key and DECRBY in one script returning `{ok, remaining, TTL}`; key by tenant and UTC date; answer 429 with `Retry-After: <ttl>` and `X-RateLimit-Remaining`.',
  ],
  checks: [
    {
      id: 'atomic',
      title: 'Reserves inside one Lua script',
      detail:
        'The read, the comparison and the decrement run inside one script (`EVAL` / `EVALSHA`, `register_script`, `defineCommand`, `NewScript`); a client-side GET followed by DECRBY lets two requests spend the same budget.',
      match: {
        python: {
          all: [
            /redis\.call\(\s*['"]GET['"]/,
            /redis\.call\(\s*['"]DECRBY['"]/,
            /register_script\(|\.eval\(|\.evalsha\(/,
          ],
          none: [/\br\.get\(\s*key|\br\.decrby\(/],
        },
        typescript: {
          all: [
            /redis\.call\(\s*['"]GET['"]/,
            /redis\.call\(\s*['"]DECRBY['"]/,
            /defineCommand\(|\.eval\(|\.evalsha\(/,
          ],
          none: [/redis\.get\(\s*key|redis\.decrby\(/],
        },
        go: {
          all: [
            /redis\.call\(\s*['"]GET['"]/,
            /redis\.call\(\s*['"]DECRBY['"]/,
            /redis\.NewScript\(|\.Eval\(|\.EvalSha\(/,
          ],
          none: [/rdb\.Get\(|rdb\.DecrBy\(/],
        },
        scala: {
          all: [/redis\.call\(\s*['"]GET['"]/, /redis\.call\(\s*['"]DECRBY['"]/, /jedis\.eval(sha)?\(/],
          none: [/jedis\.get\(|jedis\.decrBy\(/],
        },
        cpp: {
          all: [/redis\.call\(\s*['"]GET['"]/, /redis\.call\(\s*['"]DECRBY['"]/, /redis\.eval(sha)?[<(]/],
          none: [/redis\.get\(|redis\.decrby\(/],
        },
      },
    },
    {
      id: 'ttl',
      title: 'The day key expires at midnight UTC',
      detail:
        'The script creates the key with `SET … EX <seconds to midnight>` (or an `EXPIRE` right after) and reports its `TTL`; a key with no expiry never resets, and an expiry set on every reservation keeps moving.',
      match: {
        python: {
          all: [
            /redis\.call\(\s*['"]SET['"][^\n]*['"]EX['"]|redis\.call\(\s*['"]SETEX['"]|redis\.call\(\s*['"]EXPIRE['"]/,
            /redis\.call\(\s*['"]TTL['"]/,
          ],
        },
        typescript: {
          all: [
            /redis\.call\(\s*['"]SET['"][^\n]*['"]EX['"]|redis\.call\(\s*['"]SETEX['"]|redis\.call\(\s*['"]EXPIRE['"]/,
            /redis\.call\(\s*['"]TTL['"]/,
          ],
        },
        go: {
          all: [
            /redis\.call\(\s*['"]SET['"][^\n]*['"]EX['"]|redis\.call\(\s*['"]SETEX['"]|redis\.call\(\s*['"]EXPIRE['"]/,
            /redis\.call\(\s*['"]TTL['"]/,
          ],
        },
        scala: {
          all: [
            /redis\.call\(\s*['"]SET['"][^\n]*['"]EX['"]|redis\.call\(\s*['"]SETEX['"]|redis\.call\(\s*['"]EXPIRE['"]/,
            /redis\.call\(\s*['"]TTL['"]/,
          ],
        },
        cpp: {
          all: [
            /redis\.call\(\s*['"]SET['"][^\n]*['"]EX['"]|redis\.call\(\s*['"]SETEX['"]|redis\.call\(\s*['"]EXPIRE['"]/,
            /redis\.call\(\s*['"]TTL['"]/,
          ],
        },
      },
    },
    {
      id: 'reject-headers',
      title: 'Answers 429 with Retry-After and X-RateLimit-Remaining',
      detail:
        "A request that does not fit answers `429 Too Many Requests` with `Retry-After` (the key's TTL) and `X-RateLimit-Remaining`, and the route behind the guard does not run.",
      match: {
        python: {all: [/Retry-After/, /X-RateLimit-Remaining/, /\b429\b/]},
        typescript: {all: [/Retry-After/, /X-RateLimit-Remaining/, /\b429\b/]},
        go: {all: [/Retry-After/, /X-RateLimit-Remaining/, /http\.StatusTooManyRequests|\b429\b/]},
        scala: {all: [/Retry-After/, /X-RateLimit-Remaining/, /StatusCodes\.TooManyRequests|\b429\b/]},
        cpp: {all: [/Retry-After/, /X-RateLimit-Remaining/, /\b429\b/]},
      },
    },
    {
      id: 'tenant-day-key',
      title: 'Keys by tenant and UTC day',
      detail:
        "The key is `budget:{tenant}:{yyyymmdd}` from the authenticated tenant and the UTC date of the current time; without the day, today's key is tomorrow's.",
      match: {
        python: {all: [/f["']budget:\{tenant\}:\{/, /%Y%m%d|strftime|\.date\(\)/]},
        typescript: {all: [/`budget:\$\{tenant\}:\$\{/, /toISOString|getUTC/]},
        go: {all: [/"budget:%s:%s"|"budget:"\s*\+\s*tenant\s*\+\s*":"/, /20060102/]},
        scala: {all: [/s"budget:\$\{?tenant\}?:\$/, /yyyyMMdd|BASIC_ISO_DATE/]},
        cpp: {all: [/"budget:"\s*\+\s*tenant\s*\+\s*":"/, /%Y%m%d/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import math
import time

import redis
from fastapi import HTTPException, Request

from gateway.auth import authenticate

r = redis.Redis(host="redis", port=6379, decode_responses=True)

DAILY_TOKEN_BUDGET = 1_000_000


def wanted_tokens(body: dict) -> int:
    """What a request may cost: the input estimate plus what the model may generate."""
    chars = sum(len(m.get("content", "")) for m in body.get("messages", []))
    return math.ceil(chars / 4) + int(body.get("max_tokens", 512))


# TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
def reserve(tenant: str, tokens: int) -> tuple[bool, int, int]:
    """Take tokens from the tenant's budget: (ok, remaining, seconds until the budget resets)."""
    key = f"budget:{tenant}"
    left = r.get(key)
    if left is None:
        r.set(key, DAILY_TOKEN_BUDGET)
        left = DAILY_TOKEN_BUDGET
    left = int(left)
    if tokens > left:
        return False, left, 0
    r.decrby(key, tokens)
    return True, left - tokens, 0


async def budget_guard(request: Request) -> None:
    """Runs before the chat route (\`dependencies=[Depends(budget_guard)]\`): reserves or answers 429."""
    tenant = authenticate(request.headers.get("authorization"))
    ok, left, ttl = reserve(tenant, wanted_tokens(await request.json()))
    if not ok:
        raise HTTPException(status_code=429, detail="daily token budget exhausted")
`,
      solution: `import math
import time

import redis
from fastapi import HTTPException, Request

from gateway.auth import authenticate

r = redis.Redis(host="redis", port=6379, decode_responses=True)

DAILY_TOKEN_BUDGET = 1_000_000

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
reserve_script = r.register_script(RESERVE_LUA)


def wanted_tokens(body: dict) -> int:
    """What a request may cost: the input estimate plus what the model may generate."""
    chars = sum(len(m.get("content", "")) for m in body.get("messages", []))
    return math.ceil(chars / 4) + int(body.get("max_tokens", 512))


def budget_key(tenant: str) -> str:
    day = time.strftime("%Y%m%d", time.gmtime(time.time()))
    return f"budget:{tenant}:{day}"


def seconds_to_midnight() -> int:
    return 86400 - int(time.time()) % 86400


def reserve(tenant: str, tokens: int) -> tuple[bool, int, int]:
    """Take tokens from the tenant's budget: (ok, remaining, seconds until the budget resets)."""
    ok, left, ttl = reserve_script(keys=[budget_key(tenant)], args=[tokens, DAILY_TOKEN_BUDGET, seconds_to_midnight()])
    return bool(ok), int(left), int(ttl)


async def budget_guard(request: Request) -> None:
    """Runs before the chat route (\`dependencies=[Depends(budget_guard)]\`): reserves or answers 429."""
    tenant = authenticate(request.headers.get("authorization"))
    ok, left, ttl = reserve(tenant, wanted_tokens(await request.json()))
    if not ok:
        raise HTTPException(
            status_code=429,
            detail="daily token budget exhausted",
            headers={"Retry-After": str(max(ttl, 1)), "X-RateLimit-Remaining": str(left)},
        )
`,
    },
    typescript: {
      starter: `import type {FastifyReply, FastifyRequest} from 'fastify';
import {authenticate} from 'gateway/auth';
import Redis from 'ioredis';

export const DAILY_TOKEN_BUDGET = 1_000_000;

const redis = new Redis({host: 'redis', port: 6379});

interface ChatBody {
  messages?: {content?: string}[];
  max_tokens?: number;
}

/** What a request may cost: the input estimate plus what the model may generate. */
export function wantedTokens(body: ChatBody): number {
  const chars = (body.messages ?? []).reduce((n, m) => n + (m.content ?? '').length, 0);
  return Math.ceil(chars / 4) + (body.max_tokens ?? 512);
}

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
/** Take tokens from the tenant's budget: [ok, remaining, seconds until the budget resets]. */
export async function reserve(tenant: string, tokens: number): Promise<[boolean, number, number]> {
  const key = \`budget:\${tenant}\`;
  let left = await redis.get(key);
  if (left === null) {
    await redis.set(key, DAILY_TOKEN_BUDGET);
    left = String(DAILY_TOKEN_BUDGET);
  }
  const remaining = Number(left);
  if (tokens > remaining) return [false, remaining, 0];
  await redis.decrby(key, tokens);
  return [true, remaining - tokens, 0];
}

/** The chat route's preHandler: reserves or answers 429. */
export async function budgetGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tenant = authenticate(request.headers.authorization);
  const [ok] = await reserve(tenant, wantedTokens(request.body as ChatBody));
  if (!ok) reply.code(429).send({error: 'daily token budget exhausted'});
}
`,
      solution: `import type {FastifyReply, FastifyRequest} from 'fastify';
import {authenticate} from 'gateway/auth';
import Redis from 'ioredis';

export const DAILY_TOKEN_BUDGET = 1_000_000;

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

interface BudgetRedis extends Redis {
  reserve(key: string, tokens: number, budget: number, ttl: number): Promise<[number, number, number]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as BudgetRedis;
redis.defineCommand('reserve', {numberOfKeys: 1, lua: RESERVE_LUA});

interface ChatBody {
  messages?: {content?: string}[];
  max_tokens?: number;
}

/** What a request may cost: the input estimate plus what the model may generate. */
export function wantedTokens(body: ChatBody): number {
  const chars = (body.messages ?? []).reduce((n, m) => n + (m.content ?? '').length, 0);
  return Math.ceil(chars / 4) + (body.max_tokens ?? 512);
}

function budgetKey(tenant: string): string {
  const day = new Date(Date.now()).toISOString().slice(0, 10).replace(/-/g, '');
  return \`budget:\${tenant}:\${day}\`;
}

function secondsToMidnight(): number {
  return 86400 - (Math.floor(Date.now() / 1000) % 86400);
}

/** Take tokens from the tenant's budget: [ok, remaining, seconds until the budget resets]. */
export async function reserve(tenant: string, tokens: number): Promise<[boolean, number, number]> {
  const [ok, left, ttl] = await redis.reserve(budgetKey(tenant), tokens, DAILY_TOKEN_BUDGET, secondsToMidnight());
  return [ok === 1, left, ttl];
}

/** The chat route's preHandler: reserves or answers 429. */
export async function budgetGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const tenant = authenticate(request.headers.authorization);
  const [ok, left, ttl] = await reserve(tenant, wantedTokens(request.body as ChatBody));
  if (!ok) {
    reply
      .code(429)
      .headers({'Retry-After': String(Math.max(ttl, 1)), 'X-RateLimit-Remaining': String(left)})
      .send({error: 'daily token budget exhausted'});
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
	"io"
	"math"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"

	"gateway/auth"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const dailyTokenBudget = 1_000_000

type chatBody struct {
	Messages  []struct{ Content string \`json:"content"\` } \`json:"messages"\`
	MaxTokens *int                                        \`json:"max_tokens"\`
}

// wantedTokens is what a request may cost: the input estimate plus what the model may generate.
func wantedTokens(body chatBody) int {
	chars := 0
	for _, m := range body.Messages {
		chars += len(m.Content)
	}
	max := 512
	if body.MaxTokens != nil {
		max = *body.MaxTokens
	}
	return int(math.Ceil(float64(chars)/4)) + max
}

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
// reserve takes tokens from the tenant's budget: ok, remaining, seconds until the budget resets.
func reserve(ctx context.Context, tenant string, tokens int) (bool, int, int, error) {
	key := "budget:" + tenant
	left, err := rdb.Get(ctx, key).Int()
	if err == redis.Nil {
		if err := rdb.Set(ctx, key, dailyTokenBudget, 0).Err(); err != nil {
			return false, 0, 0, err
		}
		left = dailyTokenBudget
	} else if err != nil {
		return false, 0, 0, err
	}
	if tokens > left {
		return false, left, 0, nil
	}
	if err := rdb.DecrBy(ctx, key, int64(tokens)).Err(); err != nil {
		return false, 0, 0, err
	}
	return true, left - tokens, 0, nil
}

// budgetGuard wraps the chat route: reserves or answers 429.
func budgetGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		tenant, ok := auth.Tenant(r)
		if !ok {
			http.Error(rw, "missing bearer token", http.StatusUnauthorized)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(raw))
		var body chatBody
		_ = json.Unmarshal(raw, &body)
		allowed, _, _, err := reserve(r.Context(), tenant, wantedTokens(body))
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		if !allowed {
			http.Error(rw, "daily token budget exhausted", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(rw, r)
	})
}

var _ = time.Now
`,
      solution: `package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"gateway/auth"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const dailyTokenBudget = 1_000_000

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

type chatBody struct {
	Messages  []struct{ Content string \`json:"content"\` } \`json:"messages"\`
	MaxTokens *int                                        \`json:"max_tokens"\`
}

// wantedTokens is what a request may cost: the input estimate plus what the model may generate.
func wantedTokens(body chatBody) int {
	chars := 0
	for _, m := range body.Messages {
		chars += len(m.Content)
	}
	max := 512
	if body.MaxTokens != nil {
		max = *body.MaxTokens
	}
	return int(math.Ceil(float64(chars)/4)) + max
}

func budgetKey(tenant string) string {
	return "budget:" + tenant + ":" + time.Now().UTC().Format("20060102")
}

func secondsToMidnight() int {
	return 86400 - int(time.Now().Unix()%86400)
}

// reserve takes tokens from the tenant's budget: ok, remaining, seconds until the budget resets.
func reserve(ctx context.Context, tenant string, tokens int) (bool, int, int, error) {
	res, err := reserveScript.Run(ctx, rdb, []string{budgetKey(tenant)}, tokens, dailyTokenBudget, secondsToMidnight()).Int64Slice()
	if err != nil {
		return false, 0, 0, err
	}
	return res[0] == 1, int(res[1]), int(res[2]), nil
}

// budgetGuard wraps the chat route: reserves or answers 429.
func budgetGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		tenant, ok := auth.Tenant(r)
		if !ok {
			http.Error(rw, "missing bearer token", http.StatusUnauthorized)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		r.Body = io.NopCloser(bytes.NewReader(raw))
		var body chatBody
		_ = json.Unmarshal(raw, &body)
		allowed, left, ttl, err := reserve(r.Context(), tenant, wantedTokens(body))
		if err != nil {
			http.Error(rw, err.Error(), http.StatusInternalServerError)
			return
		}
		if !allowed {
			rw.Header().Set("Retry-After", strconv.Itoa(max(ttl, 1)))
			rw.Header().Set("X-RateLimit-Remaining", strconv.Itoa(left))
			http.Error(rw, "daily token budget exhausted", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(rw, r)
	})
}
`,
    },
    scala: {
      starter: `import java.time.format.DateTimeFormatter
import java.time.{Instant, ZoneOffset}

import gateway.Auth
import org.apache.pekko.http.scaladsl.model.{HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Directive0
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object Budget {
  val jedis = new JedisPooled("redis", 6379)

  val DailyTokenBudget = 1000000L

  case class Reservation(ok: Boolean, remaining: Long, ttl: Long)

  /** What a request may cost: the input estimate plus what the model may generate. */
  def wantedTokens(body: String): Long = {
    val json = ujson.read(body)
    val chars = json.obj.get("messages").map(_.arr.map(m => m.obj.get("content").map(_.str.length).getOrElse(0)).sum).getOrElse(0)
    math.ceil(chars / 4.0).toLong + json.obj.get("max_tokens").map(_.num.toLong).getOrElse(512L)
  }

  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  /** Take tokens from the tenant's budget. */
  def reserve(tenant: String, tokens: Long): Reservation = {
    val key = s"budget:$tenant"
    val left = Option(jedis.get(key)) match {
      case Some(v) => v.toLong
      case None =>
        jedis.set(key, DailyTokenBudget.toString)
        DailyTokenBudget
    }
    if (tokens > left) Reservation(ok = false, left, 0)
    else {
      jedis.decrBy(key, tokens)
      Reservation(ok = true, left - tokens, 0)
    }
  }

  /** Wraps the chat route: reserves or answers 429. */
  def budgeted(tenant: String, body: String): Directive0 = {
    val r = reserve(tenant, wantedTokens(body))
    if (r.ok) pass
    else complete(HttpResponse(StatusCodes.TooManyRequests, entity = "daily token budget exhausted"))
  }

  val guarded: Directive0 =
    optionalHeaderValueByName("Authorization").flatMap { authorization =>
      Auth.tenant(authorization) match {
        case None => complete(HttpResponse(StatusCodes.Unauthorized, entity = "missing bearer token"))
        case Some(tenant) => entity(as[String]).flatMap(body => budgeted(tenant, body))
      }
    }
}
`,
      solution: `import java.time.format.DateTimeFormatter
import java.time.{Instant, ZoneOffset}

import gateway.Auth
import org.apache.pekko.http.scaladsl.model.{HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Directive0
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object Budget {
  val jedis = new JedisPooled("redis", 6379)

  val DailyTokenBudget = 1000000L

  val ReserveLua: String =
    """local left = tonumber(redis.call('GET', KEYS[1]))
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
  private val sha = jedis.scriptLoad(ReserveLua)

  case class Reservation(ok: Boolean, remaining: Long, ttl: Long)

  /** What a request may cost: the input estimate plus what the model may generate. */
  def wantedTokens(body: String): Long = {
    val json = ujson.read(body)
    val chars = json.obj.get("messages").map(_.arr.map(m => m.obj.get("content").map(_.str.length).getOrElse(0)).sum).getOrElse(0)
    math.ceil(chars / 4.0).toLong + json.obj.get("max_tokens").map(_.num.toLong).getOrElse(512L)
  }

  private val Day = DateTimeFormatter.ofPattern("yyyyMMdd").withZone(ZoneOffset.UTC)

  def budgetKey(tenant: String): String = s"budget:$tenant:\${Day.format(Instant.now())}"

  def secondsToMidnight(): Long = 86400L - Instant.now().getEpochSecond % 86400L

  /** Take tokens from the tenant's budget. */
  def reserve(tenant: String, tokens: Long): Reservation = {
    val args = List(tokens.toString, DailyTokenBudget.toString, secondsToMidnight().toString).asJava
    val reply = jedis.evalsha(sha, List(budgetKey(tenant)).asJava, args).asInstanceOf[java.util.List[java.lang.Long]].asScala
    Reservation(reply(0) == 1L, reply(1), reply(2))
  }

  /** Wraps the chat route: reserves or answers 429. */
  def budgeted(tenant: String, body: String): Directive0 = {
    val r = reserve(tenant, wantedTokens(body))
    if (r.ok) pass
    else {
      val headers = List(RawHeader("Retry-After", math.max(r.ttl, 1L).toString), RawHeader("X-RateLimit-Remaining", r.remaining.toString))
      complete(HttpResponse(StatusCodes.TooManyRequests, headers = headers, entity = "daily token budget exhausted"))
    }
  }

  val guarded: Directive0 =
    optionalHeaderValueByName("Authorization").flatMap { authorization =>
      Auth.tenant(authorization) match {
        case None => complete(HttpResponse(StatusCodes.Unauthorized, entity = "missing bearer token"))
        case Some(tenant) => entity(as[String]).flatMap(body => budgeted(tenant, body))
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
#include <cmath>
#include <ctime>
#include <iterator>
#include <string>
#include <vector>

#include "gateway/auth.h"

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kDailyTokenBudget = 1000000;

struct Reservation {
  bool ok;
  long long remaining;
  long long ttl;
};

// What a request may cost: the input estimate plus what the model may generate.
long long wanted_tokens(const std::string& body) {
  nlohmann::json json = nlohmann::json::object();
  try {
    json = nlohmann::json::parse(body);
  } catch (const std::exception&) {
  }
  size_t chars = 0;
  for (const auto& m : json.value("messages", nlohmann::json::array())) chars += m.value("content", "").size();
  return static_cast<long long>(std::ceil(chars / 4.0)) + json.value("max_tokens", 512);
}

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
// Take tokens from the tenant's budget.
Reservation reserve(const std::string& tenant, long long tokens) {
  const std::string key = "budget:" + tenant;
  auto value = redis.get(key);
  long long left = kDailyTokenBudget;
  if (!value) {
    redis.set(key, std::to_string(kDailyTokenBudget));
  } else {
    left = std::stoll(*value);
  }
  if (tokens > left) return {false, left, 0};
  redis.decrby(key, tokens);
  return {true, left - tokens, 0};
}

// Registered with svr.set_pre_routing_handler: reserves or answers 429 before the chat route.
httplib::Server::HandlerResponse budget_guard(const httplib::Request& req, httplib::Response& res) {
  const auto tenant = gateway::tenant(req);
  if (!tenant) {
    res.status = 401;
    res.set_content("missing bearer token", "text/plain");
    return httplib::Server::HandlerResponse::Handled;
  }
  const Reservation r = reserve(*tenant, wanted_tokens(req.body));
  if (!r.ok) {
    res.status = 429;
    res.set_content("daily token budget exhausted", "text/plain");
    return httplib::Server::HandlerResponse::Handled;
  }
  return httplib::Server::HandlerResponse::Unhandled;
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cmath>
#include <ctime>
#include <iterator>
#include <string>
#include <vector>

#include "gateway/auth.h"

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kDailyTokenBudget = 1000000;

const std::string kReserveLua = R"lua(
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
)lua";
const std::string kReserveSha = redis.script_load(kReserveLua);

struct Reservation {
  bool ok;
  long long remaining;
  long long ttl;
};

// What a request may cost: the input estimate plus what the model may generate.
long long wanted_tokens(const std::string& body) {
  nlohmann::json json = nlohmann::json::object();
  try {
    json = nlohmann::json::parse(body);
  } catch (const std::exception&) {
  }
  size_t chars = 0;
  for (const auto& m : json.value("messages", nlohmann::json::array())) chars += m.value("content", "").size();
  return static_cast<long long>(std::ceil(chars / 4.0)) + json.value("max_tokens", 512);
}

std::string budget_key(const std::string& tenant) {
  const std::time_t now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  char day[9];
  std::strftime(day, sizeof day, "%Y%m%d", std::gmtime(&now));
  return "budget:" + tenant + ":" + day;
}

long long seconds_to_midnight() {
  const long long now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  return 86400 - now % 86400;
}

// Take tokens from the tenant's budget.
Reservation reserve(const std::string& tenant, long long tokens) {
  std::vector<long long> reply;
  redis.evalsha(kReserveSha, {budget_key(tenant)},
                {std::to_string(tokens), std::to_string(kDailyTokenBudget), std::to_string(seconds_to_midnight())},
                std::back_inserter(reply));
  return {reply[0] == 1, reply[1], reply[2]};
}

// Registered with svr.set_pre_routing_handler: reserves or answers 429 before the chat route.
httplib::Server::HandlerResponse budget_guard(const httplib::Request& req, httplib::Response& res) {
  const auto tenant = gateway::tenant(req);
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
    res.set_content("daily token budget exhausted", "text/plain");
    return httplib::Server::HandlerResponse::Handled;
  }
  return httplib::Server::HandlerResponse::Unhandled;
}
`,
    },
  },
  harness: {
    python: `import time

from fastapi import Depends, FastAPI, Request

AUTH = {"Authorization": "Bearer acme"}


def _day(ctx):
    return time.strftime("%Y%m%d", time.gmtime(ctx.clock.time()))


def _gateway(ctx):
    """The guard needs a route to guard: one the harness registers, counting what got through."""
    m = ctx.load("budget")
    app = FastAPI()
    served = []

    @app.post("/v1/chat", dependencies=[Depends(m.budget_guard)])
    async def chat(request: Request):
        served.append(await request.json())
        return {"id": "r-1", "content": "ok"}

    m.app, m.served = app, served
    return m


def _body(tokens, content_chars=400):
    """A request worth content_chars / 4 + max_tokens tokens."""
    return {"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "x" * content_chars}], "max_tokens": tokens - content_chars // 4}


async def _chat(ctx, m, body, headers=AUTH):
    async with ctx.client(m.app) as c:
        return await c.post("/v1/chat", json=body, headers=headers)


async def check_atomic(ctx):
    m = _gateway(ctx)
    key = f"budget:acme:{_day(ctx)}"
    ctx.redis.set(key, 10000)
    # Another gateway replica lands right after the first command that touches the budget, between a
    # client-side read and its decrement, and spends everything that is left.
    probe = ctx.redis_after(key, lambda: ctx.redis.set(key, 0))
    r = await _chat(ctx, m, _body(164))
    assert probe.fired, f"a request from acme never touched {key}: the budget lives in budget:{{tenant}}:{{yyyymmdd}} (keys: {sorted(ctx.redis.keys('budget:*'))})"
    left = int(ctx.redis.get(key))
    assert left >= 0, f"{key} holds {left} after another replica emptied it between your read and your decrement: both requests spent the same budget. Read, compare and decrement inside one Lua script"
    assert left == 0, f"{key} holds {left} after another replica set it to 0 between your commands: the replica's update was lost. Read, compare and decrement inside one Lua script"
    second = await _chat(ctx, m, _body(164))
    assert second.status_code == 429, f"with the budget emptied by another replica the next request answered {second.status_code}, expected 429"


async def check_ttl(ctx):
    m = _gateway(ctx)
    key = f"budget:acme:{_day(ctx)}"
    r = await _chat(ctx, m, _body(164))
    assert r.status_code == 200, f"the first request of the day answered {r.status_code}: {r.text}"
    assert ctx.redis.exists(key), f"after a request {key} does not exist (keys: {sorted(ctx.redis.keys('budget:*'))})"
    ttl = ctx.redis.ttl(key)
    assert ttl > 0, f"{key} has no expiry (TTL {ttl}): the daily budget never resets"
    midnight = 86400 - int(ctx.clock.time()) % 86400
    assert abs(ttl - midnight) <= 2, f"{key} expires in {ttl} s, expected the {midnight} s left until midnight UTC"
    ctx.clock.advance(100)
    await _chat(ctx, m, _body(164))
    later = ctx.redis.ttl(key)
    assert abs(later - (midnight - 100)) <= 2, f"after 100 s and a second reservation the TTL is {later} s, expected about {midnight - 100}: the expiry is set when the key is created, a reservation must not extend it"


async def check_reject_headers(ctx):
    m = _gateway(ctx)
    key = f"budget:acme:{_day(ctx)}"
    ctx.redis.set(key, 50, ex=3600)
    r = await _chat(ctx, m, _body(164))
    assert r.status_code == 429, f"a request worth 164 tokens against 50 remaining answered {r.status_code}, expected 429"
    assert m.served == [], "a rejected request must not reach the route behind the guard"
    assert r.headers.get("retry-after") in ("3600", "3599"), f"Retry-After is {r.headers.get('retry-after')!r}, expected the key's TTL (3600 s)"
    assert r.headers.get("x-ratelimit-remaining") == "50", f"X-RateLimit-Remaining is {r.headers.get('x-ratelimit-remaining')!r}, expected 50"
    assert int(ctx.redis.get(key)) == 50, f"a rejected request must not spend: {key} holds {ctx.redis.get(key)}, expected 50"
    small = await _chat(ctx, m, _body(2, content_chars=4))
    assert small.status_code == 200 and len(m.served) == 1, f"a request that fits (2 tokens of 50) answered {small.status_code}"
    assert int(ctx.redis.get(key)) == 48, f"after a 2-token reservation {key} holds {ctx.redis.get(key)}, expected 48"


async def check_tenant_day_key(ctx):
    m = _gateway(ctx)
    day = _day(ctx)
    await _chat(ctx, m, _body(164))
    await _chat(ctx, m, _body(164), headers={"Authorization": "Bearer beta"})
    keys = sorted(ctx.redis.keys("budget:*"))
    assert keys == [f"budget:acme:{day}", f"budget:beta:{day}"], f"after one request each from acme and beta the budget keys are {keys}, expected budget:acme:{day} and budget:beta:{day}"
    assert int(ctx.redis.get(f"budget:acme:{day}")) == 1_000_000 - 164, f"budget:acme:{day} holds {ctx.redis.get(f'budget:acme:{day}')}, expected 1000000 - 164"
    ctx.clock.advance(86400)
    tomorrow = _day(ctx)
    r = await _chat(ctx, m, _body(164))
    assert r.status_code == 200, f"the first request of the next day answered {r.status_code}"
    assert ctx.redis.exists(f"budget:acme:{tomorrow}"), f"the next day's request must open budget:acme:{tomorrow}; keys: {sorted(ctx.redis.keys('budget:*'))}"
    assert int(ctx.redis.get(f"budget:acme:{tomorrow}")) == 1_000_000 - 164, "the next day starts from a full budget"
`,
    typescript: `import Fastify from 'fastify';

const AUTH = {Authorization: 'Bearer acme'};

const day = (ctx): string => new Date(ctx.clock.now()).toISOString().slice(0, 10).replace(/-/g, '');

/** The guard needs a route to guard: one the harness registers, counting what got through. */
function gateway(ctx) {
  const m = ctx.load('budget');
  const app = Fastify();
  const served: unknown[] = [];
  app.post('/v1/chat', {preHandler: m.budgetGuard}, async request => {
    served.push(request.body);
    return {id: 'r-1', content: 'ok'};
  });
  return {m, served, c: ctx.client(app)};
}

/** A request worth contentChars / 4 + max_tokens tokens. */
const body = (tokens: number, contentChars = 400) => ({
  model: 'gpt-4o-mini',
  messages: [{role: 'user', content: 'x'.repeat(contentChars)}],
  max_tokens: tokens - contentChars / 4,
});

export async function check_atomic(ctx) {
  const {c} = gateway(ctx);
  const key = \`budget:acme:\${day(ctx)}\`;
  ctx.redis.set(key, 10000);
  // Another gateway replica lands right after the first command that touches the budget, between a
  // client-side read and its decrement, and spends everything that is left.
  const probe = ctx.redisAfter(key, () => ctx.redis.set(key, 0));
  await c.post('/v1/chat', {body: body(164), headers: AUTH});
  assert(probe.fired, \`a request from acme never touched \${key}: the budget lives in budget:{tenant}:{yyyymmdd} (keys: \${JSON.stringify(ctx.redis.keys('budget:*').sort())})\`);
  const left = Number(ctx.redis.get(key));
  assert(left >= 0, \`\${key} holds \${left} after another replica emptied it between your read and your decrement: both requests spent the same budget. Read, compare and decrement inside one Lua script\`);
  assert.equal(left, 0, \`\${key} holds \${left} after another replica set it to 0 between your commands: the replica's update was lost. Read, compare and decrement inside one Lua script\`);
  const second = await c.post('/v1/chat', {body: body(164), headers: AUTH});
  assert.equal(second.status, 429, \`with the budget emptied by another replica the next request answered \${second.status}, expected 429\`);
}

export async function check_ttl(ctx) {
  const {c} = gateway(ctx);
  const key = \`budget:acme:\${day(ctx)}\`;
  const r = await c.post('/v1/chat', {body: body(164), headers: AUTH});
  assert.equal(r.status, 200, \`the first request of the day answered \${r.status}: \${r.text}\`);
  assert(ctx.redis.exists(key), \`after a request \${key} does not exist (keys: \${JSON.stringify(ctx.redis.keys('budget:*').sort())})\`);
  const ttl = Number(ctx.redis.ttl(key));
  assert(ttl > 0, \`\${key} has no expiry (TTL \${ttl}): the daily budget never resets\`);
  const midnight = 86400 - (Math.floor(ctx.clock.now() / 1000) % 86400);
  assert(Math.abs(ttl - midnight) <= 2, \`\${key} expires in \${ttl} s, expected the \${midnight} s left until midnight UTC\`);
  ctx.clock.advance(100);
  await c.post('/v1/chat', {body: body(164), headers: AUTH});
  const later = Number(ctx.redis.ttl(key));
  assert(Math.abs(later - (midnight - 100)) <= 2, \`after 100 s and a second reservation the TTL is \${later} s, expected about \${midnight - 100}: the expiry is set when the key is created, a reservation must not extend it\`);
}

export async function check_reject_headers(ctx) {
  const {c, served} = gateway(ctx);
  const key = \`budget:acme:\${day(ctx)}\`;
  ctx.redis.set(key, 50, 'EX', 3600);
  const r = await c.post('/v1/chat', {body: body(164), headers: AUTH});
  assert.equal(r.status, 429, \`a request worth 164 tokens against 50 remaining answered \${r.status}, expected 429\`);
  assert.equal(served.length, 0, 'a rejected request must not reach the route behind the guard');
  assert(['3600', '3599'].includes(r.headers['retry-after']), \`Retry-After is \${JSON.stringify(r.headers['retry-after'])}, expected the key's TTL (3600 s)\`);
  assert.equal(r.headers['x-ratelimit-remaining'], '50', \`X-RateLimit-Remaining is \${JSON.stringify(r.headers['x-ratelimit-remaining'])}, expected 50\`);
  assert.equal(Number(ctx.redis.get(key)), 50, \`a rejected request must not spend: \${key} holds \${ctx.redis.get(key)}, expected 50\`);
  const small = await c.post('/v1/chat', {body: body(2, 4), headers: AUTH});
  assert(small.status === 200 && served.length === 1, \`a request that fits (2 tokens of 50) answered \${small.status}\`);
  assert.equal(Number(ctx.redis.get(key)), 48, \`after a 2-token reservation \${key} holds \${ctx.redis.get(key)}, expected 48\`);
}

export async function check_tenant_day_key(ctx) {
  const {c} = gateway(ctx);
  const today = day(ctx);
  await c.post('/v1/chat', {body: body(164), headers: AUTH});
  await c.post('/v1/chat', {body: body(164), headers: {Authorization: 'Bearer beta'}});
  const keys = ctx.redis.keys('budget:*').sort();
  assert.deepStrictEqual(keys, [\`budget:acme:\${today}\`, \`budget:beta:\${today}\`], \`after one request each from acme and beta the budget keys are \${JSON.stringify(keys)}, expected budget:acme:\${today} and budget:beta:\${today}\`);
  assert.equal(Number(ctx.redis.get(\`budget:acme:\${today}\`)), 1_000_000 - 164, \`budget:acme:\${today} holds \${ctx.redis.get(\`budget:acme:\${today}\`)}, expected 1000000 - 164\`);
  ctx.clock.advance(86400);
  const tomorrow = day(ctx);
  const r = await c.post('/v1/chat', {body: body(164), headers: AUTH});
  assert.equal(r.status, 200, \`the first request of the next day answered \${r.status}\`);
  assert(ctx.redis.exists(\`budget:acme:\${tomorrow}\`), \`the next day's request must open budget:acme:\${tomorrow}; keys: \${JSON.stringify(ctx.redis.keys('budget:*').sort())}\`);
  assert.equal(Number(ctx.redis.get(\`budget:acme:\${tomorrow}\`)), 1_000_000 - 164, 'the next day starts from a full budget');
}
`,
    go: `package main

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"leetbuild/harness"
)

// budgetGateway is budgetGuard wrapped around a route the harness registers, counting what got through.
type budgetGateway struct {
	served int
	http   *harness.HTTP
}

func newBudgetGateway(ctx *harness.Ctx) *budgetGateway {
	g := &budgetGateway{}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/chat", func(rw http.ResponseWriter, r *http.Request) {
		g.served++
		rw.Header().Set("Content-Type", "application/json")
		rw.Write([]byte(\`{"id":"r-1","content":"ok"}\`))
	})
	g.http = ctx.HTTP(budgetGuard(mux))
	return g
}

func budgetDay(ctx *harness.Ctx) string {
	return time.UnixMilli(ctx.Clock.Now()).UTC().Format("20060102")
}

// budgetBody is a request worth contentChars / 4 + max_tokens tokens.
func budgetBody(tokens, contentChars int) string {
	return fmt.Sprintf(\`{"model":"gpt-4o-mini","messages":[{"role":"user","content":"%s"}],"max_tokens":%d}\`, strings.Repeat("x", contentChars), tokens-contentChars/4)
}

func budgetValue(ctx *harness.Ctx, key string) int {
	v, _ := ctx.Redis.Get(key)
	n, _ := strconv.Atoi(v)
	return n
}

func CheckAtomic(ctx *harness.Ctx) {
	g := newBudgetGateway(ctx)
	key := "budget:acme:" + budgetDay(ctx)
	ctx.Redis.Set(key, 10000)
	// Another gateway replica lands right after the first command that touches the budget, between a
	// client-side read and its decrement, and spends everything that is left.
	fired := false
	ctx.Redis.After(key, func() any {
		fired = true
		return ctx.Redis.Do("SET", key, 0)
	})
	g.http.Post("/v1/chat", budgetBody(164, 400), "Authorization", "Bearer acme", "Content-Type", "application/json")
	ctx.Assert(fired, "a request from acme never touched %s: the budget lives in budget:{tenant}:{yyyymmdd} (keys: %v)", key, ctx.Redis.Keys("budget:*"))
	left := budgetValue(ctx, key)
	ctx.Assert(left >= 0, "%s holds %d after another replica emptied it between your read and your decrement: both requests spent the same budget. Read, compare and decrement inside one Lua script", key, left)
	ctx.Equal(left, 0, "%s after another replica set it to 0 between your commands (the replica's update was lost; read, compare and decrement inside one Lua script)", key)
	second := g.http.Post("/v1/chat", budgetBody(164, 400), "Authorization", "Bearer acme", "Content-Type", "application/json")
	ctx.Equal(second.Status, 429, "with the budget emptied by another replica the next request")
}

func CheckTtl(ctx *harness.Ctx) {
	g := newBudgetGateway(ctx)
	key := "budget:acme:" + budgetDay(ctx)
	r := g.http.Post("/v1/chat", budgetBody(164, 400), "Authorization", "Bearer acme", "Content-Type", "application/json")
	ctx.Equal(r.Status, 200, "the first request of the day (%s)", r.Text())
	ctx.Assert(ctx.Redis.Exists(key) == 1, "after a request %s does not exist (keys: %v)", key, ctx.Redis.Keys("budget:*"))
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(ttl > 0, "%s has no expiry (TTL %d): the daily budget never resets", key, ttl)
	midnight := 86400 - (ctx.Clock.Now()/1000)%86400
	ctx.Assert(ttl-midnight <= 2 && midnight-ttl <= 2, "%s expires in %d s, expected the %d s left until midnight UTC", key, ttl, midnight)
	ctx.Clock.Advance(100)
	g.http.Post("/v1/chat", budgetBody(164, 400), "Authorization", "Bearer acme", "Content-Type", "application/json")
	later := ctx.Redis.TTL(key)
	want := midnight - 100
	ctx.Assert(later-want <= 2 && want-later <= 2, "after 100 s and a second reservation the TTL is %d s, expected about %d: the expiry is set when the key is created, a reservation must not extend it", later, want)
}

func CheckRejectHeaders(ctx *harness.Ctx) {
	g := newBudgetGateway(ctx)
	key := "budget:acme:" + budgetDay(ctx)
	ctx.Redis.Do("SET", key, 50, "EX", 3600)
	r := g.http.Post("/v1/chat", budgetBody(164, 400), "Authorization", "Bearer acme", "Content-Type", "application/json")
	ctx.Equal(r.Status, 429, "a request worth 164 tokens against 50 remaining")
	ctx.Equal(g.served, 0, "a rejected request must not reach the route behind the guard; the route ran")
	retry := r.Header.Get("Retry-After")
	ctx.Assert(retry == "3600" || retry == "3599", "Retry-After is %q, expected the key's TTL (3600 s)", retry)
	ctx.Equal(r.Header.Get("X-RateLimit-Remaining"), "50", "X-RateLimit-Remaining")
	ctx.Equal(budgetValue(ctx, key), 50, "a rejected request must not spend; %s", key)
	small := g.http.Post("/v1/chat", budgetBody(2, 4), "Authorization", "Bearer acme", "Content-Type", "application/json")
	ctx.Assert(small.Status == 200 && g.served == 1, "a request that fits (2 tokens of 50) answered %d", small.Status)
	ctx.Equal(budgetValue(ctx, key), 48, "after a 2-token reservation %s", key)
}

func CheckTenantDayKey(ctx *harness.Ctx) {
	g := newBudgetGateway(ctx)
	today := budgetDay(ctx)
	g.http.Post("/v1/chat", budgetBody(164, 400), "Authorization", "Bearer acme", "Content-Type", "application/json")
	g.http.Post("/v1/chat", budgetBody(164, 400), "Authorization", "Bearer beta", "Content-Type", "application/json")
	ctx.Equal(ctx.Redis.Keys("budget:*"), []string{"budget:acme:" + today, "budget:beta:" + today}, "after one request each from acme and beta the budget keys")
	ctx.Equal(budgetValue(ctx, "budget:acme:"+today), 1_000_000-164, "budget:acme:%s (1000000 - 164)", today)
	ctx.Clock.Advance(86400)
	tomorrow := budgetDay(ctx)
	r := g.http.Post("/v1/chat", budgetBody(164, 400), "Authorization", "Bearer acme", "Content-Type", "application/json")
	ctx.Equal(r.Status, 200, "the first request of the next day")
	ctx.Assert(ctx.Redis.Exists("budget:acme:"+tomorrow) == 1, "the next day's request must open budget:acme:%s; keys: %v", tomorrow, ctx.Redis.Keys("budget:*"))
	ctx.Equal(budgetValue(ctx, "budget:acme:"+tomorrow), 1_000_000-164, "the next day starts from a full budget; budget:acme:%s", tomorrow)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cstdlib>
#include <ctime>
#include <string>
#include <vector>

namespace {

// budget_guard wrapped around a route the harness registers, counting what got through.
struct BudgetGateway {
  int served = 0;
  httplib::Server svr;
  harness::HTTP http;

  explicit BudgetGateway(harness::Ctx& ctx) : http(ctx.HTTP(svr)) {
    svr.set_pre_routing_handler(budget_guard);
    svr.Post("/v1/chat", [this](const httplib::Request&, httplib::Response& res) {
      served++;
      res.set_content(R"({"id":"r-1","content":"ok"})", "application/json");
    });
  }

  harness::Response chat(const std::string& body, const std::string& tenant = "acme") {
    return http.Post("/v1/chat", body, "Authorization", "Bearer " + tenant, "Content-Type", "application/json");
  }
};

std::string budgetDay(harness::Ctx& ctx) {
  const std::time_t t = ctx.Clock.Now() / 1000;
  char day[9];
  std::strftime(day, sizeof day, "%Y%m%d", std::gmtime(&t));
  return day;
}

// A request worth content_chars / 4 + max_tokens tokens.
std::string budgetBody(int tokens, int content_chars = 400) {
  return R"({"model":"gpt-4o-mini","messages":[{"role":"user","content":")" + std::string(content_chars, 'x') +
         R"("}],"max_tokens":)" + std::to_string(tokens - content_chars / 4) + "}";
}

long long budgetValue(harness::Ctx& ctx, const std::string& key) {
  const auto v = ctx.Redis.Get(key);
  return v ? std::atoll(v->c_str()) : -1;
}

}  // namespace

void CheckAtomic(harness::Ctx& ctx) {
  BudgetGateway g(ctx);
  const std::string key = "budget:acme:" + budgetDay(ctx);
  ctx.Redis.Set(key, 10000);
  // Another gateway replica lands right after the first command that touches the budget, between a
  // client-side read and its decrement, and spends everything that is left.
  bool fired = false;
  ctx.Redis.After(key, [&] {
    fired = true;
    ctx.Redis.Do("SET", key, 0);
  });
  g.chat(budgetBody(164));
  ctx.Assert(fired, "a request from acme never touched %s: the budget lives in budget:{tenant}:{yyyymmdd} (keys: %v)", key, ctx.Redis.Keys("budget:*"));
  const long long left = budgetValue(ctx, key);
  ctx.Assert(left >= 0, "%s holds %d after another replica emptied it between your read and your decrement: both requests spent the same budget. Read, compare and decrement inside one Lua script", key, left);
  ctx.Equal(left, 0, "%s after another replica set it to 0 between your commands (the replica's update was lost; read, compare and decrement inside one Lua script)", key);
  const auto second = g.chat(budgetBody(164));
  ctx.Equal(second.Status, 429, "with the budget emptied by another replica the next request");
}

void CheckTtl(harness::Ctx& ctx) {
  BudgetGateway g(ctx);
  const std::string key = "budget:acme:" + budgetDay(ctx);
  const auto r = g.chat(budgetBody(164));
  ctx.Equal(r.Status, 200, "the first request of the day (%s)", r.Text());
  ctx.Assert(ctx.Redis.Exists(key) == 1, "after a request %s does not exist (keys: %v)", key, ctx.Redis.Keys("budget:*"));
  const long long ttl = ctx.Redis.TTL(key);
  ctx.Assert(ttl > 0, "%s has no expiry (TTL %d): the daily budget never resets", key, ttl);
  const long long midnight = 86400 - (ctx.Clock.Now() / 1000) % 86400;
  ctx.Assert(std::llabs(ttl - midnight) <= 2, "%s expires in %d s, expected the %d s left until midnight UTC", key, ttl, midnight);
  ctx.Clock.Advance(100);
  g.chat(budgetBody(164));
  const long long later = ctx.Redis.TTL(key);
  ctx.Assert(std::llabs(later - (midnight - 100)) <= 2, "after 100 s and a second reservation the TTL is %d s, expected about %d: the expiry is set when the key is created, a reservation must not extend it", later, midnight - 100);
}

void CheckRejectHeaders(harness::Ctx& ctx) {
  BudgetGateway g(ctx);
  const std::string key = "budget:acme:" + budgetDay(ctx);
  ctx.Redis.Do("SET", key, 50, "EX", 3600);
  const auto r = g.chat(budgetBody(164));
  ctx.Equal(r.Status, 429, "a request worth 164 tokens against 50 remaining");
  ctx.Equal(g.served, 0, "a rejected request must not reach the route behind the guard; the route ran");
  const std::string retry = r.HeaderValue("Retry-After");
  ctx.Assert(retry == "3600" || retry == "3599", "Retry-After is %q, expected the key's TTL (3600 s)", retry);
  ctx.Equal(r.HeaderValue("X-RateLimit-Remaining"), "50", "X-RateLimit-Remaining");
  ctx.Equal(budgetValue(ctx, key), 50, "a rejected request must not spend; %s", key);
  const auto small = g.chat(budgetBody(2, 4));
  ctx.Assert(small.Status == 200 && g.served == 1, "a request that fits (2 tokens of 50) answered %d", small.Status);
  ctx.Equal(budgetValue(ctx, key), 48, "after a 2-token reservation %s", key);
}

void CheckTenantDayKey(harness::Ctx& ctx) {
  BudgetGateway g(ctx);
  const std::string today = budgetDay(ctx);
  g.chat(budgetBody(164));
  g.chat(budgetBody(164), "beta");
  auto keys = ctx.Redis.Keys("budget:*");
  std::sort(keys.begin(), keys.end());
  ctx.Equal(keys, {"budget:acme:" + today, "budget:beta:" + today}, "after one request each from acme and beta the budget keys");
  ctx.Equal(budgetValue(ctx, "budget:acme:" + today), 1000000 - 164, "budget:acme:%s (1000000 - 164)", today);
  ctx.Clock.Advance(86400);
  const std::string tomorrow = budgetDay(ctx);
  const auto r = g.chat(budgetBody(164));
  ctx.Equal(r.Status, 200, "the first request of the next day");
  ctx.Assert(ctx.Redis.Exists("budget:acme:" + tomorrow) == 1, "the next day's request must open budget:acme:%s; keys: %v", tomorrow, ctx.Redis.Keys("budget:*"));
  ctx.Equal(budgetValue(ctx, "budget:acme:" + tomorrow), 1000000 - 164, "the next day starts from a full budget; budget:acme:%s", tomorrow);
}
`,
  },
  debrief: `The script is the fix because Redis runs it alone: between its GET and its DECRBY no other replica's command can land, which is the property the three-round-trip version only had in a serial test. Putting the first write inside the same script with its \`EX\` closes the second gap, a key created by one path and expired by another. Returning \`TTL\` from the script makes \`Retry-After\` and the key's life the same number, so the client's wait ends exactly when the budget comes back. Production gateways settle the reservation after the call (refund the unused \`max_tokens\`, charge the provider's real count), keep a per-minute token rate beside the daily budget, and fail open with an alarm when Redis is unreachable rather than refusing every tenant.`,
};
