import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Shard leases: claim, heartbeat, complete, reap',
  concept: 'redis',
  guides: ['atomic-state', 'leases'],
  file: 'state',
  focus: ['worker', 'redis'],
  task: `## Task

**Starting point.** The starter leases shards over the keys \`batch/config\` defines. \`claim(batch_id,
worker_id)\` pops \`batch:pending:{id}\`, then writes the owner, a deadline \`LEASE_S\` ahead and state
\`running\`; \`heartbeat\` writes the owner and a new deadline; \`complete(…, outcome)\` writes the outcome
and drops the owner; \`reap\` takes the shards whose deadline passed and marks them \`failed\`. A healthy
demo finishes. It hides 5 flaws.

**Failure mode the checks target.** On a million-record batch workers die mid-shard, and the lease is
what survives that. A worker that dies between the pop and the lease takes a shard with it; a heartbeat
that does not look at the owner hands a running shard to a second worker; a dead worker's shard marked
\`failed\` fails the batch; the worker the reaper replaced can still complete the shard; and a done shard
whose deadline stays behind is run again.

Requirements, each operation **one Lua script** (\`register_script\`, \`defineCommand\`, \`NewScript\`,
\`eval\`):

- \`claim\`: \`LPOP\`, owner, deadline \`now + LEASE_S\` and state \`running\` together; nothing when the
  list is empty.
- \`heartbeat\`: only the owner moves its deadline; anyone else gets \`false\` and changes nothing.
- \`complete\`: only the owner; drops the owner and the deadline, writes \`done\` or \`failed\`.
- \`reap\`: every shard whose deadline is at or before now goes back to \`pending\` (the list and the
  state), its owner and deadline gone.`,
  sequence: {
    participants: ['Worker A', 'Redis', 'Worker B'],
    messages: [
      {from: 'Worker A', to: 'Redis', label: 'EVALSHA claim · LPOP · HSET owner · ZADD deadline', kind: 'sync'},
      {from: 'Redis', to: 'Worker A', label: 'shard 0', kind: 'reply'},
      {from: 'Worker B', to: 'Redis', label: 'EVALSHA heartbeat 0 · owner is A', kind: 'sync'},
      {from: 'Redis', to: 'Worker B', label: '0 (not yours)', kind: 'reply'},
      {from: 'Worker B', to: 'Redis', label: 'EVALSHA reap · deadline passed → RPUSH pending', kind: 'sync'},
      {from: 'Worker B', to: 'Redis', label: 'EVALSHA claim → shard 0', kind: 'sync'},
      {from: 'Worker A', to: 'Redis', label: 'EVALSHA complete 0 · owner is B', kind: 'sync'},
      {from: 'Redis', to: 'Worker A', label: '0 (fenced)', kind: 'reply'},
    ],
  },
  hints: [
    "Symptom: after a worker crash one shard is in neither the queue nor anyone's lease, two workers run the same shard, a batch whose worker died reports a failed shard, and a finished shard runs a second time 30 seconds later.",
    'Mechanism: `claim` is separate round trips, so a crash after `LPOP` drops the shard; `heartbeat` and `complete` write without comparing the owner; `reap` writes `failed` instead of requeueing; `complete` leaves the deadline in the sorted set.',
    'Change: one script per operation. claim: LPOP, HSET owner, ZADD deadline, HSET running. heartbeat and complete: `HGET` owner first, return 0 on a mismatch; complete then HDEL, ZREM, HSET outcome. reap: ZRANGEBYSCORE, then ZREM, HDEL, HSET pending, RPUSH.',
  ],
  checks: [
    {
      id: 'claim-atomic',
      title: 'Claims a shard in one script',
      detail:
        'At the instant claim first touches the pending list, every shard is either still pending or owned, so a worker dying there loses nothing; claims hand out 0, 1, 2 in order with a deadline LEASE_S ahead, and an empty list claims nothing. The starter pops first and leases in later round trips.',
      match: {
        python: {all: [/register_script\(|\.eval\(|\.evalsha\(/, /redis\.call\(\s*['"]LPOP['"]/], none: [/\.lpop\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(|\.evalsha\(/, /redis\.call\(\s*['"]LPOP['"]/], none: [/\.lpop\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(|\.EvalSha\(/, /redis\.call\(\s*['"]LPOP['"]/], none: [/\.LPop\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]LPOP['"]/], none: [/\.lpop\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]LPOP['"]/], none: [/\.lpop\(/]},
      },
    },
    {
      id: 'owner-heartbeat',
      title: 'Only the owner extends its lease',
      detail:
        "A heartbeat from a worker that does not hold the shard answers false and leaves owner and deadline alone; the owner's heartbeat moves the deadline to now + LEASE_S, so a reap 40 s after the claim and 20 s after the heartbeat takes nothing. The starter's heartbeat makes the caller the owner.",
      match: {
        python: {all: [/['"]HGET['"][\s\S]{0,200}?['"]ZADD['"]/]},
        typescript: {all: [/['"]HGET['"][\s\S]{0,200}?['"]ZADD['"]/]},
        go: {all: [/['"]HGET['"][\s\S]{0,200}?['"]ZADD['"]/]},
        scala: {all: [/['"]HGET['"][\s\S]{0,200}?['"]ZADD['"]/]},
        cpp: {all: [/['"]HGET['"][\s\S]{0,200}?['"]ZADD['"]/]},
      },
    },
    {
      id: 'reaper-requeue',
      title: "Requeues a dead worker's shard",
      detail:
        'A shard whose deadline passed (its worker stopped heartbeating) is returned by reap, set back to pending, pushed on the pending list without owner or deadline, and the next claim takes it. The starter marks it failed, so one crash fails the batch.',
      match: {
        python: {all: [/redis\.call\(\s*['"]RPUSH['"]|\.rpush\(/], none: [/\.hset\([^\n]*["']failed["']/]},
        typescript: {all: [/redis\.call\(\s*['"]RPUSH['"]|\.rpush\(/], none: [/\.hset\([^\n]*['"]failed['"]/]},
        go: {all: [/redis\.call\(\s*['"]RPUSH['"]|\.RPush\(/], none: [/\.HSet\([^\n]*"failed"/]},
        scala: {all: [/redis\.call\(\s*['"]RPUSH['"]|\.rpush\(/], none: [/\.hset\([^\n]*"failed"/]},
        cpp: {all: [/redis\.call\(\s*['"]RPUSH['"]|\.rpush\(/], none: [/\.hset\([^\n]*"failed"/]},
      },
    },
    {
      id: 'fenced-complete',
      title: 'Refuses a completion from a replaced worker',
      detail:
        'After the reaper gave shard 0 to w-b, a complete from w-a (who stalled past its lease) answers false and changes nothing; w-b completes it. The starter lets any caller write the outcome.',
      match: {
        python: {all: [/['"]HGET['"][\s\S]{0,200}?['"]HDEL['"]/]},
        typescript: {all: [/['"]HGET['"][\s\S]{0,200}?['"]HDEL['"]/]},
        go: {all: [/['"]HGET['"][\s\S]{0,200}?['"]HDEL['"]/]},
        scala: {all: [/['"]HGET['"][\s\S]{0,200}?['"]HDEL['"]/]},
        cpp: {all: [/['"]HGET['"][\s\S]{0,200}?['"]HDEL['"]/]},
      },
    },
    {
      id: 'complete-clears-deadline',
      title: 'A completed shard leaves no deadline behind',
      detail:
        'complete removes the shard from batch:deadlines, so a reap after the old deadline takes nothing and the shard stays done. The starter leaves the deadline, and the reaper hands a finished shard out again.',
      match: {
        python: {all: [/['"]HDEL['"][\s\S]{0,200}?['"]ZREM['"]|\.hdel\([^\n]*\n[^\n]*\.zrem\(/]},
        typescript: {all: [/['"]HDEL['"][\s\S]{0,200}?['"]ZREM['"]|\.hdel\([^\n]*\n[^\n]*\.zrem\(/]},
        go: {all: [/['"]HDEL['"][\s\S]{0,200}?['"]ZREM['"]|\.HDel\([^\n]*\n[^\n]*\.ZRem\(/]},
        scala: {all: [/['"]HDEL['"][\s\S]{0,200}?['"]ZREM['"]|\.hdel\([^\n]*\n[^\n]*\.zrem\(/]},
        cpp: {all: [/['"]HDEL['"][\s\S]{0,200}?['"]ZREM['"]|\.hdel\([^\n]*\n[^\n]*\.zrem\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

from batch.config import LEASE_S, deadlines_key, owners_key, pending_key, shards_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def claim(batch_id: str, worker_id: str) -> str | None:
    """Take the next pending shard and lease it to worker_id for LEASE_S; None when nothing is pending."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    shard = r.lpop(pending_key(batch_id))
    if shard is None:
        return None
    r.hset(owners_key(batch_id), shard, worker_id)
    r.zadd(deadlines_key(batch_id), {shard: int(time.time()) + LEASE_S})
    r.hset(shards_key(batch_id), shard, "running")
    return shard


def heartbeat(batch_id: str, shard: str, worker_id: str) -> bool:
    """Extend worker_id's lease on shard by LEASE_S; False when the lease is not worker_id's."""
    r.hset(owners_key(batch_id), shard, worker_id)
    r.zadd(deadlines_key(batch_id), {shard: int(time.time()) + LEASE_S})
    return True


def complete(batch_id: str, shard: str, worker_id: str, outcome: str) -> bool:
    """Record the shard's outcome (done or failed) and release the lease; False when it is not worker_id's."""
    r.hset(shards_key(batch_id), shard, outcome)
    r.hdel(owners_key(batch_id), shard)
    return True


def reap(batch_id: str) -> list[str]:
    """The shards whose lease ran out, handled so another worker can take them over."""
    expired = r.zrangebyscore(deadlines_key(batch_id), "-inf", int(time.time()))
    for shard in expired:
        r.zrem(deadlines_key(batch_id), shard)
        r.hset(shards_key(batch_id), shard, "failed")
    return expired
`,
      solution: `import time

import redis

from batch.config import LEASE_S, deadlines_key, owners_key, pending_key, shards_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CLAIM = """
local shard = redis.call('LPOP', KEYS[1])
if not shard then return false end
redis.call('HSET', KEYS[2], shard, ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[2], shard)
redis.call('HSET', KEYS[4], shard, 'running')
return shard
"""

HEARTBEAT = """
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return 1
"""

COMPLETE = """
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[3])
return 1
"""

REAP = """
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, shard in ipairs(expired) do
  redis.call('ZREM', KEYS[1], shard)
  redis.call('HDEL', KEYS[2], shard)
  redis.call('HSET', KEYS[3], shard, 'pending')
  redis.call('RPUSH', KEYS[4], shard)
end
return expired
"""

claim_shard = r.register_script(CLAIM)
extend_lease = r.register_script(HEARTBEAT)
complete_shard = r.register_script(COMPLETE)
reap_expired = r.register_script(REAP)


def claim(batch_id: str, worker_id: str) -> str | None:
    """Take the next pending shard and lease it to worker_id for LEASE_S; None when nothing is pending."""
    return claim_shard(
        keys=[pending_key(batch_id), owners_key(batch_id), deadlines_key(batch_id), shards_key(batch_id)],
        args=[worker_id, int(time.time()) + LEASE_S],
    )


def heartbeat(batch_id: str, shard: str, worker_id: str) -> bool:
    """Extend worker_id's lease on shard by LEASE_S; False when the lease is not worker_id's."""
    extended = extend_lease(keys=[owners_key(batch_id), deadlines_key(batch_id)], args=[shard, worker_id, int(time.time()) + LEASE_S])
    return extended == 1


def complete(batch_id: str, shard: str, worker_id: str, outcome: str) -> bool:
    """Record the shard's outcome (done or failed) and release the lease; False when it is not worker_id's."""
    completed = complete_shard(keys=[owners_key(batch_id), deadlines_key(batch_id), shards_key(batch_id)], args=[shard, worker_id, outcome])
    return completed == 1


def reap(batch_id: str) -> list[str]:
    """The shards whose lease ran out, handled so another worker can take them over."""
    return reap_expired(
        keys=[deadlines_key(batch_id), owners_key(batch_id), shards_key(batch_id), pending_key(batch_id)],
        args=[int(time.time())],
    )
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {LEASE_S, deadlinesKey, ownersKey, pendingKey, shardsKey} from 'batch/config';

export const redis = new Redis({host: 'redis', port: 6379});

const now = (): number => Math.floor(Date.now() / 1000);

/** Take the next pending shard and lease it to workerId for LEASE_S; null when nothing is pending. */
export async function claim(batchId: string, workerId: string): Promise<string | null> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const shard = await redis.lpop(pendingKey(batchId));
  if (shard === null) return null;
  await redis.hset(ownersKey(batchId), shard, workerId);
  await redis.zadd(deadlinesKey(batchId), now() + LEASE_S, shard);
  await redis.hset(shardsKey(batchId), shard, 'running');
  return shard;
}

/** Extend workerId's lease on shard by LEASE_S; false when the lease is not workerId's. */
export async function heartbeat(batchId: string, shard: string, workerId: string): Promise<boolean> {
  await redis.hset(ownersKey(batchId), shard, workerId);
  await redis.zadd(deadlinesKey(batchId), now() + LEASE_S, shard);
  return true;
}

/** Record the shard's outcome (done or failed) and release the lease; false when it is not workerId's. */
export async function complete(batchId: string, shard: string, workerId: string, outcome: string): Promise<boolean> {
  await redis.hset(shardsKey(batchId), shard, outcome);
  await redis.hdel(ownersKey(batchId), shard);
  return true;
}

/** The shards whose lease ran out, handled so another worker can take them over. */
export async function reap(batchId: string): Promise<string[]> {
  const expired = await redis.zrangebyscore(deadlinesKey(batchId), '-inf', now());
  for (const shard of expired) {
    await redis.zrem(deadlinesKey(batchId), shard);
    await redis.hset(shardsKey(batchId), shard, 'failed');
  }
  return expired;
}
`,
      solution: `import Redis from 'ioredis';

import {LEASE_S, deadlinesKey, ownersKey, pendingKey, shardsKey} from 'batch/config';

const CLAIM = \`
local shard = redis.call('LPOP', KEYS[1])
if not shard then return false end
redis.call('HSET', KEYS[2], shard, ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[2], shard)
redis.call('HSET', KEYS[4], shard, 'running')
return shard
\`;

const HEARTBEAT = \`
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return 1
\`;

const COMPLETE = \`
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[3])
return 1
\`;

const REAP = \`
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, shard in ipairs(expired) do
  redis.call('ZREM', KEYS[1], shard)
  redis.call('HDEL', KEYS[2], shard)
  redis.call('HSET', KEYS[3], shard, 'pending')
  redis.call('RPUSH', KEYS[4], shard)
end
return expired
\`;

interface LeaseRedis extends Redis {
  claimShard(pending: string, owners: string, deadlines: string, shards: string, worker: string, deadline: number): Promise<string | null>;
  extendLease(owners: string, deadlines: string, shard: string, worker: string, deadline: number): Promise<number>;
  completeShard(owners: string, deadlines: string, shards: string, shard: string, worker: string, outcome: string): Promise<number>;
  reapExpired(deadlines: string, owners: string, shards: string, pending: string, now: number): Promise<string[]>;
}

export const redis = new Redis({host: 'redis', port: 6379}) as LeaseRedis;
redis.defineCommand('claimShard', {numberOfKeys: 4, lua: CLAIM});
redis.defineCommand('extendLease', {numberOfKeys: 2, lua: HEARTBEAT});
redis.defineCommand('completeShard', {numberOfKeys: 3, lua: COMPLETE});
redis.defineCommand('reapExpired', {numberOfKeys: 4, lua: REAP});

const now = (): number => Math.floor(Date.now() / 1000);

/** Take the next pending shard and lease it to workerId for LEASE_S; null when nothing is pending. */
export async function claim(batchId: string, workerId: string): Promise<string | null> {
  return redis.claimShard(pendingKey(batchId), ownersKey(batchId), deadlinesKey(batchId), shardsKey(batchId), workerId, now() + LEASE_S);
}

/** Extend workerId's lease on shard by LEASE_S; false when the lease is not workerId's. */
export async function heartbeat(batchId: string, shard: string, workerId: string): Promise<boolean> {
  return (await redis.extendLease(ownersKey(batchId), deadlinesKey(batchId), shard, workerId, now() + LEASE_S)) === 1;
}

/** Record the shard's outcome (done or failed) and release the lease; false when it is not workerId's. */
export async function complete(batchId: string, shard: string, workerId: string, outcome: string): Promise<boolean> {
  return (await redis.completeShard(ownersKey(batchId), deadlinesKey(batchId), shardsKey(batchId), shard, workerId, outcome)) === 1;
}

/** The shards whose lease ran out, handled so another worker can take them over. */
export async function reap(batchId: string): Promise<string[]> {
  return redis.reapExpired(deadlinesKey(batchId), ownersKey(batchId), shardsKey(batchId), pendingKey(batchId), now());
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"batch/config" // config.LeaseSeconds, config.PendingKey/OwnersKey/DeadlinesKey/ShardsKey — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// claim takes the next pending shard and leases it to workerID for LeaseSeconds; "" when nothing is pending.
func claim(ctx context.Context, batchID, workerID string) (string, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	shard, err := rdb.LPop(ctx, config.PendingKey(batchID)).Result()
	if errors.Is(err, redis.Nil) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	rdb.HSet(ctx, config.OwnersKey(batchID), shard, workerID)
	rdb.ZAdd(ctx, config.DeadlinesKey(batchID), redis.Z{Score: float64(time.Now().Unix() + config.LeaseSeconds), Member: shard})
	rdb.HSet(ctx, config.ShardsKey(batchID), shard, "running")
	return shard, nil
}

// heartbeat extends workerID's lease on shard by LeaseSeconds; false when the lease is not workerID's.
func heartbeat(ctx context.Context, batchID, shard, workerID string) (bool, error) {
	rdb.HSet(ctx, config.OwnersKey(batchID), shard, workerID)
	if err := rdb.ZAdd(ctx, config.DeadlinesKey(batchID), redis.Z{Score: float64(time.Now().Unix() + config.LeaseSeconds), Member: shard}).Err(); err != nil {
		return false, err
	}
	return true, nil
}

// complete records the shard's outcome (done or failed) and releases the lease; false when it is not workerID's.
func complete(ctx context.Context, batchID, shard, workerID, outcome string) (bool, error) {
	rdb.HSet(ctx, config.ShardsKey(batchID), shard, outcome)
	if err := rdb.HDel(ctx, config.OwnersKey(batchID), shard).Err(); err != nil {
		return false, err
	}
	return true, nil
}

// reap handles the shards whose lease ran out so another worker can take them over; it returns them.
func reap(ctx context.Context, batchID string) ([]string, error) {
	expired, err := rdb.ZRangeByScore(ctx, config.DeadlinesKey(batchID), &redis.ZRangeBy{Min: "-inf", Max: strconv.FormatInt(time.Now().Unix(), 10)}).Result()
	if err != nil {
		return nil, err
	}
	for _, shard := range expired {
		rdb.ZRem(ctx, config.DeadlinesKey(batchID), shard)
		rdb.HSet(ctx, config.ShardsKey(batchID), shard, "failed")
	}
	return expired, nil
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"

	"batch/config" // config.LeaseSeconds, config.PendingKey/OwnersKey/DeadlinesKey/ShardsKey — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var claimShard = redis.NewScript(\`
local shard = redis.call('LPOP', KEYS[1])
if not shard then return false end
redis.call('HSET', KEYS[2], shard, ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[2], shard)
redis.call('HSET', KEYS[4], shard, 'running')
return shard
\`)

var extendLease = redis.NewScript(\`
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return 1
\`)

var completeShard = redis.NewScript(\`
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[3])
return 1
\`)

var reapExpired = redis.NewScript(\`
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, shard in ipairs(expired) do
  redis.call('ZREM', KEYS[1], shard)
  redis.call('HDEL', KEYS[2], shard)
  redis.call('HSET', KEYS[3], shard, 'pending')
  redis.call('RPUSH', KEYS[4], shard)
end
return expired
\`)

// claim takes the next pending shard and leases it to workerID for LeaseSeconds; "" when nothing is pending.
func claim(ctx context.Context, batchID, workerID string) (string, error) {
	keys := []string{config.PendingKey(batchID), config.OwnersKey(batchID), config.DeadlinesKey(batchID), config.ShardsKey(batchID)}
	shard, err := claimShard.Run(ctx, rdb, keys, workerID, time.Now().Unix()+config.LeaseSeconds).Text()
	if errors.Is(err, redis.Nil) {
		return "", nil
	}
	return shard, err
}

// heartbeat extends workerID's lease on shard by LeaseSeconds; false when the lease is not workerID's.
func heartbeat(ctx context.Context, batchID, shard, workerID string) (bool, error) {
	keys := []string{config.OwnersKey(batchID), config.DeadlinesKey(batchID)}
	extended, err := extendLease.Run(ctx, rdb, keys, shard, workerID, time.Now().Unix()+config.LeaseSeconds).Int()
	return extended == 1, err
}

// complete records the shard's outcome (done or failed) and releases the lease; false when it is not workerID's.
func complete(ctx context.Context, batchID, shard, workerID, outcome string) (bool, error) {
	keys := []string{config.OwnersKey(batchID), config.DeadlinesKey(batchID), config.ShardsKey(batchID)}
	completed, err := completeShard.Run(ctx, rdb, keys, shard, workerID, outcome).Int()
	return completed == 1, err
}

// reap handles the shards whose lease ran out so another worker can take them over; it returns them.
func reap(ctx context.Context, batchID string) ([]string, error) {
	keys := []string{config.DeadlinesKey(batchID), config.OwnersKey(batchID), config.ShardsKey(batchID), config.PendingKey(batchID)}
	return reapExpired.Run(ctx, rdb, keys, time.Now().Unix()).StringSlice()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import batch.Config

object ShardLeases {
  private val jedis = new JedisPooled("redis", 6379)

  private def now(): Long = System.currentTimeMillis() / 1000

  /** Take the next pending shard and lease it to workerId for LeaseSeconds; None when nothing is pending. */
  def claim(batchId: String, workerId: String): Option[String] = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val shard = Option(jedis.lpop(Config.pendingKey(batchId)))
    shard.foreach { s =>
      jedis.hset(Config.ownersKey(batchId), s, workerId)
      jedis.zadd(Config.deadlinesKey(batchId), (now() + Config.LeaseSeconds).toDouble, s)
      jedis.hset(Config.shardsKey(batchId), s, "running")
    }
    shard
  }

  /** Extend workerId's lease on shard by LeaseSeconds; false when the lease is not workerId's. */
  def heartbeat(batchId: String, shard: String, workerId: String): Boolean = {
    jedis.hset(Config.ownersKey(batchId), shard, workerId)
    jedis.zadd(Config.deadlinesKey(batchId), (now() + Config.LeaseSeconds).toDouble, shard)
    true
  }

  /** Record the shard's outcome (done or failed) and release the lease; false when it is not workerId's. */
  def complete(batchId: String, shard: String, workerId: String, outcome: String): Boolean = {
    jedis.hset(Config.shardsKey(batchId), shard, outcome)
    jedis.hdel(Config.ownersKey(batchId), shard)
    true
  }

  /** The shards whose lease ran out, handled so another worker can take them over. */
  def reap(batchId: String): List[String] = {
    val expired = jedis.zrangeByScore(Config.deadlinesKey(batchId), "-inf", now().toString).asScala.toList
    expired.foreach { shard =>
      jedis.zrem(Config.deadlinesKey(batchId), shard)
      jedis.hset(Config.shardsKey(batchId), shard, "failed")
    }
    expired
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import batch.Config

object ShardLeases {
  private val jedis = new JedisPooled("redis", 6379)

  private val Claim = """
local shard = redis.call('LPOP', KEYS[1])
if not shard then return false end
redis.call('HSET', KEYS[2], shard, ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[2], shard)
redis.call('HSET', KEYS[4], shard, 'running')
return shard
"""

  private val Heartbeat = """
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return 1
"""

  private val Complete = """
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[3])
return 1
"""

  private val Reap = """
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, shard in ipairs(expired) do
  redis.call('ZREM', KEYS[1], shard)
  redis.call('HDEL', KEYS[2], shard)
  redis.call('HSET', KEYS[3], shard, 'pending')
  redis.call('RPUSH', KEYS[4], shard)
end
return expired
"""

  private def now(): Long = System.currentTimeMillis() / 1000

  /** Take the next pending shard and lease it to workerId for LeaseSeconds; None when nothing is pending. */
  def claim(batchId: String, workerId: String): Option[String] = {
    val keys = List(Config.pendingKey(batchId), Config.ownersKey(batchId), Config.deadlinesKey(batchId), Config.shardsKey(batchId))
    Option(jedis.eval(Claim, keys.asJava, List(workerId, (now() + Config.LeaseSeconds).toString).asJava)).map(_.toString)
  }

  /** Extend workerId's lease on shard by LeaseSeconds; false when the lease is not workerId's. */
  def heartbeat(batchId: String, shard: String, workerId: String): Boolean = {
    val keys = List(Config.ownersKey(batchId), Config.deadlinesKey(batchId))
    jedis.eval(Heartbeat, keys.asJava, List(shard, workerId, (now() + Config.LeaseSeconds).toString).asJava) == 1L
  }

  /** Record the shard's outcome (done or failed) and release the lease; false when it is not workerId's. */
  def complete(batchId: String, shard: String, workerId: String, outcome: String): Boolean = {
    val keys = List(Config.ownersKey(batchId), Config.deadlinesKey(batchId), Config.shardsKey(batchId))
    jedis.eval(Complete, keys.asJava, List(shard, workerId, outcome).asJava) == 1L
  }

  /** The shards whose lease ran out, handled so another worker can take them over. */
  def reap(batchId: String): List[String] = {
    val keys = List(Config.deadlinesKey(batchId), Config.ownersKey(batchId), Config.shardsKey(batchId), Config.pendingKey(batchId))
    jedis.eval(Reap, keys.asJava, List(now().toString).asJava).asInstanceOf[java.util.List[AnyRef]].asScala.map(_.toString).toList
  }
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

#include "batch/config.h"  // config::kLeaseSeconds, config::pending_key/owners_key/deadlines_key/shards_key — provided

sw::redis::Redis redis("tcp://redis:6379");

long long now_s() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Take the next pending shard and lease it to worker_id for kLeaseSeconds; nullopt when nothing is pending.
std::optional<std::string> claim(const std::string& batch_id, const std::string& worker_id) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const auto shard = redis.lpop(config::pending_key(batch_id));
  if (!shard) return std::nullopt;
  redis.hset(config::owners_key(batch_id), *shard, worker_id);
  redis.zadd(config::deadlines_key(batch_id), *shard, static_cast<double>(now_s() + config::kLeaseSeconds));
  redis.hset(config::shards_key(batch_id), *shard, "running");
  return *shard;
}

// Extend worker_id's lease on shard by kLeaseSeconds; false when the lease is not worker_id's.
bool heartbeat(const std::string& batch_id, const std::string& shard, const std::string& worker_id) {
  redis.hset(config::owners_key(batch_id), shard, worker_id);
  redis.zadd(config::deadlines_key(batch_id), shard, static_cast<double>(now_s() + config::kLeaseSeconds));
  return true;
}

// Record the shard's outcome (done or failed) and release the lease; false when it is not worker_id's.
bool complete(const std::string& batch_id, const std::string& shard, const std::string& worker_id, const std::string& outcome) {
  redis.hset(config::shards_key(batch_id), shard, outcome);
  redis.hdel(config::owners_key(batch_id), shard);
  return true;
}

// The shards whose lease ran out, handled so another worker can take them over.
std::vector<std::string> reap(const std::string& batch_id) {
  std::vector<std::string> expired;
  redis.zrangebyscore(config::deadlines_key(batch_id),
                      sw::redis::RightBoundedInterval<double>(static_cast<double>(now_s()), sw::redis::BoundType::CLOSED),
                      std::back_inserter(expired));
  for (const auto& shard : expired) {
    redis.zrem(config::deadlines_key(batch_id), shard);
    redis.hset(config::shards_key(batch_id), shard, "failed");
  }
  return expired;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <vector>

#include "batch/config.h"  // config::kLeaseSeconds, config::pending_key/owners_key/deadlines_key/shards_key — provided

sw::redis::Redis redis("tcp://redis:6379");

const std::string kClaim = R"(
local shard = redis.call('LPOP', KEYS[1])
if not shard then return false end
redis.call('HSET', KEYS[2], shard, ARGV[1])
redis.call('ZADD', KEYS[3], ARGV[2], shard)
redis.call('HSET', KEYS[4], shard, 'running')
return shard
)";

const std::string kHeartbeat = R"(
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[1])
return 1
)";

const std::string kComplete = R"(
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HSET', KEYS[3], ARGV[1], ARGV[3])
return 1
)";

const std::string kReap = R"(
local expired = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
for _, shard in ipairs(expired) do
  redis.call('ZREM', KEYS[1], shard)
  redis.call('HDEL', KEYS[2], shard)
  redis.call('HSET', KEYS[3], shard, 'pending')
  redis.call('RPUSH', KEYS[4], shard)
end
return expired
)";

long long now_s() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Take the next pending shard and lease it to worker_id for kLeaseSeconds; nullopt when nothing is pending.
std::optional<std::string> claim(const std::string& batch_id, const std::string& worker_id) {
  const auto shard = redis.eval<sw::redis::OptionalString>(
      kClaim, {config::pending_key(batch_id), config::owners_key(batch_id), config::deadlines_key(batch_id), config::shards_key(batch_id)},
      {worker_id, std::to_string(now_s() + config::kLeaseSeconds)});
  if (!shard) return std::nullopt;
  return *shard;
}

// Extend worker_id's lease on shard by kLeaseSeconds; false when the lease is not worker_id's.
bool heartbeat(const std::string& batch_id, const std::string& shard, const std::string& worker_id) {
  return redis.eval<long long>(kHeartbeat, {config::owners_key(batch_id), config::deadlines_key(batch_id)},
                               {shard, worker_id, std::to_string(now_s() + config::kLeaseSeconds)}) == 1;
}

// Record the shard's outcome (done or failed) and release the lease; false when it is not worker_id's.
bool complete(const std::string& batch_id, const std::string& shard, const std::string& worker_id, const std::string& outcome) {
  return redis.eval<long long>(kComplete, {config::owners_key(batch_id), config::deadlines_key(batch_id), config::shards_key(batch_id)},
                               {shard, worker_id, outcome}) == 1;
}

// The shards whose lease ran out, handled so another worker can take them over.
std::vector<std::string> reap(const std::string& batch_id) {
  return redis.eval<std::vector<std::string>>(
      kReap, {config::deadlines_key(batch_id), config::owners_key(batch_id), config::shards_key(batch_id), config::pending_key(batch_id)},
      {std::to_string(now_s())});
}
`,
    },
  },
  harness: {
    python: `B = "b1"


def _state(ctx, shards=1):
    """The learner's module over a batch whose shards 0..shards-1 are pending, as shards.seed leaves them."""
    m = ctx.load("state")
    ids = [str(i) for i in range(shards)]
    ctx.redis.rpush(f"batch:pending:{B}", *ids)
    ctx.redis.hset(f"batch:shards:{B}", mapping={i: "pending" for i in ids})
    return m


def _states(ctx):
    return ctx.redis.hgetall(f"batch:shards:{B}")


def _owners(ctx):
    return ctx.redis.hgetall(f"batch:owners:{B}")


def _pending(ctx):
    return ctx.redis.lrange(f"batch:pending:{B}", 0, -1)


def _deadline(ctx, shard):
    return ctx.redis.zscore(f"batch:deadlines:{B}", shard)


def check_claim_atomic(ctx):
    m = _state(ctx, 3)
    probe = ctx.redis_after(f"batch:pending:{B}", lambda: (_pending(ctx), _owners(ctx)))
    first = m.claim(B, "w-a")
    assert probe.fired, "claim never touched batch:pending"
    pending, owners = probe.result
    lost = [s for s in ("0", "1", "2") if s not in pending and s not in owners]
    assert not lost, f"right after claim's first command shard {lost} was in neither batch:pending ({pending}) nor batch:owners ({owners}): a worker that dies there loses it, and no reaper can find it again. The pop and the lease must be one script"
    assert first == "0", f"the first claim takes shard 0, got {first!r}"
    assert _owners(ctx) == {"0": "w-a"} and _states(ctx).get("0") == "running", f"a claimed shard has its owner and state running: owners {_owners(ctx)}, shards {_states(ctx)}"
    deadline = _deadline(ctx, "0")
    assert deadline is not None and abs(deadline - (ctx.clock.time() + 30)) <= 1, f"the lease runs LEASE_S = 30 s: batch:deadlines scores shard 0 at {deadline}, now is {int(ctx.clock.time())}"
    assert m.claim(B, "w-b") == "1" and m.claim(B, "w-c") == "2", "claims hand out shards in order, one each"
    assert m.claim(B, "w-d") is None, "an empty pending list claims nothing"


def check_owner_heartbeat(ctx):
    m = _state(ctx)
    assert m.claim(B, "w-a") == "0"
    assert not m.heartbeat(B, "0", "w-b"), "w-b heartbeated shard 0, which w-a holds, and was told the lease is its own"
    assert _owners(ctx).get("0") == "w-a", f"a heartbeat from w-b took shard 0 from w-a: batch:owners holds {_owners(ctx)}, and two workers now run the shard"
    ctx.clock.advance(20)
    assert m.heartbeat(B, "0", "w-a"), "the owner's heartbeat must succeed"
    deadline = _deadline(ctx, "0")
    assert deadline is not None and abs(deadline - (ctx.clock.time() + 30)) <= 1, f"the owner's heartbeat moves the deadline to now + 30, batch:deadlines scores shard 0 at {deadline}, now is {int(ctx.clock.time())}"
    ctx.clock.advance(20)
    reaped = m.reap(B)
    assert list(reaped) == [] and _owners(ctx).get("0") == "w-a", f"40 s after the claim and 20 s after a heartbeat the lease is alive, but reap took {reaped}"


def check_reaper_requeue(ctx):
    m = _state(ctx)
    assert m.claim(B, "w-a") == "0"
    ctx.clock.advance(31)  # w-a died: no heartbeat for longer than the lease
    reaped = m.reap(B)
    assert list(reaped) == ["0"], f"reap must return the shard whose lease ran out, got {reaped}"
    state = _states(ctx).get("0")
    assert state == "pending", f"the shard of a worker that died must go back to pending, it is {state!r}: a crash the shard did not cause would fail the batch"
    assert _pending(ctx) == ["0"], f"the reaped shard must be on batch:pending again, it holds {_pending(ctx)}"
    assert "0" not in _owners(ctx) and _deadline(ctx, "0") is None, f"a reaped shard has no owner and no deadline: owners {_owners(ctx)}, deadline {_deadline(ctx, '0')}"
    assert m.claim(B, "w-b") == "0", "another worker must be able to claim the reaped shard"
    assert list(m.reap(B)) == [], "a fresh lease is not reaped"


def check_fenced_complete(ctx):
    m = _state(ctx)
    assert m.claim(B, "w-a") == "0"
    ctx.clock.advance(31)  # w-a stalled (a long GC pause) past its lease; the reaper requeued the shard
    ctx.redis.zrem(f"batch:deadlines:{B}", "0")
    ctx.redis.hdel(f"batch:owners:{B}", "0")
    ctx.redis.hset(f"batch:shards:{B}", "0", "pending")
    ctx.redis.rpush(f"batch:pending:{B}", "0")
    assert m.claim(B, "w-b") == "0", "w-b must be able to claim the requeued shard"
    assert not m.complete(B, "0", "w-a", "done"), "w-a, whose lease was taken over, completed shard 0 and was told it worked: only the owner may complete"
    assert _states(ctx).get("0") == "running" and _owners(ctx).get("0") == "w-b", f"a completion from w-a changed the shard w-b is running: shards {_states(ctx)}, owners {_owners(ctx)}"
    assert m.complete(B, "0", "w-b", "done"), "the owner's completion must succeed"
    assert _states(ctx).get("0") == "done" and "0" not in _owners(ctx), f"after w-b completes, shard 0 is done with no owner: shards {_states(ctx)}, owners {_owners(ctx)}"


def check_complete_clears_deadline(ctx):
    m = _state(ctx)
    assert m.claim(B, "w-a") == "0"
    assert m.complete(B, "0", "w-a", "done"), "the owner's completion must succeed"
    assert _deadline(ctx, "0") is None, f"complete left shard 0 in batch:deadlines (score {_deadline(ctx, '0')}): the reaper will find it once the old deadline passes"
    ctx.clock.advance(31)
    reaped = m.reap(B)
    assert list(reaped) == [], f"reap took {reaped} 31 s after shard 0 was done: a finished shard would run again"
    assert _states(ctx).get("0") == "done" and _pending(ctx) == [], f"shard 0 must stay done and off the pending list: shards {_states(ctx)}, pending {_pending(ctx)}"
`,
    typescript: `const B = 'b1';

/** The learner's module over a batch whose shards 0..shards-1 are pending, as shards.seed leaves them. */
function state(ctx, shards = 1) {
  const m = ctx.load('state');
  const ids = Array.from({length: shards}, (_, i) => String(i));
  ctx.redis.rpush(\`batch:pending:\${B}\`, ...ids);
  for (const id of ids) ctx.redis.hset(\`batch:shards:\${B}\`, id, 'pending');
  return m;
}

const states = ctx => ctx.redis.hgetall(\`batch:shards:\${B}\`);
const owners = ctx => ctx.redis.hgetall(\`batch:owners:\${B}\`);
const pending = ctx => ctx.redis.lrange(\`batch:pending:\${B}\`, 0, -1);
const deadline = (ctx, shard: string) => {
  const score = ctx.redis.zscore(\`batch:deadlines:\${B}\`, shard);
  return score === null || score === undefined ? null : Number(score);
};
const nowS = ctx => ctx.clock.now() / 1000;

export async function check_claim_atomic(ctx) {
  const m = state(ctx, 3);
  const probe = ctx.redisAfter(\`batch:pending:\${B}\`, () => [pending(ctx), owners(ctx)]);
  const first = await m.claim(B, 'w-a');
  assert(probe.fired, 'claim never touched batch:pending');
  const [seenPending, seenOwners] = probe.result;
  const lost = ['0', '1', '2'].filter(s => !seenPending.includes(s) && !(s in seenOwners));
  assert.equal(lost.length, 0, \`right after claim's first command shard \${JSON.stringify(lost)} was in neither batch:pending (\${JSON.stringify(seenPending)}) nor batch:owners (\${JSON.stringify(seenOwners)}): a worker that dies there loses it, and no reaper can find it again. The pop and the lease must be one script\`);
  assert.equal(first, '0', \`the first claim takes shard 0, got \${JSON.stringify(first)}\`);
  assert(owners(ctx)['0'] === 'w-a' && states(ctx)['0'] === 'running', \`a claimed shard has its owner and state running: owners \${JSON.stringify(owners(ctx))}, shards \${JSON.stringify(states(ctx))}\`);
  const d = deadline(ctx, '0');
  assert(d !== null && Math.abs(d - (nowS(ctx) + 30)) <= 1, \`the lease runs LEASE_S = 30 s: batch:deadlines scores shard 0 at \${d}, now is \${Math.floor(nowS(ctx))}\`);
  assert((await m.claim(B, 'w-b')) === '1' && (await m.claim(B, 'w-c')) === '2', 'claims hand out shards in order, one each');
  assert.equal(await m.claim(B, 'w-d'), null, 'an empty pending list claims nothing');
}

export async function check_owner_heartbeat(ctx) {
  const m = state(ctx);
  assert.equal(await m.claim(B, 'w-a'), '0');
  assert(!(await m.heartbeat(B, '0', 'w-b')), 'w-b heartbeated shard 0, which w-a holds, and was told the lease is its own');
  assert.equal(owners(ctx)['0'], 'w-a', \`a heartbeat from w-b took shard 0 from w-a: batch:owners holds \${JSON.stringify(owners(ctx))}, and two workers now run the shard\`);
  ctx.clock.advance(20);
  assert(await m.heartbeat(B, '0', 'w-a'), "the owner's heartbeat must succeed");
  const d = deadline(ctx, '0');
  assert(d !== null && Math.abs(d - (nowS(ctx) + 30)) <= 1, \`the owner's heartbeat moves the deadline to now + 30, batch:deadlines scores shard 0 at \${d}, now is \${Math.floor(nowS(ctx))}\`);
  ctx.clock.advance(20);
  const reaped = await m.reap(B);
  assert(reaped.length === 0 && owners(ctx)['0'] === 'w-a', \`40 s after the claim and 20 s after a heartbeat the lease is alive, but reap took \${JSON.stringify(reaped)}\`);
}

export async function check_reaper_requeue(ctx) {
  const m = state(ctx);
  assert.equal(await m.claim(B, 'w-a'), '0');
  ctx.clock.advance(31); // w-a died: no heartbeat for longer than the lease
  const reaped = await m.reap(B);
  assert.deepEqual(reaped, ['0'], \`reap must return the shard whose lease ran out, got \${JSON.stringify(reaped)}\`);
  assert.equal(states(ctx)['0'], 'pending', \`the shard of a worker that died must go back to pending, it is \${JSON.stringify(states(ctx)['0'])}: a crash the shard did not cause would fail the batch\`);
  assert.deepEqual(pending(ctx), ['0'], \`the reaped shard must be on batch:pending again, it holds \${JSON.stringify(pending(ctx))}\`);
  assert(!('0' in owners(ctx)) && deadline(ctx, '0') === null, \`a reaped shard has no owner and no deadline: owners \${JSON.stringify(owners(ctx))}, deadline \${deadline(ctx, '0')}\`);
  assert.equal(await m.claim(B, 'w-b'), '0', 'another worker must be able to claim the reaped shard');
  assert.deepEqual(await m.reap(B), [], 'a fresh lease is not reaped');
}

export async function check_fenced_complete(ctx) {
  const m = state(ctx);
  assert.equal(await m.claim(B, 'w-a'), '0');
  ctx.clock.advance(31); // w-a stalled (a long GC pause) past its lease; the reaper requeued the shard
  ctx.redis.zrem(\`batch:deadlines:\${B}\`, '0');
  ctx.redis.hdel(\`batch:owners:\${B}\`, '0');
  ctx.redis.hset(\`batch:shards:\${B}\`, '0', 'pending');
  ctx.redis.rpush(\`batch:pending:\${B}\`, '0');
  assert.equal(await m.claim(B, 'w-b'), '0', 'w-b must be able to claim the requeued shard');
  assert(!(await m.complete(B, '0', 'w-a', 'done')), 'w-a, whose lease was taken over, completed shard 0 and was told it worked: only the owner may complete');
  assert(states(ctx)['0'] === 'running' && owners(ctx)['0'] === 'w-b', \`a completion from w-a changed the shard w-b is running: shards \${JSON.stringify(states(ctx))}, owners \${JSON.stringify(owners(ctx))}\`);
  assert(await m.complete(B, '0', 'w-b', 'done'), "the owner's completion must succeed");
  assert(states(ctx)['0'] === 'done' && !('0' in owners(ctx)), \`after w-b completes, shard 0 is done with no owner: shards \${JSON.stringify(states(ctx))}, owners \${JSON.stringify(owners(ctx))}\`);
}

export async function check_complete_clears_deadline(ctx) {
  const m = state(ctx);
  assert.equal(await m.claim(B, 'w-a'), '0');
  assert(await m.complete(B, '0', 'w-a', 'done'), "the owner's completion must succeed");
  assert.equal(deadline(ctx, '0'), null, \`complete left shard 0 in batch:deadlines (score \${deadline(ctx, '0')}): the reaper will find it once the old deadline passes\`);
  ctx.clock.advance(31);
  const reaped = await m.reap(B);
  assert.deepEqual(reaped, [], \`reap took \${JSON.stringify(reaped)} 31 s after shard 0 was done: a finished shard would run again\`);
  assert(states(ctx)['0'] === 'done' && pending(ctx).length === 0, \`shard 0 must stay done and off the pending list: shards \${JSON.stringify(states(ctx))}, pending \${JSON.stringify(pending(ctx))}\`);
}
`,
    go: `package main

import (
	"context"
	"strconv"

	"leetbuild/harness"
)

const leaseBatch = "b1"

// leaseSeed leaves shards 0..n-1 pending, as shards.Seed does.
func leaseSeed(ctx *harness.Ctx, n int) {
	for i := 0; i < n; i++ {
		id := strconv.Itoa(i)
		ctx.Redis.Do("RPUSH", "batch:pending:"+leaseBatch, id)
		ctx.Redis.Do("HSET", "batch:shards:"+leaseBatch, id, "pending")
	}
}

func leaseClaim(ctx *harness.Ctx, worker string) string {
	shard, err := claim(context.Background(), leaseBatch, worker)
	ctx.NoError(err, "claim(%s)", worker)
	return shard
}

func leaseHeartbeat(ctx *harness.Ctx, shard, worker string) bool {
	ok, err := heartbeat(context.Background(), leaseBatch, shard, worker)
	ctx.NoError(err, "heartbeat(%s, %s)", shard, worker)
	return ok
}

func leaseComplete(ctx *harness.Ctx, shard, worker, outcome string) bool {
	ok, err := complete(context.Background(), leaseBatch, shard, worker, outcome)
	ctx.NoError(err, "complete(%s, %s)", shard, worker)
	return ok
}

func leaseReap(ctx *harness.Ctx) []string {
	reaped, err := reap(context.Background(), leaseBatch)
	ctx.NoError(err, "reap")
	return reaped
}

func leaseStates(ctx *harness.Ctx) map[string]string { return ctx.Redis.HGetAll("batch:shards:" + leaseBatch) }
func leaseOwners(ctx *harness.Ctx) map[string]string { return ctx.Redis.HGetAll("batch:owners:" + leaseBatch) }
func leasePending(ctx *harness.Ctx) []string         { return ctx.Redis.LRange("batch:pending:"+leaseBatch, 0, -1) }

func leaseDeadline(ctx *harness.Ctx, shard string) (float64, bool) {
	return ctx.Redis.ZScore("batch:deadlines:"+leaseBatch, shard)
}

func leaseNear(ctx *harness.Ctx, score float64) bool {
	now := float64(ctx.Clock.Now()) / 1000
	return score-(now+30) <= 1 && (now+30)-score <= 1
}

func CheckClaimAtomic(ctx *harness.Ctx) {
	leaseSeed(ctx, 3)
	var seenPending []string
	var seenOwners map[string]string
	fired := false
	ctx.Redis.After("batch:pending:"+leaseBatch, func() any {
		fired = true
		seenPending, seenOwners = leasePending(ctx), leaseOwners(ctx)
		return nil
	})
	first := leaseClaim(ctx, "w-a")
	ctx.Assert(fired, "claim never touched batch:pending")
	for _, s := range []string{"0", "1", "2"} {
		inPending := false
		for _, p := range seenPending {
			inPending = inPending || p == s
		}
		_, owned := seenOwners[s]
		ctx.Assert(inPending || owned, "right after claim's first command shard %s was in neither batch:pending (%v) nor batch:owners (%v): a worker that dies there loses it, and no reaper can find it again. The pop and the lease must be one script", s, seenPending, seenOwners)
	}
	ctx.Equal(first, "0", "the first claim takes shard 0")
	ctx.Assert(leaseOwners(ctx)["0"] == "w-a" && leaseStates(ctx)["0"] == "running", "a claimed shard has its owner and state running: owners %v, shards %v", leaseOwners(ctx), leaseStates(ctx))
	d, ok := leaseDeadline(ctx, "0")
	ctx.Assert(ok && leaseNear(ctx, d), "the lease runs LeaseSeconds = 30 s: batch:deadlines scores shard 0 at %v, now is %d", d, ctx.Clock.Now()/1000)
	ctx.Assert(leaseClaim(ctx, "w-b") == "1" && leaseClaim(ctx, "w-c") == "2", "claims hand out shards in order, one each")
	ctx.Equal(leaseClaim(ctx, "w-d"), "", "an empty pending list claims nothing")
}

func CheckOwnerHeartbeat(ctx *harness.Ctx) {
	leaseSeed(ctx, 1)
	ctx.Equal(leaseClaim(ctx, "w-a"), "0", "the first claim")
	ctx.Assert(!leaseHeartbeat(ctx, "0", "w-b"), "w-b heartbeated shard 0, which w-a holds, and was told the lease is its own")
	ctx.Equal(leaseOwners(ctx)["0"], "w-a", "a heartbeat from w-b must not take shard 0 from w-a (two workers would run it); the owner")
	ctx.Clock.Advance(20)
	ctx.Assert(leaseHeartbeat(ctx, "0", "w-a"), "the owner's heartbeat must succeed")
	d, ok := leaseDeadline(ctx, "0")
	ctx.Assert(ok && leaseNear(ctx, d), "the owner's heartbeat moves the deadline to now + 30, batch:deadlines scores shard 0 at %v, now is %d", d, ctx.Clock.Now()/1000)
	ctx.Clock.Advance(20)
	reaped := leaseReap(ctx)
	ctx.Assert(len(reaped) == 0 && leaseOwners(ctx)["0"] == "w-a", "40 s after the claim and 20 s after a heartbeat the lease is alive, but reap took %v", reaped)
}

func CheckReaperRequeue(ctx *harness.Ctx) {
	leaseSeed(ctx, 1)
	ctx.Equal(leaseClaim(ctx, "w-a"), "0", "the first claim")
	ctx.Clock.Advance(31) // w-a died: no heartbeat for longer than the lease
	ctx.Equal(leaseReap(ctx), []string{"0"}, "reap must return the shard whose lease ran out")
	ctx.Equal(leaseStates(ctx)["0"], "pending", "the shard of a worker that died must go back to pending (a crash the shard did not cause would fail the batch); its state")
	ctx.Equal(leasePending(ctx), []string{"0"}, "the reaped shard must be on batch:pending again; it holds")
	_, owned := leaseOwners(ctx)["0"]
	_, hasDeadline := leaseDeadline(ctx, "0")
	ctx.Assert(!owned && !hasDeadline, "a reaped shard has no owner and no deadline: owners %v", leaseOwners(ctx))
	ctx.Equal(leaseClaim(ctx, "w-b"), "0", "another worker must be able to claim the reaped shard")
	ctx.Equal(len(leaseReap(ctx)), 0, "a fresh lease is not reaped; shards reaped")
}

func CheckFencedComplete(ctx *harness.Ctx) {
	leaseSeed(ctx, 1)
	ctx.Equal(leaseClaim(ctx, "w-a"), "0", "the first claim")
	ctx.Clock.Advance(31) // w-a stalled (a long GC pause) past its lease; the reaper requeued the shard
	ctx.Redis.Do("ZREM", "batch:deadlines:"+leaseBatch, "0")
	ctx.Redis.Do("HDEL", "batch:owners:"+leaseBatch, "0")
	ctx.Redis.Do("HSET", "batch:shards:"+leaseBatch, "0", "pending")
	ctx.Redis.Do("RPUSH", "batch:pending:"+leaseBatch, "0")
	ctx.Equal(leaseClaim(ctx, "w-b"), "0", "w-b must be able to claim the requeued shard")
	ctx.Assert(!leaseComplete(ctx, "0", "w-a", "done"), "w-a, whose lease was taken over, completed shard 0 and was told it worked: only the owner may complete")
	ctx.Assert(leaseStates(ctx)["0"] == "running" && leaseOwners(ctx)["0"] == "w-b", "a completion from w-a changed the shard w-b is running: shards %v, owners %v", leaseStates(ctx), leaseOwners(ctx))
	ctx.Assert(leaseComplete(ctx, "0", "w-b", "done"), "the owner's completion must succeed")
	_, owned := leaseOwners(ctx)["0"]
	ctx.Assert(leaseStates(ctx)["0"] == "done" && !owned, "after w-b completes, shard 0 is done with no owner: shards %v, owners %v", leaseStates(ctx), leaseOwners(ctx))
}

func CheckCompleteClearsDeadline(ctx *harness.Ctx) {
	leaseSeed(ctx, 1)
	ctx.Equal(leaseClaim(ctx, "w-a"), "0", "the first claim")
	ctx.Assert(leaseComplete(ctx, "0", "w-a", "done"), "the owner's completion must succeed")
	d, has := leaseDeadline(ctx, "0")
	ctx.Assert(!has, "complete left shard 0 in batch:deadlines (score %v): the reaper will find it once the old deadline passes", d)
	ctx.Clock.Advance(31)
	reaped := leaseReap(ctx)
	ctx.Assert(len(reaped) == 0, "reap took %v 31 s after shard 0 was done: a finished shard would run again", reaped)
	ctx.Assert(leaseStates(ctx)["0"] == "done" && len(leasePending(ctx)) == 0, "shard 0 must stay done and off the pending list: shards %v, pending %v", leaseStates(ctx), leasePending(ctx))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <cmath>
#include <map>
#include <string>
#include <vector>

namespace {

const std::string kBatch = "b1";

// Shards 0..n-1 pending, as shards::seed leaves them.
void leaseSeed(harness::Ctx& ctx, int n) {
  for (int i = 0; i < n; i++) {
    ctx.Redis.Do("RPUSH", "batch:pending:" + kBatch, std::to_string(i));
    ctx.Redis.Do("HSET", "batch:shards:" + kBatch, std::to_string(i), "pending");
  }
}

std::string field(const std::map<std::string, std::string>& h, const std::string& f) {
  const auto it = h.find(f);
  return it == h.end() ? "" : it->second;
}

std::map<std::string, std::string> leaseStates(harness::Ctx& ctx) { return ctx.Redis.HGetAll("batch:shards:" + kBatch); }
std::map<std::string, std::string> leaseOwners(harness::Ctx& ctx) { return ctx.Redis.HGetAll("batch:owners:" + kBatch); }
std::vector<std::string> leasePending(harness::Ctx& ctx) { return ctx.Redis.LRange("batch:pending:" + kBatch, 0, -1); }
std::optional<double> leaseDeadline(harness::Ctx& ctx, const std::string& shard) { return ctx.Redis.ZScore("batch:deadlines:" + kBatch, shard); }

bool leaseNear(harness::Ctx& ctx, std::optional<double> score) {
  return score.has_value() && std::fabs(*score - (static_cast<double>(ctx.Clock.Now()) / 1000 + 30)) <= 1;
}

}  // namespace

void CheckClaimAtomic(harness::Ctx& ctx) {
  leaseSeed(ctx, 3);
  std::vector<std::string> seenPending;
  std::map<std::string, std::string> seenOwners;
  bool fired = false;
  ctx.Redis.After("batch:pending:" + kBatch, [&] {
    fired = true;
    seenPending = leasePending(ctx);
    seenOwners = leaseOwners(ctx);
  });
  const auto first = claim(kBatch, "w-a");
  ctx.Assert(fired, "claim never touched batch:pending");
  for (const std::string s : {"0", "1", "2"}) {
    const bool inPending = std::find(seenPending.begin(), seenPending.end(), s) != seenPending.end();
    ctx.Assert(inPending || seenOwners.count(s) > 0,
               "right after claim's first command shard %s was in neither batch:pending (%v) nor batch:owners (%v): a worker that dies there loses it, and no reaper can find it again. The pop and the lease must be one script",
               s, seenPending, seenOwners);
  }
  ctx.Equal(first, std::optional<std::string>("0"), "the first claim takes shard 0");
  ctx.Assert(field(leaseOwners(ctx), "0") == "w-a" && field(leaseStates(ctx), "0") == "running", "a claimed shard has its owner and state running: owners %v, shards %v", leaseOwners(ctx), leaseStates(ctx));
  ctx.Assert(leaseNear(ctx, leaseDeadline(ctx, "0")), "the lease runs kLeaseSeconds = 30 s: batch:deadlines scores shard 0 at %v, now is %d", leaseDeadline(ctx, "0"), ctx.Clock.Now() / 1000);
  ctx.Assert(claim(kBatch, "w-b") == std::optional<std::string>("1") && claim(kBatch, "w-c") == std::optional<std::string>("2"), "claims hand out shards in order, one each");
  ctx.Assert(!claim(kBatch, "w-d").has_value(), "an empty pending list claims nothing");
}

void CheckOwnerHeartbeat(harness::Ctx& ctx) {
  leaseSeed(ctx, 1);
  ctx.Equal(claim(kBatch, "w-a"), std::optional<std::string>("0"), "the first claim");
  ctx.Assert(!heartbeat(kBatch, "0", "w-b"), "w-b heartbeated shard 0, which w-a holds, and was told the lease is its own");
  ctx.Equal(field(leaseOwners(ctx), "0"), "w-a", "a heartbeat from w-b must not take shard 0 from w-a (two workers would run it); the owner");
  ctx.Clock.Advance(20);
  ctx.Assert(heartbeat(kBatch, "0", "w-a"), "the owner's heartbeat must succeed");
  ctx.Assert(leaseNear(ctx, leaseDeadline(ctx, "0")), "the owner's heartbeat moves the deadline to now + 30, batch:deadlines scores shard 0 at %v, now is %d", leaseDeadline(ctx, "0"), ctx.Clock.Now() / 1000);
  ctx.Clock.Advance(20);
  const auto reaped = reap(kBatch);
  ctx.Assert(reaped.empty() && field(leaseOwners(ctx), "0") == "w-a", "40 s after the claim and 20 s after a heartbeat the lease is alive, but reap took %v", reaped);
}

void CheckReaperRequeue(harness::Ctx& ctx) {
  leaseSeed(ctx, 1);
  ctx.Equal(claim(kBatch, "w-a"), std::optional<std::string>("0"), "the first claim");
  ctx.Clock.Advance(31);  // w-a died: no heartbeat for longer than the lease
  ctx.Equal(reap(kBatch), {"0"}, "reap must return the shard whose lease ran out");
  ctx.Equal(field(leaseStates(ctx), "0"), "pending", "the shard of a worker that died must go back to pending (a crash the shard did not cause would fail the batch); its state");
  ctx.Equal(leasePending(ctx), {"0"}, "the reaped shard must be on batch:pending again; it holds");
  ctx.Assert(leaseOwners(ctx).count("0") == 0 && !leaseDeadline(ctx, "0").has_value(), "a reaped shard has no owner and no deadline: owners %v", leaseOwners(ctx));
  ctx.Equal(claim(kBatch, "w-b"), std::optional<std::string>("0"), "another worker must be able to claim the reaped shard");
  ctx.Equal(reap(kBatch).size(), 0, "a fresh lease is not reaped; shards reaped");
}

void CheckFencedComplete(harness::Ctx& ctx) {
  leaseSeed(ctx, 1);
  ctx.Equal(claim(kBatch, "w-a"), std::optional<std::string>("0"), "the first claim");
  ctx.Clock.Advance(31);  // w-a stalled (a long GC pause) past its lease; the reaper requeued the shard
  ctx.Redis.Do("ZREM", "batch:deadlines:" + kBatch, "0");
  ctx.Redis.Do("HDEL", "batch:owners:" + kBatch, "0");
  ctx.Redis.Do("HSET", "batch:shards:" + kBatch, "0", "pending");
  ctx.Redis.Do("RPUSH", "batch:pending:" + kBatch, "0");
  ctx.Equal(claim(kBatch, "w-b"), std::optional<std::string>("0"), "w-b must be able to claim the requeued shard");
  ctx.Assert(!complete(kBatch, "0", "w-a", "done"), "w-a, whose lease was taken over, completed shard 0 and was told it worked: only the owner may complete");
  ctx.Assert(field(leaseStates(ctx), "0") == "running" && field(leaseOwners(ctx), "0") == "w-b", "a completion from w-a changed the shard w-b is running: shards %v, owners %v", leaseStates(ctx), leaseOwners(ctx));
  ctx.Assert(complete(kBatch, "0", "w-b", "done"), "the owner's completion must succeed");
  ctx.Assert(field(leaseStates(ctx), "0") == "done" && leaseOwners(ctx).count("0") == 0, "after w-b completes, shard 0 is done with no owner: shards %v, owners %v", leaseStates(ctx), leaseOwners(ctx));
}

void CheckCompleteClearsDeadline(harness::Ctx& ctx) {
  leaseSeed(ctx, 1);
  ctx.Equal(claim(kBatch, "w-a"), std::optional<std::string>("0"), "the first claim");
  ctx.Assert(complete(kBatch, "0", "w-a", "done"), "the owner's completion must succeed");
  ctx.Assert(!leaseDeadline(ctx, "0").has_value(), "complete left shard 0 in batch:deadlines (score %v): the reaper will find it once the old deadline passes", leaseDeadline(ctx, "0"));
  ctx.Clock.Advance(31);
  const auto reaped = reap(kBatch);
  ctx.Assert(reaped.empty(), "reap took %v 31 s after shard 0 was done: a finished shard would run again", reaped);
  ctx.Assert(field(leaseStates(ctx), "0") == "done" && leasePending(ctx).empty(), "shard 0 must stay done and off the pending list: shards %v, pending %v", leaseStates(ctx), leasePending(ctx));
}
`,
  },
  debrief: `A lease is three facts that must move together (who holds the shard, until when, and whether it is still queued), and Redis keeps them together only inside one script. That is the shape of every fix: the claim pops and leases in one step so a crash cannot strand a shard between them; heartbeat and complete compare the owner first, which is what fences a worker that stalled past its lease from overwriting the one that replaced it; the reaper requeues, because a dead worker says nothing about the shard; and completion removes the deadline so the reaper's view stays in step. Production queues add an attempt count per shard so a record that crashes every worker is quarantined after a few tries, and fencing tokens checked by the output store, so even a late write from a stale worker is refused.`,
};
