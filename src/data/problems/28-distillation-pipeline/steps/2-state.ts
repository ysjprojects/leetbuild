import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis job progress with an atomic deadline budget',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

The starter is a plausible model-generated draft: it spends budget, counts samples and answers a
verdict, so the demo dashboard moves. Two invariants are broken — one costs money, one loses
correctness. Find them, fix them, and prove the fix.

The worker records every sample against the job's Redis state. Keep the whole move in **one** Lua
script per language's client.

- The job has a **token budget** at \`distill:budget:{job_id}\`, seeded to
  \`sample_cap * TOKENS_PER_CALL\` when the job starts. Each teacher call that actually runs draws
  **exactly once** from it; a call the dedupe cache skips draws **nothing**.
- The dedupe set \`distill:seen:{job_id}\` holds the **SHA-256 of the prompt**, never the prompt
  text: the prompt is tenant content and Redis is not the place to keep it.
- A hash already in the set is a **duplicate**: it increments \`rejected\` in
  \`distill:progress:{job_id}\` and the reason counter \`duplicate\` in
  \`distill:reasons:{job_id}\`, and it does **not** touch the budget.
- A fresh sample **decrements the budget** and increments \`sampled\`, then either \`accepted\` or
  \`rejected\` (plus its reason) in the same script: the budget and all three counters move together,
  so a crash between them cannot pay for a sample nobody counted, or count one nobody paid for.
- Every key the job owns gets a **TTL** (\`TTL_S\` = 86 400) refreshed by the same script, so a
  finished or abandoned job stops pinning memory.
- The script returns \`(spent, remaining, verdict)\` — one round trip, no read-back race.
- A sample with no budget left is \`budget\`, not a call that runs and overspends.

**Failure mode the checks target.** Decrementing before the dedupe check is the expensive one: a
dataset with 40 percent repeated prompts drains the budget on samples that produce nothing, which is
exactly how a run ends with "accepted" counts its budget could never have paid for. The second flaw
is quieter: three separate \`HINCRBY\`s and a \`DECRBY\` are four chances for a worker to die mid-way
and leave counts that disagree with the budget forever.`,
  sequence: {
    participants: ['Worker', 'Redis', 'Lua script'],
    messages: [
      {from: 'Worker', to: 'Redis', label: 'record(job, prompt, outcome, reason) · EVAL', kind: 'sync'},
      {from: 'Redis', to: 'Lua script', label: 'SISMEMBER distill:seen:{job}', kind: 'sync'},
      {from: 'Lua script', to: 'Worker', label: 'duplicate → rejected += 1, budget untouched', kind: 'reply'},
      {from: 'Lua script', to: 'Lua script', label: 'DECRBY budget · HINCRBY sampled/accepted', kind: 'sync'},
      {from: 'Lua script', to: 'Redis', label: 'EXPIRE seen · budget · progress · reasons', kind: 'async'},
      {from: 'Lua script', to: 'Worker', label: '{spent, remaining, verdict}', kind: 'reply'},
    ],
  },
  hints: [
    'Order inside the script is the whole first half of the fix: read `SISMEMBER` on the dedupe set *before* any `DECRBY` on the budget, and return early on a hit. A cached prompt already paid for its teacher call in an earlier job — charging for it again is how the budget disappears without samples.',
    'The second half is atomicity: one registered script (redis-py `register_script`, ioredis `defineCommand`, go-redis `NewScript`, Jedis `eval`, redis-plus-plus `eval`) that does the membership test, the `DECRBY`, the `SADD` and every `HINCRBY`. Four separate commands are four chances to crash halfway.',
    'Keep the payload small and the keys self-cleaning: `SADD` the SHA-256 of the prompt, not the prompt, and `EXPIRE` every key in the same script with `TTL_S`. A job whose worker died should disappear on its own, not wait for a human to flush it.',
  ],
  checks: [
    {
      id: 'dedupe-before-spend',
      title: 'Checks the dedupe set before it spends budget',
      detail:
        '`SISMEMBER` on the dedupe set happens **before** any `DECRBY` on the budget, so a cached prompt costs nothing. The draft decrements first and only then looks at the cache, draining the budget on duplicates.',
      match: {
        python: {order: [/SISMEMBER/, /DECRBY/]},
        typescript: {order: [/SISMEMBER/, /DECRBY/]},
        go: {order: [/SISMEMBER/, /DECRBY/]},
        scala: {order: [/SISMEMBER/, /DECRBY/]},
        cpp: {order: [/SISMEMBER/, /DECRBY/]},
      },
    },
    {
      id: 'atomic-script',
      title: 'Moves budget and counters in one script',
      detail:
        'One Lua script does the membership test, the budget decrement and every counter increment, registered and called from the client (`register_script` / `defineCommand` / `NewScript` / `eval`). The draft issues separate `DECRBY`/`HINCRBY` commands, so a crash between them leaves the job’s state inconsistent.',
      match: {
        python: {all: [/register_script\(/, /redis\.call\(\s*['"]HINCRBY['"]/]},
        typescript: {all: [/defineCommand\(/, /redis\.call\(\s*['"]HINCRBY['"]/]},
        go: {all: [/redis\.NewScript\(/, /redis\.call\(\s*['"]HINCRBY['"]/]},
        scala: {all: [/jedis\.eval\(/, /redis\.call\(\s*['"]HINCRBY['"]/]},
        cpp: {all: [/\.eval\b/, /redis\.call\(\s*['"]HINCRBY['"]/]},
      },
    },
    {
      id: 'hashed-prompt',
      title: 'Stores the prompt hash, never the prompt',
      detail:
        'The dedupe set stores a SHA-256 of the prompt (`hashlib.sha256`, `createHash("sha256")`, `sha256.Sum256`, `MessageDigest.getInstance("SHA-256")`, `SHA256()`), and the hash is what `SISMEMBER` tests. The draft puts the raw prompt — tenant content — into a Redis key.',
      match: {
        python: {all: [/hashlib\.sha256\(/, /SISMEMBER/]},
        typescript: {all: [/createHash\(\s*'sha256'/, /SISMEMBER/]},
        go: {all: [/sha256\.Sum256\(/, /SISMEMBER/]},
        scala: {all: [/MessageDigest\.getInstance\("SHA-256"\)/, /SISMEMBER/]},
        cpp: {all: [/SHA256\(/, /SISMEMBER/]},
      },
    },
    {
      id: 'reject-reason',
      title: 'Records a reason for every rejection',
      detail:
        'A rejection increments a named reason counter in `distill:reasons:{job_id}` — `duplicate` for a hash already seen, otherwise the outcome’s own reason. The draft counts rejections without saying why, so a run that rejected 40 percent of its samples cannot be explained afterwards.',
      match: {
        python: {all: [/SISMEMBER/, /reason/]},
        typescript: {all: [/SISMEMBER/, /reason/]},
        go: {all: [/SISMEMBER/, /[Rr]eason/]},
        scala: {all: [/SISMEMBER/, /reason/]},
        cpp: {all: [/SISMEMBER/, /reason/]},
      },
    },
    {
      id: 'key-ttl',
      title: 'Expires the job keys from inside the script',
      detail:
        'The script runs `EXPIRE` on the keys it touches with the caller’s `TTL_S`, so a finished or abandoned job stops holding memory. The draft sets no expiry at all and leaves every job’s budget and counters in Redis forever.',
      match: {
        python: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /TTL_S/]},
        typescript: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /TTL_S/]},
        go: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /ttlSeconds/]},
        scala: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /TtlSeconds/]},
        cpp: {all: [/redis\.call\(\s*['"]EXPIRE['"]/, /kTtlSeconds/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

CACHE_PREFIX = "distill:seen:"
BUDGET_PREFIX = "distill:budget:"
PROGRESS_PREFIX = "distill:progress:"
TOKENS_PER_CALL = 512

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def record(job_id: str, prompt: str, outcome: str) -> dict:
    # TODO: this draft draws the budget down before it knows whether the call runs at all, stores
    # the raw prompt in Redis, and moves the three counters with three separate commands. Review
    # all three: a crash between them leaves progress that no longer matches the budget.
    budget_key = BUDGET_PREFIX + job_id
    progress_key = PROGRESS_PREFIX + job_id
    r.decrby(budget_key, TOKENS_PER_CALL)
    if r.sismember(CACHE_PREFIX + job_id, prompt):
        return {"spent": 0, "verdict": "duplicate"}
    r.sadd(CACHE_PREFIX + job_id, prompt)
    r.hincrby(progress_key, "sampled", 1)
    if outcome == "accepted":
        r.hincrby(progress_key, "accepted", 1)
    else:
        r.hincrby(progress_key, "rejected", 1)
    return {"spent": TOKENS_PER_CALL, "verdict": outcome}
`,
      solution: `import hashlib

import redis

CACHE_PREFIX = "distill:seen:"
BUDGET_PREFIX = "distill:budget:"
PROGRESS_PREFIX = "distill:progress:"
REASONS_PREFIX = "distill:reasons:"
TOKENS_PER_CALL = 512
TTL_S = 86_400

RECORD_SAMPLE = """
local seen, budget, progress, reasons = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local hash, cost, outcome, reason, ttl = ARGV[1], tonumber(ARGV[2]), ARGV[3], ARGV[4], tonumber(ARGV[5])
if redis.call('SISMEMBER', seen, hash) == 1 then
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
  return {0, redis.call('GET', budget), 'duplicate'}
end
local remaining = tonumber(redis.call('GET', budget) or '-1')
if remaining >= 0 and remaining < cost then
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
  return {0, tostring(remaining), 'budget'}
end
redis.call('DECRBY', budget, cost)
redis.call('SADD', seen, hash)
redis.call('HINCRBY', progress, 'sampled', 1)
if outcome == 'accepted' then
  redis.call('HINCRBY', progress, 'accepted', 1)
else
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
end
redis.call('EXPIRE', seen, ttl)
redis.call('EXPIRE', budget, ttl)
redis.call('EXPIRE', progress, ttl)
redis.call('EXPIRE', reasons, ttl)
return {1, redis.call('GET', budget), outcome}
"""

r = redis.Redis(host="redis", port=6379, decode_responses=True)
record_sample = r.register_script(RECORD_SAMPLE)


def start_job_state(job_id: str, sample_cap: int) -> None:
    """Seed the job's state: one teacher call costs TOKENS_PER_CALL of the job's budget."""
    r.set(BUDGET_PREFIX + job_id, TOKENS_PER_CALL * sample_cap, ex=TTL_S)
    r.hset(PROGRESS_PREFIX + job_id, mapping={"sampled": 0, "accepted": 0, "rejected": 0})
    r.expire(PROGRESS_PREFIX + job_id, TTL_S)


def record(job_id: str, prompt: str, outcome: str, reason: str = "none") -> dict:
    """One atomic move: the dedupe test, the budget and every counter, or none of them."""
    hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    spent, remaining, verdict = record_sample(
        keys=[
            CACHE_PREFIX + job_id,
            BUDGET_PREFIX + job_id,
            PROGRESS_PREFIX + job_id,
            REASONS_PREFIX + job_id,
        ],
        args=[hash, TOKENS_PER_CALL, outcome, reason, TTL_S],
        client=r,
    )
    return {"spent": int(spent), "remaining": int(remaining), "verdict": verdict}
`,
    },
    typescript: {
      starter: `/** Job progress in Redis: a model-generated draft that spends before it checks. */
import Redis from 'ioredis';

const CACHE_PREFIX = 'distill:seen:';
const BUDGET_PREFIX = 'distill:budget:';
const PROGRESS_PREFIX = 'distill:progress:';
const TOKENS_PER_CALL = 512;

export const redis = new Redis({host: 'redis', port: 6379});

export interface SampleOutcome {
  spent: number;
  verdict: string;
}

export async function record(jobId: string, prompt: string, outcome: string): Promise<SampleOutcome> {
  // TODO: this draft draws the budget down before it knows whether the call runs at all, stores the
  // raw prompt in Redis, and moves the three counters with three separate commands. Review all
  // three: a crash between them leaves progress that no longer matches the budget.
  await redis.decrby(BUDGET_PREFIX + jobId, TOKENS_PER_CALL);
  if ((await redis.sismember(CACHE_PREFIX + jobId, prompt)) === 1) return {spent: 0, verdict: 'duplicate'};
  await redis.sadd(CACHE_PREFIX + jobId, prompt);
  await redis.hincrby(PROGRESS_PREFIX + jobId, 'sampled', 1);
  if (outcome === 'accepted') await redis.hincrby(PROGRESS_PREFIX + jobId, 'accepted', 1);
  else await redis.hincrby(PROGRESS_PREFIX + jobId, 'rejected', 1);
  return {spent: TOKENS_PER_CALL, verdict: outcome};
}
`,
      solution: `/** Job progress in Redis: dedupe, budget and counters move in one script. */
import {createHash} from 'node:crypto';

import Redis from 'ioredis';

const CACHE_PREFIX = 'distill:seen:';
const BUDGET_PREFIX = 'distill:budget:';
const PROGRESS_PREFIX = 'distill:progress:';
const REASONS_PREFIX = 'distill:reasons:';
const TOKENS_PER_CALL = 512;
const TTL_S = 86_400;

const RECORD_SAMPLE = \`
local seen, budget, progress, reasons = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local hash, cost, outcome, reason, ttl = ARGV[1], tonumber(ARGV[2]), ARGV[3], ARGV[4], tonumber(ARGV[5])
if redis.call('SISMEMBER', seen, hash) == 1 then
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
  return {0, redis.call('GET', budget), 'duplicate'}
end
local remaining = tonumber(redis.call('GET', budget) or '-1')
if remaining >= 0 and remaining < cost then
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
  return {0, tostring(remaining), 'budget'}
end
redis.call('DECRBY', budget, cost)
redis.call('SADD', seen, hash)
redis.call('HINCRBY', progress, 'sampled', 1)
if outcome == 'accepted' then
  redis.call('HINCRBY', progress, 'accepted', 1)
else
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
end
redis.call('EXPIRE', seen, ttl)
redis.call('EXPIRE', budget, ttl)
redis.call('EXPIRE', progress, ttl)
redis.call('EXPIRE', reasons, ttl)
return {1, redis.call('GET', budget), outcome}
\`;

export interface SampleOutcome {
  spent: number;
  remaining: number;
  verdict: string;
}

interface DistillRedis extends Redis {
  recordSample(...args: (string | number)[]): Promise<[number, string, string]>;
}

export const redis = new Redis({host: 'redis', port: 6379}) as DistillRedis;
redis.defineCommand('recordSample', {numberOfKeys: 4, lua: RECORD_SAMPLE});

export async function startJobState(jobId: string, sampleCap: number): Promise<void> {
  await redis.set(BUDGET_PREFIX + jobId, TOKENS_PER_CALL * sampleCap, 'EX', TTL_S);
  await redis.hset(PROGRESS_PREFIX + jobId, {sampled: 0, accepted: 0, rejected: 0});
  await redis.expire(PROGRESS_PREFIX + jobId, TTL_S);
}

export async function record(jobId: string, prompt: string, outcome: string, reason = 'none'): Promise<SampleOutcome> {
  const hash = createHash('sha256').update(prompt, 'utf8').digest('hex');
  const [spent, remaining, verdict] = await redis.recordSample(
    CACHE_PREFIX + jobId,
    BUDGET_PREFIX + jobId,
    PROGRESS_PREFIX + jobId,
    REASONS_PREFIX + jobId,
    hash,
    TOKENS_PER_CALL,
    outcome,
    reason,
    TTL_S,
  );
  return {spent: Number(spent), remaining: Number(remaining), verdict: String(verdict)};
}
`,
    },
    go: {
      starter: `package state

import (
	"context"

	"github.com/redis/go-redis/v9"
)

const (
	cachePrefix    = "distill:seen:"
	budgetPrefix   = "distill:budget:"
	progressPrefix = "distill:progress:"
	tokensPerCall  = 512
)

type SampleOutcome struct {
	Spent   int64
	Verdict string
}

func Record(ctx context.Context, rdb *redis.Client, jobID, prompt, outcome string) (SampleOutcome, error) {
	// TODO: this draft draws the budget down before it knows whether the call runs at all, stores
	// the raw prompt in Redis, and moves the three counters with three separate commands. Review all
	// three: a crash between them leaves progress that no longer matches the budget.
	if err := rdb.DecrBy(ctx, budgetPrefix+jobID, tokensPerCall).Err(); err != nil {
		return SampleOutcome{}, err
	}
	if seen, err := rdb.SIsMember(ctx, cachePrefix+jobID, prompt).Result(); err != nil {
		return SampleOutcome{}, err
	} else if seen {
		return SampleOutcome{Verdict: "duplicate"}, nil
	}
	if err := rdb.SAdd(ctx, cachePrefix+jobID, prompt).Err(); err != nil {
		return SampleOutcome{}, err
	}
	if err := rdb.HIncrBy(ctx, progressPrefix+jobID, "sampled", 1).Err(); err != nil {
		return SampleOutcome{}, err
	}
	if outcome == "accepted" {
		if err := rdb.HIncrBy(ctx, progressPrefix+jobID, "accepted", 1).Err(); err != nil {
			return SampleOutcome{}, err
		}
	} else if err := rdb.HIncrBy(ctx, progressPrefix+jobID, "rejected", 1).Err(); err != nil {
		return SampleOutcome{}, err
	}
	return SampleOutcome{Spent: tokensPerCall, Verdict: outcome}, nil
}
`,
      solution: `package state

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	cachePrefix    = "distill:seen:"
	budgetPrefix   = "distill:budget:"
	progressPrefix = "distill:progress:"
	reasonsPrefix  = "distill:reasons:"
	tokensPerCall  = 512
	ttlSeconds     = 86400
)

var recordSampleCmd = redis.NewScript(\`
local seen, budget, progress, reasons = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local hash, cost, outcome, reason, ttl = ARGV[1], tonumber(ARGV[2]), ARGV[3], ARGV[4], tonumber(ARGV[5])
if redis.call('SISMEMBER', seen, hash) == 1 then
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
  return {0, redis.call('GET', budget), 'duplicate'}
end
local remaining = tonumber(redis.call('GET', budget) or '-1')
if remaining >= 0 and remaining < cost then
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
  return {0, tostring(remaining), 'budget'}
end
redis.call('DECRBY', budget, cost)
redis.call('SADD', seen, hash)
redis.call('HINCRBY', progress, 'sampled', 1)
if outcome == 'accepted' then
  redis.call('HINCRBY', progress, 'accepted', 1)
else
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
end
redis.call('EXPIRE', seen, ttl)
redis.call('EXPIRE', budget, ttl)
redis.call('EXPIRE', progress, ttl)
redis.call('EXPIRE', reasons, ttl)
return {1, redis.call('GET', budget), outcome}
\`)

type SampleOutcome struct {
	Spent     int64
	Remaining int64
	Verdict   string
}

func StartJobState(ctx context.Context, rdb *redis.Client, jobID string, sampleCap int) error {
	ttl := time.Duration(ttlSeconds) * time.Second
	if err := rdb.Set(ctx, budgetPrefix+jobID, tokensPerCall*sampleCap, ttl).Err(); err != nil {
		return err
	}
	if err := rdb.HSet(ctx, progressPrefix+jobID, map[string]any{"sampled": 0, "accepted": 0, "rejected": 0}).Err(); err != nil {
		return err
	}
	return rdb.Expire(ctx, progressPrefix+jobID, ttl).Err()
}

func Record(ctx context.Context, rdb *redis.Client, jobID, prompt, outcome, reason string) (SampleOutcome, error) {
	sum := sha256.Sum256([]byte(prompt))
	keys := []string{cachePrefix + jobID, budgetPrefix + jobID, progressPrefix + jobID, reasonsPrefix + jobID}
	values, err := recordSampleCmd.Run(
		ctx, rdb, keys,
		hex.EncodeToString(sum[:]), tokensPerCall, outcome, reason, ttlSeconds,
	).Slice()
	if err != nil {
		return SampleOutcome{}, err
	}
	spent, _ := values[0].(int64)
	remaining, _ := strconv.ParseInt(values[1].(string), 10, 64)
	verdict, _ := values[2].(string)
	return SampleOutcome{Spent: spent, Remaining: remaining, Verdict: verdict}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object JobState {
  val CachePrefix = "distill:seen:"
  val BudgetPrefix = "distill:budget:"
  val ProgressPrefix = "distill:progress:"
  val TokensPerCall = 512

  val jedis = new Jedis("redis", 6379)

  def record(jobId: String, prompt: String, outcome: String): Unit = {
    // TODO: this draft draws the budget down before it knows whether the call runs at all, stores
    // the raw prompt in Redis, and moves the three counters with three separate commands. Review
    // all three: a crash between them leaves progress that no longer matches the budget.
    jedis.decrBy(BudgetPrefix + jobId, TokensPerCall)
    if (jedis.sismember(CachePrefix + jobId, prompt)) return
    jedis.sadd(CachePrefix + jobId, prompt)
    jedis.hincrBy(ProgressPrefix + jobId, "sampled", 1L)
    if (outcome == "accepted") jedis.hincrBy(ProgressPrefix + jobId, "accepted", 1L)
    else jedis.hincrBy(ProgressPrefix + jobId, "rejected", 1L)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util

import redis.clients.jedis.Jedis

object JobState {
  val CachePrefix = "distill:seen:"
  val BudgetPrefix = "distill:budget:"
  val ProgressPrefix = "distill:progress:"
  val ReasonsPrefix = "distill:reasons:"
  val TokensPerCall = 512
  val TtlSeconds = 86400

  val RecordSample: String =
    """local seen, budget, progress, reasons = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local hash, cost, outcome, reason, ttl = ARGV[1], tonumber(ARGV[2]), ARGV[3], ARGV[4], tonumber(ARGV[5])
if redis.call('SISMEMBER', seen, hash) == 1 then
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
  return {0, redis.call('GET', budget), 'duplicate'}
end
local remaining = tonumber(redis.call('GET', budget) or '-1')
if remaining >= 0 and remaining < cost then
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
  return {0, tostring(remaining), 'budget'}
end
redis.call('DECRBY', budget, cost)
redis.call('SADD', seen, hash)
redis.call('HINCRBY', progress, 'sampled', 1)
if outcome == 'accepted' then
  redis.call('HINCRBY', progress, 'accepted', 1)
else
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
end
redis.call('EXPIRE', seen, ttl)
redis.call('EXPIRE', budget, ttl)
redis.call('EXPIRE', progress, ttl)
redis.call('EXPIRE', reasons, ttl)
return {1, redis.call('GET', budget), outcome}"""

  val jedis = new Jedis("redis", 6379)

  def startJobState(jobId: String, sampleCap: Int): Unit = {
    jedis.setex(BudgetPrefix + jobId, TtlSeconds, (TokensPerCall * sampleCap).toString)
    jedis.hset(ProgressPrefix + jobId, util.Map.of("sampled", "0", "accepted", "0", "rejected", "0"))
    jedis.expire(ProgressPrefix + jobId, TtlSeconds)
  }

  def record(jobId: String, prompt: String, outcome: String, reason: String = "none"): util.List[String] = {
    val digest = MessageDigest.getInstance("SHA-256")
    val hash = digest.digest(prompt.getBytes(StandardCharsets.UTF_8)).map("%02x".format(_)).mkString
    val keys = util.Arrays.asList(
      CachePrefix + jobId,
      BudgetPrefix + jobId,
      ProgressPrefix + jobId,
      ReasonsPrefix + jobId
    )
    val args = util.Arrays.asList(hash, TokensPerCall.toString, outcome, reason, TtlSeconds.toString)
    jedis.eval(RecordSample, keys, args)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

constexpr int kTokensPerCall = 512;
const std::string kCachePrefix = "distill:seen:";
const std::string kBudgetPrefix = "distill:budget:";
const std::string kProgressPrefix = "distill:progress:";

struct SampleOutcome {
  long long spent;
  std::string verdict;
};

SampleOutcome record(sw::redis::Redis& redis, const std::string& jobId, const std::string& prompt,
                     const std::string& outcome) {
  // TODO: this draft draws the budget down before it knows whether the call runs at all, stores the
  // raw prompt in Redis, and moves the three counters with three separate commands. Review all
  // three: a crash between them leaves progress that no longer matches the budget.
  redis.decrby(kBudgetPrefix + jobId, kTokensPerCall);
  if (redis.sismember(kCachePrefix + jobId, prompt)) return {0, "duplicate"};
  redis.sadd(kCachePrefix + jobId, prompt);
  redis.hincrby(kProgressPrefix + jobId, "sampled", 1);
  if (outcome == "accepted") redis.hincrby(kProgressPrefix + jobId, "accepted", 1);
  else redis.hincrby(kProgressPrefix + jobId, "rejected", 1);
  return {kTokensPerCall, outcome};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <openssl/sha.h>

#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

constexpr int kTokensPerCall = 512;
constexpr int kTtlSeconds = 86400;
const std::string kCachePrefix = "distill:seen:";
const std::string kBudgetPrefix = "distill:budget:";
const std::string kProgressPrefix = "distill:progress:";
const std::string kReasonsPrefix = "distill:reasons:";

const std::string kRecordSample = R"lua(
local seen, budget, progress, reasons = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local hash, cost, outcome, reason, ttl = ARGV[1], tonumber(ARGV[2]), ARGV[3], ARGV[4], tonumber(ARGV[5])
if redis.call('SISMEMBER', seen, hash) == 1 then
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
  return {0, redis.call('GET', budget), 'duplicate'}
end
local remaining = tonumber(redis.call('GET', budget) or '-1')
if remaining >= 0 and remaining < cost then
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
  return {0, tostring(remaining), 'budget'}
end
redis.call('DECRBY', budget, cost)
redis.call('SADD', seen, hash)
redis.call('HINCRBY', progress, 'sampled', 1)
if outcome == 'accepted' then
  redis.call('HINCRBY', progress, 'accepted', 1)
else
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
end
redis.call('EXPIRE', seen, ttl)
redis.call('EXPIRE', budget, ttl)
redis.call('EXPIRE', progress, ttl)
redis.call('EXPIRE', reasons, ttl)
return {1, redis.call('GET', budget), outcome}
)lua";

struct SampleOutcome {
  long long spent;
  long long remaining;
  std::string verdict;
};

void startJobState(sw::redis::Redis& redis, const std::string& jobId, int sampleCap) {
  redis.setex(kBudgetPrefix + jobId, kTtlSeconds, std::to_string(kTokensPerCall * sampleCap));
  redis.hset(kProgressPrefix + jobId, "sampled", "0");
  redis.hset(kProgressPrefix + jobId, "accepted", "0");
  redis.hset(kProgressPrefix + jobId, "rejected", "0");
  redis.expire(kProgressPrefix + jobId, kTtlSeconds);
}

SampleOutcome record(sw::redis::Redis& redis, const std::string& jobId, const std::string& prompt,
                     const std::string& outcome, const std::string& reason) {
  unsigned char digest[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(prompt.data()), prompt.size(), digest);
  std::ostringstream hash;
  for (unsigned char byte : digest) {
    hash << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte);
  }
  const std::vector<std::string> keys = {
      kCachePrefix + jobId, kBudgetPrefix + jobId, kProgressPrefix + jobId, kReasonsPrefix + jobId};
  const std::vector<std::string> args = {
      hash.str(), std::to_string(kTokensPerCall), outcome, reason, std::to_string(kTtlSeconds)};
  const auto reply = redis.eval<std::vector<std::string>>(kRecordSample, keys, args);
  SampleOutcome result{0, 0, "none"};
  if (reply.size() == 3) {
    result.spent = std::stoll(reply[0]);
    result.remaining = std::stoll(reply[1]);
    result.verdict = reply[2];
  }
  return result;
}
`,
    },
  },
  debrief: `This is the step where a distillation run either has a budget or has a story about one. The draft passes review because the counters move and the demo shows a rate; what it hides is that a duplicate prompt costs a teacher call it never made, and that four separate commands are four chances to leave the budget and the counters disagreeing forever. The invariant to state out loud is "budget spent equals unique teacher calls that ran": the dedupe test comes first, the decrement happens once, and the counters move in the same script as the decrement. Real pipelines add near-duplicate detection on embeddings, a reservation before the call rather than after, and per-job keys hashed into a Redis Cluster slot so the script stays runnable.`,
};
