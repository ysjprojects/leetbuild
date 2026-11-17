import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis window merges: one script, one claim, one expiry',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry', 'idempotent-requests'],
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is \`merge_batch(tenant, batch_id, samples)\`, the call
\`POST /v1/metrics\` makes for an accepted batch: per sample it finds the window (\`window_start\`,
\`metrics.model\`), adds 1 to \`count\` and the value to \`sum\` of the hash \`win:{series}:{start}\`
(\`HINCRBY\`, \`HINCRBYFLOAT\`) and indexes the key in \`idx:{tenant}:{metric}\` (\`ZADD\`, scored by
the start). It serves the demo and hides 4 flaws.

**Failure mode the checks target.** Two tenants reporting the same series add into one counter; a
worker that dies mid-batch leaves half of it in the windows; closed windows stay in Redis forever;
and a batch the sender retries after a timeout is counted twice.

- The window key is \`win:{tenant}:{series}:{start}\`.
- One Lua script, \`MERGE_LUA\`, applies the whole batch. KEYS: \`batch_key(tenant, batch_id)\`
  (\`batch:{tenant}:{batch_id}\`), then a window key and an index key per sample. ARGV:
  \`CLAIM_TTL_SECONDS\` (86400), \`WINDOW_SECONDS + RETENTION_SECONDS\`, then each sample's start and
  value.
- The script first claims the batch key with \`SET … NX EX\`; when it already exists the script
  returns 0 and \`merge_batch\` returns \`False\`.
- Each window key gets \`EXPIREAT start + WINDOW_SECONDS + RETENTION_SECONDS\`: it lives a day after
  its window closes, however often it is written.`,
  sequence: {
    participants: ['metricsd', 'Redis', 'Dashboard read'],
    messages: [
      {
        from: 'metricsd',
        to: 'Redis',
        label: 'EVAL MERGE_LUA batch:{t}:{id} win:… idx:… · ttl · starts · values',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'SET batch NX EX 86400 · else return 0', kind: 'sync'},
      {
        from: 'Redis',
        to: 'Redis',
        label: 'HINCRBY count · HINCRBYFLOAT sum · EXPIREAT · ZADD, per sample',
        kind: 'sync',
      },
      {from: 'Redis', to: 'metricsd', label: '1 applied · 0 already applied', kind: 'reply'},
      {from: 'Dashboard read', to: 'Redis', label: 'sees the whole batch or none of it', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'window-key',
      title: 'Keys a window by tenant, series and start',
      detail:
        'The window hash is `win:{tenant}:{series}:{start}`; the starter drops the tenant, so two tenants that report the same series share one counter.',
      match: {
        python: {
          all: [/def window_key\(\s*tenant/, /f"win:\{tenant\}:\{series\}:\{start\}"/],
          none: [/f"win:\{series\}/],
        },
        typescript: {
          all: [/windowKey\s*=\s*\(\s*tenant/, /`win:\$\{tenant\}:\$\{series\}:\$\{start\}`/],
          none: [/`win:\$\{series\}/],
        },
        go: {
          all: [/func windowKey\(\s*tenant/, /"win:"\s*\+\s*tenant\s*\+|"win:%s:%s:%d",\s*tenant/],
          none: [/"win:"\s*\+\s*series/],
        },
        scala: {all: [/def windowKey\(\s*tenant/, /s"win:\$tenant:\$series:\$start"/], none: [/s"win:\$series/]},
        cpp: {
          all: [/windowKey\(\s*const std::string& tenant/, /"win:"\s*\+\s*tenant\s*\+/],
          none: [/"win:"\s*\+\s*series/],
        },
      },
    },
    {
      id: 'atomic-merge',
      title: 'Applies the whole batch in one script',
      detail:
        'Every sample moves inside one Lua script (`EVAL`, `register_script`, `NewScript`), so a reader or a crash sees the batch whole or not at all, and each window ends with its exact `count` and `sum`, indexed at its start. The starter sends client-side `HINCRBY`/`HINCRBYFLOAT`/`ZADD` per sample, and a reader between two of them sees part of a batch.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /MERGE_LUA/], none: [/\br\.hincrby(float)?\(/, /\br\.zadd\(/]},
        typescript: {
          all: [/\.eval\(|defineCommand\(/, /MERGE_LUA/],
          none: [/redis\.hincrby(float)?\(/, /redis\.zadd\(/],
        },
        go: {all: [/redis\.NewScript\(|\.Eval\(/], none: [/\.HIncrBy(Float)?\(/, /\.ZAdd\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /MergeLua/], none: [/jedis\.hincrBy(Float)?\(/, /jedis\.zadd\(/]},
        cpp: {all: [/\.eval(sha)?[<(]/, /kMergeLua/], none: [/\.hincrby(float)?\(/, /\.zadd\(/]},
      },
    },
    {
      id: 'window-ttl',
      title: 'Expires a window a day after it closes',
      detail:
        'The script sets `EXPIREAT start + WINDOW_SECONDS + RETENTION_SECONDS` on each window key, an absolute instant a later write cannot push back. The starter sets no expiry, so every window ever written stays in memory.',
      match: {
        python: {all: [/redis\.call\(\s*['"]EXPIREAT['"]/, /RETENTION_SECONDS/]},
        typescript: {all: [/redis\.call\(\s*['"]EXPIREAT['"]/, /RETENTION_SECONDS/]},
        go: {all: [/redis\.call\(\s*['"]EXPIREAT['"]/, /model\.RetentionSeconds/]},
        scala: {all: [/redis\.call\(\s*['"]EXPIREAT['"]/, /RetentionSeconds/]},
        cpp: {all: [/redis\.call\(\s*['"]EXPIREAT['"]/, /kRetentionSeconds/]},
      },
    },
    {
      id: 'dedupe-batch',
      title: 'Claims the batch id inside the script',
      detail:
        'The script first claims `batch:{tenant}:{batch_id}` with `SET … NX EX` and returns 0 when it is already there, so a redelivered batch is applied once and `merge_batch` returns false; a claim made by the client before the script would be lost with a crash between the two. The starter has no batch key.',
      match: {
        python: {all: [/redis\.call\(\s*['"]SET['"][^\n]*['"]NX['"]/, /f"batch:\{tenant\}:\{batch_id\}"/]},
        typescript: {all: [/redis\.call\(\s*['"]SET['"][^\n]*['"]NX['"]/, /`batch:\$\{tenant\}:\$\{batchId\}`/]},
        go: {all: [/redis\.call\(\s*['"]SET['"][^\n]*['"]NX['"]/, /"batch:"\s*\+\s*tenant/]},
        scala: {all: [/redis\.call\(\s*['"]SET['"][^\n]*['"]NX['"]/, /s"batch:\$tenant:\$batchId"/]},
        cpp: {all: [/redis\.call\(\s*['"]SET['"][^\n]*['"]NX['"]/, /"batch:"\s*\+\s*tenant/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from metrics.model import RETENTION_SECONDS, WINDOW_SECONDS, series_id, window_start

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def window_key(series: str, start: int) -> str:
    return f"win:{series}:{start}"


def index_key(tenant: str, metric: str) -> str:
    return f"idx:{tenant}:{metric}"


def merge_batch(tenant: str, batch_id: str, samples: list) -> bool:
    """Add every sample of the batch to its window; True when the batch was applied."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    for sample in samples:
        start = window_start(sample["timestamp"])
        key = window_key(series_id(sample["metric"], sample["labels"]), start)
        r.hincrby(key, "count", 1)
        r.hincrbyfloat(key, "sum", sample["value"])
        r.zadd(index_key(tenant, sample["metric"]), {key: start})
    return True
`,
      solution: `import redis

from metrics.model import RETENTION_SECONDS, WINDOW_SECONDS, series_id, window_start

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CLAIM_TTL_SECONDS = 86400

# KEYS[1] claims the batch; then a (window key, index key) pair per sample, with (start, value) in ARGV.
MERGE_LUA = """
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 0 end
for i = 2, #KEYS, 2 do
  local start = tonumber(ARGV[i + 1])
  redis.call('HINCRBY', KEYS[i], 'count', 1)
  redis.call('HINCRBYFLOAT', KEYS[i], 'sum', ARGV[i + 2])
  redis.call('EXPIREAT', KEYS[i], start + tonumber(ARGV[2]))
  redis.call('ZADD', KEYS[i + 1], start, KEYS[i])
end
return 1
"""
merge = r.register_script(MERGE_LUA)


def window_key(tenant: str, series: str, start: int) -> str:
    return f"win:{tenant}:{series}:{start}"


def index_key(tenant: str, metric: str) -> str:
    return f"idx:{tenant}:{metric}"


def batch_key(tenant: str, batch_id: str) -> str:
    return f"batch:{tenant}:{batch_id}"


def merge_batch(tenant: str, batch_id: str, samples: list) -> bool:
    """Add every sample of the batch to its window, once and atomically; False when the batch was applied before."""
    keys = [batch_key(tenant, batch_id)]
    args = [CLAIM_TTL_SECONDS, WINDOW_SECONDS + RETENTION_SECONDS]
    for sample in samples:
        start = window_start(sample["timestamp"])
        keys += [window_key(tenant, series_id(sample["metric"], sample["labels"]), start), index_key(tenant, sample["metric"])]
        args += [start, sample["value"]]
    return merge(keys=keys, args=args) == 1
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {RETENTION_SECONDS, type Sample, WINDOW_SECONDS, seriesId, windowStart} from 'metrics/model';

const redis = new Redis({host: 'redis', port: 6379});

export const windowKey = (series: string, start: number): string => \`win:\${series}:\${start}\`;
export const indexKey = (tenant: string, metric: string): string => \`idx:\${tenant}:\${metric}\`;

/** Add every sample of the batch to its window; true when the batch was applied. */
export async function mergeBatch(tenant: string, batchId: string, samples: Sample[]): Promise<boolean> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  for (const s of samples) {
    const start = windowStart(s.timestamp);
    const key = windowKey(seriesId(s.metric, s.labels), start);
    await redis.hincrby(key, 'count', 1);
    await redis.hincrbyfloat(key, 'sum', s.value);
    await redis.zadd(indexKey(tenant, s.metric), start, key);
  }
  return true;
}
`,
      solution: `import Redis from 'ioredis';

import {RETENTION_SECONDS, type Sample, WINDOW_SECONDS, seriesId, windowStart} from 'metrics/model';

const redis = new Redis({host: 'redis', port: 6379});

export const CLAIM_TTL_SECONDS = 86400;

/** KEYS[1] claims the batch; then a (window key, index key) pair per sample, with (start, value) in ARGV. */
export const MERGE_LUA = \`
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 0 end
for i = 2, #KEYS, 2 do
  local start = tonumber(ARGV[i + 1])
  redis.call('HINCRBY', KEYS[i], 'count', 1)
  redis.call('HINCRBYFLOAT', KEYS[i], 'sum', ARGV[i + 2])
  redis.call('EXPIREAT', KEYS[i], start + tonumber(ARGV[2]))
  redis.call('ZADD', KEYS[i + 1], start, KEYS[i])
end
return 1
\`;

export const windowKey = (tenant: string, series: string, start: number): string => \`win:\${tenant}:\${series}:\${start}\`;
export const indexKey = (tenant: string, metric: string): string => \`idx:\${tenant}:\${metric}\`;
export const batchKey = (tenant: string, batchId: string): string => \`batch:\${tenant}:\${batchId}\`;

/** Add every sample of the batch to its window, once and atomically; false when the batch was applied before. */
export async function mergeBatch(tenant: string, batchId: string, samples: Sample[]): Promise<boolean> {
  const keys = [batchKey(tenant, batchId)];
  const args: (string | number)[] = [CLAIM_TTL_SECONDS, WINDOW_SECONDS + RETENTION_SECONDS];
  for (const s of samples) {
    const start = windowStart(s.timestamp);
    keys.push(windowKey(tenant, seriesId(s.metric, s.labels), start), indexKey(tenant, s.metric));
    args.push(start, s.value);
  }
  return (await redis.eval(MERGE_LUA, keys.length, ...keys, ...args)) === 1;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"metrics/model" // model.Sample, SeriesID, WindowStart, WindowSeconds, RetentionSeconds
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func windowKey(series string, start int64) string {
	return "win:" + series + ":" + strconv.FormatInt(start, 10)
}

func indexKey(tenant, metric string) string { return "idx:" + tenant + ":" + metric }

// mergeBatch adds every sample of the batch to its window; true when the batch was applied.
func mergeBatch(ctx context.Context, tenant, batchID string, samples []model.Sample) (bool, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	for _, s := range samples {
		start := model.WindowStart(s.Timestamp)
		key := windowKey(model.SeriesID(s.Metric, s.Labels), start)
		if err := rdb.HIncrBy(ctx, key, "count", 1).Err(); err != nil {
			return false, err
		}
		if err := rdb.HIncrByFloat(ctx, key, "sum", s.Value).Err(); err != nil {
			return false, err
		}
		if err := rdb.ZAdd(ctx, indexKey(tenant, s.Metric), redis.Z{Score: float64(start), Member: key}).Err(); err != nil {
			return false, err
		}
	}
	return true, nil
}
`,
      solution: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"metrics/model" // model.Sample, SeriesID, WindowStart, WindowSeconds, RetentionSeconds
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const claimTTLSeconds = 86400

// merge claims KEYS[1], then applies a (window key, index key) pair per sample, with (start, value) in ARGV.
var merge = redis.NewScript(\`
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 0 end
for i = 2, #KEYS, 2 do
  local start = tonumber(ARGV[i + 1])
  redis.call('HINCRBY', KEYS[i], 'count', 1)
  redis.call('HINCRBYFLOAT', KEYS[i], 'sum', ARGV[i + 2])
  redis.call('EXPIREAT', KEYS[i], start + tonumber(ARGV[2]))
  redis.call('ZADD', KEYS[i + 1], start, KEYS[i])
end
return 1
\`)

func windowKey(tenant, series string, start int64) string {
	return "win:" + tenant + ":" + series + ":" + strconv.FormatInt(start, 10)
}

func indexKey(tenant, metric string) string { return "idx:" + tenant + ":" + metric }

func batchKey(tenant, batchID string) string { return "batch:" + tenant + ":" + batchID }

// mergeBatch adds every sample of the batch to its window, once and atomically; false when the batch was applied before.
func mergeBatch(ctx context.Context, tenant, batchID string, samples []model.Sample) (bool, error) {
	keys := []string{batchKey(tenant, batchID)}
	args := []any{claimTTLSeconds, model.WindowSeconds + model.RetentionSeconds}
	for _, s := range samples {
		start := model.WindowStart(s.Timestamp)
		keys = append(keys, windowKey(tenant, model.SeriesID(s.Metric, s.Labels), start), indexKey(tenant, s.Metric))
		args = append(args, start, strconv.FormatFloat(s.Value, 'f', -1, 64))
	}
	applied, err := merge.Run(ctx, rdb, keys, args...).Int64()
	return applied == 1, err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import metrics.Model.{RetentionSeconds, Sample, WindowSeconds, seriesId, windowStart}

object State {
  val jedis = new JedisPooled("redis", 6379)

  def windowKey(series: String, start: Long): String = s"win:$series:$start"
  def indexKey(tenant: String, metric: String): String = s"idx:$tenant:$metric"

  /** Add every sample of the batch to its window; true when the batch was applied. */
  def mergeBatch(tenant: String, batchId: String, samples: Seq[Sample]): Boolean = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    samples.foreach { s =>
      val start = windowStart(s.timestamp)
      val key = windowKey(seriesId(s.metric, s.labels), start)
      jedis.hincrBy(key, "count", 1)
      jedis.hincrByFloat(key, "sum", s.value)
      jedis.zadd(indexKey(tenant, s.metric), start.toDouble, key)
    }
    true
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import metrics.Model.{RetentionSeconds, Sample, WindowSeconds, seriesId, windowStart}

object State {
  val jedis = new JedisPooled("redis", 6379)

  val ClaimTtlSeconds = 86400L

  /** KEYS[1] claims the batch; then a (window key, index key) pair per sample, with (start, value) in ARGV. */
  val MergeLua: String =
    """if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 0 end
      |for i = 2, #KEYS, 2 do
      |  local start = tonumber(ARGV[i + 1])
      |  redis.call('HINCRBY', KEYS[i], 'count', 1)
      |  redis.call('HINCRBYFLOAT', KEYS[i], 'sum', ARGV[i + 2])
      |  redis.call('EXPIREAT', KEYS[i], start + tonumber(ARGV[2]))
      |  redis.call('ZADD', KEYS[i + 1], start, KEYS[i])
      |end
      |return 1
      |""".stripMargin

  def windowKey(tenant: String, series: String, start: Long): String = s"win:$tenant:$series:$start"
  def indexKey(tenant: String, metric: String): String = s"idx:$tenant:$metric"
  def batchKey(tenant: String, batchId: String): String = s"batch:$tenant:$batchId"

  /** Add every sample of the batch to its window, once and atomically; false when the batch was applied before. */
  def mergeBatch(tenant: String, batchId: String, samples: Seq[Sample]): Boolean = {
    val keys = batchKey(tenant, batchId) +: samples.flatMap { s =>
      Seq(windowKey(tenant, seriesId(s.metric, s.labels), windowStart(s.timestamp)), indexKey(tenant, s.metric))
    }
    val args = Seq(ClaimTtlSeconds.toString, (WindowSeconds + RetentionSeconds).toString) ++
      samples.flatMap(s => Seq(windowStart(s.timestamp).toString, s.value.toString))
    jedis.eval(MergeLua, keys.asJava, args.asJava).asInstanceOf[java.lang.Long] == 1L
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

#include "metrics/model.h"  // metrics::Sample, seriesId, windowStart, kWindowSeconds, kRetentionSeconds

sw::redis::Redis& stateRedis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

std::string windowKey(const std::string& series, long long start) { return "win:" + series + ":" + std::to_string(start); }

std::string indexKey(const std::string& tenant, const std::string& metric) { return "idx:" + tenant + ":" + metric; }

// Add every sample of the batch to its window; true when the batch was applied.
bool mergeBatch(const std::string& tenant, const std::string& batch_id, const std::vector<metrics::Sample>& samples) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  for (const metrics::Sample& s : samples) {
    const long long start = metrics::windowStart(s.timestamp);
    const std::string key = windowKey(metrics::seriesId(s.metric, s.labels), start);
    stateRedis().hincrby(key, "count", 1);
    stateRedis().hincrbyfloat(key, "sum", s.value);
    stateRedis().zadd(indexKey(tenant, s.metric), key, static_cast<double>(start));
  }
  return true;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <sstream>
#include <string>
#include <vector>

#include "metrics/model.h"  // metrics::Sample, seriesId, windowStart, kWindowSeconds, kRetentionSeconds

constexpr long long kClaimTtlSeconds = 86400;

// KEYS[1] claims the batch; then a (window key, index key) pair per sample, with (start, value) in ARGV.
const std::string kMergeLua = R"lua(
if not redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1]) then return 0 end
for i = 2, #KEYS, 2 do
  local start = tonumber(ARGV[i + 1])
  redis.call('HINCRBY', KEYS[i], 'count', 1)
  redis.call('HINCRBYFLOAT', KEYS[i], 'sum', ARGV[i + 2])
  redis.call('EXPIREAT', KEYS[i], start + tonumber(ARGV[2]))
  redis.call('ZADD', KEYS[i + 1], start, KEYS[i])
end
return 1
)lua";

sw::redis::Redis& stateRedis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

std::string windowKey(const std::string& tenant, const std::string& series, long long start) {
  return "win:" + tenant + ":" + series + ":" + std::to_string(start);
}

std::string indexKey(const std::string& tenant, const std::string& metric) { return "idx:" + tenant + ":" + metric; }

std::string batchKey(const std::string& tenant, const std::string& batch_id) { return "batch:" + tenant + ":" + batch_id; }

// Add every sample of the batch to its window, once and atomically; false when the batch was applied before.
bool mergeBatch(const std::string& tenant, const std::string& batch_id, const std::vector<metrics::Sample>& samples) {
  std::vector<std::string> keys = {batchKey(tenant, batch_id)};
  std::vector<std::string> args = {std::to_string(kClaimTtlSeconds), std::to_string(metrics::kWindowSeconds + metrics::kRetentionSeconds)};
  for (const metrics::Sample& s : samples) {
    const long long start = metrics::windowStart(s.timestamp);
    keys.push_back(windowKey(tenant, metrics::seriesId(s.metric, s.labels), start));
    keys.push_back(indexKey(tenant, s.metric));
    std::ostringstream value;
    value.precision(17);
    value << s.value;
    args.push_back(std::to_string(start));
    args.push_back(value.str());
  }
  return stateRedis().eval<long long>(kMergeLua, keys, args) == 1;
}
`,
    },
  },
  harness: {
    python: `import time

from metrics.model import series_id, window_start


def _sample(host="a", value=1.0, ago=5):
    return {"metric": "http_requests", "labels": {"host": host}, "timestamp": int(time.time()) - ago, "value": value}


def _key(tenant, s):
    return f"win:{tenant}:{series_id(s['metric'], s['labels'])}:{window_start(s['timestamp'])}"


def _total(ctx):
    return sum(int(ctx.redis.hget(key, "count") or 0) for key in ctx.redis.keys("win:*"))


def check_window_key(ctx):
    m = ctx.load("state")
    s = _sample()
    m.merge_batch("acme", "b-1", [s])
    m.merge_batch("globex", "b-1", [s])
    keys = sorted(ctx.redis.keys("win:*"))
    want = sorted([_key("acme", s), _key("globex", s)])
    assert keys == want, f"acme and globex each sent one sample of the same series and Redis holds {keys}, expected {want}: without the tenant in the key their counters add up"
    for key in want:
        assert ctx.redis.hget(key, "count") == "1", f"{key} counts {ctx.redis.hget(key, 'count')} samples, expected 1"


def check_atomic_merge(ctx):
    m = ctx.load("state")
    batch = [_sample("a", 1.5), _sample("a", 2.25), _sample("b", 4.0, ago=35)]
    seen = ctx.redis_after("idx:acme:http_requests", lambda: _total(ctx))
    applied = m.merge_batch("acme", "b-1", batch)
    assert seen.fired, "merge_batch never indexed the batch under idx:acme:http_requests"
    assert seen.result in (0, 3), f"a reader that looked while the batch was being merged saw {seen.result} of its 3 samples: a crash at that moment leaves exactly that much. Apply the batch in one script"
    assert applied is True and _total(ctx) == 3, f"after the merge the windows count {_total(ctx)} samples (merge_batch returned {applied!r}), expected 3"
    for s, count, total in ((batch[0], "2", 3.75), (batch[2], "1", 4.0)):
        key = _key("acme", s)
        stored = ctx.redis.hgetall(key)
        assert stored.get("count") == count and float(stored.get("sum", "nan")) == total, f"{key} holds {stored}, expected count {count} and sum {total}: each sample adds its exact value"
        score = ctx.redis.zscore("idx:acme:http_requests", key)
        assert score == window_start(s["timestamp"]), f"idx:acme:http_requests scores {key} at {score}, expected its window start {window_start(s['timestamp'])}"


def check_window_ttl(ctx):
    m = ctx.load("state")
    s, older = _sample(ago=5), _sample("b", ago=35)
    m.merge_batch("acme", "b-1", [s, older])
    keys = {int(k.rsplit(":", 1)[1]): k for k in ctx.redis.keys("win:*")}
    assert len(keys) == 2, f"two samples in two windows wrote the window keys {sorted(keys.values())}"
    for w in (s, older):
        key = keys.get(window_start(w["timestamp"]), "")
        expected = window_start(w["timestamp"]) + 10 + 86400 - int(time.time())
        ttl = ctx.redis.ttl(key)
        assert abs(ttl - expected) <= 1, f"{key} has TTL {ttl}, expected {expected}: a window lives a day after it closes (EXPIREAT start + WINDOW_SECONDS + RETENTION_SECONDS)"
    key = keys[window_start(s["timestamp"])]
    expected = window_start(s["timestamp"]) + 10 + 86400 - int(time.time())
    ctx.clock.advance(4)
    m.merge_batch("acme", "b-2", [s])
    ttl = ctx.redis.ttl(key)
    assert abs(ttl - (expected - 4)) <= 1, f"4 s later another write moved the TTL of {key} to {ttl}, expected {expected - 4}: the expiry is an instant fixed by the window, not a day after the last write"


def check_dedupe_batch(ctx):
    m = ctx.load("state")
    batch = [_sample("a", 1.0), _sample("b", 2.0)]
    claimed = ctx.redis_after("batch:acme:b-1", lambda: _total(ctx))
    assert m.merge_batch("acme", "b-1", batch) is True, "the first delivery of batch b-1 must be applied (True)"
    assert claimed.fired, "merge_batch never claimed batch:acme:b-1"
    assert claimed.result == 2, f"the moment batch:acme:b-1 was claimed the windows held {claimed.result} of its 2 samples: a crash right after a claim made outside the script loses the batch, and its retry is refused. Claim inside the script"
    again = m.merge_batch("acme", "b-1", batch)
    assert _total(ctx) == 2, f"batch b-1 delivered twice left {_total(ctx)} samples in the windows, expected 2: a redelivered batch is applied once"
    assert again is False, f"the redelivery of batch b-1 returned {again!r}, expected False"
    ttl = ctx.redis.ttl("batch:acme:b-1")
    assert 86398 <= ttl <= 86400, f"batch:acme:b-1 has TTL {ttl}, expected the claim to last CLAIM_TTL_SECONDS, a day (SET … NX EX 86400)"
    assert m.merge_batch("acme", "b-2", batch) is True and _total(ctx) == 4, f"a new batch id must be applied; the windows count {_total(ctx)}"
    assert m.merge_batch("globex", "b-1", batch) is True, "batch ids are per tenant: globex's b-1 is a different batch"
`,
    typescript: `function setup(ctx) {
  return {m: ctx.load('state'), model: ctx.load('/support/metrics/model.ts')};
}

const sample = (ctx, host = 'a', value = 1, ago = 5) => ({
  metric: 'http_requests',
  labels: {host},
  timestamp: Math.floor(ctx.clock.now() / 1000) - ago,
  value,
});

const keyOf = (model, tenant: string, s) => \`win:\${tenant}:\${model.seriesId(s.metric, s.labels)}:\${model.windowStart(s.timestamp)}\`;

const total = ctx => (ctx.redis.keys('win:*') as string[]).reduce((n, key) => n + Number(ctx.redis.hget(key, 'count') ?? 0), 0);

export async function check_window_key(ctx) {
  const {m, model} = setup(ctx);
  const s = sample(ctx);
  await m.mergeBatch('acme', 'b-1', [s]);
  await m.mergeBatch('globex', 'b-1', [s]);
  const keys = (ctx.redis.keys('win:*') as string[]).sort();
  const want = [keyOf(model, 'acme', s), keyOf(model, 'globex', s)].sort();
  assert.deepStrictEqual(keys, want, \`acme and globex each sent one sample of the same series and Redis holds \${JSON.stringify(keys)}: without the tenant in the key their counters add up\`);
  for (const key of want) assert.equal(ctx.redis.hget(key, 'count'), '1', \`\${key} must count 1 sample\`);
}

export async function check_atomic_merge(ctx) {
  const {m, model} = setup(ctx);
  const batch = [sample(ctx, 'a', 1.5), sample(ctx, 'a', 2.25), sample(ctx, 'b', 4, 35)];
  const seen = ctx.redisAfter('idx:acme:http_requests', () => total(ctx));
  const applied = await m.mergeBatch('acme', 'b-1', batch);
  assert(seen.fired, 'mergeBatch never indexed the batch under idx:acme:http_requests');
  assert(seen.result === 0 || seen.result === 3, \`a reader that looked while the batch was being merged saw \${seen.result} of its 3 samples: a crash at that moment leaves exactly that much. Apply the batch in one script\`);
  assert(applied === true && total(ctx) === 3, \`after the merge the windows count \${total(ctx)} samples (mergeBatch resolved \${applied}), expected 3\`);
  for (const [s, count, sum] of [[batch[0], '2', 3.75], [batch[2], '1', 4]] as const) {
    const key = keyOf(model, 'acme', s);
    const stored = ctx.redis.hgetall(key);
    assert(stored.count === count && Number(stored.sum) === sum, \`\${key} holds \${JSON.stringify(stored)}, expected count \${count} and sum \${sum}: each sample adds its exact value\`);
    const score = ctx.redis.zscore('idx:acme:http_requests', key);
    assert(score !== null && Number(score) === model.windowStart(s.timestamp), \`idx:acme:http_requests scores \${key} at \${score}, expected its window start \${model.windowStart(s.timestamp)}\`);
  }
}

export async function check_window_ttl(ctx) {
  const {m, model} = setup(ctx);
  const s = sample(ctx);
  const older = sample(ctx, 'b', 1, 35);
  await m.mergeBatch('acme', 'b-1', [s, older]);
  const keys = new Map((ctx.redis.keys('win:*') as string[]).map(k => [Number(k.slice(k.lastIndexOf(':') + 1)), k]));
  assert.equal(keys.size, 2, \`two samples in two windows wrote the window keys \${JSON.stringify([...keys.values()])}\`);
  const now = Math.floor(ctx.clock.now() / 1000);
  for (const w of [s, older]) {
    const key = keys.get(model.windowStart(w.timestamp)) ?? '';
    const want = model.windowStart(w.timestamp) + 10 + 86400 - now;
    const got = ctx.redis.ttl(key) as number;
    assert(Math.abs(got - want) <= 1, \`\${key} has TTL \${got}, expected \${want}: a window lives a day after it closes (EXPIREAT start + WINDOW_SECONDS + RETENTION_SECONDS)\`);
  }
  const key = keys.get(model.windowStart(s.timestamp)) as string;
  const expected = model.windowStart(s.timestamp) + 10 + 86400 - now;
  ctx.clock.advance(4);
  await m.mergeBatch('acme', 'b-2', [s]);
  const ttl = ctx.redis.ttl(key) as number;
  assert(Math.abs(ttl - (expected - 4)) <= 1, \`4 s later another write moved the TTL of \${key} to \${ttl}, expected \${expected - 4}: the expiry is an instant fixed by the window, not a day after the last write\`);
}

export async function check_dedupe_batch(ctx) {
  const {m} = setup(ctx);
  const batch = [sample(ctx, 'a', 1), sample(ctx, 'b', 2)];
  const claimed = ctx.redisAfter('batch:acme:b-1', () => total(ctx));
  assert.equal(await m.mergeBatch('acme', 'b-1', batch), true, 'the first delivery of batch b-1 must be applied (true)');
  assert(claimed.fired, 'mergeBatch never claimed batch:acme:b-1');
  assert.equal(claimed.result, 2, \`the moment batch:acme:b-1 was claimed the windows held \${claimed.result} of its 2 samples: a crash right after a claim made outside the script loses the batch, and its retry is refused. Claim inside the script\`);
  const again = await m.mergeBatch('acme', 'b-1', batch);
  assert.equal(total(ctx), 2, \`batch b-1 delivered twice left \${total(ctx)} samples in the windows, expected 2: a redelivered batch is applied once\`);
  assert.equal(again, false, \`the redelivery of batch b-1 resolved \${again}, expected false\`);
  const ttl = ctx.redis.ttl('batch:acme:b-1') as number;
  assert(ttl >= 86398 && ttl <= 86400, \`batch:acme:b-1 has TTL \${ttl}, expected the claim to last CLAIM_TTL_SECONDS, a day (SET … NX EX 86400)\`);
  assert((await m.mergeBatch('acme', 'b-2', batch)) === true && total(ctx) === 4, \`a new batch id must be applied; the windows count \${total(ctx)}\`);
  assert.equal(await m.mergeBatch('globex', 'b-1', batch), true, "batch ids are per tenant: globex's b-1 is a different batch");
}
`,
    go: `package main

import (
	"context"
	"strconv"
	"strings"

	"metrics/model"

	"leetbuild/harness"
)

var stateBg = context.Background()

func stateSample(ctx *harness.Ctx, host string, value float64, ago int64) model.Sample {
	return model.Sample{Metric: "http_requests", Labels: map[string]string{"host": host}, Timestamp: ctx.Clock.Now()/1000 - ago, Value: value}
}

func stateKey(tenant string, s model.Sample) string {
	return "win:" + tenant + ":" + model.SeriesID(s.Metric, s.Labels) + ":" + strconv.FormatInt(model.WindowStart(s.Timestamp), 10)
}

func stateTotal(ctx *harness.Ctx) int {
	n := 0
	for _, key := range ctx.Redis.Keys("win:*") {
		count, _ := ctx.Redis.HGet(key, "count")
		c, _ := strconv.Atoi(count)
		n += c
	}
	return n
}

func stateMerge(ctx *harness.Ctx, tenant, batchID string, samples []model.Sample) bool {
	applied, err := mergeBatch(stateBg, tenant, batchID, samples)
	ctx.NoError(err, "mergeBatch(%s, %s) failed", tenant, batchID)
	return applied
}

func CheckWindowKey(ctx *harness.Ctx) {
	s := stateSample(ctx, "a", 1, 5)
	stateMerge(ctx, "acme", "b-1", []model.Sample{s})
	stateMerge(ctx, "globex", "b-1", []model.Sample{s})
	want := []string{stateKey("acme", s), stateKey("globex", s)}
	ctx.Equal(ctx.Redis.Keys("win:*"), want, "acme and globex each sent one sample of the same series: without the tenant in the key their counters add up; the window keys")
	for _, key := range want {
		count, _ := ctx.Redis.HGet(key, "count")
		ctx.Equal(count, "1", "%s's count", key)
	}
}

func CheckAtomicMerge(ctx *harness.Ctx) {
	batch := []model.Sample{stateSample(ctx, "a", 1.5, 5), stateSample(ctx, "a", 2.25, 5), stateSample(ctx, "b", 4, 35)}
	seen := ctx.Redis.After("idx:acme:http_requests", func() any { return stateTotal(ctx) })
	applied := stateMerge(ctx, "acme", "b-1", batch)
	ctx.Assert(seen.Fired, "mergeBatch never indexed the batch under idx:acme:http_requests")
	ctx.Assert(seen.Result == 0 || seen.Result == 3, "a reader that looked while the batch was being merged saw %v of its 3 samples: a crash at that moment leaves exactly that much. Apply the batch in one script", seen.Result)
	ctx.Assert(applied && stateTotal(ctx) == 3, "after the merge the windows count %d samples (mergeBatch returned %v), expected 3", stateTotal(ctx), applied)
	for i, want := range []struct {
		count string
		sum   float64
	}{{"2", 3.75}, {"1", 4}} {
		s := batch[i*2]
		key := stateKey("acme", s)
		stored := ctx.Redis.HGetAll(key)
		sum, err := strconv.ParseFloat(stored["sum"], 64)
		ctx.Assert(stored["count"] == want.count && err == nil && sum == want.sum, "%s holds %v, expected count %s and sum %v: each sample adds its exact value", key, stored, want.count, want.sum)
		score, ok := ctx.Redis.ZScore("idx:acme:http_requests", key)
		ctx.Assert(ok && int64(score) == model.WindowStart(s.Timestamp), "idx:acme:http_requests scores %s at %v (indexed: %v), expected its window start %d", key, score, ok, model.WindowStart(s.Timestamp))
	}
}

func CheckWindowTtl(ctx *harness.Ctx) {
	s, older := stateSample(ctx, "a", 1, 5), stateSample(ctx, "b", 1, 35)
	stateMerge(ctx, "acme", "b-1", []model.Sample{s, older})
	keys := map[int64]string{}
	for _, k := range ctx.Redis.Keys("win:*") {
		start, _ := strconv.ParseInt(k[strings.LastIndex(k, ":")+1:], 10, 64)
		keys[start] = k
	}
	ctx.Equal(len(keys), 2, "two samples in two windows must write two window keys (%v)", keys)
	now := ctx.Clock.Now() / 1000
	for _, w := range []model.Sample{s, older} {
		key := keys[model.WindowStart(w.Timestamp)]
		want := model.WindowStart(w.Timestamp) + 10 + 86400 - now
		got := ctx.Redis.TTL(key)
		ctx.Assert(got >= want-1 && got <= want+1, "%s has TTL %d, expected %d: a window lives a day after it closes (EXPIREAT start + WindowSeconds + RetentionSeconds)", key, got, want)
	}
	key := keys[model.WindowStart(s.Timestamp)]
	expected := model.WindowStart(s.Timestamp) + 10 + 86400 - now
	ctx.Clock.Advance(4)
	stateMerge(ctx, "acme", "b-2", []model.Sample{s})
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(ttl >= expected-5 && ttl <= expected-3, "4 s later another write moved the TTL of %s to %d, expected %d: the expiry is an instant fixed by the window, not a day after the last write", key, ttl, expected-4)
}

func CheckDedupeBatch(ctx *harness.Ctx) {
	batch := []model.Sample{stateSample(ctx, "a", 1, 5), stateSample(ctx, "b", 2, 5)}
	claimed := ctx.Redis.After("batch:acme:b-1", func() any { return stateTotal(ctx) })
	ctx.Equal(stateMerge(ctx, "acme", "b-1", batch), true, "the first delivery of batch b-1 must be applied; applied")
	ctx.Assert(claimed.Fired, "mergeBatch never claimed batch:acme:b-1")
	ctx.Assert(claimed.Result == 2, "the moment batch:acme:b-1 was claimed the windows held %v of its 2 samples: a crash right after a claim made outside the script loses the batch, and its retry is refused. Claim inside the script", claimed.Result)
	again := stateMerge(ctx, "acme", "b-1", batch)
	ctx.Equal(stateTotal(ctx), 2, "batch b-1 delivered twice: a redelivered batch is applied once; the samples in the windows")
	ctx.Equal(again, false, "the redelivery of batch b-1; applied")
	ttl := ctx.Redis.TTL("batch:acme:b-1")
	ctx.Assert(ttl >= 86398 && ttl <= 86400, "batch:acme:b-1 has TTL %d, expected the claim to last ClaimTTLSeconds, a day (SET … NX EX 86400)", ttl)
	ctx.Assert(stateMerge(ctx, "acme", "b-2", batch) && stateTotal(ctx) == 4, "a new batch id must be applied; the windows count %d", stateTotal(ctx))
	ctx.Equal(stateMerge(ctx, "globex", "b-1", batch), true, "batch ids are per tenant: globex's b-1 is a different batch; applied")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <tuple>
#include <vector>

#include "metrics/model.h"

namespace {

metrics::Sample stateSample(harness::Ctx& ctx, const std::string& host = "a", double value = 1, long long ago = 5) {
  return metrics::Sample{"http_requests", {{"host", host}}, ctx.Clock.Now() / 1000 - ago, value};
}

std::string stateKey(const std::string& tenant, const metrics::Sample& s) {
  return "win:" + tenant + ":" + metrics::seriesId(s.metric, s.labels) + ":" + std::to_string(metrics::windowStart(s.timestamp));
}

long long stateTotal(harness::Ctx& ctx) {
  long long n = 0;
  for (const auto& key : ctx.Redis.Keys("win:*")) {
    const auto count = ctx.Redis.HGet(key, "count");
    if (count) n += std::stoll(*count);
  }
  return n;
}

}  // namespace

void CheckWindowKey(harness::Ctx& ctx) {
  const auto s = stateSample(ctx);
  mergeBatch("acme", "b-1", {s});
  mergeBatch("globex", "b-1", {s});
  const std::vector<std::string> want = {stateKey("acme", s), stateKey("globex", s)};
  ctx.Equal(ctx.Redis.Keys("win:*"), want, "acme and globex each sent one sample of the same series: without the tenant in the key their counters add up; the window keys");
  for (const auto& key : want) ctx.Equal(ctx.Redis.HGet(key, "count"), std::optional<std::string>("1"), "%s's count", key);
}

void CheckAtomicMerge(harness::Ctx& ctx) {
  const std::vector<metrics::Sample> batch = {stateSample(ctx, "a", 1.5), stateSample(ctx, "a", 2.25), stateSample(ctx, "b", 4, 35)};
  auto seen = std::make_shared<long long>(-1);
  ctx.Redis.After("idx:acme:http_requests", [&ctx, seen] { *seen = stateTotal(ctx); });
  const bool applied = mergeBatch("acme", "b-1", batch);
  ctx.Assert(*seen >= 0, "mergeBatch never indexed the batch under idx:acme:http_requests");
  ctx.Assert(*seen == 0 || *seen == 3, "a reader that looked while the batch was being merged saw %d of its 3 samples: a crash at that moment leaves exactly that much. Apply the batch in one script", *seen);
  ctx.Assert(applied && stateTotal(ctx) == 3, "after the merge the windows count %d samples (mergeBatch returned %t), expected 3", stateTotal(ctx), applied);
  const std::vector<std::tuple<metrics::Sample, std::string, double>> wants = {{batch[0], "2", 3.75}, {batch[2], "1", 4.0}};
  for (const auto& [s, count, sum] : wants) {
    const auto key = stateKey("acme", s);
    const auto stored = ctx.Redis.HGetAll(key);
    ctx.Assert(stored.count("count") && stored.at("count") == count && stored.count("sum") && std::stod(stored.at("sum")) == sum,
               "%s holds %v, expected count %s and sum %v: each sample adds its exact value", key, stored, count, sum);
    const auto score = ctx.Redis.ZScore("idx:acme:http_requests", key);
    ctx.Assert(score && static_cast<long long>(*score) == metrics::windowStart(s.timestamp), "idx:acme:http_requests scores %s at %s, expected its window start %d", key,
               score ? std::to_string(*score) : std::string("nothing"), metrics::windowStart(s.timestamp));
  }
}

void CheckWindowTtl(harness::Ctx& ctx) {
  const auto s = stateSample(ctx);
  const auto older = stateSample(ctx, "b", 1, 35);
  mergeBatch("acme", "b-1", {s, older});
  std::map<long long, std::string> keys;
  for (const auto& k : ctx.Redis.Keys("win:*")) keys[std::stoll(k.substr(k.rfind(':') + 1))] = k;
  ctx.Equal(keys.size(), 2, "two samples in two windows must write two window keys (%v)", keys);
  const long long now = ctx.Clock.Now() / 1000;
  for (const auto& w : {s, older}) {
    const auto key = keys.count(metrics::windowStart(w.timestamp)) ? keys.at(metrics::windowStart(w.timestamp)) : std::string();
    const long long want = metrics::windowStart(w.timestamp) + 10 + 86400 - now;
    const long long got = ctx.Redis.TTL(key);
    ctx.Assert(got >= want - 1 && got <= want + 1, "%s has TTL %d, expected %d: a window lives a day after it closes (EXPIREAT start + kWindowSeconds + kRetentionSeconds)", key, got, want);
  }
  const auto key = keys.at(metrics::windowStart(s.timestamp));
  const long long expected = metrics::windowStart(s.timestamp) + 10 + 86400 - now;
  ctx.Clock.Advance(4);
  mergeBatch("acme", "b-2", {s});
  const long long ttl = ctx.Redis.TTL(key);
  ctx.Assert(ttl >= expected - 5 && ttl <= expected - 3, "4 s later another write moved the TTL of %s to %d, expected %d: the expiry is an instant fixed by the window, not a day after the last write", key, ttl, expected - 4);
}

void CheckDedupeBatch(harness::Ctx& ctx) {
  const std::vector<metrics::Sample> batch = {stateSample(ctx, "a", 1), stateSample(ctx, "b", 2)};
  auto claimed = std::make_shared<long long>(-1);
  ctx.Redis.After("batch:acme:b-1", [&ctx, claimed] { *claimed = stateTotal(ctx); });
  ctx.Equal(mergeBatch("acme", "b-1", batch), true, "the first delivery of batch b-1 must be applied; applied");
  ctx.Assert(*claimed >= 0, "mergeBatch never claimed batch:acme:b-1");
  ctx.Assert(*claimed == 2, "the moment batch:acme:b-1 was claimed the windows held %d of its 2 samples: a crash right after a claim made outside the script loses the batch, and its retry is refused. Claim inside the script", *claimed);
  const bool again = mergeBatch("acme", "b-1", batch);
  ctx.Equal(stateTotal(ctx), 2, "batch b-1 delivered twice: a redelivered batch is applied once; the samples in the windows");
  ctx.Equal(again, false, "the redelivery of batch b-1; applied");
  const long long ttl = ctx.Redis.TTL("batch:acme:b-1");
  ctx.Assert(ttl >= 86398 && ttl <= 86400, "batch:acme:b-1 has TTL %d, expected the claim to last kClaimTtlSeconds, a day (SET … NX EX 86400)", ttl);
  ctx.Assert(mergeBatch("acme", "b-2", batch) && stateTotal(ctx) == 4, "a new batch id must be applied; the windows count %d", stateTotal(ctx));
  ctx.Equal(mergeBatch("globex", "b-1", batch), true, "batch ids are per tenant: globex's b-1 is a different batch; applied");
}
`,
  },
  hints: [
    "Two tenants that report the same series show each other's traffic; after a deploy that killed a worker the chart dips for one window, and a retried batch doubles a spike.",
    'Each sample is three separate commands from the client, so a reader or a crash can land between them; nothing records which batches were applied, nothing sets an expiry, and the key has no tenant.',
    "Key windows `win:{tenant}:{series}:{start}`. Send one `EVAL` of `MERGE_LUA`: `SET batch NX EX` or return 0, then per sample `HINCRBY`, `HINCRBYFLOAT`, `EXPIREAT start + WINDOW_SECONDS + RETENTION_SECONDS`, `ZADD`; return the script's 1 or 0 as a boolean.",
  ],
  debrief: `Putting the claim and every increment in one script makes the batch the unit Redis applies, which is what the sender's retry assumes: either the batch counted or it did not, and a redelivery finds the claim and stops. The claim has to live inside the script; a claim set by the client before the merge would survive a crash that lost the merge, and the retry would then skip a batch that never counted. \`EXPIREAT\` ties a window's lifetime to the window rather than to its last write, so a late sample cannot keep a window alive. Production aggregators also trim the per-metric index as windows expire, and shard windows across Redis nodes by series, which a script can only do when all its keys hash to one slot.`,
};
