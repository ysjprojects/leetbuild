import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Atomic hourly counters with expiry',
  concept: 'redis',
  file: 'state',
  focus: ['meter', 'redis'],
  task: `## Task

The starter is a plausible model-generated draft: a report arrives, the counters move, and the
dashboard shows spend. It races under concurrency, it never rolls over, and it leaks keys forever.
Find the flaws, fix them, and prove the fix.

Implement \`record_usage(tenant, model, input_tokens, output_tokens)\`, the call the API makes once a
usage report has been validated:

- Spend lives in **one Redis hash per \`(tenant, hour bucket)\`**: \`meter:{tenant}:{bucket}\` with
  fields \`input_tokens\`, \`output_tokens\` and \`events\`, where \`bucket = int(now // WINDOW_S)\` and
  \`WINDOW_S = 3600\`. The draft keys on the tenant alone, so the counter never resets and "this
  hour's spend" is really "all spend since the tenant first appeared".
- Both token increments, the event count and the window expiry happen in **one atomic Lua
  \`EVAL\`**: a report is one unit of spend, so a process that dies mid-update must not leave the
  input counter moved and the output counter behind. Two client-side \`HINCRBY\` commands are the
  exact half-applied state the limiter reads.
- The expiry is set **when the window opens** — \`WINDOW_TTL_S = 7200\`, the hour the window covers
  plus one hour of grace for reconciliation — and never re-set by a later write, so the key
  disappears an hour after its window closes instead of living forever. A \`TTL\` read inside the
  script tells you whether the deadline is already there.
- The script returns the fresh \`input_tokens\`, \`output_tokens\` and \`events\` so the caller never
  needs a second round trip: a re-read after the write can pick up another request's increment and
  report it as this one's.
- The limiter and the meter read the **same key**: pricing and enforcement must not disagree about
  which window a token belongs to.

**Failure mode the checks target.** The atomicity flaw is the loud one under load — two concurrent
reports each move one counter and the totals drift — but the missing hour bucket is the one that
survives review: without it every window shares one counter, so a tenant that spent its budget last
week is still over it today, and no TTL can fix a key that is supposed to keep counting.`,
  sequence: {
    participants: ['Cost Meter', 'Second request', 'Redis'],
    messages: [
      {from: 'Cost Meter', to: 'Redis', label: 'EVAL meter:{tenant}:{bucket} · input+output+events', kind: 'sync'},
      {from: 'Redis', to: 'Cost Meter', label: '{input, output, events} + EXPIRE on first write', kind: 'reply'},
      {from: 'Second request', to: 'Redis', label: 'EVAL same window key', kind: 'sync'},
      {from: 'Redis', to: 'Second request', label: 'totals after both writes', kind: 'reply'},
      {from: 'Cost Meter', to: 'Cost Meter', label: 'two concurrent reports: no half-applied hash', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'TTL 7200 · window + one hour of grace', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'atomic-script',
      title: 'Moves both counters in one atomic script',
      detail:
        'The increments and the expiry run inside one `EVAL`, so an interrupted update can never leave the input counter moved and the output counter behind. The draft sends one client-side `HINCRBY` per field, which is exactly the half-applied hash the limiter reads.',
      match: {
        python: {all: [/METER_LUA/, /\.eval\(/, /HINCRBY/], none: [/r\.hincrby\(/]},
        typescript: {all: [/METER_LUA/, /\.eval\(/, /HINCRBY/], none: [/r\.hincrby\(/]},
        go: {all: [/meterScript/, /\.Run\(/, /HINCRBY/], none: [/\.HIncrBy\(/]},
        scala: {all: [/MeterLua/, /\.eval\(/, /HINCRBY/], none: [/r\.hincrBy\(/]},
        cpp: {all: [/kMeterLua/, /\.eval</, /HINCRBY/], none: [/r\.hincrby\(/]},
      },
    },
    {
      id: 'window-key',
      title: 'Keys the hash by (tenant, hour bucket)',
      detail:
        'The hash is `meter:{tenant}:{bucket}`, built from the tenant and the hour the report belongs to. The draft keys on the tenant alone, so one counter accumulates every hour the tenant ever spent and "this window" is unbounded.',
      match: {
        python: {all: [/meter:/, /bucket/]},
        typescript: {all: [/meter:/, /bucket/]},
        go: {all: [/meter:/, /bucket/]},
        scala: {all: [/meter:/, /bucket/]},
        cpp: {all: [/meter:/, /bucket/]},
      },
    },
    {
      id: 'window-ttl',
      title: 'Expires the window with a named TTL',
      detail:
        'The script sets `EXPIRE` from `WINDOW_TTL_S`, so the key for a closed window is gone instead of accumulating forever. The draft sets no TTL on any key it touches.',
      match: {
        python: {all: [/WINDOW_TTL_S/, /EXPIRE/]},
        typescript: {all: [/WINDOW_TTL_S/, /EXPIRE/]},
        go: {all: [/windowTTLS/, /EXPIRE/]},
        scala: {all: [/WindowTtlS/, /EXPIRE/]},
        cpp: {all: [/kWindowTtlS/, /EXPIRE/]},
      },
    },
    {
      id: 'expiry-on-first-write',
      title: 'Sets the deadline once, when the window opens',
      detail:
        'Inside the script the deadline is only written while the key has no TTL (`TTL` returns -1 or -2), so a report in the last minute of a window does not push the deadline out. Re-setting `EXPIRE` on every write keeps an active tenant’s key alive indefinitely.',
      match: {
        python: {all: [/redis\.call\('TTL'/, /redis\.call\('EXPIRE'/]},
        typescript: {all: [/redis\.call\('TTL'/, /redis\.call\('EXPIRE'/]},
        go: {all: [/redis\.call\('TTL'/, /redis\.call\('EXPIRE'/]},
        scala: {all: [/redis\.call\('TTL'/, /redis\.call\('EXPIRE'/]},
        cpp: {all: [/redis\.call\('TTL'/, /redis\.call\('EXPIRE'/]},
      },
    },
    {
      id: 'read-your-write',
      title: 'Returns the counters from the same script',
      detail:
        'The script reads the totals it just wrote and returns them, so the caller’s number is the number its own write produced. A second `HGET` after the script can report another concurrent request’s increment as this one’s.',
      match: {
        python: {all: [/redis\.call\('HGET'/, /return \{/]},
        typescript: {all: [/redis\.call\('HGET'/, /return \{/]},
        go: {all: [/redis\.call\('HGET'/, /return \{/]},
        scala: {all: [/redis\.call\('HGET'/, /return \{/]},
        cpp: {all: [/redis\.call\('HGET'/, /return \{/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis
from fastapi import FastAPI, HTTPException

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def record_usage(tenant: str, model: str, input_tokens: int, output_tokens: int) -> dict:
    # TODO: move both increments and the expiry into one atomic script, key the hash by
    # (tenant, hour bucket) instead of the tenant alone, and expire the key with its window.
    if input_tokens < 0 or output_tokens < 0:
        raise HTTPException(status_code=400, detail="token counts must not be negative")
    key = f"meter:{tenant}"
    r.hincrby(key, "input_tokens", input_tokens)
    r.hincrby(key, "output_tokens", output_tokens)
    return {
        "window_width_s": 3600,
        "input_tokens": int(r.hget(key, "input_tokens") or 0),
        "output_tokens": int(r.hget(key, "output_tokens") or 0),
        "events": 0,
    }
`,
      solution: `import time

import redis
from fastapi import FastAPI, HTTPException

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 3600
WINDOW_TTL_S = 7200

METER_LUA = """
redis.call('HINCRBY', KEYS[1], 'input_tokens', ARGV[1])
redis.call('HINCRBY', KEYS[1], 'output_tokens', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'events', 1)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {tonumber(redis.call('HGET', KEYS[1], 'input_tokens')) or 0,
        tonumber(redis.call('HGET', KEYS[1], 'output_tokens')) or 0,
        tonumber(redis.call('HGET', KEYS[1], 'events')) or 0}
"""


def window_bucket(now: float | None = None) -> int:
    """The hour this report belongs to; the limiter and the meter must agree on it."""
    return int((now if now is not None else time.time()) // WINDOW_S)


def meter_key(tenant: str, bucket: int) -> str:
    """The one hash per (tenant, window) that the limiter checks and the meter writes."""
    return f"meter:{tenant}:{bucket}"


def record_usage(tenant: str, model: str, input_tokens: int, output_tokens: int) -> dict:
    if input_tokens < 0 or output_tokens < 0:
        raise HTTPException(status_code=400, detail="token counts must not be negative")
    bucket = window_bucket()
    key = meter_key(tenant, bucket)
    totals = r.eval(METER_LUA, 1, key, input_tokens, output_tokens, WINDOW_TTL_S)
    input_total, output_total, events = (int(value) for value in totals)
    return {
        "window_bucket": bucket,
        "input_tokens": input_total,
        "output_tokens": output_total,
        "events": events,
    }
`,
    },
    typescript: {
      starter: `/** recordUsage: a model-generated draft that moves each counter with its own command. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

interface Meter {
  window_width_s: number;
  input_tokens: number;
  output_tokens: number;
  events: number;
}

export async function recordUsage(
  tenant: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): Promise<Meter> {
  // TODO: move both increments and the expiry into one atomic script, key the hash by
  // (tenant, hour bucket) instead of the tenant alone, and expire the key with its window.
  const key = \`meter:\${tenant}\`;
  await r.hincrby(key, 'input_tokens', inputTokens);
  await r.hincrby(key, 'output_tokens', outputTokens);
  return {
    window_width_s: 3600,
    input_tokens: Number((await r.hget(key, 'input_tokens')) ?? 0),
    output_tokens: Number((await r.hget(key, 'output_tokens')) ?? 0),
    events: 0,
  };
}
`,
      solution: `/** recordUsage: one atomic script moves the window counters and opens the expiry. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const WINDOW_S = 3600;
const WINDOW_TTL_S = 7200;

const METER_LUA = \`
redis.call('HINCRBY', KEYS[1], 'input_tokens', ARGV[1])
redis.call('HINCRBY', KEYS[1], 'output_tokens', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'events', 1)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {tonumber(redis.call('HGET', KEYS[1], 'input_tokens')) or 0,
        tonumber(redis.call('HGET', KEYS[1], 'output_tokens')) or 0,
        tonumber(redis.call('HGET', KEYS[1], 'events')) or 0}
\`;

interface Meter {
  window_bucket: number;
  input_tokens: number;
  output_tokens: number;
  events: number;
}

/** The hour this report belongs to; the limiter and the meter must agree on it. */
export function windowBucket(now: number = Date.now()): number {
  return Math.floor(now / 1000 / WINDOW_S);
}

/** The one hash per (tenant, window) that the limiter checks and the meter writes. */
export function meterKey(tenant: string, bucket: number): string {
  return \`meter:\${tenant}:\${bucket}\`;
}

export async function recordUsage(
  tenant: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): Promise<Meter> {
  if (inputTokens < 0 || outputTokens < 0) throw new Error('token counts must not be negative');
  const bucket = windowBucket();
  const totals = (await r.eval(
    METER_LUA,
    1,
    meterKey(tenant, bucket),
    String(inputTokens),
    String(outputTokens),
    String(WINDOW_TTL_S),
  )) as [number, number, number];
  return {window_bucket: bucket, input_tokens: totals[0], output_tokens: totals[1], events: totals[2]};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Meter struct {
	WindowWidthS int64 \`json:"window_width_s"\`
	InputTokens  int64 \`json:"input_tokens"\`
	OutputTokens int64 \`json:"output_tokens"\`
	Events       int64 \`json:"events"\`
}

func recordUsage(ctx context.Context, tenant, model string, inputTokens, outputTokens int64) (Meter, error) {
	// TODO: move both increments and the expiry into one atomic script, key the hash by
	// (tenant, hour bucket) instead of the tenant alone, and expire the key with its window.
	if inputTokens < 0 || outputTokens < 0 {
		return Meter{}, errors.New("token counts must not be negative")
	}
	key := "meter:" + tenant
	if err := rdb.HIncrBy(ctx, key, "input_tokens", inputTokens).Err(); err != nil {
		return Meter{}, err
	}
	if err := rdb.HIncrBy(ctx, key, "output_tokens", outputTokens).Err(); err != nil {
		return Meter{}, err
	}
	input, _ := rdb.HGet(ctx, key, "input_tokens").Int64()
	output, _ := rdb.HGet(ctx, key, "output_tokens").Int64()
	return Meter{WindowWidthS: 3600, InputTokens: input, OutputTokens: output}, nil
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	windowS    int64 = 3600
	windowTTLS int64 = 7200
)

var meterScript = redis.NewScript(\`
redis.call('HINCRBY', KEYS[1], 'input_tokens', ARGV[1])
redis.call('HINCRBY', KEYS[1], 'output_tokens', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'events', 1)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {tonumber(redis.call('HGET', KEYS[1], 'input_tokens')) or 0,
        tonumber(redis.call('HGET', KEYS[1], 'output_tokens')) or 0,
        tonumber(redis.call('HGET', KEYS[1], 'events')) or 0}
\`)

type Meter struct {
	WindowBucket int64 \`json:"window_bucket"\`
	InputTokens  int64 \`json:"input_tokens"\`
	OutputTokens int64 \`json:"output_tokens"\`
	Events       int64 \`json:"events"\`
}

// windowBucket is the hour a report belongs to; the limiter and the meter must agree on it.
func windowBucket(now time.Time) int64 {
	return now.Unix() / windowS
}

// meterKey is the one hash per (tenant, window) that the limiter checks and the meter writes.
func meterKey(tenant string, bucket int64) string {
	return "meter:" + tenant + ":" + strconv.FormatInt(bucket, 10)
}

func recordUsage(ctx context.Context, tenant, model string, inputTokens, outputTokens int64) (Meter, error) {
	if inputTokens < 0 || outputTokens < 0 {
		return Meter{}, errors.New("token counts must not be negative")
	}
	bucket := windowBucket(time.Now())
	totals, err := meterScript.Run(ctx, rdb, []string{meterKey(tenant, bucket)},
		inputTokens, outputTokens, windowTTLS).Int64Slice()
	if err != nil {
		return Meter{}, err
	}
	return Meter{WindowBucket: bucket, InputTokens: totals[0], OutputTokens: totals[1], Events: totals[2]}, nil
}
`,
    },
    scala: {
      starter: `import jedis.RedisClient
import scala.jdk.CollectionConverters._

object MeterState {
  val r: RedisClient = new RedisClient("redis", 6379)

  def recordUsage(tenant: String, model: String, inputTokens: Long, outputTokens: Long): Map[String, Long] = {
    // TODO: move both increments and the expiry into one atomic script, key the hash by
    // (tenant, hour bucket) instead of the tenant alone, and expire the key with its window.
    require(inputTokens >= 0 && outputTokens >= 0, "token counts must not be negative")
    val key = s"meter:$tenant"
    r.hincrBy(key, "input_tokens", inputTokens)
    r.hincrBy(key, "output_tokens", outputTokens)
    Map(
      "window_width_s" -> 3600L,
      "input_tokens" -> Option(r.hget(key, "input_tokens")).map(_.toLong).getOrElse(0L),
      "output_tokens" -> Option(r.hget(key, "output_tokens")).map(_.toLong).getOrElse(0L),
      "events" -> 0L
    )
  }
}
`,
      solution: `import jedis.RedisClient
import scala.jdk.CollectionConverters._

object MeterState {
  val r: RedisClient = new RedisClient("redis", 6379)

  val WindowS = 3600L
  val WindowTtlS = 7200L

  val MeterLua =
    """
redis.call('HINCRBY', KEYS[1], 'input_tokens', ARGV[1])
redis.call('HINCRBY', KEYS[1], 'output_tokens', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'events', 1)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {tonumber(redis.call('HGET', KEYS[1], 'input_tokens')) or 0,
        tonumber(redis.call('HGET', KEYS[1], 'output_tokens')) or 0,
        tonumber(redis.call('HGET', KEYS[1], 'events')) or 0}
"""

  /** The hour a report belongs to; the limiter and the meter must agree on it. */
  def windowBucket(nowMillis: Long): Long = nowMillis / 1000 / WindowS

  /** The one hash per (tenant, window) that the limiter checks and the meter writes. */
  def meterKey(tenant: String, bucket: Long): String = s"meter:$tenant:$bucket"

  def recordUsage(tenant: String, model: String, inputTokens: Long, outputTokens: Long): Map[String, Long] = {
    require(inputTokens >= 0 && outputTokens >= 0, "token counts must not be negative")
    val bucket = windowBucket(System.currentTimeMillis())
    val totals = r
      .eval(
        MeterLua,
        List(meterKey(tenant, bucket)).asJava,
        List(inputTokens.toString, outputTokens.toString, WindowTtlS.toString).asJava
      )
      .asInstanceOf[java.util.List[Long]]
      .asScala
      .map(_.toLong)
      .toList
    Map(
      "window_bucket" -> bucket,
      "input_tokens" -> totals(0),
      "output_tokens" -> totals(1),
      "events" -> totals(2)
    )
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

#include <nlohmann/json.hpp>

using json = nlohmann::json;
using sw::redis::Redis;

Redis r("tcp://redis:6379");

json recordUsage(const std::string& tenant, const std::string& model, long long inputTokens, long long outputTokens) {
  // TODO: move both increments and the expiry into one atomic script, key the hash by
  // (tenant, hour bucket) instead of the tenant alone, and expire the key with its window.
  const std::string key = "meter:" + tenant;
  r.hincrby(key, "input_tokens", inputTokens);
  r.hincrby(key, "output_tokens", outputTokens);
  const auto input = r.hget(key, "input_tokens").value_or("0");
  const auto output = r.hget(key, "output_tokens").value_or("0");
  return json{
      {"window_width_s", 3600},
      {"input_tokens", std::stoll(input)},
      {"output_tokens", std::stoll(output)},
      {"events", 0},
  };
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

#include <nlohmann/json.hpp>

using json = nlohmann::json;
using sw::redis::Redis;

Redis r("tcp://redis:6379");

constexpr long long kWindowS = 3600;
constexpr long long kWindowTtlS = 7200;

const std::string kMeterLua = R"LUA(
redis.call('HINCRBY', KEYS[1], 'input_tokens', ARGV[1])
redis.call('HINCRBY', KEYS[1], 'output_tokens', ARGV[2])
redis.call('HINCRBY', KEYS[1], 'events', 1)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {tonumber(redis.call('HGET', KEYS[1], 'input_tokens')) or 0,
        tonumber(redis.call('HGET', KEYS[1], 'output_tokens')) or 0,
        tonumber(redis.call('HGET', KEYS[1], 'events')) or 0}
)LUA";

// windowBucket is the hour a report belongs to; the limiter and the meter must agree on it.
long long windowBucket(long long nowSeconds) { return nowSeconds / kWindowS; }

// meterKey is the one hash per (tenant, window) that the limiter checks and the meter writes.
std::string meterKey(const std::string& tenant, long long bucket) {
  return "meter:" + tenant + ":" + std::to_string(bucket);
}

json recordUsage(const std::string& tenant, const std::string& model, long long inputTokens, long long outputTokens) {
  if (inputTokens < 0 || outputTokens < 0) {
    throw std::invalid_argument("token counts must not be negative");
  }
  const auto now = std::chrono::duration_cast<std::chrono::seconds>(
                       std::chrono::system_clock::now().time_since_epoch())
                       .count();
  const long long bucket = windowBucket(now);
  const auto totals = r.eval<std::vector<long long>>(kMeterLua, {meterKey(tenant, bucket)},
                                                     {std::to_string(inputTokens), std::to_string(outputTokens),
                                                      std::to_string(kWindowTtlS)});
  return json{
      {"window_bucket", bucket},
      {"input_tokens", totals.at(0)},
      {"output_tokens", totals.at(1)},
      {"events", totals.at(2)},
  };
}
`,
    },
  },
  hints: [
    'Everything that decides the result runs inside the script: both `HINCRBY` calls, the `events` increment and the expiry. A client-side read before or after the write is where the race lives, and it is also a second round trip the caller pays for on every request.',
    'The key is the contract with the limiter: `meter:{tenant}:{bucket}`, with `bucket = now // WINDOW_S`. Price this window and enforce the same window, or the platform will happily admit a request the meter has already billed for an hour ago.',
    'Only set the deadline when there is none: `TTL` returns -1 for a key with no expiry and -2 for a missing one, so `if redis.call(\'TTL\', KEYS[1]) < 0` means "this window just opened". Re-setting `EXPIRE` on every write slides the deadline forward and the key outlives its window by as long as the tenant keeps spending.',
  ],
  debrief: `The interviewer is testing whether you know what the counter is *for*: it is the number the budget limiter reads before admitting a request and the number the spend report prints afterwards, so it has to be one atomic unit of spend that belongs to one window and disappears when that window is done. The draft fails all three: two client commands instead of one script, a key without the hour in it, and no expiry at all. The subtle part is the third one done right — setting the TTL on every write looks careful and is wrong, because an active tenant then never lets the key go; the deadline belongs to the window, not to the write. Real meters keep a second, coarser counter for the billing period, a reconciliation key that survives longer than the window, and a hash tag so all of one tenant's window keys land on the same Redis cluster slot.`,
};
