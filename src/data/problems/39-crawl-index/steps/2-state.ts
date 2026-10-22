import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis frontier with per-host politeness tokens',
  concept: 'redis',
  file: 'state',
  focus: ['crawler', 'redis', 'fetcher'],
  task: `## Task

The starter is a plausible model-generated draft: with one host and an idle crawl it hands out URLs
at about the right speed, so the demo looks polite. It is impolite by construction. Find the flaws,
fix them, and prove the fix.

Implement the **frontier** the crawl workers take work from:

- One queue **per host**: the key is \`frontier:{job_id}:{host}\` (\`RPUSH\` to enqueue,
  \`LPOP\` to take). A single shared queue lets one slow host back up the entire crawl and hides
  which host is being hit.
- One **token bucket per host**, keyed \`bucket:{job_id}:{host}\`, whose capacity and refill rate
  are the host's \`rate_per_minute\`. Tokens accrue with elapsed time (\`elapsed_ms * rate / 60000\`)
  and are capped at capacity; the key carries a TTL so an abandoned host stops costing memory.
- The **refill and the take are one atomic Lua \`EVAL\`**: read the bucket, accrue, decide, write and
  return whether a token was taken. A client-side GET-then-SET leaves a window in which two workers
  both see a token and the host gets double its rate for the busy minute.
- A host that answers **429** is **throttled**, not retried at the same rate: \`throttle:{job_id}:{host}\`
  holds a not-before timestamp derived from \`Retry-After\` and doubled per consecutive attempt, and
  \`take\` returns nothing while that timestamp is in the future.

**Failure mode the checks target.** The draft keeps one global queue and one global bucket, so the
whole crawl's capacity can land on a single host. Its client-side refill overshoots under concurrency,
and it has nowhere to record “this host said 429, come back in 30 seconds”, so a hostile or
overloaded host is hammered at exactly the rate that provoked it.`,
  sequence: {
    participants: ['Crawl service', 'Redis frontier', 'Web host'],
    messages: [
      {
        from: 'Crawl service',
        to: 'Redis frontier',
        label: 'RPUSH frontier:{job}:{host} · discovered URL',
        kind: 'sync',
      },
      {from: 'Crawl service', to: 'Redis frontier', label: 'GET throttle:{job}:{host}', kind: 'sync'},
      {from: 'Redis frontier', to: 'Crawl service', label: 'not-before / none — skip while throttled', kind: 'reply'},
      {
        from: 'Crawl service',
        to: 'Redis frontier',
        label: 'EVAL refill + take on bucket:{job}:{host} · one atomic step',
        kind: 'sync',
      },
      {from: 'Redis frontier', to: 'Crawl service', label: '1 = token taken · 0 = empty bucket', kind: 'reply'},
      {from: 'Crawl service', to: 'Web host', label: 'GET path only when the bucket allowed it', kind: 'sync'},
      {from: 'Web host', to: 'Crawl service', label: '429 · Retry-After: 30', kind: 'reply'},
      {from: 'Crawl service', to: 'Redis frontier', label: 'SET throttle:{job}:{host} · now + backoff', kind: 'async'},
    ],
  },
  hints: [
    'Everything the script needs goes in as arguments: capacity, rate, the current time in milliseconds and the TTL. Passing `now` from the caller keeps the script deterministic and testable — `redis.call("TIME")` inside Lua is harder to pin in a unit test.',
    'The script must return the decision, not just the state: `1` when a token was taken and `0` when the bucket was empty, so the caller pops from the host queue only when the host may be fetched. Write the bucket back on both paths, including the refusal, so `refilled_at` moves forward and elapsed time is never counted twice.',
    'Backing off is a host-level fact, not a URL-level one: `Retry-After: 30` becomes a not-before timestamp on `throttle:{job}:{host}`, doubled per consecutive attempt and capped, and every worker checks it before taking work for that host. That is what stops three workers from all retrying the host that just refused them.',
  ],
  checks: [
    {
      id: 'host-queue',
      title: 'One frontier queue per host',
      detail:
        'URLs are enqueued on `frontier:{job_id}:{host}` — a queue per host, pushed with `RPUSH`. The draft pushes every discovery onto one shared `frontier:{job_id}` list.',
      match: {
        python: {all: [/frontier:\{job_id\}:\{host\}/, /rpush\(/]},
        typescript: {all: [/frontier:\$\{jobId\}:\$\{host\}/, /rpush\(/]},
        go: {all: [/frontier:%s:%s/, /RPush\(/]},
        scala: {all: [/frontier:\$jobId:\$host/, /rpush\(/]},
        cpp: {all: [/"frontier:"/, /rpush\(/]},
      },
    },
    {
      id: 'atomic-refill',
      title: 'Refill and take in one atomic Lua script',
      detail:
        'The bucket is read, accrued, spent and written inside one `EVAL` (`REFILL_LUA`). The draft reads with `GET` and writes with `SET` from the client, so two workers can both spend the same token.',
      match: {
        python: {all: [/REFILL_LUA/, /\.eval\(/], none: [/r\.set\(\s*bucket_key/]},
        typescript: {all: [/REFILL_LUA/, /\.eval\(/], none: [/\.set\(\s*bucketKey/]},
        go: {all: [/refillScript/, /\.Eval\(/], none: [/\.Set\(ctx,\s*bucketKey/]},
        scala: {all: [/RefillLua/, /\.eval\(/], none: [/\.set\(\s*bucketKey/]},
        cpp: {all: [/kRefillLua/, /\.eval</], none: [/\.set\(\s*bucketKey/]},
      },
    },
    {
      id: 'bucket-per-host',
      title: 'Bucket keyed per host at the host’s rate',
      detail:
        'The bucket is `bucket:{job_id}:{host}` and its capacity and refill rate come from the host policy’s `rate_per_minute`. One shared bucket spends every host’s politeness at whichever rate the busiest host is fetched.',
      match: {
        python: {all: [/bucket:\{job_id\}:\{host\}/, /rate_per_minute/]},
        typescript: {all: [/bucket:\$\{jobId\}:\$\{host\}/, /rate_per_minute/]},
        go: {all: [/bucket:%s:%s/, /RatePerMinute/]},
        scala: {all: [/bucket:\$jobId:\$host/, /rate_per_minute/]},
        cpp: {all: [/"bucket:"/, /rate_per_minute/]},
      },
    },
    {
      id: 'throttle-429',
      title: 'A 429 throttles the host with exponential backoff',
      detail:
        'A 429 writes a not-before timestamp on `throttle:{job_id}:{host}` computed from `Retry-After`, doubled per consecutive attempt, and `take` skips the host until it passes. The draft cannot express “come back later” at all.',
      match: {
        python: {all: [/throttle:\{job_id\}:\{host\}/, /retry_after/, /backoff/]},
        typescript: {all: [/throttle:\$\{jobId\}:\$\{host\}/, /retry_after/, /backoff/]},
        go: {all: [/throttle:%s:%s/, /retryAfter/, /backoff/]},
        scala: {all: [/throttle:\$jobId:\$host/, /retryAfter/, /backoff/]},
        cpp: {all: [/"throttle:"/, /retry_after/, /backoff/]},
      },
    },
    {
      id: 'no-global-bucket',
      title: 'No shared rate bucket across hosts',
      detail:
        'There is no single `bucket:global` (or equivalent) key that every host spends from: the crawl’s whole rate budget must not be drainable by one host.',
      match: {
        python: {none: [/bucket:global/]},
        typescript: {none: [/bucket:global/]},
        go: {none: [/bucket:global/]},
        scala: {none: [/bucket:global/]},
        cpp: {none: [/bucket:global/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

FRONTIER_KEY = "frontier:{job_id}"
BUCKET_KEY = "bucket:global"
RATE_PER_MINUTE = 30


class HostPolicy:
    def __init__(self, rate_per_minute: int = RATE_PER_MINUTE) -> None:
        self.rate_per_minute = rate_per_minute


def enqueue(job_id: str, host: str, url: str) -> None:
    """Add a discovered URL to the frontier."""
    r.rpush(FRONTIER_KEY.format(job_id=job_id), url)


def take(job_id: str, host: str, policy: HostPolicy) -> str | None:
    """The next URL for a host, if the shared bucket allows a fetch right now."""
    # TODO: this draft keeps one global queue and one global bucket, so a slow host stalls the
    # whole crawl while a fast one absorbs the entire rate budget; it refills with a client-side
    # GET-then-SET so a busy minute over-fetches; and it cannot back a host off after a 429. Use
    # one queue and one bucket per host, do the refill and take in one Lua script, and give a
    # throttled host a not-before time instead of retrying it at the same rate.
    bucket = r.get(BUCKET_KEY)
    tokens = float(bucket) if bucket is not None else float(policy.rate_per_minute)
    tokens = min(float(policy.rate_per_minute), tokens + 1.0)
    r.set(BUCKET_KEY, tokens)
    if tokens < 1:
        return None
    return r.lpop(FRONTIER_KEY.format(job_id=job_id))


def throttle(job_id: str, host: str, retry_after_s: int, attempts: int) -> None:
    """Record a 429 for the host."""
    return None
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

BUCKET_TTL_S = 3600
MAX_THROTTLE_S = 900

REFILL_LUA = """
local capacity = tonumber(ARGV[1])
local rate_per_minute = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'refilled_at')
local tokens = tonumber(state[1]) or capacity
local refilled_at = tonumber(state[2]) or now_ms
local elapsed_ms = math.max(0, now_ms - refilled_at)
tokens = math.min(capacity, tokens + elapsed_ms * rate_per_minute / 60000)
if tokens < 1 then
  redis.call('HSET', KEYS[1], 'tokens', tokens, 'refilled_at', now_ms)
  redis.call('EXPIRE', KEYS[1], ARGV[4])
  return 0
end
redis.call('HSET', KEYS[1], 'tokens', tokens - 1, 'refilled_at', now_ms)
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
"""


class HostPolicy:
    def __init__(self, rate_per_minute: int = 30) -> None:
        self.rate_per_minute = rate_per_minute


def frontier_key(job_id: str, host: str) -> str:
    """The queue of discovered URLs for one host, so hosts cannot back each other up."""
    return f"frontier:{job_id}:{host}"


def bucket_key(job_id: str, host: str) -> str:
    return f"bucket:{job_id}:{host}"


def throttle_key(job_id: str, host: str) -> str:
    return f"throttle:{job_id}:{host}"


def enqueue(job_id: str, host: str, url: str) -> None:
    """Add a discovered URL to that host's queue."""
    r.rpush(frontier_key(job_id, host), url)


def take(job_id: str, host: str, policy: HostPolicy) -> str | None:
    """One URL for the host, or None while its bucket is empty or the host is throttled."""
    now_ms = int(time.time() * 1000)
    not_before = r.get(throttle_key(job_id, host))
    if not_before is not None and now_ms < int(not_before):
        return None
    allowed = r.eval(
        REFILL_LUA,
        1,
        bucket_key(job_id, host),
        policy.rate_per_minute,
        policy.rate_per_minute,
        now_ms,
        BUCKET_TTL_S,
    )
    if int(allowed) == 0:
        return None
    return r.lpop(frontier_key(job_id, host))


def throttle(job_id: str, host: str, retry_after_s: int, attempts: int) -> int:
    """Back the host off after a 429: not before Retry-After, doubled per consecutive attempt."""
    backoff = min(MAX_THROTTLE_S, retry_after_s * (2 ** max(0, attempts - 1)))
    not_before = int(time.time() * 1000) + backoff * 1000
    r.set(throttle_key(job_id, host), not_before, ex=max(backoff, 60))
    return backoff
`,
    },
    typescript: {
      starter: `/** The Redis frontier: a model-generated draft with one queue and one bucket. */
import Redis from 'ioredis';

export const r = new Redis({host: 'redis', port: 6379});

const RATE_PER_MINUTE = 30;

export interface HostPolicy {
  rate_per_minute: number;
}

const FRONTIER_KEY = 'frontier:job';
const BUCKET_KEY = 'bucket:global';

export async function enqueue(_jobId: string, _host: string, url: string): Promise<void> {
  // TODO: this draft keeps one global queue and one global bucket, so a slow host stalls the
  // whole crawl while a fast one absorbs the entire rate budget; it refills with a client-side
  // GET-then-SET so a busy minute over-fetches; and it cannot back a host off after a 429. Use
  // one queue and one bucket per host, do the refill and take in one Lua script, and give a
  // throttled host a not-before time instead of retrying it at the same rate.
  await r.rpush(FRONTIER_KEY, url);
}

export async function take(_jobId: string, _host: string, policy: HostPolicy): Promise<string | null> {
  const bucket = await r.get(BUCKET_KEY);
  let tokens = bucket === null ? policy.rate_per_minute : Number(bucket);
  tokens = Math.min(policy.rate_per_minute, tokens + 1);
  await r.set(BUCKET_KEY, String(tokens));
  if (tokens < 1) return null;
  return r.lpop(FRONTIER_KEY);
}

export async function throttle(_jobId: string, _host: string, _retryAfterS: number, _attempts: number): Promise<number> {
  return 0;
}
`,
      solution: `/** The Redis frontier: one queue per host, one token bucket per host, one atomic script. */
import Redis from 'ioredis';

export const r = new Redis({host: 'redis', port: 6379});

const BUCKET_TTL_S = 3600;
const MAX_THROTTLE_S = 900;

export const REFILL_LUA = \`
local capacity = tonumber(ARGV[1])
local rate_per_minute = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'refilled_at')
local tokens = tonumber(state[1]) or capacity
local refilled_at = tonumber(state[2]) or now_ms
local elapsed_ms = math.max(0, now_ms - refilled_at)
tokens = math.min(capacity, tokens + elapsed_ms * rate_per_minute / 60000)
if tokens < 1 then
  redis.call('HSET', KEYS[1], 'tokens', tokens, 'refilled_at', now_ms)
  redis.call('EXPIRE', KEYS[1], ARGV[4])
  return 0
end
redis.call('HSET', KEYS[1], 'tokens', tokens - 1, 'refilled_at', now_ms)
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
\`;

export interface HostPolicy {
  rate_per_minute: number;
}

export const frontierKey = (jobId: string, host: string): string => \`frontier:\${jobId}:\${host}\`;
export const bucketKey = (jobId: string, host: string): string => \`bucket:\${jobId}:\${host}\`;
export const throttleKey = (jobId: string, host: string): string => \`throttle:\${jobId}:\${host}\`;

export async function enqueue(jobId: string, host: string, url: string): Promise<void> {
  await r.rpush(frontierKey(jobId, host), url);
}

export async function take(jobId: string, host: string, policy: HostPolicy): Promise<string | null> {
  const nowMs = Date.now();
  const notBefore = await r.get(throttleKey(jobId, host));
  if (notBefore !== null && nowMs < Number(notBefore)) return null;
  const allowed = await r.eval(
    REFILL_LUA,
    1,
    bucketKey(jobId, host),
    String(policy.rate_per_minute),
    String(policy.rate_per_minute),
    String(nowMs),
    String(BUCKET_TTL_S),
  );
  if (Number(allowed) === 0) return null;
  return r.lpop(frontierKey(jobId, host));
}

export async function throttle(jobId: string, host: string, retry_after_s: number, attempts: number): Promise<number> {
  const backoff = Math.min(MAX_THROTTLE_S, retry_after_s * 2 ** Math.max(0, attempts - 1));
  const notBefore = Date.now() + backoff * 1000;
  await r.set(throttleKey(jobId, host), String(notBefore), 'EX', Math.max(backoff, 60));
  return backoff;
}
`,
    },
    go: {
      starter: `package state

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

const ratePerMinute = 30

var r = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const bucketKey = "bucket:global"

type HostPolicy struct {
	RatePerMinute int
}

func (p HostPolicy) rate() int {
	if p.RatePerMinute > 0 {
		return p.RatePerMinute
	}
	return ratePerMinute
}

func Enqueue(ctx context.Context, jobID, host, url string) error {
	// TODO: this draft keeps one global queue and one global bucket, so a slow host stalls the
	// whole crawl while a fast one absorbs the entire rate budget; it refills with a client-side
	// GET-then-SET so a busy minute over-fetches; and it cannot back a host off after a 429. Use
	// one queue and one bucket per host, do the refill and take in one Lua script, and give a
	// throttled host a not-before time instead of retrying it at the same rate.
	return r.RPush(ctx, fmt.Sprintf("frontier:%s", jobID), url).Err()
}

func Take(ctx context.Context, jobID, host string, policy HostPolicy) (string, bool, error) {
	raw, err := r.Get(ctx, bucketKey).Result()
	tokens := float64(policy.rate())
	if err == nil {
		tokens, _ = parseFloat(raw)
	}
	tokens = min(float64(policy.rate()), tokens+1)
	if err := r.Set(ctx, bucketKey, tokens, 0).Err(); err != nil {
		return "", false, err
	}
	if tokens < 1 {
		return "", false, nil
	}
	url, err := r.LPop(ctx, fmt.Sprintf("frontier:%s", jobID)).Result()
	if err == redis.Nil {
		return "", false, nil
	}
	return url, err == nil, err
}

func Throttle(ctx context.Context, jobID, host string, retryAfterS, attempts int) (int, error) {
	return 0, nil
}

func parseFloat(raw string) (float64, error) {
	var value float64
	_, err := fmt.Sscanf(raw, "%f", &value)
	return value, err
}
`,
      solution: `package state

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	bucketTTLSeconds = 3600
	maxThrottleS     = 900
)

var r = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const refillScript = \`
local capacity = tonumber(ARGV[1])
local rate_per_minute = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'refilled_at')
local tokens = tonumber(state[1]) or capacity
local refilled_at = tonumber(state[2]) or now_ms
local elapsed_ms = math.max(0, now_ms - refilled_at)
tokens = math.min(capacity, tokens + elapsed_ms * rate_per_minute / 60000)
if tokens < 1 then
  redis.call('HSET', KEYS[1], 'tokens', tokens, 'refilled_at', now_ms)
  redis.call('EXPIRE', KEYS[1], ARGV[4])
  return 0
end
redis.call('HSET', KEYS[1], 'tokens', tokens - 1, 'refilled_at', now_ms)
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
\`

type HostPolicy struct {
	RatePerMinute int
}

func frontierKey(jobID, host string) string {
	return fmt.Sprintf("frontier:%s:%s", jobID, host)
}

func bucketKey(jobID, host string) string {
	return fmt.Sprintf("bucket:%s:%s", jobID, host)
}

func throttleKey(jobID, host string) string {
	return fmt.Sprintf("throttle:%s:%s", jobID, host)
}

func Enqueue(ctx context.Context, jobID, host, url string) error {
	return r.RPush(ctx, frontierKey(jobID, host), url).Err()
}

func Take(ctx context.Context, jobID, host string, policy HostPolicy) (string, bool, error) {
	nowMs := time.Now().UnixMilli()
	notBefore, err := r.Get(ctx, throttleKey(jobID, host)).Int64()
	if err != nil && err != redis.Nil {
		return "", false, err
	}
	if notBefore > 0 && nowMs < notBefore {
		return "", false, nil
	}
	allowed, err := r.Eval(ctx, refillScript, []string{bucketKey(jobID, host)},
		policy.RatePerMinute, policy.RatePerMinute, nowMs, bucketTTLSeconds).Int()
	if err != nil {
		return "", false, err
	}
	if allowed == 0 {
		return "", false, nil
	}
	url, err := r.LPop(ctx, frontierKey(jobID, host)).Result()
	if err == redis.Nil {
		return "", false, nil
	}
	return url, err == nil, err
}

func Throttle(ctx context.Context, jobID, host string, retryAfterS, attempts int) (int, error) {
	backoff := retryAfterS << max(0, attempts-1)
	if backoff > maxThrottleS {
		backoff = maxThrottleS
	}
	notBefore := time.Now().Add(time.Duration(backoff) * time.Second)
	return backoff, r.Set(ctx, throttleKey(jobID, host), notBefore.UnixMilli(), time.Duration(backoff)*time.Second).Err()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object Frontier {
  val RatePerMinute = 30

  val jedis = new Jedis("redis", 6379)

  final case class HostPolicy(rate_per_minute: Int = RatePerMinute)

  val bucketKey = "bucket:global"

  def enqueue(jobId: String, host: String, url: String): Unit = {
    // TODO: this draft keeps one global queue and one global bucket, so a slow host stalls the
    // whole crawl while a fast one absorbs the entire rate budget; it refills with a client-side
    // GET-then-SET so a busy minute over-fetches; and it cannot back a host off after a 429. Use
    // one queue and one bucket per host, do the refill and take in one Lua script, and give a
    // throttled host a not-before time instead of retrying it at the same rate.
    jedis.rpush(s"frontier:$jobId", url)
  }

  def take(jobId: String, host: String, policy: HostPolicy): Option[String] = {
    val stored = Option(jedis.get(bucketKey)).map(_.toDouble)
    val tokens = math.min(policy.rate_per_minute.toDouble, stored.getOrElse(policy.rate_per_minute.toDouble) + 1.0)
    jedis.set(bucketKey, tokens.toString)
    if (tokens < 1) None else Option(jedis.lpop(s"frontier:$jobId"))
  }

  def throttle(jobId: String, host: String, retryAfterS: Int, attempts: Int): Int = 0
}
`,
      solution: `import java.time.Instant

import redis.clients.jedis.Jedis
import scala.jdk.CollectionConverters._

object Frontier {
  val BucketTtlSeconds = 3600
  val MaxThrottleSeconds = 900

  val jedis = new Jedis("redis", 6379)

  final case class HostPolicy(rate_per_minute: Int)

  val RefillLua: String =
    """local capacity = tonumber(ARGV[1])
      |local rate_per_minute = tonumber(ARGV[2])
      |local now_ms = tonumber(ARGV[3])
      |local state = redis.call('HMGET', KEYS[1], 'tokens', 'refilled_at')
      |local tokens = tonumber(state[1]) or capacity
      |local refilled_at = tonumber(state[2]) or now_ms
      |local elapsed_ms = math.max(0, now_ms - refilled_at)
      |tokens = math.min(capacity, tokens + elapsed_ms * rate_per_minute / 60000)
      |if tokens < 1 then
      |  redis.call('HSET', KEYS[1], 'tokens', tokens, 'refilled_at', now_ms)
      |  redis.call('EXPIRE', KEYS[1], ARGV[4])
      |  return 0
      |end
      |redis.call('HSET', KEYS[1], 'tokens', tokens - 1, 'refilled_at', now_ms)
      |redis.call('EXPIRE', KEYS[1], ARGV[4])
      |return 1
      |""".stripMargin

  def frontierKey(jobId: String, host: String): String = s"frontier:$jobId:$host"

  def bucketKey(jobId: String, host: String): String = s"bucket:$jobId:$host"

  def throttleKey(jobId: String, host: String): String = s"throttle:$jobId:$host"

  def enqueue(jobId: String, host: String, url: String): Unit = jedis.rpush(frontierKey(jobId, host), url)

  def take(jobId: String, host: String, policy: HostPolicy): Option[String] = {
    val nowMs = Instant.now().toEpochMilli
    val notBefore = Option(jedis.get(throttleKey(jobId, host))).map(_.toLong)
    if (notBefore.exists(nowMs < _)) return None
    val allowed = jedis.eval(
      RefillLua,
      List(bucketKey(jobId, host)).asJava,
      List(
        policy.rate_per_minute.toString,
        policy.rate_per_minute.toString,
        nowMs.toString,
        BucketTtlSeconds.toString
      ).asJava
    )
    if (allowed.toString.toLong == 0) None else Option(jedis.lpop(frontierKey(jobId, host)))
  }

  def throttle(jobId: String, host: String, retryAfterS: Int, attempts: Int): Int = {
    val backoff = math.min(MaxThrottleSeconds, retryAfterS * (1 << math.max(0, attempts - 1)))
    val notBefore = Instant.now().plusSeconds(backoff)
    jedis.set(throttleKey(jobId, host), notBefore.toEpochMilli.toString)
    jedis.expire(throttleKey(jobId, host), math.max(backoff, 60))
    backoff
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <cmath>
#include <string>

using sw::redis::Redis;

constexpr int kRatePerMinute = 30;

Redis r("tcp://redis:6379");

const std::string bucketKey = "bucket:global";

struct HostPolicy {
  int rate_per_minute = kRatePerMinute;
};

void enqueue(const std::string& jobId, const std::string& host, const std::string& url) {
  // TODO: this draft keeps one global queue and one global bucket, so a slow host stalls the
  // whole crawl while a fast one absorbs the entire rate budget; it refills with a client-side
  // GET-then-SET so a busy minute over-fetches; and it cannot back a host off after a 429. Use
  // one queue and one bucket per host, do the refill and take in one Lua script, and give a
  // throttled host a not-before time instead of retrying it at the same rate.
  r.rpush("frontier:global:" + jobId, url);
}

std::optional<std::string> take(const std::string& jobId, const std::string& host, const HostPolicy& policy) {
  double tokens = static_cast<double>(policy.rate_per_minute);
  if (const auto stored = r.get(bucketKey)) tokens = std::stod(*stored);
  tokens = std::min(static_cast<double>(policy.rate_per_minute), tokens + 1.0);
  r.set(bucketKey, std::to_string(tokens));
  if (tokens < 1) return std::nullopt;
  return r.lpop("frontier:global:" + jobId);
}

int throttle(const std::string& jobId, const std::string& host, int retryAfterS, int attempts) {
  return 0;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <optional>
#include <string>

using sw::redis::Redis;

constexpr int kBucketTtlSeconds = 3600;
constexpr int kMaxThrottleSeconds = 900;

const std::string kRefillLua = R"(
local capacity = tonumber(ARGV[1])
local rate_per_minute = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'refilled_at')
local tokens = tonumber(state[1]) or capacity
local refilled_at = tonumber(state[2]) or now_ms
local elapsed_ms = math.max(0, now_ms - refilled_at)
tokens = math.min(capacity, tokens + elapsed_ms * rate_per_minute / 60000)
if tokens < 1 then
  redis.call('HSET', KEYS[1], 'tokens', tokens, 'refilled_at', now_ms)
  redis.call('EXPIRE', KEYS[1], ARGV[4])
  return 0
end
redis.call('HSET', KEYS[1], 'tokens', tokens - 1, 'refilled_at', now_ms)
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
)";

Redis r("tcp://redis:6379");

struct HostPolicy {
  int rate_per_minute;
};

std::string frontierKey(const std::string& jobId, const std::string& host) {
  return "frontier:" + jobId + ":" + host;
}

std::string bucketKey(const std::string& jobId, const std::string& host) {
  return "bucket:" + jobId + ":" + host;
}

std::string throttleKey(const std::string& jobId, const std::string& host) {
  return "throttle:" + jobId + ":" + host;
}

void enqueue(const std::string& jobId, const std::string& host, const std::string& url) {
  r.rpush(frontierKey(jobId, host), url);
}

std::optional<std::string> take(const std::string& jobId, const std::string& host, const HostPolicy& policy) {
  const auto nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                         std::chrono::system_clock::now().time_since_epoch())
                         .count();
  if (const auto notBefore = r.get(throttleKey(jobId, host))) {
    if (nowMs < std::stoll(*notBefore)) return std::nullopt;
  }
  const auto allowed = r.eval<long long>(
      kRefillLua,
      {bucketKey(jobId, host)},
      {std::to_string(policy.rate_per_minute), std::to_string(policy.rate_per_minute), std::to_string(nowMs),
       std::to_string(kBucketTtlSeconds)});
  if (allowed == 0) return std::nullopt;
  return r.lpop(frontierKey(jobId, host));
}

int throttle(const std::string& jobId, const std::string& host, int retry_after_s, int attempts) {
  const int backoff = std::min(kMaxThrottleSeconds, retry_after_s * (1 << std::max(0, attempts - 1)));
  const auto notBefore = std::chrono::system_clock::now() + std::chrono::seconds(backoff);
  const auto notBeforeMs =
      std::chrono::duration_cast<std::chrono::milliseconds>(notBefore.time_since_epoch()).count();
  r.set(throttleKey(jobId, host), std::to_string(notBeforeMs));
  r.expire(throttleKey(jobId, host), std::max(backoff, 60));
  return backoff;
}
`,
    },
  },
  debrief: `The interviewer is testing whether you understand politeness as a per-host property. The draft looks reasonable because a crawl of one host cannot show the difference: one queue and one bucket behave exactly like per-host ones when there is only one host. Three defects are being checked: the shared queue and shared bucket couple every host's progress to the slowest and fastest one, the client-side refill is a read-modify-write race that overshoots under concurrency, and there is no representation of "this host asked us to come back later". Real crawlers also spread the frontier across instances with a lease (so a crashing worker does not lose its URL), keep the bucket in memory for the hot path with Redis as the arbiter, and lower a host's rate permanently when 429s keep arriving.`,
};
