import type {Step} from '@/lib/types';

export const trainingStateStep: Step = {
  id: 'state',
  title: 'Redis queue positions and lease-based holds',
  concept: 'redis',
  file: 'state',
  focus: ['scheduler', 'redis', 'worker'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the queue half of
\`trainsched\`: a run goes in with \`ZADD <priority>\`, comes out with \`ZPOPMIN\`, and a boost writes a
key of its own. It serves the demo — one run, one band, one worker — and it hides the two flaws this
step is about: a start that never happened loses the run, and a priority boost leaves the run in two
places at once. Review it like the person who owns the fleet, fix it, and prove the fix.

Implement the Redis side of the scheduler: the queue a run waits in and the lease the scheduler holds
while a worker starts it.

- **One position per run, derived from the band and the age.** The queue is the sorted set
  \`training:queue\` and a run's score is \`band * EPOCH_MS + enqueued_at_ms\`, with \`band\`,
  \`priority\`, \`enqueued_at_ms\` and \`state\` kept in the hash \`training:run:{run_id}\`. The draft
  scores the raw priority with no age term, so every run in a band ties on the same score and a run
  submitted a second ago can sort ahead of one that has been waiting an hour.
- **A move is one member's score, never a second key.** \`boost(run_id, band)\` must move the run
  atomically: a Lua \`EVAL\` (a registered script, or an equivalent atomic \`ZADD\` that replaces the
  same member's score) that rewrites the run's score inside \`training:queue\` and the \`band\` field of
  its hash together. The draft writes \`SET training:queue:{band}:{run_id}\`, so the sorted set the
  scheduler actually polls keeps the old position and the boost lives in a key nobody reads.
- **Starting a run is a lease, not a pop.** \`claim_start(run_id, worker)\` claims the run with
  \`SET training:lease:{run_id} <worker> NX EX LEASE_TTL_S\` (\`15 s\`) and records the deadline in
  the \`training:leases\` sorted set, then drops the run from \`training:queue\` — all before the
  worker is asked to start anything. A claim that returns \`0\` means another scheduler owns the
  start: leave the run alone and take the next one. The TTL is short enough that a crashed start is
  retried inside a reconcile window and long enough for the worker's \`StartRun\` to land.
- **A dead start returns the run, with its band intact.** \`reap_expired(now_ms)\` reads the expired
  deadlines with \`ZRANGEBYSCORE training:leases 0 <now_ms>\`, reads each run's band back with
  \`HGET training:run:{run_id} band\`, scores the run into \`training:queue\` again at
  \`band * EPOCH_MS + enqueued_at_ms\`, and sets its state back to \`queued\`. The band comes from the
  run's own record, never from a default: a boosted run must not re-enter as the lowest band.

**Failure mode the checks target.** The pop that means "started" is the quiet one: the demo's worker
always comes up, so nobody notices that the run left the queue before it left the machine — a crash
between the pop and the process start makes a queued run vanish with no error at all, and it is gone
for good. The duplicate position is the one that costs a second GPU: a boost writes a fresh key, the
sorted set still holds the old member, and the run is started once per position it occupies. Both
flaws are invisible to a single-run demo, and both are checked below.`,
  sequence: {
    participants: ['Scheduler', 'Redis', 'Training worker', 'Queue reaper'],
    messages: [
      {
        from: 'Scheduler',
        to: 'Redis',
        label: 'EVAL enqueue · ZADD training:queue band*EPOCH_MS+now run_7f3a',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Scheduler', label: '1 · score 1700003600451 · band 0 in the run hash', kind: 'reply'},
      {
        from: 'Scheduler',
        to: 'Redis',
        label: 'EVAL claim_start · SET training:lease:run_7f3a NX EX 15 · ZADD training:leases',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Scheduler', label: '1 · deadline 1700003619000 · run off the queue', kind: 'reply'},
      {from: 'Scheduler', to: 'Training worker', label: 'StartRun(run_7f3a) only after the claim', kind: 'sync'},
      {from: 'Scheduler', to: 'Redis', label: 'EVAL boost · ZADD the same member a new score', kind: 'sync'},
      {from: 'Queue reaper', to: 'Redis', label: 'EVAL reap · ZRANGEBYSCORE training:leases 0 now', kind: 'sync'},
      {from: 'Redis', to: 'Queue reaper', label: 'run_7f3a back in the queue at band 0 · state queued', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'queue-position',
      title: 'Scores a position from the band and the enqueue time',
      detail:
        'The position is `band * EPOCH_MS + enqueued_at_ms`, computed once by `position_score`, and `band`, `priority`, `enqueued_at_ms` and `state` are written to the run hash. The draft scores the raw priority, so a band 0 run with priority 9 and one with priority 7 differ by two points while nothing records that one of them waited an hour: the band must decide first and the millisecond only breaks ties inside it.',
      match: {
        python: {all: [/def position_score\(/, /band\s*\*\s*EPOCH_MS/, /['"]enqueued_at_ms['"]/, /['"]band['"]/]},
        typescript: {
          all: [/function positionScore\(/, /band\s*\*\s*EPOCH_MS/, /['"]enqueued_at_ms['"]/, /['"]band['"]/],
        },
        go: {all: [/func positionScore\(/, /int64\(band\)\*epochMs/, /['"]enqueued_at_ms['"]/, /['"]band['"]/]},
        scala: {all: [/def positionScore\(/, /band\s*\*\s*EpochMs/, /['"]enqueued_at_ms['"]/, /['"]band['"]/]},
        cpp: {all: [/positionScore\(/, /band\s*\*\s*kEpochMs/, /['"]enqueued_at_ms['"]/, /['"]band['"]/]},
      },
    },
    {
      id: 'single-position',
      title: 'A boost moves the run’s score instead of writing a second key',
      detail:
        '`boost` runs one Lua `EVAL` (a registered script) that `ZSCORE`s the run, `ZADD`s the same member with its new score and updates the `band` field of the run hash, so the run occupies exactly one position no matter how two schedulers interleave. The draft writes `SET training:queue:{band}:{run_id}`: the sorted set the scheduler polls keeps the old member, and the same run now has two positions, one of which is invisible to every reader.',
      match: {
        python: {all: [/MOVE_SCRIPT/, /\.eval\(\s*MOVE_SCRIPT/, /ZSCORE/, /ZADD/]},
        typescript: {all: [/MOVE_SCRIPT/, /\.eval\(\s*MOVE_SCRIPT/, /ZSCORE/, /ZADD/]},
        go: {all: [/moveScript/, /NewScript\(/, /\.Run\(/, /ZSCORE/, /ZADD/]},
        scala: {all: [/MoveLua/, /\.eval\(\s*MoveLua/, /ZSCORE/, /ZADD/]},
        cpp: {all: [/kMoveLua/, /eval<[^>]*>\(\s*kMoveLua/, /ZSCORE/, /ZADD/]},
      },
    },
    {
      id: 'start-lease',
      title: 'A start is claimed with a lease before the worker is asked',
      detail:
        '`claim_start(run_id, worker)` claims the start with `SET training:lease:{run_id} <worker> NX EX LEASE_TTL_S` (`15 s`) and records the deadline in the `training:leases` sorted set, so a second scheduler that loses the claim leaves the run to its owner instead of starting it twice. The draft pops the run and calls it started: with no `NX`, no TTL and no deadline there is nothing to take over, and nothing that knows the start is still in flight.',
      match: {
        python: {all: [/LEASE_TTL_S/, /'NX'/, /'EX'/, /training:leases/, /ZADD/, /def claim_start\(/]},
        typescript: {all: [/LEASE_TTL_S/, /'NX'/, /'EX'/, /training:leases/, /ZADD/, /claimStart\(/]},
        go: {all: [/leaseTTLS/, /'NX'/, /'EX'/, /training:leases/, /ZADD/, /func claimStart\(/]},
        scala: {all: [/LeaseTtlS/, /'NX'/, /'EX'/, /training:leases/, /ZADD/, /def claimStart\(/]},
        cpp: {all: [/kLeaseTtlS/, /'NX'/, /'EX'/, /training:leases/, /ZADD/, /claimStart\(/]},
      },
    },
    {
      id: 'lease-recovery',
      title: 'Expired start leases return the run with its band intact',
      detail:
        '`reap_expired` finds the leases nobody renewed with `ZRANGEBYSCORE training:leases 0 <now_ms>`, reads each run’s `band` back from its hash with `HGET`, re-`ZADD`s the run into `training:queue` at `band * EPOCH_MS + enqueued_at_ms` and sets its state to `queued`. The band is read from the run’s own record and never recomputed from a default, or a reaped high-priority run re-enters the queue behind everything it already outranked.',
      match: {
        python: {all: [/REAP_SCRIPT/, /ZRANGEBYSCORE/, /HGET/, /['"]band['"]/, /'queued'/, /def reap_expired\(/]},
        typescript: {all: [/REAP_SCRIPT/, /ZRANGEBYSCORE/, /HGET/, /['"]band['"]/, /'queued'/, /reapExpired\(/]},
        go: {all: [/reapScript/, /ZRANGEBYSCORE/, /HGET/, /['"]band['"]/, /'queued'/, /func reapExpired\(/]},
        scala: {all: [/ReapLua/, /ZRANGEBYSCORE/, /HGET/, /['"]band['"]/, /'queued'/, /def reapExpired\(/]},
        cpp: {all: [/kReapLua/, /ZRANGEBYSCORE/, /HGET/, /['"]band['"]/, /'queued'/, /reapExpired\(/]},
      },
    },
    {
      id: 'no-plain-set',
      title: 'No plain SET on a queue key',
      detail:
        'The queue is one sorted set and a run is one member of it, so a plain `SET` on a `training:queue…` key is the duplicate-position flaw: the sorted set keeps its old member and the boost is only visible to whoever happens to read the other key. Position writes end in `ZADD`, and the only key a start writes with `SET` is `training:lease:{run_id}`, which is a lease, not a position.',
      match: {
        python: {
          all: [/training:queue/],
          none: [/\.set\(\s*queue_key\(/, /\.set\(\s*f?['"]training:queue/, /['"]training:queue:\{band\}['"]/],
        },
        typescript: {
          all: [/training:queue/],
          none: [/\.set\(\s*queueKey\(/, /\.set\([^)\n]*training:queue/, /training:queue:\$\{band\}/],
        },
        go: {
          all: [/training:queue/],
          none: [/\.Set\(\s*ctx\s*,\s*queueKey\(/, /\.Set\([^)\n]*training:queue/, /"training:queue:"\s*\+/],
        },
        scala: {
          all: [/training:queue/],
          none: [/\.set\(\s*queueKey\(/, /\.set\([^)\n]*training:queue/, /s"training:queue:\$band/],
        },
        cpp: {
          all: [/training:queue/],
          none: [/\.set\(\s*queueKey\(/, /\.set\([^)\n]*training:queue/, /"training:queue:"\s*\+/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

import redis as redis_client

logger = logging.getLogger("trainsched")

QUEUE_KEY = "training:queue"


def queue_key(band: int, run_id: str) -> str:
    """Where this draft parks a run after a boost."""
    return f"training:queue:{band}:{run_id}"


class TrainingQueue:
    """Queue positions and start claims for training runs."""

    def __init__(self, redis: "redis_client.Redis") -> None:
        self.redis = redis

    def enqueue(self, run_id: str, band: int, priority: int) -> None:
        # TODO: this draft scores the queue with the raw priority and no age term, so every run in
        # a band ties; a boost writes a per-band key with SET instead of moving the run inside one
        # sorted set, so the run keeps its old position as well; and a start pops the run and calls
        # it started with no lease, so a worker that dies during startup orphans it.
        self.redis.zadd(QUEUE_KEY, {run_id: priority})

    def boost(self, run_id: str, band: int) -> None:
        self.redis.set(queue_key(band, run_id), time.time() * 1000)
        logger.info("run boosted run_id=%s band=%d", run_id, band)

    def start(self, worker: str) -> str | None:
        popped = self.redis.zpopmin(QUEUE_KEY)
        if not popped:
            return None
        run_id = popped[0][0]
        logger.info("run started run_id=%s worker=%s", run_id, worker)
        return run_id

    def reap_expired(self, now_ms: int) -> int:
        # TODO: nothing ever returns an interrupted start to the queue.
        return 0
`,
      solution: `import logging
import time

import redis as redis_client

logger = logging.getLogger("trainsched")

LEASE_TTL_S = 15
EPOCH_MS = 1_700_000_000_000
QUEUE_KEY = "training:queue"
LEASES_KEY = "training:leases"

# One member, one position: the score mixes the band with the enqueue time, so the band decides
# first and the millisecond only breaks ties inside it.
ENQUEUE_SCRIPT = """
redis.call('HSET', KEYS[2], 'band', ARGV[1], 'priority', ARGV[2], 'state', 'queued',
           'enqueued_at_ms', ARGV[3])
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5])
return 1
"""

# A boost is a move, not an insert: ZADD on the same member replaces its score, so the run cannot
# hold a position in the sorted set and another one in a key of its own.
MOVE_SCRIPT = """
local previous = redis.call('ZSCORE', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('HSET', KEYS[2], 'band', ARGV[3])
if previous then
  return 1
end
return 0
"""

# The claim is the lease: whoever wins SET NX owns the start, and the deadline goes into the leases
# sorted set so the reaper can find a start that was never confirmed.
CLAIM_START_SCRIPT = """
local claimed = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if not claimed then
  return 0
end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
redis.call('ZREM', KEYS[3], ARGV[4])
redis.call('HSET', KEYS[4], 'state', 'starting')
return 1
"""

# A dead start gives the run back. The band comes from the run's own hash, never from a default, so
# a high-priority run returns to the queue in the band it was admitted with.
REAP_SCRIPT = """
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1])
for _, run_id in ipairs(expired) do
  local run_key = 'training:run:' .. run_id
  local band = tonumber(redis.call('HGET', run_key, 'band')) or 0
  local enqueued_at_ms = tonumber(redis.call('HGET', run_key, 'enqueued_at_ms')) or tonumber(ARGV[1])
  redis.call('ZREM', KEYS[1], run_id)
  redis.call('DEL', 'training:lease:' .. run_id)
  redis.call('HSET', run_key, 'state', 'queued')
  redis.call('ZADD', KEYS[2], band * tonumber(ARGV[2]) + enqueued_at_ms, run_id)
end
return #expired
"""


def position_score(band: int, enqueued_at_ms: int) -> int:
    return band * EPOCH_MS + enqueued_at_ms


def run_key(run_id: str) -> str:
    return f"training:run:{run_id}"


def lease_key(run_id: str) -> str:
    return f"training:lease:{run_id}"


class TrainingQueue:
    """One queue position per run, handed to a worker under a start lease."""

    def __init__(self, redis: "redis_client.Redis") -> None:
        self.redis = redis

    def enqueue(self, run_id: str, band: int, priority: int, now_ms: int | None = None) -> int:
        enqueued_at_ms = int(time.time() * 1000) if now_ms is None else now_ms
        score = position_score(band, enqueued_at_ms)
        self.redis.eval(
            ENQUEUE_SCRIPT,
            2,
            QUEUE_KEY,
            run_key(run_id),
            band,
            priority,
            enqueued_at_ms,
            score,
            run_id,
        )
        logger.info("run queued run_id=%s band=%d score=%d", run_id, band, score)
        return score

    def boost(self, run_id: str, band: int) -> bool:
        score = position_score(band, int(time.time() * 1000))
        moved = self.redis.eval(MOVE_SCRIPT, 2, QUEUE_KEY, run_key(run_id), run_id, score, band)
        logger.info("run boosted run_id=%s band=%d score=%d", run_id, band, score)
        return moved == 1

    def claim_start(self, run_id: str, worker: str, now_ms: int) -> bool:
        deadline = now_ms + LEASE_TTL_S * 1000
        claimed = self.redis.eval(
            CLAIM_START_SCRIPT,
            4,
            lease_key(run_id),
            LEASES_KEY,
            QUEUE_KEY,
            run_key(run_id),
            worker,
            LEASE_TTL_S,
            deadline,
            run_id,
        )
        if claimed != 1:
            logger.info("start already leased run_id=%s worker=%s", run_id, worker)
            return False
        return True

    def next_for_start(self, worker: str, now_ms: int) -> str | None:
        for run_id in self.redis.zrange(QUEUE_KEY, 0, 9):
            if self.claim_start(run_id, worker, now_ms):
                return run_id
        return None

    def reap_expired(self, now_ms: int) -> int:
        reaped = self.redis.eval(REAP_SCRIPT, 2, LEASES_KEY, QUEUE_KEY, now_ms, EPOCH_MS)
        if reaped > 0:
            logger.info("start leases reaped reaped=%s", reaped)
        return int(reaped)
`,
    },
    typescript: {
      starter: `/** The scheduler's Redis queue: a model-generated draft that pops a run and calls it started. */
import {Redis} from 'ioredis';

export const r = new Redis('redis://redis:6379');

const QUEUE_KEY = 'training:queue';

function queueKey(band: number, runId: string): string {
  return \`training:queue:\${band}:\${runId}\`;
}

export async function enqueue(runId: string, band: number, priority: number): Promise<void> {
  // TODO: this draft scores the queue with the raw priority and no age term, so every run in a band
  // ties; a boost writes a per-band key with set instead of moving the run inside one sorted set, so
  // the run keeps its old position as well; and a start pops the run and calls it started with no
  // lease, so a worker that dies during startup orphans it.
  await r.zadd(QUEUE_KEY, priority, runId);
}

export async function boost(runId: string, band: number): Promise<void> {
  await r.set(queueKey(band, runId), Date.now());
}

export async function start(worker: string): Promise<string | null> {
  const popped = await r.zpopmin(QUEUE_KEY, 1);
  if (popped.length === 0) return null;
  void worker;
  return popped[0];
}

export async function reapExpired(_nowMs: number): Promise<number> {
  // TODO: nothing ever returns an interrupted start to the queue.
  return 0;
}
`,
      solution: `/** The scheduler's Redis queue: one position per run, handed to a worker under a start lease. */
import {Redis} from 'ioredis';

const LEASE_TTL_S = 15;
const EPOCH_MS = 1_700_000_000_000;
const QUEUE_KEY = 'training:queue';
const LEASES_KEY = 'training:leases';

// One member, one position: the score mixes the band with the enqueue time, so the band decides
// first and the millisecond only breaks ties inside it.
const ENQUEUE_SCRIPT = \`
redis.call('HSET', KEYS[2], 'band', ARGV[1], 'priority', ARGV[2], 'state', 'queued',
           'enqueued_at_ms', ARGV[3])
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5])
return 1
\`;

// A boost is a move, not an insert: ZADD on the same member replaces its score, so the run cannot
// hold a position in the sorted set and another one in a key of its own.
const MOVE_SCRIPT = \`
local previous = redis.call('ZSCORE', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('HSET', KEYS[2], 'band', ARGV[3])
if previous then
  return 1
end
return 0
\`;

// The claim is the lease: whoever wins SET NX owns the start, and the deadline goes into the leases
// sorted set so the reaper can find a start that was never confirmed.
const CLAIM_START_SCRIPT = \`
local claimed = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if not claimed then
  return 0
end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
redis.call('ZREM', KEYS[3], ARGV[4])
redis.call('HSET', KEYS[4], 'state', 'starting')
return 1
\`;

// A dead start gives the run back. The band comes from the run's own hash, never from a default, so
// a high-priority run returns to the queue in the band it was admitted with.
const REAP_SCRIPT = \`
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1])
for _, run_id in ipairs(expired) do
  local run_key = 'training:run:' .. run_id
  local band = tonumber(redis.call('HGET', run_key, 'band')) or 0
  local enqueued_at_ms = tonumber(redis.call('HGET', run_key, 'enqueued_at_ms')) or tonumber(ARGV[1])
  redis.call('ZREM', KEYS[1], run_id)
  redis.call('DEL', 'training:lease:' .. run_id)
  redis.call('HSET', run_key, 'state', 'queued')
  redis.call('ZADD', KEYS[2], band * tonumber(ARGV[2]) + enqueued_at_ms, run_id)
end
return #expired
\`;

function positionScore(band: number, enqueuedAtMs: number): number {
  return band * EPOCH_MS + enqueuedAtMs;
}

const runKey = (runId: string): string => \`training:run:\${runId}\`;
const leaseKey = (runId: string): string => \`training:lease:\${runId}\`;

export async function enqueue(
  redis: Redis,
  runId: string,
  band: number,
  priority: number,
  nowMs: number,
): Promise<number> {
  const score = positionScore(band, nowMs);
  await redis.eval(ENQUEUE_SCRIPT, 2, QUEUE_KEY, runKey(runId), band, priority, nowMs, score, runId);
  return score;
}

export async function boost(redis: Redis, runId: string, band: number, nowMs: number): Promise<boolean> {
  const score = positionScore(band, nowMs);
  const moved = (await redis.eval(MOVE_SCRIPT, 2, QUEUE_KEY, runKey(runId), runId, score, band)) as number;
  return Number(moved) === 1;
}

export async function claimStart(redis: Redis, runId: string, worker: string, nowMs: number): Promise<boolean> {
  const deadline = nowMs + LEASE_TTL_S * 1000;
  const claimed = (await redis.eval(
    CLAIM_START_SCRIPT,
    4,
    leaseKey(runId),
    LEASES_KEY,
    QUEUE_KEY,
    runKey(runId),
    worker,
    LEASE_TTL_S,
    deadline,
    runId,
  )) as number;
  return Number(claimed) === 1;
}

export async function nextForStart(redis: Redis, worker: string, nowMs: number): Promise<string | null> {
  const candidates = await redis.zrange(QUEUE_KEY, 0, 9);
  for (const runId of candidates) {
    if (await claimStart(redis, runId, worker, nowMs)) return runId;
  }
  return null;
}

export async function reapExpired(redis: Redis, nowMs: number): Promise<number> {
  return Number(await redis.eval(REAP_SCRIPT, 2, LEASES_KEY, QUEUE_KEY, nowMs, EPOCH_MS));
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

const queueName = "training:queue"

func queueKey(band int, runID string) string {
	return "training:queue:" + strconv.Itoa(band) + ":" + runID
}

func enqueue(ctx context.Context, rdb *redis.Client, runID string, band, priority int) error {
	// TODO: this draft scores the queue with the raw priority and no age term, so every run in a
	// band ties; a boost writes a per-band key with Set instead of moving the run inside one sorted
	// set, so the run keeps its old position as well; and a start pops the run and calls it started
	// with no lease, so a worker that dies during startup orphans it.
	return rdb.ZAdd(ctx, queueName, redis.Z{Score: float64(priority), Member: runID}).Err()
}

func boost(ctx context.Context, rdb *redis.Client, runID string, band int) error {
	return rdb.Set(ctx, queueKey(band, runID), time.Now().UnixMilli(), 0).Err()
}

func start(ctx context.Context, rdb *redis.Client, worker string) (string, error) {
	popped, err := rdb.ZPopMin(ctx, queueName, 1).Result()
	if err != nil || len(popped) == 0 {
		return "", err
	}
	_ = worker
	return popped[0].Member.(string), nil
}

func reapExpired(ctx context.Context, rdb *redis.Client, nowMS int64) (int64, error) {
	// TODO: nothing ever returns an interrupted start to the queue.
	return 0, nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

const (
	leaseTTLS int64 = 15
	epochMs   int64 = 1_700_000_000_000
	queueKey        = "training:queue"
	leasesKey       = "training:leases"
)

// One member, one position: the score mixes the band with the enqueue time, so the band decides
// first and the millisecond only breaks ties inside it.
var enqueueScript = redis.NewScript(\`
redis.call('HSET', KEYS[2], 'band', ARGV[1], 'priority', ARGV[2], 'state', 'queued',
           'enqueued_at_ms', ARGV[3])
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5])
return 1
\`)

// A boost is a move, not an insert: ZADD on the same member replaces its score, so the run cannot
// hold a position in the sorted set and another one in a key of its own.
var moveScript = redis.NewScript(\`
local previous = redis.call('ZSCORE', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('HSET', KEYS[2], 'band', ARGV[3])
if previous then
  return 1
end
return 0
\`)

// The claim is the lease: whoever wins SET NX owns the start, and the deadline goes into the leases
// sorted set so the reaper can find a start that was never confirmed.
var claimStartScript = redis.NewScript(\`
local claimed = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if not claimed then
  return 0
end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
redis.call('ZREM', KEYS[3], ARGV[4])
redis.call('HSET', KEYS[4], 'state', 'starting')
return 1
\`)

// A dead start gives the run back. The band comes from the run's own hash, never from a default.
var reapScript = redis.NewScript(\`
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1])
for _, run_id in ipairs(expired) do
  local run_key = 'training:run:' .. run_id
  local band = tonumber(redis.call('HGET', run_key, 'band')) or 0
  local enqueued_at_ms = tonumber(redis.call('HGET', run_key, 'enqueued_at_ms')) or tonumber(ARGV[1])
  redis.call('ZREM', KEYS[1], run_id)
  redis.call('DEL', 'training:lease:' .. run_id)
  redis.call('HSET', run_key, 'state', 'queued')
  redis.call('ZADD', KEYS[2], band * tonumber(ARGV[2]) + enqueued_at_ms, run_id)
end
return #expired
\`)

func positionScore(band int, enqueuedAtMs int64) int64 {
	return int64(band)*epochMs + enqueuedAtMs
}

func runKey(runID string) string   { return "training:run:" + runID }
func leaseKey(runID string) string { return "training:lease:" + runID }

func enqueue(ctx context.Context, rdb *redis.Client, runID string, band, priority int, nowMS int64) (int64, error) {
	score := positionScore(band, nowMS)
	err := enqueueScript.Run(ctx, rdb, []string{queueKey, runKey(runID)},
		band, priority, nowMS, score, runID).Err()
	return score, err
}

func boost(ctx context.Context, rdb *redis.Client, runID string, band int, nowMS int64) (bool, error) {
	score := positionScore(band, nowMS)
	moved, err := moveScript.Run(ctx, rdb, []string{queueKey, runKey(runID)}, runID, score, band).Int()
	if err != nil {
		return false, err
	}
	return moved == 1, nil
}

func claimStart(ctx context.Context, rdb *redis.Client, runID, worker string, nowMS int64) (bool, error) {
	deadline := nowMS + leaseTTLS*1000
	claimed, err := claimStartScript.Run(ctx, rdb,
		[]string{leaseKey(runID), leasesKey, queueKey, runKey(runID)},
		worker, leaseTTLS, deadline, runID).Int()
	if err != nil {
		return false, err
	}
	return claimed == 1, nil
}

func nextForStart(ctx context.Context, rdb *redis.Client, worker string, nowMS int64) (string, error) {
	candidates, err := rdb.ZRange(ctx, queueKey, 0, 9).Result()
	if err != nil {
		return "", err
	}
	for _, runID := range candidates {
		claimed, err := claimStart(ctx, rdb, runID, worker, nowMS)
		if err != nil {
			return "", err
		}
		if claimed {
			return runID, nil
		}
	}
	return "", nil
}

func reapExpired(ctx context.Context, rdb *redis.Client, nowMS int64) (int64, error) {
	return reapScript.Run(ctx, rdb, []string{leasesKey, queueKey}, nowMS, epochMs).Int64()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object TrainingQueue {
  val QueueKey = "training:queue"

  val redis = new Jedis("redis", 6379)

  def queueKey(band: Int, runId: String): String = s"training:queue:$band:$runId"

  def enqueue(runId: String, band: Int, priority: Int): Unit = {
    // TODO: this draft scores the queue with the raw priority and no age term, so every run in a
    // band ties; a boost writes a per-band key with set instead of moving the run inside one sorted
    // set, so the run keeps its old position as well; and a start pops the run and calls it started
    // with no lease, so a worker that dies during startup orphans it.
    redis.zadd(QueueKey, priority.toDouble, runId)
  }

  def boost(runId: String, band: Int): Unit = {
    redis.set(queueKey(band, runId), System.currentTimeMillis().toString)
  }

  def start(worker: String): Option[String] = {
    val popped = redis.zpopmin(QueueKey)
    if (popped == null) None else Some(popped.getElement)
  }

  def reapExpired(nowMs: Long): Long = {
    // TODO: nothing ever returns an interrupted start to the queue.
    0L
  }
}
`,
      solution: `import java.util

import redis.clients.jedis.Jedis

object TrainingQueue {
  val LeaseTtlS: Long = 15
  val EpochMs: Long = 1700000000000L
  val QueueKey: String = "training:queue"
  val LeasesKey: String = "training:leases"

  // One member, one position: the score mixes the band with the enqueue time, so the band decides
  // first and the millisecond only breaks ties inside it.
  val EnqueueLua: String =
    """
redis.call('HSET', KEYS[2], 'band', ARGV[1], 'priority', ARGV[2], 'state', 'queued',
           'enqueued_at_ms', ARGV[3])
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5])
return 1
"""

  // A boost is a move, not an insert: ZADD on the same member replaces its score, so the run cannot
  // hold a position in the sorted set and another one in a key of its own.
  val MoveLua: String =
    """
local previous = redis.call('ZSCORE', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('HSET', KEYS[2], 'band', ARGV[3])
if previous then
  return 1
end
return 0
"""

  // The claim is the lease: whoever wins SET NX owns the start, and the deadline goes into the
  // leases sorted set so the reaper can find a start that was never confirmed.
  val ClaimStartLua: String =
    """
local claimed = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if not claimed then
  return 0
end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
redis.call('ZREM', KEYS[3], ARGV[4])
redis.call('HSET', KEYS[4], 'state', 'starting')
return 1
"""

  // A dead start gives the run back. The band comes from the run's own hash, never from a default.
  val ReapLua: String =
    """
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1])
for _, run_id in ipairs(expired) do
  local run_key = 'training:run:' .. run_id
  local band = tonumber(redis.call('HGET', run_key, 'band')) or 0
  local enqueued_at_ms = tonumber(redis.call('HGET', run_key, 'enqueued_at_ms')) or tonumber(ARGV[1])
  redis.call('ZREM', KEYS[1], run_id)
  redis.call('DEL', 'training:lease:' .. run_id)
  redis.call('HSET', run_key, 'state', 'queued')
  redis.call('ZADD', KEYS[2], band * tonumber(ARGV[2]) + enqueued_at_ms, run_id)
end
return #expired
"""

  def positionScore(band: Int, enqueuedAtMs: Long): Long = band * EpochMs + enqueuedAtMs

  def runKey(runId: String): String = s"training:run:$runId"
  def leaseKey(runId: String): String = s"training:lease:$runId"

  def enqueue(jedis: Jedis, runId: String, band: Int, priority: Int, nowMs: Long): Long = {
    val score = positionScore(band, nowMs)
    jedis.eval(
      EnqueueLua,
      util.List.of(QueueKey, runKey(runId)),
      util.List.of(band.toString, priority.toString, nowMs.toString, score.toString, runId),
    )
    score
  }

  def boost(jedis: Jedis, runId: String, band: Int, nowMs: Long): Boolean = {
    val score = positionScore(band, nowMs)
    val moved = jedis
      .eval(MoveLua, util.List.of(QueueKey, runKey(runId)), util.List.of(runId, score.toString, band.toString))
      .asInstanceOf[java.lang.Long]
    moved.longValue() == 1L
  }

  def claimStart(jedis: Jedis, runId: String, worker: String, nowMs: Long): Boolean = {
    val deadline = nowMs + LeaseTtlS * 1000
    val claimed = jedis
      .eval(
        ClaimStartLua,
        util.List.of(leaseKey(runId), LeasesKey, QueueKey, runKey(runId)),
        util.List.of(worker, LeaseTtlS.toString, deadline.toString, runId),
      )
      .asInstanceOf[java.lang.Long]
    claimed.longValue() == 1L
  }

  def nextForStart(jedis: Jedis, worker: String, nowMs: Long): Option[String] = {
    val candidates = jedis.zrange(QueueKey, 0, 9)
    import scala.jdk.CollectionConverters._
    candidates.asScala.find(runId => claimStart(jedis, runId, worker, nowMs))
  }

  def reapExpired(jedis: Jedis, nowMs: Long): Long = {
    val reaped = jedis
      .eval(ReapLua, util.List.of(LeasesKey, QueueKey), util.List.of(nowMs.toString, EpochMs.toString))
      .asInstanceOf[java.lang.Long]
    reaped.longValue()
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

const std::string kQueueKey = "training:queue";

std::string queueKey(int band, const std::string& runId) {
  return "training:queue:" + std::to_string(band) + ":" + runId;
}

void enqueue(sw::redis::Redis& redis, const std::string& runId, int band, int priority) {
  // TODO: this draft scores the queue with the raw priority and no age term, so every run in a band
  // ties; a boost writes a per-band key with set instead of moving the run inside one sorted set, so
  // the run keeps its old position as well; and a start pops the run and calls it started with no
  // lease, so a worker that dies during startup orphans it.
  redis.zadd(kQueueKey, runId, priority);
}

void boost(sw::redis::Redis& redis, const std::string& runId, int band) {
  redis.set(queueKey(band, runId), std::to_string(nowMs()));
}

std::optional<std::string> start(sw::redis::Redis& redis, const std::string& worker) {
  auto popped = redis.zpopmin(kQueueKey);
  if (!popped) return std::nullopt;
  return popped->first;
}

long long reapExpired(sw::redis::Redis& redis, long long nowMs) {
  // TODO: nothing ever returns an interrupted start to the queue.
  return 0;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

constexpr long long kLeaseTtlS = 15;
constexpr long long kEpochMs = 1700000000000LL;
const std::string kQueueKey = "training:queue";
const std::string kLeasesKey = "training:leases";

// One member, one position: the score mixes the band with the enqueue time, so the band decides
// first and the millisecond only breaks ties inside it.
const std::string kEnqueueLua = R"lua(
redis.call('HSET', KEYS[2], 'band', ARGV[1], 'priority', ARGV[2], 'state', 'queued',
           'enqueued_at_ms', ARGV[3])
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[5])
return 1
)lua";

// A boost is a move, not an insert: ZADD on the same member replaces its score, so the run cannot
// hold a position in the sorted set and another one in a key of its own.
const std::string kMoveLua = R"lua(
local previous = redis.call('ZSCORE', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('HSET', KEYS[2], 'band', ARGV[3])
if previous then
  return 1
end
return 0
)lua";

// The claim is the lease: whoever wins SET NX owns the start, and the deadline goes into the leases
// sorted set so the reaper can find a start that was never confirmed.
const std::string kClaimStartLua = R"lua(
local claimed = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])
if not claimed then
  return 0
end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[4])
redis.call('ZREM', KEYS[3], ARGV[4])
redis.call('HSET', KEYS[4], 'state', 'starting')
return 1
)lua";

// A dead start gives the run back. The band comes from the run's own hash, never from a default.
const std::string kReapLua = R"lua(
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], 0, ARGV[1])
for _, run_id in ipairs(expired) do
  local run_key = 'training:run:' .. run_id
  local band = tonumber(redis.call('HGET', run_key, 'band')) or 0
  local enqueued_at_ms = tonumber(redis.call('HGET', run_key, 'enqueued_at_ms')) or tonumber(ARGV[1])
  redis.call('ZREM', KEYS[1], run_id)
  redis.call('DEL', 'training:lease:' .. run_id)
  redis.call('HSET', run_key, 'state', 'queued')
  redis.call('ZADD', KEYS[2], band * tonumber(ARGV[2]) + enqueued_at_ms, run_id)
end
return #expired
)lua";

long long positionScore(int band, long long enqueuedAtMs) { return band * kEpochMs + enqueuedAtMs; }

std::string runKey(const std::string& runId) { return "training:run:" + runId; }
std::string leaseKey(const std::string& runId) { return "training:lease:" + runId; }

long long enqueue(sw::redis::Redis& redis, const std::string& runId, int band, int priority, long long nowMs) {
  const long long score = positionScore(band, nowMs);
  redis.eval<std::string>(kEnqueueLua, {kQueueKey, runKey(runId)},
                          {std::to_string(band), std::to_string(priority), std::to_string(nowMs),
                           std::to_string(score), runId});
  return score;
}

bool boost(sw::redis::Redis& redis, const std::string& runId, int band, long long nowMs) {
  const long long score = positionScore(band, nowMs);
  const auto moved = redis.eval<long long>(kMoveLua, {kQueueKey, runKey(runId)},
                                           {runId, std::to_string(score), std::to_string(band)});
  return moved == 1;
}

bool claimStart(sw::redis::Redis& redis, const std::string& runId, const std::string& worker, long long nowMs) {
  const long long deadline = nowMs + kLeaseTtlS * 1000;
  const auto claimed = redis.eval<long long>(
      kClaimStartLua, {leaseKey(runId), kLeasesKey, kQueueKey, runKey(runId)},
      {worker, std::to_string(kLeaseTtlS), std::to_string(deadline), runId});
  return claimed == 1;
}

std::optional<std::string> nextForStart(sw::redis::Redis& redis, const std::string& worker, long long nowMs) {
  const auto candidates = redis.zrange(kQueueKey, 0, 9);
  for (const auto& runId : candidates) {
    if (claimStart(redis, runId, worker, nowMs)) return runId;
  }
  return std::nullopt;
}

long long reapExpired(sw::redis::Redis& redis, long long nowMs) {
  return redis.eval<long long>(kReapLua, {kLeasesKey, kQueueKey},
                               {std::to_string(nowMs), std::to_string(kEpochMs)});
}
`,
    },
  },
  hints: [
    'The score has to answer "who goes next" in one number: `band * EPOCH_MS + enqueued_at_ms`. Multiply the band by a fixed epoch so it dominates and the millisecond only breaks ties inside it, and keep `band` in the run hash too — the reaper and `GET /v1/training/runs/{id}` both need the band without re-deriving it from a priority that may since have changed.',
    'A boost is a move, not an insert. `ZADD training:queue <new_score> <run_id>` on the same member replaces its score in place; put the `ZSCORE` read, that `ZADD` and the hash update in one script so the position in the sorted set and the `band` field can never disagree.',
    'Claim before you call the worker, and reap on a timer: `SET training:lease:{run_id} <worker> NX EX 15` plus `ZADD training:leases <deadline> <run_id>` is the claim; `ZRANGEBYSCORE training:leases 0 <now>` finds the leases nobody renewed, and each of those runs goes back to `training:queue` at `band * EPOCH_MS + enqueued_at_ms` with the band read from its own hash.',
  ],
  debrief: `The interviewer is testing whether you can review a queue that is also a lock. The draft looks
right because the demo enqueues one run and starts it: nothing crashes, and no second scheduler
exists to race the first. What it hides is that the pop is not a claim — the run leaves the queue
before it leaves the machine, so a worker that dies during startup loses it silently and
unrecoverably — and that a position written as a key per band is not a position in the sorted set the
scheduler polls, so a boost doubles the run instead of moving it. The fix is one member per run in
one sorted set with a score that carries both the band and the age, a scripted move so the score and
the hash cannot disagree, and a lease whose deadline makes a stalled start recoverable at the band
the run was admitted with rather than at a default. Real schedulers add a heartbeat that renews the
lease while the worker is still starting, an in-flight cap per worker, and a metric for runs that came
back from the reaper — that last number is the earliest honest signal that the fleet is unhealthy.`,
};
