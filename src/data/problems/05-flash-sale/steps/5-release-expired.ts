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
        typescript: {
          all: [
            /\bredis\.zrangebyscore\(\s*['"]holds['"]\s*,\s*['"]-inf['"]\s*,[\s\S]{0,120}?['"]LIMIT['"]\s*,\s*0\s*,\s*BATCH/,
            /await sleep\(\s*SWEEP_INTERVAL_MS\s*\)|setTimeout\([^\n]*SWEEP_INTERVAL_MS/,
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
        typescript: {all: [LUA_INCRBY, LUA_DEL, LUA_ZREM]},
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
        typescript: {order: [LUA_EXISTS_GONE, LUA_ZREM, LUA_INCRBY]},
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
        typescript: {
          all: [
            /async function release\((?:(?!\n\})[\s\S])*?\bredis\.get\(\s*`hold:\$\{orderId\}`\s*\)(?:(?!\n\})[\s\S])*?releaseHold\(/,
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
    typescript: {
      starter: `import {setTimeout as sleep} from 'node:timers/promises';

import Redis from 'ioredis';

export const BATCH = 100;
export const SWEEP_INTERVAL_MS = 1000;

// KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
// ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"
const RELEASE_LUA = \`
return 0
\`;

/** The client with the release script registered as a command. */
interface ReleasingRedis extends Redis {
  release(stockKey: string, holdKey: string, holdsKey: string, qty: string, member: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ReleasingRedis;
redis.defineCommand('release', {numberOfKeys: 3, lua: RELEASE_LUA});

/** Gives one hold back to stock; false when the hold was already gone (confirmed or released). */
export async function releaseHold(member: string): Promise<boolean> {
  const [orderId, sku, qty] = member.split(':');
  const result = await redis.release(\`stock:\${sku}\`, \`hold:\${orderId}\`, 'holds', qty, member);
  return result === 1;
}

/** Explicit release by the API (503 path) and the fulfilment consumer (no physical stock). */
export async function release(orderId: string): Promise<void> {
  // TODO: GET hold:{orderId}; when it exists, releaseHold(member)
  throw new Error('not implemented');
}

export async function sweep(): Promise<void> {
  // TODO: every SWEEP_INTERVAL_MS: ZRANGEBYSCORE holds -inf now LIMIT 0 BATCH, releaseHold each member
  // TODO: the script: EXISTS hold == 0 → ZREM, 0; else INCRBY stock, DEL hold, ZREM, 1
  throw new Error('not implemented');
}
`,
      solution: `import {setTimeout as sleep} from 'node:timers/promises';

import Redis from 'ioredis';

export const BATCH = 100;
export const SWEEP_INTERVAL_MS = 1000;

// KEYS[1] = stock:{sku}   KEYS[2] = hold:{order_id}   KEYS[3] = holds
// ARGV[1] = qty   ARGV[2] = member "{order_id}:{sku}:{qty}"
const RELEASE_LUA = \`
if redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('ZREM', KEYS[3], ARGV[2])
  return 0
end
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[3], ARGV[2])
return 1
\`;

/** The client with the release script registered as a command. */
interface ReleasingRedis extends Redis {
  release(stockKey: string, holdKey: string, holdsKey: string, qty: string, member: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ReleasingRedis;
redis.defineCommand('release', {numberOfKeys: 3, lua: RELEASE_LUA});

/** Gives one hold back to stock; false when the hold was already gone (confirmed or released). */
export async function releaseHold(member: string): Promise<boolean> {
  const [orderId, sku, qty] = member.split(':');
  const result = await redis.release(\`stock:\${sku}\`, \`hold:\${orderId}\`, 'holds', qty, member);
  return result === 1;
}

/** Explicit release by the API (503 path) and the fulfilment consumer (no physical stock). */
export async function release(orderId: string): Promise<void> {
  const member = await redis.get(\`hold:\${orderId}\`);
  if (member !== null) await releaseHold(member);
}

export async function sweep(): Promise<void> {
  for (;;) {
    const now = Math.floor(Date.now() / 1000);
    const expired = await redis.zrangebyscore('holds', '-inf', now, 'LIMIT', 0, BATCH);
    for (const member of expired) await releaseHold(member);
    await sleep(SWEEP_INTERVAL_MS);
  }
}
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
  harness: {
    python: `import time

SKU = "shoe-42"
STOCK = "stock:shoe-42"


def _hold(ctx, order_id, qty=2, expires_in=600, sku=SKU):
    member = f"{order_id}:{sku}:{qty}"
    ctx.redis.set(f"hold:{order_id}", member, ex=2 * 600)
    ctx.redis.zadd("holds", {member: int(time.time()) + expires_in})
    return member


def check_expired_batch(ctx):
    ctx.redis.set(STOCK, 0)
    expired = {_hold(ctx, f"e{i}", qty=1, expires_in=-10) for i in range(150)}
    future = _hold(ctx, "later", expires_in=600)
    m = ctx.load("hold_sweeper")
    seen = []

    def release_hold(member):
        seen.append((ctx.clock.sleeps, member))
        ctx.redis.zrem("holds", member)
        return True

    m.release_hold = release_hold
    ctx.clock.sleep_limit = 1
    ctx.drain(m.sweep)
    assert seen, "sweep() released nothing: 150 holds are past their expiry"
    first_tick = [member for tick, member in seen if tick == 0]
    assert len(first_tick) <= 100, f"the first tick released {len(first_tick)} holds; at most BATCH = 100 per tick"
    assert len(first_tick) == 100, f"the first tick released {len(first_tick)} holds, expected the full batch of 100"
    assert ctx.clock.sleeps == 2, f"the loop slept {ctx.clock.sleeps} times across two ticks, expected one sleep per tick"
    assert 0.9 <= ctx.clock.offset <= 1.1, f"the loop slept {ctx.clock.offset:.2f} s between ticks, expected SWEEP_INTERVAL_S = 1 s"
    members = [member for _, member in seen]
    assert future not in members, "a hold that expires in 600 s must not be released: only members with a score up to now"
    assert set(members) == expired, f"after two ticks {len(set(members))} distinct expired holds were released, expected all 150"
    assert len(members) == 150, f"release_hold was called {len(members)} times for 150 expired holds: a released member must not be read again"


def check_atomic_release(ctx):
    ctx.redis.set(STOCK, 3)
    member = _hold(ctx, "o1", qty=2, expires_in=-5)
    m = ctx.load("hold_sweeper")
    assert m.release_hold(member) is True, "releasing an existing hold must return True"
    assert ctx.redis.get(STOCK) == "5", f"stock is {ctx.redis.get(STOCK)!r} after releasing a hold of 2 on 3, expected 5"
    assert ctx.redis.exists("hold:o1") == 0, "hold:o1 must be deleted by the release"
    assert ctx.redis.zscore("holds", member) is None, "the member must be removed from holds by the release"
    assert m.release_hold(member) is False, "releasing the same hold again must return False"
    assert ctx.redis.get(STOCK) == "5", f"stock is {ctx.redis.get(STOCK)!r} after a second release, expected still 5: units go back exactly once"

    ctx.redis.set(STOCK, 0)
    a = _hold(ctx, "a", qty=2, expires_in=600)
    b = _hold(ctx, "b", qty=3, expires_in=600)
    c = _hold(ctx, "c", qty=1, expires_in=1800)
    ctx.clock.advance(601)
    ctx.clock.sleep_limit = 0
    ctx.drain(m.sweep)
    assert ctx.redis.get(STOCK) == "5", f"stock is {ctx.redis.get(STOCK)!r} after sweeping two expired holds of 2 and 3, expected 5"
    assert ctx.redis.exists("hold:a", "hold:b") == 0, "the sweeper must delete the expired hold keys"
    assert ctx.redis.zrange("holds", 0, -1) == [c], f"holds is {ctx.redis.zrange('holds', 0, -1)}, expected only the unexpired member {c}"
    assert ctx.redis.get("hold:c") == c, "an unexpired hold must be left alone"


def check_skip_fulfilled(ctx):
    ctx.redis.set(STOCK, 3)
    member = "o1:shoe-42:2"
    ctx.redis.zadd("holds", {member: int(time.time()) - 5})
    m = ctx.load("hold_sweeper")
    assert m.release_hold(member) is False, "a member whose hold:o1 is gone (confirmed) must return False"
    assert ctx.redis.get(STOCK) == "3", f"stock is {ctx.redis.get(STOCK)!r}: a confirmed order's units were given back, they were sold"
    assert ctx.redis.zscore("holds", member) is None, "the stale member must be ZREMed so the sweeper never reads it again"

    ctx.redis.zadd("holds", {"o2:shoe-42:1": int(time.time()) - 5})
    ctx.clock.sleep_limit = 0
    ctx.drain(m.sweep)
    assert ctx.redis.get(STOCK) == "3", "sweeping a confirmed order must not touch stock"
    assert ctx.redis.zcard("holds") == 0, "the sweeper must drop the stale member from holds"


def check_release_by_order(ctx):
    ctx.redis.set(STOCK, 3)
    member = _hold(ctx, "o1", qty=2, expires_in=600)
    m = ctx.load("hold_sweeper")
    original = m.release_hold
    released = []

    def release_hold(value):
        released.append(value)
        return original(value)

    m.release_hold = release_hold
    m.release("o1")
    assert released == [member], f"release(o1) must pass the stored member {member!r} to release_hold; calls: {released}"
    assert ctx.redis.get(STOCK) == "5", f"stock is {ctx.redis.get(STOCK)!r} after release(o1), expected 5"
    assert ctx.redis.exists("hold:o1") == 0, "hold:o1 must be gone after release(o1)"
    assert ctx.redis.zscore("holds", member) is None, "the member must leave holds after release(o1)"
    m.release("o1")
    assert ctx.redis.get(STOCK) == "5", "a second release(o1) must not give the units back again"
    m.release("never-reserved")
    assert ctx.redis.get(STOCK) == "5", "release of an unknown order must do nothing"
`,
    typescript: `const SKU = 'shoe-42';
const STOCK = 'stock:shoe-42';

/** A hold as step 1 writes it: the key with its safety-net TTL and the expiry-queue member. */
function hold(ctx, orderId: string, qty = 2, expiresIn = 600, sku = SKU) {
  const member = \`\${orderId}:\${sku}:\${qty}\`;
  ctx.redis.set(\`hold:\${orderId}\`, member, 'EX', 2 * 600);
  ctx.redis.zadd('holds', Math.floor(ctx.clock.now() / 1000) + expiresIn, member);
  return member;
}

export async function check_expired_batch(ctx) {
  ctx.redis.set(STOCK, 0);
  const expired = new Set<string>();
  for (let i = 0; i < 150; i++) expired.add(hold(ctx, \`e\${i}\`, 1, -10));
  const future = hold(ctx, 'later', 2, 600);
  const m = ctx.load('hold_sweeper');
  // Each hold key is touched once, by the release that gives it back: note the tick it happened on.
  const seen: {tick: number; at: number; member: string}[] = [];
  for (const member of expired) {
    const orderId = member.split(':')[0];
    ctx.redisAfter(\`hold:\${orderId}\`, () => seen.push({tick: ctx.clock.sleeps, at: ctx.clock.now(), member}));
  }
  await ctx.drain(m.sweep());
  assert(seen.length > 0, 'sweep() released nothing: 150 holds are past their expiry');
  const firstTick = seen.filter(s => s.tick === 0);
  assert(firstTick.length <= 100, \`the first tick released \${firstTick.length} holds; at most BATCH = 100 per tick\`);
  assert.equal(firstTick.length, 100, \`the first tick released \${firstTick.length} holds, expected the full batch of 100\`);
  const secondTick = seen.filter(s => s.tick === 1);
  assert.equal(secondTick.length, 50, \`the second tick released \${secondTick.length} holds, expected the remaining 50\`);
  const gap = secondTick[0].at - firstTick[0].at;
  assert(900 <= gap && gap <= 1200, \`the loop slept \${gap} ms between ticks, expected SWEEP_INTERVAL_MS = 1000\`);
  assert.equal(ctx.redis.get('hold:later'), future, 'a hold that expires in 600 s must not be released: only members with a score up to now');
  assert.notEqual(ctx.redis.zscore('holds', future), null, 'the unexpired member must stay in holds');
  const members = new Set(seen.map(s => s.member));
  assert.equal(members.size, 150, \`after the sweep \${members.size} distinct expired holds were released, expected all 150\`);
  assert.equal(ctx.redis.get(STOCK), '150', \`stock is \${JSON.stringify(ctx.redis.get(STOCK))} after releasing 150 holds of 1 on 0, expected 150: each hold goes back exactly once\`);
}

export async function check_atomic_release(ctx) {
  ctx.redis.set(STOCK, 3);
  const member = hold(ctx, 'o1', 2, -5);
  const m = ctx.load('hold_sweeper');
  assert.equal(await m.releaseHold(member), true, 'releasing an existing hold must return true');
  assert.equal(ctx.redis.get(STOCK), '5', \`stock is \${JSON.stringify(ctx.redis.get(STOCK))} after releasing a hold of 2 on 3, expected 5\`);
  assert.equal(ctx.redis.exists('hold:o1'), 0, 'hold:o1 must be deleted by the release');
  assert.equal(ctx.redis.zscore('holds', member), null, 'the member must be removed from holds by the release');
  assert.equal(await m.releaseHold(member), false, 'releasing the same hold again must return false');
  assert.equal(ctx.redis.get(STOCK), '5', \`stock is \${JSON.stringify(ctx.redis.get(STOCK))} after a second release, expected still 5: units go back exactly once\`);

  ctx.redis.set(STOCK, 0);
  hold(ctx, 'a', 2, 600);
  hold(ctx, 'b', 3, 600);
  const c = hold(ctx, 'c', 1, 1800);
  ctx.clock.advance(601);
  await ctx.drain(m.sweep());
  assert.equal(ctx.redis.get(STOCK), '5', \`stock is \${JSON.stringify(ctx.redis.get(STOCK))} after sweeping two expired holds of 2 and 3, expected 5\`);
  assert.equal(ctx.redis.exists('hold:a', 'hold:b'), 0, 'the sweeper must delete the expired hold keys');
  assert.deepEqual(ctx.redis.zrange('holds', 0, -1), [c], \`holds is \${JSON.stringify(ctx.redis.zrange('holds', 0, -1))}, expected only the unexpired member \${c}\`);
  assert.equal(ctx.redis.get('hold:c'), c, 'an unexpired hold must be left alone');
}

export async function check_skip_fulfilled(ctx) {
  ctx.redis.set(STOCK, 3);
  const member = 'o1:shoe-42:2';
  ctx.redis.zadd('holds', Math.floor(ctx.clock.now() / 1000) - 5, member);
  const m = ctx.load('hold_sweeper');
  assert.equal(await m.releaseHold(member), false, 'a member whose hold:o1 is gone (confirmed) must return false');
  assert.equal(ctx.redis.get(STOCK), '3', \`stock is \${JSON.stringify(ctx.redis.get(STOCK))}: a confirmed order's units were given back, they were sold\`);
  assert.equal(ctx.redis.zscore('holds', member), null, 'the stale member must be ZREMed so the sweeper never reads it again');

  ctx.redis.zadd('holds', Math.floor(ctx.clock.now() / 1000) - 5, 'o2:shoe-42:1');
  await ctx.drain(m.sweep());
  assert.equal(ctx.redis.get(STOCK), '3', 'sweeping a confirmed order must not touch stock');
  assert.equal(ctx.redis.zcard('holds'), 0, 'the sweeper must drop the stale member from holds');
}

export async function check_release_by_order(ctx) {
  ctx.redis.set(STOCK, 3);
  const member = hold(ctx, 'o1', 2, 600);
  const m = ctx.load('hold_sweeper');
  await m.release('o1');
  assert.equal(ctx.redis.get(STOCK), '5', \`stock is \${JSON.stringify(ctx.redis.get(STOCK))} after release(o1), expected 5\`);
  assert.equal(ctx.redis.exists('hold:o1'), 0, 'hold:o1 must be gone after release(o1)');
  assert.equal(ctx.redis.zscore('holds', member), null, 'the member must leave holds after release(o1)');
  await m.release('o1');
  assert.equal(ctx.redis.get(STOCK), '5', 'a second release(o1) must not give the units back again');
  await m.release('never-reserved');
  assert.equal(ctx.redis.get(STOCK), '5', 'release of an unknown order must do nothing');

  // The sweeper gets there first: right after release(o2) has read the member, the hold is swept.
  const racing = hold(ctx, 'o2', 2, -5);
  ctx.redisAfter('hold:o2', () => {
    ctx.redis.incrby(STOCK, 2);
    ctx.redis.del('hold:o2');
    ctx.redis.zrem('holds', racing);
  });
  await m.release('o2');
  assert.equal(ctx.redis.get(STOCK), '7', \`stock is \${JSON.stringify(ctx.redis.get(STOCK))} after release(o2) raced the sweeper, expected 7: the units went back twice — release must go through the same EXISTS-guarded script\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"strings"

	"leetbuild/harness"
)

const shoeStockKey = "stock:shoe-42"

// placeHold writes a hold of shoe-42 as step 1 does: the key with its safety-net TTL and the
// expiry-queue member, due expiresIn seconds from now.
func placeHold(ctx *harness.Ctx, orderID string, qty int, expiresIn int64) string {
	member := fmt.Sprintf("%s:shoe-42:%d", orderID, qty)
	ctx.Redis.Set("hold:"+orderID, member, "EX", 2*600)
	ctx.Redis.Do("ZADD", "holds", ctx.Clock.Now()/1000+expiresIn, member)
	return member
}

// stringAt is the string at key, nil when it does not exist.
func stringAt(ctx *harness.Ctx, key string) any {
	if v, ok := ctx.Redis.Get(key); ok {
		return v
	}
	return nil
}

// sweepDue runs the sweeper until the world settles (it loops forever).
func sweepDue(ctx *harness.Ctx) { ctx.Drain(func() { sweep(context.Background()) }) }

// sighting is a release touching a hold key, and the virtual time it happened at.
type sighting struct {
	at     int64
	member string
}

func CheckExpiredBatch(ctx *harness.Ctx) {
	ctx.Redis.Set(shoeStockKey, 0)
	var expired []string
	for i := range 150 {
		expired = append(expired, placeHold(ctx, fmt.Sprintf("e%d", i), 1, -10))
	}
	future := placeHold(ctx, "later", 2, 600)
	// Each hold key is touched once, by the release that gives it back: note when it happened.
	var seen []sighting
	for _, member := range expired {
		orderID := strings.Split(member, ":")[0]
		ctx.Redis.After("hold:"+orderID, func() any {
			seen = append(seen, sighting{at: ctx.Clock.Now(), member: member})
			return nil
		})
	}
	// The sweeper runs in the background while the check moves time on in 100 ms steps: a loop that
	// sleeps and one that waits on a ticker progress alike, and each tick happens at one instant.
	go sweep(context.Background())
	ctx.Tick()
	for range 30 {
		ctx.Clock.Advance(0.1)
		ctx.Tick()
	}
	ctx.Assert(len(seen) > 0, "sweep released nothing: 150 holds are past their expiry")
	var ticks []int64
	for _, s := range seen {
		if len(ticks) == 0 || ticks[len(ticks)-1] != s.at {
			ticks = append(ticks, s.at)
		}
	}
	var firstTick, secondTick []sighting
	for _, s := range seen {
		switch {
		case s.at == ticks[0]:
			firstTick = append(firstTick, s)
		case len(ticks) > 1 && s.at == ticks[1]:
			secondTick = append(secondTick, s)
		}
	}
	ctx.Assert(len(firstTick) <= 100, "the first tick released %d holds; at most batch = 100 per tick", len(firstTick))
	ctx.Equal(len(firstTick), 100, "holds released by the first tick (the full batch)")
	ctx.Equal(len(secondTick), 50, "holds released by the second tick (the remaining 50)")
	gap := secondTick[0].at - firstTick[0].at
	ctx.Assert(900 <= gap && gap <= 1200, "the loop slept %d ms between ticks, expected sweepInterval = 1000", gap)
	ctx.Equal(stringAt(ctx, "hold:later"), future, "a hold that expires in 600 s must not be released: only members with a score up to now")
	_, ok := ctx.Redis.ZScore("holds", future)
	ctx.Assert(ok, "the unexpired member must stay in holds")
	members := map[string]bool{}
	for _, s := range seen {
		members[s.member] = true
	}
	ctx.Equal(len(members), 150, "distinct expired holds released by the sweep")
	ctx.Equal(stringAt(ctx, shoeStockKey), "150", "stock after releasing 150 holds of 1 on 0: each hold goes back exactly once")
}

func CheckAtomicRelease(ctx *harness.Ctx) {
	bg := context.Background()
	ctx.Redis.Set(shoeStockKey, 3)
	member := placeHold(ctx, "o1", 2, -5)
	ok, err := releaseHold(bg, member)
	ctx.NoError(err, "releaseHold(%q) returned an error", member)
	ctx.Equal(ok, true, "releasing an existing hold must return true")
	ctx.Equal(stringAt(ctx, shoeStockKey), "5", "stock after releasing a hold of 2 on 3")
	ctx.Equal(ctx.Redis.Exists("hold:o1"), 0, "hold:o1 must be deleted by the release")
	_, indexed := ctx.Redis.ZScore("holds", member)
	ctx.Assert(!indexed, "the member must be removed from holds by the release")
	ok, err = releaseHold(bg, member)
	ctx.NoError(err, "releaseHold(%q) returned an error", member)
	ctx.Equal(ok, false, "releasing the same hold again must return false")
	ctx.Equal(stringAt(ctx, shoeStockKey), "5", "stock after a second release (units go back exactly once)")

	ctx.Redis.Set(shoeStockKey, 0)
	placeHold(ctx, "a", 2, 600)
	placeHold(ctx, "b", 3, 600)
	c := placeHold(ctx, "c", 1, 1800)
	ctx.Clock.Advance(601)
	sweepDue(ctx)
	ctx.Equal(stringAt(ctx, shoeStockKey), "5", "stock after sweeping two expired holds of 2 and 3")
	ctx.Equal(ctx.Redis.Exists("hold:a", "hold:b"), 0, "the sweeper must delete the expired hold keys")
	var left []string
	for _, z := range ctx.Redis.ZRangeWithScores("holds", 0, -1) {
		left = append(left, z.Member)
	}
	ctx.Equal(left, []string{c}, "holds must keep only the unexpired member")
	ctx.Equal(stringAt(ctx, "hold:c"), c, "an unexpired hold must be left alone")
}

func CheckSkipFulfilled(ctx *harness.Ctx) {
	ctx.Redis.Set(shoeStockKey, 3)
	member := "o1:shoe-42:2"
	ctx.Redis.Do("ZADD", "holds", ctx.Clock.Now()/1000-5, member)
	ok, err := releaseHold(context.Background(), member)
	ctx.NoError(err, "releaseHold(%q) returned an error", member)
	ctx.Equal(ok, false, "a member whose hold:o1 is gone (confirmed) must return false")
	ctx.Equal(stringAt(ctx, shoeStockKey), "3", "a confirmed order's units were sold, not given back: stock")
	_, indexed := ctx.Redis.ZScore("holds", member)
	ctx.Assert(!indexed, "the stale member must be ZREMed so the sweeper never reads it again")

	ctx.Redis.Do("ZADD", "holds", ctx.Clock.Now()/1000-5, "o2:shoe-42:1")
	sweepDue(ctx)
	ctx.Equal(stringAt(ctx, shoeStockKey), "3", "sweeping a confirmed order must not touch stock")
	ctx.Equal(ctx.Redis.ZCard("holds"), 0, "the sweeper must drop the stale member from holds")
}

func CheckReleaseByOrder(ctx *harness.Ctx) {
	bg := context.Background()
	ctx.Redis.Set(shoeStockKey, 3)
	member := placeHold(ctx, "o1", 2, 600)
	ctx.NoError(release(bg, "o1"), "release(o1) returned an error")
	ctx.Equal(stringAt(ctx, shoeStockKey), "5", "stock after release(o1)")
	ctx.Equal(ctx.Redis.Exists("hold:o1"), 0, "hold:o1 must be gone after release(o1)")
	_, indexed := ctx.Redis.ZScore("holds", member)
	ctx.Assert(!indexed, "the member must leave holds after release(o1)")
	ctx.NoError(release(bg, "o1"), "a second release(o1) returned an error")
	ctx.Equal(stringAt(ctx, shoeStockKey), "5", "a second release(o1) must not give the units back again")
	ctx.NoError(release(bg, "never-reserved"), "release(never-reserved) returned an error")
	ctx.Equal(stringAt(ctx, shoeStockKey), "5", "release of an unknown order must do nothing")

	// The sweeper gets there first: right after release(o2) has read the member, the hold is swept.
	racing := placeHold(ctx, "o2", 2, -5)
	ctx.Redis.After("hold:o2", func() any {
		ctx.Redis.Do("INCRBY", shoeStockKey, 2)
		ctx.Redis.Del("hold:o2")
		return ctx.Redis.Do("ZREM", "holds", racing)
	})
	ctx.NoError(release(bg, "o2"), "release(o2) returned an error")
	ctx.Equal(stringAt(ctx, shoeStockKey), "7", "stock after release(o2) raced the sweeper (the units must not go back twice: release must go through the same EXISTS-guarded script)")
}
`,
  },
  debrief: `The sorted set is a priority queue keyed by time, and \`ZRANGEBYSCORE … LIMIT\` is the classic way to drain one in bounded slices. The \`EXISTS\` guard inside the script is what makes the sweeper, the API's 503 path and the consumer's no-stock path safe to run concurrently and to repeat: a hold is released at most once no matter who gets there first. Real systems run the sweeper on an elected leader (or shard the sorted set by SKU prefix), treat keyspace notifications only as a hint, and reconcile the Redis counter against the warehouse ledger after the drop — the oversell that any cache-fronted counter eventually produces is caught by accounting, not by more Lua.`,
};
