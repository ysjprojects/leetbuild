import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis visibility timeout with atomic claim and return',
  concept: 'redis',
  guides: ['leases', 'atomic-state'],
  file: 'state',
  focus: ['api', 'redis', 'worker'],
  task: `## Task

**Starting point.** The starter is the Redis half of the queue. \`claim(worker)\` pops the next id
from \`jobs:queue\` with \`LPOP\`, then \`ZADD\`s it to \`jobs:inflight\` scored by its deadline (now plus
\`VISIBILITY_TIMEOUT_S\`, 60 s) and marks \`job:{id}\` running. \`return_expired()\` reads the expired
members with \`ZRANGEBYSCORE\`, then \`LPUSH\`es, re-marks and \`ZREM\`s each one. \`ack(job_id, worker)\`
is a Lua script that checks the worker and sets \`state = completed\`. It serves the demo and hides
three flaws.

**Failure mode the checks target.** A worker that dies between the pop and the in-flight write
loses the job with no trace; two reapers that see one expired claim both requeue it, so two
workers run it at once; a completed job comes back after its deadline and runs again.

- \`claim\` is one Lua script: \`LPOP\`, \`ZADD jobs:inflight <deadline> <id>\` and
  \`HSET job:{id} state running worker … deadline_ms …\`.
- \`return_expired\` is one script that requeues a member at the head of \`jobs:queue\` only when its
  \`ZREM\` returned 1, sets \`state = queued\` and clears \`worker\` and \`deadline_ms\`.
- \`ack\` also \`ZREM\`s the job from \`jobs:inflight\` and answers false when the claim is gone.`,
  sequence: {
    participants: ['Worker', 'Reaper', 'Redis'],
    messages: [
      {
        from: 'Worker',
        to: 'Redis',
        label: 'CLAIM: LPOP jobs:queue · ZADD jobs:inflight deadline · HSET running',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Worker', label: 'job id (or nil)', kind: 'reply'},
      {from: 'Worker', to: 'Redis', label: 'ACK: worker matches? ZREM jobs:inflight · state completed', kind: 'sync'},
      {
        from: 'Reaper',
        to: 'Redis',
        label: 'RETURN: ZRANGEBYSCORE -inf now · ZREM == 1 → LPUSH jobs:queue',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Reaper', label: 'the ids this reaper returned', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'claim-deadline',
      title: 'A claim scores the job by its visibility deadline',
      detail:
        'Claims hand out queued jobs in order; each claimed id is in `jobs:inflight` scored by now + 60 000 ms, and `job:{id}` is `running` with the worker and the same `deadline_ms`. An empty queue claims nothing.',
      match: {
        python: {all: [/VISIBILITY_TIMEOUT_S/, /jobs:inflight/]},
        typescript: {all: [/VISIBILITY_TIMEOUT_S/, /jobs:inflight/]},
        go: {all: [/visibilityTimeoutS/, /jobs:inflight/]},
        cpp: {all: [/kVisibilityTimeoutS/, /jobs:inflight/]},
      },
    },
    {
      id: 'atomic-claim',
      title: 'Pops and records the claim in one script',
      detail:
        'At every instant the claimed job is on `jobs:queue` or in `jobs:inflight`, and once it is in `jobs:inflight` its record says `running` with the worker: the check looks right after your first command on `jobs:queue`. The starter pops with a client `LPOP` and writes the claim afterwards, so in between the job is nowhere.',
      match: {
        python: {all: [/redis\.call\(\s*['"]LPOP['"]/, /register_script\(|\.eval\(/], none: [/\br\.lpop\(/]},
        typescript: {all: [/redis\.call\(\s*['"]LPOP['"]/, /defineCommand\(|\.eval\(/], none: [/redis\.lpop\(/]},
        go: {all: [/redis\.call\(\s*'LPOP'/, /redis\.NewScript\(/], none: [/\.LPop\(/]},
        cpp: {all: [/redis\.call\(\s*'LPOP'/, /redis\.eval</], none: [/redis\.lpop\(/]},
      },
    },
    {
      id: 'single-return',
      title: 'An expired claim is requeued once, guarded by its ZREM',
      detail:
        'A second reaper returns the same expired claim right after your first command on `jobs:inflight`; afterwards the job is on `jobs:queue` exactly once. On a later return the job is on one of the two structures after every command your reaper sends to `jobs:inflight`, goes back at the head of `jobs:queue`, and its record is `queued` with no `worker` or `deadline_ms`. The starter pushes every member it read, whether or not another reaper already took it.',
      match: {
        python: {all: [/redis\.call\(\s*['"]ZREM['"][^)]*\)\s*==\s*1/], none: [/\br\.lpush\(/]},
        typescript: {all: [/redis\.call\(\s*['"]ZREM['"][^)]*\)\s*==\s*1/], none: [/redis\.lpush\(/]},
        go: {all: [/redis\.call\(\s*'ZREM'[^)]*\)\s*==\s*1/], none: [/\.LPush\(/]},
        cpp: {all: [/redis\.call\(\s*'ZREM'[^)]*\)\s*==\s*1/], none: [/redis\.lpush\(/]},
      },
    },
    {
      id: 'ack-clears-claim',
      title: 'The ack removes the job from jobs:inflight',
      detail:
        'After an ack the job is `completed` and gone from `jobs:inflight`, so a reaper run after its deadline leaves it alone; an ack from a worker that does not hold the claim answers false. The starter only flips the state, and the finished job is requeued at its deadline.',
      match: {
        python: {all: [/ACK_LUA\s*=\s*"""(?:(?!""")[\s\S])*ZREM/]},
        typescript: {all: [/ACK_LUA\s*=\s*`[^`]*ZREM/]},
        go: {all: [/ackScript\s*=\s*redis\.NewScript\(`[^`]*ZREM/]},
        cpp: {all: [/kAckLua\s*=\s*R"lua\((?:(?!\)lua")[\s\S])*ZREM/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

QUEUE_KEY = "jobs:queue"
INFLIGHT_KEY = "jobs:inflight"
VISIBILITY_TIMEOUT_S = 60

ACK_LUA = """
if redis.call('HGET', KEYS[2], 'worker') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[2], 'state', 'completed')
return 1
"""

_ack = r.register_script(ACK_LUA)


def now_ms() -> int:
    return int(time.time() * 1000)


def claim(worker: str) -> str | None:
    """Move the next queued job into jobs:inflight under the visibility timeout; its id, or None."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    job_id = r.lpop(QUEUE_KEY)
    if job_id is None:
        return None
    deadline = now_ms() + VISIBILITY_TIMEOUT_S * 1000
    r.zadd(INFLIGHT_KEY, {job_id: deadline})
    r.hset(f"job:{job_id}", mapping={"state": "running", "worker": worker, "deadline_ms": deadline})
    return job_id


def ack(job_id: str, worker: str) -> bool:
    """Complete the job if worker still holds its claim; False when the claim is gone."""
    return _ack(keys=[INFLIGHT_KEY, f"job:{job_id}"], args=[worker, job_id]) == 1


def return_expired() -> list[str]:
    """Put every claim past its deadline back at the head of the queue; the ids returned."""
    expired = r.zrangebyscore(INFLIGHT_KEY, "-inf", now_ms())
    for job_id in expired:
        r.lpush(QUEUE_KEY, job_id)
        r.hset(f"job:{job_id}", "state", "queued")
        r.zrem(INFLIGHT_KEY, job_id)
    return expired
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

QUEUE_KEY = "jobs:queue"
INFLIGHT_KEY = "jobs:inflight"
VISIBILITY_TIMEOUT_S = 60

# Each script runs on the server with no other client in between: the job is always in exactly one
# of jobs:queue and jobs:inflight.
CLAIM_LUA = """
local job_id = redis.call('LPOP', KEYS[1])
if not job_id then return false end
redis.call('ZADD', KEYS[2], ARGV[1], job_id)
redis.call('HSET', 'job:' .. job_id, 'state', 'running', 'worker', ARGV[2], 'deadline_ms', ARGV[1])
return job_id
"""

ACK_LUA = """
if redis.call('HGET', KEYS[2], 'worker') ~= ARGV[1] then return 0 end
if redis.call('ZREM', KEYS[1], ARGV[2]) == 0 then return 0 end
redis.call('HSET', KEYS[2], 'state', 'completed')
redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms')
return 1
"""

RETURN_LUA = """
local returned = {}
for _, job_id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])) do
  if redis.call('ZREM', KEYS[1], job_id) == 1 then
    redis.call('LPUSH', KEYS[2], job_id)
    redis.call('HSET', 'job:' .. job_id, 'state', 'queued')
    redis.call('HDEL', 'job:' .. job_id, 'worker', 'deadline_ms')
    table.insert(returned, job_id)
  end
end
return returned
"""

_claim = r.register_script(CLAIM_LUA)
_ack = r.register_script(ACK_LUA)
_return = r.register_script(RETURN_LUA)


def now_ms() -> int:
    return int(time.time() * 1000)


def claim(worker: str) -> str | None:
    """Move the next queued job into jobs:inflight under the visibility timeout; its id, or None."""
    return _claim(keys=[QUEUE_KEY, INFLIGHT_KEY], args=[now_ms() + VISIBILITY_TIMEOUT_S * 1000, worker])


def ack(job_id: str, worker: str) -> bool:
    """Complete the job if worker still holds its claim; False when the claim is gone."""
    return _ack(keys=[INFLIGHT_KEY, f"job:{job_id}"], args=[worker, job_id]) == 1


def return_expired() -> list[str]:
    """Put every claim past its deadline back at the head of the queue; the ids returned."""
    return list(_return(keys=[INFLIGHT_KEY, QUEUE_KEY], args=[now_ms()]))
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

export const QUEUE_KEY = 'jobs:queue';
export const INFLIGHT_KEY = 'jobs:inflight';
export const VISIBILITY_TIMEOUT_S = 60;

export const ACK_LUA = \`
if redis.call('HGET', KEYS[2], 'worker') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[2], 'state', 'completed')
return 1
\`;

interface StateRedis extends Redis {
  ackJob(inflight: string, job: string, worker: string, jobId: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as StateRedis;
redis.defineCommand('ackJob', {numberOfKeys: 2, lua: ACK_LUA});

/** Move the next queued job into jobs:inflight under the visibility timeout; its id, or null. */
export async function claim(worker: string): Promise<string | null> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const jobId = await redis.lpop(QUEUE_KEY);
  if (jobId === null) return null;
  const deadline = Date.now() + VISIBILITY_TIMEOUT_S * 1000;
  await redis.zadd(INFLIGHT_KEY, deadline, jobId);
  await redis.hset(\`job:\${jobId}\`, {state: 'running', worker, deadline_ms: deadline});
  return jobId;
}

/** Complete the job if worker still holds its claim; false when the claim is gone. */
export async function ack(jobId: string, worker: string): Promise<boolean> {
  return (await redis.ackJob(INFLIGHT_KEY, \`job:\${jobId}\`, worker, jobId)) === 1;
}

/** Put every claim past its deadline back at the head of the queue; the ids returned. */
export async function returnExpired(): Promise<string[]> {
  const expired = await redis.zrangebyscore(INFLIGHT_KEY, '-inf', Date.now());
  for (const jobId of expired) {
    await redis.lpush(QUEUE_KEY, jobId);
    await redis.hset(\`job:\${jobId}\`, 'state', 'queued');
    await redis.zrem(INFLIGHT_KEY, jobId);
  }
  return expired;
}
`,
      solution: `import Redis from 'ioredis';

export const QUEUE_KEY = 'jobs:queue';
export const INFLIGHT_KEY = 'jobs:inflight';
export const VISIBILITY_TIMEOUT_S = 60;

// Each script runs on the server with no other client in between: the job is always in exactly one
// of jobs:queue and jobs:inflight.
export const CLAIM_LUA = \`
local job_id = redis.call('LPOP', KEYS[1])
if not job_id then return false end
redis.call('ZADD', KEYS[2], ARGV[1], job_id)
redis.call('HSET', 'job:' .. job_id, 'state', 'running', 'worker', ARGV[2], 'deadline_ms', ARGV[1])
return job_id
\`;

export const ACK_LUA = \`
if redis.call('HGET', KEYS[2], 'worker') ~= ARGV[1] then return 0 end
if redis.call('ZREM', KEYS[1], ARGV[2]) == 0 then return 0 end
redis.call('HSET', KEYS[2], 'state', 'completed')
redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms')
return 1
\`;

export const RETURN_LUA = \`
local returned = {}
for _, job_id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])) do
  if redis.call('ZREM', KEYS[1], job_id) == 1 then
    redis.call('LPUSH', KEYS[2], job_id)
    redis.call('HSET', 'job:' .. job_id, 'state', 'queued')
    redis.call('HDEL', 'job:' .. job_id, 'worker', 'deadline_ms')
    table.insert(returned, job_id)
  end
end
return returned
\`;

interface StateRedis extends Redis {
  claimJob(queue: string, inflight: string, deadlineMs: number, worker: string): Promise<string | null>;
  ackJob(inflight: string, job: string, worker: string, jobId: string): Promise<number>;
  returnJobs(inflight: string, queue: string, nowMs: number): Promise<string[]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as StateRedis;
redis.defineCommand('claimJob', {numberOfKeys: 2, lua: CLAIM_LUA});
redis.defineCommand('ackJob', {numberOfKeys: 2, lua: ACK_LUA});
redis.defineCommand('returnJobs', {numberOfKeys: 2, lua: RETURN_LUA});

/** Move the next queued job into jobs:inflight under the visibility timeout; its id, or null. */
export async function claim(worker: string): Promise<string | null> {
  return redis.claimJob(QUEUE_KEY, INFLIGHT_KEY, Date.now() + VISIBILITY_TIMEOUT_S * 1000, worker);
}

/** Complete the job if worker still holds its claim; false when the claim is gone. */
export async function ack(jobId: string, worker: string): Promise<boolean> {
  return (await redis.ackJob(INFLIGHT_KEY, \`job:\${jobId}\`, worker, jobId)) === 1;
}

/** Put every claim past its deadline back at the head of the queue; the ids returned. */
export async function returnExpired(): Promise<string[]> {
  return redis.returnJobs(INFLIGHT_KEY, QUEUE_KEY, Date.now());
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

const (
	queueKey           = "jobs:queue"
	inflightKey        = "jobs:inflight"
	visibilityTimeoutS = 60
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var ackScript = redis.NewScript(\`
if redis.call('HGET', KEYS[2], 'worker') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[2], 'state', 'completed')
return 1
\`)

// claim moves the next queued job into jobs:inflight under the visibility timeout; its id, or "".
func claim(ctx context.Context, worker string) (string, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	jobID, err := rdb.LPop(ctx, queueKey).Result()
	if err == redis.Nil {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	deadline := time.Now().Add(visibilityTimeoutS * time.Second).UnixMilli()
	rdb.ZAdd(ctx, inflightKey, redis.Z{Score: float64(deadline), Member: jobID})
	rdb.HSet(ctx, "job:"+jobID, "state", "running", "worker", worker, "deadline_ms", deadline)
	return jobID, nil
}

// ack completes the job if worker still holds its claim; false when the claim is gone.
func ack(ctx context.Context, jobID, worker string) (bool, error) {
	n, err := ackScript.Run(ctx, rdb, []string{inflightKey, "job:" + jobID}, worker, jobID).Int64()
	return n == 1, err
}

// returnExpired puts every claim past its deadline back at the head of the queue; the ids returned.
func returnExpired(ctx context.Context) ([]string, error) {
	now := strconv.FormatInt(time.Now().UnixMilli(), 10)
	expired, err := rdb.ZRangeByScore(ctx, inflightKey, &redis.ZRangeBy{Min: "-inf", Max: now}).Result()
	if err != nil {
		return nil, err
	}
	for _, jobID := range expired {
		rdb.LPush(ctx, queueKey, jobID)
		rdb.HSet(ctx, "job:"+jobID, "state", "queued")
		rdb.ZRem(ctx, inflightKey, jobID)
	}
	return expired, nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	queueKey           = "jobs:queue"
	inflightKey        = "jobs:inflight"
	visibilityTimeoutS = 60
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Each script runs on the server with no other client in between: the job is always in exactly one
// of jobs:queue and jobs:inflight.
var claimScript = redis.NewScript(\`
local job_id = redis.call('LPOP', KEYS[1])
if not job_id then return false end
redis.call('ZADD', KEYS[2], ARGV[1], job_id)
redis.call('HSET', 'job:' .. job_id, 'state', 'running', 'worker', ARGV[2], 'deadline_ms', ARGV[1])
return job_id
\`)

var ackScript = redis.NewScript(\`
if redis.call('HGET', KEYS[2], 'worker') ~= ARGV[1] then return 0 end
if redis.call('ZREM', KEYS[1], ARGV[2]) == 0 then return 0 end
redis.call('HSET', KEYS[2], 'state', 'completed')
redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms')
return 1
\`)

var returnScript = redis.NewScript(\`
local returned = {}
for _, job_id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])) do
  if redis.call('ZREM', KEYS[1], job_id) == 1 then
    redis.call('LPUSH', KEYS[2], job_id)
    redis.call('HSET', 'job:' .. job_id, 'state', 'queued')
    redis.call('HDEL', 'job:' .. job_id, 'worker', 'deadline_ms')
    table.insert(returned, job_id)
  end
end
return returned
\`)

// claim moves the next queued job into jobs:inflight under the visibility timeout; its id, or "".
func claim(ctx context.Context, worker string) (string, error) {
	deadline := time.Now().Add(visibilityTimeoutS * time.Second).UnixMilli()
	jobID, err := claimScript.Run(ctx, rdb, []string{queueKey, inflightKey}, deadline, worker).Text()
	if err == redis.Nil {
		return "", nil
	}
	return jobID, err
}

// ack completes the job if worker still holds its claim; false when the claim is gone.
func ack(ctx context.Context, jobID, worker string) (bool, error) {
	n, err := ackScript.Run(ctx, rdb, []string{inflightKey, "job:" + jobID}, worker, jobID).Int64()
	return n == 1, err
}

// returnExpired puts every claim past its deadline back at the head of the queue; the ids returned.
func returnExpired(ctx context.Context) ([]string, error) {
	return returnScript.Run(ctx, rdb, []string{inflightKey, queueKey}, time.Now().UnixMilli()).StringSlice()
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <optional>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

const std::string kQueueKey = "jobs:queue";
const std::string kInflightKey = "jobs:inflight";
constexpr long long kVisibilityTimeoutS = 60;

const std::string kAckLua = R"lua(
if redis.call('HGET', KEYS[2], 'worker') ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[2], 'state', 'completed')
return 1
)lua";

long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Move the next queued job into jobs:inflight under the visibility timeout; its id, if one was queued.
std::optional<std::string> claim(const std::string& worker) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const auto job_id = redis.lpop(kQueueKey);
  if (!job_id) return std::nullopt;
  const long long deadline = nowMs() + kVisibilityTimeoutS * 1000;
  redis.zadd(kInflightKey, *job_id, static_cast<double>(deadline));
  redis.hset("job:" + *job_id, {{"state", "running"}, {"worker", worker}, {"deadline_ms", std::to_string(deadline)}});
  return *job_id;
}

// Complete the job if worker still holds its claim; false when the claim is gone.
bool ack(const std::string& job_id, const std::string& worker) {
  return redis.eval<long long>(kAckLua, {kInflightKey, "job:" + job_id}, {worker, job_id}) == 1;
}

// Put every claim past its deadline back at the head of the queue; the ids returned.
std::vector<std::string> returnExpired() {
  std::vector<std::string> expired;
  redis.zrangebyscore(kInflightKey, sw::redis::RightBoundedInterval<double>(static_cast<double>(nowMs()), sw::redis::BoundType::CLOSED),
                      std::back_inserter(expired));
  for (const std::string& job_id : expired) {
    redis.lpush(kQueueKey, job_id);
    redis.hset("job:" + job_id, "state", "queued");
    redis.zrem(kInflightKey, job_id);
  }
  return expired;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

const std::string kQueueKey = "jobs:queue";
const std::string kInflightKey = "jobs:inflight";
constexpr long long kVisibilityTimeoutS = 60;

// Each script runs on the server with no other client in between: the job is always in exactly one
// of jobs:queue and jobs:inflight.
const std::string kClaimLua = R"lua(
local job_id = redis.call('LPOP', KEYS[1])
if not job_id then return false end
redis.call('ZADD', KEYS[2], ARGV[1], job_id)
redis.call('HSET', 'job:' .. job_id, 'state', 'running', 'worker', ARGV[2], 'deadline_ms', ARGV[1])
return job_id
)lua";

const std::string kAckLua = R"lua(
if redis.call('HGET', KEYS[2], 'worker') ~= ARGV[1] then return 0 end
if redis.call('ZREM', KEYS[1], ARGV[2]) == 0 then return 0 end
redis.call('HSET', KEYS[2], 'state', 'completed')
redis.call('HDEL', KEYS[2], 'worker', 'deadline_ms')
return 1
)lua";

const std::string kReturnLua = R"lua(
local returned = {}
for _, job_id in ipairs(redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])) do
  if redis.call('ZREM', KEYS[1], job_id) == 1 then
    redis.call('LPUSH', KEYS[2], job_id)
    redis.call('HSET', 'job:' .. job_id, 'state', 'queued')
    redis.call('HDEL', 'job:' .. job_id, 'worker', 'deadline_ms')
    table.insert(returned, job_id)
  end
end
return returned
)lua";

long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Move the next queued job into jobs:inflight under the visibility timeout; its id, if one was queued.
std::optional<std::string> claim(const std::string& worker) {
  const std::string deadline = std::to_string(nowMs() + kVisibilityTimeoutS * 1000);
  const auto job_id = redis.eval<sw::redis::OptionalString>(kClaimLua, {kQueueKey, kInflightKey}, {deadline, worker});
  if (!job_id) return std::nullopt;
  return *job_id;
}

// Complete the job if worker still holds its claim; false when the claim is gone.
bool ack(const std::string& job_id, const std::string& worker) {
  return redis.eval<long long>(kAckLua, {kInflightKey, "job:" + job_id}, {worker, job_id}) == 1;
}

// Put every claim past its deadline back at the head of the queue; the ids returned.
std::vector<std::string> returnExpired() {
  return redis.eval<std::vector<std::string>>(kReturnLua, {kInflightKey, kQueueKey}, {std::to_string(nowMs())});
}
`,
    },
  },
  harness: {
    python: `import time

from jobs import store

PAYLOAD = {"to": "ada@example.com", "template": "welcome"}


def _job(n):
    job_id = f"job-{n}"
    store.create_job(job_id, "t-1", "email.send", PAYLOAD)
    return job_id


def _where(ctx, job_id):
    places = []
    if job_id in ctx.redis.lrange("jobs:queue", 0, -1):
        places.append("jobs:queue")
    if ctx.redis.zscore("jobs:inflight", job_id) is not None:
        places.append("jobs:inflight")
    return places


def check_claim_deadline(ctx):
    m = ctx.load("state")
    a, b = _job(1), _job(2)
    assert m.claim("w-1") == a, f"the first claim must hand out {a}, the head of jobs:queue"
    deadline = int(time.time() * 1000) + 60000
    score = ctx.redis.zscore("jobs:inflight", a)
    assert score == deadline, f"{a} is in jobs:inflight with score {score}, expected its deadline {deadline} (now + VISIBILITY_TIMEOUT_S in ms)"
    job = store.get_job(a)
    assert job["state"] == "running" and job["worker"] == "w-1" and job["deadline_ms"] == deadline, f"job:{a} after the claim is {job}"
    assert m.claim("w-2") == b, f"the second claim must hand out {b}"
    assert m.claim("w-3") is None, "a claim on an empty queue must return None"


def check_atomic_claim(ctx):
    m = ctx.load("state")
    a = _job(1)
    probe = ctx.redis_after("jobs:queue", lambda: (_where(ctx, a), store.get_job(a)))
    assert m.claim("w-1") == a, f"the claim must hand out {a}"
    assert probe.fired, "claim never touched jobs:queue"
    places, job = probe.result
    assert places, f"right after your first command on jobs:queue, {a} was on neither jobs:queue nor jobs:inflight: a worker that dies there loses the job with no trace. Pop and record the claim in one script"
    if places == ["jobs:inflight"]:
        assert job["state"] == "running" and job["worker"] == "w-1", f"right after your first command on jobs:queue, {a} was in jobs:inflight but job:{a} was {job}: a worker that dies there leaves a claimed job the record calls queued. Write the record in the claim's script"
    assert _where(ctx, a) == ["jobs:inflight"], f"after the claim {a} is in {_where(ctx, a)}, expected jobs:inflight only"


def check_single_return(ctx):
    m = ctx.load("state")
    a = _job(1)
    assert m.claim("w-1") == a
    ctx.clock.advance(61)

    def other_reaper():
        if ctx.redis.zrem("jobs:inflight", a) == 1:
            ctx.redis.lpush("jobs:queue", a)
            ctx.redis.hset(f"job:{a}", "state", "queued")
            ctx.redis.hdel(f"job:{a}", "worker", "deadline_ms")

    probe = ctx.redis_after("jobs:inflight", other_reaper)
    m.return_expired()
    assert probe.fired, "return_expired never touched jobs:inflight"
    copies = ctx.redis.lrange("jobs:queue", 0, -1).count(a)
    assert copies == 1, f"two reapers returned one expired claim and jobs:queue now holds {a} {copies} times: two workers will run it at once. Requeue a member only when your ZREM removed it"
    assert m.claim("w-2") == a, f"the returned job must be claimable again"
    b = _job(2)
    ctx.clock.advance(61)
    seen = []
    watching = [True]

    def watch():
        # Where the job is right after each of the reaper's commands on jobs:inflight.
        if watching[0]:
            seen.append(_where(ctx, a))
            ctx.redis_after("jobs:inflight", watch)

    ctx.redis_after("jobs:inflight", watch)
    returned = m.return_expired()
    watching[0] = False
    assert returned == [a], f"one expired claim must be returned once, got {returned}"
    assert [] not in seen, f"right after one of your commands on jobs:inflight, {a} was on neither jobs:queue nor jobs:inflight (places seen {seen}): a reaper that dies there loses the job. Remove and requeue in one script"
    assert ctx.redis.lrange("jobs:queue", 0, -1) == [a, b], f"jobs:queue after the return is {ctx.redis.lrange('jobs:queue', 0, -1)}: an expired claim goes back at the head, ahead of {b}"
    assert m.return_expired() == [], "a second pass must find nothing to return"
    job = store.get_job(a)
    assert job["state"] == "queued" and job["worker"] is None and job["deadline_ms"] is None, f"a returned job must be queued with no worker and no deadline_ms, got {job}"


def check_ack_clears_claim(ctx):
    m = ctx.load("state")
    a = _job(1)
    assert m.claim("w-1") == a
    assert m.ack(a, "w-2") is False, "an ack from a worker that does not hold the claim must return False"
    assert m.ack(a, "w-1") is True, "the ack of the worker holding the claim must return True"
    assert store.get_job(a)["state"] == "completed", f"job:{a} after the ack is {store.get_job(a)}"
    score = ctx.redis.zscore("jobs:inflight", a)
    assert score is None, f"after the ack {a} is still in jobs:inflight (score {score}): the reaper will return a finished job at its deadline"
    ctx.clock.advance(61)
    m.return_expired()
    assert a not in ctx.redis.lrange("jobs:queue", 0, -1), f"the completed job {a} was put back on jobs:queue and will run again"
`,
    typescript: `const PAYLOAD = {to: 'ada@example.com', template: 'welcome'};

async function setup(ctx) {
  return {m: ctx.load('state'), store: ctx.load('/support/jobs/store.ts')};
}

async function job(store, n: number): Promise<string> {
  const jobId = \`job-\${n}\`;
  await store.createJob(jobId, 't-1', 'email.send', PAYLOAD);
  return jobId;
}

function where(ctx, jobId: string): string[] {
  const places: string[] = [];
  if (ctx.redis.lrange('jobs:queue', 0, -1).includes(jobId)) places.push('jobs:queue');
  if (ctx.redis.zscore('jobs:inflight', jobId) !== null) places.push('jobs:inflight');
  return places;
}

export async function check_claim_deadline(ctx) {
  const {m, store} = await setup(ctx);
  const a = await job(store, 1);
  const b = await job(store, 2);
  assert.equal(await m.claim('w-1'), a, \`the first claim must hand out \${a}, the head of jobs:queue\`);
  const deadline = Date.now() + 60000;
  const score = Number(ctx.redis.zscore('jobs:inflight', a));
  assert.equal(score, deadline, \`\${a} is in jobs:inflight with score \${score}, expected its deadline \${deadline} (now + VISIBILITY_TIMEOUT_S in ms)\`);
  const record = await store.getJob(a);
  assert(record.state === 'running' && record.worker === 'w-1' && record.deadline_ms === deadline, \`job:\${a} after the claim is \${JSON.stringify(record)}\`);
  assert.equal(await m.claim('w-2'), b, \`the second claim must hand out \${b}\`);
  assert.equal(await m.claim('w-3'), null, 'a claim on an empty queue must return null');
}

export async function check_atomic_claim(ctx) {
  const {m, store} = await setup(ctx);
  const a = await job(store, 1);
  const probe = ctx.redisAfter('jobs:queue', () => ({places: where(ctx, a), record: ctx.redis.hgetall(\`job:\${a}\`)}));
  assert.equal(await m.claim('w-1'), a, \`the claim must hand out \${a}\`);
  assert(probe.fired, 'claim never touched jobs:queue');
  const {places, record} = probe.result;
  assert(places.length > 0, \`right after your first command on jobs:queue, \${a} was on neither jobs:queue nor jobs:inflight: a worker that dies there loses the job with no trace. Pop and record the claim in one script\`);
  if (places.length === 1 && places[0] === 'jobs:inflight') {
    assert(record.state === 'running' && record.worker === 'w-1', \`right after your first command on jobs:queue, \${a} was in jobs:inflight but job:\${a} was \${JSON.stringify(record)}: a worker that dies there leaves a claimed job the record calls queued. Write the record in the claim's script\`);
  }
  assert.deepEqual(where(ctx, a), ['jobs:inflight'], \`after the claim \${a} is in \${JSON.stringify(where(ctx, a))}, expected jobs:inflight only\`);
}

export async function check_single_return(ctx) {
  const {m, store} = await setup(ctx);
  const a = await job(store, 1);
  assert.equal(await m.claim('w-1'), a);
  ctx.clock.advance(61);
  const probe = ctx.redisAfter('jobs:inflight', () => {
    if (ctx.redis.zrem('jobs:inflight', a) === 1) {
      ctx.redis.lpush('jobs:queue', a);
      ctx.redis.hset(\`job:\${a}\`, 'state', 'queued');
      ctx.redis.hdel(\`job:\${a}\`, 'worker', 'deadline_ms');
    }
  });
  await m.returnExpired();
  assert(probe.fired, 'returnExpired never touched jobs:inflight');
  const copies = ctx.redis.lrange('jobs:queue', 0, -1).filter(id => id === a).length;
  assert.equal(copies, 1, \`two reapers returned one expired claim and jobs:queue now holds \${a} \${copies} times: two workers will run it at once. Requeue a member only when your ZREM removed it\`);
  assert.equal(await m.claim('w-2'), a, 'the returned job must be claimable again');
  const b = await job(store, 2);
  ctx.clock.advance(61);
  const seen: string[][] = [];
  let watching = true;
  const watch = () => {
    // Where the job is right after each of the reaper's commands on jobs:inflight.
    if (!watching) return;
    seen.push(where(ctx, a));
    ctx.redisAfter('jobs:inflight', watch);
  };
  ctx.redisAfter('jobs:inflight', watch);
  const returned = await m.returnExpired();
  watching = false;
  assert.deepEqual(returned, [a], \`one expired claim must be returned once, got \${JSON.stringify(returned)}\`);
  assert(seen.every(places => places.length > 0), \`right after one of your commands on jobs:inflight, \${a} was on neither jobs:queue nor jobs:inflight (places seen \${JSON.stringify(seen)}): a reaper that dies there loses the job. Remove and requeue in one script\`);
  assert.deepEqual(ctx.redis.lrange('jobs:queue', 0, -1), [a, b], \`jobs:queue after the return is \${JSON.stringify(ctx.redis.lrange('jobs:queue', 0, -1))}: an expired claim goes back at the head, ahead of \${b}\`);
  assert.deepEqual(await m.returnExpired(), [], 'a second pass must find nothing to return');
  const record = await store.getJob(a);
  assert(record.state === 'queued' && record.worker === null && record.deadline_ms === null, \`a returned job must be queued with no worker and no deadline_ms, got \${JSON.stringify(record)}\`);
}

export async function check_ack_clears_claim(ctx) {
  const {m, store} = await setup(ctx);
  const a = await job(store, 1);
  assert.equal(await m.claim('w-1'), a);
  assert.equal(await m.ack(a, 'w-2'), false, 'an ack from a worker that does not hold the claim must return false');
  assert.equal(await m.ack(a, 'w-1'), true, 'the ack of the worker holding the claim must return true');
  assert.equal((await store.getJob(a)).state, 'completed', \`job:\${a} after the ack must be completed\`);
  const score = ctx.redis.zscore('jobs:inflight', a);
  assert.equal(score, null, \`after the ack \${a} is still in jobs:inflight (score \${score}): the reaper will return a finished job at its deadline\`);
  ctx.clock.advance(61);
  await m.returnExpired();
  assert(!ctx.redis.lrange('jobs:queue', 0, -1).includes(a), \`the completed job \${a} was put back on jobs:queue and will run again\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"

	"jobs/store"

	"leetbuild/harness"
)

var hStateBg = context.Background()

func hStateJob(ctx *harness.Ctx, n int) string {
	jobID := fmt.Sprintf("job-%d", n)
	ctx.NoError(store.CreateJob(hStateBg, jobID, "t-1", "email.send", map[string]any{"to": "ada@example.com", "template": "welcome"}), "CreateJob")
	return jobID
}

func hStateWhere(ctx *harness.Ctx, jobID string) []string {
	places := []string{}
	for _, id := range ctx.Redis.LRange("jobs:queue", 0, -1) {
		if id == jobID {
			places = append(places, "jobs:queue")
			break
		}
	}
	if _, ok := ctx.Redis.ZScore("jobs:inflight", jobID); ok {
		places = append(places, "jobs:inflight")
	}
	return places
}

func hStateClaim(ctx *harness.Ctx, worker string) string {
	jobID, err := claim(hStateBg, worker)
	ctx.NoError(err, "claim(%s)", worker)
	return jobID
}

func hStateCopies(ctx *harness.Ctx, jobID string) int {
	n := 0
	for _, id := range ctx.Redis.LRange("jobs:queue", 0, -1) {
		if id == jobID {
			n++
		}
	}
	return n
}

func CheckClaimDeadline(ctx *harness.Ctx) {
	a, b := hStateJob(ctx, 1), hStateJob(ctx, 2)
	ctx.Equal(hStateClaim(ctx, "w-1"), a, "the first claim must hand out the head of jobs:queue")
	deadline := ctx.Clock.Now() + 60000
	score, ok := ctx.Redis.ZScore("jobs:inflight", a)
	ctx.Assert(ok && int64(score) == deadline, "%s is in jobs:inflight with score %v, expected its deadline %d (now + visibilityTimeoutS in ms)", a, score, deadline)
	job := store.GetJob(hStateBg, a)
	ctx.Assert(job.State == "running" && job.Worker == "w-1" && job.DeadlineMs == deadline, "job:%s after the claim is %+v", a, job)
	ctx.Equal(hStateClaim(ctx, "w-2"), b, "the second claim")
	ctx.Equal(hStateClaim(ctx, "w-3"), "", "a claim on an empty queue must return \\"\\"; the claim")
}

func CheckAtomicClaim(ctx *harness.Ctx) {
	a := hStateJob(ctx, 1)
	var record map[string]string
	probe := ctx.Redis.After("jobs:queue", func() any {
		record = ctx.Redis.HGetAll("job:" + a)
		return hStateWhere(ctx, a)
	})
	ctx.Equal(hStateClaim(ctx, "w-1"), a, "the claim")
	ctx.Assert(probe.Fired, "claim never touched jobs:queue")
	places, _ := probe.Result.([]string)
	ctx.Assert(len(places) > 0, "right after your first command on jobs:queue, %s was on neither jobs:queue nor jobs:inflight: a worker that dies there loses the job with no trace. Pop and record the claim in one script", a)
	if len(places) == 1 && places[0] == "jobs:inflight" {
		ctx.Assert(record["state"] == "running" && record["worker"] == "w-1", "right after your first command on jobs:queue, %s was in jobs:inflight but job:%s was %v: a worker that dies there leaves a claimed job the record calls queued. Write the record in the claim's script", a, a, record)
	}
	ctx.Equal(hStateWhere(ctx, a), []string{"jobs:inflight"}, "where the job is after the claim")
}

func CheckSingleReturn(ctx *harness.Ctx) {
	a := hStateJob(ctx, 1)
	ctx.Equal(hStateClaim(ctx, "w-1"), a, "the claim")
	ctx.Clock.Advance(61)
	probe := ctx.Redis.After("jobs:inflight", func() any {
		if ctx.Redis.Do("ZREM", "jobs:inflight", a).(int64) == 1 {
			ctx.Redis.Do("LPUSH", "jobs:queue", a)
			ctx.Redis.Do("HSET", "job:"+a, "state", "queued")
			ctx.Redis.Do("HDEL", "job:"+a, "worker", "deadline_ms")
		}
		return nil
	})
	_, err := returnExpired(hStateBg)
	ctx.NoError(err, "returnExpired")
	ctx.Assert(probe.Fired, "returnExpired never touched jobs:inflight")
	copies := hStateCopies(ctx, a)
	ctx.Assert(copies == 1, "two reapers returned one expired claim and jobs:queue now holds %s %d times: two workers will run it at once. Requeue a member only when your ZREM removed it", a, copies)
	ctx.Equal(hStateClaim(ctx, "w-2"), a, "the returned job must be claimable again; the claim")
	b := hStateJob(ctx, 2)
	ctx.Clock.Advance(61)
	var seen [][]string
	watching := true
	var watch func() any
	watch = func() any {
		// Where the job is right after each of the reaper's commands on jobs:inflight.
		if watching {
			seen = append(seen, hStateWhere(ctx, a))
			ctx.Redis.After("jobs:inflight", watch)
		}
		return nil
	}
	ctx.Redis.After("jobs:inflight", watch)
	first, _ := returnExpired(hStateBg)
	watching = false
	ctx.Equal(first, []string{a}, "one expired claim must be returned once")
	lost := false
	for _, places := range seen {
		lost = lost || len(places) == 0
	}
	ctx.Assert(!lost, "right after one of your commands on jobs:inflight, %s was on neither jobs:queue nor jobs:inflight (places seen %v): a reaper that dies there loses the job. Remove and requeue in one script", a, seen)
	ctx.Equal(ctx.Redis.LRange("jobs:queue", 0, -1), []string{a, b}, "an expired claim goes back at the head, ahead of "+b+"; jobs:queue after the return")
	second, _ := returnExpired(hStateBg)
	ctx.Equal(len(second), 0, "a second pass must find nothing to return; returned")
	job := store.GetJob(hStateBg, a)
	ctx.Assert(job.State == "queued" && job.Worker == "" && job.DeadlineMs == 0, "a returned job must be queued with no worker and no deadline_ms, got %+v", job)
}

func CheckAckClearsClaim(ctx *harness.Ctx) {
	a := hStateJob(ctx, 1)
	ctx.Equal(hStateClaim(ctx, "w-1"), a, "the claim")
	wrong, err := ack(hStateBg, a, "w-2")
	ctx.NoError(err, "ack")
	ctx.Equal(wrong, false, "an ack from a worker that does not hold the claim")
	right, err := ack(hStateBg, a, "w-1")
	ctx.NoError(err, "ack")
	ctx.Equal(right, true, "the ack of the worker holding the claim")
	ctx.Equal(store.GetJob(hStateBg, a).State, "completed", "the job's state after the ack")
	score, ok := ctx.Redis.ZScore("jobs:inflight", a)
	ctx.Assert(!ok, "after the ack %s is still in jobs:inflight (score %v): the reaper will return a finished job at its deadline", a, score)
	ctx.Clock.Advance(61)
	returnExpired(hStateBg)
	ctx.Equal(hStateCopies(ctx, a), 0, "the completed job was put back on jobs:queue and will run again; its copies on the queue")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <functional>
#include <map>
#include <string>
#include <vector>

#include "jobs/store.h"

namespace {

std::string hStateJob(int n) {
  const std::string job_id = "job-" + std::to_string(n);
  store::createJob(job_id, "t-1", "email.send", nlohmann::json{{"to", "ada@example.com"}, {"template", "welcome"}});
  return job_id;
}

std::vector<std::string> hStateWhere(harness::Ctx& ctx, const std::string& job_id) {
  std::vector<std::string> places;
  const auto queued = ctx.Redis.LRange("jobs:queue", 0, -1);
  if (std::find(queued.begin(), queued.end(), job_id) != queued.end()) places.push_back("jobs:queue");
  if (ctx.Redis.ZScore("jobs:inflight", job_id)) places.push_back("jobs:inflight");
  return places;
}

long hStateCopies(harness::Ctx& ctx, const std::string& job_id) {
  const auto queued = ctx.Redis.LRange("jobs:queue", 0, -1);
  return static_cast<long>(std::count(queued.begin(), queued.end(), job_id));
}

}  // namespace

void CheckClaimDeadline(harness::Ctx& ctx) {
  const std::string a = hStateJob(1);
  const std::string b = hStateJob(2);
  ctx.Equal(claim("w-1").value_or(""), a, "the first claim must hand out the head of jobs:queue");
  const long long deadline = ctx.Clock.Now() + 60000;
  const auto score = ctx.Redis.ZScore("jobs:inflight", a);
  ctx.Assert(score && static_cast<long long>(*score) == deadline, "%s is in jobs:inflight with score %v, expected its deadline %d (now + kVisibilityTimeoutS in ms)", a, score.value_or(0), deadline);
  const auto job = store::getJob(a);
  ctx.Assert(job && job->state == "running" && job->worker == "w-1" && job->deadline_ms == deadline, "job:%s after the claim is %s by %s until %d", a, job ? job->state : "", job ? job->worker : "", job ? job->deadline_ms : 0);
  ctx.Equal(claim("w-2").value_or(""), b, "the second claim");
  ctx.Assert(!claim("w-3"), "a claim on an empty queue must return nothing");
}

void CheckAtomicClaim(harness::Ctx& ctx) {
  const std::string a = hStateJob(1);
  bool fired = false;
  std::vector<std::string> places;
  std::map<std::string, std::string> record;
  ctx.Redis.After("jobs:queue", [&] {
    fired = true;
    places = hStateWhere(ctx, a);
    record = ctx.Redis.HGetAll("job:" + a);
  });
  ctx.Equal(claim("w-1").value_or(""), a, "the claim");
  ctx.Assert(fired, "claim never touched jobs:queue");
  ctx.Assert(!places.empty(), "right after your first command on jobs:queue, %s was on neither jobs:queue nor jobs:inflight: a worker that dies there loses the job with no trace. Pop and record the claim in one script", a);
  if (places == std::vector<std::string>{"jobs:inflight"}) {
    ctx.Assert(record["state"] == "running" && record["worker"] == "w-1", "right after your first command on jobs:queue, %s was in jobs:inflight but job:%s was %s by '%s': a worker that dies there leaves a claimed job the record calls queued. Write the record in the claim's script", a, a, record["state"], record["worker"]);
  }
  ctx.Equal(hStateWhere(ctx, a), std::vector<std::string>{"jobs:inflight"}, "where the job is after the claim");
}

void CheckSingleReturn(harness::Ctx& ctx) {
  const std::string a = hStateJob(1);
  ctx.Equal(claim("w-1").value_or(""), a, "the claim");
  ctx.Clock.Advance(61);
  bool fired = false;
  ctx.Redis.After("jobs:inflight", [&] {
    fired = true;
    if (ctx.Redis.Do("ZREM", "jobs:inflight", a).Int() == 1) {
      ctx.Redis.Do("LPUSH", "jobs:queue", a);
      ctx.Redis.Do("HSET", "job:" + a, "state", "queued");
      ctx.Redis.Do("HDEL", "job:" + a, "worker", "deadline_ms");
    }
  });
  returnExpired();
  ctx.Assert(fired, "returnExpired never touched jobs:inflight");
  const long copies = hStateCopies(ctx, a);
  ctx.Assert(copies == 1, "two reapers returned one expired claim and jobs:queue now holds %s %d times: two workers will run it at once. Requeue a member only when your ZREM removed it", a, copies);
  ctx.Equal(claim("w-2").value_or(""), a, "the returned job must be claimable again; the claim");
  const std::string b = hStateJob(2);
  ctx.Clock.Advance(61);
  std::vector<std::vector<std::string>> seen;
  bool watching = true;
  std::function<void()> watch = [&] {
    // Where the job is right after each of the reaper's commands on jobs:inflight.
    if (!watching) return;
    seen.push_back(hStateWhere(ctx, a));
    ctx.Redis.After("jobs:inflight", watch);
  };
  ctx.Redis.After("jobs:inflight", watch);
  const auto returned = returnExpired();
  watching = false;
  ctx.Equal(returned, std::vector<std::string>{a}, "one expired claim must be returned once");
  std::string trail;
  bool lost = false;
  for (const auto& places : seen) {
    lost = lost || places.empty();
    trail += places.empty() ? " nowhere" : " " + places.front();
  }
  ctx.Assert(!lost, "right after one of your commands on jobs:inflight, %s was on neither jobs:queue nor jobs:inflight (places seen:%s): a reaper that dies there loses the job. Remove and requeue in one script", a, trail);
  ctx.Equal(ctx.Redis.LRange("jobs:queue", 0, -1), std::vector<std::string>{a, b}, "an expired claim goes back at the head, ahead of " + b + "; jobs:queue after the return");
  ctx.Equal(returnExpired().size(), 0, "a second pass must find nothing to return; returned");
  const auto job = store::getJob(a);
  ctx.Assert(job && job->state == "queued" && job->worker.empty() && job->deadline_ms == 0, "a returned job must be queued with no worker and no deadline_ms, got %s by '%s' until %d", job ? job->state : "", job ? job->worker : "", job ? job->deadline_ms : 0);
}

void CheckAckClearsClaim(harness::Ctx& ctx) {
  const std::string a = hStateJob(1);
  ctx.Equal(claim("w-1").value_or(""), a, "the claim");
  ctx.Equal(ack(a, "w-2"), false, "an ack from a worker that does not hold the claim");
  ctx.Equal(ack(a, "w-1"), true, "the ack of the worker holding the claim");
  ctx.Equal(store::getJob(a)->state, "completed", "the job's state after the ack");
  const auto score = ctx.Redis.ZScore("jobs:inflight", a);
  ctx.Assert(!score, "after the ack %s is still in jobs:inflight (score %v): the reaper will return a finished job at its deadline", a, score.value_or(0));
  ctx.Clock.Advance(61);
  returnExpired();
  ctx.Equal(hStateCopies(ctx, a), 0, "the completed job was put back on jobs:queue and will run again; its copies on the queue");
}
`,
  },
  hints: [
    'Run two reapers against one expired claim: the job id lands on `jobs:queue` twice. Ack a job, wait past its deadline and run the reaper: the finished job is queued again.',
    'Each function sends several commands, and another client can act between any two. The pop leaves the job in neither structure until the `ZADD` lands; the reaper pushes without checking that its own `ZREM` won; the ack script never touches `jobs:inflight`.',
    "Move the claim and the return into Lua scripts (`register_script`): `LPOP`, `ZADD` and `HSET` in one; `if redis.call('ZREM', …) == 1 then LPUSH …` in the other. Add `ZREM jobs:inflight` to `ACK_LUA` and return 0 when it removed nothing.",
  ],
  debrief: `Every function here moves a job between two structures, and the only way to make such a move indivisible in Redis is to run it on the server as one script: no other client runs between its commands, so the job is always in exactly one of \`jobs:queue\` and \`jobs:inflight\`. The \`ZREM\` result is the reaper's ticket: of two reapers that see one expired claim, one removes it and the other gets 0. The ack's \`ZREM\` is what ends the claim; the state field only describes it. Production queues add a heartbeat that extends a long job's deadline, as SQS's \`ChangeMessageVisibility\` does, and count deliveries so a job that keeps timing out reaches the dead letter.`,
};
