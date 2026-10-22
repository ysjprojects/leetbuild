import type {Step} from '@/lib/types';

export const windowedSketchStep: Step = {
  id: 'state',
  title: 'Redis windowed sketches updated atomically',
  concept: 'redis',
  file: 'state',
  focus: ['monitor', 'redis', 'baseline'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: batches arrive, buckets go up,
and the demo shows a distribution. It hides two multi-window bugs — one that loses counts under
concurrency, one that destroys the reference — and one about time. Review it, fix it, and prove the
fix.

Input distributions are tracked as **windowed sketches** in Redis, one per (tenant, monitor, window),
with the baseline kept apart.

- The **live** sketch key is \`sketch:live:{tenant}:{monitor_id}:{window}\`, where \`window\` is the
  window start (\`floor(now / window_s) * window_s\`). A key without the tenant, the monitor or the
  window mixes unrelated monitors or never resets. The draft uses one \`sketch:{tenant}:{monitor}:{…}\`
  namespace for everything.
- A batch is a list of \`(bucket, count)\` pairs and must be merged by **one atomic Lua \`EVAL\`**: the
  counters are incremented server-side with \`HINCRBY\`, never read and written back from the client.
  The draft does \`HGET\` → add → \`HSET\` per bucket, so two concurrent batches lose counts.
- The **baseline** sketch lives under its own prefix, \`sketch:baseline:{tenant}:{baseline_ref}\`, and a
  live merge must never touch it. The draft writes the baseline into the same mutable namespace as
  live traffic, so last week's reference slowly becomes this week's data and drift stops firing.
- The baseline is **frozen once**: \`freeze_baseline\` uses a write-once set, so a second freeze is a
  no-op rather than a silent overwrite of the reference.
- **Window expiry follows the window boundary exactly**: \`EXPIRE\` is set to
  \`window_end - now\` (\`window_end = window_start + window_s\`), so the key dies when its window's last
  second does. The draft expires it an hour after the first write, which is not a window at all.

**Failure mode the checks target.** A read-modify-write from the client is a lost-update race; a shared
key between the live signal and its own baseline makes the comparison self-referential; a fixed TTL is
not a window. Each one leaves the monitor running, quiet and wrong.`,
  sequence: {
    participants: ['Drift Monitor', 'Redis', 'Baseline sketch'],
    messages: [
      {
        from: 'Drift Monitor',
        to: 'Redis',
        label: 'EVAL merge · KEYS[sketch:live:{tenant}:{monitor}:{window}]',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Drift Monitor', label: '{total, ttl}', kind: 'reply'},
      {from: 'Drift Monitor', to: 'Baseline sketch', label: 'freeze_baseline · SET NX', kind: 'async'},
      {from: 'Baseline sketch', to: 'Drift Monitor', label: 'OK / nil on a second freeze', kind: 'reply'},
      {
        from: 'Drift Monitor',
        to: 'Drift Monitor',
        label: 'EXPIRE = window_end - now, claimed inside the same script',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'atomic-merge',
      title: 'Merges a whole batch with one atomic script',
      detail:
        'Every bucket of a batch is merged inside one `EVAL`/`NewScript` call with `HINCRBY`. The draft reads with `HGET`, adds in the client and writes with `HSET`, so two concurrent batches both read the same value and one increment is lost.',
      match: {
        python: {all: [/MERGE_LUA/, /\.eval\(/, /HINCRBY/]},
        typescript: {all: [/MERGE_LUA/, /\.eval\(/, /HINCRBY/]},
        go: {all: [/(mergeScript|NewScript)/, /\.Run\(/, /HINCRBY/]},
        scala: {all: [/MergeLua/, /\.eval\(/, /HINCRBY/]},
        cpp: {all: [/kMergeLua/, /\.eval</, /HINCRBY/]},
      },
    },
    {
      id: 'live-key',
      title: 'Keys live sketches by tenant, monitor and window',
      detail:
        'The live key is `sketch:live:{tenant}:{monitor_id}:{window}`, built by `live_key`/`liveKey`. A key that drops the monitor, the tenant or the window makes unrelated monitors share a sketch or lets a window never reset.',
      match: {
        python: {all: [/sketch:live:/, /live_key\(/]},
        typescript: {all: [/sketch:live:/, /liveKey\(/]},
        go: {all: [/sketch:live:/, /liveKey\(/]},
        scala: {all: [/sketch:live:/, /liveKey\(/]},
        cpp: {all: [/"sketch:live:"/, /liveKey\(/]},
      },
    },
    {
      id: 'baseline-separate',
      title: 'Keeps the baseline out of the live key space',
      detail:
        'Baseline sketches use their own `sketch:baseline:` prefix, and a merge refuses a key in that space instead of writing into it. The draft puts live and baseline traffic in one mutable key, so the reference drifts with the signal it is supposed to judge.',
      match: {
        python: {all: [/sketch:baseline:/, /BASELINE_PREFIX/, /raise ValueError/]},
        typescript: {all: [/sketch:baseline:/, /BASELINE_PREFIX/, /throw new Error/]},
        go: {all: [/sketch:baseline:/, /baselinePrefix/, /panic\(/]},
        scala: {all: [/sketch:baseline:/, /BaselinePrefix/, /IllegalArgumentException/]},
        cpp: {all: [/"sketch:baseline:"/, /kBaselinePrefix/, /std::invalid_argument/]},
      },
    },
    {
      id: 'baseline-frozen',
      title: 'Freezes the baseline once',
      detail:
        'The baseline is written with a write-once set (`nx=True`, `NX`, `SetNX`, `SetParams…nx()`, `UpdateType::NOT_EXIST`), so a later freeze cannot overwrite the reference. The draft deletes and rewrites the key, so a re-run silently rebases the monitor on the new traffic.',
      match: {
        python: {all: [/freeze_baseline\(/, /nx=True/]},
        typescript: {all: [/freezeBaseline\(/, /['"]NX['"]/]},
        go: {all: [/FreezeBaseline\(/, /SetNX\(/]},
        scala: {all: [/freezeBaseline\(/, /SetParams/]},
        cpp: {all: [/freezeBaseline\(/, /UpdateType::NOT_EXIST/]},
      },
    },
    {
      id: 'window-boundary',
      title: 'Expires the sketch exactly at the window boundary',
      detail:
        'The TTL is `window_end - now`, set by `EXPIRE` inside the merge script, so the key dies when its window ends. The draft expires the key 3600 s after the first write, which drifts out of step with the window it claims to represent.',
      match: {
        python: {all: [/window_end\(/, /EXPIRE/]},
        typescript: {all: [/windowEnd\(/, /EXPIRE/]},
        go: {all: [/windowEnd\(/, /EXPIRE/]},
        scala: {all: [/windowEnd\(/, /EXPIRE/]},
        cpp: {all: [/windowEnd\(/, /EXPIRE/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SKETCH_ROOT = "sketch"


def window(now: int, window_s: int) -> int:
    return now // window_s * window_s


def merge_batch(tenant: str, monitor_id: str, window_start: int, batch: dict[int, int]) -> int:
    # TODO: this draft reads each bucket, adds in the client and writes it back, so two concurrent
    # batches lose counts; it writes live and baseline traffic into one mutable key; and it expires
    # the key an hour after the first write instead of at the window boundary. Review all three.
    key = f"{SKETCH_ROOT}:{tenant}:{monitor_id}:{window_start}"
    total = 0
    for bucket_id, count in batch.items():
        current = int(r.hget(key, bucket_id) or 0)
        r.hset(key, bucket_id, current + count)
        total += current + count
    r.expire(key, 3600)
    return total


def freeze_baseline(tenant: str, baseline_ref: str, batch: dict[int, int]) -> bool:
    key = f"{SKETCH_ROOT}:{tenant}:{baseline_ref}"
    r.delete(key)
    r.hset(key, mapping={str(k): v for k, v in batch.items()})
    return True
`,
      solution: `import json
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LIVE_PREFIX = "sketch:live:"
BASELINE_PREFIX = "sketch:baseline:"

MERGE_LUA = """
local total = 0
for i = 1, #ARGV - 1, 2 do
  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
  total = total + redis.call('HGET', KEYS[1], ARGV[i])
end
redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
return total
"""


def window_start(now: int, window_s: int) -> int:
    return now // window_s * window_s


def window_end(now: int, window_s: int) -> int:
    return window_start(now, window_s) + window_s


def live_key(tenant: str, monitor_id: str, window: int) -> str:
    return f"{LIVE_PREFIX}{tenant}:{monitor_id}:{window}"


def baseline_key(tenant: str, baseline_ref: str) -> str:
    return f"{BASELINE_PREFIX}{tenant}:{baseline_ref}"


def merge_batch(tenant: str, monitor_id: str, window: int, window_s: int, batch: dict[int, int]) -> int:
    """Merge one batch of (bucket, count) pairs into the window's sketch, atomically."""
    key = live_key(tenant, monitor_id, window)
    if key.startswith(BASELINE_PREFIX):
        raise ValueError("baseline sketches are immutable")
    now = int(time.time())
    ttl = max(window_end(now, window_s) - now, 1)
    args: list[int] = []
    for bucket_id, count in batch.items():
        args.extend([bucket_id, count])
    args.append(ttl)
    return int(r.eval(MERGE_LUA, 1, key, *args))


def freeze_baseline(tenant: str, baseline_ref: str, batch: dict[int, int]) -> bool:
    """Freeze the reference once; a later freeze is a no-op, never an overwrite."""
    key = baseline_key(tenant, baseline_ref)
    if key.startswith(LIVE_PREFIX):
        raise ValueError("a baseline sketch never shares the live prefix")
    payload = json.dumps({str(bucket): count for bucket, count in batch.items()})
    return bool(r.set(key, payload, nx=True))
`,
    },
    typescript: {
      starter: `/** Windowed sketches in Redis: a model-generated draft. */
import Redis from 'ioredis';

export const r = new Redis({host: 'redis', port: 6379});

const SKETCH_ROOT = 'sketch';

interface Batch {
  [bucket: string]: number;
}

function window(now: number, windowS: number): number {
  return Math.floor(now / windowS) * windowS;
}

export async function mergeBatch(
  tenant: string,
  monitorId: string,
  windowStart: number,
  batch: Batch,
): Promise<number> {
  // TODO: this draft reads each bucket, adds in the client and writes it back, so two concurrent
  // batches lose counts; it writes live and baseline traffic into one mutable key; and it expires
  // the key an hour after the first write instead of at the window boundary. Review all three.
  const key = SKETCH_ROOT + ':' + tenant + ':' + monitorId + ':' + windowStart;
  let total = 0;
  for (const [bucket, count] of Object.entries(batch)) {
    const current = Number((await r.hget(key, bucket)) ?? 0);
    await r.hset(key, bucket, current + count);
    total += current + count;
  }
  await r.expire(key, 3600);
  return total;
}

export async function freezeBaseline(tenant: string, baselineRef: string, batch: Batch): Promise<boolean> {
  const key = SKETCH_ROOT + ':' + tenant + ':' + baselineRef;
  await r.del(key);
  await r.hset(key, batch);
  return true;
}
`,
      solution: `/** Windowed sketches in Redis: one atomic merge per batch, a frozen baseline. */
import Redis from 'ioredis';

export const r = new Redis({host: 'redis', port: 6379});

const LIVE_PREFIX = 'sketch:live:';
const BASELINE_PREFIX = 'sketch:baseline:';

const MERGE_LUA = \`
local total = 0
for i = 1, #ARGV - 1, 2 do
  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
  total = total + redis.call('HGET', KEYS[1], ARGV[i])
end
redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
return total
\`;

interface Batch {
  [bucket: string]: number;
}

/** Start of the window that contains \`now\`: the bucket every key and TTL is built from. */
export function windowStart(now: number, windowS: number): number {
  return Math.floor(now / windowS) * windowS;
}

/** The instant this window ends; a sketch may live exactly this long. */
export function windowEnd(now: number, windowS: number): number {
  return windowStart(now, windowS) + windowS;
}

export function liveKey(tenant: string, monitorId: string, window: number): string {
  return LIVE_PREFIX + tenant + ':' + monitorId + ':' + window;
}

export function baselineKey(tenant: string, baselineRef: string): string {
  return BASELINE_PREFIX + tenant + ':' + baselineRef;
}

export async function mergeBatch(
  tenant: string,
  monitorId: string,
  window: number,
  windowS: number,
  batch: Batch,
): Promise<number> {
  const key = liveKey(tenant, monitorId, window);
  if (key.startsWith(BASELINE_PREFIX)) throw new Error('baseline sketches are immutable');
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(windowEnd(now, windowS) - now, 1);
  const args: string[] = [];
  for (const [bucket, count] of Object.entries(batch)) args.push(bucket, String(count));
  args.push(String(ttl));
  return (await r.eval(MERGE_LUA, 1, key, ...args)) as number;
}

export async function freezeBaseline(tenant: string, baselineRef: string, batch: Batch): Promise<boolean> {
  const key = baselineKey(tenant, baselineRef);
  if (key.startsWith(LIVE_PREFIX)) throw new Error('a baseline sketch never shares the live prefix');
  const reply = await r.set(key, JSON.stringify(batch), 'NX');
  return reply === 'OK';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const sketchRoot = "sketch"

type Batch map[string]int64

var rdb *redis.Client

func window(now int64, windowS int64) int64 {
	return now / windowS * windowS
}

func sketchKey(parts ...string) string {
	key := sketchRoot
	for _, part := range parts {
		key = key + ":" + part
	}
	return key
}

func mergeBatch(ctx context.Context, tenant, monitorID string, windowStart int64, batch Batch) (int64, error) {
	// TODO: this draft reads each bucket, adds in the client and writes it back, so two concurrent
	// batches lose counts; it writes live and baseline traffic into one mutable key; and it expires
	// the key an hour after the first write instead of at the window boundary. Review all three.
	key := sketchKey(tenant, monitorID, fmt.Sprintf("%d", windowStart))
	var total int64
	for bucket, count := range batch {
		current, _ := rdb.HGet(ctx, key, bucket).Int64()
		rdb.HSet(ctx, key, bucket, current+count)
		total += current + count
	}
	rdb.Expire(ctx, key, time.Hour)
	return total, nil
}

func FreezeBaseline(ctx context.Context, tenant, baselineRef string, batch Batch) (bool, error) {
	key := sketchKey(tenant, baselineRef)
	rdb.Del(ctx, key)
	values := make(map[string]any, len(batch))
	for bucket, count := range batch {
		values[bucket] = count
	}
	rdb.HSet(ctx, key, values)
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	livePrefix     = "sketch:live:"
	baselinePrefix = "sketch:baseline:"
)

type Batch map[string]int64

var rdb *redis.Client

var mergeScript = redis.NewScript(\`
local total = 0
for i = 1, #ARGV - 1, 2 do
  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
  total = total + redis.call('HGET', KEYS[1], ARGV[i])
end
redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
return total
\`)

func windowStart(now, windowS int64) int64 {
	return now / windowS * windowS
}

func windowEnd(now, windowS int64) int64 {
	return windowStart(now, windowS) + windowS
}

func liveKey(tenant, monitorID string, window int64) string {
	return fmt.Sprintf("%s%s:%s:%d", livePrefix, tenant, monitorID, window)
}

func baselineKey(tenant, baselineRef string) string {
	return fmt.Sprintf("%s%s:%s", baselinePrefix, tenant, baselineRef)
}

func mergeBatch(ctx context.Context, tenant, monitorID string, window, windowS int64, batch Batch) (int64, error) {
	key := liveKey(tenant, monitorID, window)
	if strings.HasPrefix(key, baselinePrefix) {
		panic("baseline sketches are immutable")
	}
	now := time.Now().Unix()
	ttl := windowEnd(now, windowS) - now
	if ttl < 1 {
		ttl = 1
	}
	args := make([]any, 0, len(batch)*2+1)
	for bucket, count := range batch {
		args = append(args, bucket, count)
	}
	args = append(args, ttl)
	return mergeScript.Run(ctx, rdb, []string{key}, args...).Int64()
}

func FreezeBaseline(ctx context.Context, tenant, baselineRef string, batch Batch) (bool, error) {
	key := baselineKey(tenant, baselineRef)
	if strings.HasPrefix(key, livePrefix) {
		panic("a baseline sketch never shares the live prefix")
	}
	payload, err := json.Marshal(batch)
	if err != nil {
		return false, err
	}
	return rdb.SetNX(ctx, key, payload, 0).Result()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object SketchStore {
  val SketchRoot = "sketch"

  val jedis = new Jedis("redis", 6379)

  def window(now: Long, windowS: Long): Long = now / windowS * windowS

  def sketchKey(parts: String*): String = (SketchRoot +: parts).mkString(":")

  def mergeBatch(tenant: String, monitorId: String, windowStart: Long, batch: Map[Int, Long]): Long = {
    // TODO: this draft reads each bucket, adds in the client and writes it back, so two concurrent
    // batches lose counts; it writes live and baseline traffic into one mutable key; and it expires
    // the key an hour after the first write instead of at the window boundary. Review all three.
    val key = sketchKey(tenant, monitorId, windowStart.toString)
    var total = 0L
    batch.foreach { case (bucket, count) =>
      val current = Option(jedis.hget(key, bucket.toString)).map(_.toLong).getOrElse(0L)
      jedis.hset(key, bucket.toString, (current + count).toString)
      total += current + count
    }
    jedis.expire(key, 3600)
    total
  }

  def freezeBaseline(tenant: String, baselineRef: String, batch: Map[Int, Long]): Boolean = {
    val key = sketchKey(tenant, baselineRef)
    jedis.del(key)
    val values = batch.map { case (bucket, count) => bucket.toString -> count.toString }
    jedis.hset(key, values)
    true
  }
}
`,
      solution: `import scala.jdk.CollectionConverters._

import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams

object SketchStore {
  val LivePrefix = "sketch:live:"
  val BaselinePrefix = "sketch:baseline:"

  val MergeLua: String =
    """
local total = 0
for i = 1, #ARGV - 1, 2 do
  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
  total = total + redis.call('HGET', KEYS[1], ARGV[i])
end
redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
return total
"""

  val jedis = new Jedis("redis", 6379)

  def windowStart(now: Long, windowS: Long): Long = now / windowS * windowS

  def windowEnd(now: Long, windowS: Long): Long = windowStart(now, windowS) + windowS

  def liveKey(tenant: String, monitorId: String, window: Long): String =
    s"$LivePrefix$tenant:$monitorId:$window"

  def baselineKey(tenant: String, baselineRef: String): String =
    s"$BaselinePrefix$tenant:$baselineRef"

  def mergeBatch(tenant: String, monitorId: String, window: Long, windowS: Long, batch: Map[Int, Long]): Long = {
    val key = liveKey(tenant, monitorId, window)
    if (key.startsWith(BaselinePrefix)) {
      throw new IllegalArgumentException("baseline sketches are immutable")
    }
    val now = System.currentTimeMillis() / 1000
    val ttl = math.max(windowEnd(now, windowS) - now, 1L)
    val args = batch.flatMap { case (bucket, count) => List(bucket.toString, count.toString) }.toList :+ ttl.toString
    jedis.eval(MergeLua, List(key).asJava, args.asJava).asInstanceOf[java.lang.Long].longValue()
  }

  def freezeBaseline(tenant: String, baselineRef: String, batch: Map[Int, Long]): Boolean = {
    val key = baselineKey(tenant, baselineRef)
    if (key.startsWith(LivePrefix)) {
      throw new IllegalArgumentException("a baseline sketch never shares the live prefix")
    }
    val payload = batch.map { case (bucket, count) => s"$bucket=$count" }.mkString(";")
    jedis.set(key, payload, SetParams.setParams().nx()) == "OK"
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <unordered_map>
#include <vector>

using sw::redis::Redis;

const std::string kSketchRoot = "sketch";

Redis redis("tcp://redis:6379");

long window(long now, long windowS) { return now / windowS * windowS; }

std::string sketchKey(const std::vector<std::string>& parts) {
  std::string key = kSketchRoot;
  for (const auto& part : parts) key += ":" + part;
  return key;
}

long mergeBatch(const std::string& tenant,
                const std::string& monitorId,
                long windowStart,
                const std::unordered_map<std::string, long>& batch) {
  // TODO: this draft reads each bucket, adds in the client and writes it back, so two concurrent
  // batches lose counts; it writes live and baseline traffic into one mutable key; and it expires
  // the key an hour after the first write instead of at the window boundary. Review all three.
  const auto key = sketchKey({tenant, monitorId, std::to_string(windowStart)});
  long total = 0;
  for (const auto& [bucket, count] : batch) {
    const auto current = redis.hget(key, bucket).value_or("0");
    redis.hset(key, bucket, std::to_string(std::stol(current) + count));
    total += std::stol(current) + count;
  }
  redis.expire(key, std::chrono::seconds(3600));
  return total;
}

bool freezeBaseline(const std::string& tenant,
                    const std::string& baselineRef,
                    const std::unordered_map<std::string, long>& batch) {
  const auto key = sketchKey({tenant, baselineRef});
  redis.del(key);
  std::unordered_map<std::string, std::string> values;
  for (const auto& [bucket, count] : batch) values[bucket] = std::to_string(count);
  redis.hset(key, values.begin(), values.end());
  return true;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

using sw::redis::Redis;

const std::string kLivePrefix = "sketch:live:";
const std::string kBaselinePrefix = "sketch:baseline:";

const std::string kMergeLua = R"(
local total = 0
for i = 1, #ARGV - 1, 2 do
  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
  total = total + redis.call('HGET', KEYS[1], ARGV[i])
end
redis.call('EXPIRE', KEYS[1], ARGV[#ARGV])
return total
)";

Redis redis("tcp://redis:6379");

long windowStart(long now, long windowS) { return now / windowS * windowS; }

long windowEnd(long now, long windowS) { return windowStart(now, windowS) + windowS; }

std::string liveKey(const std::string& tenant, const std::string& monitorId, long window) {
  return kLivePrefix + tenant + ":" + monitorId + ":" + std::to_string(window);
}

std::string baselineKey(const std::string& tenant, const std::string& baselineRef) {
  return kBaselinePrefix + tenant + ":" + baselineRef;
}

long mergeBatch(const std::string& tenant,
                const std::string& monitorId,
                long window,
                long windowS,
                const std::unordered_map<std::string, long>& batch) {
  const auto key = liveKey(tenant, monitorId, window);
  if (key.rfind(kBaselinePrefix, 0) == 0) {
    throw std::invalid_argument("baseline sketches are immutable");
  }
  const long now =
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long ttl = std::max(windowEnd(now, windowS) - now, 1L);
  std::vector<std::string> args;
  for (const auto& [bucket, count] : batch) {
    args.push_back(bucket);
    args.push_back(std::to_string(count));
  }
  args.push_back(std::to_string(ttl));
  return redis.eval<long>(kMergeLua, {key}, args.begin(), args.end());
}

bool freezeBaseline(const std::string& tenant,
                    const std::string& baselineRef,
                    const std::unordered_map<std::string, long>& batch) {
  const auto key = baselineKey(tenant, baselineRef);
  if (key.rfind(kLivePrefix, 0) == 0) {
    throw std::invalid_argument("a baseline sketch never shares the live prefix");
  }
  std::string payload;
  for (const auto& [bucket, count] : batch) payload += bucket + "=" + std::to_string(count) + ";";
  return redis.set(key, payload, std::chrono::seconds(0), sw::redis::UpdateType::NOT_EXIST);
}
`,
    },
  },
  hints: [
    'The script must do the whole batch on the server: pass the `(bucket, count)` pairs as `ARGV` and let Lua run `HINCRBY` per bucket, returning the merged total. `HGET` followed by `HSET` in the client leaves a window between the two commands where another batch reads the same value.',
    'Two key spaces, never one: `sketch:live:{tenant}:{monitor_id}:{window}` for traffic and `sketch:baseline:{tenant}:{ref}` for the reference. The live path should refuse a key in the baseline space, and `freeze_baseline` should write once (`nx`) so a re-run cannot rebase the monitor on today’s traffic.',
    'A window key must die with its window. Compute `window_end = window_start + window_s` and pass `window_end - now` as the TTL into the same script, so the key expires exactly when its window does instead of an hour after the first batch.',
  ],
  debrief: `This step is about the two ways a drift monitor lies to itself. The first is concurrency: a
client-side read-modify-write over sketch buckets loses increments whenever two batches for the same
window land together, so the distribution that gets evaluated is not the distribution that arrived —
the fix is one \`EVAL\` per batch with \`HINCRBY\` on the server. The second is the reference: writing the
baseline into the same mutable key as live traffic turns the monitor into a comparison of the signal
with itself, and over a few windows nothing can ever be detected. Separate prefixes plus a write-once
freeze keep the reference a reference. The third is time: a TTL of 3600 s after the first write is not
a window, so keys overlap and windows never line up with the buckets being compared; the TTL has to be
computed from the boundary. Real deployments add Cuckoo or t-digest sketches with serialized merge,
per-feature namespaces, and a compaction job that archives expired windows.`,
};
