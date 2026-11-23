import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis budget: one Lua script per reservation move',
  concept: 'redis',
  guides: ['atomic-state'],
  file: 'budget',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter keeps a team's GPU-hours under the keys \`finetune/config\` defines:
\`submit(team, job_id, amount)\` pushes the job onto \`ft:queue:{team}\`, reads \`ft:pool:{team}\`, and
when it covers \`amount\` draws it and writes \`ft:reservation:{job_id}\` (\`team\`, \`reserved\`, \`spent\`,
\`state\` = \`queued\`); \`start\` pops the job and sets \`running\`; \`complete(team, job_id, spent)\` returns
\`reserved - spent\` to the pool; \`cancel\` marks the job \`cancelled\` and returns what it spent. Every
move is several commands. The demo moves jobs through the queue. It hides 5 flaws.

**Failure mode the checks target.** The queue fills with jobs the pool did not cover. Two API
replicas read the same balance and both draw, so the pool goes negative and the cluster is
oversubscribed. A completion callback delivered twice hands the remainder back twice, and the next job
over-commits the pool. A cancelled job keeps its hours.

Requirements, each kept by **one Lua script**:

- \`submit\`: check the pool, \`DECRBY\`, write the reservation, then \`RPUSH\`; a pool that cannot cover
  \`amount\` changes nothing and answers false.
- \`start\`: only a \`queued\` reservation becomes \`running\` (false otherwise, and nothing written).
- \`complete\`: only a \`running\` reservation; it returns \`reserved - min(spent, reserved)\` and becomes
  \`completed\`, so a retry returns 0.
- \`cancel\`: a \`queued\` or \`running\` reservation returns \`reserved - spent\`, leaves the queue and
  becomes \`cancelled\`; anything else returns 0.`,
  sequence: {
    participants: ['API', 'Redis'],
    messages: [
      {from: 'API', to: 'Redis', label: 'EVALSHA submit · pool reservation queue · team job amount', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'GET pool ≥ amount · DECRBY · HSET reservation · RPUSH queue', kind: 'sync'},
      {from: 'Redis', to: 'API', label: '1', kind: 'reply'},
      {from: 'API', to: 'Redis', label: 'EVALSHA complete · pool reservation · spent', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: "state == 'running' → INCRBY pool remainder · state completed", kind: 'sync'},
      {from: 'Redis', to: 'API', label: 'hours returned', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'reserve-at-submit',
      title: 'Queues a job only once its hours are reserved',
      detail:
        'A job the pool cannot cover is not queued and gets no reservation; a covered one is queued with reserved = amount and the pool drawn by that much. A pool holding exactly the amount covers it, and an empty pool cannot cover even 1 hour. The starter pushes onto the queue before it looks at the pool.',
      match: {
        python: {order: [/DECRBY/, /RPUSH/], none: [/\.rpush\(/]},
        typescript: {order: [/DECRBY/, /RPUSH/], none: [/\.rpush\(/]},
        go: {order: [/DECRBY/, /RPUSH/], none: [/\.RPush\(/]},
        cpp: {order: [/DECRBY/, /RPUSH/], none: [/redis\.rpush\(/]},
      },
    },
    {
      id: 'atomic-reserve',
      title: 'Tests and draws the pool in one script',
      detail:
        'Another replica drawing 80 hours lands between this submit\u2019s commands: the pool of 100 must not go negative, and exactly the submissions that succeeded are drawn. The starter reads the balance and draws it in separate commands.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(|\.evalsha\(/, /redis\.call\(\s*['"]DECRBY['"]/],
          none: [/\.decrby\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(|\.evalsha\(/, /redis\.call\(\s*['"]DECRBY['"]/],
          none: [/\.decrby\(/],
        },
        go: {all: [/redis\.NewScript\(|\.Eval\(|\.EvalSha\(/, /redis\.call\(\s*['"]DECRBY['"]/], none: [/\.DecrBy\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]DECRBY['"]/], none: [/\.decrby\(/]},
      },
    },
    {
      id: 'start-guard',
      title: 'Starts only a queued reservation',
      detail:
        'A job that never got a reservation, a cancelled one and one already running do not start and nothing is written for them; a queued one becomes running and leaves the queue. A cancel landing between start\u2019s commands is not overwritten. The starter marks any job running.',
      match: {
        python: {all: [/(~=|==)\s*['"]queued['"]/]},
        typescript: {all: [/(~=|==)\s*['"]queued['"]/]},
        go: {all: [/(~=|==)\s*['"]queued['"]/]},
        cpp: {all: [/(~=|==)\s*['"]queued['"]/]},
      },
    },
    {
      id: 'release-once',
      title: 'Returns the remainder once, and never more than was reserved',
      detail:
        'complete(600 reserved, 450 spent) returns 150 and the retry returns 0; a run that overspent returns 0 and takes nothing more from the pool. A job that never started, or was cancelled, completes nothing, and a duplicate callback landing between a completion\u2019s commands returns nothing more. The starter adds reserved - spent to the pool on every call.',
      match: {
        python: {all: [/(~=|==)\s*['"]running['"]/, /redis\.call\(\s*['"]INCRBY['"]/], none: [/\.incrby\(/]},
        typescript: {all: [/(~=|==)\s*['"]running['"]/, /redis\.call\(\s*['"]INCRBY['"]/], none: [/\.incrby\(/]},
        go: {all: [/(~=|==)\s*['"]running['"]/, /redis\.call\(\s*['"]INCRBY['"]/], none: [/\.IncrBy\(/]},
        cpp: {all: [/(~=|==)\s*['"]running['"]/, /redis\.call\(\s*['"]INCRBY['"]/], none: [/\.incrby\(/]},
      },
    },
    {
      id: 'cancel-frees',
      title: 'Cancelling frees the whole unspent reservation',
      detail:
        'Cancelling a queued job returns all 600 hours, takes it off the queue and marks it cancelled; a second cancel, or a cancel after completion, returns 0. Cancelling a running job frees its reservation too, and a job with no reservation frees 0 and writes nothing. The starter returns the job\u2019s spent figure, which is 0 before it ran.',
      match: {
        python: {all: [/redis\.call\(\s*['"]HSET['"][^\n]*['"]cancelled['"]/]},
        typescript: {all: [/redis\.call\(\s*['"]HSET['"][^\n]*['"]cancelled['"]/]},
        go: {all: [/redis\.call\(\s*['"]HSET['"][^\n]*['"]cancelled['"]/]},
        cpp: {all: [/redis\.call\(\s*['"]HSET['"][^\n]*['"]cancelled['"]/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from finetune.config import pool_key, queue_key, reservation_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def submit(team: str, job_id: str, amount: int) -> bool:
    """Reserve amount GPU-hours from the team's pool and queue the job; False when the pool cannot cover it."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    r.rpush(queue_key(team), job_id)
    balance = int(r.get(pool_key(team)) or 0)
    if balance < amount:
        return False
    r.decrby(pool_key(team), amount)
    r.hset(reservation_key(job_id), mapping={"team": team, "reserved": amount, "spent": 0, "state": "queued"})
    return True


def start(team: str, job_id: str) -> bool:
    """Take the job off the queue and mark it running; False when it has no reservation to run on."""
    r.lrem(queue_key(team), 0, job_id)
    r.hset(reservation_key(job_id), "state", "running")
    return True


def complete(team: str, job_id: str, spent: int) -> int:
    """Record what the run spent and return the rest of its reservation to the pool; the hours returned."""
    reserved = int(r.hget(reservation_key(job_id), "reserved") or 0)
    refund = reserved - spent
    r.incrby(pool_key(team), refund)
    r.hset(reservation_key(job_id), mapping={"spent": spent, "state": "completed"})
    return refund


def cancel(team: str, job_id: str) -> int:
    """Drop the job from the queue and free its reservation; the hours returned."""
    freed = int(r.hget(reservation_key(job_id), "spent") or 0)
    r.incrby(pool_key(team), freed)
    r.hset(reservation_key(job_id), "state", "cancelled")
    r.lrem(queue_key(team), 0, job_id)
    return freed
`,
      solution: `import redis

from finetune.config import pool_key, queue_key, reservation_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

SUBMIT = """
local pool, reservation, queue = KEYS[1], KEYS[2], KEYS[3]
local team, job_id, amount = ARGV[1], ARGV[2], tonumber(ARGV[3])
if tonumber(redis.call('GET', pool) or '0') < amount then return 0 end
redis.call('DECRBY', pool, amount)
redis.call('HSET', reservation, 'team', team, 'reserved', amount, 'spent', 0, 'state', 'queued')
redis.call('RPUSH', queue, job_id)
return 1
"""

START = """
local reservation, queue = KEYS[1], KEYS[2]
if redis.call('HGET', reservation, 'state') ~= 'queued' then return 0 end
redis.call('LREM', queue, 0, ARGV[1])
redis.call('HSET', reservation, 'state', 'running')
return 1
"""

COMPLETE = """
local pool, reservation = KEYS[1], KEYS[2]
if redis.call('HGET', reservation, 'state') ~= 'running' then return 0 end
local reserved = tonumber(redis.call('HGET', reservation, 'reserved'))
local spent = math.min(tonumber(ARGV[1]), reserved)
redis.call('INCRBY', pool, reserved - spent)
redis.call('HSET', reservation, 'spent', spent, 'state', 'completed')
return reserved - spent
"""

CANCEL = """
local pool, reservation, queue = KEYS[1], KEYS[2], KEYS[3]
local state = redis.call('HGET', reservation, 'state')
if state ~= 'queued' and state ~= 'running' then return 0 end
local reserved = tonumber(redis.call('HGET', reservation, 'reserved'))
local spent = tonumber(redis.call('HGET', reservation, 'spent'))
redis.call('INCRBY', pool, reserved - spent)
redis.call('LREM', queue, 0, ARGV[1])
redis.call('HSET', reservation, 'state', 'cancelled')
return reserved - spent
"""

submit_script = r.register_script(SUBMIT)
start_script = r.register_script(START)
complete_script = r.register_script(COMPLETE)
cancel_script = r.register_script(CANCEL)


def submit(team: str, job_id: str, amount: int) -> bool:
    """Reserve amount GPU-hours from the team's pool and queue the job; False when the pool cannot cover it."""
    keys = [pool_key(team), reservation_key(job_id), queue_key(team)]
    return submit_script(keys=keys, args=[team, job_id, amount]) == 1


def start(team: str, job_id: str) -> bool:
    """Take the job off the queue and mark it running; False when it has no reservation to run on."""
    return start_script(keys=[reservation_key(job_id), queue_key(team)], args=[job_id]) == 1


def complete(team: str, job_id: str, spent: int) -> int:
    """Record what the run spent and return the rest of its reservation to the pool; the hours returned."""
    return int(complete_script(keys=[pool_key(team), reservation_key(job_id)], args=[spent]))


def cancel(team: str, job_id: str) -> int:
    """Drop the job from the queue and free its reservation; the hours returned."""
    return int(cancel_script(keys=[pool_key(team), reservation_key(job_id), queue_key(team)], args=[job_id]))
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {poolKey, queueKey, reservationKey} from 'finetune/config';

export const redis = new Redis({host: 'redis', port: 6379});

/** Reserve amount GPU-hours from the team's pool and queue the job; false when the pool cannot cover it. */
export async function submit(team: string, jobId: string, amount: number): Promise<boolean> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  await redis.rpush(queueKey(team), jobId);
  const balance = Number((await redis.get(poolKey(team))) ?? 0);
  if (balance < amount) return false;
  await redis.decrby(poolKey(team), amount);
  await redis.hset(reservationKey(jobId), {team, reserved: amount, spent: 0, state: 'queued'});
  return true;
}

/** Take the job off the queue and mark it running; false when it has no reservation to run on. */
export async function start(team: string, jobId: string): Promise<boolean> {
  await redis.lrem(queueKey(team), 0, jobId);
  await redis.hset(reservationKey(jobId), 'state', 'running');
  return true;
}

/** Record what the run spent and return the rest of its reservation to the pool; the hours returned. */
export async function complete(team: string, jobId: string, spent: number): Promise<number> {
  const reserved = Number((await redis.hget(reservationKey(jobId), 'reserved')) ?? 0);
  const refund = reserved - spent;
  await redis.incrby(poolKey(team), refund);
  await redis.hset(reservationKey(jobId), {spent, state: 'completed'});
  return refund;
}

/** Drop the job from the queue and free its reservation; the hours returned. */
export async function cancel(team: string, jobId: string): Promise<number> {
  const freed = Number((await redis.hget(reservationKey(jobId), 'spent')) ?? 0);
  await redis.incrby(poolKey(team), freed);
  await redis.hset(reservationKey(jobId), 'state', 'cancelled');
  await redis.lrem(queueKey(team), 0, jobId);
  return freed;
}
`,
      solution: `import Redis from 'ioredis';

import {poolKey, queueKey, reservationKey} from 'finetune/config';

const SUBMIT = \`
local pool, reservation, queue = KEYS[1], KEYS[2], KEYS[3]
local team, job_id, amount = ARGV[1], ARGV[2], tonumber(ARGV[3])
if tonumber(redis.call('GET', pool) or '0') < amount then return 0 end
redis.call('DECRBY', pool, amount)
redis.call('HSET', reservation, 'team', team, 'reserved', amount, 'spent', 0, 'state', 'queued')
redis.call('RPUSH', queue, job_id)
return 1
\`;

const START = \`
local reservation, queue = KEYS[1], KEYS[2]
if redis.call('HGET', reservation, 'state') ~= 'queued' then return 0 end
redis.call('LREM', queue, 0, ARGV[1])
redis.call('HSET', reservation, 'state', 'running')
return 1
\`;

const COMPLETE = \`
local pool, reservation = KEYS[1], KEYS[2]
if redis.call('HGET', reservation, 'state') ~= 'running' then return 0 end
local reserved = tonumber(redis.call('HGET', reservation, 'reserved'))
local spent = math.min(tonumber(ARGV[1]), reserved)
redis.call('INCRBY', pool, reserved - spent)
redis.call('HSET', reservation, 'spent', spent, 'state', 'completed')
return reserved - spent
\`;

const CANCEL = \`
local pool, reservation, queue = KEYS[1], KEYS[2], KEYS[3]
local state = redis.call('HGET', reservation, 'state')
if state ~= 'queued' and state ~= 'running' then return 0 end
local reserved = tonumber(redis.call('HGET', reservation, 'reserved'))
local spent = tonumber(redis.call('HGET', reservation, 'spent'))
redis.call('INCRBY', pool, reserved - spent)
redis.call('LREM', queue, 0, ARGV[1])
redis.call('HSET', reservation, 'state', 'cancelled')
return reserved - spent
\`;

interface BudgetRedis extends Redis {
  submitJob(pool: string, reservation: string, queue: string, team: string, jobId: string, amount: number): Promise<number>;
  startJob(reservation: string, queue: string, jobId: string): Promise<number>;
  completeJob(pool: string, reservation: string, spent: number): Promise<number>;
  cancelJob(pool: string, reservation: string, queue: string, jobId: string): Promise<number>;
}

export const redis = new Redis({host: 'redis', port: 6379}) as BudgetRedis;
redis.defineCommand('submitJob', {numberOfKeys: 3, lua: SUBMIT});
redis.defineCommand('startJob', {numberOfKeys: 2, lua: START});
redis.defineCommand('completeJob', {numberOfKeys: 2, lua: COMPLETE});
redis.defineCommand('cancelJob', {numberOfKeys: 3, lua: CANCEL});

/** Reserve amount GPU-hours from the team's pool and queue the job; false when the pool cannot cover it. */
export async function submit(team: string, jobId: string, amount: number): Promise<boolean> {
  return Number(await redis.submitJob(poolKey(team), reservationKey(jobId), queueKey(team), team, jobId, amount)) === 1;
}

/** Take the job off the queue and mark it running; false when it has no reservation to run on. */
export async function start(team: string, jobId: string): Promise<boolean> {
  return Number(await redis.startJob(reservationKey(jobId), queueKey(team), jobId)) === 1;
}

/** Record what the run spent and return the rest of its reservation to the pool; the hours returned. */
export async function complete(team: string, jobId: string, spent: number): Promise<number> {
  return Number(await redis.completeJob(poolKey(team), reservationKey(jobId), spent));
}

/** Drop the job from the queue and free its reservation; the hours returned. */
export async function cancel(team: string, jobId: string): Promise<number> {
  return Number(await redis.cancelJob(poolKey(team), reservationKey(jobId), queueKey(team), jobId));
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/redis/go-redis/v9"

	"finetune/config" // config.PoolKey, config.QueueKey, config.ReservationKey — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// submit reserves amount GPU-hours from the team's pool and queues the job; false when the pool cannot cover it.
func submit(ctx context.Context, team, jobID string, amount int64) (bool, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	if err := rdb.RPush(ctx, config.QueueKey(team), jobID).Err(); err != nil {
		return false, err
	}
	balance, err := rdb.Get(ctx, config.PoolKey(team)).Int64()
	if err != nil && !errors.Is(err, redis.Nil) {
		return false, err
	}
	if balance < amount {
		return false, nil
	}
	if err := rdb.DecrBy(ctx, config.PoolKey(team), amount).Err(); err != nil {
		return false, err
	}
	return true, rdb.HSet(ctx, config.ReservationKey(jobID), "team", team, "reserved", amount, "spent", 0, "state", "queued").Err()
}

// start takes the job off the queue and marks it running; false when it has no reservation to run on.
func start(ctx context.Context, team, jobID string) (bool, error) {
	if err := rdb.LRem(ctx, config.QueueKey(team), 0, jobID).Err(); err != nil {
		return false, err
	}
	return true, rdb.HSet(ctx, config.ReservationKey(jobID), "state", "running").Err()
}

// complete records what the run spent and returns the rest of its reservation to the pool; the hours returned.
func complete(ctx context.Context, team, jobID string, spent int64) (int64, error) {
	reserved, err := rdb.HGet(ctx, config.ReservationKey(jobID), "reserved").Int64()
	if err != nil && !errors.Is(err, redis.Nil) {
		return 0, err
	}
	refund := reserved - spent
	if err := rdb.IncrBy(ctx, config.PoolKey(team), refund).Err(); err != nil {
		return 0, err
	}
	return refund, rdb.HSet(ctx, config.ReservationKey(jobID), "spent", spent, "state", "completed").Err()
}

// cancel drops the job from the queue and frees its reservation; the hours returned.
func cancel(ctx context.Context, team, jobID string) (int64, error) {
	freed, err := rdb.HGet(ctx, config.ReservationKey(jobID), "spent").Int64()
	if err != nil && !errors.Is(err, redis.Nil) {
		return 0, err
	}
	if err := rdb.IncrBy(ctx, config.PoolKey(team), freed).Err(); err != nil {
		return 0, err
	}
	if err := rdb.HSet(ctx, config.ReservationKey(jobID), "state", "cancelled").Err(); err != nil {
		return 0, err
	}
	return freed, rdb.LRem(ctx, config.QueueKey(team), 0, jobID).Err()
}

func main() {
	ok, err := submit(context.Background(), "ml-search", "job-demo", 10)
	fmt.Println(ok, err)
}
`,
      solution: `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"

	"finetune/config" // config.PoolKey, config.QueueKey, config.ReservationKey — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var submitScript = redis.NewScript(\`
local pool, reservation, queue = KEYS[1], KEYS[2], KEYS[3]
local team, job_id, amount = ARGV[1], ARGV[2], tonumber(ARGV[3])
if tonumber(redis.call('GET', pool) or '0') < amount then return 0 end
redis.call('DECRBY', pool, amount)
redis.call('HSET', reservation, 'team', team, 'reserved', amount, 'spent', 0, 'state', 'queued')
redis.call('RPUSH', queue, job_id)
return 1
\`)

var startScript = redis.NewScript(\`
local reservation, queue = KEYS[1], KEYS[2]
if redis.call('HGET', reservation, 'state') ~= 'queued' then return 0 end
redis.call('LREM', queue, 0, ARGV[1])
redis.call('HSET', reservation, 'state', 'running')
return 1
\`)

var completeScript = redis.NewScript(\`
local pool, reservation = KEYS[1], KEYS[2]
if redis.call('HGET', reservation, 'state') ~= 'running' then return 0 end
local reserved = tonumber(redis.call('HGET', reservation, 'reserved'))
local spent = math.min(tonumber(ARGV[1]), reserved)
redis.call('INCRBY', pool, reserved - spent)
redis.call('HSET', reservation, 'spent', spent, 'state', 'completed')
return reserved - spent
\`)

var cancelScript = redis.NewScript(\`
local pool, reservation, queue = KEYS[1], KEYS[2], KEYS[3]
local state = redis.call('HGET', reservation, 'state')
if state ~= 'queued' and state ~= 'running' then return 0 end
local reserved = tonumber(redis.call('HGET', reservation, 'reserved'))
local spent = tonumber(redis.call('HGET', reservation, 'spent'))
redis.call('INCRBY', pool, reserved - spent)
redis.call('LREM', queue, 0, ARGV[1])
redis.call('HSET', reservation, 'state', 'cancelled')
return reserved - spent
\`)

// submit reserves amount GPU-hours from the team's pool and queues the job; false when the pool cannot cover it.
func submit(ctx context.Context, team, jobID string, amount int64) (bool, error) {
	keys := []string{config.PoolKey(team), config.ReservationKey(jobID), config.QueueKey(team)}
	n, err := submitScript.Run(ctx, rdb, keys, team, jobID, amount).Int64()
	return n == 1, err
}

// start takes the job off the queue and marks it running; false when it has no reservation to run on.
func start(ctx context.Context, team, jobID string) (bool, error) {
	n, err := startScript.Run(ctx, rdb, []string{config.ReservationKey(jobID), config.QueueKey(team)}, jobID).Int64()
	return n == 1, err
}

// complete records what the run spent and returns the rest of its reservation to the pool; the hours returned.
func complete(ctx context.Context, team, jobID string, spent int64) (int64, error) {
	return completeScript.Run(ctx, rdb, []string{config.PoolKey(team), config.ReservationKey(jobID)}, spent).Int64()
}

// cancel drops the job from the queue and frees its reservation; the hours returned.
func cancel(ctx context.Context, team, jobID string) (int64, error) {
	keys := []string{config.PoolKey(team), config.ReservationKey(jobID), config.QueueKey(team)}
	return cancelScript.Run(ctx, rdb, keys, jobID).Int64()
}

func main() {
	ok, err := submit(context.Background(), "ml-search", "job-demo", 10)
	fmt.Println(ok, err)
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

#include "finetune/config.h"  // config::pool_key, config::queue_key, config::reservation_key — provided

sw::redis::Redis redis("tcp://redis:6379");

long long number(const sw::redis::OptionalString& value) { return value ? std::stoll(*value) : 0; }

// Reserve amount GPU-hours from the team's pool and queue the job; false when the pool cannot cover it.
bool submit(const std::string& team, const std::string& job_id, long long amount) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  redis.rpush(config::queue_key(team), job_id);
  const long long balance = number(redis.get(config::pool_key(team)));
  if (balance < amount) return false;
  redis.decrby(config::pool_key(team), amount);
  redis.hset(config::reservation_key(job_id), {{"team", team}, {"reserved", std::to_string(amount)}, {"spent", "0"}, {"state", "queued"}});
  return true;
}

// Take the job off the queue and mark it running; false when it has no reservation to run on.
bool start(const std::string& team, const std::string& job_id) {
  redis.lrem(config::queue_key(team), 0, job_id);
  redis.hset(config::reservation_key(job_id), "state", "running");
  return true;
}

// Record what the run spent and return the rest of its reservation to the pool; the hours returned.
long long complete(const std::string& team, const std::string& job_id, long long spent) {
  const long long reserved = number(redis.hget(config::reservation_key(job_id), "reserved"));
  const long long refund = reserved - spent;
  redis.incrby(config::pool_key(team), refund);
  redis.hset(config::reservation_key(job_id), {{"spent", std::to_string(spent)}, {"state", "completed"}});
  return refund;
}

// Drop the job from the queue and free its reservation; the hours returned.
long long cancel(const std::string& team, const std::string& job_id) {
  const long long freed = number(redis.hget(config::reservation_key(job_id), "spent"));
  redis.incrby(config::pool_key(team), freed);
  redis.hset(config::reservation_key(job_id), "state", "cancelled");
  redis.lrem(config::queue_key(team), 0, job_id);
  return freed;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>

#include "finetune/config.h"  // config::pool_key, config::queue_key, config::reservation_key — provided

sw::redis::Redis redis("tcp://redis:6379");

const std::string kSubmit = R"lua(
local pool, reservation, queue = KEYS[1], KEYS[2], KEYS[3]
local team, job_id, amount = ARGV[1], ARGV[2], tonumber(ARGV[3])
if tonumber(redis.call('GET', pool) or '0') < amount then return 0 end
redis.call('DECRBY', pool, amount)
redis.call('HSET', reservation, 'team', team, 'reserved', amount, 'spent', 0, 'state', 'queued')
redis.call('RPUSH', queue, job_id)
return 1
)lua";

const std::string kStart = R"lua(
local reservation, queue = KEYS[1], KEYS[2]
if redis.call('HGET', reservation, 'state') ~= 'queued' then return 0 end
redis.call('LREM', queue, 0, ARGV[1])
redis.call('HSET', reservation, 'state', 'running')
return 1
)lua";

const std::string kComplete = R"lua(
local pool, reservation = KEYS[1], KEYS[2]
if redis.call('HGET', reservation, 'state') ~= 'running' then return 0 end
local reserved = tonumber(redis.call('HGET', reservation, 'reserved'))
local spent = math.min(tonumber(ARGV[1]), reserved)
redis.call('INCRBY', pool, reserved - spent)
redis.call('HSET', reservation, 'spent', spent, 'state', 'completed')
return reserved - spent
)lua";

const std::string kCancel = R"lua(
local pool, reservation, queue = KEYS[1], KEYS[2], KEYS[3]
local state = redis.call('HGET', reservation, 'state')
if state ~= 'queued' and state ~= 'running' then return 0 end
local reserved = tonumber(redis.call('HGET', reservation, 'reserved'))
local spent = tonumber(redis.call('HGET', reservation, 'spent'))
redis.call('INCRBY', pool, reserved - spent)
redis.call('LREM', queue, 0, ARGV[1])
redis.call('HSET', reservation, 'state', 'cancelled')
return reserved - spent
)lua";

// Reserve amount GPU-hours from the team's pool and queue the job; false when the pool cannot cover it.
bool submit(const std::string& team, const std::string& job_id, long long amount) {
  return redis.eval<long long>(kSubmit, {config::pool_key(team), config::reservation_key(job_id), config::queue_key(team)},
                               {team, job_id, std::to_string(amount)}) == 1;
}

// Take the job off the queue and mark it running; false when it has no reservation to run on.
bool start(const std::string& team, const std::string& job_id) {
  return redis.eval<long long>(kStart, {config::reservation_key(job_id), config::queue_key(team)}, {job_id}) == 1;
}

// Record what the run spent and return the rest of its reservation to the pool; the hours returned.
long long complete(const std::string& team, const std::string& job_id, long long spent) {
  return redis.eval<long long>(kComplete, {config::pool_key(team), config::reservation_key(job_id)}, {std::to_string(spent)});
}

// Drop the job from the queue and free its reservation; the hours returned.
long long cancel(const std::string& team, const std::string& job_id) {
  return redis.eval<long long>(kCancel, {config::pool_key(team), config::reservation_key(job_id), config::queue_key(team)}, {job_id});
}
`,
    },
  },
  harness: {
    python: `TEAM = "ml-search"
POOL = f"ft:pool:{TEAM}"
QUEUE = f"ft:queue:{TEAM}"


def _budget(ctx, pool):
    ctx.redis.set(POOL, pool)
    return ctx.load("budget")


def _pool(ctx):
    return int(ctx.redis.get(POOL) or 0)


def _queue(ctx):
    return ctx.redis.lrange(QUEUE, 0, -1)


def _reservation(ctx, job_id):
    return ctx.redis.hgetall(f"ft:reservation:{job_id}")


def check_reserve_at_submit(ctx):
    m = _budget(ctx, 100)
    assert m.submit(TEAM, "job-big", 150) is False, "a pool of 100 hours cannot cover 150: submit must answer False"
    assert _queue(ctx) == [], f"a job the pool cannot cover was queued anyway: {_queue(ctx)}; the queue must hold only jobs whose hours are reserved"
    assert _reservation(ctx, "job-big") == {}, f"a refused submit wrote a reservation: {_reservation(ctx, 'job-big')}"
    assert _pool(ctx) == 100, f"a refused submit moved the pool to {_pool(ctx)}"
    assert m.submit(TEAM, "job-ok", 60) is True, "60 of 100 hours must be reserved"
    assert _queue(ctx) == ["job-ok"], f"the covered job must be queued once: {_queue(ctx)}"
    res = _reservation(ctx, "job-ok")
    assert res.get("reserved") == "60" and res.get("state") == "queued" and res.get("team") == TEAM, f"the reservation must read team, reserved 60, state queued: {res}"
    assert _pool(ctx) == 40, f"the pool must be drawn by 60, it holds {_pool(ctx)}"
    assert m.submit(TEAM, "job-exact", 40) is True, "a pool of 40 hours covers a job of exactly 40: submit must answer True"
    assert _pool(ctx) == 0 and _queue(ctx) == ["job-ok", "job-exact"], f"the exact fit draws the pool to 0 and is queued: pool {_pool(ctx)}, queue {_queue(ctx)}"
    assert m.submit(TEAM, "job-one", 1) is False and _pool(ctx) == 0 and _reservation(ctx, "job-one") == {}, f"an empty pool cannot cover 1 hour: pool {_pool(ctx)}, reservation {_reservation(ctx, 'job-one')}"


def check_atomic_reserve(ctx):
    m = _budget(ctx, 100)

    def other_replica():
        # another API replica submitting job-b for 80 hours, landing between this submit's commands
        if int(ctx.redis.get(POOL) or 0) >= 80:
            ctx.redis.decrby(POOL, 80)
            return True
        return False

    probe = ctx.redis_after(POOL, other_replica)
    mine = m.submit(TEAM, "job-a", 60)
    assert probe.fired, "submit never touched the pool"
    drawn = (60 if mine else 0) + (80 if probe.result else 0)
    assert _pool(ctx) >= 0, f"two submissions of 60 and 80 hours against a pool of 100 left it at {_pool(ctx)}: both passed the balance check before either drew, so the cluster is oversubscribed. Test and draw in one script"
    assert _pool(ctx) == 100 - drawn, f"the pool holds {_pool(ctx)}, but the submissions that succeeded drew {drawn}"
    assert mine or probe.result, "one of the two submissions fits the pool and must succeed"


def check_start_guard(ctx):
    m = _budget(ctx, 100)
    assert m.start(TEAM, "job-ghost") is False, "job-ghost has no reservation: start must answer False, a job cannot run on hours nobody reserved"
    assert _reservation(ctx, "job-ghost") == {}, f"start wrote a reservation for a job that never had one: {_reservation(ctx, 'job-ghost')}"
    assert m.submit(TEAM, "job-a", 60) is True
    assert m.start(TEAM, "job-a") is True, "a queued job with a reservation must start"
    assert _reservation(ctx, "job-a").get("state") == "running" and _queue(ctx) == [], f"a started job is running and off the queue: {_reservation(ctx, 'job-a')}, queue {_queue(ctx)}"
    assert m.start(TEAM, "job-a") is False, "a running job must not start a second time"
    assert m.submit(TEAM, "job-b", 30) is True
    m.cancel(TEAM, "job-b")
    assert m.start(TEAM, "job-b") is False, "a cancelled job must not start: its reservation is gone"
    assert _reservation(ctx, "job-b").get("state") == "cancelled", f"start overwrote a cancelled reservation: {_reservation(ctx, 'job-b')}"
    assert m.submit(TEAM, "job-c", 20) is True

    def cancel_lands():
        # the team cancels job-c from another replica, landing right after start's first command on the reservation
        res = ctx.redis.hgetall("ft:reservation:job-c")
        if res.get("state") in ("queued", "running"):
            ctx.redis.incrby(POOL, int(res["reserved"]) - int(res["spent"]))
            ctx.redis.lrem(QUEUE, 0, "job-c")
            ctx.redis.hset("ft:reservation:job-c", "state", "cancelled")

    probe = ctx.redis_after("ft:reservation:job-c", cancel_lands)
    m.start(TEAM, "job-c")
    assert probe.fired, "start never touched job-c's reservation"
    assert _reservation(ctx, "job-c").get("state") == "cancelled", f"a cancel landed between start's commands and start overwrote it: job-c reads {_reservation(ctx, 'job-c')} though its hours went back to the pool. Check and move the state in one script"


def check_release_once(ctx):
    m = _budget(ctx, 1000)
    assert m.submit(TEAM, "job-a", 600) is True and m.start(TEAM, "job-a") is True
    assert m.complete(TEAM, "job-a", 450) == 150, "600 reserved, 450 spent: complete returns 150"
    assert _pool(ctx) == 550, f"the pool must hold 550 after the remainder came back, it holds {_pool(ctx)}"
    again = m.complete(TEAM, "job-a", 450)
    assert again == 0 and _pool(ctx) == 550, f"the trainer's completion callback arrived twice and the second returned {again}, leaving the pool at {_pool(ctx)}: the remainder goes back once"
    res = _reservation(ctx, "job-a")
    assert res.get("spent") == "450" and res.get("state") == "completed", f"the reservation must read spent 450, state completed: {res}"
    assert m.submit(TEAM, "job-b", 300) is True and m.start(TEAM, "job-b") is True
    over = m.complete(TEAM, "job-b", 500)
    assert over == 0 and _pool(ctx) == 250, f"a run that spent 500 of 300 reserved hours returned {over} and left the pool at {_pool(ctx)}, expected 0 and 250: a release never takes more from the pool"
    assert m.submit(TEAM, "job-c", 100) is True and m.start(TEAM, "job-c") is True

    def duplicate_callback():
        # the same completion delivered again, landing right after this one's first command on the reservation
        res = ctx.redis.hgetall("ft:reservation:job-c")
        if res.get("state") == "running":
            ctx.redis.incrby(POOL, int(res["reserved"]) - 60)
            ctx.redis.hset("ft:reservation:job-c", mapping={"spent": 60, "state": "completed"})

    probe = ctx.redis_after("ft:reservation:job-c", duplicate_callback)
    m.complete(TEAM, "job-c", 60)
    assert probe.fired, "complete never touched job-c's reservation"
    assert _pool(ctx) == 190, f"a duplicate completion landed between this completion's commands and the pool holds {_pool(ctx)}, expected 190: the 40-hour remainder went back twice. Check the state and release in one script"
    assert m.submit(TEAM, "job-d", 50) is True
    early = m.complete(TEAM, "job-d", 0)
    assert early == 0 and _pool(ctx) == 140 and _reservation(ctx, "job-d").get("state") == "queued", f"job-d never started, yet complete returned {early}: pool {_pool(ctx)}, {_reservation(ctx, 'job-d')}; only a running reservation completes"
    assert m.cancel(TEAM, "job-d") == 50
    late = m.complete(TEAM, "job-d", 0)
    assert late == 0 and _pool(ctx) == 190 and _reservation(ctx, "job-d").get("state") == "cancelled", f"a completion after the cancel returned {late}: pool {_pool(ctx)}, {_reservation(ctx, 'job-d')}; a cancelled job's hours went back already"


def check_cancel_frees(ctx):
    m = _budget(ctx, 1000)
    assert m.submit(TEAM, "job-a", 600) is True
    freed = m.cancel(TEAM, "job-a")
    assert freed == 600 and _pool(ctx) == 1000, f"cancelling a queued job freed {freed} hours and left the pool at {_pool(ctx)}, expected 600 and 1000: a cancelled job keeps nothing"
    assert _queue(ctx) == [] and _reservation(ctx, "job-a").get("state") == "cancelled", f"a cancelled job leaves the queue and reads cancelled: queue {_queue(ctx)}, {_reservation(ctx, 'job-a')}"
    assert m.cancel(TEAM, "job-a") == 0 and _pool(ctx) == 1000, f"a second cancel must free nothing, the pool holds {_pool(ctx)}"
    assert m.submit(TEAM, "job-b", 200) is True and m.start(TEAM, "job-b") is True
    assert m.complete(TEAM, "job-b", 150) == 50
    late = m.cancel(TEAM, "job-b")
    assert late == 0 and _pool(ctx) == 850, f"a cancel after completion freed {late} and left the pool at {_pool(ctx)}, expected 0 and 850"
    assert m.submit(TEAM, "job-c", 300) is True and m.start(TEAM, "job-c") is True
    freed = m.cancel(TEAM, "job-c")
    assert freed == 300 and _pool(ctx) == 850 and _reservation(ctx, "job-c").get("state") == "cancelled", f"cancelling a running job freed {freed} and left the pool at {_pool(ctx)}, expected 300 and 850: {_reservation(ctx, 'job-c')}"
    ghost = m.cancel(TEAM, "job-ghost")
    assert ghost == 0 and _pool(ctx) == 850 and _reservation(ctx, "job-ghost") == {}, f"cancelling a job with no reservation freed {ghost}, pool {_pool(ctx)}, wrote {_reservation(ctx, 'job-ghost')}"
`,
    typescript: `const TEAM = 'ml-search';
const POOL = \`ft:pool:\${TEAM}\`;
const QUEUE = \`ft:queue:\${TEAM}\`;

function budget(ctx, pool: number) {
  ctx.redis.set(POOL, String(pool));
  return ctx.load('budget');
}

const poolOf = ctx => Number(ctx.redis.get(POOL) ?? 0);
const queueOf = ctx => ctx.redis.lrange(QUEUE, 0, -1);
const reservation = (ctx, jobId: string) => ctx.redis.hgetall(\`ft:reservation:\${jobId}\`);

export async function check_reserve_at_submit(ctx) {
  const m = budget(ctx, 100);
  assert.equal(await m.submit(TEAM, 'job-big', 150), false, 'a pool of 100 hours cannot cover 150: submit must resolve false');
  assert.deepEqual(queueOf(ctx), [], \`a job the pool cannot cover was queued anyway: \${JSON.stringify(queueOf(ctx))}; the queue must hold only jobs whose hours are reserved\`);
  assert.deepEqual(reservation(ctx, 'job-big'), {}, \`a refused submit wrote a reservation: \${JSON.stringify(reservation(ctx, 'job-big'))}\`);
  assert.equal(poolOf(ctx), 100, \`a refused submit moved the pool to \${poolOf(ctx)}\`);
  assert.equal(await m.submit(TEAM, 'job-ok', 60), true, '60 of 100 hours must be reserved');
  assert.deepEqual(queueOf(ctx), ['job-ok'], \`the covered job must be queued once: \${JSON.stringify(queueOf(ctx))}\`);
  const res = reservation(ctx, 'job-ok');
  assert(res.reserved === '60' && res.state === 'queued' && res.team === TEAM, \`the reservation must read team, reserved 60, state queued: \${JSON.stringify(res)}\`);
  assert.equal(poolOf(ctx), 40, \`the pool must be drawn by 60, it holds \${poolOf(ctx)}\`);
  assert.equal(await m.submit(TEAM, 'job-exact', 40), true, 'a pool of 40 hours covers a job of exactly 40: submit must resolve true');
  assert(poolOf(ctx) === 0 && JSON.stringify(queueOf(ctx)) === '["job-ok","job-exact"]', \`the exact fit draws the pool to 0 and is queued: pool \${poolOf(ctx)}, queue \${JSON.stringify(queueOf(ctx))}\`);
  const one = await m.submit(TEAM, 'job-one', 1);
  assert(one === false && poolOf(ctx) === 0 && Object.keys(reservation(ctx, 'job-one')).length === 0, \`an empty pool cannot cover 1 hour: submit resolved \${one}, pool \${poolOf(ctx)}, reservation \${JSON.stringify(reservation(ctx, 'job-one'))}\`);
}

export async function check_atomic_reserve(ctx) {
  const m = budget(ctx, 100);
  // another API replica submitting job-b for 80 hours, landing between this submit's commands
  const probe = ctx.redisAfter(POOL, () => {
    if (Number(ctx.redis.get(POOL) ?? 0) >= 80) {
      ctx.redis.decrby(POOL, 80);
      return true;
    }
    return false;
  });
  const mine = await m.submit(TEAM, 'job-a', 60);
  assert(probe.fired, 'submit never touched the pool');
  const drawn = (mine ? 60 : 0) + (probe.result ? 80 : 0);
  assert(poolOf(ctx) >= 0, \`two submissions of 60 and 80 hours against a pool of 100 left it at \${poolOf(ctx)}: both passed the balance check before either drew, so the cluster is oversubscribed. Test and draw in one script\`);
  assert.equal(poolOf(ctx), 100 - drawn, \`the pool holds \${poolOf(ctx)}, but the submissions that succeeded drew \${drawn}\`);
  assert(mine || probe.result, 'one of the two submissions fits the pool and must succeed');
}

export async function check_start_guard(ctx) {
  const m = budget(ctx, 100);
  assert.equal(await m.start(TEAM, 'job-ghost'), false, 'job-ghost has no reservation: start must resolve false, a job cannot run on hours nobody reserved');
  assert.deepEqual(reservation(ctx, 'job-ghost'), {}, \`start wrote a reservation for a job that never had one: \${JSON.stringify(reservation(ctx, 'job-ghost'))}\`);
  assert.equal(await m.submit(TEAM, 'job-a', 60), true);
  assert.equal(await m.start(TEAM, 'job-a'), true, 'a queued job with a reservation must start');
  assert(reservation(ctx, 'job-a').state === 'running' && queueOf(ctx).length === 0, \`a started job is running and off the queue: \${JSON.stringify(reservation(ctx, 'job-a'))}, queue \${JSON.stringify(queueOf(ctx))}\`);
  assert.equal(await m.start(TEAM, 'job-a'), false, 'a running job must not start a second time');
  assert.equal(await m.submit(TEAM, 'job-b', 30), true);
  await m.cancel(TEAM, 'job-b');
  assert.equal(await m.start(TEAM, 'job-b'), false, 'a cancelled job must not start: its reservation is gone');
  assert.equal(reservation(ctx, 'job-b').state, 'cancelled', \`start overwrote a cancelled reservation: \${JSON.stringify(reservation(ctx, 'job-b'))}\`);
  assert.equal(await m.submit(TEAM, 'job-c', 20), true);
  // the team cancels job-c from another replica, landing right after start's first command on the reservation
  const probe = ctx.redisAfter('ft:reservation:job-c', () => {
    const res = reservation(ctx, 'job-c');
    if (res.state === 'queued' || res.state === 'running') {
      ctx.redis.incrby(POOL, Number(res.reserved) - Number(res.spent));
      ctx.redis.lrem(QUEUE, 0, 'job-c');
      ctx.redis.hset('ft:reservation:job-c', 'state', 'cancelled');
    }
  });
  await m.start(TEAM, 'job-c');
  assert(probe.fired, "start never touched job-c's reservation");
  assert.equal(reservation(ctx, 'job-c').state, 'cancelled', \`a cancel landed between start's commands and start overwrote it: job-c reads \${JSON.stringify(reservation(ctx, 'job-c'))} though its hours went back to the pool. Check and move the state in one script\`);
}

export async function check_release_once(ctx) {
  const m = budget(ctx, 1000);
  assert((await m.submit(TEAM, 'job-a', 600)) && (await m.start(TEAM, 'job-a')), 'job-a must be reserved and started');
  assert.equal(await m.complete(TEAM, 'job-a', 450), 150, '600 reserved, 450 spent: complete returns 150');
  assert.equal(poolOf(ctx), 550, \`the pool must hold 550 after the remainder came back, it holds \${poolOf(ctx)}\`);
  const again = await m.complete(TEAM, 'job-a', 450);
  assert(again === 0 && poolOf(ctx) === 550, \`the trainer's completion callback arrived twice and the second returned \${again}, leaving the pool at \${poolOf(ctx)}: the remainder goes back once\`);
  const res = reservation(ctx, 'job-a');
  assert(res.spent === '450' && res.state === 'completed', \`the reservation must read spent 450, state completed: \${JSON.stringify(res)}\`);
  assert((await m.submit(TEAM, 'job-b', 300)) && (await m.start(TEAM, 'job-b')), 'job-b must be reserved and started');
  const over = await m.complete(TEAM, 'job-b', 500);
  assert(over === 0 && poolOf(ctx) === 250, \`a run that spent 500 of 300 reserved hours returned \${over} and left the pool at \${poolOf(ctx)}, expected 0 and 250: a release never takes more from the pool\`);
  assert((await m.submit(TEAM, 'job-c', 100)) && (await m.start(TEAM, 'job-c')), 'job-c must be reserved and started');
  // the same completion delivered again, landing right after this one's first command on the reservation
  const probe = ctx.redisAfter('ft:reservation:job-c', () => {
    const r = reservation(ctx, 'job-c');
    if (r.state === 'running') {
      ctx.redis.incrby(POOL, Number(r.reserved) - 60);
      ctx.redis.hset('ft:reservation:job-c', {spent: 60, state: 'completed'});
    }
  });
  await m.complete(TEAM, 'job-c', 60);
  assert(probe.fired, "complete never touched job-c's reservation");
  assert.equal(poolOf(ctx), 190, \`a duplicate completion landed between this completion's commands and the pool holds \${poolOf(ctx)}, expected 190: the 40-hour remainder went back twice. Check the state and release in one script\`);
  assert.equal(await m.submit(TEAM, 'job-d', 50), true);
  const early = await m.complete(TEAM, 'job-d', 0);
  assert(early === 0 && poolOf(ctx) === 140 && reservation(ctx, 'job-d').state === 'queued', \`job-d never started, yet complete returned \${early}: pool \${poolOf(ctx)}, \${JSON.stringify(reservation(ctx, 'job-d'))}; only a running reservation completes\`);
  assert.equal(await m.cancel(TEAM, 'job-d'), 50);
  const late = await m.complete(TEAM, 'job-d', 0);
  assert(late === 0 && poolOf(ctx) === 190 && reservation(ctx, 'job-d').state === 'cancelled', \`a completion after the cancel returned \${late}: pool \${poolOf(ctx)}, \${JSON.stringify(reservation(ctx, 'job-d'))}; a cancelled job's hours went back already\`);
}

export async function check_cancel_frees(ctx) {
  const m = budget(ctx, 1000);
  assert.equal(await m.submit(TEAM, 'job-a', 600), true);
  const freed = await m.cancel(TEAM, 'job-a');
  assert(freed === 600 && poolOf(ctx) === 1000, \`cancelling a queued job freed \${freed} hours and left the pool at \${poolOf(ctx)}, expected 600 and 1000: a cancelled job keeps nothing\`);
  assert(queueOf(ctx).length === 0 && reservation(ctx, 'job-a').state === 'cancelled', \`a cancelled job leaves the queue and reads cancelled: queue \${JSON.stringify(queueOf(ctx))}, \${JSON.stringify(reservation(ctx, 'job-a'))}\`);
  assert((await m.cancel(TEAM, 'job-a')) === 0 && poolOf(ctx) === 1000, \`a second cancel must free nothing, the pool holds \${poolOf(ctx)}\`);
  assert((await m.submit(TEAM, 'job-b', 200)) && (await m.start(TEAM, 'job-b')), 'job-b must be reserved and started');
  assert.equal(await m.complete(TEAM, 'job-b', 150), 50);
  const late = await m.cancel(TEAM, 'job-b');
  assert(late === 0 && poolOf(ctx) === 850, \`a cancel after completion freed \${late} and left the pool at \${poolOf(ctx)}, expected 0 and 850\`);
  assert((await m.submit(TEAM, 'job-c', 300)) && (await m.start(TEAM, 'job-c')), 'job-c must be reserved and started');
  const running = await m.cancel(TEAM, 'job-c');
  assert(running === 300 && poolOf(ctx) === 850 && reservation(ctx, 'job-c').state === 'cancelled', \`cancelling a running job freed \${running} and left the pool at \${poolOf(ctx)}, expected 300 and 850: \${JSON.stringify(reservation(ctx, 'job-c'))}\`);
  const ghost = await m.cancel(TEAM, 'job-ghost');
  assert(ghost === 0 && poolOf(ctx) === 850 && Object.keys(reservation(ctx, 'job-ghost')).length === 0, \`cancelling a job with no reservation freed \${ghost}, pool \${poolOf(ctx)}, wrote \${JSON.stringify(reservation(ctx, 'job-ghost'))}\`);
}
`,
    go: `package main

import (
	"context"
	"strconv"

	"leetbuild/harness"
)

const (
	harnessBudgetTeam  = "ml-search"
	harnessBudgetPool  = "ft:pool:ml-search"
	harnessBudgetQueue = "ft:queue:ml-search"
)

var harnessBudgetCtx = context.Background()

func harnessBudgetSeed(ctx *harness.Ctx, pool int64) { ctx.Redis.Set(harnessBudgetPool, pool) }

func harnessBudgetBalance(ctx *harness.Ctx) int64 {
	raw, _ := ctx.Redis.Get(harnessBudgetPool)
	n, _ := strconv.ParseInt(raw, 10, 64)
	return n
}

func harnessBudgetReservation(ctx *harness.Ctx, jobID string) map[string]string {
	return ctx.Redis.HGetAll("ft:reservation:" + jobID)
}

func harnessBudgetSubmit(ctx *harness.Ctx, jobID string, amount int64) bool {
	ok, err := submit(harnessBudgetCtx, harnessBudgetTeam, jobID, amount)
	ctx.NoError(err, "submit(%s, %d)", jobID, amount)
	return ok
}

func harnessBudgetStart(ctx *harness.Ctx, jobID string) bool {
	ok, err := start(harnessBudgetCtx, harnessBudgetTeam, jobID)
	ctx.NoError(err, "start(%s)", jobID)
	return ok
}

func harnessBudgetComplete(ctx *harness.Ctx, jobID string, spent int64) int64 {
	n, err := complete(harnessBudgetCtx, harnessBudgetTeam, jobID, spent)
	ctx.NoError(err, "complete(%s, %d)", jobID, spent)
	return n
}

func harnessBudgetCancel(ctx *harness.Ctx, jobID string) int64 {
	n, err := cancel(harnessBudgetCtx, harnessBudgetTeam, jobID)
	ctx.NoError(err, "cancel(%s)", jobID)
	return n
}

func CheckReserveAtSubmit(ctx *harness.Ctx) {
	harnessBudgetSeed(ctx, 100)
	ctx.Assert(!harnessBudgetSubmit(ctx, "job-big", 150), "a pool of 100 hours cannot cover 150: submit must answer false")
	ctx.Equal(len(ctx.Redis.LRange(harnessBudgetQueue, 0, -1)), 0, "a job the pool cannot cover was queued anyway (%v): the queue must hold only jobs whose hours are reserved; queued jobs", ctx.Redis.LRange(harnessBudgetQueue, 0, -1))
	ctx.Equal(len(harnessBudgetReservation(ctx, "job-big")), 0, "a refused submit wrote a reservation (%v); fields", harnessBudgetReservation(ctx, "job-big"))
	ctx.Equal(harnessBudgetBalance(ctx), 100, "a refused submit moved the pool")
	ctx.Assert(harnessBudgetSubmit(ctx, "job-ok", 60), "60 of 100 hours must be reserved")
	ctx.Equal(ctx.Redis.LRange(harnessBudgetQueue, 0, -1), []string{"job-ok"}, "the covered job must be queued once")
	res := harnessBudgetReservation(ctx, "job-ok")
	ctx.Assert(res["reserved"] == "60" && res["state"] == "queued" && res["team"] == harnessBudgetTeam, "the reservation must read team, reserved 60, state queued: %v", res)
	ctx.Equal(harnessBudgetBalance(ctx), 40, "the pool must be drawn by 60")
	ctx.Assert(harnessBudgetSubmit(ctx, "job-exact", 40), "a pool of 40 hours covers a job of exactly 40: submit must answer true")
	ctx.Assert(harnessBudgetBalance(ctx) == 0 && len(ctx.Redis.LRange(harnessBudgetQueue, 0, -1)) == 2, "the exact fit draws the pool to 0 and is queued: pool %d, queue %v", harnessBudgetBalance(ctx), ctx.Redis.LRange(harnessBudgetQueue, 0, -1))
	one := harnessBudgetSubmit(ctx, "job-one", 1)
	ctx.Assert(!one && harnessBudgetBalance(ctx) == 0 && len(harnessBudgetReservation(ctx, "job-one")) == 0, "an empty pool cannot cover 1 hour: submit answered %v, pool %d, reservation %v", one, harnessBudgetBalance(ctx), harnessBudgetReservation(ctx, "job-one"))
}

func CheckAtomicReserve(ctx *harness.Ctx) {
	harnessBudgetSeed(ctx, 100)
	fired, other := false, false
	// another API replica submitting job-b for 80 hours, landing between this submit's commands
	ctx.Redis.After(harnessBudgetPool, func() any {
		fired = true
		if harnessBudgetBalance(ctx) >= 80 {
			ctx.Redis.Do("DECRBY", harnessBudgetPool, 80)
			other = true
		}
		return nil
	})
	mine := harnessBudgetSubmit(ctx, "job-a", 60)
	ctx.Assert(fired, "submit never touched the pool")
	drawn := int64(0)
	if mine {
		drawn += 60
	}
	if other {
		drawn += 80
	}
	ctx.Assert(harnessBudgetBalance(ctx) >= 0, "two submissions of 60 and 80 hours against a pool of 100 left it at %d: both passed the balance check before either drew, so the cluster is oversubscribed. Test and draw in one script", harnessBudgetBalance(ctx))
	ctx.Equal(harnessBudgetBalance(ctx), 100-drawn, "the pool against what the successful submissions drew")
	ctx.Assert(mine || other, "one of the two submissions fits the pool and must succeed")
}

func CheckStartGuard(ctx *harness.Ctx) {
	harnessBudgetSeed(ctx, 100)
	ctx.Assert(!harnessBudgetStart(ctx, "job-ghost"), "job-ghost has no reservation: start must answer false, a job cannot run on hours nobody reserved")
	ctx.Equal(len(harnessBudgetReservation(ctx, "job-ghost")), 0, "start wrote a reservation for a job that never had one (%v); fields", harnessBudgetReservation(ctx, "job-ghost"))
	ctx.Assert(harnessBudgetSubmit(ctx, "job-a", 60), "job-a must be reserved")
	ctx.Assert(harnessBudgetStart(ctx, "job-a"), "a queued job with a reservation must start")
	ctx.Assert(harnessBudgetReservation(ctx, "job-a")["state"] == "running" && len(ctx.Redis.LRange(harnessBudgetQueue, 0, -1)) == 0, "a started job is running and off the queue: %v, queue %v", harnessBudgetReservation(ctx, "job-a"), ctx.Redis.LRange(harnessBudgetQueue, 0, -1))
	ctx.Assert(!harnessBudgetStart(ctx, "job-a"), "a running job must not start a second time")
	ctx.Assert(harnessBudgetSubmit(ctx, "job-b", 30), "job-b must be reserved")
	harnessBudgetCancel(ctx, "job-b")
	ctx.Assert(!harnessBudgetStart(ctx, "job-b"), "a cancelled job must not start: its reservation is gone")
	ctx.Equal(harnessBudgetReservation(ctx, "job-b")["state"], "cancelled", "start overwrote a cancelled reservation; its state")
	ctx.Assert(harnessBudgetSubmit(ctx, "job-c", 20), "job-c must be reserved")
	// the team cancels job-c from another replica, landing right after start's first command on the reservation
	probe := ctx.Redis.After("ft:reservation:job-c", func() any {
		res := harnessBudgetReservation(ctx, "job-c")
		if res["state"] == "queued" || res["state"] == "running" {
			reserved, _ := strconv.ParseInt(res["reserved"], 10, 64)
			spent, _ := strconv.ParseInt(res["spent"], 10, 64)
			ctx.Redis.Do("INCRBY", harnessBudgetPool, reserved-spent)
			ctx.Redis.Do("LREM", harnessBudgetQueue, 0, "job-c")
			ctx.Redis.Do("HSET", "ft:reservation:job-c", "state", "cancelled")
		}
		return nil
	})
	harnessBudgetStart(ctx, "job-c")
	ctx.Assert(probe.Fired, "start never touched job-c's reservation")
	ctx.Equal(harnessBudgetReservation(ctx, "job-c")["state"], "cancelled", "a cancel landed between start's commands and start overwrote it, though job-c's hours went back to the pool: check and move the state in one script; job-c's state")
}

func CheckReleaseOnce(ctx *harness.Ctx) {
	harnessBudgetSeed(ctx, 1000)
	ctx.Assert(harnessBudgetSubmit(ctx, "job-a", 600) && harnessBudgetStart(ctx, "job-a"), "job-a must be reserved and started")
	ctx.Equal(harnessBudgetComplete(ctx, "job-a", 450), 150, "600 reserved, 450 spent: complete returns")
	ctx.Equal(harnessBudgetBalance(ctx), 550, "the pool after the remainder came back")
	again := harnessBudgetComplete(ctx, "job-a", 450)
	ctx.Assert(again == 0 && harnessBudgetBalance(ctx) == 550, "the trainer's completion callback arrived twice and the second returned %d, leaving the pool at %d: the remainder goes back once", again, harnessBudgetBalance(ctx))
	res := harnessBudgetReservation(ctx, "job-a")
	ctx.Assert(res["spent"] == "450" && res["state"] == "completed", "the reservation must read spent 450, state completed: %v", res)
	ctx.Assert(harnessBudgetSubmit(ctx, "job-b", 300) && harnessBudgetStart(ctx, "job-b"), "job-b must be reserved and started")
	over := harnessBudgetComplete(ctx, "job-b", 500)
	ctx.Assert(over == 0 && harnessBudgetBalance(ctx) == 250, "a run that spent 500 of 300 reserved hours returned %d and left the pool at %d, expected 0 and 250: a release never takes more from the pool", over, harnessBudgetBalance(ctx))
	ctx.Assert(harnessBudgetSubmit(ctx, "job-c", 100) && harnessBudgetStart(ctx, "job-c"), "job-c must be reserved and started")
	// the same completion delivered again, landing right after this one's first command on the reservation
	probe := ctx.Redis.After("ft:reservation:job-c", func() any {
		res := harnessBudgetReservation(ctx, "job-c")
		if res["state"] == "running" {
			reserved, _ := strconv.ParseInt(res["reserved"], 10, 64)
			ctx.Redis.Do("INCRBY", harnessBudgetPool, reserved-60)
			ctx.Redis.Do("HSET", "ft:reservation:job-c", "spent", 60, "state", "completed")
		}
		return nil
	})
	harnessBudgetComplete(ctx, "job-c", 60)
	ctx.Assert(probe.Fired, "complete never touched job-c's reservation")
	ctx.Equal(harnessBudgetBalance(ctx), 190, "a duplicate completion landed between this completion's commands: the 40-hour remainder went back twice. Check the state and release in one script; the pool")
	ctx.Assert(harnessBudgetSubmit(ctx, "job-d", 50), "job-d must be reserved")
	early := harnessBudgetComplete(ctx, "job-d", 0)
	ctx.Assert(early == 0 && harnessBudgetBalance(ctx) == 140 && harnessBudgetReservation(ctx, "job-d")["state"] == "queued", "job-d never started, yet complete returned %d: pool %d, %v; only a running reservation completes", early, harnessBudgetBalance(ctx), harnessBudgetReservation(ctx, "job-d"))
	ctx.Equal(harnessBudgetCancel(ctx, "job-d"), 50, "cancelling queued job-d frees")
	late := harnessBudgetComplete(ctx, "job-d", 0)
	ctx.Assert(late == 0 && harnessBudgetBalance(ctx) == 190 && harnessBudgetReservation(ctx, "job-d")["state"] == "cancelled", "a completion after the cancel returned %d: pool %d, %v; a cancelled job's hours went back already", late, harnessBudgetBalance(ctx), harnessBudgetReservation(ctx, "job-d"))
}

func CheckCancelFrees(ctx *harness.Ctx) {
	harnessBudgetSeed(ctx, 1000)
	ctx.Assert(harnessBudgetSubmit(ctx, "job-a", 600), "job-a must be reserved")
	freed := harnessBudgetCancel(ctx, "job-a")
	ctx.Assert(freed == 600 && harnessBudgetBalance(ctx) == 1000, "cancelling a queued job freed %d hours and left the pool at %d, expected 600 and 1000: a cancelled job keeps nothing", freed, harnessBudgetBalance(ctx))
	ctx.Assert(len(ctx.Redis.LRange(harnessBudgetQueue, 0, -1)) == 0 && harnessBudgetReservation(ctx, "job-a")["state"] == "cancelled", "a cancelled job leaves the queue and reads cancelled: queue %v, %v", ctx.Redis.LRange(harnessBudgetQueue, 0, -1), harnessBudgetReservation(ctx, "job-a"))
	ctx.Assert(harnessBudgetCancel(ctx, "job-a") == 0 && harnessBudgetBalance(ctx) == 1000, "a second cancel must free nothing, the pool holds %d", harnessBudgetBalance(ctx))
	ctx.Assert(harnessBudgetSubmit(ctx, "job-b", 200) && harnessBudgetStart(ctx, "job-b"), "job-b must be reserved and started")
	ctx.Equal(harnessBudgetComplete(ctx, "job-b", 150), 50, "200 reserved, 150 spent: complete returns")
	late := harnessBudgetCancel(ctx, "job-b")
	ctx.Assert(late == 0 && harnessBudgetBalance(ctx) == 850, "a cancel after completion freed %d and left the pool at %d, expected 0 and 850", late, harnessBudgetBalance(ctx))
	ctx.Assert(harnessBudgetSubmit(ctx, "job-c", 300) && harnessBudgetStart(ctx, "job-c"), "job-c must be reserved and started")
	running := harnessBudgetCancel(ctx, "job-c")
	ctx.Assert(running == 300 && harnessBudgetBalance(ctx) == 850 && harnessBudgetReservation(ctx, "job-c")["state"] == "cancelled", "cancelling a running job freed %d and left the pool at %d, expected 300 and 850: %v", running, harnessBudgetBalance(ctx), harnessBudgetReservation(ctx, "job-c"))
	ghost := harnessBudgetCancel(ctx, "job-ghost")
	ctx.Assert(ghost == 0 && harnessBudgetBalance(ctx) == 850 && len(harnessBudgetReservation(ctx, "job-ghost")) == 0, "cancelling a job with no reservation freed %d, pool %d, wrote %v", ghost, harnessBudgetBalance(ctx), harnessBudgetReservation(ctx, "job-ghost"))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cstdlib>
#include <string>

namespace {

const std::string kHarnessTeam = "ml-search";
const std::string kHarnessPool = "ft:pool:ml-search";
const std::string kHarnessQueue = "ft:queue:ml-search";

long long harnessBalance(harness::Ctx& ctx) {
  const auto raw = ctx.Redis.Get(kHarnessPool);
  return raw ? std::strtoll(raw->c_str(), nullptr, 10) : 0;
}

std::string harnessField(harness::Ctx& ctx, const std::string& job_id, const std::string& name) {
  const auto all = ctx.Redis.HGetAll("ft:reservation:" + job_id);
  const auto it = all.find(name);
  return it == all.end() ? "" : it->second;
}

}  // namespace

void CheckReserveAtSubmit(harness::Ctx& ctx) {
  ctx.Redis.Set(kHarnessPool, 100);
  ctx.Assert(!submit(kHarnessTeam, "job-big", 150), "a pool of 100 hours cannot cover 150: submit must answer false");
  ctx.Equal(ctx.Redis.LRange(kHarnessQueue, 0, -1).size(), 0, "a job the pool cannot cover was queued anyway (%v): the queue must hold only jobs whose hours are reserved; queued jobs", ctx.Redis.LRange(kHarnessQueue, 0, -1));
  ctx.Equal(ctx.Redis.HGetAll("ft:reservation:job-big").size(), 0, "a refused submit wrote a reservation; fields");
  ctx.Equal(harnessBalance(ctx), 100, "a refused submit moved the pool");
  ctx.Assert(submit(kHarnessTeam, "job-ok", 60), "60 of 100 hours must be reserved");
  ctx.Equal(ctx.Redis.LRange(kHarnessQueue, 0, -1), {"job-ok"}, "the covered job must be queued once");
  ctx.Assert(harnessField(ctx, "job-ok", "reserved") == "60" && harnessField(ctx, "job-ok", "state") == "queued" && harnessField(ctx, "job-ok", "team") == kHarnessTeam,
             "the reservation must read team, reserved 60, state queued: %v", ctx.Redis.HGetAll("ft:reservation:job-ok"));
  ctx.Equal(harnessBalance(ctx), 40, "the pool must be drawn by 60");
  ctx.Assert(submit(kHarnessTeam, "job-exact", 40), "a pool of 40 hours covers a job of exactly 40: submit must answer true");
  ctx.Assert(harnessBalance(ctx) == 0 && ctx.Redis.LRange(kHarnessQueue, 0, -1).size() == 2, "the exact fit draws the pool to 0 and is queued: pool %d, queue %v", harnessBalance(ctx), ctx.Redis.LRange(kHarnessQueue, 0, -1));
  const bool one = submit(kHarnessTeam, "job-one", 1);
  ctx.Assert(!one && harnessBalance(ctx) == 0 && ctx.Redis.HGetAll("ft:reservation:job-one").empty(), "an empty pool cannot cover 1 hour: submit answered %v, pool %d, reservation %v", one, harnessBalance(ctx), ctx.Redis.HGetAll("ft:reservation:job-one"));
}

void CheckAtomicReserve(harness::Ctx& ctx) {
  ctx.Redis.Set(kHarnessPool, 100);
  bool fired = false;
  bool other = false;
  // another API replica submitting job-b for 80 hours, landing between this submit's commands
  ctx.Redis.After(kHarnessPool, [&] {
    fired = true;
    if (harnessBalance(ctx) >= 80) {
      ctx.Redis.Do("DECRBY", kHarnessPool, 80);
      other = true;
    }
  });
  const bool mine = submit(kHarnessTeam, "job-a", 60);
  ctx.Assert(fired, "submit never touched the pool");
  const long long drawn = (mine ? 60 : 0) + (other ? 80 : 0);
  ctx.Assert(harnessBalance(ctx) >= 0, "two submissions of 60 and 80 hours against a pool of 100 left it at %d: both passed the balance check before either drew, so the cluster is oversubscribed. Test and draw in one script", harnessBalance(ctx));
  ctx.Equal(harnessBalance(ctx), 100 - drawn, "the pool against what the successful submissions drew");
  ctx.Assert(mine || other, "one of the two submissions fits the pool and must succeed");
}

void CheckStartGuard(harness::Ctx& ctx) {
  ctx.Redis.Set(kHarnessPool, 100);
  ctx.Assert(!start(kHarnessTeam, "job-ghost"), "job-ghost has no reservation: start must answer false, a job cannot run on hours nobody reserved");
  ctx.Equal(ctx.Redis.HGetAll("ft:reservation:job-ghost").size(), 0, "start wrote a reservation for a job that never had one; fields");
  ctx.Assert(submit(kHarnessTeam, "job-a", 60), "job-a must be reserved");
  ctx.Assert(start(kHarnessTeam, "job-a"), "a queued job with a reservation must start");
  ctx.Assert(harnessField(ctx, "job-a", "state") == "running" && ctx.Redis.LRange(kHarnessQueue, 0, -1).empty(), "a started job is running and off the queue: %v, queue %v",
             ctx.Redis.HGetAll("ft:reservation:job-a"), ctx.Redis.LRange(kHarnessQueue, 0, -1));
  ctx.Assert(!start(kHarnessTeam, "job-a"), "a running job must not start a second time");
  ctx.Assert(submit(kHarnessTeam, "job-b", 30), "job-b must be reserved");
  cancel(kHarnessTeam, "job-b");
  ctx.Assert(!start(kHarnessTeam, "job-b"), "a cancelled job must not start: its reservation is gone");
  ctx.Equal(harnessField(ctx, "job-b", "state"), "cancelled", "start overwrote a cancelled reservation; its state");
  ctx.Assert(submit(kHarnessTeam, "job-c", 20), "job-c must be reserved");
  bool fired = false;
  // the team cancels job-c from another replica, landing right after start's first command on the reservation
  ctx.Redis.After("ft:reservation:job-c", [&] {
    fired = true;
    const std::string state = harnessField(ctx, "job-c", "state");
    if (state == "queued" || state == "running") {
      const long long back = std::strtoll(harnessField(ctx, "job-c", "reserved").c_str(), nullptr, 10) - std::strtoll(harnessField(ctx, "job-c", "spent").c_str(), nullptr, 10);
      ctx.Redis.Do("INCRBY", kHarnessPool, back);
      ctx.Redis.Do("LREM", kHarnessQueue, 0, "job-c");
      ctx.Redis.Do("HSET", "ft:reservation:job-c", "state", "cancelled");
    }
  });
  start(kHarnessTeam, "job-c");
  ctx.Assert(fired, "start never touched job-c's reservation");
  ctx.Equal(harnessField(ctx, "job-c", "state"), "cancelled", "a cancel landed between start's commands and start overwrote it, though job-c's hours went back to the pool: check and move the state in one script; job-c's state");
}

void CheckReleaseOnce(harness::Ctx& ctx) {
  ctx.Redis.Set(kHarnessPool, 1000);
  ctx.Assert(submit(kHarnessTeam, "job-a", 600) && start(kHarnessTeam, "job-a"), "job-a must be reserved and started");
  ctx.Equal(complete(kHarnessTeam, "job-a", 450), 150, "600 reserved, 450 spent: complete returns");
  ctx.Equal(harnessBalance(ctx), 550, "the pool after the remainder came back");
  const long long again = complete(kHarnessTeam, "job-a", 450);
  ctx.Assert(again == 0 && harnessBalance(ctx) == 550, "the trainer's completion callback arrived twice and the second returned %d, leaving the pool at %d: the remainder goes back once", again, harnessBalance(ctx));
  ctx.Assert(harnessField(ctx, "job-a", "spent") == "450" && harnessField(ctx, "job-a", "state") == "completed", "the reservation must read spent 450, state completed: %v", ctx.Redis.HGetAll("ft:reservation:job-a"));
  ctx.Assert(submit(kHarnessTeam, "job-b", 300) && start(kHarnessTeam, "job-b"), "job-b must be reserved and started");
  const long long over = complete(kHarnessTeam, "job-b", 500);
  ctx.Assert(over == 0 && harnessBalance(ctx) == 250, "a run that spent 500 of 300 reserved hours returned %d and left the pool at %d, expected 0 and 250: a release never takes more from the pool", over, harnessBalance(ctx));
  ctx.Assert(submit(kHarnessTeam, "job-c", 100) && start(kHarnessTeam, "job-c"), "job-c must be reserved and started");
  bool fired = false;
  // the same completion delivered again, landing right after this one's first command on the reservation
  ctx.Redis.After("ft:reservation:job-c", [&] {
    fired = true;
    if (harnessField(ctx, "job-c", "state") == "running") {
      ctx.Redis.Do("INCRBY", kHarnessPool, std::strtoll(harnessField(ctx, "job-c", "reserved").c_str(), nullptr, 10) - 60);
      ctx.Redis.Do("HSET", "ft:reservation:job-c", "spent", 60, "state", "completed");
    }
  });
  complete(kHarnessTeam, "job-c", 60);
  ctx.Assert(fired, "complete never touched job-c's reservation");
  ctx.Equal(harnessBalance(ctx), 190, "a duplicate completion landed between this completion's commands: the 40-hour remainder went back twice. Check the state and release in one script; the pool");
  ctx.Assert(submit(kHarnessTeam, "job-d", 50), "job-d must be reserved");
  const long long early = complete(kHarnessTeam, "job-d", 0);
  ctx.Assert(early == 0 && harnessBalance(ctx) == 140 && harnessField(ctx, "job-d", "state") == "queued", "job-d never started, yet complete returned %d: pool %d, %v; only a running reservation completes", early, harnessBalance(ctx), ctx.Redis.HGetAll("ft:reservation:job-d"));
  ctx.Equal(cancel(kHarnessTeam, "job-d"), 50, "cancelling queued job-d frees");
  const long long late = complete(kHarnessTeam, "job-d", 0);
  ctx.Assert(late == 0 && harnessBalance(ctx) == 190 && harnessField(ctx, "job-d", "state") == "cancelled", "a completion after the cancel returned %d: pool %d, %v; a cancelled job's hours went back already", late, harnessBalance(ctx), ctx.Redis.HGetAll("ft:reservation:job-d"));
}

void CheckCancelFrees(harness::Ctx& ctx) {
  ctx.Redis.Set(kHarnessPool, 1000);
  ctx.Assert(submit(kHarnessTeam, "job-a", 600), "job-a must be reserved");
  const long long freed = cancel(kHarnessTeam, "job-a");
  ctx.Assert(freed == 600 && harnessBalance(ctx) == 1000, "cancelling a queued job freed %d hours and left the pool at %d, expected 600 and 1000: a cancelled job keeps nothing", freed, harnessBalance(ctx));
  ctx.Assert(ctx.Redis.LRange(kHarnessQueue, 0, -1).empty() && harnessField(ctx, "job-a", "state") == "cancelled", "a cancelled job leaves the queue and reads cancelled: queue %v, %v",
             ctx.Redis.LRange(kHarnessQueue, 0, -1), ctx.Redis.HGetAll("ft:reservation:job-a"));
  ctx.Assert(cancel(kHarnessTeam, "job-a") == 0 && harnessBalance(ctx) == 1000, "a second cancel must free nothing, the pool holds %d", harnessBalance(ctx));
  ctx.Assert(submit(kHarnessTeam, "job-b", 200) && start(kHarnessTeam, "job-b"), "job-b must be reserved and started");
  ctx.Equal(complete(kHarnessTeam, "job-b", 150), 50, "200 reserved, 150 spent: complete returns");
  const long long late = cancel(kHarnessTeam, "job-b");
  ctx.Assert(late == 0 && harnessBalance(ctx) == 850, "a cancel after completion freed %d and left the pool at %d, expected 0 and 850", late, harnessBalance(ctx));
  ctx.Assert(submit(kHarnessTeam, "job-c", 300) && start(kHarnessTeam, "job-c"), "job-c must be reserved and started");
  const long long running = cancel(kHarnessTeam, "job-c");
  ctx.Assert(running == 300 && harnessBalance(ctx) == 850 && harnessField(ctx, "job-c", "state") == "cancelled", "cancelling a running job freed %d and left the pool at %d, expected 300 and 850: %v", running, harnessBalance(ctx), ctx.Redis.HGetAll("ft:reservation:job-c"));
  const long long ghost = cancel(kHarnessTeam, "job-ghost");
  ctx.Assert(ghost == 0 && harnessBalance(ctx) == 850 && ctx.Redis.HGetAll("ft:reservation:job-ghost").empty(), "cancelling a job with no reservation freed %d, pool %d, wrote %v", ghost, harnessBalance(ctx), ctx.Redis.HGetAll("ft:reservation:job-ghost"));
}
`,
  },
  hints: [
    'Symptom: the queue holds jobs that were refused, two replicas oversubscribe a pool into negative hours, a duplicated completion callback grows the pool, and a cancelled job keeps its hours.',
    'Mechanism: `submit` pushes before it checks and reads the balance in one command and draws it in another; `start` checks nothing; `complete` has no state to tell a retry apart; `cancel` returns the `spent` field, which is 0 for a job that never ran.',
    "Change: one `register_script` (`defineCommand`, `NewScript`, `eval`) per move. `submit`: GET, compare, DECRBY, HSET, RPUSH. `start`: `state ~= 'queued'` returns 0. `complete`: only from `running`, INCRBY `reserved - min(spent, reserved)`. `cancel`: from queued or running, INCRBY `reserved - spent`, LREM, `cancelled`.",
  ],
  debrief: `A reservation is a small state machine, and each script is one edge of it: Redis runs a script alone, so the test and the write cannot be split by another replica, and the state field is what makes a retried edge a no-op. That is the shape the double completion needed: the trainer's callback will arrive twice one day, and only state that changes with the first call can recognise the second. Pushing to the queue inside the same script means the queue holds only jobs whose hours are drawn. A production scheduler also expires abandoned reservations, keeps a per-team ledger of every draw and release for reconciliation, and shards pools by cluster so one script stays inside one region.`,
};
