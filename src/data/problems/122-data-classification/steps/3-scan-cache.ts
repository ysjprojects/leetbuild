import type {Step} from '@/lib/types';

export const scanCacheStep: Step = {
  id: 'scan-cache',
  title: 'Redis: results by schema hash, a daily budget, verification that expires',
  concept: 'redis',
  file: 'scan_cache',
  focus: ['metasense', 'redis', 'llm'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: a second scan of the same
entity comes back from the cache, the day's counter goes up, and the owner's pending verification is
recorded, so the demo passes. It hides four production flaws. Review it like the person who gets
the model invoice and the "why is this table still Tier 1" ticket, fix it, and prove the fix.

Implement \`classify_entity(entity, owner, columns)\`, the worker's path around the gateway call
from the previous step:

- Results are cached under \`classify:{entity}:{schema_hash}\` (\`schema_hash\` is the hex SHA-256
  of the columns joined by \`\\n\`) for **7 days** (\`RESULT_TTL_S = 604800\`). Keyed by entity name
  alone, a table that gained a \`passport_no\` column keeps serving yesterday's tags.
- The day's classification budget is **400 entities** (\`DAILY_ENTITY_BUDGET\`, the top of the
  source's 300–400 per day) under \`budget:{day}\` (UTC \`YYYY-MM-DD\`), reserved by **one atomic
  Lua script**: \`INCR\`, \`EXPIRE\` on first write (\`BUDGET_TTL_S = 172800\`), and a \`DECR\` plus
  \`0\` when the increment crossed the cap. A read followed by a separate increment lets two workers
  both see 399 and both call the model.
- **Reserve before the gateway call.** A cache hit never spends budget; a rejected reservation
  raises \`BudgetExhausted\` so the job is requeued for tomorrow and the model is never called.
- After a fresh classification, record the pending verification under \`verify:{entity}\` as a hash
  (\`owner\`, \`schema_hash\`, \`state=pending\`) with a **7-day** expiry (\`VERIFY_TTL_S = 604800\`)
  — the source notifies owners weekly, and a reminder key that never expires is a reminder for a
  table that may no longer exist.

**Failure mode the checks target.** A cache keyed by name serves stale tags after a schema change —
the one case governance cares about; the counter that is read and then incremented overspends under
exactly the concurrency a backlog creates; counting after the call means the cap is a report, not a
limit; and the verification key without a TTL grows the keyspace by one entry per entity forever.`,
  sequence: {
    participants: ['metasense', 'Redis', 'LLM gateway'],
    messages: [
      {from: 'metasense', to: 'Redis', label: 'GET classify:{entity}:{schema_hash}', kind: 'sync'},
      {from: 'Redis', to: 'metasense', label: 'nil', kind: 'reply'},
      {
        from: 'metasense',
        to: 'Redis',
        label: 'EVAL reserve · KEYS[budget:2024-11-14] · ARGV[400, 172800]',
        kind: 'sync',
      },
      {from: 'Redis', to: 'metasense', label: '1 (or 0 → BudgetExhausted, no call)', kind: 'reply'},
      {from: 'metasense', to: 'LLM gateway', label: 'Classify … only after the reservation', kind: 'sync'},
      {from: 'LLM gateway', to: 'metasense', label: 'tags', kind: 'reply'},
      {
        from: 'metasense',
        to: 'Redis',
        label: 'SET classify:… EX 604800 · HSET verify:{entity} · EXPIRE 604800',
        kind: 'async',
      },
    ],
  },
  hints: [
    'The cache key has two parts because the thing being cached is a classification of a *schema*, not of a name: `classify:{entity}:{schema_hash}`. Compute the hash the same way the intake did, and give the entry an `ex=` when you set it.',
    'The budget script does everything on the server: `INCR`, then `EXPIRE` when the result is 1 (first write of the day), then compare with the cap — and `DECR` before returning 0 so a rejected reservation does not consume a slot. Call it with `EVAL` before the gateway stub is touched; on 0, raise `BudgetExhausted` and return without calling.',
    'The verification record is a hash plus an expiry: `HSET verify:{entity} owner … schema_hash … state pending` and `EXPIRE verify:{entity} VERIFY_TTL_S` (or a pipeline that does both). Seven days is the source’s weekly reminder cadence.',
  ],
  checks: [
    {
      id: 'cache-key',
      title: 'Caches results under classify:{entity}:{schema_hash} with a 7-day TTL',
      detail:
        'The result key carries the schema hash and is set with `RESULT_TTL_S = 604800`. The draft keys by entity name alone and never expires the entry, so a schema change keeps serving old tags.',
      match: {
        python: {all: [/classify:\{entity\}:\{schema_hash\}/, /RESULT_TTL_S\s*=\s*604800/, /ex=RESULT_TTL_S/]},
        typescript: {
          all: [/classify:\$\{entity\}:\$\{schemaHash\}/, /RESULT_TTL_S\s*=\s*604800/, /['"]EX['"],\s*RESULT_TTL_S/],
        },
        go: {all: [/"classify:%s:%s"/, /resultTTLS\s*=\s*604800/, /resultTTLS\s*\*\s*time\.Second/]},
        scala: {all: [/classify:\$entity:\$schemaHash/, /ResultTtlS\s*=\s*604800/, /setex\(/]},
        cpp: {
          all: [
            /"classify:"\s*\+\s*entity\s*\+\s*":"\s*\+\s*schemaHash/,
            /kResultTtlS\s*=\s*604800/,
            /std::chrono::seconds\(kResultTtlS\)/,
          ],
        },
      },
    },
    {
      id: 'budget-atomic',
      title: 'Reserves the daily budget with one atomic Lua script',
      detail:
        'One `EVAL` increments the day counter, sets its expiry on first write, and decrements back when the cap is crossed. A client-side `GET` followed by `INCR` lets two workers both pass at 399.',
      match: {
        python: {all: [/RESERVE_LUA/, /\.eval\(/, /INCR/, /EXPIRE/, /DECR/]},
        typescript: {all: [/RESERVE_LUA/, /\.eval\(/, /INCR/, /EXPIRE/, /DECR/]},
        go: {all: [/reserveScript\s*=\s*redis\.NewScript\(/, /\.Run\(/, /INCR/, /EXPIRE/, /DECR/]},
        scala: {all: [/ReserveLua/, /\.eval\(/, /INCR/, /EXPIRE/, /DECR/]},
        cpp: {all: [/kReserveLua/, /\.eval</, /INCR/, /EXPIRE/, /DECR/]},
      },
    },
    {
      id: 'budget-cap',
      title: 'Caps the day at 400 entities under budget:{day}',
      detail:
        'A `DAILY_ENTITY_BUDGET = 400` constant and a `budget:{day}` key (UTC date) bound the model calls per day; a rejected reservation raises `BudgetExhausted`. The draft counts but never refuses.',
      match: {
        python: {all: [/DAILY_ENTITY_BUDGET\s*=\s*400/, /budget:\{day\}/, /BudgetExhausted/]},
        typescript: {all: [/DAILY_ENTITY_BUDGET\s*=\s*400/, /budget:\$\{day\}/, /BudgetExhausted/]},
        go: {all: [/dailyEntityBudget\s*=\s*400/, /"budget:"\s*\+\s*day/, /errBudgetExhausted/]},
        scala: {all: [/DailyEntityBudget\s*=\s*400/, /budget:\$day/, /BudgetExhausted/]},
        cpp: {all: [/kDailyEntityBudget\s*=\s*400/, /"budget:"\s*\+\s*day/, /BudgetExhausted/]},
      },
    },
    {
      id: 'verify-expiry',
      title: 'Pending verification expires after 7 days',
      detail:
        'The `verify:{entity}` hash is written with a `VERIFY_TTL_S = 604800` expiry. The draft writes it without one, so every entity ever scanned keeps a reminder record forever.',
      match: {
        python: {all: [/verify:\{entity\}/, /VERIFY_TTL_S\s*=\s*604800/, /\.expire\(\s*\w+,\s*VERIFY_TTL_S\s*\)/]},
        typescript: {
          all: [/verify:\$\{entity\}/, /VERIFY_TTL_S\s*=\s*604800/, /\.expire\(\s*\w+,\s*VERIFY_TTL_S\s*\)/],
        },
        go: {all: [/"verify:"\s*\+\s*entity/, /verifyTTLS\s*=\s*604800/, /verifyTTLS\s*\*\s*time\.Second/]},
        scala: {all: [/verify:\$entity/, /VerifyTtlS\s*=\s*604800/, /\.expire\(\s*\w+,\s*VerifyTtlS\s*\)/]},
        cpp: {all: [/"verify:"\s*\+\s*entity/, /kVerifyTtlS\s*=\s*604800/, /std::chrono::seconds\(kVerifyTtlS\)/]},
      },
    },
    {
      id: 'reserve-before-call',
      title: 'Reserves budget before the gateway call',
      detail:
        'The reservation runs before `classify_columns(...)`; a cache hit never reserves and a rejected reservation never calls. The draft counts after the call, so the cap never stops a call.',
      match: {
        python: {order: [/reserve_budget\(/, /classify_columns\(/]},
        typescript: {order: [/reserveBudget\(/, /classifyColumns\(/]},
        go: {order: [/reserveBudget\(/, /classifyColumns\(/]},
        scala: {order: [/reserveBudget\(/, /classifyColumns\(/]},
        cpp: {order: [/reserveBudget\(/, /classifyColumns\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

from classify_columns import classify_columns

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def classify_entity(entity: str, owner: str, columns: list[str]) -> list[dict]:
    # TODO: this draft caches by entity name alone with no TTL, counts the day's entities after
    # the call with a non-atomic read, never refuses, and leaves the verification record forever.
    cached = r.get(f"classify:{entity}")
    if cached is not None:
        return json.loads(cached)
    tags = classify_columns(entity, columns)
    used = int(r.get("budget:today") or 0)
    if used < 400:
        r.incr("budget:today")
    r.set(f"classify:{entity}", json.dumps(tags))
    r.hset(f"verify:{entity}", mapping={"owner": owner, "state": "pending"})
    return tags
`,
      solution: `import datetime
import hashlib
import json

import redis

from classify_columns import classify_columns

RESULT_TTL_S = 604800
VERIFY_TTL_S = 604800
BUDGET_TTL_S = 172800
DAILY_ENTITY_BUDGET = 400

RESERVE_LUA = """
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if n > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
"""

r = redis.Redis(host="redis", port=6379, decode_responses=True)


class BudgetExhausted(Exception):
    """The day's 400 entities are spent; the job is requeued for tomorrow."""


def schema_hash_of(columns: list[str]) -> str:
    return hashlib.sha256("\\n".join(columns).encode("utf-8")).hexdigest()


def reserve_budget() -> bool:
    day = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    return int(r.eval(RESERVE_LUA, 1, f"budget:{day}", DAILY_ENTITY_BUDGET, BUDGET_TTL_S)) == 1


def classify_entity(entity: str, owner: str, columns: list[str]) -> list[dict]:
    schema_hash = schema_hash_of(columns)
    result_key = f"classify:{entity}:{schema_hash}"
    cached = r.get(result_key)
    if cached is not None:
        return json.loads(cached)
    if not reserve_budget():
        raise BudgetExhausted(entity)
    tags = classify_columns(entity, columns)
    r.set(result_key, json.dumps(tags), ex=RESULT_TTL_S)
    verify_key = f"verify:{entity}"
    pipe = r.pipeline()
    pipe.hset(verify_key, mapping={"owner": owner, "schema_hash": schema_hash, "state": "pending"})
    pipe.expire(verify_key, VERIFY_TTL_S)
    pipe.execute()
    return tags
`,
    },
    typescript: {
      starter: `/** Scan cache: a model-generated draft that keys by entity name and counts after the call. */
import {Redis} from 'ioredis';

import {classifyColumns, type ColumnTag} from './classify_columns';

const r = new Redis('redis://redis:6379');

export async function classifyEntity(entity: string, owner: string, columns: string[]): Promise<ColumnTag[]> {
  // TODO: this draft caches by entity name alone with no TTL, counts the day's entities after
  // the call with a non-atomic read, never refuses, and leaves the verification record forever.
  const cached = await r.get(\`classify:\${entity}\`);
  if (cached !== null) return JSON.parse(cached) as ColumnTag[];
  const tags = await classifyColumns(entity, columns);
  const used = Number((await r.get('budget:today')) ?? 0);
  if (used < 400) await r.incr('budget:today');
  await r.set(\`classify:\${entity}\`, JSON.stringify(tags));
  await r.hset(\`verify:\${entity}\`, {owner, state: 'pending'});
  return tags;
}
`,
      solution: `/** Scan cache: results by schema hash, one atomic daily reservation, verification that expires. */
import {createHash} from 'node:crypto';

import {Redis} from 'ioredis';

import {classifyColumns, type ColumnTag} from './classify_columns';

const RESULT_TTL_S = 604800;
const VERIFY_TTL_S = 604800;
const BUDGET_TTL_S = 172800;
const DAILY_ENTITY_BUDGET = 400;

const RESERVE_LUA = \`
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if n > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
\`;

const r = new Redis('redis://redis:6379');

export class BudgetExhausted extends Error {}

function schemaHashOf(columns: string[]): string {
  return createHash('sha256').update(columns.join('\\n')).digest('hex');
}

async function reserveBudget(): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const reply = await r.eval(RESERVE_LUA, 1, \`budget:\${day}\`, String(DAILY_ENTITY_BUDGET), String(BUDGET_TTL_S));
  return reply === 1;
}

export async function classifyEntity(entity: string, owner: string, columns: string[]): Promise<ColumnTag[]> {
  const schemaHash = schemaHashOf(columns);
  const resultKey = \`classify:\${entity}:\${schemaHash}\`;
  const cached = await r.get(resultKey);
  if (cached !== null) return JSON.parse(cached) as ColumnTag[];
  if (!(await reserveBudget())) throw new BudgetExhausted(entity);
  const tags = await classifyColumns(entity, columns);
  await r.set(resultKey, JSON.stringify(tags), 'EX', RESULT_TTL_S);
  const verifyKey = \`verify:\${entity}\`;
  await r
    .multi()
    .hset(verifyKey, {owner, schema_hash: schemaHash, state: 'pending'})
    .expire(verifyKey, VERIFY_TTL_S)
    .exec();
  return tags;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
	pb "metasense/classifierpb"
)

var (
	rdb    *redis.Client
	client pb.ClassifierClient
)

// TODO: this draft caches by entity name alone with no TTL, counts the day's entities after the
// call with a non-atomic read, never refuses, and leaves the verification record forever.
func classifyEntity(ctx context.Context, entity, owner string, columns []string) ([]ColumnTag, error) {
	cached, err := rdb.Get(ctx, "classify:"+entity).Result()
	if err == nil {
		var tags []ColumnTag
		_ = json.Unmarshal([]byte(cached), &tags)
		return tags, nil
	}
	tags, err := classifyColumns(ctx, client, entity, columns)
	if err != nil {
		return nil, err
	}
	used, _ := rdb.Get(ctx, "budget:today").Int()
	if used < 400 {
		rdb.Incr(ctx, "budget:today")
	}
	payload, _ := json.Marshal(tags)
	rdb.Set(ctx, "classify:"+entity, payload, 0)
	rdb.HSet(ctx, "verify:"+entity, "owner", owner, "state", "pending")
	return tags, nil
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
	pb "metasense/classifierpb"
)

const (
	resultTTLS        = 604800
	verifyTTLS        = 604800
	budgetTTLS        = 172800
	dailyEntityBudget = 400
)

var errBudgetExhausted = errors.New("daily classification budget exhausted; requeue for tomorrow")

var reserveScript = redis.NewScript(\`
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if n > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
\`)

var (
	rdb    *redis.Client
	client pb.ClassifierClient
)

func schemaHashOf(columns []string) string {
	sum := sha256.Sum256([]byte(strings.Join(columns, "\\n")))
	return hex.EncodeToString(sum[:])
}

func reserveBudget(ctx context.Context) (bool, error) {
	day := time.Now().UTC().Format("2006-01-02")
	n, err := reserveScript.Run(ctx, rdb, []string{"budget:" + day}, dailyEntityBudget, budgetTTLS).Int()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}

func classifyEntity(ctx context.Context, entity, owner string, columns []string) ([]ColumnTag, error) {
	schemaHash := schemaHashOf(columns)
	resultKey := fmt.Sprintf("classify:%s:%s", entity, schemaHash)
	cached, err := rdb.Get(ctx, resultKey).Result()
	if err == nil {
		var tags []ColumnTag
		if err := json.Unmarshal([]byte(cached), &tags); err == nil {
			return tags, nil
		}
	}
	ok, err := reserveBudget(ctx)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, errBudgetExhausted
	}
	tags, err := classifyColumns(ctx, client, entity, columns)
	if err != nil {
		return nil, err
	}
	payload, err := json.Marshal(tags)
	if err != nil {
		return nil, err
	}
	if err := rdb.Set(ctx, resultKey, payload, resultTTLS*time.Second).Err(); err != nil {
		return nil, err
	}
	verifyKey := "verify:" + entity
	pipe := rdb.TxPipeline()
	pipe.HSet(ctx, verifyKey, "owner", owner, "schema_hash", schemaHash, "state", "pending")
	pipe.Expire(ctx, verifyKey, verifyTTLS*time.Second)
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, err
	}
	return tags, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis
import spray.json._

object ScanCache {
  import ClassifyColumns.classifyColumns

  implicit val tagFormat: RootJsonFormat[ColumnTag] = DefaultJsonProtocol.jsonFormat3(ColumnTag)
  val jedis = new Jedis("redis", 6379)

  // TODO: this draft caches by entity name alone with no TTL, counts the day's entities after the
  // call with a non-atomic read, never refuses, and leaves the verification record forever.
  def classifyEntity(entity: String, owner: String, columns: List[String]): List[ColumnTag] = {
    Option(jedis.get(s"classify:$entity")) match {
      case Some(cached) => cached.parseJson.convertTo[List[ColumnTag]]
      case None =>
        val tags = classifyColumns(entity, columns)
        val used = Option(jedis.get("budget:today")).map(_.toLong).getOrElse(0L)
        if (used < 400) jedis.incr("budget:today")
        jedis.set(s"classify:$entity", tags.toJson.compactPrint)
        jedis.hset(s"verify:$entity", java.util.Map.of("owner", owner, "state", "pending"))
        tags
    }
  }
}
`,
      solution: `import java.security.MessageDigest
import java.time.{LocalDate, ZoneOffset}

import redis.clients.jedis.Jedis
import spray.json._

final class BudgetExhausted(entity: String) extends RuntimeException(s"daily budget exhausted for $entity")

object ScanCache {
  import ClassifyColumns.classifyColumns

  implicit val tagFormat: RootJsonFormat[ColumnTag] = DefaultJsonProtocol.jsonFormat3(ColumnTag)

  val ResultTtlS = 604800L
  val VerifyTtlS = 604800L
  val BudgetTtlS = 172800L
  val DailyEntityBudget = 400L

  val ReserveLua =
    """
      |local n = redis.call('INCR', KEYS[1])
      |if n == 1 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[2])
      |end
      |if n > tonumber(ARGV[1]) then
      |  redis.call('DECR', KEYS[1])
      |  return 0
      |end
      |return 1
      |""".stripMargin

  val jedis = new Jedis("redis", 6379)

  def schemaHashOf(columns: List[String]): String =
    MessageDigest
      .getInstance("SHA-256")
      .digest(columns.mkString("\\n").getBytes("UTF-8"))
      .map("%02x".format(_))
      .mkString

  def reserveBudget(): Boolean = {
    val day = LocalDate.now(ZoneOffset.UTC).toString
    jedis.eval(ReserveLua, 1, s"budget:$day", DailyEntityBudget.toString, BudgetTtlS.toString) == 1L
  }

  def classifyEntity(entity: String, owner: String, columns: List[String]): List[ColumnTag] = {
    val schemaHash = schemaHashOf(columns)
    val resultKey = s"classify:$entity:$schemaHash"
    Option(jedis.get(resultKey)) match {
      case Some(cached) => cached.parseJson.convertTo[List[ColumnTag]]
      case None =>
        if (!reserveBudget()) throw new BudgetExhausted(entity)
        val tags = classifyColumns(entity, columns)
        jedis.setex(resultKey, ResultTtlS, tags.toJson.compactPrint)
        val verifyKey = s"verify:$entity"
        val tx = jedis.multi()
        tx.hset(verifyKey, java.util.Map.of("owner", owner, "schema_hash", schemaHash, "state", "pending"))
        tx.expire(verifyKey, VerifyTtlS)
        tx.exec()
        tags
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <nlohmann/json.hpp>
#include <string>
#include <unordered_map>
#include <vector>

#include "classifier.grpc.pb.h"

using json = nlohmann::json;

struct ColumnTag {
  std::string column;
  std::string tag;
  double confidence;
};

std::vector<ColumnTag> classifyColumns(Classifier::Stub* stub, const std::string& entity,
                                       const std::vector<std::string>& columns);
json toJson(const std::vector<ColumnTag>& tags);
std::vector<ColumnTag> fromJson(const json& data);

// TODO: this draft caches by entity name alone with no TTL, counts the day's entities after the
// call with a non-atomic read, never refuses, and leaves the verification record forever.
std::vector<ColumnTag> classifyEntity(sw::redis::Redis& redis, Classifier::Stub* stub, const std::string& entity,
                                      const std::string& owner, const std::vector<std::string>& columns) {
  const auto cached = redis.get("classify:" + entity);
  if (cached) return fromJson(json::parse(*cached));
  const auto tags = classifyColumns(stub, entity, columns);
  const auto raw = redis.get("budget:today");
  const long long used = raw ? std::stoll(*raw) : 0;
  if (used < 400) redis.incr("budget:today");
  redis.set("classify:" + entity, toJson(tags).dump());
  const std::unordered_map<std::string, std::string> record = {{"owner", owner}, {"state", "pending"}};
  redis.hset("verify:" + entity, record.begin(), record.end());
  return tags;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <ctime>
#include <nlohmann/json.hpp>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

#include "classifier.grpc.pb.h"

using json = nlohmann::json;

constexpr long long kResultTtlS = 604800;
constexpr long long kVerifyTtlS = 604800;
constexpr long long kBudgetTtlS = 172800;
constexpr long long kDailyEntityBudget = 400;

const char* kReserveLua = R"LUA(
local n = redis.call('INCR', KEYS[1])
if n == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if n > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
)LUA";

struct ColumnTag {
  std::string column;
  std::string tag;
  double confidence;
};

struct BudgetExhausted : std::runtime_error {
  using std::runtime_error::runtime_error;
};

std::vector<ColumnTag> classifyColumns(Classifier::Stub* stub, const std::string& entity,
                                       const std::vector<std::string>& columns);
json toJson(const std::vector<ColumnTag>& tags);
std::vector<ColumnTag> fromJson(const json& data);
std::string sha256Hex(const std::string& text);

std::string schemaHashOf(const std::vector<std::string>& columns) {
  std::string joined;
  for (std::size_t i = 0; i < columns.size(); i++) {
    if (i > 0) joined += "\\n";
    joined += columns[i];
  }
  return sha256Hex(joined);
}

std::string todayUtc() {
  const std::time_t now = std::time(nullptr);
  char buf[11];
  std::strftime(buf, sizeof(buf), "%Y-%m-%d", std::gmtime(&now));
  return buf;
}

bool reserveBudget(sw::redis::Redis& redis) {
  const std::string day = todayUtc();
  const auto reply = redis.eval<long long>(kReserveLua, {"budget:" + day},
                                           {std::to_string(kDailyEntityBudget), std::to_string(kBudgetTtlS)});
  return reply == 1;
}

std::vector<ColumnTag> classifyEntity(sw::redis::Redis& redis, Classifier::Stub* stub, const std::string& entity,
                                      const std::string& owner, const std::vector<std::string>& columns) {
  const auto schemaHash = schemaHashOf(columns);
  const std::string resultKey = "classify:" + entity + ":" + schemaHash;
  const auto cached = redis.get(resultKey);
  if (cached) return fromJson(json::parse(*cached));
  if (!reserveBudget(redis)) throw BudgetExhausted(entity);
  const auto tags = classifyColumns(stub, entity, columns);
  redis.set(resultKey, toJson(tags).dump(), std::chrono::seconds(kResultTtlS));
  const std::string verifyKey = "verify:" + entity;
  const std::unordered_map<std::string, std::string> record = {
      {"owner", owner}, {"schema_hash", schemaHash}, {"state", "pending"}};
  auto tx = redis.transaction();
  tx.hset(verifyKey, record.begin(), record.end()).expire(verifyKey, std::chrono::seconds(kVerifyTtlS)).exec();
  return tags;
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can tell a cache key from a cache *identity*. A classification belongs to a schema, so the key must carry the schema hash — the source's whole reason for re-scanning is that a column was added, and a name-keyed cache hides exactly that. Four separate defects are being checked: the key and its TTL, the atomic reservation (read-then-increment overspends under the concurrency a backlog produces), the order (reserve before the call, so the cap is a limit and not a report — the source's rate limiter sits in front of the provider for the same reason), and the expiry on the verification record, which matches the weekly reminder cadence the source describes. Real services add a refund when the gateway call fails after the reservation, a per-platform share of the daily budget, and a token-based budget alongside the entity count, since one 150-column job costs more than ten 5-column ones.`,
};
