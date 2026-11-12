import type {Step} from '@/lib/types';

export const windowedSketchStep: Step = {
  id: 'state',
  title: 'Redis windowed sketches merged atomically',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['monitor', 'redis', 'baseline'],
  task: `## Task

**Starting point.** The starter is the sketch store the evaluator writes into:
\`merge_batch(tenant, monitor_id, window_s, batch)\` adds a batch of \`{bucket: count}\` into the hash
\`sketch:live:{tenant}:{monitor_id}\` with one \`HGET\` and one \`HSET\` per bucket, sets a 3600 s
expiry and returns the hash's sample count; \`freeze_baseline(tenant, baseline_ref, batch)\` deletes
and rewrites the JSON baseline under \`sketch:baseline:{tenant}:{baseline_ref}\`. It serves the demo
and hides four flaws.

**Failure mode the checks target.** Two evaluator replicas merging into one sketch lose each other's
counts; the 10:00 window starts with the 09:00 counts, and under steady traffic the sketch never
resets at all; and a re-run of the freeze job silently rebases the monitor on today's traffic.

- One sketch per window: \`live_key(tenant, monitor_id, window)\` is
  \`sketch:live:{tenant}:{monitor_id}:{window}\`, \`window\` being the window's start
  (\`now // window_s * window_s\`).
- A batch is merged by **one Lua script**: \`HINCRBY\` per bucket, the window's total returned.
- The script's \`EXPIRE\` is the seconds left in the window (\`window + window_s - now\`), so the
  sketch dies with its window.
- A baseline is written **once** (\`SET … NX\`); a second freeze returns \`False\` and leaves it as it
  was.`,
  sequence: {
    participants: ['Window evaluator', 'Redis', 'Baseline job'],
    messages: [
      {
        from: 'Window evaluator',
        to: 'Redis',
        label: 'EVALSHA merge sketch:live:t1:m-1:900 · 1 640 · 2 210 · 200',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Window evaluator', label: 'HINCRBY ×2 · EXPIRE 200 → window total', kind: 'reply'},
      {from: 'Baseline job', to: 'Redis', label: 'SET sketch:baseline:t1:baseline:v3:2026-10-01 {…} NX', kind: 'sync'},
      {from: 'Redis', to: 'Baseline job', label: 'OK · nil on a second freeze', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-merge',
      title: 'Merges a whole batch in one Lua script',
      detail:
        'Every bucket of a batch is incremented with `HINCRBY` inside one script (`EVAL`/`register_script`/`defineCommand`/`NewScript`); a client-side `HGET` then `HSET` loses the increment another replica made in between.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /HINCRBY/], none: [/\.hget\(/, /\.hset\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /HINCRBY/], none: [/\.hget\(/, /\.hset\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /HINCRBY/], none: [/\.HGet\(/, /\.HSet\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /HINCRBY/], none: [/\.hget\(/, /\.hset\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /HINCRBY/], none: [/\.hget\(/, /\.hset\(/]},
      },
    },
    {
      id: 'window-key',
      title: 'Keeps one sketch per window',
      detail:
        'The live key carries the window start (`live_key`/`liveKey(tenant, monitor_id, window)`), so a new window starts from an empty sketch instead of the previous window’s counts.',
      match: {
        python: {all: [/def live_key\([^)]*\bwindow/]},
        typescript: {all: [/function liveKey\([^)]*\bwindow|liveKey\s*=\s*\([^)]*\bwindow/]},
        go: {all: [/func liveKey\([^)]*\bwindow/]},
        scala: {all: [/def liveKey\([^)]*\bwindow/]},
        cpp: {all: [/liveKey\([^)]*\bwindow/]},
      },
    },
    {
      id: 'window-ttl',
      title: 'Expires the sketch at the end of its window',
      detail:
        'The expiry is the seconds left in the window (`window + window_s - now`), set on every merge, so the key dies with its window; a fixed hour slides forward on every write.',
      match: {
        python: {all: [/window_s\s*-\s*now|window_end\s*-\s*now|EXPIREAT|expireat/], none: [/\b3600\b/]},
        typescript: {all: [/windowS\s*-\s*now|windowEnd\s*-\s*now|EXPIREAT|expireat/], none: [/\b3600\b/]},
        go: {all: [/windowS\s*-\s*now|windowEnd\s*-\s*now|EXPIREAT|ExpireAt/], none: [/\b3600\b/, /time\.Hour/]},
        scala: {all: [/windowS\s*-\s*now|windowEnd\s*-\s*now|EXPIREAT|expireAt/], none: [/\b3600\b/]},
        cpp: {all: [/window_s\s*-\s*now|window_end\s*-\s*now|EXPIREAT|expireat/], none: [/\b3600\b/]},
      },
    },
    {
      id: 'baseline-frozen',
      title: 'Writes the baseline once',
      detail:
        'The baseline is written with a set-if-absent (`nx=True`, `NX`, `SetNX`, `SetParams.nx()`, `UpdateType::NOT_EXIST`) and not deleted first, so a second freeze reports false and the reference stays as it was.',
      match: {
        python: {all: [/nx\s*=\s*True/], none: [/\.delete\(/]},
        typescript: {all: [/['"]NX['"]/], none: [/\.del\(/]},
        go: {all: [/SetNX\(|Mode:\s*"NX"/], none: [/\.Del\(/]},
        scala: {all: [/\.nx\(\)/], none: [/\.del\(/]},
        cpp: {all: [/UpdateType::NOT_EXIST/], none: [/\.del\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def merge_batch(tenant: str, monitor_id: str, window_s: int, batch: dict[int, int]) -> int:
    """Merge a batch of bucket counts into the monitor's sketch for the current window; returns the window's sample count."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    key = f"sketch:live:{tenant}:{monitor_id}"
    for bucket, count in batch.items():
        current = int(r.hget(key, bucket) or 0)
        r.hset(key, bucket, current + count)
    r.expire(key, 3600)
    return sum(int(count) for count in r.hvals(key))


def freeze_baseline(tenant: str, baseline_ref: str, batch: dict[int, int]) -> bool:
    """Store the reference sketch monitors are compared against; True when this call wrote it."""
    key = f"sketch:baseline:{tenant}:{baseline_ref}"
    r.delete(key)
    r.set(key, json.dumps({str(bucket): count for bucket, count in batch.items()}))
    return True
`,
      solution: `import json
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# HINCRBY every (bucket, count) pair of ARGV, expire the hash after ARGV[#ARGV] seconds, return its total.
MERGE_LUA = """
for i = 1, #ARGV - 1, 2 do
  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
end
redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
local total = 0
for _, count in ipairs(redis.call('HVALS', KEYS[1])) do
  total = total + tonumber(count)
end
return total
"""
merge = r.register_script(MERGE_LUA)


def window_start(now: int, window_s: int) -> int:
    return now // window_s * window_s


def live_key(tenant: str, monitor_id: str, window: int) -> str:
    return f"sketch:live:{tenant}:{monitor_id}:{window}"


def merge_batch(tenant: str, monitor_id: str, window_s: int, batch: dict[int, int]) -> int:
    """Merge a batch of bucket counts into the monitor's sketch for the current window; returns the window's sample count."""
    now = int(time.time())
    window = window_start(now, window_s)
    args: list[int] = []
    for bucket, count in sorted(batch.items()):
        args += [bucket, count]
    args.append(window + window_s - now)  # the seconds left in the window: the sketch dies with it
    return int(merge(keys=[live_key(tenant, monitor_id, window)], args=args))


def freeze_baseline(tenant: str, baseline_ref: str, batch: dict[int, int]) -> bool:
    """Store the reference sketch monitors are compared against; True when this call wrote it."""
    key = f"sketch:baseline:{tenant}:{baseline_ref}"
    payload = json.dumps({str(bucket): count for bucket, count in sorted(batch.items())})
    return bool(r.set(key, payload, nx=True))  # a reference is written once, never rebased
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** Bucket id → count. */
export type Sketch = Record<number, number>;

/** Merge a batch of bucket counts into the monitor's sketch for the current window; returns the window's sample count. */
export async function mergeBatch(tenant: string, monitorId: string, windowS: number, batch: Sketch): Promise<number> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = \`sketch:live:\${tenant}:\${monitorId}\`;
  for (const [bucket, count] of Object.entries(batch)) {
    const current = Number((await redis.hget(key, bucket)) ?? 0);
    await redis.hset(key, bucket, current + Number(count));
  }
  await redis.expire(key, 3600);
  const counts = await redis.hvals(key);
  return counts.reduce((total, count) => total + Number(count), 0);
}

/** Store the reference sketch monitors are compared against; true when this call wrote it. */
export async function freezeBaseline(tenant: string, baselineRef: string, batch: Sketch): Promise<boolean> {
  const key = \`sketch:baseline:\${tenant}:\${baselineRef}\`;
  await redis.del(key);
  await redis.set(key, JSON.stringify(batch));
  return true;
}
`,
      solution: `import Redis from 'ioredis';

/** HINCRBY every (bucket, count) pair of ARGV, expire the hash after ARGV[#ARGV] seconds, return its total. */
export const MERGE_LUA = \`
for i = 1, #ARGV - 1, 2 do
  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
end
redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
local total = 0
for _, count in ipairs(redis.call('HVALS', KEYS[1])) do
  total = total + tonumber(count)
end
return total
\`;

interface SketchRedis extends Redis {
  mergeSketch(key: string, ...args: number[]): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as SketchRedis;
redis.defineCommand('mergeSketch', {numberOfKeys: 1, lua: MERGE_LUA});

/** Bucket id → count. */
export type Sketch = Record<number, number>;

export const windowStart = (now: number, windowS: number): number => Math.floor(now / windowS) * windowS;

export const liveKey = (tenant: string, monitorId: string, window: number): string => \`sketch:live:\${tenant}:\${monitorId}:\${window}\`;

/** Merge a batch of bucket counts into the monitor's sketch for the current window; returns the window's sample count. */
export async function mergeBatch(tenant: string, monitorId: string, windowS: number, batch: Sketch): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const window = windowStart(now, windowS);
  const args = Object.entries(batch)
    .map(([bucket, count]) => [Number(bucket), Number(count)])
    .sort((a, b) => a[0] - b[0])
    .flat();
  args.push(window + windowS - now); // the seconds left in the window: the sketch dies with it
  return Number(await redis.mergeSketch(liveKey(tenant, monitorId, window), ...args));
}

/** Store the reference sketch monitors are compared against; true when this call wrote it. */
export async function freezeBaseline(tenant: string, baselineRef: string, batch: Sketch): Promise<boolean> {
  const key = \`sketch:baseline:\${tenant}:\${baselineRef}\`;
  // A reference is written once, never rebased.
  return (await redis.set(key, JSON.stringify(batch), 'NX')) === 'OK';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// mergeBatch merges a batch of bucket counts into the monitor's sketch for the current window and
// returns the window's sample count.
func mergeBatch(ctx context.Context, tenant, monitorID string, windowS int64, batch map[int]int64) (int64, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := "sketch:live:" + tenant + ":" + monitorID
	for bucket, count := range batch {
		field := strconv.Itoa(bucket)
		current, _ := rdb.HGet(ctx, key, field).Int64()
		if err := rdb.HSet(ctx, key, field, current+count).Err(); err != nil {
			return 0, err
		}
	}
	rdb.Expire(ctx, key, 3600*time.Second)
	var total int64
	for _, count := range rdb.HVals(ctx, key).Val() {
		n, _ := strconv.ParseInt(count, 10, 64)
		total += n
	}
	return total, nil
}

// freezeBaseline stores the reference sketch monitors are compared against; true when this call wrote it.
func freezeBaseline(ctx context.Context, tenant, baselineRef string, batch map[int]int64) (bool, error) {
	key := "sketch:baseline:" + tenant + ":" + baselineRef
	payload, _ := json.Marshal(batch)
	rdb.Del(ctx, key)
	if err := rdb.Set(ctx, key, payload, 0).Err(); err != nil {
		return false, err
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// merge HINCRBYs every (bucket, count) pair of ARGV, expires the hash after ARGV[#ARGV] seconds and returns its total.
var merge = redis.NewScript(\`
for i = 1, #ARGV - 1, 2 do
  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
end
redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
local total = 0
for _, count in ipairs(redis.call('HVALS', KEYS[1])) do
  total = total + tonumber(count)
end
return total
\`)

func windowStart(now, windowS int64) int64 { return now / windowS * windowS }

func liveKey(tenant, monitorID string, window int64) string {
	return fmt.Sprintf("sketch:live:%s:%s:%d", tenant, monitorID, window)
}

// mergeBatch merges a batch of bucket counts into the monitor's sketch for the current window and
// returns the window's sample count.
func mergeBatch(ctx context.Context, tenant, monitorID string, windowS int64, batch map[int]int64) (int64, error) {
	now := time.Now().Unix()
	window := windowStart(now, windowS)
	buckets := make([]int, 0, len(batch))
	for bucket := range batch {
		buckets = append(buckets, bucket)
	}
	sort.Ints(buckets)
	var args []any
	for _, bucket := range buckets {
		args = append(args, bucket, batch[bucket])
	}
	args = append(args, window+windowS-now) // the seconds left in the window: the sketch dies with it
	return merge.Run(ctx, rdb, []string{liveKey(tenant, monitorID, window)}, args...).Int64()
}

// freezeBaseline stores the reference sketch monitors are compared against; true when this call wrote it.
func freezeBaseline(ctx context.Context, tenant, baselineRef string, batch map[int]int64) (bool, error) {
	key := "sketch:baseline:" + tenant + ":" + baselineRef
	payload, _ := json.Marshal(batch)
	return rdb.SetNX(ctx, key, payload, 0).Result() // a reference is written once, never rebased
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** Merge a batch of bucket counts into the monitor's sketch for the current window; returns the window's sample count. */
  def mergeBatch(tenant: String, monitorId: String, windowS: Long, batch: Map[Int, Long]): Long = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = s"sketch:live:$tenant:$monitorId"
    batch.foreach { case (bucket, count) =>
      val current = Option(jedis.hget(key, bucket.toString)).map(_.toLong).getOrElse(0L)
      jedis.hset(key, bucket.toString, (current + count).toString)
    }
    jedis.expire(key, 3600L)
    jedis.hvals(key).asScala.map(_.toLong).sum
  }

  /** Store the reference sketch monitors are compared against; true when this call wrote it. */
  def freezeBaseline(tenant: String, baselineRef: String, batch: Map[Int, Long]): Boolean = {
    val key = s"sketch:baseline:$tenant:$baselineRef"
    jedis.del(key)
    jedis.set(key, JsObject(batch.map { case (bucket, count) => bucket.toString -> JsNumber(count) }).compactPrint)
    true
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

import scala.jdk.CollectionConverters._

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** HINCRBY every (bucket, count) pair of ARGV, expire the hash after ARGV[#ARGV] seconds, return its total. */
  val MergeLua: String =
    """for i = 1, #ARGV - 1, 2 do
      |  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
      |end
      |redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
      |local total = 0
      |for _, count in ipairs(redis.call('HVALS', KEYS[1])) do
      |  total = total + tonumber(count)
      |end
      |return total
      |""".stripMargin

  def windowStart(now: Long, windowS: Long): Long = now / windowS * windowS

  def liveKey(tenant: String, monitorId: String, window: Long): String = s"sketch:live:$tenant:$monitorId:$window"

  /** Merge a batch of bucket counts into the monitor's sketch for the current window; returns the window's sample count. */
  def mergeBatch(tenant: String, monitorId: String, windowS: Long, batch: Map[Int, Long]): Long = {
    val now = System.currentTimeMillis() / 1000
    val window = windowStart(now, windowS)
    val pairs = batch.toSeq.sortBy(_._1).flatMap { case (bucket, count) => Seq(bucket.toString, count.toString) }
    val args = pairs :+ (window + windowS - now).toString // the seconds left in the window: the sketch dies with it
    jedis.eval(MergeLua, List(liveKey(tenant, monitorId, window)).asJava, args.asJava).asInstanceOf[java.lang.Long]
  }

  /** Store the reference sketch monitors are compared against; true when this call wrote it. */
  def freezeBaseline(tenant: String, baselineRef: String, batch: Map[Int, Long]): Boolean = {
    val key = s"sketch:baseline:$tenant:$baselineRef"
    val payload = JsObject(batch.map { case (bucket, count) => bucket.toString -> JsNumber(count) }).compactPrint
    jedis.set(key, payload, SetParams.setParams().nx()) != null // a reference is written once, never rebased
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <map>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

// Bucket id → count.
using Sketch = std::map<int, long>;

// Merge a batch of bucket counts into the monitor's sketch for the current window; returns the
// window's sample count.
long long mergeBatch(const std::string& tenant, const std::string& monitor_id, long window_s, const Sketch& batch) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = "sketch:live:" + tenant + ":" + monitor_id;
  for (const auto& [bucket, count] : batch) {
    const auto current = redis.hget(key, std::to_string(bucket));
    redis.hset(key, std::to_string(bucket), std::to_string((current ? std::stol(*current) : 0) + count));
  }
  redis.expire(key, 3600);
  long long total = 0;
  for (const std::string& count : redis.hvals(key)) total += std::stoll(count);
  return total;
}

// Store the reference sketch monitors are compared against; true when this call wrote it.
bool freezeBaseline(const std::string& tenant, const std::string& baseline_ref, const Sketch& batch) {
  const std::string key = "sketch:baseline:" + tenant + ":" + baseline_ref;
  nlohmann::json payload = nlohmann::json::object();
  for (const auto& [bucket, count] : batch) payload[std::to_string(bucket)] = count;
  redis.del(key);
  redis.set(key, payload.dump());
  return true;
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <map>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

// Bucket id → count.
using Sketch = std::map<int, long>;

// HINCRBY every (bucket, count) pair of ARGV, expire the hash after ARGV[#ARGV] seconds, return its total.
const std::string kMergeLua = R"lua(
for i = 1, #ARGV - 1, 2 do
  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
end
redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
local total = 0
for _, count in ipairs(redis.call('HVALS', KEYS[1])) do
  total = total + tonumber(count)
end
return total
)lua";

long windowStart(long now, long window_s) { return now / window_s * window_s; }

std::string liveKey(const std::string& tenant, const std::string& monitor_id, long window) {
  return "sketch:live:" + tenant + ":" + monitor_id + ":" + std::to_string(window);
}

// Merge a batch of bucket counts into the monitor's sketch for the current window; returns the
// window's sample count.
long long mergeBatch(const std::string& tenant, const std::string& monitor_id, long window_s, const Sketch& batch) {
  const long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long window = windowStart(now, window_s);
  std::vector<std::string> args;
  for (const auto& [bucket, count] : batch) {
    args.push_back(std::to_string(bucket));
    args.push_back(std::to_string(count));
  }
  args.push_back(std::to_string(window + window_s - now));  // the seconds left in the window: the sketch dies with it
  const std::vector<std::string> keys = {liveKey(tenant, monitor_id, window)};
  return redis.eval<long long>(kMergeLua, keys.begin(), keys.end(), args.begin(), args.end());
}

// Store the reference sketch monitors are compared against; true when this call wrote it.
bool freezeBaseline(const std::string& tenant, const std::string& baseline_ref, const Sketch& batch) {
  const std::string key = "sketch:baseline:" + tenant + ":" + baseline_ref;
  nlohmann::json payload = nlohmann::json::object();
  for (const auto& [bucket, count] : batch) payload[std::to_string(bucket)] = count;
  // A reference is written once, never rebased.
  return redis.set(key, payload.dump(), std::chrono::milliseconds(0), sw::redis::UpdateType::NOT_EXIST);
}
`,
    },
  },
  harness: {
    python: `import json

REF = "baseline:v3:2026-10-01"
BASELINE_KEY = f"sketch:baseline:t1:{REF}"


def check_atomic_merge(ctx):
    m = ctx.load("state")
    first = m.merge_batch("t1", "m-1", 300, {1: 5})
    assert first == 5, f"the first batch of 5 samples reported {first!r} samples in the window"
    keys = ctx.redis.keys("sketch:*")
    assert len(keys) == 1, f"one merge left {keys} in Redis, expected one sketch"
    key = keys[0]
    # Another evaluator replica merges its batch between this merge's commands.
    rival = ctx.redis_after(key, lambda: m.merge_batch("t1", "m-1", 300, {1: 7, 2: 1}))
    m.merge_batch("t1", "m-1", 300, {1: 3, 2: 2})
    assert rival.fired, f"the second merge never touched {key}"
    if rival.error is not None:
        raise rival.error
    counts = ctx.redis.hgetall(key)
    assert counts == {"1": "15", "2": "3"}, f"{key} holds {counts} after batches of 5, 7 and 3 in bucket 1 and 1 and 2 in bucket 2, expected 15 and 3: the other replica's increment landed between your read and your write and was overwritten. Merge the batch with HINCRBY inside one script"


def _into_window(ctx, offset):
    """Move the clock to offset seconds into a 300 s window; returns that window's start."""
    now = int(ctx.clock.time())
    if (offset - now) % 300:
        ctx.clock.advance((offset - now) % 300)
    return int(ctx.clock.time()) - offset


def check_window_key(ctx):
    m = ctx.load("state")
    window = _into_window(ctx, 10)
    m.merge_batch("t1", "m-1", 300, {1: 4})
    first = ctx.redis.hgetall(f"sketch:live:t1:m-1:{window}")
    assert first == {"1": "4"}, f"a batch 10 s into window {window} (window_s 300) must land in sketch:live:t1:m-1:{window}, which holds {first}; Redis holds {sorted(ctx.redis.keys('sketch:*'))}"
    ctx.clock.advance(300)
    total = m.merge_batch("t1", "m-1", 300, {2: 6})
    second = ctx.redis.hgetall(f"sketch:live:t1:m-1:{window + 300}")
    assert second == {"2": "6"}, f"the batch 300 s later must start the sketch of window {window + 300}, which holds {second}; Redis holds {sorted(ctx.redis.keys('sketch:*'))}"
    assert total == 6, f"the first batch of window {window + 300} reported {total} samples, expected 6: the new window started with the previous window's counts"


def check_window_ttl(ctx):
    m = ctx.load("state")
    window = _into_window(ctx, 100)
    key = f"sketch:live:t1:m-1:{window}"
    m.merge_batch("t1", "m-1", 300, {1: 4})
    ttl = ctx.redis.ttl(key)
    assert 199 <= ttl <= 200, f"100 s into window {window} the window has 200 s left, but {key} expires in {ttl} s (Redis holds {sorted(ctx.redis.keys('sketch:*'))}): the expiry must be the seconds left in the window"
    ctx.clock.advance(50)
    m.merge_batch("t1", "m-1", 300, {1: 4})
    ttl = ctx.redis.ttl(key)
    assert 149 <= ttl <= 150, f"150 s into the window {key} expires in {ttl} s, expected 150: a later write must not push the expiry past the window's end"
    ctx.clock.advance(150)
    assert ctx.redis.exists(key) == 0, f"the window ended but {key} is still there"


def check_baseline_frozen(ctx):
    m = ctx.load("state")
    assert m.freeze_baseline("t1", REF, {1: 10, 2: 20}) is True, "the first freeze must write the baseline and return True"
    raw = ctx.redis.get(BASELINE_KEY)
    assert raw is not None and json.loads(raw) == {"1": 10, "2": 20}, f"{BASELINE_KEY} holds {raw!r}, expected the JSON object {{\\"1\\": 10, \\"2\\": 20}}"
    again = m.freeze_baseline("t1", REF, {1: 99})
    assert again is False, f"a second freeze of {REF} returned {again!r}, expected False: the reference already exists"
    raw = ctx.redis.get(BASELINE_KEY)
    assert raw is not None and json.loads(raw) == {"1": 10, "2": 20}, f"a second freeze rewrote the baseline to {raw!r}: the monitor is now compared against today's traffic. Write it once (SET NX)"
    assert ctx.redis.ttl(BASELINE_KEY) == -1, "the baseline must not expire"
`,
    typescript: `const REF = 'baseline:v3:2026-10-01';
const BASELINE_KEY = \`sketch:baseline:t1:\${REF}\`;

const sketchKeys = (ctx): string => JSON.stringify((ctx.redis.keys('sketch:*') as string[]).sort());

export async function check_atomic_merge(ctx) {
  const m = ctx.load('state');
  const first = await m.mergeBatch('t1', 'm-1', 300, {1: 5});
  assert.equal(first, 5, \`the first batch of 5 samples reported \${first} samples in the window\`);
  const keys = ctx.redis.keys('sketch:*');
  assert.equal(keys.length, 1, \`one merge left \${JSON.stringify(keys)} in Redis, expected one sketch\`);
  const key = keys[0];
  // Another evaluator replica merges its batch between this merge's commands.
  const rival = ctx.redisAfter(key, () => m.mergeBatch('t1', 'm-1', 300, {1: 7, 2: 1}));
  await m.mergeBatch('t1', 'm-1', 300, {1: 3, 2: 2});
  assert(rival.fired, \`the second merge never touched \${key}\`);
  await rival.result;
  const counts = ctx.redis.hgetall(key);
  assert.deepStrictEqual(counts, {1: '15', 2: '3'}, \`\${key} holds \${JSON.stringify(counts)} after batches of 5, 7 and 3 in bucket 1 and 1 and 2 in bucket 2, expected 15 and 3: the other replica's increment landed between your read and your write and was overwritten. Merge the batch with HINCRBY inside one script\`);
}

/** Move the clock to offset seconds into a 300 s window; returns that window's start. */
function intoWindow(ctx, offset: number): number {
  const now = Math.floor(ctx.clock.now() / 1000);
  const step = (((offset - now) % 300) + 300) % 300;
  if (step > 0) ctx.clock.advance(step);
  return Math.floor(ctx.clock.now() / 1000) - offset;
}

export async function check_window_key(ctx) {
  const m = ctx.load('state');
  const window = intoWindow(ctx, 10);
  await m.mergeBatch('t1', 'm-1', 300, {1: 4});
  const first = ctx.redis.hgetall(\`sketch:live:t1:m-1:\${window}\`);
  assert.deepStrictEqual(first, {1: '4'}, \`a batch 10 s into window \${window} (window_s 300) must land in sketch:live:t1:m-1:\${window}, which holds \${JSON.stringify(first)}; Redis holds \${sketchKeys(ctx)}\`);
  ctx.clock.advance(300);
  const total = await m.mergeBatch('t1', 'm-1', 300, {2: 6});
  const second = ctx.redis.hgetall(\`sketch:live:t1:m-1:\${window + 300}\`);
  assert.deepStrictEqual(second, {2: '6'}, \`the batch 300 s later must start the sketch of window \${window + 300}, which holds \${JSON.stringify(second)}; Redis holds \${sketchKeys(ctx)}\`);
  assert.equal(total, 6, \`the first batch of window \${window + 300} reported \${total} samples, expected 6: the new window started with the previous window's counts\`);
}

export async function check_window_ttl(ctx) {
  const m = ctx.load('state');
  const window = intoWindow(ctx, 100);
  const key = \`sketch:live:t1:m-1:\${window}\`;
  await m.mergeBatch('t1', 'm-1', 300, {1: 4});
  let ttl = ctx.redis.ttl(key);
  assert(ttl >= 199 && ttl <= 200, \`100 s into window \${window} the window has 200 s left, but \${key} expires in \${ttl} s (Redis holds \${sketchKeys(ctx)}): the expiry must be the seconds left in the window\`);
  ctx.clock.advance(50);
  await m.mergeBatch('t1', 'm-1', 300, {1: 4});
  ttl = ctx.redis.ttl(key);
  assert(ttl >= 149 && ttl <= 150, \`150 s into the window \${key} expires in \${ttl} s, expected 150: a later write must not push the expiry past the window's end\`);
  ctx.clock.advance(150);
  assert.equal(ctx.redis.exists(key), 0, \`the window ended but \${key} is still there\`);
}

export async function check_baseline_frozen(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.freezeBaseline('t1', REF, {1: 10, 2: 20}), true, 'the first freeze must write the baseline and return true');
  let raw = ctx.redis.get(BASELINE_KEY);
  assert(raw !== null && JSON.stringify(JSON.parse(raw)) === '{"1":10,"2":20}', \`\${BASELINE_KEY} holds \${JSON.stringify(raw)}, expected the JSON object {"1": 10, "2": 20}\`);
  const again = await m.freezeBaseline('t1', REF, {1: 99});
  assert.equal(again, false, \`a second freeze of \${REF} returned \${again}, expected false: the reference already exists\`);
  raw = ctx.redis.get(BASELINE_KEY);
  assert(raw !== null && JSON.stringify(JSON.parse(raw)) === '{"1":10,"2":20}', \`a second freeze rewrote the baseline to \${JSON.stringify(raw)}: the monitor is now compared against today's traffic. Write it once (SET NX)\`);
  assert.equal(ctx.redis.ttl(BASELINE_KEY), -1, 'the baseline must not expire');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"leetbuild/harness"
)

const (
	ref         = "baseline:v3:2026-10-01"
	baselineKey = "sketch:baseline:t1:" + ref
)

var stateBg = context.Background()

func merged(ctx *harness.Ctx, batch map[int]int64) int64 {
	total, err := mergeBatch(stateBg, "t1", "m-1", 300, batch)
	ctx.NoError(err, "mergeBatch(t1, m-1, 300, %v) failed", batch)
	return total
}

func CheckAtomicMerge(ctx *harness.Ctx) {
	ctx.Equal(merged(ctx, map[int]int64{1: 5}), 5, "the first batch of 5 samples; the window's samples")
	keys := ctx.Redis.Keys("sketch:*")
	ctx.Equal(len(keys), 1, "one merge must leave one sketch in Redis (%q); the keys", keys)
	key := keys[0]
	// Another evaluator replica merges its batch between this merge's commands.
	rival := ctx.Redis.After(key, func() any {
		_, err := mergeBatch(stateBg, "t1", "m-1", 300, map[int]int64{1: 7, 2: 1})
		return err
	})
	merged(ctx, map[int]int64{1: 3, 2: 2})
	ctx.Assert(rival.Fired, "the second merge never touched %s", key)
	ctx.Assert(rival.Result == nil, "the other replica's merge failed: %v", rival.Result)
	ctx.Equal(ctx.Redis.HGetAll(key), map[string]string{"1": "15", "2": "3"}, "%s after batches of 5, 7 and 3 in bucket 1 and 1 and 2 in bucket 2: the other replica's increment landed between your read and your write and was overwritten. Merge the batch with HINCRBY inside one script", key)
}

// intoWindow moves the clock to offset seconds into a 300 s window and returns that window's start.
func intoWindow(ctx *harness.Ctx, offset int64) int64 {
	now := ctx.Clock.Now() / 1000
	if step := ((offset-now)%300 + 300) % 300; step > 0 {
		ctx.Clock.Advance(float64(step))
	}
	return ctx.Clock.Now()/1000 - offset
}

func CheckWindowKey(ctx *harness.Ctx) {
	window := intoWindow(ctx, 10)
	merged(ctx, map[int]int64{1: 4})
	first := fmt.Sprintf("sketch:live:t1:m-1:%d", window)
	ctx.Equal(ctx.Redis.HGetAll(first), map[string]string{"1": "4"}, "a batch 10 s into window %d (window_s 300) must land in %s (Redis holds %q)", window, first, ctx.Redis.Keys("sketch:*"))
	ctx.Clock.Advance(300)
	total := merged(ctx, map[int]int64{2: 6})
	second := fmt.Sprintf("sketch:live:t1:m-1:%d", window+300)
	ctx.Equal(ctx.Redis.HGetAll(second), map[string]string{"2": "6"}, "the batch 300 s later must start the sketch of window %d, %s (Redis holds %q)", window+300, second, ctx.Redis.Keys("sketch:*"))
	ctx.Equal(total, 6, "the first batch of window %d must not count the previous window's samples; the window's samples", window+300)
}

func CheckWindowTtl(ctx *harness.Ctx) {
	window := intoWindow(ctx, 100)
	key := fmt.Sprintf("sketch:live:t1:m-1:%d", window)
	merged(ctx, map[int]int64{1: 4})
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(ttl >= 199 && ttl <= 200, "100 s into window %d the window has 200 s left, but %s expires in %d s (Redis holds %q): the expiry must be the seconds left in the window", window, key, ttl, ctx.Redis.Keys("sketch:*"))
	ctx.Clock.Advance(50)
	merged(ctx, map[int]int64{1: 4})
	ttl = ctx.Redis.TTL(key)
	ctx.Assert(ttl >= 149 && ttl <= 150, "150 s into the window %s expires in %d s, expected 150: a later write must not push the expiry past the window's end", key, ttl)
	ctx.Clock.Advance(150)
	ctx.Equal(ctx.Redis.Exists(key), 0, "the window ended, so %s must be gone; exists", key)
}

func CheckBaselineFrozen(ctx *harness.Ctx) {
	first, err := freezeBaseline(stateBg, "t1", ref, map[int]int64{1: 10, 2: 20})
	ctx.NoError(err, "the first freeze failed")
	ctx.Equal(first, true, "the first freeze must write the baseline; written")
	want := map[string]any{"1": 10, "2": 20}
	stored := func() map[string]any {
		raw, _ := ctx.Redis.Get(baselineKey)
		var out map[string]any
		json.Unmarshal([]byte(raw), &out)
		return out
	}
	ctx.Equal(stored(), want, "%s must hold the JSON object {\\"1\\": 10, \\"2\\": 20}", baselineKey)
	again, err := freezeBaseline(stateBg, "t1", ref, map[int]int64{1: 99})
	ctx.NoError(err, "the second freeze failed")
	ctx.Equal(again, false, "a second freeze of %s must report that the reference already exists; written", ref)
	ctx.Equal(stored(), want, "a second freeze rewrote the baseline: the monitor is now compared against today's traffic. Write it once (SET NX); the baseline")
	ctx.Equal(ctx.Redis.TTL(baselineKey), -1, "the baseline must not expire; its TTL")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <memory>
#include <optional>
#include <string>

namespace {

const std::string kRef = "baseline:v3:2026-10-01";
const std::string kBaselineKey = "sketch:baseline:t1:" + kRef;

std::map<std::string, std::string> hash(const std::map<std::string, std::string>& m) { return m; }

}  // namespace

void CheckAtomicMerge(harness::Ctx& ctx) {
  ctx.Equal(mergeBatch("t1", "m-1", 300, {{1, 5}}), 5, "the first batch of 5 samples; the window's samples");
  const auto keys = ctx.Redis.Keys("sketch:*");
  ctx.Equal(keys.size(), 1, "one merge must leave one sketch in Redis (%q); the keys", keys);
  const std::string key = keys[0];
  // Another evaluator replica merges its batch between this merge's commands.
  auto fired = std::make_shared<bool>(false);
  auto error = std::make_shared<std::optional<std::string>>();
  ctx.Redis.After(key, [fired, error] {
    *fired = true;
    try {
      mergeBatch("t1", "m-1", 300, {{1, 7}, {2, 1}});
    } catch (const std::exception& e) {
      *error = e.what();
    }
  });
  mergeBatch("t1", "m-1", 300, {{1, 3}, {2, 2}});
  ctx.Assert(*fired, "the second merge never touched %s", key);
  ctx.Assert(!*error, "the other replica's merge failed: %s", error->value_or(""));
  ctx.Equal(ctx.Redis.HGetAll(key), hash({{"1", "15"}, {"2", "3"}}), "%s after batches of 5, 7 and 3 in bucket 1 and 1 and 2 in bucket 2: the other replica's increment landed between your read and your write and was overwritten. Merge the batch with HINCRBY inside one script", key);
}

// Move the clock to offset seconds into a 300 s window; returns that window's start.
long intoWindow(harness::Ctx& ctx, long offset) {
  const long now = static_cast<long>(ctx.Clock.Now() / 1000);
  const long step = ((offset - now) % 300 + 300) % 300;
  if (step > 0) ctx.Clock.Advance(static_cast<double>(step));
  return static_cast<long>(ctx.Clock.Now() / 1000) - offset;
}

void CheckWindowKey(harness::Ctx& ctx) {
  const long window = intoWindow(ctx, 10);
  mergeBatch("t1", "m-1", 300, {{1, 4}});
  const std::string first = "sketch:live:t1:m-1:" + std::to_string(window);
  ctx.Equal(ctx.Redis.HGetAll(first), hash({{"1", "4"}}), "a batch 10 s into window %d (window_s 300) must land in %s (Redis holds %q)", window, first, ctx.Redis.Keys("sketch:*"));
  ctx.Clock.Advance(300);
  const long long total = mergeBatch("t1", "m-1", 300, {{2, 6}});
  const std::string second = "sketch:live:t1:m-1:" + std::to_string(window + 300);
  ctx.Equal(ctx.Redis.HGetAll(second), hash({{"2", "6"}}), "the batch 300 s later must start the sketch of window %d, %s (Redis holds %q)", window + 300, second, ctx.Redis.Keys("sketch:*"));
  ctx.Equal(total, 6, "the first batch of window %d must not count the previous window's samples; the window's samples", window + 300);
}

void CheckWindowTtl(harness::Ctx& ctx) {
  const long window = intoWindow(ctx, 100);
  const std::string key = "sketch:live:t1:m-1:" + std::to_string(window);
  mergeBatch("t1", "m-1", 300, {{1, 4}});
  long long ttl = ctx.Redis.TTL(key);
  ctx.Assert(ttl >= 199 && ttl <= 200, "100 s into window %d the window has 200 s left, but %s expires in %d s (Redis holds %q): the expiry must be the seconds left in the window", window, key, ttl, ctx.Redis.Keys("sketch:*"));
  ctx.Clock.Advance(50);
  mergeBatch("t1", "m-1", 300, {{1, 4}});
  ttl = ctx.Redis.TTL(key);
  ctx.Assert(ttl >= 149 && ttl <= 150, "150 s into the window %s expires in %d s, expected 150: a later write must not push the expiry past the window's end", key, ttl);
  ctx.Clock.Advance(150);
  ctx.Equal(ctx.Redis.Exists(key), 0, "the window ended, so %s must be gone; exists", key);
}

void CheckBaselineFrozen(harness::Ctx& ctx) {
  ctx.Equal(freezeBaseline("t1", kRef, {{1, 10}, {2, 20}}), true, "the first freeze must write the baseline; written");
  const nlohmann::json want = {{"1", 10}, {"2", 20}};
  const auto stored = [&ctx] { return nlohmann::json::parse(ctx.Redis.Get(kBaselineKey).value_or("null")); };
  ctx.Equal(stored(), want, "%s must hold the JSON object {\\"1\\": 10, \\"2\\": 20}", kBaselineKey);
  ctx.Equal(freezeBaseline("t1", kRef, {{1, 99}}), false, "a second freeze of %s must report that the reference already exists; written", kRef);
  ctx.Equal(stored(), want, "a second freeze rewrote the baseline: the monitor is now compared against today's traffic. Write it once (SET NX); the baseline");
  ctx.Equal(ctx.Redis.TTL(kBaselineKey), -1, "the baseline must not expire; its TTL");
}
`,
  },
  hints: [
    'Run two evaluator replicas against one monitor and compare their batch totals with the sketch: counts are missing. Look at the sketch an hour into steady traffic: it still holds every sample since the first.',
    'A read in the client and a write back are two commands another replica can land between. The key has no window in it, and an expiry reset to an hour on every write keeps moving away. `DEL` then `SET` overwrites any baseline.',
    'Key the sketch `sketch:live:{tenant}:{monitor_id}:{window}`, merge with one script doing `HINCRBY` per bucket and `EXPIRE` of `window + window_s - now`, and freeze with `SET … NX`.',
  ],
  debrief: `Redis runs a script without interleaving another client's command, so the batch's increments and the expiry land as one change: no replica can read a half-merged sketch or overwrite a count it did not see. Putting the window start into the key is what makes the window real; the expiry only cleans up, and it is set to the window's end so the key dies with the data it holds instead of an hour after the latest write. The baseline is the opposite of a live sketch: written once, without an expiry, and outside every merge, because a reference that changes cannot detect change. Production drift monitors keep sketches with bounded memory (t-digests or fixed bins per feature) and store each window's summary before its key expires.`,
};
