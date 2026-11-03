import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis generation counters with diversity windows',
  concept: 'redis',
  file: 'state',
  focus: ['synth', 'redis', 'generator'],
  task: `## Task

**Starting point.** The starter's \`record_generated\` requires a \`seed_digest\`, reads a
\`records\` field from \`synth:total:{job_id}\` with \`HGET\`, increments it in a second call, stores
the last entity id, and returns \`{"admitted": true, "total": n}\`. It compiles, serves the demo and
hides 5 flaws.

**Failure mode the checks target.** Diversity collapse: a recipe asked for ten thousand records is
satisfied by one prolific entity and no totals-based gate notices. The client-side read-modify-write
loses increments under concurrency, and the missing TTL keeps every attempt in Redis for months.

\`record_generated\` is called by a generator worker per record:

- Coverage is a **hash per job**, \`synth:cov:{job_id}\`, entity id to admitted count.
- Repeats are throttled **per window** in \`synth:cov:{job_id}:{entity_id}:{window}\`, with
  \`window = int(time.time()) // WINDOW_S\` and \`WINDOW_S = 60\`.
- At most \`ENTITY_LIMIT = 5\` records per entity per window. Beyond that return \`throttled: true\`,
  admit and count nothing, and do **not** consume the job's record cap.
- Count, compare and expire in **one atomic Lua \`EVAL\`**.
- The windowed key gets **\`EXPIRE\` \`WINDOW_S\`** inside the script; the coverage hash
  \`JOB_TTL_S = 86400\`.
- Return \`{"admitted": bool, "throttled": bool, "coverage": {entity_id: count, …}}\`.`,
  sequence: {
    participants: ['Generator worker', 'Second worker', 'Redis'],
    messages: [
      {from: 'Generator worker', to: 'Redis', label: 'EVAL coverage key synth:cov:job-7:ent-42:window', kind: 'sync'},
      {from: 'Redis', to: 'Generator worker', label: '{1, count 3} · EXPIRE 60 · HINCRBY', kind: 'reply'},
      {from: 'Second worker', to: 'Redis', label: 'EVAL same entity, same window', kind: 'sync'},
      {from: 'Redis', to: 'Second worker', label: '{1, count 4} — no lost increment', kind: 'reply'},
      {from: 'Generator worker', to: 'Redis', label: 'EVAL sixth repeat inside the window', kind: 'sync'},
      {from: 'Redis', to: 'Generator worker', label: '{0, count 6} → throttled, cap untouched', kind: 'reply'},
      {from: 'Generator worker', to: 'Redis', label: 'HGETALL synth:cov:job-7', kind: 'sync'},
      {from: 'Redis', to: 'Generator worker', label: '{ent-42: 5, ent-77: 2} · per-entity coverage', kind: 'reply'},
    ],
  },
  hints: [
    'A job asked for ten thousand records reports ten thousand, the dashboard looks healthy, and the trained model has seen one seed entity over and over. Under two workers the total sometimes lands one short.',
    'One hash field per job cannot say which entity a record came from, and `HGET` followed by `HINCRBY` is two round trips, so two workers read the same count. No key carries a window or a TTL.',
    'Put `INCR` on `synth:cov:{job}:{entity}:{window}`, the `ENTITY_LIMIT` compare, `EXPIRE WINDOW_S` and the `HINCRBY` on the job hash into `COVERAGE_LUA`, run it with `.eval(`, and return `hgetall(` as `coverage`.',
  ],
  checks: [
    {
      id: 'atomic-window',
      title: 'Moves the counter and the limit in one atomic script',
      detail:
        'The increment, the limit comparison and the expiry happen inside one `EVAL`/`NewScript` call driven by `COVERAGE_LUA`. The starter reads the counter, compares on the client and writes it back, so two workers both observe the same value and one of them admits past the limit.',
      match: {
        python: {all: [/COVERAGE_LUA/, /\.eval\(/, /INCR/]},
        typescript: {all: [/COVERAGE_LUA/, /\.eval\(/, /INCR/]},
        go: {all: [/coverageScript/, /\.Run\(/, /INCR/]},
        scala: {all: [/CoverageLua/, /\.eval\(/, /INCR/]},
        cpp: {all: [/kCoverageLua/, /\.eval</, /INCR/]},
      },
    },
    {
      id: 'per-entity-key',
      title: 'Scopes the throttle to (job, entity, window)',
      detail:
        'The throttled counter is `synth:cov:{job_id}:{entity_id}:{window}`, so a repeat of one seed entity is what is limited and the bucket changes on schedule. The starter counts records, not entities, and has no window at all.',
      match: {
        python: {all: [/synth:cov:/, /entity_id/, /window/]},
        typescript: {all: [/synth:cov:/, /entityId/, /window/]},
        go: {all: [/synth:cov:/, /EntityID/, /window/]},
        scala: {all: [/synth:cov:/, /entityId/, /window/]},
        cpp: {all: [/synth:cov:/, /entity_id/, /window/]},
      },
    },
    {
      id: 'entity-limit',
      title: 'Throttles beyond five records of one entity per window',
      detail:
        '`ENTITY_LIMIT = 5` is enforced inside the script and the denied record comes back as `throttled`, admitted nowhere and counted nowhere. The starter has no per-entity limit, so a recipe can regenerate one popular entity without bound.',
      match: {
        python: {all: [/ENTITY_LIMIT\s*=\s*5/, /throttled/]},
        typescript: {all: [/ENTITY_LIMIT\s*=\s*5/, /throttled/]},
        go: {all: [/entityLimit\s*=\s*5/, /throttled/]},
        scala: {all: [/EntityLimit\s*=\s*5/, /throttled/]},
        cpp: {all: [/kEntityLimit\s*=\s*5/, /throttled/]},
      },
    },
    {
      id: 'window-ttl',
      title: 'Expires the window counters on schedule',
      detail:
        'The windowed counter is written with `EXPIRE` set from `WINDOW_S = 60` inside the script, so the throttle resets with the window and Redis does not accumulate a key per attempt per entity forever. The starter sets no TTL on any key.',
      match: {
        python: {all: [/WINDOW_S\s*=\s*60/, /EXPIRE/]},
        typescript: {all: [/WINDOW_S\s*=\s*60/, /EXPIRE/]},
        go: {all: [/windowS\s*=\s*60/, /EXPIRE/]},
        scala: {all: [/WindowS\s*=\s*60/, /EXPIRE/]},
        cpp: {all: [/kWindowS\s*=\s*60/, /EXPIRE/]},
      },
    },
    {
      id: 'coverage-not-totals',
      title: 'Reports per-entity coverage, not a total',
      detail:
        'The result carries the job’s coverage hash read from `synth:cov:{job_id}` — one count per seed entity — so diversity is measurable after the fact. The starter returns a single total, which is exactly the number that hid the collapse.',
      match: {
        python: {all: [/coverage/, /hgetall\(/]},
        typescript: {all: [/coverage/, /hgetall\(/]},
        go: {all: [/coverage/, /HGetAll\(/]},
        scala: {all: [/coverage/, /hgetAll\(/]},
        cpp: {all: [/coverage/, /hgetall\(/]},
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


class GeneratedRecord(BaseModel):
    job_id: str
    entity_id: str
    seed_digest: str


def record_generated(record: GeneratedRecord) -> dict:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    if not record.seed_digest:
        raise HTTPException(status_code=400, detail="seed_digest is required")
    total_key = f"synth:total:{record.job_id}"
    total = int(r.hget(total_key, "records") or 0)
    r.hincrby(total_key, "records", 1)
    r.hset(total_key, "last_entity_id", record.entity_id)
    return {"admitted": True, "total": total + 1}
`,
      solution: `import time

import redis
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 60
ENTITY_LIMIT = 5
JOB_TTL_S = 86_400

# One EVAL decides everything: the windowed counter moves and expires inside the script, the limit
# is compared server-side, and only an admitted record reaches the job's per-entity coverage hash.
COVERAGE_LUA = """
local count = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
if count > tonumber(ARGV[1]) then
  return {0, count}
end
redis.call('HINCRBY', KEYS[2], ARGV[3], 1)
redis.call('EXPIRE', KEYS[2], ARGV[4])
return {1, count}
"""


class GeneratedRecord(BaseModel):
    job_id: str
    entity_id: str
    seed_digest: str


def window_key(job_id: str, entity_id: str, window: int) -> str:
    return f"synth:cov:{job_id}:{entity_id}:{window}"


def coverage_key(job_id: str) -> str:
    return f"synth:cov:{job_id}"


def record_generated(record: GeneratedRecord) -> dict:
    if not record.seed_digest:
        raise HTTPException(status_code=400, detail="seed_digest is required")
    window = int(time.time()) // WINDOW_S
    reply = r.eval(
        COVERAGE_LUA,
        2,
        window_key(record.job_id, record.entity_id, window),
        coverage_key(record.job_id),
        ENTITY_LIMIT,
        WINDOW_S,
        record.entity_id,
        JOB_TTL_S,
    )
    admitted = bool(reply[0])
    coverage = {entity: int(count) for entity, count in r.hgetall(coverage_key(record.job_id)).items()}
    return {"admitted": admitted, "throttled": not admitted, "coverage": coverage}
`,
    },
    typescript: {
      starter: `/** recordGenerated: move the job counter for one generated record. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

interface GeneratedRecord {
  job_id: string;
  entity_id: string;
  seed_digest: string;
}

interface GenerationResult {
  admitted: boolean;
  total: number;
}

export async function recordGenerated(record: GeneratedRecord): Promise<GenerationResult> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const totalKey = \`synth:total:\${record.job_id}\`;
  const total = Number((await r.hget(totalKey, 'records')) ?? 0);
  await r.hincrby(totalKey, 'records', 1);
  await r.hset(totalKey, 'last_entity_id', record.entity_id);
  return {admitted: true, total: total + 1};
}
`,
      solution: `/** recordGenerated: one EVAL moves the entity's window counter and the job's coverage hash. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const WINDOW_S = 60;
const ENTITY_LIMIT = 5;
const JOB_TTL_S = 86_400;

// The windowed counter moves and expires inside the script, the limit is compared server-side,
// and only an admitted record reaches the job's per-entity coverage hash.
const COVERAGE_LUA = \`
local count = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
if count > tonumber(ARGV[1]) then
  return {0, count}
end
redis.call('HINCRBY', KEYS[2], ARGV[3], 1)
redis.call('EXPIRE', KEYS[2], ARGV[4])
return {1, count}
\`;

interface GeneratedRecord {
  job_id: string;
  entity_id: string;
  seed_digest: string;
}

interface GenerationResult {
  admitted: boolean;
  throttled: boolean;
  coverage: Record<string, number>;
}

function windowKey(jobId: string, entityId: string, window: number): string {
  return \`synth:cov:\${jobId}:\${entityId}:\${window}\`;
}

function coverageKey(jobId: string): string {
  return \`synth:cov:\${jobId}\`;
}

export async function recordGenerated(record: GeneratedRecord): Promise<GenerationResult> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const reply = (await r.eval(
    COVERAGE_LUA,
    2,
    windowKey(record.job_id, record.entity_id, window),
    coverageKey(record.job_id),
    String(ENTITY_LIMIT),
    String(WINDOW_S),
    record.entity_id,
    String(JOB_TTL_S),
  )) as [number, number];
  const admitted = reply[0] === 1;
  const fields = await r.hgetall(coverageKey(record.job_id));
  const coverage: Record<string, number> = {};
  for (const entity of Object.keys(fields)) coverage[entity] = Number(fields[entity]);
  return {admitted, throttled: !admitted, coverage};
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

type GeneratedRecord struct {
	JobID      string \`json:"job_id"\`
	EntityID   string \`json:"entity_id"\`
	SeedDigest string \`json:"seed_digest"\`
}

type GenerationResult struct {
	Admitted bool  \`json:"admitted"\`
	Total    int64 \`json:"total"\`
}

func recordGenerated(ctx context.Context, record GeneratedRecord) (GenerationResult, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	totalKey := fmt.Sprintf("synth:total:%s", record.JobID)
	total, _ := rdb.HGet(ctx, totalKey, "records").Int64()
	rdb.HIncrBy(ctx, totalKey, "records", 1)
	rdb.HSet(ctx, totalKey, "last_entity_id", record.EntityID)
	return GenerationResult{Admitted: true, Total: total + 1}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	windowS     = 60
	entityLimit = 5
	jobTTLS     = 86400
)

var rdb *redis.Client

// The windowed counter moves and expires inside the script, the limit is compared server-side,
// and only an admitted record reaches the job's per-entity coverage hash.
var coverageScript = redis.NewScript(\`
local count = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
if count > tonumber(ARGV[1]) then
  return {0, count}
end
redis.call('HINCRBY', KEYS[2], ARGV[3], 1)
redis.call('EXPIRE', KEYS[2], ARGV[4])
return {1, count}
\`)

type GeneratedRecord struct {
	JobID      string \`json:"job_id"\`
	EntityID   string \`json:"entity_id"\`
	SeedDigest string \`json:"seed_digest"\`
}

type GenerationResult struct {
	Admitted  bool             \`json:"admitted"\`
	Throttled bool             \`json:"throttled"\`
	Coverage  map[string]int64 \`json:"coverage"\`
}

func windowKey(jobID, entityID string, window int64) string {
	return fmt.Sprintf("synth:cov:%s:%s:%d", jobID, entityID, window)
}

func coverageKey(jobID string) string {
	return fmt.Sprintf("synth:cov:%s", jobID)
}

func recordGenerated(ctx context.Context, record GeneratedRecord) (GenerationResult, error) {
	window := time.Now().Unix() / windowS
	values, err := coverageScript.Run(
		ctx,
		rdb,
		[]string{windowKey(record.JobID, record.EntityID, window), coverageKey(record.JobID)},
		entityLimit,
		windowS,
		record.EntityID,
		jobTTLS,
	).Int64Slice()
	if err != nil {
		return GenerationResult{}, err
	}
	fields, err := rdb.HGetAll(ctx, coverageKey(record.JobID)).Result()
	if err != nil {
		return GenerationResult{}, err
	}
	coverage := make(map[string]int64, len(fields))
	for entity, count := range fields {
		n, _ := strconv.ParseInt(count, 10, 64)
		coverage[entity] = n
	}
	admitted := values[0] == 1
	return GenerationResult{Admitted: admitted, Throttled: !admitted, Coverage: coverage}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

final case class GeneratedRecord(job_id: String, entity_id: String, seed_digest: String)
final case class GenerationResult(admitted: Boolean, total: Long)

object GenerationStore {
  val r = new Jedis("redis", 6379)

  def recordGenerated(record: GeneratedRecord): GenerationResult = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val totalKey = s"synth:total:\${record.job_id}"
    val total = Option(r.hget(totalKey, "records")).map(_.toLong).getOrElse(0L)
    r.hincrBy(totalKey, "records", 1)
    r.hset(totalKey, "last_entity_id", record.entity_id)
    GenerationResult(admitted = true, total = total + 1)
  }
}
`,
      solution: `import redis.clients.jedis.Jedis
import scala.jdk.CollectionConverters._

final case class GeneratedRecord(job_id: String, entity_id: String, seed_digest: String)
final case class GenerationResult(admitted: Boolean, throttled: Boolean, coverage: Map[String, Long])

object GenerationStore {
  val WindowS = 60L
  val EntityLimit = 5L
  val JobTTLS = 86400L
  val r = new Jedis("redis", 6379)

  // The windowed counter moves and expires inside the script, the limit is compared server-side,
  // and only an admitted record reaches the job's per-entity coverage hash.
  val CoverageLua =
    """
      |local count = redis.call('INCR', KEYS[1])
      |redis.call('EXPIRE', KEYS[1], ARGV[2])
      |if count > tonumber(ARGV[1]) then
      |  return {0, count}
      |end
      |redis.call('HINCRBY', KEYS[2], ARGV[3], 1)
      |redis.call('EXPIRE', KEYS[2], ARGV[4])
      |return {1, count}
      |""".stripMargin

  def windowKey(jobId: String, entityId: String, window: Long): String =
    s"synth:cov:\${jobId}:\${entityId}:\${window}"

  def coverageKey(jobId: String): String = s"synth:cov:\${jobId}"

  /** Jedis hands back field strings; the report wants one count per seed entity. */
  def hgetall(key: String): Map[String, Long] =
    r.hgetAll(key).asScala.map { case (entity, count) => entity -> count.toLong }.toMap

  def recordGenerated(record: GeneratedRecord): GenerationResult = {
    val window = System.currentTimeMillis() / 1000 / WindowS
    val reply = r
      .eval(
        CoverageLua,
        2,
        windowKey(record.job_id, record.entity_id, window),
        coverageKey(record.job_id),
        EntityLimit.toString,
        WindowS.toString,
        record.entity_id,
        JobTTLS.toString
      )
      .asInstanceOf[java.util.List[Long]]
    val admitted = reply.get(0) == 1L
    GenerationResult(
      admitted = admitted,
      throttled = !admitted,
      coverage = hgetall(coverageKey(record.job_id))
    )
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

struct GeneratedRecord {
  std::string job_id;
  std::string entity_id;
  std::string seed_digest;
};

struct GenerationResult {
  bool admitted;
  long long total;
};

GenerationResult recordGenerated(sw::redis::Redis& redis, const GeneratedRecord& record) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const auto totalKey = "synth:total:" + record.job_id;
  auto raw = redis.hget(totalKey, "records");
  const long long total = raw ? std::stoll(*raw) : 0;
  redis.hincrby(totalKey, "records", 1);
  redis.hset(totalKey, "last_entity_id", record.entity_id);
  return {true, total + 1};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <unordered_map>
#include <vector>

constexpr long long kWindowS = 60;
constexpr long long kEntityLimit = 5;
constexpr long long kJobTTLS = 86400;

// The windowed counter moves and expires inside the script, the limit is compared server-side,
// and only an admitted record reaches the job's per-entity coverage hash.
const char* kCoverageLua = R"LUA(
local count = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
if count > tonumber(ARGV[1]) then
  return {0, count}
end
redis.call('HINCRBY', KEYS[2], ARGV[3], 1)
redis.call('EXPIRE', KEYS[2], ARGV[4])
return {1, count}
)LUA";

struct GeneratedRecord {
  std::string job_id;
  std::string entity_id;
  std::string seed_digest;
};

struct GenerationResult {
  bool admitted;
  bool throttled;
  std::unordered_map<std::string, long long> coverage;
};

std::string windowKey(const std::string& jobId, const std::string& entityId, long long window) {
  return "synth:cov:" + jobId + ":" + entityId + ":" + std::to_string(window);
}

std::string coverageKey(const std::string& jobId) {
  return "synth:cov:" + jobId;
}

GenerationResult recordGenerated(sw::redis::Redis& redis, const GeneratedRecord& record) {
  const auto window = std::chrono::duration_cast<std::chrono::seconds>(
                          std::chrono::system_clock::now().time_since_epoch())
                          .count() /
                      kWindowS;
  const auto reply = redis.eval<std::vector<long long>>(
      kCoverageLua,
      {windowKey(record.job_id, record.entity_id, window), coverageKey(record.job_id)},
      {std::to_string(kEntityLimit), std::to_string(kWindowS), record.entity_id, std::to_string(kJobTTLS)});
  const bool admitted = reply[0] == 1;
  const auto fields = redis.hgetall(coverageKey(record.job_id));
  std::unordered_map<std::string, long long> coverage;
  for (const auto& [entity, count] : fields) {
    coverage[entity] = std::stoll(count);
  }
  return {admitted, !admitted, coverage};
}
`,
    },
  },
  debrief: `The fix moves the decision into Redis because the decision is a read followed by a write on the same value, and only a script can make those two steps one. The window number lives in the key rather than in a reset job so a new window starts from zero by construction, and the \`EXPIRE\` sits inside the same script so no key can be created without its TTL. Keeping the throttled attempt out of both the windowed counter and the job hash is what keeps the cap for records the corpus kept. A production ledger would also report diversity over entity *types*, not just ids, and shuffle the seed order so the cap is spent across entities instead of down the list.`,
};
