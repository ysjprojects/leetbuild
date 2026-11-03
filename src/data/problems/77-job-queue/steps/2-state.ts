import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis visibility timeout with atomic claim return',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'worker'],
  task: `## Task

**Starting point.** The starter is the Redis half of \`jobqd\`: \`enqueue\` writes the job hash and
\`LPUSH\`es \`jobs:queue\`; \`claim\` \`LPOP\`s the queue, then \`ZADD\`s \`jobs:inflight\` and writes the
state and deadline in separate commands; \`return_expired\` \`LPUSH\`es every member it reads in the
expiry window; \`ack\` flips the hash state. It serves the demo (one worker, one healthy job) and
hides four flaws.

**Failure mode the checks target.** A worker killed between the pop and the in-flight write leaves
the job in no list and no set. Two reaper passes both requeue the same expired member, so one job
runs on two workers at once. A completed job stays in \`jobs:inflight\` and the reaper runs it again.

- One job, one position, one deadline: the list \`jobs:queue\`, the sorted set \`jobs:inflight\`
  scored by \`now_ms + VISIBILITY_TIMEOUT_S * 1000\` (\`VISIBILITY_TIMEOUT_S = 60\`), and the hash
  \`jobs:job:{job_id}\` holding \`state\`, \`type\`, \`attempts\`, \`enqueued_at_ms\`,
  \`claim_deadline_ms\` and \`worker\`.
- The claim is one \`EVAL\`: \`CLAIM_SCRIPT\` \`LPOP\`s the queue, \`ZADD\`s the job into
  \`jobs:inflight\` with the deadline as its score and writes \`state = in_flight\` with the same
  \`claim_deadline_ms\` into the hash. No client-side \`lpop\` remains.
- The return is a compare-and-move: \`RETURN_SCRIPT\` reads \`ZRANGEBYSCORE jobs:inflight 0 <now_ms>\`
  and, per member, \`ZREM\`s it and only \`LPUSH\`es it back when that \`ZREM\` returned \`1\`, setting
  the hash to \`state = queued\`.
- The ack clears the claim with the state: \`ACK_SCRIPT\` \`ZREM\`s the in-flight member and writes
  \`state = completed\`, clearing \`worker\` and \`claim_deadline_ms\`.`,
  sequence: {
    participants: ['Job API', 'Redis', 'Worker', 'Queue reaper'],
    messages: [
      {
        from: 'Job API',
        to: 'Redis',
        label: 'LPUSH jobs:queue job_7f3a · HSET jobs:job:job_7f3a state queued',
        kind: 'sync',
      },
      {
        from: 'Redis',
        to: 'Job API',
        label: 'job_7f3a on jobs:queue · state queued · enqueued_at_ms set',
        kind: 'reply',
      },
      {
        from: 'Worker',
        to: 'Redis',
        label: 'EVAL CLAIM_SCRIPT · LPOP jobs:queue · ZADD jobs:inflight 1700003660000 job_7f3a',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Worker', label: 'job_7f3a · deadline 1700003660000 · state in_flight', kind: 'reply'},
      {from: 'Worker', to: 'Worker', label: 'run the job, then ack it', kind: 'sync'},
      {
        from: 'Worker',
        to: 'Redis',
        label: 'EVAL ACK_SCRIPT · ZREM jobs:inflight job_7f3a · state completed',
        kind: 'async',
      },
      {
        from: 'Queue reaper',
        to: 'Redis',
        label: 'EVAL RETURN_SCRIPT · ZRANGEBYSCORE jobs:inflight 0 now_ms',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Queue reaper', label: 'ZREM returned 1 · stalled job back on jobs:queue', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'queue-keys',
      title: 'Names the queue, the in-flight set, the job hash and the visibility timeout',
      detail:
        'The job waits in the list `jobs:queue`, a claim is the member `job_id` of the sorted set `jobs:inflight` scored by its visibility deadline in milliseconds, and `state`, `type`, `attempts`, `enqueued_at_ms`, `claim_deadline_ms` and `worker` live in the hash `jobs:job:{job_id}` under `VISIBILITY_TIMEOUT_S` (`60 s`). A job that is not in one of those two structures at every instant is a job the queue has lost track of.',
      match: {
        python: {all: [/jobs:queue/, /jobs:inflight/, /jobs:job:/, /VISIBILITY_TIMEOUT_S/]},
        typescript: {all: [/jobs:queue/, /jobs:inflight/, /jobs:job:/, /VISIBILITY_TIMEOUT_S/]},
        go: {all: [/jobs:queue/, /jobs:inflight/, /jobs:job:/, /visibilityTimeoutS/]},
        scala: {all: [/jobs:queue/, /jobs:inflight/, /jobs:job:/, /VisibilityTimeoutS/]},
        cpp: {all: [/jobs:queue/, /jobs:inflight/, /jobs:job:/, /kVisibilityTimeoutS/]},
      },
    },
    {
      id: 'atomic-claim',
      title: 'Claims the job in one Lua EVAL with the deadline as the in-flight score',
      detail:
        '`CLAIM_SCRIPT` runs through one `EVAL`: it `LPOP`s `jobs:queue`, `ZADD`s the popped job into `jobs:inflight` scored by `now_ms + VISIBILITY_TIMEOUT_S * 1000` and writes the same `claim_deadline_ms` into `jobs:job:{job_id}`, so the pop and the in-flight write are one operation. The starter `LPOP`s first and writes the score, the state and the deadline in separate commands afterwards, so a crash between them leaves the job in neither structure — lost with no trace and nothing for a reaper to find.',
      match: {
        python: {all: [/CLAIM_SCRIPT/, /\.eval\(\s*CLAIM_SCRIPT/, /LPOP/, /ZADD/, /claim_deadline_ms/]},
        typescript: {all: [/CLAIM_SCRIPT/, /\.eval\(\s*CLAIM_SCRIPT/, /LPOP/, /ZADD/, /claim_deadline_ms/]},
        go: {all: [/claimScript/, /NewScript\(/, /\.Run\(/, /LPOP/, /ZADD/, /claim_deadline_ms/]},
        scala: {all: [/ClaimLua/, /\.eval\(\s*ClaimLua/, /LPOP/, /ZADD/, /claim_deadline_ms/]},
        cpp: {all: [/kClaimLua/, /eval<[^>]*>\(\s*kClaimLua/, /LPOP/, /ZADD/, /claim_deadline_ms/]},
      },
    },
    {
      id: 'atomic-return',
      title: 'An expired claim returns the job exactly once, guarded by the ZREM result',
      detail:
        '`RETURN_SCRIPT` reads the expired window with `ZRANGEBYSCORE jobs:inflight 0 <now_ms>` and, inside the same script, removes each member with `ZREM` and only `LPUSH`es it back onto `jobs:queue` when that `ZREM` returned `1`, setting the hash back to `state = queued`. The claim’s own removal is the guard. The starter reads the expired window and then `LPUSH`es every member it saw, so two reaper passes both requeue the same job and two workers claim it concurrently — the same side effect run twice.',
      match: {
        python: {
          all: [/RETURN_SCRIPT/, /\.eval\(\s*RETURN_SCRIPT/, /ZRANGEBYSCORE/, /ZREM/, /LPUSH/, /['"]queued['"]/],
          order: [/ZREM/, /LPUSH/],
        },
        typescript: {
          all: [/RETURN_SCRIPT/, /\.eval\(\s*RETURN_SCRIPT/, /ZRANGEBYSCORE/, /ZREM/, /LPUSH/, /['"]queued['"]/],
          order: [/ZREM/, /LPUSH/],
        },
        go: {
          all: [/returnScript/, /NewScript\(/, /\.Run\(/, /ZRANGEBYSCORE/, /ZREM/, /LPUSH/, /['"]queued['"]/],
          order: [/ZREM/, /LPUSH/],
        },
        scala: {
          all: [/ReturnLua/, /\.eval\(\s*ReturnLua/, /ZRANGEBYSCORE/, /ZREM/, /LPUSH/, /['"]queued['"]/],
          order: [/ZREM/, /LPUSH/],
        },
        cpp: {
          all: [/kReturnLua/, /eval<[^>]*>\(\s*kReturnLua/, /ZRANGEBYSCORE/, /ZREM/, /LPUSH/, /['"]queued['"]/],
          order: [/ZREM/, /LPUSH/],
        },
      },
    },
    {
      id: 'ack-clears-claim',
      title: 'The ack removes the in-flight member in the same script as the state write',
      detail:
        '`ACK_SCRIPT` `ZREM`s `jobs:inflight` for the finished job and writes `state = completed` while clearing `worker` and `claim_deadline_ms`, so the in-flight set holds only claims that are still alive. The starter’s ack only flips the hash state: the completed job stays in `jobs:inflight`, its deadline eventually expires, and the next reaper pass returns a job that already ran to the queue — a phantom entry that becomes a second execution.',
      match: {
        python: {all: [/ACK_SCRIPT/, /\.eval\(\s*ACK_SCRIPT/, /ZREM/, /['"]completed['"]/, /claim_deadline_ms/]},
        typescript: {all: [/ACK_SCRIPT/, /\.eval\(\s*ACK_SCRIPT/, /ZREM/, /['"]completed['"]/, /claim_deadline_ms/]},
        go: {all: [/ackScript/, /NewScript\(/, /\.Run\(/, /ZREM/, /['"]completed['"]/, /claim_deadline_ms/]},
        scala: {all: [/AckLua/, /\.eval\(\s*AckLua/, /ZREM/, /['"]completed['"]/, /claim_deadline_ms/]},
        cpp: {all: [/kAckLua/, /eval<[^>]*>\(\s*kAckLua/, /ZREM/, /['"]completed['"]/, /claim_deadline_ms/]},
      },
    },
    {
      id: 'no-unscripted-pop',
      title: 'The queue pop happens only inside the claim script',
      detail:
        "No client-side `LPOP` remains anywhere: the only pop in the file is `redis.call('LPOP', …)` inside `CLAIM_SCRIPT`, which is what makes the move atomic. A bare client pop is the two-command claim by definition — the job has already left `jobs:queue` while the deadline, the state and the in-flight entry are still unwritten.",
      match: {
        python: {all: [/jobs:queue/, /LPOP/], none: [/\.lpop\(/]},
        typescript: {all: [/jobs:queue/, /LPOP/], none: [/\.lpop\(/]},
        go: {all: [/jobs:queue/, /LPOP/], none: [/\.LPop\(/]},
        scala: {all: [/jobs:queue/, /LPOP/], none: [/\.lpop\(/]},
        cpp: {all: [/jobs:queue/, /LPOP/], none: [/\.lpop\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import redis as redis_client

logger = logging.getLogger("jobqd")

VISIBILITY_TIMEOUT_S = 60
QUEUE_KEY = "jobs:queue"
INFLIGHT_KEY = "jobs:inflight"


def job_key(job_id: str) -> str:
    return f"jobs:job:{job_id}"


class JobQueue:
    """The Redis half of jobqd: a first version that pops the job and then calls it claimed."""

    def __init__(self, redis: "redis_client.Redis") -> None:
        self.redis = redis

    def enqueue(self, job_id: str, job_type: str, now_ms: int) -> None:
        self.redis.hset(
            job_key(job_id),
            mapping={"state": "queued", "type": job_type, "attempts": 0, "enqueued_at_ms": now_ms},
        )
        self.redis.lpush(QUEUE_KEY, job_id)
        logger.info("job enqueued job_id=%s type=%s", job_id, job_type)

    def claim(self, worker: str, now_ms: int) -> str | None:
        # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        popped = self.redis.lpop(QUEUE_KEY)
        if popped is None:
            return None
        job_id = popped.decode() if isinstance(popped, bytes) else str(popped)
        deadline = now_ms + VISIBILITY_TIMEOUT_S * 1000
        self.redis.zadd(INFLIGHT_KEY, {job_id: deadline})
        self.redis.hset(
            job_key(job_id),
            mapping={"state": "in_flight", "worker": worker, "claim_deadline_ms": deadline},
        )
        logger.info("job claimed job_id=%s worker=%s", job_id, worker)
        return job_id

    def return_expired(self, now_ms: int) -> int:
        returned = 0
        for raw in self.redis.zrangebyscore(INFLIGHT_KEY, 0, now_ms):
            job_id = raw.decode() if isinstance(raw, bytes) else str(raw)
            self.redis.lpush(QUEUE_KEY, job_id)
            self.redis.hset(job_key(job_id), mapping={"state": "queued"})
            self.redis.zrem(INFLIGHT_KEY, job_id)
            returned += 1
        return returned

    def ack(self, job_id: str) -> None:
        self.redis.hset(job_key(job_id), mapping={"state": "completed"})
        logger.info("job completed job_id=%s", job_id)
`,
      solution: `import logging

import redis as redis_client

logger = logging.getLogger("jobqd")

VISIBILITY_TIMEOUT_S = 60
QUEUE_KEY = "jobs:queue"
INFLIGHT_KEY = "jobs:inflight"

# The claim is one step, because the queue and the in-flight set are two views of the same job and a
# crash must not be able to fall between them: the pop and the deadline-scored in-flight entry happen
# inside one script, so a worker either owns the job with a visible deadline or never touched it.
CLAIM_SCRIPT = """
local job_id = redis.call('LPOP', KEYS[1])
if not job_id then
  return false
end
local deadline = tonumber(ARGV[1])
redis.call('ZADD', KEYS[2], deadline, job_id)
redis.call('HSET', 'jobs:job:' .. job_id, 'state', 'in_flight', 'worker', ARGV[2],
           'claim_deadline_ms', deadline)
return job_id
"""

# The return is a compare-and-move: the ZREM is the check that the claim still exists, and Redis runs
# one script without interleaving, so an expired job goes back to the queue exactly once and a job
# whose worker is slow but alive is never in the queue and in flight at the same time.
RETURN_SCRIPT = """
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1])
local returned = 0
for _, job_id in ipairs(expired) do
  if redis.call('ZREM', KEYS[1], job_id) == 1 then
    redis.call('LPUSH', KEYS[2], job_id)
    redis.call('HSET', 'jobs:job:' .. job_id, 'state', 'queued', 'worker', '')
    returned = returned + 1
  end
end
return returned
"""

# The ack clears the claim in the same script that writes the terminal state, so the in-flight set
# never keeps a phantom entry the reaper could return to the queue.
ACK_SCRIPT = """
local removed = redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2], 'state', 'completed', 'claim_deadline_ms', 0, 'worker', '')
return removed
"""


def job_key(job_id: str) -> str:
    return f"jobs:job:{job_id}"


class JobQueue:
    """One job in the queue, one claim in flight, one return when the claim expires."""

    def __init__(self, redis: "redis_client.Redis") -> None:
        self.redis = redis

    def enqueue(self, job_id: str, job_type: str, now_ms: int) -> None:
        self.redis.hset(
            job_key(job_id),
            mapping={
                "state": "queued",
                "type": job_type,
                "attempts": 0,
                "enqueued_at_ms": now_ms,
                "claim_deadline_ms": 0,
                "worker": "",
            },
        )
        self.redis.lpush(QUEUE_KEY, job_id)
        logger.info("job enqueued job_id=%s type=%s", job_id, job_type)

    def claim(self, worker: str, now_ms: int) -> str | None:
        deadline = now_ms + VISIBILITY_TIMEOUT_S * 1000
        claimed = self.redis.eval(CLAIM_SCRIPT, 2, QUEUE_KEY, INFLIGHT_KEY, deadline, worker)
        if claimed is None:
            return None
        job_id = claimed.decode() if isinstance(claimed, bytes) else str(claimed)
        logger.info("job claimed job_id=%s worker=%s deadline_ms=%d", job_id, worker, deadline)
        return job_id

    def return_expired(self, now_ms: int) -> int:
        returned = int(self.redis.eval(RETURN_SCRIPT, 2, INFLIGHT_KEY, QUEUE_KEY, now_ms))
        if returned > 0:
            logger.info("stalled claims returned returned=%s now_ms=%s", returned, now_ms)
        return returned

    def ack(self, job_id: str) -> bool:
        removed = self.redis.eval(ACK_SCRIPT, 2, INFLIGHT_KEY, job_key(job_id), job_id)
        return int(removed) == 1
`,
    },
    typescript: {
      starter: `/** The Redis half of jobqd: flawed code that pops the job and calls it claimed. */
import {Redis} from 'ioredis';

export const r = new Redis('redis://redis:6379');

const VISIBILITY_TIMEOUT_S = 60;
const QUEUE_KEY = 'jobs:queue';
const INFLIGHT_KEY = 'jobs:inflight';

export const jobKey = (jobId: string): string => \`jobs:job:\${jobId}\`;

export async function enqueue(jobId: string, jobType: string, nowMs: number): Promise<void> {
  await r.hset(jobKey(jobId), {
    state: 'queued',
    type: jobType,
    attempts: '0',
    enqueued_at_ms: String(nowMs),
  });
  await r.lpush(QUEUE_KEY, jobId);
}

export async function claim(worker: string, nowMs: number): Promise<string | null> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const popped = await r.lpop(QUEUE_KEY);
  if (popped === null) return null;
  const deadline = nowMs + VISIBILITY_TIMEOUT_S * 1000;
  await r.zadd(INFLIGHT_KEY, deadline, popped);
  await r.hset(jobKey(popped), {
    state: 'in_flight',
    worker,
    claim_deadline_ms: String(deadline),
  });
  return popped;
}

export async function returnExpired(nowMs: number): Promise<number> {
  const expired = await r.zrangebyscore(INFLIGHT_KEY, 0, nowMs);
  for (const jobId of expired) {
    await r.lpush(QUEUE_KEY, jobId);
    await r.hset(jobKey(jobId), {state: 'queued'});
    await r.zrem(INFLIGHT_KEY, jobId);
  }
  return expired.length;
}

export async function ack(jobId: string): Promise<void> {
  await r.hset(jobKey(jobId), {state: 'completed'});
}
`,
      solution: `/** The Redis half of jobqd: one atomic claim under a visibility timeout, one idempotent return. */
import {Redis} from 'ioredis';

const VISIBILITY_TIMEOUT_S = 60;
const QUEUE_KEY = 'jobs:queue';
const INFLIGHT_KEY = 'jobs:inflight';

// The claim is one step, because the queue and the in-flight set are two views of the same job and a
// crash must not be able to fall between them: the pop and the deadline-scored in-flight entry happen
// inside one script, so a worker either owns the job with a visible deadline or never touched it.
const CLAIM_SCRIPT = \`
local job_id = redis.call('LPOP', KEYS[1])
if not job_id then
  return false
end
local deadline = tonumber(ARGV[1])
redis.call('ZADD', KEYS[2], deadline, job_id)
redis.call('HSET', 'jobs:job:' .. job_id, 'state', 'in_flight', 'worker', ARGV[2],
           'claim_deadline_ms', deadline)
return job_id
\`;

// The return is a compare-and-move: the ZREM is the check that the claim still exists, and one script
// runs without interleaving, so an expired job goes back to the queue exactly once and a job whose
// worker is slow but alive is never in the queue and in flight at the same time.
const RETURN_SCRIPT = \`
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1])
local returned = 0
for _, job_id in ipairs(expired) do
  if redis.call('ZREM', KEYS[1], job_id) == 1 then
    redis.call('LPUSH', KEYS[2], job_id)
    redis.call('HSET', 'jobs:job:' .. job_id, 'state', 'queued', 'worker', '')
    returned = returned + 1
  end
end
return returned
\`;

// The ack clears the claim in the same script that writes the terminal state, so the in-flight set
// never keeps a phantom entry the reaper could return to the queue.
const ACK_SCRIPT = \`
local removed = redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2], 'state', 'completed', 'claim_deadline_ms', 0, 'worker', '')
return removed
\`;

export const jobKey = (jobId: string): string => \`jobs:job:\${jobId}\`;

export async function enqueue(redis: Redis, jobId: string, jobType: string, nowMs: number): Promise<void> {
  await redis.hset(jobKey(jobId), {
    state: 'queued',
    type: jobType,
    attempts: '0',
    enqueued_at_ms: String(nowMs),
    claim_deadline_ms: '0',
    worker: '',
  });
  await redis.lpush(QUEUE_KEY, jobId);
}

export async function claim(redis: Redis, worker: string, nowMs: number): Promise<string | null> {
  const deadline = nowMs + VISIBILITY_TIMEOUT_S * 1000;
  const claimed = (await redis.eval(CLAIM_SCRIPT, 2, QUEUE_KEY, INFLIGHT_KEY, deadline, worker)) as string | null;
  return claimed ?? null;
}

export async function returnExpired(redis: Redis, nowMs: number): Promise<number> {
  return Number(await redis.eval(RETURN_SCRIPT, 2, INFLIGHT_KEY, QUEUE_KEY, nowMs));
}

export async function ack(redis: Redis, jobId: string): Promise<boolean> {
  const removed = (await redis.eval(ACK_SCRIPT, 2, INFLIGHT_KEY, jobKey(jobId), jobId)) as number;
  return Number(removed) === 1;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"
)

const (
	visibilityTimeoutS int64 = 60
	queueKey                 = "jobs:queue"
	inflightKey              = "jobs:inflight"
)

func jobKey(jobID string) string { return "jobs:job:" + jobID }

func enqueue(ctx context.Context, rdb *redis.Client, jobID, jobType string, nowMS int64) error {
	if err := rdb.HSet(ctx, jobKey(jobID), "state", "queued", "type", jobType,
		"attempts", 0, "enqueued_at_ms", nowMS).Err(); err != nil {
		return err
	}
	return rdb.LPush(ctx, queueKey, jobID).Err()
}

// claim is the starter's two-command move: the pop and the in-flight write are separate round trips.
// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
func claim(ctx context.Context, rdb *redis.Client, worker string, nowMS int64) (string, error) {
	jobID, err := rdb.LPop(ctx, queueKey).Result()
	if err != nil || jobID == "" {
		return "", err
	}
	deadline := nowMS + visibilityTimeoutS*1000
	if err := rdb.ZAdd(ctx, inflightKey, redis.Z{Score: float64(deadline), Member: jobID}).Err(); err != nil {
		return "", err
	}
	if err := rdb.HSet(ctx, jobKey(jobID), "state", "in_flight", "worker", worker,
		"claim_deadline_ms", deadline).Err(); err != nil {
		return "", err
	}
	return jobID, nil
}

func returnExpired(ctx context.Context, rdb *redis.Client, nowMS int64) (int64, error) {
	expired, err := rdb.ZRangeByScore(ctx, inflightKey, &redis.ZRangeBy{
		Min: "0",
		Max: strconv.FormatInt(nowMS, 10),
	}).Result()
	if err != nil {
		return 0, err
	}
	var returned int64
	for _, jobID := range expired {
		if err := rdb.LPush(ctx, queueKey, jobID).Err(); err != nil {
			return returned, err
		}
		if err := rdb.HSet(ctx, jobKey(jobID), "state", "queued").Err(); err != nil {
			return returned, err
		}
		rdb.ZRem(ctx, inflightKey, jobID)
		returned++
	}
	return returned, nil
}

func ack(ctx context.Context, rdb *redis.Client, jobID string) error {
	return rdb.HSet(ctx, jobKey(jobID), "state", "completed").Err()
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

const (
	visibilityTimeoutS int64 = 60
	queueKey                 = "jobs:queue"
	inflightKey              = "jobs:inflight"
)

// The claim is one step, because the queue and the in-flight set are two views of the same job and a
// crash must not be able to fall between them: the pop and the deadline-scored in-flight entry happen
// inside one script, so a worker either owns the job with a visible deadline or never touched it.
var claimScript = redis.NewScript(\`
local job_id = redis.call('LPOP', KEYS[1])
if not job_id then
  return false
end
local deadline = tonumber(ARGV[1])
redis.call('ZADD', KEYS[2], deadline, job_id)
redis.call('HSET', 'jobs:job:' .. job_id, 'state', 'in_flight', 'worker', ARGV[2],
           'claim_deadline_ms', deadline)
return job_id
\`)

// The return is a compare-and-move: the ZREM is the check that the claim still exists, and one script
// runs without interleaving, so an expired job goes back to the queue exactly once and a job whose
// worker is slow but alive is never in the queue and in flight at the same time.
var returnScript = redis.NewScript(\`
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1])
local returned = 0
for _, job_id in ipairs(expired) do
  if redis.call('ZREM', KEYS[1], job_id) == 1 then
    redis.call('LPUSH', KEYS[2], job_id)
    redis.call('HSET', 'jobs:job:' .. job_id, 'state', 'queued', 'worker', '')
    returned = returned + 1
  end
end
return returned
\`)

// The ack clears the claim in the same script that writes the terminal state, so the in-flight set
// never keeps a phantom entry the reaper could return to the queue.
var ackScript = redis.NewScript(\`
local removed = redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2], 'state', 'completed', 'claim_deadline_ms', 0, 'worker', '')
return removed
\`)

func jobKey(jobID string) string { return "jobs:job:" + jobID }

func enqueue(ctx context.Context, rdb *redis.Client, jobID, jobType string, nowMS int64) error {
	if err := rdb.HSet(ctx, jobKey(jobID), "state", "queued", "type", jobType, "attempts", 0,
		"enqueued_at_ms", nowMS, "claim_deadline_ms", 0, "worker", "").Err(); err != nil {
		return err
	}
	return rdb.LPush(ctx, queueKey, jobID).Err()
}

func claim(ctx context.Context, rdb *redis.Client, worker string, nowMS int64) (string, error) {
	deadline := nowMS + visibilityTimeoutS*1000
	return claimScript.Run(ctx, rdb, []string{queueKey, inflightKey}, deadline, worker).Text()
}

func returnExpired(ctx context.Context, rdb *redis.Client, nowMS int64) (int64, error) {
	return returnScript.Run(ctx, rdb, []string{inflightKey, queueKey}, nowMS).Int64()
}

func ack(ctx context.Context, rdb *redis.Client, jobID string) (bool, error) {
	removed, err := ackScript.Run(ctx, rdb, []string{inflightKey, jobKey(jobID)}, jobID).Int()
	if err != nil {
		return false, err
	}
	return removed == 1, nil
}
`,
    },
    scala: {
      starter: `import scala.jdk.CollectionConverters._

import redis.clients.jedis.Jedis

object JobQueue {
  val VisibilityTimeoutS: Long = 60
  val QueueKey: String = "jobs:queue"
  val InflightKey: String = "jobs:inflight"

  val jedis = new Jedis("redis", 6379)

  def jobKey(jobId: String): String = s"jobs:job:$jobId"

  def enqueue(jobId: String, jobType: String, nowMs: Long): Unit = {
    jedis.hset(
      jobKey(jobId),
      Map(
        "state" -> "queued",
        "type" -> jobType,
        "attempts" -> "0",
        "enqueued_at_ms" -> nowMs.toString,
      ).asJava,
    )
    jedis.lpush(QueueKey, jobId)
  }

  def claim(worker: String, nowMs: Long): Option[String] = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    Option(jedis.lpop(QueueKey)).map { jobId =>
      val deadline = nowMs + VisibilityTimeoutS * 1000
      jedis.zadd(InflightKey, deadline.toDouble, jobId)
      jedis.hset(
        jobKey(jobId),
        Map("state" -> "in_flight", "worker" -> worker, "claim_deadline_ms" -> deadline.toString).asJava,
      )
      jobId
    }
  }

  def returnExpired(nowMs: Long): Long = {
    val expired = jedis.zrangeByScore(InflightKey, 0, nowMs).asScala
    expired.foreach { jobId =>
      jedis.lpush(QueueKey, jobId)
      jedis.hset(jobKey(jobId), Map("state" -> "queued").asJava)
      jedis.zrem(InflightKey, jobId)
    }
    expired.size.toLong
  }

  def ack(jobId: String): Unit = {
    jedis.hset(jobKey(jobId), Map("state" -> "completed").asJava)
  }
}
`,
      solution: `import scala.jdk.CollectionConverters._

import redis.clients.jedis.Jedis

object JobQueue {
  val VisibilityTimeoutS: Long = 60
  val QueueKey: String = "jobs:queue"
  val InflightKey: String = "jobs:inflight"

  // The claim is one step, because the queue and the in-flight set are two views of the same job and
  // a crash must not be able to fall between them: the pop and the deadline-scored in-flight entry
  // happen inside one script, so a worker either owns the job with a visible deadline or never
  // touched it.
  val ClaimLua: String =
    """
local job_id = redis.call('LPOP', KEYS[1])
if not job_id then
  return false
end
local deadline = tonumber(ARGV[1])
redis.call('ZADD', KEYS[2], deadline, job_id)
redis.call('HSET', 'jobs:job:' .. job_id, 'state', 'in_flight', 'worker', ARGV[2],
           'claim_deadline_ms', deadline)
return job_id
"""

  // The return is a compare-and-move: the ZREM is the check that the claim still exists, and one
  // script runs without interleaving, so an expired job goes back to the queue exactly once and a job
  // whose worker is slow but alive is never in the queue and in flight at the same time.
  val ReturnLua: String =
    """
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1])
local returned = 0
for _, job_id in ipairs(expired) do
  if redis.call('ZREM', KEYS[1], job_id) == 1 then
    redis.call('LPUSH', KEYS[2], job_id)
    redis.call('HSET', 'jobs:job:' .. job_id, 'state', 'queued', 'worker', '')
    returned = returned + 1
  end
end
return returned
"""

  // The ack clears the claim in the same script that writes the terminal state, so the in-flight set
  // never keeps a phantom entry the reaper could return to the queue.
  val AckLua: String =
    """
local removed = redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2], 'state', 'completed', 'claim_deadline_ms', 0, 'worker', '')
return removed
"""

  def jobKey(jobId: String): String = s"jobs:job:$jobId"

  def enqueue(jedis: Jedis, jobId: String, jobType: String, nowMs: Long): Unit = {
    jedis.hset(
      jobKey(jobId),
      Map(
        "state" -> "queued",
        "type" -> jobType,
        "attempts" -> "0",
        "enqueued_at_ms" -> nowMs.toString,
        "claim_deadline_ms" -> "0",
        "worker" -> "",
      ).asJava,
    )
    jedis.lpush(QueueKey, jobId)
  }

  def claim(jedis: Jedis, worker: String, nowMs: Long): Option[String] = {
    val deadline = nowMs + VisibilityTimeoutS * 1000
    val claimed = jedis.eval(
      ClaimLua,
      2,
      QueueKey,
      InflightKey,
      deadline.toString,
      worker,
    )
    Option(claimed).map(_.toString)
  }

  def returnExpired(jedis: Jedis, nowMs: Long): Long = {
    jedis
      .eval(ReturnLua, 2, InflightKey, QueueKey, nowMs.toString)
      .asInstanceOf[java.lang.Long]
      .longValue()
  }

  def ack(jedis: Jedis, jobId: String): Boolean = {
    val removed = jedis
      .eval(AckLua, 2, InflightKey, jobKey(jobId), jobId)
      .asInstanceOf[java.lang.Long]
    removed.longValue() == 1L
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <vector>

constexpr long long kVisibilityTimeoutS = 60;
const std::string kQueueKey = "jobs:queue";
const std::string kInflightKey = "jobs:inflight";

std::string jobKey(const std::string& jobId) { return "jobs:job:" + jobId; }

void enqueue(sw::redis::Redis& redis, const std::string& jobId, const std::string& jobType, long long nowMs) {
  redis.hset(jobKey(jobId), "state", "queued");
  redis.hset(jobKey(jobId), "type", jobType);
  redis.hset(jobKey(jobId), "attempts", "0");
  redis.hset(jobKey(jobId), "enqueued_at_ms", std::to_string(nowMs));
  redis.lpush(kQueueKey, jobId);
}

std::optional<std::string> claim(sw::redis::Redis& redis, const std::string& worker, long long nowMs) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  auto popped = redis.lpop(kQueueKey);
  if (!popped) return std::nullopt;
  const std::string jobId = *popped;
  const long long deadline = nowMs + kVisibilityTimeoutS * 1000;
  redis.zadd(kInflightKey, jobId, static_cast<double>(deadline));
  redis.hset(jobKey(jobId), "state", "in_flight");
  redis.hset(jobKey(jobId), "worker", worker);
  redis.hset(jobKey(jobId), "claim_deadline_ms", std::to_string(deadline));
  return jobId;
}

long long returnExpired(sw::redis::Redis& redis, long long nowMs) {
  const auto expired = redis.zrangebyscore(kInflightKey, "0", std::to_string(nowMs));
  for (const auto& jobId : expired) {
    redis.lpush(kQueueKey, jobId);
    redis.hset(jobKey(jobId), "state", "queued");
    redis.zrem(kInflightKey, jobId);
  }
  return static_cast<long long>(expired.size());
}

void ack(sw::redis::Redis& redis, const std::string& jobId) {
  redis.hset(jobKey(jobId), "state", "completed");
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <vector>

constexpr long long kVisibilityTimeoutS = 60;
const std::string kQueueKey = "jobs:queue";
const std::string kInflightKey = "jobs:inflight";

// The claim is one step, because the queue and the in-flight set are two views of the same job and a
// crash must not be able to fall between them: the pop and the deadline-scored in-flight entry happen
// inside one script, so a worker either owns the job with a visible deadline or never touched it.
const std::string kClaimLua = R"lua(
local job_id = redis.call('LPOP', KEYS[1])
if not job_id then
  return false
end
local deadline = tonumber(ARGV[1])
redis.call('ZADD', KEYS[2], deadline, job_id)
redis.call('HSET', 'jobs:job:' .. job_id, 'state', 'in_flight', 'worker', ARGV[2],
           'claim_deadline_ms', deadline)
return job_id
)lua";

// The return is a compare-and-move: the ZREM is the check that the claim still exists, and one script
// runs without interleaving, so an expired job goes back to the queue exactly once and a job whose
// worker is slow but alive is never in the queue and in flight at the same time.
const std::string kReturnLua = R"lua(
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1])
local returned = 0
for _, job_id in ipairs(expired) do
  if redis.call('ZREM', KEYS[1], job_id) == 1 then
    redis.call('LPUSH', KEYS[2], job_id)
    redis.call('HSET', 'jobs:job:' .. job_id, 'state', 'queued', 'worker', '')
    returned = returned + 1
  end
end
return returned
)lua";

// The ack clears the claim in the same script that writes the terminal state, so the in-flight set
// never keeps a phantom entry the reaper could return to the queue.
const std::string kAckLua = R"lua(
local removed = redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2], 'state', 'completed', 'claim_deadline_ms', 0, 'worker', '')
return removed
)lua";

std::string jobKey(const std::string& jobId) { return "jobs:job:" + jobId; }

void enqueue(sw::redis::Redis& redis, const std::string& jobId, const std::string& jobType, long long nowMs) {
  redis.hset(jobKey(jobId), "state", "queued");
  redis.hset(jobKey(jobId), "type", jobType);
  redis.hset(jobKey(jobId), "attempts", "0");
  redis.hset(jobKey(jobId), "enqueued_at_ms", std::to_string(nowMs));
  redis.hset(jobKey(jobId), "claim_deadline_ms", "0");
  redis.hset(jobKey(jobId), "worker", "");
  redis.lpush(kQueueKey, jobId);
}

std::optional<std::string> claim(sw::redis::Redis& redis, const std::string& worker, long long nowMs) {
  const long long deadline = nowMs + kVisibilityTimeoutS * 1000;
  auto claimed = redis.eval<sw::redis::OptionalString>(
      kClaimLua, {kQueueKey, kInflightKey}, {std::to_string(deadline), worker});
  if (!claimed) return std::nullopt;
  return std::optional<std::string>(*claimed);
}

long long returnExpired(sw::redis::Redis& redis, long long nowMs) {
  return redis.eval<long long>(kReturnLua, {kInflightKey, kQueueKey}, {std::to_string(nowMs)});
}

bool ack(sw::redis::Redis& redis, const std::string& jobId) {
  const auto removed = redis.eval<long long>(kAckLua, {kInflightKey, jobKey(jobId)}, {jobId});
  return removed == 1;
}
`,
    },
  },
  hints: [
    'After a worker pod is OOM-killed, a job is in no queue and no worker; the billing job also charged a customer twice after two reaper passes ran a minute apart.',
    '`self.redis.lpop` runs before `zadd` and `hset`, so a crash between them loses the job; `return_expired` `LPUSH`es every member before its `zrem`, so two passes both requeue it; `ack` leaves the member in `jobs:inflight`.',
    "Move the pop into `CLAIM_SCRIPT` (`LPOP`, `ZADD` with the deadline, `HSET`); in `RETURN_SCRIPT` guard with `if redis.call('ZREM', ...) == 1 then LPUSH`; in `ACK_SCRIPT` `ZREM` and set `completed` together.",
  ],
  debrief: `This queue is also a lock held across a crash, which is why the fix puts every move inside one script. The pop and the in-flight write are one operation because a job must be in exactly one of the two structures at every instant; a crash then leaves either a claim with a deadline or an untouched queue. The return is guarded by its own \`ZREM\` result because that is the only proof the claim it read is still the claim it is returning, which makes the return exactly once however many reapers run. The ack removes the claim with the state so the in-flight set holds only live claims. Production queues add a heartbeat that extends the deadline while a long job is still alive, and watch the count of claims the reaper returned as the earliest signal that the worker fleet is unhealthy.`,
};
