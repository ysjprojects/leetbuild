import type {Step} from '@/lib/types';

const LUA = `local key = KEYS[1]
local now, window, limit = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, 0}
end
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
return {0, tonumber(oldest[2]) + window - now}`;

export const slidingWindowStep: Step = {
  id: 'sliding-window',
  title: 'Trim, count, admit, expire — one EVAL',
  concept: 'redis',
  file: 'sliding_window',
  focus: ['limiter', 'redis'],
  task: `## Task

Implement \`allow(client_id, now_ms) -> (allowed, retry_after_ms)\`: a sliding-window log limiter of
**\`LIMIT = 10\`** calls per **\`WINDOW_MS = 1000\`** over the sorted set **\`sw:{client_id}\`**, where
every admitted call is a member scored by its \`now_ms\`. The caller passes the time; the script never
calls \`TIME\`.

- The whole decision is **one Lua script** run as **one round trip**: \`ZREMRANGEBYSCORE\` everything
  scored \`<= now - window\`, \`ZCARD\`, and when \`count < limit\`: \`ZADD now member\`, \`PEXPIRE window\`,
  return \`{1, 0}\`. Otherwise \`ZRANGE 0 0 WITHSCORES\` and return \`{0, oldest + window - now}\` — the
  milliseconds until the oldest member leaves the window. No Redis logic outside the script: the
  client only builds the key and the member and calls the script.
- \`KEYS[1]\` is the key; \`ARGV\` is \`now_ms, WINDOW_MS, LIMIT, member\`, bound in the script as
  \`now, window, limit, member\`.
- The **member** is \`"{now_ms}-{nonce}"\` with a random nonce (\`uuid4\`, \`randomUUID\`, …): two calls in
  the same millisecond — from the same instance or another one — are two members, never one
  overwritten score.
- The script is **loaded once** at import (\`register_script\` / \`defineCommand\` / \`redis.NewScript\` /
  \`scriptLoad\` / \`script_load\`) and called by SHA; each \`allow\` is exactly one \`EVALSHA\`/\`EVAL\`
  after the first.
- \`allowed\` is a bool; \`retry_after_ms\` is an int, \`0\` when allowed.

> Three commands from the client are three chances for another instance to land between them.
> Inside Redis the script runs alone; the only way to be exact under a race is to never leave.`,
  sequence: {
    participants: ['limiter A', 'limiter B', 'Redis'],
    messages: [
      {from: 'limiter A', to: 'Redis', label: 'EVALSHA sw:c7 now=400 (trim · ZCARD 9 · ZADD · PEXPIRE)', kind: 'sync'},
      {from: 'Redis', to: 'limiter A', label: '{1, 0}', kind: 'reply'},
      {from: 'limiter B', to: 'Redis', label: 'EVALSHA sw:c7 now=400 (trim · ZCARD 10)', kind: 'sync'},
      {from: 'Redis', to: 'limiter B', label: '{0, 600} — oldest at 0 leaves at 1000', kind: 'reply'},
      {from: 'limiter B', to: 'Redis', label: 'EVALSHA sw:c7 now=1000 (trim 1 · ZCARD 9 · ZADD)', kind: 'sync'},
      {from: 'Redis', to: 'limiter B', label: '{1, 0}', kind: 'reply'},
    ],
  },
  hints: [
    'Write the script first, as the task lists it: `ZREMRANGEBYSCORE key -inf (now - window)`, `ZCARD`, then either `ZADD` + `PEXPIRE` + `return {1, 0}` or `ZRANGE key 0 0 WITHSCORES` + `return {0, tonumber(oldest[2]) + window - now}`. `tonumber` every ARGV you do arithmetic on.',
    'Load it once at module level and call it per request with `keys=[key]` and `args=[now_ms, WINDOW_MS, LIMIT, member]`; the reply is a two-element list of integers — convert the first to a bool.',
    'The member must differ per call: `f"{now_ms}-{uuid4().hex}"`. Using `now_ms` alone as the member makes two calls in one millisecond one member, and the limit leaks.',
  ],
  checks: [
    {
      id: 'one-script',
      title: 'The whole decision is one round trip',
      detail:
        'After the script is loaded, every `allow` sends exactly one `EVALSHA`/`EVAL`; trim, count and admit run inside it (`ZREMRANGEBYSCORE`, `ZCARD`, `ZADD` through `redis.call`), never as client commands.',
      match: {
        python: {
          all: [
            /redis\.call\(\s*['"]ZREMRANGEBYSCORE['"]/,
            /redis\.call\(\s*['"]ZCARD['"]/,
            /redis\.call\(\s*['"]ZADD['"]/,
          ],
          none: [/r\.zremrangebyscore\(/, /r\.zcard\(/, /r\.zadd\(/],
        },
        typescript: {
          all: [
            /redis\.call\(\s*['"]ZREMRANGEBYSCORE['"]/,
            /redis\.call\(\s*['"]ZCARD['"]/,
            /redis\.call\(\s*['"]ZADD['"]/,
          ],
          none: [/redis\.zremrangebyscore\(/, /redis\.zcard\(/, /redis\.zadd\(/],
        },
        go: {
          all: [
            /redis\.call\(\s*['"]ZREMRANGEBYSCORE['"]/,
            /redis\.call\(\s*['"]ZCARD['"]/,
            /redis\.call\(\s*['"]ZADD['"]/,
          ],
          none: [/rdb\.ZRemRangeByScore\(/, /rdb\.ZCard\(/, /rdb\.ZAdd\(/],
        },
        scala: {
          all: [
            /redis\.call\(\s*['"]ZREMRANGEBYSCORE['"]/,
            /redis\.call\(\s*['"]ZCARD['"]/,
            /redis\.call\(\s*['"]ZADD['"]/,
          ],
          none: [/jedis\.zremrangeByScore\(/, /jedis\.zcard\(/, /jedis\.zadd\(/],
        },
        cpp: {
          all: [
            /redis\.call\(\s*['"]ZREMRANGEBYSCORE['"]/,
            /redis\.call\(\s*['"]ZCARD['"]/,
            /redis\.call\(\s*['"]ZADD['"]/,
          ],
          none: [/redis\.zremrangebyscore\(/, /redis\.zcard\(/, /redis\.zadd\(/],
        },
      },
    },
    {
      id: 'limit',
      title: 'Admits LIMIT per window, then denies with the oldest member’s remaining time',
      detail:
        'Ten calls in a window are admitted with `retry_after_ms = 0`; the eleventh is denied with `oldest + WINDOW_MS - now`, which the script reads with `ZRANGE 0 0 WITHSCORES`. Clients are independent.',
      match: {
        python: {
          all: [
            /count\s*<\s*limit/,
            /redis\.call\(\s*['"]ZRANGE['"]\s*,\s*key\s*,\s*0\s*,\s*0\s*,\s*['"]WITHSCORES['"]/,
          ],
        },
        typescript: {
          all: [
            /count\s*<\s*limit/,
            /redis\.call\(\s*['"]ZRANGE['"]\s*,\s*key\s*,\s*0\s*,\s*0\s*,\s*['"]WITHSCORES['"]/,
          ],
        },
        go: {
          all: [
            /count\s*<\s*limit/,
            /redis\.call\(\s*['"]ZRANGE['"]\s*,\s*key\s*,\s*0\s*,\s*0\s*,\s*['"]WITHSCORES['"]/,
          ],
        },
        scala: {
          all: [
            /count\s*<\s*limit/,
            /redis\.call\(\s*['"]ZRANGE['"]\s*,\s*key\s*,\s*0\s*,\s*0\s*,\s*['"]WITHSCORES['"]/,
          ],
        },
        cpp: {
          all: [
            /count\s*<\s*limit/,
            /redis\.call\(\s*['"]ZRANGE['"]\s*,\s*key\s*,\s*0\s*,\s*0\s*,\s*['"]WITHSCORES['"]/,
          ],
        },
      },
    },
    {
      id: 'sliding',
      title: 'The window slides: exactly the expired calls are admitted again',
      detail:
        'Members scored `<= now - WINDOW_MS` are trimmed before counting (`ZREMRANGEBYSCORE key -inf (now - window)`), so after part of the window passes exactly that many calls are admitted and the next denial points at the new oldest member.',
      match: {
        python: {
          all: [/redis\.call\(\s*['"]ZREMRANGEBYSCORE['"]\s*,\s*key\s*,\s*['"]-inf['"]\s*,\s*now\s*-\s*window\s*\)/],
        },
        typescript: {
          all: [/redis\.call\(\s*['"]ZREMRANGEBYSCORE['"]\s*,\s*key\s*,\s*['"]-inf['"]\s*,\s*now\s*-\s*window\s*\)/],
        },
        go: {
          all: [/redis\.call\(\s*['"]ZREMRANGEBYSCORE['"]\s*,\s*key\s*,\s*['"]-inf['"]\s*,\s*now\s*-\s*window\s*\)/],
        },
        scala: {
          all: [/redis\.call\(\s*['"]ZREMRANGEBYSCORE['"]\s*,\s*key\s*,\s*['"]-inf['"]\s*,\s*now\s*-\s*window\s*\)/],
        },
        cpp: {
          all: [/redis\.call\(\s*['"]ZREMRANGEBYSCORE['"]\s*,\s*key\s*,\s*['"]-inf['"]\s*,\s*now\s*-\s*window\s*\)/],
        },
      },
    },
    {
      id: 'ttl',
      title: 'The key lives exactly one window past its last admit',
      detail:
        'An admit sets `PEXPIRE sw:{client_id} WINDOW_MS` inside the script, so an idle client’s set disappears on its own and `PTTL` tracks the virtual clock.',
      match: {
        python: {all: [/redis\.call\(\s*['"]PEXPIRE['"]\s*,\s*key\s*,\s*window\s*\)/]},
        typescript: {all: [/redis\.call\(\s*['"]PEXPIRE['"]\s*,\s*key\s*,\s*window\s*\)/]},
        go: {all: [/redis\.call\(\s*['"]PEXPIRE['"]\s*,\s*key\s*,\s*window\s*\)/]},
        scala: {all: [/redis\.call\(\s*['"]PEXPIRE['"]\s*,\s*key\s*,\s*window\s*\)/]},
        cpp: {all: [/redis\.call\(\s*['"]PEXPIRE['"]\s*,\s*key\s*,\s*window\s*\)/]},
      },
    },
    {
      id: 'atomic',
      title: 'Two instances never admit more than LIMIT between them',
      detail:
        'A second instance’s `allow` landing between any two of the first instance’s Redis commands must not find a half-made decision: the script is loaded once and called by SHA, and the count it reads is the count it adds to.',
      match: {
        python: {all: [/register_script\(/]},
        typescript: {all: [/defineCommand\(/]},
        go: {all: [/redis\.NewScript\(/, /\.Run\(/]},
        scala: {all: [/scriptLoad\(/, /evalsha\(/]},
        cpp: {all: [/script_load\(/, /evalsha/]},
      },
    },
    {
      id: 'unique-members',
      title: 'Calls in the same millisecond are distinct members',
      detail:
        'The member is `{now_ms}-{nonce}` with a random nonce, so ten calls at one `now_ms` are ten members scored `now_ms` and the eleventh is denied; a bare `now_ms` member would collapse them into one.',
      match: {
        python: {all: [/uuid4\(\)|token_hex\(|getrandbits\(|randbytes\(/]},
        typescript: {all: [/randomUUID\(\)|randomBytes\(/]},
        go: {all: [/rand\.\w+\(/]},
        scala: {all: [/UUID\.randomUUID\(\)|Random/]},
        cpp: {all: [/random_device|mt19937/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""A sliding-window log limiter: LIMIT calls per WINDOW_MS, per client, decided inside Redis."""
import uuid

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LIMIT = 10
WINDOW_MS = 1000

# TODO: Lua — KEYS[1] = key; ARGV = now_ms, WINDOW_MS, LIMIT, member (bind as now, window, limit, member).
# ZREMRANGEBYSCORE key -inf (now - window); count = ZCARD; count < limit → ZADD now member, PEXPIRE window,
# return {1, 0}; else ZRANGE key 0 0 WITHSCORES → return {0, oldest + window - now}.
SCRIPT = """
"""
# TODO: slide = r.register_script(SCRIPT)  # loaded once; EVALSHA per call, EVAL as the fallback on NOSCRIPT


def allow(client_id: str, now_ms: int) -> tuple[bool, int]:
    """One round trip: (allowed, retry_after_ms) for client_id at now_ms."""
    key = f"sw:{client_id}"
    member = f"{now_ms}-{uuid.uuid4().hex}"
    # TODO: this is four round trips and a race between instances — move it into SCRIPT and call slide once
    r.zremrangebyscore(key, "-inf", now_ms - WINDOW_MS)
    if r.zcard(key) < LIMIT:
        r.zadd(key, {member: now_ms})
        r.pexpire(key, WINDOW_MS)
        return True, 0
    oldest = r.zrange(key, 0, 0, withscores=True)
    return False, int(oldest[0][1]) + WINDOW_MS - now_ms
`,
      solution: `"""A sliding-window log limiter: LIMIT calls per WINDOW_MS, per client, decided inside Redis."""
import uuid

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LIMIT = 10
WINDOW_MS = 1000

# KEYS[1] = sw:{client_id}; ARGV = now_ms, WINDOW_MS, LIMIT, member. Returns {allowed, retry_after_ms}.
SCRIPT = """
${LUA}
"""
slide = r.register_script(SCRIPT)  # loaded once; EVALSHA per call, EVAL as the fallback on NOSCRIPT


def allow(client_id: str, now_ms: int) -> tuple[bool, int]:
    """One round trip: (allowed, retry_after_ms) for client_id at now_ms."""
    key = f"sw:{client_id}"
    member = f"{now_ms}-{uuid.uuid4().hex}"
    allowed, retry_after_ms = slide(keys=[key], args=[now_ms, WINDOW_MS, LIMIT, member])
    return allowed == 1, int(retry_after_ms)
`,
    },
    typescript: {
      starter: `/** A sliding-window log limiter: LIMIT calls per WINDOW_MS, per client, decided inside Redis. */
import {randomUUID} from 'node:crypto';
import Redis from 'ioredis';

export const LIMIT = 10;
export const WINDOW_MS = 1000;

// TODO: Lua — KEYS[1] = key; ARGV = nowMs, WINDOW_MS, LIMIT, member (bind as now, window, limit, member).
// ZREMRANGEBYSCORE key -inf (now - window); count = ZCARD; count < limit → ZADD now member, PEXPIRE window,
// return {1, 0}; else ZRANGE key 0 0 WITHSCORES → return {0, oldest + window - now}.
const SCRIPT = \`\`;

interface SlidingRedis extends Redis {
  slide(key: string, nowMs: number, windowMs: number, limit: number, member: string): Promise<[number, number]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as SlidingRedis;
// TODO: redis.defineCommand('slide', {numberOfKeys: 1, lua: SCRIPT}); — loaded once, EVALSHA per call

/** One round trip: [allowed, retryAfterMs] for clientId at nowMs. */
export async function allow(clientId: string, nowMs: number): Promise<[boolean, number]> {
  const key = \`sw:\${clientId}\`;
  const member = \`\${nowMs}-\${randomUUID()}\`;
  // TODO: this is four round trips and a race between instances — move it into SCRIPT and call redis.slide once
  await redis.zremrangebyscore(key, '-inf', nowMs - WINDOW_MS);
  if ((await redis.zcard(key)) < LIMIT) {
    await redis.zadd(key, nowMs, member);
    await redis.pexpire(key, WINDOW_MS);
    return [true, 0];
  }
  const oldest = await redis.zrange(key, 0, 0, 'WITHSCORES');
  return [false, Number(oldest[1]) + WINDOW_MS - nowMs];
}
`,
      solution: `/** A sliding-window log limiter: LIMIT calls per WINDOW_MS, per client, decided inside Redis. */
import {randomUUID} from 'node:crypto';
import Redis from 'ioredis';

export const LIMIT = 10;
export const WINDOW_MS = 1000;

// KEYS[1] = sw:{clientId}; ARGV = nowMs, WINDOW_MS, LIMIT, member. Returns {allowed, retryAfterMs}.
const SCRIPT = \`
${LUA}
\`;

interface SlidingRedis extends Redis {
  slide(key: string, nowMs: number, windowMs: number, limit: number, member: string): Promise<[number, number]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as SlidingRedis;
// Loaded once: every call is an EVALSHA, with EVAL as the fallback on NOSCRIPT.
redis.defineCommand('slide', {numberOfKeys: 1, lua: SCRIPT});

/** One round trip: [allowed, retryAfterMs] for clientId at nowMs. */
export async function allow(clientId: string, nowMs: number): Promise<[boolean, number]> {
  const key = \`sw:\${clientId}\`;
  const member = \`\${nowMs}-\${randomUUID()}\`;
  const [allowed, retryAfterMs] = await redis.slide(key, nowMs, WINDOW_MS, LIMIT, member);
  return [allowed === 1, retryAfterMs];
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"math/rand/v2"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	limit    = 10
	windowMs = 1000
)

// TODO: Lua — KEYS[1] = key; ARGV = nowMs, windowMs, limit, member (bind as now, window, limit, member).
// ZREMRANGEBYSCORE key -inf (now - window); count = ZCARD; count < limit → ZADD now member, PEXPIRE window,
// return {1, 0}; else ZRANGE key 0 0 WITHSCORES → return {0, oldest + window - now}.
// Then: var slide = redis.NewScript(script) — loaded once, EVALSHA per call via slide.Run.

// allow decides in one round trip: (allowed, retryAfterMs) for clientID at nowMs.
func allow(ctx context.Context, clientID string, nowMs int64) (bool, int64, error) {
	key := "sw:" + clientID
	member := fmt.Sprintf("%d-%08x", nowMs, rand.Uint32())
	// TODO: this is four round trips and a race between instances — move it into the script and call slide.Run once
	if err := rdb.ZRemRangeByScore(ctx, key, "-inf", fmt.Sprint(nowMs-windowMs)).Err(); err != nil {
		return false, 0, err
	}
	count, err := rdb.ZCard(ctx, key).Result()
	if err != nil {
		return false, 0, err
	}
	if count < limit {
		if err := rdb.ZAdd(ctx, key, redis.Z{Score: float64(nowMs), Member: member}).Err(); err != nil {
			return false, 0, err
		}
		return true, 0, rdb.PExpire(ctx, key, windowMs*1e6).Err()
	}
	oldest, err := rdb.ZRangeWithScores(ctx, key, 0, 0).Result()
	if err != nil {
		return false, 0, err
	}
	return false, int64(oldest[0].Score) + windowMs - nowMs, nil
}

func main() {
	ok, retry, err := allow(context.Background(), "demo", 0)
	fmt.Println(ok, retry, err)
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"math/rand/v2"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	limit    = 10
	windowMs = 1000
)

// KEYS[1] = sw:{clientID}; ARGV = nowMs, windowMs, limit, member. Returns {allowed, retryAfterMs}.
// Run uses EVALSHA and falls back to EVAL once when the script is not loaded yet.
var slide = redis.NewScript(\`
${LUA}
\`)

// allow decides in one round trip: (allowed, retryAfterMs) for clientID at nowMs.
func allow(ctx context.Context, clientID string, nowMs int64) (bool, int64, error) {
	key := "sw:" + clientID
	member := fmt.Sprintf("%d-%08x", nowMs, rand.Uint32())
	res, err := slide.Run(ctx, rdb, []string{key}, nowMs, windowMs, limit, member).Int64Slice()
	if err != nil {
		return false, 0, err
	}
	return res[0] == 1, res[1], nil
}

func main() {
	ok, retry, err := allow(context.Background(), "demo", 0)
	fmt.Println(ok, retry, err)
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled

/** A sliding-window log limiter: Limit calls per WindowMs, per client, decided inside Redis. */
object SlidingWindow {
  val jedis = new JedisPooled("redis", 6379)
  val Limit = 10
  val WindowMs = 1000L

  // TODO: Lua — KEYS[1] = key; ARGV = nowMs, WindowMs, Limit, member (bind as now, window, limit, member).
  // ZREMRANGEBYSCORE key -inf (now - window); count = ZCARD; count < limit → ZADD now member, PEXPIRE window,
  // return {1, 0}; else ZRANGE key 0 0 WITHSCORES → return {0, oldest + window - now}.
  val Script: String = ""
  // TODO: private val sha = jedis.scriptLoad(Script) — loaded once, evalsha per call

  /** One round trip: (allowed, retryAfterMs) for clientId at nowMs. */
  def allow(clientId: String, nowMs: Long): (Boolean, Long) = {
    val key = s"sw:$clientId"
    val member = s"$nowMs-\${UUID.randomUUID()}"
    // TODO: this is four round trips and a race between instances — move it into Script and evalsha once
    jedis.zremrangeByScore(key, "-inf", (nowMs - WindowMs).toString)
    if (jedis.zcard(key) < Limit) {
      jedis.zadd(key, nowMs.toDouble, member)
      jedis.pexpire(key, WindowMs)
      (true, 0L)
    } else {
      val oldest = jedis.zrangeWithScores(key, 0, 0).asScala.head
      (false, oldest.getScore.toLong + WindowMs - nowMs)
    }
  }

  def main(args: Array[String]): Unit = println(allow("demo", 0L))
}
`,
      solution: `import java.util.UUID

import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled

/** A sliding-window log limiter: Limit calls per WindowMs, per client, decided inside Redis. */
object SlidingWindow {
  val jedis = new JedisPooled("redis", 6379)
  val Limit = 10
  val WindowMs = 1000L

  // KEYS[1] = sw:{clientId}; ARGV = nowMs, WindowMs, Limit, member. Returns {allowed, retryAfterMs}.
  val Script: String =
    """${LUA.split('\n').join('\n      |')}
      |""".stripMargin
  // Loaded once: every call is an EVALSHA.
  private val sha = jedis.scriptLoad(Script)

  /** One round trip: (allowed, retryAfterMs) for clientId at nowMs. */
  def allow(clientId: String, nowMs: Long): (Boolean, Long) = {
    val key = s"sw:$clientId"
    val member = s"$nowMs-\${UUID.randomUUID()}"
    val args = List(nowMs.toString, WindowMs.toString, Limit.toString, member).asJava
    val reply = jedis.evalsha(sha, List(key).asJava, args).asInstanceOf[java.util.List[java.lang.Long]].asScala
    (reply(0) == 1L, reply(1).longValue)
  }

  def main(args: Array[String]): Unit = println(allow("demo", 0L))
}
`,
    },
    cpp: {
      starter: `// A sliding-window log limiter: kLimit calls per kWindowMs, per client, decided inside Redis.
#include <sw/redis++/redis++.h>

#include <iterator>
#include <random>
#include <string>
#include <utility>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kLimit = 10;
constexpr long long kWindowMs = 1000;

// TODO: Lua — KEYS[1] = key; ARGV = now_ms, kWindowMs, kLimit, member (bind as now, window, limit, member).
// ZREMRANGEBYSCORE key -inf (now - window); count = ZCARD; count < limit → ZADD now member, PEXPIRE window,
// return {1, 0}; else ZRANGE key 0 0 WITHSCORES → return {0, oldest + window - now}.
const std::string kScript = "";
// TODO: const std::string kScriptSha = redis.script_load(kScript); — loaded once, evalsha per call

std::string nonce() {
  static std::mt19937 gen{std::random_device{}()};
  return std::to_string(gen());
}

struct Decision {
  bool allowed;
  long long retry_after_ms;
};

// One round trip: {allowed, retry_after_ms} for client_id at now_ms.
Decision allow(const std::string& client_id, long long now_ms) {
  const std::string key = "sw:" + client_id;
  const std::string member = std::to_string(now_ms) + "-" + nonce();
  // TODO: this is four round trips and a race between instances — move it into kScript and evalsha once
  redis.zremrangebyscore(key, sw::redis::RightBoundedInterval<double>(static_cast<double>(now_ms - kWindowMs), sw::redis::BoundType::CLOSED));
  if (redis.zcard(key) < kLimit) {
    redis.zadd(key, member, static_cast<double>(now_ms));
    redis.pexpire(key, std::chrono::milliseconds(kWindowMs));
    return {true, 0};
  }
  std::vector<std::pair<std::string, double>> oldest;
  redis.zrange(key, 0, 0, std::back_inserter(oldest));
  return {false, static_cast<long long>(oldest[0].second) + kWindowMs - now_ms};
}

int main() {
  const Decision d = allow("demo", 0);
  return d.allowed ? 0 : 1;
}
`,
      solution: `// A sliding-window log limiter: kLimit calls per kWindowMs, per client, decided inside Redis.
#include <sw/redis++/redis++.h>

#include <iterator>
#include <random>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kLimit = 10;
constexpr long long kWindowMs = 1000;

// KEYS[1] = sw:{client_id}; ARGV = now_ms, kWindowMs, kLimit, member. Returns {allowed, retry_after_ms}.
const std::string kScript = R"lua(
${LUA}
)lua";
// Loaded once: every call is an EVALSHA.
const std::string kScriptSha = redis.script_load(kScript);

std::string nonce() {
  static std::mt19937 gen{std::random_device{}()};
  return std::to_string(gen());
}

struct Decision {
  bool allowed;
  long long retry_after_ms;
};

// One round trip: {allowed, retry_after_ms} for client_id at now_ms.
Decision allow(const std::string& client_id, long long now_ms) {
  const std::string key = "sw:" + client_id;
  const std::string member = std::to_string(now_ms) + "-" + nonce();
  std::vector<long long> reply;
  redis.evalsha(kScriptSha, {key}, {std::to_string(now_ms), std::to_string(kWindowMs), std::to_string(kLimit), member},
                std::back_inserter(reply));
  return {reply[0] == 1, reply[1]};
}

int main() {
  const Decision d = allow("demo", 0);
  return d.allowed ? 0 : 1;
}
`,
    },
  },
  harness: {
    python: `import time

from leetbuild.metrics import METRICS

LIMIT = 10
WINDOW_MS = 1000


def now_ms():
    """The virtual clock in milliseconds, so scores and TTLs move together."""
    return int(time.time() * 1000)


def names(ctx):
    """Every command the learner's clients send, by name; returns (list, restore)."""
    sent = []
    cls = ctx.redis.__class__
    real = cls.execute_command

    def record(self, *args, **kw):
        sent.append(str(args[0]).upper())
        return real(self, *args, **kw)

    cls.execute_command = record
    return sent, lambda: setattr(cls, "execute_command", real)


def check_one_script(ctx):
    m = ctx.load("sliding_window")
    assert m.allow("c1", 0) == (True, 0), "the first call of a fresh client is admitted with retry_after_ms 0"
    sent, restore = names(ctx)
    trips = METRICS.redis_trips
    try:
        for i in range(1, 12):
            m.allow("c1", i)
    finally:
        restore()
    trips = METRICS.redis_trips - trips
    assert trips == 11, f"11 calls after the script is loaded took {trips} round trips, expected exactly 11 — one EVALSHA/EVAL each"
    outside = sorted({c for c in sent if c not in ("EVAL", "EVALSHA")})
    assert not outside, f"the client sent {outside} besides EVAL/EVALSHA: trim, count and admit must run inside the script"
    assert ctx.redis.type("sw:c1") == "zset", f"sw:c1 is {ctx.redis.type('sw:c1')!r}, expected a sorted set"


def check_limit(ctx):
    m = ctx.load("sliding_window")
    first = [m.allow("alice", 0) for _ in range(LIMIT)]
    assert first == [(True, 0)] * LIMIT, f"10 calls at now_ms 0 must all be admitted with retry 0, got {first}"
    assert ctx.redis.zcard("sw:alice") == LIMIT, f"sw:alice holds {ctx.redis.zcard('sw:alice')} members after 10 admits, expected 10"
    assert m.allow("alice", 0) == (False, 1000), f"the 11th call at 0 is denied with retry_after_ms 1000 (oldest at 0 leaves at 1000), got {m.allow('alice', 0)}"
    assert m.allow("alice", 400) == (False, 600), f"at 400 the oldest member (scored 0) leaves in 600 ms, got {m.allow('alice', 400)}"
    assert m.allow("alice", 999) == (False, 1), f"at 999 the oldest member leaves in 1 ms, got {m.allow('alice', 999)}"
    assert ctx.redis.zcard("sw:alice") == LIMIT, "a denied call must not add a member"
    assert m.allow("bob", 400) == (True, 0), "clients are independent: bob's first call is admitted while alice is full"
    assert m.allow("alice", 1000) == (True, 0), "at 1000 the member scored 0 is out of the window (<= now - window) and one call is admitted"


def check_sliding(ctx):
    m = ctx.load("sliding_window")
    for _ in range(4):
        assert m.allow("c", 0) == (True, 0)
    for _ in range(6):
        assert m.allow("c", 300) == (True, 0)
    assert m.allow("c", 300) == (False, 700), f"full at 300: denied, the oldest (scored 0) leaves at 1000, 700 ms away, got {m.allow('c', 300)}"
    at_1000 = [m.allow("c", 1000) for _ in range(5)]
    assert at_1000 == [(True, 0)] * 4 + [(False, 300)], f"at 1000 exactly the 4 members scored 0 have left: 4 admits then a denial pointing at the member scored 300 (retry 300), got {at_1000}"
    assert ctx.redis.zcard("sw:c") == LIMIT, f"sw:c holds {ctx.redis.zcard('sw:c')} members, expected 10: the 4 expired ones trimmed, 4 new ones added"
    assert m.allow("c", 1299) == (False, 1), f"at 1299 the member scored 300 leaves in 1 ms, got {m.allow('c', 1299)}"
    at_1300 = [m.allow("c", 1300) for _ in range(7)]
    assert at_1300 == [(True, 0)] * 6 + [(False, 700)], f"at 1300 the 6 members scored 300 have left: 6 admits, then a denial pointing at the member scored 1000 (retry 700), got {at_1300}"


def check_ttl(ctx):
    m = ctx.load("sliding_window")
    assert m.allow("idle", now_ms()) == (True, 0)
    pttl = ctx.redis.pttl("sw:idle")
    assert 950 <= pttl <= 1000, f"PTTL sw:idle is {pttl} right after an admit, expected WINDOW_MS (1000)"
    ctx.clock.advance(0.3)
    pttl = ctx.redis.pttl("sw:idle")
    assert 650 <= pttl <= 700, f"PTTL sw:idle is {pttl} 300 ms later, expected about 700: the TTL is set once per admit, not refreshed by the clock"
    assert m.allow("idle", now_ms()) == (True, 0)
    pttl = ctx.redis.pttl("sw:idle")
    assert 950 <= pttl <= 1000, f"PTTL sw:idle is {pttl} after a second admit, expected 1000 again: every admit re-arms PEXPIRE"
    ctx.clock.advance(1.1)
    assert ctx.redis.exists("sw:idle") == 0, "a client idle for a whole window must leave no key behind"
    assert m.allow("idle", now_ms()) == (True, 0), "after the key expired the client starts a fresh window"


def check_atomic(ctx):
    a = ctx.load("sliding_window")
    b = ctx.reload("sliding_window")
    theirs = []
    seven = [a.allow("racer", 0) for _ in range(7)]
    assert seven == [(True, 0)] * 7

    def land():
        # two calls from the other instance, then re-armed for the first instance's next command
        theirs.append(b.allow("racer", 0))
        theirs.append(b.allow("racer", 0))
        if len(theirs) < 40:
            ctx.redis_after("sw:racer", land)

    probe = ctx.redis_after("sw:racer", land)
    mine = seven + [a.allow("racer", 0) for _ in range(5)]
    assert probe.fired, "the first instance never touched sw:racer"
    assert probe.error is None, f"the second instance's allow raised {probe.error!r} while landing between commands"
    admitted = sum(1 for ok, _ in mine if ok) + sum(1 for ok, _ in theirs if ok)
    assert admitted <= LIMIT, f"two instances admitted {admitted} calls for one client in one window: the second instance landed between the first's commands and both counted the same slot — the decision must be one script"
    assert admitted == LIMIT, f"two instances together admitted {admitted} of the 10 allowed"
    assert ctx.redis.zcard("sw:racer") == LIMIT, f"sw:racer holds {ctx.redis.zcard('sw:racer')} members, expected 10"
    assert a.allow("racer", 0) == (False, 1000) and b.allow("racer", 0) == (False, 1000), "both instances deny once the window is full"


def check_unique_members(ctx):
    m = ctx.load("sliding_window")
    other = ctx.reload("sliding_window")
    same = [m.allow("burst", 5000) for _ in range(9)]
    assert same == [(True, 0)] * 9, f"9 calls in the same millisecond must all be admitted, got {same}"
    assert ctx.redis.zcard("sw:burst") == 9, f"9 calls at now_ms 5000 left {ctx.redis.zcard('sw:burst')} members: each call must be its own member, not one member rewritten"
    assert other.allow("burst", 5000) == (True, 0), "a second instance's call in the same millisecond is the 10th member"
    members = ctx.redis.zrange("sw:burst", 0, -1, withscores=True)
    assert len(members) == LIMIT and len({name for name, _ in members}) == LIMIT, f"expected 10 distinct members, got {members}"
    assert all(score == 5000 for _, score in members), f"every member is scored by its now_ms (5000), got {members}"
    assert all(name.startswith("5000-") for name, _ in members), f"members are '{{now_ms}}-{{nonce}}', got {[name for name, _ in members]}"
    assert m.allow("burst", 5000) == (False, 1000), "the 11th call in that millisecond is denied with the full window to wait"
`,
    typescript: `const LIMIT = 10;
const WINDOW_MS = 1000;

export async function check_one_script(ctx) {
  const m = ctx.load('sliding_window');
  assert.deepEqual(await m.allow('c1', 0), [true, 0], 'the first call of a fresh client is admitted with retryAfterMs 0');
  const before = ctx.redisRoundTrips().length;
  for (let i = 1; i < 12; i++) await m.allow('c1', i);
  const trips = ctx.redisRoundTrips().slice(before);
  assert.equal(trips.length, 11, \`11 calls after the script is loaded took \${trips.length} round trips, expected exactly 11 — one EVALSHA/EVAL each\`);
  const outside = [...new Set(trips.flat().filter(c => c !== 'EVAL' && c !== 'EVALSHA'))].sort();
  assert.equal(outside.length, 0, \`the client sent \${JSON.stringify(outside)} besides EVAL/EVALSHA: trim, count and admit must run inside the script\`);
  assert.equal(ctx.redis.type('sw:c1'), 'zset', \`sw:c1 is \${JSON.stringify(ctx.redis.type('sw:c1'))}, expected a sorted set\`);
}

export async function check_limit(ctx) {
  const m = ctx.load('sliding_window');
  const first = [];
  for (let i = 0; i < LIMIT; i++) first.push(await m.allow('alice', 0));
  assert.deepEqual(first, Array(LIMIT).fill([true, 0]), \`10 calls at nowMs 0 must all be admitted with retry 0, got \${JSON.stringify(first)}\`);
  assert.equal(ctx.redis.zcard('sw:alice'), LIMIT, \`sw:alice holds \${ctx.redis.zcard('sw:alice')} members after 10 admits, expected 10\`);
  assert.deepEqual(await m.allow('alice', 0), [false, 1000], 'the 11th call at 0 is denied with retryAfterMs 1000 (oldest at 0 leaves at 1000)');
  assert.deepEqual(await m.allow('alice', 400), [false, 600], 'at 400 the oldest member (scored 0) leaves in 600 ms');
  assert.deepEqual(await m.allow('alice', 999), [false, 1], 'at 999 the oldest member leaves in 1 ms');
  assert.equal(ctx.redis.zcard('sw:alice'), LIMIT, 'a denied call must not add a member');
  assert.deepEqual(await m.allow('bob', 400), [true, 0], "clients are independent: bob's first call is admitted while alice is full");
  assert.deepEqual(await m.allow('alice', 1000), [true, 0], 'at 1000 the member scored 0 is out of the window (<= now - window) and one call is admitted');
}

export async function check_sliding(ctx) {
  const m = ctx.load('sliding_window');
  for (let i = 0; i < 4; i++) assert.deepEqual(await m.allow('c', 0), [true, 0]);
  for (let i = 0; i < 6; i++) assert.deepEqual(await m.allow('c', 300), [true, 0]);
  assert.deepEqual(await m.allow('c', 300), [false, 700], 'full at 300: denied, the oldest (scored 0) leaves at 1000, 700 ms away');
  const at1000 = [];
  for (let i = 0; i < 5; i++) at1000.push(await m.allow('c', 1000));
  assert.deepEqual(at1000, [...Array(4).fill([true, 0]), [false, 300]], \`at 1000 exactly the 4 members scored 0 have left: 4 admits then a denial pointing at the member scored 300 (retry 300), got \${JSON.stringify(at1000)}\`);
  assert.equal(ctx.redis.zcard('sw:c'), LIMIT, \`sw:c holds \${ctx.redis.zcard('sw:c')} members, expected 10: the 4 expired ones trimmed, 4 new ones added\`);
  assert.deepEqual(await m.allow('c', 1299), [false, 1], 'at 1299 the member scored 300 leaves in 1 ms');
  const at1300 = [];
  for (let i = 0; i < 7; i++) at1300.push(await m.allow('c', 1300));
  assert.deepEqual(at1300, [...Array(6).fill([true, 0]), [false, 700]], \`at 1300 the 6 members scored 300 have left: 6 admits, then a denial pointing at the member scored 1000 (retry 700), got \${JSON.stringify(at1300)}\`);
}

export async function check_ttl(ctx) {
  const m = ctx.load('sliding_window');
  assert.deepEqual(await m.allow('idle', ctx.clock.now()), [true, 0]);
  let pttl = ctx.redis.pttl('sw:idle');
  assert(950 <= pttl && pttl <= 1000, \`PTTL sw:idle is \${pttl} right after an admit, expected WINDOW_MS (1000)\`);
  ctx.clock.advance(0.3);
  pttl = ctx.redis.pttl('sw:idle');
  assert(650 <= pttl && pttl <= 700, \`PTTL sw:idle is \${pttl} 300 ms later, expected about 700: the TTL is set once per admit, not refreshed by the clock\`);
  assert.deepEqual(await m.allow('idle', ctx.clock.now()), [true, 0]);
  pttl = ctx.redis.pttl('sw:idle');
  assert(950 <= pttl && pttl <= 1000, \`PTTL sw:idle is \${pttl} after a second admit, expected 1000 again: every admit re-arms PEXPIRE\`);
  ctx.clock.advance(1.1);
  assert.equal(ctx.redis.exists('sw:idle'), 0, 'a client idle for a whole window must leave no key behind');
  assert.deepEqual(await m.allow('idle', ctx.clock.now()), [true, 0], 'after the key expired the client starts a fresh window');
}

export async function check_atomic(ctx) {
  const a = ctx.load('sliding_window');
  const b = ctx.reload('sliding_window');
  const theirs: Promise<[boolean, number]>[] = [];
  const mine: [boolean, number][] = [];
  for (let i = 0; i < 7; i++) mine.push(await a.allow('racer', 0));
  assert.deepEqual(mine, Array(7).fill([true, 0]));
  const land = () => {
    // two calls from the other instance, then re-armed (before the first instance's await continues) for its next command
    theirs.push(b.allow('racer', 0));
    theirs.push(b.allow('racer', 0));
    if (theirs.length < 40) queueMicrotask(() => ctx.redisAfter('sw:racer', land));
  };
  const probe = ctx.redisAfter('sw:racer', land);
  for (let i = 0; i < 5; i++) mine.push(await a.allow('racer', 0));
  assert(probe.fired, 'the first instance never touched sw:racer');
  assert.equal(probe.error, undefined, \`the second instance's allow raised \${String(probe.error)} while landing between commands\`);
  const landed = await Promise.all(theirs);
  const admitted = mine.filter(([ok]) => ok).length + landed.filter(([ok]) => ok).length;
  assert(admitted <= LIMIT, \`two instances admitted \${admitted} calls for one client in one window: the second instance landed between the first's commands and both counted the same slot — the decision must be one script\`);
  assert.equal(admitted, LIMIT, \`two instances together admitted \${admitted} of the 10 allowed\`);
  assert.equal(ctx.redis.zcard('sw:racer'), LIMIT, \`sw:racer holds \${ctx.redis.zcard('sw:racer')} members, expected 10\`);
  assert.deepEqual(await a.allow('racer', 0), [false, 1000], 'both instances deny once the window is full');
  assert.deepEqual(await b.allow('racer', 0), [false, 1000], 'both instances deny once the window is full');
}

export async function check_unique_members(ctx) {
  const m = ctx.load('sliding_window');
  const other = ctx.reload('sliding_window');
  const same = [];
  for (let i = 0; i < 9; i++) same.push(await m.allow('burst', 5000));
  assert.deepEqual(same, Array(9).fill([true, 0]), \`9 calls in the same millisecond must all be admitted, got \${JSON.stringify(same)}\`);
  assert.equal(ctx.redis.zcard('sw:burst'), 9, \`9 calls at nowMs 5000 left \${ctx.redis.zcard('sw:burst')} members: each call must be its own member, not one member rewritten\`);
  assert.deepEqual(await other.allow('burst', 5000), [true, 0], "a second instance's call in the same millisecond is the 10th member");
  const flat = ctx.redis.zrange('sw:burst', 0, -1, 'WITHSCORES') as string[];
  const names = flat.filter((_, i) => i % 2 === 0);
  const scores = flat.filter((_, i) => i % 2 === 1);
  assert(names.length === LIMIT && new Set(names).size === LIMIT, \`expected 10 distinct members, got \${JSON.stringify(flat)}\`);
  assert(scores.every(s => Number(s) === 5000), \`every member is scored by its nowMs (5000), got \${JSON.stringify(flat)}\`);
  assert(names.every(n => n.startsWith('5000-')), \`members are '{nowMs}-{nonce}', got \${JSON.stringify(names)}\`);
  assert.deepEqual(await m.allow('burst', 5000), [false, 1000], 'the 11th call in that millisecond is denied with the full window to wait');
}
`,
    go: `package main

import (
	"context"
	"sort"
	"strings"

	"leetbuild/harness"
)

// swVerdict is what allow returned, so a call compares and prints as one value.
type swVerdict struct {
	Allowed      bool
	RetryAfterMs int64
}

var (
	swBg    = context.Background()
	swAdmit = swVerdict{true, 0}
)

func swAllow(ctx *harness.Ctx, clientID string, nowMs int64) swVerdict {
	ok, retry, err := allow(swBg, clientID, nowMs)
	ctx.NoError(err, "allow(%q, %d) returned an error", clientID, nowMs)
	return swVerdict{ok, retry}
}

// swAdmits is n admitted verdicts.
func swAdmits(n int) []swVerdict {
	out := make([]swVerdict, n)
	for i := range out {
		out[i] = swAdmit
	}
	return out
}

func CheckOneScript(ctx *harness.Ctx) {
	ctx.Equal(swAllow(ctx, "c1", 0), swAdmit, "the first call of a fresh client is admitted with retryAfterMs 0")
	before := len(ctx.Redis.RoundTrips())
	for i := int64(1); i < 12; i++ {
		swAllow(ctx, "c1", i)
	}
	trips := ctx.Redis.RoundTrips()[before:]
	ctx.Assert(len(trips) == 11, "11 calls after the script is loaded took %d round trips, expected exactly 11: one EVALSHA/EVAL each", len(trips))
	seen := map[string]bool{}
	outside := []string{}
	for _, trip := range trips {
		for _, name := range trip {
			if name != "EVAL" && name != "EVALSHA" && !seen[name] {
				seen[name] = true
				outside = append(outside, name)
			}
		}
	}
	sort.Strings(outside)
	ctx.Assert(len(outside) == 0, "the client sent %s besides EVAL/EVALSHA: trim, count and admit must run inside the script", harness.Show(outside))
	ctx.Equal(ctx.Redis.Type("sw:c1"), "zset", "sw:c1 must be a sorted set: its type")
}

func CheckLimit(ctx *harness.Ctx) {
	first := []swVerdict{}
	for range limit {
		first = append(first, swAllow(ctx, "alice", 0))
	}
	ctx.Equal(first, swAdmits(limit), "10 calls at nowMs 0 must all be admitted with retry 0")
	ctx.Equal(ctx.Redis.ZCard("sw:alice"), limit, "the members of sw:alice after 10 admits")
	ctx.Equal(swAllow(ctx, "alice", 0), swVerdict{false, 1000}, "the 11th call at 0 is denied with retryAfterMs 1000 (oldest at 0 leaves at 1000)")
	ctx.Equal(swAllow(ctx, "alice", 400), swVerdict{false, 600}, "at 400 the oldest member (scored 0) leaves in 600 ms")
	ctx.Equal(swAllow(ctx, "alice", 999), swVerdict{false, 1}, "at 999 the oldest member leaves in 1 ms")
	ctx.Equal(ctx.Redis.ZCard("sw:alice"), limit, "a denied call must not add a member: the members of sw:alice")
	ctx.Equal(swAllow(ctx, "bob", 400), swAdmit, "clients are independent: bob's first call is admitted while alice is full")
	ctx.Equal(swAllow(ctx, "alice", 1000), swAdmit, "at 1000 the member scored 0 is out of the window (<= now - window) and one call is admitted")
}

func CheckSliding(ctx *harness.Ctx) {
	for range 4 {
		ctx.Equal(swAllow(ctx, "c", 0), swAdmit, "the first 4 calls at 0 are admitted")
	}
	for range 6 {
		ctx.Equal(swAllow(ctx, "c", 300), swAdmit, "the next 6 calls at 300 are admitted")
	}
	ctx.Equal(swAllow(ctx, "c", 300), swVerdict{false, 700}, "full at 300: denied, the oldest (scored 0) leaves at 1000, 700 ms away")
	at1000 := []swVerdict{}
	for range 5 {
		at1000 = append(at1000, swAllow(ctx, "c", 1000))
	}
	ctx.Equal(at1000, append(swAdmits(4), swVerdict{false, 300}), "at 1000 exactly the 4 members scored 0 have left: 4 admits then a denial pointing at the member scored 300 (retry 300)")
	ctx.Equal(ctx.Redis.ZCard("sw:c"), limit, "the members of sw:c: the 4 expired ones trimmed, 4 new ones added")
	ctx.Equal(swAllow(ctx, "c", 1299), swVerdict{false, 1}, "at 1299 the member scored 300 leaves in 1 ms")
	at1300 := []swVerdict{}
	for range 7 {
		at1300 = append(at1300, swAllow(ctx, "c", 1300))
	}
	ctx.Equal(at1300, append(swAdmits(6), swVerdict{false, 700}), "at 1300 the 6 members scored 300 have left: 6 admits, then a denial pointing at the member scored 1000 (retry 700)")
}

func CheckTtl(ctx *harness.Ctx) {
	ctx.Equal(swAllow(ctx, "idle", ctx.Clock.Now()), swAdmit, "the first call of a fresh client is admitted")
	pttl := ctx.Redis.PTTL("sw:idle")
	ctx.Assert(950 <= pttl && pttl <= 1000, "PTTL sw:idle is %d right after an admit, expected windowMs (1000)", pttl)
	ctx.Clock.Advance(0.3)
	pttl = ctx.Redis.PTTL("sw:idle")
	ctx.Assert(650 <= pttl && pttl <= 700, "PTTL sw:idle is %d 300 ms later, expected about 700: the TTL is set once per admit, not refreshed by the clock", pttl)
	ctx.Equal(swAllow(ctx, "idle", ctx.Clock.Now()), swAdmit, "the second call is admitted")
	pttl = ctx.Redis.PTTL("sw:idle")
	ctx.Assert(950 <= pttl && pttl <= 1000, "PTTL sw:idle is %d after a second admit, expected 1000 again: every admit re-arms PEXPIRE", pttl)
	ctx.Clock.Advance(1.1)
	ctx.Equal(ctx.Redis.Exists("sw:idle"), 0, "a client idle for a whole window must leave no key behind")
	ctx.Equal(swAllow(ctx, "idle", ctx.Clock.Now()), swAdmit, "after the key expired the client starts a fresh window")
}

func CheckAtomic(ctx *harness.Ctx) {
	mine := []swVerdict{}
	for range 7 {
		mine = append(mine, swAllow(ctx, "racer", 0))
	}
	ctx.Equal(mine, swAdmits(7), "the first 7 calls are admitted")
	// A second instance's two calls land right after each command of the first instance's that touches
	// sw:racer, re-armed for its next one, until 40 have landed.
	var theirs []swVerdict
	var theirErr error
	var land func() any
	land = func() any {
		for range 2 {
			ok, retry, err := allow(swBg, "racer", 0)
			if err != nil && theirErr == nil {
				theirErr = err
			}
			theirs = append(theirs, swVerdict{ok, retry})
		}
		if len(theirs) < 40 {
			ctx.Redis.After("sw:racer", land)
		}
		return nil
	}
	probe := ctx.Redis.After("sw:racer", land)
	for range 5 {
		mine = append(mine, swAllow(ctx, "racer", 0))
	}
	ctx.Assert(probe.Fired, "the first instance never touched sw:racer")
	ctx.Assert(probe.Err == nil, "the second instance's allow failed while landing between commands: %v", probe.Err)
	ctx.NoError(theirErr, "the second instance's allow returned an error while landing between commands")
	admitted := 0
	for _, v := range append(mine, theirs...) {
		if v.Allowed {
			admitted++
		}
	}
	ctx.Assert(admitted <= limit, "two instances admitted %d calls for one client in one window: the second instance landed between the first's commands and both counted the same slot, so the decision must be one script", admitted)
	ctx.Equal(admitted, limit, "the calls two instances together admitted")
	ctx.Equal(ctx.Redis.ZCard("sw:racer"), limit, "the members of sw:racer")
	ctx.Equal(swAllow(ctx, "racer", 0), swVerdict{false, 1000}, "both instances deny once the window is full")
	ctx.Equal(swAllow(ctx, "racer", 0), swVerdict{false, 1000}, "both instances deny once the window is full")
}

func CheckUniqueMembers(ctx *harness.Ctx) {
	same := []swVerdict{}
	for range 9 {
		same = append(same, swAllow(ctx, "burst", 5000))
	}
	ctx.Equal(same, swAdmits(9), "9 calls in the same millisecond must all be admitted")
	ctx.Equal(ctx.Redis.ZCard("sw:burst"), 9, "the members after 9 calls at nowMs 5000: each call must be its own member, not one member rewritten")
	ctx.Equal(swAllow(ctx, "burst", 5000), swAdmit, "a second instance's call in the same millisecond is the 10th member")
	members := ctx.Redis.ZRangeWithScores("sw:burst", 0, -1)
	names := map[string]bool{}
	for _, z := range members {
		names[z.Member] = true
	}
	ctx.Assert(len(members) == limit && len(names) == limit, "expected 10 distinct members, got %v", members)
	for _, z := range members {
		ctx.Assert(z.Score == 5000, "every member is scored by its nowMs (5000), got %v", members)
		ctx.Assert(strings.HasPrefix(z.Member, "5000-"), "members are %q, got %v", "{nowMs}-{nonce}", members)
	}
	ctx.Equal(swAllow(ctx, "burst", 5000), swVerdict{false, 1000}, "the 11th call in that millisecond is denied with the full window to wait")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <exception>
#include <functional>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace {

// swVerdict is what allow returned, so a call compares and prints as one value.
using swVerdict = std::pair<bool, long long>;

const swVerdict swAdmit{true, 0};

swVerdict swAllow(const std::string& clientID, long long nowMs) {
  const Decision d = allow(clientID, nowMs);
  return {d.allowed, d.retry_after_ms};
}

// swAdmits is n admitted verdicts, then the tail.
std::vector<swVerdict> swAdmits(long long n, std::vector<swVerdict> tail = {}) {
  std::vector<swVerdict> out(static_cast<size_t>(n), swAdmit);
  out.insert(out.end(), tail.begin(), tail.end());
  return out;
}

}  // namespace

void CheckOneScript(harness::Ctx& ctx) {
  ctx.Equal(swAllow("c1", 0), swAdmit, "the first call of a fresh client is admitted with retryAfterMs 0");
  const size_t before = ctx.Redis.RoundTrips().size();
  for (long long i = 1; i < 12; i++) swAllow("c1", i);
  const auto all = ctx.Redis.RoundTrips();
  const std::vector<std::vector<std::string>> trips(all.begin() + static_cast<long>(before), all.end());
  ctx.Assert(trips.size() == 11, "11 calls after the script is loaded took %d round trips, expected exactly 11: one EVALSHA/EVAL each", trips.size());
  std::set<std::string> outside;
  for (const auto& trip : trips) {
    for (const auto& name : trip) {
      if (name != "EVAL" && name != "EVALSHA") outside.insert(name);
    }
  }
  ctx.Assert(outside.empty(), "the client sent %s besides EVAL/EVALSHA: trim, count and admit must run inside the script", harness::Value(std::vector<std::string>(outside.begin(), outside.end())));
  ctx.Equal(ctx.Redis.Type("sw:c1"), "zset", "sw:c1 must be a sorted set: its type");
}

void CheckLimit(harness::Ctx& ctx) {
  std::vector<swVerdict> first;
  for (long long i = 0; i < kLimit; i++) first.push_back(swAllow("alice", 0));
  ctx.Equal(first, swAdmits(kLimit), "10 calls at nowMs 0 must all be admitted with retry 0");
  ctx.Equal(ctx.Redis.ZCard("sw:alice"), kLimit, "the members of sw:alice after 10 admits");
  ctx.Equal(swAllow("alice", 0), swVerdict{false, 1000}, "the 11th call at 0 is denied with retryAfterMs 1000 (oldest at 0 leaves at 1000)");
  ctx.Equal(swAllow("alice", 400), swVerdict{false, 600}, "at 400 the oldest member (scored 0) leaves in 600 ms");
  ctx.Equal(swAllow("alice", 999), swVerdict{false, 1}, "at 999 the oldest member leaves in 1 ms");
  ctx.Equal(ctx.Redis.ZCard("sw:alice"), kLimit, "a denied call must not add a member: the members of sw:alice");
  ctx.Equal(swAllow("bob", 400), swAdmit, "clients are independent: bob's first call is admitted while alice is full");
  ctx.Equal(swAllow("alice", 1000), swAdmit, "at 1000 the member scored 0 is out of the window (<= now - window) and one call is admitted");
}

void CheckSliding(harness::Ctx& ctx) {
  for (int i = 0; i < 4; i++) ctx.Equal(swAllow("c", 0), swAdmit, "the first 4 calls at 0 are admitted");
  for (int i = 0; i < 6; i++) ctx.Equal(swAllow("c", 300), swAdmit, "the next 6 calls at 300 are admitted");
  ctx.Equal(swAllow("c", 300), swVerdict{false, 700}, "full at 300: denied, the oldest (scored 0) leaves at 1000, 700 ms away");
  std::vector<swVerdict> at1000;
  for (int i = 0; i < 5; i++) at1000.push_back(swAllow("c", 1000));
  ctx.Equal(at1000, swAdmits(4, {{false, 300}}), "at 1000 exactly the 4 members scored 0 have left: 4 admits then a denial pointing at the member scored 300 (retry 300)");
  ctx.Equal(ctx.Redis.ZCard("sw:c"), kLimit, "the members of sw:c: the 4 expired ones trimmed, 4 new ones added");
  ctx.Equal(swAllow("c", 1299), swVerdict{false, 1}, "at 1299 the member scored 300 leaves in 1 ms");
  std::vector<swVerdict> at1300;
  for (int i = 0; i < 7; i++) at1300.push_back(swAllow("c", 1300));
  ctx.Equal(at1300, swAdmits(6, {{false, 700}}), "at 1300 the 6 members scored 300 have left: 6 admits, then a denial pointing at the member scored 1000 (retry 700)");
}

void CheckTtl(harness::Ctx& ctx) {
  ctx.Equal(swAllow("idle", ctx.Clock.Now()), swAdmit, "the first call of a fresh client is admitted");
  long long pttl = ctx.Redis.PTTL("sw:idle");
  ctx.Assert(950 <= pttl && pttl <= 1000, "PTTL sw:idle is %d right after an admit, expected windowMs (1000)", pttl);
  ctx.Clock.Advance(0.3);
  pttl = ctx.Redis.PTTL("sw:idle");
  ctx.Assert(650 <= pttl && pttl <= 700, "PTTL sw:idle is %d 300 ms later, expected about 700: the TTL is set once per admit, not refreshed by the clock", pttl);
  ctx.Equal(swAllow("idle", ctx.Clock.Now()), swAdmit, "the second call is admitted");
  pttl = ctx.Redis.PTTL("sw:idle");
  ctx.Assert(950 <= pttl && pttl <= 1000, "PTTL sw:idle is %d after a second admit, expected 1000 again: every admit re-arms PEXPIRE", pttl);
  ctx.Clock.Advance(1.1);
  ctx.Equal(ctx.Redis.Exists("sw:idle"), 0, "a client idle for a whole window must leave no key behind");
  ctx.Equal(swAllow("idle", ctx.Clock.Now()), swAdmit, "after the key expired the client starts a fresh window");
}

void CheckAtomic(harness::Ctx& ctx) {
  std::vector<swVerdict> mine;
  for (int i = 0; i < 7; i++) mine.push_back(swAllow("racer", 0));
  ctx.Equal(mine, swAdmits(7), "the first 7 calls are admitted");
  // A second instance's two calls land right after each command of the first instance's that touches
  // sw:racer, re-armed for its next one, until 40 have landed.
  std::vector<swVerdict> theirs;
  std::string theirErr;
  bool fired = false;
  std::function<void()> land = [&] {
    fired = true;
    for (int i = 0; i < 2; i++) {
      try {
        theirs.push_back(swAllow("racer", 0));
      } catch (const std::exception& e) {
        if (theirErr.empty()) theirErr = e.what();
        theirs.push_back({false, 0});
      }
    }
    if (theirs.size() < 40) ctx.Redis.After("sw:racer", land);
  };
  ctx.Redis.After("sw:racer", land);
  for (int i = 0; i < 5; i++) mine.push_back(swAllow("racer", 0));
  ctx.Assert(fired, "the first instance never touched sw:racer");
  ctx.Assert(theirErr.empty(), "the second instance's allow returned an error while landing between commands: %s", theirErr);
  long long admitted = 0;
  for (const auto& v : mine) admitted += v.first ? 1 : 0;
  for (const auto& v : theirs) admitted += v.first ? 1 : 0;
  ctx.Assert(admitted <= kLimit, "two instances admitted %d calls for one client in one window: the second instance landed between the first's commands and both counted the same slot, so the decision must be one script", admitted);
  ctx.Equal(admitted, kLimit, "the calls two instances together admitted");
  ctx.Equal(ctx.Redis.ZCard("sw:racer"), kLimit, "the members of sw:racer");
  ctx.Equal(swAllow("racer", 0), swVerdict{false, 1000}, "both instances deny once the window is full");
  ctx.Equal(swAllow("racer", 0), swVerdict{false, 1000}, "both instances deny once the window is full");
}

void CheckUniqueMembers(harness::Ctx& ctx) {
  std::vector<swVerdict> same;
  for (int i = 0; i < 9; i++) same.push_back(swAllow("burst", 5000));
  ctx.Equal(same, swAdmits(9), "9 calls in the same millisecond must all be admitted");
  ctx.Equal(ctx.Redis.ZCard("sw:burst"), 9, "the members after 9 calls at nowMs 5000: each call must be its own member, not one member rewritten");
  ctx.Equal(swAllow("burst", 5000), swAdmit, "a second instance's call in the same millisecond is the 10th member");
  const auto members = ctx.Redis.ZRangeWithScores("sw:burst", 0, -1);
  std::set<std::string> names;
  for (const auto& z : members) names.insert(z.Member);
  ctx.Assert(static_cast<long long>(members.size()) == kLimit && static_cast<long long>(names.size()) == kLimit, "expected 10 distinct members, got %v", members);
  for (const auto& z : members) {
    ctx.Assert(z.Score == 5000, "every member is scored by its nowMs (5000), got %v", members);
    ctx.Assert(z.Member.rfind("5000-", 0) == 0, "members are %q, got %v", "{nowMs}-{nonce}", members);
  }
  ctx.Equal(swAllow("burst", 5000), swVerdict{false, 1000}, "the 11th call in that millisecond is denied with the full window to wait");
}
`,
  },
  debrief: `The limiter is correct for one reason: nothing between the trim and the \`ZADD\` happens outside Redis. A client that trims, counts and then adds gives every other instance three places to land, and the race only shows at the edge — count nine, both add — which is exactly where a limiter matters. The script runs alone, so the count it reads is the count it adds to, and because the caller passes \`now_ms\` the script is deterministic and replicates safely. The sorted set is the natural log: scores are time, \`ZREMRANGEBYSCORE\` is the slide, \`ZRANGE 0 0\` is the oldest member and therefore an exact \`retry_after_ms\`, and \`PEXPIRE\` makes an idle client cost nothing. The member must be unique per call because a sorted set is a set — reusing \`now_ms\` silently merges a burst into one entry. Real systems add a second, coarser limit per client, a cheaper approximation (two fixed windows weighted by overlap) when the log would hold thousands of members per client, hash tags so the key and the script stay on one cluster slot, and fail-open behaviour when Redis is unreachable.`,
};
