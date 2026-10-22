import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis rate limits and one-time captcha tokens',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

The starter is a plausible model-generated draft: the happy path — a captcha token the client just
received, one submission from one address — always works. The limiter and the captcha hide three
races and a leak. Find them, fix them, and prove the fix.

Implement the abuse controls every public form submission runs through:

- A captcha token is **consumed exactly once**. The client presents \`captcha\`, the service removes
  the token from Redis and allows the submission only if the token was still there. Consuming it
  must be **one atomic compare-and-delete** (\`GETDEL\`, or \`GET\` then \`DEL\` inside one \`EVAL\`):
  a client-side \`GET\` followed by a separate \`DEL\` leaves a window where two parallel replays both
  observe the same token and both pass.
- A submission is limited on **two dimensions**: the form and the submitter IP. Both are reserved by
  one atomic script and the request is allowed only when **both** have room. A key that names only
  the IP lets a botnet sweep one form from many addresses while a single office IP is throttled; a
  key that names only the form lets one address exhaust the form for everyone.
- The keys carry the **window bucket** (\`floor(unix_seconds / 60)\`), so each key expires with its
  window instead of counting forever. Keys are \`limit:form:{form_id}:{window}\` and
  \`limit:ip:{ip}:{window}\`.
- When either dimension is exhausted answer **429** with \`Retry-After\` and
  \`X-RateLimit-Remaining\`; when the captcha token is missing or already used answer **409** naming
  the replay. Neither answer may reach the storage write.

**Failure mode the checks target.** The draft's \`GET\`/\`DEL\` pair lets two concurrent replays both
consume one token; its IP-only key lets a distributed sweep pass while one shared address is blocked
and gives no per-form ceiling; and without a window bucket the first busy minute locks the key
forever.`,
  sequence: {
    participants: ['Client', 'Form API', 'Redis'],
    messages: [
      {from: 'Client', to: 'Form API', label: 'POST submission · captcha token', kind: 'sync'},
      {from: 'Form API', to: 'Redis', label: 'EVAL GETDEL captcha:{token}', kind: 'sync'},
      {from: 'Redis', to: 'Form API', label: 'token value or nil — one consumer wins', kind: 'reply'},
      {
        from: 'Form API',
        to: 'Redis',
        label: 'EVAL limit:form:{id}:{window} + limit:ip:{ip}:{window}',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Form API', label: '{allowed, form_remaining, ip_remaining, ttl}', kind: 'reply'},
      {
        from: 'Form API',
        to: 'Client',
        label: '201 stored · 409 captcha replayed · 429 with Retry-After',
        kind: 'reply',
      },
    ],
  },
  hints: [
    'A compare-and-delete must be one server-side operation. `GETDEL` removes and returns the value in a single command; if the key is gone the answer is nil and the replay loses. Doing `GET` and then `DEL` from the client means both replays read the same token before either deletes it.',
    'The limit is not one counter — it is the intersection of a form counter and an IP counter. The Lua script reads both, rejects when either is full, and increments both with `EXPIRE` on first write so each key dies with its window. Name the keys `limit:form:…` and `limit:ip:…` so neither dimension can be skipped.',
    'Put the window bucket in the key: `floor(unix_seconds / 60)`. A key without the bucket counts forever, so one busy minute blocks the form permanently. Return the remaining budget from the script so the 429 headers report real numbers.',
  ],
  checks: [
    {
      id: 'captcha-atomic',
      title: 'Consumes the captcha token in one atomic compare-and-delete',
      detail:
        'The token is removed and read in a single server-side operation (a Lua script or `GETDEL`). The draft does a client-side `GET` then `DEL`, so two parallel replays both see the token and both pass.',
      match: {
        python: {all: [/CONSUME_LUA/, /\.eval\(/], none: [/\.delete\(/]},
        typescript: {all: [/CONSUME_LUA/, /\.eval\(/], none: [/\.del\(/]},
        go: {all: [/consumeScript/, /\.Run\(/], none: [/\.Del\(/]},
        scala: {all: [/ConsumeLua/, /\.eval\(/], none: [/\.del\(/]},
        cpp: {all: [/kConsumeLua/, /\.eval</], none: [/\.del\(/]},
      },
    },
    {
      id: 'captcha-replay',
      title: 'Refuses a replayed captcha token',
      detail:
        'A token that is already gone is refused with a distinct answer naming the replay (**409**), never allowed through to storage.',
      match: {
        python: {all: [/already used/]},
        typescript: {all: [/already used/]},
        go: {all: [/already used/]},
        scala: {all: [/already used/]},
        cpp: {all: [/already used/]},
      },
    },
    {
      id: 'limit-dimensions',
      title: 'Limits the form and the IP, not just one',
      detail:
        'The limiter keys both the form (`limit:form:…`) and the submitter IP (`limit:ip:…`), so a distributed sweep cannot pass while one address is throttled. The draft keys the IP only.',
      match: {
        python: {all: [/limit:form:/, /limit:ip:/]},
        typescript: {all: [/limit:form:/, /limit:ip:/]},
        go: {all: [/limit:form:/, /limit:ip:/]},
        scala: {all: [/limit:form:/, /limit:ip:/]},
        cpp: {all: [/"limit:form:"/, /"limit:ip:"/]},
      },
    },
    {
      id: 'window-bucket',
      title: 'Keys expire with their window bucket',
      detail:
        'Keys include the 60-second window bucket so the counters reset each window instead of living forever. The draft has no window, so the first busy minute locks the key permanently.',
      match: {
        python: {all: [/WINDOW_S/, /window\(\)/]},
        typescript: {all: [/WINDOW_S/, /windowBucket/]},
        go: {all: [/windowSeconds/]},
        scala: {all: [/WindowSeconds/]},
        cpp: {all: [/kWindowSeconds/]},
      },
    },
    {
      id: 'limit-headers',
      title: 'Answers 429 with Retry-After and remaining budget',
      detail:
        'An exhausted dimension gets `429 Too Many Requests` with `Retry-After` and `X-RateLimit-Remaining` built from the script’s return value, and the storage write never runs.',
      match: {
        python: {all: [/Retry-After/, /X-RateLimit-Remaining/, /status_code\s*=\s*429/]},
        typescript: {all: [/Retry-After/, /X-RateLimit-Remaining/, /\.code\(\s*429\s*\)/]},
        go: {all: [/Retry-After/, /X-RateLimit-Remaining/, /StatusTooManyRequests/]},
        scala: {all: [/Retry-After/, /X-RateLimit-Remaining/, /TooManyRequests/]},
        cpp: {all: [/"Retry-After"/, /"X-RateLimit-Remaining"/, /\b429\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis
from fastapi import FastAPI, Header, HTTPException

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

LIMIT_PER_WINDOW = 5

submissions = {}


def consume_captcha(token: str) -> bool:
    # TODO: this draft consumes the captcha token with GET-then-DELETE (two round trips, so two
    # parallel replays both pass), keys the limit on the IP only (a botnet sweeps the form while
    # one office IP stays blocked), and omits the window bucket so the counter never resets.
    value = r.get(f"captcha:{token}")
    if value is None:
        return False
    r.delete(f"captcha:{token}")
    return True


def allowed(ip: str) -> bool:
    key = f"limit:ip:{ip}"
    used = int(r.get(key) or 0)
    if used >= LIMIT_PER_WINDOW:
        return False
    r.incr(key)
    return True


@app.post("/v1/forms/{form_id}/submissions")
def submit(form_id: str, body: dict, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    if not consume_captcha(body.get("captcha", "")):
        raise HTTPException(status_code=403, detail="captcha required")
    if not allowed(tenant):
        raise HTTPException(status_code=429, detail="rate limited")
    submission_id = "sub_" + str(len(submissions) + 1)
    submissions[submission_id] = body
    return {"submission_id": submission_id}
`,
      solution: `import time

import redis
from fastapi import FastAPI, Header, HTTPException

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 60
LIMIT_PER_WINDOW = 5

CONSUME_LUA = """
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
  return value
end
return false
"""

LIMIT_LUA = """
local form = tonumber(redis.call('GET', KEYS[1])) or 0
local ip = tonumber(redis.call('GET', KEYS[2])) or 0
local limit = tonumber(ARGV[1])
if form >= limit or ip >= limit then
  return {0, math.max(0, limit - form), math.max(0, limit - ip)}
end
redis.call('INCR', KEYS[1])
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return {1, limit - form - 1, limit - ip - 1}
"""

submissions = {}


def window() -> int:
    return int(time.time()) // WINDOW_S


def consume_captcha(token: str) -> bool:
    return bool(r.eval(CONSUME_LUA, 1, f"captcha:{token}"))


def reserve(form_id: str, ip: str) -> tuple[bool, int, int]:
    keys = [f"limit:form:{form_id}:{window()}", f"limit:ip:{ip}:{window()}"]
    ok, form_left, ip_left = r.eval(LIMIT_LUA, 2, *keys, LIMIT_PER_WINDOW, WINDOW_S)
    return bool(ok), int(form_left), int(ip_left)


@app.post("/v1/forms/{form_id}/submissions")
def submit(form_id: str, body: dict, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    if not consume_captcha(body.get("captcha", "")):
        raise HTTPException(status_code=409, detail="captcha token already used")
    ok, form_left, ip_left = reserve(form_id, tenant)
    if not ok:
        raise HTTPException(
            status_code=429,
            detail="submission limit reached",
            headers={
                "Retry-After": str(WINDOW_S),
                "X-RateLimit-Remaining": str(min(form_left, ip_left)),
            },
        )
    submission_id = "sub_" + str(len(submissions) + 1)
    submissions[submission_id] = body
    return {"submission_id": submission_id}
`,
    },
    typescript: {
      starter: `/** Abuse controls for public form submissions — a model-generated draft. */
import {Redis} from 'ioredis';
import Fastify from 'fastify';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const LIMIT_PER_WINDOW = 5;
const submissions: Record<string, unknown> = {};

async function consumeCaptcha(token: string): Promise<boolean> {
  // TODO: this draft consumes the captcha token with GET-then-DELETE (two round trips, so two
  // parallel replays both pass), keys the limit on the IP only (a botnet sweeps the form while
  // one office IP stays blocked), and omits the window bucket so the counter never resets.
  const value = await r.get('captcha:' + token);
  if (value === null) return false;
  await r.del('captcha:' + token);
  return true;
}

async function allowed(ip: string): Promise<boolean> {
  const key = 'limit:ip:' + ip;
  const used = Number((await r.get(key)) ?? 0);
  if (used >= LIMIT_PER_WINDOW) return false;
  await r.incr(key);
  return true;
}

app.post('/v1/forms/:id/submissions', async (req, reply) => {
  const {id} = req.params as {id: string};
  const {ip, captcha} = req.body as {ip: string; captcha?: string};
  if (!(await consumeCaptcha(captcha ?? ''))) return reply.code(403).send({error: 'captcha required'});
  if (!(await allowed(ip))) return reply.code(429).send({error: 'rate limited'});
  const submissionId = 'sub_' + String(Object.keys(submissions).length + 1);
  submissions[submissionId] = req.body;
  return reply.send({submissionId});
});
`,
      solution: `/** Abuse controls for public form submissions — one atomic consume and a two-dimensional limit. */
import {Redis} from 'ioredis';
import Fastify from 'fastify';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const WINDOW_S = 60;
const LIMIT_PER_WINDOW = 5;

// Compare-and-delete in one round trip: GET then DEL, or nothing when the token is already gone.
const CONSUME_LUA = [
  "local value = redis.call('GET', KEYS[1])",
  "if value then redis.call('DEL', KEYS[1]) return value end",
  'return false',
].join(' ');

// Read both dimensions, reject when either is full, increment and expire both on success.
const LIMIT_LUA = [
  "local form = tonumber(redis.call('GET', KEYS[1])) or 0",
  "local ip = tonumber(redis.call('GET', KEYS[2])) or 0",
  'local limit = tonumber(ARGV[1])',
  'if form >= limit or ip >= limit then return {0, limit - form, limit - ip} end',
  "redis.call('INCR', KEYS[1]) redis.call('INCR', KEYS[2])",
  "redis.call('EXPIRE', KEYS[1], ARGV[2]) redis.call('EXPIRE', KEYS[2], ARGV[2])",
  'return {1, limit - form - 1, limit - ip - 1}',
].join(' ');

const submissions: Record<string, unknown> = {};

function windowBucket(): number {
  return Math.floor(Date.now() / 1000 / WINDOW_S);
}

async function consumeCaptcha(token: string): Promise<boolean> {
  const value = await r.eval(CONSUME_LUA, 1, 'captcha:' + token);
  return value !== null && value !== false;
}

async function reserve(formId: string, ip: string): Promise<[boolean, number, number]> {
  const keys = ['limit:form:' + formId + ':' + windowBucket(), 'limit:ip:' + ip + ':' + windowBucket()];
  const reply = (await r.eval(LIMIT_LUA, 2, ...keys, String(LIMIT_PER_WINDOW), String(WINDOW_S))) as number[];
  return [reply[0] === 1, reply[1], reply[2]];
}

app.post('/v1/forms/:id/submissions', async (req, reply) => {
  const {id} = req.params as {id: string};
  const {ip, captcha} = req.body as {ip: string; captcha?: string};
  if (!(await consumeCaptcha(captcha ?? '')))
    return reply.code(409).send({error: 'captcha token already used'});
  const [ok, formLeft, ipLeft] = await reserve(id, ip);
  if (!ok)
    return reply
      .code(429)
      .headers({'Retry-After': String(WINDOW_S), 'X-RateLimit-Remaining': String(Math.min(formLeft, ipLeft))})
      .send({error: 'submission limit reached'});
  const submissionId = 'sub_' + String(Object.keys(submissions).length + 1);
  submissions[submissionId] = req.body;
  return reply.send({submissionId});
});
`,
    },
    go: {
      starter: `package formapi

import (
	"context"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const limitPerWindow = 5

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func consumeCaptcha(ctx context.Context, token string) bool {
	// TODO: this draft consumes the captcha token with GET-then-DELETE (two round trips, so two
	// parallel replays both pass), keys the limit on the IP only (a botnet sweeps the form while
	// one office IP stays blocked), and omits the window bucket so the counter never resets.
	value, err := rdb.Get(ctx, "captcha:"+token).Result()
	if err != nil {
		return false
	}
	_ = rdb.Del(ctx, "captcha:"+token).Err()
	return value != ""
}

func allowed(ctx context.Context, ip string) bool {
	key := "limit:ip:" + ip
	used, _ := strconv.Atoi(rdb.Get(ctx, key).Val())
	if used >= limitPerWindow {
		return false
	}
	rdb.Incr(ctx, key)
	return true
}

func Submit(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	ip := r.Header.Get("X-Forwarded-For")
	if !consumeCaptcha(ctx, r.URL.Query().Get("captcha")) {
		http.Error(w, "captcha required", http.StatusForbidden)
		return
	}
	if !allowed(ctx, ip) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return
	}
	w.WriteHeader(http.StatusCreated)
}
`,
      solution: `package formapi

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	windowSeconds  = 60
	limitPerWindow = 5
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Compare-and-delete in one script: two parallel replays cannot both observe the token.
var consumeScript = redis.NewScript(\`
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
  return value
end
return false
\`)

// One reservation across both dimensions; each key expires with its window bucket.
var limitScript = redis.NewScript(\`
local form = tonumber(redis.call('GET', KEYS[1])) or 0
local ip = tonumber(redis.call('GET', KEYS[2])) or 0
local limit = tonumber(ARGV[1])
if form >= limit or ip >= limit then return {0, limit - form, limit - ip} end
redis.call('INCR', KEYS[1])
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return {1, limit - form - 1, limit - ip - 1}
\`)

func consumeCaptcha(ctx context.Context, token string) bool {
	value, err := consumeScript.Run(ctx, rdb, []string{"captcha:" + token}).Result()
	return err == nil && value != nil && value != false
}

func reserve(ctx context.Context, formID, ip string) (bool, int, int) {
	window := time.Now().Unix() / windowSeconds
	keys := []string{"limit:form:" + formID + ":" + strconv.FormatInt(window, 10), "limit:ip:" + ip + ":" + strconv.FormatInt(window, 10)}
	values, err := limitScript.Run(ctx, rdb, keys, limitPerWindow, windowSeconds).Int64Slice()
	if err != nil || len(values) != 3 {
		return false, 0, 0
	}
	return values[0] == 1, int(values[1]), int(values[2])
}

func Submit(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	formID := r.PathValue("id")
	ip := r.Header.Get("X-Forwarded-For")
	if !consumeCaptcha(ctx, r.URL.Query().Get("captcha")) {
		http.Error(w, "captcha token already used", http.StatusConflict)
		return
	}
	ok, formLeft, ipLeft := reserve(ctx, formID, ip)
	if !ok {
		remaining := formLeft
		if ipLeft < remaining {
			remaining = ipLeft
		}
		w.Header().Set("Retry-After", strconv.Itoa(windowSeconds))
		w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
		http.Error(w, "submission limit reached", http.StatusTooManyRequests)
		return
	}
	w.WriteHeader(http.StatusCreated)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.http.scaladsl.server.Directives._
import redis.clients.jedis.Jedis

object State {
  val LimitPerWindow = 5
  val jedis = new Jedis("redis", 6379)

  def consumeCaptcha(token: String): Boolean = {
    // TODO: this draft consumes the captcha token with GET-then-DELETE (two round trips, so two
    // parallel replays both pass), keys the limit on the IP only (a botnet sweeps the form while
    // one office IP stays blocked), and omits the window bucket so the counter never resets.
    val value = jedis.get("captcha:" + token)
    if (value == null) false
    else {
      jedis.del("captcha:" + token)
      true
    }
  }

  def allowed(ip: String): Boolean = {
    val key = "limit:ip:" + ip
    val used = Option(jedis.get(key)).map(_.toInt).getOrElse(0)
    if (used >= LimitPerWindow) false
    else {
      jedis.incr(key)
      true
    }
  }

  val routes: Route = path("v1" / "forms" / Segment / "submissions") { _ =>
    post {
      entity(as[String]) { _ =>
        complete("captcha required")
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.http.scaladsl.server.Directives._
import redis.clients.jedis.Jedis
import scala.jdk.CollectionConverters._

object State {
  val WindowSeconds = 60
  val LimitPerWindow = 5
  val jedis = new Jedis("redis", 6379)

  // Compare-and-delete in one script: two parallel replays cannot both observe the token.
  val ConsumeLua =
    """
      |local value = redis.call('GET', KEYS[1])
      |if value then
      |  redis.call('DEL', KEYS[1])
      |  return value
      |end
      |return false
      |""".stripMargin

  // One reservation across both dimensions; each key expires with its window bucket.
  val LimitLua =
    """
      |local form = tonumber(redis.call('GET', KEYS[1])) or 0
      |local ip = tonumber(redis.call('GET', KEYS[2])) or 0
      |local limit = tonumber(ARGV[1])
      |if form >= limit or ip >= limit then return {0, limit - form, limit - ip} end
      |redis.call('INCR', KEYS[1])
      |redis.call('INCR', KEYS[2])
      |redis.call('EXPIRE', KEYS[1], ARGV[2])
      |redis.call('EXPIRE', KEYS[2], ARGV[2])
      |return {1, limit - form - 1, limit - ip - 1}
      |""".stripMargin

  def windowBucket: Long = System.currentTimeMillis() / 1000 / WindowSeconds

  def consumeCaptcha(token: String): Boolean = {
    val value = jedis.eval(ConsumeLua, List("captcha:" + token).asJava, List.empty[String].asJava)
    value != null && value != false
  }

  def reserve(formId: String, ip: String): (Boolean, Int, Int) = {
    val keys = List("limit:form:" + formId + ":" + windowBucket, "limit:ip:" + ip + ":" + windowBucket).asJava
    val args = List(LimitPerWindow.toString, WindowSeconds.toString).asJava
    val reply = jedis.eval(LimitLua, keys, args).asInstanceOf[java.util.List[Long]]
    (reply.get(0) == 1L, reply.get(1).toInt, reply.get(2).toInt)
  }

  val routes: Route = path("v1" / "forms" / Segment / "submissions") { formId =>
    post {
      headerValueByName("X-Forwarded-For") { ip =>
        parameter("captcha") { token =>
          if (!consumeCaptcha(token))
            complete(StatusCodes.Conflict -> """{"error":"captcha token already used"}""")
          else {
            val (ok, formLeft, ipLeft) = reserve(formId, ip)
            if (!ok)
              respondWithHeaders(
                "Retry-After" -> WindowSeconds.toString,
                "X-RateLimit-Remaining" -> Math.min(formLeft, ipLeft).toString
              ) {
                complete(StatusCodes.TooManyRequests -> """{"error":"submission limit reached"}""")
              }
            else complete(StatusCodes.Created -> """{"submissionId":"stored"}""")
          }
        }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <string>

using namespace sw::redis;

void RegisterRoutes(httplib::Server& svr, Redis& redis) {
  const int limitPerWindow = 5;

  auto consumeCaptcha = [&](const std::string& token) {
    // TODO: this draft consumes the captcha token with GET-then-DELETE (two round trips, so two
    // parallel replays both pass), keys the limit on the IP only (a botnet sweeps the form while
    // one office IP stays blocked), and omits the window bucket so the counter never resets.
    auto value = redis.get("captcha:" + token);
    if (!value) return false;
    redis.del("captcha:" + token);
    return true;
  };

  auto allowed = [&](const std::string& ip) {
    const std::string key = "limit:ip:" + ip;
    auto used = redis.get(key);
    if (used && std::stoi(*used) >= limitPerWindow) return false;
    redis.incr(key);
    return true;
  };

  svr.Post("/v1/forms/([^/]+)/submissions", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string ip = req.get_header_value("X-Forwarded-For");
    if (!consumeCaptcha(req.get_param_value("captcha"))) {
      res.status = 403;
      res.set_content("captcha required", "text/plain");
      return;
    }
    if (!allowed(ip)) {
      res.status = 429;
      res.set_content("rate limited", "text/plain");
      return;
    }
    res.status = 201;
  });
}
`,
      solution: `#include <httplib.h>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <ctime>
#include <string>
#include <vector>

using namespace sw::redis;

static const int kWindowSeconds = 60;
static const int kLimitPerWindow = 5;

// Compare-and-delete in one script: two parallel replays cannot both observe the token.
static const char* kConsumeLua = R"(
local value = redis.call('GET', KEYS[1])
if value then
  redis.call('DEL', KEYS[1])
  return value
end
return false
)";

// One reservation across both dimensions; each key expires with its window bucket.
static const char* kLimitLua = R"(
local form = tonumber(redis.call('GET', KEYS[1])) or 0
local ip = tonumber(redis.call('GET', KEYS[2])) or 0
local limit = tonumber(ARGV[1])
if form >= limit or ip >= limit then return {0, limit - form, limit - ip} end
redis.call('INCR', KEYS[1])
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('EXPIRE', KEYS[2], ARGV[2])
return {1, limit - form - 1, limit - ip - 1}
)";

static bool ConsumeCaptcha(Redis& redis, const std::string& token) {
  auto value = redis.eval<long long>(kConsumeLua, {"captcha:" + token}, {});
  return value > 0;
}

void RegisterRoutes(httplib::Server& svr, Redis& redis) {
  svr.Post("/v1/forms/([^/]+)/submissions", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string formId = req.matches[1];
    const std::string ip = req.get_header_value("X-Forwarded-For");
    if (!ConsumeCaptcha(redis, req.get_param_value("captcha"))) {
      res.status = 409;
      res.set_content("captcha token already used", "text/plain");
      return;
    }
    const long window = static_cast<long>(std::time(nullptr)) / kWindowSeconds;
    const std::vector<std::string> keys = {
        "limit:form:" + formId + ":" + std::to_string(window),
        "limit:ip:" + ip + ":" + std::to_string(window),
    };
    auto reply = redis.eval<long long>(kLimitLua, keys, {std::to_string(kLimitPerWindow), std::to_string(kWindowSeconds)});
    const bool ok = reply == 1;
    if (!ok) {
      const int formLeft = static_cast<int>(redis.get("limit:form:" + formId + ":" + std::to_string(window)).value_or("0").size());
      const int ipLeft = static_cast<int>(redis.get("limit:ip:" + ip + ":" + std::to_string(window)).value_or("0").size());
      res.status = 429;
      res.set_header("Retry-After", std::to_string(kWindowSeconds));
      res.set_header("X-RateLimit-Remaining", std::to_string(std::min(formLeft, ipLeft)));
      res.set_content("submission limit reached", "text/plain");
      return;
    }
    res.status = 201;
  });
}
`,
    },
  },
  debrief: `The interviewer is testing whether you understand that abuse controls are concurrency problems, not counters. A captcha token is a one-shot value, so reading and deleting it must be one server-side operation — \`GETDEL\`, or \`GET\` and \`DEL\` inside a Lua script — because a client-side pair leaves the read and the delete in different round trips. The limit has two dimensions for a reason: an IP-only key is defeated by a botnet with many addresses, and a form-only key lets one address exhaust a form for everyone, so the script reads both and increments both in one pass. Keys carry the window bucket so the budget resets instead of locking forever. Real systems add a sliding-window or token-bucket script when a fixed minute bucket is too coarse, a captcha issuer that signs tokens so a token cannot be minted offline, and \`Retry-After\` reporting the actual TTL left in the window.`,
};
