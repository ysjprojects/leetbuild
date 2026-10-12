import type {Step} from '@/lib/types';

export const userRateLimitStep: Step = {
  id: 'user-rate-limit',
  title: 'Sliding-window limit: 20 per user per hour',
  concept: 'redis',
  file: 'rate_limit',
  focus: ['worker', 'redis'],
  task: `## Task

Twenty pings an hour is where a user turns notifications off for good. Implement
\`allowed(user_id, notification_id)\`: a **sliding window** over the last hour, kept in a Redis sorted
set, that the delivery worker consults before sending.

- The key is \`rl:{user_id}\`; members are notification ids scored by their timestamp in milliseconds.
- In **one pipeline / MULTI**, run: \`ZADD rl:{user} <now_ms> <id>\`,
  \`ZREMRANGEBYSCORE rl:{user} -inf <now_ms − 3600000>\`, \`ZCARD rl:{user}\`, \`EXPIRE rl:{user} 3600\`.
- When the count is **over 20**, the notification is dropped: \`INCR dropped:{user}\` (so the number is
  visible on a dashboard) and return false. Otherwise return true.

:::widget token-bucket {"rate": 20, "burst": 20}

> A token bucket (above) refills continuously and caps the burst; a fixed window resets on the
> minute and lets 2× the limit through at the boundary. The sliding window here counts the exact
> events of the last hour — the most precise of the three, at the price of one sorted-set member
> per event instead of one counter. For "20 per user per hour" that is a small price.`,
  sequence: {
    participants: ['delivery', 'Redis'],
    messages: [
      {from: 'delivery', to: 'Redis', label: 'MULTI', kind: 'sync'},
      {from: 'delivery', to: 'Redis', label: 'ZADD rl:u42 1717171717000 n-7f3', kind: 'sync'},
      {from: 'delivery', to: 'Redis', label: 'ZREMRANGEBYSCORE rl:u42 -inf 1717168117000', kind: 'sync'},
      {from: 'delivery', to: 'Redis', label: 'ZCARD rl:u42 · EXPIRE rl:u42 3600', kind: 'sync'},
      {from: 'Redis', to: 'delivery', label: 'EXEC → [1, 3, 21, 1]', kind: 'reply'},
      {from: 'delivery', to: 'Redis', label: 'INCR dropped:u42 (21 > 20)', kind: 'sync'},
    ],
  },
  hints: [
    'Add first, trim second: once the stale members are gone, ZCARD is exactly "events in the last hour including this one". That is the number to compare with the limit.',
    'The four commands go into one pipeline (or MULTI/EXEC) and the ZCARD reply is the third result; read it from the replies, not with a separate round trip.',
    'EXPIRE on every call is cheap and keeps idle users from leaving a sorted set behind forever; the TTL equals the window because anything older is trimmed anyway.',
  ],
  checks: [
    {
      id: 'zset-key',
      title: 'Adds the notification to rl:{user} scored by time',
      detail: 'ZADD the notification id into `rl:{user}` with the current time in milliseconds as its score.',
      match: {
        python: {all: [/f["']rl:\{user_id\}["']/, /\.zadd\(\s*\w+\s*,\s*\{\s*notification_id\s*:\s*now_ms\s*\}\s*\)/]},
        go: {
          all: [
            /"rl:"\s*\+\s*\w+|"rl:%s"/,
            /\.ZAdd\(\s*ctx\s*,\s*\w+\s*,\s*redis\.Z\{\s*Score:\s*float64\(\s*nowMs\s*\)\s*,\s*Member:\s*notificationID\s*\}\s*\)/,
          ],
        },
        scala: {all: [/s"rl:\$/, /\.zadd\(\s*\w+\s*,\s*nowMs(\.toDouble)?\s*,\s*notificationId\s*\)/]},
        cpp: {all: [/"rl:"\s*\+/, /\.zadd\(\s*\w+\s*,\s*notification_id\s*,\s*[^,\n]*now_ms[^,\n]*\)/]},
      },
    },
    {
      id: 'trim-window',
      title: 'Removes events older than one hour',
      detail:
        '`ZREMRANGEBYSCORE rl:{user} -inf now−3600000` drops everything that left the window, so the count is exact.',
      match: {
        python: {
          all: [/\.zremrangebyscore\(\s*\w+\s*,\s*["']-inf["']\s*,\s*now_ms\s*-\s*(WINDOW_MS|3_?600_?000)\s*\)/],
        },
        go: {all: [/\.ZRemRangeByScore\(\s*ctx\s*,\s*\w+\s*,\s*"-inf"\s*,[^\n]*nowMs\s*-\s*windowMs/]},
        scala: {
          all: [/\.zremrangeByScore\(\s*\w+\s*,\s*("-inf"|Double\.NegativeInfinity)\s*,[^\n]*nowMs\s*-\s*WindowMs/],
        },
        cpp: {all: [/\.zremrangebyscore\(\s*\w+\s*,[^\n]*RightBoundedInterval<double>\(\s*now_ms\s*-\s*kWindowMs/]},
      },
    },
    {
      id: 'pipeline',
      title: 'Runs ZADD, trim, ZCARD and EXPIRE in one round trip',
      detail:
        'All four commands go through one pipeline / MULTI: one round trip per check, and the count is read from the replies rather than with a separate call.',
      match: {
        python: {
          all: [
            /\br\.pipeline\(/,
            /\.zcard\(\s*\w+\s*\)/,
            /\.expire\(\s*\w+\s*,\s*(WINDOW_S|3600)\s*\)/,
            /\.execute\(\)/,
          ],
        },
        go: {
          all: [
            /rdb\.(TxPipeline|Pipeline|TxPipelined|Pipelined)\(/,
            /\.ZCard\(\s*ctx\s*,\s*\w+\s*\)/,
            /\.Expire\(\s*ctx\s*,\s*\w+\s*,\s*(window|time\.Hour)\s*\)/,
          ],
        },
        scala: {
          all: [
            /jedis\.(pipelined|multi)\(\)/,
            /\.zcard\(\s*\w+\s*\)/,
            /\.expire\(\s*\w+\s*,\s*(WindowSeconds|3600L?)\s*\)/,
            /\.(sync|exec)\(\)/,
          ],
        },
        cpp: {
          all: [
            /redis\.(transaction|pipeline)\(/,
            /\.zcard\(\s*\w+\s*\)/,
            /\.expire\(\s*\w+\s*,\s*kWindow\s*\)/,
            /\.exec\(\)/,
          ],
        },
      },
    },
    {
      id: 'over-limit',
      title: 'Drops the 21st notification of the hour and counts it',
      detail: 'When the count exceeds the limit, `INCR dropped:{user}` and return false; the worker skips delivery.',
      match: {
        python: {
          all: [/[\w.()[\]]+\s*>\s*(LIMIT|20)\b/, /\.incr\(\s*f["']dropped:\{user_id\}["']\s*\)/, /return False/],
        },
        go: {
          all: [
            /[\w.()]+\s*>\s*(limit|20)\b/,
            /\.Incr\(\s*ctx\s*,\s*("dropped:"\s*\+\s*\w+|fmt\.Sprintf\(\s*"dropped:%s")/,
            /return false/,
          ],
        },
        scala: {all: [/[\w.()]+\s*>\s*(Limit|20)\b/, /\.incr\(\s*s"dropped:\$/, /\bfalse\b/]},
        cpp: {all: [/[\w.()]+\s*>\s*(kLimit|20)\b/, /\.incr\(\s*"dropped:"\s*\+/, /return false/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

r = redis.Redis(host="redis", port=6379)

LIMIT = 20  # notifications per user per hour
WINDOW_MS = 3_600_000
WINDOW_S = 3600


def allowed(user_id: str, notification_id: str) -> bool:
    """True when this notification fits the user's hourly budget; False → the worker skips delivery."""
    now_ms = int(time.time() * 1000)
    key = f"rl:{user_id}"
    # TODO: one pipeline: ZADD key {notification_id: now_ms} · ZREMRANGEBYSCORE key -inf now_ms-WINDOW_MS · ZCARD key · EXPIRE key WINDOW_S
    # TODO: count > LIMIT → INCR dropped:{user_id}, return False
    raise NotImplementedError
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379)

LIMIT = 20  # notifications per user per hour
WINDOW_MS = 3_600_000
WINDOW_S = 3600


def allowed(user_id: str, notification_id: str) -> bool:
    """True when this notification fits the user's hourly budget; False → the worker skips delivery."""
    now_ms = int(time.time() * 1000)
    key = f"rl:{user_id}"
    pipe = r.pipeline(transaction=True)
    pipe.zadd(key, {notification_id: now_ms})
    pipe.zremrangebyscore(key, "-inf", now_ms - WINDOW_MS)
    pipe.zcard(key)
    pipe.expire(key, WINDOW_S)
    _, _, count, _ = pipe.execute()
    if count > LIMIT:
        r.incr(f"dropped:{user_id}")
        return False
    return True
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	limit    = 20 // notifications per user per hour
	windowMs = int64(3_600_000)
	window   = time.Hour
)

// allowed reports whether this notification fits the user's hourly budget; false → the worker skips delivery.
func allowed(ctx context.Context, userID, notificationID string) (bool, error) {
	nowMs := time.Now().UnixMilli()
	key := "rl:" + userID
	// TODO: one TxPipeline: ZAdd key {nowMs, notificationID} · ZRemRangeByScore key -inf nowMs-windowMs · ZCard key · Expire key window
	// TODO: count > limit → Incr dropped:{user}, return false
	_ = nowMs
	_ = key
	_ = strconv.FormatInt
	return true, errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	limit    = 20 // notifications per user per hour
	windowMs = int64(3_600_000)
	window   = time.Hour
)

// allowed reports whether this notification fits the user's hourly budget; false → the worker skips delivery.
func allowed(ctx context.Context, userID, notificationID string) (bool, error) {
	nowMs := time.Now().UnixMilli()
	key := "rl:" + userID
	pipe := rdb.TxPipeline()
	pipe.ZAdd(ctx, key, redis.Z{Score: float64(nowMs), Member: notificationID})
	pipe.ZRemRangeByScore(ctx, key, "-inf", strconv.FormatInt(nowMs-windowMs, 10))
	count := pipe.ZCard(ctx, key)
	pipe.Expire(ctx, key, window)
	if _, err := pipe.Exec(ctx); err != nil {
		return false, err
	}
	if count.Val() > limit {
		rdb.Incr(ctx, "dropped:"+userID)
		return false, nil
	}
	return true, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

object RateLimit {
  val jedis = new JedisPooled("redis", 6379)

  val Limit = 20 // notifications per user per hour
  val WindowMs = 3600000L
  val WindowSeconds = 3600L

  /** True when this notification fits the user's hourly budget; false → the worker skips delivery. */
  def allowed(userId: String, notificationId: String): Boolean = {
    val nowMs = System.currentTimeMillis()
    val key = s"rl:$userId"
    // TODO: one pipeline: zadd key nowMs notificationId · zremrangeByScore key "-inf" nowMs-WindowMs · zcard key · expire key WindowSeconds
    // TODO: count > Limit → incr dropped:{user}, false
    ???
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

object RateLimit {
  val jedis = new JedisPooled("redis", 6379)

  val Limit = 20 // notifications per user per hour
  val WindowMs = 3600000L
  val WindowSeconds = 3600L

  /** True when this notification fits the user's hourly budget; false → the worker skips delivery. */
  def allowed(userId: String, notificationId: String): Boolean = {
    val nowMs = System.currentTimeMillis()
    val key = s"rl:$userId"
    val pipe = jedis.pipelined()
    pipe.zadd(key, nowMs.toDouble, notificationId)
    pipe.zremrangeByScore(key, "-inf", (nowMs - WindowMs).toString)
    val count = pipe.zcard(key)
    pipe.expire(key, WindowSeconds)
    pipe.sync()
    if (count.get() > Limit) {
      jedis.incr(s"dropped:$userId")
      false
    } else true
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kLimit = 20;  // notifications per user per hour
constexpr long long kWindowMs = 3'600'000;
constexpr std::chrono::seconds kWindow{3600};

// True when this notification fits the user's hourly budget; false → the worker skips delivery.
bool allowed(const std::string& user_id, const std::string& notification_id) {
  const long long now_ms =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string key = "rl:" + user_id;
  // TODO: one transaction: zadd key notification_id now_ms · zremrangebyscore key (-inf, now_ms-kWindowMs] · zcard key · expire key kWindow
  // TODO: count > kLimit → incr dropped:{user}, return false
  return true;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kLimit = 20;  // notifications per user per hour
constexpr long long kWindowMs = 3'600'000;
constexpr std::chrono::seconds kWindow{3600};

// True when this notification fits the user's hourly budget; false → the worker skips delivery.
bool allowed(const std::string& user_id, const std::string& notification_id) {
  const long long now_ms =
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const std::string key = "rl:" + user_id;
  auto tx = redis.transaction();
  tx.zadd(key, notification_id, static_cast<double>(now_ms))
      .zremrangebyscore(key, sw::redis::RightBoundedInterval<double>(now_ms - kWindowMs, sw::redis::BoundType::CLOSED))
      .zcard(key)
      .expire(key, kWindow);
  auto replies = tx.exec();
  const long long count = replies.get<long long>(2);
  if (count > kLimit) {
    redis.incr("dropped:" + user_id);
    return false;
  }
  return true;
}
`,
    },
  },
  harness: {
    python: `import time

import redis


def _limiter(ctx):
    m = ctx.load("rate_limit")
    clients = [c for c in vars(m).values() if isinstance(c, redis.Redis)]
    assert clients, "the module must create a redis.Redis client"
    m.direct = []  # commands sent outside a pipeline
    m.pipelines = 0
    for client in clients:
        execute_command, pipeline = client.execute_command, client.pipeline

        def counted_execute(*args, _original=execute_command, **kwargs):
            m.direct.append(args[0] if args else None)
            return _original(*args, **kwargs)

        def counted_pipeline(*args, _original=pipeline, **kwargs):
            m.pipelines += 1
            return _original(*args, **kwargs)

        client.execute_command = counted_execute
        client.pipeline = counted_pipeline
    return m


def check_zset_key(ctx):
    m = _limiter(ctx)
    before = int(time.time() * 1000)
    assert m.allowed("u42", "n-1") is True, "the first notification of the hour must be allowed"
    after = int(time.time() * 1000)
    assert ctx.redis.type("rl:u42") == "zset", f"rl:u42 must be a sorted set, found {ctx.redis.type('rl:u42')!r}"
    score = ctx.redis.zscore("rl:u42", "n-1")
    assert score is not None, f"n-1 must be a member of rl:u42, members are {ctx.redis.zrange('rl:u42', 0, -1)}"
    assert before <= score <= after, f"n-1 is scored {score}, expected the current time in milliseconds (about {before})"
    m.allowed("u7", "n-2")
    assert ctx.redis.zcard("rl:u42") == 1 and ctx.redis.zcard("rl:u7") == 1, "each user has their own rl:{user} set"


def check_trim_window(ctx):
    m = _limiter(ctx)
    m.allowed("u42", "n-1")
    m.allowed("u42", "n-2")
    ctx.clock.advance(1800)
    m.allowed("u42", "n-3")
    assert ctx.redis.zcard("rl:u42") == 3, f"after 30 min all three events are still in the window, found {ctx.redis.zcard('rl:u42')}"
    ctx.clock.advance(1801)
    assert m.allowed("u42", "n-4") is True
    members = ctx.redis.zrange("rl:u42", 0, -1)
    assert members == ["n-3", "n-4"], f"events older than an hour must be trimmed: rl:u42 holds {members}, expected ['n-3', 'n-4']"


def check_pipeline(ctx):
    m = _limiter(ctx)
    assert m.allowed("u42", "n-1") is True
    ttl = ctx.redis.ttl("rl:u42")
    assert 3500 <= ttl <= 3600, f"rl:u42 must expire after 3600 s, TTL is {ttl}"
    assert m.pipelines >= 1, "the four commands must travel in one pipeline / MULTI"
    assert m.direct == [], f"an allowed check must cost one round trip; these commands were sent on their own: {m.direct}"
    ctx.clock.advance(3601)
    assert ctx.redis.exists("rl:u42") == 0, "an idle user's set must expire with the window"


def check_over_limit(ctx):
    m = _limiter(ctx)
    for i in range(20):
        assert m.allowed("u42", f"n-{i}") is True, f"notification {i + 1} of 20 must be allowed"
    assert ctx.redis.get("dropped:u42") is None, "nothing was dropped yet: dropped:u42 must not exist"
    assert m.allowed("u42", "n-20") is False, "the 21st notification of the hour must be dropped"
    assert ctx.redis.get("dropped:u42") == "1", f"dropped:u42 is {ctx.redis.get('dropped:u42')!r}, expected 1"
    assert m.allowed("u42", "n-21") is False
    assert ctx.redis.get("dropped:u42") == "2", f"dropped:u42 is {ctx.redis.get('dropped:u42')!r}, expected 2"
    assert m.allowed("u7", "n-22") is True, "another user's budget is untouched"
    ctx.clock.advance(3601)
    assert m.allowed("u42", "n-23") is True, "an hour later the user's budget is back"
`,
  },
  debrief: `A sorted set scored by time is a sliding window with no bookkeeping: add, trim, count, and the TTL cleans up after idle users. The four commands travel together so the check costs one round trip, and because the whole thing is per user it shards trivially. Real systems wrap the same four commands in a Lua script so the add-trim-count is atomic against concurrent workers, remove the member again when the decision is "drop" (so dropped pings do not eat the budget), and prefer a cheaper approximation — sliding log with coarse buckets, or a token bucket — once the limit is thousands per window instead of twenty.`,
};
