import type {Language, Matcher, Step} from '@/lib/types';

/** The five languages a course is written in (the drill is not in CUDA). */
type CourseLanguage = Exclude<Language, 'cuda'>;

const EVAL: Record<CourseLanguage, RegExp> = {
  python: /\br\.eval\(|register_script\(|\.evalsha\(/,
  typescript: /redis\.eval\(|defineCommand\(|\.evalsha\(/,
  go: /redis\.NewScript\(|\.Eval\(|\.EvalSha\(/,
  scala: /jedis\.eval(sha)?\(/,
  cpp: /"EVAL"|\.eval(sha)?[<(]/,
};

/** The bucket read, computed or written from the client instead of inside the script. */
const CLIENT_SIDE: Record<CourseLanguage, RegExp[]> = {
  python: [/\br\.(hm?get|hgetall|hset|hincrbyfloat|pttl|pexpire)\(/, /(?<![\w.])(min|ceil)\(/],
  typescript: [/redis\.(hm?get|hgetall|hset|hincrbyfloat|pttl|pexpire)\(/, /Math\.(min|ceil)\(/],
  go: [/rdb\.(HM?Get|HGetAll|HSet|HIncrByFloat|PTTL|PExpire)\(/, /math\.(Min|Ceil)\(/],
  scala: [/jedis\.(hm?get|hgetAll|hset|hincrByFloat|pttl|pexpire)\(/, /Math\.(min|ceil)\(/],
  cpp: [/redis\.(hm?get|hgetall|hset|hincrbyfloat|pttl|pexpire)\(/, /std::(min|ceil)\(/],
};

/** The script is the same Lua in every language, so matchers on it are built once and applied everywhere. */
const perLanguage = (build: (language: CourseLanguage) => Matcher): Record<CourseLanguage, Matcher> => ({
  python: build('python'),
  typescript: build('typescript'),
  go: build('go'),
  scala: build('scala'),
  cpp: build('cpp'),
});

export const lazyRefillStep: Step = {
  id: 'lazy-refill',
  title: 'take(): refill from the clock, take or wait, in one EVAL',
  concept: 'redis',
  file: 'token_bucket',
  focus: ['service', 'redis'],
  task: `## Task

Implement \`take(bucket, cost, now_ms)\` → \`(allowed, tokens_left, wait_ms)\`: a token bucket per \`bucket\`
with \`RATE = 5\` tokens per second and \`CAPACITY = 20\`, decided by **one Lua script** over the hash
\`tb:{bucket}\` (fields \`tokens\`, \`updated_ms\`). The caller passes its clock, \`now_ms\`; the script never
reads \`TIME\`.

- **Refill first**: \`tokens = min(CAPACITY, tokens + (now_ms - updated_ms) × RATE / 1000)\`. A missing hash
  is a **full** bucket (\`tokens = CAPACITY\`, \`updated_ms = now_ms\`). Tokens are fractional: 300 ms earns 1.5.
- **Then decide**: \`cost > CAPACITY\` → denied, \`wait_ms = -1\` (never possible). \`tokens ≥ cost\` → subtract,
  allowed, \`wait_ms = 0\`. Otherwise denied, nothing taken, \`wait_ms = ceil((cost − tokens) × 1000 / RATE)\`.
- **Always write back** \`tokens\` and \`updated_ms = now_ms\` — a denied call still banks the refill — and
  \`PEXPIRE\` the key for \`CAPACITY / RATE × 1000\` ms (4000): idle that long, the bucket is full again
  and the key may go.
- Return the three values from the script. A Lua float reaching Redis is **truncated** to an integer:
  return \`tokens\` as a string (\`tostring\`) and parse it on the client.
- **Exactly one round trip per call** (\`EVAL\` / \`EVALSHA\`), and no hash command from the client.

:::widget token-bucket {"rate": 5, "burst": 20}

> Two servers sharing one bucket read the same last token unless the read, the refill, the compare and
> the write are one script: Redis runs it alone, so the second caller sees the first one's write.`,
  sequence: {
    participants: ['API server', 'Redis'],
    messages: [
      {from: 'API server', to: 'Redis', label: 'EVAL tb:ana  rate=5 capacity=20 cost=1 now=… ttl=4000', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'HMGET → nil → full · 20 ≥ 1 → 19 · HSET · PEXPIRE 4000', kind: 'sync'},
      {from: 'Redis', to: 'API server', label: '{1, "19", 0}', kind: 'reply'},
      {from: 'API server', to: 'Redis', label: 'EVAL … cost=1 now=+300 ms  (bucket at 0)', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'refill 0 + 1.5 → 1.5 ≥ 1 → 0.5 · HSET · PEXPIRE', kind: 'sync'},
      {from: 'Redis', to: 'API server', label: '{1, "0.5", 0}', kind: 'reply'},
      {from: 'API server', to: 'Redis', label: 'EVAL … cost=1 now=+300 ms', kind: 'sync'},
      {from: 'Redis', to: 'API server', label: '{0, "0.5", 100}  — ceil(0.5 × 1000 / 5)', kind: 'reply'},
    ],
  },
  hints: [
    'Pass `RATE`, `CAPACITY`, `cost`, `now_ms` and the TTL as `ARGV`; `KEYS[1]` is `tb:{bucket}`. `HMGET` both fields, `tonumber` them; `nil` tokens means a bucket nobody has seen — start it at `capacity` with `updated = now`.',
    'Refill is `math.min(capacity, tokens + (now - updated) * rate / 1000)`. Then one three-way branch: `cost > capacity` → wait `-1`; `tokens >= cost` → subtract, allowed; else `wait = math.ceil((cost - tokens) * 1000 / rate)`. Return `{allowed, tostring(tokens), wait}` — a raw float would come back truncated.',
    'The `HSET` of both fields and the `PEXPIRE` sit after the branch, unconditionally, so a denial banks the refill and every call renews the TTL. The client sends the script once per call with `eval` (or `evalsha`); there is nothing else to send.',
  ],
  checks: [
    {
      id: 'burst-then-deny',
      title: 'A new bucket allows CAPACITY unit takes, then denies with the wait',
      detail:
        '20 takes of 1 at one instant are allowed with `tokens_left` 19 … 0; the 21st is denied, takes nothing and reports `ceil(1 × 1000 / 5) = 200` ms; a cost of 3 reports 600. The hash `tb:{bucket}` holds `tokens` and `updated_ms`.',
      match: perLanguage(() => ({
        all: [
          /tokens\s*>=\s*cost/,
          /tokens\s*-\s*cost/,
          /math\.ceil\(\s*\(\s*cost\s*-\s*tokens\s*\)\s*\*\s*1000\s*\/\s*rate\s*\)/,
        ],
      })),
    },
    {
      id: 'lazy-refill',
      title: 'Refills by elapsed time, fractionally, capped at CAPACITY',
      detail:
        'An empty bucket holds 1.5 tokens 300 ms later and 0.5 after a unit take; a denied take still writes the refilled `tokens` and `updated_ms` back; 100 s idle gives exactly 20, not 500.',
      match: perLanguage(() => ({
        all: [/math\.min\(\s*capacity\s*,/, /\(\s*now\s*-\s*updated\s*\)\s*\*\s*rate\s*\/\s*1000/],
      })),
    },
    {
      id: 'oversized-cost',
      title: 'A cost above CAPACITY is denied with wait_ms = -1',
      detail:
        'No wait would ever make 21 tokens appear in a bucket of 20: `take` answers `-1`, takes nothing, and still writes the bucket back.',
      match: perLanguage(() => ({all: [/cost\s*>\s*capacity/, /wait\s*=\s*-1/]})),
    },
    {
      id: 'key-expires',
      title: 'The key lives CAPACITY / RATE seconds past the last take',
      detail:
        'After a take `PTTL tb:{bucket}` is at most 4000 ms and the key is gone 4.1 s later — a full bucket needs no key; every take renews the TTL.',
      match: perLanguage(() => ({
        all: [/redis\.call\(\s*['"]PEXPIRE['"]/],
        order: [/redis\.call\(\s*['"]HSET['"]/, /redis\.call\(\s*['"]PEXPIRE['"]/],
      })),
    },
    {
      id: 'atomic',
      title: 'Two servers never spend the same token',
      detail:
        'A second instance’s `take` lands right after the first one’s first command on the key: with one token left exactly one of them is allowed and the hash ends at 0. Read, refill, compare and write must be one script.',
      match: perLanguage(language => ({
        all: [EVAL[language], /redis\.call\(\s*['"]HM?GET['"]/, /redis\.call\(\s*['"]HSET['"]/],
      })),
    },
    {
      id: 'one-round-trip',
      title: 'Exactly one round trip per take, no client-side arithmetic',
      detail:
        'Every `take` sends one `EVAL`/`EVALSHA` and nothing else: no `HMGET`/`HSET`/`PTTL` from the client, no refill computed outside the script — a pipeline is still two commands and still a race.',
      match: perLanguage(language => ({all: [EVAL[language]], none: CLIENT_SIDE[language]})),
    },
  ],
  code: {
    python: {
      starter: `"""A token bucket per key: refilled lazily from the caller's clock, taken atomically — all inside one Lua script."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RATE = 5  # tokens per second
CAPACITY = 20  # tokens; a new bucket starts full
REFILL_MS = CAPACITY * 1000 // RATE  # 4000 ms: idle this long, the bucket is full again and the key may go

# TODO: Lua — HMGET tokens/updated_ms (nil → full bucket) → refill → allow / deny with wait / -1 → HSET → PEXPIRE
#       → return {allowed, tostring(tokens), wait}
TAKE_LUA = ""


def take(bucket: str, cost: float, now_ms: int) -> tuple[bool, float, int]:
    """Refill, then take \`cost\` tokens if they are there: (allowed, tokens left, ms until \`cost\` would be there; -1 = never)."""
    key = f"tb:{bucket}"
    # TODO: one r.eval(TAKE_LUA, 1, key, RATE, CAPACITY, cost, now_ms, REFILL_MS); parse {allowed, tokens, wait_ms}
    raise NotImplementedError
`,
      solution: `"""A token bucket per key: refilled lazily from the caller's clock, taken atomically — all inside one Lua script."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RATE = 5  # tokens per second
CAPACITY = 20  # tokens; a new bucket starts full
REFILL_MS = CAPACITY * 1000 // RATE  # 4000 ms: idle this long, the bucket is full again and the key may go

TAKE_LUA = """
local rate, capacity = tonumber(ARGV[1]), tonumber(ARGV[2])
local cost, now, refill_ms = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'updated_ms')
local tokens, updated = tonumber(bucket[1]), tonumber(bucket[2])
if tokens == nil then
  tokens, updated = capacity, now
end
tokens = math.min(capacity, tokens + (now - updated) * rate / 1000)
local allowed, wait = 0, 0
if cost > capacity then
  wait = -1
elseif tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  wait = math.ceil((cost - tokens) * 1000 / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated_ms', now)
redis.call('PEXPIRE', KEYS[1], refill_ms)
return {allowed, tostring(tokens), wait}
"""


def take(bucket: str, cost: float, now_ms: int) -> tuple[bool, float, int]:
    """Refill, then take \`cost\` tokens if they are there: (allowed, tokens left, ms until \`cost\` would be there; -1 = never)."""
    allowed, tokens, wait_ms = r.eval(TAKE_LUA, 1, f"tb:{bucket}", RATE, CAPACITY, cost, now_ms, REFILL_MS)
    return allowed == 1, float(tokens), int(wait_ms)
`,
    },
    typescript: {
      starter: `/** A token bucket per key: refilled lazily from the caller's clock, taken atomically — all inside one Lua script. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const RATE = 5; // tokens per second
export const CAPACITY = 20; // tokens; a new bucket starts full
export const REFILL_MS = (CAPACITY * 1000) / RATE; // 4000 ms: idle this long, the bucket is full again and the key may go

// TODO: Lua — HMGET tokens/updated_ms (nil → full bucket) → refill → allow / deny with wait / -1 → HSET → PEXPIRE
//       → return {allowed, tostring(tokens), wait}
const TAKE_LUA = '';

/** Refill, then take \`cost\` tokens if they are there: [allowed, tokens left, ms until \`cost\` would be there; -1 = never]. */
export async function take(bucket: string, cost: number, nowMs: number): Promise<[boolean, number, number]> {
  const key = \`tb:\${bucket}\`;
  // TODO: one redis.eval(TAKE_LUA, 1, key, RATE, CAPACITY, cost, nowMs, REFILL_MS); parse [allowed, tokens, waitMs]
  throw new Error(\`not implemented: take(\${key}, \${cost}, \${nowMs})\`);
}
`,
      solution: `/** A token bucket per key: refilled lazily from the caller's clock, taken atomically — all inside one Lua script. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const RATE = 5; // tokens per second
export const CAPACITY = 20; // tokens; a new bucket starts full
export const REFILL_MS = (CAPACITY * 1000) / RATE; // 4000 ms: idle this long, the bucket is full again and the key may go

const TAKE_LUA = \`
local rate, capacity = tonumber(ARGV[1]), tonumber(ARGV[2])
local cost, now, refill_ms = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'updated_ms')
local tokens, updated = tonumber(bucket[1]), tonumber(bucket[2])
if tokens == nil then
  tokens, updated = capacity, now
end
tokens = math.min(capacity, tokens + (now - updated) * rate / 1000)
local allowed, wait = 0, 0
if cost > capacity then
  wait = -1
elseif tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  wait = math.ceil((cost - tokens) * 1000 / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated_ms', now)
redis.call('PEXPIRE', KEYS[1], refill_ms)
return {allowed, tostring(tokens), wait}
\`;

/** Refill, then take \`cost\` tokens if they are there: [allowed, tokens left, ms until \`cost\` would be there; -1 = never]. */
export async function take(bucket: string, cost: number, nowMs: number): Promise<[boolean, number, number]> {
  const reply = (await redis.eval(TAKE_LUA, 1, \`tb:\${bucket}\`, RATE, CAPACITY, cost, nowMs, REFILL_MS)) as [
    number,
    string,
    number,
  ];
  return [reply[0] === 1, Number(reply[1]), reply[2]];
}
`,
    },
    go: {
      starter: `// A token bucket per key: refilled lazily from the caller's clock, taken atomically — all inside one Lua script.
package main

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	rate     = 5.0                            // tokens per second
	capacity = 20.0                           // tokens; a new bucket starts full
	refillMs = int64(capacity * 1000 / rate) // 4000 ms: idle this long, the bucket is full again and the key may go
)

// TODO: Lua — HMGET tokens/updated_ms (nil → full bucket) → refill → allow / deny with wait / -1 → HSET → PEXPIRE
//       → return {allowed, tostring(tokens), wait}
const takeLua = ""

// Take refills, then takes cost tokens if they are there: allowed, tokens left, ms until cost would be there (-1 = never).
func Take(ctx context.Context, bucket string, cost float64, nowMs int64) (bool, float64, int64, error) {
	key := "tb:" + bucket
	// TODO: run takeLua once with KEYS = {key} and ARGV = {rate, capacity, cost, nowMs, refillMs}; parse {allowed, tokens, waitMs}
	_ = key
	return false, 0, 0, errors.New("not implemented")
}
`,
      solution: `// A token bucket per key: refilled lazily from the caller's clock, taken atomically — all inside one Lua script.
package main

import (
	"context"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	rate     = 5.0                            // tokens per second
	capacity = 20.0                           // tokens; a new bucket starts full
	refillMs = int64(capacity * 1000 / rate) // 4000 ms: idle this long, the bucket is full again and the key may go
)

// Run sends EVALSHA and falls back to EVAL once when the script is not loaded yet.
var takeScript = redis.NewScript(\`
local rate, capacity = tonumber(ARGV[1]), tonumber(ARGV[2])
local cost, now, refill_ms = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'updated_ms')
local tokens, updated = tonumber(bucket[1]), tonumber(bucket[2])
if tokens == nil then
  tokens, updated = capacity, now
end
tokens = math.min(capacity, tokens + (now - updated) * rate / 1000)
local allowed, wait = 0, 0
if cost > capacity then
  wait = -1
elseif tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  wait = math.ceil((cost - tokens) * 1000 / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated_ms', now)
redis.call('PEXPIRE', KEYS[1], refill_ms)
return {allowed, tostring(tokens), wait}
\`)

// Take refills, then takes cost tokens if they are there: allowed, tokens left, ms until cost would be there (-1 = never).
func Take(ctx context.Context, bucket string, cost float64, nowMs int64) (bool, float64, int64, error) {
	reply, err := takeScript.Run(ctx, rdb, []string{"tb:" + bucket}, rate, capacity, cost, nowMs, refillMs).Slice()
	if err != nil {
		return false, 0, 0, err
	}
	if len(reply) != 3 {
		return false, 0, 0, fmt.Errorf("take: unexpected reply %v", reply)
	}
	tokens, err := strconv.ParseFloat(reply[1].(string), 64)
	if err != nil {
		return false, 0, 0, err
	}
	return reply[0].(int64) == 1, tokens, reply[2].(int64), nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** A token bucket per key: refilled lazily from the caller's clock, taken atomically — all inside one Lua script. */
object TokenBucket {
  val jedis = new JedisPooled("redis", 6379)

  val Rate = 5.0 // tokens per second
  val Capacity = 20.0 // tokens; a new bucket starts full
  val RefillMs: Long = (Capacity * 1000 / Rate).toLong // 4000 ms: idle this long, the bucket is full again and the key may go

  // TODO: Lua — HMGET tokens/updated_ms (nil → full bucket) → refill → allow / deny with wait / -1 → HSET → PEXPIRE
  //       → return {allowed, tostring(tokens), wait}
  val TakeLua: String = ""

  /** Refill, then take \`cost\` tokens if they are there: (allowed, tokens left, ms until \`cost\` would be there; -1 = never). */
  def take(bucket: String, cost: Double, nowMs: Long): (Boolean, Double, Long) = {
    val key = s"tb:$bucket"
    // TODO: one jedis.eval(TakeLua, List(key), List(Rate, Capacity, cost, nowMs, RefillMs) as strings); parse (allowed, tokens, waitMs)
    throw new NotImplementedError(s"take($key, $cost, $nowMs)")
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/** A token bucket per key: refilled lazily from the caller's clock, taken atomically — all inside one Lua script. */
object TokenBucket {
  val jedis = new JedisPooled("redis", 6379)

  val Rate = 5.0 // tokens per second
  val Capacity = 20.0 // tokens; a new bucket starts full
  val RefillMs: Long = (Capacity * 1000 / Rate).toLong // 4000 ms: idle this long, the bucket is full again and the key may go

  val TakeLua: String =
    """local rate, capacity = tonumber(ARGV[1]), tonumber(ARGV[2])
      |local cost, now, refill_ms = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
      |local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'updated_ms')
      |local tokens, updated = tonumber(bucket[1]), tonumber(bucket[2])
      |if tokens == nil then
      |  tokens, updated = capacity, now
      |end
      |tokens = math.min(capacity, tokens + (now - updated) * rate / 1000)
      |local allowed, wait = 0, 0
      |if cost > capacity then
      |  wait = -1
      |elseif tokens >= cost then
      |  tokens = tokens - cost
      |  allowed = 1
      |else
      |  wait = math.ceil((cost - tokens) * 1000 / rate)
      |end
      |redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated_ms', now)
      |redis.call('PEXPIRE', KEYS[1], refill_ms)
      |return {allowed, tostring(tokens), wait}
      |""".stripMargin

  /** Refill, then take \`cost\` tokens if they are there: (allowed, tokens left, ms until \`cost\` would be there; -1 = never). */
  def take(bucket: String, cost: Double, nowMs: Long): (Boolean, Double, Long) = {
    val args = List(Rate.toString, Capacity.toString, cost.toString, nowMs.toString, RefillMs.toString).asJava
    val reply = jedis.eval(TakeLua, List(s"tb:$bucket").asJava, args).asInstanceOf[java.util.List[AnyRef]]
    (reply.get(0).asInstanceOf[Long] == 1L, reply.get(1).toString.toDouble, reply.get(2).asInstanceOf[Long])
  }
}
`,
    },
    cpp: {
      starter: `// A token bucket per key: refilled lazily from the caller's clock, taken atomically — all inside one Lua script.
#include <sw/redis++/redis++.h>

#include <stdexcept>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr double kRate = 5.0;      // tokens per second
constexpr double kCapacity = 20.0; // tokens; a new bucket starts full
constexpr long long kRefillMs = static_cast<long long>(kCapacity * 1000 / kRate);  // 4000 ms: idle this long, the bucket is full again

// TODO: Lua — HMGET tokens/updated_ms (nil → full bucket) → refill → allow / deny with wait / -1 → HSET → PEXPIRE
//       → return {allowed, tostring(tokens), wait}
const std::string kTakeLua = "";

struct Take {
  bool allowed;
  double tokens_left;
  long long wait_ms;  // until \`cost\` would be there; -1 = never
};

// Refill, then take \`cost\` tokens if they are there — one script, one round trip.
Take take(const std::string& bucket, double cost, long long now_ms) {
  const std::string key = "tb:" + bucket;
  // TODO: run kTakeLua once with KEYS = {key} and ARGV = {kRate, kCapacity, cost, now_ms, kRefillMs}; parse {allowed, tokens, wait_ms}
  throw std::logic_error("not implemented: take(" + key + ")");
}
`,
      solution: `// A token bucket per key: refilled lazily from the caller's clock, taken atomically — all inside one Lua script.
#include <sw/redis++/redis++.h>

#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr double kRate = 5.0;      // tokens per second
constexpr double kCapacity = 20.0; // tokens; a new bucket starts full
constexpr long long kRefillMs = static_cast<long long>(kCapacity * 1000 / kRate);  // 4000 ms: idle this long, the bucket is full again

const std::string kTakeLua = R"lua(
local rate, capacity = tonumber(ARGV[1]), tonumber(ARGV[2])
local cost, now, refill_ms = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])
local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'updated_ms')
local tokens, updated = tonumber(bucket[1]), tonumber(bucket[2])
if tokens == nil then
  tokens, updated = capacity, now
end
tokens = math.min(capacity, tokens + (now - updated) * rate / 1000)
local allowed, wait = 0, 0
if cost > capacity then
  wait = -1
elseif tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  wait = math.ceil((cost - tokens) * 1000 / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated_ms', now)
redis.call('PEXPIRE', KEYS[1], refill_ms)
return {allowed, tostring(tokens), wait}
)lua";

struct Take {
  bool allowed;
  double tokens_left;
  long long wait_ms;  // until \`cost\` would be there; -1 = never
};

// Refill, then take \`cost\` tokens if they are there — one script, one round trip.
Take take(const std::string& bucket, double cost, long long now_ms) {
  const std::string key = "tb:" + bucket;
  auto reply = redis.command("EVAL", kTakeLua, "1", key, std::to_string(kRate), std::to_string(kCapacity),
                             std::to_string(cost), std::to_string(now_ms), std::to_string(kRefillMs));
  const redisReply* r = reply.get();  // {integer, bulk string, integer}
  return {r->element[0]->integer == 1, std::stod(std::string(r->element[1]->str, r->element[1]->len)),
          r->element[2]->integer};
}
`,
    },
  },
  harness: {
    python: `import redis as redis_lib

from leetbuild.metrics import METRICS

T0 = 1_700_000_000_000  # the caller's clock in ms: the harness owns it, nothing here depends on wall time


def _near(value, expected):
    return abs(float(value) - expected) < 1e-6


def _settled(probe, what):
    """The parallel take landed and finished: its result, or its own error re-raised."""
    assert probe.fired, f"take never touched {what}"
    if probe.error is not None:
        raise probe.error
    return probe.result


def check_burst_then_deny(ctx):
    m = ctx.load("token_bucket")
    results = [m.take("api:ana", 1, T0) for _ in range(20)]
    allowed = [bool(a) for a, _, _ in results]
    assert all(allowed), f"a new bucket starts full: 20 unit takes at one instant must all be allowed, got {allowed}"
    left = [t for _, t, _ in results]
    want = [float(x) for x in range(19, -1, -1)]
    assert all(_near(a, b) for a, b in zip(left, want)), f"tokens_left after each unit take must count 19, 18 … 0, got {left}"
    waits = [w for _, _, w in results]
    assert waits == [0] * 20, f"an allowed take reports wait_ms 0, got {waits}"
    denied = m.take("api:ana", 1, T0)
    assert not denied[0], f"the 21st unit take at the same instant must be denied, got {denied}"
    assert _near(denied[1], 0), f"a denied take takes nothing: tokens_left must stay 0, got {denied[1]}"
    assert denied[2] == 200, f"one token from an empty bucket is ceil((1 - 0) * 1000 / 5) = 200 ms away, wait_ms was {denied[2]}"
    assert m.take("api:ana", 3, T0)[2] == 600, "three tokens from an empty bucket are 600 ms away"
    assert bool(m.take("api:bo", 1, T0)[0]), "buckets are independent: api:bo is untouched by api:ana's spending"
    kind = ctx.redis.type("tb:api:ana")
    assert kind == "hash", f"tb:api:ana is {kind!r} (keys: {sorted(ctx.redis.keys('*'))}), expected a hash with tokens and updated_ms"
    fields = ctx.redis.hgetall("tb:api:ana")
    assert set(fields) == {"tokens", "updated_ms"}, f"tb:api:ana has fields {sorted(fields)}, expected tokens and updated_ms"
    assert _near(fields["tokens"], 0), f"tb:api:ana holds {fields['tokens']} tokens after 20 unit takes, expected 0"
    assert int(float(fields["updated_ms"])) == T0, f"updated_ms is {fields['updated_ms']}, expected the caller's now_ms {T0}"


def check_lazy_refill(ctx):
    m = ctx.load("token_bucket")
    for _ in range(20):
        m.take("k", 1, T0)
    a, t, w = m.take("k", 1, T0 + 300)
    assert bool(a) and _near(t, 0.5), f"300 ms at 5 tokens/s earns 1.5 tokens: a unit take is allowed with 0.5 left, got {(a, t, w)}"
    a, t, w = m.take("k", 1, T0 + 300)
    assert not a and _near(t, 0.5) and w == 100, f"with 0.5 tokens a unit take is denied, keeps 0.5 and waits ceil(0.5 * 1000 / 5) = 100 ms, got {(a, t, w)}"
    a, t, w = m.take("k", 1, T0 + 400)
    assert bool(a) and _near(t, 0), f"100 ms later the half token is whole: allowed with 0 left, got {(a, t, w)}"
    a, t, w = m.take("k", 5, T0 + 1400)
    assert bool(a) and _near(t, 0), f"one second earns 5 tokens: a take of 5 is allowed with 0 left, got {(a, t, w)}"
    a, t, w = m.take("k", 5, T0 + 2200)
    assert not a and _near(t, 4) and w == 200, f"800 ms earns 4: a take of 5 is denied with 4 left and 200 ms to wait, got {(a, t, w)}"
    fields = ctx.redis.hgetall("tb:k")
    assert _near(fields.get("tokens", "nan"), 4) and int(float(fields.get("updated_ms", 0))) == T0 + 2200, f"a denied take must still write the refilled bucket back (tokens 4, updated_ms {T0 + 2200}), the hash holds {fields}"
    a, t, w = m.take("k", 5, T0 + 2400)
    assert bool(a) and _near(t, 0), f"200 ms after the denial the 4 banked tokens plus 1 make 5: allowed, got {(a, t, w)}"
    a, t, w = m.take("k", 20, T0 + 100_000)
    assert bool(a) and _near(t, 0), f"100 s idle fills the bucket to CAPACITY (20), not 500: a take of 20 is allowed with 0 left, got {(a, t, w)}"
    a, t, w = m.take("k", 1, T0 + 100_000)
    assert not a and w == 200, f"the refill is capped at 20: nothing is left after taking 20, got {(a, t, w)}"


def check_oversized_cost(ctx):
    m = ctx.load("token_bucket")
    a, t, w = m.take("k", 21, T0)
    assert not a and w == -1, f"21 tokens never fit in a bucket of 20: expected (False, 20, -1), got {(a, t, w)}"
    assert _near(t, 20), f"an impossible take takes nothing: tokens_left must be 20, got {t}"
    assert ctx.redis.exists("tb:k") == 1, "the bucket is written back even when the take is impossible"
    a, t, w = m.take("k", 20, T0)
    assert bool(a) and _near(t, 0), f"the full bucket is still there: a take of exactly 20 is allowed, got {(a, t, w)}"
    a, t, w = m.take("k", 25, T0 + 500)
    assert not a and w == -1, f"an oversized cost on an empty bucket is -1, not a wait, got {(a, t, w)}"
    assert _near(t, 2.5), f"the refill still happens on an impossible take: 500 ms earns 2.5, tokens_left was {t}"


def check_key_expires(ctx):
    m = ctx.load("token_bucket")
    m.take("k", 1, T0)
    pttl = ctx.redis.pttl("tb:k")
    assert 3500 < pttl <= 4000, f"PTTL tb:k is {pttl} ms after a take, expected CAPACITY / RATE * 1000 = 4000 (PEXPIRE)"
    ctx.clock.advance(3.0)
    m.take("k", 1, T0 + 3000)
    pttl = ctx.redis.pttl("tb:k")
    assert 3500 < pttl <= 4000, f"every take renews the TTL: PTTL tb:k is {pttl} ms right after the second take, expected 4000"
    ctx.clock.advance(3.9)
    assert ctx.redis.exists("tb:k") == 1, "3.9 s after the last take the key must still be there"
    ctx.clock.advance(0.2)
    assert ctx.redis.exists("tb:k") == 0, "4.1 s after the last take the key must be gone: a full bucket needs no key"
    a, t, w = m.take("k", 20, T0 + 7100)
    assert bool(a) and _near(t, 0), f"a bucket whose key expired is a new, full bucket: a take of 20 is allowed, got {(a, t, w)}"


def check_atomic(ctx):
    m1 = ctx.load("token_bucket")
    m2 = ctx.reload("token_bucket")
    for _ in range(19):
        m1.take("k", 1, T0)
    # Another server's take lands right after this one's first command on the key — the window a
    # client-side read-refill-write leaves open — and both see one token.
    rival = ctx.redis_after("tb:k", lambda: m2.take("k", 1, T0))
    mine = m1.take("k", 1, T0)
    theirs = _settled(rival, "tb:k")
    winners = [bool(mine[0]), bool(theirs[0])]
    assert winners.count(True) == 1, (
        f"two parallel unit takes on a bucket holding one token returned {mine} and {theirs}: "
        + ("both were allowed — the second server read the bucket before the first wrote it back. Read, refill, compare and write must be one Lua script" if all(winners) else "neither was allowed, but one of them must get the token")
    )
    tokens = ctx.redis.hget("tb:k", "tokens")
    assert _near(tokens, 0), f"tb:k holds {tokens} tokens after the race, expected 0: a lost update left a token behind"
    loser = theirs if winners[0] else mine
    assert loser[2] == 200, f"the denied take reports 200 ms (one token at 5/s), got {loser}"
    a, t, w = m1.take("k", 1, T0)
    assert not a, f"a third take at the same instant must be denied, got {(a, t, w)}"


def check_one_round_trip(ctx):
    m = ctx.load("token_bucket")
    m.take("k", 1, T0)  # warm-up: a script registered on first use may load itself here
    calls = []
    cls = redis_lib.Redis
    real = cls.execute_command

    def record(self, *args, **kw):
        calls.append(str(args[0]).upper())
        return real(self, *args, **kw)

    cls.execute_command = record
    before = METRICS.redis_trips
    try:
        for i in range(5):
            m.take("k", 1, T0 + 100 * i)
    finally:
        cls.execute_command = real
    trips = METRICS.redis_trips - before
    assert trips == 5, f"5 takes made {trips} round trip(s) ({calls}): each take is exactly one EVAL/EVALSHA — a pipeline of HMGET … HSET is still two commands and still a race"
    assert all(c in ("EVAL", "EVALSHA") for c in calls), f"5 takes sent {calls}: the only command a take sends is EVAL/EVALSHA; the hash is read and written inside the script"
`,
    typescript: `const T0 = 1_700_000_000_000; // the caller's clock in ms: the harness owns it, nothing here depends on wall time

const near = (value: unknown, expected: number): boolean => Math.abs(Number(value) - expected) < 1e-6;

type Take = [boolean, number, number];

/** A parallel take that lands right after the first command on \`key\`: await it once it started, its own error re-thrown. */
function rival(ctx, key: string, fn: () => Promise<Take>): (what: string) => Promise<Take> {
  let started: Promise<Take> | undefined;
  ctx.redisAfter(key, () => {
    started = fn();
  });
  return (what: string) => {
    assert(started !== undefined, \`take never touched \${what}\`);
    return started;
  };
}

export async function check_burst_then_deny(ctx) {
  const m = ctx.load('token_bucket');
  const results: Take[] = [];
  for (let i = 0; i < 20; i += 1) results.push(await m.take('api:ana', 1, T0));
  const allowed = results.map(r => Boolean(r[0]));
  assert(allowed.every(Boolean), \`a new bucket starts full: 20 unit takes at one instant must all be allowed, got \${JSON.stringify(allowed)}\`);
  const left = results.map(r => r[1]);
  assert(left.every((t, i) => near(t, 19 - i)), \`tokensLeft after each unit take must count 19, 18 … 0, got \${JSON.stringify(left)}\`);
  const waits = results.map(r => r[2]);
  assert(waits.every(w => w === 0), \`an allowed take reports waitMs 0, got \${JSON.stringify(waits)}\`);
  const denied = await m.take('api:ana', 1, T0);
  assert(!denied[0], \`the 21st unit take at the same instant must be denied, got \${JSON.stringify(denied)}\`);
  assert(near(denied[1], 0), \`a denied take takes nothing: tokensLeft must stay 0, got \${denied[1]}\`);
  assert.equal(denied[2], 200, \`one token from an empty bucket is ceil((1 - 0) * 1000 / 5) = 200 ms away, waitMs was \${denied[2]}\`);
  assert.equal((await m.take('api:ana', 3, T0))[2], 600, 'three tokens from an empty bucket are 600 ms away');
  assert((await m.take('api:bo', 1, T0))[0], "buckets are independent: api:bo is untouched by api:ana's spending");
  const kind = ctx.redis.type('tb:api:ana');
  assert.equal(kind, 'hash', \`tb:api:ana is \${JSON.stringify(kind)} (keys: \${JSON.stringify(ctx.redis.keys('*').sort())}), expected a hash with tokens and updated_ms\`);
  const fields = ctx.redis.hgetall('tb:api:ana') as Record<string, string>;
  assert.deepEqual(Object.keys(fields).sort(), ['tokens', 'updated_ms'], \`tb:api:ana has fields \${JSON.stringify(Object.keys(fields).sort())}, expected tokens and updated_ms\`);
  assert(near(fields.tokens, 0), \`tb:api:ana holds \${fields.tokens} tokens after 20 unit takes, expected 0\`);
  assert.equal(Math.trunc(Number(fields.updated_ms)), T0, \`updated_ms is \${fields.updated_ms}, expected the caller's nowMs \${T0}\`);
}

export async function check_lazy_refill(ctx) {
  const m = ctx.load('token_bucket');
  for (let i = 0; i < 20; i += 1) await m.take('k', 1, T0);
  let r: Take = await m.take('k', 1, T0 + 300);
  assert(r[0] && near(r[1], 0.5), \`300 ms at 5 tokens/s earns 1.5 tokens: a unit take is allowed with 0.5 left, got \${JSON.stringify(r)}\`);
  r = await m.take('k', 1, T0 + 300);
  assert(!r[0] && near(r[1], 0.5) && r[2] === 100, \`with 0.5 tokens a unit take is denied, keeps 0.5 and waits ceil(0.5 * 1000 / 5) = 100 ms, got \${JSON.stringify(r)}\`);
  r = await m.take('k', 1, T0 + 400);
  assert(r[0] && near(r[1], 0), \`100 ms later the half token is whole: allowed with 0 left, got \${JSON.stringify(r)}\`);
  r = await m.take('k', 5, T0 + 1400);
  assert(r[0] && near(r[1], 0), \`one second earns 5 tokens: a take of 5 is allowed with 0 left, got \${JSON.stringify(r)}\`);
  r = await m.take('k', 5, T0 + 2200);
  assert(!r[0] && near(r[1], 4) && r[2] === 200, \`800 ms earns 4: a take of 5 is denied with 4 left and 200 ms to wait, got \${JSON.stringify(r)}\`);
  const fields = ctx.redis.hgetall('tb:k') as Record<string, string>;
  assert(near(fields.tokens ?? 'nan', 4) && Math.trunc(Number(fields.updated_ms ?? 0)) === T0 + 2200, \`a denied take must still write the refilled bucket back (tokens 4, updated_ms \${T0 + 2200}), the hash holds \${JSON.stringify(fields)}\`);
  r = await m.take('k', 5, T0 + 2400);
  assert(r[0] && near(r[1], 0), \`200 ms after the denial the 4 banked tokens plus 1 make 5: allowed, got \${JSON.stringify(r)}\`);
  r = await m.take('k', 20, T0 + 100_000);
  assert(r[0] && near(r[1], 0), \`100 s idle fills the bucket to CAPACITY (20), not 500: a take of 20 is allowed with 0 left, got \${JSON.stringify(r)}\`);
  r = await m.take('k', 1, T0 + 100_000);
  assert(!r[0] && r[2] === 200, \`the refill is capped at 20: nothing is left after taking 20, got \${JSON.stringify(r)}\`);
}

export async function check_oversized_cost(ctx) {
  const m = ctx.load('token_bucket');
  let r: Take = await m.take('k', 21, T0);
  assert(!r[0] && r[2] === -1, \`21 tokens never fit in a bucket of 20: expected [false, 20, -1], got \${JSON.stringify(r)}\`);
  assert(near(r[1], 20), \`an impossible take takes nothing: tokensLeft must be 20, got \${r[1]}\`);
  assert.equal(ctx.redis.exists('tb:k'), 1, 'the bucket is written back even when the take is impossible');
  r = await m.take('k', 20, T0);
  assert(r[0] && near(r[1], 0), \`the full bucket is still there: a take of exactly 20 is allowed, got \${JSON.stringify(r)}\`);
  r = await m.take('k', 25, T0 + 500);
  assert(!r[0] && r[2] === -1, \`an oversized cost on an empty bucket is -1, not a wait, got \${JSON.stringify(r)}\`);
  assert(near(r[1], 2.5), \`the refill still happens on an impossible take: 500 ms earns 2.5, tokensLeft was \${r[1]}\`);
}

export async function check_key_expires(ctx) {
  const m = ctx.load('token_bucket');
  await m.take('k', 1, T0);
  let pttl = ctx.redis.pttl('tb:k');
  assert(3500 < pttl && pttl <= 4000, \`PTTL tb:k is \${pttl} ms after a take, expected CAPACITY / RATE * 1000 = 4000 (PEXPIRE)\`);
  ctx.clock.advance(3.0);
  await m.take('k', 1, T0 + 3000);
  pttl = ctx.redis.pttl('tb:k');
  assert(3500 < pttl && pttl <= 4000, \`every take renews the TTL: PTTL tb:k is \${pttl} ms right after the second take, expected 4000\`);
  ctx.clock.advance(3.9);
  assert.equal(ctx.redis.exists('tb:k'), 1, '3.9 s after the last take the key must still be there');
  ctx.clock.advance(0.2);
  assert.equal(ctx.redis.exists('tb:k'), 0, '4.1 s after the last take the key must be gone: a full bucket needs no key');
  const r: Take = await m.take('k', 20, T0 + 7100);
  assert(r[0] && near(r[1], 0), \`a bucket whose key expired is a new, full bucket: a take of 20 is allowed, got \${JSON.stringify(r)}\`);
}

export async function check_atomic(ctx) {
  const m1 = ctx.load('token_bucket');
  const m2 = ctx.reload('token_bucket');
  for (let i = 0; i < 19; i += 1) await m1.take('k', 1, T0);
  // Another server's take lands right after this one's first command on the key — the window a
  // client-side read-refill-write leaves open — and both see one token.
  const settled = rival(ctx, 'tb:k', () => m2.take('k', 1, T0));
  const mine: Take = await m1.take('k', 1, T0);
  const theirs = await settled('tb:k');
  const winners = [Boolean(mine[0]), Boolean(theirs[0])];
  assert.equal(
    winners.filter(Boolean).length,
    1,
    \`two parallel unit takes on a bucket holding one token returned \${JSON.stringify(mine)} and \${JSON.stringify(theirs)}: \` +
      (winners[0] && winners[1]
        ? 'both were allowed — the second server read the bucket before the first wrote it back. Read, refill, compare and write must be one Lua script'
        : 'neither was allowed, but one of them must get the token'),
  );
  const tokens = ctx.redis.hget('tb:k', 'tokens');
  assert(near(tokens, 0), \`tb:k holds \${tokens} tokens after the race, expected 0: a lost update left a token behind\`);
  const loser = winners[0] ? theirs : mine;
  assert.equal(loser[2], 200, \`the denied take reports 200 ms (one token at 5/s), got \${JSON.stringify(loser)}\`);
  const third: Take = await m1.take('k', 1, T0);
  assert(!third[0], \`a third take at the same instant must be denied, got \${JSON.stringify(third)}\`);
}

export async function check_one_round_trip(ctx) {
  const m = ctx.load('token_bucket');
  await m.take('k', 1, T0); // warm-up: a script registered on first use may load itself here
  const before = ctx.redisRoundTrips().length;
  for (let i = 0; i < 5; i += 1) await m.take('k', 1, T0 + 100 * i);
  const trips = ctx.redisRoundTrips().slice(before);
  assert.equal(trips.length, 5, \`5 takes made \${trips.length} round trip(s) (\${JSON.stringify(trips)}): each take is exactly one EVAL/EVALSHA — a pipeline of HMGET … HSET is still two commands and still a race\`);
  const calls = trips.flat();
  assert(calls.every(c => c === 'EVAL' || c === 'EVALSHA'), \`5 takes sent \${JSON.stringify(trips)}: the only command a take sends is EVAL/EVALSHA; the hash is read and written inside the script\`);
}
`,
  },
  debrief: `The bucket is two numbers and the caller's clock, which is why it fits in one hash and twenty lines of Lua. Three choices carry the design. The refill is **lazy** — computed from \`now - updated_ms\` at the moment of a decision, never by a timer — so an idle bucket costs nothing and a million buckets cost nothing. The decision runs **inside Redis**: the script reads, refills, compares and writes while no other command runs, so every server that shares the bucket sees one consistent counter without a lock, and the race the harness lands (a second take between a read and its write-back) simply cannot happen. And the caller passes \`now_ms\` rather than the script calling \`TIME\`, which keeps the script a pure function of its arguments — replayable, replicable, testable with a clock the test owns. The small print is where buckets go wrong in production: a Lua float returned raw is truncated to an integer (hence \`tostring\`), a denial must still write back or the refill it computed is lost, and the \`PEXPIRE\` of exactly one full refill is what lets a key disappear without the bucket ever looking less than full. Real limiters add a per-route and a global bucket, cache the script with \`SCRIPT LOAD\`/\`EVALSHA\` and fall back on \`NOSCRIPT\`, fail open when Redis is unreachable, and turn \`wait_ms\` into \`Retry-After\`.`,
};
