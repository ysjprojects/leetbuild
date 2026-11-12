import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis job state: a diversity window per seed entity in one script',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter keeps a job's state under the keys \`synth/config\` defines.
\`claim(job_id, entity_id, max_records)\` is called before a worker generates a record from a seed
entity: it bumps \`generated\` in \`synth:progress:{job}\`, answers \`cap\` past \`max_records\`, then reads
the entity's counter \`window_key(job, entity, now // WINDOW_S)\` with GET, answers \`throttled\` at
\`ENTITY_LIMIT\` (5) and writes the counter back with SET. \`settle(job_id, record_id, entity_id,
outcome, seed_digest)\` counts \`admitted\`, \`parked\` or \`rejected\` and stores an admitted record's
digest in \`synth:records:{job}\`. The demo dashboard moves. It hides 4 flaws.

**Failure mode the checks target.** Diversity collapse: a recipe meant to cover thousands of entities
is filled by one prolific seed. GET then SET lets two workers both take the fifth slot, throttled
claims eat the job's record cap, and without per-entity coverage no report can see the collapse.

Requirements, kept by **one Lua script** per operation:

- \`claim\`: a job at \`max_records\` answers \`cap\`; an entity at \`ENTITY_LIMIT\` in this window answers
  \`throttled\` (\`throttled\` up, \`generated\` untouched); otherwise INCR the window counter and
  \`generated\`. The answer is \`{verdict, count}\`.
- \`settle\` with \`admitted\` also adds one to the entity in \`synth:coverage:{job}\`.
- The window counter expires after \`WINDOW_S\`; progress, coverage and records after \`TTL_S\`; every
  script stamps \`updated_at\` (unix seconds).`,
  sequence: {
    participants: ['Worker', 'Redis'],
    messages: [
      {
        from: 'Worker',
        to: 'Redis',
        label: 'EVALSHA claim · progress window · max_records limit window_s ttl now',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'HGET generated < cap · GET window < 5', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'INCR window · EXPIRE 60 · HINCRBY generated', kind: 'sync'},
      {from: 'Redis', to: 'Worker', label: '{ok, 3}', kind: 'reply'},
      {
        from: 'Worker',
        to: 'Redis',
        label: 'EVALSHA settle · progress coverage records · admitted entity digest',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Worker', label: 'OK', kind: 'reply'},
    ],
  },
  hints: [
    'Symptom: a job asked for 1000 records stops at 600 with most of them from one entity, two workers on one entity both get a fifth slot, and nothing in Redis says which entities the corpus covers.',
    'Mechanism: `claim` bumps `generated` before it knows the record will be generated, so throttled claims spend the cap; GET and SET are two round trips with room for another worker between them; `settle` never touches a coverage hash.',
    'Change: one `register_script` / `defineCommand` / `NewScript` / `eval` per operation: HGET generated against the cap, GET the window against ENTITY_LIMIT (HINCRBY throttled), else INCR + EXPIRE WINDOW_S + HINCRBY generated; `settle` adds HINCRBY coverage; HSET updated_at and EXPIRE TTL_S.',
  ],
  checks: [
    {
      id: 'entity-limit',
      title: 'Throttles the sixth record of one entity in a window',
      detail:
        'Five claims for one entity in one window are ok, the sixth is throttled, and another entity has its own counter at window_key(job, entity, window).',
      match: {
        python: {all: [/ENTITY_LIMIT/, /window_key\(/]},
        typescript: {all: [/ENTITY_LIMIT/, /windowKey\(/]},
        go: {all: [/EntityLimit/, /WindowKey\(/]},
        scala: {all: [/EntityLimit/, /windowKey\(/]},
        cpp: {all: [/kEntityLimit/, /window_key\(/]},
      },
    },
    {
      id: 'atomic-claim',
      title: 'Claims a slot in one Lua script',
      detail:
        'The cap test, the window test and the INCR run inside one EVAL/EVALSHA, so a second worker landing during a claim for the fifth slot is throttled. The starter reads the counter with GET and writes it with SET, and both workers take the slot.',
      match: {
        python: {all: [/register_script\(|\.eval\(|\.evalsha\(/, /redis\.call\(\s*['"]INCR['"]/], none: [/\br\.get\(/]},
        typescript: {
          all: [/defineCommand\(|\.eval\(|\.evalsha\(/, /redis\.call\(\s*['"]INCR['"]/],
          none: [/redis\.get\(/],
        },
        go: {all: [/redis\.NewScript\(|\.Eval\(|\.EvalSha\(/, /redis\.call\(\s*['"]INCR['"]/], none: [/rdb\.Get\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]INCR['"]/], none: [/jedis\.get\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]INCR['"]/], none: [/redis\.get\(/]},
      },
    },
    {
      id: 'throttle-spares-cap',
      title: 'A throttled claim leaves the record cap alone',
      detail:
        'Throttled claims count as throttled and leave generated where it was, so the job still reaches max_records with other entities; generated never passes max_records. The starter increments generated before it tests the window.',
      match: {
        python: {order: [/['"]throttled['"]\s*,\s*1\b/, /['"]generated['"]\s*,\s*1\b/]},
        typescript: {order: [/['"]throttled['"]\s*,\s*1\b/, /['"]generated['"]\s*,\s*1\b/]},
        go: {order: [/['"]throttled['"]\s*,\s*1\b/, /['"]generated['"]\s*,\s*1\b/]},
        scala: {order: [/['"]throttled['"]\s*,\s*1\b/, /['"]generated['"]\s*,\s*1\b/]},
        cpp: {order: [/['"]throttled['"]\s*,\s*1\b/, /['"]generated['"]\s*,\s*1\b/]},
      },
    },
    {
      id: 'coverage-per-entity',
      title: 'Counts admitted records per entity',
      detail:
        'An admitted record adds one to its entity in synth:coverage:{job}; parked and rejected records do not. The starter counts outcomes per job only, so a corpus of one entity looks like any other.',
      match: {
        python: {all: [/coverage_key\(/, /HINCRBY/]},
        typescript: {all: [/coverageKey\(/, /HINCRBY/]},
        go: {all: [/CoverageKey\(/, /HINCRBY/]},
        scala: {all: [/coverageKey\(/, /HINCRBY/]},
        cpp: {all: [/coverage_key\(/, /HINCRBY/]},
      },
    },
    {
      id: 'key-ttl',
      title: 'Expires the window and the job keys, and stamps updated_at',
      detail:
        'The window counter gets EXPIRE WINDOW_S, so the next window starts from zero and old counters leave Redis; progress, coverage and records get TTL_S, and the progress hash carries updated_at. The starter sets no expiry and no stamp.',
      match: {
        python: {all: [/redis\.call\(\s*['"]EXPIRE['"]|\.expire\(/, /WINDOW_S/, /TTL_S/, /updated_at/]},
        typescript: {all: [/redis\.call\(\s*['"]EXPIRE['"]|\.expire\(/, /WINDOW_S/, /TTL_S/, /updated_at/]},
        go: {all: [/redis\.call\(\s*['"]EXPIRE['"]|\.Expire\(/, /WindowSeconds/, /TTLSeconds/, /updated_at/]},
        scala: {all: [/redis\.call\(\s*['"]EXPIRE['"]|\.expire\(/, /WindowSeconds/, /TtlSeconds/, /updated_at/]},
        cpp: {all: [/redis\.call\(\s*['"]EXPIRE['"]|\.expire\(/, /kWindowSeconds/, /kTtlSeconds/, /updated_at/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis

from synth.config import ENTITY_LIMIT, WINDOW_S, progress_key, records_key, window_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def claim(job_id: str, entity_id: str, max_records: int) -> dict:
    """Claim one generation slot for a record of entity_id: {verdict: ok | throttled | cap, count}."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    generated = r.hincrby(progress_key(job_id), "generated", 1)
    if generated > max_records:
        return {"verdict": "cap", "count": generated - 1}
    key = window_key(job_id, entity_id, int(time.time()) // WINDOW_S)
    count = int(r.get(key) or 0)
    if count >= ENTITY_LIMIT:
        r.hincrby(progress_key(job_id), "throttled", 1)
        return {"verdict": "throttled", "count": count}
    r.set(key, count + 1)
    return {"verdict": "ok", "count": count + 1}


def settle(job_id: str, record_id: str, entity_id: str, outcome: str, seed_digest: str) -> None:
    """Count a claimed record's outcome: admitted (with its seed digest), parked or rejected."""
    r.hincrby(progress_key(job_id), outcome, 1)
    if outcome == "admitted":
        r.hset(records_key(job_id), record_id, seed_digest)
`,
      solution: `import time

import redis

from synth.config import ENTITY_LIMIT, TTL_S, WINDOW_S, coverage_key, progress_key, records_key, window_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CLAIM = """
local progress, window = KEYS[1], KEYS[2]
local cap, limit, window_s, ttl, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), ARGV[5]
local generated = tonumber(redis.call('HGET', progress, 'generated') or '0')
if generated >= cap then
  return {'cap', tostring(generated)}
end
local count = tonumber(redis.call('GET', window) or '0')
if count >= limit then
  redis.call('HINCRBY', progress, 'throttled', 1)
  redis.call('HSET', progress, 'updated_at', now)
  redis.call('EXPIRE', progress, ttl)
  return {'throttled', tostring(count)}
end
count = redis.call('INCR', window)
if count == 1 then
  redis.call('EXPIRE', window, window_s)
end
redis.call('HINCRBY', progress, 'generated', 1)
redis.call('HSET', progress, 'updated_at', now)
redis.call('EXPIRE', progress, ttl)
return {'ok', tostring(count)}
"""

SETTLE = """
local progress, coverage, records = KEYS[1], KEYS[2], KEYS[3]
local outcome, entity, record_id, digest, ttl, now = ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5]), ARGV[6]
redis.call('HINCRBY', progress, outcome, 1)
if outcome == 'admitted' then
  redis.call('HINCRBY', coverage, entity, 1)
  redis.call('HSET', records, record_id, digest)
  redis.call('EXPIRE', coverage, ttl)
  redis.call('EXPIRE', records, ttl)
end
redis.call('HSET', progress, 'updated_at', now)
redis.call('EXPIRE', progress, ttl)
return 1
"""

claim_slot = r.register_script(CLAIM)
settle_record = r.register_script(SETTLE)


def claim(job_id: str, entity_id: str, max_records: int) -> dict:
    """Claim one generation slot for a record of entity_id: {verdict: ok | throttled | cap, count}."""
    now = int(time.time())
    verdict, count = claim_slot(
        keys=[progress_key(job_id), window_key(job_id, entity_id, now // WINDOW_S)],
        args=[max_records, ENTITY_LIMIT, WINDOW_S, TTL_S, now],
    )
    return {"verdict": verdict, "count": int(count)}


def settle(job_id: str, record_id: str, entity_id: str, outcome: str, seed_digest: str) -> None:
    """Count a claimed record's outcome: admitted (with its seed digest), parked or rejected."""
    settle_record(
        keys=[progress_key(job_id), coverage_key(job_id), records_key(job_id)],
        args=[outcome, entity_id, record_id, seed_digest, TTL_S, int(time.time())],
    )
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {ENTITY_LIMIT, WINDOW_S, progressKey, recordsKey, windowKey} from 'synth/config';

export const redis = new Redis({host: 'redis', port: 6379});

export interface Claim {
  verdict: 'ok' | 'throttled' | 'cap';
  count: number;
}

/** Claim one generation slot for a record of entityId. */
export async function claim(jobId: string, entityId: string, maxRecords: number): Promise<Claim> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const generated = await redis.hincrby(progressKey(jobId), 'generated', 1);
  if (generated > maxRecords) return {verdict: 'cap', count: generated - 1};
  const key = windowKey(jobId, entityId, Math.floor(Date.now() / 1000 / WINDOW_S));
  const count = Number((await redis.get(key)) ?? 0);
  if (count >= ENTITY_LIMIT) {
    await redis.hincrby(progressKey(jobId), 'throttled', 1);
    return {verdict: 'throttled', count};
  }
  await redis.set(key, count + 1);
  return {verdict: 'ok', count: count + 1};
}

/** Count a claimed record's outcome: admitted (with its seed digest), parked or rejected. */
export async function settle(jobId: string, recordId: string, entityId: string, outcome: string, seedDigest: string): Promise<void> {
  void entityId;
  await redis.hincrby(progressKey(jobId), outcome, 1);
  if (outcome === 'admitted') await redis.hset(recordsKey(jobId), recordId, seedDigest);
}
`,
      solution: `import Redis from 'ioredis';

import {ENTITY_LIMIT, TTL_S, WINDOW_S, coverageKey, progressKey, recordsKey, windowKey} from 'synth/config';

const CLAIM = \`
local progress, window = KEYS[1], KEYS[2]
local cap, limit, window_s, ttl, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), ARGV[5]
local generated = tonumber(redis.call('HGET', progress, 'generated') or '0')
if generated >= cap then
  return {'cap', tostring(generated)}
end
local count = tonumber(redis.call('GET', window) or '0')
if count >= limit then
  redis.call('HINCRBY', progress, 'throttled', 1)
  redis.call('HSET', progress, 'updated_at', now)
  redis.call('EXPIRE', progress, ttl)
  return {'throttled', tostring(count)}
end
count = redis.call('INCR', window)
if count == 1 then
  redis.call('EXPIRE', window, window_s)
end
redis.call('HINCRBY', progress, 'generated', 1)
redis.call('HSET', progress, 'updated_at', now)
redis.call('EXPIRE', progress, ttl)
return {'ok', tostring(count)}
\`;

const SETTLE = \`
local progress, coverage, records = KEYS[1], KEYS[2], KEYS[3]
local outcome, entity, record_id, digest, ttl, now = ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5]), ARGV[6]
redis.call('HINCRBY', progress, outcome, 1)
if outcome == 'admitted' then
  redis.call('HINCRBY', coverage, entity, 1)
  redis.call('HSET', records, record_id, digest)
  redis.call('EXPIRE', coverage, ttl)
  redis.call('EXPIRE', records, ttl)
end
redis.call('HSET', progress, 'updated_at', now)
redis.call('EXPIRE', progress, ttl)
return 1
\`;

interface StateRedis extends Redis {
  claimSlot(progress: string, window: string, cap: number, limit: number, windowS: number, ttl: number, now: number): Promise<[string, string]>;
  settleRecord(progress: string, coverage: string, records: string, outcome: string, entity: string, recordId: string, digest: string, ttl: number, now: number): Promise<number>;
}

export const redis = new Redis({host: 'redis', port: 6379}) as StateRedis;
redis.defineCommand('claimSlot', {numberOfKeys: 2, lua: CLAIM});
redis.defineCommand('settleRecord', {numberOfKeys: 3, lua: SETTLE});

export interface Claim {
  verdict: 'ok' | 'throttled' | 'cap';
  count: number;
}

/** Claim one generation slot for a record of entityId. */
export async function claim(jobId: string, entityId: string, maxRecords: number): Promise<Claim> {
  const now = Math.floor(Date.now() / 1000);
  const [verdict, count] = await redis.claimSlot(
    progressKey(jobId), windowKey(jobId, entityId, Math.floor(now / WINDOW_S)),
    maxRecords, ENTITY_LIMIT, WINDOW_S, TTL_S, now,
  );
  return {verdict: verdict as Claim['verdict'], count: Number(count)};
}

/** Count a claimed record's outcome: admitted (with its seed digest), parked or rejected. */
export async function settle(jobId: string, recordId: string, entityId: string, outcome: string, seedDigest: string): Promise<void> {
  await redis.settleRecord(
    progressKey(jobId), coverageKey(jobId), recordsKey(jobId),
    outcome, entityId, recordId, seedDigest, TTL_S, Math.floor(Date.now() / 1000),
  );
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"synth/config" // config.EntityLimit, config.WindowSeconds, config.ProgressKey/WindowKey/RecordsKey — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Claim is claim's answer: the verdict (ok, throttled, cap) and the count behind it.
type Claim struct {
	Verdict string
	Count   int64
}

// claim takes one generation slot for a record of entityID.
func claim(ctx context.Context, jobID, entityID string, maxRecords int) (Claim, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	generated, err := rdb.HIncrBy(ctx, config.ProgressKey(jobID), "generated", 1).Result()
	if err != nil {
		return Claim{}, err
	}
	if generated > int64(maxRecords) {
		return Claim{Verdict: "cap", Count: generated - 1}, nil
	}
	key := config.WindowKey(jobID, entityID, time.Now().Unix()/config.WindowSeconds)
	count, err := rdb.Get(ctx, key).Int64()
	if err != nil && !errors.Is(err, redis.Nil) {
		return Claim{}, err
	}
	if count >= config.EntityLimit {
		if err := rdb.HIncrBy(ctx, config.ProgressKey(jobID), "throttled", 1).Err(); err != nil {
			return Claim{}, err
		}
		return Claim{Verdict: "throttled", Count: count}, nil
	}
	if err := rdb.Set(ctx, key, count+1, 0).Err(); err != nil {
		return Claim{}, err
	}
	return Claim{Verdict: "ok", Count: count + 1}, nil
}

// settle counts a claimed record's outcome: admitted (with its seed digest), parked or rejected.
func settle(ctx context.Context, jobID, recordID, entityID, outcome, seedDigest string) error {
	if err := rdb.HIncrBy(ctx, config.ProgressKey(jobID), outcome, 1).Err(); err != nil {
		return err
	}
	if outcome == "admitted" {
		return rdb.HSet(ctx, config.RecordsKey(jobID), recordID, seedDigest).Err()
	}
	return nil
}

func main() {
	c, err := claim(context.Background(), "job-demo", "entity-demo", 100)
	fmt.Println(c, err)
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"synth/config" // config.EntityLimit, config.WindowSeconds, config.TTLSeconds, config.*Key — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var claimSlot = redis.NewScript(\`
local progress, window = KEYS[1], KEYS[2]
local cap, limit, window_s, ttl, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), ARGV[5]
local generated = tonumber(redis.call('HGET', progress, 'generated') or '0')
if generated >= cap then
  return {'cap', tostring(generated)}
end
local count = tonumber(redis.call('GET', window) or '0')
if count >= limit then
  redis.call('HINCRBY', progress, 'throttled', 1)
  redis.call('HSET', progress, 'updated_at', now)
  redis.call('EXPIRE', progress, ttl)
  return {'throttled', tostring(count)}
end
count = redis.call('INCR', window)
if count == 1 then
  redis.call('EXPIRE', window, window_s)
end
redis.call('HINCRBY', progress, 'generated', 1)
redis.call('HSET', progress, 'updated_at', now)
redis.call('EXPIRE', progress, ttl)
return {'ok', tostring(count)}
\`)

var settleRecord = redis.NewScript(\`
local progress, coverage, records = KEYS[1], KEYS[2], KEYS[3]
local outcome, entity, record_id, digest, ttl, now = ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5]), ARGV[6]
redis.call('HINCRBY', progress, outcome, 1)
if outcome == 'admitted' then
  redis.call('HINCRBY', coverage, entity, 1)
  redis.call('HSET', records, record_id, digest)
  redis.call('EXPIRE', coverage, ttl)
  redis.call('EXPIRE', records, ttl)
end
redis.call('HSET', progress, 'updated_at', now)
redis.call('EXPIRE', progress, ttl)
return 1
\`)

// Claim is claim's answer: the verdict (ok, throttled, cap) and the count behind it.
type Claim struct {
	Verdict string
	Count   int64
}

// claim takes one generation slot for a record of entityID.
func claim(ctx context.Context, jobID, entityID string, maxRecords int) (Claim, error) {
	now := time.Now().Unix()
	keys := []string{config.ProgressKey(jobID), config.WindowKey(jobID, entityID, now/config.WindowSeconds)}
	reply, err := claimSlot.Run(ctx, rdb, keys, maxRecords, config.EntityLimit, config.WindowSeconds, config.TTLSeconds, now).Slice()
	if err != nil {
		return Claim{}, err
	}
	count, _ := strconv.ParseInt(fmt.Sprint(reply[1]), 10, 64)
	return Claim{Verdict: fmt.Sprint(reply[0]), Count: count}, nil
}

// settle counts a claimed record's outcome: admitted (with its seed digest), parked or rejected.
func settle(ctx context.Context, jobID, recordID, entityID, outcome, seedDigest string) error {
	keys := []string{config.ProgressKey(jobID), config.CoverageKey(jobID), config.RecordsKey(jobID)}
	return settleRecord.Run(ctx, rdb, keys, outcome, entityID, recordID, seedDigest, config.TTLSeconds, time.Now().Unix()).Err()
}

func main() {
	c, err := claim(context.Background(), "job-demo", "entity-demo", 100)
	fmt.Println(c, err)
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import synth.Config

/** claim's answer: the verdict (ok, throttled, cap) and the count behind it. */
final case class Claim(verdict: String, count: Long)

object SynthState {
  val jedis = new JedisPooled("redis", 6379)

  /** Claim one generation slot for a record of entityId. */
  def claim(jobId: String, entityId: String, maxRecords: Int): Claim = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val generated = jedis.hincrBy(Config.progressKey(jobId), "generated", 1)
    if (generated > maxRecords) return Claim("cap", generated - 1)
    val key = Config.windowKey(jobId, entityId, System.currentTimeMillis() / 1000 / Config.WindowSeconds)
    val count = Option(jedis.get(key)).map(_.toLong).getOrElse(0L)
    if (count >= Config.EntityLimit) {
      jedis.hincrBy(Config.progressKey(jobId), "throttled", 1)
      return Claim("throttled", count)
    }
    jedis.set(key, (count + 1).toString)
    Claim("ok", count + 1)
  }

  /** Count a claimed record's outcome: admitted (with its seed digest), parked or rejected. */
  def settle(jobId: String, recordId: String, entityId: String, outcome: String, seedDigest: String): Unit = {
    jedis.hincrBy(Config.progressKey(jobId), outcome, 1)
    if (outcome == "admitted") jedis.hset(Config.recordsKey(jobId), recordId, seedDigest)
    ()
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import synth.Config

/** claim's answer: the verdict (ok, throttled, cap) and the count behind it. */
final case class Claim(verdict: String, count: Long)

object SynthState {
  val jedis = new JedisPooled("redis", 6379)

  val ClaimSlot: String =
    """local progress, window = KEYS[1], KEYS[2]
      |local cap, limit, window_s, ttl, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), ARGV[5]
      |local generated = tonumber(redis.call('HGET', progress, 'generated') or '0')
      |if generated >= cap then
      |  return {'cap', tostring(generated)}
      |end
      |local count = tonumber(redis.call('GET', window) or '0')
      |if count >= limit then
      |  redis.call('HINCRBY', progress, 'throttled', 1)
      |  redis.call('HSET', progress, 'updated_at', now)
      |  redis.call('EXPIRE', progress, ttl)
      |  return {'throttled', tostring(count)}
      |end
      |count = redis.call('INCR', window)
      |if count == 1 then
      |  redis.call('EXPIRE', window, window_s)
      |end
      |redis.call('HINCRBY', progress, 'generated', 1)
      |redis.call('HSET', progress, 'updated_at', now)
      |redis.call('EXPIRE', progress, ttl)
      |return {'ok', tostring(count)}
      |""".stripMargin

  val SettleRecord: String =
    """local progress, coverage, records = KEYS[1], KEYS[2], KEYS[3]
      |local outcome, entity, record_id, digest, ttl, now = ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5]), ARGV[6]
      |redis.call('HINCRBY', progress, outcome, 1)
      |if outcome == 'admitted' then
      |  redis.call('HINCRBY', coverage, entity, 1)
      |  redis.call('HSET', records, record_id, digest)
      |  redis.call('EXPIRE', coverage, ttl)
      |  redis.call('EXPIRE', records, ttl)
      |end
      |redis.call('HSET', progress, 'updated_at', now)
      |redis.call('EXPIRE', progress, ttl)
      |return 1
      |""".stripMargin

  /** Claim one generation slot for a record of entityId. */
  def claim(jobId: String, entityId: String, maxRecords: Int): Claim = {
    val now = System.currentTimeMillis() / 1000
    val keys = List(Config.progressKey(jobId), Config.windowKey(jobId, entityId, now / Config.WindowSeconds))
    val args = List(maxRecords.toString, Config.EntityLimit.toString, Config.WindowSeconds.toString, Config.TtlSeconds.toString, now.toString)
    val reply = jedis.eval(ClaimSlot, keys.asJava, args.asJava).asInstanceOf[java.util.List[AnyRef]].asScala.map(_.toString)
    Claim(reply(0), reply(1).toLong)
  }

  /** Count a claimed record's outcome: admitted (with its seed digest), parked or rejected. */
  def settle(jobId: String, recordId: String, entityId: String, outcome: String, seedDigest: String): Unit = {
    val keys = List(Config.progressKey(jobId), Config.coverageKey(jobId), Config.recordsKey(jobId))
    val args = List(outcome, entityId, recordId, seedDigest, Config.TtlSeconds.toString, (System.currentTimeMillis() / 1000).toString)
    jedis.eval(SettleRecord, keys.asJava, args.asJava)
    ()
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

#include "synth/config.h"  // config::kEntityLimit, config::kWindowSeconds, config::progress_key/window_key/records_key — provided

sw::redis::Redis redis("tcp://redis:6379");

// claim's answer: the verdict (ok, throttled, cap) and the count behind it.
struct Claim {
  std::string verdict;
  long long count = 0;
};

long long unix_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Claim one generation slot for a record of entity_id.
Claim claim(const std::string& job_id, const std::string& entity_id, long long max_records) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const long long generated = redis.hincrby(config::progress_key(job_id), "generated", 1);
  if (generated > max_records) return {"cap", generated - 1};
  const std::string key = config::window_key(job_id, entity_id, unix_seconds() / config::kWindowSeconds);
  const auto raw = redis.get(key);
  const long long count = raw ? std::stoll(*raw) : 0;
  if (count >= config::kEntityLimit) {
    redis.hincrby(config::progress_key(job_id), "throttled", 1);
    return {"throttled", count};
  }
  redis.set(key, std::to_string(count + 1));
  return {"ok", count + 1};
}

// Count a claimed record's outcome: admitted (with its seed digest), parked or rejected.
void settle(const std::string& job_id, const std::string& record_id, const std::string& entity_id, const std::string& outcome,
            const std::string& seed_digest) {
  redis.hincrby(config::progress_key(job_id), outcome, 1);
  if (outcome == "admitted") redis.hset(config::records_key(job_id), record_id, seed_digest);
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

#include "synth/config.h"  // config::kEntityLimit, config::kWindowSeconds, config::kTtlSeconds, config::*_key — provided

sw::redis::Redis redis("tcp://redis:6379");

const std::string kClaimSlot = R"lua(
local progress, window = KEYS[1], KEYS[2]
local cap, limit, window_s, ttl, now = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4]), ARGV[5]
local generated = tonumber(redis.call('HGET', progress, 'generated') or '0')
if generated >= cap then
  return {'cap', tostring(generated)}
end
local count = tonumber(redis.call('GET', window) or '0')
if count >= limit then
  redis.call('HINCRBY', progress, 'throttled', 1)
  redis.call('HSET', progress, 'updated_at', now)
  redis.call('EXPIRE', progress, ttl)
  return {'throttled', tostring(count)}
end
count = redis.call('INCR', window)
if count == 1 then
  redis.call('EXPIRE', window, window_s)
end
redis.call('HINCRBY', progress, 'generated', 1)
redis.call('HSET', progress, 'updated_at', now)
redis.call('EXPIRE', progress, ttl)
return {'ok', tostring(count)}
)lua";

const std::string kSettleRecord = R"lua(
local progress, coverage, records = KEYS[1], KEYS[2], KEYS[3]
local outcome, entity, record_id, digest, ttl, now = ARGV[1], ARGV[2], ARGV[3], ARGV[4], tonumber(ARGV[5]), ARGV[6]
redis.call('HINCRBY', progress, outcome, 1)
if outcome == 'admitted' then
  redis.call('HINCRBY', coverage, entity, 1)
  redis.call('HSET', records, record_id, digest)
  redis.call('EXPIRE', coverage, ttl)
  redis.call('EXPIRE', records, ttl)
end
redis.call('HSET', progress, 'updated_at', now)
redis.call('EXPIRE', progress, ttl)
return 1
)lua";

// claim's answer: the verdict (ok, throttled, cap) and the count behind it.
struct Claim {
  std::string verdict;
  long long count = 0;
};

long long unix_seconds() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

// Claim one generation slot for a record of entity_id.
Claim claim(const std::string& job_id, const std::string& entity_id, long long max_records) {
  const long long now = unix_seconds();
  const auto [verdict, count] = redis.eval<std::string, std::string>(
      kClaimSlot, {config::progress_key(job_id), config::window_key(job_id, entity_id, now / config::kWindowSeconds)},
      {std::to_string(max_records), std::to_string(config::kEntityLimit), std::to_string(config::kWindowSeconds),
       std::to_string(config::kTtlSeconds), std::to_string(now)});
  return {verdict, std::stoll(count)};
}

// Count a claimed record's outcome: admitted (with its seed digest), parked or rejected.
void settle(const std::string& job_id, const std::string& record_id, const std::string& entity_id, const std::string& outcome,
            const std::string& seed_digest) {
  redis.eval<long long>(kSettleRecord, {config::progress_key(job_id), config::coverage_key(job_id), config::records_key(job_id)},
                        {outcome, entity_id, record_id, seed_digest, std::to_string(config::kTtlSeconds), std::to_string(unix_seconds())});
}
`,
    },
  },
  harness: {
    python: `import time

JOB = "j1"


def _window(entity):
    return f"synth:window:{JOB}:{entity}:{int(time.time()) // 60}"


def _progress(ctx):
    return {k: int(v) for k, v in ctx.redis.hgetall(f"synth:progress:{JOB}").items() if k != "updated_at"}


def _verdicts(m, entity, n, cap=100):
    return [m.claim(JOB, entity, cap)["verdict"] for _ in range(n)]


def check_entity_limit(ctx):
    m = ctx.load("state")
    verdicts = _verdicts(m, "e-paris", 6)
    assert verdicts == ["ok"] * 5 + ["throttled"], f"six claims for one entity in one window answered {verdicts}: five are ok, the sixth is throttled"
    assert ctx.redis.get(_window("e-paris")) == "5", f"the window counter {_window('e-paris')} must read 5, it holds {ctx.redis.get(_window('e-paris'))!r} (keys {sorted(ctx.redis.keys('synth:*'))})"
    other = m.claim(JOB, "e-lima", 100)
    assert other["verdict"] == "ok" and other["count"] == 1, f"another entity has its own window and starts at 1, got {other}"


def check_atomic_claim(ctx):
    m = ctx.load("state")
    assert _verdicts(m, "e-paris", 4) == ["ok"] * 4
    key = _window("e-paris")

    def other_worker():
        # another worker claiming the fifth slot of the same entity, landing during this worker's claim
        if int(ctx.redis.get(key) or 0) >= 5:
            return "throttled"
        ctx.redis.incr(key)
        ctx.redis.hincrby(f"synth:progress:{JOB}", "generated", 1)
        return "ok"

    probe = ctx.redis_after(key, other_worker)
    mine = m.claim(JOB, "e-paris", 100)
    assert probe.fired, "claim never touched the window counter"
    verdicts = sorted([mine["verdict"], probe.result])
    assert verdicts == ["ok", "throttled"], f"two workers raced for the last slot of the window and the verdicts were {verdicts}: the test and the INCR must run in one script, so exactly one of them gets it"
    assert ctx.redis.get(key) == "5", f"the window counter reads {ctx.redis.get(key)} after the race, expected 5: an increment was lost or the limit passed"
    assert _progress(ctx).get("generated") == 5, f"five slots were granted, generated is {_progress(ctx).get('generated')}"


def check_throttle_spares_cap(ctx):
    m = ctx.load("state")
    assert _verdicts(m, "e-paris", 5, cap=6) == ["ok"] * 5
    verdicts = _verdicts(m, "e-paris", 3, cap=6)
    assert verdicts == ["throttled"] * 3, f"three more claims for e-paris answered {verdicts}, expected throttled: a throttled claim generates nothing and must not spend the job's record cap"
    progress = _progress(ctx)
    assert progress.get("generated") == 5 and progress.get("throttled") == 3, f"five records generated, three throttled: progress holds {progress}"
    other = m.claim(JOB, "e-lima", 6)
    assert other["verdict"] == "ok", f"the job has generated 5 of 6 records, so e-lima gets the sixth; got {other}"
    full = m.claim(JOB, "e-rome", 6)
    assert full["verdict"] == "cap", f"with 6 of 6 generated the next claim is cap, got {full}"
    assert _progress(ctx).get("generated") == 6, f"generated must stop at max_records, it reads {_progress(ctx).get('generated')}"


def check_coverage_per_entity(ctx):
    m = ctx.load("state")
    plan = [("e-paris", "admitted"), ("e-paris", "admitted"), ("e-lima", "admitted"), ("e-lima", "parked"), ("e-rome", "rejected")]
    for i, (entity, outcome) in enumerate(plan):
        assert m.claim(JOB, entity, 100)["verdict"] == "ok"
        m.settle(JOB, f"r-{i}", entity, outcome, f"digest-{i}")
    coverage = ctx.redis.hgetall(f"synth:coverage:{JOB}")
    assert coverage == {"e-paris": "2", "e-lima": "1"}, f"synth:coverage:{JOB} must count admitted records per entity (e-paris 2, e-lima 1), it holds {coverage}"
    progress = _progress(ctx)
    assert (progress.get("generated"), progress.get("admitted"), progress.get("parked"), progress.get("rejected")) == (5, 3, 1, 1), f"five generated: three admitted, one parked, one rejected; progress holds {progress}"
    records = ctx.redis.hgetall(f"synth:records:{JOB}")
    assert records == {"r-0": "digest-0", "r-1": "digest-1", "r-2": "digest-2"}, f"only admitted records keep a seed digest, synth:records:{JOB} holds {records}"


def check_key_ttl(ctx):
    m = ctx.load("state")
    assert m.claim(JOB, "e-paris", 100)["verdict"] == "ok"
    m.settle(JOB, "r-1", "e-paris", "admitted", "d-1")
    window = _window("e-paris")
    ttl = ctx.redis.ttl(window)
    assert 0 < ttl <= 60, f"{window} has TTL {ttl}: the window counter expires after WINDOW_S (60 s), or a busy entity stays throttled and old windows pile up"
    for key in (f"synth:progress:{JOB}", f"synth:coverage:{JOB}", f"synth:records:{JOB}"):
        ttl = ctx.redis.ttl(key)
        assert ttl != -2, f"{key} does not exist after a claim and an admitted settle"
        assert 0 < ttl <= 86_400, f"{key} has TTL {ttl}: every key the job owns expires TTL_S (86400 s) after its last move"
    stamp = ctx.redis.hget(f"synth:progress:{JOB}", "updated_at")
    assert stamp is not None and stamp.isdigit(), f"the progress hash must carry updated_at (unix seconds), it holds {ctx.redis.hgetall(f'synth:progress:{JOB}')}"
    ctx.clock.advance(61)
    assert ctx.redis.get(window) is None, f"a minute later the old window counter must be gone, it still reads {ctx.redis.get(window)}"
    ctx.clock.advance(86_400)
    assert ctx.redis.keys("synth:*") == [], f"a day after its last move the job must be gone, found {sorted(ctx.redis.keys('synth:*'))}"
`,
    typescript: `const JOB = 'j1';

const windowOf = (ctx, entity: string) => \`synth:window:\${JOB}:\${entity}:\${Math.floor(ctx.clock.now() / 1000 / 60)}\`;
const progress = ctx => Object.fromEntries(Object.entries(ctx.redis.hgetall(\`synth:progress:\${JOB}\`)).filter(([k]) => k !== 'updated_at').map(([k, v]) => [k, Number(v)]));

async function verdicts(m, entity: string, n: number, cap = 100): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i += 1) out.push((await m.claim(JOB, entity, cap)).verdict);
  return out;
}

export async function check_entity_limit(ctx) {
  const m = ctx.load('state');
  const got = await verdicts(m, 'e-paris', 6);
  assert.deepEqual(got, ['ok', 'ok', 'ok', 'ok', 'ok', 'throttled'], \`six claims for one entity in one window answered \${JSON.stringify(got)}: five are ok, the sixth is throttled\`);
  assert.equal(ctx.redis.get(windowOf(ctx, 'e-paris')), '5', \`the window counter \${windowOf(ctx, 'e-paris')} must read 5 (keys \${JSON.stringify(ctx.redis.keys('synth:*').sort())})\`);
  const other = await m.claim(JOB, 'e-lima', 100);
  assert(other.verdict === 'ok' && other.count === 1, \`another entity has its own window and starts at 1, got \${JSON.stringify(other)}\`);
}

export async function check_atomic_claim(ctx) {
  const m = ctx.load('state');
  assert.deepEqual(await verdicts(m, 'e-paris', 4), ['ok', 'ok', 'ok', 'ok']);
  const key = windowOf(ctx, 'e-paris');
  // another worker claiming the fifth slot of the same entity, landing during this worker's claim
  const probe = ctx.redisAfter(key, () => {
    if (Number(ctx.redis.get(key) ?? 0) >= 5) return 'throttled';
    ctx.redis.incr(key);
    ctx.redis.hincrby(\`synth:progress:\${JOB}\`, 'generated', 1);
    return 'ok';
  });
  const mine = await m.claim(JOB, 'e-paris', 100);
  assert(probe.fired, 'claim never touched the window counter');
  const got = [mine.verdict, probe.result].sort();
  assert.deepEqual(got, ['ok', 'throttled'], \`two workers raced for the last slot of the window and the verdicts were \${JSON.stringify(got)}: the test and the INCR must run in one script, so exactly one of them gets it\`);
  assert.equal(ctx.redis.get(key), '5', \`the window counter reads \${ctx.redis.get(key)} after the race, expected 5: an increment was lost or the limit passed\`);
  assert.equal(progress(ctx).generated, 5, \`five slots were granted, generated is \${progress(ctx).generated}\`);
}

export async function check_throttle_spares_cap(ctx) {
  const m = ctx.load('state');
  assert.deepEqual(await verdicts(m, 'e-paris', 5, 6), ['ok', 'ok', 'ok', 'ok', 'ok']);
  const got = await verdicts(m, 'e-paris', 3, 6);
  assert.deepEqual(got, ['throttled', 'throttled', 'throttled'], \`three more claims for e-paris answered \${JSON.stringify(got)}, expected throttled: a throttled claim generates nothing and must not spend the job's record cap\`);
  const p = progress(ctx);
  assert(p.generated === 5 && p.throttled === 3, \`five records generated, three throttled: progress holds \${JSON.stringify(p)}\`);
  const other = await m.claim(JOB, 'e-lima', 6);
  assert.equal(other.verdict, 'ok', \`the job has generated 5 of 6 records, so e-lima gets the sixth; got \${JSON.stringify(other)}\`);
  const full = await m.claim(JOB, 'e-rome', 6);
  assert.equal(full.verdict, 'cap', \`with 6 of 6 generated the next claim is cap, got \${JSON.stringify(full)}\`);
  assert.equal(progress(ctx).generated, 6, \`generated must stop at max_records, it reads \${progress(ctx).generated}\`);
}

export async function check_coverage_per_entity(ctx) {
  const m = ctx.load('state');
  const plan = [['e-paris', 'admitted'], ['e-paris', 'admitted'], ['e-lima', 'admitted'], ['e-lima', 'parked'], ['e-rome', 'rejected']];
  for (const [i, [entity, outcome]] of plan.entries()) {
    assert.equal((await m.claim(JOB, entity, 100)).verdict, 'ok');
    await m.settle(JOB, \`r-\${i}\`, entity, outcome, \`digest-\${i}\`);
  }
  const coverage = ctx.redis.hgetall(\`synth:coverage:\${JOB}\`);
  assert.deepEqual(coverage, {'e-paris': '2', 'e-lima': '1'}, \`synth:coverage:\${JOB} must count admitted records per entity (e-paris 2, e-lima 1), it holds \${JSON.stringify(coverage)}\`);
  const p = progress(ctx);
  assert.deepEqual([p.generated, p.admitted, p.parked, p.rejected], [5, 3, 1, 1], \`five generated: three admitted, one parked, one rejected; progress holds \${JSON.stringify(p)}\`);
  const records = ctx.redis.hgetall(\`synth:records:\${JOB}\`);
  assert.deepEqual(records, {'r-0': 'digest-0', 'r-1': 'digest-1', 'r-2': 'digest-2'}, \`only admitted records keep a seed digest, synth:records:\${JOB} holds \${JSON.stringify(records)}\`);
}

export async function check_key_ttl(ctx) {
  const m = ctx.load('state');
  assert.equal((await m.claim(JOB, 'e-paris', 100)).verdict, 'ok');
  await m.settle(JOB, 'r-1', 'e-paris', 'admitted', 'd-1');
  const window = windowOf(ctx, 'e-paris');
  const wttl = Number(ctx.redis.ttl(window));
  assert(0 < wttl && wttl <= 60, \`\${window} has TTL \${wttl}: the window counter expires after WINDOW_S (60 s), or a busy entity stays throttled and old windows pile up\`);
  for (const key of [\`synth:progress:\${JOB}\`, \`synth:coverage:\${JOB}\`, \`synth:records:\${JOB}\`]) {
    const ttl = Number(ctx.redis.ttl(key));
    assert(ttl !== -2, \`\${key} does not exist after a claim and an admitted settle\`);
    assert(0 < ttl && ttl <= 86_400, \`\${key} has TTL \${ttl}: every key the job owns expires TTL_S (86400 s) after its last move\`);
  }
  const stamp = ctx.redis.hget(\`synth:progress:\${JOB}\`, 'updated_at');
  assert(typeof stamp === 'string' && /^\\d+$/.test(stamp), \`the progress hash must carry updated_at (unix seconds), it holds \${JSON.stringify(ctx.redis.hgetall(\`synth:progress:\${JOB}\`))}\`);
  ctx.clock.advance(61);
  assert.equal(ctx.redis.get(window), null, \`a minute later the old window counter must be gone, it still reads \${ctx.redis.get(window)}\`);
  ctx.clock.advance(86_400);
  assert.deepEqual(ctx.redis.keys('synth:*'), [], \`a day after its last move the job must be gone, found \${JSON.stringify(ctx.redis.keys('synth:*').sort())}\`);
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

const stateJob = "j1"

func stateWindow(ctx *harness.Ctx, entity string) string {
	return "synth:window:" + stateJob + ":" + entity + ":" + strconv.FormatInt(ctx.Clock.Now()/1000/60, 10)
}

func stateClaim(ctx *harness.Ctx, entity string, cap int) Claim {
	c, err := claim(context.Background(), stateJob, entity, cap)
	ctx.NoError(err, "claim(%q)", entity)
	return c
}

func stateVerdicts(ctx *harness.Ctx, entity string, n, cap int) []string {
	out := []string{}
	for i := 0; i < n; i++ {
		out = append(out, stateClaim(ctx, entity, cap).Verdict)
	}
	return out
}

func stateCount(ctx *harness.Ctx, field string) int64 {
	n, _ := strconv.ParseInt(ctx.Redis.HGetAll("synth:progress:"+stateJob)[field], 10, 64)
	return n
}

func CheckEntityLimit(ctx *harness.Ctx) {
	ctx.Equal(stateVerdicts(ctx, "e-paris", 6, 100), []string{"ok", "ok", "ok", "ok", "ok", "throttled"}, "six claims for one entity in one window: five are ok, the sixth is throttled")
	got, _ := ctx.Redis.Get(stateWindow(ctx, "e-paris"))
	ctx.Equal(got, "5", "the window counter %s (keys %v)", stateWindow(ctx, "e-paris"), ctx.Redis.Keys("synth:*"))
	other := stateClaim(ctx, "e-lima", 100)
	ctx.Assert(other.Verdict == "ok" && other.Count == 1, "another entity has its own window and starts at 1, got %+v", other)
}

func CheckAtomicClaim(ctx *harness.Ctx) {
	ctx.Equal(stateVerdicts(ctx, "e-paris", 4, 100), []string{"ok", "ok", "ok", "ok"}, "the first four claims")
	key := stateWindow(ctx, "e-paris")
	other := ""
	// another worker claiming the fifth slot of the same entity, landing during this worker's claim
	ctx.Redis.After(key, func() any {
		raw, _ := ctx.Redis.Get(key)
		n, _ := strconv.Atoi(raw)
		if n >= 5 {
			other = "throttled"
			return nil
		}
		ctx.Redis.Do("INCR", key)
		ctx.Redis.Do("HINCRBY", "synth:progress:"+stateJob, "generated", 1)
		other = "ok"
		return nil
	})
	mine := stateClaim(ctx, "e-paris", 100)
	ctx.Assert(other != "", "claim never touched the window counter")
	verdicts := []string{mine.Verdict, other}
	sort.Strings(verdicts)
	ctx.Equal(verdicts, []string{"ok", "throttled"}, "two workers raced for the last slot of the window: the test and the INCR must run in one script, so exactly one of them gets it; the verdicts")
	got, _ := ctx.Redis.Get(key)
	ctx.Equal(got, "5", "the window counter after the race (an increment was lost or the limit passed)")
	ctx.Equal(stateCount(ctx, "generated"), 5, "five slots were granted; generated")
}

func CheckThrottleSparesCap(ctx *harness.Ctx) {
	ctx.Equal(stateVerdicts(ctx, "e-paris", 5, 6), []string{"ok", "ok", "ok", "ok", "ok"}, "the first five claims")
	ctx.Equal(stateVerdicts(ctx, "e-paris", 3, 6), []string{"throttled", "throttled", "throttled"}, "three more claims for e-paris: a throttled claim generates nothing and must not spend the job's record cap")
	ctx.Assert(stateCount(ctx, "generated") == 5 && stateCount(ctx, "throttled") == 3, "five records generated, three throttled: progress holds %v", ctx.Redis.HGetAll("synth:progress:"+stateJob))
	ctx.Equal(stateClaim(ctx, "e-lima", 6).Verdict, "ok", "the job has generated 5 of 6 records, so e-lima gets the sixth")
	ctx.Equal(stateClaim(ctx, "e-rome", 6).Verdict, "cap", "with 6 of 6 generated the next claim")
	ctx.Equal(stateCount(ctx, "generated"), 6, "generated must stop at max_records")
}

func CheckCoveragePerEntity(ctx *harness.Ctx) {
	plan := [][2]string{{"e-paris", "admitted"}, {"e-paris", "admitted"}, {"e-lima", "admitted"}, {"e-lima", "parked"}, {"e-rome", "rejected"}}
	for i, p := range plan {
		ctx.Equal(stateClaim(ctx, p[0], 100).Verdict, "ok", "claim %s", p[0])
		ctx.NoError(settle(context.Background(), stateJob, "r-"+strconv.Itoa(i), p[0], p[1], "digest-"+strconv.Itoa(i)), "settle")
	}
	ctx.Equal(ctx.Redis.HGetAll("synth:coverage:"+stateJob), map[string]string{"e-paris": "2", "e-lima": "1"}, "synth:coverage:%s must count admitted records per entity", stateJob)
	ctx.Equal([]int64{stateCount(ctx, "generated"), stateCount(ctx, "admitted"), stateCount(ctx, "parked"), stateCount(ctx, "rejected")}, []int64{5, 3, 1, 1}, "five generated: three admitted, one parked, one rejected (%v)", ctx.Redis.HGetAll("synth:progress:"+stateJob))
	ctx.Equal(ctx.Redis.HGetAll("synth:records:"+stateJob), map[string]string{"r-0": "digest-0", "r-1": "digest-1", "r-2": "digest-2"}, "only admitted records keep a seed digest in synth:records:%s", stateJob)
}

func CheckKeyTtl(ctx *harness.Ctx) {
	ctx.Equal(stateClaim(ctx, "e-paris", 100).Verdict, "ok", "the claim")
	ctx.NoError(settle(context.Background(), stateJob, "r-1", "e-paris", "admitted", "d-1"), "settle")
	window := stateWindow(ctx, "e-paris")
	wttl := ctx.Redis.TTL(window)
	ctx.Assert(0 < wttl && wttl <= 60, "%s has TTL %d: the window counter expires after WindowSeconds (60 s), or a busy entity stays throttled and old windows pile up", window, wttl)
	for _, key := range []string{"synth:progress:" + stateJob, "synth:coverage:" + stateJob, "synth:records:" + stateJob} {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl != -2, "%s does not exist after a claim and an admitted settle", key)
		ctx.Assert(0 < ttl && ttl <= 86_400, "%s has TTL %d: every key the job owns expires TTLSeconds (86400 s) after its last move", key, ttl)
	}
	stamp, ok := ctx.Redis.HGet("synth:progress:"+stateJob, "updated_at")
	ctx.Assert(ok && regexp.MustCompile(\`^\\d+$\`).MatchString(stamp), "the progress hash must carry updated_at (unix seconds), it holds %v", ctx.Redis.HGetAll("synth:progress:"+stateJob))
	ctx.Clock.Advance(61)
	_, still := ctx.Redis.Get(window)
	ctx.Assert(!still, "a minute later the old window counter %s must be gone", window)
	ctx.Clock.Advance(86_400)
	ctx.Equal(len(ctx.Redis.Keys("synth:*")), 0, "a day after its last move the job must be gone (%v); keys left", ctx.Redis.Keys("synth:*"))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <cstdlib>
#include <map>
#include <string>
#include <vector>

namespace {

const std::string kJob = "j1";

std::string stateWindow(harness::Ctx& ctx, const std::string& entity) {
  return "synth:window:" + kJob + ":" + entity + ":" + std::to_string(ctx.Clock.Now() / 1000 / 60);
}

std::vector<std::string> stateVerdicts(const std::string& entity, int n, long long cap) {
  std::vector<std::string> out;
  for (int i = 0; i < n; i++) out.push_back(claim(kJob, entity, cap).verdict);
  return out;
}

long long stateCount(harness::Ctx& ctx, const std::string& field) {
  const auto all = ctx.Redis.HGetAll("synth:progress:" + kJob);
  const auto it = all.find(field);
  return it == all.end() ? 0 : std::strtoll(it->second.c_str(), nullptr, 10);
}

}  // namespace

void CheckEntityLimit(harness::Ctx& ctx) {
  ctx.Equal(stateVerdicts("e-paris", 6, 100), {"ok", "ok", "ok", "ok", "ok", "throttled"}, "six claims for one entity in one window: five are ok, the sixth is throttled");
  ctx.Equal(ctx.Redis.Get(stateWindow(ctx, "e-paris")).value_or(""), "5", "the window counter %s (keys %v)", stateWindow(ctx, "e-paris"), ctx.Redis.Keys("synth:*"));
  const Claim other = claim(kJob, "e-lima", 100);
  ctx.Assert(other.verdict == "ok" && other.count == 1, "another entity has its own window and starts at 1, got %s %d", other.verdict, other.count);
}

void CheckAtomicClaim(harness::Ctx& ctx) {
  ctx.Equal(stateVerdicts("e-paris", 4, 100), {"ok", "ok", "ok", "ok"}, "the first four claims");
  const std::string key = stateWindow(ctx, "e-paris");
  std::string other;
  // another worker claiming the fifth slot of the same entity, landing during this worker's claim
  ctx.Redis.After(key, [&] {
    const auto raw = ctx.Redis.Get(key);
    if (raw && std::atoi(raw->c_str()) >= 5) {
      other = "throttled";
      return;
    }
    ctx.Redis.Do("INCR", key);
    ctx.Redis.Do("HINCRBY", "synth:progress:" + kJob, "generated", 1);
    other = "ok";
  });
  const Claim mine = claim(kJob, "e-paris", 100);
  ctx.Assert(!other.empty(), "claim never touched the window counter");
  std::vector<std::string> verdicts = {mine.verdict, other};
  std::sort(verdicts.begin(), verdicts.end());
  ctx.Equal(verdicts, {"ok", "throttled"}, "two workers raced for the last slot of the window: the test and the INCR must run in one script, so exactly one of them gets it; the verdicts");
  ctx.Equal(ctx.Redis.Get(key).value_or(""), "5", "the window counter after the race (an increment was lost or the limit passed)");
  ctx.Equal(stateCount(ctx, "generated"), 5, "five slots were granted; generated");
}

void CheckThrottleSparesCap(harness::Ctx& ctx) {
  ctx.Equal(stateVerdicts("e-paris", 5, 6), {"ok", "ok", "ok", "ok", "ok"}, "the first five claims");
  ctx.Equal(stateVerdicts("e-paris", 3, 6), {"throttled", "throttled", "throttled"}, "three more claims for e-paris: a throttled claim generates nothing and must not spend the job's record cap");
  ctx.Assert(stateCount(ctx, "generated") == 5 && stateCount(ctx, "throttled") == 3, "five records generated, three throttled: progress holds %v", ctx.Redis.HGetAll("synth:progress:" + kJob));
  ctx.Equal(claim(kJob, "e-lima", 6).verdict, "ok", "the job has generated 5 of 6 records, so e-lima gets the sixth");
  ctx.Equal(claim(kJob, "e-rome", 6).verdict, "cap", "with 6 of 6 generated the next claim");
  ctx.Equal(stateCount(ctx, "generated"), 6, "generated must stop at max_records");
}

void CheckCoveragePerEntity(harness::Ctx& ctx) {
  const std::vector<std::pair<std::string, std::string>> plan = {{"e-paris", "admitted"}, {"e-paris", "admitted"}, {"e-lima", "admitted"}, {"e-lima", "parked"}, {"e-rome", "rejected"}};
  for (size_t i = 0; i < plan.size(); i++) {
    ctx.Equal(claim(kJob, plan[i].first, 100).verdict, "ok", "claim %s", plan[i].first);
    settle(kJob, "r-" + std::to_string(i), plan[i].first, plan[i].second, "digest-" + std::to_string(i));
  }
  ctx.Equal(ctx.Redis.HGetAll("synth:coverage:" + kJob), std::map<std::string, std::string>{{"e-paris", "2"}, {"e-lima", "1"}}, "synth:coverage:%s must count admitted records per entity", kJob);
  ctx.Equal(std::vector<long long>{stateCount(ctx, "generated"), stateCount(ctx, "admitted"), stateCount(ctx, "parked"), stateCount(ctx, "rejected")}, std::vector<long long>{5, 3, 1, 1},
            "five generated: three admitted, one parked, one rejected (%v)", ctx.Redis.HGetAll("synth:progress:" + kJob));
  ctx.Equal(ctx.Redis.HGetAll("synth:records:" + kJob), std::map<std::string, std::string>{{"r-0", "digest-0"}, {"r-1", "digest-1"}, {"r-2", "digest-2"}},
            "only admitted records keep a seed digest in synth:records:%s", kJob);
}

void CheckKeyTtl(harness::Ctx& ctx) {
  ctx.Equal(claim(kJob, "e-paris", 100).verdict, "ok", "the claim");
  settle(kJob, "r-1", "e-paris", "admitted", "d-1");
  const std::string window = stateWindow(ctx, "e-paris");
  const long long wttl = ctx.Redis.TTL(window);
  ctx.Assert(0 < wttl && wttl <= 60, "%s has TTL %d: the window counter expires after kWindowSeconds (60 s), or a busy entity stays throttled and old windows pile up", window, wttl);
  for (const std::string key : {"synth:progress:" + kJob, "synth:coverage:" + kJob, "synth:records:" + kJob}) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl != -2, "%s does not exist after a claim and an admitted settle", key);
    ctx.Assert(0 < ttl && ttl <= 86400, "%s has TTL %d: every key the job owns expires kTtlSeconds (86400 s) after its last move", key, ttl);
  }
  const auto stamp = ctx.Redis.HGet("synth:progress:" + kJob, "updated_at");
  ctx.Assert(stamp && !stamp->empty() && std::all_of(stamp->begin(), stamp->end(), [](char c) { return c >= '0' && c <= '9'; }),
             "the progress hash must carry updated_at (unix seconds), it holds %v", ctx.Redis.HGetAll("synth:progress:" + kJob));
  ctx.Clock.Advance(61);
  ctx.Assert(!ctx.Redis.Get(window).has_value(), "a minute later the old window counter %s must be gone", window);
  ctx.Clock.Advance(86400);
  ctx.Equal(ctx.Redis.Keys("synth:*").size(), 0, "a day after its last move the job must be gone (%v); keys left", ctx.Redis.Keys("synth:*"));
}
`,
  },
  debrief: `The script is the shape of the fix: the cap test, the window test and the increment have to be one decision, and Redis runs a script alone, so no second worker sees the counter between the read and the write. The order inside it matters as much: a claim spends the cap only when a record will really be generated, which keeps throttled repeats from ending a job early. The window lives in the key name and the expiry only cleans up, so the next minute starts from zero without a sweeper. Coverage per entity is the number that makes collapse visible; a total cannot. Production pipelines measure diversity more finely than an entity id (embedding clusters, n-gram overlap) and throttle per recipe and per seed source as well as per entity.`,
};
