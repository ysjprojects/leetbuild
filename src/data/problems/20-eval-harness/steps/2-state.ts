import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis progress counters: atomic, expiring, deduped',
  concept: 'redis',
  file: 'state',
  focus: ['harness', 'redis'],
  task: `## Task

The starter is a plausible model-generated draft: a sample is scored and the counter moves, so the
demo shows progress on the dashboard. It races under load, it counts redeliveries, and it leaks keys
forever. Find the flaws, fix them, and prove the fix.

Implement \`record_sample\`, the call every worker makes when one sample finishes:

- The run's progress lives in **one Redis hash per run**: \`evals:run:{run_id}\`, with the fields
  \`scored\`, \`passed\` and \`failed\`. The draft reads and writes the fields as separate client calls,
  so two samples that land together can overwrite each other's \`GET\`.
- A sample is identified by \`(run_id, sample_id)\` and gets its **own dedupe key**:
  \`sample:{run_id}:{sample_id}\`. A redelivered Kafka message must not score twice.
- The dedupe flag, the \`scored\` increment and the \`passed\`/\`failed\` increment happen in **one
  atomic Lua \`EVAL\`**: \`SET … NX\` first, and only when the key was actually created do the
  increments run. A worker that decides "already seen" from a client-side read is exactly the race
  the draft has.
- Both keys **expire with the run**: \`EXPIRE\` from the same script, \`RUN_TTL_S = 86_400\`
  seconds. Counters without a TTL outlive the run record and the release they belonged to.
- Return the counters the caller reads: \`{applied, scored, passed, failed}\`, where \`applied\` is
  false for a redelivered sample that changed nothing.

**Failure mode the checks target.** The subtle one is the redelivery: the Kafka topic is
at-least-once, so the same sample will arrive twice after any rebalance, and \`scored\` drifts above
the run's budget while the pass rate is computed over more samples than were ever scored. The
client-side read-modify-write is the loud one under concurrency, and the missing TTL is the silent
one that keeps every finished run's keys alive for months.`,
  sequence: {
    participants: ['Eval worker', 'Second worker', 'Redis'],
    messages: [
      {from: 'Eval worker', to: 'Redis', label: 'EVAL dedupe sample:run-7:s-42 · NX', kind: 'sync'},
      {from: 'Redis', to: 'Eval worker', label: '{1, scored+1, passed+1}', kind: 'reply'},
      {from: 'Second worker', to: 'Redis', label: 'EVAL same sample redelivered', kind: 'sync'},
      {from: 'Redis', to: 'Second worker', label: '{0, counters unchanged}', kind: 'reply'},
      {from: 'Eval worker', to: 'Redis', label: 'EVAL HINCRBY scored · EXPIRE evals:run:run-7 86400', kind: 'async'},
      {from: 'Eval worker', to: 'Eval worker', label: 'two concurrent samples lose no increment', kind: 'sync'},
    ],
  },
  hints: [
    'Everything that decides the result has to run inside the script: read nothing on the client, because the client read is where the race lives. `SET sample:… NX` returns whether this worker created the flag; only then does the script `HINCRBY` the counters.',
    'Make the dedupe key a function of both ids — `sample:{run_id}:{sample_id}` — and give it the same TTL as the counters. A run-scoped flag alone would collapse every sample into one; a flag without a TTL turns the dedupe set into the largest structure in Redis.',
    'Return the fresh counters from the script and hand them straight back to the caller. If you re-read the hash after the script you can report another worker’s progress as yours, and `applied = false` is the signal the worker uses to skip its own bookkeeping.',
  ],
  checks: [
    {
      id: 'atomic-script',
      title: 'Moves the counters with one atomic script',
      detail:
        'The dedupe and both increments happen inside one `EVAL`/`NewScript` call. The draft reads the fields with `GET` and writes them back, so two concurrent samples both observe the same value and one increment is lost.',
      match: {
        python: {all: [/COUNTERS_LUA/, /\.eval\(/, /HINCRBY/]},
        typescript: {all: [/COUNTERS_LUA/, /\.eval\(/, /HINCRBY/]},
        go: {all: [/countersScript/, /\.Run\(/, /HINCRBY/]},
        scala: {all: [/CountersLua/, /\.eval\(/, /HINCRBY/]},
        cpp: {all: [/kCountersLua/, /\.eval</, /HINCRBY/]},
      },
    },
    {
      id: 'dedupe-nx',
      title: 'Dedupes a redelivered sample under its own key',
      detail:
        'A per-sample key `sample:{run_id}:{sample_id}` is claimed with `SET … NX` inside the script, so an at-least-once redelivery leaves the counters unchanged. The draft has no per-sample key at all and counts the replay.',
      match: {
        python: {all: [/SET/, /'NX'/, /sample:/]},
        typescript: {all: [/SET/, /'NX'/, /sample:/]},
        go: {all: [/SET/, /'NX'/, /sample:/]},
        scala: {all: [/SET/, /'NX'/, /sample:/]},
        cpp: {all: [/SET/, /'NX'/, /sample:/]},
      },
    },
    {
      id: 'counter-ttl',
      title: 'Expires the counters with the run',
      detail:
        'The script sets `EXPIRE` from `RUN_TTL_S`, so a finished run’s counters and dedupe flags disappear instead of accumulating forever. The draft sets no TTL on any key.',
      match: {
        python: {all: [/RUN_TTL_S/, /EXPIRE/]},
        typescript: {all: [/RUN_TTL_S/, /EXPIRE/]},
        go: {all: [/runTTLS/, /EXPIRE/]},
        scala: {all: [/RunTTLS/, /EXPIRE/]},
        cpp: {all: [/kRunTTLS/, /EXPIRE/]},
      },
    },
    {
      id: 'run-scoped-key',
      title: 'Scopes the counters to one run',
      detail:
        'The counters live in `evals:run:{run_id}`, built from the run the sample belongs to. A shared or run-less key mixes two runs’ progress, and the release gate then reads a count that belongs to someone else’s eval.',
      match: {
        python: {all: [/evals:run:/, /run_id/]},
        typescript: {all: [/evals:run:/, /runId/]},
        go: {all: [/evals:run:/, /RunID/]},
        scala: {all: [/evals:run:/, /runId/]},
        cpp: {all: [/evals:run:/, /runId/]},
      },
    },
    {
      id: 'dedupe-before-increment',
      title: 'Claims the sample before it counts it',
      detail:
        'Within the script the `SET … NX` claim is evaluated before the `HINCRBY` calls, and the increments only run when the claim succeeded. Landing the increment first counts a redelivery even when the dedupe flag already existed.',
      match: {
        python: {order: [/'NX'/, /HINCRBY/]},
        typescript: {order: [/'NX'/, /HINCRBY/]},
        go: {order: [/'NX'/, /HINCRBY/]},
        scala: {order: [/'NX'/, /HINCRBY/]},
        cpp: {order: [/'NX'/, /HINCRBY/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class SampleResult(BaseModel):
    run_id: str
    sample_id: str
    outcome: str


def record_sample(result: SampleResult) -> dict:
    # TODO: replace the client-side GET-then-INCR with one atomic script, add a per-sample dedupe
    # key so a redelivered Kafka message is not scored twice, and expire the counters with the run.
    if result.outcome not in {"passed", "failed"}:
        raise HTTPException(status_code=400, detail="outcome must be passed or failed")
    key = f"evals:run:{result.run_id}"
    scored = int(r.hget(key, "scored") or 0)
    passed = int(r.hget(key, "passed") or 0)
    failed = int(r.hget(key, "failed") or 0)
    r.hincrby(key, "scored", 1)
    r.hincrby(key, result.outcome, 1)
    if result.outcome == "passed":
        passed += 1
    else:
        failed += 1
    return {"applied": True, "scored": scored + 1, "passed": passed, "failed": failed}
`,
      solution: `import redis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

RUN_TTL_S = 86_400

COUNTERS_LUA = """
local fresh = redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[3])
if not fresh then
  return {0, tonumber(redis.call('HGET', KEYS[2], 'scored')) or 0,
          tonumber(redis.call('HGET', KEYS[2], 'passed')) or 0,
          tonumber(redis.call('HGET', KEYS[2], 'failed')) or 0}
end
redis.call('HINCRBY', KEYS[2], 'scored', 1)
redis.call('HINCRBY', KEYS[2], ARGV[1], 1)
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return {1, tonumber(redis.call('HGET', KEYS[2], 'scored')) or 0,
        tonumber(redis.call('HGET', KEYS[2], 'passed')) or 0,
        tonumber(redis.call('HGET', KEYS[2], 'failed')) or 0}
"""


class SampleResult(BaseModel):
    run_id: str
    sample_id: str
    outcome: str


def counters_key(run_id: str) -> str:
    return f"evals:run:{run_id}"


def dedupe_key(run_id: str, sample_id: str) -> str:
    return f"sample:{run_id}:{sample_id}"


def record_sample(result: SampleResult) -> dict:
    if result.outcome not in {"passed", "failed"}:
        raise HTTPException(status_code=400, detail="outcome must be passed or failed")
    applied, scored, passed, failed = r.eval(
        COUNTERS_LUA,
        2,
        dedupe_key(result.run_id, result.sample_id),
        counters_key(result.run_id),
        result.outcome,
        RUN_TTL_S,
    )
    return {"applied": bool(applied), "scored": int(scored), "passed": int(passed), "failed": int(failed)}
`,
    },
    typescript: {
      starter: `/** recordSample: a model-generated draft that reads, then writes, one counter at a time. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

interface SampleResult {
  run_id: string;
  sample_id: string;
  outcome: 'passed' | 'failed';
}

interface Counters {
  applied: boolean;
  scored: number;
  passed: number;
  failed: number;
}

export async function recordSample(result: SampleResult): Promise<Counters> {
  // TODO: replace the client-side GET-then-INCR with one atomic script, add a per-sample dedupe
  // key so a redelivered Kafka message is not scored twice, and expire the counters with the run.
  const key = \`evals:run:\${result.run_id}\`;
  const scored = Number((await r.hget(key, 'scored')) ?? 0);
  const passed = Number((await r.hget(key, 'passed')) ?? 0);
  const failed = Number((await r.hget(key, 'failed')) ?? 0);
  await r.hincrby(key, 'scored', 1);
  await r.hincrby(key, result.outcome, 1);
  return {
    applied: true,
    scored: scored + 1,
    passed: result.outcome === 'passed' ? passed + 1 : passed,
    failed: result.outcome === 'failed' ? failed + 1 : failed,
  };
}
`,
      solution: `/** recordSample: one atomic script claims the sample, counts it and expires the run's keys. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const RUN_TTL_S = 86_400;

const COUNTERS_LUA = \`
local fresh = redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[3])
if not fresh then
  return {0, tonumber(redis.call('HGET', KEYS[2], 'scored')) or 0,
          tonumber(redis.call('HGET', KEYS[2], 'passed')) or 0,
          tonumber(redis.call('HGET', KEYS[2], 'failed')) or 0}
end
redis.call('HINCRBY', KEYS[2], 'scored', 1)
redis.call('HINCRBY', KEYS[2], ARGV[1], 1)
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return {1, tonumber(redis.call('HGET', KEYS[2], 'scored')) or 0,
        tonumber(redis.call('HGET', KEYS[2], 'passed')) or 0,
        tonumber(redis.call('HGET', KEYS[2], 'failed')) or 0}
\`;

interface SampleResult {
  run_id: string;
  sample_id: string;
  outcome: 'passed' | 'failed';
}

interface Counters {
  applied: boolean;
  scored: number;
  passed: number;
  failed: number;
}

function countersKey(runId: string): string {
  return \`evals:run:\${runId}\`;
}

function dedupeKey(runId: string, sampleId: string): string {
  return \`sample:\${runId}:\${sampleId}\`;
}

export async function recordSample(result: SampleResult): Promise<Counters> {
  const reply = (await r.eval(
    COUNTERS_LUA,
    2,
    dedupeKey(result.run_id, result.sample_id),
    countersKey(result.run_id),
    result.outcome,
    String(RUN_TTL_S),
  )) as [number, number, number, number];
  return {applied: reply[0] === 1, scored: reply[1], passed: reply[2], failed: reply[3]};
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

var rdb *redis.Client

type SampleResult struct {
	RunID    string \`json:"run_id"\`
	SampleID string \`json:"sample_id"\`
	Outcome  string \`json:"outcome"\`
}

type Counters struct {
	Applied bool
	Scored  int64
	Passed  int64
	Failed  int64
}

func recordSample(ctx context.Context, result SampleResult) (Counters, error) {
	// TODO: replace the client-side GET-then-INCR with one atomic script, add a per-sample dedupe
	// key so a redelivered Kafka message is not scored twice, and expire the counters with the run.
	key := fmt.Sprintf("evals:run:%s", result.RunID)
	scored, _ := rdb.HGet(ctx, key, "scored").Int64()
	passed, _ := rdb.HGet(ctx, key, "passed").Int64()
	failed, _ := rdb.HGet(ctx, key, "failed").Int64()
	rdb.HIncrBy(ctx, key, "scored", 1)
	rdb.HIncrBy(ctx, key, result.Outcome, 1)
	if result.Outcome == "passed" {
		passed++
	} else {
		failed++
	}
	return Counters{Applied: true, Scored: scored + 1, Passed: passed, Failed: failed}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

const runTTLS = 86400

var rdb *redis.Client

var countersScript = redis.NewScript(\`
local fresh = redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[3])
if not fresh then
  return {0, tonumber(redis.call('HGET', KEYS[2], 'scored')) or 0,
          tonumber(redis.call('HGET', KEYS[2], 'passed')) or 0,
          tonumber(redis.call('HGET', KEYS[2], 'failed')) or 0}
end
redis.call('HINCRBY', KEYS[2], 'scored', 1)
redis.call('HINCRBY', KEYS[2], ARGV[1], 1)
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return {1, tonumber(redis.call('HGET', KEYS[2], 'scored')) or 0,
        tonumber(redis.call('HGET', KEYS[2], 'passed')) or 0,
        tonumber(redis.call('HGET', KEYS[2], 'failed')) or 0}
\`)

type SampleResult struct {
	RunID    string \`json:"run_id"\`
	SampleID string \`json:"sample_id"\`
	Outcome  string \`json:"outcome"\`
}

type Counters struct {
	Applied bool
	Scored  int64
	Passed  int64
	Failed  int64
}

func countersKey(runID string) string {
	return fmt.Sprintf("evals:run:%s", runID)
}

func dedupeKey(runID, sampleID string) string {
	return fmt.Sprintf("sample:%s:%s", runID, sampleID)
}

func recordSample(ctx context.Context, result SampleResult) (Counters, error) {
	values, err := countersScript.Run(
		ctx,
		rdb,
		[]string{dedupeKey(result.RunID, result.SampleID), countersKey(result.RunID)},
		result.Outcome,
		runTTLS,
	).Int64Slice()
	if err != nil {
		return Counters{}, err
	}
	return Counters{Applied: values[0] == 1, Scored: values[1], Passed: values[2], Failed: values[3]}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

final case class SampleResult(run_id: String, sample_id: String, outcome: String)
final case class Counters(applied: Boolean, scored: Long, passed: Long, failed: Long)

object ProgressStore {
  val r = new Jedis("redis", 6379)

  def recordSample(result: SampleResult): Counters = {
    // TODO: replace the client-side GET-then-INCR with one atomic script, add a per-sample dedupe
    // key so a redelivered Kafka message is not scored twice, and expire the counters with the run.
    val key = s"evals:run:\${result.run_id}"
    val scored = Option(r.hget(key, "scored")).map(_.toLong).getOrElse(0L)
    val passed = Option(r.hget(key, "passed")).map(_.toLong).getOrElse(0L)
    val failed = Option(r.hget(key, "failed")).map(_.toLong).getOrElse(0L)
    r.hincrBy(key, "scored", 1)
    r.hincrBy(key, result.outcome, 1)
    Counters(
      applied = true,
      scored = scored + 1,
      passed = if (result.outcome == "passed") passed + 1 else passed,
      failed = if (result.outcome == "failed") failed + 1 else failed
    )
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

final case class SampleResult(run_id: String, sample_id: String, outcome: String)
final case class Counters(applied: Boolean, scored: Long, passed: Long, failed: Long)

object ProgressStore {
  val RunTTLS = 86400L
  val r = new Jedis("redis", 6379)

  val CountersLua =
    """
      |local fresh = redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[3])
      |if not fresh then
      |  return {0, tonumber(redis.call('HGET', KEYS[2], 'scored')) or 0,
      |          tonumber(redis.call('HGET', KEYS[2], 'passed')) or 0,
      |          tonumber(redis.call('HGET', KEYS[2], 'failed')) or 0}
      |end
      |redis.call('HINCRBY', KEYS[2], 'scored', 1)
      |redis.call('HINCRBY', KEYS[2], ARGV[1], 1)
      |redis.call('EXPIRE', KEYS[2], ARGV[3])
      |redis.call('EXPIRE', KEYS[1], ARGV[3])
      |return {1, tonumber(redis.call('HGET', KEYS[2], 'scored')) or 0,
      |        tonumber(redis.call('HGET', KEYS[2], 'passed')) or 0,
      |        tonumber(redis.call('HGET', KEYS[2], 'failed')) or 0}
      |""".stripMargin

  def countersKey(runId: String): String = s"evals:run:$runId"

  def dedupeKey(runId: String, sampleId: String): String = s"sample:$runId:$sampleId"

  def recordSample(result: SampleResult): Counters = {
    val reply = r
      .eval(
        CountersLua,
        2,
        dedupeKey(result.run_id, result.sample_id),
        countersKey(result.run_id),
        result.outcome,
        RunTTLS.toString
      )
      .asInstanceOf[java.util.List[Long]]
    Counters(
      applied = reply.get(0) == 1L,
      scored = reply.get(1),
      passed = reply.get(2),
      failed = reply.get(3)
    )
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

struct SampleResult {
  std::string run_id;
  std::string sample_id;
  std::string outcome;
};

struct Counters {
  bool applied;
  long long scored;
  long long passed;
  long long failed;
};

Counters recordSample(sw::redis::Redis& redis, const SampleResult& result) {
  // TODO: replace the client-side GET-then-INCR with one atomic script, add a per-sample dedupe
  // key so a redelivered Kafka message is not scored twice, and expire the counters with the run.
  const auto key = "evals:run:" + result.run_id;
  auto rawScored = redis.hget(key, "scored");
  auto rawPassed = redis.hget(key, "passed");
  auto rawFailed = redis.hget(key, "failed");
  const long long scored = rawScored ? std::stoll(*rawScored) : 0;
  const long long passed = rawPassed ? std::stoll(*rawPassed) : 0;
  const long long failed = rawFailed ? std::stoll(*rawFailed) : 0;
  redis.hincrby(key, "scored", 1);
  redis.hincrby(key, result.outcome, 1);
  return {true, scored + 1, result.outcome == "passed" ? passed + 1 : passed,
          result.outcome == "failed" ? failed + 1 : failed};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

constexpr long long kRunTTLS = 86400;

const char* kCountersLua = R"LUA(
local fresh = redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[3])
if not fresh then
  return {0, tonumber(redis.call('HGET', KEYS[2], 'scored')) or 0,
          tonumber(redis.call('HGET', KEYS[2], 'passed')) or 0,
          tonumber(redis.call('HGET', KEYS[2], 'failed')) or 0}
end
redis.call('HINCRBY', KEYS[2], 'scored', 1)
redis.call('HINCRBY', KEYS[2], ARGV[1], 1)
redis.call('EXPIRE', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[3])
return {1, tonumber(redis.call('HGET', KEYS[2], 'scored')) or 0,
        tonumber(redis.call('HGET', KEYS[2], 'passed')) or 0,
        tonumber(redis.call('HGET', KEYS[2], 'failed')) or 0}
)LUA";

struct SampleResult {
  std::string run_id;
  std::string sample_id;
  std::string outcome;
};

struct Counters {
  bool applied;
  long long scored;
  long long passed;
  long long failed;
};

std::string countersKey(const std::string& runId) {
  return "evals:run:" + runId;
}

std::string dedupeKey(const std::string& runId, const std::string& sampleId) {
  return "sample:" + runId + ":" + sampleId;
}

Counters recordSample(sw::redis::Redis& redis, const SampleResult& result) {
  const auto reply = redis.eval<std::vector<long long>>(
      kCountersLua,
      {dedupeKey(result.run_id, result.sample_id), countersKey(result.run_id)},
      {result.outcome, kRunTTLS});
  return {reply[0] == 1, reply[1], reply[2], reply[3]};
}
`,
    },
  },
  debrief: `The interview question behind this step is idempotence under at-least-once delivery, with an atomicity question hiding behind it. The client-side read-modify-write fails only when two samples land together, which is exactly what a run with real parallelism does, and the missing dedupe key fails only on a consumer rebalance — both are invisible in a demo that scores one sample at a time. One Lua script fixes all three: \`SET … NX\` claims the sample and reports whether it was fresh, the increments happen only for a fresh sample, and \`EXPIRE\` ties both keys to the run's lifetime. Returning the counters from the same script keeps the caller from reading another worker's progress. Real harnesses store the per-sample verdict durably and treat Redis as a cache, add a monotonic sequence so out-of-order results cannot revise a finished run, and keep a separate low-cardinality key for the dashboard counter.`,
};
