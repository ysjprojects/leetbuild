import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis aggregation windows with atomic merges',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: batches arrive, the window
counters move, and the dashboard shows series totals. It hides a crash that leaves half a batch
applied, an expiry that lags its window by hours, and a redelivery that counts twice. Review it, fix
it, and prove the fix with the checks below.

Implement \`merge_batch(tenant, batch)\`, the call the API makes once a batch of per-series deltas has
been accepted:

- A batch carries its \`batch_id\`, the time it was \`recorded_at\`, and its \`(series, delta)\`
  samples. Every delta belongs to the window that contains the batch time:
  \`window_start = floor(recorded_at / WINDOW_SECONDS) * WINDOW_SECONDS\`, with **\`WINDOW_SECONDS =
  60\`**.
- Each counter lives in its own key, \`metrics:{tenant}:{series}:{window_start}\`, built by
  \`window_key\` from the tenant, the series and the boundary — a key that drops the series mixes
  unrelated counters, and a key that drops the boundary never rolls over.
- The **whole batch merges in one atomic Lua \`EVAL\`**: every delta is incremented server-side in a
  single script, so a crash leaves the batch applied or absent, never half of it. The draft sends
  one \`INCRBY\` per sample from the client, and a crash between two of them leaves a partial batch
  that downstream rollups cannot distinguish from real data.
- The window key **expires exactly at its boundary**: the script sets \`EXPIRE\` to
  \`window_start + WINDOW_SECONDS - now\` on the first write (\`TTL\` < 0 means the key just opened).
  The draft never expires at write time — a cleanup job sweeps hours later — so a closed window
  stays readable next to live ones.
- A **redelivered batch is a no-op**: claim the batch id with \`SET NX\` (\`nx=True\`, \`'NX'\`,
  \`SetNX\`, \`nx()\`, \`UpdateType::NOT_EXIST\`) on \`metrics:batch:{batch_id}\`, with a \`WINDOW_TTL\`
  lifetime, before merging, and skip the merge when the claim is refused. The draft keeps no batch
  id, so an at-least-once redelivery adds the same samples twice.

**Failure mode the checks target.** One \`INCRBY\` per sample is a partial batch waiting for a crash;
a TTL set by a sweeper that runs hours later is not a window boundary; and a merge without a batch
id silently doubles the series when the broker redelivers.`,
  sequence: {
    participants: ['Metrics API', 'Redis', 'Rollup worker'],
    messages: [
      {from: 'Metrics API', to: 'Redis', label: 'SET metrics:batch:{id} 1 NX EX 600 — claim first', kind: 'sync'},
      {from: 'Redis', to: 'Metrics API', label: 'nil: already applied, merge skipped', kind: 'reply'},
      {from: 'Metrics API', to: 'Redis', label: 'EVAL merge · INCRBY metrics:{tenant}:{series}:{window}', kind: 'sync'},
      {from: 'Redis', to: 'Metrics API', label: '{applied: 3, ttl: 41} — all deltas or none', kind: 'reply'},
      {
        from: 'Rollup worker',
        to: 'Redis',
        label: 'MGET metrics:{tenant}:*:{window} once the window closes',
        kind: 'async',
      },
    ],
  },
  hints: [
    'The whole batch belongs in one script: pass every counter key as `KEYS` and every delta as `ARGV`, and let Lua run the `INCRBY` loop next to the expiry in a single `EVAL`. One client-side `INCRBY` per sample means a crash between two of them leaves half the batch applied, and nothing downstream can tell which half.',
    'The deadline comes from the boundary, not from the write: compute `window_start + WINDOW_SECONDS - now` and pass it into the script, which sets `EXPIRE` only while `TTL` is negative (the key just opened). A cleanup job that sweeps hours later leaves a closed window sitting next to live ones, so a rollup reads yesterday as today.',
    "A redelivered batch must be a no-op: claim `metrics:batch:{batch_id}` with `SET NX` (`nx=True`, `'NX'`, `SetNX`, `nx()`, `UpdateType::NOT_EXIST`) and a `WINDOW_TTL` lifetime before merging — a refused claim means the batch was already applied, so return without touching a counter.",
  ],
  checks: [
    {
      id: 'window-key',
      title: 'Keys by tenant, series and the window boundary',
      detail:
        'The counter key is `metrics:{tenant}:{series}:{window_start}`, built by `window_key` from the tenant, the series and the boundary returned by `window_start`. A key that drops the series mixes unrelated counters, and a key that drops the boundary never rolls over.',
      match: {
        python: {all: [/WINDOW_SECONDS/, /window_key\(/, /window_start\(/, /metrics:/]},
        typescript: {all: [/WINDOW_SECONDS/, /windowKey\(/, /windowStart\(/, /metrics:/]},
        go: {all: [/windowSeconds/, /windowKey\(/, /windowStart\(/, /metrics:/]},
        scala: {all: [/WindowSeconds/, /windowKey\(/, /windowStart\(/, /metrics:/]},
        cpp: {all: [/kWindowSeconds/, /window_key\(/, /window_start\(/, /"metrics:"/]},
      },
    },
    {
      id: 'atomic-merge',
      title: 'Merges the whole batch in one atomic script',
      detail:
        'Every delta of the batch is applied inside one `EVAL`/`NewScript` call, so a crash leaves the batch applied or absent, never half of it. The draft sends one client-side `INCRBY` per sample, and a crash between two of them leaves a partial batch that downstream rollups cannot distinguish from real data.',
      match: {
        python: {all: [/MERGE_LUA/, /\.eval\(/, /INCRBY/]},
        typescript: {all: [/MERGE_LUA/, /\.eval\(/, /INCRBY/]},
        go: {all: [/(mergeScript|NewScript)/, /\.Run\(/, /INCRBY/]},
        scala: {all: [/MergeLua/, /\.eval\(/, /INCRBY/]},
        cpp: {all: [/kMergeLua/, /\.eval</, /INCRBY/]},
      },
    },
    {
      id: 'window-expiry',
      title: 'Expires the key at its window boundary',
      detail:
        'Inside the merge script the key gets `EXPIRE` when `TTL` is negative, set to `window_start + WINDOW_SECONDS - now`, so a key lives exactly until the end of the window it counts. The draft expires nothing at write time — a cleanup job sweeps hours later — so a closed window is still there long past its boundary.',
      match: {
        python: {all: [/WINDOW_SECONDS/, /redis\.call\('EXPIRE'/, /redis\.call\('TTL'/]},
        typescript: {all: [/WINDOW_SECONDS/, /redis\.call\('EXPIRE'/, /redis\.call\('TTL'/]},
        go: {all: [/windowSeconds/, /redis\.call\('EXPIRE'/, /redis\.call\('TTL'/]},
        scala: {all: [/WindowSeconds/, /redis\.call\('EXPIRE'/, /redis\.call\('TTL'/]},
        cpp: {all: [/kWindowSeconds/, /redis\.call\('EXPIRE'/, /redis\.call\('TTL'/]},
      },
    },
    {
      id: 'dedupe-batch-id',
      title: 'Claims the batch id before merging',
      detail:
        'The batch id is recorded with a write-once set (`nx=True`, `NX`, `SetNX`, `SetParams…nx()`, `UpdateType::NOT_EXIST`) on `metrics:batch:{batch_id}` before the merge runs, so a redelivered batch is claimed once and applied once. The draft has no batch-id key, so the same batch counts twice.',
      match: {
        python: {all: [/metrics:batch:/, /batch_id/, /nx=True/], order: [/nx=True/, /\.eval\(/]},
        typescript: {all: [/metrics:batch:/, /batchId/, /['"]NX['"]/], order: [/['"]NX['"]/, /\.eval\(/]},
        go: {all: [/metrics:batch:/, /BatchID/, /SetNX\(/], order: [/SetNX\(/, /\.Run\(/]},
        scala: {all: [/metrics:batch:/, /batchId/, /SetParams/], order: [/SetParams/, /\.eval\(/]},
        cpp: {
          all: [/metrics:batch:/, /batch_id/, /UpdateType::NOT_EXIST/],
          order: [/UpdateType::NOT_EXIST/, /\.eval</],
        },
      },
    },
    {
      id: 'no-partial-writes',
      title: 'No per-sample INCRBY left in the merge path',
      detail:
        'No client-side `incrby`/`incrBy`/`IncrBy` call per sample remains: every counter moves inside the script, where the batch is already atomic. A single client call per sample is the half-applied batch the checks are about, even when each call on its own is correct.',
      match: {
        python: {none: [/\.incrby\(/]},
        typescript: {none: [/\.incrby\(/]},
        go: {none: [/\.IncrBy\(/]},
        scala: {none: [/\.incrBy\(/]},
        cpp: {none: [/\.incrby\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""merge_batch: a model-generated draft that sends one INCRBY per sample."""
from dataclasses import dataclass

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_SECONDS = 60
WINDOW_TTL = 600


@dataclass
class Sample:
    series: str
    delta: int


@dataclass
class Batch:
    batch_id: str
    recorded_at: int
    samples: list[Sample]


def window_start(now: int) -> int:
    return now // WINDOW_SECONDS * WINDOW_SECONDS


def window_key(tenant: str, series: str, start: int) -> str:
    return f"metrics:{tenant}:{series}:{start}"


def merge_batch(tenant: str, batch: Batch) -> dict:
    # TODO: this draft sends one INCRBY per sample from the client, so a crash mid-batch leaves a
    # partial merge; it never expires a window at write time (only a sweeper that runs hours later
    # does); and it has no batch-id claim, so a redelivered batch is applied twice. Review all three.
    start = window_start(batch.recorded_at)
    applied = 0
    for sample in batch.samples:
        r.incrby(window_key(tenant, sample.series, start), sample.delta)
        applied += 1
    return {"applied": applied, "window_start": start}


def sweep_closed_windows(tenant: str) -> int:
    """Cleanup job: the sweep runs every few hours, so keys outlive their window."""
    swept = 0
    for key in r.scan_iter(match=f"metrics:{tenant}:*"):
        if r.ttl(key) < 0:
            r.expire(key, WINDOW_TTL)
            swept += 1
    return swept
`,
      solution: `"""merge_batch: one atomic script per batch, a boundary-aligned expiry, a batch-id claim."""
import time
from dataclasses import dataclass

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_SECONDS = 60
WINDOW_TTL = 600

MERGE_LUA = """
local ttl = ARGV[#KEYS + 1]
for i = 1, #KEYS do
  redis.call('INCRBY', KEYS[i], ARGV[i])
  if redis.call('TTL', KEYS[i]) < 0 then
    redis.call('EXPIRE', KEYS[i], ttl)
  end
end
return #KEYS
"""


@dataclass
class Sample:
    series: str
    delta: int


@dataclass
class Batch:
    batch_id: str
    recorded_at: int
    samples: list[Sample]


def window_start(now: int) -> int:
    """The first second of the window that contains the given time."""
    return now // WINDOW_SECONDS * WINDOW_SECONDS


def window_key(tenant: str, series: str, start: int) -> str:
    """One counter per (tenant, series, window); rollups sum them per window."""
    return f"metrics:{tenant}:{series}:{start}"


def batch_key(batch_id: str) -> str:
    """The claim that makes a redelivered batch a no-op."""
    return f"metrics:batch:{batch_id}"


def merge_batch(tenant: str, batch: Batch) -> dict:
    """Merge a whole batch atomically; a batch already applied is skipped."""
    claimed = r.set(batch_key(batch.batch_id), "1", nx=True, ex=WINDOW_TTL)
    if not claimed:
        return {"applied": 0, "duplicate": True}
    start = window_start(batch.recorded_at)
    now = int(time.time())
    ttl = max(start + WINDOW_SECONDS - now, 1)
    keys = [window_key(tenant, sample.series, start) for sample in batch.samples]
    deltas = [sample.delta for sample in batch.samples]
    applied = int(r.eval(MERGE_LUA, len(keys), *keys, *deltas, ttl))
    return {"applied": applied, "duplicate": False, "window_start": start}
`,
    },
    typescript: {
      starter: `/** mergeBatch: a model-generated draft that sends one INCRBY per sample. */
import {Redis} from 'ioredis';

const r = new Redis({host: 'redis', port: 6379});

const WINDOW_SECONDS = 60;
const WINDOW_TTL = 600;

export interface Sample {
  series: string;
  delta: number;
}

export interface Batch {
  batchId: string;
  recordedAt: number;
  samples: Sample[];
}

export function windowStart(now: number): number {
  return Math.floor(now / WINDOW_SECONDS) * WINDOW_SECONDS;
}

export function windowKey(tenant: string, series: string, start: number): string {
  return \`metrics:\${tenant}:\${series}:\${start}\`;
}

export async function mergeBatch(tenant: string, batch: Batch): Promise<{applied: number; window_start: number}> {
  // TODO: this draft sends one INCRBY per sample from the client, so a crash mid-batch leaves a
  // partial merge; it never expires a window at write time (only a sweeper that runs hours later
  // does); and it has no batch-id claim, so a redelivered batch is applied twice. Review all three.
  const start = windowStart(batch.recordedAt);
  let applied = 0;
  for (const sample of batch.samples) {
    await r.incrby(windowKey(tenant, sample.series, start), sample.delta);
    applied += 1;
  }
  return {applied, window_start: start};
}

/** Cleanup job: the sweep runs every few hours, so keys outlive their window. */
export async function sweepClosedWindows(tenant: string): Promise<number> {
  let swept = 0;
  for (const key of await r.keys(\`metrics:\${tenant}:*\`)) {
    if ((await r.ttl(key)) < 0) {
      await r.expire(key, WINDOW_TTL);
      swept += 1;
    }
  }
  return swept;
}
`,
      solution: `/** mergeBatch: one atomic script per batch, a boundary-aligned expiry, a batch-id claim. */
import {Redis} from 'ioredis';

const r = new Redis({host: 'redis', port: 6379});

const WINDOW_SECONDS = 60;
const WINDOW_TTL = 600;

const MERGE_LUA = \`
local ttl = ARGV[#KEYS + 1]
for i = 1, #KEYS do
  redis.call('INCRBY', KEYS[i], ARGV[i])
  if redis.call('TTL', KEYS[i]) < 0 then
    redis.call('EXPIRE', KEYS[i], ttl)
  end
end
return #KEYS
\`;

export interface Sample {
  series: string;
  delta: number;
}

export interface Batch {
  batchId: string;
  recordedAt: number;
  samples: Sample[];
}

/** The first second of the window that contains \`now\`. */
export function windowStart(now: number): number {
  return Math.floor(now / WINDOW_SECONDS) * WINDOW_SECONDS;
}

/** One counter per (tenant, series, window); rollups sum them per window. */
export function windowKey(tenant: string, series: string, start: number): string {
  return \`metrics:\${tenant}:\${series}:\${start}\`;
}

/** The claim that makes a redelivered batch a no-op. */
export function batchKey(batchId: string): string {
  return \`metrics:batch:\${batchId}\`;
}

export async function mergeBatch(
  tenant: string,
  batch: Batch,
): Promise<{applied: number; duplicate: boolean; window_start: number}> {
  const claimed = await r.set(batchKey(batch.batchId), '1', 'NX', 'EX', String(WINDOW_TTL));
  if (claimed !== 'OK') return {applied: 0, duplicate: true, window_start: 0};
  const start = windowStart(batch.recordedAt);
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(start + WINDOW_SECONDS - now, 1);
  const keys = batch.samples.map(sample => windowKey(tenant, sample.series, start));
  const deltas = batch.samples.map(sample => String(sample.delta));
  const applied = (await r.eval(MERGE_LUA, keys.length, ...keys, ...deltas, String(ttl))) as number;
  return {applied, duplicate: false, window_start: start};
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

const (
	windowSeconds = 60
	windowTtl     = 600
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Sample struct {
	Series string
	Delta  int64
}

type Batch struct {
	BatchID    string
	RecordedAt int64
	Samples    []Sample
}

func windowStart(now int64) int64 {
	return now / windowSeconds * windowSeconds
}

func windowKey(tenant, series string, start int64) string {
	return fmt.Sprintf("metrics:%s:%s:%d", tenant, series, start)
}

func mergeBatch(ctx context.Context, tenant string, batch Batch) (int, error) {
	// TODO: this draft sends one INCRBY per sample from the client, so a crash mid-batch leaves a
	// partial merge; it never expires a window at write time (only a sweeper that runs hours later
	// does); and it has no batch-id claim, so a redelivered batch is applied twice. Review all three.
	start := windowStart(batch.RecordedAt)
	for _, sample := range batch.Samples {
		if err := rdb.IncrBy(ctx, windowKey(tenant, sample.Series, start), sample.Delta).Err(); err != nil {
			return 0, err
		}
	}
	return len(batch.Samples), nil
}

// sweepClosedWindows is the cleanup job: it runs hours later, so keys outlive their window.
func sweepClosedWindows(ctx context.Context, tenant string) (int, error) {
	keys, _ := rdb.Keys(ctx, fmt.Sprintf("metrics:%s:*", tenant)).Result()
	swept := 0
	for _, key := range keys {
		if ttl, _ := rdb.TTL(ctx, key).Result(); ttl < 0 {
			rdb.Expire(ctx, key, windowTtl*time.Second)
			swept++
		}
	}
	return swept, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	windowSeconds = 60
	windowTtl     = 600
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// mergeScript increments every counter of the batch and opens the window's expiry.
var mergeScript = redis.NewScript(\`
local ttl = ARGV[#KEYS + 1]
for i = 1, #KEYS do
  redis.call('INCRBY', KEYS[i], ARGV[i])
  if redis.call('TTL', KEYS[i]) < 0 then
    redis.call('EXPIRE', KEYS[i], ttl)
  end
end
return #KEYS
\`)

type Sample struct {
	Series string
	Delta  int64
}

type Batch struct {
	BatchID    string
	RecordedAt int64
	Samples    []Sample
}

// windowStart is the first second of the window that contains now.
func windowStart(now int64) int64 {
	return now / windowSeconds * windowSeconds
}

// windowKey is one counter per (tenant, series, window); rollups sum them per window.
func windowKey(tenant, series string, start int64) string {
	return fmt.Sprintf("metrics:%s:%s:%d", tenant, series, start)
}

// batchKey is the claim that makes a redelivered batch a no-op.
func batchKey(batchID string) string {
	return fmt.Sprintf("metrics:batch:%s", batchID)
}

// mergeBatch applies the whole batch in one script; a batch already applied is skipped.
func mergeBatch(ctx context.Context, tenant string, batch Batch) (int, bool, error) {
	claimed, err := rdb.SetNX(ctx, batchKey(batch.BatchID), "1", windowTtl*time.Second).Result()
	if err != nil {
		return 0, false, err
	}
	if !claimed {
		return 0, true, nil
	}
	start := windowStart(batch.RecordedAt)
	now := time.Now().Unix()
	ttl := start + windowSeconds - now
	if ttl < 1 {
		ttl = 1
	}
	keys := make([]string, 0, len(batch.Samples))
	args := make([]any, 0, len(batch.Samples)+1)
	for _, sample := range batch.Samples {
		keys = append(keys, windowKey(tenant, sample.Series, start))
		args = append(args, sample.Delta)
	}
	args = append(args, ttl)
	applied, err := mergeScript.Run(ctx, rdb, keys, args...).Int()
	if err != nil {
		return 0, false, err
	}
	return applied, false, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object MetricsStore {
  val WindowSeconds = 60L
  val WindowTtl = 600L

  val jedis = new Jedis("redis", 6379)

  final case class Sample(series: String, delta: Long)
  final case class Batch(batchId: String, recordedAt: Long, samples: List[Sample])

  def windowStart(now: Long): Long = now / WindowSeconds * WindowSeconds

  def windowKey(tenant: String, series: String, start: Long): String = s"metrics:$tenant:$series:$start"

  def mergeBatch(tenant: String, batch: Batch): Map[String, Long] = {
    // TODO: this draft sends one INCRBY per sample from the client, so a crash mid-batch leaves a
    // partial merge; it never expires a window at write time (only a sweeper that runs hours later
    // does); and it has no batch-id claim, so a redelivered batch is applied twice. Review all three.
    val start = windowStart(batch.recordedAt)
    batch.samples.foreach { sample =>
      jedis.incrBy(windowKey(tenant, sample.series, start), sample.delta)
    }
    Map("applied" -> batch.samples.size.toLong, "window_start" -> start)
  }

  // sweepClosedWindows is the cleanup job: it runs hours later, so keys outlive their window.
  def sweepClosedWindows(tenant: String): Long = {
    import scala.jdk.CollectionConverters._
    var swept = 0L
    jedis.keys(s"metrics:$tenant:*").asScala.foreach { key =>
      if (jedis.ttl(key) < 0) {
        jedis.expire(key, WindowTtl)
        swept += 1
      }
    }
    swept
  }
}
`,
      solution: `import scala.jdk.CollectionConverters._

import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams

object MetricsStore {
  val WindowSeconds = 60L
  val WindowTtl = 600L

  val MergeLua: String =
    """
local ttl = ARGV[#KEYS + 1]
for i = 1, #KEYS do
  redis.call('INCRBY', KEYS[i], ARGV[i])
  if redis.call('TTL', KEYS[i]) < 0 then
    redis.call('EXPIRE', KEYS[i], ttl)
  end
end
return #KEYS
"""

  val jedis = new Jedis("redis", 6379)

  final case class Sample(series: String, delta: Long)
  final case class Batch(batchId: String, recordedAt: Long, samples: List[Sample])

  /** The first second of the window that contains now. */
  def windowStart(now: Long): Long = now / WindowSeconds * WindowSeconds

  /** One counter per (tenant, series, window); rollups sum them per window. */
  def windowKey(tenant: String, series: String, start: Long): String = s"metrics:$tenant:$series:$start"

  /** The claim that makes a redelivered batch a no-op. */
  def batchKey(batchId: String): String = s"metrics:batch:$batchId"

  /** Merge a whole batch atomically; a batch already applied is skipped. */
  def mergeBatch(tenant: String, batch: Batch): Map[String, Long] = {
    val claimed = jedis.set(batchKey(batch.batchId), "1", SetParams.setParams().nx().ex(WindowTtl))
    if (claimed != "OK") {
      Map("applied" -> 0L, "duplicate" -> 1L)
    } else {
      val start = windowStart(batch.recordedAt)
      val now = System.currentTimeMillis() / 1000
      val ttl = math.max(start + WindowSeconds - now, 1L)
      val keys = batch.samples.map(sample => windowKey(tenant, sample.series, start))
      val args = batch.samples.map(sample => sample.delta.toString) :+ ttl.toString
      val applied = jedis.eval(MergeLua, keys.asJava, args.asJava).asInstanceOf[java.lang.Long].longValue()
      Map("applied" -> applied, "duplicate" -> 0L, "window_start" -> start)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <string>
#include <vector>

using sw::redis::Redis;

constexpr long long kWindowSeconds = 60;
constexpr long long kWindowTtl = 600;

Redis redis("tcp://redis:6379");

struct Sample {
  std::string series;
  long long delta;
};

struct Batch {
  std::string batch_id;
  long long recorded_at;
  std::vector<Sample> samples;
};

long long window_start(long long now) { return now / kWindowSeconds * kWindowSeconds; }

std::string window_key(const std::string& tenant, const std::string& series, long long start) {
  return "metrics:" + tenant + ":" + series + ":" + std::to_string(start);
}

int merge_batch(const std::string& tenant, const Batch& batch) {
  // TODO: this draft sends one INCRBY per sample from the client, so a crash mid-batch leaves a
  // partial merge; it never expires a window at write time (only a sweeper that runs hours later
  // does); and it has no batch-id claim, so a redelivered batch is applied twice. Review all three.
  const auto start = window_start(batch.recorded_at);
  for (const auto& sample : batch.samples) {
    redis.incrby(window_key(tenant, sample.series, start), sample.delta);
  }
  return static_cast<int>(batch.samples.size());
}

// sweep_closed_windows is the cleanup job: it runs hours later, so keys outlive their window.
long long sweep_closed_windows(const std::string& tenant) {
  std::vector<std::string> keys;
  redis.keys("metrics:" + tenant + ":*", std::back_inserter(keys));
  long long swept = 0;
  for (const auto& key : keys) {
    if (redis.ttl(key) < 0) {
      redis.expire(key, std::chrono::seconds(kWindowTtl));
      swept += 1;
    }
  }
  return swept;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <string>
#include <vector>

using sw::redis::Redis;

constexpr long long kWindowSeconds = 60;
constexpr long long kWindowTtl = 600;

const std::string kMergeLua = R"(
local ttl = ARGV[#KEYS + 1]
for i = 1, #KEYS do
  redis.call('INCRBY', KEYS[i], ARGV[i])
  if redis.call('TTL', KEYS[i]) < 0 then
    redis.call('EXPIRE', KEYS[i], ttl)
  end
end
return #KEYS
)";

Redis redis("tcp://redis:6379");

struct Sample {
  std::string series;
  long long delta;
};

struct Batch {
  std::string batch_id;
  long long recorded_at;
  std::vector<Sample> samples;
};

// window_start is the first second of the window that contains now.
long long window_start(long long now) { return now / kWindowSeconds * kWindowSeconds; }

// window_key is one counter per (tenant, series, window); rollups sum them per window.
std::string window_key(const std::string& tenant, const std::string& series, long long start) {
  return "metrics:" + tenant + ":" + series + ":" + std::to_string(start);
}

// batch_key is the claim that makes a redelivered batch a no-op.
std::string batch_key(const std::string& batch_id) { return "metrics:batch:" + batch_id; }

// merge_batch applies the whole batch in one script; a batch already applied is skipped.
int merge_batch(const std::string& tenant, const Batch& batch) {
  const bool claimed = redis.set(
      batch_key(batch.batch_id), "1", std::chrono::seconds(kWindowTtl), sw::redis::UpdateType::NOT_EXIST);
  if (!claimed) {
    return 0;
  }
  const long long start = window_start(batch.recorded_at);
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(
                            std::chrono::system_clock::now().time_since_epoch())
                            .count();
  const long long ttl = std::max(start + kWindowSeconds - now, 1LL);
  std::vector<std::string> keys;
  std::vector<std::string> args;
  for (const auto& sample : batch.samples) {
    keys.push_back(window_key(tenant, sample.series, start));
    args.push_back(std::to_string(sample.delta));
  }
  args.push_back(std::to_string(ttl));
  return static_cast<int>(redis.eval<long long>(kMergeLua, keys.begin(), keys.end(), args.begin(), args.end()));
}
`,
    },
  },
  debrief: `The lesson is that an aggregation window is an atomic unit of work. A batch that lands half-applied is worse than one that never landed: downstream rollups cannot tell a partial window from a real one, so the numbers are quietly wrong and there is no error to find. One Lua \`EVAL\` per batch makes every merge all-or-nothing, and the same script opens the window's expiry, so the key dies at its boundary instead of whenever a sweeper notices — a deadline that belongs to the window, not to the write. Dedupe by batch id closes the other half: brokers deliver at least once, so the merge must be idempotent per batch, and \`SET NX\` on \`metrics:batch:{batch_id}\` before any counter moves turns a redelivery into a no-op. Real pipelines go one step further and make the claim part of the same transaction as the merge — the guard is the script's first step — so a crash between the two cannot swallow a batch; they also keep longer-lived window archives for rollups that run after expiry, and hash-tag keys so every counter of one tenant-window lands on the same Redis cluster slot.`,
};
