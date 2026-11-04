import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis partition progress: completion happens once',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the partition progress every worker shares:
\`commit_partition(load_id, partition_id, total_partitions)\` appends the partition to the list
\`load:{id}:partitions\` and, once the list is \`total_partitions\` long, sets \`load:{id}:complete\` and
returns True; \`is_complete(load_id)\` reads the flag. It serves the demo, where every partition
commits once, and hides three flaws.

**Failure mode the checks target.** A redelivered partition task counts twice, so a load with a
partition missing reads as complete; two workers finishing the last two partitions at once are both
told they completed the load, so the completion event goes out twice; and the progress keys of every
abandoned load stay in Redis.

- Committed partitions are the **set** \`load:{id}:partitions\`: a repeated commit adds nothing.
- Add the partition, count the set and set the flag in **one Lua script** that answers 1 only to the
  commit that completed the load, the one that found the flag unset.
- Both keys expire after \`LOAD_TTL_S\` (7 days).`,
  sequence: {
    participants: ['Worker A', 'Worker B', 'Redis'],
    messages: [
      {from: 'Worker A', to: 'Redis', label: 'EVAL commit · SADD load:{id}:partitions p-1 · total 3', kind: 'sync'},
      {from: 'Redis', to: 'Worker A', label: '0 · p-2 still missing', kind: 'reply'},
      {from: 'Worker B', to: 'Redis', label: 'EVAL commit · SADD p-2 · SCARD = 3 · SET complete EX 7 d', kind: 'sync'},
      {from: 'Redis', to: 'Worker B', label: '1 · this commit completed the load', kind: 'reply'},
      {from: 'Worker A', to: 'Redis', label: 'EVAL commit · p-2 redelivered', kind: 'sync'},
      {from: 'Redis', to: 'Worker A', label: '0 · already complete', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'partition-set',
      title: 'Counts each partition once',
      detail:
        'Committed partitions go into the set `load:{id}:partitions` (`SADD`, counted with `SCARD`), so a redelivered partition adds nothing; the starter appends to a list and counts deliveries.',
      match: {
        python: {all: [/SADD/i, /SCARD/i], none: [/rpush|llen/i]},
        typescript: {all: [/SADD/i, /SCARD/i], none: [/rpush|llen/i]},
        go: {all: [/SADD/i, /SCARD/i], none: [/rpush|llen/i]},
        scala: {all: [/SADD/i, /SCARD/i], none: [/rpush|llen/i]},
        cpp: {all: [/SADD/i, /SCARD/i], none: [/rpush|llen/i]},
      },
    },
    {
      id: 'complete-once',
      title: 'Exactly one commit completes the load',
      detail:
        'One Lua script adds the partition, counts the set and sets the flag only if it was unset, answering 1 to that commit alone; the starter’s separate commands let two workers both see a full count.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /EXISTS|\bNX\b/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /EXISTS|\bNX\b/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /EXISTS|\bNX\b/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /EXISTS|\bNX\b/]},
        cpp: {all: [/redis\.eval(sha)?</, /EXISTS|\bNX\b/]},
      },
    },
    {
      id: 'expiry',
      title: 'Expires the progress keys',
      detail:
        'Both `load:{id}:partitions` and `load:{id}:complete` carry `LOAD_TTL_S` (7 days); the starter writes them without a TTL, so every abandoned load stays in Redis.',
      match: {
        python: {all: [/LOAD_TTL_S\s*=/, /EXPIRE|'EX'|"EX"/]},
        typescript: {all: [/LOAD_TTL_S\s*=/, /EXPIRE|'EX'|"EX"/]},
        go: {all: [/loadTTLSeconds\s*=/, /EXPIRE|'EX'|"EX"/]},
        scala: {all: [/LoadTtlSeconds(:\s*Long)?\s*=/, /EXPIRE|'EX'|"EX"/]},
        cpp: {all: [/kLoadTtlSeconds\s*=/, /EXPIRE|'EX'|"EX"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def commit_partition(load_id: str, partition_id: str, total_partitions: int) -> bool:
    """Record a committed partition; True for the commit that completed the load."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    parts = f"load:{load_id}:partitions"
    r.rpush(parts, partition_id)
    if r.llen(parts) >= total_partitions:
        r.set(f"load:{load_id}:complete", "1")
        return True
    return False


def is_complete(load_id: str) -> bool:
    """Whether every partition of the load committed."""
    return r.exists(f"load:{load_id}:complete") == 1
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LOAD_TTL_S = 7 * 24 * 3600

# Add, count and complete in one step: only the commit that finds the flag unset is answered 1.
COMMIT_LUA = """
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if redis.call('SCARD', KEYS[1]) < tonumber(ARGV[2]) then return 0 end
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
return 1
"""
commit = r.register_script(COMMIT_LUA)


def commit_partition(load_id: str, partition_id: str, total_partitions: int) -> bool:
    """Record a committed partition; True for the commit that completed the load."""
    keys = [f"load:{load_id}:partitions", f"load:{load_id}:complete"]
    return commit(keys=keys, args=[partition_id, total_partitions, LOAD_TTL_S]) == 1


def is_complete(load_id: str) -> bool:
    """Whether every partition of the load committed."""
    return r.exists(f"load:{load_id}:complete") == 1
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** Record a committed partition; true for the commit that completed the load. */
export async function commitPartition(loadId: string, partitionId: string, totalPartitions: number): Promise<boolean> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const parts = \`load:\${loadId}:partitions\`;
  await redis.rpush(parts, partitionId);
  if ((await redis.llen(parts)) < totalPartitions) return false;
  await redis.set(\`load:\${loadId}:complete\`, '1');
  return true;
}

/** Whether every partition of the load committed. */
export async function isComplete(loadId: string): Promise<boolean> {
  return (await redis.exists(\`load:\${loadId}:complete\`)) === 1;
}
`,
      solution: `import Redis from 'ioredis';

export const LOAD_TTL_S = 7 * 24 * 3600;

// Add, count and complete in one step: only the commit that finds the flag unset is answered 1.
const COMMIT_LUA = \`
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if redis.call('SCARD', KEYS[1]) < tonumber(ARGV[2]) then return 0 end
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
return 1
\`;

interface ProgressRedis extends Redis {
  commitPartition(parts: string, complete: string, partitionId: string, total: number, ttl: number): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ProgressRedis;
redis.defineCommand('commitPartition', {numberOfKeys: 2, lua: COMMIT_LUA});

/** Record a committed partition; true for the commit that completed the load. */
export async function commitPartition(loadId: string, partitionId: string, totalPartitions: number): Promise<boolean> {
  return (await redis.commitPartition(\`load:\${loadId}:partitions\`, \`load:\${loadId}:complete\`, partitionId, totalPartitions, LOAD_TTL_S)) === 1;
}

/** Whether every partition of the load committed. */
export async function isComplete(loadId: string): Promise<boolean> {
  return (await redis.exists(\`load:\${loadId}:complete\`)) === 1;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// commitPartition records a committed partition; true for the commit that completed the load.
func commitPartition(ctx context.Context, loadID, partitionID string, totalPartitions int) (bool, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	parts := "load:" + loadID + ":partitions"
	if err := rdb.RPush(ctx, parts, partitionID).Err(); err != nil {
		return false, err
	}
	n, err := rdb.LLen(ctx, parts).Result()
	if err != nil || n < int64(totalPartitions) {
		return false, err
	}
	return true, rdb.Set(ctx, "load:"+loadID+":complete", "1", 0).Err()
}

// isComplete reports whether every partition of the load committed.
func isComplete(ctx context.Context, loadID string) (bool, error) {
	n, err := rdb.Exists(ctx, "load:"+loadID+":complete").Result()
	return n == 1, err
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const loadTTLSeconds = 7 * 24 * 3600

// commitScript adds, counts and completes in one step: only the commit that finds the flag unset is answered 1.
var commitScript = redis.NewScript(\`
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if redis.call('SCARD', KEYS[1]) < tonumber(ARGV[2]) then return 0 end
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
return 1
\`)

// commitPartition records a committed partition; true for the commit that completed the load.
func commitPartition(ctx context.Context, loadID, partitionID string, totalPartitions int) (bool, error) {
	keys := []string{"load:" + loadID + ":partitions", "load:" + loadID + ":complete"}
	done, err := commitScript.Run(ctx, rdb, keys, partitionID, totalPartitions, loadTTLSeconds).Int64()
	return done == 1, err
}

// isComplete reports whether every partition of the load committed.
func isComplete(ctx context.Context, loadID string) (bool, error) {
	n, err := rdb.Exists(ctx, "load:"+loadID+":complete").Result()
	return n == 1, err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** Record a committed partition; true for the commit that completed the load. */
  def commitPartition(loadId: String, partitionId: String, totalPartitions: Int): Boolean = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    val parts = s"load:$loadId:partitions"
    jedis.rpush(parts, partitionId)
    if (jedis.llen(parts) < totalPartitions) false
    else {
      jedis.set(s"load:$loadId:complete", "1")
      true
    }
  }

  /** Whether every partition of the load committed. */
  def isComplete(loadId: String): Boolean = jedis.exists(s"load:$loadId:complete")
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  val jedis = new JedisPooled("redis", 6379)

  val LoadTtlSeconds: Long = 7L * 24 * 3600

  /** Add, count and complete in one step: only the commit that finds the flag unset is answered 1. */
  val CommitLua: String =
    """redis.call('SADD', KEYS[1], ARGV[1])
      |redis.call('EXPIRE', KEYS[1], ARGV[3])
      |if redis.call('SCARD', KEYS[1]) < tonumber(ARGV[2]) then return 0 end
      |if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
      |redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
      |return 1
      |""".stripMargin

  /** Record a committed partition; true for the commit that completed the load. */
  def commitPartition(loadId: String, partitionId: String, totalPartitions: Int): Boolean = {
    val keys = List(s"load:$loadId:partitions", s"load:$loadId:complete").asJava
    val args = List(partitionId, totalPartitions.toString, LoadTtlSeconds.toString).asJava
    jedis.eval(CommitLua, keys, args).asInstanceOf[java.lang.Long] == 1L
  }

  /** Whether every partition of the load committed. */
  def isComplete(loadId: String): Boolean = jedis.exists(s"load:$loadId:complete")
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

sw::redis::Redis redis("tcp://redis:6379");

// Record a committed partition; true for the commit that completed the load.
bool commitPartition(const std::string& load_id, const std::string& partition_id, long total_partitions) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const std::string parts = "load:" + load_id + ":partitions";
  redis.rpush(parts, partition_id);
  if (redis.llen(parts) < total_partitions) return false;
  redis.set("load:" + load_id + ":complete", "1");
  return true;
}

// Whether every partition of the load committed.
bool isComplete(const std::string& load_id) { return redis.exists("load:" + load_id + ":complete") == 1; }
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long kLoadTtlSeconds = 7 * 24 * 3600;

// Add, count and complete in one step: only the commit that finds the flag unset is answered 1.
const std::string kCommitLua = R"lua(
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
if redis.call('SCARD', KEYS[1]) < tonumber(ARGV[2]) then return 0 end
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[2], '1', 'EX', ARGV[3])
return 1
)lua";

// Record a committed partition; true for the commit that completed the load.
bool commitPartition(const std::string& load_id, const std::string& partition_id, long total_partitions) {
  return redis.eval<long long>(kCommitLua, {"load:" + load_id + ":partitions", "load:" + load_id + ":complete"},
                               {partition_id, std::to_string(total_partitions), std::to_string(kLoadTtlSeconds)}) == 1;
}

// Whether every partition of the load committed.
bool isComplete(const std::string& load_id) { return redis.exists("load:" + load_id + ":complete") == 1; }
`,
    },
  },
  harness: {
    python: `LOAD_TTL_S = 7 * 24 * 3600


def check_partition_set(ctx):
    m = ctx.load("state")
    assert m.commit_partition("ld-1", "p-0", 2) is False, "the first of two partitions must not complete the load"
    again = m.commit_partition("ld-1", "p-0", 2)
    assert again is False, "p-0 committed a second time (a redelivered task) completed a two-partition load whose p-1 never committed: a partition counts once"
    assert m.is_complete("ld-1") is False, "ld-1 reads as complete with p-1 missing"
    assert m.commit_partition("ld-1", "p-1", 2) is True, "the commit of p-1, the last missing partition, must complete the load"
    assert m.is_complete("ld-1") is True, "after both partitions committed ld-1 must read as complete"


def check_complete_once(ctx):
    m = ctx.load("state")
    assert m.commit_partition("ld-1", "p-0", 3) is False, "the first of three partitions must not complete the load"
    # Another worker commits p-2 right after this worker's first command on the partition set.
    rival = ctx.redis_after("load:ld-1:partitions", lambda: m.commit_partition("ld-1", "p-2", 3))
    mine = m.commit_partition("ld-1", "p-1", 3)
    assert rival.fired, "commit_partition never touched load:ld-1:partitions"
    if rival.error is not None:
        raise rival.error
    winners = [mine, rival.result].count(True)
    assert winners == 1, f"two workers committed the last two partitions at once and {winners} of them were told they completed the load (this one {mine}, the other {rival.result}): exactly one may announce the completion"
    assert m.is_complete("ld-1") is True, "after all three partitions committed ld-1 must read as complete"
    assert m.commit_partition("ld-1", "p-2", 3) is False, "a redelivered final partition reported completing the load a second time"


def check_expiry(ctx):
    m = ctx.load("state")
    m.commit_partition("ld-1", "p-0", 2)
    ttl = ctx.redis.ttl("load:ld-1:partitions")
    assert LOAD_TTL_S - 60 <= ttl <= LOAD_TTL_S, f"load:ld-1:partitions has TTL {ttl}, expected LOAD_TTL_S ({LOAD_TTL_S} s): an abandoned load's progress must expire"
    m.commit_partition("ld-1", "p-1", 2)
    ttl = ctx.redis.ttl("load:ld-1:complete")
    assert LOAD_TTL_S - 60 <= ttl <= LOAD_TTL_S, f"load:ld-1:complete has TTL {ttl}, expected LOAD_TTL_S ({LOAD_TTL_S} s): a flag that outlives its load makes a re-run look done"
`,
    typescript: `const LOAD_TTL_S = 7 * 24 * 3600;

export async function check_partition_set(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.commitPartition('ld-1', 'p-0', 2), false, 'the first of two partitions must not complete the load');
  assert.equal(await m.commitPartition('ld-1', 'p-0', 2), false, 'p-0 committed a second time (a redelivered task) completed a two-partition load whose p-1 never committed: a partition counts once');
  assert.equal(await m.isComplete('ld-1'), false, 'ld-1 reads as complete with p-1 missing');
  assert.equal(await m.commitPartition('ld-1', 'p-1', 2), true, 'the commit of p-1, the last missing partition, must complete the load');
  assert.equal(await m.isComplete('ld-1'), true, 'after both partitions committed ld-1 must read as complete');
}

export async function check_complete_once(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.commitPartition('ld-1', 'p-0', 3), false, 'the first of three partitions must not complete the load');
  // Another worker commits p-2 right after this worker's first command on the partition set.
  const rival = ctx.redisAfter('load:ld-1:partitions', () => m.commitPartition('ld-1', 'p-2', 3));
  const mine = await m.commitPartition('ld-1', 'p-1', 3);
  assert(rival.fired, 'commitPartition never touched load:ld-1:partitions');
  if (rival.error !== undefined) throw rival.error;
  const theirs = await rival.result;
  const winners = [mine, theirs].filter(won => won === true).length;
  assert.equal(winners, 1, \`two workers committed the last two partitions at once and \${winners} of them were told they completed the load (this one \${mine}, the other \${theirs}): exactly one may announce the completion\`);
  assert.equal(await m.isComplete('ld-1'), true, 'after all three partitions committed ld-1 must read as complete');
  assert.equal(await m.commitPartition('ld-1', 'p-2', 3), false, 'a redelivered final partition reported completing the load a second time');
}

export async function check_expiry(ctx) {
  const m = ctx.load('state');
  await m.commitPartition('ld-1', 'p-0', 2);
  let ttl = ctx.redis.ttl('load:ld-1:partitions');
  assert(LOAD_TTL_S - 60 <= ttl && ttl <= LOAD_TTL_S, \`load:ld-1:partitions has TTL \${ttl}, expected LOAD_TTL_S (\${LOAD_TTL_S} s): an abandoned load's progress must expire\`);
  await m.commitPartition('ld-1', 'p-1', 2);
  ttl = ctx.redis.ttl('load:ld-1:complete');
  assert(LOAD_TTL_S - 60 <= ttl && ttl <= LOAD_TTL_S, \`load:ld-1:complete has TTL \${ttl}, expected LOAD_TTL_S (\${LOAD_TTL_S} s): a flag that outlives its load makes a re-run look done\`);
}
`,
    go: `package main

import (
	"context"

	"leetbuild/harness"
)

const stateTTL = 7 * 24 * 3600

var stateBg = context.Background()

func stateCommit(ctx *harness.Ctx, partitionID string, total int) bool {
	done, err := commitPartition(stateBg, "ld-1", partitionID, total)
	ctx.NoError(err, "commitPartition(ld-1, %s, %d) failed", partitionID, total)
	return done
}

func stateComplete(ctx *harness.Ctx) bool {
	done, err := isComplete(stateBg, "ld-1")
	ctx.NoError(err, "isComplete(ld-1) failed")
	return done
}

func CheckPartitionSet(ctx *harness.Ctx) {
	ctx.Equal(stateCommit(ctx, "p-0", 2), false, "the first of two partitions must not complete the load; completed")
	ctx.Equal(stateCommit(ctx, "p-0", 2), false, "p-0 committed a second time (a redelivered task) completed a two-partition load whose p-1 never committed: a partition counts once; completed")
	ctx.Equal(stateComplete(ctx), false, "ld-1 must not read as complete with p-1 missing; complete")
	ctx.Equal(stateCommit(ctx, "p-1", 2), true, "the commit of p-1, the last missing partition, must complete the load; completed")
	ctx.Equal(stateComplete(ctx), true, "after both partitions committed, ld-1 complete")
}

func CheckCompleteOnce(ctx *harness.Ctx) {
	ctx.Equal(stateCommit(ctx, "p-0", 3), false, "the first of three partitions must not complete the load; completed")
	// Another worker commits p-2 right after this worker's first command on the partition set.
	rival := ctx.Redis.After("load:ld-1:partitions", func() any {
		done, err := commitPartition(stateBg, "ld-1", "p-2", 3)
		ctx.NoError(err, "the other worker's commit failed")
		return done
	})
	mine := stateCommit(ctx, "p-1", 3)
	ctx.Assert(rival.Fired, "commitPartition never touched load:ld-1:partitions")
	ctx.Assert(rival.Err == nil, "the other worker's commit failed: %v", rival.Err)
	winners := 0
	for _, won := range []any{mine, rival.Result} {
		if won == true {
			winners++
		}
	}
	ctx.Equal(winners, 1, "two workers committed the last two partitions at once (this one %v, the other %v): exactly one may be told it completed the load; the commits answered true", mine, rival.Result)
	ctx.Equal(stateComplete(ctx), true, "after all three partitions committed, ld-1 complete")
	ctx.Equal(stateCommit(ctx, "p-2", 3), false, "a redelivered final partition must not report completing the load a second time; completed")
}

func CheckExpiry(ctx *harness.Ctx) {
	stateCommit(ctx, "p-0", 2)
	ttl := ctx.Redis.TTL("load:ld-1:partitions")
	ctx.Assert(stateTTL-60 <= ttl && ttl <= stateTTL, "load:ld-1:partitions has TTL %d, expected loadTTLSeconds (%d s): an abandoned load's progress must expire", ttl, stateTTL)
	stateCommit(ctx, "p-1", 2)
	ttl = ctx.Redis.TTL("load:ld-1:complete")
	ctx.Assert(stateTTL-60 <= ttl && ttl <= stateTTL, "load:ld-1:complete has TTL %d, expected loadTTLSeconds (%d s): a flag that outlives its load makes a re-run look done", ttl, stateTTL)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>

namespace {

constexpr long long kStateTtl = 7 * 24 * 3600;

struct Rival {
  bool fired = false;
  bool done = false;
  std::optional<std::string> err;
};

}  // namespace

void CheckPartitionSet(harness::Ctx& ctx) {
  ctx.Equal(commitPartition("ld-1", "p-0", 2), false, "the first of two partitions must not complete the load; completed");
  ctx.Equal(commitPartition("ld-1", "p-0", 2), false, "p-0 committed a second time (a redelivered task) completed a two-partition load whose p-1 never committed: a partition counts once; completed");
  ctx.Equal(isComplete("ld-1"), false, "ld-1 must not read as complete with p-1 missing; complete");
  ctx.Equal(commitPartition("ld-1", "p-1", 2), true, "the commit of p-1, the last missing partition, must complete the load; completed");
  ctx.Equal(isComplete("ld-1"), true, "after both partitions committed, ld-1 complete");
}

void CheckCompleteOnce(harness::Ctx& ctx) {
  ctx.Equal(commitPartition("ld-1", "p-0", 3), false, "the first of three partitions must not complete the load; completed");
  // Another worker commits p-2 right after this worker's first command on the partition set.
  auto rival = std::make_shared<Rival>();
  ctx.Redis.After("load:ld-1:partitions", [rival] {
    rival->fired = true;
    try {
      rival->done = commitPartition("ld-1", "p-2", 3);
    } catch (const std::exception& e) {
      rival->err = e.what();
    }
  });
  const bool mine = commitPartition("ld-1", "p-1", 3);
  ctx.Assert(rival->fired, "commitPartition never touched load:ld-1:partitions");
  ctx.Assert(!rival->err, "the other worker's commit failed: %s", rival->err.value_or(""));
  ctx.Equal(int(mine) + int(rival->done), 1, "two workers committed the last two partitions at once (this one %t, the other %t): exactly one may be told it completed the load; the commits answered true", mine, rival->done);
  ctx.Equal(isComplete("ld-1"), true, "after all three partitions committed, ld-1 complete");
  ctx.Equal(commitPartition("ld-1", "p-2", 3), false, "a redelivered final partition must not report completing the load a second time; completed");
}

void CheckExpiry(harness::Ctx& ctx) {
  commitPartition("ld-1", "p-0", 2);
  long long ttl = ctx.Redis.TTL("load:ld-1:partitions");
  ctx.Assert(kStateTtl - 60 <= ttl && ttl <= kStateTtl, "load:ld-1:partitions has TTL %d, expected kLoadTtlSeconds (%d s): an abandoned load's progress must expire", ttl, kStateTtl);
  commitPartition("ld-1", "p-1", 2);
  ttl = ctx.Redis.TTL("load:ld-1:complete");
  ctx.Assert(kStateTtl - 60 <= ttl && ttl <= kStateTtl, "load:ld-1:complete has TTL %d, expected kLoadTtlSeconds (%d s): a flag that outlives its load makes a re-run look done", ttl, kStateTtl);
}
`,
  },
  hints: [
    'Commit p-0 twice for a two-partition load: it reads complete while p-1 was never written. Commit the last two partitions from two workers at once: both calls return True.',
    'A list counts deliveries, not partitions, so `LLEN` reaches the total early. The append, the count and the `SET` are three commands: another worker’s commit lands between them and both see a full count. Nothing sets a TTL.',
    'One script: `SADD KEYS[1] ARGV[1]` and `EXPIRE` it, return 0 while `SCARD` is below `ARGV[2]` or `KEYS[2]` exists, else `SET KEYS[2] 1 EX ARGV[3]` and return 1. Run it through `register_script`.',
  ],
  debrief: `Completion is a transition, not a count, and only a transition can be handed to exactly one caller. The set makes the count mean distinct partitions, so a redelivered task is harmless. The script makes "add, count, set the flag if it was unset" one step, so of two workers finishing together exactly one is answered 1 and the completion event is produced once. The TTL belongs to correctness as well: a flag that outlives its load makes a re-run of the same load id look done. Production loaders keep committed partitions next to the warehouse's own commit log, so a crash between the warehouse write and the Redis commit can be reconciled on restart.`,
};
