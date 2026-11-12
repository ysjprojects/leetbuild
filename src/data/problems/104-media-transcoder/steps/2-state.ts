import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis segment claims with a lease, done after encode, a gapless manifest',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'worker'],
  task: `## Task

**Starting point.** The starter is the segment tracker every worker shares:
\`claim(job_id, index, worker)\` reads \`transcode:claim:{job_id}:{index}\` and sets it when empty,
\`run_segment(job_id, index, worker, encode)\` claims, calls \`mark_done\` (an \`SADD\` to
\`transcode:done:{job_id}\` plus an \`INCR\` of a counter), runs \`encode(job_id, index)\` and
releases, and \`manifest(job_id, segment_count)\` turns the counter into \`{segment_count, done,
missing, complete}\`. It serves the demo and hides five flaws.

**Failure mode the checks target.** Two workers encode one segment; a worker that crashes holds its
segment forever; a crash during an encode leaves a segment marked done with nothing behind it; a
redelivered segment is encoded again; and the manifest calls a file with a hole complete.

- One atomic claim decides the winner: \`SET\` with \`NX\` and \`PX LEASE_MS\` (90 s) in one call,
  so a dead worker's segment is retaken once the lease runs out.
- \`run_segment\` skips a segment that \`is_done\` (answers \`"skipped"\`), records done only after
  \`encode\` returned, and releases the claim when \`encode\` raises.
- \`manifest\` is computed from the done set against every index in \`range(segment_count)\`.`,
  sequence: {
    participants: ['Worker A', 'Worker B', 'Redis', 'Encoder'],
    messages: [
      {from: 'Worker A', to: 'Redis', label: 'SISMEMBER transcode:done:{job} 7 → 0', kind: 'sync'},
      {from: 'Worker A', to: 'Redis', label: 'SET transcode:claim:{job}:7 A NX PX 90000 → OK', kind: 'sync'},
      {from: 'Worker B', to: 'Redis', label: 'SET … NX PX 90000 → nil (busy)', kind: 'sync'},
      {from: 'Worker A', to: 'Encoder', label: 'encode(job, 7)', kind: 'sync'},
      {from: 'Encoder', to: 'Worker A', label: 'returned', kind: 'reply'},
      {from: 'Worker A', to: 'Redis', label: 'SADD transcode:done:{job} 7 · release claim', kind: 'sync'},
      {from: 'Worker A', to: 'Redis', label: 'SMEMBERS done → missing = range(n) − done', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'atomic-claim',
      title: 'One atomic SET NX decides who encodes a segment',
      detail:
        'The claim is a single `SET … NX` on `transcode:claim:{job_id}:{index}`; reading the key and then setting it lets a second worker land between the two commands and win too.',
      match: {
        python: {all: [/\.set\([^\n]*nx\s*=\s*True/], none: [/\.get\(\s*(key|claim_key)\b/]},
        typescript: {all: [/\.set\([^\n]*'NX'/], none: [/\.get\(\s*(key|claimKey)\b/]},
        go: {all: [/SetNX\(|Mode:\s*"NX"/], none: [/rdb\.Get\(\s*ctx,\s*(key|claimKey)\b/]},
        scala: {all: [/\.nx\(\)/], none: [/jedis\.get\(\s*(key|claimKey)\b/]},
        cpp: {all: [/UpdateType::NOT_EXIST/], none: [/redis\.get\(\s*(key|claimKey)\b/]},
      },
    },
    {
      id: 'lease-retake',
      title: "A claim carries a lease, so a dead worker's segment is retaken",
      detail:
        'The claim expires after `LEASE_MS` (90 s), set in the same command; a claim with no expiry outlives a crashed worker and the segment is never encoded.',
      match: {
        python: {all: [/LEASE_MS\s*=\s*90_?000\b/, /px\s*=\s*LEASE_MS/]},
        typescript: {all: [/LEASE_MS\s*=\s*90_?000\b/, /'PX',\s*LEASE_MS/]},
        go: {all: [/leaseMS\s*=\s*90000\b/, /SetNX\([^\n]*leaseMS|TTL:\s*leaseMS/]},
        scala: {all: [/LeaseMs\s*=\s*90000L?\b/, /\.px\(\s*LeaseMs\s*\)/]},
        cpp: {all: [/kLeaseMs\s*=\s*90000\b/, /milliseconds\(\s*kLeaseMs\s*\)/]},
      },
    },
    {
      id: 'done-after-encode',
      title: 'Done is recorded only after the encode returned',
      detail:
        '`run_segment` calls `encode` before `mark_done`, and releases the claim when `encode` raises; the starter marks the segment done first, so a crash mid-encode leaves a hole the done set covers.',
      match: {
        python: {
          order: [/def run_segment/, /\bencode\(job_id, index\)/, /\bmark_done\(job_id, index\)/],
          all: [/except[^\n]*:\s*\n\s*release\(/],
        },
        typescript: {
          order: [/function runSegment/, /await encode\(/, /await markDone\(/],
          all: [/catch[^\n]*\{\s*\n\s*await release\(/],
        },
        go: {
          order: [/func runSegment/, /\bencode\(jobID, index\)/, /\bmarkDone\(ctx, jobID, index\)/],
          all: [/encode\(jobID, index\); err != nil \{\s*\n\s*release\(/],
        },
        scala: {
          order: [/def runSegment/, /\bencode\(jobId, index\)/, /\bmarkDone\(jobId, index\)/],
          all: [/catch \{ case e: Exception => release\(/],
        },
        cpp: {
          order: [/std::string runSegment/, /\bencode\(job_id, index\)/, /\bmarkDone\(job_id, index\)/],
          all: [/catch \(\.\.\.\) \{\s*\n\s*release\(/],
        },
      },
    },
    {
      id: 'done-skip',
      title: 'A redelivered segment that is already done is skipped',
      detail:
        '`run_segment` asks `is_done` before it claims and answers `"skipped"`; the starter claims and encodes again, since the finished segment released its claim.',
      match: {
        python: {order: [/def run_segment/, /\bis_done\(/, /\bclaim\(/], all: [/["']skipped["']/]},
        typescript: {order: [/function runSegment/, /\bisDone\(/, /\bclaim\(/], all: [/['"]skipped['"]/]},
        go: {order: [/func runSegment/, /\bisDone\(/, /\bclaim\(/], all: [/"skipped"/]},
        scala: {order: [/def runSegment/, /\bisDone\(/, /\bclaim\(/], all: [/"skipped"/]},
        cpp: {order: [/std::string runSegment/, /\bisDone\(/, /\bclaim\(/], all: [/"skipped"/]},
      },
    },
    {
      id: 'gapless-manifest',
      title: 'The manifest covers every expected index',
      detail:
        'The manifest reads the done set (`SMEMBERS`) and reports every index of `range(segment_count)` it lacks as missing; a counter of completions counts a redelivered segment twice and calls a file with a hole complete.',
      match: {
        python: {all: [/smembers\(/], none: [/transcode:count|\.incr\(/]},
        typescript: {all: [/smembers\(/], none: [/transcode:count|\.incr\(/]},
        go: {all: [/SMembers\(/], none: [/transcode:count|\.Incr\(/]},
        scala: {all: [/smembers\(/], none: [/transcode:count|\.incr\(/]},
        cpp: {all: [/smembers\(/], none: [/transcode:count|\.incr\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEASE_MS = 90_000

# Deletes the claim only while it still names this worker: a lease that expired and was retaken stays.
RELEASE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
"""
release_script = r.register_script(RELEASE_LUA)


def claim_key(job_id: str, index: int) -> str:
    return f"transcode:claim:{job_id}:{index}"


def done_key(job_id: str) -> str:
    return f"transcode:done:{job_id}"


def claim(job_id: str, index: int, worker: str) -> bool:
    """Take segment index for worker; False when another worker holds it."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    key = claim_key(job_id, index)
    if r.get(key) is not None:
        return False
    r.set(key, worker)
    return True


def release(job_id: str, index: int, worker: str) -> None:
    """Give the claim back, if worker still holds it."""
    release_script(keys=[claim_key(job_id, index)], args=[worker])


def is_done(job_id: str, index: int) -> bool:
    return bool(r.sismember(done_key(job_id), index))


def mark_done(job_id: str, index: int) -> None:
    r.sadd(done_key(job_id), index)
    r.incr(f"transcode:count:{job_id}")


def run_segment(job_id: str, index: int, worker: str, encode) -> str:
    """Encode segment index once: "skipped" (already done), "busy" (claimed elsewhere) or "done"."""
    if not claim(job_id, index, worker):
        return "busy"
    mark_done(job_id, index)
    encode(job_id, index)
    release(job_id, index, worker)
    return "done"


def manifest(job_id: str, segment_count: int) -> dict:
    """{segment_count, done, missing, complete}: done and missing are sorted indices."""
    count = int(r.get(f"transcode:count:{job_id}") or 0)
    done = list(range(min(count, segment_count)))
    missing = list(range(len(done), segment_count))
    return {"segment_count": segment_count, "done": done, "missing": missing, "complete": not missing}
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEASE_MS = 90_000

# Deletes the claim only while it still names this worker: a lease that expired and was retaken stays.
RELEASE_LUA = """
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
"""
release_script = r.register_script(RELEASE_LUA)


def claim_key(job_id: str, index: int) -> str:
    return f"transcode:claim:{job_id}:{index}"


def done_key(job_id: str) -> str:
    return f"transcode:done:{job_id}"


def claim(job_id: str, index: int, worker: str) -> bool:
    """Take segment index for worker; False when another worker holds it."""
    # One command decides the winner, and the lease frees the segment if this worker dies.
    return r.set(claim_key(job_id, index), worker, nx=True, px=LEASE_MS) is True


def release(job_id: str, index: int, worker: str) -> None:
    """Give the claim back, if worker still holds it."""
    release_script(keys=[claim_key(job_id, index)], args=[worker])


def is_done(job_id: str, index: int) -> bool:
    return bool(r.sismember(done_key(job_id), index))


def mark_done(job_id: str, index: int) -> None:
    r.sadd(done_key(job_id), index)


def run_segment(job_id: str, index: int, worker: str, encode) -> str:
    """Encode segment index once: "skipped" (already done), "busy" (claimed elsewhere) or "done"."""
    if is_done(job_id, index):
        return "skipped"
    if not claim(job_id, index, worker):
        return "busy"
    try:
        encode(job_id, index)
    except Exception:
        release(job_id, index, worker)
        raise
    # Done means the encode returned: the bytes exist.
    mark_done(job_id, index)
    release(job_id, index, worker)
    return "done"


def manifest(job_id: str, segment_count: int) -> dict:
    """{segment_count, done, missing, complete}: done and missing are sorted indices."""
    done = sorted(int(i) for i in r.smembers(done_key(job_id)))
    missing = sorted(set(range(segment_count)) - set(done))
    return {"segment_count": segment_count, "done": done, "missing": missing, "complete": not missing}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const LEASE_MS = 90_000;

/** Deletes the claim only while it still names this worker: a lease that expired and was retaken stays. */
export const RELEASE_LUA = \`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
\`;

export interface Coverage {
  segment_count: number;
  done: number[];
  missing: number[];
  complete: boolean;
}

export const claimKey = (jobId: string, index: number): string => \`transcode:claim:\${jobId}:\${index}\`;
export const doneKey = (jobId: string): string => \`transcode:done:\${jobId}\`;

/** Take segment index for worker; false when another worker holds it. */
export async function claim(jobId: string, index: number, worker: string): Promise<boolean> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const key = claimKey(jobId, index);
  if ((await redis.get(key)) !== null) return false;
  await redis.set(key, worker);
  return true;
}

/** Give the claim back, if worker still holds it. */
export async function release(jobId: string, index: number, worker: string): Promise<void> {
  await redis.eval(RELEASE_LUA, 1, claimKey(jobId, index), worker);
}

export async function isDone(jobId: string, index: number): Promise<boolean> {
  return (await redis.sismember(doneKey(jobId), String(index))) === 1;
}

export async function markDone(jobId: string, index: number): Promise<void> {
  await redis.sadd(doneKey(jobId), String(index));
  await redis.incr(\`transcode:count:\${jobId}\`);
}

/** Encode segment index once: "skipped" (already done), "busy" (claimed elsewhere) or "done". */
export async function runSegment(jobId: string, index: number, worker: string, encode: (jobId: string, index: number) => Promise<void>): Promise<string> {
  if (!(await claim(jobId, index, worker))) return 'busy';
  await markDone(jobId, index);
  await encode(jobId, index);
  await release(jobId, index, worker);
  return 'done';
}

/** The manifest: done and missing are sorted indices. */
export async function manifest(jobId: string, segmentCount: number): Promise<Coverage> {
  const count = Number((await redis.get(\`transcode:count:\${jobId}\`)) ?? 0);
  const done = Array.from({length: Math.min(count, segmentCount)}, (_, i) => i);
  const missing = Array.from({length: segmentCount - done.length}, (_, i) => done.length + i);
  return {segment_count: segmentCount, done, missing, complete: missing.length === 0};
}
`,
      solution: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const LEASE_MS = 90_000;

/** Deletes the claim only while it still names this worker: a lease that expired and was retaken stays. */
export const RELEASE_LUA = \`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
\`;

export interface Coverage {
  segment_count: number;
  done: number[];
  missing: number[];
  complete: boolean;
}

export const claimKey = (jobId: string, index: number): string => \`transcode:claim:\${jobId}:\${index}\`;
export const doneKey = (jobId: string): string => \`transcode:done:\${jobId}\`;

/** Take segment index for worker; false when another worker holds it. */
export async function claim(jobId: string, index: number, worker: string): Promise<boolean> {
  // One command decides the winner, and the lease frees the segment if this worker dies.
  return (await redis.set(claimKey(jobId, index), worker, 'PX', LEASE_MS, 'NX')) === 'OK';
}

/** Give the claim back, if worker still holds it. */
export async function release(jobId: string, index: number, worker: string): Promise<void> {
  await redis.eval(RELEASE_LUA, 1, claimKey(jobId, index), worker);
}

export async function isDone(jobId: string, index: number): Promise<boolean> {
  return (await redis.sismember(doneKey(jobId), String(index))) === 1;
}

export async function markDone(jobId: string, index: number): Promise<void> {
  await redis.sadd(doneKey(jobId), String(index));
}

/** Encode segment index once: "skipped" (already done), "busy" (claimed elsewhere) or "done". */
export async function runSegment(jobId: string, index: number, worker: string, encode: (jobId: string, index: number) => Promise<void>): Promise<string> {
  if (await isDone(jobId, index)) return 'skipped';
  if (!(await claim(jobId, index, worker))) return 'busy';
  try {
    await encode(jobId, index);
  } catch (e) {
    await release(jobId, index, worker);
    throw e;
  }
  // Done means the encode returned: the bytes exist.
  await markDone(jobId, index);
  await release(jobId, index, worker);
  return 'done';
}

/** The manifest: done and missing are sorted indices. */
export async function manifest(jobId: string, segmentCount: number): Promise<Coverage> {
  const done = (await redis.smembers(doneKey(jobId))).map(Number).sort((a, b) => a - b);
  const missing = Array.from({length: segmentCount}, (_, i) => i).filter(i => !done.includes(i));
  return {segment_count: segmentCount, done, missing, complete: missing.length === 0};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const leaseMS = 90000

// releaseScript deletes the claim only while it still names this worker: a lease that expired and
// was retaken stays.
var releaseScript = redis.NewScript(\`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
\`)

// Coverage is the manifest of a job: Done and Missing are sorted indices.
type Coverage struct {
	SegmentCount int   \`json:"segment_count"\`
	Done         []int \`json:"done"\`
	Missing      []int \`json:"missing"\`
	Complete     bool  \`json:"complete"\`
}

func claimKey(jobID string, index int) string { return fmt.Sprintf("transcode:claim:%s:%d", jobID, index) }
func doneKey(jobID string) string             { return "transcode:done:" + jobID }

// claim takes segment index for worker; false when another worker holds it.
func claim(ctx context.Context, jobID string, index int, worker string) (bool, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	key := claimKey(jobID, index)
	if _, err := rdb.Get(ctx, key).Result(); err != redis.Nil {
		return false, err
	}
	return true, rdb.Set(ctx, key, worker, 0).Err()
}

// release gives the claim back, if worker still holds it.
func release(ctx context.Context, jobID string, index int, worker string) error {
	return releaseScript.Run(ctx, rdb, []string{claimKey(jobID, index)}, worker).Err()
}

func isDone(ctx context.Context, jobID string, index int) (bool, error) {
	return rdb.SIsMember(ctx, doneKey(jobID), index).Result()
}

func markDone(ctx context.Context, jobID string, index int) error {
	if err := rdb.SAdd(ctx, doneKey(jobID), index).Err(); err != nil {
		return err
	}
	return rdb.Incr(ctx, "transcode:count:"+jobID).Err()
}

// runSegment encodes segment index once: "skipped" (already done), "busy" (claimed elsewhere) or "done".
func runSegment(ctx context.Context, jobID string, index int, worker string, encode func(jobID string, index int) error) (string, error) {
	won, err := claim(ctx, jobID, index, worker)
	if err != nil || !won {
		return "busy", err
	}
	if err := markDone(ctx, jobID, index); err != nil {
		return "", err
	}
	if err := encode(jobID, index); err != nil {
		return "", err
	}
	return "done", release(ctx, jobID, index, worker)
}

// manifest is the job's coverage of every expected index.
func manifest(ctx context.Context, jobID string, segmentCount int) (Coverage, error) {
	count, err := rdb.Get(ctx, "transcode:count:"+jobID).Int()
	if err != nil && err != redis.Nil {
		return Coverage{}, err
	}
	done, missing := []int{}, []int{}
	for i := 0; i < segmentCount; i++ {
		if i < count {
			done = append(done, i)
		} else {
			missing = append(missing, i)
		}
	}
	return Coverage{SegmentCount: segmentCount, Done: done, Missing: missing, Complete: len(missing) == 0}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const leaseMS = 90000

// releaseScript deletes the claim only while it still names this worker: a lease that expired and
// was retaken stays.
var releaseScript = redis.NewScript(\`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
\`)

// Coverage is the manifest of a job: Done and Missing are sorted indices.
type Coverage struct {
	SegmentCount int   \`json:"segment_count"\`
	Done         []int \`json:"done"\`
	Missing      []int \`json:"missing"\`
	Complete     bool  \`json:"complete"\`
}

func claimKey(jobID string, index int) string { return fmt.Sprintf("transcode:claim:%s:%d", jobID, index) }
func doneKey(jobID string) string             { return "transcode:done:" + jobID }

// claim takes segment index for worker; false when another worker holds it.
func claim(ctx context.Context, jobID string, index int, worker string) (bool, error) {
	// One command decides the winner, and the lease frees the segment if this worker dies.
	return rdb.SetNX(ctx, claimKey(jobID, index), worker, leaseMS*time.Millisecond).Result()
}

// release gives the claim back, if worker still holds it.
func release(ctx context.Context, jobID string, index int, worker string) error {
	return releaseScript.Run(ctx, rdb, []string{claimKey(jobID, index)}, worker).Err()
}

func isDone(ctx context.Context, jobID string, index int) (bool, error) {
	return rdb.SIsMember(ctx, doneKey(jobID), index).Result()
}

func markDone(ctx context.Context, jobID string, index int) error {
	return rdb.SAdd(ctx, doneKey(jobID), index).Err()
}

// runSegment encodes segment index once: "skipped" (already done), "busy" (claimed elsewhere) or "done".
func runSegment(ctx context.Context, jobID string, index int, worker string, encode func(jobID string, index int) error) (string, error) {
	done, err := isDone(ctx, jobID, index)
	if err != nil {
		return "", err
	}
	if done {
		return "skipped", nil
	}
	won, err := claim(ctx, jobID, index, worker)
	if err != nil || !won {
		return "busy", err
	}
	if err := encode(jobID, index); err != nil {
		release(ctx, jobID, index, worker)
		return "", err
	}
	// Done means the encode returned: the bytes exist.
	if err := markDone(ctx, jobID, index); err != nil {
		return "", err
	}
	return "done", release(ctx, jobID, index, worker)
}

// manifest is the job's coverage of every expected index.
func manifest(ctx context.Context, jobID string, segmentCount int) (Coverage, error) {
	members, err := rdb.SMembers(ctx, doneKey(jobID)).Result()
	if err != nil {
		return Coverage{}, err
	}
	seen := map[int]bool{}
	done := []int{}
	for _, m := range members {
		i, _ := strconv.Atoi(m)
		seen[i] = true
		done = append(done, i)
	}
	sort.Ints(done)
	missing := []int{}
	for i := 0; i < segmentCount; i++ {
		if !seen[i] {
			missing = append(missing, i)
		}
	}
	return Coverage{SegmentCount: segmentCount, Done: done, Missing: missing, Complete: len(missing) == 0}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  /** The manifest of a job: done and missing are sorted indices. */
  final case class Coverage(segmentCount: Int, done: Seq[Int], missing: Seq[Int], complete: Boolean)

  val LeaseMs = 90000L

  /** Deletes the claim only while it still names this worker: a lease that expired and was retaken stays. */
  val ReleaseLua: String =
    """if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
      |return 0
      |""".stripMargin

  val jedis = new JedisPooled("redis", 6379)

  def claimKey(jobId: String, index: Int): String = s"transcode:claim:$jobId:$index"
  def doneKey(jobId: String): String = s"transcode:done:$jobId"

  /** Take segment index for worker; false when another worker holds it. */
  def claim(jobId: String, index: Int, worker: String): Boolean = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val key = claimKey(jobId, index)
    if (jedis.get(key) != null) false
    else {
      jedis.set(key, worker)
      true
    }
  }

  /** Give the claim back, if worker still holds it. */
  def release(jobId: String, index: Int, worker: String): Unit =
    jedis.eval(ReleaseLua, List(claimKey(jobId, index)).asJava, List(worker).asJava)

  def isDone(jobId: String, index: Int): Boolean = jedis.sismember(doneKey(jobId), index.toString)

  def markDone(jobId: String, index: Int): Unit = {
    jedis.sadd(doneKey(jobId), index.toString)
    jedis.incr(s"transcode:count:$jobId")
  }

  /** Encode segment index once: "skipped" (already done), "busy" (claimed elsewhere) or "done". */
  def runSegment(jobId: String, index: Int, worker: String, encode: (String, Int) => Unit): String =
    if (!claim(jobId, index, worker)) "busy"
    else {
      markDone(jobId, index)
      encode(jobId, index)
      release(jobId, index, worker)
      "done"
    }

  /** The job's coverage of every expected index. */
  def manifest(jobId: String, segmentCount: Int): Coverage = {
    val count = Option(jedis.get(s"transcode:count:$jobId")).map(_.toInt).getOrElse(0)
    val done = 0 until math.min(count, segmentCount)
    val missing = done.length until segmentCount
    Coverage(segmentCount, done, missing, missing.isEmpty)
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

object State {
  /** The manifest of a job: done and missing are sorted indices. */
  final case class Coverage(segmentCount: Int, done: Seq[Int], missing: Seq[Int], complete: Boolean)

  val LeaseMs = 90000L

  /** Deletes the claim only while it still names this worker: a lease that expired and was retaken stays. */
  val ReleaseLua: String =
    """if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
      |return 0
      |""".stripMargin

  val jedis = new JedisPooled("redis", 6379)

  def claimKey(jobId: String, index: Int): String = s"transcode:claim:$jobId:$index"
  def doneKey(jobId: String): String = s"transcode:done:$jobId"

  /** Take segment index for worker; false when another worker holds it. */
  def claim(jobId: String, index: Int, worker: String): Boolean =
    // One command decides the winner, and the lease frees the segment if this worker dies.
    jedis.set(claimKey(jobId, index), worker, SetParams.setParams().nx().px(LeaseMs)) != null

  /** Give the claim back, if worker still holds it. */
  def release(jobId: String, index: Int, worker: String): Unit =
    jedis.eval(ReleaseLua, List(claimKey(jobId, index)).asJava, List(worker).asJava)

  def isDone(jobId: String, index: Int): Boolean = jedis.sismember(doneKey(jobId), index.toString)

  def markDone(jobId: String, index: Int): Unit = jedis.sadd(doneKey(jobId), index.toString)

  /** Encode segment index once: "skipped" (already done), "busy" (claimed elsewhere) or "done". */
  def runSegment(jobId: String, index: Int, worker: String, encode: (String, Int) => Unit): String =
    if (isDone(jobId, index)) "skipped"
    else if (!claim(jobId, index, worker)) "busy"
    else {
      try encode(jobId, index)
      catch { case e: Exception => release(jobId, index, worker); throw e }
      // Done means the encode returned: the bytes exist.
      markDone(jobId, index)
      release(jobId, index, worker)
      "done"
    }

  /** The job's coverage of every expected index. */
  def manifest(jobId: String, segmentCount: Int): Coverage = {
    val done = jedis.smembers(doneKey(jobId)).asScala.toSeq.map(_.toInt).sorted
    val missing = (0 until segmentCount).filterNot(done.toSet)
    Coverage(segmentCount, done, missing, missing.isEmpty)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <functional>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kLeaseMs = 90000;

// Deletes the claim only while it still names this worker: a lease that expired and was retaken stays.
const std::string kReleaseLua = R"lua(
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
)lua";

// The manifest of a job: done and missing are sorted indices.
struct Coverage {
  int segment_count = 0;
  std::vector<int> done;
  std::vector<int> missing;
  bool complete = false;
};

std::string claimKey(const std::string& job_id, int index) { return "transcode:claim:" + job_id + ":" + std::to_string(index); }
std::string doneKey(const std::string& job_id) { return "transcode:done:" + job_id; }

// Take segment index for worker; false when another worker holds it.
bool claim(const std::string& job_id, int index, const std::string& worker) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string key = claimKey(job_id, index);
  if (redis.get(key)) return false;
  redis.set(key, worker);
  return true;
}

// Give the claim back, if worker still holds it.
void release(const std::string& job_id, int index, const std::string& worker) {
  redis.eval<long long>(kReleaseLua, {claimKey(job_id, index)}, {worker});
}

bool isDone(const std::string& job_id, int index) { return redis.sismember(doneKey(job_id), std::to_string(index)); }

void markDone(const std::string& job_id, int index) {
  redis.sadd(doneKey(job_id), std::to_string(index));
  redis.incr("transcode:count:" + job_id);
}

// Encode segment index once: "skipped" (already done), "busy" (claimed elsewhere) or "done".
std::string runSegment(const std::string& job_id, int index, const std::string& worker, const std::function<void(const std::string&, int)>& encode) {
  if (!claim(job_id, index, worker)) return "busy";
  markDone(job_id, index);
  encode(job_id, index);
  release(job_id, index, worker);
  return "done";
}

// The job's coverage of every expected index.
Coverage manifest(const std::string& job_id, int segment_count) {
  const auto count = redis.get("transcode:count:" + job_id);
  const int n = count ? std::stoi(*count) : 0;
  Coverage out;
  out.segment_count = segment_count;
  for (int i = 0; i < segment_count; i++) (i < n ? out.done : out.missing).push_back(i);
  out.complete = out.missing.empty();
  return out;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <functional>
#include <set>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kLeaseMs = 90000;

// Deletes the claim only while it still names this worker: a lease that expired and was retaken stays.
const std::string kReleaseLua = R"lua(
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
)lua";

// The manifest of a job: done and missing are sorted indices.
struct Coverage {
  int segment_count = 0;
  std::vector<int> done;
  std::vector<int> missing;
  bool complete = false;
};

std::string claimKey(const std::string& job_id, int index) { return "transcode:claim:" + job_id + ":" + std::to_string(index); }
std::string doneKey(const std::string& job_id) { return "transcode:done:" + job_id; }

// Take segment index for worker; false when another worker holds it.
bool claim(const std::string& job_id, int index, const std::string& worker) {
  // One command decides the winner, and the lease frees the segment if this worker dies.
  return redis.set(claimKey(job_id, index), worker, std::chrono::milliseconds(kLeaseMs), sw::redis::UpdateType::NOT_EXIST);
}

// Give the claim back, if worker still holds it.
void release(const std::string& job_id, int index, const std::string& worker) {
  redis.eval<long long>(kReleaseLua, {claimKey(job_id, index)}, {worker});
}

bool isDone(const std::string& job_id, int index) { return redis.sismember(doneKey(job_id), std::to_string(index)); }

void markDone(const std::string& job_id, int index) { redis.sadd(doneKey(job_id), std::to_string(index)); }

// Encode segment index once: "skipped" (already done), "busy" (claimed elsewhere) or "done".
std::string runSegment(const std::string& job_id, int index, const std::string& worker, const std::function<void(const std::string&, int)>& encode) {
  if (isDone(job_id, index)) return "skipped";
  if (!claim(job_id, index, worker)) return "busy";
  try {
    encode(job_id, index);
  } catch (...) {
    release(job_id, index, worker);
    throw;
  }
  // Done means the encode returned: the bytes exist.
  markDone(job_id, index);
  release(job_id, index, worker);
  return "done";
}

// The job's coverage of every expected index.
Coverage manifest(const std::string& job_id, int segment_count) {
  Coverage out;
  out.segment_count = segment_count;
  for (const std::string& m : redis.smembers(doneKey(job_id))) out.done.push_back(std::stoi(m));
  std::sort(out.done.begin(), out.done.end());
  const std::set<int> seen(out.done.begin(), out.done.end());
  for (int i = 0; i < segment_count; i++) {
    if (!seen.count(i)) out.missing.push_back(i);
  }
  out.complete = out.missing.empty();
  return out;
}
`,
    },
  },
  harness: {
    python: `JOB = "tj-1"


class Encoder:
    """The encode callable: records the indices it was asked for, whether each was already in the done set at that moment, and fails on demand."""

    def __init__(self, ctx, fail=()):
        self.ctx = ctx
        self.fail = set(fail)
        self.calls = []
        self.done_during = []

    def __call__(self, job_id, index):
        self.calls.append(index)
        self.done_during.append(bool(self.ctx.redis.sismember(f"transcode:done:{job_id}", index)))
        if index in self.fail:
            raise RuntimeError(f"worker lost while encoding segment {index}")


def check_atomic_claim(ctx):
    m = ctx.load("state")
    # A second worker's claim lands right after this worker's first command on the key.
    rival = ctx.redis_after("transcode:claim:tj-1:4", lambda: m.claim(JOB, 4, "w-2"))
    mine = m.claim(JOB, 4, "w-1")
    assert rival.fired, "claim never touched transcode:claim:tj-1:4"
    if rival.error is not None:
        raise rival.error
    winners = [w for w, won in (("w-1", mine), ("w-2", rival.result)) if won]
    assert len(winners) == 1, f"two workers claimed segment 4 at the same moment and {len(winners)} won (w-1: {mine}, w-2: {rival.result}): reading the key and then setting it lets both in. One SET NX must decide"
    holder = ctx.redis.get("transcode:claim:tj-1:4")
    assert holder == winners[0], f"{winners[0]} won segment 4 but the claim names {holder!r}"
    assert m.claim(JOB, 4, "w-3") is False, "a third worker claimed a segment another worker holds"


def check_lease_retake(ctx):
    m = ctx.load("state")
    assert m.claim(JOB, 2, "w-1") is True, "the first claim of segment 2 must win"
    ttl = ctx.redis.pttl("transcode:claim:tj-1:2")
    assert 0 < ttl <= 90_000, f"the claim on segment 2 has PTTL {ttl}: with no expiry a crashed worker holds the segment forever. Claim with PX LEASE_MS (90 s)"
    ctx.clock.advance(60)
    assert m.claim(JOB, 2, "w-2") is False, "60 s into w-1's 90-second lease, w-2 took segment 2"
    ctx.clock.advance(31)
    assert m.claim(JOB, 2, "w-2") is True, "w-1 died and its 90-second lease ran out: w-2 must retake segment 2"


def check_done_after_encode(ctx):
    m = ctx.load("state")
    broken = Encoder(ctx, fail={3})
    try:
        m.run_segment(JOB, 3, "w-1", broken)
    except RuntimeError:
        pass
    else:
        raise AssertionError("the encode of segment 3 raised but run_segment did not")
    assert not ctx.redis.sismember("transcode:done:tj-1", 3), "segment 3 is in the done set although its encode failed: the manifest will call a file with a hole complete. Record done after the encode returned"
    assert m.claim(JOB, 3, "w-2") is True, "the failed encode left w-1's claim on segment 3: release it so another worker retakes the segment now, not after the lease"
    ok = Encoder(ctx)
    assert m.run_segment(JOB, 5, "w-1", ok) == "done", "a successful encode of segment 5 must answer 'done'"
    assert ok.done_during == [False], "segment 5 was already in the done set while it was still encoding: a crash at that moment leaves a hole marked done"
    assert ctx.redis.sismember("transcode:done:tj-1", 5), "after a successful encode segment 5 must be in the done set"


def check_done_skip(ctx):
    m = ctx.load("state")
    enc = Encoder(ctx)
    assert m.run_segment(JOB, 1, "w-1", enc) == "done", "the first run of segment 1 must answer 'done'"
    again = m.run_segment(JOB, 1, "w-2", enc)
    assert enc.calls == [1], f"segment 1 was encoded {len(enc.calls)} times: a redelivered segment that is already done must be skipped, not encoded again"
    assert again == "skipped", f"a redelivery of a done segment answered {again!r}, expected 'skipped'"
    m.claim(JOB, 6, "w-1")
    busy = m.run_segment(JOB, 6, "w-2", enc)
    assert busy == "busy" and enc.calls == [1], f"a segment w-1 holds answered {busy!r} to w-2 and was encoded: it must answer 'busy'"


def check_gapless_manifest(ctx):
    m = ctx.load("state")
    m.mark_done(JOB, 0)
    m.mark_done(JOB, 2)
    m.mark_done(JOB, 2)  # a redelivered completion
    got = m.manifest(JOB, 4)
    want = {"segment_count": 4, "done": [0, 2], "missing": [1, 3], "complete": False}
    assert got == want, f"segments 0 and 2 (twice) of 4 are done and the manifest says {got}: it must cover every expected index, {want}"
    m.mark_done(JOB, 1)
    m.mark_done(JOB, 3)
    got = m.manifest(JOB, 4)
    want = {"segment_count": 4, "done": [0, 1, 2, 3], "missing": [], "complete": True}
    assert got == want, f"with every segment done the manifest says {got}, expected {want}"
`,
    typescript: `const JOB = 'tj-1';

/** The encode callback: records the indices it was asked for, whether each was already done at that moment, and fails on demand. */
function encoder(ctx, fail: number[] = []) {
  const calls: number[] = [];
  const doneDuring: boolean[] = [];
  const encode = async (jobId: string, index: number): Promise<void> => {
    calls.push(index);
    doneDuring.push(Number(ctx.redis.sismember(\`transcode:done:\${jobId}\`, String(index))) === 1);
    if (fail.includes(index)) throw new Error(\`worker lost while encoding segment \${index}\`);
  };
  return {calls, doneDuring, encode};
}

export async function check_atomic_claim(ctx) {
  const m = ctx.load('state');
  // A second worker's claim lands right after this worker's first command on the key.
  const rival = ctx.redisAfter('transcode:claim:tj-1:4', () => m.claim(JOB, 4, 'w-2'));
  const mine = await m.claim(JOB, 4, 'w-1');
  assert(rival.fired, 'claim never touched transcode:claim:tj-1:4');
  if (rival.error !== undefined) throw rival.error;
  const theirs = await rival.result;
  const winners = [mine ? 'w-1' : null, theirs ? 'w-2' : null].filter(w => w !== null);
  assert.equal(winners.length, 1, \`two workers claimed segment 4 at the same moment and \${winners.length} won (w-1: \${mine}, w-2: \${theirs}): reading the key and then setting it lets both in. One SET NX must decide\`);
  assert.equal(ctx.redis.get('transcode:claim:tj-1:4'), winners[0], \`\${winners[0]} won segment 4 but the claim names someone else\`);
  assert.equal(await m.claim(JOB, 4, 'w-3'), false, 'a third worker claimed a segment another worker holds');
}

export async function check_lease_retake(ctx) {
  const m = ctx.load('state');
  assert.equal(await m.claim(JOB, 2, 'w-1'), true, 'the first claim of segment 2 must win');
  const ttl = Number(ctx.redis.pttl('transcode:claim:tj-1:2'));
  assert(ttl > 0 && ttl <= 90_000, \`the claim on segment 2 has PTTL \${ttl}: with no expiry a crashed worker holds the segment forever. Claim with PX LEASE_MS (90 s)\`);
  ctx.clock.advance(60);
  assert.equal(await m.claim(JOB, 2, 'w-2'), false, "60 s into w-1's 90-second lease, w-2 took segment 2");
  ctx.clock.advance(31);
  assert.equal(await m.claim(JOB, 2, 'w-2'), true, "w-1 died and its 90-second lease ran out: w-2 must retake segment 2");
}

export async function check_done_after_encode(ctx) {
  const m = ctx.load('state');
  const broken = encoder(ctx, [3]);
  await assert.rejects(m.runSegment(JOB, 3, 'w-1', broken.encode), 'the encode of segment 3 threw but runSegment did not');
  assert.equal(Number(ctx.redis.sismember('transcode:done:tj-1', '3')), 0, 'segment 3 is in the done set although its encode failed: the manifest will call a file with a hole complete. Record done after the encode returned');
  assert.equal(await m.claim(JOB, 3, 'w-2'), true, "the failed encode left w-1's claim on segment 3: release it so another worker retakes the segment now, not after the lease");
  const ok = encoder(ctx);
  assert.equal(await m.runSegment(JOB, 5, 'w-1', ok.encode), 'done', "a successful encode of segment 5 must answer 'done'");
  assert.deepStrictEqual(ok.doneDuring, [false], 'segment 5 was already in the done set while it was still encoding: a crash at that moment leaves a hole marked done');
  assert.equal(Number(ctx.redis.sismember('transcode:done:tj-1', '5')), 1, 'after a successful encode segment 5 must be in the done set');
}

export async function check_done_skip(ctx) {
  const m = ctx.load('state');
  const enc = encoder(ctx);
  assert.equal(await m.runSegment(JOB, 1, 'w-1', enc.encode), 'done', "the first run of segment 1 must answer 'done'");
  const again = await m.runSegment(JOB, 1, 'w-2', enc.encode);
  assert.deepStrictEqual(enc.calls, [1], \`segment 1 was encoded \${enc.calls.length} times: a redelivered segment that is already done must be skipped, not encoded again\`);
  assert.equal(again, 'skipped', \`a redelivery of a done segment answered \${JSON.stringify(again)}, expected 'skipped'\`);
  await m.claim(JOB, 6, 'w-1');
  const busy = await m.runSegment(JOB, 6, 'w-2', enc.encode);
  assert(busy === 'busy' && enc.calls.length === 1, \`a segment w-1 holds answered \${JSON.stringify(busy)} to w-2 and was encoded: it must answer 'busy'\`);
}

export async function check_gapless_manifest(ctx) {
  const m = ctx.load('state');
  await m.markDone(JOB, 0);
  await m.markDone(JOB, 2);
  await m.markDone(JOB, 2); // a redelivered completion
  let got = await m.manifest(JOB, 4);
  let want = {segment_count: 4, done: [0, 2], missing: [1, 3], complete: false};
  assert.deepStrictEqual(got, want, \`segments 0 and 2 (twice) of 4 are done and the manifest says \${JSON.stringify(got)}: it must cover every expected index, \${JSON.stringify(want)}\`);
  await m.markDone(JOB, 1);
  await m.markDone(JOB, 3);
  got = await m.manifest(JOB, 4);
  want = {segment_count: 4, done: [0, 1, 2, 3], missing: [], complete: true};
  assert.deepStrictEqual(got, want, \`with every segment done the manifest says \${JSON.stringify(got)}, expected \${JSON.stringify(want)}\`);
}
`,
    go: `package main

import (
	"context"
	"errors"
	"strconv"

	"leetbuild/harness"
)

const stateJob = "tj-1"

var stateBg = context.Background()

// recorder is the encode callback: the indices it was asked for, whether each was already in the
// done set at that moment, and the indices it fails.
type recorder struct {
	ctx        *harness.Ctx
	fail       map[int]bool
	calls      []int
	doneDuring []bool
}

func (e *recorder) encode(jobID string, index int) error {
	e.calls = append(e.calls, index)
	e.doneDuring = append(e.doneDuring, e.ctx.Redis.SIsMember("transcode:done:"+jobID, strconv.Itoa(index)))
	if e.fail[index] {
		return errors.New("worker lost while encoding the segment")
	}
	return nil
}

func mustClaim(ctx *harness.Ctx, index int, worker string) bool {
	won, err := claim(stateBg, stateJob, index, worker)
	ctx.NoError(err, "claim(%s, %d, %s) failed", stateJob, index, worker)
	return won
}

func CheckAtomicClaim(ctx *harness.Ctx) {
	// A second worker's claim lands right after this worker's first command on the key.
	rival := ctx.Redis.After("transcode:claim:tj-1:4", func() any {
		won, _ := claim(stateBg, stateJob, 4, "w-2")
		return won
	})
	mine := mustClaim(ctx, 4, "w-1")
	ctx.Assert(rival.Fired, "claim never touched transcode:claim:tj-1:4")
	theirs, _ := rival.Result.(bool)
	ctx.Assert(mine != theirs, "two workers claimed segment 4 at the same moment (w-1: %v, w-2: %v): exactly one must win. Reading the key and then setting it lets both in; one SET NX must decide", mine, theirs)
	winner := "w-1"
	if theirs {
		winner = "w-2"
	}
	holder, _ := ctx.Redis.Get("transcode:claim:tj-1:4")
	ctx.Equal(holder, winner, "%s won segment 4; the claim names", winner)
	ctx.Equal(mustClaim(ctx, 4, "w-3"), false, "a third worker must not claim a segment another worker holds; won")
}

func CheckLeaseRetake(ctx *harness.Ctx) {
	ctx.Equal(mustClaim(ctx, 2, "w-1"), true, "the first claim of segment 2 must win; won")
	ttl := ctx.Redis.PTTL("transcode:claim:tj-1:2")
	ctx.Assert(ttl > 0 && ttl <= 90000, "the claim on segment 2 has PTTL %d: with no expiry a crashed worker holds the segment forever. Claim with a 90 s lease (leaseMS)", ttl)
	ctx.Clock.Advance(60)
	ctx.Equal(mustClaim(ctx, 2, "w-2"), false, "60 s into w-1's 90-second lease, w-2 must not take segment 2; won")
	ctx.Clock.Advance(31)
	ctx.Equal(mustClaim(ctx, 2, "w-2"), true, "w-1 died and its 90-second lease ran out: w-2 must retake segment 2; won")
}

func CheckDoneAfterEncode(ctx *harness.Ctx) {
	broken := &recorder{ctx: ctx, fail: map[int]bool{3: true}}
	_, err := runSegment(stateBg, stateJob, 3, "w-1", broken.encode)
	ctx.Assert(err != nil, "the encode of segment 3 failed but runSegment returned no error")
	ctx.Assert(!ctx.Redis.SIsMember("transcode:done:tj-1", "3"), "segment 3 is in the done set although its encode failed: the manifest will call a file with a hole complete. Record done after the encode returned")
	ctx.Equal(mustClaim(ctx, 3, "w-2"), true, "the failed encode left w-1's claim on segment 3: release it so another worker retakes the segment now, not after the lease; won")
	ok := &recorder{ctx: ctx}
	status, err := runSegment(stateBg, stateJob, 5, "w-1", ok.encode)
	ctx.NoError(err, "a successful encode of segment 5 failed")
	ctx.Equal(status, "done", "a successful encode of segment 5")
	ctx.Equal(ok.doneDuring, []bool{false}, "segment 5 was already in the done set while it was still encoding (a crash then leaves a hole marked done); done during the encode")
	ctx.Assert(ctx.Redis.SIsMember("transcode:done:tj-1", "5"), "after a successful encode segment 5 must be in the done set")
}

func CheckDoneSkip(ctx *harness.Ctx) {
	enc := &recorder{ctx: ctx}
	status, err := runSegment(stateBg, stateJob, 1, "w-1", enc.encode)
	ctx.NoError(err, "the first run of segment 1 failed")
	ctx.Equal(status, "done", "the first run of segment 1")
	again, err := runSegment(stateBg, stateJob, 1, "w-2", enc.encode)
	ctx.NoError(err, "the redelivery of segment 1 failed")
	ctx.Equal(enc.calls, []int{1}, "a redelivered segment that is already done must be skipped, not encoded again; the encodes")
	ctx.Equal(again, "skipped", "a redelivery of a done segment")
	mustClaim(ctx, 6, "w-1")
	busy, _ := runSegment(stateBg, stateJob, 6, "w-2", enc.encode)
	ctx.Assert(busy == "busy" && len(enc.calls) == 1, "a segment w-1 holds answered %q to w-2 and was encoded: it must answer busy", busy)
}

func CheckGaplessManifest(ctx *harness.Ctx) {
	for _, i := range []int{0, 2, 2} { // 2 twice: a redelivered completion
		ctx.NoError(markDone(stateBg, stateJob, i), "markDone(%d) failed", i)
	}
	got, err := manifest(stateBg, stateJob, 4)
	ctx.NoError(err, "manifest failed")
	ctx.Equal(got, Coverage{SegmentCount: 4, Done: []int{0, 2}, Missing: []int{1, 3}, Complete: false}, "segments 0 and 2 (twice) of 4 are done: the manifest must cover every expected index")
	markDone(stateBg, stateJob, 1)
	markDone(stateBg, stateJob, 3)
	got, _ = manifest(stateBg, stateJob, 4)
	ctx.Equal(got, Coverage{SegmentCount: 4, Done: []int{0, 1, 2, 3}, Missing: []int{}, Complete: true}, "with every segment done, the manifest")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

const std::string kJob = "tj-1";

// The encode callback's record: the indices it was asked for, whether each was already in the done
// set at that moment, and the indices it fails.
struct Recorder {
  std::set<int> fail;
  std::vector<int> calls;
  std::vector<bool> done_during;
};

std::function<void(const std::string&, int)> encoder(harness::Ctx& ctx, Recorder& rec) {
  return [&ctx, &rec](const std::string& job_id, int index) {
    rec.calls.push_back(index);
    rec.done_during.push_back(ctx.Redis.SIsMember("transcode:done:" + job_id, std::to_string(index)));
    if (rec.fail.count(index)) throw std::runtime_error("worker lost while encoding segment " + std::to_string(index));
  };
}

}  // namespace

void CheckAtomicClaim(harness::Ctx& ctx) {
  // A second worker's claim lands right after this worker's first command on the key.
  auto fired = std::make_shared<bool>(false);
  auto theirs = std::make_shared<bool>(false);
  ctx.Redis.After("transcode:claim:tj-1:4", [fired, theirs] {
    *fired = true;
    *theirs = claim(kJob, 4, "w-2");
  });
  const bool mine = claim(kJob, 4, "w-1");
  ctx.Assert(*fired, "claim never touched transcode:claim:tj-1:4");
  ctx.Assert(mine != *theirs, "two workers claimed segment 4 at the same moment (w-1: %t, w-2: %t): exactly one must win. Reading the key and then setting it lets both in; one SET NX must decide", mine, *theirs);
  const std::string winner = mine ? "w-1" : "w-2";
  ctx.Equal(ctx.Redis.Get("transcode:claim:tj-1:4").value_or(""), winner, "%s won segment 4; the claim names", winner);
  ctx.Equal(claim(kJob, 4, "w-3"), false, "a third worker must not claim a segment another worker holds; won");
}

void CheckLeaseRetake(harness::Ctx& ctx) {
  ctx.Equal(claim(kJob, 2, "w-1"), true, "the first claim of segment 2 must win; won");
  const long long ttl = ctx.Redis.PTTL("transcode:claim:tj-1:2");
  ctx.Assert(ttl > 0 && ttl <= 90000, "the claim on segment 2 has PTTL %d: with no expiry a crashed worker holds the segment forever. Claim with a 90 s lease (kLeaseMs)", ttl);
  ctx.Clock.Advance(60);
  ctx.Equal(claim(kJob, 2, "w-2"), false, "60 s into w-1's 90-second lease, w-2 must not take segment 2; won");
  ctx.Clock.Advance(31);
  ctx.Equal(claim(kJob, 2, "w-2"), true, "w-1 died and its 90-second lease ran out: w-2 must retake segment 2; won");
}

void CheckDoneAfterEncode(harness::Ctx& ctx) {
  Recorder broken;
  broken.fail = {3};
  bool threw = false;
  try {
    runSegment(kJob, 3, "w-1", encoder(ctx, broken));
  } catch (const std::runtime_error&) {
    threw = true;
  }
  ctx.Assert(threw, "the encode of segment 3 threw but runSegment did not");
  ctx.Assert(!ctx.Redis.SIsMember("transcode:done:tj-1", "3"), "segment 3 is in the done set although its encode failed: the manifest will call a file with a hole complete. Record done after the encode returned");
  ctx.Equal(claim(kJob, 3, "w-2"), true, "the failed encode left w-1's claim on segment 3: release it so another worker retakes the segment now, not after the lease; won");
  Recorder ok;
  ctx.Equal(runSegment(kJob, 5, "w-1", encoder(ctx, ok)), "done", "a successful encode of segment 5");
  ctx.Equal(ok.done_during, std::vector<bool>{false}, "segment 5 was already in the done set while it was still encoding (a crash then leaves a hole marked done); done during the encode");
  ctx.Assert(ctx.Redis.SIsMember("transcode:done:tj-1", "5"), "after a successful encode segment 5 must be in the done set");
}

void CheckDoneSkip(harness::Ctx& ctx) {
  Recorder rec;
  ctx.Equal(runSegment(kJob, 1, "w-1", encoder(ctx, rec)), "done", "the first run of segment 1");
  const std::string again = runSegment(kJob, 1, "w-2", encoder(ctx, rec));
  ctx.Equal(rec.calls, std::vector<int>{1}, "a redelivered segment that is already done must be skipped, not encoded again; the encodes");
  ctx.Equal(again, "skipped", "a redelivery of a done segment");
  claim(kJob, 6, "w-1");
  const std::string busy = runSegment(kJob, 6, "w-2", encoder(ctx, rec));
  ctx.Assert(busy == "busy" && rec.calls.size() == 1, "a segment w-1 holds answered %q to w-2 and was encoded: it must answer busy", busy);
}

void CheckGaplessManifest(harness::Ctx& ctx) {
  markDone(kJob, 0);
  markDone(kJob, 2);
  markDone(kJob, 2);  // a redelivered completion
  Coverage got = manifest(kJob, 4);
  ctx.Assert(got.segment_count == 4 && got.done == std::vector<int>{0, 2} && got.missing == std::vector<int>{1, 3} && !got.complete,
             "segments 0 and 2 (twice) of 4 are done and the manifest says done %v, missing %v, complete %t: it must cover every expected index (done [0 2], missing [1 3], not complete)",
             got.done, got.missing, got.complete);
  markDone(kJob, 1);
  markDone(kJob, 3);
  got = manifest(kJob, 4);
  ctx.Assert(got.done == std::vector<int>{0, 1, 2, 3} && got.missing.empty() && got.complete, "with every segment done the manifest says done %v, missing %v, complete %t", got.done, got.missing, got.complete);
}
`,
  },
  hints: [
    'Kill a worker in the middle of segment 9: the manifest still reaches "complete" and the player skips a minute. Meanwhile two workers write overlapping fragments of segment 12.',
    '`claim` is a GET and then a SET with no NX and no expiry, so two readers both win and a dead worker keeps the key; `run_segment` marks done before encoding, and `manifest` counts completions instead of reading which indices exist.',
    'Claim with `SET key worker NX PX LEASE_MS`; in `run_segment` return "skipped" when `is_done`, release in an `except` around `encode`, call `mark_done` after it; build `missing = set(range(segment_count)) - done` from `SMEMBERS`.',
  ],
  debrief: `Every piece of the fix serves one rule: the queue delivers at least once and workers die, so segment work has to be safe to repeat. A single \`SET NX PX\` makes "test and take" one event in Redis, and the lease turns a crash into a delay instead of a permanent hole. Recording done after the encode, and skipping what is done, make the done set mean "the bytes exist" and nothing weaker; once it does, the manifest can be computed from it and the counter goes away. What this step did not do: a worker whose encode can outlast the lease renews it with a heartbeat, and the output write carries the claim's token so a worker that lost its lease cannot overwrite the segment its successor wrote.`,
};
