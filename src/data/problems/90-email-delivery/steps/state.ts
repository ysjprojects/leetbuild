import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis suppression and per-recipient rate limits',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'relay'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a recipient with no
suppression flag and budget left gets its mail through, so the demo passes. It hides two flaws that
only appear after the first hour or the first burst. Find them, fix them, and prove the fix.

Implement the admission check every send runs before the relay:

- Suppression and the per-recipient minute counter are decided in **one atomic Redis script**
  (a Lua \`EVAL\`): a read followed by a separate increment lets two concurrent sends both pass the
  same check.
- Suppression is **durable**: it lives in a set (\`suppression:list\`) with no per-member expiry, so a
  bounced address stays suppressed after lunch. The draft writes a \`suppression:{recipient}\` cache
  key with \`ex=3600\`, so the unsubscribe is forgotten when the TTL lapses.
- The rate window **expires**: the counter key \`rate:{recipient}:{window}\` gets \`EXPIRE 60\` on its
  first write (\`window = floor(unix_seconds / 60)\`), so the window rolls over instead of living
  forever.
- An **unsubscribe** path (\`suppress(recipient)\`) writes the durable set and takes effect within
  seconds — the next admission sees it, with no TTL to wait out.
- A suppressed recipient is refused with **409** and an over-limit recipient with **429**, and the
  admission verdict runs **before** the relay call so a refused send never reaches the relay. The
  draft sends first and checks afterwards.

**Failure mode the checks target.** Suppression in an expiring cache means a bounced or unsubscribed
address is mailed again after the TTL; a check-then-send split means a burst of concurrent sends all
observe the same count and slips past the cap; and admitting after the relay means the mail is
already gone when the check refuses.`,
  sequence: {
    participants: ['Email API', 'Redis', 'Relay'],
    messages: [
      {
        from: 'Email API',
        to: 'Redis',
        label: 'EVAL admit · KEYS[suppression:list, rate:{recipient}:{window}]',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Email API', label: '{0, -1} suppressed / {-1, n} over limit / {1, n}', kind: 'reply'},
      {from: 'Email API', to: 'Email API', label: 'unsubscribe → SADD suppression:list', kind: 'sync'},
      {from: 'Email API', to: 'Relay', label: 'send(recipient) only when verdict is 1', kind: 'async'},
      {from: 'Email API', to: 'Email API', label: '409 suppressed · 429 rate limited', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'atomic',
      title: 'Decides suppression and the minute counter in one atomic script',
      detail:
        'A single Lua `EVAL` reads suppression, increments the rate counter and sets its expiry; a client-side read followed by a separate increment races, so two concurrent sends can both pass.',
      match: {
        python: {all: [/ADMIT_LUA/, /\.eval\(/, /SISMEMBER/, /INCR/]},
        typescript: {all: [/ADMIT_LUA/, /\.eval\(/, /sismember/i, /incr/i]},
        go: {all: [/admitScript/, /\.Eval\(|\.Run\(/, /SISMEMBER/, /INCR/]},
        scala: {all: [/AdmitLua/, /\.eval\(/, /SISMEMBER/, /INCR/]},
        cpp: {all: [/kAdmitLua/, /EVAL/, /SISMEMBER/, /INCR/]},
      },
    },
    {
      id: 'durable-suppression',
      title: 'Suppression is durable and never expires on its own',
      detail:
        'Suppression lives in a set (`suppression:list`) written with `SADD`, so it has no TTL. The draft writes a `suppression:{recipient}` key with a one-hour expiry, so the unsubscribe is forgotten.',
      match: {
        python: {all: [/SUPPRESSED_SET/, /\.sadd\(/]},
        typescript: {all: [/SUPPRESSED_SET/, /\.sadd\(/]},
        go: {all: [/SuppressedSet/, /\.SAdd\(/]},
        scala: {all: [/SuppressedSet/, /\.sadd\(/]},
        cpp: {all: [/kSuppressedSet/, /SADD/]},
      },
    },
    {
      id: 'rate-window',
      title: 'The rate window expires with its minute',
      detail:
        'The rate counter carries an `EXPIRE` of one window, so the limit resets instead of accumulating forever. The draft increments a counter that never dies.',
      match: {
        python: {all: [/EXPIRE/, /WINDOW_S/]},
        typescript: {all: [/EXPIRE/, /WINDOW_S/]},
        go: {all: [/EXPIRE/, /windowSeconds/]},
        scala: {all: [/EXPIRE/, /WindowSeconds/]},
        cpp: {all: [/EXPIRE/, /kWindowSeconds/]},
      },
    },
    {
      id: 'unsubscribe',
      title: 'An unsubscribe takes effect within seconds',
      detail:
        '`suppress(recipient)` writes the durable set with `SADD`, so the next admission sees it immediately. The draft only writes an expiring cache key.',
      match: {
        python: {all: [/def suppress\(/, /\.sadd\(/]},
        typescript: {all: [/function suppress/, /\.sadd\(/]},
        go: {all: [/func Suppress\(/, /\.SAdd\(/]},
        scala: {all: [/def suppress\(/, /\.sadd\(/]},
        cpp: {all: [/void suppress\(/, /SADD/]},
      },
    },
    {
      id: 'admit-first',
      title: 'The admission verdict gates the relay call',
      detail:
        'The atomic admission runs before the relay is called, so a suppressed or over-limit send never reaches the relay. The draft sends first and checks afterwards.',
      match: {
        python: {order: [/admit\(/, /relay\.send\(/]},
        typescript: {order: [/admit\(/, /relay\.send\(/]},
        go: {order: [/Admit\(/, /relay\.Send\(/]},
        scala: {order: [/admit\(/, /relay\.send\(/]},
        cpp: {order: [/admit\(/, /relay\.send\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

RATE_LIMIT = 5


class SendBody(BaseModel):
    recipient: str


class Relay:
    def send(self, recipient: str) -> str:
        """Hand the message to the relay and return a message id."""
        raise NotImplementedError


relay = Relay()


def is_suppressed(recipient: str) -> bool:
    # TODO: this draft keeps suppression in a 1-hour cache key, so a bounce is forgotten after
    # lunch, and it checks the rate then sends in two steps so a burst slips through.
    return bool(r.get(f"suppression:{recipient}"))


def suppress(recipient: str) -> None:
    r.set(f"suppression:{recipient}", "1", ex=3600)


def check_rate(recipient: str, window: int) -> bool:
    count = int(r.get(f"rate:{recipient}:{window}") or 0)
    if count >= RATE_LIMIT:
        return False
    r.incr(f"rate:{recipient}:{window}")
    return True


@app.post("/v1/emails")
def send(body: SendBody) -> JSONResponse:
    window = int(time.time()) // 60
    message_id = relay.send(body.recipient)
    if is_suppressed(body.recipient):
        return JSONResponse({"error": "suppressed"}, status_code=409)
    if not check_rate(body.recipient, window):
        return JSONResponse({"error": "rate limited"}, status_code=429)
    return JSONResponse({"message_id": message_id}, status_code=202)
`,
      solution: `import time

import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

SUPPRESSED_SET = "suppression:list"
RATE_PREFIX = "rate:"
RATE_LIMIT = 5
WINDOW_S = 60

ADMIT_LUA = """
local suppressed = redis.call('SISMEMBER', KEYS[1], ARGV[1])
if suppressed == 1 then return {0, -1} end
local count = redis.call('INCR', KEYS[2])
if count == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
if count > tonumber(ARGV[3]) then return {-1, count} end
return {1, count}
"""


class SendBody(BaseModel):
    recipient: str


class Relay:
    def send(self, recipient: str) -> str:
        """Hand the message to the relay and return a message id."""
        raise NotImplementedError


relay = Relay()


def is_suppressed(recipient: str) -> bool:
    """True when the recipient is on the durable suppression set."""
    return bool(r.sismember(SUPPRESSED_SET, recipient))


def suppress(recipient: str) -> None:
    """Unsubscribe: durable, takes effect on the next admission."""
    r.sadd(SUPPRESSED_SET, recipient)


def admit(recipient: str, window: int) -> tuple[int, int]:
    """One atomic check: suppression plus the per-recipient minute counter."""
    verdict = r.eval(
        ADMIT_LUA, 2, SUPPRESSED_SET, f"{RATE_PREFIX}{recipient}:{window}", recipient, WINDOW_S, RATE_LIMIT
    )
    return int(verdict[0]), int(verdict[1])


@app.post("/v1/emails")
def send(body: SendBody) -> JSONResponse:
    window = int(time.time()) // WINDOW_S
    verdict, _ = admit(body.recipient, window)
    if verdict == 0:
        return JSONResponse({"error": "suppressed"}, status_code=409)
    if verdict < 0:
        return JSONResponse({"error": "rate limited"}, status_code=429)
    message_id = relay.send(body.recipient)
    return JSONResponse({"message_id": message_id}, status_code=202)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const RATE_LIMIT = 5;

interface SendBody {
  recipient: string;
}

interface Relay {
  send(recipient: string): Promise<string>;
}

const relay: Relay = {
  async send() {
    throw new Error('Not implemented');
  },
};

async function isSuppressed(recipient: string): Promise<boolean> {
  // TODO: this draft keeps suppression in a 1-hour cache key, so a bounce is forgotten after
  // lunch, and it checks the rate then sends in two steps so a burst slips through.
  return Boolean(await r.get(\`suppression:\${recipient}\`));
}

async function suppress(recipient: string): Promise<void> {
  await r.set(\`suppression:\${recipient}\`, '1', 'EX', 3600);
}

async function checkRate(recipient: string, window: number): Promise<boolean> {
  const count = Number((await r.get(\`rate:\${recipient}:\${window}\`)) ?? 0);
  if (count >= RATE_LIMIT) return false;
  await r.incr(\`rate:\${recipient}:\${window}\`);
  return true;
}

app.post('/v1/emails', async (request, reply) => {
  const body = request.body as SendBody;
  const window = Math.floor(Date.now() / 1000 / 60);
  const messageId = await relay.send(body.recipient);
  if (await isSuppressed(body.recipient)) {
    return reply.code(409).send({error: 'suppressed'});
  }
  if (!(await checkRate(body.recipient, window))) {
    return reply.code(429).send({error: 'rate limited'});
  }
  return reply.code(202).send({message_id: messageId});
});
`,
      solution: `import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const SUPPRESSED_SET = 'suppression:list';
const RATE_PREFIX = 'rate:';
const RATE_LIMIT = 5;
const WINDOW_S = 60;

const ADMIT_LUA = \`
local suppressed = redis.call('SISMEMBER', KEYS[1], ARGV[1])
if suppressed == 1 then return {0, -1} end
local count = redis.call('INCR', KEYS[2])
if count == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
if count > tonumber(ARGV[3]) then return {-1, count} end
return {1, count}
\`;

interface SendBody {
  recipient: string;
}

interface Relay {
  send(recipient: string): Promise<string>;
}

const relay: Relay = {
  async send() {
    throw new Error('Not implemented');
  },
};

async function isSuppressed(recipient: string): Promise<boolean> {
  return Boolean(await r.sismember(SUPPRESSED_SET, recipient));
}

async function suppress(recipient: string): Promise<void> {
  await r.sadd(SUPPRESSED_SET, recipient);
}

async function admit(recipient: string, window: number): Promise<[number, number]> {
  const verdict = (await r.eval(
    ADMIT_LUA,
    2,
    SUPPRESSED_SET,
    \`\${RATE_PREFIX}\${recipient}:\${window}\`,
    recipient,
    String(WINDOW_S),
    String(RATE_LIMIT),
  )) as [number, number];
  return [Number(verdict[0]), Number(verdict[1])];
}

app.post('/v1/emails', async (request, reply) => {
  const body = request.body as SendBody;
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const [verdict] = await admit(body.recipient, window);
  if (verdict === 0) {
    return reply.code(409).send({error: 'suppressed'});
  }
  if (verdict < 0) {
    return reply.code(429).send({error: 'rate limited'});
  }
  const messageId = await relay.send(body.recipient);
  return reply.code(202).send({message_id: messageId});
});
`,
    },
    go: {
      starter: `package state

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const RateLimit = 5

var Rdb *redis.Client

type Relay interface {
	Send(recipient string) (string, error)
}

func IsSuppressed(ctx context.Context, recipient string) bool {
	// TODO: this draft keeps suppression in a 1-hour cache key, so a bounce is forgotten after
	// lunch, and it checks the rate then sends in two steps so a burst slips through.
	value, _ := Rdb.Get(ctx, "suppression:"+recipient).Result()
	return value != ""
}

func Suppress(ctx context.Context, recipient string) {
	Rdb.Set(ctx, "suppression:"+recipient, "1", time.Hour)
}

func CheckRate(ctx context.Context, recipient string, window int64) bool {
	key := fmt.Sprintf("rate:%s:%d", recipient, window)
	count, _ := Rdb.Get(ctx, key).Int()
	if count >= RateLimit {
		return false
	}
	Rdb.Incr(ctx, key)
	return true
}

func Register(mux *http.ServeMux, relay Relay) {
	mux.HandleFunc("POST /v1/emails", func(w http.ResponseWriter, r *http.Request) {
		recipient := r.URL.Query().Get("recipient")
		window := time.Now().Unix() / 60
		messageID, _ := relay.Send(recipient)
		if IsSuppressed(r.Context(), recipient) {
			http.Error(w, "suppressed", http.StatusConflict)
			return
		}
		if !CheckRate(r.Context(), recipient, window) {
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		w.WriteHeader(http.StatusAccepted)
		fmt.Fprintf(w, "{\\"message_id\\":%q}", messageID)
	})
}
`,
      solution:
        `package state

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	SuppressedSet = "suppression:list"
	RatePrefix    = "rate:"
	RateLimit     = 5
	windowSeconds = 60
)

const admitScript = ` +
        '`' +
        `
local suppressed = redis.call('SISMEMBER', KEYS[1], ARGV[1])
if suppressed == 1 then return {0, -1} end
local count = redis.call('INCR', KEYS[2])
if count == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
if count > tonumber(ARGV[3]) then return {-1, count} end
return {1, count}
` +
        '`' +
        `

var Rdb *redis.Client

type Relay interface {
	Send(recipient string) (string, error)
}

func IsSuppressed(ctx context.Context, recipient string) bool {
	ok, _ := Rdb.SIsMember(ctx, SuppressedSet, recipient).Result()
	return ok
}

func Suppress(ctx context.Context, recipient string) {
	Rdb.SAdd(ctx, SuppressedSet, recipient)
}

func Admit(ctx context.Context, recipient string, window int64) (int, int) {
	values, _ := Rdb.Eval(
		ctx,
		admitScript,
		[]string{SuppressedSet, fmt.Sprintf("%s%s:%d", RatePrefix, recipient, window)},
		recipient,
		windowSeconds,
		RateLimit,
	).Result()
	results := values.([]interface{})
	return int(results[0].(int64)), int(results[1].(int64))
}

func Register(mux *http.ServeMux, relay Relay) {
	mux.HandleFunc("POST /v1/emails", func(w http.ResponseWriter, r *http.Request) {
		recipient := r.URL.Query().Get("recipient")
		window := time.Now().Unix() / windowSeconds
		verdict, _ := Admit(r.Context(), recipient, window)
		if verdict == 0 {
			http.Error(w, "suppressed", http.StatusConflict)
			return
		}
		if verdict < 0 {
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return
		}
		messageID, _ := relay.Send(recipient)
		w.WriteHeader(http.StatusAccepted)
		fmt.Fprintf(w, "{\\"message_id\\":%q}", messageID)
	})
}
`,
    },
    scala: {
      starter: `package state

import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object State {
  val RateLimit = 5

  trait Relay {
    def send(recipient: String): String
  }

  def isSuppressed(redis: Redis, recipient: String): Boolean =
    // TODO: this draft keeps suppression in a 1-hour cache key, so a bounce is forgotten after
    // lunch, and it checks the rate then sends in two steps so a burst slips through.
    redis.get(s"suppression:$recipient").isDefined

  def suppress(redis: Redis, recipient: String): Unit =
    redis.set(s"suppression:$recipient", "1", ex = 3600)

  def checkRate(redis: Redis, recipient: String, window: Long): Boolean = {
    val count = redis.get(s"rate:$recipient:$window").map(_.toInt).getOrElse(0)
    if (count >= RateLimit) false
    else {
      redis.incr(s"rate:$recipient:$window")
      true
    }
  }

  def routes(redis: Redis, relay: Relay): Route =
    path("v1" / "emails") {
      post {
        parameters("recipient") { recipient =>
          val window = System.currentTimeMillis() / 1000 / 60
          val messageId = relay.send(recipient)
          if (isSuppressed(redis, recipient)) {
            complete(StatusCodes.Conflict, "suppressed")
          } else if (!checkRate(redis, recipient, window)) {
            complete(StatusCodes.TooManyRequests, "rate limited")
          } else {
            complete(StatusCodes.Accepted, s"""{"message_id":"$messageId"}""")
          }
        }
      }
    }
}
`,
      solution: `package state

import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object State {
  val SuppressedSet = "suppression:list"
  val RatePrefix = "rate:"
  val RateLimit = 5
  val WindowSeconds = 60

  val AdmitLua: String =
    """local suppressed = redis.call('SISMEMBER', KEYS[1], ARGV[1])
      |if suppressed == 1 then return {0, -1} end
      |local count = redis.call('INCR', KEYS[2])
      |if count == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
      |if count > tonumber(ARGV[3]) then return {-1, count} end
      |return {1, count}""".stripMargin

  trait Relay {
    def send(recipient: String): String
  }

  def isSuppressed(redis: Redis, recipient: String): Boolean =
    redis.sismember(SuppressedSet, recipient)

  def suppress(redis: Redis, recipient: String): Unit =
    redis.sadd(SuppressedSet, recipient)

  def admit(redis: Redis, recipient: String, window: Long): (Int, Int) = {
    val reply = redis.eval(
      AdmitLua,
      List(SuppressedSet, s"$RatePrefix$recipient:$window"),
      List(recipient, WindowSeconds.toString, RateLimit.toString)
    )
    (reply.head.toInt, reply(1).toInt)
  }

  def routes(redis: Redis, relay: Relay): Route =
    path("v1" / "emails") {
      post {
        parameters("recipient") { recipient =>
          val window = System.currentTimeMillis() / 1000 / WindowSeconds
          val (verdict, _) = admit(redis, recipient, window)
          if (verdict == 0) {
            complete(StatusCodes.Conflict, "suppressed")
          } else if (verdict < 0) {
            complete(StatusCodes.TooManyRequests, "rate limited")
          } else {
            val messageId = relay.send(recipient)
            complete(StatusCodes.Accepted, s"""{"message_id":"$messageId"}""")
          }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>

#include <ctime>
#include <string>

namespace state {

constexpr int kRateLimit = 5;

class Relay {
 public:
  virtual std::string send(const std::string& recipient) = 0;
};

bool isSuppressed(redisContext* ctx, const std::string& recipient) {
  // TODO: this draft keeps suppression in a 1-hour cache key, so a bounce is forgotten after
  // lunch, and it checks the rate then sends in two steps so a burst slips through.
  redisReply* reply = (redisReply*)redisCommand(ctx, "GET suppression:%s", recipient.c_str());
  const bool found = reply != nullptr && reply->type != REDIS_REPLY_NIL;
  freeReplyObject(reply);
  return found;
}

void suppress(redisContext* ctx, const std::string& recipient) {
  redisReply* reply = (redisReply*)redisCommand(ctx, "SET suppression:%s 1 EX 3600", recipient.c_str());
  freeReplyObject(reply);
}

bool checkRate(redisContext* ctx, const std::string& recipient, long window) {
  const std::string key = "rate:" + recipient + ":" + std::to_string(window);
  redisReply* reply = (redisReply*)redisCommand(ctx, "GET %s", key.c_str());
  const long count = reply != nullptr && reply->type == REDIS_REPLY_STRING ? std::stol(reply->str) : 0;
  freeReplyObject(reply);
  if (count >= kRateLimit) return false;
  reply = (redisReply*)redisCommand(ctx, "INCR %s", key.c_str());
  freeReplyObject(reply);
  return true;
}

void Register(httplib::Server& svr, redisContext* ctx, Relay& relay) {
  svr.Post("/v1/emails", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string recipient = req.get_param_value("recipient");
    const long window = static_cast<long>(time(nullptr)) / 60;
    const std::string message_id = relay.send(recipient);
    if (isSuppressed(ctx, recipient)) {
      res.status = 409;
      res.set_content("suppressed", "text/plain");
      return;
    }
    if (!checkRate(ctx, recipient, window)) {
      res.status = 429;
      res.set_content("rate limited", "text/plain");
      return;
    }
    res.status = 202;
    res.set_content("{\\"message_id\\":\\"" + message_id + "\\"}", "application/json");
  });
}

}  // namespace state
`,
      solution: `#include <httplib.h>

#include <ctime>
#include <string>

namespace state {

const std::string kSuppressedSet = "suppression:list";
constexpr int kRateLimit = 5;
constexpr long kWindowSeconds = 60;

const std::string kAdmitLua = R"(
local suppressed = redis.call('SISMEMBER', KEYS[1], ARGV[1])
if suppressed == 1 then return {0, -1} end
local count = redis.call('INCR', KEYS[2])
if count == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end
if count > tonumber(ARGV[3]) then return {-1, count} end
return {1, count}
)";

class Relay {
 public:
  virtual std::string send(const std::string& recipient) = 0;
};

bool isSuppressed(redisContext* ctx, const std::string& recipient) {
  redisReply* reply = (redisReply*)redisCommand(ctx, "SISMEMBER %s %s", kSuppressedSet.c_str(), recipient.c_str());
  const bool found = reply != nullptr && reply->integer == 1;
  freeReplyObject(reply);
  return found;
}

void suppress(redisContext* ctx, const std::string& recipient) {
  redisReply* reply = (redisReply*)redisCommand(ctx, "SADD %s %s", kSuppressedSet.c_str(), recipient.c_str());
  freeReplyObject(reply);
}

int admit(redisContext* ctx, const std::string& recipient, long window, int* count) {
  const std::string key = "rate:" + recipient + ":" + std::to_string(window);
  redisReply* reply = (redisReply*)redisCommand(ctx, "EVAL %s 2 %s %s %s %d %d",
                                               kAdmitLua.c_str(), kSuppressedSet.c_str(), key.c_str(),
                                               recipient.c_str(), static_cast<int>(kWindowSeconds), kRateLimit);
  const long verdict = reply != nullptr && reply->type == REDIS_REPLY_ARRAY ? reply->element[0]->integer : -1;
  *count = reply != nullptr && reply->type == REDIS_REPLY_ARRAY ? static_cast<int>(reply->element[1]->integer) : 0;
  freeReplyObject(reply);
  return static_cast<int>(verdict);
}

void Register(httplib::Server& svr, redisContext* ctx, Relay& relay) {
  svr.Post("/v1/emails", [&](const httplib::Request& req, httplib::Response& res) {
    const std::string recipient = req.get_param_value("recipient");
    const long window = static_cast<long>(time(nullptr)) / kWindowSeconds;
    int count = 0;
    const int verdict = admit(ctx, recipient, window, &count);
    if (verdict == 0) {
      res.status = 409;
      res.set_content("suppressed", "text/plain");
      return;
    }
    if (verdict < 0) {
      res.status = 429;
      res.set_content("rate limited", "text/plain");
      return;
    }
    const std::string message_id = relay.send(recipient);
    res.status = 202;
    res.set_content("{\\"message_id\\":\\"" + message_id + "\\"}", "application/json");
  });
}

}  // namespace state
`,
    },
  },
  hints: [
    'Suppression is a set, not a cache entry: `SADD suppression:list {recipient}` has no TTL, so a bounce or an unsubscribe stays suppressed. A `SET ... EX 3600` key forgets the address when the hour is up.',
    'The suppression read and the rate increment must be one script. A client-side `GET` followed by a separate `INCR` leaves a gap where two concurrent sends both read the same count and both pass.',
    'The minute counter needs an `EXPIRE` set on its first write, and the handler must read the verdict before it calls the relay — a suppressed or over-limit send never reaches the relay.',
  ],
  debrief: `The interviewer is testing whether you can review a Redis-backed admission path for durability and atomicity. The draft reads fine because the demo suppresses an address and sends one message. Two defects are being checked: suppression stored with a TTL, so an unsubscribe is forgotten when the cache expires; and a check-then-send split, so a burst of concurrent sends all observe the same count. The durable set and the single Lua script are the fix. Real senders keep suppression in durable storage with an audit trail, scope rate limits per campaign as well as per recipient, and alert when the suppression set is written outside the unsubscribe path.`,
};
