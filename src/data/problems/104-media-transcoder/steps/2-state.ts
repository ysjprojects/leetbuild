import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis segment progress with exactly-once segment claims',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'worker'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a worker asks for a segment,
gets it, encodes it and the counter goes up. On a short file with no failures it is right. It hides
three flaws that only appear when a worker crashes or a message is redelivered. Review it, fix it,
and prove the fix with the checks below.

Implement the segment tracker the workers and the API share:

- Work is claimed per \`(job id, segment index)\`, never per job: the claim key is
  \`transcode:claim:{job_id}:{index}\`. One **atomic** claim must decide the winner —
  \`SET\` with \`NX\` and an expiry in one call (Python/TypeScript/Scala/C++), \`SetArgs{Mode: "NX",
  TTL: …}\` (Go) or an equivalent single-round-trip form. A read followed by a write lets two
  workers both see the segment free and both encode it, and the output gets two overlapping
  fragments.
- The claim carries a **lease** (\`LEASE_MS = 90_000\`): a worker that dies mid-segment holds a
  lease that expires, so one other worker retakes that segment. A worker that fails releases its
  lease so the retake is immediate; a worker that succeeds deletes it.
- \`mark_done(job_id, index)\` records completion in \`transcode:done:{job_id}\` and is called
  **only after** \`encode_segment\` returned. The draft marks the segment done before the encode,
  so a crash leaves a hole that the counter still reports as progress.
- A redelivered segment whose index is already done is **skipped** (\`is_done\` checked before the
  claim) rather than encoded a second time.
- The manifest is only trustworthy when it covers **every** expected index:
  \`expected = set(range(segment_count))\`, \`missing = expected - done\`, and \`complete\` is true
  only when \`missing\` is empty. A count of finished segments cannot tell a full file from one with
  a hole in it.

**Failure mode the checks target.** \`GET\`-then-\`SET\` without \`NX\` lets two workers encode one
segment; a claim with no expiry means a crashed worker's segment is never retaken; \`done\` written
before the encode is what turns a crash into a silently missing minute of video; and a manifest
built from a counter reports completeness for a file that is missing a segment.`,
  sequence: {
    participants: ['Transcoder API', 'Worker', 'Redis'],
    messages: [
      {from: 'Transcoder API', to: 'Worker', label: 'EncodeSegment(job, index, source_uri)', kind: 'sync'},
      {from: 'Worker', to: 'Redis', label: 'SET transcode:claim:job:7 · NX · PX LEASE_MS', kind: 'sync'},
      {from: 'Redis', to: 'Worker', label: 'OK (lease held) / nil (another worker owns it)', kind: 'reply'},
      {from: 'Worker', to: 'Worker', label: 'encode the segment', kind: 'sync'},
      {from: 'Worker', to: 'Redis', label: 'HSET transcode:done:job 7 done   ← only after the encode', kind: 'sync'},
      {from: 'Worker', to: 'Redis', label: 'DEL claim (or let the lease expire on a crash)', kind: 'async'},
      {from: 'Redis', to: 'Transcoder API', label: 'HKEYS done · missing = expected − done', kind: 'reply'},
      {from: 'Transcoder API', to: 'Transcoder API', label: 'manifest complete only when gap-free', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'atomic-claim',
      title: 'One atomic claim per (job, segment)',
      detail:
        'The claim is a single `SET` with `NX` and a lease expiry (`SetArgs` with `Mode: "NX"` in Go, `SetParams.nx().px()` in Scala, `UpdateType::NOT_EXIST` in C++). `GET`-then-`SET` lets two workers both win and encode the same segment.',
      match: {
        python: {all: [/\.set\(/, /\bnx=True/, /\bpx=LEASE_MS/]},
        typescript: {all: [/\.set\(/, /'PX'/, /'NX'/, /LEASE_MS/]},
        go: {all: [/SetArgs\(/, /"NX"/, /TTL:\s*leaseTTL/]},
        scala: {all: [/\.set\(/, /\.nx\(\)/, /\.px\(/]},
        cpp: {all: [/\bset\(/, /NOT_EXIST/, /kLeaseMs/]},
      },
    },
    {
      id: 'lease-retake',
      title: 'Leased claims so a crashed segment is retaken',
      detail:
        'The claim expires on its own (`LEASE_MS`) and is released when the encode fails, so a crashed worker’s segment is retaken by exactly one other worker. The draft sets a permanent key, so the segment is stuck forever.',
      match: {
        python: {all: [/LEASE_MS/, /release\(/, /\.delete\(/]},
        typescript: {all: [/LEASE_MS/, /release\(/, /\.del\(/]},
        go: {all: [/leaseTTL/, /Release\(/, /\.Del\(/]},
        scala: {all: [/LeaseMs/, /release\(/, /\.del\(/]},
        cpp: {all: [/kLeaseMs/, /release\(/, /\.del\(/]},
      },
    },
    {
      id: 'done-after-encode',
      title: 'Done is recorded after the encode returns',
      detail:
        '`mark_done` runs after `encode_segment` — the completion marker follows a successful encode. The draft writes it first, so a crashed encode is recorded as finished and the manifest reports a hole-free file.',
      match: {
        python: {order: [/encode_segment\(/, /mark_done\(/], all: [/mark_done\(/]},
        typescript: {order: [/encodeSegment\(/, /markDone\(/], all: [/markDone\(/]},
        go: {order: [/encodeSegment\(/, /markDone\(/], all: [/markDone\(/]},
        scala: {order: [/encodeSegment\(/, /markDone\(/], all: [/markDone\(/]},
        cpp: {order: [/encodeSegment\(/, /markDone\(/], all: [/markDone\(/]},
      },
    },
    {
      id: 'done-skip',
      title: 'A redelivered segment that is done is skipped',
      detail:
        '`is_done` is checked before the claim and the encode, so a redelivered message whose segment already finished is a no-op instead of a second encode. The draft re-encodes every delivery.',
      match: {
        python: {all: [/is_done\(/, /return True/]},
        typescript: {all: [/isDone\(/, /return true/]},
        go: {all: [/IsDone\(/, /return true/]},
        scala: {all: [/isDone\(/, /return true/]},
        cpp: {all: [/isDone\(/, /return true/]},
      },
    },
    {
      id: 'gapless-manifest',
      title: 'Manifest covers every expected index',
      detail:
        'The manifest compares the done set with `expected = range(segment_count)`, reports `missing`, and is `complete` only when nothing is missing. The draft counts finished segments, so a file with a hole still looks complete.',
      match: {
        python: {all: [/range\(segment_count\)/, /missing/, /complete/]},
        typescript: {all: [/const expected = new Set/, /missing/, /complete/]},
        go: {all: [/expected\s*:=/, /missing/, /complete/]},
        scala: {all: [/val expected/, /missing/, /complete/]},
        cpp: {all: [/expected/, /missing/, /complete/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import uuid

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)
logger = logging.getLogger("transcoder")


def claim(job_id: str, index: int) -> bool:
    # TODO: this draft reads the claim key and then writes it with no NX and no expiry, marks a
    # segment done before its encode returns, re-encodes redelivered segments, and builds the
    # manifest from a counter. Review all four.
    key = f"transcode:claim:{index}"
    if r.get(key) is not None:
        return False
    r.set(key, str(uuid.uuid4()))
    return True


def mark_done(job_id: str, index: int) -> None:
    r.hincrby(f"transcode:done:{job_id}", "done", 1)


def run_segment(job_id: str, index: int, encode_segment) -> bool:
    if not claim(job_id, index):
        return True
    mark_done(job_id, index)
    encode_segment(job_id, index)
    return True


def manifest(job_id: str, segment_count: int) -> dict:
    done = int(r.hget(f"transcode:done:{job_id}", "done") or 0)
    return {"complete": done > 0, "done": done}
`,
      solution: `import logging
import uuid

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)
logger = logging.getLogger("transcoder")

LEASE_MS = 90_000


def claim_key(job_id: str, index: int) -> str:
    """One key per segment, so a claim never blocks a different segment of the same job."""
    return f"transcode:claim:{job_id}:{index}"


def done_key(job_id: str) -> str:
    return f"transcode:done:{job_id}"


def claim(job_id: str, index: int) -> str | None:
    """Atomic claim with a lease; None when another worker already holds the segment."""
    lease = str(uuid.uuid4())
    if not r.set(claim_key(job_id, index), lease, nx=True, px=LEASE_MS):
        return None
    return lease


def release(job_id: str, index: int, lease: str) -> None:
    """Drop the claim, but only while we still own it — never another worker's lease."""
    key = claim_key(job_id, index)
    if r.get(key) == lease:
        r.delete(key)


def is_done(job_id: str, index: int) -> bool:
    """A redelivered segment that already finished must not be encoded again."""
    return bool(r.hexists(done_key(job_id), index))


def mark_done(job_id: str, index: int) -> None:
    """Record the segment as encoded; only ever called after the encode returned."""
    r.hset(done_key(job_id), index, "done")


def run_segment(job_id: str, index: int, encode_segment) -> bool:
    if is_done(job_id, index):
        return True
    lease = claim(job_id, index)
    if lease is None:
        return True
    try:
        encode_segment(job_id, index)   # the encode comes first
        mark_done(job_id, index)        # completion follows a successful encode
    except Exception:
        release(job_id, index, lease)   # a failed segment is retaken without waiting for the lease
        raise
    r.delete(claim_key(job_id, index))
    logger.info("segment done job=%s index=%d", job_id, index)
    return True


def manifest(job_id: str, segment_count: int) -> dict:
    """Trustworthy only when it covers every expected index: a count cannot show a hole."""
    expected = set(range(segment_count))
    done = {int(index) for index in r.hkeys(done_key(job_id))}
    missing = sorted(expected - done)
    return {"complete": not missing, "segments": sorted(done), "missing": missing}
`,
    },
    typescript: {
      starter: `/** Segment tracker: a model-generated draft that races and marks work done too early. */
import {randomUUID} from 'node:crypto';

import {Redis} from 'ioredis';

export const r = new Redis({host: 'redis', port: 6379});

export async function claim(jobId: string, index: number): Promise<boolean> {
  // TODO: this draft reads the claim key and then writes it with no NX and no expiry, marks a
  // segment done before its encode returns, re-encodes redelivered segments, and builds the
  // manifest from a counter. Review all four.
  const key = \`transcode:claim:\${index}\`;
  if ((await r.get(key)) !== null) return false;
  await r.set(key, randomUUID());
  return true;
}

export async function markDone(jobId: string, index: number): Promise<void> {
  await r.hincrby(\`transcode:done:\${jobId}\`, 'done', 1);
}

export async function runSegment(
  jobId: string,
  index: number,
  encodeSegment: (jobId: string, index: number) => Promise<void>,
): Promise<boolean> {
  if (!(await claim(jobId, index))) return true;
  await markDone(jobId, index);
  await encodeSegment(jobId, index);
  return true;
}

export async function manifest(jobId: string, segmentCount: number): Promise<{complete: boolean; done: number}> {
  const done = Number((await r.hget(\`transcode:done:\${jobId}\`, 'done')) ?? 0);
  return {complete: done > 0, done};
}
`,
      solution: `/** Segment tracker: one atomic leased claim per (job, segment); done only after the encode. */
import {randomUUID} from 'node:crypto';

import {Redis} from 'ioredis';

export const r = new Redis({host: 'redis', port: 6379});

export const LEASE_MS = 90_000;

const claimKey = (jobId: string, index: number): string => \`transcode:claim:\${jobId}:\${index}\`;
const doneKey = (jobId: string): string => \`transcode:done:\${jobId}\`;

/** Atomic claim with a lease; null when another worker already holds the segment. */
export async function claim(jobId: string, index: number): Promise<string | null> {
  const lease = randomUUID();
  const won = await r.set(claimKey(jobId, index), lease, 'PX', LEASE_MS, 'NX');
  return won === 'OK' ? lease : null;
}

/** Drop the claim, but only while we still own it — never another worker's lease. */
export async function release(jobId: string, index: number, lease: string): Promise<void> {
  if ((await r.get(claimKey(jobId, index))) === lease) await r.del(claimKey(jobId, index));
}

/** A redelivered segment that already finished must not be encoded again. */
export async function isDone(jobId: string, index: number): Promise<boolean> {
  return (await r.hexists(doneKey(jobId), String(index))) === 1;
}

/** Record the segment as encoded; only ever called after the encode returned. */
export async function markDone(jobId: string, index: number): Promise<void> {
  await r.hset(doneKey(jobId), String(index), 'done');
}

export async function runSegment(
  jobId: string,
  index: number,
  encodeSegment: (jobId: string, index: number) => Promise<void>,
): Promise<boolean> {
  if (await isDone(jobId, index)) return true;
  const lease = await claim(jobId, index);
  if (lease === null) return true;
  try {
    await encodeSegment(jobId, index);
    await markDone(jobId, index);
  } catch (error) {
    await release(jobId, index, lease);
    throw error;
  }
  await r.del(claimKey(jobId, index));
  return true;
}

export interface Manifest {
  complete: boolean;
  segments: number[];
  missing: number[];
}

/** Trustworthy only when it covers every expected index: a count cannot show a hole. */
export async function manifest(jobId: string, segmentCount: number): Promise<Manifest> {
  const expected = new Set<number>();
  for (let index = 0; index < segmentCount; index++) expected.add(index);
  const done = (await r.hkeys(doneKey(jobId))).map(Number).sort((a, b) => a - b);
  const missing = [...expected].filter(index => !done.includes(index)).sort((a, b) => a - b);
  return {complete: missing.length === 0, segments: done, missing};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"log"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

type Tracker struct {
	rdb *redis.Client
}

func (t *Tracker) Claim(ctx context.Context, jobID string, index int) (bool, error) {
	// TODO: this draft reads the claim key and then writes it with no NX and no expiry, marks a
	// segment done before its encode returns, re-encodes redelivered segments, and builds the
	// manifest from a counter. Review all four.
	key := fmt.Sprintf("transcode:claim:%d", index)
	if t.rdb.Exists(ctx, key).Val() == 1 {
		return false, nil
	}
	return true, t.rdb.Set(ctx, key, uuid.NewString(), 0).Err()
}

func (t *Tracker) markDone(ctx context.Context, jobID string, index int) error {
	return t.rdb.HIncrBy(ctx, fmt.Sprintf("transcode:done:%s", jobID), "done", 1).Err()
}

func (t *Tracker) RunSegment(ctx context.Context, jobID string, index int, encodeSegment func(context.Context, string, int) error) (bool, error) {
	won, err := t.Claim(ctx, jobID, index)
	if err != nil || !won {
		return true, err
	}
	if err := t.markDone(ctx, jobID, index); err != nil {
		return false, err
	}
	if err := encodeSegment(ctx, jobID, index); err != nil {
		return false, err
	}
	return true, nil
}

func (t *Tracker) Manifest(ctx context.Context, jobID string, segmentCount int) (map[string]any, error) {
	done, err := t.rdb.HGet(ctx, fmt.Sprintf("transcode:done:%s", jobID), "done").Int()
	if err != nil && err != redis.Nil {
		return nil, err
	}
	log.Printf("manifest job=%s done=%d", jobID, done)
	return map[string]any{"complete": done > 0, "done": done}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"log"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const leaseTTL = 90 * time.Second

type Tracker struct {
	rdb *redis.Client
}

/** One key per segment, so a claim never blocks a different segment of the same job. */
func claimKey(jobID string, index int) string {
	return fmt.Sprintf("transcode:claim:%s:%d", jobID, index)
}

func doneKey(jobID string) string {
	return fmt.Sprintf("transcode:done:%s", jobID)
}

/** Atomic claim with a lease; "" when another worker already holds the segment. */
func (t *Tracker) Claim(ctx context.Context, jobID string, index int) (string, error) {
	lease := uuid.NewString()
	won, err := t.rdb.SetArgs(ctx, claimKey(jobID, index), lease, redis.SetArgs{Mode: "NX", TTL: leaseTTL}).Result()
	if err == redis.Nil {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if won == "" {
		return "", nil
	}
	return lease, nil
}

/** Drop the claim, but only while we still own it — never another worker's lease. */
func (t *Tracker) Release(ctx context.Context, jobID string, index int, lease string) error {
	key := claimKey(jobID, index)
	if t.rdb.Get(ctx, key).Val() != lease {
		return nil
	}
	return t.rdb.Del(ctx, key).Err()
}

/** A redelivered segment that already finished must not be encoded again. */
func (t *Tracker) IsDone(ctx context.Context, jobID string, index int) (bool, error) {
	return t.rdb.HExists(ctx, doneKey(jobID), fmt.Sprint(index)).Result()
}

/** Record the segment as encoded; only ever called after the encode returned. */
func (t *Tracker) markDone(ctx context.Context, jobID string, index int) error {
	return t.rdb.HSet(ctx, doneKey(jobID), fmt.Sprint(index), "done").Err()
}

func (t *Tracker) RunSegment(ctx context.Context, jobID string, index int, encodeSegment func(context.Context, string, int) error) (bool, error) {
	done, err := t.IsDone(ctx, jobID, index)
	if err != nil {
		return false, err
	}
	if done {
		return true, nil
	}
	lease, err := t.Claim(ctx, jobID, index)
	if err != nil {
		return false, err
	}
	if lease == "" {
		return true, nil
	}
	if err := encodeSegment(ctx, jobID, index); err != nil {
		_ = t.Release(ctx, jobID, index, lease)
		return false, err
	}
	if err := t.markDone(ctx, jobID, index); err != nil {
		return false, err
	}
	log.Printf("segment done job=%s index=%d", jobID, index)
	return true, t.rdb.Del(ctx, claimKey(jobID, index)).Err()
}

/** Trustworthy only when it covers every expected index: a count cannot show a hole. */
func (t *Tracker) Manifest(ctx context.Context, jobID string, segmentCount int) (map[string]any, error) {
	expected := make([]int, 0, segmentCount)
	for index := 0; index < segmentCount; index++ {
		expected = append(expected, index)
	}
	raw, err := t.rdb.HKeys(ctx, doneKey(jobID)).Result()
	if err != nil {
		return nil, err
	}
	done := make([]int, 0, len(raw))
	seen := map[int]bool{}
	for _, value := range raw {
		var index int
		if _, scanErr := fmt.Sscan(value, &index); scanErr != nil {
			continue
		}
		done = append(done, index)
		seen[index] = true
	}
	sort.Ints(done)
	missing := []int{}
	for _, index := range expected {
		if !seen[index] {
			missing = append(missing, index)
		}
	}
	return map[string]any{"complete": len(missing) == 0, "segments": done, "missing": missing}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

import java.util.UUID
import scala.jdk.CollectionConverters._

class Tracker(jedis: Jedis) {

  // TODO: this draft reads the claim key and then writes it with no NX and no expiry, marks a
  // segment done before its encode returns, re-encodes redelivered segments, and builds the
  // manifest from a counter. Review all four.
  def claim(jobId: String, index: Int): Boolean = {
    val key = s"transcode:claim:$index"
    if (jedis.exists(key)) return false
    jedis.set(key, UUID.randomUUID().toString)
    true
  }

  def markDone(jobId: String, index: Int): Unit =
    jedis.hincrBy(s"transcode:done:$jobId", "done", 1)

  def runSegment(jobId: String, index: Int, encodeSegment: (String, Int) => Unit): Boolean = {
    if (!claim(jobId, index)) return true
    markDone(jobId, index)
    encodeSegment(jobId, index)
    true
  }

  def manifest(jobId: String, segmentCount: Int): Map[String, Any] = {
    val done = Option(jedis.hget(s"transcode:done:$jobId", "done")).map(_.toInt).getOrElse(0)
    Map("complete" -> (done > 0), "done" -> done)
  }
}
`,
      solution: `import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams

import java.util.UUID
import scala.jdk.CollectionConverters._

object State {
  val LeaseMs = 90000L

  /** One key per segment, so a claim never blocks a different segment of the same job. */
  def claimKey(jobId: String, index: Int): String = s"transcode:claim:$jobId:$index"

  def doneKey(jobId: String): String = s"transcode:done:$jobId"
}

class Tracker(jedis: Jedis) {
  import State._

  /** Atomic claim with a lease; None when another worker already holds the segment. */
  def claim(jobId: String, index: Int): Option[String] = {
    val lease = UUID.randomUUID().toString
    val won = jedis.set(claimKey(jobId, index), lease, SetParams.setParams().nx().px(LeaseMs))
    Option(won).map(_ => lease)
  }

  /** Drop the claim, but only while we still own it — never another worker's lease. */
  def release(jobId: String, index: Int, lease: String): Unit =
    if (jedis.get(claimKey(jobId, index)) == lease) jedis.del(claimKey(jobId, index))

  /** A redelivered segment that already finished must not be encoded again. */
  def isDone(jobId: String, index: Int): Boolean = jedis.hexists(doneKey(jobId), index.toString)

  /** Record the segment as encoded; only ever called after the encode returned. */
  def markDone(jobId: String, index: Int): Unit = jedis.hset(doneKey(jobId), index.toString, "done")

  def runSegment(jobId: String, index: Int, encodeSegment: (String, Int) => Unit): Boolean = {
    if (isDone(jobId, index)) return true
    claim(jobId, index) match {
      case None => true
      case Some(lease) =>
        try {
          encodeSegment(jobId, index)
          markDone(jobId, index)
        } catch {
          case failure: Throwable =>
            release(jobId, index, lease)
            throw failure
        }
        jedis.del(claimKey(jobId, index))
        true
    }
  }

  /** Trustworthy only when it covers every expected index: a count cannot show a hole. */
  def manifest(jobId: String, segmentCount: Int): Map[String, Any] = {
    val expected = (0 until segmentCount).toSet
    val done = jedis.hkeys(doneKey(jobId)).asScala.map(_.toInt).toSet
    val missing = (expected -- done).toList.sorted
    Map("complete" -> missing.isEmpty, "segments" -> done.toList.sorted, "missing" -> missing)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <iostream>
#include <string>
#include <uuid/uuid.h>

class SegmentTracker {
 public:
  explicit SegmentTracker(sw::redis::Redis& redis) : redis_(redis) {}

  // TODO: this draft reads the claim key and then writes it with no NX and no expiry, marks a
  // segment done before its encode returns, re-encodes redelivered segments, and builds the
  // manifest from a counter. Review all four.
  bool claim(const std::string& job_id, int index) {
    const std::string key = "transcode:claim:" + std::to_string(index);
    if (redis_.exists(key)) return false;
    redis_.set(key, newLeaseId());
    return true;
  }

  void markDone(const std::string& job_id, int index) {
    redis_.hincrby("transcode:done:" + job_id, "done", 1);
  }

  bool runSegment(const std::string& job_id, int index,
                  const std::function<void(const std::string&, int)>& encodeSegment) {
    if (!claim(job_id, index)) return true;
    markDone(job_id, index);
    encodeSegment(job_id, index);
    return true;
  }

  std::map<std::string, int> manifest(const std::string& job_id, int segmentCount) {
    const long long done = redis_.hget("transcode:done:" + job_id, "done").value_or("0") == "0"
                               ? 0
                               : std::stoll(redis_.hget("transcode:done:" + job_id, "done").value());
    std::clog << "manifest job=" << job_id << " done=" << done << std::endl;
    return {{"complete", done > 0 ? 1 : 0}, {"done", static_cast<int>(done)}};
  }

 private:
  sw::redis::Redis& redis_;

  static std::string newLeaseId() { return "lease-" + std::to_string(std::rand()); }
};
`,
      solution: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <functional>
#include <iostream>
#include <iterator>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

const long long kLeaseMs = 90000;

std::string newLeaseId() { return "lease-" + std::to_string(std::rand()) + "-" + std::to_string(std::rand()); }

/** One key per segment, so a claim never blocks a different segment of the same job. */
std::string claimKey(const std::string& job_id, int index) {
  return "transcode:claim:" + job_id + ":" + std::to_string(index);
}

std::string doneKey(const std::string& job_id) { return "transcode:done:" + job_id; }

struct Manifest {
  bool complete;
  std::vector<int> segments;
  std::vector<int> missing;
};

}  // namespace

class SegmentTracker {
 public:
  explicit SegmentTracker(sw::redis::Redis& redis) : redis_(redis) {}

  /** Atomic claim with a lease; nullopt when another worker already holds the segment. */
  std::optional<std::string> claim(const std::string& job_id, int index) {
    const std::string lease = newLeaseId();
    const bool won = redis_.set(claimKey(job_id, index), lease, std::chrono::milliseconds(kLeaseMs),
                                sw::redis::UpdateType::NOT_EXIST);
    if (!won) return std::nullopt;
    return lease;
  }

  /** Drop the claim, but only while we still own it — never another worker's lease. */
  void release(const std::string& job_id, int index, const std::string& lease) {
    const auto held = redis_.get(claimKey(job_id, index));
    if (held && *held == lease) redis_.del(claimKey(job_id, index));
  }

  /** A redelivered segment that already finished must not be encoded again. */
  bool isDone(const std::string& job_id, int index) {
    return redis_.hexists(doneKey(job_id), std::to_string(index));
  }

  /** Record the segment as encoded; only ever called after the encode returned. */
  void markDone(const std::string& job_id, int index) {
    redis_.hset(doneKey(job_id), std::to_string(index), "done");
  }

  bool runSegment(const std::string& job_id, int index,
                  const std::function<void(const std::string&, int)>& encodeSegment) {
    if (isDone(job_id, index)) return true;
    auto lease = claim(job_id, index);
    if (!lease) return true;
    try {
      encodeSegment(job_id, index);
      markDone(job_id, index);
    } catch (...) {
      release(job_id, index, *lease);
      throw;
    }
    redis_.del(claimKey(job_id, index));
    std::clog << "segment done job=" << job_id << " index=" << index << std::endl;
    return true;
  }

  /** Trustworthy only when it covers every expected index: a count cannot show a hole. */
  Manifest manifest(const std::string& job_id, int segmentCount) {
    std::set<int> expected;
    for (int index = 0; index < segmentCount; ++index) expected.insert(index);
    std::vector<std::string> raw;
    redis_.hkeys(doneKey(job_id), std::back_inserter(raw));
    std::set<int> done;
    for (const auto& value : raw) done.insert(std::stoi(value));
    std::vector<int> missing;
    std::set_difference(expected.begin(), expected.end(), done.begin(), done.end(), std::back_inserter(missing));
    return Manifest{missing.empty(), std::vector<int>(done.begin(), done.end()), missing};
  }

 private:
  sw::redis::Redis& redis_;
};
`,
    },
  },
  hints: [
    'The claim has to be one round trip that both tests and takes: `SET key lease NX PX LEASE_MS`. `GET` then `SET` leaves a window where two workers both read "free" and both encode the same segment — the output then has two overlapping fragments.',
    'A lease is what makes a crash recoverable. Give the claim an expiry, and release it yourself when the encode throws so the retake is immediate; a claim with no TTL means a worker that dies takes its segment out of the job forever.',
    'Order matters more than the counter: call `mark_done` after `encode_segment` returns, and build the manifest from the set of done indices compared against `range(segment_count)`. A count of finished segments reports a complete file even when the middle segment is missing.',
  ],
  debrief: `The interviewer is testing whether you can review a generated work-tracking module against crashes and redelivery. The draft is right on a healthy short file: the counter goes up, the worker moves on. Four defects are being checked: the claim must be atomic (\`SET NX PX\`) so exactly one worker owns a segment; the claim must carry a lease so a crashed worker's segment is retaken by someone else after the lease expires; completion must be recorded after the encode, not before, or a crash leaves a hole the state still calls progress; and the manifest must cover every expected index, because a count cannot distinguish a full file from one with a missing minute. The redelivery skip is the fourth piece of the same idea: idempotent segment work is what lets the queue be at-least-once. Real pipelines add a heartbeat that renews the lease for very long segments, a per-job concurrency cap, and a reconciler that sweeps expired claims into a retry queue.`,
};
