import type {Step} from '@/lib/types';

export const uploadStateStep: Step = {
  id: 'state',
  title: 'A Redis commit that holds only for a complete chunk set',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the commit the upload path calls after the last chunk:
\`commit(upload_id)\` reads the upload (\`store.upload\`) and the digest of its chunk set
(\`store.manifest\`, None while a chunk is missing), writes the record \`checkpoint:{upload_id}\`
(\`upload_id, run_id, step, chunks, digest\`) and points \`run:{run_id}:latest\` at it;
\`latest_committed(run_id)\` follows that pointer. It commits the demo upload and hides three flaws.

**Failure mode the checks target.** The upload's chunks expire between the completeness check and
the write, and the record points at nothing. A committed checkpoint expires a day later along with
the abandoned uploads. A slow upload of an older step finishes last, and a resumed run goes back in
time.

- One Lua script (\`COMMIT_LUA\`, run with \`EVAL\`) checks that \`upload:{id}:chunks\` and
  \`upload:{id}:digests\` both hold \`chunks\` entries, and only then writes the record.
- The same script **\`PERSIST\`s** \`upload:{id}\` and its chunks and digests: staged uploads expire
  after \`store.UPLOAD_TTL\`, committed ones stay.
- It indexes the record in **\`run:{run_id}:checkpoints\`** with \`ZADD\` (score = step);
  \`latest_committed\` reads the highest score with \`ZREVRANGE … 0 0\`.`,
  sequence: {
    participants: ['Checkpoint API', 'Redis'],
    messages: [
      {
        from: 'Checkpoint API',
        to: 'Redis',
        label: 'HGETALL upload:u-1 · HMGET upload:u-1:digests → manifest',
        kind: 'sync',
      },
      {from: 'Checkpoint API', to: 'Redis', label: 'EVAL COMMIT_LUA (5 keys) u-1 manifest', kind: 'sync'},
      {
        from: 'Redis',
        to: 'Redis',
        label: 'HLEN = chunks? PERSIST · HSET checkpoint:u-1 · ZADD run:r1:checkpoints',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Checkpoint API', label: '1 committed · 0 incomplete', kind: 'reply'},
      {from: 'Checkpoint API', to: 'Redis', label: 'ZREVRANGE run:r1:checkpoints 0 0 → latest', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'commit',
      title: 'Commits a complete upload and refuses an incomplete one',
      detail:
        '`commit` answers the record (`upload_id`, `run_id`, `step`, `chunks`, the manifest `digest`) for a complete upload and None for one with a chunk missing, which leaves no record behind.',
      match: {
        python: {all: [/def commit\(\s*upload_id/, /store\.manifest\(/]},
        typescript: {all: [/function commit\(\s*uploadId/, /manifest\(/]},
        go: {all: [/func commit\(\s*ctx context\.Context,\s*uploadID/, /store\.Manifest\(/]},
        scala: {all: [/def commit\(\s*uploadId/, /Store\.manifest\(/]},
        cpp: {all: [/commit\(\s*const std::string& upload_id\)/, /store::manifest\(/]},
      },
    },
    {
      id: 'commit-atomic',
      title: 'Checks completeness and writes the record in one script',
      detail:
        'The chunk counts are checked (`HLEN`) and the record written inside one `EVAL`, so chunks that expire between the check and the write leave no record. The starter writes `checkpoint:{id}` from the client after reading the manifest.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /HLEN/], none: [/r\.hset\(\s*f["']checkpoint:/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /HLEN/], none: [/redis\.hset\(\s*`checkpoint:/]},
        go: {all: [/redis\.NewScript\(/, /HLEN/], none: [/rdb\.HSet\(\s*ctx,\s*"checkpoint:/]},
        scala: {all: [/jedis\.eval\(/, /HLEN/], none: [/jedis\.hset\(\s*s"checkpoint:/]},
        cpp: {all: [/\.eval<long long>\(/, /HLEN/], none: [/redis\.hset\(\s*"checkpoint:/]},
      },
    },
    {
      id: 'commit-persist',
      title: 'A committed checkpoint outlives the upload TTL',
      detail:
        'The commit script `PERSIST`s the upload and its chunks and digests, so a day later the committed weights are still there while abandoned uploads have expired. The starter leaves the TTL in place.',
      match: {
        python: {all: [/PERSIST/]},
        typescript: {all: [/PERSIST/]},
        go: {all: [/PERSIST/]},
        scala: {all: [/PERSIST/]},
        cpp: {all: [/PERSIST/]},
      },
    },
    {
      id: 'latest-by-step',
      title: 'The latest checkpoint is the highest step, not the last commit',
      detail:
        'Records are indexed in `run:{run_id}:checkpoints` by step (`ZADD`) and `latest_committed` reads the top score. The starter overwrites `run:{run_id}:latest` on every commit, so a slow older step wins.',
      match: {
        python: {all: [/ZADD/, /zrevrange\(/], none: [/:latest/]},
        typescript: {all: [/ZADD/, /zrevrange\(/], none: [/:latest/]},
        go: {all: [/ZADD/, /ZRevRange\(/], none: [/:latest/]},
        scala: {all: [/ZADD/, /zrevrange\(/], none: [/:latest/]},
        cpp: {all: [/ZADD/, /zrevrange\(/], none: [/:latest/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from checkpoint import store  # upload, manifest, record

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def commit(upload_id: str) -> dict | None:
    """Commit a complete upload: its checkpoint record, or None for an unknown or incomplete upload."""
    # TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
    upload = store.upload(upload_id)
    if upload is None:
        return None
    digest = store.manifest(upload_id)
    if digest is None:
        return None  # a chunk is still missing
    r.hset(
        f"checkpoint:{upload_id}",
        mapping={"upload_id": upload_id, "run_id": upload["run_id"], "step": upload["step"], "chunks": upload["chunks"], "digest": digest},
    )
    r.set(f"run:{upload['run_id']}:latest", upload_id)
    return store.record(upload_id)


def latest_committed(run_id: str) -> dict | None:
    """The run's latest committed checkpoint, or None."""
    upload_id = r.get(f"run:{run_id}:latest")
    return None if upload_id is None else store.record(upload_id)
`,
      solution: `import redis

from checkpoint import store  # upload, manifest, record

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS: upload:{id}, upload:{id}:chunks, upload:{id}:digests, checkpoint:{id}, run:{run_id}:checkpoints
# ARGV: upload_id, manifest digest
COMMIT_LUA = """
local meta = redis.call('HMGET', KEYS[1], 'run_id', 'step', 'chunks')
if not meta[1] then return 0 end
local chunks = tonumber(meta[3])
if redis.call('HLEN', KEYS[2]) ~= chunks or redis.call('HLEN', KEYS[3]) ~= chunks then return 0 end
redis.call('PERSIST', KEYS[1])
redis.call('PERSIST', KEYS[2])
redis.call('PERSIST', KEYS[3])
redis.call('HSET', KEYS[4], 'upload_id', ARGV[1], 'run_id', meta[1], 'step', meta[2], 'chunks', meta[3], 'digest', ARGV[2])
redis.call('ZADD', KEYS[5], meta[2], ARGV[1])
return 1
"""
commit_script = r.register_script(COMMIT_LUA)


def commit(upload_id: str) -> dict | None:
    """Commit a complete upload: its checkpoint record, or None for an unknown or incomplete upload."""
    upload = store.upload(upload_id)
    if upload is None:
        return None
    digest = store.manifest(upload_id)
    if digest is None:
        return None  # a chunk is still missing
    keys = [
        f"upload:{upload_id}",
        f"upload:{upload_id}:chunks",
        f"upload:{upload_id}:digests",
        f"checkpoint:{upload_id}",
        f"run:{upload['run_id']}:checkpoints",
    ]
    # The completeness check, the PERSIST and the record are one step: nothing expires in between.
    if commit_script(keys=keys, args=[upload_id, digest]) != 1:
        return None
    return store.record(upload_id)


def latest_committed(run_id: str) -> dict | None:
    """The run's latest committed checkpoint, or None."""
    top = r.zrevrange(f"run:{run_id}:checkpoints", 0, 0)  # the highest step, whatever committed last
    return store.record(top[0]) if top else None
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {type CheckpointRecord, manifest, record, upload} from 'checkpoint/store';

const redis = new Redis({host: 'redis', port: 6379});

/** Commit a complete upload: its checkpoint record, or null for an unknown or incomplete upload. */
export async function commit(uploadId: string): Promise<CheckpointRecord | null> {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const current = await upload(uploadId);
  if (current === null) return null;
  const digest = await manifest(uploadId);
  if (digest === null) return null; // a chunk is still missing
  await redis.hset(\`checkpoint:\${uploadId}\`, {
    upload_id: uploadId,
    run_id: current.run_id,
    step: String(current.step),
    chunks: String(current.chunks),
    digest,
  });
  await redis.set(\`run:\${current.run_id}:latest\`, uploadId);
  return record(uploadId);
}

/** The run's latest committed checkpoint, or null. */
export async function latestCommitted(runId: string): Promise<CheckpointRecord | null> {
  const uploadId = await redis.get(\`run:\${runId}:latest\`);
  return uploadId === null ? null : record(uploadId);
}
`,
      solution: `import Redis from 'ioredis';

import {type CheckpointRecord, manifest, record, upload} from 'checkpoint/store';

// KEYS: upload:{id}, upload:{id}:chunks, upload:{id}:digests, checkpoint:{id}, run:{run_id}:checkpoints
// ARGV: upload_id, manifest digest
export const COMMIT_LUA = \`
local meta = redis.call('HMGET', KEYS[1], 'run_id', 'step', 'chunks')
if not meta[1] then return 0 end
local chunks = tonumber(meta[3])
if redis.call('HLEN', KEYS[2]) ~= chunks or redis.call('HLEN', KEYS[3]) ~= chunks then return 0 end
redis.call('PERSIST', KEYS[1])
redis.call('PERSIST', KEYS[2])
redis.call('PERSIST', KEYS[3])
redis.call('HSET', KEYS[4], 'upload_id', ARGV[1], 'run_id', meta[1], 'step', meta[2], 'chunks', meta[3], 'digest', ARGV[2])
redis.call('ZADD', KEYS[5], meta[2], ARGV[1])
return 1
\`;

interface CommitRedis extends Redis {
  commitUpload(k1: string, k2: string, k3: string, k4: string, k5: string, uploadId: string, digest: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as CommitRedis;
redis.defineCommand('commitUpload', {numberOfKeys: 5, lua: COMMIT_LUA});

/** Commit a complete upload: its checkpoint record, or null for an unknown or incomplete upload. */
export async function commit(uploadId: string): Promise<CheckpointRecord | null> {
  const current = await upload(uploadId);
  if (current === null) return null;
  const digest = await manifest(uploadId);
  if (digest === null) return null; // a chunk is still missing
  // The completeness check, the PERSIST and the record are one step: nothing expires in between.
  const committed = await redis.commitUpload(
    \`upload:\${uploadId}\`,
    \`upload:\${uploadId}:chunks\`,
    \`upload:\${uploadId}:digests\`,
    \`checkpoint:\${uploadId}\`,
    \`run:\${current.run_id}:checkpoints\`,
    uploadId,
    digest,
  );
  return committed === 1 ? record(uploadId) : null;
}

/** The run's latest committed checkpoint, or null. */
export async function latestCommitted(runId: string): Promise<CheckpointRecord | null> {
  const top = await redis.zrevrange(\`run:\${runId}:checkpoints\`, 0, 0); // the highest step, whatever committed last
  return top.length === 0 ? null : record(top[0]);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"checkpoint/store" // store.GetUpload, Manifest, GetRecord, Record
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// commit commits a complete upload: its checkpoint record, or nil for an unknown or incomplete upload.
func commit(ctx context.Context, uploadID string) (*store.Record, error) {
	// TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
	upload := store.GetUpload(ctx, uploadID)
	if upload == nil {
		return nil, nil
	}
	digest := store.Manifest(ctx, uploadID)
	if digest == "" {
		return nil, nil // a chunk is still missing
	}
	fields := map[string]any{"upload_id": uploadID, "run_id": upload.RunID, "step": upload.Step, "chunks": upload.Chunks, "digest": digest}
	if err := rdb.HSet(ctx, "checkpoint:"+uploadID, fields).Err(); err != nil {
		return nil, err
	}
	if err := rdb.Set(ctx, "run:"+upload.RunID+":latest", uploadID, 0).Err(); err != nil {
		return nil, err
	}
	return store.GetRecord(ctx, uploadID), nil
}

// latestCommitted is the run's latest committed checkpoint, or nil.
func latestCommitted(ctx context.Context, runID string) *store.Record {
	uploadID, err := rdb.Get(ctx, "run:"+runID+":latest").Result()
	if err != nil {
		return nil
	}
	return store.GetRecord(ctx, uploadID)
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"checkpoint/store" // store.GetUpload, Manifest, GetRecord, Record
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// commitScript: KEYS upload:{id}, upload:{id}:chunks, upload:{id}:digests, checkpoint:{id},
// run:{run_id}:checkpoints; ARGV upload_id, manifest digest.
var commitScript = redis.NewScript(\`
local meta = redis.call('HMGET', KEYS[1], 'run_id', 'step', 'chunks')
if not meta[1] then return 0 end
local chunks = tonumber(meta[3])
if redis.call('HLEN', KEYS[2]) ~= chunks or redis.call('HLEN', KEYS[3]) ~= chunks then return 0 end
redis.call('PERSIST', KEYS[1])
redis.call('PERSIST', KEYS[2])
redis.call('PERSIST', KEYS[3])
redis.call('HSET', KEYS[4], 'upload_id', ARGV[1], 'run_id', meta[1], 'step', meta[2], 'chunks', meta[3], 'digest', ARGV[2])
redis.call('ZADD', KEYS[5], meta[2], ARGV[1])
return 1
\`)

// commit commits a complete upload: its checkpoint record, or nil for an unknown or incomplete upload.
func commit(ctx context.Context, uploadID string) (*store.Record, error) {
	upload := store.GetUpload(ctx, uploadID)
	if upload == nil {
		return nil, nil
	}
	digest := store.Manifest(ctx, uploadID)
	if digest == "" {
		return nil, nil // a chunk is still missing
	}
	keys := []string{"upload:" + uploadID, "upload:" + uploadID + ":chunks", "upload:" + uploadID + ":digests", "checkpoint:" + uploadID, "run:" + upload.RunID + ":checkpoints"}
	// The completeness check, the PERSIST and the record are one step: nothing expires in between.
	committed, err := commitScript.Run(ctx, rdb, keys, uploadID, digest).Int64()
	if err != nil {
		return nil, err
	}
	if committed != 1 {
		return nil, nil
	}
	return store.GetRecord(ctx, uploadID), nil
}

// latestCommitted is the run's latest committed checkpoint, or nil.
func latestCommitted(ctx context.Context, runID string) *store.Record {
	top := rdb.ZRevRange(ctx, "run:"+runID+":checkpoints", 0, 0).Val() // the highest step, whatever committed last
	if len(top) == 0 {
		return nil
	}
	return store.GetRecord(ctx, top[0])
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import checkpoint.Store // Store.upload, manifest, record, Record

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** Commit a complete upload: its checkpoint record, or None for an unknown or incomplete upload. */
  def commit(uploadId: String): Option[Store.Record] = {
    // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
    for {
      upload <- Store.upload(uploadId)
      digest <- Store.manifest(uploadId) // None: a chunk is still missing
      record <- {
        val fields = Map("upload_id" -> uploadId, "run_id" -> upload.runId, "step" -> upload.step.toString, "chunks" -> upload.chunks.toString, "digest" -> digest)
        jedis.hset(s"checkpoint:$uploadId", fields.asJava)
        jedis.set(s"run:\${upload.runId}:latest", uploadId)
        Store.record(uploadId)
      }
    } yield record
  }

  /** The run's latest committed checkpoint, or None. */
  def latestCommitted(runId: String): Option[Store.Record] = Option(jedis.get(s"run:$runId:latest")).flatMap(Store.record)
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import checkpoint.Store // Store.upload, manifest, record, Record

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** KEYS upload:{id}, upload:{id}:chunks, upload:{id}:digests, checkpoint:{id}, run:{run_id}:checkpoints; ARGV upload_id, digest. */
  val CommitLua: String =
    """local meta = redis.call('HMGET', KEYS[1], 'run_id', 'step', 'chunks')
      |if not meta[1] then return 0 end
      |local chunks = tonumber(meta[3])
      |if redis.call('HLEN', KEYS[2]) ~= chunks or redis.call('HLEN', KEYS[3]) ~= chunks then return 0 end
      |redis.call('PERSIST', KEYS[1])
      |redis.call('PERSIST', KEYS[2])
      |redis.call('PERSIST', KEYS[3])
      |redis.call('HSET', KEYS[4], 'upload_id', ARGV[1], 'run_id', meta[1], 'step', meta[2], 'chunks', meta[3], 'digest', ARGV[2])
      |redis.call('ZADD', KEYS[5], meta[2], ARGV[1])
      |return 1
      |""".stripMargin

  /** Commit a complete upload: its checkpoint record, or None for an unknown or incomplete upload. */
  def commit(uploadId: String): Option[Store.Record] =
    for {
      upload <- Store.upload(uploadId)
      digest <- Store.manifest(uploadId) // None: a chunk is still missing
      keys = List(s"upload:$uploadId", s"upload:$uploadId:chunks", s"upload:$uploadId:digests", s"checkpoint:$uploadId", s"run:\${upload.runId}:checkpoints")
      // The completeness check, the PERSIST and the record are one step: nothing expires in between.
      if jedis.eval(CommitLua, keys.asJava, List(uploadId, digest).asJava).asInstanceOf[java.lang.Long] == 1L
      record <- Store.record(uploadId)
    } yield record

  /** The run's latest committed checkpoint, or None: the highest step, whatever committed last. */
  def latestCommitted(runId: String): Option[Store.Record] =
    jedis.zrevrange(s"run:$runId:checkpoints", 0, 0).asScala.headOption.flatMap(Store.record)
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>

#include "checkpoint/store.h"  // store::upload, manifest, record, Record

sw::redis::Redis redis("tcp://redis:6379");

// Commit a complete upload: its checkpoint record, or none for an unknown or incomplete upload.
std::optional<store::Record> commit(const std::string& upload_id) {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const auto upload = store::upload(upload_id);
  if (!upload) return std::nullopt;
  const std::string digest = store::manifest(upload_id);
  if (digest.empty()) return std::nullopt;  // a chunk is still missing
  redis.hset("checkpoint:" + upload_id, {{"upload_id", upload_id},
                                         {"run_id", upload->run_id},
                                         {"step", std::to_string(upload->step)},
                                         {"chunks", std::to_string(upload->chunks)},
                                         {"digest", digest}});
  redis.set("run:" + upload->run_id + ":latest", upload_id);
  return store::record(upload_id);
}

// The run's latest committed checkpoint, or none.
std::optional<store::Record> latestCommitted(const std::string& run_id) {
  const auto upload_id = redis.get("run:" + run_id + ":latest");
  if (!upload_id) return std::nullopt;
  return store::record(*upload_id);
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <optional>
#include <string>
#include <vector>

#include "checkpoint/store.h"  // store::upload, manifest, record, Record

sw::redis::Redis redis("tcp://redis:6379");

// KEYS upload:{id}, upload:{id}:chunks, upload:{id}:digests, checkpoint:{id}, run:{run_id}:checkpoints;
// ARGV upload_id, manifest digest.
const std::string kCommitLua = R"lua(
local meta = redis.call('HMGET', KEYS[1], 'run_id', 'step', 'chunks')
if not meta[1] then return 0 end
local chunks = tonumber(meta[3])
if redis.call('HLEN', KEYS[2]) ~= chunks or redis.call('HLEN', KEYS[3]) ~= chunks then return 0 end
redis.call('PERSIST', KEYS[1])
redis.call('PERSIST', KEYS[2])
redis.call('PERSIST', KEYS[3])
redis.call('HSET', KEYS[4], 'upload_id', ARGV[1], 'run_id', meta[1], 'step', meta[2], 'chunks', meta[3], 'digest', ARGV[2])
redis.call('ZADD', KEYS[5], meta[2], ARGV[1])
return 1
)lua";

// Commit a complete upload: its checkpoint record, or none for an unknown or incomplete upload.
std::optional<store::Record> commit(const std::string& upload_id) {
  const auto upload = store::upload(upload_id);
  if (!upload) return std::nullopt;
  const std::string digest = store::manifest(upload_id);
  if (digest.empty()) return std::nullopt;  // a chunk is still missing
  const std::vector<std::string> keys = {"upload:" + upload_id, "upload:" + upload_id + ":chunks", "upload:" + upload_id + ":digests",
                                         "checkpoint:" + upload_id, "run:" + upload->run_id + ":checkpoints"};
  const std::vector<std::string> args = {upload_id, digest};
  // The completeness check, the PERSIST and the record are one step: nothing expires in between.
  if (redis.eval<long long>(kCommitLua, keys.begin(), keys.end(), args.begin(), args.end()) != 1) return std::nullopt;
  return store::record(upload_id);
}

// The run's latest committed checkpoint, or none: the highest step, whatever committed last.
std::optional<store::Record> latestCommitted(const std::string& run_id) {
  std::vector<std::string> top;
  redis.zrevrange("run:" + run_id + ":checkpoints", 0, 0, std::back_inserter(top));
  if (top.empty()) return std::nullopt;
  return store::record(top[0]);
}
`,
    },
  },
  harness: {
    python: `from checkpoint import store


def _upload(step=1200, staged=3, run="r1"):
    """An upload of run's checkpoint at step in 3 chunks, the first staged of them staged."""
    store.create_run(run, "t1")
    upload_id = store.open_upload(run, "t1", step, 3)["upload_id"]
    for i in range(staged):
        payload = f"step {step} layer {i}".encode()
        store.put_chunk(upload_id, i, payload, store.digest(payload))
    return upload_id


def check_commit(ctx):
    m = ctx.load("state")
    partial = _upload(staged=2)
    assert m.commit(partial) is None, "an upload with chunk 2 missing committed"
    assert ctx.redis.exists(f"checkpoint:{partial}") == 0, "an incomplete upload left a checkpoint record"
    assert m.commit("u-404") is None, "an unknown upload committed"
    full = _upload(step=1300)
    record = m.commit(full)
    assert record is not None, "a complete upload did not commit"
    expected = {"upload_id": full, "run_id": "r1", "step": 1300, "chunks": 3, "digest": store.manifest(full)}
    assert record == expected, f"commit answered {record}, expected {expected}"
    assert store.record(full) == expected, f"checkpoint:{full} holds {store.record(full)}, expected {expected}"
    assert m.latest_committed("r1") == expected, f"latest_committed('r1') answered {m.latest_committed('r1')}"


def check_commit_atomic(ctx):
    m = ctx.load("state")
    upload_id = _upload()
    marker = f"checkpoint:{upload_id}"

    def expiry():
        # The upload's TTL runs out right after commit first reads its digests: Redis drops the
        # staged chunks, unless a commit already persisted them.
        if ctx.redis.exists(marker):
            return "committed"
        ctx.redis.delete(f"upload:{upload_id}:chunks", f"upload:{upload_id}:digests")
        return "expired"

    probe = ctx.redis_after(f"upload:{upload_id}:digests", expiry)
    record = m.commit(upload_id)
    assert probe.fired, f"commit never read upload:{upload_id}:digests"
    staged = ctx.redis.hlen(f"upload:{upload_id}:chunks")
    if ctx.redis.exists(marker):
        assert staged == 3, f"commit wrote {marker} although the upload's chunks expired between its completeness check and its write ({staged} of 3 staged): the check and the write must be one Lua script"
    assert (record is None) == (ctx.redis.exists(marker) == 0), f"commit answered {record} but {marker} {'exists' if ctx.redis.exists(marker) else 'does not exist'}"


def check_commit_persist(ctx):
    m = ctx.load("state")
    upload_id = _upload()
    abandoned = _upload(step=900, staged=1)
    record = m.commit(upload_id)
    assert record is not None, "a complete upload did not commit"
    ctx.clock.advance(store.UPLOAD_TTL + 1)
    assert store.stored_count(abandoned) == 0, "an abandoned upload must still expire after store.UPLOAD_TTL"
    staged = store.stored_count(upload_id)
    assert staged == 3, f"a day after the commit the checkpoint stages {staged} of its 3 chunks: the commit left the upload's TTL in place, so the committed weights expired with the abandoned uploads. PERSIST them in the commit script"
    assert store.upload(upload_id) is not None, f"upload:{upload_id} expired after it was committed"
    assert m.latest_committed("r1") == record, f"a day later latest_committed('r1') answers {m.latest_committed('r1')}, expected {record}"


def check_latest_by_step(ctx):
    m = ctx.load("state")
    newer = _upload(step=1200)
    older = _upload(step=1000)  # a slow upload of an earlier step finishes last
    assert m.commit(newer) is not None and m.commit(older) is not None, "both complete uploads must commit"
    latest = m.latest_committed("r1")
    assert latest is not None and latest["step"] == 1200, f"latest_committed('r1') answers step {latest and latest['step']} after steps 1200 and 1000 committed in that order: the latest checkpoint is the highest step, not the last commit"
    assert m.latest_committed("r9") is None, "a run without a commit must have no latest checkpoint"
`,
    typescript: `function setup(ctx) {
  const store = ctx.load('/support/checkpoint/store.ts');
  const m = ctx.load('state');
  /** An upload of run's checkpoint at step in 3 chunks, the first staged of them staged. */
  const upload = async (step = 1200, staged = 3, run = 'r1'): Promise<string> => {
    await store.createRun(run, 't1');
    const {upload_id} = await store.openUpload(run, 't1', step, 3);
    for (let i = 0; i < staged; i++) {
      const payload = Buffer.from(\`step \${step} layer \${i}\`);
      await store.putChunk(upload_id, i, payload, store.digest(payload));
    }
    return upload_id;
  };
  return {store, m, upload};
}

export async function check_commit(ctx) {
  const {store, m, upload} = setup(ctx);
  const partial = await upload(1200, 2);
  assert.equal(await m.commit(partial), null, 'an upload with chunk 2 missing committed');
  assert.equal(ctx.redis.exists(\`checkpoint:\${partial}\`), 0, 'an incomplete upload left a checkpoint record');
  assert.equal(await m.commit('u-404'), null, 'an unknown upload committed');
  const full = await upload(1300);
  const record = await m.commit(full);
  assert(record !== null, 'a complete upload did not commit');
  const expected = {upload_id: full, run_id: 'r1', step: 1300, chunks: 3, digest: await store.manifest(full)};
  assert.deepEqual(record, expected, \`commit answered \${JSON.stringify(record)}\`);
  assert.deepEqual(await store.record(full), expected, \`checkpoint:\${full} must hold the record\`);
  assert.deepEqual(await m.latestCommitted('r1'), expected, "latestCommitted('r1') must answer the record");
}

export async function check_commit_atomic(ctx) {
  const {m, upload} = setup(ctx);
  const uploadId = await upload();
  const marker = \`checkpoint:\${uploadId}\`;
  // The upload's TTL runs out right after commit first reads its digests: Redis drops the staged
  // chunks, unless a commit already persisted them.
  const probe = ctx.redisAfter(\`upload:\${uploadId}:digests\`, () => {
    if (ctx.redis.exists(marker) === 1) return 'committed';
    ctx.redis.del(\`upload:\${uploadId}:chunks\`, \`upload:\${uploadId}:digests\`);
    return 'expired';
  });
  const record = await m.commit(uploadId);
  assert(probe.fired, \`commit never read upload:\${uploadId}:digests\`);
  const staged = ctx.redis.hlen(\`upload:\${uploadId}:chunks\`);
  const exists = ctx.redis.exists(marker) === 1;
  if (exists) {
    assert.equal(staged, 3, \`commit wrote \${marker} although the upload's chunks expired between its completeness check and its write (\${staged} of 3 staged): the check and the write must be one Lua script\`);
  }
  assert.equal(record === null, !exists, \`commit answered \${JSON.stringify(record)} but \${marker} \${exists ? 'exists' : 'does not exist'}\`);
}

export async function check_commit_persist(ctx) {
  const {store, m, upload} = setup(ctx);
  const uploadId = await upload();
  const abandoned = await upload(900, 1);
  const record = await m.commit(uploadId);
  assert(record !== null, 'a complete upload did not commit');
  ctx.clock.advance(store.UPLOAD_TTL + 1);
  assert.equal(await store.storedCount(abandoned), 0, 'an abandoned upload must still expire after UPLOAD_TTL');
  const staged = await store.storedCount(uploadId);
  assert.equal(staged, 3, \`a day after the commit the checkpoint stages \${staged} of its 3 chunks: the commit left the upload's TTL in place, so the committed weights expired with the abandoned uploads. PERSIST them in the commit script\`);
  assert((await store.upload(uploadId)) !== null, \`upload:\${uploadId} expired after it was committed\`);
  assert.deepEqual(await m.latestCommitted('r1'), record, "a day later latestCommitted('r1') must still answer the record");
}

export async function check_latest_by_step(ctx) {
  const {m, upload} = setup(ctx);
  const newer = await upload(1200);
  const older = await upload(1000); // a slow upload of an earlier step finishes last
  assert((await m.commit(newer)) !== null && (await m.commit(older)) !== null, 'both complete uploads must commit');
  const latest = await m.latestCommitted('r1');
  assert(latest !== null && latest.step === 1200, \`latestCommitted('r1') answers step \${latest?.step} after steps 1200 and 1000 committed in that order: the latest checkpoint is the highest step, not the last commit\`);
  assert.equal(await m.latestCommitted('r9'), null, 'a run without a commit must have no latest checkpoint');
}
`,
    go: `package main

import (
	"context"
	"fmt"

	"checkpoint/store"

	"leetbuild/harness"
)

var bg = context.Background()

// stageUpload opens an upload of run's checkpoint at step in 3 chunks and stages the first staged of them.
func stageUpload(runID string, step int64, staged int) string {
	store.CreateRun(bg, runID, "t1")
	upload := store.OpenUpload(bg, runID, "t1", step, 3)
	for i := 0; i < staged; i++ {
		payload := []byte(fmt.Sprintf("step %d layer %d", step, i))
		store.PutChunk(bg, upload.UploadID, int64(i), payload, store.Digest(payload))
	}
	return upload.UploadID
}

func mustCommit(ctx *harness.Ctx, uploadID string) *store.Record {
	record, err := commit(bg, uploadID)
	ctx.NoError(err, "commit(%s)", uploadID)
	return record
}

func CheckCommit(ctx *harness.Ctx) {
	partial := stageUpload("r1", 1200, 2)
	ctx.Assert(mustCommit(ctx, partial) == nil, "an upload with chunk 2 missing committed")
	ctx.Equal(ctx.Redis.Exists("checkpoint:"+partial), 0, "an incomplete upload must leave no checkpoint record")
	ctx.Assert(mustCommit(ctx, "u-404") == nil, "an unknown upload committed")
	full := stageUpload("r1", 1300, 3)
	record := mustCommit(ctx, full)
	ctx.Assert(record != nil, "a complete upload did not commit")
	expected := store.Record{UploadID: full, RunID: "r1", Step: 1300, Chunks: 3, Digest: store.Manifest(bg, full)}
	ctx.Equal(*record, expected, "commit's record")
	ctx.Equal(*store.GetRecord(bg, full), expected, "checkpoint:%s", full)
	latest := latestCommitted(bg, "r1")
	ctx.Assert(latest != nil && *latest == expected, "latestCommitted(r1) answered %+v, expected %+v", latest, expected)
}

func CheckCommitAtomic(ctx *harness.Ctx) {
	uploadID := stageUpload("r1", 1200, 3)
	marker := "checkpoint:" + uploadID
	// The upload's TTL runs out right after commit first reads its digests: Redis drops the staged
	// chunks, unless a commit already persisted them.
	probe := ctx.Redis.After("upload:"+uploadID+":digests", func() any {
		if ctx.Redis.Exists(marker) == 1 {
			return "committed"
		}
		ctx.Redis.Del("upload:"+uploadID+":chunks", "upload:"+uploadID+":digests")
		return "expired"
	})
	record := mustCommit(ctx, uploadID)
	ctx.Assert(probe.Fired, "commit never read upload:%s:digests", uploadID)
	staged := ctx.Redis.HLen("upload:" + uploadID + ":chunks")
	exists := ctx.Redis.Exists(marker) == 1
	if exists {
		ctx.Assert(staged == 3, "commit wrote %s although the upload's chunks expired between its completeness check and its write (%d of 3 staged): the check and the write must be one Lua script", marker, staged)
	}
	ctx.Assert((record == nil) == !exists, "commit answered %+v but %s exists: %t", record, marker, exists)
}

func CheckCommitPersist(ctx *harness.Ctx) {
	uploadID := stageUpload("r1", 1200, 3)
	abandoned := stageUpload("r1", 900, 1)
	record := mustCommit(ctx, uploadID)
	ctx.Assert(record != nil, "a complete upload did not commit")
	ctx.Clock.AdvanceBy(store.UploadTTL + 1e9)
	ctx.Equal(store.StoredCount(bg, abandoned), 0, "an abandoned upload must still expire after UploadTTL; its staged chunks")
	staged := store.StoredCount(bg, uploadID)
	ctx.Equal(staged, 3, "a day after the commit the commit must have persisted the upload (PERSIST in the commit script), or the committed weights expire with the abandoned uploads; the staged chunks")
	ctx.Assert(store.GetUpload(bg, uploadID) != nil, "upload:%s expired after it was committed", uploadID)
	latest := latestCommitted(bg, "r1")
	ctx.Assert(latest != nil && *latest == *record, "a day later latestCommitted(r1) answers %+v, expected %+v", latest, record)
}

func CheckLatestByStep(ctx *harness.Ctx) {
	newer := stageUpload("r1", 1200, 3)
	older := stageUpload("r1", 1000, 3) // a slow upload of an earlier step finishes last
	ctx.Assert(mustCommit(ctx, newer) != nil && mustCommit(ctx, older) != nil, "both complete uploads must commit")
	latest := latestCommitted(bg, "r1")
	ctx.Assert(latest != nil && latest.Step == 1200, "latestCommitted(r1) answers %+v after steps 1200 and 1000 committed in that order: the latest checkpoint is the highest step, not the last commit", latest)
	ctx.Assert(latestCommitted(bg, "r9") == nil, "a run without a commit must have no latest checkpoint")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <optional>
#include <string>

#include "checkpoint/store.h"

namespace {

// An upload of run's checkpoint at step in 3 chunks, the first staged of them staged.
std::string stageUpload(const std::string& run_id, long step, int staged) {
  store::createRun(run_id, "t1");
  const store::Upload upload = store::openUpload(run_id, "t1", step, 3);
  for (int i = 0; i < staged; i++) {
    const std::string payload = "step " + std::to_string(step) + " layer " + std::to_string(i);
    store::putChunk(upload.upload_id, i, payload, store::digest(payload));
  }
  return upload.upload_id;
}

bool same(const std::optional<store::Record>& a, const std::optional<store::Record>& b) {
  if (!a || !b) return !a && !b;
  return a->upload_id == b->upload_id && a->run_id == b->run_id && a->step == b->step && a->chunks == b->chunks && a->digest == b->digest;
}

std::string show(const std::optional<store::Record>& r) {
  if (!r) return "none";
  return r->upload_id + " run " + r->run_id + " step " + std::to_string(r->step) + " chunks " + std::to_string(r->chunks) + " digest " + r->digest;
}

}  // namespace

void CheckCommit(harness::Ctx& ctx) {
  const std::string partial = stageUpload("r1", 1200, 2);
  ctx.Assert(!commit(partial), "an upload with chunk 2 missing committed");
  ctx.Equal(ctx.Redis.Exists("checkpoint:" + partial), 0, "an incomplete upload must leave no checkpoint record");
  ctx.Assert(!commit("u-404"), "an unknown upload committed");
  const std::string full = stageUpload("r1", 1300, 3);
  const auto record = commit(full);
  ctx.Assert(record.has_value(), "a complete upload did not commit");
  const std::optional<store::Record> expected = store::Record{full, "r1", 1300, 3, store::manifest(full)};
  ctx.Assert(same(record, expected), "commit answered %s, expected %s", show(record), show(expected));
  ctx.Assert(same(store::record(full), expected), "checkpoint:%s holds %s, expected %s", full, show(store::record(full)), show(expected));
  ctx.Assert(same(latestCommitted("r1"), expected), "latestCommitted(r1) answered %s, expected %s", show(latestCommitted("r1")), show(expected));
}

void CheckCommitAtomic(harness::Ctx& ctx) {
  const std::string upload_id = stageUpload("r1", 1200, 3);
  const std::string marker = "checkpoint:" + upload_id;
  bool fired = false;
  // The upload's TTL runs out right after commit first reads its digests: Redis drops the staged
  // chunks, unless a commit already persisted them.
  ctx.Redis.After("upload:" + upload_id + ":digests", [&] {
    fired = true;
    if (ctx.Redis.Exists(marker) == 1) return;
    ctx.Redis.Del("upload:" + upload_id + ":chunks", "upload:" + upload_id + ":digests");
  });
  const auto record = commit(upload_id);
  ctx.Assert(fired, "commit never read upload:%s:digests", upload_id);
  const long long staged = ctx.Redis.HLen("upload:" + upload_id + ":chunks");
  const bool exists = ctx.Redis.Exists(marker) == 1;
  if (exists) {
    ctx.Assert(staged == 3,
               "commit wrote %s although the upload's chunks expired between its completeness check and its write (%d of 3 staged): the check and the write must be one Lua script",
               marker, staged);
  }
  ctx.Assert(record.has_value() == exists, "commit answered %s but %s exists: %t", show(record), marker, exists);
}

void CheckCommitPersist(harness::Ctx& ctx) {
  const std::string upload_id = stageUpload("r1", 1200, 3);
  const std::string abandoned = stageUpload("r1", 900, 1);
  const auto record = commit(upload_id);
  ctx.Assert(record.has_value(), "a complete upload did not commit");
  ctx.Clock.Advance(store::kUploadTtl + 1);
  ctx.Equal(store::storedCount(abandoned), 0, "an abandoned upload must still expire after kUploadTtl; its staged chunks");
  ctx.Equal(store::storedCount(upload_id), 3,
            "a day after the commit the commit must have persisted the upload (PERSIST in the commit script), or the committed weights expire with the abandoned uploads; the staged chunks");
  ctx.Assert(store::upload(upload_id).has_value(), "upload:%s expired after it was committed", upload_id);
  ctx.Assert(same(latestCommitted("r1"), record), "a day later latestCommitted(r1) answers %s, expected %s", show(latestCommitted("r1")), show(record));
}

void CheckLatestByStep(harness::Ctx& ctx) {
  const std::string newer = stageUpload("r1", 1200, 3);
  const std::string older = stageUpload("r1", 1000, 3);  // a slow upload of an earlier step finishes last
  ctx.Assert(commit(newer).has_value() && commit(older).has_value(), "both complete uploads must commit");
  const auto latest = latestCommitted("r1");
  ctx.Assert(latest && latest->step == 1200,
             "latestCommitted(r1) answers %s after steps 1200 and 1000 committed in that order: the latest checkpoint is the highest step, not the last commit",
             show(latest));
  ctx.Assert(!latestCommitted("r9"), "a run without a commit must have no latest checkpoint");
}
`,
  },
  hints: [
    'Commit step 1200, then let a slow upload of step 1000 commit: the latest checkpoint goes back to 1000. Advance the clock a day after a commit: the committed chunks are gone.',
    'The completeness check and the record are separate commands, so chunks can expire between them; nothing removes the TTL `put_chunk` set; and a plain pointer records which commit ran last, not which step is newest.',
    'Move the check into `COMMIT_LUA`: `HLEN` of chunks and digests equals `chunks`, then `PERSIST` the three upload keys, `HSET checkpoint:{id}`, `ZADD run:{run_id}:checkpoints step id`. Read `ZREVRANGE … 0 0`.',
  ],
  debrief: `The record is a promise that a set of chunks exists, so it must be written in the same step that sees them, and it must change their lifetime from "staged" to "kept". One script does both: it checks the counts, removes the TTL from the upload's keys and writes the record, which is why no expiry can fall between them. Ordering the index by step rather than by commit time makes "latest" a fact about training progress, not about which uploader was slowest. Orbax, the JAX checkpoint library, gets the same guarantee on object stores without atomic rename by writing a commit_success file only after the checkpoint is complete; production stores also delete superseded checkpoints and keep a retention count per run.`,
};
