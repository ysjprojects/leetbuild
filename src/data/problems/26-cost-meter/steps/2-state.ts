import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'The window hash: one script, integer micro-dollars, an hour of grace',
  concept: 'redis',
  guides: ['keys-and-expiry', 'atomic-state'],
  file: 'state',
  focus: ['meter', 'redis', 'limiter'],
  task: `## Task

**Starting point.** The starter's \`record_usage(tenant, input_tokens, output_tokens, cost_micros)\` adds
one priced report to the tenant's spend: three \`HINCRBY\` and one \`HINCRBYFLOAT\` against
\`meter:{tenant}\` (the cost kept as dollars in \`cost_usd\`), then an \`HMGET\` that reads the totals back.
The demo dashboard moves. It hides four flaws.

**Failure mode the checks target.** The budget limiter reads this hash, so its flaws turn into wrong
429s. A key with no hour in it does not reset: a tenant that hit its budget last week is over it today.
Separate commands let another report land between them, and the read-back returns that report's tokens
as this one's. A float of dollars drifts by fractions of a cent per report, and finance rounds the
drift into invoices.

Requirements:

- One hash per tenant hour: \`window_key(tenant, bucket_of(now))\` from \`meter/config\`, fields
  \`input_tokens\`, \`output_tokens\`, \`cost_micros\`, \`events\`.
- One Lua script (\`EVAL\`) adds both counts, the cost as integer micro-dollars (\`HINCRBY\`) and one
  event, and returns the four totals it wrote.
- The key expires one hour after its window closes, \`EXPIREAT (bucket + 1) × WINDOW_S + GRACE_S\`, from
  the same script, so a later write cannot move it.`,
  sequence: {
    participants: ['meterd', 'Redis', 'Budget limiter'],
    messages: [
      {from: 'meterd', to: 'Redis', label: 'EVAL record · meter:t1:{bucket} · in out cost expire_at', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'HINCRBY ×4 · EXPIREAT window end + grace', kind: 'sync'},
      {from: 'Redis', to: 'meterd', label: '{input_tokens, output_tokens, cost_micros, events}', kind: 'reply'},
      {from: 'Budget limiter', to: 'Redis', label: 'HGET meter:t1:{bucket} cost_micros', kind: 'sync'},
    ],
  },
  hints: [
    "Symptom: a tenant over budget last Tuesday still gets 429s today, two concurrent reports each come back with the other one's tokens in their totals, and the cost field reads 0.0060000000000000001.",
    'Mechanism: the key is `meter:{tenant}` with no bucket and no expiry; four separate writes and a read-back leave gaps another client fills; `HINCRBYFLOAT` adds binary floats of dollars.',
    "Change: `register_script` / `defineCommand` / `NewScript` / `eval` with four `HINCRBY` (cost in micros) and `EXPIREAT (bucket + 1) * WINDOW_S + GRACE_S`, keyed `window_key(tenant, bucket_of(now))`; return the script's own totals.",
  ],
  checks: [
    {
      id: 'window-key',
      title: 'Keys the spend by tenant and hour window',
      detail:
        'A report lands in meter:{tenant}:{bucket} for the current hour; the next hour starts a new hash from zero, and another tenant has its own. The starter keys by tenant alone, so spend never resets.',
      match: {
        python: {all: [/window_key\(/, /bucket_of\(/]},
        typescript: {all: [/windowKey\(/, /bucketOf\(/]},
        go: {all: [/config\.WindowKey\(/, /config\.BucketOf\(/]},
        scala: {all: [/Config\.windowKey\(/, /Config\.bucketOf\(/]},
        cpp: {all: [/config::window_key\(/, /config::bucket_of\(/]},
      },
    },
    {
      id: 'atomic-script',
      title: 'Records in one Lua script and returns its own totals',
      detail:
        "The four HINCRBY run inside one EVAL, and the totals returned are the ones the script wrote: another report landing at the same moment is in the hash but not in this report's totals; events counts reports. The starter issues separate commands and reads the hash back afterwards.",
      match: {
        python: {
          all: [/register_script\(|\.eval\(|\.evalsha\(/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/\.hincrby(float)?\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(|\.evalsha\(/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/\.hincrby(float)?\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(|\.EvalSha\(/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/\.HIncrBy(Float)?\(/],
        },
        scala: {all: [/jedis\s*\.eval(sha)?\(/, /redis\.call\(\s*['"]HINCRBY['"]/], none: [/\.hincrBy(Float)?\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]HINCRBY['"]/], none: [/\.hincrby(float)?\(/]},
      },
    },
    {
      id: 'window-expiry',
      title: 'Expires the window an hour after it closes',
      detail:
        'A write at half past the hour leaves a TTL of about 5400 s (window end plus GRACE_S), a later write leaves the expiry where it was, and the hash is gone once the grace hour is over. The starter sets no expiry.',
      match: {
        python: {all: [/redis\.call\(\s*['"]EXPIREAT['"]/, /GRACE_S/], none: [/['"]EXPIRE['"]|\.expire\(/]},
        typescript: {all: [/redis\.call\(\s*['"]EXPIREAT['"]/, /GRACE_S/], none: [/['"]EXPIRE['"]|\.expire\(/]},
        go: {all: [/redis\.call\(\s*['"]EXPIREAT['"]/, /config\.GraceSeconds/], none: [/['"]EXPIRE['"]|\.Expire\(/]},
        scala: {all: [/redis\.call\(\s*['"]EXPIREAT['"]/, /Config\.GraceSeconds/], none: [/['"]EXPIRE['"]|\.expire\(/]},
        cpp: {all: [/redis\.call\(\s*['"]EXPIREAT['"]/, /config::kGraceSeconds/], none: [/['"]EXPIRE['"]|\.expire\(/]},
      },
    },
    {
      id: 'integer-micros',
      title: 'Adds the cost as integer micro-dollars',
      detail:
        "The hash holds cost_micros, an exact integer sum of every report's cost, the field the limiter and the spend read use. The starter adds floats of dollars to cost_usd with HINCRBYFLOAT.",
      match: {
        python: {all: [/['"]cost_micros['"]/], none: [/hincrbyfloat|cost_usd/i]},
        typescript: {all: [/['"]cost_micros['"]/], none: [/hincrbyfloat|cost_usd/i]},
        go: {all: [/['"]cost_micros['"]/], none: [/hincrbyfloat|cost_usd/i]},
        scala: {all: [/['"]cost_micros['"]/], none: [/hincrbyfloat|cost_usd/i]},
        cpp: {all: [/['"]cost_micros['"]/], none: [/hincrbyfloat|cost_usd/i]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def record_usage(tenant: str, input_tokens: int, output_tokens: int, cost_micros: int) -> dict:
    """Add one priced report to the tenant's spend; the totals after it."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    key = f"meter:{tenant}"
    r.hincrby(key, "input_tokens", input_tokens)
    r.hincrby(key, "output_tokens", output_tokens)
    r.hincrbyfloat(key, "cost_usd", cost_micros / 1_000_000)
    r.hincrby(key, "events", 1)
    totals = r.hmget(key, "input_tokens", "output_tokens", "cost_usd", "events")
    return {
        "input_tokens": int(totals[0]),
        "output_tokens": int(totals[1]),
        "cost_micros": round(float(totals[2]) * 1_000_000),
        "events": int(totals[3]),
    }
`,
      solution: `import time

import redis

from meter.config import GRACE_S, WINDOW_S, bucket_of, window_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RECORD = """
local key = KEYS[1]
local totals = {
  redis.call('HINCRBY', key, 'input_tokens', ARGV[1]),
  redis.call('HINCRBY', key, 'output_tokens', ARGV[2]),
  redis.call('HINCRBY', key, 'cost_micros', ARGV[3]),
  redis.call('HINCRBY', key, 'events', 1),
}
redis.call('EXPIREAT', key, ARGV[4])
return totals
"""

record = r.register_script(RECORD)


def record_usage(tenant: str, input_tokens: int, output_tokens: int, cost_micros: int) -> dict:
    """Add one priced report to the tenant's spend; the totals after it."""
    bucket = bucket_of(time.time())
    # The window's key lives until an hour after the window closes, whenever it was last written.
    expire_at = (bucket + 1) * WINDOW_S + GRACE_S
    totals = record(keys=[window_key(tenant, bucket)], args=[input_tokens, output_tokens, cost_micros, expire_at])
    return dict(zip(("input_tokens", "output_tokens", "cost_micros", "events"), (int(n) for n in totals)))
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

export const redis = new Redis({host: 'redis', port: 6379});

export interface Totals {
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  events: number;
}

/** Add one priced report to the tenant's spend; the totals after it. */
export async function recordUsage(tenant: string, inputTokens: number, outputTokens: number, costMicros: number): Promise<Totals> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const key = \`meter:\${tenant}\`;
  await redis.hincrby(key, 'input_tokens', inputTokens);
  await redis.hincrby(key, 'output_tokens', outputTokens);
  await redis.hincrbyfloat(key, 'cost_usd', costMicros / 1_000_000);
  await redis.hincrby(key, 'events', 1);
  const [input, output, costUsd, events] = await redis.hmget(key, 'input_tokens', 'output_tokens', 'cost_usd', 'events');
  return {
    input_tokens: Number(input),
    output_tokens: Number(output),
    cost_micros: Math.round(Number(costUsd) * 1_000_000),
    events: Number(events),
  };
}
`,
      solution: `import Redis from 'ioredis';

import {GRACE_S, WINDOW_S, bucketOf, windowKey} from 'meter/config';

const RECORD = \`
local key = KEYS[1]
local totals = {
  redis.call('HINCRBY', key, 'input_tokens', ARGV[1]),
  redis.call('HINCRBY', key, 'output_tokens', ARGV[2]),
  redis.call('HINCRBY', key, 'cost_micros', ARGV[3]),
  redis.call('HINCRBY', key, 'events', 1),
}
redis.call('EXPIREAT', key, ARGV[4])
return totals
\`;

interface MeterRedis extends Redis {
  recordWindow(key: string, input: number, output: number, cost: number, expireAt: number): Promise<number[]>;
}

export const redis = new Redis({host: 'redis', port: 6379}) as MeterRedis;
redis.defineCommand('recordWindow', {numberOfKeys: 1, lua: RECORD});

export interface Totals {
  input_tokens: number;
  output_tokens: number;
  cost_micros: number;
  events: number;
}

/** Add one priced report to the tenant's spend; the totals after it. */
export async function recordUsage(tenant: string, inputTokens: number, outputTokens: number, costMicros: number): Promise<Totals> {
  const bucket = bucketOf(Date.now() / 1000);
  // The window's key lives until an hour after the window closes, whenever it was last written.
  const expireAt = (bucket + 1) * WINDOW_S + GRACE_S;
  const [input, output, cost, events] = await redis.recordWindow(windowKey(tenant, bucket), inputTokens, outputTokens, costMicros, expireAt);
  return {input_tokens: Number(input), output_tokens: Number(output), cost_micros: Number(cost), events: Number(events)};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Totals are a window's counters after a report.
type Totals struct {
	InputTokens  int64
	OutputTokens int64
	CostMicros   int64
	Events       int64
}

// recordUsage adds one priced report to the tenant's spend; the totals after it.
func recordUsage(ctx context.Context, tenant string, inputTokens, outputTokens, costMicros int64) (Totals, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	key := "meter:" + tenant
	rdb.HIncrBy(ctx, key, "input_tokens", inputTokens)
	rdb.HIncrBy(ctx, key, "output_tokens", outputTokens)
	rdb.HIncrByFloat(ctx, key, "cost_usd", float64(costMicros)/1_000_000)
	rdb.HIncrBy(ctx, key, "events", 1)
	vals, err := rdb.HMGet(ctx, key, "input_tokens", "output_tokens", "cost_usd", "events").Result()
	if err != nil {
		return Totals{}, err
	}
	n := func(v any) int64 { i, _ := strconv.ParseInt(fmt.Sprint(v), 10, 64); return i }
	usd, _ := strconv.ParseFloat(fmt.Sprint(vals[2]), 64)
	return Totals{InputTokens: n(vals[0]), OutputTokens: n(vals[1]), CostMicros: int64(usd*1_000_000 + 0.5), Events: n(vals[3])}, nil
}

func main() {
	if _, err := recordUsage(context.Background(), "t-demo", 1200, 300, 6000); err != nil {
		fmt.Println(err)
	}
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"meter/config" // config.WindowSeconds, config.GraceSeconds, config.BucketOf, config.WindowKey — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var recordWindow = redis.NewScript(\`
local key = KEYS[1]
local totals = {
  redis.call('HINCRBY', key, 'input_tokens', ARGV[1]),
  redis.call('HINCRBY', key, 'output_tokens', ARGV[2]),
  redis.call('HINCRBY', key, 'cost_micros', ARGV[3]),
  redis.call('HINCRBY', key, 'events', 1),
}
redis.call('EXPIREAT', key, ARGV[4])
return totals
\`)

// Totals are a window's counters after a report.
type Totals struct {
	InputTokens  int64
	OutputTokens int64
	CostMicros   int64
	Events       int64
}

// recordUsage adds one priced report to the tenant's spend; the totals after it.
func recordUsage(ctx context.Context, tenant string, inputTokens, outputTokens, costMicros int64) (Totals, error) {
	bucket := config.BucketOf(time.Now().Unix())
	// The window's key lives until an hour after the window closes, whenever it was last written.
	expireAt := (bucket+1)*config.WindowSeconds + config.GraceSeconds
	totals, err := recordWindow.Run(ctx, rdb, []string{config.WindowKey(tenant, bucket)}, inputTokens, outputTokens, costMicros, expireAt).Int64Slice()
	if err != nil {
		return Totals{}, err
	}
	return Totals{InputTokens: totals[0], OutputTokens: totals[1], CostMicros: totals[2], Events: totals[3]}, nil
}

func main() {
	if _, err := recordUsage(context.Background(), "t-demo", 1200, 300, 6000); err != nil {
		fmt.Println(err)
	}
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

/** A window's counters after a report. */
final case class Totals(inputTokens: Long, outputTokens: Long, costMicros: Long, events: Long)

object WindowState {
  val jedis = new JedisPooled("redis", 6379)

  /** Add one priced report to the tenant's spend; the totals after it. */
  def recordUsage(tenant: String, inputTokens: Long, outputTokens: Long, costMicros: Long): Totals = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val key = s"meter:$tenant"
    jedis.hincrBy(key, "input_tokens", inputTokens)
    jedis.hincrBy(key, "output_tokens", outputTokens)
    jedis.hincrByFloat(key, "cost_usd", costMicros / 1000000.0)
    jedis.hincrBy(key, "events", 1)
    val totals = jedis.hmget(key, "input_tokens", "output_tokens", "cost_usd", "events")
    Totals(totals.get(0).toLong, totals.get(1).toLong, math.round(totals.get(2).toDouble * 1000000), totals.get(3).toLong)
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import meter.Config

/** A window's counters after a report. */
final case class Totals(inputTokens: Long, outputTokens: Long, costMicros: Long, events: Long)

object WindowState {
  val jedis = new JedisPooled("redis", 6379)

  val Record: String =
    """local key = KEYS[1]
      |local totals = {
      |  redis.call('HINCRBY', key, 'input_tokens', ARGV[1]),
      |  redis.call('HINCRBY', key, 'output_tokens', ARGV[2]),
      |  redis.call('HINCRBY', key, 'cost_micros', ARGV[3]),
      |  redis.call('HINCRBY', key, 'events', 1),
      |}
      |redis.call('EXPIREAT', key, ARGV[4])
      |return totals
      |""".stripMargin

  /** Add one priced report to the tenant's spend; the totals after it. */
  def recordUsage(tenant: String, inputTokens: Long, outputTokens: Long, costMicros: Long): Totals = {
    val bucket = Config.bucketOf(System.currentTimeMillis() / 1000)
    // The window's key lives until an hour after the window closes, whenever it was last written.
    val expireAt = (bucket + 1) * Config.WindowSeconds + Config.GraceSeconds
    val args = List(inputTokens, outputTokens, costMicros, expireAt).map(_.toString)
    val totals = jedis
      .eval(Record, List(Config.windowKey(tenant, bucket)).asJava, args.asJava)
      .asInstanceOf[java.util.List[java.lang.Long]]
      .asScala
      .map(_.longValue)
    Totals(totals(0), totals(1), totals(2), totals(3))
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <cmath>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

// A window's counters after a report.
struct Totals {
  long long input_tokens = 0;
  long long output_tokens = 0;
  long long cost_micros = 0;
  long long events = 0;
};

// Add one priced report to the tenant's spend; the totals after it.
Totals record_usage(const std::string& tenant, long long input_tokens, long long output_tokens, long long cost_micros) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string key = "meter:" + tenant;
  redis.hincrby(key, "input_tokens", input_tokens);
  redis.hincrby(key, "output_tokens", output_tokens);
  redis.hincrbyfloat(key, "cost_usd", static_cast<double>(cost_micros) / 1000000);
  redis.hincrby(key, "events", 1);
  const auto vals = redis.hmget(key, {"input_tokens", "output_tokens", "cost_usd", "events"});
  return {std::stoll(*vals[0]), std::stoll(*vals[1]), std::llround(std::stod(*vals[2]) * 1000000), std::stoll(*vals[3])};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <tuple>

#include "meter/config.h"  // config::kWindowSeconds, config::kGraceSeconds, config::bucket_of, config::window_key — provided

sw::redis::Redis redis("tcp://redis:6379");

const std::string kRecord = R"lua(
local key = KEYS[1]
local totals = {
  redis.call('HINCRBY', key, 'input_tokens', ARGV[1]),
  redis.call('HINCRBY', key, 'output_tokens', ARGV[2]),
  redis.call('HINCRBY', key, 'cost_micros', ARGV[3]),
  redis.call('HINCRBY', key, 'events', 1),
}
redis.call('EXPIREAT', key, ARGV[4])
return totals
)lua";

// A window's counters after a report.
struct Totals {
  long long input_tokens = 0;
  long long output_tokens = 0;
  long long cost_micros = 0;
  long long events = 0;
};

// Add one priced report to the tenant's spend; the totals after it.
Totals record_usage(const std::string& tenant, long long input_tokens, long long output_tokens, long long cost_micros) {
  const long long now =
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long long bucket = config::bucket_of(now);
  // The window's key lives until an hour after the window closes, whenever it was last written.
  const long long expire_at = (bucket + 1) * config::kWindowSeconds + config::kGraceSeconds;
  const auto [input, output, cost, events] = redis.eval<long long, long long, long long, long long>(
      kRecord, {config::window_key(tenant, bucket)},
      {std::to_string(input_tokens), std::to_string(output_tokens), std::to_string(cost_micros), std::to_string(expire_at)});
  return {input, output, cost, events};
}
`,
    },
  },
  harness: {
    python: `import time

WINDOW = 3600
GRACE = 3600


def _mid_window(ctx):
    """Move the clock to half past the next hour; the bucket it falls in."""
    ctx.clock.advance(WINDOW - time.time() % WINDOW + 1800)
    return int(time.time() // WINDOW)


def _hash(ctx, key):
    return ctx.redis.hgetall(key)


def _totals(t):
    return (t.get("input_tokens"), t.get("output_tokens"), t.get("cost_micros"), t.get("events"))


def check_window_key(ctx):
    m = ctx.load("state")
    bucket = _mid_window(ctx)
    m.record_usage("t1", 1000, 200, 4500)
    key = f"meter:t1:{bucket}"
    assert ctx.redis.exists(key), f"a report at half past the hour must land in {key} (meter:{{tenant}}:{{bucket}}), the keys are {sorted(ctx.redis.keys('*'))}"
    assert _hash(ctx, key).get("input_tokens") == "1000", f"{key} holds {_hash(ctx, key)}"
    m.record_usage("t2", 7, 7, 7)
    assert _hash(ctx, f"meter:t2:{bucket}").get("input_tokens") == "7", f"another tenant has its own window, the keys are {sorted(ctx.redis.keys('*'))}"
    ctx.clock.advance(WINDOW)
    totals = m.record_usage("t1", 10, 20, 300)
    assert _totals(totals) == (10, 20, 300, 1), f"the next hour starts a new window from zero, record_usage answered {totals}: without the hour in the key, last week's spend still counts against this hour's budget"
    assert _hash(ctx, f"meter:t1:{bucket + 1}").get("input_tokens") == "10", f"the next hour's report must land in meter:t1:{bucket + 1}, the keys are {sorted(ctx.redis.keys('*'))}"


def check_atomic_script(ctx):
    m = ctx.load("state")
    bucket = _mid_window(ctx)
    key = f"meter:t1:{bucket}"

    def other_report():
        # another replica recording a report for the same tenant, landing between two of this one's commands
        ctx.redis.hincrby(key, "input_tokens", 500)
        ctx.redis.hincrby(key, "output_tokens", 50)
        ctx.redis.hincrby(key, "cost_micros", 2000)
        ctx.redis.hincrby(key, "events", 1)

    probe = ctx.redis_after(key, other_report)
    totals = m.record_usage("t1", 1000, 200, 4500)
    assert probe.fired, f"record_usage never touched {key}, the keys are {sorted(ctx.redis.keys('*'))}"
    assert _totals(totals) == (1000, 200, 4500, 1), f"record_usage answered {totals}, expected the totals its own write produced (1000, 200, 4500, 1 event): another report landed between its commands and was counted as this one's"
    window = _hash(ctx, key)
    assert (window.get("input_tokens"), window.get("cost_micros"), window.get("events")) == ("1500", "6500", "2"), f"both reports must be in the window: {window}"


def check_window_expiry(ctx):
    m = ctx.load("state")
    bucket = _mid_window(ctx)
    key = f"meter:t1:{bucket}"
    m.record_usage("t1", 100, 10, 400)
    expected = (bucket + 1) * WINDOW + GRACE - time.time()
    ttl = ctx.redis.ttl(key)
    assert ttl > 0, f"{key} has TTL {ttl}: a window that never expires keeps last hour's spend in Redis for good"
    assert abs(ttl - expected) <= 3, f"{key} has TTL {ttl} s at half past the hour, expected about {expected:.0f} s: the window expires GRACE_S after it closes, not a fixed time after each write"
    ctx.clock.advance(600)
    m.record_usage("t1", 100, 10, 400)
    later = ctx.redis.ttl(key)
    assert abs(later - (expected - 600)) <= 3, f"a write ten minutes later moved the expiry: TTL {later} s, expected about {expected - 600:.0f} s"
    ctx.clock.advance(expected - 600 + 1)
    assert not ctx.redis.exists(key), f"an hour after the window closed {key} must be gone, it holds {_hash(ctx, key)}"


def check_integer_micros(ctx):
    m = ctx.load("state")
    bucket = _mid_window(ctx)
    for cost in (1, 2, 3, 100_000, 7):
        totals = m.record_usage("t1", 10, 10, cost)
    window = _hash(ctx, f"meter:t1:{bucket}")
    assert window.get("cost_micros") == "100013", f"five reports costing 100013 micro-dollars in all left the window as {window}: the spend must be an exact integer sum in cost_micros (HINCRBY), not floats of dollars"
    assert not any("." in v for v in window.values()), f"every field of the window must be an integer: {window}"
    assert totals.get("cost_micros") == 100013, f"record_usage must answer cost_micros 100013, got {totals}"
`,
    typescript: `const WINDOW = 3600;
const GRACE = 3600;

/** Move the clock to half past the next hour; the bucket it falls in. */
function midWindow(ctx): number {
  ctx.clock.advance(WINDOW - ((ctx.clock.now() / 1000) % WINDOW) + 1800);
  return Math.floor(ctx.clock.now() / 1000 / WINDOW);
}

const hash = (ctx, key: string) => ctx.redis.hgetall(key);
const totalsOf = t => [t.input_tokens, t.output_tokens, t.cost_micros, t.events];

export async function check_window_key(ctx) {
  const m = ctx.load('state');
  const bucket = midWindow(ctx);
  await m.recordUsage('t1', 1000, 200, 4500);
  const key = \`meter:t1:\${bucket}\`;
  assert(ctx.redis.exists(key) === 1, \`a report at half past the hour must land in \${key} (meter:{tenant}:{bucket}), the keys are \${JSON.stringify(ctx.redis.keys('*').sort())}\`);
  assert.equal(hash(ctx, key).input_tokens, '1000', \`\${key} holds \${JSON.stringify(hash(ctx, key))}\`);
  await m.recordUsage('t2', 7, 7, 7);
  assert.equal(hash(ctx, \`meter:t2:\${bucket}\`).input_tokens, '7', \`another tenant has its own window, the keys are \${JSON.stringify(ctx.redis.keys('*').sort())}\`);
  ctx.clock.advance(WINDOW);
  const totals = await m.recordUsage('t1', 10, 20, 300);
  assert.deepEqual(totalsOf(totals), [10, 20, 300, 1], \`the next hour starts a new window from zero, recordUsage answered \${JSON.stringify(totals)}: without the hour in the key, last week's spend still counts against this hour's budget\`);
  assert.equal(hash(ctx, \`meter:t1:\${bucket + 1}\`).input_tokens, '10', \`the next hour's report must land in meter:t1:\${bucket + 1}, the keys are \${JSON.stringify(ctx.redis.keys('*').sort())}\`);
}

export async function check_atomic_script(ctx) {
  const m = ctx.load('state');
  const bucket = midWindow(ctx);
  const key = \`meter:t1:\${bucket}\`;
  // another replica recording a report for the same tenant, landing between two of this one's commands
  const probe = ctx.redisAfter(key, () => {
    ctx.redis.hincrby(key, 'input_tokens', 500);
    ctx.redis.hincrby(key, 'output_tokens', 50);
    ctx.redis.hincrby(key, 'cost_micros', 2000);
    ctx.redis.hincrby(key, 'events', 1);
  });
  const totals = await m.recordUsage('t1', 1000, 200, 4500);
  assert(probe.fired, \`recordUsage never touched \${key}, the keys are \${JSON.stringify(ctx.redis.keys('*').sort())}\`);
  assert.deepEqual(totalsOf(totals), [1000, 200, 4500, 1], \`recordUsage answered \${JSON.stringify(totals)}, expected the totals its own write produced (1000, 200, 4500, 1 event): another report landed between its commands and was counted as this one's\`);
  const w = hash(ctx, key);
  assert(w.input_tokens === '1500' && w.cost_micros === '6500' && w.events === '2', \`both reports must be in the window: \${JSON.stringify(w)}\`);
}

export async function check_window_expiry(ctx) {
  const m = ctx.load('state');
  const bucket = midWindow(ctx);
  const key = \`meter:t1:\${bucket}\`;
  await m.recordUsage('t1', 100, 10, 400);
  const expected = (bucket + 1) * WINDOW + GRACE - ctx.clock.now() / 1000;
  const ttl = Number(ctx.redis.ttl(key));
  assert(ttl > 0, \`\${key} has TTL \${ttl}: a window that never expires keeps last hour's spend in Redis for good\`);
  assert(Math.abs(ttl - expected) <= 3, \`\${key} has TTL \${ttl} s at half past the hour, expected about \${expected.toFixed(0)} s: the window expires GRACE_S after it closes, not a fixed time after each write\`);
  ctx.clock.advance(600);
  await m.recordUsage('t1', 100, 10, 400);
  const later = Number(ctx.redis.ttl(key));
  assert(Math.abs(later - (expected - 600)) <= 3, \`a write ten minutes later moved the expiry: TTL \${later} s, expected about \${(expected - 600).toFixed(0)} s\`);
  ctx.clock.advance(expected - 600 + 1);
  assert.equal(ctx.redis.exists(key), 0, \`an hour after the window closed \${key} must be gone, it holds \${JSON.stringify(hash(ctx, key))}\`);
}

export async function check_integer_micros(ctx) {
  const m = ctx.load('state');
  const bucket = midWindow(ctx);
  let totals;
  for (const cost of [1, 2, 3, 100_000, 7]) totals = await m.recordUsage('t1', 10, 10, cost);
  const w = hash(ctx, \`meter:t1:\${bucket}\`);
  assert.equal(w.cost_micros, '100013', \`five reports costing 100013 micro-dollars in all left the window as \${JSON.stringify(w)}: the spend must be an exact integer sum in cost_micros (HINCRBY), not floats of dollars\`);
  assert(!Object.values(w).some(v => String(v).includes('.')), \`every field of the window must be an integer: \${JSON.stringify(w)}\`);
  assert.equal(totals.cost_micros, 100013, \`recordUsage must answer cost_micros 100013, got \${JSON.stringify(totals)}\`);
}
`,
    go: `package main

import (
	"context"
	"math"
	"strconv"
	"strings"

	"leetbuild/harness"
)

const (
	stateWindow = 3600
	stateGrace  = 3600
)

// stateMidWindow moves the clock to half past the next hour; the bucket it falls in.
func stateMidWindow(ctx *harness.Ctx) int64 {
	now := float64(ctx.Clock.Now()) / 1000
	ctx.Clock.Advance(stateWindow - math.Mod(now, stateWindow) + 1800)
	return ctx.Clock.Now() / 1000 / stateWindow
}

func stateKey(tenant string, bucket int64) string {
	return "meter:" + tenant + ":" + strconv.FormatInt(bucket, 10)
}

func stateRecord(ctx *harness.Ctx, tenant string, in, out, cost int64) Totals {
	t, err := recordUsage(context.Background(), tenant, in, out, cost)
	ctx.NoError(err, "recordUsage(%s)", tenant)
	return t
}

func CheckWindowKey(ctx *harness.Ctx) {
	bucket := stateMidWindow(ctx)
	stateRecord(ctx, "t1", 1000, 200, 4500)
	key := stateKey("t1", bucket)
	ctx.Equal(ctx.Redis.HGetAll(key)["input_tokens"], "1000", "a report at half past the hour must land in %s (meter:{tenant}:{bucket}); the keys are %v; its input_tokens", key, ctx.Redis.Keys("*"))
	stateRecord(ctx, "t2", 7, 7, 7)
	ctx.Equal(ctx.Redis.HGetAll(stateKey("t2", bucket))["input_tokens"], "7", "another tenant has its own window (keys %v); its input_tokens", ctx.Redis.Keys("*"))
	ctx.Clock.Advance(stateWindow)
	totals := stateRecord(ctx, "t1", 10, 20, 300)
	ctx.Equal(totals, Totals{InputTokens: 10, OutputTokens: 20, CostMicros: 300, Events: 1}, "the next hour starts a new window from zero (without the hour in the key, last week's spend still counts against this hour's budget); recordUsage's totals")
	ctx.Equal(ctx.Redis.HGetAll(stateKey("t1", bucket+1))["input_tokens"], "10", "the next hour's report must land in %s (keys %v); its input_tokens", stateKey("t1", bucket+1), ctx.Redis.Keys("*"))
}

func CheckAtomicScript(ctx *harness.Ctx) {
	bucket := stateMidWindow(ctx)
	key := stateKey("t1", bucket)
	fired := false
	// another replica recording a report for the same tenant, landing between two of this one's commands
	ctx.Redis.After(key, func() any {
		fired = true
		ctx.Redis.Do("HINCRBY", key, "input_tokens", 500)
		ctx.Redis.Do("HINCRBY", key, "output_tokens", 50)
		ctx.Redis.Do("HINCRBY", key, "cost_micros", 2000)
		ctx.Redis.Do("HINCRBY", key, "events", 1)
		return nil
	})
	totals := stateRecord(ctx, "t1", 1000, 200, 4500)
	ctx.Assert(fired, "recordUsage never touched %s, the keys are %v", key, ctx.Redis.Keys("*"))
	ctx.Equal(totals, Totals{InputTokens: 1000, OutputTokens: 200, CostMicros: 4500, Events: 1}, "recordUsage must answer the totals its own write produced: another report landed between its commands and was counted as this one's; the totals")
	w := ctx.Redis.HGetAll(key)
	ctx.Assert(w["input_tokens"] == "1500" && w["cost_micros"] == "6500" && w["events"] == "2", "both reports must be in the window: %v", w)
}

func CheckWindowExpiry(ctx *harness.Ctx) {
	bucket := stateMidWindow(ctx)
	key := stateKey("t1", bucket)
	stateRecord(ctx, "t1", 100, 10, 400)
	expected := float64((bucket+1)*stateWindow+stateGrace) - float64(ctx.Clock.Now())/1000
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(ttl > 0, "%s has TTL %d: a window that never expires keeps last hour's spend in Redis for good", key, ttl)
	ctx.Assert(math.Abs(float64(ttl)-expected) <= 3, "%s has TTL %d s at half past the hour, expected about %.0f s: the window expires GraceSeconds after it closes, not a fixed time after each write", key, ttl, expected)
	ctx.Clock.Advance(600)
	stateRecord(ctx, "t1", 100, 10, 400)
	later := ctx.Redis.TTL(key)
	ctx.Assert(math.Abs(float64(later)-(expected-600)) <= 3, "a write ten minutes later moved the expiry: TTL %d s, expected about %.0f s", later, expected-600)
	ctx.Clock.Advance(expected - 600 + 1)
	ctx.Equal(ctx.Redis.Exists(key), 0, "an hour after the window closed %s must be gone (%v); exists", key, ctx.Redis.HGetAll(key))
}

func CheckIntegerMicros(ctx *harness.Ctx) {
	bucket := stateMidWindow(ctx)
	var totals Totals
	for _, cost := range []int64{1, 2, 3, 100_000, 7} {
		totals = stateRecord(ctx, "t1", 10, 10, cost)
	}
	w := ctx.Redis.HGetAll(stateKey("t1", bucket))
	ctx.Equal(w["cost_micros"], "100013", "five reports costing 100013 micro-dollars in all left the window as %v: the spend must be an exact integer sum in cost_micros (HINCRBY), not floats of dollars; cost_micros", w)
	for field, v := range w {
		ctx.Assert(!strings.Contains(v, "."), "every field of the window must be an integer: %s is %s", field, v)
	}
	ctx.Equal(totals.CostMicros, 100013, "recordUsage's CostMicros")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cmath>
#include <string>

namespace {

constexpr long long kWindow = 3600;
constexpr long long kGrace = 3600;

// Move the clock to half past the next hour; the bucket it falls in.
long long midWindow(harness::Ctx& ctx) {
  const double now = static_cast<double>(ctx.Clock.Now()) / 1000;
  ctx.Clock.Advance(kWindow - std::fmod(now, kWindow) + 1800);
  return ctx.Clock.Now() / 1000 / kWindow;
}

std::string windowOf(const std::string& tenant, long long bucket) { return "meter:" + tenant + ":" + std::to_string(bucket); }

std::string field(harness::Ctx& ctx, const std::string& key, const std::string& name) {
  const auto all = ctx.Redis.HGetAll(key);
  const auto it = all.find(name);
  return it == all.end() ? "" : it->second;
}

}  // namespace

void CheckWindowKey(harness::Ctx& ctx) {
  const long long bucket = midWindow(ctx);
  record_usage("t1", 1000, 200, 4500);
  const std::string key = windowOf("t1", bucket);
  ctx.Equal(field(ctx, key, "input_tokens"), "1000", "a report at half past the hour must land in %s (meter:{tenant}:{bucket}); the keys are %v; its input_tokens", key, ctx.Redis.Keys("*"));
  record_usage("t2", 7, 7, 7);
  ctx.Equal(field(ctx, windowOf("t2", bucket), "input_tokens"), "7", "another tenant has its own window (keys %v); its input_tokens", ctx.Redis.Keys("*"));
  ctx.Clock.Advance(kWindow);
  const Totals totals = record_usage("t1", 10, 20, 300);
  ctx.Assert(totals.input_tokens == 10 && totals.output_tokens == 20 && totals.cost_micros == 300 && totals.events == 1,
             "the next hour starts a new window from zero, record_usage answered (%d, %d, %d, %d events): without the hour in the key, last week's spend still counts against this hour's budget",
             totals.input_tokens, totals.output_tokens, totals.cost_micros, totals.events);
  ctx.Equal(field(ctx, windowOf("t1", bucket + 1), "input_tokens"), "10", "the next hour's report must land in %s (keys %v); its input_tokens", windowOf("t1", bucket + 1), ctx.Redis.Keys("*"));
}

void CheckAtomicScript(harness::Ctx& ctx) {
  const long long bucket = midWindow(ctx);
  const std::string key = windowOf("t1", bucket);
  bool fired = false;
  // another replica recording a report for the same tenant, landing between two of this one's commands
  ctx.Redis.After(key, [&] {
    fired = true;
    ctx.Redis.Do("HINCRBY", key, "input_tokens", 500);
    ctx.Redis.Do("HINCRBY", key, "output_tokens", 50);
    ctx.Redis.Do("HINCRBY", key, "cost_micros", 2000);
    ctx.Redis.Do("HINCRBY", key, "events", 1);
  });
  const Totals totals = record_usage("t1", 1000, 200, 4500);
  ctx.Assert(fired, "record_usage never touched %s, the keys are %v", key, ctx.Redis.Keys("*"));
  ctx.Assert(totals.input_tokens == 1000 && totals.output_tokens == 200 && totals.cost_micros == 4500 && totals.events == 1,
             "record_usage answered (%d, %d, %d, %d events), expected the totals its own write produced (1000, 200, 4500, 1 event): another report landed between its commands and was counted as this one's",
             totals.input_tokens, totals.output_tokens, totals.cost_micros, totals.events);
  ctx.Assert(field(ctx, key, "input_tokens") == "1500" && field(ctx, key, "cost_micros") == "6500" && field(ctx, key, "events") == "2",
             "both reports must be in the window: %v", ctx.Redis.HGetAll(key));
}

void CheckWindowExpiry(harness::Ctx& ctx) {
  const long long bucket = midWindow(ctx);
  const std::string key = windowOf("t1", bucket);
  record_usage("t1", 100, 10, 400);
  const double expected = static_cast<double>((bucket + 1) * kWindow + kGrace) - static_cast<double>(ctx.Clock.Now()) / 1000;
  const long long ttl = ctx.Redis.TTL(key);
  ctx.Assert(ttl > 0, "%s has TTL %d: a window that never expires keeps last hour's spend in Redis for good", key, ttl);
  ctx.Assert(std::fabs(static_cast<double>(ttl) - expected) <= 3,
             "%s has TTL %d s at half past the hour, expected about %.0f s: the window expires kGraceSeconds after it closes, not a fixed time after each write", key, ttl, expected);
  ctx.Clock.Advance(600);
  record_usage("t1", 100, 10, 400);
  const long long later = ctx.Redis.TTL(key);
  ctx.Assert(std::fabs(static_cast<double>(later) - (expected - 600)) <= 3, "a write ten minutes later moved the expiry: TTL %d s, expected about %.0f s", later, expected - 600);
  ctx.Clock.Advance(expected - 600 + 1);
  ctx.Equal(ctx.Redis.Exists(key), 0, "an hour after the window closed %s must be gone (%v); exists", key, ctx.Redis.HGetAll(key));
}

void CheckIntegerMicros(harness::Ctx& ctx) {
  const long long bucket = midWindow(ctx);
  Totals totals;
  for (long long cost : {1LL, 2LL, 3LL, 100000LL, 7LL}) totals = record_usage("t1", 10, 10, cost);
  const std::string key = windowOf("t1", bucket);
  ctx.Equal(field(ctx, key, "cost_micros"), "100013",
            "five reports costing 100013 micro-dollars in all left the window as %v: the spend must be an exact integer sum in cost_micros (HINCRBY), not floats of dollars; cost_micros", ctx.Redis.HGetAll(key));
  for (const auto& [name, value] : ctx.Redis.HGetAll(key)) {
    ctx.Assert(value.find('.') == std::string::npos, "every field of the window must be an integer: %s is %s", name, value);
  }
  ctx.Equal(totals.cost_micros, 100013, "record_usage's cost_micros");
}
`,
  },
  debrief: `One script is the unit because the window's fields only mean something together: the limiter divides cost by events, the read in step 5 pairs tokens with spend, and Redis runs a script with nothing in between. Returning the script's own totals is the same argument made for the caller; a read-back is a second question asked after the world moved. Micro-dollars as integers make the sum exact, so the limiter, the read and the invoice agree to the micro-dollar. The expiry is pinned to the window rather than to the last write so a busy tenant's key leaves on schedule. A production meter shards hot tenants across a few keys summed on read, and keeps closed windows in a durable store before Redis drops them, since an hour of grace is for late reports, not for audits.`,
};
