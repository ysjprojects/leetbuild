import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis frontier: a queue and a token bucket per host, spent in one script',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['crawler', 'redis'],
  task: `## Task

**Starting point.** The starter is the frontier every crawl worker takes work from:
\`enqueue(job_id, host, url)\` pushes the URL with \`RPUSH\` and records it in \`pending:{job_id}\`;
\`take(job_id, host, rate_per_minute)\` refills the host's bucket \`bucket:{job_id}:{host}\` (fields
\`tokens\`, \`ts\`) and pops a URL with \`LPOP\`; \`throttle(job_id, host, retry_after_s)\` records a
429 in \`throttle:{job_id}:{host}\`; \`requeue\` puts a URL back. With one host and one worker it
paces requests about right. It hides five flaws.

**Failure mode the checks target.** A take for one host hands out another host's URL; two workers
both spend the last token; a host idle for an hour gets every queued URL at once; a host that
answered 429 keeps being fetched; and every host ever crawled keeps a bucket in Redis.

- One queue per host: \`frontier:{job_id}:{host}\`.
- Tokens accrue at \`elapsed_ms * rate_per_minute / 60000\`, capped at \`BURST\` (2); a new bucket
  starts full.
- The refill, the spend and the \`LPOP\` are one Lua script (\`EVAL\`), which also answers nothing
  while \`throttle:{job_id}:{host}\` holds a time (ms) still in the future.
- The bucket expires \`BUCKET_TTL_MS\` (one hour) after its last take.`,
  sequence: {
    participants: ['Crawl worker', 'Redis frontier', 'Second worker'],
    messages: [
      {
        from: 'Crawl worker',
        to: 'Redis frontier',
        label: 'RPUSH frontier:{job}:{host} url · ZADD NX pending:{job}',
        kind: 'sync',
      },
      {
        from: 'Crawl worker',
        to: 'Redis frontier',
        label: 'EVAL take · bucket, queue, throttle · now, rate, BURST, TTL',
        kind: 'sync',
      },
      {
        from: 'Redis frontier',
        to: 'Redis frontier',
        label: 'throttled? refill ≤ BURST · token? LPOP · HSET · PEXPIRE',
        kind: 'sync',
      },
      {from: 'Redis frontier', to: 'Crawl worker', label: 'url · or nil', kind: 'reply'},
      {
        from: 'Second worker',
        to: 'Redis frontier',
        label: 'EVAL take (runs after, sees the spent token)',
        kind: 'sync',
      },
      {from: 'Redis frontier', to: 'Second worker', label: 'nil', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'per-host-queue',
      title: 'One queue per host',
      detail:
        "URLs are queued under `frontier:{job_id}:{host}` and `take` pops only from the host it was asked about. The starter keeps one list per job, so a take for one host can hand out another host's URL.",
      match: {
        python: {all: [/frontier:\{job_id\}:\{host\}/], none: [/["']frontier:\{job_id\}["']/]},
        typescript: {all: [/frontier:\$\{jobId\}:\$\{host\}/], none: [/`frontier:\$\{jobId\}`/]},
        go: {
          all: [/"frontier:"\s*\+\s*jobID\s*\+\s*":"\s*\+\s*host|"frontier:%s:%s"/],
          none: [/"frontier:"\s*\+\s*jobID\s*\}/],
        },
        cpp: {all: [/"frontier:"\s*\+\s*job_id\s*\+\s*":"\s*\+\s*host/], none: [/"frontier:"\s*\+\s*job_id;/]},
      },
    },
    {
      id: 'atomic-take',
      title: 'Refill, spend and pop in one Lua script',
      detail:
        'The bucket is read, refilled, spent and the URL popped inside one script (`register_script`/`EVAL`), never with a client-side `HMGET` then `HSET`: a second worker landing between them reads the same tokens and both take a URL.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]HM?GET['"]/, /redis\.call\(\s*['"]LPOP['"]/],
          none: [/\.hmget\(|\.hget\(|\.hgetall\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]HM?GET['"]/, /redis\.call\(\s*['"]LPOP['"]/],
          none: [/\.hmget\(|\.hget\(|\.hgetall\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]HM?GET['"]/, /redis\.call\(\s*['"]LPOP['"]/],
          none: [/\.HMGet\(|\.HGet\(|\.HGetAll\(/],
        },
        cpp: {
          all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]HM?GET['"]/, /redis\.call\(\s*['"]LPOP['"]/],
          none: [/\.hmget\(|\.hget\(|\.hgetall\(/],
        },
      },
    },
    {
      id: 'refill-cap',
      title: 'Tokens are capped at BURST',
      detail:
        'The refill is `min(burst, tokens + elapsed_ms * rate / 60000)`: a host idle for an hour gets `BURST` URLs, then one per refill interval, and a take on an empty queue spends no token. The starter adds the elapsed time without a cap.',
      match: {
        python: {all: [/math\.min\(\s*burst|tokens\s*>\s*burst/]},
        typescript: {all: [/math\.min\(\s*burst|tokens\s*>\s*burst/]},
        go: {all: [/math\.min\(\s*burst|tokens\s*>\s*burst/]},
        cpp: {all: [/math\.min\(\s*burst|tokens\s*>\s*burst/]},
      },
    },
    {
      id: 'throttle',
      title: 'A throttled host gets nothing until its not-before time',
      detail:
        '`take` reads `throttle:{job_id}:{host}` (inside the script) and hands out nothing while the time it holds is in the future; other hosts keep moving. The starter records the 429 and never reads it.',
      match: {
        python: {all: [/def take(?:(?!\ndef )[\s\S])*?throttle_key\(/]},
        typescript: {all: [/function take(?:(?!\nexport )[\s\S])*?throttleKey\(/]},
        go: {all: [/func take(?:(?!\n\})[\s\S])*?throttleKey\(/]},
        cpp: {all: [/ take\((?:(?!\n\})[\s\S])*?throttleKey\(/]},
      },
    },
    {
      id: 'bucket-ttl',
      title: "An idle host's bucket expires",
      detail:
        "Every take sets the bucket's expiry to the full `BUCKET_TTL_MS` (`PEXPIRE`) in the same script that writes the bucket, so a host the crawl stopped visiting stops costing memory; after an hour its bucket would be full anyway. The starter writes buckets that never expire.",
      match: {
        python: {all: [/P?EXPIRE['"]|\.p?expire\(/i, /BUCKET_TTL_MS/]},
        typescript: {all: [/P?EXPIRE['"]|\.p?expire\(/i, /BUCKET_TTL_MS/]},
        go: {all: [/P?EXPIRE['"]|\.P?Expire\(/i, /bucketTTLMs/]},
        cpp: {all: [/P?EXPIRE['"]|\.p?expire\(/i, /kBucketTtlMs/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

BURST = 2


def queue_key(job_id: str) -> str:
    return f"frontier:{job_id}"


def bucket_key(job_id: str, host: str) -> str:
    return f"bucket:{job_id}:{host}"


def throttle_key(job_id: str, host: str) -> str:
    return f"throttle:{job_id}:{host}"


def pending_key(job_id: str) -> str:
    return f"pending:{job_id}"


def enqueue(job_id: str, host: str, url: str) -> None:
    """Queue url on its host; it is pending from now until an outcome is recorded."""
    r.rpush(queue_key(job_id), url)
    r.zadd(pending_key(job_id), {url: time.time()}, nx=True)


def take(job_id: str, host: str, rate_per_minute: int) -> str | None:
    """The next URL of the host if the host is not throttled and its bucket holds a token, else None."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    now_ms = int(time.time() * 1000)
    tokens, ts = r.hmget(bucket_key(job_id, host), "tokens", "ts")
    tokens = BURST if tokens is None else float(tokens)
    ts = now_ms if ts is None else int(ts)
    tokens += (now_ms - ts) * rate_per_minute / 60000
    url = None
    if tokens >= 1:
        url = r.lpop(queue_key(job_id))
        if url is not None:
            tokens -= 1
    r.hset(bucket_key(job_id, host), mapping={"tokens": tokens, "ts": now_ms})
    return url


def throttle(job_id: str, host: str, retry_after_s: int) -> None:
    """The host answered 429: take hands out nothing for it for retry_after_s seconds."""
    wait_ms = max(int(retry_after_s), 1) * 1000
    r.set(throttle_key(job_id, host), int(time.time() * 1000) + wait_ms, px=wait_ms)


def requeue(job_id: str, host: str, url: str) -> None:
    """Put a taken URL back at the tail of its host's queue."""
    r.rpush(queue_key(job_id), url)
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

BURST = 2
BUCKET_TTL_MS = 3_600_000

# KEYS: the host's bucket, queue and throttle. ARGV: now (ms), rate per minute, burst, bucket TTL (ms).
TAKE_LUA = """
local now = tonumber(ARGV[1])
if now < tonumber(redis.call('GET', KEYS[3]) or '0') then return false end
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or burst
local ts = tonumber(state[2]) or now
tokens = math.min(burst, tokens + (now - ts) * rate / 60000)
local url = false
if tokens >= 1 then
  url = redis.call('LPOP', KEYS[2])
  if url then tokens = tokens - 1 end
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return url
"""
take_script = r.register_script(TAKE_LUA)


def queue_key(job_id: str, host: str) -> str:
    return f"frontier:{job_id}:{host}"


def bucket_key(job_id: str, host: str) -> str:
    return f"bucket:{job_id}:{host}"


def throttle_key(job_id: str, host: str) -> str:
    return f"throttle:{job_id}:{host}"


def pending_key(job_id: str) -> str:
    return f"pending:{job_id}"


def enqueue(job_id: str, host: str, url: str) -> None:
    """Queue url on its host; it is pending from now until an outcome is recorded."""
    r.rpush(queue_key(job_id, host), url)
    r.zadd(pending_key(job_id), {url: time.time()}, nx=True)


def take(job_id: str, host: str, rate_per_minute: int) -> str | None:
    """The next URL of the host if the host is not throttled and its bucket holds a token, else None."""
    now_ms = int(time.time() * 1000)
    keys = [bucket_key(job_id, host), queue_key(job_id, host), throttle_key(job_id, host)]
    return take_script(keys=keys, args=[now_ms, rate_per_minute, BURST, BUCKET_TTL_MS])


def throttle(job_id: str, host: str, retry_after_s: int) -> None:
    """The host answered 429: take hands out nothing for it for retry_after_s seconds."""
    wait_ms = max(int(retry_after_s), 1) * 1000
    r.set(throttle_key(job_id, host), int(time.time() * 1000) + wait_ms, px=wait_ms)


def requeue(job_id: str, host: str, url: str) -> None:
    """Put a taken URL back at the tail of its host's queue."""
    r.rpush(queue_key(job_id, host), url)
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const BURST = 2;

export const queueKey = (jobId: string): string => \`frontier:\${jobId}\`;
export const bucketKey = (jobId: string, host: string): string => \`bucket:\${jobId}:\${host}\`;
export const throttleKey = (jobId: string, host: string): string => \`throttle:\${jobId}:\${host}\`;
export const pendingKey = (jobId: string): string => \`pending:\${jobId}\`;

/** Queue url on its host; it is pending from now until an outcome is recorded. */
export async function enqueue(jobId: string, host: string, url: string): Promise<void> {
  await redis.rpush(queueKey(jobId), url);
  await redis.zadd(pendingKey(jobId), 'NX', Date.now() / 1000, url);
}

/** The next URL of the host if the host is not throttled and its bucket holds a token, else null. */
export async function take(jobId: string, host: string, ratePerMinute: number): Promise<string | null> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const now = Date.now();
  const [savedTokens, savedTs] = await redis.hmget(bucketKey(jobId, host), 'tokens', 'ts');
  let tokens = savedTokens === null ? BURST : Number(savedTokens);
  const ts = savedTs === null ? now : Number(savedTs);
  tokens += ((now - ts) * ratePerMinute) / 60000;
  let url: string | null = null;
  if (tokens >= 1) {
    url = await redis.lpop(queueKey(jobId));
    if (url !== null) tokens -= 1;
  }
  await redis.hset(bucketKey(jobId, host), {tokens: String(tokens), ts: String(now)});
  return url;
}

/** The host answered 429: take hands out nothing for it for retryAfterS seconds. */
export async function throttle(jobId: string, host: string, retryAfterS: number): Promise<void> {
  const waitMs = Math.max(Math.floor(retryAfterS), 1) * 1000;
  await redis.set(throttleKey(jobId, host), String(Date.now() + waitMs), 'PX', waitMs);
}

/** Put a taken URL back at the tail of its host's queue. */
export async function requeue(jobId: string, host: string, url: string): Promise<void> {
  await redis.rpush(queueKey(jobId), url);
}
`,
      solution: `import Redis from 'ioredis';

export const BURST = 2;
export const BUCKET_TTL_MS = 3_600_000;

// KEYS: the host's bucket, queue and throttle. ARGV: now (ms), rate per minute, burst, bucket TTL (ms).
export const TAKE_LUA = \`
local now = tonumber(ARGV[1])
if now < tonumber(redis.call('GET', KEYS[3]) or '0') then return false end
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or burst
local ts = tonumber(state[2]) or now
tokens = math.min(burst, tokens + (now - ts) * rate / 60000)
local url = false
if tokens >= 1 then
  url = redis.call('LPOP', KEYS[2])
  if url then tokens = tokens - 1 end
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return url
\`;

interface FrontierRedis extends Redis {
  takeUrl(bucket: string, queue: string, throttle: string, now: number, rate: number, burst: number, ttl: number): Promise<string | null>;
}

const redis = new Redis({host: 'redis', port: 6379}) as FrontierRedis;
redis.defineCommand('takeUrl', {numberOfKeys: 3, lua: TAKE_LUA});

export const queueKey = (jobId: string, host: string): string => \`frontier:\${jobId}:\${host}\`;
export const bucketKey = (jobId: string, host: string): string => \`bucket:\${jobId}:\${host}\`;
export const throttleKey = (jobId: string, host: string): string => \`throttle:\${jobId}:\${host}\`;
export const pendingKey = (jobId: string): string => \`pending:\${jobId}\`;

/** Queue url on its host; it is pending from now until an outcome is recorded. */
export async function enqueue(jobId: string, host: string, url: string): Promise<void> {
  await redis.rpush(queueKey(jobId, host), url);
  await redis.zadd(pendingKey(jobId), 'NX', Date.now() / 1000, url);
}

/** The next URL of the host if the host is not throttled and its bucket holds a token, else null. */
export async function take(jobId: string, host: string, ratePerMinute: number): Promise<string | null> {
  return redis.takeUrl(bucketKey(jobId, host), queueKey(jobId, host), throttleKey(jobId, host), Date.now(), ratePerMinute, BURST, BUCKET_TTL_MS);
}

/** The host answered 429: take hands out nothing for it for retryAfterS seconds. */
export async function throttle(jobId: string, host: string, retryAfterS: number): Promise<void> {
  const waitMs = Math.max(Math.floor(retryAfterS), 1) * 1000;
  await redis.set(throttleKey(jobId, host), String(Date.now() + waitMs), 'PX', waitMs);
}

/** Put a taken URL back at the tail of its host's queue. */
export async function requeue(jobId: string, host: string, url: string): Promise<void> {
  await redis.rpush(queueKey(jobId, host), url);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const burst = 2

func queueKey(jobID string) string          { return "frontier:" + jobID }
func bucketKey(jobID, host string) string   { return "bucket:" + jobID + ":" + host }
func throttleKey(jobID, host string) string { return "throttle:" + jobID + ":" + host }
func pendingKey(jobID string) string        { return "pending:" + jobID }

// enqueue queues url on its host; it is pending from now until an outcome is recorded.
func enqueue(ctx context.Context, jobID, host, url string) error {
	if err := rdb.RPush(ctx, queueKey(jobID), url).Err(); err != nil {
		return err
	}
	return rdb.ZAddNX(ctx, pendingKey(jobID), redis.Z{Score: float64(time.Now().UnixMilli()) / 1000, Member: url}).Err()
}

// take is the next URL of the host if the host is not throttled and its bucket holds a token, else "".
func take(ctx context.Context, jobID, host string, ratePerMinute int) (string, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	nowMs := time.Now().UnixMilli()
	state, err := rdb.HMGet(ctx, bucketKey(jobID, host), "tokens", "ts").Result()
	if err != nil {
		return "", err
	}
	tokens := float64(burst)
	ts := nowMs
	if saved, ok := state[0].(string); ok {
		tokens, _ = strconv.ParseFloat(saved, 64)
	}
	if saved, ok := state[1].(string); ok {
		ts, _ = strconv.ParseInt(saved, 10, 64)
	}
	tokens += float64(nowMs-ts) * float64(ratePerMinute) / 60000
	url := ""
	if tokens >= 1 {
		popped, err := rdb.LPop(ctx, queueKey(jobID)).Result()
		if err != nil && err != redis.Nil {
			return "", err
		}
		if err == nil {
			url = popped
			tokens--
		}
	}
	return url, rdb.HSet(ctx, bucketKey(jobID, host), "tokens", tokens, "ts", nowMs).Err()
}

// throttle: the host answered 429, take hands out nothing for it for retryAfterS seconds.
func throttle(ctx context.Context, jobID, host string, retryAfterS int) error {
	if retryAfterS < 1 {
		retryAfterS = 1
	}
	wait := time.Duration(retryAfterS) * time.Second
	return rdb.Set(ctx, throttleKey(jobID, host), time.Now().UnixMilli()+wait.Milliseconds(), wait).Err()
}

// requeue puts a taken URL back at the tail of its host's queue.
func requeue(ctx context.Context, jobID, host, url string) error {
	return rdb.RPush(ctx, queueKey(jobID), url).Err()
}
`,
      solution: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	burst       = 2
	bucketTTLMs = 3600000
)

// takeScript: KEYS are the host's bucket, queue and throttle; ARGV now (ms), rate per minute, burst, bucket TTL (ms).
var takeScript = redis.NewScript(\`
local now = tonumber(ARGV[1])
if now < tonumber(redis.call('GET', KEYS[3]) or '0') then return false end
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or burst
local ts = tonumber(state[2]) or now
tokens = math.min(burst, tokens + (now - ts) * rate / 60000)
local url = false
if tokens >= 1 then
  url = redis.call('LPOP', KEYS[2])
  if url then tokens = tokens - 1 end
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return url
\`)

func queueKey(jobID, host string) string    { return "frontier:" + jobID + ":" + host }
func bucketKey(jobID, host string) string   { return "bucket:" + jobID + ":" + host }
func throttleKey(jobID, host string) string { return "throttle:" + jobID + ":" + host }
func pendingKey(jobID string) string        { return "pending:" + jobID }

// enqueue queues url on its host; it is pending from now until an outcome is recorded.
func enqueue(ctx context.Context, jobID, host, url string) error {
	if err := rdb.RPush(ctx, queueKey(jobID, host), url).Err(); err != nil {
		return err
	}
	return rdb.ZAddNX(ctx, pendingKey(jobID), redis.Z{Score: float64(time.Now().UnixMilli()) / 1000, Member: url}).Err()
}

// take is the next URL of the host if the host is not throttled and its bucket holds a token, else "".
func take(ctx context.Context, jobID, host string, ratePerMinute int) (string, error) {
	keys := []string{bucketKey(jobID, host), queueKey(jobID, host), throttleKey(jobID, host)}
	url, err := takeScript.Run(ctx, rdb, keys, time.Now().UnixMilli(), ratePerMinute, burst, bucketTTLMs).Text()
	if err == redis.Nil {
		return "", nil
	}
	return url, err
}

// throttle: the host answered 429, take hands out nothing for it for retryAfterS seconds.
func throttle(ctx context.Context, jobID, host string, retryAfterS int) error {
	if retryAfterS < 1 {
		retryAfterS = 1
	}
	wait := time.Duration(retryAfterS) * time.Second
	return rdb.Set(ctx, throttleKey(jobID, host), time.Now().UnixMilli()+wait.Milliseconds(), wait).Err()
}

// requeue puts a taken URL back at the tail of its host's queue.
func requeue(ctx context.Context, jobID, host, url string) error {
	return rdb.RPush(ctx, queueKey(jobID, host), url).Err()
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <optional>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long kBurst = 2;

long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string queueKey(const std::string& job_id) { return "frontier:" + job_id; }
std::string bucketKey(const std::string& job_id, const std::string& host) { return "bucket:" + job_id + ":" + host; }
std::string throttleKey(const std::string& job_id, const std::string& host) { return "throttle:" + job_id + ":" + host; }
std::string pendingKey(const std::string& job_id) { return "pending:" + job_id; }

// Queue url on its host; it is pending from now until an outcome is recorded.
void enqueue(const std::string& job_id, const std::string& host, const std::string& url) {
  redis.rpush(queueKey(job_id), url);
  redis.zadd(pendingKey(job_id), url, static_cast<double>(nowMs()) / 1000, sw::redis::UpdateType::NOT_EXIST);
}

// The next URL of the host if the host is not throttled and its bucket holds a token, else none.
std::optional<std::string> take(const std::string& job_id, const std::string& host, long rate_per_minute) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const long long now = nowMs();
  const std::vector<sw::redis::OptionalString> state = redis.hmget(bucketKey(job_id, host), {"tokens", "ts"});
  double tokens = state[0] ? std::stod(*state[0]) : static_cast<double>(kBurst);
  const long long ts = state[1] ? std::stoll(*state[1]) : now;
  tokens += static_cast<double>(now - ts) * rate_per_minute / 60000;
  std::optional<std::string> url;
  if (tokens >= 1) {
    url = redis.lpop(queueKey(job_id));
    if (url) tokens -= 1;
  }
  redis.hset(bucketKey(job_id, host), {{"tokens", std::to_string(tokens)}, {"ts", std::to_string(now)}});
  return url;
}

// The host answered 429: take hands out nothing for it for retry_after_s seconds.
void throttle(const std::string& job_id, const std::string& host, long retry_after_s) {
  const std::chrono::milliseconds wait{std::max(retry_after_s, 1L) * 1000};
  redis.set(throttleKey(job_id, host), std::to_string(nowMs() + wait.count()), wait);
}

// Put a taken URL back at the tail of its host's queue.
void requeue(const std::string& job_id, const std::string& host, const std::string& url) { redis.rpush(queueKey(job_id), url); }
`,
      solution: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <optional>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long kBurst = 2;
constexpr long long kBucketTtlMs = 3600000;

// KEYS: the host's bucket, queue and throttle. ARGV: now (ms), rate per minute, burst, bucket TTL (ms).
const std::string kTakeLua = R"lua(
local now = tonumber(ARGV[1])
if now < tonumber(redis.call('GET', KEYS[3]) or '0') then return false end
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or burst
local ts = tonumber(state[2]) or now
tokens = math.min(burst, tokens + (now - ts) * rate / 60000)
local url = false
if tokens >= 1 then
  url = redis.call('LPOP', KEYS[2])
  if url then tokens = tokens - 1 end
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
return url
)lua";

long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

std::string queueKey(const std::string& job_id, const std::string& host) { return "frontier:" + job_id + ":" + host; }
std::string bucketKey(const std::string& job_id, const std::string& host) { return "bucket:" + job_id + ":" + host; }
std::string throttleKey(const std::string& job_id, const std::string& host) { return "throttle:" + job_id + ":" + host; }
std::string pendingKey(const std::string& job_id) { return "pending:" + job_id; }

// Queue url on its host; it is pending from now until an outcome is recorded.
void enqueue(const std::string& job_id, const std::string& host, const std::string& url) {
  redis.rpush(queueKey(job_id, host), url);
  redis.zadd(pendingKey(job_id), url, static_cast<double>(nowMs()) / 1000, sw::redis::UpdateType::NOT_EXIST);
}

// The next URL of the host if the host is not throttled and its bucket holds a token, else none.
std::optional<std::string> take(const std::string& job_id, const std::string& host, long rate_per_minute) {
  return redis.eval<sw::redis::OptionalString>(
      kTakeLua, {bucketKey(job_id, host), queueKey(job_id, host), throttleKey(job_id, host)},
      {std::to_string(nowMs()), std::to_string(rate_per_minute), std::to_string(kBurst), std::to_string(kBucketTtlMs)});
}

// The host answered 429: take hands out nothing for it for retry_after_s seconds.
void throttle(const std::string& job_id, const std::string& host, long retry_after_s) {
  const std::chrono::milliseconds wait{std::max(retry_after_s, 1L) * 1000};
  redis.set(throttleKey(job_id, host), std::to_string(nowMs() + wait.count()), wait);
}

// Put a taken URL back at the tail of its host's queue.
void requeue(const std::string& job_id, const std::string& host, const std::string& url) { redis.rpush(queueKey(job_id, host), url); }
`,
    },
  },
  harness: {
    python: `JOB = "nightly"
BLOG = "blog.example.com"
DOCS = "docs.example.com"


def _url(host, n):
    return f"https://{host}/p/{n}"


def _queued(ctx, host):
    return ctx.redis.lrange(f"frontier:{JOB}:{host}", 0, -1)


def check_per_host_queue(ctx):
    m = ctx.load("state")
    m.enqueue(JOB, BLOG, _url(BLOG, 1))
    m.enqueue(JOB, DOCS, _url(DOCS, 1))
    m.enqueue(JOB, BLOG, _url(BLOG, 2))
    got = m.take(JOB, DOCS, 60)
    assert got == _url(DOCS, 1), f"take({JOB}, {DOCS}) answered {got!r}: a take for one host must pop that host's URL, from frontier:{JOB}:{DOCS}"
    assert _queued(ctx, BLOG) == [_url(BLOG, 1), _url(BLOG, 2)], f"frontier:{JOB}:{BLOG} holds {_queued(ctx, BLOG)}, expected the blog's two URLs in order"
    assert m.take(JOB, BLOG, 60) == _url(BLOG, 1), "a take for the blog must pop the blog's first URL"
    assert ctx.redis.zcard(f"pending:{JOB}") == 3, f"pending:{JOB} holds {ctx.redis.zcard(f'pending:{JOB}')} URLs, expected the 3 enqueued"


def check_atomic_take(ctx):
    m = ctx.load("state")
    for n in range(3):
        m.enqueue(JOB, BLOG, _url(BLOG, n))
    assert m.take(JOB, BLOG, 1) == _url(BLOG, 0), "the first take of a new bucket must hand out the first URL"
    # One token is left. A second worker's take lands while this one is between its Redis commands.
    rival = ctx.redis_after(f"bucket:{JOB}:{BLOG}", lambda: m.take(JOB, BLOG, 1))
    mine = m.take(JOB, BLOG, 1)
    assert rival.fired, f"take never touched bucket:{JOB}:{BLOG}"
    if rival.error is not None:
        raise rival.error
    taken = [u for u in (mine, rival.result) if u is not None]
    assert len(taken) == 1, f"one token was left and two workers took {taken}: the bucket was read, then written, with the other worker in between. Read, refill, spend and pop in one Lua script"
    assert _queued(ctx, BLOG) == [_url(BLOG, 2)], f"frontier:{JOB}:{BLOG} holds {_queued(ctx, BLOG)}, expected the one URL nobody had a token for"


def check_refill_cap(ctx):
    m = ctx.load("state")
    assert m.take(JOB, BLOG, 60) is None, "a take on an empty queue must answer None"
    for n in range(8):
        m.enqueue(JOB, BLOG, _url(BLOG, n))
    first = [m.take(JOB, BLOG, 60) for _ in range(3)]
    assert None not in first[:2] and first[2] is None, f"a new bucket holds BURST = 2 tokens and a take on an empty queue spends none: three takes answered {first}"
    ctx.clock.advance(0.5)
    assert m.take(JOB, BLOG, 60) is None, "half a second at 60 per minute refills half a token: the take must answer None"
    ctx.clock.advance(0.5)
    assert m.take(JOB, BLOG, 60) is not None, "a second at 60 per minute refills one token: the take must answer a URL"
    ctx.clock.advance(3600)
    burst = [m.take(JOB, BLOG, 60) for _ in range(5)]
    got = sum(url is not None for url in burst)
    assert got == 2, f"after an hour idle the host got {got} URLs back to back: tokens are capped at BURST = 2, or an idle host gets hammered"


def check_throttle(ctx):
    m = ctx.load("state")
    m.enqueue(JOB, BLOG, _url(BLOG, 1))
    m.enqueue(JOB, BLOG, _url(BLOG, 2))
    m.enqueue(JOB, DOCS, _url(DOCS, 1))
    m.throttle(JOB, BLOG, 30)
    got = m.take(JOB, BLOG, 60)
    assert got is None, f"right after a 429 with Retry-After 30 the throttled host got {got!r}: take must hand out nothing until the not-before time"
    assert m.take(JOB, DOCS, 60) == _url(DOCS, 1), "a throttle on one host must not stop the others"
    ctx.clock.advance(29)
    assert m.take(JOB, BLOG, 60) is None, "29 s into a 30 s Retry-After the host must still get nothing"
    ctx.clock.advance(2)
    assert m.take(JOB, BLOG, 60) == _url(BLOG, 1), "once Retry-After has passed the host's next URL must be handed out"


def check_bucket_ttl(ctx):
    m = ctx.load("state")
    m.enqueue(JOB, BLOG, _url(BLOG, 1))
    m.enqueue(JOB, BLOG, _url(BLOG, 2))
    key = f"bucket:{JOB}:{BLOG}"
    probe = ctx.redis_after(key, lambda: ctx.redis.pttl(key))
    m.take(JOB, BLOG, 60)
    assert probe.fired, f"take never touched {key}"
    assert probe.result is not None and probe.result > 0, f"right after the command that wrote {key} its PTTL was {probe.result}: the expiry is set in the same script as the write, or a crash in between leaves a bucket that never expires"
    ttl = ctx.redis.pttl(key)
    assert 3_590_000 <= ttl <= 3_600_000, f"{key} has PTTL {ttl}: a bucket must expire BUCKET_TTL_MS (one hour) after its last take, or every host ever crawled stays in Redis"
    ctx.clock.advance(3000)
    assert m.take(JOB, BLOG, 60) == _url(BLOG, 2), "the host's second URL must be handed out 3000 s later"
    ttl = ctx.redis.pttl(key)
    assert 3_590_000 <= ttl <= 3_600_000, f"{key} has PTTL {ttl} right after a take: every take sets the expiry to BUCKET_TTL_MS again, not only the take that created the bucket"
    ctx.clock.advance(3590)
    assert ctx.redis.exists(key), f"{key} expired before an hour had passed since the host's last take"
    ctx.clock.advance(11)
    assert not ctx.redis.exists(key), f"an hour after the host's last take {key} is still in Redis"
`,
    typescript: `const JOB = 'nightly';
const BLOG = 'blog.example.com';
const DOCS = 'docs.example.com';

const url = (host: string, n: number): string => \`https://\${host}/p/\${n}\`;
const queued = (ctx, host: string): string[] => ctx.redis.lrange(\`frontier:\${JOB}:\${host}\`, 0, -1);

export async function check_per_host_queue(ctx) {
  const m = ctx.load('state');
  await m.enqueue(JOB, BLOG, url(BLOG, 1));
  await m.enqueue(JOB, DOCS, url(DOCS, 1));
  await m.enqueue(JOB, BLOG, url(BLOG, 2));
  const got = await m.take(JOB, DOCS, 60);
  assert.equal(got, url(DOCS, 1), \`take(\${JOB}, \${DOCS}) answered \${JSON.stringify(got)}: a take for one host must pop that host's URL, from frontier:\${JOB}:\${DOCS}\`);
  assert.deepStrictEqual(queued(ctx, BLOG), [url(BLOG, 1), url(BLOG, 2)], \`frontier:\${JOB}:\${BLOG} holds \${JSON.stringify(queued(ctx, BLOG))}, expected the blog's two URLs in order\`);
  assert.equal(await m.take(JOB, BLOG, 60), url(BLOG, 1), "a take for the blog must pop the blog's first URL");
  assert.equal(ctx.redis.zcard(\`pending:\${JOB}\`), 3, \`pending:\${JOB} must hold the 3 enqueued URLs\`);
}

export async function check_atomic_take(ctx) {
  const m = ctx.load('state');
  for (let n = 0; n < 3; n++) await m.enqueue(JOB, BLOG, url(BLOG, n));
  assert.equal(await m.take(JOB, BLOG, 1), url(BLOG, 0), 'the first take of a new bucket must hand out the first URL');
  // One token is left. A second worker's take lands while this one is between its Redis commands.
  const rival = ctx.redisAfter(\`bucket:\${JOB}:\${BLOG}\`, () => m.take(JOB, BLOG, 1));
  const mine = await m.take(JOB, BLOG, 1);
  assert(rival.fired, \`take never touched bucket:\${JOB}:\${BLOG}\`);
  if (rival.error !== undefined) throw rival.error;
  const theirs = await rival.result;
  const taken = [mine, theirs].filter(u => u !== null);
  assert.equal(taken.length, 1, \`one token was left and two workers took \${JSON.stringify(taken)}: the bucket was read, then written, with the other worker in between. Read, refill, spend and pop in one Lua script\`);
  assert.deepStrictEqual(queued(ctx, BLOG), [url(BLOG, 2)], \`frontier:\${JOB}:\${BLOG} holds \${JSON.stringify(queued(ctx, BLOG))}, expected the one URL nobody had a token for\`);
}

export async function check_refill_cap(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.take(JOB, BLOG, 60), null, 'a take on an empty queue must answer null');
  for (let n = 0; n < 8; n++) await m.enqueue(JOB, BLOG, url(BLOG, n));
  const first = [await m.take(JOB, BLOG, 60), await m.take(JOB, BLOG, 60), await m.take(JOB, BLOG, 60)];
  assert(first[0] !== null && first[1] !== null && first[2] === null, \`a new bucket holds BURST = 2 tokens and a take on an empty queue spends none: three takes answered \${JSON.stringify(first)}\`);
  ctx.clock.advance(0.5);
  assert.equal(await m.take(JOB, BLOG, 60), null, 'half a second at 60 per minute refills half a token: the take must answer null');
  ctx.clock.advance(0.5);
  assert.notEqual(await m.take(JOB, BLOG, 60), null, 'a second at 60 per minute refills one token: the take must answer a URL');
  ctx.clock.advance(3600);
  let got = 0;
  for (let i = 0; i < 5; i++) if ((await m.take(JOB, BLOG, 60)) !== null) got++;
  assert.equal(got, 2, \`after an hour idle the host got \${got} URLs back to back: tokens are capped at BURST = 2, or an idle host gets hammered\`);
}

export async function check_throttle(ctx) {
  const m = ctx.load('state');
  await m.enqueue(JOB, BLOG, url(BLOG, 1));
  await m.enqueue(JOB, BLOG, url(BLOG, 2));
  await m.enqueue(JOB, DOCS, url(DOCS, 1));
  await m.throttle(JOB, BLOG, 30);
  const got = await m.take(JOB, BLOG, 60);
  assert.equal(got, null, \`right after a 429 with Retry-After 30 the throttled host got \${JSON.stringify(got)}: take must hand out nothing until the not-before time\`);
  assert.equal(await m.take(JOB, DOCS, 60), url(DOCS, 1), 'a throttle on one host must not stop the others');
  ctx.clock.advance(29);
  assert.equal(await m.take(JOB, BLOG, 60), null, '29 s into a 30 s Retry-After the host must still get nothing');
  ctx.clock.advance(2);
  assert.equal(await m.take(JOB, BLOG, 60), url(BLOG, 1), "once Retry-After has passed the host's next URL must be handed out");
}

export async function check_bucket_ttl(ctx) {
  const m = ctx.load('state');
  await m.enqueue(JOB, BLOG, url(BLOG, 1));
  await m.enqueue(JOB, BLOG, url(BLOG, 2));
  const key = \`bucket:\${JOB}:\${BLOG}\`;
  const probe = ctx.redisAfter(key, () => ctx.redis.pttl(key));
  await m.take(JOB, BLOG, 60);
  assert(probe.fired, \`take never touched \${key}\`);
  const early = await probe.result;
  assert(typeof early === 'number' && early > 0, \`right after the command that wrote \${key} its PTTL was \${early}: the expiry is set in the same script as the write, or a crash in between leaves a bucket that never expires\`);
  let ttl = ctx.redis.pttl(key);
  assert(ttl >= 3_590_000 && ttl <= 3_600_000, \`\${key} has PTTL \${ttl}: a bucket must expire BUCKET_TTL_MS (one hour) after its last take, or every host ever crawled stays in Redis\`);
  ctx.clock.advance(3000);
  assert.equal(await m.take(JOB, BLOG, 60), url(BLOG, 2), "the host's second URL must be handed out 3000 s later");
  ttl = ctx.redis.pttl(key);
  assert(ttl >= 3_590_000 && ttl <= 3_600_000, \`\${key} has PTTL \${ttl} right after a take: every take sets the expiry to BUCKET_TTL_MS again, not only the take that created the bucket\`);
  ctx.clock.advance(3590);
  assert.equal(ctx.redis.exists(key), 1, \`\${key} expired before an hour had passed since the host's last take\`);
  ctx.clock.advance(11);
  assert.equal(ctx.redis.exists(key), 0, \`an hour after the host's last take \${key} is still in Redis\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"

	"leetbuild/harness"
)

const (
	kHStateJob = "nightly"
	kHBlogHost = "blog.example.com"
	kHDocsHost = "docs.example.com"
)

var hStateBg = context.Background()

func hPageURL(host string, n int) string { return fmt.Sprintf("https://%s/p/%d", host, n) }

func hMustEnqueue(ctx *harness.Ctx, host string, n int) {
	ctx.NoError(enqueue(hStateBg, kHStateJob, host, hPageURL(host, n)), "enqueue(%s) failed", hPageURL(host, n))
}

func hMustTake(ctx *harness.Ctx, host string, rate int) string {
	url, err := take(hStateBg, kHStateJob, host, rate)
	ctx.NoError(err, "take(%s, %s) failed", kHStateJob, host)
	return url
}

func hHostQueue(ctx *harness.Ctx, host string) []string {
	return ctx.Redis.LRange("frontier:"+kHStateJob+":"+host, 0, -1)
}

func CheckPerHostQueue(ctx *harness.Ctx) {
	hMustEnqueue(ctx, kHBlogHost, 1)
	hMustEnqueue(ctx, kHDocsHost, 1)
	hMustEnqueue(ctx, kHBlogHost, 2)
	got := hMustTake(ctx, kHDocsHost, 60)
	ctx.Equal(got, hPageURL(kHDocsHost, 1), "a take for %s must pop that host's URL, from frontier:%s:%s; take answered", kHDocsHost, kHStateJob, kHDocsHost)
	ctx.Equal(hHostQueue(ctx, kHBlogHost), []string{hPageURL(kHBlogHost, 1), hPageURL(kHBlogHost, 2)}, "frontier:%s:%s must hold the blog's two URLs in order", kHStateJob, kHBlogHost)
	ctx.Equal(hMustTake(ctx, kHBlogHost, 60), hPageURL(kHBlogHost, 1), "a take for the blog must pop the blog's first URL")
	ctx.Equal(ctx.Redis.ZCard("pending:"+kHStateJob), 3, "pending:%s must hold the 3 enqueued URLs", kHStateJob)
}

func CheckAtomicTake(ctx *harness.Ctx) {
	for n := 0; n < 3; n++ {
		hMustEnqueue(ctx, kHBlogHost, n)
	}
	ctx.Equal(hMustTake(ctx, kHBlogHost, 1), hPageURL(kHBlogHost, 0), "the first take of a new bucket must hand out the first URL")
	// One token is left. A second worker's take lands while this one is between its Redis commands.
	rival := ctx.Redis.After("bucket:"+kHStateJob+":"+kHBlogHost, func() any {
		url, _ := take(hStateBg, kHStateJob, kHBlogHost, 1)
		return url
	})
	mine := hMustTake(ctx, kHBlogHost, 1)
	ctx.Assert(rival.Fired, "take never touched bucket:%s:%s", kHStateJob, kHBlogHost)
	theirs, _ := rival.Result.(string)
	var taken []string
	for _, u := range []string{mine, theirs} {
		if u != "" {
			taken = append(taken, u)
		}
	}
	ctx.Assert(len(taken) == 1, "one token was left and two workers took %q: the bucket was read, then written, with the other worker in between. Read, refill, spend and pop in one Lua script", taken)
	ctx.Equal(hHostQueue(ctx, kHBlogHost), []string{hPageURL(kHBlogHost, 2)}, "frontier:%s:%s must keep the one URL nobody had a token for", kHStateJob, kHBlogHost)
}

func CheckRefillCap(ctx *harness.Ctx) {
	ctx.Equal(hMustTake(ctx, kHBlogHost, 60), "", "a take on an empty queue must answer nothing")
	for n := 0; n < 8; n++ {
		hMustEnqueue(ctx, kHBlogHost, n)
	}
	first := []string{hMustTake(ctx, kHBlogHost, 60), hMustTake(ctx, kHBlogHost, 60), hMustTake(ctx, kHBlogHost, 60)}
	ctx.Assert(first[0] != "" && first[1] != "" && first[2] == "", "a new bucket holds BURST = 2 tokens and a take on an empty queue spends none: three takes answered %q", first)
	ctx.Clock.Advance(0.5)
	ctx.Equal(hMustTake(ctx, kHBlogHost, 60), "", "half a second at 60 per minute refills half a token: the take must answer nothing")
	ctx.Clock.Advance(0.5)
	ctx.Assert(hMustTake(ctx, kHBlogHost, 60) != "", "a second at 60 per minute refills one token: the take must answer a URL")
	ctx.Clock.Advance(3600)
	got := 0
	for i := 0; i < 5; i++ {
		if hMustTake(ctx, kHBlogHost, 60) != "" {
			got++
		}
	}
	ctx.Equal(got, 2, "after an hour idle the host got URLs back to back: tokens are capped at BURST = 2, or an idle host gets hammered; the URLs")
}

func CheckThrottle(ctx *harness.Ctx) {
	hMustEnqueue(ctx, kHBlogHost, 1)
	hMustEnqueue(ctx, kHBlogHost, 2)
	hMustEnqueue(ctx, kHDocsHost, 1)
	ctx.NoError(throttle(hStateBg, kHStateJob, kHBlogHost, 30), "throttle failed")
	ctx.Equal(hMustTake(ctx, kHBlogHost, 60), "", "right after a 429 with Retry-After 30 take must hand the throttled host nothing until the not-before time; take answered")
	ctx.Equal(hMustTake(ctx, kHDocsHost, 60), hPageURL(kHDocsHost, 1), "a throttle on one host must not stop the others")
	ctx.Clock.Advance(29)
	ctx.Equal(hMustTake(ctx, kHBlogHost, 60), "", "29 s into a 30 s Retry-After the host must still get nothing")
	ctx.Clock.Advance(2)
	ctx.Equal(hMustTake(ctx, kHBlogHost, 60), hPageURL(kHBlogHost, 1), "once Retry-After has passed the host's next URL must be handed out")
}

func CheckBucketTtl(ctx *harness.Ctx) {
	hMustEnqueue(ctx, kHBlogHost, 1)
	hMustEnqueue(ctx, kHBlogHost, 2)
	key := "bucket:" + kHStateJob + ":" + kHBlogHost
	probe := ctx.Redis.After(key, func() any { return ctx.Redis.PTTL(key) })
	hMustTake(ctx, kHBlogHost, 60)
	ctx.Assert(probe.Fired, "take never touched %s", key)
	early, _ := probe.Result.(int64)
	ctx.Assert(early > 0, "right after the command that wrote %s its PTTL was %d: the expiry is set in the same script as the write, or a crash in between leaves a bucket that never expires", key, early)
	ttl := ctx.Redis.PTTL(key)
	ctx.Assert(ttl >= 3590000 && ttl <= 3600000, "%s has PTTL %d: a bucket must expire BUCKET_TTL_MS (one hour) after its last take, or every host ever crawled stays in Redis", key, ttl)
	ctx.Clock.Advance(3000)
	ctx.Equal(hMustTake(ctx, kHBlogHost, 60), hPageURL(kHBlogHost, 2), "the host's second URL must be handed out 3000 s later")
	ttl = ctx.Redis.PTTL(key)
	ctx.Assert(ttl >= 3590000 && ttl <= 3600000, "%s has PTTL %d right after a take: every take sets the expiry to BUCKET_TTL_MS again, not only the take that created the bucket", key, ttl)
	ctx.Clock.Advance(3590)
	ctx.Equal(ctx.Redis.Exists(key), 1, "%s expired before an hour had passed since the host's last take", key)
	ctx.Clock.Advance(11)
	ctx.Equal(ctx.Redis.Exists(key), 0, "an hour after the host's last take %s is still in Redis", key)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace {

const std::string kHJob = "nightly";
const std::string kHBlog = "blog.example.com";
const std::string kHDocs = "docs.example.com";

std::string hPageUrl(const std::string& host, int n) { return "https://" + host + "/p/" + std::to_string(n); }

std::vector<std::string> hHostQueue(harness::Ctx& ctx, const std::string& host) {
  return ctx.Redis.LRange("frontier:" + kHJob + ":" + host, 0, -1);
}

std::string hTaken(const std::optional<std::string>& url) { return url.value_or(""); }

}  // namespace

void CheckPerHostQueue(harness::Ctx& ctx) {
  enqueue(kHJob, kHBlog, hPageUrl(kHBlog, 1));
  enqueue(kHJob, kHDocs, hPageUrl(kHDocs, 1));
  enqueue(kHJob, kHBlog, hPageUrl(kHBlog, 2));
  ctx.Equal(hTaken(take(kHJob, kHDocs, 60)), hPageUrl(kHDocs, 1), "a take for %s must pop that host's URL, from frontier:%s:%s; take answered", kHDocs, kHJob, kHDocs);
  ctx.Equal(hHostQueue(ctx, kHBlog), {hPageUrl(kHBlog, 1), hPageUrl(kHBlog, 2)}, "frontier:%s:%s must hold the blog's two URLs in order", kHJob, kHBlog);
  ctx.Equal(hTaken(take(kHJob, kHBlog, 60)), hPageUrl(kHBlog, 1), "a take for the blog must pop the blog's first URL");
  ctx.Equal(ctx.Redis.ZCard("pending:" + kHJob), 3, "pending:%s must hold the 3 enqueued URLs", kHJob);
}

void CheckAtomicTake(harness::Ctx& ctx) {
  for (int n = 0; n < 3; n++) enqueue(kHJob, kHBlog, hPageUrl(kHBlog, n));
  ctx.Equal(hTaken(take(kHJob, kHBlog, 1)), hPageUrl(kHBlog, 0), "the first take of a new bucket must hand out the first URL");
  // One token is left. A second worker's take lands while this one is between its Redis commands.
  auto fired = std::make_shared<bool>(false);
  auto theirs = std::make_shared<std::string>();
  ctx.Redis.After("bucket:" + kHJob + ":" + kHBlog, [fired, theirs] {
    *fired = true;
    *theirs = take(kHJob, kHBlog, 1).value_or("");
  });
  const std::string mine = hTaken(take(kHJob, kHBlog, 1));
  ctx.Assert(*fired, "take never touched bucket:%s:%s", kHJob, kHBlog);
  std::vector<std::string> both;
  for (const std::string& u : {mine, *theirs}) {
    if (!u.empty()) both.push_back(u);
  }
  ctx.Assert(both.size() == 1, "one token was left and two workers took %q: the bucket was read, then written, with the other worker in between. Read, refill, spend and pop in one Lua script", both);
  ctx.Equal(hHostQueue(ctx, kHBlog), {hPageUrl(kHBlog, 2)}, "frontier:%s:%s must keep the one URL nobody had a token for", kHJob, kHBlog);
}

void CheckRefillCap(harness::Ctx& ctx) {
  ctx.Equal(hTaken(take(kHJob, kHBlog, 60)), "", "a take on an empty queue must answer nothing");
  for (int n = 0; n < 8; n++) enqueue(kHJob, kHBlog, hPageUrl(kHBlog, n));
  const std::vector<std::string> first = {hTaken(take(kHJob, kHBlog, 60)), hTaken(take(kHJob, kHBlog, 60)), hTaken(take(kHJob, kHBlog, 60))};
  ctx.Assert(!first[0].empty() && !first[1].empty() && first[2].empty(), "a new bucket holds kBurst = 2 tokens and a take on an empty queue spends none: three takes answered %q", first);
  ctx.Clock.Advance(0.5);
  ctx.Equal(hTaken(take(kHJob, kHBlog, 60)), "", "half a second at 60 per minute refills half a token: the take must answer nothing");
  ctx.Clock.Advance(0.5);
  ctx.Assert(!hTaken(take(kHJob, kHBlog, 60)).empty(), "a second at 60 per minute refills one token: the take must answer a URL");
  ctx.Clock.Advance(3600);
  int got = 0;
  for (int i = 0; i < 5; i++) {
    if (take(kHJob, kHBlog, 60)) got++;
  }
  ctx.Equal(got, 2, "after an hour idle the host got URLs back to back: tokens are capped at kBurst = 2, or an idle host gets hammered; the URLs");
}

void CheckThrottle(harness::Ctx& ctx) {
  enqueue(kHJob, kHBlog, hPageUrl(kHBlog, 1));
  enqueue(kHJob, kHBlog, hPageUrl(kHBlog, 2));
  enqueue(kHJob, kHDocs, hPageUrl(kHDocs, 1));
  throttle(kHJob, kHBlog, 30);
  ctx.Equal(hTaken(take(kHJob, kHBlog, 60)), "", "right after a 429 with Retry-After 30 take must hand the throttled host nothing until the not-before time; take answered");
  ctx.Equal(hTaken(take(kHJob, kHDocs, 60)), hPageUrl(kHDocs, 1), "a throttle on one host must not stop the others");
  ctx.Clock.Advance(29);
  ctx.Equal(hTaken(take(kHJob, kHBlog, 60)), "", "29 s into a 30 s Retry-After the host must still get nothing");
  ctx.Clock.Advance(2);
  ctx.Equal(hTaken(take(kHJob, kHBlog, 60)), hPageUrl(kHBlog, 1), "once Retry-After has passed the host's next URL must be handed out");
}

void CheckBucketTtl(harness::Ctx& ctx) {
  enqueue(kHJob, kHBlog, hPageUrl(kHBlog, 1));
  enqueue(kHJob, kHBlog, hPageUrl(kHBlog, 2));
  const std::string key = "bucket:" + kHJob + ":" + kHBlog;
  auto fired = std::make_shared<bool>(false);
  auto early = std::make_shared<long long>(0);
  ctx.Redis.After(key, [&ctx, key, fired, early] {
    *fired = true;
    *early = ctx.Redis.PTTL(key);
  });
  take(kHJob, kHBlog, 60);
  ctx.Assert(*fired, "take never touched %s", key);
  ctx.Assert(*early > 0, "right after the command that wrote %s its PTTL was %d: the expiry is set in the same script as the write, or a crash in between leaves a bucket that never expires", key, *early);
  long long ttl = ctx.Redis.PTTL(key);
  ctx.Assert(ttl >= 3590000 && ttl <= 3600000, "%s has PTTL %d: a bucket must expire kBucketTtlMs (one hour) after its last take, or every host ever crawled stays in Redis", key, ttl);
  ctx.Clock.Advance(3000);
  ctx.Equal(hTaken(take(kHJob, kHBlog, 60)), hPageUrl(kHBlog, 2), "the host's second URL must be handed out 3000 s later");
  ttl = ctx.Redis.PTTL(key);
  ctx.Assert(ttl >= 3590000 && ttl <= 3600000, "%s has PTTL %d right after a take: every take sets the expiry to kBucketTtlMs again, not only the take that created the bucket", key, ttl);
  ctx.Clock.Advance(3590);
  ctx.Equal(ctx.Redis.Exists(key), 1, "%s expired before an hour had passed since the host's last take", key);
  ctx.Clock.Advance(11);
  ctx.Equal(ctx.Redis.Exists(key), 0, "an hour after the host's last take %s is still in Redis", key);
}
`,
  },
  hints: [
    'Queue a URL for blog.example.com and one for docs.example.com, then take for docs: you get the blog URL. Leave a host idle for an hour and it gets every queued URL at once, even right after a 429.',
    'There is one list per job, so the host never reaches the `LPOP`. The bucket is read with `HMGET`, computed in the client and written back, so a second worker can read the same tokens in between; nothing caps them or reads the throttle key.',
    'Key the queue `frontier:{job_id}:{host}`. Move take into one Lua script: return false while `GET throttle` is later than now, refill with `math.min(burst, …)`, `LPOP` and spend a token, `HSET` tokens and ts, `PEXPIRE` by `BUCKET_TTL_MS`.',
  ],
  debrief: `A token bucket is two numbers and a clock, so the hard part is that two workers must not read the same two numbers: in one Lua script the read, the refill, the spend and the pop are one step, and a token is never spent on an empty queue. The cap is what makes the bucket a rate limit rather than a savings account, and it is also why the TTL is safe: an hour after the last take the bucket would be full again, so deleting it loses nothing. The throttle sits in the same script, so a 429 stops every worker at once. Production frontiers also shard hosts across Redis nodes, adapt each host's rate from its latency, and lease URLs so a crashed worker's URL comes back.`,
};
