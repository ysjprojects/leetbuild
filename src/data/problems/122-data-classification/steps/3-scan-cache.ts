import type {Step} from '@/lib/types';

export const scanCacheStep: Step = {
  id: 'scan-cache',
  title: 'Redis: results by schema hash, a daily budget, verification that expires',
  concept: 'redis',
  file: 'scan_cache',
  focus: ['metasense', 'redis', 'llm'],
  task: `## Task

**Starting point.** The starter's \`classify_entity(entity, owner, columns)\` looks up
\`classify:{entity}\`, calls \`classify_columns\` on a miss, then reads \`budget:today\`, increments
it if under 400, stores the tags with no expiry and writes \`verify:{entity}\` with no expiry. A
second scan of the same entity comes from the cache, so the demo passes; it hides five flaws.

**Failure mode the checks target.** A cache keyed by name serves stale tags after a schema change,
the one case governance cares about; a counter read and then incremented overspends under the
concurrency a backlog creates; counting after the call makes the cap a report, not a limit; a
verification key without a TTL grows the keyspace forever.

- Cache results under \`classify:{entity}:{schema_hash}\` (hex SHA-256 of the columns joined by
  \`\\n\`) for **7 days** (\`RESULT_TTL_S = 604800\`).
- The day's budget is **400 entities** (\`DAILY_ENTITY_BUDGET\`) under \`budget:{day}\` (UTC
  \`YYYY-MM-DD\`), reserved by **one atomic Lua script**: \`INCR\`, \`EXPIRE\` on first write
  (\`BUDGET_TTL_S = 172800\`), and \`DECR\` plus \`0\` when the increment crossed the cap.
- **Reserve before the gateway call.** A cache hit spends no budget; a rejected reservation raises
  \`BudgetExhausted\` so the job is requeued for tomorrow without calling the model.
- After a fresh classification, record \`verify:{entity}\` as a hash (\`owner\`, \`schema_hash\`,
  \`state=pending\`) with a **7-day** expiry (\`VERIFY_TTL_S = 604800\`).`,
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
    'A table gained a `passport_no` column last week and the catalog still shows the tags from before; the invoice for one busy day lists 460 entities against a cap of 400.',
    'The key is the entity name, so a new schema hits the old entry; the counter is read, compared and incremented in three round trips after the model was paid; neither key has a TTL.',
    'Key `classify:{entity}:{schema_hash}` with `ex=RESULT_TTL_S`; one `EVAL` script (`INCR`, `EXPIRE` on 1, `DECR` and return 0 over the cap) before `classify_columns`, raising `BudgetExhausted` on 0; `HSET verify:{entity}` plus `EXPIRE VERIFY_TTL_S`.',
  ],
  checks: [
    {
      id: 'cache-key',
      title: 'Caches results under classify:{entity}:{schema_hash} with a 7-day TTL',
      detail:
        'The result key carries the schema hash and is set with `RESULT_TTL_S = 604800`. The starter keys by entity name alone and never expires the entry, so a schema change keeps serving old tags.',
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
        'A `DAILY_ENTITY_BUDGET = 400` constant and a `budget:{day}` key (UTC date) bound the model calls per day; a rejected reservation raises `BudgetExhausted`. The starter counts but never refuses.',
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
        'The `verify:{entity}` hash is written with a `VERIFY_TTL_S = 604800` expiry. The starter writes it without one, so every entity ever scanned keeps a reminder record forever.',
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
        'The reservation runs before `classify_columns(...)`; a cache hit does not reserve and a rejected reservation does not call. The starter counts after the call, so the cap never stops a call.',
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
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
      starter: `/** Scan cache: flawed code that keys by entity name and counts after the call. */
import {Redis} from 'ioredis';

import {classifyColumns, type ColumnTag} from './classify_columns';

const r = new Redis('redis://redis:6379');

export async function classifyEntity(entity: string, owner: string, columns: string[]): Promise<ColumnTag[]> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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

  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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

// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
  debrief: `A cache key names what the value is a function of. A classification is a function of a schema, so the key carries the schema hash; the source's reason for re-scanning is that a column was added, and a name-keyed cache hides exactly that. The budget moves into one Lua script because a read and an increment in separate round trips are a check followed by a race, and before the call because a cap counted afterwards describes the overspend instead of preventing it; the source's rate limiter sits in front of the provider for the same reason. The 7-day expiries match the weekly reminder cadence. Production services also refund the reservation when the gateway call fails, give each platform a share of the day, and budget tokens alongside entities.`,
};
