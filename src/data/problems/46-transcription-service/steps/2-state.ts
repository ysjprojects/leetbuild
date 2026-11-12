import type {Step} from '@/lib/types';

export const transcriptionStateStep: Step = {
  id: 'state',
  title: 'A Redis chunk ledger that claims each chunk once',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['worker', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter is the chunk ledger the workers share: \`run_chunk(job_id, index,
total, transcribe)\` looks chunk \`index\` up in the \`progress:chunks\` hash, calls \`transcribe()\` (the
ASR call of step 3) unless the chunk is \`done\`, marks it \`done\` and, once \`total\` chunks are done,
calls \`jobs.mark_done\`. It answers \`{status: "done" | "duplicate" | "failed", segments}\`. It serves
the demo and hides five flaws.

**Failure mode the checks target.** Kafka delivers a chunk at least once, so the same chunk arrives
twice, sometimes while the first delivery is still at the provider, and both pay for the ASR call.
Chunk 0 of one job reads as done for every job, a chunk whose transcription failed is recorded as
done, and a finished job's ledger stays in Redis for good.

- The ledger is the job's own hash, \`job:{job_id}:chunks\`: chunk index → \`running\`, \`done\` or
  \`failed\`.
- Claim the chunk **before** \`transcribe()\`, in **one Lua script**: a chunk that is \`running\` or
  \`done\` answers \`duplicate\`; one with no state, or \`failed\`, becomes \`running\`.
- A \`transcribe()\` that raises writes \`failed\` and answers \`failed\`, so a redelivery can claim
  the chunk again.
- When the last chunk is \`done\`, \`EXPIRE\` the ledger for \`LEDGER_TTL_S\` = 86 400 s.`,
  sequence: {
    participants: ['Chunk worker', 'Redis ledger', 'ASR provider', 'jobs store'],
    messages: [
      {
        from: 'Chunk worker',
        to: 'Redis ledger',
        label: 'EVAL claim job:{id}:chunks 7 → 1 (running) · 0 (duplicate)',
        kind: 'sync',
      },
      {from: 'Chunk worker', to: 'ASR provider', label: 'transcribe() only after the claim won', kind: 'sync'},
      {from: 'ASR provider', to: 'Chunk worker', label: 'segments · or an error', kind: 'reply'},
      {from: 'Chunk worker', to: 'Redis ledger', label: 'HSET 7 done · or HSET 7 failed', kind: 'sync'},
      {from: 'Chunk worker', to: 'Redis ledger', label: 'last chunk done → EXPIRE 86400', kind: 'sync'},
      {from: 'Chunk worker', to: 'jobs store', label: 'mark_done(job_id)', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'job-key',
      title: 'One ledger per job',
      detail:
        "Chunk states live in the job's own hash `job:{job_id}:chunks`; the starter keeps every job in one `progress:chunks` hash, so chunk 0 of the second job reads as done.",
      match: {
        python: {all: [/f["']job:\{job_id\}:chunks["']/], none: [/progress:chunks/]},
        typescript: {all: [/`job:\$\{jobId\}:chunks`/], none: [/progress:chunks/]},
        go: {all: [/"job:"\s*\+\s*jobID\s*\+\s*":chunks"/], none: [/progress:chunks/]},
        scala: {all: [/s"job:\$jobId:chunks"/], none: [/progress:chunks/]},
        cpp: {all: [/"job:"\s*\+\s*job_id\s*\+\s*":chunks"/], none: [/progress:chunks/]},
      },
    },
    {
      id: 'claim-before-transcribe',
      title: 'Claims the chunk before the ASR call',
      detail:
        'The chunk is claimed (`running`) before `transcribe()` runs, so a redelivery that arrives while the first delivery is at the provider answers `duplicate`; the starter marks the chunk only after the call returns.',
      match: {
        python: {order: [/\bclaim\w*\(|\.eval(sha)?\(/, /transcribe\(\)/]},
        typescript: {order: [/\bclaim\w*\(|\.eval(sha)?\(/, /transcribe\(\)/]},
        go: {order: [/\bclaim\w*\.Run\(|\.Eval(Sha)?\(/, /transcribe\(\)/]},
        scala: {order: [/\bclaim\w*\(|\.eval(sha)?\(/, /transcribe\(\)/]},
        cpp: {order: [/\.eval(sha)?\s*</, /transcribe\(\)/]},
      },
    },
    {
      id: 'atomic-claim',
      title: 'The claim is one Lua script',
      detail:
        'Reading the chunk state and writing `running` happen in one script (`register_script`/`eval`/`NewScript`), so two deliveries racing on the ledger cannot both win; an `HGET` followed by an `HSET` leaves a gap another worker lands in.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]HGET['"]/, /redis\.call\(\s*['"]HSET['"]/],
          none: [/\br\.hget\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]HGET['"]/, /redis\.call\(\s*['"]HSET['"]/],
          none: [/redis\.hget\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]HGET['"]/, /redis\.call\(\s*['"]HSET['"]/],
          none: [/rdb\.HGet\(/],
        },
        scala: {
          all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]HGET['"]/, /redis\.call\(\s*['"]HSET['"]/],
          none: [/jedis\.hget\(/],
        },
        cpp: {
          all: [/\.eval(sha)?\s*</, /redis\.call\(\s*['"]HGET['"]/, /redis\.call\(\s*['"]HSET['"]/],
          none: [/\.hget\(/],
        },
      },
    },
    {
      id: 'failure-releases',
      title: 'A failed chunk is not progress',
      detail:
        'When `transcribe()` raises, the ledger records `failed` and the call answers `failed`, so a redelivery can claim the chunk and the job does not count it; the starter swallows the error and marks the chunk `done` with no segments.',
      match: {
        python: {all: [/except\b[\s\S]{0,160}?hset\([^\n]*["']failed["']/]},
        typescript: {all: [/catch\b[\s\S]{0,160}?hset\([^\n]*['"]failed['"]/]},
        go: {all: [/if err != nil[\s\S]{0,200}?HSet\([^\n]*"failed"/]},
        scala: {all: [/catch\b[\s\S]{0,200}?hset\([^\n]*"failed"/]},
        cpp: {all: [/catch\b[\s\S]{0,200}?hset\([^\n]*"failed"/]},
      },
    },
    {
      id: 'ledger-ttl',
      title: "A finished job's ledger expires in 24 hours",
      detail:
        'Once the last chunk is `done` the ledger gets an `EXPIRE` of `LEDGER_TTL_S` (86 400 s), and not before; the starter never sets one, so every finished job keeps its ledger in Redis.',
      match: {
        python: {all: [/LEDGER_TTL_S\s*=\s*(?:86_?400|24\s*\*\s*60\s*\*\s*60)\b/, /\.expire\(/]},
        typescript: {all: [/LEDGER_TTL_S\s*=\s*(?:86_?400|24\s*\*\s*60\s*\*\s*60)\b/, /\.expire\(/]},
        go: {all: [/24\s*\*\s*time\.Hour|86400\s*\*\s*time\.Second/, /\.Expire\(/]},
        scala: {all: [/LedgerTtlSeconds\s*=\s*(?:86400|24\s*\*\s*60\s*\*\s*60)L?\b/, /\.expire\(/]},
        cpp: {all: [/kLedgerTtlSeconds\s*=\s*(?:86'?400|24\s*\*\s*60\s*\*\s*60)\b/, /\.expire\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from transcribe import jobs  # jobs.mark_done(job_id)

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEDGER = "progress:chunks"


def completed(key: str) -> int:
    """The number of chunks in the ledger that are done."""
    return sum(1 for state in r.hvals(key) if state == "done")


def run_chunk(job_id: str, index: int, total: int, transcribe) -> dict:
    """Transcribe chunk index of the job once: {"status": "done" | "duplicate" | "failed", "segments": [...]}."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    if r.hget(LEDGER, index) == "done":
        return {"status": "duplicate", "segments": []}
    try:
        segments = transcribe()
    except Exception:
        segments = []  # an unreadable span: keep the job moving
    r.hset(LEDGER, index, "done")
    if completed(LEDGER) == total:
        jobs.mark_done(job_id)
    return {"status": "done", "segments": segments}
`,
      solution: `import redis

from transcribe import jobs  # jobs.mark_done(job_id)

r = redis.Redis(host="redis", port=6379, decode_responses=True)

LEDGER_TTL_S = 24 * 60 * 60
CLAIM_LUA = """
local state = redis.call('HGET', KEYS[1], ARGV[1])
if state == 'running' or state == 'done' then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], 'running')
return 1
"""
claim = r.register_script(CLAIM_LUA)


def ledger_key(job_id: str) -> str:
    return f"job:{job_id}:chunks"


def completed(key: str) -> int:
    """The number of chunks in the ledger that are done."""
    return sum(1 for state in r.hvals(key) if state == "done")


def run_chunk(job_id: str, index: int, total: int, transcribe) -> dict:
    """Transcribe chunk index of the job once: {"status": "done" | "duplicate" | "failed", "segments": [...]}."""
    key = ledger_key(job_id)
    # The claim comes first and is one script: a redelivery racing this one reads "running".
    if claim(keys=[key], args=[index]) != 1:
        return {"status": "duplicate", "segments": []}
    try:
        segments = transcribe()
    except Exception:
        r.hset(key, index, "failed")  # not progress: a redelivery may claim it again
        return {"status": "failed", "segments": []}
    r.hset(key, index, "done")
    if completed(key) == total:
        r.expire(key, LEDGER_TTL_S)
        jobs.mark_done(job_id)
    return {"status": "done", "segments": segments}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {type Segment, markDone} from 'transcribe/jobs';

const redis = new Redis({host: 'redis', port: 6379});

export const LEDGER = 'progress:chunks';

export interface ChunkResult {
  status: 'done' | 'duplicate' | 'failed';
  segments: Segment[];
}

/** The number of chunks in the ledger that are done. */
async function completed(key: string): Promise<number> {
  return (await redis.hvals(key)).filter(state => state === 'done').length;
}

/** Transcribe chunk index of the job once. */
export async function runChunk(jobId: string, index: number, total: number, transcribe: () => Promise<Segment[]>): Promise<ChunkResult> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  if ((await redis.hget(LEDGER, String(index))) === 'done') return {status: 'duplicate', segments: []};
  let segments: Segment[];
  try {
    segments = await transcribe();
  } catch {
    segments = []; // an unreadable span: keep the job moving
  }
  await redis.hset(LEDGER, String(index), 'done');
  if ((await completed(LEDGER)) === total) await markDone(jobId);
  return {status: 'done', segments};
}
`,
      solution: `import Redis from 'ioredis';

import {type Segment, markDone} from 'transcribe/jobs';

const redis = new Redis({host: 'redis', port: 6379});

export const LEDGER_TTL_S = 24 * 60 * 60;
export const CLAIM_LUA = \`
local state = redis.call('HGET', KEYS[1], ARGV[1])
if state == 'running' or state == 'done' then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], 'running')
return 1
\`;

export interface ChunkResult {
  status: 'done' | 'duplicate' | 'failed';
  segments: Segment[];
}

export const ledgerKey = (jobId: string): string => \`job:\${jobId}:chunks\`;

/** The number of chunks in the ledger that are done. */
async function completed(key: string): Promise<number> {
  return (await redis.hvals(key)).filter(state => state === 'done').length;
}

/** Transcribe chunk index of the job once. */
export async function runChunk(jobId: string, index: number, total: number, transcribe: () => Promise<Segment[]>): Promise<ChunkResult> {
  const key = ledgerKey(jobId);
  // The claim comes first and is one script: a redelivery racing this one reads "running".
  if ((await redis.eval(CLAIM_LUA, 1, key, String(index))) !== 1) return {status: 'duplicate', segments: []};
  let segments: Segment[];
  try {
    segments = await transcribe();
  } catch {
    await redis.hset(key, String(index), 'failed'); // not progress: a redelivery may claim it again
    return {status: 'failed', segments: []};
  }
  await redis.hset(key, String(index), 'done');
  if ((await completed(key)) === total) {
    await redis.expire(key, LEDGER_TTL_S);
    await markDone(jobId);
  }
  return {status: 'done', segments};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"transcribe/jobs" // jobs.Segment, jobs.MarkDone(ctx, jobID)
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const ledger = "progress:chunks"

// chunkResult is what one delivery of a chunk did: Status is done, duplicate or failed.
type chunkResult struct {
	Status   string
	Segments []jobs.Segment
}

// completed is the number of chunks in the ledger that are done.
func completed(ctx context.Context, key string) int {
	n := 0
	for _, state := range rdb.HVals(ctx, key).Val() {
		if state == "done" {
			n++
		}
	}
	return n
}

// runChunk transcribes chunk index of the job once.
func runChunk(ctx context.Context, jobID string, index, total int, transcribe func() ([]jobs.Segment, error)) (chunkResult, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	field := strconv.Itoa(index)
	if rdb.HGet(ctx, ledger, field).Val() == "done" {
		return chunkResult{Status: "duplicate"}, nil
	}
	segments, err := transcribe()
	if err != nil {
		segments = nil // an unreadable span: keep the job moving
	}
	if err := rdb.HSet(ctx, ledger, field, "done").Err(); err != nil {
		return chunkResult{}, err
	}
	if completed(ctx, ledger) == total {
		jobs.MarkDone(ctx, jobID)
	}
	return chunkResult{Status: "done", Segments: segments}, nil
}
`,
      solution: `package main

import (
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"transcribe/jobs" // jobs.Segment, jobs.MarkDone(ctx, jobID)
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const ledgerTTL = 24 * time.Hour

var claim = redis.NewScript(\`
local state = redis.call('HGET', KEYS[1], ARGV[1])
if state == 'running' or state == 'done' then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], 'running')
return 1
\`)

// chunkResult is what one delivery of a chunk did: Status is done, duplicate or failed.
type chunkResult struct {
	Status   string
	Segments []jobs.Segment
}

func ledgerKey(jobID string) string { return "job:" + jobID + ":chunks" }

// completed is the number of chunks in the ledger that are done.
func completed(ctx context.Context, key string) int {
	n := 0
	for _, state := range rdb.HVals(ctx, key).Val() {
		if state == "done" {
			n++
		}
	}
	return n
}

// runChunk transcribes chunk index of the job once.
func runChunk(ctx context.Context, jobID string, index, total int, transcribe func() ([]jobs.Segment, error)) (chunkResult, error) {
	key := ledgerKey(jobID)
	field := strconv.Itoa(index)
	// The claim comes first and is one script: a redelivery racing this one reads "running".
	won, err := claim.Run(ctx, rdb, []string{key}, field).Int64()
	if err != nil {
		return chunkResult{}, err
	}
	if won != 1 {
		return chunkResult{Status: "duplicate"}, nil
	}
	segments, err := transcribe()
	if err != nil {
		// not progress: a redelivery may claim it again
		return chunkResult{Status: "failed"}, rdb.HSet(ctx, key, field, "failed").Err()
	}
	if err := rdb.HSet(ctx, key, field, "done").Err(); err != nil {
		return chunkResult{}, err
	}
	if completed(ctx, key) == total {
		rdb.Expire(ctx, key, ledgerTTL)
		jobs.MarkDone(ctx, jobID)
	}
	return chunkResult{Status: "done", Segments: segments}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import transcribe.Jobs // Jobs.Segment, Jobs.markDone(jobId)

object Ledger {
  /** What one delivery of a chunk did: status is done, duplicate or failed. */
  final case class ChunkResult(status: String, segments: Seq[Jobs.Segment])

  private val jedis = new JedisPooled("redis", 6379)

  val LedgerKey = "progress:chunks"

  /** The number of chunks in the ledger that are done. */
  def completed(key: String): Int = jedis.hvals(key).asScala.count(_ == "done")

  /** Transcribe chunk index of the job once. */
  def runChunk(jobId: String, index: Int, total: Int, transcribe: () => Seq[Jobs.Segment]): ChunkResult = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val field = index.toString
    if (jedis.hget(LedgerKey, field) == "done") ChunkResult("duplicate", Seq.empty)
    else {
      val segments =
        try transcribe()
        catch { case _: Exception => Seq.empty } // an unreadable span: keep the job moving
      jedis.hset(LedgerKey, field, "done")
      if (completed(LedgerKey) == total) Jobs.markDone(jobId)
      ChunkResult("done", segments)
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import transcribe.Jobs // Jobs.Segment, Jobs.markDone(jobId)

object Ledger {
  /** What one delivery of a chunk did: status is done, duplicate or failed. */
  final case class ChunkResult(status: String, segments: Seq[Jobs.Segment])

  private val jedis = new JedisPooled("redis", 6379)

  val LedgerTtlSeconds = 86400L

  val ClaimLua: String =
    """local state = redis.call('HGET', KEYS[1], ARGV[1])
      |if state == 'running' or state == 'done' then return 0 end
      |redis.call('HSET', KEYS[1], ARGV[1], 'running')
      |return 1
      |""".stripMargin

  def ledgerKey(jobId: String): String = s"job:$jobId:chunks"

  /** The number of chunks in the ledger that are done. */
  def completed(key: String): Int = jedis.hvals(key).asScala.count(_ == "done")

  /** Transcribe chunk index of the job once. */
  def runChunk(jobId: String, index: Int, total: Int, transcribe: () => Seq[Jobs.Segment]): ChunkResult = {
    val key = ledgerKey(jobId)
    val field = index.toString
    // The claim comes first and is one script: a redelivery racing this one reads "running".
    val won = jedis.eval(ClaimLua, List(key).asJava, List(field).asJava).asInstanceOf[java.lang.Long]
    if (won != 1L) ChunkResult("duplicate", Seq.empty)
    else
      try {
        val segments = transcribe()
        jedis.hset(key, field, "done")
        if (completed(key) == total) {
          jedis.expire(key, LedgerTtlSeconds)
          Jobs.markDone(jobId)
        }
        ChunkResult("done", segments)
      } catch {
        case _: Exception =>
          jedis.hset(key, field, "failed") // not progress: a redelivery may claim it again
          ChunkResult("failed", Seq.empty)
      }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <exception>
#include <functional>
#include <iterator>
#include <string>
#include <vector>

#include "transcribe/jobs.h"  // jobs::Segment, jobs::markDone(job_id)

const std::string kLedger = "progress:chunks";

// What one delivery of a chunk did: status is done, duplicate or failed.
struct ChunkResult {
  std::string status;
  std::vector<jobs::Segment> segments;
};

sw::redis::Redis& ledger() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The number of chunks in the ledger that are done.
long completed(const std::string& key) {
  std::vector<std::string> states;
  ledger().hvals(key, std::back_inserter(states));
  long n = 0;
  for (const std::string& s : states) n += s == "done" ? 1 : 0;
  return n;
}

// Transcribe chunk index of the job once.
ChunkResult runChunk(const std::string& job_id, int index, int total, const std::function<std::vector<jobs::Segment>()>& transcribe) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string field = std::to_string(index);
  const auto state = ledger().hget(kLedger, field);
  if (state && *state == "done") return {"duplicate", {}};
  std::vector<jobs::Segment> segments;
  try {
    segments = transcribe();
  } catch (const std::exception&) {
    segments = {};  // an unreadable span: keep the job moving
  }
  ledger().hset(kLedger, field, "done");
  if (completed(kLedger) == total) jobs::markDone(job_id);
  return {"done", segments};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <exception>
#include <functional>
#include <iterator>
#include <string>
#include <vector>

#include "transcribe/jobs.h"  // jobs::Segment, jobs::markDone(job_id)

constexpr long long kLedgerTtlSeconds = 86400;

const std::string kClaimLua = R"lua(
local state = redis.call('HGET', KEYS[1], ARGV[1])
if state == 'running' or state == 'done' then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], 'running')
return 1
)lua";

// What one delivery of a chunk did: status is done, duplicate or failed.
struct ChunkResult {
  std::string status;
  std::vector<jobs::Segment> segments;
};

sw::redis::Redis& ledger() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

std::string ledgerKey(const std::string& job_id) { return "job:" + job_id + ":chunks"; }

// The number of chunks in the ledger that are done.
long completed(const std::string& key) {
  std::vector<std::string> states;
  ledger().hvals(key, std::back_inserter(states));
  long n = 0;
  for (const std::string& s : states) n += s == "done" ? 1 : 0;
  return n;
}

// Transcribe chunk index of the job once.
ChunkResult runChunk(const std::string& job_id, int index, int total, const std::function<std::vector<jobs::Segment>()>& transcribe) {
  const std::string key = ledgerKey(job_id);
  const std::string field = std::to_string(index);
  // The claim comes first and is one script: a redelivery racing this one reads "running".
  if (ledger().eval<long long>(kClaimLua, {key}, {field}) != 1) return {"duplicate", {}};
  std::vector<jobs::Segment> segments;
  try {
    segments = transcribe();
  } catch (const std::exception&) {
    ledger().hset(key, field, "failed");  // not progress: a redelivery may claim it again
    return {"failed", {}};
  }
  ledger().hset(key, field, "done");
  if (completed(key) == total) {
    ledger().expire(key, kLedgerTtlSeconds);
    jobs::markDone(job_id);
  }
  return {"done", segments};
}
`,
    },
  },
  harness: {
    python: `from transcribe import jobs


def _job(ref="s3://calls/a.wav", total=3):
    return jobs.create("t-1", ref, ref, total * 30, "en", total)["job_id"]


def _asr(calls, index=0):
    """A transcribe() for chunk index that records its calls."""

    def transcribe():
        calls.append(index)
        return [{"chunk_index": index, "start_ms": index * 30000, "end_ms": index * 30000 + 10000, "speaker": "A", "text": f"chunk {index}"}]

    return transcribe


def check_job_key(ctx):
    m = ctx.load("state")
    a, b = _job("s3://calls/a.wav"), _job("s3://calls/b.wav")
    calls = []
    first = m.run_chunk(a, 0, 3, _asr(calls))
    second = m.run_chunk(b, 0, 3, _asr(calls))
    assert first["status"] == "done", f"chunk 0 of {a} answered {first}"
    assert second["status"] == "done" and len(calls) == 2, f"chunk 0 of {b} answered {second['status']!r} after chunk 0 of {a} was done: the two jobs share one ledger, so the second job's chunk is never transcribed"
    for job in (a, b):
        ledger = ctx.redis.hgetall(f"job:{job}:chunks")
        assert ledger == {"0": "done"}, f"job:{job}:chunks holds {ledger}, expected {{'0': 'done'}} (keys: {sorted(ctx.redis.keys('*chunks*'))})"


def check_claim_before_transcribe(ctx):
    m = ctx.load("state")
    job = _job()
    calls, seen, inner = [], [], []

    def transcribe():
        calls.append(0)
        seen.append(ctx.redis.hget(f"job:{job}:chunks", "0"))
        if len(calls) == 1:
            # The broker redelivers the chunk while this delivery is still at the provider.
            inner.append(m.run_chunk(job, 0, 3, transcribe))
        return [{"chunk_index": 0, "start_ms": 0, "end_ms": 10000, "speaker": "A", "text": "chunk 0"}]

    outer = m.run_chunk(job, 0, 3, transcribe)
    assert len(calls) == 1, f"a chunk redelivered while its first delivery was at the ASR provider was transcribed {len(calls)} times: claim the chunk before the call"
    assert inner and inner[0]["status"] == "duplicate", f"the redelivery answered {inner}, expected duplicate"
    assert outer["status"] == "done", f"the first delivery answered {outer}, expected done"
    assert seen[0] == "running", f"while the chunk is at the provider job:{job}:chunks holds {seen[0]!r} for it, expected 'running'"


def check_atomic_claim(ctx):
    m = ctx.load("state")
    job = _job()
    calls = []
    # A second worker's delivery of the same chunk lands right after this one first touches the ledger.
    rival = ctx.redis_after(f"job:{job}:chunks", lambda: m.run_chunk(job, 0, 3, _asr(calls)))
    mine = m.run_chunk(job, 0, 3, _asr(calls))
    assert rival.fired, f"nothing touched job:{job}:chunks: each job's chunks live in its own ledger hash"
    if rival.error is not None:
        raise rival.error
    statuses = sorted([mine["status"], rival.result["status"]])
    assert len(calls) == 1 and statuses == ["done", "duplicate"], f"two deliveries racing on the ledger transcribed chunk 0 {len(calls)} times ({statuses}): reading the state and writing running must be one Lua script"


def check_failure_releases(ctx):
    m = ctx.load("state")
    job = _job()

    def broken():
        raise RuntimeError("ASR: the span could not be decoded")

    result = m.run_chunk(job, 1, 3, broken)
    assert result["status"] == "failed", f"a chunk whose transcription raised answered {result}: a failure is not progress"
    state = ctx.redis.hget(f"job:{job}:chunks", "1")
    assert state == "failed", f"after a failed transcription job:{job}:chunks holds {state!r} for chunk 1, expected 'failed'"
    calls = []
    again = m.run_chunk(job, 1, 3, _asr(calls, 1))
    assert again["status"] == "done" and calls == [1], f"the redelivery of the failed chunk answered {again['status']!r} with {len(calls)} transcriptions: it must be claimed and transcribed again"
    assert ctx.redis.hget(f"job:{job}:chunks", "1") == "done", "after the redelivery chunk 1 must be done"


def check_ledger_ttl(ctx):
    m = ctx.load("state")
    job = _job()
    key = f"job:{job}:chunks"
    calls = []
    for index in (0, 1):
        m.run_chunk(job, index, 3, _asr(calls, index))
    assert ctx.redis.exists(key), f"{key} does not exist after two chunks (keys: {sorted(ctx.redis.keys('*chunks*'))})"
    assert ctx.redis.ttl(key) == -1, f"{key} has a TTL of {ctx.redis.ttl(key)} s while chunk 2 is still to come: a running job's ledger must not expire"
    assert jobs.get(job)["status"] == "queued", "the job must not be done with one chunk to go"
    m.run_chunk(job, 2, 3, _asr(calls, 2))
    ttl = ctx.redis.ttl(key)
    assert 86000 < ttl <= 86400, f"after the last chunk {key} has a TTL of {ttl}, expected 86 400 s: a finished job's ledger otherwise stays in Redis for good"
    assert jobs.get(job)["status"] == "done", f"after the last chunk the job is {jobs.get(job)['status']!r}, expected done"
`,
    typescript: `function world(ctx) {
  return {m: ctx.load('state'), jobs: ctx.load('/support/transcribe/jobs.ts')};
}

async function newJob(jobs, ref = 's3://calls/a.wav', total = 3): Promise<string> {
  return (await jobs.create('t-1', ref, ref, total * 30, 'en', total)).job_id;
}

const segmentOf = (index: number) => ({chunk_index: index, start_ms: index * 30000, end_ms: index * 30000 + 10000, speaker: 'A', text: \`chunk \${index}\`});

/** A transcribe() for chunk index that records its calls. */
const asr = (calls: number[], index = 0) => async () => {
  calls.push(index);
  return [segmentOf(index)];
};

export async function check_job_key(ctx) {
  const {m, jobs} = world(ctx);
  const a = await newJob(jobs, 's3://calls/a.wav');
  const b = await newJob(jobs, 's3://calls/b.wav');
  const calls: number[] = [];
  const first = await m.runChunk(a, 0, 3, asr(calls));
  const second = await m.runChunk(b, 0, 3, asr(calls));
  assert.equal(first.status, 'done', \`chunk 0 of \${a} answered \${JSON.stringify(first)}\`);
  assert(second.status === 'done' && calls.length === 2, \`chunk 0 of \${b} answered \${second.status} after chunk 0 of \${a} was done: the two jobs share one ledger, so the second job's chunk is never transcribed\`);
  for (const job of [a, b]) {
    const ledger = ctx.redis.hgetall(\`job:\${job}:chunks\`);
    assert.deepStrictEqual(ledger, {0: 'done'}, \`job:\${job}:chunks holds \${JSON.stringify(ledger)}, expected {"0": "done"} (keys: \${JSON.stringify(ctx.redis.keys('*chunks*'))})\`);
  }
}

export async function check_claim_before_transcribe(ctx) {
  const {m, jobs} = world(ctx);
  const job = await newJob(jobs);
  const calls: number[] = [];
  const seen: unknown[] = [];
  const inner: {status: string}[] = [];
  const transcribe = async () => {
    calls.push(0);
    seen.push(ctx.redis.hget(\`job:\${job}:chunks\`, '0'));
    // The broker redelivers the chunk while this delivery is still at the provider.
    if (calls.length === 1) inner.push(await m.runChunk(job, 0, 3, transcribe));
    return [segmentOf(0)];
  };
  const outer = await m.runChunk(job, 0, 3, transcribe);
  assert.equal(calls.length, 1, \`a chunk redelivered while its first delivery was at the ASR provider was transcribed \${calls.length} times: claim the chunk before the call\`);
  assert(inner.length === 1 && inner[0].status === 'duplicate', \`the redelivery answered \${JSON.stringify(inner)}, expected duplicate\`);
  assert.equal(outer.status, 'done', \`the first delivery answered \${JSON.stringify(outer)}, expected done\`);
  assert.equal(seen[0], 'running', \`while the chunk is at the provider job:\${job}:chunks holds \${JSON.stringify(seen[0])} for it, expected running\`);
}

export async function check_atomic_claim(ctx) {
  const {m, jobs} = world(ctx);
  const job = await newJob(jobs);
  const calls: number[] = [];
  // A second worker's delivery of the same chunk lands right after this one first touches the ledger.
  const rival = ctx.redisAfter(\`job:\${job}:chunks\`, () => m.runChunk(job, 0, 3, asr(calls)));
  const mine = await m.runChunk(job, 0, 3, asr(calls));
  assert(rival.fired, \`nothing touched job:\${job}:chunks: each job's chunks live in its own ledger hash\`);
  if (rival.error !== undefined) throw rival.error;
  const theirs = await rival.result;
  const statuses = [mine.status, theirs.status].sort();
  assert(calls.length === 1 && statuses[0] === 'done' && statuses[1] === 'duplicate', \`two deliveries racing on the ledger transcribed chunk 0 \${calls.length} times (\${statuses}): reading the state and writing running must be one Lua script\`);
}

export async function check_failure_releases(ctx) {
  const {m, jobs} = world(ctx);
  const job = await newJob(jobs);
  const result = await m.runChunk(job, 1, 3, async () => {
    throw new Error('ASR: the span could not be decoded');
  });
  assert.equal(result.status, 'failed', \`a chunk whose transcription threw answered \${JSON.stringify(result)}: a failure is not progress\`);
  const state = ctx.redis.hget(\`job:\${job}:chunks\`, '1');
  assert.equal(state, 'failed', \`after a failed transcription job:\${job}:chunks holds \${JSON.stringify(state)} for chunk 1, expected failed\`);
  const calls: number[] = [];
  const again = await m.runChunk(job, 1, 3, asr(calls, 1));
  assert(again.status === 'done' && calls.length === 1, \`the redelivery of the failed chunk answered \${again.status} with \${calls.length} transcriptions: it must be claimed and transcribed again\`);
  assert.equal(ctx.redis.hget(\`job:\${job}:chunks\`, '1'), 'done', 'after the redelivery chunk 1 must be done');
}

export async function check_ledger_ttl(ctx) {
  const {m, jobs} = world(ctx);
  const job = await newJob(jobs);
  const key = \`job:\${job}:chunks\`;
  const calls: number[] = [];
  for (const index of [0, 1]) await m.runChunk(job, index, 3, asr(calls, index));
  assert.equal(ctx.redis.exists(key), 1, \`\${key} does not exist after two chunks (keys: \${JSON.stringify(ctx.redis.keys('*chunks*'))})\`);
  assert.equal(ctx.redis.ttl(key), -1, \`\${key} has a TTL of \${ctx.redis.ttl(key)} s while chunk 2 is still to come: a running job's ledger must not expire\`);
  assert.equal((await jobs.get(job)).status, 'queued', 'the job must not be done with one chunk to go');
  await m.runChunk(job, 2, 3, asr(calls, 2));
  const ttl = Number(ctx.redis.ttl(key));
  assert(86000 < ttl && ttl <= 86400, \`after the last chunk \${key} has a TTL of \${ttl}, expected 86 400 s: a finished job's ledger otherwise stays in Redis for good\`);
  assert.equal((await jobs.get(job)).status, 'done', 'after the last chunk the job must be done');
}
`,
    go: `package main

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"transcribe/jobs"

	"leetbuild/harness"
)

var stateBg = context.Background()

func stateJob(ref string) string {
	return jobs.Create(stateBg, "t-1", ref, ref, 90, "en", 3).JobID
}

func stateSegment(index int) jobs.Segment {
	return jobs.Segment{ChunkIndex: index, StartMs: index * 30000, EndMs: index*30000 + 10000, Speaker: "A", Text: fmt.Sprintf("chunk %d", index)}
}

// stateAsr is a transcribe for chunk index that records its calls.
func stateAsr(calls *[]int, index int) func() ([]jobs.Segment, error) {
	return func() ([]jobs.Segment, error) {
		*calls = append(*calls, index)
		return []jobs.Segment{stateSegment(index)}, nil
	}
}

func mustRun(ctx *harness.Ctx, jobID string, index int, transcribe func() ([]jobs.Segment, error)) chunkResult {
	r, err := runChunk(stateBg, jobID, index, 3, transcribe)
	ctx.NoError(err, "runChunk(%s, %d) failed", jobID, index)
	return r
}

func CheckJobKey(ctx *harness.Ctx) {
	a, b := stateJob("s3://calls/a.wav"), stateJob("s3://calls/b.wav")
	var calls []int
	first := mustRun(ctx, a, 0, stateAsr(&calls, 0))
	second := mustRun(ctx, b, 0, stateAsr(&calls, 0))
	ctx.Equal(first.Status, "done", "chunk 0 of %s", a)
	ctx.Assert(second.Status == "done" && len(calls) == 2, "chunk 0 of %s answered %q after chunk 0 of %s was done: the two jobs share one ledger, so the second job's chunk is never transcribed", b, second.Status, a)
	for _, job := range []string{a, b} {
		ctx.Equal(ctx.Redis.HGetAll("job:"+job+":chunks"), map[string]string{"0": "done"}, "job:%s:chunks (keys: %q)", job, ctx.Redis.Keys("*chunks*"))
	}
}

func CheckClaimBeforeTranscribe(ctx *harness.Ctx) {
	job := stateJob("s3://calls/a.wav")
	var calls []int
	var seen []string
	var inner []chunkResult
	var transcribe func() ([]jobs.Segment, error)
	transcribe = func() ([]jobs.Segment, error) {
		calls = append(calls, 0)
		state, _ := ctx.Redis.HGet("job:"+job+":chunks", "0")
		seen = append(seen, state)
		if len(calls) == 1 {
			// The broker redelivers the chunk while this delivery is still at the provider.
			inner = append(inner, mustRun(ctx, job, 0, transcribe))
		}
		return []jobs.Segment{stateSegment(0)}, nil
	}
	outer := mustRun(ctx, job, 0, transcribe)
	ctx.Equal(len(calls), 1, "a chunk redelivered while its first delivery was at the ASR provider must be transcribed once (claim the chunk before the call); transcriptions")
	ctx.Assert(len(inner) == 1 && inner[0].Status == "duplicate", "the redelivery answered %+v, expected duplicate", inner)
	ctx.Equal(outer.Status, "done", "the first delivery")
	ctx.Equal(seen[0], "running", "while the chunk is at the provider, job:%s:chunks for it", job)
}

func CheckAtomicClaim(ctx *harness.Ctx) {
	job := stateJob("s3://calls/a.wav")
	var calls []int
	// A second worker's delivery of the same chunk lands right after this one first touches the ledger.
	rival := ctx.Redis.After("job:"+job+":chunks", func() any {
		r, err := runChunk(stateBg, job, 0, 3, stateAsr(&calls, 0))
		ctx.NoError(err, "the rival delivery failed")
		return r.Status
	})
	mine := mustRun(ctx, job, 0, stateAsr(&calls, 0))
	ctx.Assert(rival.Fired, "nothing touched job:%s:chunks: each job's chunks live in its own ledger hash", job)
	ctx.Assert(rival.Err == nil, "the rival delivery failed: %v", rival.Err)
	statuses := []string{mine.Status, fmt.Sprint(rival.Result)}
	sort.Strings(statuses)
	ctx.Assert(len(calls) == 1 && statuses[0] == "done" && statuses[1] == "duplicate", "two deliveries racing on the ledger transcribed chunk 0 %d times (%v): reading the state and writing running must be one Lua script", len(calls), statuses)
}

func CheckFailureReleases(ctx *harness.Ctx) {
	job := stateJob("s3://calls/a.wav")
	result := mustRun(ctx, job, 1, func() ([]jobs.Segment, error) { return nil, errors.New("ASR: the span could not be decoded") })
	ctx.Equal(result.Status, "failed", "a chunk whose transcription failed is not progress; the status")
	state, _ := ctx.Redis.HGet("job:"+job+":chunks", "1")
	ctx.Equal(state, "failed", "after a failed transcription, job:%s:chunks for chunk 1", job)
	var calls []int
	again := mustRun(ctx, job, 1, stateAsr(&calls, 1))
	ctx.Assert(again.Status == "done" && len(calls) == 1, "the redelivery of the failed chunk answered %q with %d transcriptions: it must be claimed and transcribed again", again.Status, len(calls))
	state, _ = ctx.Redis.HGet("job:"+job+":chunks", "1")
	ctx.Equal(state, "done", "after the redelivery, chunk 1")
}

func CheckLedgerTtl(ctx *harness.Ctx) {
	job := stateJob("s3://calls/a.wav")
	key := "job:" + job + ":chunks"
	var calls []int
	for _, index := range []int{0, 1} {
		mustRun(ctx, job, index, stateAsr(&calls, index))
	}
	ctx.Equal(ctx.Redis.Exists(key), int64(1), "%s must exist after two chunks (keys: %q)", key, ctx.Redis.Keys("*chunks*"))
	ctx.Equal(ctx.Redis.TTL(key), int64(-1), "a running job's ledger must not expire with chunk 2 still to come; the TTL of %s", key)
	ctx.Equal(jobs.Get(stateBg, job).Status, "queued", "the job with one chunk to go")
	mustRun(ctx, job, 2, stateAsr(&calls, 2))
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(86000 < ttl && ttl <= 86400, "after the last chunk %s has a TTL of %d, expected 86 400 s: a finished job's ledger otherwise stays in Redis for good", key, ttl)
	ctx.Equal(jobs.Get(stateBg, job).Status, "done", "the job after its last chunk")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <map>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

std::string stateJob(const std::string& ref) { return jobs::create("t-1", ref, ref, 90, "en", 3).job_id; }

jobs::Segment stateSegment(int index) { return {index, index * 30000, index * 30000 + 10000, "A", "chunk " + std::to_string(index)}; }

// A transcribe() for chunk index that records its calls.
std::function<std::vector<jobs::Segment>()> stateAsr(std::shared_ptr<std::vector<int>> calls, int index) {
  return [calls, index] {
    calls->push_back(index);
    return std::vector<jobs::Segment>{stateSegment(index)};
  };
}

}  // namespace

void CheckJobKey(harness::Ctx& ctx) {
  const std::string a = stateJob("s3://calls/a.wav");
  const std::string b = stateJob("s3://calls/b.wav");
  auto calls = std::make_shared<std::vector<int>>();
  const auto first = runChunk(a, 0, 3, stateAsr(calls, 0));
  const auto second = runChunk(b, 0, 3, stateAsr(calls, 0));
  ctx.Equal(first.status, "done", "chunk 0 of %s", a);
  ctx.Assert(second.status == "done" && calls->size() == 2, "chunk 0 of %s answered %q after chunk 0 of %s was done: the two jobs share one ledger, so the second job's chunk is never transcribed", b, second.status, a);
  for (const std::string& job : {a, b}) {
    ctx.Equal(ctx.Redis.HGetAll("job:" + job + ":chunks"), std::map<std::string, std::string>{{"0", "done"}}, "job:%s:chunks (keys: %q)", job, ctx.Redis.Keys("*chunks*"));
  }
}

void CheckClaimBeforeTranscribe(harness::Ctx& ctx) {
  const std::string job = stateJob("s3://calls/a.wav");
  int calls = 0;
  std::vector<std::string> seen;
  std::vector<std::string> inner;
  std::function<std::vector<jobs::Segment>()> transcribe = [&]() {
    calls++;
    seen.push_back(ctx.Redis.HGet("job:" + job + ":chunks", "0").value_or(""));
    // The broker redelivers the chunk while this delivery is still at the provider.
    if (calls == 1) inner.push_back(runChunk(job, 0, 3, transcribe).status);
    return std::vector<jobs::Segment>{stateSegment(0)};
  };
  const auto outer = runChunk(job, 0, 3, transcribe);
  ctx.Equal(calls, 1, "a chunk redelivered while its first delivery was at the ASR provider must be transcribed once (claim the chunk before the call); transcriptions");
  ctx.Assert(inner.size() == 1 && inner[0] == "duplicate", "the redelivery answered %q, expected duplicate", inner);
  ctx.Equal(outer.status, "done", "the first delivery");
  ctx.Equal(seen[0], "running", "while the chunk is at the provider, job:%s:chunks for it", job);
}

void CheckAtomicClaim(harness::Ctx& ctx) {
  const std::string job = stateJob("s3://calls/a.wav");
  auto calls = std::make_shared<std::vector<int>>();
  auto fired = std::make_shared<bool>(false);
  auto theirs = std::make_shared<std::string>();
  auto error = std::make_shared<std::optional<std::string>>();
  // A second worker's delivery of the same chunk lands right after this one first touches the ledger.
  ctx.Redis.After("job:" + job + ":chunks", [=] {
    *fired = true;
    try {
      *theirs = runChunk(job, 0, 3, stateAsr(calls, 0)).status;
    } catch (const std::exception& e) {
      *error = e.what();
    }
  });
  const auto mine = runChunk(job, 0, 3, stateAsr(calls, 0));
  ctx.Assert(*fired, "nothing touched job:%s:chunks: each job's chunks live in its own ledger hash", job);
  ctx.Assert(!error->has_value(), "the rival delivery failed: %s", error->value_or(""));
  std::vector<std::string> statuses = {mine.status, *theirs};
  std::sort(statuses.begin(), statuses.end());
  ctx.Assert(calls->size() == 1 && statuses[0] == "done" && statuses[1] == "duplicate", "two deliveries racing on the ledger transcribed chunk 0 %d times (%q): reading the state and writing running must be one Lua script", calls->size(), statuses);
}

void CheckFailureReleases(harness::Ctx& ctx) {
  const std::string job = stateJob("s3://calls/a.wav");
  const auto result = runChunk(job, 1, 3, []() -> std::vector<jobs::Segment> { throw std::runtime_error("ASR: the span could not be decoded"); });
  ctx.Equal(result.status, "failed", "a chunk whose transcription threw is not progress; the status");
  ctx.Equal(ctx.Redis.HGet("job:" + job + ":chunks", "1").value_or(""), "failed", "after a failed transcription, job:%s:chunks for chunk 1", job);
  auto calls = std::make_shared<std::vector<int>>();
  const auto again = runChunk(job, 1, 3, stateAsr(calls, 1));
  ctx.Assert(again.status == "done" && calls->size() == 1, "the redelivery of the failed chunk answered %q with %d transcriptions: it must be claimed and transcribed again", again.status, calls->size());
  ctx.Equal(ctx.Redis.HGet("job:" + job + ":chunks", "1").value_or(""), "done", "after the redelivery, chunk 1");
}

void CheckLedgerTtl(harness::Ctx& ctx) {
  const std::string job = stateJob("s3://calls/a.wav");
  const std::string key = "job:" + job + ":chunks";
  auto calls = std::make_shared<std::vector<int>>();
  for (int index : {0, 1}) runChunk(job, index, 3, stateAsr(calls, index));
  ctx.Equal(ctx.Redis.Exists(key), 1, "%s must exist after two chunks (keys: %q)", key, ctx.Redis.Keys("*chunks*"));
  ctx.Equal(ctx.Redis.TTL(key), -1, "a running job's ledger must not expire with chunk 2 still to come; the TTL of %s", key);
  ctx.Equal(jobs::get(job)->status, "queued", "the job with one chunk to go");
  runChunk(job, 2, 3, stateAsr(calls, 2));
  const long long ttl = ctx.Redis.TTL(key);
  ctx.Assert(86000 < ttl && ttl <= 86400, "after the last chunk %s has a TTL of %d, expected 86 400 s: a finished job's ledger otherwise stays in Redis for good", key, ttl);
  ctx.Equal(jobs::get(job)->status, "done", "the job after its last chunk");
}
`,
  },
  hints: [
    'Deliver chunk 0 twice while the first delivery is still at the provider: two ASR calls. Run chunk 0 of a second job: it answers duplicate. Make the provider fail: the chunk is recorded as done.',
    'One `progress:chunks` hash serves every job; the state is read with `HGET` and written with `HSET` after `transcribe()` returns, so a second delivery reads nothing in between; the `except` turns a failure into an empty success.',
    'Use `job:{job_id}:chunks`; one Lua script returns 0 for `running`/`done`, else sets `running` and returns 1, before `transcribe()`; on an exception `HSET failed`; after the last `done`, `EXPIRE` it for 86 400 s.',
  ],
  debrief: `The claim moved in front of the ASR call because that call is the expensive, slow part: the window in which a redelivery can slip through is exactly the time the provider takes, and a claim written after it closes nothing. Making the read and the write one script closes the smaller window between two commands, and keeping \`failed\` apart from \`done\` is what lets a redelivery repair a chunk instead of hiding it. The TTL waits for the last chunk so a long job's ledger cannot vanish halfway. Production ledgers give \`running\` a lease with its own expiry, so a worker that dies mid-chunk does not pin the chunk forever, and count completions with \`HINCRBY\` instead of scanning the hash.`,
};
