import type {Step} from '@/lib/types';

export const scanCacheStep: Step = {
  id: 'scan-cache',
  title: 'Redis: results by schema hash, a daily budget reserved atomically, keys that expire',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'scan_cache',
  focus: ['metasense', 'redis', 'llm'],
  task: `## Task

**Starting point.** The starter's \`classify_entity(job)\` takes a job from step 1 (\`entity\`,
\`owner\`, \`schema_hash\`, \`columns\`). It answers from \`classify:{entity}\` when that key exists;
otherwise it reads \`budget:{day}\` (UTC \`YYYY-MM-DD\`), raises \`BudgetExhausted\` at 400, calls
\`classify_columns\` (step 2), runs \`INCR\` on the counter, stores the tags and writes
\`verify:{entity}\` (\`owner\`, \`schema_hash\`, \`state=pending\`) for step 4. It hides 3 flaws.

**Failure mode the checks target.** A cache keyed by name serves the old tags after a schema change,
the one case governance cares about; two workers that both read 399 both call the model, so the cap
is a hope; and keys without an expiry grow with every table the lake ever had.

- Cache the tags under \`classify:{entity}:{schema_hash}\`. A hit spends no budget.
- Reserve the day's slot (\`DAILY_ENTITY_BUDGET\` = 400) with **one Lua script** before the model
  call: \`INCR\`, \`EXPIRE\` the counter (\`BUDGET_TTL_S\`, 2 days) on its first write, and over the
  cap \`DECR\` and answer 0, which raises \`BudgetExhausted\`.
- The tags expire after **7 days** (\`RESULT_TTL_S\`), and so does \`verify:{entity}\`
  (\`VERIFY_TTL_S\`).`,
  sequence: {
    participants: ['metasense', 'Redis', 'LLM gateway'],
    messages: [
      {from: 'metasense', to: 'Redis', label: 'GET classify:{entity}:{schema_hash}', kind: 'sync'},
      {from: 'Redis', to: 'metasense', label: 'nil', kind: 'reply'},
      {from: 'metasense', to: 'Redis', label: 'EVAL reserve · budget:{day} · 400 · 172800', kind: 'sync'},
      {from: 'Redis', to: 'metasense', label: '1 (0 → BudgetExhausted, no call)', kind: 'reply'},
      {from: 'metasense', to: 'LLM gateway', label: 'classify_columns(entity, columns)', kind: 'sync'},
      {from: 'LLM gateway', to: 'metasense', label: 'tags', kind: 'reply'},
      {from: 'metasense', to: 'Redis', label: 'SET classify:… EX 604800 · HSET verify:{entity} · EXPIRE', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'cache-key',
      title: 'Caches tags per schema, so a changed schema is classified again',
      detail:
        'After a column is added, the entity is classified again and the new tags are cached under `classify:{entity}:{schema_hash}`; a job for the old schema is still a cache hit that spends no budget. The starter keys by entity and serves the old tags.',
      match: {
        python: {all: [/classify:\{[^}\n]+\}:\{[^}\n]+\}/]},
        typescript: {all: [/classify:\$\{[^}\n]+\}:\$\{[^}\n]+\}/]},
        go: {all: [/"classify:"\s*\+[^\n]*\+\s*":"\s*\+/]},
        scala: {all: [/s"classify:\$\{?[\w.]+\}?:\$/]},
        cpp: {all: [/"classify:"\s*\+[^\n;]*\+\s*":"\s*\+/]},
      },
    },
    {
      id: 'budget-atomic',
      title: 'Reserves the day’s budget atomically, before the call',
      detail:
        'With the day at 400 no call is made and the counter stays at 400; at 399 the 400th entity still gets its slot, and with another worker reserving at the same moment exactly one of the two gets it and the counter never passes 400. The starter reads, calls, then increments, so both workers pass.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /['"]INCR['"]/, /['"]DECR['"]/], none: [/\br\.incr\(/]},
        typescript: {all: [/\.eval\(|defineCommand\(/, /['"]INCR['"]/, /['"]DECR['"]/], none: [/redis\.incr\(/]},
        go: {all: [/redis\.NewScript\(/, /['"]INCR['"]/, /['"]DECR['"]/], none: [/rdb\.Incr\(/]},
        scala: {all: [/jedis\.eval\(/, /['"]INCR['"]/, /['"]DECR['"]/], none: [/jedis\.incr\(/]},
        cpp: {all: [/\.eval</, /['"]INCR['"]/, /['"]DECR['"]/], none: [/\bredis\.incr\(/]},
      },
    },
    {
      id: 'expiry',
      title: 'Every key it writes expires',
      detail:
        'The cached tags and `verify:{entity}` expire after 7 days and the day counter 2 days after its first write, not its latest; the tags and the counter have their expiry from the moment they exist. The starter sets no expiry on any of them.',
      match: {
        python: {all: [/ex\s*=\s*RESULT_TTL_S/, /\.expire\([^\n]*VERIFY_TTL_S/, /BUDGET_TTL_S/]},
        typescript: {all: [/['"]EX['"],\s*RESULT_TTL_S/, /\.expire\([^\n]*VERIFY_TTL_S/, /BUDGET_TTL_S/]},
        go: {all: [/\.Set\([^\n]*resultTTL\)/, /\.Expire\([^\n]*verifyTTL\)/, /budgetTTLSeconds/]},
        scala: {all: [/setex\([^\n]*ResultTtlS/, /\.expire\([^\n]*VerifyTtlS/, /BudgetTtlS/]},
        cpp: {all: [/\.set\([^\n]*kResultTtl/, /\.expire\([^\n]*kVerifyTtl/, /kBudgetTtlS/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import time

import redis

from classify_columns import classify_columns  # step 2: one tag per column; raises ClassifyFailed

r = redis.Redis(host="redis", port=6379, decode_responses=True)

DAILY_ENTITY_BUDGET = 400


class BudgetExhausted(Exception):
    """Today's budget is spent: the job waits for tomorrow and the model is not called."""


def classify_entity(job: dict) -> dict[str, str]:
    """The entity's tags: from the cache, or from the model within today's budget."""
    # TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
    entity = job["entity"]
    cached = r.get(f"classify:{entity}")
    if cached is not None:
        return json.loads(cached)
    day = "budget:" + time.strftime("%Y-%m-%d", time.gmtime())
    if int(r.get(day) or 0) >= DAILY_ENTITY_BUDGET:
        raise BudgetExhausted(f"{day} is spent")
    tags = classify_columns(entity, job["columns"])
    r.incr(day)
    r.set(f"classify:{entity}", json.dumps(tags))
    r.hset(f"verify:{entity}", mapping={"owner": job["owner"], "schema_hash": job["schema_hash"], "state": "pending"})
    return tags
`,
      solution: `import json
import time

import redis

from classify_columns import classify_columns  # step 2: one tag per column; raises ClassifyFailed

r = redis.Redis(host="redis", port=6379, decode_responses=True)

DAILY_ENTITY_BUDGET = 400
RESULT_TTL_S = 7 * 24 * 3600
VERIFY_TTL_S = 7 * 24 * 3600
BUDGET_TTL_S = 2 * 24 * 3600  # outlives its day, then goes

# One round trip, one decision: two workers at 399 cannot both get the last slot.
RESERVE_LUA = """
local used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if used > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
"""
reserve = r.register_script(RESERVE_LUA)


class BudgetExhausted(Exception):
    """Today's budget is spent: the job waits for tomorrow and the model is not called."""


def classify_entity(job: dict) -> dict[str, str]:
    """The entity's tags: from the cache, or from the model within today's budget."""
    entity = job["entity"]
    cache_key = f"classify:{entity}:{job['schema_hash']}"
    cached = r.get(cache_key)
    if cached is not None:
        return json.loads(cached)
    day = "budget:" + time.strftime("%Y-%m-%d", time.gmtime())
    if reserve(keys=[day], args=[DAILY_ENTITY_BUDGET, BUDGET_TTL_S]) != 1:
        raise BudgetExhausted(f"{day} is spent")
    tags = classify_columns(entity, job["columns"])
    r.set(cache_key, json.dumps(tags), ex=RESULT_TTL_S)
    r.hset(f"verify:{entity}", mapping={"owner": job["owner"], "schema_hash": job["schema_hash"], "state": "pending"})
    r.expire(f"verify:{entity}", VERIFY_TTL_S)
    return tags
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import type {Job} from 'metasense/jobs';

import {classifyColumns} from './classify_columns'; // step 2: one tag per column; throws ClassifyFailed

const redis = new Redis({host: 'redis', port: 6379});

export const DAILY_ENTITY_BUDGET = 400;

/** Today's budget is spent: the job waits for tomorrow and the model is not called. */
export class BudgetExhausted extends Error {}

/** The entity's tags: from the cache, or from the model within today's budget. */
export async function classifyEntity(job: Job): Promise<Record<string, string>> {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const cached = await redis.get(\`classify:\${job.entity}\`);
  if (cached !== null) return JSON.parse(cached) as Record<string, string>;
  const day = \`budget:\${new Date().toISOString().slice(0, 10)}\`;
  if (Number((await redis.get(day)) ?? 0) >= DAILY_ENTITY_BUDGET) throw new BudgetExhausted(\`\${day} is spent\`);
  const tags = await classifyColumns(job.entity, job.columns);
  await redis.incr(day);
  await redis.set(\`classify:\${job.entity}\`, JSON.stringify(tags));
  await redis.hset(\`verify:\${job.entity}\`, {owner: job.owner, schema_hash: job.schema_hash ?? '', state: 'pending'});
  return tags;
}
`,
      solution: `import Redis from 'ioredis';

import type {Job} from 'metasense/jobs';

import {classifyColumns} from './classify_columns'; // step 2: one tag per column; throws ClassifyFailed

const redis = new Redis({host: 'redis', port: 6379});

export const DAILY_ENTITY_BUDGET = 400;
export const RESULT_TTL_S = 7 * 24 * 3600;
export const VERIFY_TTL_S = 7 * 24 * 3600;
export const BUDGET_TTL_S = 2 * 24 * 3600; // outlives its day, then goes

// One round trip, one decision: two workers at 399 cannot both get the last slot.
export const RESERVE_LUA = \`
local used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if used > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
\`;

/** Today's budget is spent: the job waits for tomorrow and the model is not called. */
export class BudgetExhausted extends Error {}

/** The entity's tags: from the cache, or from the model within today's budget. */
export async function classifyEntity(job: Job): Promise<Record<string, string>> {
  const cacheKey = \`classify:\${job.entity}:\${job.schema_hash}\`;
  const cached = await redis.get(cacheKey);
  if (cached !== null) return JSON.parse(cached) as Record<string, string>;
  const day = \`budget:\${new Date().toISOString().slice(0, 10)}\`;
  if (Number(await redis.eval(RESERVE_LUA, 1, day, DAILY_ENTITY_BUDGET, BUDGET_TTL_S)) !== 1) throw new BudgetExhausted(\`\${day} is spent\`);
  const tags = await classifyColumns(job.entity, job.columns);
  await redis.set(cacheKey, JSON.stringify(tags), 'EX', RESULT_TTL_S);
  await redis.hset(\`verify:\${job.entity}\`, {owner: job.owner, schema_hash: job.schema_hash ?? '', state: 'pending'});
  await redis.expire(\`verify:\${job.entity}\`, VERIFY_TTL_S);
  return tags;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"metasense/jobs"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const dailyEntityBudget = 400

// ErrBudgetExhausted: today's budget is spent; the job waits for tomorrow and the model is not called.
var ErrBudgetExhausted = errors.New("budget exhausted")

// Built in step 2 (classify_columns.go): one tag per column from the LLM gateway.
var classifyColumns = func(ctx context.Context, entity string, columns []string) (map[string]string, error) {
	panic("built in step 2")
}

// classifyEntity is the entity's tags: from the cache, or from the model within today's budget.
func classifyEntity(ctx context.Context, job jobs.Job) (map[string]string, error) {
	// TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
	cached, err := rdb.Get(ctx, "classify:"+job.Entity).Result()
	if err == nil {
		tags := map[string]string{}
		return tags, json.Unmarshal([]byte(cached), &tags)
	}
	day := "budget:" + time.Now().UTC().Format("2006-01-02")
	used, _ := rdb.Get(ctx, day).Int()
	if used >= dailyEntityBudget {
		return nil, fmt.Errorf("%w: %s", ErrBudgetExhausted, day)
	}
	tags, err := classifyColumns(ctx, job.Entity, job.Columns)
	if err != nil {
		return nil, err
	}
	rdb.Incr(ctx, day)
	raw, _ := json.Marshal(tags)
	rdb.Set(ctx, "classify:"+job.Entity, raw, 0)
	rdb.HSet(ctx, "verify:"+job.Entity, map[string]any{"owner": job.Owner, "schema_hash": job.SchemaHash, "state": "pending"})
	return tags, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"metasense/jobs"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	dailyEntityBudget = 400
	resultTTL         = 7 * 24 * time.Hour
	verifyTTL         = 7 * 24 * time.Hour
	budgetTTLSeconds  = 2 * 24 * 3600 // outlives its day, then goes
)

// reserveScript is one round trip, one decision: two workers at 399 cannot both get the last slot.
var reserveScript = redis.NewScript(\`
local used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if used > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
\`)

// ErrBudgetExhausted: today's budget is spent; the job waits for tomorrow and the model is not called.
var ErrBudgetExhausted = errors.New("budget exhausted")

// Built in step 2 (classify_columns.go): one tag per column from the LLM gateway.
var classifyColumns = func(ctx context.Context, entity string, columns []string) (map[string]string, error) {
	panic("built in step 2")
}

// classifyEntity is the entity's tags: from the cache, or from the model within today's budget.
func classifyEntity(ctx context.Context, job jobs.Job) (map[string]string, error) {
	cacheKey := "classify:" + job.Entity + ":" + job.SchemaHash
	cached, err := rdb.Get(ctx, cacheKey).Result()
	if err == nil {
		tags := map[string]string{}
		return tags, json.Unmarshal([]byte(cached), &tags)
	}
	day := "budget:" + time.Now().UTC().Format("2006-01-02")
	reserved, err := reserveScript.Run(ctx, rdb, []string{day}, dailyEntityBudget, budgetTTLSeconds).Int64()
	if err != nil {
		return nil, err
	}
	if reserved != 1 {
		return nil, fmt.Errorf("%w: %s", ErrBudgetExhausted, day)
	}
	tags, err := classifyColumns(ctx, job.Entity, job.Columns)
	if err != nil {
		return nil, err
	}
	raw, _ := json.Marshal(tags)
	if err := rdb.Set(ctx, cacheKey, raw, resultTTL).Err(); err != nil {
		return nil, err
	}
	rdb.HSet(ctx, "verify:"+job.Entity, map[string]any{"owner": job.Owner, "schema_hash": job.SchemaHash, "state": "pending"})
	return tags, rdb.Expire(ctx, "verify:"+job.Entity, verifyTTL).Err()
}
`,
    },
    scala: {
      starter: `import java.time.{LocalDate, ZoneOffset}

import redis.clients.jedis.JedisPooled
import spray.json._

import metasense.Jobs

import scala.jdk.CollectionConverters._

/** Today's budget is spent: the job waits for tomorrow and the model is not called. */
final class BudgetExhausted(message: String) extends RuntimeException(message)

object ScanCache {
  val jedis = new JedisPooled("redis", 6379)
  val DailyEntityBudget = 400

  private def tagsOf(raw: String): Map[String, String] = raw.parseJson.asJsObject.fields.collect { case (c, JsString(t)) => c -> t }

  /** The entity's tags: from the cache, or from the model within today's budget. */
  def classifyEntity(job: Jobs.Job): Map[String, String] = {
    // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
    Option(jedis.get(s"classify:\${job.entity}")) match {
      case Some(cached) => tagsOf(cached)
      case None =>
        val day = s"budget:\${LocalDate.now(ZoneOffset.UTC)}"
        if (Option(jedis.get(day)).map(_.toInt).getOrElse(0) >= DailyEntityBudget) throw new BudgetExhausted(s"$day is spent")
        val tags = ClassifyColumns.classifyColumns(job.entity, job.columns) // step 2
        jedis.incr(day)
        jedis.set(s"classify:\${job.entity}", JsObject(tags.map { case (c, t) => c -> JsString(t) }).compactPrint)
        jedis.hset(s"verify:\${job.entity}", Map("owner" -> job.owner, "schema_hash" -> job.schemaHash, "state" -> "pending").asJava)
        tags
    }
  }
}
`,
      solution: `import java.time.{LocalDate, ZoneOffset}

import redis.clients.jedis.JedisPooled
import spray.json._

import metasense.Jobs

import scala.jdk.CollectionConverters._

/** Today's budget is spent: the job waits for tomorrow and the model is not called. */
final class BudgetExhausted(message: String) extends RuntimeException(message)

object ScanCache {
  val jedis = new JedisPooled("redis", 6379)
  val DailyEntityBudget = 400
  val ResultTtlS = 7L * 24 * 3600
  val VerifyTtlS = 7L * 24 * 3600
  val BudgetTtlS = 2L * 24 * 3600 // outlives its day, then goes

  // One round trip, one decision: two workers at 399 cannot both get the last slot.
  val ReserveLua: String =
    """local used = redis.call('INCR', KEYS[1])
      |if used == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
      |if used > tonumber(ARGV[1]) then
      |  redis.call('DECR', KEYS[1])
      |  return 0
      |end
      |return 1
      |""".stripMargin

  private def tagsOf(raw: String): Map[String, String] = raw.parseJson.asJsObject.fields.collect { case (c, JsString(t)) => c -> t }

  /** The entity's tags: from the cache, or from the model within today's budget. */
  def classifyEntity(job: Jobs.Job): Map[String, String] = {
    val cacheKey = s"classify:\${job.entity}:\${job.schemaHash}"
    Option(jedis.get(cacheKey)) match {
      case Some(cached) => tagsOf(cached)
      case None =>
        val day = s"budget:\${LocalDate.now(ZoneOffset.UTC)}"
        val reserved = jedis.eval(ReserveLua, List(day).asJava, List(DailyEntityBudget.toString, BudgetTtlS.toString).asJava)
        if (reserved.asInstanceOf[java.lang.Long] != 1L) throw new BudgetExhausted(s"$day is spent")
        val tags = ClassifyColumns.classifyColumns(job.entity, job.columns) // step 2
        jedis.setex(cacheKey, ResultTtlS, JsObject(tags.map { case (c, t) => c -> JsString(t) }).compactPrint)
        jedis.hset(s"verify:\${job.entity}", Map("owner" -> job.owner, "schema_hash" -> job.schemaHash, "state" -> "pending").asJava)
        jedis.expire(s"verify:\${job.entity}", VerifyTtlS)
        tags
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <ctime>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kDailyEntityBudget = 400;

// Today's budget is spent: the job waits for tomorrow and the model is not called.
struct BudgetExhausted : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Built in step 2 (classify_columns.cpp): one tag per column from the LLM gateway; throws ClassifyFailed.
std::map<std::string, std::string> classifyColumns(const std::string& entity, const std::vector<std::string>& columns);

// The entity's tags ({entity, owner, schema_hash, columns} job): from the cache, or from the model within today's budget.
std::map<std::string, std::string> classifyEntity(const nlohmann::json& job) {
  // TODO: this starter has 3 flaws. The task says where to look; the checks say what must change.
  const std::string entity = job.at("entity");
  if (const auto cached = redis.get("classify:" + entity)) return nlohmann::json::parse(*cached).get<std::map<std::string, std::string>>();
  const std::time_t now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  std::tm utc{};
  gmtime_r(&now, &utc);
  char date[16];
  std::strftime(date, sizeof date, "%Y-%m-%d", &utc);
  const std::string day = std::string("budget:") + date;
  const auto used = redis.get(day);
  if (used && std::stoll(*used) >= kDailyEntityBudget) throw BudgetExhausted(day + " is spent");
  const auto tags = classifyColumns(entity, job.at("columns").get<std::vector<std::string>>());
  redis.incr(day);
  redis.set("classify:" + entity, nlohmann::json(tags).dump());
  redis.hset("verify:" + entity, {std::make_pair(std::string("owner"), job.at("owner").get<std::string>()),
                                  std::make_pair(std::string("schema_hash"), job.at("schema_hash").get<std::string>()),
                                  std::make_pair(std::string("state"), std::string("pending"))});
  return tags;
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <ctime>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kDailyEntityBudget = 400;
constexpr long long kResultTtlS = 7 * 24 * 3600;
constexpr long long kVerifyTtlS = 7 * 24 * 3600;
constexpr long long kBudgetTtlS = 2 * 24 * 3600;  // outlives its day, then goes

// One round trip, one decision: two workers at 399 cannot both get the last slot.
const std::string kReserveLua = R"lua(
local used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if used > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
)lua";

// Today's budget is spent: the job waits for tomorrow and the model is not called.
struct BudgetExhausted : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Built in step 2 (classify_columns.cpp): one tag per column from the LLM gateway; throws ClassifyFailed.
std::map<std::string, std::string> classifyColumns(const std::string& entity, const std::vector<std::string>& columns);

// The entity's tags ({entity, owner, schema_hash, columns} job): from the cache, or from the model within today's budget.
std::map<std::string, std::string> classifyEntity(const nlohmann::json& job) {
  const std::string entity = job.at("entity");
  const std::string cacheKey = "classify:" + entity + ":" + job.at("schema_hash").get<std::string>();
  if (const auto cached = redis.get(cacheKey)) return nlohmann::json::parse(*cached).get<std::map<std::string, std::string>>();
  const std::time_t now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  std::tm utc{};
  gmtime_r(&now, &utc);
  char date[16];
  std::strftime(date, sizeof date, "%Y-%m-%d", &utc);
  const std::string day = std::string("budget:") + date;
  if (redis.eval<long long>(kReserveLua, {day}, {std::to_string(kDailyEntityBudget), std::to_string(kBudgetTtlS)}) != 1) {
    throw BudgetExhausted(day + " is spent");
  }
  const auto tags = classifyColumns(entity, job.at("columns").get<std::vector<std::string>>());
  redis.set(cacheKey, nlohmann::json(tags).dump(), std::chrono::seconds(kResultTtlS));
  redis.hset("verify:" + entity, {std::make_pair(std::string("owner"), job.at("owner").get<std::string>()),
                                  std::make_pair(std::string("schema_hash"), job.at("schema_hash").get<std::string>()),
                                  std::make_pair(std::string("state"), std::string("pending"))});
  redis.expire("verify:" + entity, std::chrono::seconds(kVerifyTtlS));
  return tags;
}
`,
    },
  },
  harness: {
    python: `import json
import time

import data_classification_pb2 as pb
import data_classification_pb2_grpc as pb_grpc
from metasense import jobs

GATEWAY = "llm-gateway:9000"
OLD = ["merchant_id", "status"]
NEW = ["merchant_id", "status", "passport_no"]


class Gateway(pb_grpc.ClassifierServicer):
    """The LLM gateway stand-in: passport columns are Personal.ID, the rest None."""

    def Classify(self, request, context):
        rows = [{"column_name": c, "assigned_tag": "Personal.ID" if "passport" in c else "None"} for c in request.columns]
        return pb.ClassifyReply(content=json.dumps(rows), model="stand-in")


def _module(ctx):
    ctx.grpc.serve(pb_grpc.add_ClassifierServicer_to_server, Gateway(), GATEWAY)
    return ctx.load("scan_cache")


def _job(entity, columns):
    return {"entity": entity, "owner": "team-logistics", "schema_hash": jobs.schema_hash(columns), "columns": columns}


def _calls(ctx):
    return len(ctx.grpc.calls_to("Classify"))


def _day():
    return "budget:" + time.strftime("%Y-%m-%d", time.gmtime())


def _classify(m, job):
    try:
        return m.classify_entity(job)
    except Exception as exc:
        raise AssertionError(f"classify_entity({job['entity']}) raised {type(exc).__name__}: {exc}") from exc


def check_cache_key(ctx):
    m = _module(ctx)
    _classify(m, _job("deliveries", OLD))
    tags = _classify(m, _job("deliveries", NEW))
    assert tags.get("passport_no") == "Personal.ID", f"after passport_no was added classify_entity answered {tags}: the cached tags of the old schema were served. Key the cache by schema_hash"
    assert _calls(ctx) == 2, f"a changed schema must be classified again: {_calls(ctx)} Classify calls for two schemas"
    key = f"classify:deliveries:{jobs.schema_hash(NEW)}"
    assert ctx.redis.exists(key), f"the new tags are not cached under {key} (keys: {sorted(ctx.redis.keys('classify:*'))})"
    again = _classify(m, _job("deliveries", OLD))
    assert again == {"merchant_id": "None", "status": "None"} and _calls(ctx) == 2, f"a job for the old schema must be a cache hit: {_calls(ctx)} calls, tags {again}"
    assert ctx.redis.get(_day()) == "2", f"{_day()} is {ctx.redis.get(_day())!r} after two model calls and a cache hit, expected 2: a hit spends no budget"


def check_budget_atomic(ctx):
    m = _module(ctx)
    day = _day()
    ctx.redis.set(day, 400)
    try:
        m.classify_entity(_job("orders", OLD))
        raise AssertionError("with 400 entities classified today classify_entity returned tags, expected BudgetExhausted")
    except m.BudgetExhausted:
        pass
    assert _calls(ctx) == 0, f"with today's budget spent the model was called {_calls(ctx)} time(s)"
    assert ctx.redis.get(day) == "400", f"a refused reservation left {day} at {ctx.redis.get(day)!r}, expected 400: over the cap the slot is given back"
    ctx.redis.set(day, 399)
    _classify(m, _job("payments", OLD))  # the 400th entity of the day still fits
    assert _calls(ctx) == 1 and ctx.redis.get(day) == "400", f"at 399 the 400th entity must get the last slot: {_calls(ctx)} call(s), {day} = {ctx.redis.get(day)!r}"
    ctx.redis.set(day, 399)
    other = []

    def another_worker():
        """A second worker reserving the same slot the way the task says: INCR, and DECR back over the cap."""
        if ctx.redis.incr(day) > 400:
            ctx.redis.decr(day)
            other.append(False)
        else:
            other.append(True)

    probe = ctx.redis_after(day, another_worker)
    try:
        m.classify_entity(_job("deliveries", OLD))
        mine = True
    except m.BudgetExhausted:
        mine = False
    used = int(ctx.redis.get(day))
    assert probe.fired and other, f"classify_entity never touched {day}"
    assert used <= 400, f"two workers raced for the last slot and {day} reads {used}: the read, the call and the INCR are separate steps, so both passed. Reserve with one script before the call"
    assert mine != other[0], f"exactly one of the two workers gets the last slot (yours: {mine}, the other: {other[0]})"
    assert _calls(ctx) == (2 if mine else 1), f"the model was called {_calls(ctx) - 1} time(s) though your worker {'got' if mine else 'did not get'} a slot"


def _ttl_when_written(ctx, key, seen):
    """The TTL of key right after the first command that leaves it existing (a lookup of the missing key
    before that re-arms the probe)."""

    def watch():
        if ctx.redis.exists(key):
            seen[key] = ctx.redis.ttl(key)
        else:
            ctx.redis_after(key, watch)

    ctx.redis_after(key, watch)


def check_expiry(ctx):
    m = _module(ctx)
    into_day = ctx.clock.time() % 86400
    if into_day > 86400 - 7200:  # the hour this check waits stays inside one UTC day
        ctx.clock.advance(86400 - into_day + 60)
    at_write = {}
    cache_key = f"classify:deliveries:{jobs.schema_hash(NEW)}"
    _ttl_when_written(ctx, cache_key, at_write)
    _ttl_when_written(ctx, _day(), at_write)
    _classify(m, _job("deliveries", NEW))
    written = ctx.redis.keys("classify:*")
    assert written, "classify_entity cached nothing under classify:*"
    key = written[0]
    ttl = ctx.redis.ttl(key)
    assert 604000 <= ttl <= 604800, f"{key} has TTL {ttl}, expected RESULT_TTL_S = 604800 (7 days)"
    pending = ctx.redis.hgetall("verify:deliveries")
    assert pending == {"owner": "team-logistics", "schema_hash": jobs.schema_hash(NEW), "state": "pending"}, f"verify:deliveries holds {pending}"
    ttl = ctx.redis.ttl("verify:deliveries")
    assert 604000 <= ttl <= 604800, f"verify:deliveries has TTL {ttl}, expected VERIFY_TTL_S = 604800 (7 days)"
    ttl = ctx.redis.ttl(_day())
    assert 172000 <= ttl <= 172800, f"{_day()} has TTL {ttl}, expected BUDGET_TTL_S = 172800 (2 days) set on its first write"
    for k in (cache_key, _day()):
        assert at_write.get(k, -1) > 0, f"{k} existed without a TTL right after the command that wrote it (TTL {at_write.get(k)}): a crash before the separate EXPIRE leaves it forever. Write it with its expiry in one command"
    day = _day()
    ctx.clock.advance(3600)
    _classify(m, _job("orders", OLD))
    assert ctx.redis.get(day) == "2", f"{day} is {ctx.redis.get(day)!r} after two entities, expected 2"
    ttl = ctx.redis.ttl(day)
    assert ttl <= 172800 - 3500, f"an hour later the second reservation reset {day}'s TTL to {ttl}: the counter expires 2 days after its first write, not its last"
`,
    typescript: `const GATEWAY = 'llm-gateway:9000';
const OLD = ['merchant_id', 'status'];
const NEW = ['merchant_id', 'status', 'passport_no'];

/** The LLM gateway stand-in (passport columns are Personal.ID, the rest None) and the learner's module. */
function world(ctx) {
  const {metasensed} = ctx.proto('data_classification.proto');
  ctx.grpc.serve(metasensed.Classifier.service, {
    Classify(call, callback) {
      const rows = call.request.columns.map((c: string) => ({column_name: c, assigned_tag: c.includes('passport') ? 'Personal.ID' : 'None'}));
      callback(null, {content: JSON.stringify(rows), model: 'stand-in'});
    },
  }, GATEWAY);
  const {schemaHash} = ctx.load('/support/metasense/jobs.ts');
  return {m: ctx.load('scan_cache'), schemaHash};
}

const calls = ctx => ctx.grpc.callsTo('Classify').length;
const today = ctx => \`budget:\${new Date(ctx.clock.now()).toISOString().slice(0, 10)}\`;
const job = (schemaHash, entity: string, columns: string[]) => ({entity, owner: 'team-logistics', schema_hash: schemaHash(columns), columns});

async function classify(m, j) {
  try {
    return await m.classifyEntity(j);
  } catch (e) {
    assert.fail(\`classifyEntity(\${j.entity}) threw \${e instanceof Error ? \`\${e.constructor.name}: \${e.message}\` : String(e)}\`);
  }
}

export async function check_cache_key(ctx) {
  const {m, schemaHash} = world(ctx);
  await classify(m, job(schemaHash, 'deliveries', OLD));
  const tags = await classify(m, job(schemaHash, 'deliveries', NEW));
  assert.equal(tags.passport_no, 'Personal.ID', \`after passport_no was added classifyEntity answered \${JSON.stringify(tags)}: the cached tags of the old schema were served. Key the cache by schema_hash\`);
  assert.equal(calls(ctx), 2, \`a changed schema must be classified again: \${calls(ctx)} Classify calls for two schemas\`);
  const key = \`classify:deliveries:\${schemaHash(NEW)}\`;
  assert.equal(ctx.redis.exists(key), 1, \`the new tags are not cached under \${key} (keys: \${JSON.stringify(ctx.redis.keys('classify:*'))})\`);
  const again = await classify(m, job(schemaHash, 'deliveries', OLD));
  assert(calls(ctx) === 2 && again.merchant_id === 'None' && again.passport_no === undefined, \`a job for the old schema must be a cache hit: \${calls(ctx)} calls, tags \${JSON.stringify(again)}\`);
  assert.equal(ctx.redis.get(today(ctx)), '2', \`\${today(ctx)} is \${ctx.redis.get(today(ctx))} after two model calls and a cache hit, expected 2: a hit spends no budget\`);
}

export async function check_budget_atomic(ctx) {
  const {m, schemaHash} = world(ctx);
  const day = today(ctx);
  ctx.redis.set(day, '400');
  let threw = false;
  try {
    await m.classifyEntity(job(schemaHash, 'orders', OLD));
  } catch (e) {
    threw = e instanceof m.BudgetExhausted;
  }
  assert(threw, 'with 400 entities classified today classifyEntity must throw BudgetExhausted');
  assert.equal(calls(ctx), 0, \`with today's budget spent the model was called \${calls(ctx)} time(s)\`);
  assert.equal(ctx.redis.get(day), '400', \`a refused reservation left \${day} at \${ctx.redis.get(day)}, expected 400: over the cap the slot is given back\`);
  ctx.redis.set(day, '399');
  await classify(m, job(schemaHash, 'payments', OLD)); // the 400th entity of the day still fits
  assert(calls(ctx) === 1 && ctx.redis.get(day) === '400', \`at 399 the 400th entity must get the last slot: \${calls(ctx)} call(s), \${day} = \${ctx.redis.get(day)}\`);
  ctx.redis.set(day, '399');
  const other: boolean[] = [];
  // A second worker reserving the same slot the way the task says: INCR, and DECR back over the cap.
  const probe = ctx.redisAfter(day, () => {
    if (Number(ctx.redis.incr(day)) > 400) {
      ctx.redis.decr(day);
      other.push(false);
    } else other.push(true);
  });
  let mine = true;
  try {
    await m.classifyEntity(job(schemaHash, 'deliveries', OLD));
  } catch (e) {
    if (!(e instanceof m.BudgetExhausted)) throw e;
    mine = false;
  }
  const used = Number(ctx.redis.get(day));
  assert(probe.fired && other.length === 1, \`classifyEntity never touched \${day}\`);
  assert(used <= 400, \`two workers raced for the last slot and \${day} reads \${used}: the read, the call and the INCR are separate steps, so both passed. Reserve with one script before the call\`);
  assert.notEqual(mine, other[0], \`exactly one of the two workers gets the last slot (yours: \${mine}, the other: \${other[0]})\`);
  assert.equal(calls(ctx), mine ? 2 : 1, \`the model was called \${calls(ctx) - 1} time(s) though your worker \${mine ? 'got' : 'did not get'} a slot\`);
}

/**
 * The TTL of key right after the first command that leaves it existing (a lookup of the missing key
 * before that re-arms the probe).
 */
function ttlWhenWritten(ctx, key: string, seen: Record<string, number>) {
  const watch = () => {
    if (Number(ctx.redis.exists(key)) === 1) seen[key] = Number(ctx.redis.ttl(key));
    else ctx.redisAfter(key, watch);
  };
  ctx.redisAfter(key, watch);
}

export async function check_expiry(ctx) {
  const {m, schemaHash} = world(ctx);
  const intoDay = (ctx.clock.now() / 1000) % 86400;
  if (intoDay > 86400 - 7200) ctx.clock.advance(86400 - intoDay + 60); // the hour this check waits stays inside one UTC day
  const atWrite: Record<string, number> = {};
  const cacheKey = \`classify:deliveries:\${schemaHash(NEW)}\`;
  const day = today(ctx);
  ttlWhenWritten(ctx, cacheKey, atWrite);
  ttlWhenWritten(ctx, day, atWrite);
  await classify(m, job(schemaHash, 'deliveries', NEW));
  const written: string[] = ctx.redis.keys('classify:*');
  assert(written.length > 0, 'classifyEntity cached nothing under classify:*');
  const key = written[0];
  let ttl = ctx.redis.ttl(key);
  assert(604000 <= ttl && ttl <= 604800, \`\${key} has TTL \${ttl}, expected RESULT_TTL_S = 604800 (7 days)\`);
  const pending = ctx.redis.hgetall('verify:deliveries');
  assert.deepEqual({...pending}, {owner: 'team-logistics', schema_hash: schemaHash(NEW), state: 'pending'}, \`verify:deliveries holds \${JSON.stringify(pending)}\`);
  ttl = ctx.redis.ttl('verify:deliveries');
  assert(604000 <= ttl && ttl <= 604800, \`verify:deliveries has TTL \${ttl}, expected VERIFY_TTL_S = 604800 (7 days)\`);
  ttl = ctx.redis.ttl(day);
  assert(172000 <= ttl && ttl <= 172800, \`\${day} has TTL \${ttl}, expected BUDGET_TTL_S = 172800 (2 days) set on its first write\`);
  for (const k of [cacheKey, day]) {
    assert((atWrite[k] ?? -1) > 0, \`\${k} existed without a TTL right after the command that wrote it (TTL \${atWrite[k]}): a crash before the separate EXPIRE leaves it forever. Write it with its expiry in one command\`);
  }
  ctx.clock.advance(3600);
  await classify(m, job(schemaHash, 'orders', OLD));
  assert.equal(ctx.redis.get(day), '2', \`\${day} is \${ctx.redis.get(day)} after two entities, expected 2\`);
  ttl = ctx.redis.ttl(day);
  assert(ttl <= 172800 - 3500, \`an hour later the second reservation reset \${day}'s TTL to \${ttl}: the counter expires 2 days after its first write, not its last\`);
}
`,
    go: `package main

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"metasense/jobs"

	"leetbuild/harness"
)

var (
	cacheOld   = []string{"merchant_id", "status"}
	cacheNew   = []string{"merchant_id", "status", "passport_no"}
	cacheModelCalls int
)

// cacheWorld stands step 2 in: passport columns are Personal.ID, the rest None; it counts the model calls.
func cacheWorld() {
	cacheModelCalls = 0
	classifyColumns = func(_ context.Context, _ string, columns []string) (map[string]string, error) {
		cacheModelCalls++
		tags := map[string]string{}
		for _, c := range columns {
			tags[c] = "None"
			if strings.Contains(c, "passport") {
				tags[c] = "Personal.ID"
			}
		}
		return tags, nil
	}
}

func cacheJob(entity string, columns []string) jobs.Job {
	return jobs.Job{Entity: entity, Owner: "team-logistics", SchemaHash: jobs.SchemaHash(columns), Columns: columns}
}

func cacheDay(ctx *harness.Ctx) string { return "budget:" + ctx.Clock.Time().UTC().Format("2006-01-02") }

func cacheClassify(ctx *harness.Ctx, job jobs.Job) map[string]string {
	tags, err := classifyEntity(context.Background(), job)
	ctx.NoError(err, "classifyEntity(%s)", job.Entity)
	return tags
}

func CheckCacheKey(ctx *harness.Ctx) {
	cacheWorld()
	cacheClassify(ctx, cacheJob("deliveries", cacheOld))
	tags := cacheClassify(ctx, cacheJob("deliveries", cacheNew))
	ctx.Equal(tags["passport_no"], "Personal.ID", "after passport_no was added classifyEntity served the cached tags of the old schema (%v); key the cache by schema_hash. passport_no", tags)
	ctx.Equal(cacheModelCalls, 2, "a changed schema must be classified again; model calls for two schemas")
	key := "classify:deliveries:" + jobs.SchemaHash(cacheNew)
	ctx.Equal(ctx.Redis.Exists(key), 1, "the new tags must be cached under %s (keys: %v)", key, ctx.Redis.Keys("classify:*"))
	again := cacheClassify(ctx, cacheJob("deliveries", cacheOld))
	ctx.Assert(cacheModelCalls == 2 && len(again) == 2, "a job for the old schema must be a cache hit: %d model calls, tags %v", cacheModelCalls, again)
	used, _ := ctx.Redis.Get(cacheDay(ctx))
	ctx.Equal(used, "2", "%s after two model calls and a cache hit (a hit spends no budget)", cacheDay(ctx))
}

func CheckBudgetAtomic(ctx *harness.Ctx) {
	cacheWorld()
	day := cacheDay(ctx)
	ctx.Redis.Set(day, 400)
	_, err := classifyEntity(context.Background(), cacheJob("orders", cacheOld))
	ctx.Assert(errors.Is(err, ErrBudgetExhausted), "with 400 entities classified today classifyEntity must return ErrBudgetExhausted, got %v", err)
	ctx.Equal(cacheModelCalls, 0, "with today's budget spent the model must not be called; calls")
	left, _ := ctx.Redis.Get(day)
	ctx.Equal(left, "400", "a refused reservation must give the slot back over the cap; %s", day)
	ctx.Redis.Set(day, 399)
	cacheClassify(ctx, cacheJob("payments", cacheOld)) // the 400th entity of the day still fits
	last, _ := ctx.Redis.Get(day)
	ctx.Assert(cacheModelCalls == 1 && last == "400", "at 399 the 400th entity must get the last slot: %d call(s), %s = %s", cacheModelCalls, day, last)
	ctx.Redis.Set(day, 399)
	var other []bool
	// A second worker reserving the same slot the way the task says: INCR, and DECR back over the cap.
	probe := ctx.Redis.After(day, func() any {
		if ctx.Redis.Do("INCR", day).(int64) > 400 {
			ctx.Redis.Do("DECR", day)
			other = append(other, false)
		} else {
			other = append(other, true)
		}
		return nil
	})
	_, err = classifyEntity(context.Background(), cacheJob("deliveries", cacheOld))
	ctx.Assert(err == nil || errors.Is(err, ErrBudgetExhausted), "classifyEntity returned %v", err)
	mine := err == nil
	raw, _ := ctx.Redis.Get(day)
	used, _ := strconv.Atoi(raw)
	ctx.Assert(probe.Fired && len(other) == 1, "classifyEntity never touched %s", day)
	ctx.Assert(used <= 400, "two workers raced for the last slot and %s reads %d: the read, the call and the INCR are separate steps, so both passed. Reserve with one script before the call", day, used)
	ctx.Assert(mine != other[0], "exactly one of the two workers gets the last slot (yours: %v, the other: %v)", mine, other[0])
	want := 1
	if mine {
		want = 2
	}
	ctx.Equal(cacheModelCalls, want, "the model calls must match the slot your worker got")
}

// cacheTTLWhenWritten records the TTL of key right after the first command that leaves it existing (a
// lookup of the missing key before that re-arms the probe).
func cacheTTLWhenWritten(ctx *harness.Ctx, key string, seen map[string]int64) {
	var watch func() any
	watch = func() any {
		if ctx.Redis.Exists(key) == 1 {
			seen[key] = ctx.Redis.TTL(key)
		} else {
			ctx.Redis.After(key, watch)
		}
		return nil
	}
	ctx.Redis.After(key, watch)
}

func CheckExpiry(ctx *harness.Ctx) {
	cacheWorld()
	if intoDay := ctx.Clock.Now() / 1000 % 86400; intoDay > 86400-7200 {
		ctx.Clock.Advance(float64(86400 - intoDay + 60)) // the hour this check waits stays inside one UTC day
	}
	atWrite := map[string]int64{}
	cacheKey := "classify:deliveries:" + jobs.SchemaHash(cacheNew)
	day := cacheDay(ctx)
	cacheTTLWhenWritten(ctx, cacheKey, atWrite)
	cacheTTLWhenWritten(ctx, day, atWrite)
	cacheClassify(ctx, cacheJob("deliveries", cacheNew))
	written := ctx.Redis.Keys("classify:*")
	ctx.Assert(len(written) > 0, "classifyEntity cached nothing under classify:*")
	key := written[0]
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(604000 <= ttl && ttl <= 604800, "%s has TTL %d, expected 604800 (7 days)", key, ttl)
	ctx.Equal(ctx.Redis.HGetAll("verify:deliveries"), map[string]string{"owner": "team-logistics", "schema_hash": jobs.SchemaHash(cacheNew), "state": "pending"}, "verify:deliveries")
	ttl = ctx.Redis.TTL("verify:deliveries")
	ctx.Assert(604000 <= ttl && ttl <= 604800, "verify:deliveries has TTL %d, expected 604800 (7 days)", ttl)
	ttl = ctx.Redis.TTL(day)
	ctx.Assert(172000 <= ttl && ttl <= 172800, "%s has TTL %d, expected 172800 (2 days) set on its first write", day, ttl)
	for _, k := range []string{cacheKey, day} {
		got, ok := atWrite[k]
		ctx.Assert(ok && got > 0, "%s existed without a TTL right after the command that wrote it (TTL %d): a crash before the separate EXPIRE leaves it forever. Write it with its expiry in one command", k, got)
	}
	ctx.Clock.Advance(3600)
	cacheClassify(ctx, cacheJob("orders", cacheOld))
	used, _ := ctx.Redis.Get(day)
	ctx.Equal(used, "2", "%s after two entities", day)
	ttl = ctx.Redis.TTL(day)
	ctx.Assert(ttl <= 172800-3500, "an hour later the second reservation reset %s's TTL to %d: the counter expires 2 days after its first write, not its last", day, ttl)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <ctime>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "classify_columns.cpp"
#include "metasense/jobs.h"

namespace {

const std::vector<std::string> hOld = {"merchant_id", "status"};
const std::vector<std::string> hNew = {"merchant_id", "status", "passport_no"};

// The LLM gateway stand-in: passport columns are Personal.ID, the rest None.
class HCacheGateway final : public metasensed::Classifier::Service {
 public:
  grpc::Status Classify(grpc::ServerContext*, const metasensed::ClassifyRequest* req, metasensed::ClassifyReply* reply) override {
    nlohmann::json rows = nlohmann::json::array();
    for (const auto& c : req->columns()) rows.push_back({{"column_name", c}, {"assigned_tag", c.find("passport") != std::string::npos ? "Personal.ID" : "None"}});
    reply->set_content(rows.dump());
    reply->set_model("stand-in");
    return grpc::Status::OK;
  }
};

void hCacheWorld(harness::Ctx& ctx) {
  static HCacheGateway peer;
  ctx.GRPC.Server("llm-gateway:9000")->RegisterService(&peer);
}

nlohmann::json hJob(const std::string& entity, const std::vector<std::string>& columns) {
  return {{"entity", entity}, {"owner", "team-logistics"}, {"schema_hash", jobs::schemaHash(columns)}, {"columns", columns}};
}

size_t hCalls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("Classify").size(); }

std::string hToday(harness::Ctx& ctx) {
  const std::time_t now = ctx.Clock.Now() / 1000;
  std::tm utc{};
  gmtime_r(&now, &utc);
  char date[16];
  std::strftime(date, sizeof date, "%Y-%m-%d", &utc);
  return std::string("budget:") + date;
}

std::map<std::string, std::string> hClassifyOK(harness::Ctx& ctx, const nlohmann::json& j) {
  try {
    return classifyEntity(j);
  } catch (const std::exception& e) {
    ctx.Fatalf("classifyEntity(%s) threw %s: %s", j["entity"].get<std::string>(), harness::CurrentExceptionType(), e.what());
  }
}

}  // namespace

void CheckCacheKey(harness::Ctx& ctx) {
  hCacheWorld(ctx);
  hClassifyOK(ctx, hJob("deliveries", hOld));
  const auto tags = hClassifyOK(ctx, hJob("deliveries", hNew));
  ctx.Equal(tags.count("passport_no") ? tags.at("passport_no") : "<missing>", "Personal.ID",
            "after passport_no was added classifyEntity served the cached tags of the old schema; key the cache by schema_hash. passport_no");
  ctx.Equal(hCalls(ctx), 2, "a changed schema must be classified again; Classify calls for two schemas");
  const std::string key = "classify:deliveries:" + jobs::schemaHash(hNew);
  ctx.Equal(ctx.Redis.Exists(key), 1, "the new tags must be cached under %s (keys: %v)", key, ctx.Redis.Keys("classify:*"));
  const auto again = hClassifyOK(ctx, hJob("deliveries", hOld));
  ctx.Assert(hCalls(ctx) == 2 && again.size() == 2, "a job for the old schema must be a cache hit: %d calls, %d tags", hCalls(ctx), again.size());
  ctx.Equal(ctx.Redis.Get(hToday(ctx)).value_or(""), "2", "%s after two model calls and a cache hit (a hit spends no budget)", hToday(ctx));
}

void CheckBudgetAtomic(harness::Ctx& ctx) {
  hCacheWorld(ctx);
  const std::string day = hToday(ctx);
  ctx.Redis.Set(day, "400");
  bool threw = false;
  try {
    classifyEntity(hJob("orders", hOld));
  } catch (const BudgetExhausted&) {
    threw = true;
  }
  ctx.Assert(threw, "with 400 entities classified today classifyEntity must throw BudgetExhausted");
  ctx.Equal(hCalls(ctx), 0, "with today's budget spent the model must not be called; calls");
  ctx.Equal(ctx.Redis.Get(day).value_or(""), "400", "a refused reservation must give the slot back over the cap; %s", day);
  ctx.Redis.Set(day, "399");
  hClassifyOK(ctx, hJob("payments", hOld));  // the 400th entity of the day still fits
  ctx.Assert(hCalls(ctx) == 1 && ctx.Redis.Get(day).value_or("") == "400", "at 399 the 400th entity must get the last slot: %d call(s), %s = %s", hCalls(ctx), day,
             ctx.Redis.Get(day).value_or("<missing>"));
  ctx.Redis.Set(day, "399");
  std::vector<bool> other;
  // A second worker reserving the same slot the way the task says: INCR, and DECR back over the cap.
  ctx.Redis.After(day, [&] {
    if (ctx.Redis.Do("INCR", day).Int() > 400) {
      ctx.Redis.Do("DECR", day);
      other.push_back(false);
    } else {
      other.push_back(true);
    }
  });
  bool mine = true;
  try {
    classifyEntity(hJob("deliveries", hOld));
  } catch (const BudgetExhausted&) {
    mine = false;
  }
  const long long used = std::stoll(ctx.Redis.Get(day).value_or("0"));
  ctx.Assert(other.size() == 1, "classifyEntity never touched %s", day);
  ctx.Assert(used <= 400, "two workers raced for the last slot and %s reads %d: the read, the call and the INCR are separate steps, so both passed. Reserve with one script before the call", day, used);
  ctx.Assert(mine != other[0], "exactly one of the two workers gets the last slot (yours: %v, the other: %v)", mine, static_cast<bool>(other[0]));
  ctx.Equal(hCalls(ctx), mine ? 2 : 1, "the model calls must match the slot your worker got");
}

// Records the TTL of key right after the first command that leaves it existing (a lookup of the
// missing key before that re-arms the probe).
void hTTLWhenWritten(harness::Ctx& ctx, const std::string& key, std::map<std::string, long long>& seen) {
  auto watch = std::make_shared<std::function<void()>>();
  *watch = [&ctx, &seen, key, watch] {
    if (ctx.Redis.Exists(key) == 1) {
      seen[key] = ctx.Redis.TTL(key);
    } else {
      ctx.Redis.After(key, *watch);
    }
  };
  ctx.Redis.After(key, *watch);
}

void CheckExpiry(harness::Ctx& ctx) {
  hCacheWorld(ctx);
  const int64_t intoDay = ctx.Clock.Now() / 1000 % 86400;
  if (intoDay > 86400 - 7200) ctx.Clock.Advance(static_cast<double>(86400 - intoDay + 60));  // the hour this check waits stays inside one UTC day
  std::map<std::string, long long> atWrite;
  const std::string cacheKey = "classify:deliveries:" + jobs::schemaHash(hNew);
  const std::string day = hToday(ctx);
  hTTLWhenWritten(ctx, cacheKey, atWrite);
  hTTLWhenWritten(ctx, day, atWrite);
  hClassifyOK(ctx, hJob("deliveries", hNew));
  const auto written = ctx.Redis.Keys("classify:*");
  ctx.Assert(!written.empty(), "classifyEntity cached nothing under classify:*");
  const std::string key = written[0];
  long long ttl = ctx.Redis.TTL(key);
  ctx.Assert(604000 <= ttl && ttl <= 604800, "%s has TTL %d, expected 604800 (7 days)", key, ttl);
  ctx.Equal(ctx.Redis.HGetAll("verify:deliveries"),
            std::map<std::string, std::string>{{"owner", "team-logistics"}, {"schema_hash", jobs::schemaHash(hNew)}, {"state", "pending"}}, "verify:deliveries");
  ttl = ctx.Redis.TTL("verify:deliveries");
  ctx.Assert(604000 <= ttl && ttl <= 604800, "verify:deliveries has TTL %d, expected 604800 (7 days)", ttl);
  ttl = ctx.Redis.TTL(day);
  ctx.Assert(172000 <= ttl && ttl <= 172800, "%s has TTL %d, expected 172800 (2 days) set on its first write", day, ttl);
  for (const std::string& k : {cacheKey, day}) {
    const long long got = atWrite.count(k) ? atWrite.at(k) : -2;
    ctx.Assert(got > 0, "%s existed without a TTL right after the command that wrote it (TTL %d): a crash before the separate EXPIRE leaves it forever. Write it with its expiry in one command", k, got);
  }
  ctx.Clock.Advance(3600);
  hClassifyOK(ctx, hJob("orders", hOld));
  ctx.Equal(ctx.Redis.Get(day).value_or(""), "2", "%s after two entities", day);
  ttl = ctx.Redis.TTL(day);
  ctx.Assert(ttl <= 172800 - 3500, "an hour later the second reservation reset %s's TTL to %d: the counter expires 2 days after its first write, not its last", day, ttl);
}
`,
  },
  hints: [
    'A table gained a `passport_no` column last week and the catalogue still shows the tags from before; on a busy day the invoice lists 403 entities against a cap of 400; and Redis keeps growing.',
    'The cache key is the entity name, so a new schema hits the old entry. The counter is read, the model is called, and only then is the counter increased: every worker that read 399 in that window gets through. Nothing sets a TTL.',
    'Key `classify:{entity}:{schema_hash}`; one `register_script` with `INCR`, `EXPIRE` when it returns 1, and `DECR` plus `return 0` over the cap, run before `classify_columns`; `ex=RESULT_TTL_S` on the `SET` and `expire(verify:…, VERIFY_TTL_S)`.',
  ],
  debrief: `The cache key states what the cached value depends on: the tags are a function of the schema, so the schema hash belongs in the key, and an old schema stays a hit while it lives. The budget only holds if the decision and the count are one step, so the script increments first and gives the slot back over the cap; reserving before the call is what turns the cap into a limit rather than a report. A slot spent on a call that then fails is not refunded here, which errs toward the provider's bill. Grab's gateway also meters tokens per minute against the provider quota, which a per-entity count cannot express, and a production cache would bound memory with an eviction policy as well as TTLs.`,
};
