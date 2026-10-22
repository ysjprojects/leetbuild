import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis gap-less progress with manifest commit',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it writes a completion flag,
logs each partition, and answers \`is_complete\` from the flag. It serves the demo where the loader
runs to the end, and it turns a crash into a table that is missing data while the platform believes
the load finished. Review it like the service owner, fix it, and prove the fix.

Track a load's progress in Redis, one manifest at a time.

- **Every committed partition** is recorded in a Redis **set** at \`load:{manifest_id}:partitions\`.
  A set, not a counter and not a list: committing the same partition twice (a retried worker, a
  re-run after a crash) must be a **no-op**, so the re-run is safe.
- The completion flag \`load:{manifest_id}:complete\` may only be written when **every** partition of
  the manifest is in the set — \`SCARD\` reaches the manifest's partition count. Flipping it when the
  source file is read (or when the *last* file arrives) marks a load done that never committed.
- The final partition and the completion flag are written by **one atomic script** (\`EVAL\` with
  \`KEYS\`/\`ARGV\`): two round-trips leave a window in which the last partition is committed and the
  flag is not, or the flag is set and the count moved afterwards.
- Readers ask \`is_complete(manifest_id, total_partitions)\`. A partial load must be **invisible** as
  done: the flag alone is not enough — the reader re-checks the committed count before answering
  \`true\`.
- Both keys carry a **TTL** (\`LOAD_TTL_S\` seconds, \`EX\` on the write) so an abandoned manifest
  cannot leave a stale "complete" behind that a later load of the same id reads as its own.

**Failure mode the checks target.** The draft marks complete at read time and keeps no set: a crash
between the read and the last partition leaves a load that any downstream reader — and the report
endpoint in step 5 — will call done, while two partitions are missing. A counter instead of a set
would double-count a re-run; a flag without a TTL would outlive the load.`,
  sequence: {
    participants: ['Load worker', 'Redis', 'Downstream reader'],
    messages: [
      {from: 'Load worker', to: 'Redis', label: 'SADD load:{id}:partitions {partition}', kind: 'sync'},
      {from: 'Redis', to: 'Load worker', label: '1 · new partition / 0 · already committed', kind: 'reply'},
      {from: 'Load worker', to: 'Redis', label: 'EVAL commit · SCARD vs total · SET complete EX', kind: 'sync'},
      {from: 'Redis', to: 'Load worker', label: '1 complete / 0 still missing partitions', kind: 'reply'},
      {from: 'Downstream reader', to: 'Redis', label: 'GET load:{id}:complete', kind: 'sync'},
      {from: 'Redis', to: 'Downstream reader', label: '1', kind: 'reply'},
      {from: 'Downstream reader', to: 'Redis', label: 'SCARD load:{id}:partitions before trusting it', kind: 'sync'},
      {from: 'Redis', to: 'Downstream reader', label: 'committed count', kind: 'reply'},
    ],
  },
  hints: [
    'Start from the invariant, not the code: a load is complete exactly when the set of committed partitions has grown to the manifest’s partition count. Every write in the step exists to preserve that sentence across crashes.',
    '`SADD` is the dedupe: the same partition id twice is one member, so a re-run and a retried worker cannot inflate progress. Then the `SCARD` check and the `SET complete ... EX` must live in the **same** script — a `KEYS`/`ARGV` Lua body — or a crash between them breaks the invariant.',
    'The reader is part of the contract: `is_complete` reads the flag *and* re-checks `SCARD`, so a stale or early flag is never enough. The TTL is what makes the flag belong to this load and not to whichever re-run reuses the manifest id later.',
  ],
  checks: [
    {
      id: 'partition-set',
      title: 'Records committed partitions in a Redis set',
      detail:
        'Committed partitions are `SADD`ed into `load:{manifest_id}:partitions`, so the same partition committed twice stays one member and a re-run is safe. The draft records no set at all.',
      match: {
        python: {all: [/\.sadd\(/, /:partitions/]},
        typescript: {all: [/\.sadd\(/, /:partitions/]},
        go: {all: [/\.SAdd\(/, /:partitions/]},
        scala: {all: [/\.sadd\(/, /:partitions/]},
        cpp: {all: [/\.sadd\(/, /:partitions/]},
      },
    },
    {
      id: 'complete-after-all',
      title: 'Sets the completion flag only when every partition is in',
      detail:
        'The flag is written only when `SCARD` of the partition set reaches the manifest’s partition count. The draft flips the flag when the source file is read.',
      match: {
        python: {all: [/SCARD/, /total_partitions/], none: [/begin_load/]},
        typescript: {all: [/SCARD/, /totalPartitions/], none: [/beginLoad/]},
        go: {all: [/SCARD/, /totalPartitions/], none: [/beginLoad/]},
        scala: {all: [/SCARD/, /totalPartitions/], none: [/beginLoad/]},
        cpp: {all: [/SCARD/, /totalPartitions/], none: [/beginLoad/]},
      },
    },
    {
      id: 'atomic-commit',
      title: 'Commits the final partition and the flag in one script',
      detail:
        'One `EVAL` over `KEYS`/`ARGV` counts the set and writes the flag, so no crash can leave the last partition committed without the flag. The draft never uses a script.',
      match: {
        python: {all: [/\beval\(/, /KEYS\[1\]/, /ARGV\[1\]/]},
        typescript: {all: [/\beval\(/, /KEYS\[1\]/, /ARGV\[1\]/]},
        go: {all: [/NewScript\(/, /KEYS\[1\]/, /ARGV\[1\]/]},
        scala: {all: [/\.eval\(/, /KEYS\[1\]/, /ARGV\[1\]/]},
        cpp: {all: [/\beval</, /KEYS\[1\]/, /ARGV\[1\]/]},
      },
    },
    {
      id: 'reader-counts',
      title: 'Never reports a partial load as done',
      detail:
        '`is_complete` reads the flag **and** re-checks `SCARD` against the partition count, so a partial load is invisible as done. The draft answers from the flag alone.',
      match: {
        python: {all: [/def is_complete\(/, /scard\(/]},
        typescript: {all: [/isComplete\(/, /scard\(/]},
        go: {all: [/IsComplete\(/, /SCard\(/]},
        scala: {all: [/isComplete\(/, /scard\(/]},
        cpp: {all: [/isComplete\(/, /scard\(/]},
      },
    },
    {
      id: 'expiry',
      title: 'Expires progress keys with the load',
      detail:
        'Both keys carry `LOAD_TTL_S` seconds via `EX`/`EXPIRE`, so an abandoned manifest cannot leave a stale completion flag behind. The draft writes both keys without a TTL.',
      match: {
        python: {all: [/LOAD_TTL_S/, /'EX'|EXPIRE/]},
        typescript: {all: [/LOAD_TTL_S/, /'EX'|EXPIRE/]},
        go: {all: [/loadTTLS/, /'EX'|EXPIRE/]},
        scala: {all: [/LoadTtlS/, /'EX'|EXPIRE/]},
        cpp: {all: [/kLoadTtlS/, /'EX'|EXPIRE/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import redis

r = redis.Redis(host="redis", port=6379)
logger = logging.getLogger("loader")


def begin_load(manifest_id: str, total_partitions: int) -> None:
    # TODO: this draft flips the completion flag when the source file is read, before any partition
    # commits, and gives the key no TTL. A crash here leaves a load that looks complete while
    # partitions are missing. Review the whole path.
    r.set(f"load:{manifest_id}:complete", "1")


def commit_partition(manifest_id: str, partition_id: str, total_partitions: int) -> None:
    # TODO: the draft "tracks" progress in the log instead of a Redis set, so a re-run cannot dedupe
    # and the completion check has nothing to count.
    logger.info("committed %s/%s", manifest_id, partition_id)


def is_complete(manifest_id: str, total_partitions: int) -> bool:
    # TODO: readers trust the flag alone; they never check the partition count.
    return r.get(f"load:{manifest_id}:complete") is not None
`,
      solution: `import logging

import redis

r = redis.Redis(host="redis", port=6379)
logger = logging.getLogger("loader")

LOAD_TTL_S = 86400
COMMIT_LUA = """
local committed = redis.call('SCARD', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
if committed >= tonumber(ARGV[1]) then
  redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[2]))
  return 1
end
return 0
"""


def commit_partition(manifest_id: str, partition_id: str, total_partitions: int) -> bool:
    """Record one committed partition; True once the manifest is complete and the flag is set."""
    parts = f"load:{manifest_id}:partitions"
    complete = f"load:{manifest_id}:complete"
    r.sadd(parts, partition_id)  # dedupe: a re-run of the same partition adds no member
    done = r.eval(COMMIT_LUA, 2, parts, complete, total_partitions, LOAD_TTL_S)
    if done == 1:
        logger.info("manifest %s complete: %d/%d partitions", manifest_id, total_partitions, total_partitions)
    return done == 1


def is_complete(manifest_id: str, total_partitions: int) -> bool:
    """A load is done only when the flag is set *and* every partition is in the set."""
    parts = f"load:{manifest_id}:partitions"
    complete = f"load:{manifest_id}:complete"
    if r.get(complete) is None:
        return False
    return r.scard(parts) >= total_partitions
`,
    },
    typescript: {
      starter: `/** Redis progress for one manifest: a model-generated draft that trusts the read. */
import Redis from 'ioredis';

export const redis = new Redis('redis://redis:6379');

export async function beginLoad(manifestId: string, totalPartitions: number): Promise<void> {
  // TODO: this draft flips the completion flag when the source file is read, before any partition
  // commits, and gives the key no TTL. Review the whole path.
  await redis.set(\`load:\${manifestId}:complete\`, '1');
}

export async function commitPartition(
  manifestId: string,
  partitionId: string,
  totalPartitions: number,
): Promise<void> {
  // TODO: the draft logs progress instead of recording it in a Redis set, so a re-run cannot dedupe
  // and the completion check has nothing to count.
  console.log(\`committed \${manifestId}/\${partitionId}\`);
}

export async function isComplete(manifestId: string, totalPartitions: number): Promise<boolean> {
  // TODO: readers trust the flag alone; they never check the partition count.
  return (await redis.get(\`load:\${manifestId}:complete\`)) !== null;
}
`,
      solution: `/** Redis progress for one manifest: a set of committed partitions, a scripted completion. */
import Redis from 'ioredis';

export const redis = new Redis('redis://redis:6379');

const LOAD_TTL_S = 86400;
const COMMIT_LUA = \`
local committed = redis.call('SCARD', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
if committed >= tonumber(ARGV[1]) then
  redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[2]))
  return 1
end
return 0
\`;

export async function commitPartition(
  manifestId: string,
  partitionId: string,
  totalPartitions: number,
): Promise<boolean> {
  const parts = \`load:\${manifestId}:partitions\`;
  const complete = \`load:\${manifestId}:complete\`;
  await redis.sadd(parts, partitionId); // a re-run of the same partition adds no member
  const done = await redis.eval(COMMIT_LUA, 2, parts, complete, totalPartitions, LOAD_TTL_S);
  return Number(done) === 1;
}

export async function isComplete(manifestId: string, totalPartitions: number): Promise<boolean> {
  const parts = \`load:\${manifestId}:partitions\`;
  const complete = \`load:\${manifestId}:complete\`;
  const flag = await redis.get(complete);
  if (flag === null) return false; // the flag alone is not enough
  return (await redis.scard(parts)) >= totalPartitions;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func beginLoad(ctx context.Context, manifestID string, totalPartitions int) error {
	// TODO: this draft flips the completion flag when the source file is read, before any partition
	// commits, and gives the key no TTL. Review the whole path.
	return rdb.Set(ctx, "load:"+manifestID+":complete", "1", 0).Err()
}

func commitPartition(ctx context.Context, manifestID, partitionID string, totalPartitions int) error {
	// TODO: the draft logs progress instead of recording it in a Redis set, so a re-run cannot
	// dedupe and the completion check has nothing to count.
	log.Printf("committed %s/%s", manifestID, partitionID)
	return nil
}

func IsComplete(ctx context.Context, manifestID string, totalPartitions int) (bool, error) {
	// TODO: readers trust the flag alone; they never check the partition count.
	flag, err := rdb.Get(ctx, "load:"+manifestID+":complete").Result()
	if err == redis.Nil {
		return false, nil
	}
	return flag == "1", err
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"log"

	"github.com/redis/go-redis/v9"
)

const loadTTLS = 86400

var (
	rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
	// One script: the count of committed partitions and the completion flag cannot be split by a crash.
	commitScript = redis.NewScript(\`
local committed = redis.call('SCARD', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
if committed >= tonumber(ARGV[1]) then
  redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[2]))
  return 1
end
return 0
\`)
)

// CommitPartition records one committed partition and reports whether the manifest is now complete.
func CommitPartition(ctx context.Context, manifestID, partitionID string, totalPartitions int) (bool, error) {
	parts := "load:" + manifestID + ":partitions"
	complete := "load:" + manifestID + ":complete"
	if err := rdb.SAdd(ctx, parts, partitionID).Err(); err != nil {
		return false, err
	}
	done, err := commitScript.Run(ctx, rdb, []string{parts, complete}, totalPartitions, loadTTLS).Int()
	if err != nil {
		return false, err
	}
	if done == 1 {
		log.Printf("manifest %s complete: %d partitions", manifestID, totalPartitions)
	}
	return done == 1, nil
}

// IsComplete reads the flag *and* the committed count: a partial load is never reported as done.
func IsComplete(ctx context.Context, manifestID string, totalPartitions int) (bool, error) {
	parts := "load:" + manifestID + ":partitions"
	complete := "load:" + manifestID + ":complete"
	flag, err := rdb.Get(ctx, complete).Result()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if flag != "1" {
		return false, nil
	}
	committed, err := rdb.SCard(ctx, parts).Result()
	if err != nil {
		return false, err
	}
	return int(committed) >= totalPartitions, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object LoadState {
  val jedis = new Jedis("redis", 6379)

  def beginLoad(manifestId: String, totalPartitions: Int): Unit = {
    // TODO: this draft flips the completion flag when the source file is read, before any partition
    // commits, and gives the key no TTL. Review the whole path.
    jedis.set(s"load:$manifestId:complete", "1")
  }

  def commitPartition(manifestId: String, partitionId: String, totalPartitions: Int): Unit = {
    // TODO: the draft logs progress instead of recording it in a Redis set, so a re-run cannot
    // dedupe and the completion check has nothing to count.
    println(s"committed $manifestId/$partitionId")
  }

  def isComplete(manifestId: String, totalPartitions: Int): Boolean = {
    // TODO: readers trust the flag alone; they never check the partition count.
    Option(jedis.get(s"load:$manifestId:complete")).isDefined
  }
}
`,
      solution: `import scala.jdk.CollectionConverters._

import redis.clients.jedis.Jedis

object LoadState {
  val LoadTtlS = 86400L
  val jedis = new Jedis("redis", 6379)

  // One script: the count of committed partitions and the completion flag cannot be split by a crash.
  val CommitLua =
    """
      |local committed = redis.call('SCARD', KEYS[1])
      |redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
      |if committed >= tonumber(ARGV[1]) then
      |  redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[2]))
      |  return 1
      |end
      |return 0
      |""".stripMargin

  /** Records one committed partition and reports whether the manifest is now complete. */
  def commitPartition(manifestId: String, partitionId: String, totalPartitions: Int): Boolean = {
    val parts = s"load:$manifestId:partitions"
    val complete = s"load:$manifestId:complete"
    jedis.sadd(parts, partitionId) // dedupe: a re-run of the same partition adds no member
    val done = jedis
      .eval(CommitLua, List(parts, complete).asJava, List(totalPartitions.toString, LoadTtlS.toString).asJava)
      .asInstanceOf[Long]
    done == 1L
  }

  /** Reads the flag *and* the committed count: a partial load is never reported as done. */
  def isComplete(manifestId: String, totalPartitions: Int): Boolean = {
    val parts = s"load:$manifestId:partitions"
    val complete = s"load:$manifestId:complete"
    Option(jedis.get(complete)) match {
      case None => false
      case Some(flag) if flag != "1" => false
      case Some(_) => jedis.scard(parts) >= totalPartitions
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <iostream>
#include <string>

using sw::redis::Redis;

Redis redis("tcp://redis:6379");

void beginLoad(const std::string& manifestId, int totalPartitions) {
  // TODO: this draft flips the completion flag when the source file is read, before any partition
  // commits, and gives the key no TTL. Review the whole path.
  redis.set("load:" + manifestId + ":complete", "1");
}

void commitPartition(const std::string& manifestId, const std::string& partitionId, int totalPartitions) {
  // TODO: the draft logs progress instead of recording it in a Redis set, so a re-run cannot dedupe
  // and the completion check has nothing to count.
  std::cout << "committed " << manifestId << "/" << partitionId << "\\n";
}

bool isComplete(const std::string& manifestId, int totalPartitions) {
  // TODO: readers trust the flag alone; they never check the partition count.
  return redis.get("load:" + manifestId + ":complete").has_value();
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <iostream>
#include <string>
#include <vector>

using sw::redis::Redis;

constexpr int kLoadTtlS = 86400;

Redis redis("tcp://redis:6379");

// One script: the count of committed partitions and the completion flag cannot be split by a crash.
const std::string kCommitLua = R"lua(
local committed = redis.call('SCARD', KEYS[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
if committed >= tonumber(ARGV[1]) then
  redis.call('SET', KEYS[2], '1', 'EX', tonumber(ARGV[2]))
  return 1
end
return 0
)lua";

// Records one committed partition and reports whether the manifest is now complete.
bool commitPartition(const std::string& manifestId, const std::string& partitionId, int totalPartitions) {
  const std::string parts = "load:" + manifestId + ":partitions";
  const std::string complete = "load:" + manifestId + ":complete";
  redis.sadd(parts, partitionId);  // dedupe: a re-run of the same partition adds no member
  const long done = redis.eval<long>(
      kCommitLua, {parts, complete}, {std::to_string(totalPartitions), std::to_string(kLoadTtlS)});
  if (done == 1) {
    std::cout << "manifest " << manifestId << " complete: " << totalPartitions << " partitions\\n";
  }
  return done == 1;
}

// Reads the flag *and* the committed count: a partial load is never reported as done.
bool isComplete(const std::string& manifestId, int totalPartitions) {
  const std::string parts = "load:" + manifestId + ":partitions";
  const std::string complete = "load:" + manifestId + ":complete";
  const auto flag = redis.get(complete);
  if (!flag || *flag != "1") return false;
  return static_cast<int>(redis.scard(parts)) >= totalPartitions;
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can keep a progress record honest across crashes. The
draft is convincing because the demo never crashes; the defect is the *order* of writes. A load is
complete exactly when the set of committed partitions has reached the manifest's partition count, and
everything else in the step exists to hold that sentence: \`SADD\` makes the record a set so a re-run or
a retried worker cannot inflate it, one Lua script counts and flips the flag so no crash can separate
them, the reader re-checks the count so a stale flag can never be read as done, and the TTL makes the
flag expire with the load instead of being inherited by the next run of the same manifest id. Real
loaders add per-partition attempt counts, a heartbeat for stuck workers, and a compaction that folds
old manifests into a summary so Redis does not hold every load forever.`,
};
