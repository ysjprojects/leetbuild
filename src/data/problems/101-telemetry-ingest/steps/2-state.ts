import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis admission: one script per device window',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['ingest', 'redis'],
  task: `## Task

**Starting point.** The starter implements \`admit(device_id, samples)\`, the admission the ingest
path asks before it appends a batch: it \`HSET\`s every sample's value into \`latest:{device_id}\`,
\`GET\`s the counter \`rate:{device_id}\`, refuses when the batch would pass \`RATE_LIMIT\` and otherwise
\`INCRBY\`s it, and answers \`{"admitted", "remaining", "retry_after"}\` with \`retry_after = WINDOW_S\`
on a refusal. It serves the demo and hides four flaws.

**Failure mode the checks target.** During a firmware rollout the fleet retries in lockstep and two
batches both fit a window only one of them fits; a refused batch still moves the dashboard's latest
value; a device that had one busy minute is refused for good; and a refused device is told to wait a
full minute however much of the window is left.

- A device may send **600 samples** (\`RATE_LIMIT\`) per **60-second window** (\`WINDOW_S\`), counted in
  \`rate:{device_id}\`.
- One Lua script (\`ADMIT_LUA\`) reads the counter, refuses a batch that does not fit, and only then
  increments it and writes each metric's latest value into \`latest:{device_id}\`.
- The window is the counter's life: the script \`EXPIRE\`s it with \`WINDOW_S\` when it creates it.
- A refusal answers \`remaining\` (samples left in the window) and \`retry_after\`, the counter's
  remaining \`TTL\`, from the script's return value.`,
  sequence: {
    participants: ['Telemetry Ingest', 'Redis'],
    messages: [
      {
        from: 'Telemetry Ingest',
        to: 'Redis',
        label: 'EVAL ADMIT_LUA · rate:{device} latest:{device} · n, 600, 60, metric/value…',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'GET count · count + n > 600 → refuse, write nothing', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'INCRBY · EXPIRE 60 on first write · HSET latest', kind: 'sync'},
      {from: 'Redis', to: 'Telemetry Ingest', label: '{admitted, remaining, retry_after = TTL}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-admit',
      title: 'Two racing batches cannot both spend the last of a window',
      detail:
        'With 100 samples left, two batches of 80 arrive together: exactly one is admitted and the counter ends at 580. The read, the comparison and the increment run in one Lua script; the starter reads with `GET` and increments with `INCRBY` in two round trips, so both batches read 500.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /INCRBY/], none: [/\br\.incrby\(/, /\br\.get\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /INCRBY/], none: [/redis\.incrby\(/, /redis\.get\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /INCRBY/], none: [/rdb\.IncrBy\(/, /rdb\.Get\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /INCRBY/], none: [/jedis\.incrBy\(/, /jedis\.get\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /INCRBY/], none: [/redis\.incrby\(/, /redis\.get\(/]},
      },
    },
    {
      id: 'refused-writes-nothing',
      title: 'A refused batch leaves the latest values and the counter alone',
      detail:
        "The script decides first and writes `latest:{device}` only for an admitted batch. The starter writes every value before it looks at the counter, so a refused batch still changes the device's latest reading.",
      match: {
        python: {order: [/redis\.call\(\s*['"]GET['"]/, /redis\.call\(\s*['"]HSET['"]/], none: [/\br\.hset\(/]},
        typescript: {order: [/redis\.call\(\s*['"]GET['"]/, /redis\.call\(\s*['"]HSET['"]/], none: [/redis\.hset\(/]},
        go: {order: [/redis\.call\(\s*['"]GET['"]/, /redis\.call\(\s*['"]HSET['"]/], none: [/rdb\.HSet\(/]},
        scala: {order: [/redis\.call\(\s*['"]GET['"]/, /redis\.call\(\s*['"]HSET['"]/], none: [/jedis\.hset\(/]},
        cpp: {order: [/redis\.call\(\s*['"]GET['"]/, /redis\.call\(\s*['"]HSET['"]/], none: [/redis\.hset\(/]},
      },
    },
    {
      id: 'window-expiry',
      title: 'The counter expires with its window',
      detail:
        'The script sets the counter’s expiry to the window when it creates it, so 61 seconds after a full window the device is admitted again. The starter never expires `rate:{device}`, so a busy minute refuses the device for good.',
      match: {
        python: {all: [/redis\.call\(\s*['"]EXPIRE['"]/]},
        typescript: {all: [/redis\.call\(\s*['"]EXPIRE['"]/]},
        go: {all: [/redis\.call\(\s*['"]EXPIRE['"]/]},
        scala: {all: [/redis\.call\(\s*['"]EXPIRE['"]/]},
        cpp: {all: [/redis\.call\(\s*['"]EXPIRE['"]/]},
      },
    },
    {
      id: 'retry-after',
      title: 'A refusal says how long the window has left',
      detail:
        "A refused batch answers `retry_after` equal to the counter's remaining TTL (15 s, 45 s into the window) and the samples left. The starter answers the full window every time, so devices back off too long or retry in lockstep.",
      match: {
        python: {all: [/redis\.call\(\s*['"]TTL['"]/], none: [/["']retry_after["']\s*:\s*WINDOW_S/]},
        typescript: {all: [/redis\.call\(\s*['"]TTL['"]/], none: [/retry_after:\s*WINDOW_S/]},
        go: {all: [/redis\.call\(\s*['"]TTL['"]/], none: [/RetryAfter:\s*windowS/]},
        scala: {all: [/redis\.call\(\s*['"]TTL['"]/], none: [/,\s*WindowSeconds\)/]},
        cpp: {all: [/redis\.call\(\s*['"]TTL['"]/], none: [/,\s*kWindowS\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RATE_LIMIT = 600  # samples per device per window
WINDOW_S = 60


def admit(device_id: str, samples: list[dict]) -> dict:
    """Count a batch of samples ({"metric", "value", "ts"}) against the device's window and record each metric's latest value."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    key = f"rate:{device_id}"
    r.hset(f"latest:{device_id}", mapping={s["metric"]: s["value"] for s in samples})
    count = int(r.get(key) or 0)
    if count + len(samples) > RATE_LIMIT:
        return {"admitted": False, "remaining": RATE_LIMIT - count, "retry_after": WINDOW_S}
    r.incrby(key, len(samples))
    return {"admitted": True, "remaining": RATE_LIMIT - count - len(samples), "retry_after": 0}
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RATE_LIMIT = 600  # samples per device per window
WINDOW_S = 60

# KEYS: rate:{device}, latest:{device}. ARGV: n, limit, window, then metric/value pairs.
# Decide first; only an admitted batch moves the counter and the latest values.
ADMIT_LUA = """
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
local n = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if count + n > limit then
  local ttl = redis.call('TTL', KEYS[1])
  if ttl < 0 then ttl = 0 end
  return {0, limit - count, ttl}
end
local total = redis.call('INCRBY', KEYS[1], n)
if total == n then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
for i = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
end
return {1, limit - total, 0}
"""
admit_script = r.register_script(ADMIT_LUA)


def admit(device_id: str, samples: list[dict]) -> dict:
    """Count a batch of samples ({"metric", "value", "ts"}) against the device's window and record each metric's latest value."""
    latest = {}
    for sample in samples:
        latest[sample["metric"]] = sample["value"]  # a later sample of a metric wins
    args = [len(samples), RATE_LIMIT, WINDOW_S]
    for metric, value in latest.items():
        args += [metric, value]
    admitted, remaining, retry_after = admit_script(keys=[f"rate:{device_id}", f"latest:{device_id}"], args=args)
    return {"admitted": admitted == 1, "remaining": remaining, "retry_after": retry_after}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import type {Sample} from 'ingestd/wal';

export const RATE_LIMIT = 600; // samples per device per window
export const WINDOW_S = 60;

export interface Admission {
  admitted: boolean;
  remaining: number;
  retry_after: number;
}

const redis = new Redis({host: 'redis', port: 6379});

/** Count a batch of samples against the device's window and record each metric's latest value. */
export async function admit(deviceId: string, samples: Sample[]): Promise<Admission> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = \`rate:\${deviceId}\`;
  await redis.hset(\`latest:\${deviceId}\`, Object.fromEntries(samples.map(s => [s.metric, String(s.value)])));
  const count = Number((await redis.get(key)) ?? 0);
  if (count + samples.length > RATE_LIMIT) return {admitted: false, remaining: RATE_LIMIT - count, retry_after: WINDOW_S};
  await redis.incrby(key, samples.length);
  return {admitted: true, remaining: RATE_LIMIT - count - samples.length, retry_after: 0};
}
`,
      solution: `import Redis from 'ioredis';

import type {Sample} from 'ingestd/wal';

export const RATE_LIMIT = 600; // samples per device per window
export const WINDOW_S = 60;

/**
 * KEYS: rate:{device}, latest:{device}. ARGV: n, limit, window, then metric/value pairs.
 * Decide first; only an admitted batch moves the counter and the latest values.
 */
export const ADMIT_LUA = \`
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
local n = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if count + n > limit then
  local ttl = redis.call('TTL', KEYS[1])
  if ttl < 0 then ttl = 0 end
  return {0, limit - count, ttl}
end
local total = redis.call('INCRBY', KEYS[1], n)
if total == n then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
for i = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
end
return {1, limit - total, 0}
\`;

export interface Admission {
  admitted: boolean;
  remaining: number;
  retry_after: number;
}

interface AdmitRedis extends Redis {
  admitBatch(rateKey: string, latestKey: string, ...args: (string | number)[]): Promise<[number, number, number]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as AdmitRedis;
redis.defineCommand('admitBatch', {numberOfKeys: 2, lua: ADMIT_LUA});

/** Count a batch of samples against the device's window and record each metric's latest value. */
export async function admit(deviceId: string, samples: Sample[]): Promise<Admission> {
  const latest = new Map<string, number>();
  for (const sample of samples) latest.set(sample.metric, sample.value); // a later sample of a metric wins
  const args = [samples.length, RATE_LIMIT, WINDOW_S, ...[...latest].flat()];
  const [admitted, remaining, retryAfter] = await redis.admitBatch(\`rate:\${deviceId}\`, \`latest:\${deviceId}\`, ...args);
  return {admitted: admitted === 1, remaining, retry_after: retryAfter};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"ingestd/wal" // wal.Sample
)

const (
	rateLimit = 600 // samples per device per window
	windowS   = 60
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Admission is the answer to one batch.
type Admission struct {
	Admitted   bool
	Remaining  int64
	RetryAfter int64
}

// admit counts a batch of samples against the device's window and records each metric's latest value.
func admit(ctx context.Context, deviceID string, samples []wal.Sample) (Admission, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	key := "rate:" + deviceID
	for _, s := range samples {
		if err := rdb.HSet(ctx, "latest:"+deviceID, s.Metric, s.Value).Err(); err != nil {
			return Admission{}, err
		}
	}
	count, err := rdb.Get(ctx, key).Int64()
	if err != nil && err != redis.Nil {
		return Admission{}, err
	}
	n := int64(len(samples))
	if count+n > rateLimit {
		return Admission{Admitted: false, Remaining: rateLimit - count, RetryAfter: windowS}, nil
	}
	if err := rdb.IncrBy(ctx, key, n).Err(); err != nil {
		return Admission{}, err
	}
	return Admission{Admitted: true, Remaining: rateLimit - count - n}, nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"ingestd/wal" // wal.Sample
)

const (
	rateLimit = 600 // samples per device per window
	windowS   = 60
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// admitScript: KEYS rate:{device}, latest:{device}; ARGV n, limit, window, then metric/value pairs.
// It decides first; only an admitted batch moves the counter and the latest values.
var admitScript = redis.NewScript(\`
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
local n = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if count + n > limit then
  local ttl = redis.call('TTL', KEYS[1])
  if ttl < 0 then ttl = 0 end
  return {0, limit - count, ttl}
end
local total = redis.call('INCRBY', KEYS[1], n)
if total == n then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
for i = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
end
return {1, limit - total, 0}
\`)

// Admission is the answer to one batch.
type Admission struct {
	Admitted   bool
	Remaining  int64
	RetryAfter int64
}

// admit counts a batch of samples against the device's window and records each metric's latest value.
func admit(ctx context.Context, deviceID string, samples []wal.Sample) (Admission, error) {
	latest := map[string]float64{}
	for _, s := range samples {
		latest[s.Metric] = s.Value // a later sample of a metric wins
	}
	args := []any{len(samples), rateLimit, windowS}
	for metric, value := range latest {
		args = append(args, metric, value)
	}
	reply, err := admitScript.Run(ctx, rdb, []string{"rate:" + deviceID, "latest:" + deviceID}, args...).Int64Slice()
	if err != nil {
		return Admission{}, err
	}
	return Admission{Admitted: reply[0] == 1, Remaining: reply[1], RetryAfter: reply[2]}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import ingestd.Sample

/** The answer to one batch. */
final case class Admission(admitted: Boolean, remaining: Long, retryAfter: Long)

object AdmitState {
  val jedis = new JedisPooled("redis", 6379)

  val RateLimit = 600L // samples per device per window
  val WindowSeconds = 60L

  /** Count a batch of samples against the device's window and record each metric's latest value. */
  def admit(deviceId: String, samples: Seq[Sample]): Admission = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = s"rate:$deviceId"
    samples.foreach(s => jedis.hset(s"latest:$deviceId", s.metric, s.value.toString))
    val count = Option(jedis.get(key)).map(_.toLong).getOrElse(0L)
    if (count + samples.size > RateLimit) Admission(false, RateLimit - count, WindowSeconds)
    else {
      jedis.incrBy(key, samples.size.toLong)
      Admission(true, RateLimit - count - samples.size, 0L)
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import ingestd.Sample

/** The answer to one batch. */
final case class Admission(admitted: Boolean, remaining: Long, retryAfter: Long)

object AdmitState {
  val jedis = new JedisPooled("redis", 6379)

  val RateLimit = 600L // samples per device per window
  val WindowSeconds = 60L

  /**
   * KEYS: rate:{device}, latest:{device}. ARGV: n, limit, window, then metric/value pairs.
   * Decide first; only an admitted batch moves the counter and the latest values.
   */
  val AdmitLua: String =
    """local count = tonumber(redis.call('GET', KEYS[1]) or '0')
      |local n = tonumber(ARGV[1])
      |local limit = tonumber(ARGV[2])
      |if count + n > limit then
      |  local ttl = redis.call('TTL', KEYS[1])
      |  if ttl < 0 then ttl = 0 end
      |  return {0, limit - count, ttl}
      |end
      |local total = redis.call('INCRBY', KEYS[1], n)
      |if total == n then
      |  redis.call('EXPIRE', KEYS[1], ARGV[3])
      |end
      |for i = 4, #ARGV, 2 do
      |  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
      |end
      |return {1, limit - total, 0}
      |""".stripMargin

  /** Count a batch of samples against the device's window and record each metric's latest value. */
  def admit(deviceId: String, samples: Seq[Sample]): Admission = {
    val latest = samples.map(s => s.metric -> s.value).toMap // a later sample of a metric wins
    val args = Seq(samples.size.toString, RateLimit.toString, WindowSeconds.toString) ++
      latest.toSeq.flatMap { case (metric, value) => Seq(metric, value.toString) }
    val reply = jedis.eval(AdmitLua, List(s"rate:$deviceId", s"latest:$deviceId").asJava, args.asJava)
      .asInstanceOf[java.util.List[java.lang.Long]].asScala.map(_.longValue)
    Admission(reply(0) == 1L, reply(1), reply(2))
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

#include "ingestd/wal.h"  // wal::Sample

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kRateLimit = 600;  // samples per device per window
constexpr long long kWindowS = 60;

// The answer to one batch.
struct Admission {
  bool admitted = false;
  long long remaining = 0;
  long long retry_after = 0;
};

// Count a batch of samples against the device's window and record each metric's latest value.
Admission admit(const std::string& device_id, const std::vector<wal::Sample>& samples) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = "rate:" + device_id;
  for (const wal::Sample& s : samples) redis.hset("latest:" + device_id, s.metric, std::to_string(s.value));
  const auto current = redis.get(key);
  const long long count = current ? std::stoll(*current) : 0;
  const long long n = static_cast<long long>(samples.size());
  if (count + n > kRateLimit) return {false, kRateLimit - count, kWindowS};
  redis.incrby(key, n);
  return {true, kRateLimit - count - n, 0};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <map>
#include <string>
#include <vector>

#include "ingestd/wal.h"  // wal::Sample

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kRateLimit = 600;  // samples per device per window
constexpr long long kWindowS = 60;

// KEYS: rate:{device}, latest:{device}. ARGV: n, limit, window, then metric/value pairs.
// Decide first; only an admitted batch moves the counter and the latest values.
const std::string kAdmitLua = R"lua(
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
local n = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if count + n > limit then
  local ttl = redis.call('TTL', KEYS[1])
  if ttl < 0 then ttl = 0 end
  return {0, limit - count, ttl}
end
local total = redis.call('INCRBY', KEYS[1], n)
if total == n then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
for i = 4, #ARGV, 2 do
  redis.call('HSET', KEYS[2], ARGV[i], ARGV[i + 1])
end
return {1, limit - total, 0}
)lua";

// The answer to one batch.
struct Admission {
  bool admitted = false;
  long long remaining = 0;
  long long retry_after = 0;
};

// Count a batch of samples against the device's window and record each metric's latest value.
Admission admit(const std::string& device_id, const std::vector<wal::Sample>& samples) {
  std::map<std::string, double> latest;
  for (const wal::Sample& s : samples) latest[s.metric] = s.value;  // a later sample of a metric wins
  const std::vector<std::string> keys = {"rate:" + device_id, "latest:" + device_id};
  std::vector<std::string> args = {std::to_string(samples.size()), std::to_string(kRateLimit), std::to_string(kWindowS)};
  for (const auto& [metric, value] : latest) {
    args.push_back(metric);
    args.push_back(std::to_string(value));
  }
  std::vector<long long> reply;
  redis.eval(kAdmitLua, keys.begin(), keys.end(), args.begin(), args.end(), std::back_inserter(reply));
  return {reply.at(0) == 1, reply.at(1), reply.at(2)};
}
`,
    },
  },
  harness: {
    python: `TS0 = 1_800_000_000


def _samples(n, value=20.0):
    return [{"metric": "temp_c", "value": value, "ts": TS0} for _ in range(n)]


def _count(ctx, device="d-1"):
    return int(ctx.redis.get(f"rate:{device}") or 0)


def check_atomic_admit(ctx):
    m = ctx.load("state")
    first = m.admit("d-1", _samples(500))
    assert first["admitted"] is True, f"the first 500 samples of a fresh window must be admitted, got {first}"
    # A second batch lands right after this one's first command on the counter.
    rival = ctx.redis_after("rate:d-1", lambda: m.admit("d-1", _samples(80)))
    mine = m.admit("d-1", _samples(80))
    assert rival.fired, "the second batch never touched rate:d-1"
    if rival.error is not None:
        raise rival.error
    count = _count(ctx)
    assert count <= 600, f"two racing batches of 80 on top of 500 left rate:d-1 at {count}, past the limit of 600: both read the counter before either moved it"
    outcomes = sorted([mine["admitted"], rival.result["admitted"]])
    assert outcomes == [False, True], f"with 100 samples left exactly one batch of 80 fits; admitted: {outcomes}"
    assert count == 580, f"rate:d-1 holds {count}, expected 580"


def check_refused_writes_nothing(ctx):
    m = ctx.load("state")
    assert m.admit("d-1", _samples(590, value=20.0))["admitted"] is True, "590 samples fit a fresh window"
    refused = m.admit("d-1", _samples(20, value=99.0))
    assert refused["admitted"] is False, f"20 more samples with 10 left must be refused, got {refused}"
    latest = ctx.redis.hget("latest:d-1", "temp_c")
    assert latest is not None and float(latest) == 20.0, f"a refused batch moved latest:d-1 temp_c to {latest}: the dashboard shows a reading the pipeline never admitted"
    assert _count(ctx) == 590, f"a refused batch moved rate:d-1 to {_count(ctx)}, expected 590"


def check_window_expiry(ctx):
    m = ctx.load("state")
    m.admit("d-1", _samples(500))
    m.admit("d-1", _samples(100))
    over = m.admit("d-1", _samples(1))
    assert over["admitted"] is False, f"the 601st sample of a window must be refused, got {over}"
    ttl = ctx.redis.ttl("rate:d-1")
    assert 0 < ttl <= 60, f"rate:d-1 has TTL {ttl}: a counter without an expiry never resets, so a device that had one busy minute is refused for good"
    ctx.clock.advance(61)
    after = m.admit("d-1", _samples(1))
    assert after["admitted"] is True, f"61 s later, in a new window, one sample was refused: {after}"
    assert _count(ctx) == 1, f"the new window's counter holds {_count(ctx)}, expected 1"


def check_retry_after(ctx):
    m = ctx.load("state")
    m.admit("d-1", _samples(500))
    ctx.clock.advance(45)
    refused = m.admit("d-1", _samples(200))
    assert refused["admitted"] is False, f"200 samples with 100 left must be refused, got {refused}"
    assert refused["remaining"] == 100, f"remaining must be the 100 samples left in the window, got {refused['remaining']}"
    assert 14 <= refused["retry_after"] <= 15, f"45 s into a 60-second window retry_after is {refused['retry_after']}, expected the 15 s left on rate:d-1's TTL"
    other = m.admit("d-2", _samples(10))
    assert other["admitted"] is True and other["remaining"] == 590, f"d-2 has its own window: 10 samples leave 590, got {other}"
`,
    typescript: `const TS0 = 1_800_000_000;

const samples = (n: number, value = 20.0) => Array.from({length: n}, () => ({metric: 'temp_c', value, ts: TS0}));
const count = (ctx, device = 'd-1'): number => Number(ctx.redis.get(\`rate:\${device}\`) ?? 0);

export async function check_atomic_admit(ctx) {
  const m = ctx.load('state');
  const first = await m.admit('d-1', samples(500));
  assert.equal(first.admitted, true, \`the first 500 samples of a fresh window must be admitted, got \${JSON.stringify(first)}\`);
  // A second batch lands right after this one's first command on the counter.
  const rival = ctx.redisAfter('rate:d-1', () => m.admit('d-1', samples(80)));
  const mine = await m.admit('d-1', samples(80));
  assert(rival.fired, 'the second batch never touched rate:d-1');
  if (rival.error !== undefined) throw rival.error;
  const theirs = await rival.result;
  const total = count(ctx);
  assert(total <= 600, \`two racing batches of 80 on top of 500 left rate:d-1 at \${total}, past the limit of 600: both read the counter before either moved it\`);
  const outcomes = [mine.admitted, theirs.admitted].sort();
  assert.deepEqual(outcomes, [false, true], \`with 100 samples left exactly one batch of 80 fits; admitted: \${JSON.stringify(outcomes)}\`);
  assert.equal(total, 580, \`rate:d-1 holds \${total}, expected 580\`);
}

export async function check_refused_writes_nothing(ctx) {
  const m = ctx.load('state');
  assert.equal((await m.admit('d-1', samples(590, 20.0))).admitted, true, '590 samples fit a fresh window');
  const refused = await m.admit('d-1', samples(20, 99.0));
  assert.equal(refused.admitted, false, \`20 more samples with 10 left must be refused, got \${JSON.stringify(refused)}\`);
  const latest = ctx.redis.hget('latest:d-1', 'temp_c');
  assert(latest !== null && Number(latest) === 20, \`a refused batch moved latest:d-1 temp_c to \${latest}: the dashboard shows a reading the pipeline never admitted\`);
  assert.equal(count(ctx), 590, \`a refused batch moved rate:d-1 to \${count(ctx)}, expected 590\`);
}

export async function check_window_expiry(ctx) {
  const m = ctx.load('state');
  await m.admit('d-1', samples(500));
  await m.admit('d-1', samples(100));
  const over = await m.admit('d-1', samples(1));
  assert.equal(over.admitted, false, \`the 601st sample of a window must be refused, got \${JSON.stringify(over)}\`);
  const ttl = ctx.redis.ttl('rate:d-1');
  assert(ttl > 0 && ttl <= 60, \`rate:d-1 has TTL \${ttl}: a counter without an expiry never resets, so a device that had one busy minute is refused for good\`);
  ctx.clock.advance(61);
  const after = await m.admit('d-1', samples(1));
  assert.equal(after.admitted, true, \`61 s later, in a new window, one sample was refused: \${JSON.stringify(after)}\`);
  assert.equal(count(ctx), 1, \`the new window's counter holds \${count(ctx)}, expected 1\`);
}

export async function check_retry_after(ctx) {
  const m = ctx.load('state');
  await m.admit('d-1', samples(500));
  ctx.clock.advance(45);
  const refused = await m.admit('d-1', samples(200));
  assert.equal(refused.admitted, false, \`200 samples with 100 left must be refused, got \${JSON.stringify(refused)}\`);
  assert.equal(refused.remaining, 100, \`remaining must be the 100 samples left in the window, got \${refused.remaining}\`);
  assert(refused.retry_after >= 14 && refused.retry_after <= 15, \`45 s into a 60-second window retry_after is \${refused.retry_after}, expected the 15 s left on rate:d-1's TTL\`);
  const other = await m.admit('d-2', samples(10));
  assert(other.admitted === true && other.remaining === 590, \`d-2 has its own window: 10 samples leave 590, got \${JSON.stringify(other)}\`);
}
`,
    go: `package main

import (
	"context"
	"strconv"

	"ingestd/wal"

	"leetbuild/harness"
)

var stateBg = context.Background()

func batchOf(n int, value float64) []wal.Sample {
	out := make([]wal.Sample, n)
	for i := range out {
		out[i] = wal.Sample{Metric: "temp_c", Value: value, TS: 1_800_000_000}
	}
	return out
}

func mustAdmit(ctx *harness.Ctx, device string, n int, value float64) Admission {
	a, err := admit(stateBg, device, batchOf(n, value))
	ctx.NoError(err, "admit(%s, %d samples)", device, n)
	return a
}

func counter(ctx *harness.Ctx, device string) int64 {
	raw, _ := ctx.Redis.Get("rate:" + device)
	n, _ := strconv.ParseInt(raw, 10, 64)
	return n
}

func CheckAtomicAdmit(ctx *harness.Ctx) {
	ctx.Assert(mustAdmit(ctx, "d-1", 500, 20).Admitted, "the first 500 samples of a fresh window must be admitted")
	// A second batch lands right after this one's first command on the counter.
	rival := ctx.Redis.After("rate:d-1", func() any {
		a, err := admit(stateBg, "d-1", batchOf(80, 20))
		ctx.NoError(err, "the racing admit failed")
		return a
	})
	mine := mustAdmit(ctx, "d-1", 80, 20)
	ctx.Assert(rival.Fired, "the second batch never touched rate:d-1")
	ctx.Assert(rival.Err == nil, "the racing admit failed: %v", rival.Err)
	theirs, _ := rival.Result.(Admission)
	total := counter(ctx, "d-1")
	ctx.Assert(total <= 600, "two racing batches of 80 on top of 500 left rate:d-1 at %d, past the limit of 600: both read the counter before either moved it", total)
	ctx.Assert(mine.Admitted != theirs.Admitted, "with 100 samples left exactly one batch of 80 fits; admitted: %v and %v", mine.Admitted, theirs.Admitted)
	ctx.Equal(total, int64(580), "rate:d-1 after the race")
}

func CheckRefusedWritesNothing(ctx *harness.Ctx) {
	ctx.Assert(mustAdmit(ctx, "d-1", 590, 20).Admitted, "590 samples fit a fresh window")
	refused := mustAdmit(ctx, "d-1", 20, 99)
	ctx.Assert(!refused.Admitted, "20 more samples with 10 left must be refused, got %+v", refused)
	latest, _ := ctx.Redis.HGet("latest:d-1", "temp_c")
	value, _ := strconv.ParseFloat(latest, 64)
	ctx.Assert(value == 20, "a refused batch moved latest:d-1 temp_c to %q: the dashboard shows a reading the pipeline never admitted", latest)
	ctx.Equal(counter(ctx, "d-1"), int64(590), "a refused batch must leave rate:d-1")
}

func CheckWindowExpiry(ctx *harness.Ctx) {
	mustAdmit(ctx, "d-1", 500, 20)
	mustAdmit(ctx, "d-1", 100, 20)
	ctx.Assert(!mustAdmit(ctx, "d-1", 1, 20).Admitted, "the 601st sample of a window must be refused")
	ttl := ctx.Redis.TTL("rate:d-1")
	ctx.Assert(ttl > 0 && ttl <= 60, "rate:d-1 has TTL %d: a counter without an expiry never resets, so a device that had one busy minute is refused for good", ttl)
	ctx.Clock.Advance(61)
	after := mustAdmit(ctx, "d-1", 1, 20)
	ctx.Assert(after.Admitted, "61 s later, in a new window, one sample was refused: %+v", after)
	ctx.Equal(counter(ctx, "d-1"), int64(1), "the new window's counter")
}

func CheckRetryAfter(ctx *harness.Ctx) {
	mustAdmit(ctx, "d-1", 500, 20)
	ctx.Clock.Advance(45)
	refused := mustAdmit(ctx, "d-1", 200, 20)
	ctx.Assert(!refused.Admitted, "200 samples with 100 left must be refused, got %+v", refused)
	ctx.Equal(refused.Remaining, int64(100), "remaining must be the samples left in the window")
	ctx.Assert(refused.RetryAfter >= 14 && refused.RetryAfter <= 15, "45 s into a 60-second window RetryAfter is %d, expected the 15 s left on rate:d-1's TTL", refused.RetryAfter)
	other := mustAdmit(ctx, "d-2", 10, 20)
	ctx.Assert(other.Admitted && other.Remaining == 590, "d-2 has its own window: 10 samples leave 590, got %+v", other)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <string>
#include <vector>

#include "ingestd/wal.h"

namespace {

std::vector<wal::Sample> batchOf(int n, double value) { return std::vector<wal::Sample>(n, wal::Sample{"temp_c", value, 1800000000LL}); }

long long counter(harness::Ctx& ctx, const std::string& device) {
  const auto raw = ctx.Redis.Get("rate:" + device);
  return raw ? std::stoll(*raw) : 0;
}

struct Rival {
  bool fired = false;
  Admission result;
  std::string err;
};

}  // namespace

void CheckAtomicAdmit(harness::Ctx& ctx) {
  ctx.Assert(admit("d-1", batchOf(500, 20)).admitted, "the first 500 samples of a fresh window must be admitted");
  // A second batch lands right after this one's first command on the counter.
  auto rival = std::make_shared<Rival>();
  ctx.Redis.After("rate:d-1", [rival] {
    rival->fired = true;
    try {
      rival->result = admit("d-1", batchOf(80, 20));
    } catch (const std::exception& e) {
      rival->err = e.what();
    }
  });
  const Admission mine = admit("d-1", batchOf(80, 20));
  ctx.Assert(rival->fired, "the second batch never touched rate:d-1");
  ctx.Assert(rival->err.empty(), "the racing admit failed: %s", rival->err);
  const long long total = counter(ctx, "d-1");
  ctx.Assert(total <= 600, "two racing batches of 80 on top of 500 left rate:d-1 at %d, past the limit of 600: both read the counter before either moved it", total);
  ctx.Assert(mine.admitted != rival->result.admitted, "with 100 samples left exactly one batch of 80 fits; admitted: %t and %t", mine.admitted, rival->result.admitted);
  ctx.Equal(total, 580LL, "rate:d-1 after the race");
}

void CheckRefusedWritesNothing(harness::Ctx& ctx) {
  ctx.Assert(admit("d-1", batchOf(590, 20)).admitted, "590 samples fit a fresh window");
  const Admission refused = admit("d-1", batchOf(20, 99));
  ctx.Assert(!refused.admitted, "20 more samples with 10 left must be refused");
  const auto latest = ctx.Redis.HGet("latest:d-1", "temp_c");
  ctx.Assert(latest && std::stod(*latest) == 20, "a refused batch moved latest:d-1 temp_c to %q: the dashboard shows a reading the pipeline never admitted", latest.value_or(""));
  ctx.Equal(counter(ctx, "d-1"), 590LL, "a refused batch must leave rate:d-1");
}

void CheckWindowExpiry(harness::Ctx& ctx) {
  admit("d-1", batchOf(500, 20));
  admit("d-1", batchOf(100, 20));
  ctx.Assert(!admit("d-1", batchOf(1, 20)).admitted, "the 601st sample of a window must be refused");
  const long long ttl = ctx.Redis.TTL("rate:d-1");
  ctx.Assert(ttl > 0 && ttl <= 60, "rate:d-1 has TTL %d: a counter without an expiry never resets, so a device that had one busy minute is refused for good", ttl);
  ctx.Clock.Advance(61);
  ctx.Assert(admit("d-1", batchOf(1, 20)).admitted, "61 s later, in a new window, one sample was refused");
  ctx.Equal(counter(ctx, "d-1"), 1LL, "the new window's counter");
}

void CheckRetryAfter(harness::Ctx& ctx) {
  admit("d-1", batchOf(500, 20));
  ctx.Clock.Advance(45);
  const Admission refused = admit("d-1", batchOf(200, 20));
  ctx.Assert(!refused.admitted, "200 samples with 100 left must be refused");
  ctx.Equal(refused.remaining, 100LL, "remaining must be the samples left in the window");
  ctx.Assert(refused.retry_after >= 14 && refused.retry_after <= 15, "45 s into a 60-second window retry_after is %d, expected the 15 s left on rate:d-1's TTL", refused.retry_after);
  const Admission other = admit("d-2", batchOf(10, 20));
  ctx.Assert(other.admitted && other.remaining == 590, "d-2 has its own window: 10 samples must leave 590, got %d", other.remaining);
}
`,
  },
  hints: [
    'Send two batches of 80 at once with 100 samples left in the window: both are admitted. Refuse a batch and look at the dashboard: its readings are there anyway.',
    'The count is read with one command and moved with another, so two requests read the same count; the latest values are written before the decision; nothing ever expires `rate:{device}`, and `retry_after` is a constant.',
    'Move everything into `ADMIT_LUA`: `GET` and compare, return `{0, remaining, TTL}` on refusal, else `INCRBY`, `EXPIRE` when the total equals n, `HSET` each metric, return `{1, remaining, 0}`. Call it once per batch.',
  ],
  debrief: `One script is the smallest thing that makes "read, compare, write" one step: Redis runs it to completion before any other client's command, so the second of two racing batches sees the first one's increment. Putting the latest-value writes behind the same decision is what keeps the dashboard and the counter telling the same story. Expiring the counter on its first write makes the window a fixed window that starts with the device's first batch; its TTL is then exactly what a refused device should wait. A fixed window lets a device send twice its budget across a boundary; production limiters that care use a sliding window or a token bucket in the same script, and keep the limits per device class in Redis so a fleet's budget changes without a deploy.`,
};
