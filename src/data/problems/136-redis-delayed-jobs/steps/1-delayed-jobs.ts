import type {Step} from '@/lib/types';

// The Lua script is the same text in every language; these read it wherever it is embedded.
const LUA_ZRANGEBYSCORE =
  /redis\.call\(\s*['"]ZRANGEBYSCORE['"]\s*,\s*KEYS\[1\]\s*,\s*['"]-inf['"]\s*,\s*ARGV\[1\]\s*,\s*['"]LIMIT['"]\s*,\s*0\s*,\s*ARGV\[2\]\s*\)/i;
const LUA_ZREM = /redis\.call\(\s*['"]ZREM['"]\s*,\s*KEYS\[1\]\s*,/i;
const LUA_HGET_PAYLOAD = /redis\.call\(\s*['"]HGET['"]\s*,\s*KEYS\[2\]\s*,/i;
const LUA_HGET_ATTEMPTS = /redis\.call\(\s*['"]HGET['"]\s*,\s*KEYS\[3\]\s*,/i;

export const delayedJobsStep: Step = {
  id: 'delayed-jobs',
  title: 'Schedule, pop what is due, back off on failure',
  concept: 'redis',
  file: 'delayed_jobs',
  focus: ['worker', 'redis'],
  task: `## Task

A delayed-job queue in Redis: a sorted set of job ids scored by the millisecond they become due, a
hash of payloads, a hash of failure counts, and a list for the jobs that gave up. Times are passed
in (\`run_at_ms\`, \`now_ms\`), never read from a clock.

- \`schedule(job_id, payload, run_at_ms)\`: \`HSET jobs:payload {job_id} {payload}\` and
  \`ZADD jobs:delayed {run_at_ms} {job_id}\`.
- \`pop_due(now_ms, limit)\` → a list of \`(job_id, payload, attempt)\` — **one Lua script**, called with
  \`KEYS = [jobs:delayed, jobs:payload, jobs:attempts]\` and \`ARGV = [now_ms, limit]\`:
  \`ZRANGEBYSCORE KEYS[1] -inf now LIMIT 0 limit\`, then for each id \`ZREM\` it from \`KEYS[1]\` and read its
  payload (\`HGET KEYS[2]\`) and its failures so far (\`HGET KEYS[3]\`, \`0\` when absent). Jobs come back in
  \`run_at\` order; a job due later than \`now_ms\` stays; a job the script returned is **gone from
  \`jobs:delayed\`** — two workers calling \`pop_due\` at the same instant never share a job.
- \`backoff_ms(attempt)\` → \`min(BASE_MS × 2^(attempt − 1), MAX_BACKOFF_MS)\` with \`BASE_MS = 1000\` and
  \`MAX_BACKOFF_MS = 60000\`: 1 s, 2 s, 4 s, 8 s, 16 s, 32 s, 60 s, 60 s…
- \`fail(job_id, now_ms)\`: \`attempt = HINCRBY jobs:attempts {job_id} 1\`. If \`attempt >= MAX_ATTEMPTS\`
  (\`5\`): \`RPUSH jobs:dead {job_id}\`, \`HDEL jobs:attempts {job_id}\`, leave the payload for inspection and
  return \`None\`. Otherwise \`ZADD jobs:delayed {now_ms + backoff_ms(attempt)} {job_id}\` and return that
  new \`run_at_ms\`.
- \`complete(job_id)\`: \`HDEL jobs:payload {job_id}\` and \`HDEL jobs:attempts {job_id}\` — nothing of the job
  remains.

:::widget deadline-retry {base: 1000, deadline: 60000, attempts: 5}

> \`ZRANGEBYSCORE\` followed by a client-side \`ZREM\` is the bug every first delayed queue ships: two
> workers read the same due ids and both run the job. The script makes read-and-remove one
> indivisible claim.`,
  sequence: {
    participants: ['scheduler', 'worker', 'Redis'],
    messages: [
      {from: 'scheduler', to: 'Redis', label: 'HSET jobs:payload j1 … · ZADD jobs:delayed 5000 j1', kind: 'sync'},
      {from: 'worker', to: 'Redis', label: 'EVAL pop · now 4000 · limit 10', kind: 'sync'},
      {from: 'Redis', to: 'worker', label: '[] (j1 is due at 5000)', kind: 'reply'},
      {from: 'worker', to: 'Redis', label: 'EVAL pop · now 5000 · limit 10', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'ZRANGEBYSCORE → j1 · ZREM j1 · HGET payload · HGET attempts', kind: 'sync'},
      {from: 'Redis', to: 'worker', label: '[(j1, …, 0)]', kind: 'reply'},
      {from: 'worker', to: 'Redis', label: 'fail(j1, 5000): HINCRBY attempts → 1 · ZADD 6000 j1', kind: 'sync'},
      {from: 'worker', to: 'Redis', label: 'fail(j1, 15000) ×4 … attempt 5: RPUSH jobs:dead j1', kind: 'sync'},
    ],
  },
  hints: [
    'Write the script first and return a flat list — `id, payload, attempts, id, payload, attempts…` — then split it in threes on the client; a nested Lua table with a `nil` in it loses elements.',
    '`HGET` of a missing field is `false` in Lua: `redis.call("HGET", KEYS[3], id) or "0"`. `ZREM` inside the loop, before the reads, is what makes the claim atomic: nothing can run between the script’s commands.',
    '`fail` is three ordinary commands: `HINCRBY` gives you the attempt number, then either the dead-letter `RPUSH` + `HDEL` or a `ZADD` at `now_ms + backoff_ms(attempt)`. Compare the attempt with `MAX_ATTEMPTS` before computing a delay.',
  ],
  checks: [
    {
      id: 'scheduled',
      title: 'Schedules under jobs:payload and jobs:delayed; nothing pops early',
      detail:
        '`schedule` writes the payload to the hash `jobs:payload` and the id to the sorted set `jobs:delayed` scored by `run_at_ms`; `pop_due` with a `now_ms` before that score returns nothing and removes nothing.',
      match: {
        python: {all: [/r\.hset\(\s*"jobs:payload"/, /r\.zadd\(\s*"jobs:delayed"/]},
        typescript: {all: [/redis\.hset\(\s*'jobs:payload'/, /redis\.zadd\(\s*'jobs:delayed'/]},
        go: {all: [/rdb\.HSet\(ctx, "jobs:payload"/, /rdb\.ZAdd\(ctx, "jobs:delayed"/]},
        scala: {all: [/jedis\.hset\("jobs:payload"/, /jedis\.zadd\("jobs:delayed"/]},
        cpp: {all: [/redis\.hset\("jobs:payload"/, /redis\.zadd\("jobs:delayed"/]},
      },
    },
    {
      id: 'due-in-order',
      title: 'Due jobs pop in run_at order, at most `limit`, the rest stay',
      detail:
        'The script selects with `ZRANGEBYSCORE KEYS[1] -inf ARGV[1] LIMIT 0 ARGV[2]`: the earliest due jobs first, never more than `limit`, and every job it did not return is still in `jobs:delayed`.',
      match: {
        python: {all: [LUA_ZRANGEBYSCORE]},
        typescript: {all: [LUA_ZRANGEBYSCORE]},
        go: {all: [LUA_ZRANGEBYSCORE]},
        scala: {all: [LUA_ZRANGEBYSCORE]},
        cpp: {all: [LUA_ZRANGEBYSCORE]},
      },
    },
    {
      id: 'atomic-claim',
      title: 'Read and remove are one script: two poppers never share a job',
      detail:
        '`ZREM` follows the `ZRANGEBYSCORE` inside the Lua script and the payload and attempt counts are read there too; a second `pop_due` landing right after the first one’s read gets none of its jobs. No client-side `zrangebyscore`/`zrem`.',
      match: {
        python: {
          order: [LUA_ZRANGEBYSCORE, LUA_ZREM, LUA_HGET_PAYLOAD, LUA_HGET_ATTEMPTS],
          all: [/r\.eval\(\s*POP_LUA\s*,\s*3\s*,\s*"jobs:delayed"\s*,\s*"jobs:payload"\s*,\s*"jobs:attempts"/],
          none: [/r\.zrangebyscore\(/, /r\.zrem\(/],
        },
        typescript: {
          order: [LUA_ZRANGEBYSCORE, LUA_ZREM, LUA_HGET_PAYLOAD, LUA_HGET_ATTEMPTS],
          all: [/redis\.eval\(\s*POP_LUA\s*,\s*3\s*,\s*'jobs:delayed'\s*,\s*'jobs:payload'\s*,\s*'jobs:attempts'/],
          none: [/redis\.zrangebyscore\(/, /redis\.zrem\(/],
        },
        go: {
          order: [LUA_ZRANGEBYSCORE, LUA_ZREM, LUA_HGET_PAYLOAD, LUA_HGET_ATTEMPTS],
          all: [/redis\.NewScript\(popLua\)/, /popScript\.Run\(ctx, rdb, keys, nowMs, limit\)/],
          none: [/rdb\.ZRangeByScore\(/, /rdb\.ZRem\(/],
        },
        scala: {
          order: [LUA_ZRANGEBYSCORE, LUA_ZREM, LUA_HGET_PAYLOAD, LUA_HGET_ATTEMPTS],
          all: [/jedis\.eval\(PopLua, keys, args\)/],
          none: [/jedis\.zrangeByScore\(/, /jedis\.zrem\(/],
        },
        cpp: {
          order: [LUA_ZRANGEBYSCORE, LUA_ZREM, LUA_HGET_PAYLOAD, LUA_HGET_ATTEMPTS],
          all: [/redis\.eval<std::vector<std::string>>\(kPopLua,/],
          none: [/redis\.zrangebyscore\(/, /redis\.zrem\(/],
        },
      },
    },
    {
      id: 'backoff',
      title: 'Fails back off 1 s, 2 s, 4 s, 8 s, then die on the fifth',
      detail:
        '`fail` counts with `HINCRBY jobs:attempts`, reschedules at `now_ms + backoff_ms(attempt)` while the attempt is below `MAX_ATTEMPTS`, and on the fifth failure `RPUSH`es the id to `jobs:dead`, drops its attempt count and returns nothing; `pop_due` reports the attempts so far.',
      match: {
        python: {all: [/r\.hincrby\(\s*"jobs:attempts"/, />=\s*MAX_ATTEMPTS/, /r\.rpush\(\s*"jobs:dead"/]},
        typescript: {all: [/redis\.hincrby\(\s*'jobs:attempts'/, />=\s*MAX_ATTEMPTS/, /redis\.rpush\(\s*'jobs:dead'/]},
        go: {all: [/rdb\.HIncrBy\(ctx, "jobs:attempts"/, />=\s*maxAttempts/, /rdb\.RPush\(ctx, "jobs:dead"/]},
        scala: {all: [/jedis\.hincrBy\("jobs:attempts"/, />=\s*MaxAttempts/, /jedis\.rpush\("jobs:dead"/]},
        cpp: {all: [/redis\.hincrby\("jobs:attempts"/, />=\s*kMaxAttempts/, /redis\.rpush\("jobs:dead"/]},
      },
    },
    {
      id: 'backoff-cap',
      title: 'The delay doubles and stops at 60 s',
      detail:
        '`backoff_ms(attempt)` is `BASE_MS × 2^(attempt − 1)` capped by `MAX_BACKOFF_MS`: 1000, 2000, 4000, 8000, 16000, 32000, then 60000 for every later attempt.',
      match: {
        python: {all: [/min\(/, /MAX_BACKOFF_MS/, /2\s*\*\*\s*\(attempt - 1\)/]},
        typescript: {all: [/Math\.min\(/, /MAX_BACKOFF_MS/, /2\s*\*\*\s*\(attempt - 1\)/]},
        go: {all: [/min\(/, /maxBackoffMs/]},
        scala: {all: [/math\.min\(/, /MaxBackoffMs/, /math\.pow\(2/]},
        cpp: {all: [/std::min\(/, /kMaxBackoffMs/, /std::pow\(2/]},
      },
    },
    {
      id: 'complete',
      title: 'A completed job leaves nothing behind',
      detail:
        '`complete` deletes the job’s field from `jobs:payload` and from `jobs:attempts`; it is in no set or list afterwards, and other jobs are untouched.',
      match: {
        python: {all: [/r\.hdel\(\s*"jobs:payload"/, /r\.hdel\(\s*"jobs:attempts"/]},
        typescript: {all: [/redis\.hdel\(\s*'jobs:payload'/, /redis\.hdel\(\s*'jobs:attempts'/]},
        go: {all: [/rdb\.HDel\(ctx, "jobs:payload"/, /rdb\.HDel\(ctx, "jobs:attempts"/]},
        scala: {all: [/jedis\.hdel\("jobs:payload"/, /jedis\.hdel\("jobs:attempts"/]},
        cpp: {all: [/redis\.hdel\("jobs:payload"/, /redis\.hdel\("jobs:attempts"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Delayed jobs in Redis: a due-time sorted set, an atomic pop, exponential backoff, a dead list."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_ATTEMPTS = 5
BASE_MS = 1000
MAX_BACKOFF_MS = 60_000

# KEYS[1] = jobs:delayed   KEYS[2] = jobs:payload   KEYS[3] = jobs:attempts
# ARGV[1] = now_ms   ARGV[2] = limit
# Returns a flat list: id, payload, attempts, id, payload, attempts…
POP_LUA = """
return {}
"""


def schedule(job_id: str, payload: str, run_at_ms: int) -> None:
    """HSET the payload, ZADD the id at run_at_ms."""
    # TODO
    raise NotImplementedError


def pop_due(now_ms: int, limit: int) -> list[tuple[str, str, int]]:
    """Up to limit jobs due at now_ms, earliest first, each removed from jobs:delayed by the script."""
    # TODO: POP_LUA — ZRANGEBYSCORE … LIMIT, ZREM each, HGET payload and attempts; split the reply in threes
    raise NotImplementedError


def backoff_ms(attempt: int) -> int:
    """1 s, 2 s, 4 s … capped at MAX_BACKOFF_MS."""
    # TODO
    raise NotImplementedError


def fail(job_id: str, now_ms: int) -> int | None:
    """Count the failure; reschedule with backoff and return the new run_at_ms, or move to jobs:dead and return None."""
    # TODO: HINCRBY jobs:attempts; >= MAX_ATTEMPTS → RPUSH jobs:dead + HDEL attempts; else ZADD now + backoff
    raise NotImplementedError


def complete(job_id: str) -> None:
    """Forget the job: payload and attempts."""
    # TODO
    raise NotImplementedError
`,
      solution: `"""Delayed jobs in Redis: a due-time sorted set, an atomic pop, exponential backoff, a dead list."""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MAX_ATTEMPTS = 5
BASE_MS = 1000
MAX_BACKOFF_MS = 60_000

# KEYS[1] = jobs:delayed   KEYS[2] = jobs:payload   KEYS[3] = jobs:attempts
# ARGV[1] = now_ms   ARGV[2] = limit
# Returns a flat list: id, payload, attempts, id, payload, attempts…
POP_LUA = """
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
local out = {}
for _, id in ipairs(due) do
  redis.call('ZREM', KEYS[1], id)
  out[#out + 1] = id
  out[#out + 1] = redis.call('HGET', KEYS[2], id) or ''
  out[#out + 1] = redis.call('HGET', KEYS[3], id) or '0'
end
return out
"""


def schedule(job_id: str, payload: str, run_at_ms: int) -> None:
    """HSET the payload, ZADD the id at run_at_ms."""
    r.hset("jobs:payload", job_id, payload)
    r.zadd("jobs:delayed", {job_id: run_at_ms})


def pop_due(now_ms: int, limit: int) -> list[tuple[str, str, int]]:
    """Up to limit jobs due at now_ms, earliest first, each removed from jobs:delayed by the script."""
    flat = r.eval(POP_LUA, 3, "jobs:delayed", "jobs:payload", "jobs:attempts", now_ms, limit)
    return [(flat[i], flat[i + 1], int(flat[i + 2])) for i in range(0, len(flat), 3)]


def backoff_ms(attempt: int) -> int:
    """1 s, 2 s, 4 s … capped at MAX_BACKOFF_MS."""
    return min(BASE_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS)


def fail(job_id: str, now_ms: int) -> int | None:
    """Count the failure; reschedule with backoff and return the new run_at_ms, or move to jobs:dead and return None."""
    attempt = r.hincrby("jobs:attempts", job_id, 1)
    if attempt >= MAX_ATTEMPTS:
        r.rpush("jobs:dead", job_id)
        r.hdel("jobs:attempts", job_id)
        return None
    run_at_ms = now_ms + backoff_ms(attempt)
    r.zadd("jobs:delayed", {job_id: run_at_ms})
    return run_at_ms


def complete(job_id: str) -> None:
    """Forget the job: payload and attempts."""
    r.hdel("jobs:payload", job_id)
    r.hdel("jobs:attempts", job_id)
`,
    },
    typescript: {
      starter: `/** Delayed jobs in Redis: a due-time sorted set, an atomic pop, exponential backoff, a dead list. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const MAX_ATTEMPTS = 5;
export const BASE_MS = 1000;
export const MAX_BACKOFF_MS = 60_000;

// KEYS[1] = jobs:delayed   KEYS[2] = jobs:payload   KEYS[3] = jobs:attempts
// ARGV[1] = now_ms   ARGV[2] = limit
// Returns a flat list: id, payload, attempts, id, payload, attempts…
const POP_LUA = \`
return {}
\`;

/** [jobId, payload, attempts so far] */
export type Due = [string, string, number];

/** HSET the payload, ZADD the id at runAtMs. */
export async function schedule(jobId: string, payload: string, runAtMs: number): Promise<void> {
  // TODO
  throw new Error('not implemented');
}

/** Up to limit jobs due at nowMs, earliest first, each removed from jobs:delayed by the script. */
export async function popDue(nowMs: number, limit: number): Promise<Due[]> {
  // TODO: POP_LUA — ZRANGEBYSCORE … LIMIT, ZREM each, HGET payload and attempts; split the reply in threes
  throw new Error('not implemented');
}

/** 1 s, 2 s, 4 s … capped at MAX_BACKOFF_MS. */
export function backoffMs(attempt: number): number {
  // TODO
  throw new Error('not implemented');
}

/** Count the failure; reschedule with backoff and return the new runAtMs, or move to jobs:dead and return null. */
export async function fail(jobId: string, nowMs: number): Promise<number | null> {
  // TODO: HINCRBY jobs:attempts; >= MAX_ATTEMPTS → RPUSH jobs:dead + HDEL attempts; else ZADD now + backoff
  throw new Error('not implemented');
}

/** Forget the job: payload and attempts. */
export async function complete(jobId: string): Promise<void> {
  // TODO
  throw new Error('not implemented');
}
`,
      solution: `/** Delayed jobs in Redis: a due-time sorted set, an atomic pop, exponential backoff, a dead list. */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const MAX_ATTEMPTS = 5;
export const BASE_MS = 1000;
export const MAX_BACKOFF_MS = 60_000;

// KEYS[1] = jobs:delayed   KEYS[2] = jobs:payload   KEYS[3] = jobs:attempts
// ARGV[1] = now_ms   ARGV[2] = limit
// Returns a flat list: id, payload, attempts, id, payload, attempts…
const POP_LUA = \`
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
local out = {}
for _, id in ipairs(due) do
  redis.call('ZREM', KEYS[1], id)
  out[#out + 1] = id
  out[#out + 1] = redis.call('HGET', KEYS[2], id) or ''
  out[#out + 1] = redis.call('HGET', KEYS[3], id) or '0'
end
return out
\`;

/** [jobId, payload, attempts so far] */
export type Due = [string, string, number];

/** HSET the payload, ZADD the id at runAtMs. */
export async function schedule(jobId: string, payload: string, runAtMs: number): Promise<void> {
  await redis.hset('jobs:payload', jobId, payload);
  await redis.zadd('jobs:delayed', runAtMs, jobId);
}

/** Up to limit jobs due at nowMs, earliest first, each removed from jobs:delayed by the script. */
export async function popDue(nowMs: number, limit: number): Promise<Due[]> {
  const flat = (await redis.eval(POP_LUA, 3, 'jobs:delayed', 'jobs:payload', 'jobs:attempts', nowMs, limit)) as string[];
  const due: Due[] = [];
  for (let i = 0; i + 2 < flat.length; i += 3) due.push([flat[i], flat[i + 1], Number(flat[i + 2])]);
  return due;
}

/** 1 s, 2 s, 4 s … capped at MAX_BACKOFF_MS. */
export function backoffMs(attempt: number): number {
  return Math.min(BASE_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
}

/** Count the failure; reschedule with backoff and return the new runAtMs, or move to jobs:dead and return null. */
export async function fail(jobId: string, nowMs: number): Promise<number | null> {
  const attempt = await redis.hincrby('jobs:attempts', jobId, 1);
  if (attempt >= MAX_ATTEMPTS) {
    await redis.rpush('jobs:dead', jobId);
    await redis.hdel('jobs:attempts', jobId);
    return null;
  }
  const runAtMs = nowMs + backoffMs(attempt);
  await redis.zadd('jobs:delayed', runAtMs, jobId);
  return runAtMs;
}

/** Forget the job: payload and attempts. */
export async function complete(jobId: string): Promise<void> {
  await redis.hdel('jobs:payload', jobId);
  await redis.hdel('jobs:attempts', jobId);
}
`,
    },
    go: {
      starter: `// Delayed jobs in Redis: a due-time sorted set, an atomic pop, exponential backoff, a dead list.
package main

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	maxAttempts  = 5
	baseMs       = int64(1000)
	maxBackoffMs = int64(60000)
)

// KEYS[1] = jobs:delayed   KEYS[2] = jobs:payload   KEYS[3] = jobs:attempts
// ARGV[1] = now_ms   ARGV[2] = limit
// Returns a flat list: id, payload, attempts, id, payload, attempts…
const popLua = \`
return {}
\`

var popScript *redis.Script // TODO: redis.NewScript(popLua)

// Job is one due job: its id, payload and failures so far.
type Job struct {
	ID      string
	Payload string
	Attempt int
}

// schedule HSETs the payload and ZADDs the id at runAtMs.
func schedule(ctx context.Context, jobID, payload string, runAtMs int64) error {
	// TODO
	return errors.New("not implemented")
}

// popDue returns up to limit jobs due at nowMs, earliest first, each removed from jobs:delayed by the script.
func popDue(ctx context.Context, nowMs int64, limit int) ([]Job, error) {
	// TODO: popLua — ZRANGEBYSCORE … LIMIT, ZREM each, HGET payload and attempts; split the reply in threes
	return nil, errors.New("not implemented")
}

// backoffMs is 1 s, 2 s, 4 s … capped at maxBackoffMs.
func backoffMs(attempt int) int64 {
	// TODO
	return 0
}

// fail counts the failure; it reschedules with backoff and returns the new runAtMs (rescheduled = true),
// or moves the job to jobs:dead (rescheduled = false).
func fail(ctx context.Context, jobID string, nowMs int64) (runAtMs int64, rescheduled bool, err error) {
	// TODO: HINCRBY jobs:attempts; >= maxAttempts → RPUSH jobs:dead + HDEL attempts; else ZADD now + backoff
	return 0, false, errors.New("not implemented")
}

// complete forgets the job: payload and attempts.
func complete(ctx context.Context, jobID string) error {
	// TODO
	return errors.New("not implemented")
}
`,
      solution: `// Delayed jobs in Redis: a due-time sorted set, an atomic pop, exponential backoff, a dead list.
package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	maxAttempts  = 5
	baseMs       = int64(1000)
	maxBackoffMs = int64(60000)
)

// KEYS[1] = jobs:delayed   KEYS[2] = jobs:payload   KEYS[3] = jobs:attempts
// ARGV[1] = now_ms   ARGV[2] = limit
// Returns a flat list: id, payload, attempts, id, payload, attempts…
const popLua = \`
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
local out = {}
for _, id in ipairs(due) do
  redis.call('ZREM', KEYS[1], id)
  out[#out + 1] = id
  out[#out + 1] = redis.call('HGET', KEYS[2], id) or ''
  out[#out + 1] = redis.call('HGET', KEYS[3], id) or '0'
end
return out
\`

var popScript = redis.NewScript(popLua)

// Job is one due job: its id, payload and failures so far.
type Job struct {
	ID      string
	Payload string
	Attempt int
}

// schedule HSETs the payload and ZADDs the id at runAtMs.
func schedule(ctx context.Context, jobID, payload string, runAtMs int64) error {
	if err := rdb.HSet(ctx, "jobs:payload", jobID, payload).Err(); err != nil {
		return err
	}
	return rdb.ZAdd(ctx, "jobs:delayed", redis.Z{Score: float64(runAtMs), Member: jobID}).Err()
}

// popDue returns up to limit jobs due at nowMs, earliest first, each removed from jobs:delayed by the script.
func popDue(ctx context.Context, nowMs int64, limit int) ([]Job, error) {
	keys := []string{"jobs:delayed", "jobs:payload", "jobs:attempts"}
	flat, err := popScript.Run(ctx, rdb, keys, nowMs, limit).StringSlice()
	if err != nil {
		return nil, err
	}
	jobs := make([]Job, 0, len(flat)/3)
	for i := 0; i+2 < len(flat); i += 3 {
		attempt, _ := strconv.Atoi(flat[i+2])
		jobs = append(jobs, Job{ID: flat[i], Payload: flat[i+1], Attempt: attempt})
	}
	return jobs, nil
}

// backoffMs is 1 s, 2 s, 4 s … capped at maxBackoffMs.
func backoffMs(attempt int) int64 {
	delay := baseMs
	for i := 1; i < attempt && delay < maxBackoffMs; i++ {
		delay *= 2
	}
	return min(delay, maxBackoffMs)
}

// fail counts the failure; it reschedules with backoff and returns the new runAtMs (rescheduled = true),
// or moves the job to jobs:dead (rescheduled = false).
func fail(ctx context.Context, jobID string, nowMs int64) (runAtMs int64, rescheduled bool, err error) {
	attempt, err := rdb.HIncrBy(ctx, "jobs:attempts", jobID, 1).Result()
	if err != nil {
		return 0, false, err
	}
	if attempt >= maxAttempts {
		if err := rdb.RPush(ctx, "jobs:dead", jobID).Err(); err != nil {
			return 0, false, err
		}
		return 0, false, rdb.HDel(ctx, "jobs:attempts", jobID).Err()
	}
	runAtMs = nowMs + backoffMs(int(attempt))
	if err := rdb.ZAdd(ctx, "jobs:delayed", redis.Z{Score: float64(runAtMs), Member: jobID}).Err(); err != nil {
		return 0, false, err
	}
	return runAtMs, true, nil
}

// complete forgets the job: payload and attempts.
func complete(ctx context.Context, jobID string) error {
	if err := rdb.HDel(ctx, "jobs:payload", jobID).Err(); err != nil {
		return err
	}
	return rdb.HDel(ctx, "jobs:attempts", jobID).Err()
}
`,
    },
    scala: {
      starter: `import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled

/** Delayed jobs in Redis: a due-time sorted set, an atomic pop, exponential backoff, a dead list. */
object DelayedJobs {
  val jedis = new JedisPooled("redis", 6379)
  val MaxAttempts = 5
  val BaseMs = 1000L
  val MaxBackoffMs = 60000L

  // KEYS[1] = jobs:delayed   KEYS[2] = jobs:payload   KEYS[3] = jobs:attempts
  // ARGV[1] = now_ms   ARGV[2] = limit
  // Returns a flat list: id, payload, attempts, id, payload, attempts…
  val PopLua: String =
    """
      |return {}
      |""".stripMargin

  /** One due job: its id, payload and failures so far. */
  case class Job(id: String, payload: String, attempt: Int)

  /** HSET the payload, ZADD the id at runAtMs. */
  def schedule(jobId: String, payload: String, runAtMs: Long): Unit = {
    ??? // TODO
  }

  /** Up to limit jobs due at nowMs, earliest first, each removed from jobs:delayed by the script. */
  def popDue(nowMs: Long, limit: Int): List[Job] = {
    ??? // TODO: PopLua — ZRANGEBYSCORE … LIMIT, ZREM each, HGET payload and attempts; split the reply in threes
  }

  /** 1 s, 2 s, 4 s … capped at MaxBackoffMs. */
  def backoffMs(attempt: Int): Long = {
    ??? // TODO
  }

  /** Count the failure; reschedule with backoff and return the new runAtMs, or move to jobs:dead and return None. */
  def fail(jobId: String, nowMs: Long): Option[Long] = {
    ??? // TODO: HINCRBY jobs:attempts; >= MaxAttempts → RPUSH jobs:dead + HDEL attempts; else ZADD now + backoff
  }

  /** Forget the job: payload and attempts. */
  def complete(jobId: String): Unit = {
    ??? // TODO
  }
}
`,
      solution: `import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled

/** Delayed jobs in Redis: a due-time sorted set, an atomic pop, exponential backoff, a dead list. */
object DelayedJobs {
  val jedis = new JedisPooled("redis", 6379)
  val MaxAttempts = 5
  val BaseMs = 1000L
  val MaxBackoffMs = 60000L

  // KEYS[1] = jobs:delayed   KEYS[2] = jobs:payload   KEYS[3] = jobs:attempts
  // ARGV[1] = now_ms   ARGV[2] = limit
  // Returns a flat list: id, payload, attempts, id, payload, attempts…
  val PopLua: String =
    """
      |local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
      |local out = {}
      |for _, id in ipairs(due) do
      |  redis.call('ZREM', KEYS[1], id)
      |  out[#out + 1] = id
      |  out[#out + 1] = redis.call('HGET', KEYS[2], id) or ''
      |  out[#out + 1] = redis.call('HGET', KEYS[3], id) or '0'
      |end
      |return out
      |""".stripMargin

  /** One due job: its id, payload and failures so far. */
  case class Job(id: String, payload: String, attempt: Int)

  /** HSET the payload, ZADD the id at runAtMs. */
  def schedule(jobId: String, payload: String, runAtMs: Long): Unit = {
    jedis.hset("jobs:payload", jobId, payload)
    jedis.zadd("jobs:delayed", runAtMs.toDouble, jobId)
  }

  /** Up to limit jobs due at nowMs, earliest first, each removed from jobs:delayed by the script. */
  def popDue(nowMs: Long, limit: Int): List[Job] = {
    val keys = List("jobs:delayed", "jobs:payload", "jobs:attempts").asJava
    val args = List(nowMs.toString, limit.toString).asJava
    val flat = jedis.eval(PopLua, keys, args).asInstanceOf[java.util.List[AnyRef]].asScala.map(_.toString).toList
    flat.grouped(3).collect { case List(id, payload, attempts) => Job(id, payload, attempts.toInt) }.toList
  }

  /** 1 s, 2 s, 4 s … capped at MaxBackoffMs. */
  def backoffMs(attempt: Int): Long =
    math.min(BaseMs * math.pow(2, attempt - 1), MaxBackoffMs.toDouble).toLong

  /** Count the failure; reschedule with backoff and return the new runAtMs, or move to jobs:dead and return None. */
  def fail(jobId: String, nowMs: Long): Option[Long] = {
    val attempt = jedis.hincrBy("jobs:attempts", jobId, 1L)
    if (attempt >= MaxAttempts) {
      jedis.rpush("jobs:dead", jobId)
      jedis.hdel("jobs:attempts", jobId)
      None
    } else {
      val runAtMs = nowMs + backoffMs(attempt.toInt)
      jedis.zadd("jobs:delayed", runAtMs.toDouble, jobId)
      Some(runAtMs)
    }
  }

  /** Forget the job: payload and attempts. */
  def complete(jobId: String): Unit = {
    jedis.hdel("jobs:payload", jobId)
    jedis.hdel("jobs:attempts", jobId)
  }
}
`,
    },
    cpp: {
      starter: `// Delayed jobs in Redis: a due-time sorted set, an atomic pop, exponential backoff, a dead list.
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <cmath>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr int kMaxAttempts = 5;
constexpr long long kBaseMs = 1000;
constexpr long long kMaxBackoffMs = 60000;

// KEYS[1] = jobs:delayed   KEYS[2] = jobs:payload   KEYS[3] = jobs:attempts
// ARGV[1] = now_ms   ARGV[2] = limit
// Returns a flat list: id, payload, attempts, id, payload, attempts…
const std::string kPopLua = R"lua(
return {}
)lua";

// One due job: its id, payload and failures so far.
struct Job {
  std::string id;
  std::string payload;
  int attempt;
};

// HSET the payload, ZADD the id at run_at_ms.
void schedule(const std::string& job_id, const std::string& payload, long long run_at_ms) {
  // TODO
  throw std::logic_error("not implemented");
}

// Up to limit jobs due at now_ms, earliest first, each removed from jobs:delayed by the script.
std::vector<Job> pop_due(long long now_ms, int limit) {
  // TODO: kPopLua — ZRANGEBYSCORE … LIMIT, ZREM each, HGET payload and attempts; split the reply in threes
  throw std::logic_error("not implemented");
}

// 1 s, 2 s, 4 s … capped at kMaxBackoffMs.
long long backoff_ms(int attempt) {
  // TODO
  throw std::logic_error("not implemented");
}

// Count the failure; reschedule with backoff and return the new run_at_ms, or move to jobs:dead and return nullopt.
std::optional<long long> fail(const std::string& job_id, long long now_ms) {
  // TODO: HINCRBY jobs:attempts; >= kMaxAttempts → RPUSH jobs:dead + HDEL attempts; else ZADD now + backoff
  throw std::logic_error("not implemented");
}

// Forget the job: payload and attempts.
void complete(const std::string& job_id) {
  // TODO
  throw std::logic_error("not implemented");
}
`,
      solution: `// Delayed jobs in Redis: a due-time sorted set, an atomic pop, exponential backoff, a dead list.
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <cmath>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr int kMaxAttempts = 5;
constexpr long long kBaseMs = 1000;
constexpr long long kMaxBackoffMs = 60000;

// KEYS[1] = jobs:delayed   KEYS[2] = jobs:payload   KEYS[3] = jobs:attempts
// ARGV[1] = now_ms   ARGV[2] = limit
// Returns a flat list: id, payload, attempts, id, payload, attempts…
const std::string kPopLua = R"lua(
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
local out = {}
for _, id in ipairs(due) do
  redis.call('ZREM', KEYS[1], id)
  out[#out + 1] = id
  out[#out + 1] = redis.call('HGET', KEYS[2], id) or ''
  out[#out + 1] = redis.call('HGET', KEYS[3], id) or '0'
end
return out
)lua";

// One due job: its id, payload and failures so far.
struct Job {
  std::string id;
  std::string payload;
  int attempt;
};

// HSET the payload, ZADD the id at run_at_ms.
void schedule(const std::string& job_id, const std::string& payload, long long run_at_ms) {
  redis.hset("jobs:payload", job_id, payload);
  redis.zadd("jobs:delayed", job_id, static_cast<double>(run_at_ms));
}

// Up to limit jobs due at now_ms, earliest first, each removed from jobs:delayed by the script.
std::vector<Job> pop_due(long long now_ms, int limit) {
  const std::vector<std::string> keys{"jobs:delayed", "jobs:payload", "jobs:attempts"};
  const std::vector<std::string> args{std::to_string(now_ms), std::to_string(limit)};
  const auto flat = redis.eval<std::vector<std::string>>(kPopLua, keys.begin(), keys.end(), args.begin(), args.end());
  std::vector<Job> jobs;
  for (std::size_t i = 0; i + 2 < flat.size(); i += 3) {
    jobs.push_back({flat[i], flat[i + 1], std::stoi(flat[i + 2])});
  }
  return jobs;
}

// 1 s, 2 s, 4 s … capped at kMaxBackoffMs.
long long backoff_ms(int attempt) {
  const double delay = static_cast<double>(kBaseMs) * std::pow(2.0, attempt - 1);
  return std::min(static_cast<long long>(std::min(delay, static_cast<double>(kMaxBackoffMs))), kMaxBackoffMs);
}

// Count the failure; reschedule with backoff and return the new run_at_ms, or move to jobs:dead and return nullopt.
std::optional<long long> fail(const std::string& job_id, long long now_ms) {
  const long long attempt = redis.hincrby("jobs:attempts", job_id, 1);
  if (attempt >= kMaxAttempts) {
    redis.rpush("jobs:dead", job_id);
    redis.hdel("jobs:attempts", job_id);
    return std::nullopt;
  }
  const long long run_at_ms = now_ms + backoff_ms(static_cast<int>(attempt));
  redis.zadd("jobs:delayed", job_id, static_cast<double>(run_at_ms));
  return run_at_ms;
}

// Forget the job: payload and attempts.
void complete(const std::string& job_id) {
  redis.hdel("jobs:payload", job_id);
  redis.hdel("jobs:attempts", job_id);
}
`,
    },
  },
  harness: {
    python: `def _ids(jobs):
    return [job[0] for job in jobs]


def check_scheduled(ctx):
    m = ctx.load("delayed_jobs")
    m.schedule("a", "send-email:a", 5000)
    m.schedule("b", "send-email:b", 2000)
    assert ctx.redis.hget("jobs:payload", "a") == "send-email:a", f"jobs:payload a is {ctx.redis.hget('jobs:payload', 'a')!r}, expected the payload send-email:a"
    assert ctx.redis.zscore("jobs:delayed", "a") == 5000, f"jobs:delayed scores a at {ctx.redis.zscore('jobs:delayed', 'a')}, expected run_at_ms 5000"
    assert ctx.redis.zscore("jobs:delayed", "b") == 2000, f"jobs:delayed scores b at {ctx.redis.zscore('jobs:delayed', 'b')}, expected run_at_ms 2000"
    assert set(ctx.redis.keys("*")) == {"jobs:payload", "jobs:delayed"}, f"schedule wrote {sorted(ctx.redis.keys('*'))}, expected exactly jobs:payload and jobs:delayed"
    assert m.pop_due(1999, 10) == [], f"at 1999 ms nothing is due (b is due at 2000), but pop_due returned {m.pop_due(1999, 10)}"
    assert ctx.redis.zcard("jobs:delayed") == 2, "a pop that returned nothing must remove nothing"
    assert m.pop_due(2000, 10) == [("b", "send-email:b", 0)], f"at 2000 ms exactly b is due: expected [('b', 'send-email:b', 0)], got {m.pop_due(2000, 10)}"
    assert ctx.redis.zrange("jobs:delayed", 0, -1) == ["a"], f"after popping b jobs:delayed holds {ctx.redis.zrange('jobs:delayed', 0, -1)}, expected only a"
    assert ctx.redis.hget("jobs:payload", "b") == "send-email:b", "popping must not delete the payload: complete does"


def check_due_in_order(ctx):
    m = ctx.load("delayed_jobs")
    for job_id, run_at in [("j3", 3000), ("j1", 1000), ("j5", 5000), ("j2", 2000), ("j4", 4000)]:
        m.schedule(job_id, f"payload-{job_id}", run_at)
    first = m.pop_due(3500, 2)
    assert _ids(first) == ["j1", "j2"], f"at 3500 ms with limit 2 the two earliest due jobs are j1, j2; got {_ids(first)}"
    assert first == [("j1", "payload-j1", 0), ("j2", "payload-j2", 0)], f"each job is (id, payload, attempt): got {first}"
    assert ctx.redis.zrange("jobs:delayed", 0, -1) == ["j3", "j4", "j5"], f"the jobs beyond the limit must stay: jobs:delayed holds {ctx.redis.zrange('jobs:delayed', 0, -1)}, expected j3, j4, j5"
    assert _ids(m.pop_due(3500, 10)) == ["j3"], "j3 is the only job still due at 3500 ms"
    assert _ids(m.pop_due(10000, 10)) == ["j4", "j5"], "at 10000 ms the rest pop in run_at order"
    assert m.pop_due(10000, 10) == [], "a drained set pops nothing"
    assert ctx.redis.exists("jobs:delayed") == 0 or ctx.redis.zcard("jobs:delayed") == 0, "every job was popped; jobs:delayed must be empty"


def check_atomic_claim(ctx):
    m = ctx.load("delayed_jobs")
    m.schedule("solo", "p", 100)
    assert _ids(m.pop_due(100, 10)) == ["solo"]
    assert ctx.redis.zscore("jobs:delayed", "solo") is None, "a popped job must be gone from jobs:delayed: the script ZREMs what it returns"
    for i in range(3):
        m.schedule(f"j{i}", f"p{i}", 1000)
    other = ctx.reload("delayed_jobs")
    # A second worker's pop_due lands right after the first command that touches jobs:delayed —
    # between a client-side ZRANGEBYSCORE and its ZREM, or after the whole script.
    rival = ctx.redis_after("jobs:delayed", lambda: other.pop_due(1000, 10))
    mine = m.pop_due(1000, 10)
    assert rival.fired, "pop_due never touched jobs:delayed as a script key: pass it as KEYS[1]"
    if rival.error is not None:
        raise rival.error
    theirs = rival.result
    shared = set(_ids(mine)) & set(_ids(theirs))
    assert not shared, f"two workers popping at once both got {sorted(shared)}: a ZRANGEBYSCORE followed by a separate ZREM lets both read the same ids. Read and remove inside one Lua script"
    assert set(_ids(mine)) | set(_ids(theirs)) == {"j0", "j1", "j2"}, f"between them the two workers must get every due job once: {_ids(mine)} and {_ids(theirs)}"
    assert ctx.redis.zcard("jobs:delayed") == 0, f"jobs:delayed still holds {ctx.redis.zrange('jobs:delayed', 0, -1)} after both pops"


def check_backoff(ctx):
    m = ctx.load("delayed_jobs")
    m.schedule("j", "p", 0)
    now = 0
    for failures, delay in enumerate([1000, 2000, 4000, 8000]):
        due = m.pop_due(now, 10)
        assert due == [("j", "p", failures)], f"at {now} ms the job is due with {failures} failure(s) so far: expected [('j', 'p', {failures})], got {due}"
        assert m.fail("j", now) == now + delay, f"failure {failures + 1} must reschedule at now + {delay} ms = {now + delay}, fail returned {m.fail('j', now)}"
        assert ctx.redis.zscore("jobs:delayed", "j") == now + delay, f"after failure {failures + 1} jobs:delayed scores j at {ctx.redis.zscore('jobs:delayed', 'j')}, expected {now + delay}"
        assert ctx.redis.hget("jobs:attempts", "j") == str(failures + 1), f"jobs:attempts j is {ctx.redis.hget('jobs:attempts', 'j')!r} after {failures + 1} failure(s)"
        assert m.pop_due(now + delay - 1, 10) == [], f"1 ms before its new run_at the job must not pop"
        now += delay
    assert m.pop_due(now, 10) == [("j", "p", 4)], "the fifth run sees 4 failures"
    assert m.fail("j", now) is None, "the fifth failure must not reschedule: fail returns None"
    assert ctx.redis.zscore("jobs:delayed", "j") is None, "a dead job must not be in jobs:delayed"
    assert ctx.redis.lrange("jobs:dead", 0, -1) == ["j"], f"jobs:dead holds {ctx.redis.lrange('jobs:dead', 0, -1)}, expected [j]"
    assert ctx.redis.hget("jobs:attempts", "j") is None, "a dead job's attempt count is dropped"
    assert ctx.redis.hget("jobs:payload", "j") == "p", "a dead job's payload stays for inspection"
    assert m.pop_due(10**9, 10) == [], "a dead job never pops again"


def check_backoff_cap(ctx):
    m = ctx.load("delayed_jobs")
    for attempt, want in [(1, 1000), (2, 2000), (3, 4000), (4, 8000), (5, 16000), (6, 32000), (7, 60000), (8, 60000), (12, 60000)]:
        got = m.backoff_ms(attempt)
        assert got == want, f"backoff_ms({attempt}) is {got}, expected {want}: BASE_MS * 2^(attempt - 1) capped at MAX_BACKOFF_MS"
    m.schedule("j", "p", 0)
    m.pop_due(0, 10)
    assert m.fail("j", 500000) == 501000, "the first failure at 500000 ms must reschedule at 501000"
    m.pop_due(501000, 10)
    assert m.fail("j", 501000) == 503000, "the second failure at 501000 ms must reschedule at 503000"


def check_complete(ctx):
    m = ctx.load("delayed_jobs")
    m.schedule("a", "pa", 0)
    m.schedule("b", "pb", 5000)
    assert _ids(m.pop_due(0, 10)) == ["a"]
    m.fail("a", 0)
    assert _ids(m.pop_due(1000, 10)) == ["a"]
    m.complete("a")
    assert ctx.redis.hget("jobs:payload", "a") is None, "complete must delete the payload"
    assert ctx.redis.hget("jobs:attempts", "a") is None, "complete must delete the attempt count"
    assert ctx.redis.zscore("jobs:delayed", "a") is None, "a completed job is not in jobs:delayed"
    assert "a" not in ctx.redis.lrange("jobs:dead", 0, -1), "a completed job is not in jobs:dead"
    assert ctx.redis.hget("jobs:payload", "b") == "pb" and ctx.redis.zscore("jobs:delayed", "b") == 5000, "completing a must leave b untouched"
    assert _ids(m.pop_due(5000, 10)) == ["b"]
    m.complete("b")
    assert ctx.redis.keys("*") == [], f"after completing every job nothing remains, but Redis holds {sorted(ctx.redis.keys('*'))}"
`,
    typescript: `const ids = (jobs: [string, string, number][]) => jobs.map(j => j[0]);

export async function check_scheduled(ctx) {
  const m = ctx.load('delayed_jobs');
  await m.schedule('a', 'send-email:a', 5000);
  await m.schedule('b', 'send-email:b', 2000);
  assert.equal(ctx.redis.hget('jobs:payload', 'a'), 'send-email:a', \`jobs:payload a is \${JSON.stringify(ctx.redis.hget('jobs:payload', 'a'))}, expected the payload send-email:a\`);
  assert.equal(Number(ctx.redis.zscore('jobs:delayed', 'a')), 5000, \`jobs:delayed scores a at \${ctx.redis.zscore('jobs:delayed', 'a')}, expected runAtMs 5000\`);
  assert.equal(Number(ctx.redis.zscore('jobs:delayed', 'b')), 2000, \`jobs:delayed scores b at \${ctx.redis.zscore('jobs:delayed', 'b')}, expected runAtMs 2000\`);
  assert.deepEqual([...ctx.redis.keys('*')].sort(), ['jobs:delayed', 'jobs:payload'], \`schedule wrote \${JSON.stringify(ctx.redis.keys('*'))}, expected exactly jobs:payload and jobs:delayed\`);
  assert.deepEqual(await m.popDue(1999, 10), [], 'at 1999 ms nothing is due (b is due at 2000)');
  assert.equal(ctx.redis.zcard('jobs:delayed'), 2, 'a pop that returned nothing must remove nothing');
  const due = await m.popDue(2000, 10);
  assert.deepEqual(due, [['b', 'send-email:b', 0]], \`at 2000 ms exactly b is due: expected [['b', 'send-email:b', 0]], got \${JSON.stringify(due)}\`);
  assert.deepEqual(ctx.redis.zrange('jobs:delayed', 0, -1), ['a'], \`after popping b jobs:delayed holds \${JSON.stringify(ctx.redis.zrange('jobs:delayed', 0, -1))}, expected only a\`);
  assert.equal(ctx.redis.hget('jobs:payload', 'b'), 'send-email:b', 'popping must not delete the payload: complete does');
}

export async function check_due_in_order(ctx) {
  const m = ctx.load('delayed_jobs');
  for (const [jobId, runAt] of [['j3', 3000], ['j1', 1000], ['j5', 5000], ['j2', 2000], ['j4', 4000]] as [string, number][]) {
    await m.schedule(jobId, \`payload-\${jobId}\`, runAt);
  }
  const first = await m.popDue(3500, 2);
  assert.deepEqual(ids(first), ['j1', 'j2'], \`at 3500 ms with limit 2 the two earliest due jobs are j1, j2; got \${JSON.stringify(ids(first))}\`);
  assert.deepEqual(first, [['j1', 'payload-j1', 0], ['j2', 'payload-j2', 0]], \`each job is [id, payload, attempt]: got \${JSON.stringify(first)}\`);
  assert.deepEqual(ctx.redis.zrange('jobs:delayed', 0, -1), ['j3', 'j4', 'j5'], \`the jobs beyond the limit must stay: jobs:delayed holds \${JSON.stringify(ctx.redis.zrange('jobs:delayed', 0, -1))}, expected j3, j4, j5\`);
  assert.deepEqual(ids(await m.popDue(3500, 10)), ['j3'], 'j3 is the only job still due at 3500 ms');
  assert.deepEqual(ids(await m.popDue(10000, 10)), ['j4', 'j5'], 'at 10000 ms the rest pop in runAt order');
  assert.deepEqual(await m.popDue(10000, 10), [], 'a drained set pops nothing');
  assert.equal(ctx.redis.zcard('jobs:delayed'), 0, 'every job was popped; jobs:delayed must be empty');
}

export async function check_atomic_claim(ctx) {
  const m = ctx.load('delayed_jobs');
  await m.schedule('solo', 'p', 100);
  assert.deepEqual(ids(await m.popDue(100, 10)), ['solo']);
  assert.equal(ctx.redis.zscore('jobs:delayed', 'solo'), null, 'a popped job must be gone from jobs:delayed: the script ZREMs what it returns');
  for (let i = 0; i < 3; i++) await m.schedule(\`j\${i}\`, \`p\${i}\`, 1000);
  const other = ctx.reload('delayed_jobs');
  // A second worker's popDue lands right after the first command that touches jobs:delayed —
  // between a client-side ZRANGEBYSCORE and its ZREM, or after the whole script.
  let theirs: Promise<[string, string, number][]> | undefined;
  const rival = ctx.redisAfter('jobs:delayed', () => {
    theirs = other.popDue(1000, 10);
  });
  const mine = await m.popDue(1000, 10);
  assert(rival.fired && theirs !== undefined, 'popDue never touched jobs:delayed as a script key: pass it as KEYS[1]');
  const his = await theirs;
  const shared = ids(mine).filter(id => ids(his).includes(id));
  assert.equal(shared.length, 0, \`two workers popping at once both got \${JSON.stringify(shared)}: a ZRANGEBYSCORE followed by a separate ZREM lets both read the same ids. Read and remove inside one Lua script\`);
  assert.deepEqual([...ids(mine), ...ids(his)].sort(), ['j0', 'j1', 'j2'], \`between them the two workers must get every due job once: \${JSON.stringify(ids(mine))} and \${JSON.stringify(ids(his))}\`);
  assert.equal(ctx.redis.zcard('jobs:delayed'), 0, \`jobs:delayed still holds \${JSON.stringify(ctx.redis.zrange('jobs:delayed', 0, -1))} after both pops\`);
}

export async function check_backoff(ctx) {
  const m = ctx.load('delayed_jobs');
  await m.schedule('j', 'p', 0);
  let now = 0;
  const delays = [1000, 2000, 4000, 8000];
  for (let failures = 0; failures < delays.length; failures++) {
    const delay = delays[failures];
    const due = await m.popDue(now, 10);
    assert.deepEqual(due, [['j', 'p', failures]], \`at \${now} ms the job is due with \${failures} failure(s) so far: expected [['j', 'p', \${failures}]], got \${JSON.stringify(due)}\`);
    const next = await m.fail('j', now);
    assert.equal(next, now + delay, \`failure \${failures + 1} must reschedule at now + \${delay} ms = \${now + delay}, fail returned \${next}\`);
    assert.equal(Number(ctx.redis.zscore('jobs:delayed', 'j')), now + delay, \`after failure \${failures + 1} jobs:delayed scores j at \${ctx.redis.zscore('jobs:delayed', 'j')}, expected \${now + delay}\`);
    assert.equal(ctx.redis.hget('jobs:attempts', 'j'), String(failures + 1), \`jobs:attempts j is \${JSON.stringify(ctx.redis.hget('jobs:attempts', 'j'))} after \${failures + 1} failure(s)\`);
    assert.deepEqual(await m.popDue(now + delay - 1, 10), [], '1 ms before its new runAt the job must not pop');
    now += delay;
  }
  assert.deepEqual(await m.popDue(now, 10), [['j', 'p', 4]], 'the fifth run sees 4 failures');
  assert.equal(await m.fail('j', now), null, 'the fifth failure must not reschedule: fail returns null');
  assert.equal(ctx.redis.zscore('jobs:delayed', 'j'), null, 'a dead job must not be in jobs:delayed');
  assert.deepEqual(ctx.redis.lrange('jobs:dead', 0, -1), ['j'], \`jobs:dead holds \${JSON.stringify(ctx.redis.lrange('jobs:dead', 0, -1))}, expected [j]\`);
  assert.equal(ctx.redis.hget('jobs:attempts', 'j'), null, "a dead job's attempt count is dropped");
  assert.equal(ctx.redis.hget('jobs:payload', 'j'), 'p', "a dead job's payload stays for inspection");
  assert.deepEqual(await m.popDue(1e9, 10), [], 'a dead job never pops again');
}

export async function check_backoff_cap(ctx) {
  const m = ctx.load('delayed_jobs');
  for (const [attempt, want] of [[1, 1000], [2, 2000], [3, 4000], [4, 8000], [5, 16000], [6, 32000], [7, 60000], [8, 60000], [12, 60000]]) {
    const got = m.backoffMs(attempt);
    assert.equal(got, want, \`backoffMs(\${attempt}) is \${got}, expected \${want}: BASE_MS * 2^(attempt - 1) capped at MAX_BACKOFF_MS\`);
  }
  await m.schedule('j', 'p', 0);
  await m.popDue(0, 10);
  assert.equal(await m.fail('j', 500000), 501000, 'the first failure at 500000 ms must reschedule at 501000');
  await m.popDue(501000, 10);
  assert.equal(await m.fail('j', 501000), 503000, 'the second failure at 501000 ms must reschedule at 503000');
}

export async function check_complete(ctx) {
  const m = ctx.load('delayed_jobs');
  await m.schedule('a', 'pa', 0);
  await m.schedule('b', 'pb', 5000);
  assert.deepEqual(ids(await m.popDue(0, 10)), ['a']);
  await m.fail('a', 0);
  assert.deepEqual(ids(await m.popDue(1000, 10)), ['a']);
  await m.complete('a');
  assert.equal(ctx.redis.hget('jobs:payload', 'a'), null, 'complete must delete the payload');
  assert.equal(ctx.redis.hget('jobs:attempts', 'a'), null, 'complete must delete the attempt count');
  assert.equal(ctx.redis.zscore('jobs:delayed', 'a'), null, 'a completed job is not in jobs:delayed');
  assert(!ctx.redis.lrange('jobs:dead', 0, -1).includes('a'), 'a completed job is not in jobs:dead');
  assert(ctx.redis.hget('jobs:payload', 'b') === 'pb' && Number(ctx.redis.zscore('jobs:delayed', 'b')) === 5000, 'completing a must leave b untouched');
  assert.deepEqual(ids(await m.popDue(5000, 10)), ['b']);
  await m.complete('b');
  assert.deepEqual(ctx.redis.keys('*'), [], \`after completing every job nothing remains, but Redis holds \${JSON.stringify(ctx.redis.keys('*'))}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"sort"

	"leetbuild/harness"
)

var djBg = context.Background()

func djIDs(jobs []Job) []string {
	ids := []string{}
	for _, j := range jobs {
		ids = append(ids, j.ID)
	}
	return ids
}

func djSchedule(ctx *harness.Ctx, jobID, payload string, runAtMs int64) {
	ctx.NoError(schedule(djBg, jobID, payload, runAtMs), "schedule(%q, %q, %d) returned an error", jobID, payload, runAtMs)
}

func djPop(ctx *harness.Ctx, nowMs int64, limit int) []Job {
	jobs, err := popDue(djBg, nowMs, limit)
	ctx.NoError(err, "popDue(%d, %d) returned an error", nowMs, limit)
	return jobs
}

// djFail is the new runAtMs, or nil when the job was not rescheduled.
func djFail(ctx *harness.Ctx, jobID string, nowMs int64) any {
	runAtMs, rescheduled, err := fail(djBg, jobID, nowMs)
	ctx.NoError(err, "fail(%q, %d) returned an error", jobID, nowMs)
	if !rescheduled {
		return nil
	}
	return runAtMs
}

func djComplete(ctx *harness.Ctx, jobID string) {
	ctx.NoError(complete(djBg, jobID), "complete(%q) returned an error", jobID)
}

// djScore is the job's score in jobs:delayed, or nil when it is not there.
func djScore(ctx *harness.Ctx, id string) any {
	if s, ok := ctx.Redis.ZScore("jobs:delayed", id); ok {
		return s
	}
	return nil
}

// djHGet is a hash field, or nil when it is missing.
func djHGet(ctx *harness.Ctx, key, field string) any {
	if v, ok := ctx.Redis.HGet(key, field); ok {
		return v
	}
	return nil
}

func djDelayed(ctx *harness.Ctx) []string {
	ids := []string{}
	for _, z := range ctx.Redis.ZRangeWithScores("jobs:delayed", 0, -1) {
		ids = append(ids, z.Member)
	}
	return ids
}

func CheckScheduled(ctx *harness.Ctx) {
	djSchedule(ctx, "a", "send-email:a", 5000)
	djSchedule(ctx, "b", "send-email:b", 2000)
	ctx.Equal(djHGet(ctx, "jobs:payload", "a"), "send-email:a", "jobs:payload a must hold the payload")
	ctx.Equal(djScore(ctx, "a"), 5000, "jobs:delayed must score a at runAtMs 5000")
	ctx.Equal(djScore(ctx, "b"), 2000, "jobs:delayed must score b at runAtMs 2000")
	ctx.Equal(ctx.Redis.Keys("*"), []string{"jobs:delayed", "jobs:payload"}, "schedule must write exactly jobs:payload and jobs:delayed")
	early := djPop(ctx, 1999, 10)
	ctx.Assert(len(early) == 0, "at 1999 ms nothing is due (b is due at 2000), got %+v", early)
	ctx.Equal(ctx.Redis.ZCard("jobs:delayed"), 2, "a pop that returned nothing must remove nothing: ZCARD jobs:delayed")
	ctx.Equal(djPop(ctx, 2000, 10), []Job{{ID: "b", Payload: "send-email:b", Attempt: 0}}, "at 2000 ms exactly b is due")
	ctx.Equal(djDelayed(ctx), []string{"a"}, "after popping b jobs:delayed must hold only a")
	ctx.Equal(djHGet(ctx, "jobs:payload", "b"), "send-email:b", "popping must not delete the payload: complete does")
}

func CheckDueInOrder(ctx *harness.Ctx) {
	for _, s := range []struct {
		id    string
		runAt int64
	}{{"j3", 3000}, {"j1", 1000}, {"j5", 5000}, {"j2", 2000}, {"j4", 4000}} {
		djSchedule(ctx, s.id, "payload-"+s.id, s.runAt)
	}
	first := djPop(ctx, 3500, 2)
	ctx.Equal(djIDs(first), []string{"j1", "j2"}, "at 3500 ms with limit 2 the two earliest due jobs are j1, j2")
	ctx.Equal(first, []Job{{ID: "j1", Payload: "payload-j1", Attempt: 0}, {ID: "j2", Payload: "payload-j2", Attempt: 0}}, "each job is {ID, Payload, Attempt}")
	ctx.Equal(djDelayed(ctx), []string{"j3", "j4", "j5"}, "the jobs beyond the limit must stay in jobs:delayed")
	ctx.Equal(djIDs(djPop(ctx, 3500, 10)), []string{"j3"}, "j3 is the only job still due at 3500 ms")
	ctx.Equal(djIDs(djPop(ctx, 10000, 10)), []string{"j4", "j5"}, "at 10000 ms the rest pop in runAt order")
	drained := djPop(ctx, 10000, 10)
	ctx.Assert(len(drained) == 0, "a drained set pops nothing, got %+v", drained)
	ctx.Equal(ctx.Redis.ZCard("jobs:delayed"), 0, "every job was popped; jobs:delayed must be empty")
}

func CheckAtomicClaim(ctx *harness.Ctx) {
	djSchedule(ctx, "solo", "p", 100)
	ctx.Equal(djIDs(djPop(ctx, 100, 10)), []string{"solo"}, "the jobs due at 100 ms")
	ctx.Equal(djScore(ctx, "solo"), nil, "a popped job must be gone from jobs:delayed: the script ZREMs what it returns")
	for i := range 3 {
		djSchedule(ctx, fmt.Sprintf("j%d", i), fmt.Sprintf("p%d", i), 1000)
	}
	// A second worker's popDue lands right after the first command that touches jobs:delayed —
	// between a client-side ZRANGEBYSCORE and its ZREM, or after the whole script.
	rival := ctx.Redis.After("jobs:delayed", func() any {
		jobs, err := popDue(djBg, 1000, 10)
		if err != nil {
			panic(err)
		}
		return jobs
	})
	mine := djPop(ctx, 1000, 10)
	ctx.Assert(rival.Fired, "popDue never touched jobs:delayed as a script key: pass it as KEYS[1]")
	ctx.NoError(rival.Err, "the second worker's popDue failed")
	his, _ := rival.Result.([]Job)
	shared := []string{}
	for _, a := range djIDs(mine) {
		for _, b := range djIDs(his) {
			if a == b {
				shared = append(shared, a)
			}
		}
	}
	ctx.Assert(len(shared) == 0, "two workers popping at once both got %q: a ZRANGEBYSCORE followed by a separate ZREM lets both read the same ids. Read and remove inside one Lua script", shared)
	all := append(djIDs(mine), djIDs(his)...)
	sort.Strings(all)
	ctx.Assert(fmt.Sprint(all) == "[j0 j1 j2]", "between them the two workers must get every due job once: %q and %q", djIDs(mine), djIDs(his))
	ctx.Assert(ctx.Redis.ZCard("jobs:delayed") == 0, "jobs:delayed still holds %q after both pops", djDelayed(ctx))
}

func CheckBackoff(ctx *harness.Ctx) {
	djSchedule(ctx, "j", "p", 0)
	now := int64(0)
	for failures, delay := range []int64{1000, 2000, 4000, 8000} {
		due := djPop(ctx, now, 10)
		ctx.Equal(due, []Job{{ID: "j", Payload: "p", Attempt: failures}}, "at %d ms the job is due with %d failure(s) so far", now, failures)
		ctx.Equal(djFail(ctx, "j", now), now+delay, "failure %d must reschedule at now + %d ms: the runAtMs fail returned", failures+1, delay)
		ctx.Equal(djScore(ctx, "j"), now+delay, "after failure %d jobs:delayed must score j at now + %d ms", failures+1, delay)
		ctx.Equal(djHGet(ctx, "jobs:attempts", "j"), fmt.Sprint(failures+1), "jobs:attempts j after %d failure(s)", failures+1)
		early := djPop(ctx, now+delay-1, 10)
		ctx.Assert(len(early) == 0, "1 ms before its new runAt the job must not pop, got %+v", early)
		now += delay
	}
	ctx.Equal(djPop(ctx, now, 10), []Job{{ID: "j", Payload: "p", Attempt: 4}}, "the fifth run sees 4 failures")
	ctx.Equal(djFail(ctx, "j", now), nil, "the fifth failure must not reschedule: fail returns rescheduled false")
	ctx.Equal(djScore(ctx, "j"), nil, "a dead job must not be in jobs:delayed")
	ctx.Equal(ctx.Redis.LRange("jobs:dead", 0, -1), []string{"j"}, "jobs:dead")
	ctx.Equal(djHGet(ctx, "jobs:attempts", "j"), nil, "a dead job's attempt count is dropped")
	ctx.Equal(djHGet(ctx, "jobs:payload", "j"), "p", "a dead job's payload stays for inspection")
	late := djPop(ctx, 1_000_000_000, 10)
	ctx.Assert(len(late) == 0, "a dead job never pops again, got %+v", late)
}

func CheckBackoffCap(ctx *harness.Ctx) {
	for _, c := range [][2]int64{{1, 1000}, {2, 2000}, {3, 4000}, {4, 8000}, {5, 16000}, {6, 32000}, {7, 60000}, {8, 60000}, {12, 60000}} {
		ctx.Equal(backoffMs(int(c[0])), c[1], "backoffMs(%d): baseMs * 2^(attempt - 1) capped at maxBackoffMs", c[0])
	}
	djSchedule(ctx, "j", "p", 0)
	djPop(ctx, 0, 10)
	ctx.Equal(djFail(ctx, "j", 500000), 501000, "the first failure at 500000 ms must reschedule at 501000")
	djPop(ctx, 501000, 10)
	ctx.Equal(djFail(ctx, "j", 501000), 503000, "the second failure at 501000 ms must reschedule at 503000")
}

func CheckComplete(ctx *harness.Ctx) {
	djSchedule(ctx, "a", "pa", 0)
	djSchedule(ctx, "b", "pb", 5000)
	ctx.Equal(djIDs(djPop(ctx, 0, 10)), []string{"a"}, "the jobs due at 0 ms")
	djFail(ctx, "a", 0)
	ctx.Equal(djIDs(djPop(ctx, 1000, 10)), []string{"a"}, "the jobs due at 1000 ms")
	djComplete(ctx, "a")
	ctx.Equal(djHGet(ctx, "jobs:payload", "a"), nil, "complete must delete the payload")
	ctx.Equal(djHGet(ctx, "jobs:attempts", "a"), nil, "complete must delete the attempt count")
	ctx.Equal(djScore(ctx, "a"), nil, "a completed job is not in jobs:delayed")
	dead := false
	for _, id := range ctx.Redis.LRange("jobs:dead", 0, -1) {
		dead = dead || id == "a"
	}
	ctx.Assert(!dead, "a completed job is not in jobs:dead")
	ctx.Assert(djHGet(ctx, "jobs:payload", "b") == "pb" && djScore(ctx, "b") == 5000.0, "completing a must leave b untouched")
	ctx.Equal(djIDs(djPop(ctx, 5000, 10)), []string{"b"}, "the jobs due at 5000 ms")
	djComplete(ctx, "b")
	keys := ctx.Redis.Keys("*")
	ctx.Assert(len(keys) == 0, "after completing every job nothing remains, but Redis holds %q", keys)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <optional>
#include <string>
#include <tuple>
#include <vector>

namespace {

// A job as {ID Payload Attempt}, comparable and printable the way Go's Job struct is.
using DjJob = std::tuple<std::string, std::string, int>;

std::vector<DjJob> djJobs(const std::vector<Job>& jobs) {
  std::vector<DjJob> out;
  for (const auto& j : jobs) out.emplace_back(j.id, j.payload, j.attempt);
  return out;
}

std::vector<std::string> djIDs(const std::vector<Job>& jobs) {
  std::vector<std::string> ids;
  for (const auto& j : jobs) ids.push_back(j.id);
  return ids;
}

// The job's score in jobs:delayed, or nullopt when it is not there.
std::optional<double> djScore(harness::Ctx& ctx, const std::string& id) { return ctx.Redis.ZScore("jobs:delayed", id); }

std::vector<std::string> djDelayed(harness::Ctx& ctx) {
  std::vector<std::string> ids;
  for (const auto& z : ctx.Redis.ZRangeWithScores("jobs:delayed", 0, -1)) ids.push_back(z.Member);
  return ids;
}

}  // namespace

void CheckScheduled(harness::Ctx& ctx) {
  schedule("a", "send-email:a", 5000);
  schedule("b", "send-email:b", 2000);
  ctx.Equal(ctx.Redis.HGet("jobs:payload", "a"), "send-email:a", "jobs:payload a must hold the payload");
  ctx.Equal(djScore(ctx, "a"), 5000, "jobs:delayed must score a at runAtMs 5000");
  ctx.Equal(djScore(ctx, "b"), 2000, "jobs:delayed must score b at runAtMs 2000");
  ctx.Equal(ctx.Redis.Keys("*"), std::vector<std::string>{"jobs:delayed", "jobs:payload"}, "schedule must write exactly jobs:payload and jobs:delayed");
  const auto early = djJobs(pop_due(1999, 10));
  ctx.Assert(early.empty(), "at 1999 ms nothing is due (b is due at 2000), got %+v", early);
  ctx.Equal(ctx.Redis.ZCard("jobs:delayed"), 2, "a pop that returned nothing must remove nothing: ZCARD jobs:delayed");
  ctx.Equal(djJobs(pop_due(2000, 10)), std::vector<DjJob>{{"b", "send-email:b", 0}}, "at 2000 ms exactly b is due");
  ctx.Equal(djDelayed(ctx), std::vector<std::string>{"a"}, "after popping b jobs:delayed must hold only a");
  ctx.Equal(ctx.Redis.HGet("jobs:payload", "b"), "send-email:b", "popping must not delete the payload: complete does");
}

void CheckDueInOrder(harness::Ctx& ctx) {
  const std::vector<std::pair<std::string, long long>> seed{{"j3", 3000}, {"j1", 1000}, {"j5", 5000}, {"j2", 2000}, {"j4", 4000}};
  for (const auto& [id, runAt] : seed) schedule(id, "payload-" + id, runAt);
  const auto first = pop_due(3500, 2);
  ctx.Equal(djIDs(first), std::vector<std::string>{"j1", "j2"}, "at 3500 ms with limit 2 the two earliest due jobs are j1, j2");
  ctx.Equal(djJobs(first), std::vector<DjJob>{{"j1", "payload-j1", 0}, {"j2", "payload-j2", 0}}, "each job is {ID, Payload, Attempt}");
  ctx.Equal(djDelayed(ctx), std::vector<std::string>{"j3", "j4", "j5"}, "the jobs beyond the limit must stay in jobs:delayed");
  ctx.Equal(djIDs(pop_due(3500, 10)), std::vector<std::string>{"j3"}, "j3 is the only job still due at 3500 ms");
  ctx.Equal(djIDs(pop_due(10000, 10)), std::vector<std::string>{"j4", "j5"}, "at 10000 ms the rest pop in runAt order");
  const auto drained = djJobs(pop_due(10000, 10));
  ctx.Assert(drained.empty(), "a drained set pops nothing, got %+v", drained);
  ctx.Equal(ctx.Redis.ZCard("jobs:delayed"), 0, "every job was popped; jobs:delayed must be empty");
}

void CheckAtomicClaim(harness::Ctx& ctx) {
  schedule("solo", "p", 100);
  ctx.Equal(djIDs(pop_due(100, 10)), std::vector<std::string>{"solo"}, "the jobs due at 100 ms");
  ctx.Equal(djScore(ctx, "solo"), nullptr, "a popped job must be gone from jobs:delayed: the script ZREMs what it returns");
  for (int i = 0; i < 3; i++) {
    schedule(harness::Sprintf("j%d", i), harness::Sprintf("p%d", i), 1000);
  }
  // A second worker's popDue lands right after the first command that touches jobs:delayed —
  // between a client-side ZRANGEBYSCORE and its ZREM, or after the whole script.
  bool fired = false;
  std::optional<std::string> rivalErr;
  std::vector<Job> his;
  ctx.Redis.After("jobs:delayed", [&] {
    fired = true;
    try {
      his = pop_due(1000, 10);
    } catch (const std::exception& e) {
      rivalErr = e.what();
    }
  });
  const auto mine = pop_due(1000, 10);
  ctx.Assert(fired, "popDue never touched jobs:delayed as a script key: pass it as KEYS[1]");
  ctx.Assert(!rivalErr, "the second worker's popDue failed: %v", rivalErr);
  std::vector<std::string> shared;
  for (const auto& a : djIDs(mine)) {
    for (const auto& b : djIDs(his)) {
      if (a == b) shared.push_back(a);
    }
  }
  ctx.Assert(shared.empty(), "two workers popping at once both got %q: a ZRANGEBYSCORE followed by a separate ZREM lets both read the same ids. Read and remove inside one Lua script", shared);
  auto all = djIDs(mine);
  for (const auto& id : djIDs(his)) all.push_back(id);
  std::sort(all.begin(), all.end());
  ctx.Assert(harness::Value(all) == "[j0 j1 j2]", "between them the two workers must get every due job once: %q and %q", djIDs(mine), djIDs(his));
  ctx.Assert(ctx.Redis.ZCard("jobs:delayed") == 0, "jobs:delayed still holds %q after both pops", djDelayed(ctx));
}

void CheckBackoff(harness::Ctx& ctx) {
  schedule("j", "p", 0);
  long long now = 0;
  const std::vector<long long> delays{1000, 2000, 4000, 8000};
  for (int failures = 0; failures < static_cast<int>(delays.size()); failures++) {
    const long long delay = delays[static_cast<size_t>(failures)];
    ctx.Equal(djJobs(pop_due(now, 10)), std::vector<DjJob>{{"j", "p", failures}}, "at %d ms the job is due with %d failure(s) so far", now, failures);
    ctx.Equal(fail("j", now), now + delay, "failure %d must reschedule at now + %d ms: the runAtMs fail returned", failures + 1, delay);
    ctx.Equal(djScore(ctx, "j"), now + delay, "after failure %d jobs:delayed must score j at now + %d ms", failures + 1, delay);
    ctx.Equal(ctx.Redis.HGet("jobs:attempts", "j"), std::to_string(failures + 1), "jobs:attempts j after %d failure(s)", failures + 1);
    const auto early = djJobs(pop_due(now + delay - 1, 10));
    ctx.Assert(early.empty(), "1 ms before its new runAt the job must not pop, got %+v", early);
    now += delay;
  }
  ctx.Equal(djJobs(pop_due(now, 10)), std::vector<DjJob>{{"j", "p", 4}}, "the fifth run sees 4 failures");
  ctx.Equal(fail("j", now), nullptr, "the fifth failure must not reschedule: fail returns rescheduled false");
  ctx.Equal(djScore(ctx, "j"), nullptr, "a dead job must not be in jobs:delayed");
  ctx.Equal(ctx.Redis.LRange("jobs:dead", 0, -1), std::vector<std::string>{"j"}, "jobs:dead");
  ctx.Equal(ctx.Redis.HGet("jobs:attempts", "j"), nullptr, "a dead job's attempt count is dropped");
  ctx.Equal(ctx.Redis.HGet("jobs:payload", "j"), "p", "a dead job's payload stays for inspection");
  const auto late = djJobs(pop_due(1000000000, 10));
  ctx.Assert(late.empty(), "a dead job never pops again, got %+v", late);
}

void CheckBackoffCap(harness::Ctx& ctx) {
  const std::vector<std::pair<int, long long>> cases{{1, 1000}, {2, 2000}, {3, 4000}, {4, 8000}, {5, 16000}, {6, 32000}, {7, 60000}, {8, 60000}, {12, 60000}};
  for (const auto& [attempt, want] : cases) {
    ctx.Equal(backoff_ms(attempt), want, "backoffMs(%d): baseMs * 2^(attempt - 1) capped at maxBackoffMs", attempt);
  }
  schedule("j", "p", 0);
  pop_due(0, 10);
  ctx.Equal(fail("j", 500000), 501000, "the first failure at 500000 ms must reschedule at 501000");
  pop_due(501000, 10);
  ctx.Equal(fail("j", 501000), 503000, "the second failure at 501000 ms must reschedule at 503000");
}

void CheckComplete(harness::Ctx& ctx) {
  schedule("a", "pa", 0);
  schedule("b", "pb", 5000);
  ctx.Equal(djIDs(pop_due(0, 10)), std::vector<std::string>{"a"}, "the jobs due at 0 ms");
  fail("a", 0);
  ctx.Equal(djIDs(pop_due(1000, 10)), std::vector<std::string>{"a"}, "the jobs due at 1000 ms");
  complete("a");
  ctx.Equal(ctx.Redis.HGet("jobs:payload", "a"), nullptr, "complete must delete the payload");
  ctx.Equal(ctx.Redis.HGet("jobs:attempts", "a"), nullptr, "complete must delete the attempt count");
  ctx.Equal(djScore(ctx, "a"), nullptr, "a completed job is not in jobs:delayed");
  bool dead = false;
  for (const auto& id : ctx.Redis.LRange("jobs:dead", 0, -1)) dead = dead || id == "a";
  ctx.Assert(!dead, "a completed job is not in jobs:dead");
  ctx.Assert(ctx.Redis.HGet("jobs:payload", "b") == "pb" && djScore(ctx, "b") == 5000.0, "completing a must leave b untouched");
  ctx.Equal(djIDs(pop_due(5000, 10)), std::vector<std::string>{"b"}, "the jobs due at 5000 ms");
  complete("b");
  const auto keys = ctx.Redis.Keys("*");
  ctx.Assert(keys.empty(), "after completing every job nothing remains, but Redis holds %q", keys);
}
`,
  },
  debrief: `The queue is three structures and one script. The sorted set is the index by time, so "what is due" is a range query, not a scan; the hashes keep the payload and the failure count out of the member name so a reschedule is a score update, not a rewrite. The script is the whole point: \`ZRANGEBYSCORE\` then \`ZREM\` from the client is two round trips with a window in between, and every worker that polls in that window runs the same job — the probe in the atomic-claim check lands exactly there. Inside Lua nothing interleaves, so a returned id is a claimed id. The backoff is deliberately plain — doubling from a base, capped, with a hard attempt limit that moves the job to a dead list instead of retrying forever. Real systems (Sidekiq, Celery's Redis broker, BullMQ) add jitter so a thundering herd of retries spreads out, a *processing* set with a visibility timeout so a worker that crashes mid-job is not a lost job, per-queue priorities, and \`SCRIPT LOAD\` + \`EVALSHA\` so the script text is not re-sent on every poll.`,
};
