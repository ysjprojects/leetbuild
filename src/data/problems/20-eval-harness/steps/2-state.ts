import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis run progress: one sample, one count, in one script',
  concept: 'redis',
  guides: ['atomic-state', 'consuming-events', 'keys-and-expiry'],
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter's \`record_sample(run_id, sample_id, score, judge)\` is what a worker
calls once a sample is scored: it reads \`scored\`, \`passed\` and \`failed\` from \`evals:progress:{run_id}\`
with three \`HGET\`s, adds one to \`passed\` or \`failed\` (a score of \`PASS_SCORE\` or more passes) and to
\`scored\` with \`HINCRBY\`, logs the judge, and answers \`{verdict: "counted", scored, passed, failed}\`
added up on the client. The demo dashboard moves. It hides 4 flaws.

**Failure mode the checks target.** Samples arrive from an at-least-once topic, so after a rebalance
the same sample is folded twice and \`scored\` drifts past the budget; two workers holding one
redelivered sample both count it; a run scored mostly by the string metric looks like a judged one;
and every finished run's keys stay in Redis.

Requirements, kept by **one Lua script**:

- \`SADD\` the sample id to \`evals:seen:{run_id}\` first; a sample already there answers \`duplicate\`
  and moves no counter.
- A counted sample adds one to \`scored\`, to \`passed\` or \`failed\`, and to \`fallback\` when \`judge\` is
  \`"fallback"\`.
- The script stamps \`updated_at\` (unix seconds) and sets \`EXPIRE TTL_S\` on both keys.
- The answer's counters come from the script, after the fold.`,
  sequence: {
    participants: ['Worker', 'Redis'],
    messages: [
      {
        from: 'Worker',
        to: 'Redis',
        label: 'EVALSHA record · progress seen · sample outcome judge ttl now',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'SADD seen sample → 1', kind: 'sync'},
      {
        from: 'Redis',
        to: 'Redis',
        label: 'HINCRBY scored · passed|failed · fallback · HSET updated_at · EXPIRE ×2',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Worker', label: '{counted, scored, passed, failed}', kind: 'reply'},
      {from: 'Worker', to: 'Redis', label: 'EVALSHA record (redelivered sample)', kind: 'sync'},
      {from: 'Redis', to: 'Worker', label: '{duplicate, counters unchanged}', kind: 'reply'},
    ],
  },
  hints: [
    'Symptom: after a consumer rebalance a 500-sample run reports `scored` 512, two workers on one redelivered sample both count it, and the report cannot tell judged samples from string-matched ones.',
    'Mechanism: nothing remembers which sample ids were counted; the reads and the increments are separate round trips another worker can land between; `judge` is only logged; and no key gets a TTL.',
    'Change: one `register_script` / `defineCommand` / `NewScript` / `eval`: `SADD` the id to the seen set and return `duplicate` on 0; else `HINCRBY` scored, the outcome and `fallback`, `HSET updated_at`, `EXPIRE` both keys, and return the counters.',
  ],
  checks: [
    {
      id: 'fold',
      title: 'Folds scored samples into scored, passed and failed',
      detail:
        'Three samples scoring 0.9, 0.2 and 0.5 read scored 3, passed 2, failed 1 (PASS_SCORE 0.5 passes), and record_sample answers those counters with the verdict counted.',
      match: {
        python: {all: [/PASS_SCORE/, /["']passed["']/, /["']failed["']/]},
        typescript: {all: [/PASS_SCORE/, /['"]passed['"]/, /['"]failed['"]/]},
        go: {all: [/config\.PassScore/, /"passed"/, /"failed"/]},
        scala: {all: [/Config\.PassScore/, /"passed"/, /"failed"/]},
        cpp: {all: [/config::kPassScore/, /"passed"/, /"failed"/]},
      },
    },
    {
      id: 'dedupe-sample',
      title: 'Counts a redelivered sample once',
      detail:
        'The sample id goes into evals:seen:{run_id}; folding the same id again answers duplicate and leaves every counter where it was. The starter counts every delivery.',
      match: {
        python: {all: [/seen_key\(|evals:seen:/, /\bSADD\b|\.sadd\(/]},
        typescript: {all: [/seenKey\(|evals:seen:/, /\bSADD\b|\.sadd\(/]},
        go: {all: [/config\.SeenKey\(|evals:seen:/, /\bSADD\b|\.SAdd\(/]},
        scala: {all: [/Config\.seenKey\(|evals:seen:/, /\bSADD\b|\.sadd\(/]},
        cpp: {all: [/config::seen_key\(|evals:seen:/, /\bSADD\b|\.sadd\(/]},
      },
    },
    {
      id: 'atomic-script',
      title: 'Folds a sample in one script: two workers, one count',
      detail:
        "Another worker folding the same sample lands between two of this worker's commands; exactly one of them counts it and scored stays 1. The test, the claim and the increments run in one EVAL/EVALSHA. The starter reads with HGET and increments in separate round trips.",
      match: {
        python: {
          all: [
            /register_script\(|\.eval\(|\.evalsha\(/,
            /redis\.call\(\s*['"]SADD['"]/,
            /redis\.call\(\s*['"]HINCRBY['"]/,
          ],
          none: [/\.hget\(/],
        },
        typescript: {
          all: [
            /defineCommand\(|\.eval\(|\.evalsha\(/,
            /redis\.call\(\s*['"]SADD['"]/,
            /redis\.call\(\s*['"]HINCRBY['"]/,
          ],
          none: [/\.hget\(/],
        },
        go: {
          all: [
            /redis\.NewScript\(|\.Eval\(|\.EvalSha\(/,
            /redis\.call\(\s*['"]SADD['"]/,
            /redis\.call\(\s*['"]HINCRBY['"]/,
          ],
          none: [/\.HGet\(/],
        },
        scala: {
          all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]SADD['"]/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/\.hget\(/],
        },
        cpp: {
          all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]SADD['"]/, /redis\.call\(\s*['"]HINCRBY['"]/],
          none: [/\.hget\(/],
        },
      },
    },
    {
      id: 'fallback-count',
      title: 'Counts the samples the string metric scored',
      detail:
        'A sample whose judge is "fallback" also adds one to the fallback field, so the report can tell a judged run from a string-matched one. The starter logs the judge and counts nothing.',
      match: {
        python: {all: [/HINCRBY['"]\s*,\s*\w+\s*,\s*['"]fallback['"]|\.hincrby\(\s*[^,]+,\s*['"]fallback['"]/]},
        typescript: {all: [/HINCRBY['"]\s*,\s*\w+\s*,\s*['"]fallback['"]|\.hincrby\(\s*[^,]+,\s*['"]fallback['"]/]},
        go: {all: [/HINCRBY['"]\s*,\s*\w+\s*,\s*['"]fallback['"]|\.HIncrBy\(\s*[^,]+,\s*[^,]+,\s*"fallback"/]},
        scala: {all: [/HINCRBY['"]\s*,\s*\w+\s*,\s*['"]fallback['"]|\.hincrBy\(\s*[^,]+,\s*"fallback"/]},
        cpp: {all: [/HINCRBY['"]\s*,\s*\w+\s*,\s*['"]fallback['"]|\.hincrby\(\s*[^,]+,\s*"fallback"/]},
      },
    },
    {
      id: 'key-ttl',
      title: 'Expires the run keys and stamps updated_at from inside the script',
      detail:
        'The progress hash and the seen set get EXPIRE TTL_S, and the hash carries updated_at, so a finished run disappears on its own and a report can tell two readings apart. The starter sets no expiry and no stamp.',
      match: {
        python: {all: [/redis\.call\(\s*['"]EXPIRE['"]|\.expire\(/, /TTL_S/, /updated_at/]},
        typescript: {all: [/redis\.call\(\s*['"]EXPIRE['"]|\.expire\(/, /TTL_S/, /updated_at/]},
        go: {all: [/redis\.call\(\s*['"]EXPIRE['"]|\.Expire\(/, /TTLSeconds/, /updated_at/]},
        scala: {all: [/redis\.call\(\s*['"]EXPIRE['"]|\.expire\(/, /TtlSeconds/, /updated_at/]},
        cpp: {all: [/redis\.call\(\s*['"]EXPIRE['"]|\.expire\(/, /kTtlSeconds/, /updated_at/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import redis

from evals.config import PASS_SCORE, progress_key

logger = logging.getLogger("evald.progress")
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def record_sample(run_id: str, sample_id: str, score: float, judge: str) -> dict:
    """Fold one scored sample into the run's progress: {verdict, scored, passed, failed}."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    key = progress_key(run_id)
    scored = int(r.hget(key, "scored") or 0)
    passed = int(r.hget(key, "passed") or 0)
    failed = int(r.hget(key, "failed") or 0)
    if score >= PASS_SCORE:
        r.hincrby(key, "passed", 1)
        passed += 1
    else:
        r.hincrby(key, "failed", 1)
        failed += 1
    r.hincrby(key, "scored", 1)
    logger.debug("eval sample run=%s sample=%s judge=%s", run_id, sample_id, judge)
    return {"verdict": "counted", "scored": scored + 1, "passed": passed, "failed": failed}
`,
      solution: `import logging
import time

import redis

from evals.config import PASS_SCORE, TTL_S, progress_key, seen_key

logger = logging.getLogger("evald.progress")
r = redis.Redis(host="redis", port=6379, decode_responses=True)

RECORD = """
local progress, seen = KEYS[1], KEYS[2]
local sample, outcome, judge, ttl, now = ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4]), ARGV[5]
local verdict = 'duplicate'
if redis.call('SADD', seen, sample) == 1 then
  verdict = 'counted'
  redis.call('HINCRBY', progress, 'scored', 1)
  redis.call('HINCRBY', progress, outcome, 1)
  if judge == 'fallback' then
    redis.call('HINCRBY', progress, 'fallback', 1)
  end
  redis.call('HSET', progress, 'updated_at', now)
  redis.call('EXPIRE', progress, ttl)
  redis.call('EXPIRE', seen, ttl)
end
local function count(field)
  return tostring(redis.call('HGET', progress, field) or '0')
end
return {verdict, count('scored'), count('passed'), count('failed')}
"""

record_script = r.register_script(RECORD)


def record_sample(run_id: str, sample_id: str, score: float, judge: str) -> dict:
    """Fold one scored sample into the run's progress, once per sample id: {verdict, scored, passed, failed}."""
    outcome = "passed" if score >= PASS_SCORE else "failed"
    verdict, scored, passed, failed = record_script(
        keys=[progress_key(run_id), seen_key(run_id)],
        args=[sample_id, outcome, judge, TTL_S, int(time.time())],
    )
    if verdict == "duplicate":
        logger.info("eval sample run=%s sample=%s already counted", run_id, sample_id)
    return {"verdict": verdict, "scored": int(scored), "passed": int(passed), "failed": int(failed)}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {PASS_SCORE, progressKey} from 'evals/config';

export const redis = new Redis({host: 'redis', port: 6379});

export interface Progress {
  verdict: string;
  scored: number;
  passed: number;
  failed: number;
}

/** Fold one scored sample into the run's progress. */
export async function recordSample(runId: string, sampleId: string, score: number, judge: string): Promise<Progress> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const key = progressKey(runId);
  const scored = Number((await redis.hget(key, 'scored')) ?? 0);
  let passed = Number((await redis.hget(key, 'passed')) ?? 0);
  let failed = Number((await redis.hget(key, 'failed')) ?? 0);
  if (score >= PASS_SCORE) {
    await redis.hincrby(key, 'passed', 1);
    passed += 1;
  } else {
    await redis.hincrby(key, 'failed', 1);
    failed += 1;
  }
  await redis.hincrby(key, 'scored', 1);
  console.debug(\`eval sample run=\${runId} sample=\${sampleId} judge=\${judge}\`);
  return {verdict: 'counted', scored: scored + 1, passed, failed};
}
`,
      solution: `import Redis from 'ioredis';

import {PASS_SCORE, TTL_S, progressKey, seenKey} from 'evals/config';

const RECORD = \`
local progress, seen = KEYS[1], KEYS[2]
local sample, outcome, judge, ttl, now = ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4]), ARGV[5]
local verdict = 'duplicate'
if redis.call('SADD', seen, sample) == 1 then
  verdict = 'counted'
  redis.call('HINCRBY', progress, 'scored', 1)
  redis.call('HINCRBY', progress, outcome, 1)
  if judge == 'fallback' then
    redis.call('HINCRBY', progress, 'fallback', 1)
  end
  redis.call('HSET', progress, 'updated_at', now)
  redis.call('EXPIRE', progress, ttl)
  redis.call('EXPIRE', seen, ttl)
end
local function count(field)
  return tostring(redis.call('HGET', progress, field) or '0')
end
return {verdict, count('scored'), count('passed'), count('failed')}
\`;

interface StateRedis extends Redis {
  recordSampleScript(
    progress: string,
    seen: string,
    sampleId: string,
    outcome: string,
    judge: string,
    ttl: number,
    now: number,
  ): Promise<[string, string, string, string]>;
}

export const redis = new Redis({host: 'redis', port: 6379}) as StateRedis;
redis.defineCommand('recordSampleScript', {numberOfKeys: 2, lua: RECORD});

export interface Progress {
  verdict: string;
  scored: number;
  passed: number;
  failed: number;
}

/** Fold one scored sample into the run's progress, once per sample id. */
export async function recordSample(runId: string, sampleId: string, score: number, judge: string): Promise<Progress> {
  const outcome = score >= PASS_SCORE ? 'passed' : 'failed';
  const [verdict, scored, passed, failed] = await redis.recordSampleScript(
    progressKey(runId),
    seenKey(runId),
    sampleId,
    outcome,
    judge,
    TTL_S,
    Math.floor(Date.now() / 1000),
  );
  if (verdict === 'duplicate') console.info(\`eval sample run=\${runId} sample=\${sampleId} already counted\`);
  return {verdict, scored: Number(scored), passed: Number(passed), failed: Number(failed)};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"

	"github.com/redis/go-redis/v9"

	"evals/config" // config.PassScore, config.ProgressKey — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Progress is record's answer: the verdict (counted, duplicate) and the run's counters.
type Progress struct {
	Verdict string
	Scored  int64
	Passed  int64
	Failed  int64
}

// recordSample folds one scored sample into the run's progress.
func recordSample(ctx context.Context, runID, sampleID string, score float64, judge string) (Progress, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	key := config.ProgressKey(runID)
	scored, _ := rdb.HGet(ctx, key, "scored").Int64()
	passed, _ := rdb.HGet(ctx, key, "passed").Int64()
	failed, _ := rdb.HGet(ctx, key, "failed").Int64()
	if score >= config.PassScore {
		if err := rdb.HIncrBy(ctx, key, "passed", 1).Err(); err != nil {
			return Progress{}, err
		}
		passed++
	} else {
		if err := rdb.HIncrBy(ctx, key, "failed", 1).Err(); err != nil {
			return Progress{}, err
		}
		failed++
	}
	if err := rdb.HIncrBy(ctx, key, "scored", 1).Err(); err != nil {
		return Progress{}, err
	}
	log.Printf("eval sample run=%s sample=%s judge=%s", runID, sampleID, judge)
	return Progress{Verdict: "counted", Scored: scored + 1, Passed: passed, Failed: failed}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"evals/config" // config.PassScore, config.TTLSeconds, config.ProgressKey, config.SeenKey — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var recordScript = redis.NewScript(\`
local progress, seen = KEYS[1], KEYS[2]
local sample, outcome, judge, ttl, now = ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4]), ARGV[5]
local verdict = 'duplicate'
if redis.call('SADD', seen, sample) == 1 then
  verdict = 'counted'
  redis.call('HINCRBY', progress, 'scored', 1)
  redis.call('HINCRBY', progress, outcome, 1)
  if judge == 'fallback' then
    redis.call('HINCRBY', progress, 'fallback', 1)
  end
  redis.call('HSET', progress, 'updated_at', now)
  redis.call('EXPIRE', progress, ttl)
  redis.call('EXPIRE', seen, ttl)
end
local function count(field)
  return tostring(redis.call('HGET', progress, field) or '0')
end
return {verdict, count('scored'), count('passed'), count('failed')}
\`)

// Progress is record's answer: the verdict (counted, duplicate) and the run's counters.
type Progress struct {
	Verdict string
	Scored  int64
	Passed  int64
	Failed  int64
}

// recordSample folds one scored sample into the run's progress, once per sample id.
func recordSample(ctx context.Context, runID, sampleID string, score float64, judge string) (Progress, error) {
	outcome := "failed"
	if score >= config.PassScore {
		outcome = "passed"
	}
	keys := []string{config.ProgressKey(runID), config.SeenKey(runID)}
	reply, err := recordScript.Run(ctx, rdb, keys, sampleID, outcome, judge, config.TTLSeconds, time.Now().Unix()).Slice()
	if err != nil {
		return Progress{}, err
	}
	count := func(i int) int64 {
		n, _ := strconv.ParseInt(fmt.Sprint(reply[i]), 10, 64)
		return n
	}
	verdict := fmt.Sprint(reply[0])
	if verdict == "duplicate" {
		log.Printf("eval sample run=%s sample=%s already counted", runID, sampleID)
	}
	return Progress{Verdict: verdict, Scored: count(1), Passed: count(2), Failed: count(3)}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import evals.Config

/** record's answer: the verdict (counted, duplicate) and the run's counters. */
final case class Progress(verdict: String, scored: Long, passed: Long, failed: Long)

object ProgressStore {
  val jedis = new JedisPooled("redis", 6379)

  private def read(key: String, field: String): Long = Option(jedis.hget(key, field)).map(_.toLong).getOrElse(0L)

  /** Fold one scored sample into the run's progress. */
  def recordSample(runId: String, sampleId: String, score: Double, judge: String): Progress = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val key = Config.progressKey(runId)
    val scored = read(key, "scored")
    var passed = read(key, "passed")
    var failed = read(key, "failed")
    if (score >= Config.PassScore) {
      jedis.hincrBy(key, "passed", 1)
      passed += 1
    } else {
      jedis.hincrBy(key, "failed", 1)
      failed += 1
    }
    jedis.hincrBy(key, "scored", 1)
    System.err.println(s"eval sample run=$runId sample=$sampleId judge=$judge")
    Progress("counted", scored + 1, passed, failed)
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import evals.Config

/** record's answer: the verdict (counted, duplicate) and the run's counters. */
final case class Progress(verdict: String, scored: Long, passed: Long, failed: Long)

object ProgressStore {
  val jedis = new JedisPooled("redis", 6379)

  val Record: String =
    """local progress, seen = KEYS[1], KEYS[2]
      |local sample, outcome, judge, ttl, now = ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4]), ARGV[5]
      |local verdict = 'duplicate'
      |if redis.call('SADD', seen, sample) == 1 then
      |  verdict = 'counted'
      |  redis.call('HINCRBY', progress, 'scored', 1)
      |  redis.call('HINCRBY', progress, outcome, 1)
      |  if judge == 'fallback' then
      |    redis.call('HINCRBY', progress, 'fallback', 1)
      |  end
      |  redis.call('HSET', progress, 'updated_at', now)
      |  redis.call('EXPIRE', progress, ttl)
      |  redis.call('EXPIRE', seen, ttl)
      |end
      |local function count(field)
      |  return tostring(redis.call('HGET', progress, field) or '0')
      |end
      |return {verdict, count('scored'), count('passed'), count('failed')}
      |""".stripMargin

  /** Fold one scored sample into the run's progress, once per sample id. */
  def recordSample(runId: String, sampleId: String, score: Double, judge: String): Progress = {
    val outcome = if (score >= Config.PassScore) "passed" else "failed"
    val keys = List(Config.progressKey(runId), Config.seenKey(runId))
    val args = List(sampleId, outcome, judge, Config.TtlSeconds.toString, (System.currentTimeMillis() / 1000).toString)
    val reply = jedis.eval(Record, keys.asJava, args.asJava).asInstanceOf[java.util.List[AnyRef]].asScala.map(_.toString)
    if (reply(0) == "duplicate") System.err.println(s"eval sample run=$runId sample=$sampleId already counted")
    Progress(reply(0), reply(1).toLong, reply(2).toLong, reply(3).toLong)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <iostream>
#include <string>

#include "evals/config.h"  // config::kPassScore, config::progress_key — provided

sw::redis::Redis redis("tcp://redis:6379");

// record's answer: the verdict (counted, duplicate) and the run's counters.
struct Progress {
  std::string verdict;
  long long scored = 0;
  long long passed = 0;
  long long failed = 0;
};

long long read_count(const std::string& key, const std::string& field) { return std::stoll(redis.hget(key, field).value_or("0")); }

// Fold one scored sample into the run's progress.
Progress record_sample(const std::string& run_id, const std::string& sample_id, double score, const std::string& judge) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string key = config::progress_key(run_id);
  const long long scored = read_count(key, "scored");
  long long passed = read_count(key, "passed");
  long long failed = read_count(key, "failed");
  if (score >= config::kPassScore) {
    redis.hincrby(key, "passed", 1);
    passed++;
  } else {
    redis.hincrby(key, "failed", 1);
    failed++;
  }
  redis.hincrby(key, "scored", 1);
  std::cerr << "eval sample run=" << run_id << " sample=" << sample_id << " judge=" << judge << "\\n";
  return {"counted", scored + 1, passed, failed};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <iostream>
#include <string>

#include "evals/config.h"  // config::kPassScore, config::kTtlSeconds, config::progress_key, config::seen_key — provided

sw::redis::Redis redis("tcp://redis:6379");

const std::string kRecord = R"lua(
local progress, seen = KEYS[1], KEYS[2]
local sample, outcome, judge, ttl, now = ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4]), ARGV[5]
local verdict = 'duplicate'
if redis.call('SADD', seen, sample) == 1 then
  verdict = 'counted'
  redis.call('HINCRBY', progress, 'scored', 1)
  redis.call('HINCRBY', progress, outcome, 1)
  if judge == 'fallback' then
    redis.call('HINCRBY', progress, 'fallback', 1)
  end
  redis.call('HSET', progress, 'updated_at', now)
  redis.call('EXPIRE', progress, ttl)
  redis.call('EXPIRE', seen, ttl)
end
local function count(field)
  return tostring(redis.call('HGET', progress, field) or '0')
end
return {verdict, count('scored'), count('passed'), count('failed')}
)lua";

// record's answer: the verdict (counted, duplicate) and the run's counters.
struct Progress {
  std::string verdict;
  long long scored = 0;
  long long passed = 0;
  long long failed = 0;
};

// Fold one scored sample into the run's progress, once per sample id.
Progress record_sample(const std::string& run_id, const std::string& sample_id, double score, const std::string& judge) {
  const std::string outcome = score >= config::kPassScore ? "passed" : "failed";
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const auto [verdict, scored, passed, failed] = redis.eval<std::string, std::string, std::string, std::string>(
      kRecord, {config::progress_key(run_id), config::seen_key(run_id)},
      {sample_id, outcome, judge, std::to_string(config::kTtlSeconds), std::to_string(now)});
  if (verdict == "duplicate") std::cerr << "eval sample run=" << run_id << " sample=" << sample_id << " already counted\\n";
  return {verdict, std::stoll(scored), std::stoll(passed), std::stoll(failed)};
}
`,
    },
  },
  harness: {
    python: `RUN = "r1"
PROGRESS = f"evals:progress:{RUN}"
SEEN = f"evals:seen:{RUN}"
TTL_S = 604_800


def _count(ctx, field):
    return int(ctx.redis.hget(PROGRESS, field) or 0)


def _counts(ctx):
    return (_count(ctx, "scored"), _count(ctx, "passed"), _count(ctx, "failed"))


def check_fold(ctx):
    m = ctx.load("state")
    m.record_sample(RUN, "s-1", 0.9, "model")
    m.record_sample(RUN, "s-2", 0.2, "model")
    last = m.record_sample(RUN, "s-3", 0.5, "model")
    assert _counts(ctx) == (3, 2, 1), f"samples scoring 0.9, 0.2 and 0.5 (a score of PASS_SCORE 0.5 passes) must read scored 3, passed 2, failed 1; {PROGRESS} holds {ctx.redis.hgetall(PROGRESS)}"
    assert isinstance(last, dict) and last.get("verdict") == "counted", f"a new sample answers verdict counted, got {last}"
    assert (last.get("scored"), last.get("passed"), last.get("failed")) == (3, 2, 1), f"record_sample answers the counters after the fold, got {last}"


def check_dedupe_sample(ctx):
    m = ctx.load("state")
    m.record_sample(RUN, "s-1", 0.9, "model")
    again = m.record_sample(RUN, "s-1", 0.9, "model")  # the topic redelivered it after a rebalance
    assert _counts(ctx) == (1, 1, 0), f"sample s-1 arrived twice and the run reads scored, passed, failed = {_counts(ctx)}: a redelivered sample must be counted once"
    assert isinstance(again, dict) and again.get("verdict") == "duplicate", f"the second delivery of s-1 must answer verdict duplicate, got {again}"
    assert (again.get("scored"), again.get("passed"), again.get("failed")) == (1, 1, 0), f"a duplicate answers the run's counters unchanged, got {again}"
    assert ctx.redis.sismember(SEEN, "s-1"), f"the counted sample id must be in {SEEN}, it holds {ctx.redis.smembers(SEEN)}"
    m.record_sample(RUN, "s-2", 0.1, "model")
    assert _counts(ctx) == (2, 1, 1), f"a new sample after the duplicate is counted: {_counts(ctx)}"


def check_atomic_script(ctx):
    m = ctx.load("state")
    landed = []

    def other_worker():
        # another worker folding the same redelivered sample, landing between two of this worker's commands
        if landed:
            return None
        landed.append(True)
        if ctx.redis.sadd(SEEN, "s-1") == 0:
            return "duplicate"
        ctx.redis.hincrby(PROGRESS, "scored", 1)
        ctx.redis.hincrby(PROGRESS, "passed", 1)
        return "counted"

    on_seen = ctx.redis_after(SEEN, other_worker)
    on_progress = ctx.redis_after(PROGRESS, other_worker)
    mine = m.record_sample(RUN, "s-1", 0.9, "model")
    assert landed, "record_sample never touched the run's keys"
    other = on_seen.result if on_seen.result is not None else on_progress.result
    assert _count(ctx, "scored") == 1, f"two workers folded sample s-1 at the same moment and scored is {_count(ctx, 'scored')}: the dedupe test and the increments must run in one script, so exactly one of them counts it"
    verdicts = sorted([str(mine.get("verdict")), str(other)])
    assert verdicts == ["counted", "duplicate"], f"two workers, one sample: the verdicts were {verdicts}, expected one counted and one duplicate"


def check_fallback_count(ctx):
    m = ctx.load("state")
    m.record_sample(RUN, "s-1", 1.0, "fallback")
    m.record_sample(RUN, "s-2", 0.75, "model")
    m.record_sample(RUN, "s-3", 0.0, "fallback")
    assert _count(ctx, "fallback") == 2, f"two of three samples were scored by the string metric and {PROGRESS} says fallback={ctx.redis.hget(PROGRESS, 'fallback')!r}: the release gate cannot tell a judged run from a string-matched one"
    assert _counts(ctx) == (3, 2, 1), f"fallback samples still count as scored and passed or failed: {_counts(ctx)}"


def check_key_ttl(ctx):
    m = ctx.load("state")
    m.record_sample(RUN, "s-1", 0.9, "model")
    for key in (PROGRESS, SEEN):
        ttl = ctx.redis.ttl(key)
        assert ttl != -2, f"{key} does not exist after a sample was recorded"
        assert 0 < ttl <= TTL_S, f"{key} has TTL {ttl}: every key the run owns expires TTL_S ({TTL_S} s) after its last move"
    stamp = ctx.redis.hget(PROGRESS, "updated_at")
    assert stamp is not None and stamp.isdigit(), f"the progress hash must carry updated_at (unix seconds), it holds {ctx.redis.hgetall(PROGRESS)}"
    ctx.clock.advance(TTL_S + 1)
    assert ctx.redis.keys(f"evals:*:{RUN}") == [], f"a week after its last move the run must be gone, found {ctx.redis.keys(f'evals:*:{RUN}')}"
`,
    typescript: `const RUN = 'r1';
const PROGRESS = \`evals:progress:\${RUN}\`;
const SEEN = \`evals:seen:\${RUN}\`;
const TTL_S = 604_800;

const count = (ctx, field: string) => Number(ctx.redis.hget(PROGRESS, field) ?? 0);
const counts = ctx => [count(ctx, 'scored'), count(ctx, 'passed'), count(ctx, 'failed')];

export async function check_fold(ctx) {
  const m = ctx.load('state');
  await m.recordSample(RUN, 's-1', 0.9, 'model');
  await m.recordSample(RUN, 's-2', 0.2, 'model');
  const last = await m.recordSample(RUN, 's-3', 0.5, 'model');
  assert.deepEqual(counts(ctx), [3, 2, 1], \`samples scoring 0.9, 0.2 and 0.5 (a score of PASS_SCORE 0.5 passes) must read scored 3, passed 2, failed 1; \${PROGRESS} holds \${JSON.stringify(ctx.redis.hgetall(PROGRESS))}\`);
  assert.equal(last?.verdict, 'counted', \`a new sample answers verdict counted, got \${JSON.stringify(last)}\`);
  assert.deepEqual([last.scored, last.passed, last.failed], [3, 2, 1], \`recordSample answers the counters after the fold, got \${JSON.stringify(last)}\`);
}

export async function check_dedupe_sample(ctx) {
  const m = ctx.load('state');
  await m.recordSample(RUN, 's-1', 0.9, 'model');
  const again = await m.recordSample(RUN, 's-1', 0.9, 'model'); // the topic redelivered it after a rebalance
  assert.deepEqual(counts(ctx), [1, 1, 0], \`sample s-1 arrived twice and the run reads scored, passed, failed = \${JSON.stringify(counts(ctx))}: a redelivered sample must be counted once\`);
  assert.equal(again?.verdict, 'duplicate', \`the second delivery of s-1 must answer verdict duplicate, got \${JSON.stringify(again)}\`);
  assert.deepEqual([again.scored, again.passed, again.failed], [1, 1, 0], \`a duplicate answers the run's counters unchanged, got \${JSON.stringify(again)}\`);
  assert.equal(ctx.redis.sismember(SEEN, 's-1'), 1, \`the counted sample id must be in \${SEEN}, it holds \${JSON.stringify(ctx.redis.smembers(SEEN))}\`);
  await m.recordSample(RUN, 's-2', 0.1, 'model');
  assert.deepEqual(counts(ctx), [2, 1, 1], \`a new sample after the duplicate is counted: \${JSON.stringify(counts(ctx))}\`);
}

export async function check_atomic_script(ctx) {
  const m = ctx.load('state');
  let landed = false;
  // another worker folding the same redelivered sample, landing between two of this worker's commands
  const otherWorker = () => {
    if (landed) return null;
    landed = true;
    if (ctx.redis.sadd(SEEN, 's-1') === 0) return 'duplicate';
    ctx.redis.hincrby(PROGRESS, 'scored', 1);
    ctx.redis.hincrby(PROGRESS, 'passed', 1);
    return 'counted';
  };
  const onSeen = ctx.redisAfter(SEEN, otherWorker);
  const onProgress = ctx.redisAfter(PROGRESS, otherWorker);
  const mine = await m.recordSample(RUN, 's-1', 0.9, 'model');
  assert(landed, 'recordSample never touched the run\\'s keys');
  const other = onSeen.result ?? onProgress.result;
  assert.equal(count(ctx, 'scored'), 1, \`two workers folded sample s-1 at the same moment and scored is \${count(ctx, 'scored')}: the dedupe test and the increments must run in one script, so exactly one of them counts it\`);
  const verdicts = [String(mine?.verdict), String(other)].sort();
  assert.deepEqual(verdicts, ['counted', 'duplicate'], \`two workers, one sample: the verdicts were \${JSON.stringify(verdicts)}, expected one counted and one duplicate\`);
}

export async function check_fallback_count(ctx) {
  const m = ctx.load('state');
  await m.recordSample(RUN, 's-1', 1.0, 'fallback');
  await m.recordSample(RUN, 's-2', 0.75, 'model');
  await m.recordSample(RUN, 's-3', 0.0, 'fallback');
  assert.equal(count(ctx, 'fallback'), 2, \`two of three samples were scored by the string metric and \${PROGRESS} says fallback=\${JSON.stringify(ctx.redis.hget(PROGRESS, 'fallback'))}: the release gate cannot tell a judged run from a string-matched one\`);
  assert.deepEqual(counts(ctx), [3, 2, 1], \`fallback samples still count as scored and passed or failed: \${JSON.stringify(counts(ctx))}\`);
}

export async function check_key_ttl(ctx) {
  const m = ctx.load('state');
  await m.recordSample(RUN, 's-1', 0.9, 'model');
  for (const key of [PROGRESS, SEEN]) {
    const ttl = Number(ctx.redis.ttl(key));
    assert(ttl !== -2, \`\${key} does not exist after a sample was recorded\`);
    assert(0 < ttl && ttl <= TTL_S, \`\${key} has TTL \${ttl}: every key the run owns expires TTL_S (\${TTL_S} s) after its last move\`);
  }
  const stamp = ctx.redis.hget(PROGRESS, 'updated_at');
  assert(typeof stamp === 'string' && /^\\d+$/.test(stamp), \`the progress hash must carry updated_at (unix seconds), it holds \${JSON.stringify(ctx.redis.hgetall(PROGRESS))}\`);
  ctx.clock.advance(TTL_S + 1);
  assert.deepEqual(ctx.redis.keys(\`evals:*:\${RUN}\`), [], \`a week after its last move the run must be gone, found \${JSON.stringify(ctx.redis.keys(\`evals:*:\${RUN}\`))}\`);
}
`,
    go: `package main

import (
	"context"
	"regexp"
	"sort"
	"strconv"

	"leetbuild/harness"
)

const (
	stateRun      = "r1"
	stateProgress = "evals:progress:" + stateRun
	stateSeen     = "evals:seen:" + stateRun
	stateTTL      = 604_800
)

func stateRecord(ctx *harness.Ctx, sampleID string, score float64, judge string) Progress {
	p, err := recordSample(context.Background(), stateRun, sampleID, score, judge)
	ctx.NoError(err, "recordSample(%q)", sampleID)
	return p
}

func stateCount(ctx *harness.Ctx, field string) int64 {
	n, _ := strconv.ParseInt(ctx.Redis.HGetAll(stateProgress)[field], 10, 64)
	return n
}

func stateCounts(ctx *harness.Ctx) []int64 {
	return []int64{stateCount(ctx, "scored"), stateCount(ctx, "passed"), stateCount(ctx, "failed")}
}

func CheckFold(ctx *harness.Ctx) {
	stateRecord(ctx, "s-1", 0.9, "model")
	stateRecord(ctx, "s-2", 0.2, "model")
	last := stateRecord(ctx, "s-3", 0.5, "model")
	ctx.Equal(stateCounts(ctx), []int64{3, 2, 1}, "samples scoring 0.9, 0.2 and 0.5 (a score of PassScore 0.5 passes) must read scored 3, passed 2, failed 1 (%v); scored, passed, failed", ctx.Redis.HGetAll(stateProgress))
	ctx.Equal(last.Verdict, "counted", "a new sample's verdict")
	ctx.Equal([]int64{last.Scored, last.Passed, last.Failed}, []int64{3, 2, 1}, "recordSample answers the counters after the fold")
}

func CheckDedupeSample(ctx *harness.Ctx) {
	stateRecord(ctx, "s-1", 0.9, "model")
	again := stateRecord(ctx, "s-1", 0.9, "model") // the topic redelivered it after a rebalance
	ctx.Equal(stateCounts(ctx), []int64{1, 1, 0}, "sample s-1 arrived twice: a redelivered sample must be counted once; scored, passed, failed")
	ctx.Equal(again.Verdict, "duplicate", "the second delivery of s-1's verdict")
	ctx.Equal([]int64{again.Scored, again.Passed, again.Failed}, []int64{1, 1, 0}, "a duplicate answers the run's counters unchanged")
	ctx.Assert(ctx.Redis.SIsMember(stateSeen, "s-1"), "the counted sample id must be in %s, it holds %v", stateSeen, ctx.Redis.SMembers(stateSeen))
	stateRecord(ctx, "s-2", 0.1, "model")
	ctx.Equal(stateCounts(ctx), []int64{2, 1, 1}, "a new sample after the duplicate is counted; scored, passed, failed")
}

func CheckAtomicScript(ctx *harness.Ctx) {
	landed := false
	other := ""
	// another worker folding the same redelivered sample, landing between two of this worker's commands
	otherWorker := func() any {
		if landed {
			return nil
		}
		landed = true
		if n, _ := ctx.Redis.Do("SADD", stateSeen, "s-1").(int64); n == 0 {
			other = "duplicate"
			return nil
		}
		ctx.Redis.Do("HINCRBY", stateProgress, "scored", 1)
		ctx.Redis.Do("HINCRBY", stateProgress, "passed", 1)
		other = "counted"
		return nil
	}
	ctx.Redis.After(stateSeen, otherWorker)
	ctx.Redis.After(stateProgress, otherWorker)
	mine := stateRecord(ctx, "s-1", 0.9, "model")
	ctx.Assert(landed, "recordSample never touched the run's keys")
	ctx.Equal(stateCount(ctx, "scored"), 1, "two workers folded sample s-1 at the same moment: the dedupe test and the increments must run in one script, so exactly one of them counts it; scored")
	verdicts := []string{mine.Verdict, other}
	sort.Strings(verdicts)
	ctx.Equal(verdicts, []string{"counted", "duplicate"}, "two workers, one sample: one counted and one duplicate; the verdicts")
}

func CheckFallbackCount(ctx *harness.Ctx) {
	stateRecord(ctx, "s-1", 1.0, "fallback")
	stateRecord(ctx, "s-2", 0.75, "model")
	stateRecord(ctx, "s-3", 0.0, "fallback")
	ctx.Equal(stateCount(ctx, "fallback"), 2, "two of three samples were scored by the string metric (%v): the release gate cannot tell a judged run from a string-matched one; fallback", ctx.Redis.HGetAll(stateProgress))
	ctx.Equal(stateCounts(ctx), []int64{3, 2, 1}, "fallback samples still count as scored and passed or failed; scored, passed, failed")
}

func CheckKeyTtl(ctx *harness.Ctx) {
	stateRecord(ctx, "s-1", 0.9, "model")
	for _, key := range []string{stateProgress, stateSeen} {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl != -2, "%s does not exist after a sample was recorded", key)
		ctx.Assert(0 < ttl && ttl <= stateTTL, "%s has TTL %d: every key the run owns expires TTLSeconds (%d s) after its last move", key, ttl, stateTTL)
	}
	stamp, ok := ctx.Redis.HGet(stateProgress, "updated_at")
	ctx.Assert(ok && regexp.MustCompile(\`^\\d+$\`).MatchString(stamp), "the progress hash must carry updated_at (unix seconds), it holds %v", ctx.Redis.HGetAll(stateProgress))
	ctx.Clock.Advance(stateTTL + 1)
	ctx.Equal(len(ctx.Redis.Keys("evals:*:"+stateRun)), 0, "a week after its last move the run must be gone (%v); keys left", ctx.Redis.Keys("evals:*:"+stateRun))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <cstdlib>
#include <string>
#include <vector>

namespace {

const std::string kRun = "r1";
const std::string kProgress = "evals:progress:" + kRun;
const std::string kSeen = "evals:seen:" + kRun;
constexpr long long kTtl = 604800;

long long stateCount(harness::Ctx& ctx, const std::string& field) {
  const auto all = ctx.Redis.HGetAll(kProgress);
  const auto it = all.find(field);
  return it == all.end() ? 0 : std::strtoll(it->second.c_str(), nullptr, 10);
}

std::vector<long long> stateCounts(harness::Ctx& ctx) { return {stateCount(ctx, "scored"), stateCount(ctx, "passed"), stateCount(ctx, "failed")}; }

}  // namespace

void CheckFold(harness::Ctx& ctx) {
  record_sample(kRun, "s-1", 0.9, "model");
  record_sample(kRun, "s-2", 0.2, "model");
  const Progress last = record_sample(kRun, "s-3", 0.5, "model");
  ctx.Equal(stateCounts(ctx), std::vector<long long>{3, 2, 1},
            "samples scoring 0.9, 0.2 and 0.5 (a score of kPassScore 0.5 passes) must read scored 3, passed 2, failed 1 (%v); scored, passed, failed", ctx.Redis.HGetAll(kProgress));
  ctx.Equal(last.verdict, "counted", "a new sample's verdict");
  ctx.Equal(std::vector<long long>{last.scored, last.passed, last.failed}, std::vector<long long>{3, 2, 1}, "record_sample answers the counters after the fold");
}

void CheckDedupeSample(harness::Ctx& ctx) {
  record_sample(kRun, "s-1", 0.9, "model");
  const Progress again = record_sample(kRun, "s-1", 0.9, "model");  // the topic redelivered it after a rebalance
  ctx.Equal(stateCounts(ctx), std::vector<long long>{1, 1, 0}, "sample s-1 arrived twice: a redelivered sample must be counted once; scored, passed, failed");
  ctx.Equal(again.verdict, "duplicate", "the second delivery of s-1's verdict");
  ctx.Equal(std::vector<long long>{again.scored, again.passed, again.failed}, std::vector<long long>{1, 1, 0}, "a duplicate answers the run's counters unchanged");
  ctx.Assert(ctx.Redis.SIsMember(kSeen, "s-1"), "the counted sample id must be in %s, it holds %v", kSeen, ctx.Redis.SMembers(kSeen));
  record_sample(kRun, "s-2", 0.1, "model");
  ctx.Equal(stateCounts(ctx), std::vector<long long>{2, 1, 1}, "a new sample after the duplicate is counted; scored, passed, failed");
}

void CheckAtomicScript(harness::Ctx& ctx) {
  bool landed = false;
  std::string other;
  // another worker folding the same redelivered sample, landing between two of this worker's commands
  const auto otherWorker = [&] {
    if (landed) return;
    landed = true;
    if (ctx.Redis.Do("SADD", kSeen, "s-1").Int() == 0) {
      other = "duplicate";
      return;
    }
    ctx.Redis.Do("HINCRBY", kProgress, "scored", 1);
    ctx.Redis.Do("HINCRBY", kProgress, "passed", 1);
    other = "counted";
  };
  ctx.Redis.After(kSeen, otherWorker);
  ctx.Redis.After(kProgress, otherWorker);
  const Progress mine = record_sample(kRun, "s-1", 0.9, "model");
  ctx.Assert(landed, "record_sample never touched the run's keys");
  ctx.Equal(stateCount(ctx, "scored"), 1, "two workers folded sample s-1 at the same moment: the dedupe test and the increments must run in one script, so exactly one of them counts it; scored");
  std::vector<std::string> verdicts = {mine.verdict, other};
  std::sort(verdicts.begin(), verdicts.end());
  ctx.Equal(verdicts, {"counted", "duplicate"}, "two workers, one sample: one counted and one duplicate; the verdicts");
}

void CheckFallbackCount(harness::Ctx& ctx) {
  record_sample(kRun, "s-1", 1.0, "fallback");
  record_sample(kRun, "s-2", 0.75, "model");
  record_sample(kRun, "s-3", 0.0, "fallback");
  ctx.Equal(stateCount(ctx, "fallback"), 2, "two of three samples were scored by the string metric (%v): the release gate cannot tell a judged run from a string-matched one; fallback", ctx.Redis.HGetAll(kProgress));
  ctx.Equal(stateCounts(ctx), std::vector<long long>{3, 2, 1}, "fallback samples still count as scored and passed or failed; scored, passed, failed");
}

void CheckKeyTtl(harness::Ctx& ctx) {
  record_sample(kRun, "s-1", 0.9, "model");
  for (const std::string& key : {kProgress, kSeen}) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl != -2, "%s does not exist after a sample was recorded", key);
    ctx.Assert(0 < ttl && ttl <= kTtl, "%s has TTL %d: every key the run owns expires kTtlSeconds (%d s) after its last move", key, ttl, kTtl);
  }
  const auto stamp = ctx.Redis.HGet(kProgress, "updated_at");
  ctx.Assert(stamp && !stamp->empty() && std::all_of(stamp->begin(), stamp->end(), [](char c) { return c >= '0' && c <= '9'; }),
             "the progress hash must carry updated_at (unix seconds), it holds %v", ctx.Redis.HGetAll(kProgress));
  ctx.Clock.Advance(kTtl + 1);
  ctx.Equal(ctx.Redis.Keys("evals:*:" + kRun).size(), 0, "a week after its last move the run must be gone (%v); keys left", ctx.Redis.Keys("evals:*:" + kRun));
}
`,
  },
  debrief: `The seen set makes the fold idempotent: a topic that delivers at least once can only be counted exactly once by the code that counts, and \`SADD\` answering 1 or 0 is the test and the claim in one command. The script keeps that claim true for two workers at once, because Redis runs it alone; separate round trips leave a gap another worker lands in. Counting fallbacks keeps the provenance of the number, which step 5 needs to refuse a run the judge barely saw, and the TTL bounds what a finished run costs. At large scale the seen set becomes a cost of its own: production systems dedupe on the partition and offset instead, or keep the dedupe in the warehouse beside the counters.`,
};
