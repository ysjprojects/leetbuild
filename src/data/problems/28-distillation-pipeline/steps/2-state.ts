import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis job state: a budget reservation in one script',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter keeps a job's state under the keys \`distill/config\` defines:
\`start_job(job_id, sample_cap)\` seeds the budget to \`sample_cap * TOKENS_PER_CALL\` and zero counters;
\`reserve(job_id, prompt)\` draws one call from the budget, tests the prompt against the seen set and
answers \`{verdict, remaining, dedupe_hash}\` with \`ok\` or \`duplicate\`; \`record(job_id, outcome, reason)\`
bumps \`accepted\` or \`rejected\`. The demo dashboard moves. It hides five flaws.

**Failure mode the checks target.** Drawing the budget before the dedupe test is the expensive one: a
dataset with 40 percent repeated prompts drains the budget on samples that produce nothing, which is how
a run ends with "accepted" counts its budget could never have paid for. Separate commands cost
correctness: two workers with the same prompt both see an empty set, and a worker that dies between
DECRBY and HINCRBY leaves counters that disagree with the budget.

Requirements, kept by **one Lua script** per operation:

- \`reserve\`: a prompt whose SHA-256 is in \`distill:seen:{job_id}\` is a \`duplicate\` (\`duplicate\` up,
  budget untouched); with fewer than \`TOKENS_PER_CALL\` tokens left the verdict is \`budget\` (\`sampled\`
  and \`rejected\` up, reason \`budget\`, budget untouched); otherwise \`DECRBY\`, \`SADD\` the hash,
  \`sampled\` up, verdict \`ok\`.
- The set holds the hash, not the prompt: the prompt is tenant content.
- \`record(job_id, "rejected", reason)\` counts the reason by name in \`distill:reasons:{job_id}\`.
- Every script stamps \`updated_at\` (unix seconds) in the progress hash and refreshes a \`TTL_S\` expiry
  on the keys it touched.
- Invariant through step 5: \`sampled == accepted + rejected\` once every reservation is recorded.`,
  sequence: {
    participants: ['Worker', 'Redis'],
    messages: [
      {
        from: 'Worker',
        to: 'Redis',
        label: 'EVALSHA reserve · seen budget progress reasons · hash cost ttl now',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'SISMEMBER seen hash → 0 · GET budget ≥ cost', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'DECRBY budget · SADD seen · HINCRBY sampled · EXPIRE ×4', kind: 'sync'},
      {from: 'Redis', to: 'Worker', label: '{ok, remaining}', kind: 'reply'},
      {
        from: 'Worker',
        to: 'Redis',
        label: 'EVALSHA record · progress reasons · rejected refusal ttl now',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Worker', label: 'sampled', kind: 'reply'},
    ],
  },
  hints: [
    'Symptom: a job with 40 percent repeated prompts runs out of budget at 60 percent of its cap, two workers on the same prompt both get `ok`, and a worker crash leaves `sampled` ahead of the budget.',
    'Mechanism: `reserve` runs DECRBY first and SISMEMBER second, so a duplicate pays; the commands are separate round trips, so another worker lands between them; the member is the raw prompt, and nothing expires.',
    'Change: one `register_script` / `defineCommand` / `NewScript` / `eval` per operation: SISMEMBER, then GET and the budget floor, then DECRBY + SADD + HINCRBY, HSET updated_at, EXPIRE each key; SADD the `sha256` hex.',
  ],
  checks: [
    {
      id: 'dedupe-before-spend',
      title: 'A duplicate costs nothing and the budget stays at or above zero',
      detail:
        'SISMEMBER runs before any DECRBY, so a repeated prompt leaves the budget where it was; with fewer than TOKENS_PER_CALL tokens left the verdict is budget and nothing is drawn. The starter decrements first and looks at the set second.',
      match: {
        python: {order: [/SISMEMBER/, /DECRBY/], none: [/\.decrby\(/]},
        typescript: {order: [/SISMEMBER/, /DECRBY/], none: [/\.decrby\(/]},
        go: {order: [/SISMEMBER/, /DECRBY/], none: [/\.DecrBy\(/]},
        scala: {order: [/SISMEMBER/, /DECRBY/], none: [/\.decrBy\(/]},
        cpp: {order: [/SISMEMBER/, /DECRBY/], none: [/\.decrby\(/]},
      },
    },
    {
      id: 'atomic-script',
      title: 'Reserves in one Lua script',
      detail:
        'The membership test, the budget floor, DECRBY, SADD and HINCRBY happen inside one EVAL/EVALSHA, so two workers reserving the same prompt spend once. The starter issues them as separate commands and a second worker lands between them.',
      match: {
        python: {
          all: [
            /register_script\(|\.eval\(|\.evalsha\(/,
            /redis\.call\(\s*['"]DECRBY['"]/,
            /redis\.call\(\s*['"]SADD['"]/,
          ],
        },
        typescript: {
          all: [
            /defineCommand\(|\.eval\(|\.evalsha\(/,
            /redis\.call\(\s*['"]DECRBY['"]/,
            /redis\.call\(\s*['"]SADD['"]/,
          ],
        },
        go: {
          all: [
            /redis\.NewScript\(|\.Eval\(|\.EvalSha\(/,
            /redis\.call\(\s*['"]DECRBY['"]/,
            /redis\.call\(\s*['"]SADD['"]/,
          ],
        },
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]DECRBY['"]/, /redis\.call\(\s*['"]SADD['"]/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]DECRBY['"]/, /redis\.call\(\s*['"]SADD['"]/]},
      },
    },
    {
      id: 'hashed-prompt',
      title: 'Stores the SHA-256 of the prompt, not the prompt',
      detail:
        'The seen set holds the hex SHA-256 of the prompt and reserve answers it as dedupe_hash; the prompt text appears in no key and no member. The starter puts the raw prompt, tenant content, into Redis.',
      match: {
        python: {
          all: [/hashlib\.sha256\(/],
          none: [/\.s(is)?member\(\s*[^,]+,\s*prompt\s*\)|\.sadd\(\s*[^,]+,\s*prompt\s*\)/],
        },
        typescript: {
          all: [/createHash\(\s*['"]sha256['"]/],
          none: [/\.s(is)?member\(\s*[^,]+,\s*prompt\s*\)|\.sadd\(\s*[^,]+,\s*prompt\s*\)/],
        },
        go: {
          all: [/sha256\.Sum256\(/],
          none: [/\.S(Is)?Member\(\s*[^,]+,\s*[^,]+,\s*prompt\s*\)|\.SAdd\(\s*[^,]+,\s*[^,]+,\s*prompt\s*\)/],
        },
        scala: {
          all: [/MessageDigest\.getInstance\("SHA-256"\)/],
          none: [/\.s(is)?member\(\s*[^,]+,\s*prompt\s*\)|\.sadd\(\s*[^,]+,\s*prompt\s*\)/],
        },
        cpp: {all: [/sha256_hex\(/], none: [/\.s(is)?member\(\s*[^,]+,\s*prompt\s*\)|\.sadd\(\s*[^,]+,\s*prompt\s*\)/]},
      },
    },
    {
      id: 'reject-reason',
      title: 'Records a reason for every rejection',
      detail:
        'A rejection increments its reason in distill:reasons:{job_id} (refusal, empty, deadline, unavailable, budget) beside rejected, so a run that rejected 40 percent of its samples can be explained. The starter counts rejections and nothing else.',
      match: {
        python: {all: [/reasons_key\(|distill:reasons:/, /HINCRBY/]},
        typescript: {all: [/reasonsKey\(|distill:reasons:/, /HINCRBY/]},
        go: {all: [/ReasonsKey\(|distill:reasons:/, /HINCRBY/]},
        scala: {all: [/reasonsKey\(|distill:reasons:/, /HINCRBY/]},
        cpp: {all: [/reasons_key\(|distill:reasons:/, /HINCRBY/]},
      },
    },
    {
      id: 'key-ttl',
      title: 'Expires the job keys and stamps updated_at from inside the script',
      detail:
        'Every key the script touches gets EXPIRE TTL_S and the progress hash carries updated_at, so an abandoned job disappears on its own and a report can tell two readings apart. The starter sets no expiry and no stamp.',
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
      starter: `import redis

from distill.config import TOKENS_PER_CALL, budget_key, progress_key, seen_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def start_job(job_id: str, sample_cap: int) -> None:
    """Seed the job's state: one teacher call costs TOKENS_PER_CALL of the job's budget."""
    r.set(budget_key(job_id), sample_cap * TOKENS_PER_CALL)
    r.hset(progress_key(job_id), mapping={"sampled": 0, "accepted": 0, "rejected": 0, "duplicate": 0})


def reserve(job_id: str, prompt: str) -> dict:
    """Pay for one teacher call unless the prompt was sampled already: {verdict, remaining, dedupe_hash}."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    remaining = r.decrby(budget_key(job_id), TOKENS_PER_CALL)
    if r.sismember(seen_key(job_id), prompt):
        r.hincrby(progress_key(job_id), "duplicate", 1)
        return {"verdict": "duplicate", "remaining": remaining, "dedupe_hash": prompt}
    r.sadd(seen_key(job_id), prompt)
    r.hincrby(progress_key(job_id), "sampled", 1)
    return {"verdict": "ok", "remaining": remaining, "dedupe_hash": prompt}


def record(job_id: str, outcome: str, reason: str = "") -> None:
    """Count the sample's outcome: accepted, or rejected with its reason."""
    r.hincrby(progress_key(job_id), "accepted" if outcome == "accepted" else "rejected", 1)
`,
      solution: `import hashlib
import time

import redis

from distill.config import TOKENS_PER_CALL, TTL_S, budget_key, progress_key, reasons_key, seen_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

RESERVE = """
local seen, budget, progress, reasons = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local hash, cost, ttl, now = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
if redis.call('SISMEMBER', seen, hash) == 1 then
  redis.call('HINCRBY', progress, 'duplicate', 1)
  redis.call('HSET', progress, 'updated_at', now)
  redis.call('EXPIRE', progress, ttl)
  return {'duplicate', redis.call('GET', budget) or '0'}
end
local remaining = tonumber(redis.call('GET', budget) or '0')
if remaining < cost then
  redis.call('HINCRBY', progress, 'sampled', 1)
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, 'budget', 1)
  redis.call('HSET', progress, 'updated_at', now)
  redis.call('EXPIRE', progress, ttl)
  redis.call('EXPIRE', reasons, ttl)
  return {'budget', tostring(remaining)}
end
remaining = redis.call('DECRBY', budget, cost)
redis.call('SADD', seen, hash)
redis.call('HINCRBY', progress, 'sampled', 1)
redis.call('HSET', progress, 'updated_at', now)
redis.call('EXPIRE', seen, ttl)
redis.call('EXPIRE', budget, ttl)
redis.call('EXPIRE', progress, ttl)
redis.call('EXPIRE', reasons, ttl)
return {'ok', tostring(remaining)}
"""

RECORD = """
local progress, reasons = KEYS[1], KEYS[2]
local outcome, reason, ttl, now = ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4]
if outcome == 'accepted' then
  redis.call('HINCRBY', progress, 'accepted', 1)
else
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
  redis.call('EXPIRE', reasons, ttl)
end
redis.call('HSET', progress, 'updated_at', now)
redis.call('EXPIRE', progress, ttl)
return redis.call('HGET', progress, 'sampled')
"""

reserve_sample = r.register_script(RESERVE)
record_outcome = r.register_script(RECORD)


def start_job(job_id: str, sample_cap: int) -> None:
    """Seed the job's state: one teacher call costs TOKENS_PER_CALL of the job's budget."""
    r.set(budget_key(job_id), sample_cap * TOKENS_PER_CALL, ex=TTL_S)
    r.hset(progress_key(job_id), mapping={"sampled": 0, "accepted": 0, "rejected": 0, "duplicate": 0, "updated_at": int(time.time())})
    r.expire(progress_key(job_id), TTL_S)


def reserve(job_id: str, prompt: str) -> dict:
    """Pay for one teacher call unless the prompt was sampled already: {verdict, remaining, dedupe_hash}."""
    dedupe_hash = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
    verdict, remaining = reserve_sample(
        keys=[seen_key(job_id), budget_key(job_id), progress_key(job_id), reasons_key(job_id)],
        args=[dedupe_hash, TOKENS_PER_CALL, TTL_S, int(time.time())],
    )
    return {"verdict": verdict, "remaining": int(remaining), "dedupe_hash": dedupe_hash}


def record(job_id: str, outcome: str, reason: str = "") -> None:
    """Count the sample's outcome: accepted, or rejected with its reason."""
    record_outcome(
        keys=[progress_key(job_id), reasons_key(job_id)],
        args=[outcome, reason or "unknown", TTL_S, int(time.time())],
    )
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {TOKENS_PER_CALL, budgetKey, progressKey, seenKey} from 'distill/config';

export const redis = new Redis({host: 'redis', port: 6379});

export interface Reservation {
  verdict: 'ok' | 'duplicate' | 'budget';
  remaining: number;
  dedupeHash: string;
}

/** Seed the job's state: one teacher call costs TOKENS_PER_CALL of the job's budget. */
export async function startJob(jobId: string, sampleCap: number): Promise<void> {
  await redis.set(budgetKey(jobId), sampleCap * TOKENS_PER_CALL);
  await redis.hset(progressKey(jobId), {sampled: 0, accepted: 0, rejected: 0, duplicate: 0});
}

/** Pay for one teacher call unless the prompt was sampled already. */
export async function reserve(jobId: string, prompt: string): Promise<Reservation> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const remaining = await redis.decrby(budgetKey(jobId), TOKENS_PER_CALL);
  if ((await redis.sismember(seenKey(jobId), prompt)) === 1) {
    await redis.hincrby(progressKey(jobId), 'duplicate', 1);
    return {verdict: 'duplicate', remaining, dedupeHash: prompt};
  }
  await redis.sadd(seenKey(jobId), prompt);
  await redis.hincrby(progressKey(jobId), 'sampled', 1);
  return {verdict: 'ok', remaining, dedupeHash: prompt};
}

/** Count the sample's outcome: accepted, or rejected with its reason. */
export async function record(jobId: string, outcome: string, reason = ''): Promise<void> {
  void reason;
  await redis.hincrby(progressKey(jobId), outcome === 'accepted' ? 'accepted' : 'rejected', 1);
}
`,
      solution: `import {createHash} from 'node:crypto';

import Redis from 'ioredis';

import {TOKENS_PER_CALL, TTL_S, budgetKey, progressKey, reasonsKey, seenKey} from 'distill/config';

const RESERVE = \`
local seen, budget, progress, reasons = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local hash, cost, ttl, now = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
if redis.call('SISMEMBER', seen, hash) == 1 then
  redis.call('HINCRBY', progress, 'duplicate', 1)
  redis.call('HSET', progress, 'updated_at', now)
  redis.call('EXPIRE', progress, ttl)
  return {'duplicate', redis.call('GET', budget) or '0'}
end
local remaining = tonumber(redis.call('GET', budget) or '0')
if remaining < cost then
  redis.call('HINCRBY', progress, 'sampled', 1)
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, 'budget', 1)
  redis.call('HSET', progress, 'updated_at', now)
  redis.call('EXPIRE', progress, ttl)
  redis.call('EXPIRE', reasons, ttl)
  return {'budget', tostring(remaining)}
end
remaining = redis.call('DECRBY', budget, cost)
redis.call('SADD', seen, hash)
redis.call('HINCRBY', progress, 'sampled', 1)
redis.call('HSET', progress, 'updated_at', now)
redis.call('EXPIRE', seen, ttl)
redis.call('EXPIRE', budget, ttl)
redis.call('EXPIRE', progress, ttl)
redis.call('EXPIRE', reasons, ttl)
return {'ok', tostring(remaining)}
\`;

const RECORD = \`
local progress, reasons = KEYS[1], KEYS[2]
local outcome, reason, ttl, now = ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4]
if outcome == 'accepted' then
  redis.call('HINCRBY', progress, 'accepted', 1)
else
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
  redis.call('EXPIRE', reasons, ttl)
end
redis.call('HSET', progress, 'updated_at', now)
redis.call('EXPIRE', progress, ttl)
return redis.call('HGET', progress, 'sampled')
\`;

interface StateRedis extends Redis {
  reserveSample(seen: string, budget: string, progress: string, reasons: string, hash: string, cost: number, ttl: number, now: number): Promise<[string, string]>;
  recordOutcome(progress: string, reasons: string, outcome: string, reason: string, ttl: number, now: number): Promise<string>;
}

export const redis = new Redis({host: 'redis', port: 6379}) as StateRedis;
redis.defineCommand('reserveSample', {numberOfKeys: 4, lua: RESERVE});
redis.defineCommand('recordOutcome', {numberOfKeys: 2, lua: RECORD});

export interface Reservation {
  verdict: 'ok' | 'duplicate' | 'budget';
  remaining: number;
  dedupeHash: string;
}

const now = (): number => Math.floor(Date.now() / 1000);

/** Seed the job's state: one teacher call costs TOKENS_PER_CALL of the job's budget. */
export async function startJob(jobId: string, sampleCap: number): Promise<void> {
  await redis.set(budgetKey(jobId), sampleCap * TOKENS_PER_CALL, 'EX', TTL_S);
  await redis.hset(progressKey(jobId), {sampled: 0, accepted: 0, rejected: 0, duplicate: 0, updated_at: now()});
  await redis.expire(progressKey(jobId), TTL_S);
}

/** Pay for one teacher call unless the prompt was sampled already. */
export async function reserve(jobId: string, prompt: string): Promise<Reservation> {
  const dedupeHash = createHash('sha256').update(prompt).digest('hex');
  const [verdict, remaining] = await redis.reserveSample(
    seenKey(jobId), budgetKey(jobId), progressKey(jobId), reasonsKey(jobId),
    dedupeHash, TOKENS_PER_CALL, TTL_S, now(),
  );
  return {verdict: verdict as Reservation['verdict'], remaining: Number(remaining), dedupeHash};
}

/** Count the sample's outcome: accepted, or rejected with its reason. */
export async function record(jobId: string, outcome: string, reason = ''): Promise<void> {
  await redis.recordOutcome(progressKey(jobId), reasonsKey(jobId), outcome, reason || 'unknown', TTL_S, now());
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"

	"distill/config" // config.TokensPerCall, config.TTLSeconds, config.BudgetKey/SeenKey/ProgressKey/ReasonsKey — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Reservation is reserve's answer: the verdict (ok, duplicate, budget), the tokens left, the prompt's hash.
type Reservation struct {
	Verdict    string
	Remaining  int64
	DedupeHash string
}

// startJob seeds the job's state: one teacher call costs TokensPerCall of the job's budget.
func startJob(ctx context.Context, jobID string, sampleCap int) error {
	if err := rdb.Set(ctx, config.BudgetKey(jobID), int64(sampleCap)*config.TokensPerCall, 0).Err(); err != nil {
		return err
	}
	return rdb.HSet(ctx, config.ProgressKey(jobID), "sampled", 0, "accepted", 0, "rejected", 0, "duplicate", 0).Err()
}

// reserve pays for one teacher call unless the prompt was sampled already.
func reserve(ctx context.Context, jobID, prompt string) (Reservation, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	remaining, err := rdb.DecrBy(ctx, config.BudgetKey(jobID), config.TokensPerCall).Result()
	if err != nil {
		return Reservation{}, err
	}
	seen, err := rdb.SIsMember(ctx, config.SeenKey(jobID), prompt).Result()
	if err != nil {
		return Reservation{}, err
	}
	if seen {
		rdb.HIncrBy(ctx, config.ProgressKey(jobID), "duplicate", 1)
		return Reservation{Verdict: "duplicate", Remaining: remaining, DedupeHash: prompt}, nil
	}
	rdb.SAdd(ctx, config.SeenKey(jobID), prompt)
	rdb.HIncrBy(ctx, config.ProgressKey(jobID), "sampled", 1)
	return Reservation{Verdict: "ok", Remaining: remaining, DedupeHash: prompt}, nil
}

// record counts the sample's outcome: accepted, or rejected with its reason.
func record(ctx context.Context, jobID, outcome, reason string) error {
	field := "rejected"
	if outcome == "accepted" {
		field = "accepted"
	}
	_ = reason
	return rdb.HIncrBy(ctx, config.ProgressKey(jobID), field, 1).Err()
}

func main() {
	ctx := context.Background()
	if err := startJob(ctx, "job-demo", 100); err != nil {
		fmt.Println(err)
	}
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"distill/config" // config.TokensPerCall, config.TTLSeconds, config.BudgetKey/SeenKey/ProgressKey/ReasonsKey — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var reserveSample = redis.NewScript(\`
local seen, budget, progress, reasons = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local hash, cost, ttl, now = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
if redis.call('SISMEMBER', seen, hash) == 1 then
  redis.call('HINCRBY', progress, 'duplicate', 1)
  redis.call('HSET', progress, 'updated_at', now)
  redis.call('EXPIRE', progress, ttl)
  return {'duplicate', redis.call('GET', budget) or '0'}
end
local remaining = tonumber(redis.call('GET', budget) or '0')
if remaining < cost then
  redis.call('HINCRBY', progress, 'sampled', 1)
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, 'budget', 1)
  redis.call('HSET', progress, 'updated_at', now)
  redis.call('EXPIRE', progress, ttl)
  redis.call('EXPIRE', reasons, ttl)
  return {'budget', tostring(remaining)}
end
remaining = redis.call('DECRBY', budget, cost)
redis.call('SADD', seen, hash)
redis.call('HINCRBY', progress, 'sampled', 1)
redis.call('HSET', progress, 'updated_at', now)
redis.call('EXPIRE', seen, ttl)
redis.call('EXPIRE', budget, ttl)
redis.call('EXPIRE', progress, ttl)
redis.call('EXPIRE', reasons, ttl)
return {'ok', tostring(remaining)}
\`)

var recordOutcome = redis.NewScript(\`
local progress, reasons = KEYS[1], KEYS[2]
local outcome, reason, ttl, now = ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4]
if outcome == 'accepted' then
  redis.call('HINCRBY', progress, 'accepted', 1)
else
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
  redis.call('EXPIRE', reasons, ttl)
end
redis.call('HSET', progress, 'updated_at', now)
redis.call('EXPIRE', progress, ttl)
return redis.call('HGET', progress, 'sampled')
\`)

// Reservation is reserve's answer: the verdict (ok, duplicate, budget), the tokens left, the prompt's hash.
type Reservation struct {
	Verdict    string
	Remaining  int64
	DedupeHash string
}

// startJob seeds the job's state: one teacher call costs TokensPerCall of the job's budget.
func startJob(ctx context.Context, jobID string, sampleCap int) error {
	if err := rdb.Set(ctx, config.BudgetKey(jobID), int64(sampleCap)*config.TokensPerCall, config.TTLSeconds*time.Second).Err(); err != nil {
		return err
	}
	if err := rdb.HSet(ctx, config.ProgressKey(jobID), "sampled", 0, "accepted", 0, "rejected", 0, "duplicate", 0, "updated_at", time.Now().Unix()).Err(); err != nil {
		return err
	}
	return rdb.Expire(ctx, config.ProgressKey(jobID), config.TTLSeconds*time.Second).Err()
}

// reserve pays for one teacher call unless the prompt was sampled already.
func reserve(ctx context.Context, jobID, prompt string) (Reservation, error) {
	sum := sha256.Sum256([]byte(prompt))
	dedupeHash := hex.EncodeToString(sum[:])
	keys := []string{config.SeenKey(jobID), config.BudgetKey(jobID), config.ProgressKey(jobID), config.ReasonsKey(jobID)}
	reply, err := reserveSample.Run(ctx, rdb, keys, dedupeHash, config.TokensPerCall, config.TTLSeconds, time.Now().Unix()).Slice()
	if err != nil {
		return Reservation{}, err
	}
	remaining, _ := strconv.ParseInt(fmt.Sprint(reply[1]), 10, 64)
	return Reservation{Verdict: fmt.Sprint(reply[0]), Remaining: remaining, DedupeHash: dedupeHash}, nil
}

// record counts the sample's outcome: accepted, or rejected with its reason.
func record(ctx context.Context, jobID, outcome, reason string) error {
	if reason == "" {
		reason = "unknown"
	}
	keys := []string{config.ProgressKey(jobID), config.ReasonsKey(jobID)}
	return recordOutcome.Run(ctx, rdb, keys, outcome, reason, config.TTLSeconds, time.Now().Unix()).Err()
}

func main() {
	ctx := context.Background()
	if err := startJob(ctx, "job-demo", 100); err != nil {
		fmt.Println(err)
	}
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import distill.Config

/** reserve's answer: the verdict (ok, duplicate, budget), the tokens left, the prompt's hash. */
final case class Reservation(verdict: String, remaining: Long, dedupeHash: String)

object JobState {
  val jedis = new JedisPooled("redis", 6379)

  /** Seed the job's state: one teacher call costs TokensPerCall of the job's budget. */
  def startJob(jobId: String, sampleCap: Int): Unit = {
    jedis.set(Config.budgetKey(jobId), (sampleCap * Config.TokensPerCall).toString)
    jedis.hset(Config.progressKey(jobId), Map("sampled" -> "0", "accepted" -> "0", "rejected" -> "0", "duplicate" -> "0").asJava)
    ()
  }

  /** Pay for one teacher call unless the prompt was sampled already. */
  def reserve(jobId: String, prompt: String): Reservation = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val remaining = jedis.decrBy(Config.budgetKey(jobId), Config.TokensPerCall)
    if (jedis.sismember(Config.seenKey(jobId), prompt)) {
      jedis.hincrBy(Config.progressKey(jobId), "duplicate", 1)
      Reservation("duplicate", remaining, prompt)
    } else {
      jedis.sadd(Config.seenKey(jobId), prompt)
      jedis.hincrBy(Config.progressKey(jobId), "sampled", 1)
      Reservation("ok", remaining, prompt)
    }
  }

  /** Count the sample's outcome: accepted, or rejected with its reason. */
  def record(jobId: String, outcome: String, reason: String = ""): Unit = {
    jedis.hincrBy(Config.progressKey(jobId), if (outcome == "accepted") "accepted" else "rejected", 1)
    ()
  }
}
`,
      solution: `import java.security.MessageDigest

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

import distill.Config

/** reserve's answer: the verdict (ok, duplicate, budget), the tokens left, the prompt's hash. */
final case class Reservation(verdict: String, remaining: Long, dedupeHash: String)

object JobState {
  val jedis = new JedisPooled("redis", 6379)

  val Reserve: String =
    """local seen, budget, progress, reasons = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
      |local hash, cost, ttl, now = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
      |if redis.call('SISMEMBER', seen, hash) == 1 then
      |  redis.call('HINCRBY', progress, 'duplicate', 1)
      |  redis.call('HSET', progress, 'updated_at', now)
      |  redis.call('EXPIRE', progress, ttl)
      |  return {'duplicate', redis.call('GET', budget) or '0'}
      |end
      |local remaining = tonumber(redis.call('GET', budget) or '0')
      |if remaining < cost then
      |  redis.call('HINCRBY', progress, 'sampled', 1)
      |  redis.call('HINCRBY', progress, 'rejected', 1)
      |  redis.call('HINCRBY', reasons, 'budget', 1)
      |  redis.call('HSET', progress, 'updated_at', now)
      |  redis.call('EXPIRE', progress, ttl)
      |  redis.call('EXPIRE', reasons, ttl)
      |  return {'budget', tostring(remaining)}
      |end
      |remaining = redis.call('DECRBY', budget, cost)
      |redis.call('SADD', seen, hash)
      |redis.call('HINCRBY', progress, 'sampled', 1)
      |redis.call('HSET', progress, 'updated_at', now)
      |redis.call('EXPIRE', seen, ttl)
      |redis.call('EXPIRE', budget, ttl)
      |redis.call('EXPIRE', progress, ttl)
      |redis.call('EXPIRE', reasons, ttl)
      |return {'ok', tostring(remaining)}
      |""".stripMargin

  val Record: String =
    """local progress, reasons = KEYS[1], KEYS[2]
      |local outcome, reason, ttl, now = ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4]
      |if outcome == 'accepted' then
      |  redis.call('HINCRBY', progress, 'accepted', 1)
      |else
      |  redis.call('HINCRBY', progress, 'rejected', 1)
      |  redis.call('HINCRBY', reasons, reason, 1)
      |  redis.call('EXPIRE', reasons, ttl)
      |end
      |redis.call('HSET', progress, 'updated_at', now)
      |redis.call('EXPIRE', progress, ttl)
      |return redis.call('HGET', progress, 'sampled')
      |""".stripMargin

  private def now: String = (System.currentTimeMillis() / 1000).toString

  private def sha256Hex(text: String): String =
    MessageDigest.getInstance("SHA-256").digest(text.getBytes("UTF-8")).map("%02x".format(_)).mkString

  /** Seed the job's state: one teacher call costs TokensPerCall of the job's budget. */
  def startJob(jobId: String, sampleCap: Int): Unit = {
    jedis.set(Config.budgetKey(jobId), (sampleCap * Config.TokensPerCall).toString, SetParams.setParams().ex(Config.TtlSeconds))
    jedis.hset(
      Config.progressKey(jobId),
      Map("sampled" -> "0", "accepted" -> "0", "rejected" -> "0", "duplicate" -> "0", "updated_at" -> now).asJava
    )
    jedis.expire(Config.progressKey(jobId), Config.TtlSeconds)
    ()
  }

  /** Pay for one teacher call unless the prompt was sampled already. */
  def reserve(jobId: String, prompt: String): Reservation = {
    val dedupeHash = sha256Hex(prompt)
    val keys = List(Config.seenKey(jobId), Config.budgetKey(jobId), Config.progressKey(jobId), Config.reasonsKey(jobId))
    val args = List(dedupeHash, Config.TokensPerCall.toString, Config.TtlSeconds.toString, now)
    val reply = jedis.eval(Reserve, keys.asJava, args.asJava).asInstanceOf[java.util.List[AnyRef]].asScala.map(_.toString)
    Reservation(reply(0), reply(1).toLong, dedupeHash)
  }

  /** Count the sample's outcome: accepted, or rejected with its reason. */
  def record(jobId: String, outcome: String, reason: String = ""): Unit = {
    val keys = List(Config.progressKey(jobId), Config.reasonsKey(jobId))
    val args = List(outcome, if (reason.isEmpty) "unknown" else reason, Config.TtlSeconds.toString, now)
    jedis.eval(Record, keys.asJava, args.asJava)
    ()
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>
#include <unordered_map>

#include "distill/config.h"  // config::kTokensPerCall, config::kTtlSeconds, config::budget_key/seen_key/progress_key/reasons_key — provided

sw::redis::Redis redis("tcp://redis:6379");

// reserve's answer: the verdict (ok, duplicate, budget), the tokens left, the prompt's hash.
struct Reservation {
  std::string verdict;
  long long remaining = 0;
  std::string dedupe_hash;
};

// Seed the job's state: one teacher call costs kTokensPerCall of the job's budget.
void start_job(const std::string& job_id, int sample_cap) {
  redis.set(config::budget_key(job_id), std::to_string(sample_cap * config::kTokensPerCall));
  redis.hset(config::progress_key(job_id), {{"sampled", "0"}, {"accepted", "0"}, {"rejected", "0"}, {"duplicate", "0"}});
}

// Pay for one teacher call unless the prompt was sampled already.
Reservation reserve(const std::string& job_id, const std::string& prompt) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const long long remaining = redis.decrby(config::budget_key(job_id), config::kTokensPerCall);
  if (redis.sismember(config::seen_key(job_id), prompt)) {
    redis.hincrby(config::progress_key(job_id), "duplicate", 1);
    return {"duplicate", remaining, prompt};
  }
  redis.sadd(config::seen_key(job_id), prompt);
  redis.hincrby(config::progress_key(job_id), "sampled", 1);
  return {"ok", remaining, prompt};
}

// Count the sample's outcome: accepted, or rejected with its reason.
void record(const std::string& job_id, const std::string& outcome, const std::string& reason = "") {
  (void)reason;
  redis.hincrby(config::progress_key(job_id), outcome == "accepted" ? "accepted" : "rejected", 1);
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <tuple>
#include <unordered_map>

#include "digest.h"          // sha256_hex(bytes) — provided
#include "distill/config.h"  // config::kTokensPerCall, config::kTtlSeconds, config::budget_key/seen_key/progress_key/reasons_key — provided

sw::redis::Redis redis("tcp://redis:6379");

const std::string kReserve = R"lua(
local seen, budget, progress, reasons = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local hash, cost, ttl, now = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4]
if redis.call('SISMEMBER', seen, hash) == 1 then
  redis.call('HINCRBY', progress, 'duplicate', 1)
  redis.call('HSET', progress, 'updated_at', now)
  redis.call('EXPIRE', progress, ttl)
  return {'duplicate', redis.call('GET', budget) or '0'}
end
local remaining = tonumber(redis.call('GET', budget) or '0')
if remaining < cost then
  redis.call('HINCRBY', progress, 'sampled', 1)
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, 'budget', 1)
  redis.call('HSET', progress, 'updated_at', now)
  redis.call('EXPIRE', progress, ttl)
  redis.call('EXPIRE', reasons, ttl)
  return {'budget', tostring(remaining)}
end
remaining = redis.call('DECRBY', budget, cost)
redis.call('SADD', seen, hash)
redis.call('HINCRBY', progress, 'sampled', 1)
redis.call('HSET', progress, 'updated_at', now)
redis.call('EXPIRE', seen, ttl)
redis.call('EXPIRE', budget, ttl)
redis.call('EXPIRE', progress, ttl)
redis.call('EXPIRE', reasons, ttl)
return {'ok', tostring(remaining)}
)lua";

const std::string kRecord = R"lua(
local progress, reasons = KEYS[1], KEYS[2]
local outcome, reason, ttl, now = ARGV[1], ARGV[2], tonumber(ARGV[3]), ARGV[4]
if outcome == 'accepted' then
  redis.call('HINCRBY', progress, 'accepted', 1)
else
  redis.call('HINCRBY', progress, 'rejected', 1)
  redis.call('HINCRBY', reasons, reason, 1)
  redis.call('EXPIRE', reasons, ttl)
end
redis.call('HSET', progress, 'updated_at', now)
redis.call('EXPIRE', progress, ttl)
return redis.call('HGET', progress, 'sampled')
)lua";

// reserve's answer: the verdict (ok, duplicate, budget), the tokens left, the prompt's hash.
struct Reservation {
  std::string verdict;
  long long remaining = 0;
  std::string dedupe_hash;
};

std::string now_s() {
  return std::to_string(std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count());
}

// Seed the job's state: one teacher call costs kTokensPerCall of the job's budget.
void start_job(const std::string& job_id, int sample_cap) {
  redis.set(config::budget_key(job_id), std::to_string(sample_cap * config::kTokensPerCall), config::kTtlSeconds);
  redis.hset(config::progress_key(job_id), {{"sampled", "0"}, {"accepted", "0"}, {"rejected", "0"}, {"duplicate", "0"}, {"updated_at", now_s()}});
  redis.expire(config::progress_key(job_id), config::kTtlSeconds);
}

// Pay for one teacher call unless the prompt was sampled already.
Reservation reserve(const std::string& job_id, const std::string& prompt) {
  const std::string dedupe_hash = sha256_hex(prompt);
  const auto [verdict, remaining] = redis.eval<std::string, std::string>(
      kReserve,
      {config::seen_key(job_id), config::budget_key(job_id), config::progress_key(job_id), config::reasons_key(job_id)},
      {dedupe_hash, std::to_string(config::kTokensPerCall), std::to_string(config::kTtlSeconds), now_s()});
  return {verdict, std::stoll(remaining), dedupe_hash};
}

// Count the sample's outcome: accepted, or rejected with its reason.
void record(const std::string& job_id, const std::string& outcome, const std::string& reason = "") {
  redis.eval(kRecord, {config::progress_key(job_id), config::reasons_key(job_id)},
             {outcome, reason.empty() ? std::string("unknown") : reason, std::to_string(config::kTtlSeconds), now_s()});
}
`,
    },
  },
  harness: {
    python: `import hashlib

JOB = "j1"
COST = 512


def _state(ctx, cap=100):
    m = ctx.load("state")
    m.start_job(JOB, cap)
    return m


def _budget(ctx):
    return int(ctx.redis.get(f"distill:budget:{JOB}") or 0)


def _progress(ctx):
    return {k: v for k, v in ctx.redis.hgetall(f"distill:progress:{JOB}").items()}


def _count(ctx, field):
    return int(_progress(ctx).get(field, 0))


def _sha(prompt):
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


def check_dedupe_before_spend(ctx):
    m = _state(ctx, cap=2)
    first = m.reserve(JOB, "What is the capital of France?")
    assert first["verdict"] == "ok", f"a fresh prompt must be reserved (verdict ok), got {first}"
    assert _budget(ctx) == COST, f"one reservation draws one call: budget is {_budget(ctx)}, expected {COST}"
    again = m.reserve(JOB, "What is the capital of France?")
    assert again["verdict"] == "duplicate", f"the same prompt again must be a duplicate, got {again}"
    assert _budget(ctx) == COST, f"a duplicate costs nothing: budget is {_budget(ctx)} after the repeat, expected {COST} (DECRBY ran before SISMEMBER)"
    assert _count(ctx, "duplicate") == 1 and _count(ctx, "sampled") == 1, f"a duplicate counts as duplicate, not sampled: {_progress(ctx)}"
    second = m.reserve(JOB, "What is the capital of Peru?")
    assert second["verdict"] == "ok" and _budget(ctx) == 0, f"the second unique prompt spends the last call: {second}, budget {_budget(ctx)}"
    third = m.reserve(JOB, "What is the capital of Chile?")
    assert third["verdict"] == "budget", f"with no budget left the verdict must be budget, got {third}"
    assert _budget(ctx) == 0, f"the budget went to {_budget(ctx)}: a job must stop at zero, not run negative"
    assert _count(ctx, "rejected") == 1 and ctx.redis.hget(f"distill:reasons:{JOB}", "budget") == "1", f"a budget refusal is a rejected sample with reason budget: {_progress(ctx)}, reasons {ctx.redis.hgetall(f'distill:reasons:{JOB}')}"


def check_atomic_script(ctx):
    m = _state(ctx)
    prompt = "Explain photosynthesis to a ten-year-old."
    hash = _sha(prompt)

    def other_worker():
        # another worker reserving the same prompt, landing between two of this worker's commands
        if ctx.redis.sismember(f"distill:seen:{JOB}", hash):
            return "duplicate"
        ctx.redis.sadd(f"distill:seen:{JOB}", hash)
        ctx.redis.decrby(f"distill:budget:{JOB}", COST)
        ctx.redis.hincrby(f"distill:progress:{JOB}", "sampled", 1)
        return "ok"

    probe = ctx.redis_after(f"distill:seen:{JOB}", other_worker)
    mine = m.reserve(JOB, prompt)
    assert probe.fired, "reserve never touched the seen set"
    verdicts = sorted([mine["verdict"], probe.result])
    assert verdicts == ["duplicate", "ok"], f"two workers reserved the same prompt and the verdicts were {verdicts}: the membership test and the spend must run in one script, so exactly one of them pays"
    assert _budget(ctx) == 100 * COST - COST, f"two workers, one prompt: the budget is {_budget(ctx)}, expected one call drawn ({100 * COST - COST})"
    assert _count(ctx, "sampled") == 1, f"two workers, one prompt: sampled is {_count(ctx, 'sampled')}, expected 1"


def check_hashed_prompt(ctx):
    m = _state(ctx)
    prompt = "Summarise the attached contract in three bullet points."
    r = m.reserve(JOB, prompt)
    members = ctx.redis.smembers(f"distill:seen:{JOB}")
    assert prompt not in members, "the seen set holds the raw prompt: tenant content must not be stored in Redis"
    assert _sha(prompt) in members, f"the seen set must hold the hex SHA-256 of the prompt ({_sha(prompt)[:12]}…), it holds {sorted(members)}"
    assert r["dedupe_hash"] == _sha(prompt), f"reserve must answer the hash as dedupe_hash, got {r.get('dedupe_hash')!r}"
    for key in ctx.redis.keys("*"):
        assert "contract" not in key, f"the prompt leaked into a key name: {key}"


def check_reject_reason(ctx):
    m = _state(ctx)
    for prompt, outcome, reason in (("p1", "accepted", ""), ("p2", "rejected", "refusal"), ("p3", "rejected", "refusal"), ("p4", "rejected", "empty")):
        assert m.reserve(JOB, prompt)["verdict"] == "ok"
        m.record(JOB, outcome, reason)
    progress = _progress(ctx)
    assert (int(progress["sampled"]), int(progress["accepted"]), int(progress["rejected"])) == (4, 1, 3), f"four reservations, one accepted, three rejected: {progress}"
    reasons = ctx.redis.hgetall(f"distill:reasons:{JOB}")
    assert reasons.get("refusal") == "2" and reasons.get("empty") == "1", f"distill:reasons:{JOB} must count refusal 2 and empty 1, holds {reasons}"
    assert "accepted" not in reasons and "" not in reasons, f"only rejections carry a reason: {reasons}"


def check_key_ttl(ctx):
    m = _state(ctx)
    m.reserve(JOB, "p1")
    m.record(JOB, "rejected", "deadline")
    for key in (f"distill:budget:{JOB}", f"distill:seen:{JOB}", f"distill:progress:{JOB}", f"distill:reasons:{JOB}"):
        ttl = ctx.redis.ttl(key)
        assert ttl != -2, f"{key} does not exist after a reservation and a record"
        assert 0 < ttl <= 86_400, f"{key} has TTL {ttl}: every key the job owns expires TTL_S (86400 s) after its last move"
    stamp = ctx.redis.hget(f"distill:progress:{JOB}", "updated_at")
    assert stamp is not None and stamp.isdigit(), f"the progress hash must carry updated_at (unix seconds), it holds {_progress(ctx)}"
    ctx.clock.advance(86_401)
    assert ctx.redis.keys(f"distill:*:{JOB}") == [], f"a day after its last move the job must be gone, found {ctx.redis.keys(f'distill:*:{JOB}')}"
`,
    typescript: `import {createHash} from 'node:crypto';

const JOB = 'j1';
const COST = 512;

async function state(ctx, cap = 100) {
  const m = ctx.load('state');
  await m.startJob(JOB, cap);
  return m;
}

const budget = ctx => Number(ctx.redis.get(\`distill:budget:\${JOB}\`) ?? 0);
const progress = ctx => ctx.redis.hgetall(\`distill:progress:\${JOB}\`);
const count = (ctx, field: string) => Number(progress(ctx)[field] ?? 0);
const sha = (prompt: string) => createHash('sha256').update(prompt).digest('hex');

export async function check_dedupe_before_spend(ctx) {
  const m = await state(ctx, 2);
  const first = await m.reserve(JOB, 'What is the capital of France?');
  assert.equal(first.verdict, 'ok', \`a fresh prompt must be reserved (verdict ok), got \${JSON.stringify(first)}\`);
  assert.equal(budget(ctx), COST, \`one reservation draws one call: budget is \${budget(ctx)}, expected \${COST}\`);
  const again = await m.reserve(JOB, 'What is the capital of France?');
  assert.equal(again.verdict, 'duplicate', \`the same prompt again must be a duplicate, got \${JSON.stringify(again)}\`);
  assert.equal(budget(ctx), COST, \`a duplicate costs nothing: budget is \${budget(ctx)} after the repeat, expected \${COST} (DECRBY ran before SISMEMBER)\`);
  assert(count(ctx, 'duplicate') === 1 && count(ctx, 'sampled') === 1, \`a duplicate counts as duplicate, not sampled: \${JSON.stringify(progress(ctx))}\`);
  const second = await m.reserve(JOB, 'What is the capital of Peru?');
  assert(second.verdict === 'ok' && budget(ctx) === 0, \`the second unique prompt spends the last call: \${JSON.stringify(second)}, budget \${budget(ctx)}\`);
  const third = await m.reserve(JOB, 'What is the capital of Chile?');
  assert.equal(third.verdict, 'budget', \`with no budget left the verdict must be budget, got \${JSON.stringify(third)}\`);
  assert.equal(budget(ctx), 0, \`the budget went to \${budget(ctx)}: a job must stop at zero, not run negative\`);
  assert(count(ctx, 'rejected') === 1 && ctx.redis.hget(\`distill:reasons:\${JOB}\`, 'budget') === '1', \`a budget refusal is a rejected sample with reason budget: \${JSON.stringify(progress(ctx))}, reasons \${JSON.stringify(ctx.redis.hgetall(\`distill:reasons:\${JOB}\`))}\`);
}

export async function check_atomic_script(ctx) {
  const m = await state(ctx);
  const prompt = 'Explain photosynthesis to a ten-year-old.';
  const hash = sha(prompt);
  // another worker reserving the same prompt, landing between two of this worker's commands
  const probe = ctx.redisAfter(\`distill:seen:\${JOB}\`, () => {
    if (ctx.redis.sismember(\`distill:seen:\${JOB}\`, hash) === 1) return 'duplicate';
    ctx.redis.sadd(\`distill:seen:\${JOB}\`, hash);
    ctx.redis.decrby(\`distill:budget:\${JOB}\`, COST);
    ctx.redis.hincrby(\`distill:progress:\${JOB}\`, 'sampled', 1);
    return 'ok';
  });
  const mine = await m.reserve(JOB, prompt);
  assert(probe.fired, 'reserve never touched the seen set');
  const verdicts = [mine.verdict, probe.result].sort();
  assert.deepEqual(verdicts, ['duplicate', 'ok'], \`two workers reserved the same prompt and the verdicts were \${JSON.stringify(verdicts)}: the membership test and the spend must run in one script, so exactly one of them pays\`);
  assert.equal(budget(ctx), 100 * COST - COST, \`two workers, one prompt: the budget is \${budget(ctx)}, expected one call drawn (\${100 * COST - COST})\`);
  assert.equal(count(ctx, 'sampled'), 1, \`two workers, one prompt: sampled is \${count(ctx, 'sampled')}, expected 1\`);
}

export async function check_hashed_prompt(ctx) {
  const m = await state(ctx);
  const prompt = 'Summarise the attached contract in three bullet points.';
  const r = await m.reserve(JOB, prompt);
  const members: string[] = ctx.redis.smembers(\`distill:seen:\${JOB}\`);
  assert(!members.includes(prompt), 'the seen set holds the raw prompt: tenant content must not be stored in Redis');
  assert(members.includes(sha(prompt)), \`the seen set must hold the hex SHA-256 of the prompt (\${sha(prompt).slice(0, 12)}…), it holds \${JSON.stringify(members)}\`);
  assert.equal(r.dedupeHash, sha(prompt), \`reserve must answer the hash as dedupeHash, got \${JSON.stringify(r.dedupeHash)}\`);
  for (const key of ctx.redis.keys('*')) assert(!key.includes('contract'), \`the prompt leaked into a key name: \${key}\`);
}

export async function check_reject_reason(ctx) {
  const m = await state(ctx);
  for (const [prompt, outcome, reason] of [['p1', 'accepted', ''], ['p2', 'rejected', 'refusal'], ['p3', 'rejected', 'refusal'], ['p4', 'rejected', 'empty']]) {
    assert.equal((await m.reserve(JOB, prompt)).verdict, 'ok');
    await m.record(JOB, outcome, reason);
  }
  const p = progress(ctx);
  assert.deepEqual([Number(p.sampled), Number(p.accepted), Number(p.rejected)], [4, 1, 3], \`four reservations, one accepted, three rejected: \${JSON.stringify(p)}\`);
  const reasons = ctx.redis.hgetall(\`distill:reasons:\${JOB}\`);
  assert(reasons.refusal === '2' && reasons.empty === '1', \`distill:reasons:\${JOB} must count refusal 2 and empty 1, holds \${JSON.stringify(reasons)}\`);
  assert(!('accepted' in reasons) && !('' in reasons), \`only rejections carry a reason: \${JSON.stringify(reasons)}\`);
}

export async function check_key_ttl(ctx) {
  const m = await state(ctx);
  await m.reserve(JOB, 'p1');
  await m.record(JOB, 'rejected', 'deadline');
  for (const key of [\`distill:budget:\${JOB}\`, \`distill:seen:\${JOB}\`, \`distill:progress:\${JOB}\`, \`distill:reasons:\${JOB}\`]) {
    const ttl = Number(ctx.redis.ttl(key));
    assert(ttl !== -2, \`\${key} does not exist after a reservation and a record\`);
    assert(0 < ttl && ttl <= 86_400, \`\${key} has TTL \${ttl}: every key the job owns expires TTL_S (86400 s) after its last move\`);
  }
  const stamp = ctx.redis.hget(\`distill:progress:\${JOB}\`, 'updated_at');
  assert(typeof stamp === 'string' && /^\\d+$/.test(stamp), \`the progress hash must carry updated_at (unix seconds), it holds \${JSON.stringify(progress(ctx))}\`);
  ctx.clock.advance(86_401);
  assert.deepEqual(ctx.redis.keys(\`distill:*:\${JOB}\`), [], \`a day after its last move the job must be gone, found \${JSON.stringify(ctx.redis.keys(\`distill:*:\${JOB}\`))}\`);
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"sort"
	"strconv"

	"leetbuild/harness"
)

const (
	stateJob  = "j1"
	stateCost = 512
)

func stateStart(ctx *harness.Ctx, cap int) {
	ctx.NoError(startJob(context.Background(), stateJob, cap), "startJob")
}

func stateReserve(ctx *harness.Ctx, prompt string) Reservation {
	r, err := reserve(context.Background(), stateJob, prompt)
	ctx.NoError(err, "reserve(%q)", prompt)
	return r
}

func stateBudget(ctx *harness.Ctx) int64 {
	raw, _ := ctx.Redis.Get("distill:budget:" + stateJob)
	n, _ := strconv.ParseInt(raw, 10, 64)
	return n
}

func stateCount(ctx *harness.Ctx, field string) int64 {
	n, _ := strconv.ParseInt(ctx.Redis.HGetAll("distill:progress:"+stateJob)[field], 10, 64)
	return n
}

func stateSha(prompt string) string {
	sum := sha256.Sum256([]byte(prompt))
	return hex.EncodeToString(sum[:])
}

func CheckDedupeBeforeSpend(ctx *harness.Ctx) {
	stateStart(ctx, 2)
	first := stateReserve(ctx, "What is the capital of France?")
	ctx.Equal(first.Verdict, "ok", "a fresh prompt must be reserved; the verdict")
	ctx.Equal(stateBudget(ctx), stateCost, "one reservation draws one call; the budget")
	again := stateReserve(ctx, "What is the capital of France?")
	ctx.Equal(again.Verdict, "duplicate", "the same prompt again; the verdict")
	ctx.Equal(stateBudget(ctx), stateCost, "a duplicate costs nothing (DECRBY ran before SISMEMBER); the budget after the repeat")
	ctx.Assert(stateCount(ctx, "duplicate") == 1 && stateCount(ctx, "sampled") == 1, "a duplicate counts as duplicate, not sampled: %v", ctx.Redis.HGetAll("distill:progress:"+stateJob))
	second := stateReserve(ctx, "What is the capital of Peru?")
	ctx.Assert(second.Verdict == "ok" && stateBudget(ctx) == 0, "the second unique prompt spends the last call: %+v, budget %d", second, stateBudget(ctx))
	third := stateReserve(ctx, "What is the capital of Chile?")
	ctx.Equal(third.Verdict, "budget", "with no budget left; the verdict")
	ctx.Equal(stateBudget(ctx), 0, "a job must stop at zero, not run negative; the budget")
	reason, _ := ctx.Redis.HGet("distill:reasons:"+stateJob, "budget")
	ctx.Assert(stateCount(ctx, "rejected") == 1 && reason == "1", "a budget refusal is a rejected sample with reason budget: %v, reasons %v", ctx.Redis.HGetAll("distill:progress:"+stateJob), ctx.Redis.HGetAll("distill:reasons:"+stateJob))
}

func CheckAtomicScript(ctx *harness.Ctx) {
	stateStart(ctx, 100)
	prompt := "Explain photosynthesis to a ten-year-old."
	hash := stateSha(prompt)
	other := ""
	// another worker reserving the same prompt, landing between two of this worker's commands
	ctx.Redis.After("distill:seen:"+stateJob, func() any {
		if ctx.Redis.SIsMember("distill:seen:"+stateJob, hash) {
			other = "duplicate"
			return nil
		}
		ctx.Redis.Do("SADD", "distill:seen:"+stateJob, hash)
		ctx.Redis.Do("DECRBY", "distill:budget:"+stateJob, stateCost)
		ctx.Redis.Do("HINCRBY", "distill:progress:"+stateJob, "sampled", 1)
		other = "ok"
		return nil
	})
	mine := stateReserve(ctx, prompt)
	ctx.Assert(other != "", "reserve never touched the seen set")
	verdicts := []string{mine.Verdict, other}
	sort.Strings(verdicts)
	ctx.Equal(verdicts, []string{"duplicate", "ok"}, "two workers reserved the same prompt: the membership test and the spend must run in one script, so exactly one of them pays; the verdicts")
	ctx.Equal(stateBudget(ctx), 100*stateCost-stateCost, "two workers, one prompt: one call drawn; the budget")
	ctx.Equal(stateCount(ctx, "sampled"), 1, "two workers, one prompt; sampled")
}

func CheckHashedPrompt(ctx *harness.Ctx) {
	stateStart(ctx, 100)
	prompt := "Summarise the attached contract in three bullet points."
	r := stateReserve(ctx, prompt)
	members := ctx.Redis.SMembers("distill:seen:" + stateJob)
	hasRaw, hasHash := false, false
	for _, m := range members {
		hasRaw = hasRaw || m == prompt
		hasHash = hasHash || m == stateSha(prompt)
	}
	ctx.Assert(!hasRaw, "the seen set holds the raw prompt: tenant content must not be stored in Redis")
	ctx.Assert(hasHash, "the seen set must hold the hex SHA-256 of the prompt (%s…), it holds %v", stateSha(prompt)[:12], members)
	ctx.Equal(r.DedupeHash, stateSha(prompt), "reserve must answer the hash as DedupeHash")
	for _, key := range ctx.Redis.Keys("*") {
		ctx.Assert(!regexp.MustCompile("contract").MatchString(key), "the prompt leaked into a key name: %s", key)
	}
}

func CheckRejectReason(ctx *harness.Ctx) {
	stateStart(ctx, 100)
	for _, s := range [][3]string{{"p1", "accepted", ""}, {"p2", "rejected", "refusal"}, {"p3", "rejected", "refusal"}, {"p4", "rejected", "empty"}} {
		ctx.Equal(stateReserve(ctx, s[0]).Verdict, "ok", "reserve %s", s[0])
		ctx.NoError(record(context.Background(), stateJob, s[1], s[2]), "record")
	}
	progress := ctx.Redis.HGetAll("distill:progress:" + stateJob)
	ctx.Equal([]int64{stateCount(ctx, "sampled"), stateCount(ctx, "accepted"), stateCount(ctx, "rejected")}, []int64{4, 1, 3}, "four reservations, one accepted, three rejected (%v); sampled, accepted, rejected", progress)
	reasons := ctx.Redis.HGetAll("distill:reasons:" + stateJob)
	ctx.Assert(reasons["refusal"] == "2" && reasons["empty"] == "1", "distill:reasons:%s must count refusal 2 and empty 1, holds %v", stateJob, reasons)
	_, acc := reasons["accepted"]
	_, blank := reasons[""]
	ctx.Assert(!acc && !blank, "only rejections carry a reason: %v", reasons)
}

func CheckKeyTtl(ctx *harness.Ctx) {
	stateStart(ctx, 100)
	stateReserve(ctx, "p1")
	ctx.NoError(record(context.Background(), stateJob, "rejected", "deadline"), "record")
	for _, key := range []string{"distill:budget:" + stateJob, "distill:seen:" + stateJob, "distill:progress:" + stateJob, "distill:reasons:" + stateJob} {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl != -2, "%s does not exist after a reservation and a record", key)
		ctx.Assert(0 < ttl && ttl <= 86_400, "%s has TTL %d: every key the job owns expires TTLSeconds (86400 s) after its last move", key, ttl)
	}
	stamp, ok := ctx.Redis.HGet("distill:progress:"+stateJob, "updated_at")
	ctx.Assert(ok && regexp.MustCompile(\`^\\d+$\`).MatchString(stamp), "the progress hash must carry updated_at (unix seconds), it holds %v", ctx.Redis.HGetAll("distill:progress:"+stateJob))
	ctx.Clock.Advance(86_401)
	ctx.Equal(len(ctx.Redis.Keys("distill:*:"+stateJob)), 0, "a day after its last move the job must be gone (%v); keys left", ctx.Redis.Keys("distill:*:"+stateJob))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <cstdlib>
#include <string>
#include <vector>

#include "digest.h"

namespace {

const std::string kJob = "j1";
constexpr long long kCost = 512;

long long stateBudget(harness::Ctx& ctx) {
  const auto raw = ctx.Redis.Get("distill:budget:" + kJob);
  return raw ? std::strtoll(raw->c_str(), nullptr, 10) : 0;
}

long long stateCount(harness::Ctx& ctx, const std::string& field) {
  const auto all = ctx.Redis.HGetAll("distill:progress:" + kJob);
  const auto it = all.find(field);
  return it == all.end() ? 0 : std::strtoll(it->second.c_str(), nullptr, 10);
}

}  // namespace

void CheckDedupeBeforeSpend(harness::Ctx& ctx) {
  start_job(kJob, 2);
  const auto first = reserve(kJob, "What is the capital of France?");
  ctx.Equal(first.verdict, "ok", "a fresh prompt must be reserved; the verdict");
  ctx.Equal(stateBudget(ctx), kCost, "one reservation draws one call; the budget");
  const auto again = reserve(kJob, "What is the capital of France?");
  ctx.Equal(again.verdict, "duplicate", "the same prompt again; the verdict");
  ctx.Equal(stateBudget(ctx), kCost, "a duplicate costs nothing (DECRBY ran before SISMEMBER); the budget after the repeat");
  ctx.Assert(stateCount(ctx, "duplicate") == 1 && stateCount(ctx, "sampled") == 1, "a duplicate counts as duplicate, not sampled: %v", ctx.Redis.HGetAll("distill:progress:" + kJob));
  const auto second = reserve(kJob, "What is the capital of Peru?");
  ctx.Assert(second.verdict == "ok" && stateBudget(ctx) == 0, "the second unique prompt spends the last call: verdict %s, budget %d", second.verdict, stateBudget(ctx));
  const auto third = reserve(kJob, "What is the capital of Chile?");
  ctx.Equal(third.verdict, "budget", "with no budget left; the verdict");
  ctx.Equal(stateBudget(ctx), 0, "a job must stop at zero, not run negative; the budget");
  const auto reason = ctx.Redis.HGet("distill:reasons:" + kJob, "budget");
  ctx.Assert(stateCount(ctx, "rejected") == 1 && reason && *reason == "1", "a budget refusal is a rejected sample with reason budget: %v, reasons %v", ctx.Redis.HGetAll("distill:progress:" + kJob), ctx.Redis.HGetAll("distill:reasons:" + kJob));
}

void CheckAtomicScript(harness::Ctx& ctx) {
  start_job(kJob, 100);
  const std::string prompt = "Explain photosynthesis to a ten-year-old.";
  const std::string hash = sha256_hex(prompt);
  std::string other;
  // another worker reserving the same prompt, landing between two of this worker's commands
  ctx.Redis.After("distill:seen:" + kJob, [&] {
    if (ctx.Redis.SIsMember("distill:seen:" + kJob, hash)) {
      other = "duplicate";
      return;
    }
    ctx.Redis.Do("SADD", "distill:seen:" + kJob, hash);
    ctx.Redis.Do("DECRBY", "distill:budget:" + kJob, kCost);
    ctx.Redis.Do("HINCRBY", "distill:progress:" + kJob, "sampled", 1);
    other = "ok";
  });
  const auto mine = reserve(kJob, prompt);
  ctx.Assert(!other.empty(), "reserve never touched the seen set");
  std::vector<std::string> verdicts = {mine.verdict, other};
  std::sort(verdicts.begin(), verdicts.end());
  ctx.Equal(verdicts, {"duplicate", "ok"}, "two workers reserved the same prompt: the membership test and the spend must run in one script, so exactly one of them pays; the verdicts");
  ctx.Equal(stateBudget(ctx), 100 * kCost - kCost, "two workers, one prompt: one call drawn; the budget");
  ctx.Equal(stateCount(ctx, "sampled"), 1, "two workers, one prompt; sampled");
}

void CheckHashedPrompt(harness::Ctx& ctx) {
  start_job(kJob, 100);
  const std::string prompt = "Summarise the attached contract in three bullet points.";
  const auto r = reserve(kJob, prompt);
  const auto members = ctx.Redis.SMembers("distill:seen:" + kJob);
  const bool hasRaw = std::find(members.begin(), members.end(), prompt) != members.end();
  const bool hasHash = std::find(members.begin(), members.end(), sha256_hex(prompt)) != members.end();
  ctx.Assert(!hasRaw, "the seen set holds the raw prompt: tenant content must not be stored in Redis");
  ctx.Assert(hasHash, "the seen set must hold the hex SHA-256 of the prompt (%s…), it holds %v", sha256_hex(prompt).substr(0, 12), members);
  ctx.Equal(r.dedupe_hash, sha256_hex(prompt), "reserve must answer the hash as dedupe_hash");
  for (const auto& key : ctx.Redis.Keys("*")) ctx.Assert(key.find("contract") == std::string::npos, "the prompt leaked into a key name: %s", key);
}

void CheckRejectReason(harness::Ctx& ctx) {
  start_job(kJob, 100);
  const std::vector<std::vector<std::string>> samples = {{"p1", "accepted", ""}, {"p2", "rejected", "refusal"}, {"p3", "rejected", "refusal"}, {"p4", "rejected", "empty"}};
  for (const auto& s : samples) {
    ctx.Equal(reserve(kJob, s[0]).verdict, "ok", "reserve %s", s[0]);
    record(kJob, s[1], s[2]);
  }
  ctx.Equal(std::vector<long long>{stateCount(ctx, "sampled"), stateCount(ctx, "accepted"), stateCount(ctx, "rejected")}, std::vector<long long>{4, 1, 3},
            "four reservations, one accepted, three rejected (%v); sampled, accepted, rejected", ctx.Redis.HGetAll("distill:progress:" + kJob));
  const auto reasons = ctx.Redis.HGetAll("distill:reasons:" + kJob);
  ctx.Assert(reasons.count("refusal") && reasons.at("refusal") == "2" && reasons.count("empty") && reasons.at("empty") == "1", "distill:reasons:%s must count refusal 2 and empty 1, holds %v", kJob, reasons);
  ctx.Assert(!reasons.count("accepted") && !reasons.count(""), "only rejections carry a reason: %v", reasons);
}

void CheckKeyTtl(harness::Ctx& ctx) {
  start_job(kJob, 100);
  reserve(kJob, "p1");
  record(kJob, "rejected", "deadline");
  for (const std::string key : {"distill:budget:" + kJob, "distill:seen:" + kJob, "distill:progress:" + kJob, "distill:reasons:" + kJob}) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl != -2, "%s does not exist after a reservation and a record", key);
    ctx.Assert(0 < ttl && ttl <= 86400, "%s has TTL %d: every key the job owns expires kTtlSeconds (86400 s) after its last move", key, ttl);
  }
  const auto stamp = ctx.Redis.HGet("distill:progress:" + kJob, "updated_at");
  ctx.Assert(stamp && !stamp->empty() && std::all_of(stamp->begin(), stamp->end(), [](char c) { return c >= '0' && c <= '9'; }),
             "the progress hash must carry updated_at (unix seconds), it holds %v", ctx.Redis.HGetAll("distill:progress:" + kJob));
  ctx.Clock.Advance(86401);
  ctx.Equal(ctx.Redis.Keys("distill:*:" + kJob).size(), 0, "a day after its last move the job must be gone (%v); keys left", ctx.Redis.Keys("distill:*:" + kJob));
}
`,
  },
  debrief: `The reservation is the shape of the fix: a worker asks for budget before it spends it, and the answer settles three questions at once (seen before? affordable? then draw) because Redis runs the script alone. Splitting those into round trips is what let two workers both see an empty set, and what let a dying worker leave the budget and the counters out of step. The hash is a privacy decision as much as a size one: the set must recognise a prompt without holding it. The TTL and the stamp are for the people who come later, a report in step 5 and an operator a week on. Production pipelines also catch near duplicates (MinHash over shingles, as NeMo Curator's fuzzy pass does) and hash each job's keys into one Redis Cluster slot so the script stays runnable when the keyspace is sharded.`,
};
