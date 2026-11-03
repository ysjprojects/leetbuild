import type {Step} from '@/lib/types';

export const trainingStateStep: Step = {
  id: 'state',
  title: 'Redis queue positions and leased starts',
  concept: 'redis',
  file: 'state',
  focus: ['scheduler', 'redis', 'worker'],
  task: `## Task

**Starting point.** The starter is the run queue every step uses (the later steps import the fixed
version as \`trainsched.queue\`): \`enqueue\` does \`ZADD training:queue <band>\`;
\`claim_next(worker, now_ms)\` reads the head with \`ZRANGE\`, removes it with \`ZREM\`, sets the lease
\`training:lease:{run_id}\` and puts its deadline in \`training:leases\`; \`confirm_start(run_id, worker)\`
drops the lease and marks the run \`running\`; \`reap_expired(now_ms)\` re-adds each run whose deadline
passed with score \`now_ms\`. It serves the demo (one run, one worker) and hides four flaws.

**Failure mode the checks target.** Inside a band the queue serves runs in id order, not arrival
order; two scheduler replicas claim one run; a worker whose lease ran out and whose run went to
another worker still confirms, so two workers train it; and a run whose worker died during startup
comes back behind everything.

- The score is \`position_score(band, enqueued_at_ms)\` = \`band * BAND_SPAN_MS + enqueued_at_ms\`.
- A claim is **one Lua script**: head, \`ZREM\`, \`SET training:lease:{id} <worker> PX LEASE_TTL_MS\`,
  the deadline into \`training:leases\`, and the run hash's \`state: starting\`, \`worker\` and
  \`position\` (the head's score).
- \`confirm_start\` is one script that confirms only while the lease still holds this worker, and
  returns false otherwise.
- \`reap_expired\` is one script that re-adds each expired run at its saved \`position\`.`,
  sequence: {
    participants: ['Scheduler A', 'Scheduler B', 'Redis', 'Worker'],
    messages: [
      {
        from: 'Scheduler A',
        to: 'Redis',
        label: 'EVAL claim: ZRANGE · ZREM · SET lease PX · ZADD leases · HSET position',
        kind: 'sync',
      },
      {from: 'Scheduler B', to: 'Redis', label: 'EVAL claim → the next run, never the same one', kind: 'sync'},
      {from: 'Worker', to: 'Redis', label: 'EVAL confirm: GET lease == worker → running', kind: 'sync'},
      {from: 'Scheduler A', to: 'Redis', label: 'EVAL reap: ZRANGEBYSCORE leases · ZADD queue position', kind: 'sync'},
      {from: 'Redis', to: 'Scheduler A', label: 'the run waits where it stood', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'queue-order',
      title: 'Serves band 0 first, then each band in submission order',
      detail:
        'Four runs over three bands are claimed band by band and, inside a band, oldest first. The starter scores by band alone, so runs of one band tie and come out in id order.',
      match: {
        python: {all: [/\*\s*BAND_SPAN_MS/, /zadd\([^\n]*position_score\(/]},
        typescript: {all: [/\*\s*BAND_SPAN_MS/, /zadd\([^\n]*positionScore\(/]},
        go: {all: [/\*\s*bandSpanMs/, /ZAdd\([^\n]*positionScore\(/]},
        scala: {all: [/\*\s*BandSpanMs/, /zadd\([^\n]*positionScore\(/]},
        cpp: {all: [/\*\s*kBandSpanMs/, /zadd\([^\n]*positionScore\(/]},
      },
    },
    {
      id: 'single-claim',
      title: 'Lets exactly one of two racing schedulers claim a run',
      detail:
        'A second scheduler claims right after this one first touches `training:queue`: one of them gets the run and the lease names it. The starter reads the head and removes it in two commands, so both claim it.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]ZREM['"]/], none: [/\.zrem\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]ZREM['"]/], none: [/redis\.zrem\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]ZREM['"]/], none: [/\.ZRem\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]ZREM['"]/], none: [/jedis\.zrem\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]ZREM['"]/], none: [/redis\.zrem\(/]},
      },
    },
    {
      id: 'confirm-guarded',
      title: 'Confirms a start only for the worker that holds the lease',
      detail:
        'A worker whose lease ran out, and whose run was claimed again by another worker, gets false from `confirm_start` and the run stays with the new worker. The starter drops the lease and marks the run running whoever asks.',
      match: {
        python: {all: [/redis\.call\(\s*['"]GET['"]/, /(~=|==)\s*ARGV\[1\]/], none: [/\.delete\(\s*lease_key\(/]},
        typescript: {all: [/redis\.call\(\s*['"]GET['"]/, /(~=|==)\s*ARGV\[1\]/], none: [/redis\.del\(\s*leaseKey\(/]},
        go: {all: [/redis\.call\(\s*['"]GET['"]/, /(~=|==)\s*ARGV\[1\]/], none: [/\.Del\([^\n]*leaseKey\(/]},
        scala: {all: [/redis\.call\(\s*['"]GET['"]/, /(~=|==)\s*ARGV\[1\]/], none: [/jedis\.del\(\s*leaseKey\(/]},
        cpp: {all: [/redis\.call\(\s*['"]GET['"]/, /(~=|==)\s*ARGV\[1\]/], none: [/redis\.del\(\s*leaseKey\(/]},
      },
    },
    {
      id: 'reap-keeps-position',
      title: 'Returns an expired start to the position it had',
      detail:
        'A band-0 run whose lease ran out is re-added at its original score and claimed before a band-0 run submitted after it; a lease that has not run out is left alone. The starter re-adds it with score `now_ms`.',
      match: {
        python: {all: [/redis\.call\(\s*['"]HGET['"][^\n]*['"]position['"]/], none: [/zadd\([^\n]*now_ms/]},
        typescript: {all: [/redis\.call\(\s*['"]HGET['"][^\n]*['"]position['"]/], none: [/zadd\([^\n]*nowMs/]},
        go: {all: [/redis\.call\(\s*['"]HGET['"][^\n]*['"]position['"]/], none: [/ZAdd\([^\n]*nowMs/]},
        scala: {all: [/redis\.call\(\s*['"]HGET['"][^\n]*['"]position['"]/], none: [/zadd\([^\n]*nowMs/]},
        cpp: {all: [/redis\.call\(\s*['"]HGET['"][^\n]*['"]position['"]/], none: [/zadd\([^\n]*now_ms/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from trainsched.runs import run_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

QUEUE_KEY = "training:queue"
LEASES_KEY = "training:leases"
BAND_SPAN_MS = 10**13
LEASE_TTL_MS = 15_000


def lease_key(run_id: str) -> str:
    return f"training:lease:{run_id}"


def enqueue(run_id: str, band: int, enqueued_at_ms: int) -> None:
    """Put the run in the queue at its position and mark it queued."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    r.zadd(QUEUE_KEY, {run_id: band})
    r.hset(run_key(run_id), "state", "queued")


def claim_next(worker: str, now_ms: int) -> str | None:
    """Lease the head of the queue to worker; None when the queue is empty."""
    head = r.zrange(QUEUE_KEY, 0, 0)
    if not head:
        return None
    run_id = head[0]
    r.zrem(QUEUE_KEY, run_id)
    r.set(lease_key(run_id), worker, px=LEASE_TTL_MS)
    r.zadd(LEASES_KEY, {run_id: now_ms + LEASE_TTL_MS})
    r.hset(run_key(run_id), mapping={"state": "starting", "worker": worker})
    return run_id


def confirm_start(run_id: str, worker: str) -> bool:
    """The worker's process is up: the run is running."""
    r.delete(lease_key(run_id))
    r.zrem(LEASES_KEY, run_id)
    r.hset(run_key(run_id), "state", "running")
    return True


def reap_expired(now_ms: int) -> int:
    """Put every run whose lease ran out by now_ms back in the queue; how many."""
    expired = r.zrangebyscore(LEASES_KEY, "-inf", now_ms)
    for run_id in expired:
        r.zrem(LEASES_KEY, run_id)
        r.zadd(QUEUE_KEY, {run_id: now_ms})
        r.hset(run_key(run_id), mapping={"state": "queued", "worker": ""})
    return len(expired)
`,
      solution: `import redis

from trainsched.runs import run_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

QUEUE_KEY = "training:queue"
LEASES_KEY = "training:leases"
BAND_SPAN_MS = 10**13
LEASE_TTL_MS = 15_000

# Read the head, take it out and lease it with nothing in between; the head's score is saved so an
# expired start can return to exactly where it stood.
CLAIM_LUA = """
local id = redis.call('ZRANGE', KEYS[1], 0, 0)[1]
if not id then return false end
local position = redis.call('ZSCORE', KEYS[1], id)
redis.call('ZREM', KEYS[1], id)
redis.call('SET', 'training:lease:' .. id, ARGV[1], 'PX', ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], id)
redis.call('HSET', 'run:' .. id, 'state', 'starting', 'worker', ARGV[1], 'position', position)
return id
"""

# Only the worker the lease still names may turn the start into a running run.
CONFIRM_LUA = """
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('HSET', 'run:' .. ARGV[2], 'state', 'running')
return 1
"""

REAP_LUA = """
local ids = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, id in ipairs(ids) do
  redis.call('ZREM', KEYS[2], id)
  redis.call('DEL', 'training:lease:' .. id)
  redis.call('ZADD', KEYS[1], redis.call('HGET', 'run:' .. id, 'position'), id)
  redis.call('HSET', 'run:' .. id, 'state', 'queued', 'worker', '')
end
return #ids
"""

claim_script = r.register_script(CLAIM_LUA)
confirm_script = r.register_script(CONFIRM_LUA)
reap_script = r.register_script(REAP_LUA)


def lease_key(run_id: str) -> str:
    return f"training:lease:{run_id}"


def position_score(band: int, enqueued_at_ms: int) -> int:
    """Where a run waits: its band first, then its submission time."""
    return band * BAND_SPAN_MS + enqueued_at_ms


def enqueue(run_id: str, band: int, enqueued_at_ms: int) -> None:
    """Put the run in the queue at its position and mark it queued."""
    r.zadd(QUEUE_KEY, {run_id: position_score(band, enqueued_at_ms)})
    r.hset(run_key(run_id), "state", "queued")


def claim_next(worker: str, now_ms: int) -> str | None:
    """Lease the head of the queue to worker; None when the queue is empty."""
    return claim_script(keys=[QUEUE_KEY, LEASES_KEY], args=[worker, LEASE_TTL_MS, now_ms + LEASE_TTL_MS])


def confirm_start(run_id: str, worker: str) -> bool:
    """The worker's process is up: the run is running, if worker still holds its lease."""
    return int(confirm_script(keys=[lease_key(run_id), LEASES_KEY], args=[worker, run_id])) == 1


def reap_expired(now_ms: int) -> int:
    """Put every run whose lease ran out by now_ms back at its position; how many."""
    return int(reap_script(keys=[QUEUE_KEY, LEASES_KEY], args=[now_ms]))
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {runKey} from 'trainsched/runs';

const redis = new Redis({host: 'redis', port: 6379});

export const QUEUE_KEY = 'training:queue';
export const LEASES_KEY = 'training:leases';
export const BAND_SPAN_MS = 10 ** 13;
export const LEASE_TTL_MS = 15_000;

export const leaseKey = (runId: string): string => \`training:lease:\${runId}\`;

/** Put the run in the queue at its position and mark it queued. */
export async function enqueue(runId: string, band: number, enqueuedAtMs: number): Promise<void> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  await redis.zadd(QUEUE_KEY, band, runId);
  await redis.hset(runKey(runId), 'state', 'queued');
}

/** Lease the head of the queue to worker; null when the queue is empty. */
export async function claimNext(worker: string, nowMs: number): Promise<string | null> {
  const head = await redis.zrange(QUEUE_KEY, 0, 0);
  if (head.length === 0) return null;
  const runId = head[0];
  await redis.zrem(QUEUE_KEY, runId);
  await redis.set(leaseKey(runId), worker, 'PX', LEASE_TTL_MS);
  await redis.zadd(LEASES_KEY, nowMs + LEASE_TTL_MS, runId);
  await redis.hset(runKey(runId), {state: 'starting', worker});
  return runId;
}

/** The worker's process is up: the run is running. */
export async function confirmStart(runId: string, worker: string): Promise<boolean> {
  await redis.del(leaseKey(runId));
  await redis.zrem(LEASES_KEY, runId);
  await redis.hset(runKey(runId), 'state', 'running');
  return true;
}

/** Put every run whose lease ran out by nowMs back in the queue; how many. */
export async function reapExpired(nowMs: number): Promise<number> {
  const expired = await redis.zrangebyscore(LEASES_KEY, '-inf', nowMs);
  for (const runId of expired) {
    await redis.zrem(LEASES_KEY, runId);
    await redis.zadd(QUEUE_KEY, nowMs, runId);
    await redis.hset(runKey(runId), {state: 'queued', worker: ''});
  }
  return expired.length;
}
`,
      solution: `import Redis from 'ioredis';

import {runKey} from 'trainsched/runs';

const redis = new Redis({host: 'redis', port: 6379});

export const QUEUE_KEY = 'training:queue';
export const LEASES_KEY = 'training:leases';
export const BAND_SPAN_MS = 10 ** 13;
export const LEASE_TTL_MS = 15_000;

// Read the head, take it out and lease it with nothing in between; the head's score is saved so an
// expired start can return to exactly where it stood.
export const CLAIM_LUA = \`
local id = redis.call('ZRANGE', KEYS[1], 0, 0)[1]
if not id then return false end
local position = redis.call('ZSCORE', KEYS[1], id)
redis.call('ZREM', KEYS[1], id)
redis.call('SET', 'training:lease:' .. id, ARGV[1], 'PX', ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], id)
redis.call('HSET', 'run:' .. id, 'state', 'starting', 'worker', ARGV[1], 'position', position)
return id
\`;

// Only the worker the lease still names may turn the start into a running run.
export const CONFIRM_LUA = \`
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('HSET', 'run:' .. ARGV[2], 'state', 'running')
return 1
\`;

export const REAP_LUA = \`
local ids = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, id in ipairs(ids) do
  redis.call('ZREM', KEYS[2], id)
  redis.call('DEL', 'training:lease:' .. id)
  redis.call('ZADD', KEYS[1], redis.call('HGET', 'run:' .. id, 'position'), id)
  redis.call('HSET', 'run:' .. id, 'state', 'queued', 'worker', '')
end
return #ids
\`;

export const leaseKey = (runId: string): string => \`training:lease:\${runId}\`;

/** Where a run waits: its band first, then its submission time. */
export const positionScore = (band: number, enqueuedAtMs: number): number => band * BAND_SPAN_MS + enqueuedAtMs;

/** Put the run in the queue at its position and mark it queued. */
export async function enqueue(runId: string, band: number, enqueuedAtMs: number): Promise<void> {
  await redis.zadd(QUEUE_KEY, positionScore(band, enqueuedAtMs), runId);
  await redis.hset(runKey(runId), 'state', 'queued');
}

/** Lease the head of the queue to worker; null when the queue is empty. */
export async function claimNext(worker: string, nowMs: number): Promise<string | null> {
  const id = await redis.eval(CLAIM_LUA, 2, QUEUE_KEY, LEASES_KEY, worker, LEASE_TTL_MS, nowMs + LEASE_TTL_MS);
  return (id as string | null) ?? null;
}

/** The worker's process is up: the run is running, if worker still holds its lease. */
export async function confirmStart(runId: string, worker: string): Promise<boolean> {
  return Number(await redis.eval(CONFIRM_LUA, 2, leaseKey(runId), LEASES_KEY, worker, runId)) === 1;
}

/** Put every run whose lease ran out by nowMs back at its position; how many. */
export async function reapExpired(nowMs: number): Promise<number> {
  return Number(await redis.eval(REAP_LUA, 2, QUEUE_KEY, LEASES_KEY, nowMs));
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

	"trainsched/runs" // runs.RunKey
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	queueKey   = "training:queue"
	leasesKey  = "training:leases"
	bandSpanMs = int64(10_000_000_000_000)
	leaseTTLMs = int64(15_000)
)

func leaseKey(runID string) string { return "training:lease:" + runID }

// enqueue puts the run in the queue at its position and marks it queued.
func enqueue(ctx context.Context, runID string, band int, enqueuedAtMs int64) error {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	if err := rdb.ZAdd(ctx, queueKey, redis.Z{Score: float64(band), Member: runID}).Err(); err != nil {
		return err
	}
	return rdb.HSet(ctx, runs.RunKey(runID), "state", "queued").Err()
}

// claimNext leases the head of the queue to worker; "" when the queue is empty.
func claimNext(ctx context.Context, worker string, nowMs int64) (string, error) {
	head, err := rdb.ZRange(ctx, queueKey, 0, 0).Result()
	if err != nil || len(head) == 0 {
		return "", err
	}
	runID := head[0]
	rdb.ZRem(ctx, queueKey, runID)
	rdb.Set(ctx, leaseKey(runID), worker, time.Duration(leaseTTLMs)*time.Millisecond)
	rdb.ZAdd(ctx, leasesKey, redis.Z{Score: float64(nowMs + leaseTTLMs), Member: runID})
	rdb.HSet(ctx, runs.RunKey(runID), "state", "starting", "worker", worker)
	return runID, nil
}

// confirmStart: the worker's process is up, the run is running.
func confirmStart(ctx context.Context, runID, worker string) (bool, error) {
	rdb.Del(ctx, leaseKey(runID))
	rdb.ZRem(ctx, leasesKey, runID)
	return true, rdb.HSet(ctx, runs.RunKey(runID), "state", "running").Err()
}

// reapExpired puts every run whose lease ran out by nowMs back in the queue; how many.
func reapExpired(ctx context.Context, nowMs int64) (int, error) {
	expired, err := rdb.ZRangeByScore(ctx, leasesKey, &redis.ZRangeBy{Min: "-inf", Max: strconv.FormatInt(nowMs, 10)}).Result()
	if err != nil {
		return 0, err
	}
	for _, runID := range expired {
		rdb.ZRem(ctx, leasesKey, runID)
		rdb.ZAdd(ctx, queueKey, redis.Z{Score: float64(nowMs), Member: runID})
		rdb.HSet(ctx, runs.RunKey(runID), "state", "queued", "worker", "")
	}
	return len(expired), nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"trainsched/runs" // runs.RunKey
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	queueKey   = "training:queue"
	leasesKey  = "training:leases"
	bandSpanMs = int64(10_000_000_000_000)
	leaseTTLMs = int64(15_000)
)

// Read the head, take it out and lease it with nothing in between; the head's score is saved so an
// expired start can return to exactly where it stood.
var claimScript = redis.NewScript(\`
local id = redis.call('ZRANGE', KEYS[1], 0, 0)[1]
if not id then return false end
local position = redis.call('ZSCORE', KEYS[1], id)
redis.call('ZREM', KEYS[1], id)
redis.call('SET', 'training:lease:' .. id, ARGV[1], 'PX', ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], id)
redis.call('HSET', 'run:' .. id, 'state', 'starting', 'worker', ARGV[1], 'position', position)
return id
\`)

// Only the worker the lease still names may turn the start into a running run.
var confirmScript = redis.NewScript(\`
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('HSET', 'run:' .. ARGV[2], 'state', 'running')
return 1
\`)

var reapScript = redis.NewScript(\`
local ids = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, id in ipairs(ids) do
  redis.call('ZREM', KEYS[2], id)
  redis.call('DEL', 'training:lease:' .. id)
  redis.call('ZADD', KEYS[1], redis.call('HGET', 'run:' .. id, 'position'), id)
  redis.call('HSET', 'run:' .. id, 'state', 'queued', 'worker', '')
end
return #ids
\`)

func leaseKey(runID string) string { return "training:lease:" + runID }

// positionScore is where a run waits: its band first, then its submission time.
func positionScore(band int, enqueuedAtMs int64) int64 {
	return int64(band)*bandSpanMs + enqueuedAtMs
}

// enqueue puts the run in the queue at its position and marks it queued.
func enqueue(ctx context.Context, runID string, band int, enqueuedAtMs int64) error {
	if err := rdb.ZAdd(ctx, queueKey, redis.Z{Score: float64(positionScore(band, enqueuedAtMs)), Member: runID}).Err(); err != nil {
		return err
	}
	return rdb.HSet(ctx, runs.RunKey(runID), "state", "queued").Err()
}

// claimNext leases the head of the queue to worker; "" when the queue is empty.
func claimNext(ctx context.Context, worker string, nowMs int64) (string, error) {
	id, err := claimScript.Run(ctx, rdb, []string{queueKey, leasesKey}, worker, leaseTTLMs, nowMs+leaseTTLMs).Text()
	if err == redis.Nil {
		return "", nil
	}
	return id, err
}

// confirmStart: the worker's process is up, the run is running, if worker still holds its lease.
func confirmStart(ctx context.Context, runID, worker string) (bool, error) {
	n, err := confirmScript.Run(ctx, rdb, []string{leaseKey(runID), leasesKey}, worker, runID).Int()
	return n == 1, err
}

// reapExpired puts every run whose lease ran out by nowMs back at its position; how many.
func reapExpired(ctx context.Context, nowMs int64) (int, error) {
	return reapScript.Run(ctx, rdb, []string{queueKey, leasesKey}, nowMs).Int()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

import trainsched.Runs // Runs.runKey

object QueueState {
  val jedis = new JedisPooled("redis", 6379)

  val QueueKey = "training:queue"
  val LeasesKey = "training:leases"
  val BandSpanMs: Long = 10000000000000L
  val LeaseTtlMs: Long = 15000L

  def leaseKey(runId: String): String = s"training:lease:$runId"

  /** Put the run in the queue at its position and mark it queued. */
  def enqueue(runId: String, band: Int, enqueuedAtMs: Long): Unit = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    jedis.zadd(QueueKey, band.toDouble, runId)
    jedis.hset(Runs.runKey(runId), "state", "queued")
  }

  /** Lease the head of the queue to worker; None when the queue is empty. */
  def claimNext(worker: String, nowMs: Long): Option[String] =
    jedis.zrange(QueueKey, 0, 0).asScala.headOption.map { runId =>
      jedis.zrem(QueueKey, runId)
      jedis.set(leaseKey(runId), worker, SetParams.setParams().px(LeaseTtlMs))
      jedis.zadd(LeasesKey, (nowMs + LeaseTtlMs).toDouble, runId)
      jedis.hset(Runs.runKey(runId), Map("state" -> "starting", "worker" -> worker).asJava)
      runId
    }

  /** The worker's process is up: the run is running. */
  def confirmStart(runId: String, worker: String): Boolean = {
    jedis.del(leaseKey(runId))
    jedis.zrem(LeasesKey, runId)
    jedis.hset(Runs.runKey(runId), "state", "running")
    true
  }

  /** Put every run whose lease ran out by nowMs back in the queue; how many. */
  def reapExpired(nowMs: Long): Long = {
    val expired = jedis.zrangeByScore(LeasesKey, Double.NegativeInfinity, nowMs.toDouble).asScala
    expired.foreach { runId =>
      jedis.zrem(LeasesKey, runId)
      jedis.zadd(QueueKey, nowMs.toDouble, runId)
      jedis.hset(Runs.runKey(runId), Map("state" -> "queued", "worker" -> "").asJava)
    }
    expired.size.toLong
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import trainsched.Runs // Runs.runKey

object QueueState {
  val jedis = new JedisPooled("redis", 6379)

  val QueueKey = "training:queue"
  val LeasesKey = "training:leases"
  val BandSpanMs: Long = 10000000000000L
  val LeaseTtlMs: Long = 15000L

  // Read the head, take it out and lease it with nothing in between; the head's score is saved so an
  // expired start can return to exactly where it stood.
  val ClaimLua: String =
    """local id = redis.call('ZRANGE', KEYS[1], 0, 0)[1]
      |if not id then return false end
      |local position = redis.call('ZSCORE', KEYS[1], id)
      |redis.call('ZREM', KEYS[1], id)
      |redis.call('SET', 'training:lease:' .. id, ARGV[1], 'PX', ARGV[2])
      |redis.call('ZADD', KEYS[2], ARGV[3], id)
      |redis.call('HSET', 'run:' .. id, 'state', 'starting', 'worker', ARGV[1], 'position', position)
      |return id
      |""".stripMargin

  // Only the worker the lease still names may turn the start into a running run.
  val ConfirmLua: String =
    """if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      |redis.call('DEL', KEYS[1])
      |redis.call('ZREM', KEYS[2], ARGV[2])
      |redis.call('HSET', 'run:' .. ARGV[2], 'state', 'running')
      |return 1
      |""".stripMargin

  val ReapLua: String =
    """local ids = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
      |for _, id in ipairs(ids) do
      |  redis.call('ZREM', KEYS[2], id)
      |  redis.call('DEL', 'training:lease:' .. id)
      |  redis.call('ZADD', KEYS[1], redis.call('HGET', 'run:' .. id, 'position'), id)
      |  redis.call('HSET', 'run:' .. id, 'state', 'queued', 'worker', '')
      |end
      |return #ids
      |""".stripMargin

  def leaseKey(runId: String): String = s"training:lease:$runId"

  /** Where a run waits: its band first, then its submission time. */
  def positionScore(band: Int, enqueuedAtMs: Long): Long = band * BandSpanMs + enqueuedAtMs

  /** Put the run in the queue at its position and mark it queued. */
  def enqueue(runId: String, band: Int, enqueuedAtMs: Long): Unit = {
    jedis.zadd(QueueKey, positionScore(band, enqueuedAtMs).toDouble, runId)
    jedis.hset(Runs.runKey(runId), "state", "queued")
  }

  /** Lease the head of the queue to worker; None when the queue is empty. */
  def claimNext(worker: String, nowMs: Long): Option[String] =
    Option(jedis.eval(ClaimLua, List(QueueKey, LeasesKey).asJava, List(worker, LeaseTtlMs.toString, (nowMs + LeaseTtlMs).toString).asJava))
      .map(_.toString)

  /** The worker's process is up: the run is running, if worker still holds its lease. */
  def confirmStart(runId: String, worker: String): Boolean =
    jedis.eval(ConfirmLua, List(leaseKey(runId), LeasesKey).asJava, List(worker, runId).asJava).asInstanceOf[java.lang.Long] == 1L

  /** Put every run whose lease ran out by nowMs back at its position; how many. */
  def reapExpired(nowMs: Long): Long =
    jedis.eval(ReapLua, List(QueueKey, LeasesKey).asJava, List(nowMs.toString).asJava).asInstanceOf[java.lang.Long]
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

#include "trainsched/runs.h"  // runs::runKey

sw::redis::Redis redis("tcp://redis:6379");

const std::string kQueueKey = "training:queue";
const std::string kLeasesKey = "training:leases";
constexpr long long kBandSpanMs = 10'000'000'000'000LL;
constexpr long long kLeaseTtlMs = 15'000;

std::string leaseKey(const std::string& run_id) { return "training:lease:" + run_id; }

// Put the run in the queue at its position and mark it queued.
void enqueue(const std::string& run_id, int band, long long enqueued_at_ms) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  redis.zadd(kQueueKey, run_id, static_cast<double>(band));
  redis.hset(runs::runKey(run_id), "state", "queued");
}

// Lease the head of the queue to worker; none when the queue is empty.
std::optional<std::string> claimNext(const std::string& worker, long long now_ms) {
  std::vector<std::string> head;
  redis.zrange(kQueueKey, 0, 0, std::back_inserter(head));
  if (head.empty()) return std::nullopt;
  const std::string run_id = head[0];
  redis.zrem(kQueueKey, run_id);
  redis.set(leaseKey(run_id), worker, std::chrono::milliseconds(kLeaseTtlMs));
  redis.zadd(kLeasesKey, run_id, static_cast<double>(now_ms + kLeaseTtlMs));
  redis.hset(runs::runKey(run_id), "state", "starting");
  redis.hset(runs::runKey(run_id), "worker", worker);
  return run_id;
}

// The worker's process is up: the run is running.
bool confirmStart(const std::string& run_id, const std::string& worker) {
  redis.del(leaseKey(run_id));
  redis.zrem(kLeasesKey, run_id);
  redis.hset(runs::runKey(run_id), "state", "running");
  return true;
}

// Put every run whose lease ran out by now_ms back in the queue; how many.
long long reapExpired(long long now_ms) {
  std::vector<std::string> expired;
  redis.zrangebyscore(kLeasesKey, sw::redis::RightBoundedInterval<double>(static_cast<double>(now_ms), sw::redis::BoundType::CLOSED),
                      std::back_inserter(expired));
  for (const auto& run_id : expired) {
    redis.zrem(kLeasesKey, run_id);
    redis.zadd(kQueueKey, run_id, static_cast<double>(now_ms));
    redis.hset(runs::runKey(run_id), "state", "queued");
    redis.hset(runs::runKey(run_id), "worker", "");
  }
  return static_cast<long long>(expired.size());
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

#include "trainsched/runs.h"  // runs::runKey

sw::redis::Redis redis("tcp://redis:6379");

const std::string kQueueKey = "training:queue";
const std::string kLeasesKey = "training:leases";
constexpr long long kBandSpanMs = 10'000'000'000'000LL;
constexpr long long kLeaseTtlMs = 15'000;

// Read the head, take it out and lease it with nothing in between; the head's score is saved so an
// expired start can return to exactly where it stood.
const std::string kClaimLua = R"lua(
local id = redis.call('ZRANGE', KEYS[1], 0, 0)[1]
if not id then return false end
local position = redis.call('ZSCORE', KEYS[1], id)
redis.call('ZREM', KEYS[1], id)
redis.call('SET', 'training:lease:' .. id, ARGV[1], 'PX', ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], id)
redis.call('HSET', 'run:' .. id, 'state', 'starting', 'worker', ARGV[1], 'position', position)
return id
)lua";

// Only the worker the lease still names may turn the start into a running run.
const std::string kConfirmLua = R"lua(
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('HSET', 'run:' .. ARGV[2], 'state', 'running')
return 1
)lua";

const std::string kReapLua = R"lua(
local ids = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, id in ipairs(ids) do
  redis.call('ZREM', KEYS[2], id)
  redis.call('DEL', 'training:lease:' .. id)
  redis.call('ZADD', KEYS[1], redis.call('HGET', 'run:' .. id, 'position'), id)
  redis.call('HSET', 'run:' .. id, 'state', 'queued', 'worker', '')
end
return #ids
)lua";

std::string leaseKey(const std::string& run_id) { return "training:lease:" + run_id; }

// Where a run waits: its band first, then its submission time.
long long positionScore(int band, long long enqueued_at_ms) { return band * kBandSpanMs + enqueued_at_ms; }

// Put the run in the queue at its position and mark it queued.
void enqueue(const std::string& run_id, int band, long long enqueued_at_ms) {
  redis.zadd(kQueueKey, run_id, static_cast<double>(positionScore(band, enqueued_at_ms)));
  redis.hset(runs::runKey(run_id), "state", "queued");
}

// Lease the head of the queue to worker; none when the queue is empty.
std::optional<std::string> claimNext(const std::string& worker, long long now_ms) {
  const auto id = redis.eval<sw::redis::OptionalString>(
      kClaimLua, {kQueueKey, kLeasesKey}, {worker, std::to_string(kLeaseTtlMs), std::to_string(now_ms + kLeaseTtlMs)});
  if (!id) return std::nullopt;
  return *id;
}

// The worker's process is up: the run is running, if worker still holds its lease.
bool confirmStart(const std::string& run_id, const std::string& worker) {
  return redis.eval<long long>(kConfirmLua, {leaseKey(run_id), kLeasesKey}, {worker, run_id}) == 1;
}

// Put every run whose lease ran out by now_ms back at its position; how many.
long long reapExpired(long long now_ms) {
  return redis.eval<long long>(kReapLua, {kQueueKey, kLeasesKey}, {std::to_string(now_ms)});
}
`,
    },
  },
  harness: {
    python: `from trainsched import runs


def _now(ctx):
    return int(ctx.clock.time() * 1000)


def _enqueue(m, run_id, band, at):
    runs.put({"run_id": run_id, "tenant": "t1", "recipe_version": "llama-ft-v3", "dataset_version": "ds-1",
              "priority": 8 - 3 * band, "band": band, "state": "queued", "enqueued_at_ms": at})
    m.enqueue(run_id, band, at)


def check_queue_order(ctx):
    m = ctx.load("state")
    t0 = _now(ctx)
    _enqueue(m, "run-a", 1, t0 + 1000)
    _enqueue(m, "run-b", 0, t0 + 3000)
    _enqueue(m, "run-c", 1, t0 + 500)
    _enqueue(m, "run-0", 2, t0)
    order = [m.claim_next(f"w-{i}", t0 + 5000) for i in range(4)]
    assert order == ["run-b", "run-c", "run-a", "run-0"], f"the queue served {order}, expected run-b (band 0), then band 1 in submission order (run-c before run-a), then run-0 (band 2)"
    assert m.claim_next("w-9", t0 + 5000) is None, "claim_next on an empty queue must return None"


def check_single_claim(ctx):
    m = ctx.load("state")
    now = _now(ctx)
    _enqueue(m, "run-a", 1, now)
    # Another scheduler replica claims right after this one first touches the queue.
    rival = ctx.redis_after("training:queue", lambda: m.claim_next("w-2", now))
    mine = m.claim_next("w-1", now)
    assert rival.fired, "claim_next never touched training:queue"
    if rival.error is not None:
        raise rival.error
    winners = [w for w, got in (("w-1", mine), ("w-2", rival.result)) if got == "run-a"]
    assert len(winners) == 1, f"two schedulers claimed run-a at once and {len(winners)} got it ({winners}): the other claim landed between your read of the head and your ZREM. Read, remove and lease in one Lua script"
    holder = ctx.redis.get("training:lease:run-a")
    assert holder == winners[0], f"training:lease:run-a names {holder!r}, but {winners[0]} won the claim"
    assert runs.get("run-a")["worker"] == winners[0], f"the run row names worker {runs.get('run-a')['worker']!r}, but {winners[0]} won the claim"


def check_confirm_guarded(ctx):
    m = ctx.load("state")
    t0 = _now(ctx)
    _enqueue(m, "run-a", 1, t0)
    assert m.claim_next("w-1", t0) == "run-a", "the only queued run must be claimed"
    ctx.clock.advance(16)  # w-1 died during startup
    assert m.reap_expired(t0 + 16000) == 1, "the lease of run-a ran out: reap_expired must return it"
    assert m.claim_next("w-2", t0 + 16000) == "run-a", "run-a must be claimable again once its lease ran out"
    late = m.confirm_start("run-a", "w-1")
    assert late is False, f"w-1, whose lease ran out and whose run went to w-2, confirmed run-a ({late!r}): two workers would train it. Confirm only for the worker the lease names"
    run = runs.get("run-a")
    assert run["state"] == "starting" and run["worker"] == "w-2", f"after the late confirm the run reads state {run['state']!r} worker {run['worker']!r}, expected starting on w-2"
    assert m.confirm_start("run-a", "w-2") is True, "the worker that holds the lease must be able to confirm"
    assert runs.get("run-a")["state"] == "running", f"a confirmed run reads state {runs.get('run-a')['state']!r}, expected running"
    assert ctx.redis.zscore("training:leases", "run-a") is None, "a confirmed run left its deadline in training:leases: the reaper would requeue a running run"


def check_reap_keeps_position(ctx):
    m = ctx.load("state")
    t0 = _now(ctx)
    _enqueue(m, "run-a", 0, t0)
    assert m.claim_next("w-1", t0) == "run-a", "the only queued run must be claimed"
    _enqueue(m, "run-b", 0, t0 + 5000)
    _enqueue(m, "run-c", 1, t0 + 100)
    assert m.reap_expired(t0 + 1000) == 0, "reap_expired returned a run whose lease has not run out"
    ctx.clock.advance(16)  # w-1 died during startup
    assert m.reap_expired(t0 + 16000) == 1, "the lease of run-a ran out: reap_expired must return it"
    score = ctx.redis.zscore("training:queue", "run-a")
    assert score == t0, f"run-a came back with score {score}, expected its original position {t0} (band 0, submitted at {t0})"
    order = [m.claim_next("w-2", t0 + 16000) for _ in range(3)]
    assert order == ["run-a", "run-b", "run-c"], f"after the reap the queue served {order}: run-a was submitted before run-b and must not lose its place"
`,
    typescript: `function load(ctx) {
  return {m: ctx.load('state'), runs: ctx.load('/support/trainsched/runs.ts')};
}

async function enqueue(m, runs, runId: string, band: number, at: number): Promise<void> {
  await runs.put({run_id: runId, tenant: 't1', recipe_version: 'llama-ft-v3', dataset_version: 'ds-1', priority: 8 - 3 * band, band, state: 'queued', enqueued_at_ms: at, worker: '', nodes: [], checkpoint_id: ''});
  await m.enqueue(runId, band, at);
}

export async function check_queue_order(ctx) {
  const {m, runs} = load(ctx);
  const t0 = ctx.clock.now();
  await enqueue(m, runs, 'run-a', 1, t0 + 1000);
  await enqueue(m, runs, 'run-b', 0, t0 + 3000);
  await enqueue(m, runs, 'run-c', 1, t0 + 500);
  await enqueue(m, runs, 'run-0', 2, t0);
  const order: string[] = [];
  for (let i = 0; i < 4; i++) order.push(await m.claimNext(\`w-\${i}\`, t0 + 5000));
  assert.deepEqual(order, ['run-b', 'run-c', 'run-a', 'run-0'], \`the queue served \${JSON.stringify(order)}, expected run-b (band 0), then band 1 in submission order (run-c before run-a), then run-0 (band 2)\`);
  assert.equal(await m.claimNext('w-9', t0 + 5000), null, 'claimNext on an empty queue must return null');
}

export async function check_single_claim(ctx) {
  const {m, runs} = load(ctx);
  const now = ctx.clock.now();
  await enqueue(m, runs, 'run-a', 1, now);
  // Another scheduler replica claims right after this one first touches the queue.
  const rival = ctx.redisAfter('training:queue', () => m.claimNext('w-2', now));
  const mine = await m.claimNext('w-1', now);
  assert(rival.fired, 'claimNext never touched training:queue');
  if (rival.error !== undefined) throw rival.error;
  const theirs = await rival.result;
  const winners = [['w-1', mine], ['w-2', theirs]].filter(([, got]) => got === 'run-a').map(([w]) => w);
  assert.equal(winners.length, 1, \`two schedulers claimed run-a at once and \${winners.length} got it (\${JSON.stringify(winners)}): the other claim landed between your read of the head and your ZREM. Read, remove and lease in one Lua script\`);
  const holder = ctx.redis.get('training:lease:run-a');
  assert.equal(holder, winners[0], \`training:lease:run-a names \${JSON.stringify(holder)}, but \${winners[0]} won the claim\`);
  assert.equal((await runs.get('run-a')).worker, winners[0], \`the run row must name \${winners[0]}, which won the claim\`);
}

export async function check_confirm_guarded(ctx) {
  const {m, runs} = load(ctx);
  const t0 = ctx.clock.now();
  await enqueue(m, runs, 'run-a', 1, t0);
  assert.equal(await m.claimNext('w-1', t0), 'run-a', 'the only queued run must be claimed');
  ctx.clock.advance(16); // w-1 died during startup
  assert.equal(await m.reapExpired(t0 + 16000), 1, 'the lease of run-a ran out: reapExpired must return it');
  assert.equal(await m.claimNext('w-2', t0 + 16000), 'run-a', 'run-a must be claimable again once its lease ran out');
  const late = await m.confirmStart('run-a', 'w-1');
  assert.equal(late, false, \`w-1, whose lease ran out and whose run went to w-2, confirmed run-a (\${late}): two workers would train it. Confirm only for the worker the lease names\`);
  const run = await runs.get('run-a');
  assert(run.state === 'starting' && run.worker === 'w-2', \`after the late confirm the run reads state \${run.state} worker \${run.worker}, expected starting on w-2\`);
  assert.equal(await m.confirmStart('run-a', 'w-2'), true, 'the worker that holds the lease must be able to confirm');
  assert.equal((await runs.get('run-a')).state, 'running', 'a confirmed run must read state running');
  assert.equal(ctx.redis.zscore('training:leases', 'run-a'), null, 'a confirmed run left its deadline in training:leases: the reaper would requeue a running run');
}

export async function check_reap_keeps_position(ctx) {
  const {m, runs} = load(ctx);
  const t0 = ctx.clock.now();
  await enqueue(m, runs, 'run-a', 0, t0);
  assert.equal(await m.claimNext('w-1', t0), 'run-a', 'the only queued run must be claimed');
  await enqueue(m, runs, 'run-b', 0, t0 + 5000);
  await enqueue(m, runs, 'run-c', 1, t0 + 100);
  assert.equal(await m.reapExpired(t0 + 1000), 0, 'reapExpired returned a run whose lease has not run out');
  ctx.clock.advance(16); // w-1 died during startup
  assert.equal(await m.reapExpired(t0 + 16000), 1, 'the lease of run-a ran out: reapExpired must return it');
  const score = Number(ctx.redis.zscore('training:queue', 'run-a'));
  assert.equal(score, t0, \`run-a came back with score \${score}, expected its original position \${t0} (band 0, submitted at \${t0})\`);
  const order: string[] = [];
  for (let i = 0; i < 3; i++) order.push(await m.claimNext('w-2', t0 + 16000));
  assert.deepEqual(order, ['run-a', 'run-b', 'run-c'], \`after the reap the queue served \${JSON.stringify(order)}: run-a was submitted before run-b and must not lose its place\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"

	"trainsched/runs"

	"leetbuild/harness"
)

var stateBg = context.Background()

func stateEnqueue(ctx *harness.Ctx, runID string, band int, at int64) {
	ctx.NoError(runs.Put(stateBg, &runs.Run{RunID: runID, Tenant: "t1", RecipeVersion: "llama-ft-v3", DatasetVersion: "ds-1", Priority: 8 - 3*band, Band: band, State: "queued", EnqueuedAtMs: at}), "runs.Put")
	ctx.NoError(enqueue(stateBg, runID, band, at), "enqueue(%s)", runID)
}

func stateClaim(ctx *harness.Ctx, worker string, nowMs int64) string {
	id, err := claimNext(stateBg, worker, nowMs)
	ctx.NoError(err, "claimNext(%s)", worker)
	return id
}

func stateReap(ctx *harness.Ctx, nowMs int64) int {
	n, err := reapExpired(stateBg, nowMs)
	ctx.NoError(err, "reapExpired")
	return n
}

func stateConfirm(ctx *harness.Ctx, runID, worker string) bool {
	ok, err := confirmStart(stateBg, runID, worker)
	ctx.NoError(err, "confirmStart(%s, %s)", runID, worker)
	return ok
}

func CheckQueueOrder(ctx *harness.Ctx) {
	t0 := ctx.Clock.Now()
	stateEnqueue(ctx, "run-a", 1, t0+1000)
	stateEnqueue(ctx, "run-b", 0, t0+3000)
	stateEnqueue(ctx, "run-c", 1, t0+500)
	stateEnqueue(ctx, "run-0", 2, t0)
	order := []string{}
	for i := 0; i < 4; i++ {
		order = append(order, stateClaim(ctx, fmt.Sprintf("w-%d", i), t0+5000))
	}
	ctx.Equal(order, []string{"run-b", "run-c", "run-a", "run-0"}, "the queue must serve run-b (band 0), then band 1 in submission order (run-c before run-a), then run-0 (band 2); the order")
	ctx.Equal(stateClaim(ctx, "w-9", t0+5000), "", "claimNext on an empty queue")
}

func CheckSingleClaim(ctx *harness.Ctx) {
	now := ctx.Clock.Now()
	stateEnqueue(ctx, "run-a", 1, now)
	// Another scheduler replica claims right after this one first touches the queue.
	theirs := ""
	rival := ctx.Redis.After("training:queue", func() any {
		id, _ := claimNext(stateBg, "w-2", now)
		theirs = id
		return id
	})
	mine := stateClaim(ctx, "w-1", now)
	ctx.Assert(rival.Fired, "claimNext never touched training:queue")
	winners := []string{}
	if mine == "run-a" {
		winners = append(winners, "w-1")
	}
	if theirs == "run-a" {
		winners = append(winners, "w-2")
	}
	ctx.Assert(len(winners) == 1, "two schedulers claimed run-a at once and %d got it (%v): the other claim landed between your read of the head and your ZREM. Read, remove and lease in one Lua script", len(winners), winners)
	holder, _ := ctx.Redis.Get("training:lease:run-a")
	ctx.Equal(holder, winners[0], "training:lease:run-a must name the winner of the claim")
	ctx.Equal(runs.Get(stateBg, "run-a").Worker, winners[0], "the run row's worker must be the winner of the claim")
}

func CheckConfirmGuarded(ctx *harness.Ctx) {
	t0 := ctx.Clock.Now()
	stateEnqueue(ctx, "run-a", 1, t0)
	ctx.Equal(stateClaim(ctx, "w-1", t0), "run-a", "the only queued run must be claimed")
	ctx.Clock.Advance(16) // w-1 died during startup
	ctx.Equal(stateReap(ctx, t0+16000), 1, "the lease of run-a ran out: reapExpired must return it")
	ctx.Equal(stateClaim(ctx, "w-2", t0+16000), "run-a", "run-a must be claimable again once its lease ran out")
	late := stateConfirm(ctx, "run-a", "w-1")
	ctx.Assert(!late, "w-1, whose lease ran out and whose run went to w-2, confirmed run-a: two workers would train it. Confirm only for the worker the lease names")
	run := runs.Get(stateBg, "run-a")
	ctx.Assert(run.State == "starting" && run.Worker == "w-2", "after the late confirm the run reads state %q worker %q, expected starting on w-2", run.State, run.Worker)
	ctx.Equal(stateConfirm(ctx, "run-a", "w-2"), true, "the worker that holds the lease must be able to confirm")
	ctx.Equal(runs.Get(stateBg, "run-a").State, "running", "a confirmed run's state")
	_, left := ctx.Redis.ZScore("training:leases", "run-a")
	ctx.Assert(!left, "a confirmed run left its deadline in training:leases: the reaper would requeue a running run")
}

func CheckReapKeepsPosition(ctx *harness.Ctx) {
	t0 := ctx.Clock.Now()
	stateEnqueue(ctx, "run-a", 0, t0)
	ctx.Equal(stateClaim(ctx, "w-1", t0), "run-a", "the only queued run must be claimed")
	stateEnqueue(ctx, "run-b", 0, t0+5000)
	stateEnqueue(ctx, "run-c", 1, t0+100)
	ctx.Equal(stateReap(ctx, t0+1000), 0, "reapExpired must leave a lease that has not run out; the runs reaped")
	ctx.Clock.Advance(16) // w-1 died during startup
	ctx.Equal(stateReap(ctx, t0+16000), 1, "the lease of run-a ran out: reapExpired must return it")
	score, _ := ctx.Redis.ZScore("training:queue", "run-a")
	ctx.Assert(int64(score) == t0, "run-a came back with score %.0f, expected its original position %d (band 0, submitted at %d)", score, t0, t0)
	order := []string{}
	for i := 0; i < 3; i++ {
		order = append(order, stateClaim(ctx, "w-2", t0+16000))
	}
	ctx.Equal(order, []string{"run-a", "run-b", "run-c"}, "after the reap run-a, submitted before run-b, must keep its place; the order")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <optional>
#include <string>
#include <vector>

namespace {

void stateEnqueue(const std::string& run_id, int band, long long at) {
  runs::Run run;
  run.run_id = run_id;
  run.tenant = "t1";
  run.recipe_version = "llama-ft-v3";
  run.dataset_version = "ds-1";
  run.priority = 8 - 3 * band;
  run.band = band;
  run.state = "queued";
  run.enqueued_at_ms = at;
  runs::put(run);
  enqueue(run_id, band, at);
}

std::string claimed(long long now_ms, const std::string& worker) { return claimNext(worker, now_ms).value_or(""); }

}  // namespace

void CheckQueueOrder(harness::Ctx& ctx) {
  const long long t0 = ctx.Clock.Now();
  stateEnqueue("run-a", 1, t0 + 1000);
  stateEnqueue("run-b", 0, t0 + 3000);
  stateEnqueue("run-c", 1, t0 + 500);
  stateEnqueue("run-0", 2, t0);
  std::vector<std::string> order;
  for (int i = 0; i < 4; i++) order.push_back(claimed(t0 + 5000, "w-" + std::to_string(i)));
  ctx.Equal(order, {"run-b", "run-c", "run-a", "run-0"},
            "the queue must serve run-b (band 0), then band 1 in submission order (run-c before run-a), then run-0 (band 2); the order");
  ctx.Assert(!claimNext("w-9", t0 + 5000).has_value(), "claimNext on an empty queue must return nothing");
}

void CheckSingleClaim(harness::Ctx& ctx) {
  const long long now = ctx.Clock.Now();
  stateEnqueue("run-a", 1, now);
  // Another scheduler replica claims right after this one first touches the queue.
  bool fired = false;
  std::string theirs;
  ctx.Redis.After("training:queue", [&] {
    fired = true;
    theirs = claimed(now, "w-2");
  });
  const std::string mine = claimed(now, "w-1");
  ctx.Assert(fired, "claimNext never touched training:queue");
  std::vector<std::string> winners;
  if (mine == "run-a") winners.push_back("w-1");
  if (theirs == "run-a") winners.push_back("w-2");
  ctx.Assert(winners.size() == 1,
             "two schedulers claimed run-a at once and %d got it (%q): the other claim landed between your read of the head and your ZREM. Read, remove and lease in one Lua script",
             winners.size(), winners);
  ctx.Equal(ctx.Redis.Get("training:lease:run-a").value_or(""), winners[0], "training:lease:run-a must name the winner of the claim");
  ctx.Equal(runs::get("run-a")->worker, winners[0], "the run row's worker must be the winner of the claim");
}

void CheckConfirmGuarded(harness::Ctx& ctx) {
  const long long t0 = ctx.Clock.Now();
  stateEnqueue("run-a", 1, t0);
  ctx.Equal(claimed(t0, "w-1"), "run-a", "the only queued run must be claimed");
  ctx.Clock.Advance(16);  // w-1 died during startup
  ctx.Equal(reapExpired(t0 + 16000), 1, "the lease of run-a ran out: reapExpired must return it");
  ctx.Equal(claimed(t0 + 16000, "w-2"), "run-a", "run-a must be claimable again once its lease ran out");
  const bool late = confirmStart("run-a", "w-1");
  ctx.Assert(!late, "w-1, whose lease ran out and whose run went to w-2, confirmed run-a: two workers would train it. Confirm only for the worker the lease names");
  const auto run = runs::get("run-a");
  ctx.Assert(run->state == "starting" && run->worker == "w-2", "after the late confirm the run reads state %q worker %q, expected starting on w-2", run->state, run->worker);
  ctx.Equal(confirmStart("run-a", "w-2"), true, "the worker that holds the lease must be able to confirm");
  ctx.Equal(runs::get("run-a")->state, "running", "a confirmed run's state");
  ctx.Assert(!ctx.Redis.ZScore("training:leases", "run-a").has_value(), "a confirmed run left its deadline in training:leases: the reaper would requeue a running run");
}

void CheckReapKeepsPosition(harness::Ctx& ctx) {
  const long long t0 = ctx.Clock.Now();
  stateEnqueue("run-a", 0, t0);
  ctx.Equal(claimed(t0, "w-1"), "run-a", "the only queued run must be claimed");
  stateEnqueue("run-b", 0, t0 + 5000);
  stateEnqueue("run-c", 1, t0 + 100);
  ctx.Equal(reapExpired(t0 + 1000), 0, "reapExpired must leave a lease that has not run out; the runs reaped");
  ctx.Clock.Advance(16);  // w-1 died during startup
  ctx.Equal(reapExpired(t0 + 16000), 1, "the lease of run-a ran out: reapExpired must return it");
  const double score = ctx.Redis.ZScore("training:queue", "run-a").value_or(-1);
  ctx.Assert(static_cast<long long>(score) == t0, "run-a came back with score %.0f, expected its original position %d (band 0, submitted at %d)", score, t0, t0);
  std::vector<std::string> order;
  for (int i = 0; i < 3; i++) order.push_back(claimed(t0 + 16000, "w-2"));
  ctx.Equal(order, {"run-a", "run-b", "run-c"}, "after the reap run-a, submitted before run-b, must keep its place; the order");
}
`,
  },
  hints: [
    'Kill a worker while its run is starting: the run comes back at the end of the queue. Two scheduler replicas sometimes start the same run on two GPUs, and inside a band the oldest run is not served first.',
    'A score of the band alone ties every run in it. Between `ZRANGE` and `ZREM` another replica can read the same head, and the confirm never asks who holds the lease. The reaper scores by the time it ran.',
    "Score with `band * BAND_SPAN_MS + enqueued_at_ms`. Claim in one script that also `HSET`s the head's `ZSCORE` as `position`; confirm only when `GET` of the lease equals `ARGV[1]`; reap by `ZADD` of `HGET … position`.",
  ],
  debrief: `Each of the three scripts answers one question that must not change while it is being answered: which run is at the head, who holds this lease, which leases ran out. A lease is what turns "popped" into "being started": the run is out of the queue, yet nothing is lost, because the deadline in \`training:leases\` brings it back if the worker never confirms. Saving the head's score at claim time is what lets the reaper return a run to its place instead of punishing it for a crash it did not cause. Slurm and Kubernetes schedulers add a heartbeat that extends the lease while a long image pull runs, and count how often one run is reaped so a run that always crashes at startup stops being retried.`,
};
