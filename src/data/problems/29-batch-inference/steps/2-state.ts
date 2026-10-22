import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis shard claims with atomic leases',
  concept: 'redis',
  file: 'state',
  focus: ['redis', 'worker', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a worker pops a shard from the
work set and starts work, so the happy path moves shards through the batch. It hides a lost shard, a
race and a lie in the counters. Review it, fix it, and prove the fix with the checks below.

Implement the shard queue the worker pool runs on, over Redis. Work set
\`batch:{batch_id}:shards\`, lease \`batch:{batch_id}:shard:{shard_id}:lease\`, lease index
\`batch:{batch_id}:leases\`, counters \`batch:{batch_id}:counts\`.

- **Claim atomically.** Pop a shard, then take its lease with \`SET … NX EX 30\` (or the stack's
  equivalent). If the lease is refused the shard was already taken: put it back and claim nothing.
  The draft pops with \`SPOP\` and processes with no lease, so a worker crash loses the shard.
- **Heartbeat only your own lease.** Renewing must compare the stored owner — a Lua script that
  returns \`0\` unless \`GET lease == worker_id\` and then \`EXPIRE\`s it. The draft's heartbeat is a
  plain \`SET\`, so two workers can believe they own the same shard.
- **Reclaim a crash.** The lease index is a sorted set keyed by deadline; a reaper returns every
  shard whose lease expired back to the work set and clears its lease, so another worker retries it.
- **Counters update on completion only, atomically.** \`HINCRBY batch:{batch_id}:counts done 1\`
  after the shard finishes (and \`failed\` when it does not) — never on claim, or a crashed worker
  leaves a shard counted as done forever.

**Failure mode the checks target.** A popped shard without a lease is a shard that vanishes when its
worker dies; a heartbeat that overwrites the lease hands one shard to two workers; counting on claim
makes the progress counter disagree with the work set.`,
  sequence: {
    participants: ['Worker pool', 'work set', 'batch · outbox'],
    messages: [
      {from: 'Worker pool', to: 'work set', label: 'SPOP then SET lease NX EX 30', kind: 'sync'},
      {from: 'work set', to: 'Worker pool', label: 'OK / nil (lost the race, requeue)', kind: 'reply'},
      {from: 'Worker pool', to: 'work set', label: 'HEARTBEAT_LUA renew if owner', kind: 'sync'},
      {from: 'Worker pool', to: 'work set', label: 'ZRANGEBYSCORE expired → SADD work set', kind: 'sync'},
      {from: 'Worker pool', to: 'batch · outbox', label: 'HINCRBY counts done after the shard completes', kind: 'sync'},
    ],
  },
  hints: [
    'The pop and the lease are two steps, so the lease is where the race is resolved: `SET lease worker NX EX 30`. When it is refused, `SADD` the shard back — the worker that already holds it owns the work.',
    'A heartbeat is not a write, it is a compare-and-renew. Run a Lua script that returns 0 unless `GET lease` equals the caller, then `EXPIRE`. A plain `SET` lets a second worker overwrite the owner and both process the shard.',
    'Crash recovery needs a deadline, not a flag: keep `batch:{batch_id}:leases` as a sorted set scored by expiry, and have a reaper move every expired member back to the work set and delete its lease.',
  ],
  checks: [
    {
      id: 'atomic-claim',
      title: 'Claims a shard with an atomic NX lease',
      detail:
        'The claim takes the lease with `SET … NX EX` (or a Lua equivalent) and requeues the shard when the lease is refused. The draft pops with `SPOP` and never takes a lease.',
      match: {
        python: {all: [/\.set\(/, /nx=True/]},
        typescript: {all: [/\.set\(/, /NX/]},
        go: {all: [/SetNX\(/, /leaseTTL|LeaseSeconds/]},
        scala: {all: [/\.set\(/, /nx\(\)/]},
        cpp: {all: [/\.set\(/, /NOT_EXIST/]},
      },
    },
    {
      id: 'lease-ttl',
      title: 'The lease carries a TTL',
      detail:
        'The lease is written with a TTL so a dead worker’s claim expires; the draft writes a lease with no expiry (or none at all).',
      match: {
        python: {all: [/LEASE_S/, /\.set\(/]},
        typescript: {all: [/LEASE_S/, /\.set\(/]},
        go: {all: [/leaseTTL/, /SetNX\(/]},
        scala: {all: [/LeaseSeconds/, /\.set\(/]},
        cpp: {all: [/kLeaseSeconds/, /\.set\(/]},
      },
    },
    {
      id: 'heartbeat-owner',
      title: 'Heartbeat renews only the owner’s lease',
      detail:
        'Renewal runs a script that compares the stored owner before it `EXPIRE`s the lease. The draft’s plain `SET` lets a second worker believe it owns the shard.',
      match: {
        python: {all: [/HEARTBEAT_LUA/, /EXPIRE/]},
        typescript: {all: [/HEARTBEAT_LUA/, /EXPIRE/]},
        go: {all: [/heartbeatScript|HEARTBEAT_LUA/, /EXPIRE/]},
        scala: {all: [/HeartbeatLua/, /EXPIRE/]},
        cpp: {all: [/kHeartbeatLua/, /EXPIRE/]},
      },
    },
    {
      id: 'reclaim-expired',
      title: 'A reaper returns expired leases to the work set',
      detail:
        'The lease index is scanned for expired deadlines and each reclaimed shard is pushed back into the work set and cleared from the index. The draft has no reaper, so a crashed shard is lost.',
      match: {
        python: {all: [/zrangebyscore\(/, /zrem\(|sadd\(/]},
        typescript: {all: [/zrangebyscore\(/, /zrem\(|sadd\(/]},
        go: {all: [/ZRangeByScore\(/, /ZRem\(|SAdd\(/]},
        scala: {all: [/zrangeByScore\(|zrangebyscore\(/, /zrem\(|sadd\(/]},
        cpp: {all: [/zrangebyscore\(/, /zrem\(|sadd\(/]},
      },
    },
    {
      id: 'counters-after-work',
      title: 'Counters update after the shard completes',
      detail:
        'The `HINCRBY` on the counters runs after the shard is processed, not on claim. The draft counts a shard as done the moment it pops it.',
      match: {
        python: {order: [/run_shard\(|process_shard\(/, /hincrby\(/]},
        typescript: {order: [/runShard\(|processShard\(/, /hincrby\(/]},
        go: {order: [/RunShard\(|ProcessShard\(/, /HIncrBy\(/]},
        scala: {order: [/runShard\(/, /hincrBy\(/]},
        cpp: {order: [/run_shard\(/, /hincrby\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def claim(batch_id: str, worker_id: str) -> str | None:
    # TODO: this draft pops the shard with no lease and counts it before the work is done; its
    # heartbeat overwrites the lease so two workers can believe they own the shard.
    shard_id = r.spop(f"batch:{batch_id}:shards")
    if shard_id is None:
        return None
    r.hincrby(f"batch:{batch_id}:counts", "done", 1)
    r.set(f"batch:{batch_id}:shard:{shard_id}:lease", worker_id, ex=30)
    return shard_id


def heartbeat(batch_id: str, shard_id: str, worker_id: str) -> None:
    r.set(f"batch:{batch_id}:shard:{shard_id}:lease", worker_id, ex=30)
`,
      solution: `import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEASE_S = 30

HEARTBEAT_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
"""


def claim(batch_id: str, worker_id: str) -> str | None:
    shard_id = r.spop(f"batch:{batch_id}:shards")
    if shard_id is None:
        return None
    lease_key = f"batch:{batch_id}:shard:{shard_id}:lease"
    if not r.set(lease_key, worker_id, nx=True, ex=LEASE_S):
        r.sadd(f"batch:{batch_id}:shards", shard_id)
        return None
    r.zadd(f"batch:{batch_id}:leases", {shard_id: time.time() + LEASE_S})
    return shard_id


def heartbeat(batch_id: str, shard_id: str, worker_id: str) -> bool:
    lease_key = f"batch:{batch_id}:shard:{shard_id}:lease"
    renewed = r.eval(HEARTBEAT_LUA, 1, lease_key, worker_id, LEASE_S)
    if renewed:
        r.zadd(f"batch:{batch_id}:leases", {shard_id: time.time() + LEASE_S})
    return bool(renewed)


def reclaim(batch_id: str) -> int:
    leases_key = f"batch:{batch_id}:leases"
    expired = r.zrangebyscore(leases_key, 0, time.time())
    for shard_id in expired:
        r.delete(f"batch:{batch_id}:shard:{shard_id}:lease")
        r.sadd(f"batch:{batch_id}:shards", shard_id)
        r.zrem(leases_key, shard_id)
    return len(expired)


def run_shard(batch_id: str, shard_id: str) -> None:
    try:
        process_shard(batch_id, shard_id)
        r.hincrby(f"batch:{batch_id}:counts", "done", 1)
    except Exception:
        r.hincrby(f"batch:{batch_id}:counts", "failed", 1)
    finally:
        r.zrem(f"batch:{batch_id}:leases", shard_id)
        r.delete(f"batch:{batch_id}:shard:{shard_id}:lease")
`,
    },
    typescript: {
      starter: `/** Shard claims: a model-generated draft that pops without a lease. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

export async function claim(batchID: string, workerID: string): Promise<string | null> {
  // TODO: this draft pops the shard with no lease and counts it before the work is done; its
  // heartbeat overwrites the lease so two workers can believe they own the shard.
  const shardID = await r.spop('batch:' + batchID + ':shards');
  if (shardID === null) return null;
  await r.hincrby('batch:' + batchID + ':counts', 'done', 1);
  await r.set('batch:' + batchID + ':shard:' + shardID + ':lease', workerID, 'EX', 30);
  return shardID;
}

export async function heartbeat(batchID: string, shardID: string, workerID: string): Promise<void> {
  await r.set('batch:' + batchID + ':shard:' + shardID + ':lease', workerID, 'EX', 30);
}
`,
      solution: `/** Shard claims: atomic NX leases, an owner-only heartbeat and a reaper. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const LEASE_S = 30;
const HEARTBEAT_LUA = \`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
\`;

export async function claim(batchID: string, workerID: string): Promise<string | null> {
  const shardID = await r.spop('batch:' + batchID + ':shards');
  if (shardID === null) return null;
  const leaseKey = 'batch:' + batchID + ':shard:' + shardID + ':lease';
  const won = await r.set(leaseKey, workerID, 'EX', LEASE_S, 'NX');
  if (won !== 'OK') {
    await r.sadd('batch:' + batchID + ':shards', shardID);
    return null;
  }
  await r.zadd('batch:' + batchID + ':leases', Date.now() / 1000 + LEASE_S, shardID);
  return shardID;
}

export async function heartbeat(batchID: string, shardID: string, workerID: string): Promise<boolean> {
  const leaseKey = 'batch:' + batchID + ':shard:' + shardID + ':lease';
  const renewed = (await r.eval(HEARTBEAT_LUA, 1, leaseKey, workerID, String(LEASE_S))) as number;
  if (renewed > 0) await r.zadd('batch:' + batchID + ':leases', Date.now() / 1000 + LEASE_S, shardID);
  return renewed > 0;
}

export async function reclaim(batchID: string): Promise<number> {
  const leasesKey = 'batch:' + batchID + ':leases';
  const expired = await r.zrangebyscore(leasesKey, 0, Date.now() / 1000);
  for (const shardID of expired) {
    await r.del('batch:' + batchID + ':shard:' + shardID + ':lease');
    await r.sadd('batch:' + batchID + ':shards', shardID);
    await r.zrem(leasesKey, shardID);
  }
  return expired.length;
}

export async function runShard(batchID: string, shardID: string): Promise<void> {
  const done = await processShard(batchID, shardID);
  await r.hincrby('batch:' + batchID + ':counts', done ? 'done' : 'failed', 1);
  await r.zrem('batch:' + batchID + ':leases', shardID);
  await r.del('batch:' + batchID + ':shard:' + shardID + ':lease');
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"
)

func Claim(ctx context.Context, rdb *redis.Client, batchID, workerID string) (string, error) {
	// TODO: this draft pops the shard with no lease and counts it before the work is done; its
	// heartbeat overwrites the lease so two workers can believe they own the shard.
	shardID, err := rdb.SPop(ctx, "batch:"+batchID+":shards").Result()
	if err != nil {
		return "", err
	}
	rdb.HIncrBy(ctx, "batch:"+batchID+":counts", "done", 1)
	rdb.Set(ctx, "batch:"+batchID+":shard:"+shardID+":lease", workerID, 30*time.Second)
	return shardID, nil
}

func Heartbeat(ctx context.Context, rdb *redis.Client, batchID, shardID, workerID string) error {
	return rdb.Set(ctx, "batch:"+batchID+":shard:"+shardID+":lease", workerID, 30*time.Second).Err()
}
`,
      solution: `package main

import (
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const leaseTTL = 30 * time.Second

var heartbeatScript = redis.NewScript(\`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0
\`)

func Claim(ctx context.Context, rdb *redis.Client, batchID, workerID string) (string, error) {
	shardID, err := rdb.SPop(ctx, "batch:"+batchID+":shards").Result()
	if err != nil {
		return "", err
	}
	leaseKey := "batch:" + batchID + ":shard:" + shardID + ":lease"
	won, err := rdb.SetNX(ctx, leaseKey, workerID, leaseTTL).Result()
	if err != nil {
		return "", err
	}
	if !won {
		rdb.SAdd(ctx, "batch:"+batchID+":shards", shardID)
		return "", nil
	}
	rdb.ZAdd(ctx, "batch:"+batchID+":leases",
		redis.Z{Score: float64(time.Now().Add(leaseTTL).Unix()), Member: shardID})
	return shardID, nil
}

func Heartbeat(ctx context.Context, rdb *redis.Client, batchID, shardID, workerID string) (bool, error) {
	leaseKey := "batch:" + batchID + ":shard:" + shardID + ":lease"
	renewed, err := heartbeatScript.Run(ctx, rdb, []string{leaseKey}, workerID,
		strconv.Itoa(int(leaseTTL.Seconds()))).Int()
	if err != nil {
		return false, err
	}
	if renewed > 0 {
		rdb.ZAdd(ctx, "batch:"+batchID+":leases",
			redis.Z{Score: float64(time.Now().Add(leaseTTL).Unix()), Member: shardID})
	}
	return renewed > 0, nil
}

func Reclaim(ctx context.Context, rdb *redis.Client, batchID string) (int, error) {
	leasesKey := "batch:" + batchID + ":leases"
	now := strconv.FormatInt(time.Now().Unix(), 10)
	expired, err := rdb.ZRangeByScore(ctx, leasesKey, &redis.ZRangeBy{Min: "-inf", Max: now}).Result()
	if err != nil {
		return 0, err
	}
	for _, shardID := range expired {
		rdb.Del(ctx, "batch:"+batchID+":shard:"+shardID+":lease")
		rdb.SAdd(ctx, "batch:"+batchID+":shards", shardID)
		rdb.ZRem(ctx, leasesKey, shardID)
	}
	return len(expired), nil
}

func RunShard(ctx context.Context, rdb *redis.Client, batchID, shardID string) {
	done, err := ProcessShard(ctx, batchID, shardID)
	if err != nil || !done {
		rdb.HIncrBy(ctx, "batch:"+batchID+":counts", "failed", 1)
		return
	}
	rdb.HIncrBy(ctx, "batch:"+batchID+":counts", "done", 1)
	rdb.ZRem(ctx, "batch:"+batchID+":leases", shardID)
	rdb.Del(ctx, "batch:"+batchID+":shard:"+shardID+":lease")
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object ShardQueue {
  def claim(jedis: Jedis, batchId: String, workerId: String): Option[String] = {
    // TODO: this draft pops the shard with no lease and counts it before the work is done; its
    // heartbeat overwrites the lease so two workers can believe they own the shard.
    Option(jedis.spop(s"batch:$batchId:shards")).map { shardId =>
      jedis.hincrBy(s"batch:$batchId:counts", "done", 1)
      jedis.set(s"batch:$batchId:shard:$shardId:lease", workerId)
      shardId
    }
  }

  def heartbeat(jedis: Jedis, batchId: String, shardId: String, workerId: String): Unit = {
    jedis.set(s"batch:$batchId:shard:$shardId:lease", workerId)
  }
}
`,
      solution: `import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams

object ShardQueue {
  val LeaseSeconds = 30
  val HeartbeatLua =
    """
      |if redis.call('GET', KEYS[1]) == ARGV[1] then
      |  return redis.call('EXPIRE', KEYS[1], ARGV[2])
      |end
      |return 0
      |""".stripMargin

  def claim(jedis: Jedis, batchId: String, workerId: String): Option[String] = {
    Option(jedis.spop(s"batch:$batchId:shards")).filter { shardId =>
      val leaseKey = s"batch:$batchId:shard:$shardId:lease"
      val lease = SetParams.setParams().nx().ex(LeaseSeconds)
      if (jedis.set(leaseKey, workerId, lease) != "OK") {
        jedis.sadd(s"batch:$batchId:shards", shardId)
        false
      } else {
        true
      }
    }
  }

  def heartbeat(jedis: Jedis, batchId: String, shardId: String, workerId: String): Boolean = {
    val leaseKey = s"batch:$batchId:shard:$shardId:lease"
    val args = java.util.List.of(workerId, LeaseSeconds.toString)
    val renewed = jedis.eval(HeartbeatLua, java.util.List.of(leaseKey), args).asInstanceOf[Long]
    renewed > 0
  }

  def reclaim(jedis: Jedis, batchId: String): Int = {
    val leasesKey = s"batch:$batchId:leases"
    val now = System.currentTimeMillis() / 1000
    val expired = jedis.zrangeByScore(leasesKey, 0d, now.toDouble)
    expired.forEach { shardId =>
      jedis.del(s"batch:$batchId:shard:$shardId:lease")
      jedis.sadd(s"batch:$batchId:shards", shardId)
      jedis.zrem(leasesKey, shardId)
    }
    expired.size
  }

  def runShard(jedis: Jedis, batchId: String, shardId: String): Unit = {
    val done = processShard(batchId, shardId)
    jedis.hincrBy(s"batch:$batchId:counts", if (done) "done" else "failed", 1)
    jedis.zrem(s"batch:$batchId:leases", shardId)
    jedis.del(s"batch:$batchId:shard:$shardId:lease")
  }
}
`,
    },
    cpp: {
      starter: `#include <redis++/redis++.h>

#include <string>

using namespace sw::redis;

std::string claim(Redis& redis, const std::string& batchId, const std::string& workerId) {
  // TODO: this draft pops the shard with no lease and counts it before the work is done; its
  // heartbeat overwrites the lease so two workers can believe they own the shard.
  auto shardId = redis.spop("batch:" + batchId + ":shards");
  if (!shardId) return "";
  redis.hincrby("batch:" + batchId + ":counts", "done", 1);
  redis.set("batch:" + batchId + ":shard:" + *shardId + ":lease", workerId);
  return *shardId;
}

void heartbeat(Redis& redis, const std::string& batchId, const std::string& shardId,
               const std::string& workerId) {
  redis.set("batch:" + batchId + ":shard:" + shardId + ":lease", workerId);
}
`,
      solution: `#include <redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

using namespace sw::redis;

constexpr int kLeaseSeconds = 30;
const std::string kHeartbeatLua =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then "
    "  return redis.call('EXPIRE', KEYS[1], ARGV[2]) "
    "end "
    "return 0";

double deadlineSeconds() {
  const auto now = std::chrono::system_clock::now().time_since_epoch();
  return std::chrono::duration_cast<std::chrono::milliseconds>(now).count() / 1000.0;
}

std::string claim(Redis& redis, const std::string& batchId, const std::string& workerId) {
  auto shardId = redis.spop("batch:" + batchId + ":shards");
  if (!shardId) return "";
  const auto leaseKey = "batch:" + batchId + ":shard:" + *shardId + ":lease";
  const bool won = redis.set(leaseKey, workerId, std::chrono::seconds(kLeaseSeconds),
                             UpdateType::NOT_EXIST);
  if (!won) {
    redis.sadd("batch:" + batchId + ":shards", *shardId);
    return "";
  }
  redis.zadd("batch:" + batchId + ":leases", *shardId, deadlineSeconds());
  return *shardId;
}

bool heartbeat(Redis& redis, const std::string& batchId, const std::string& shardId,
               const std::string& workerId) {
  const auto leaseKey = "batch:" + batchId + ":shard:" + shardId + ":lease";
  auto renewed = redis.eval(kHeartbeatLua, {leaseKey}, {workerId, std::to_string(kLeaseSeconds)});
  return renewed && *renewed != "0";
}

int reclaim(Redis& redis, const std::string& batchId) {
  const auto leasesKey = "batch:" + batchId + ":leases";
  auto expired = redis.zrangebyscore(leasesKey, 0.0, deadlineSeconds());
  for (const auto& shardId : expired) {
    redis.del("batch:" + batchId + ":shard:" + shardId + ":lease");
    redis.sadd("batch:" + batchId + ":shards", shardId);
    redis.zrem(leasesKey, shardId);
  }
  return static_cast<int>(expired.size());
}

void run_shard(Redis& redis, const std::string& batchId, const std::string& shardId) {
  const bool done = process_shard(batchId, shardId);
  redis.hincrby("batch:" + batchId + ":counts", done ? "done" : "failed", 1);
  redis.zrem("batch:" + batchId + ":leases", shardId);
  redis.del("batch:" + batchId + ":shard:" + shardId + ":lease");
}
`,
    },
  },
  debrief: `The interviewer is testing one property: can this queue lose a shard? The draft can, three ways.
It pops without a lease, so a crash between pop and completion removes the shard from the work set
forever; its heartbeat is a plain write, so a second worker can claim ownership of a shard already
being processed; and it counts a shard as done before the work happens, so the counter says finished
while the work set is missing an entry. The fix is the standard leased-work pattern — atomic
\`SET NX EX\`, a compare-and-renew heartbeat, a sorted-set deadline index with a reaper, and counters
incremented only when the shard is actually terminal. Real systems add a per-worker visibility
timeout, a bounded redelivery count, and a poison-shard quarantine after repeated failures.`,
};
