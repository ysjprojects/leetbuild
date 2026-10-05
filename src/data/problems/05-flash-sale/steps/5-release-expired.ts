import type {Step} from '@/lib/types';

const LUA_EXISTS_GONE = /redis\.call\(\s*['"]EXISTS['"]\s*,\s*KEYS\[2\]\s*\)\s*==\s*0/i;
const LUA_INCRBY = /redis\.call\(\s*['"]INCRBY['"]\s*,\s*KEYS\[1\]\s*,\s*ARGV\[1\]\s*\)/i;
const LUA_DEL = /redis\.call\(\s*['"]DEL['"]\s*,\s*KEYS\[2\]\s*\)/i;
const LUA_ZREM = /redis\.call\(\s*['"]ZREM['"]\s*,\s*KEYS\[3\]\s*,\s*ARGV\[2\]\s*\)/i;

export const releaseExpiredStep: Step = {
  id: 'release-expired',
  title: 'Sweep expired holds back into stock',
  concept: 'redis',
  file: 'hold_sweeper',
  focus: ['sweeper', 'redis'],
  task: `## Task

A hold that is never paid for must go back on sale. Implement the sweeper, one process that runs
every second, and the \`release(order_id)\` the API and the consumer call:

- \`ZRANGEBYSCORE holds -inf <now> LIMIT 0 100\`: at most 100 expired members per tick, so one burst of
  abandoned carts cannot stall the loop.
- For each member \`{order_id}:{sku}:{qty}\` run **one Lua script**: if \`hold:{order_id}\` no longer
  exists the order was confirmed or already released — only \`ZREM\` the member and return 0; otherwise
  \`INCRBY stock:{sku} qty\`, \`DEL hold:{order_id}\`, \`ZREM holds <member>\` and return 1. Atomic, so a
  sweeper that crashes half-way can never give the same units back twice. (\`release_hold(member)\` is
  provided: it splits the member and runs your script.)
- \`release(order_id)\` reads the member from \`hold:{order_id}\` and goes through the same script — the
  \`EXISTS\` guard makes it safe to race the sweeper.
- Loop: sweep a batch, sleep the interval, repeat.

:::widget cache-aside {}

> A TTL is the right tool when *forgetting* is the whole job (a cached thumbnail). A hold is different:
> its expiry has a side effect — stock goes back up — and Redis runs no code when a key dies. Hence the
> explicit expiry queue in a sorted set, with the key TTL as nothing more than a safety net.

:::widget delivery-semantics {}`,
  sequence: {
    participants: ['sweeper', 'Redis'],
    messages: [
      {from: 'sweeper', to: 'Redis', label: 'ZRANGEBYSCORE holds -inf 1727431200 LIMIT 0 100', kind: 'sync'},
      {from: 'Redis', to: 'sweeper', label: '[o7:shoe-42:2, o9:hat-1:1]', kind: 'reply'},
      {from: 'sweeper', to: 'Redis', label: 'EVALSHA release · stock:shoe-42 hold:o7 holds · 2 member', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'EXISTS hold:o7 → 1 · INCRBY 2 · DEL · ZREM', kind: 'sync'},
      {from: 'Redis', to: 'sweeper', label: '1', kind: 'reply'},
      {from: 'sweeper', to: 'Redis', label: 'EVALSHA release · hold:o9 (confirmed meanwhile)', kind: 'sync'},
      {from: 'Redis', to: 'sweeper', label: '0 (hold gone: ZREM only)', kind: 'reply'},
    ],
  },
  hints: [
    'The sorted set is a priority queue ordered by time: `ZRANGEBYSCORE` with `-inf` as the minimum and the current timestamp as the maximum returns everything that is due, and `LIMIT 0 100` bounds the slice.',
    'Inside the script, `EXISTS KEYS[2]` decides between two paths; both end with `ZREM` so a member never survives a sweep. Return 1 only when stock actually moved.',
    '`release(order_id)`: `GET hold:{order_id}`, and when it exists call `release_hold` with that value — the hold stores the exact member so you never rebuild it. The loop is `while true: sweep → sleep(interval)`.',
  ],
  checks: [
    {
      id: 'expired-batch',
      title: 'Reads at most 100 expired holds per tick',
      detail:
        '`ZRANGEBYSCORE holds -inf <now> LIMIT 0 100` inside a loop that sleeps the interval — the sweep is bounded per tick and never spins.',
      match: {
        python: {
          all: [
            /\br\.zrangebyscore\(\s*["']holds["']\s*,\s*["']-inf["']\s*,[\s\S]{0,120}?num\s*=\s*BATCH/,
            /time\.sleep\(\s*SWEEP_INTERVAL_S\s*\)/,
          ],
        },
        go: {
          all: [
            /rdb\.ZRangeByScore\(\s*ctx\s*,\s*"holds"\s*,/,
            /Min:\s*"-inf"/,
            /Count:\s*batch\b/,
            /time\.NewTicker\(\s*sweepInterval\s*\)|time\.Sleep\(\s*sweepInterval\s*\)/,
          ],
        },
        scala: {
          all: [
            /jedis\.zrangeByScore\(\s*"holds"\s*,\s*"-inf"\s*,[\s\S]{0,120}?,\s*0\s*,\s*Batch\s*\)/,
            /Thread\.sleep\(\s*SweepIntervalMillis\s*\)/,
          ],
        },
        cpp: {
          all: [
            /redis\.zrangebyscore\(\s*"holds"\s*,[\s\S]{0,200}?LimitOptions\{\s*0\s*,\s*kBatch\s*\}/,
            /sleep_for\(\s*kSweepInterval\s*\)/,
          ],
        },
      },
    },
    {
      id: 'atomic-release',
      title: 'Restores stock, deletes the hold and its index in one script',
      detail:
        '`INCRBY stock`, `DEL hold` and `ZREM holds` run inside one Lua script; done as three commands, a crash between them restores stock twice on the next tick.',
      match: {
        python: {all: [LUA_INCRBY, LUA_DEL, LUA_ZREM]},
        go: {all: [LUA_INCRBY, LUA_DEL, LUA_ZREM]},
        scala: {all: [LUA_INCRBY, LUA_DEL, LUA_ZREM]},
        cpp: {all: [LUA_INCRBY, LUA_DEL, LUA_ZREM]},
      },
    },
    {
      id: 'skip-fulfilled',
      title: 'Skips holds that are already gone',
      detail:
        'When `hold:{order_id}` no longer exists the order was confirmed (or released); the script must only `ZREM` the member and must not touch stock.',
      match: {
        python: {order: [LUA_EXISTS_GONE, LUA_ZREM, LUA_INCRBY]},
        go: {order: [LUA_EXISTS_GONE, LUA_ZREM, LUA_INCRBY]},
        scala: {order: [LUA_EXISTS_GONE, LUA_ZREM, LUA_INCRBY]},
        cpp: {order: [LUA_EXISTS_GONE, LUA_ZREM, LUA_INCRBY]},
      },
    },
    {
      id: 'release-by-order',
      title: 'release(order_id) goes through the same script',
      detail:
        '`release` reads the member stored in `hold:{order_id}` and calls `release_hold`, so an explicit release and a sweep can never both restore the units.',
      match: {
        python: {
          all: [
            /def release\((?:(?!\ndef )[\s\S])*?\br\.get\(\s*f["']hold:\{order_id\}["']\s*\)(?:(?!\ndef )[\s\S])*?release_hold\(/,
          ],
        },
        go: {
          all: [
            /func release\((?:(?!\n\})[\s\S])*?rdb\.Get\(\s*ctx\s*,\s*"hold:"\s*\+\s*orderID\s*\)(?:(?!\n\})[\s\S])*?releaseHold\(/,
          ],
        },
        scala: {
          all: [
            /def release\((?:(?!\n {2}def )[\s\S])*?jedis\.get\(\s*s"hold:\$orderId"\s*\)(?:(?!\n {2}def )[\s\S])*?releaseHold\b/,
          ],
        },
        cpp: {
          all: [
            /void release\((?:(?!\n\})[\s\S])*?redis\.get\(\s*"hold:"\s*\+\s*order_id\s*\)(?:(?!\n\})[\s\S])*?release_hold\(/,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

r = redis.Redis(host="redis", port=6379)

BATCH = 100
SWEEP_INTERVAL_S = 1.0

# KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
# ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"
RELEASE_LUA = """
return 0
"""

release_script = r.register_script(RELEASE_LUA)


def release_hold(member: str) -> bool:
    """Gives one hold back to stock; False when the hold was already gone (confirmed or released)."""
    order_id, sku, qty = member.split(":", 2)
    return release_script(keys=[f"stock:{sku}", f"hold:{order_id}", "holds"], args=[qty, member]) == 1


def release(order_id: str) -> None:
    """Explicit release by the API (503 path) and the fulfilment consumer (no physical stock)."""
    # TODO: GET hold:{order_id}; when it exists, release_hold(member)
    raise NotImplementedError


def sweep() -> None:
    # TODO: every SWEEP_INTERVAL_S: ZRANGEBYSCORE holds -inf now LIMIT 0 BATCH, release_hold each member
    # TODO: the script: EXISTS hold == 0 → ZREM, 0; else INCRBY stock, DEL hold, ZREM, 1
    raise NotImplementedError
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379)

BATCH = 100
SWEEP_INTERVAL_S = 1.0

# KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
# ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"
RELEASE_LUA = """
if redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('ZREM', KEYS[3], ARGV[2])
  return 0
end
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[3], ARGV[2])
return 1
"""

release_script = r.register_script(RELEASE_LUA)


def release_hold(member: str) -> bool:
    """Gives one hold back to stock; False when the hold was already gone (confirmed or released)."""
    order_id, sku, qty = member.split(":", 2)
    return release_script(keys=[f"stock:{sku}", f"hold:{order_id}", "holds"], args=[qty, member]) == 1


def release(order_id: str) -> None:
    """Explicit release by the API (503 path) and the fulfilment consumer (no physical stock)."""
    member = r.get(f"hold:{order_id}")
    if member is not None:
        release_hold(member.decode())


def sweep() -> None:
    while True:
        now = int(time.time())
        expired = r.zrangebyscore("holds", "-inf", now, start=0, num=BATCH)
        for member in expired:
            release_hold(member.decode())
        time.sleep(SWEEP_INTERVAL_S)
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	batch         = 100
	sweepInterval = time.Second
)

// KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
// ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"
const releaseLua = \`
return 0
\`

var releaseScript = redis.NewScript(releaseLua)

// releaseHold gives one hold back to stock; false when the hold was already gone (confirmed or released).
func releaseHold(ctx context.Context, member string) (bool, error) {
	parts := strings.SplitN(member, ":", 3)
	if len(parts) != 3 {
		return false, fmt.Errorf("malformed hold member %q", member)
	}
	keys := []string{"stock:" + parts[1], "hold:" + parts[0], "holds"}
	n, err := releaseScript.Run(ctx, rdb, keys, parts[2], member).Int()
	return n == 1, err
}

// release is the explicit release by the API (503 path) and the fulfilment consumer (no physical stock).
func release(ctx context.Context, orderID string) error {
	// TODO: Get hold:{order_id}; redis.Nil → nothing to do; otherwise releaseHold(member)
	return errors.New("not implemented")
}

func sweep(ctx context.Context) error {
	// TODO: every sweepInterval: ZRangeByScore holds -inf now LIMIT 0 batch, releaseHold each member
	// TODO: the script: EXISTS hold == 0 → ZREM, 0; else INCRBY stock, DEL hold, ZREM, 1
	_ = strconv.FormatInt
	return errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	batch         = 100
	sweepInterval = time.Second
)

// KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
// ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"
const releaseLua = \`
if redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('ZREM', KEYS[3], ARGV[2])
  return 0
end
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[3], ARGV[2])
return 1
\`

var releaseScript = redis.NewScript(releaseLua)

// releaseHold gives one hold back to stock; false when the hold was already gone (confirmed or released).
func releaseHold(ctx context.Context, member string) (bool, error) {
	parts := strings.SplitN(member, ":", 3)
	if len(parts) != 3 {
		return false, fmt.Errorf("malformed hold member %q", member)
	}
	keys := []string{"stock:" + parts[1], "hold:" + parts[0], "holds"}
	n, err := releaseScript.Run(ctx, rdb, keys, parts[2], member).Int()
	return n == 1, err
}

// release is the explicit release by the API (503 path) and the fulfilment consumer (no physical stock).
func release(ctx context.Context, orderID string) error {
	member, err := rdb.Get(ctx, "hold:"+orderID).Result()
	if errors.Is(err, redis.Nil) {
		return nil // already confirmed or swept
	}
	if err != nil {
		return err
	}
	_, err = releaseHold(ctx, member)
	return err
}

func sweep(ctx context.Context) error {
	ticker := time.NewTicker(sweepInterval)
	defer ticker.Stop()
	for {
		now := strconv.FormatInt(time.Now().Unix(), 10)
		expired, err := rdb.ZRangeByScore(ctx, "holds", &redis.ZRangeBy{Min: "-inf", Max: now, Offset: 0, Count: batch}).Result()
		if err != nil {
			return err
		}
		for _, member := range expired {
			if _, err := releaseHold(ctx, member); err != nil {
				return err
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._

object HoldSweeper {
  val jedis = new JedisPooled("redis", 6379)
  val Batch = 100
  val SweepIntervalMillis = 1000L

  // KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
  // ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"
  val ReleaseLua: String =
    """
      |return 0
      |""".stripMargin

  private val releaseSha: String = jedis.scriptLoad(ReleaseLua)

  /** Gives one hold back to stock; false when the hold was already gone (confirmed or released). */
  def releaseHold(member: String): Boolean = {
    val Array(orderId, sku, qty) = member.split(":", 3)
    val keys = List(s"stock:$sku", s"hold:$orderId", "holds").asJava
    jedis.evalsha(releaseSha, keys, List(qty, member).asJava).asInstanceOf[Long] == 1L
  }

  /** Explicit release by the API (503 path) and the fulfilment consumer (no physical stock). */
  def release(orderId: String): Unit = {
    // TODO: get hold:{order_id}; when it exists, releaseHold(member)
  }

  def sweep(): Unit = {
    // TODO: every SweepIntervalMillis: zrangeByScore holds -inf now LIMIT 0 Batch, releaseHold each member
    // TODO: the script: EXISTS hold == 0 → ZREM, 0; else INCRBY stock, DEL hold, ZREM, 1
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import scala.jdk.CollectionConverters._

object HoldSweeper {
  val jedis = new JedisPooled("redis", 6379)
  val Batch = 100
  val SweepIntervalMillis = 1000L

  // KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
  // ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"
  val ReleaseLua: String =
    """
      |if redis.call('EXISTS', KEYS[2]) == 0 then
      |  redis.call('ZREM', KEYS[3], ARGV[2])
      |  return 0
      |end
      |redis.call('INCRBY', KEYS[1], ARGV[1])
      |redis.call('DEL', KEYS[2])
      |redis.call('ZREM', KEYS[3], ARGV[2])
      |return 1
      |""".stripMargin

  private val releaseSha: String = jedis.scriptLoad(ReleaseLua)

  /** Gives one hold back to stock; false when the hold was already gone (confirmed or released). */
  def releaseHold(member: String): Boolean = {
    val Array(orderId, sku, qty) = member.split(":", 3)
    val keys = List(s"stock:$sku", s"hold:$orderId", "holds").asJava
    jedis.evalsha(releaseSha, keys, List(qty, member).asJava).asInstanceOf[Long] == 1L
  }

  /** Explicit release by the API (503 path) and the fulfilment consumer (no physical stock). */
  def release(orderId: String): Unit =
    Option(jedis.get(s"hold:$orderId")).foreach(releaseHold)

  def sweep(): Unit =
    while (true) {
      val now = (System.currentTimeMillis() / 1000).toString
      val expired = jedis.zrangeByScore("holds", "-inf", now, 0, Batch)
      expired.asScala.foreach(releaseHold)
      Thread.sleep(SweepIntervalMillis)
    }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <string>
#include <thread>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kBatch = 100;
constexpr std::chrono::seconds kSweepInterval{1};

// KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
// ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"
const std::string kReleaseLua = R"lua(
return 0
)lua";

const std::string release_sha = redis.script_load(kReleaseLua);

// Gives one hold back to stock; false when the hold was already gone (confirmed or released).
bool release_hold(const std::string& member) {
  const auto first = member.find(':'), second = member.find(':', first + 1);
  const std::string order_id = member.substr(0, first), sku = member.substr(first + 1, second - first - 1);
  const std::vector<std::string> keys{"stock:" + sku, "hold:" + order_id, "holds"};
  const std::vector<std::string> args{member.substr(second + 1), member};
  return redis.evalsha<long long>(release_sha, keys.begin(), keys.end(), args.begin(), args.end()) == 1;
}

// Explicit release by the API (503 path) and the fulfilment consumer (no physical stock).
void release(const std::string& order_id) {
  // TODO: get hold:{order_id}; when it exists, release_hold(*member)
}

void sweep() {
  // TODO: every kSweepInterval: zrangebyscore holds (-inf, now] LimitOptions{0, kBatch}, release_hold each member
  // TODO: the script: EXISTS hold == 0 → ZREM, 0; else INCRBY stock, DEL hold, ZREM, 1
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <string>
#include <thread>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kBatch = 100;
constexpr std::chrono::seconds kSweepInterval{1};

// KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
// ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"
const std::string kReleaseLua = R"lua(
if redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('ZREM', KEYS[3], ARGV[2])
  return 0
end
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[3], ARGV[2])
return 1
)lua";

const std::string release_sha = redis.script_load(kReleaseLua);

// Gives one hold back to stock; false when the hold was already gone (confirmed or released).
bool release_hold(const std::string& member) {
  const auto first = member.find(':'), second = member.find(':', first + 1);
  const std::string order_id = member.substr(0, first), sku = member.substr(first + 1, second - first - 1);
  const std::vector<std::string> keys{"stock:" + sku, "hold:" + order_id, "holds"};
  const std::vector<std::string> args{member.substr(second + 1), member};
  return redis.evalsha<long long>(release_sha, keys.begin(), keys.end(), args.begin(), args.end()) == 1;
}

// Explicit release by the API (503 path) and the fulfilment consumer (no physical stock).
void release(const std::string& order_id) {
  if (const auto member = redis.get("hold:" + order_id)) release_hold(*member);
}

void sweep() {
  while (true) {
    const auto epoch = std::chrono::system_clock::now().time_since_epoch();
    const double now = std::chrono::duration_cast<std::chrono::seconds>(epoch).count();
    std::vector<std::string> expired;
    redis.zrangebyscore("holds", sw::redis::RightBoundedInterval<double>(now, sw::redis::BoundType::LEFT_OPEN),
                        sw::redis::LimitOptions{0, kBatch}, std::back_inserter(expired));
    for (const auto& member : expired) release_hold(member);
    std::this_thread::sleep_for(kSweepInterval);
  }
}
`,
    },
  },
  debrief: `The sorted set is a priority queue keyed by time, and \`ZRANGEBYSCORE … LIMIT\` is the classic way to drain one in bounded slices. The \`EXISTS\` guard inside the script is what makes the sweeper, the API's 503 path and the consumer's no-stock path safe to run concurrently and to repeat: a hold is released at most once no matter who gets there first. Real systems run the sweeper on an elected leader (or shard the sorted set by SKU prefix), treat keyspace notifications only as a hint, and reconcile the Redis counter against the warehouse ledger after the drop — the oversell that any cache-fronted counter eventually produces is caught by accounting, not by more Lua.`,
};
