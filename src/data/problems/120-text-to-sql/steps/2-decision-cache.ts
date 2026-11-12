import type {Step} from '@/lib/types';

export const decisionCacheStep: Step = {
  id: 'decision-cache',
  title: 'Redis: decision cache and query budget',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'decisions',
  focus: ['api', 'redis', 'agents'],
  task: `## Task

**Starting point.** The starter is the Redis layer behind \`POST /v1/queries\`. \`tables_for(workspace,
question, pick_tables)\` caches the table agent's answer under \`decision:{question}\`; \`reserve(user)\`
reads \`budget:{user}\`, refuses at \`QUERY_BUDGET\` = 50 and increments it; \`propose(user, workspace,
question, pick_tables)\` picks the tables, then reserves, and answers \`{"status": "proposed", "tables"}\`
or \`{"status": "over_budget", "retry_after"}\`. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** "Trips in Seattle" misses the entry "trips in seattle" filled, and
an Ads question can read a Mobility answer; a cached table list outlives the curation it came from;
two app servers that read 49 at once both pass, and a counter without an expiry locks a busy user out
for good; a user over budget has already paid for a table-agent call.

Requirements:

- Key the decision \`decision:{workspace}:{qhash}\`, \`qhash\` the hex SHA-256 of the question trimmed,
  lower-cased, whitespace runs collapsed to one space; write it with \`DECISION_TTL_S\` = 86400.
- \`reserve\` is one Lua script on \`budget:{user}\`: at 50 it refuses with the key's TTL as
  \`retry_after\`; otherwise it \`INCR\`s, and \`EXPIRE\`s the key \`WINDOW_S\` = 3600 on the first one.
- \`propose\` reserves first: over budget, \`pick_tables\` is never called.`,
  sequence: {
    participants: ['querygen', 'Redis', 'Table agent'],
    messages: [
      {from: 'querygen', to: 'Redis', label: 'EVAL reserve · KEYS[budget:ana] · ARGV[50, 3600]', kind: 'sync'},
      {from: 'Redis', to: 'querygen', label: '{1, 0} / {0, ttl} → over_budget', kind: 'reply'},
      {from: 'querygen', to: 'Redis', label: 'GET decision:mobility:{sha256(normalised question)}', kind: 'sync'},
      {from: 'Redis', to: 'querygen', label: 'cached tables / nil', kind: 'reply'},
      {from: 'querygen', to: 'Table agent', label: 'pick_tables(question, workspace) on a miss', kind: 'sync'},
      {from: 'querygen', to: 'Redis', label: 'SET decision:… EX 86400', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'normalised-key',
      title: 'Keys the decision by workspace and normalised question hash',
      detail:
        'The same question with other spacing and capitals is a cache hit, the entry is decision:{workspace}:{sha256 hex of the normalised question}, and another workspace asks the table agent itself. The starter keys by the raw question alone.',
      match: {
        python: {all: [/sha256\(/, /\.lower\(\)/, /decision:\{workspace\}:/]},
        typescript: {all: [/createHash\(\s*['"]sha256['"]/, /toLowerCase\(\)/, /decision:\$\{workspace\}:/]},
        go: {all: [/sha256\.Sum256\(/, /strings\.ToLower\(/, /"decision:"\s*\+\s*workspace/]},
        scala: {all: [/SHA-256/, /toLowerCase/, /s"decision:\$workspace:/]},
        cpp: {all: [/sha256_hex\(/, /tolower/, /"decision:"\s*\+\s*workspace/]},
      },
    },
    {
      id: 'decision-ttl',
      title: 'Decision entries expire after 24 hours',
      detail:
        'The cached decision carries a TTL of DECISION_TTL_S (86400 s), and a day later the table agent is asked again. The starter writes it with no expiry.',
      match: {
        python: {all: [/ex\s*=\s*DECISION_TTL_S/]},
        typescript: {all: [/['"]EX['"]\s*,\s*DECISION_TTL_S/]},
        go: {all: [/rdb\.Set\([^\n]*decisionTTL\)/]},
        scala: {all: [/ex\(\s*DecisionTtlSeconds\s*\)/]},
        cpp: {all: [/redis\.set\([^\n]*kDecisionTtl/]},
      },
    },
    {
      id: 'atomic-budget',
      title: 'Reserves the hourly budget in one script',
      detail:
        "A second server reserving between the starter's GET and INCR cannot push a user past 50: exactly one of the two gets the 50th query. The counter expires WINDOW_S after the first query, so the next hour starts at 1. The starter reads and writes in separate round trips on a key that never expires.",
      match: {
        python: {all: [/register_script\(|\.eval\(/, /EXPIRE/], none: [/\br\.incr\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /EXPIRE/], none: [/redis\.incr\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /EXPIRE/], none: [/rdb\.Incr\(/]},
        scala: {all: [/jedis\s*\.eval\(/, /EXPIRE/], none: [/jedis\.incr\(/]},
        cpp: {all: [/redis\.eval</, /EXPIRE/], none: [/redis\.incr\(/]},
      },
    },
    {
      id: 'budget-first',
      title: 'Reserves before the table agent is called',
      detail:
        "A user at 50 gets over_budget with retry_after from the counter's TTL, and pick_tables is never called. The starter picks the tables first, so a refused request has already paid for a model call.",
      match: {
        python: {order: [/=\s*reserve\(\s*user\s*\)/, /tables_for\(/]},
        typescript: {order: [/await reserve\(\s*user\s*\)/, /tablesFor\(/]},
        go: {order: [/=\s*reserve\(\s*ctx\s*,\s*user\s*\)/, /tablesFor\(/]},
        scala: {order: [/=\s*reserve\(\s*user\s*\)/, /tablesFor\(/]},
        cpp: {order: [/=\s*reserve\(\s*user\s*\)/, /tables_for\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

QUERY_BUDGET = 50
WINDOW_S = 3_600


def tables_for(workspace: str, question: str, pick_tables) -> list[str]:
    """The tables proposed for a question: the cached decision, or the table agent's pick."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    key = f"decision:{question}"
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)
    tables = list(pick_tables(question, workspace))
    r.set(key, json.dumps(tables))
    return tables


def reserve(user: str) -> tuple[bool, int]:
    """One query out of the user's hourly budget: (allowed, retry_after seconds)."""
    key = f"budget:{user}"
    used = int(r.get(key) or 0)
    if used >= QUERY_BUDGET:
        return False, WINDOW_S
    r.incr(key)
    return True, 0


def propose(user: str, workspace: str, question: str, pick_tables) -> dict:
    """The proposal for one question, or over_budget with when to come back."""
    tables = tables_for(workspace, question, pick_tables)
    allowed, retry_after = reserve(user)
    if not allowed:
        return {"status": "over_budget", "retry_after": retry_after}
    return {"status": "proposed", "tables": tables}
`,
      solution: `import hashlib
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

DECISION_TTL_S = 86_400
QUERY_BUDGET = 50
WINDOW_S = 3_600

# Redis runs a script alone: no other server's command lands between the read and the increment.
RESERVE = """
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then
  return {0, redis.call('TTL', KEYS[1])}
end
used = redis.call('INCR', KEYS[1])
if used == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return {1, 0}
"""
reserve_query = r.register_script(RESERVE)


def decision_key(workspace: str, question: str) -> str:
    normalised = " ".join(question.lower().split())
    return f"decision:{workspace}:{hashlib.sha256(normalised.encode('utf-8')).hexdigest()}"


def tables_for(workspace: str, question: str, pick_tables) -> list[str]:
    """The tables proposed for a question: the cached decision, or the table agent's pick."""
    key = decision_key(workspace, question)
    cached = r.get(key)
    if cached is not None:
        return json.loads(cached)
    tables = list(pick_tables(question, workspace))
    r.set(key, json.dumps(tables), ex=DECISION_TTL_S)
    return tables


def reserve(user: str) -> tuple[bool, int]:
    """One query out of the user's hourly budget: (allowed, retry_after seconds)."""
    allowed, retry_after = reserve_query(keys=[f"budget:{user}"], args=[QUERY_BUDGET, WINDOW_S])
    return allowed == 1, int(retry_after)


def propose(user: str, workspace: str, question: str, pick_tables) -> dict:
    """The proposal for one question, or over_budget with when to come back."""
    allowed, retry_after = reserve(user)
    if not allowed:
        return {"status": "over_budget", "retry_after": retry_after}
    return {"status": "proposed", "tables": tables_for(workspace, question, pick_tables)}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

export const QUERY_BUDGET = 50;
export const WINDOW_S = 3_600;

const redis = new Redis({host: 'redis', port: 6379});

/** The table agent: the tables it proposes for a question in a workspace. */
export type TablePicker = (question: string, workspace: string) => Promise<string[]>;

export interface Proposal {
  status: 'proposed' | 'over_budget';
  tables?: string[];
  retry_after?: number;
}

/** The tables proposed for a question: the cached decision, or the table agent's pick. */
export async function tablesFor(workspace: string, question: string, pickTables: TablePicker): Promise<string[]> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const key = \`decision:\${question}\`;
  const cached = await redis.get(key);
  if (cached !== null) return JSON.parse(cached) as string[];
  const tables = await pickTables(question, workspace);
  await redis.set(key, JSON.stringify(tables));
  return tables;
}

/** One query out of the user's hourly budget. */
export async function reserve(user: string): Promise<{allowed: boolean; retryAfter: number}> {
  const key = \`budget:\${user}\`;
  const used = Number((await redis.get(key)) ?? 0);
  if (used >= QUERY_BUDGET) return {allowed: false, retryAfter: WINDOW_S};
  await redis.incr(key);
  return {allowed: true, retryAfter: 0};
}

/** The proposal for one question, or over_budget with when to come back. */
export async function propose(user: string, workspace: string, question: string, pickTables: TablePicker): Promise<Proposal> {
  const tables = await tablesFor(workspace, question, pickTables);
  const budget = await reserve(user);
  if (!budget.allowed) return {status: 'over_budget', retry_after: budget.retryAfter};
  return {status: 'proposed', tables};
}
`,
      solution: `import {createHash} from 'node:crypto';

import Redis from 'ioredis';

export const DECISION_TTL_S = 86_400;
export const QUERY_BUDGET = 50;
export const WINDOW_S = 3_600;

// Redis runs a script alone: no other server's command lands between the read and the increment.
const RESERVE = \`
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then
  return {0, redis.call('TTL', KEYS[1])}
end
used = redis.call('INCR', KEYS[1])
if used == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return {1, 0}
\`;

interface DecisionRedis extends Redis {
  reserveQuery(budgetKey: string, limit: number, windowS: number): Promise<[number, number]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as DecisionRedis;
redis.defineCommand('reserveQuery', {numberOfKeys: 1, lua: RESERVE});

/** The table agent: the tables it proposes for a question in a workspace. */
export type TablePicker = (question: string, workspace: string) => Promise<string[]>;

export interface Proposal {
  status: 'proposed' | 'over_budget';
  tables?: string[];
  retry_after?: number;
}

function decisionKey(workspace: string, question: string): string {
  const normalised = question.trim().toLowerCase().replace(/\\s+/g, ' ');
  return \`decision:\${workspace}:\${createHash('sha256').update(normalised).digest('hex')}\`;
}

/** The tables proposed for a question: the cached decision, or the table agent's pick. */
export async function tablesFor(workspace: string, question: string, pickTables: TablePicker): Promise<string[]> {
  const key = decisionKey(workspace, question);
  const cached = await redis.get(key);
  if (cached !== null) return JSON.parse(cached) as string[];
  const tables = await pickTables(question, workspace);
  await redis.set(key, JSON.stringify(tables), 'EX', DECISION_TTL_S);
  return tables;
}

/** One query out of the user's hourly budget. */
export async function reserve(user: string): Promise<{allowed: boolean; retryAfter: number}> {
  const [allowed, retryAfter] = await redis.reserveQuery(\`budget:\${user}\`, QUERY_BUDGET, WINDOW_S);
  return {allowed: Number(allowed) === 1, retryAfter: Number(retryAfter)};
}

/** The proposal for one question, or over_budget with when to come back. */
export async function propose(user: string, workspace: string, question: string, pickTables: TablePicker): Promise<Proposal> {
  const budget = await reserve(user);
  if (!budget.allowed) return {status: 'over_budget', retry_after: budget.retryAfter};
  return {status: 'proposed', tables: await tablesFor(workspace, question, pickTables)};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/redis/go-redis/v9"
)

const (
	queryBudget   = 50
	windowSeconds = 3600
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// TablePicker is the table agent: the tables it proposes for a question in a workspace.
type TablePicker func(ctx context.Context, question, workspace string) ([]string, error)

// Proposal is propose's answer: proposed with the tables, or over_budget with when to come back.
type Proposal struct {
	Status     string
	Tables     []string
	RetryAfter int64
}

// tablesFor is the tables proposed for a question: the cached decision, or the table agent's pick.
func tablesFor(ctx context.Context, workspace, question string, pick TablePicker) ([]string, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	key := "decision:" + question
	cached, err := rdb.Get(ctx, key).Result()
	if err == nil {
		var tables []string
		if json.Unmarshal([]byte(cached), &tables) == nil {
			return tables, nil
		}
	} else if !errors.Is(err, redis.Nil) {
		return nil, err
	}
	tables, err := pick(ctx, question, workspace)
	if err != nil {
		return nil, err
	}
	doc, _ := json.Marshal(tables)
	if err := rdb.Set(ctx, key, doc, 0).Err(); err != nil {
		return nil, err
	}
	return tables, nil
}

// reserve takes one query out of the user's hourly budget: allowed, and retry-after seconds when not.
func reserve(ctx context.Context, user string) (bool, int64, error) {
	key := "budget:" + user
	used, err := rdb.Get(ctx, key).Int64()
	if err != nil && !errors.Is(err, redis.Nil) {
		return false, 0, err
	}
	if used >= queryBudget {
		return false, windowSeconds, nil
	}
	if err := rdb.Incr(ctx, key).Err(); err != nil {
		return false, 0, err
	}
	return true, 0, nil
}

// propose is the proposal for one question, or over_budget with when to come back.
func propose(ctx context.Context, user, workspace, question string, pick TablePicker) (Proposal, error) {
	tables, err := tablesFor(ctx, workspace, question, pick)
	if err != nil {
		return Proposal{}, err
	}
	allowed, retryAfter, err := reserve(ctx, user)
	if err != nil {
		return Proposal{}, err
	}
	if !allowed {
		return Proposal{Status: "over_budget", RetryAfter: retryAfter}, nil
	}
	return Proposal{Status: "proposed", Tables: tables}, nil
}
`,
      solution: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	decisionTTL   = 24 * time.Hour
	queryBudget   = 50
	windowSeconds = 3600
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Redis runs a script alone: no other server's command lands between the read and the increment.
var reserveQuery = redis.NewScript(\`
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then
  return {0, redis.call('TTL', KEYS[1])}
end
used = redis.call('INCR', KEYS[1])
if used == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return {1, 0}
\`)

// TablePicker is the table agent: the tables it proposes for a question in a workspace.
type TablePicker func(ctx context.Context, question, workspace string) ([]string, error)

// Proposal is propose's answer: proposed with the tables, or over_budget with when to come back.
type Proposal struct {
	Status     string
	Tables     []string
	RetryAfter int64
}

func decisionKey(workspace, question string) string {
	normalised := strings.Join(strings.Fields(strings.ToLower(question)), " ")
	sum := sha256.Sum256([]byte(normalised))
	return "decision:" + workspace + ":" + hex.EncodeToString(sum[:])
}

// tablesFor is the tables proposed for a question: the cached decision, or the table agent's pick.
func tablesFor(ctx context.Context, workspace, question string, pick TablePicker) ([]string, error) {
	key := decisionKey(workspace, question)
	cached, err := rdb.Get(ctx, key).Result()
	if err == nil {
		var tables []string
		if json.Unmarshal([]byte(cached), &tables) == nil {
			return tables, nil
		}
	} else if !errors.Is(err, redis.Nil) {
		return nil, err
	}
	tables, err := pick(ctx, question, workspace)
	if err != nil {
		return nil, err
	}
	doc, _ := json.Marshal(tables)
	if err := rdb.Set(ctx, key, doc, decisionTTL).Err(); err != nil {
		return nil, err
	}
	return tables, nil
}

// reserve takes one query out of the user's hourly budget: allowed, and retry-after seconds when not.
func reserve(ctx context.Context, user string) (bool, int64, error) {
	reply, err := reserveQuery.Run(ctx, rdb, []string{"budget:" + user}, queryBudget, windowSeconds).Int64Slice()
	if err != nil {
		return false, 0, err
	}
	return reply[0] == 1, reply[1], nil
}

// propose is the proposal for one question, or over_budget with when to come back.
func propose(ctx context.Context, user, workspace, question string, pick TablePicker) (Proposal, error) {
	allowed, retryAfter, err := reserve(ctx, user)
	if err != nil {
		return Proposal{}, err
	}
	if !allowed {
		return Proposal{Status: "over_budget", RetryAfter: retryAfter}, nil
	}
	tables, err := tablesFor(ctx, workspace, question, pick)
	if err != nil {
		return Proposal{}, err
	}
	return Proposal{Status: "proposed", Tables: tables}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

/** propose's answer: proposed with the tables, or over_budget with when to come back. */
final case class Proposal(status: String, tables: List[String] = Nil, retryAfter: Long = 0)

object Decisions {
  val QueryBudget = 50L
  val WindowSeconds = 3600L

  private val jedis = new JedisPooled("redis", 6379)

  /** The tables proposed for a question: the cached decision, or the table agent's pick. */
  def tablesFor(workspace: String, question: String, pickTables: (String, String) => List[String]): List[String] = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val key = s"decision:$question"
    Option(jedis.get(key)) match {
      case Some(cached) => ujson.read(cached).arr.map(_.str).toList
      case None =>
        val tables = pickTables(question, workspace)
        jedis.set(key, ujson.write(ujson.Arr.from(tables.map(ujson.Str(_)))))
        tables
    }
  }

  /** One query out of the user's hourly budget: (allowed, retry-after seconds). */
  def reserve(user: String): (Boolean, Long) = {
    val key = s"budget:$user"
    val used = Option(jedis.get(key)).map(_.toLong).getOrElse(0L)
    if (used >= QueryBudget) (false, WindowSeconds)
    else {
      jedis.incr(key)
      (true, 0L)
    }
  }

  /** The proposal for one question, or over_budget with when to come back. */
  def propose(user: String, workspace: String, question: String, pickTables: (String, String) => List[String]): Proposal = {
    val tables = tablesFor(workspace, question, pickTables)
    val (allowed, retryAfter) = reserve(user)
    if (!allowed) Proposal("over_budget", retryAfter = retryAfter)
    else Proposal("proposed", tables = tables)
  }
}
`,
      solution: `import java.nio.charset.StandardCharsets.UTF_8
import java.security.MessageDigest

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import scala.jdk.CollectionConverters._

/** propose's answer: proposed with the tables, or over_budget with when to come back. */
final case class Proposal(status: String, tables: List[String] = Nil, retryAfter: Long = 0)

object Decisions {
  val DecisionTtlSeconds = 86400L
  val QueryBudget = 50L
  val WindowSeconds = 3600L

  private val jedis = new JedisPooled("redis", 6379)

  // Redis runs a script alone: no other server's command lands between the read and the increment.
  private val Reserve = """
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then
  return {0, redis.call('TTL', KEYS[1])}
end
used = redis.call('INCR', KEYS[1])
if used == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return {1, 0}
"""

  def decisionKey(workspace: String, question: String): String = {
    val normalised = question.trim.toLowerCase.split("\\\\s+").mkString(" ")
    val digest = MessageDigest.getInstance("SHA-256").digest(normalised.getBytes(UTF_8))
    s"decision:$workspace:\${digest.map("%02x".format(_)).mkString}"
  }

  /** The tables proposed for a question: the cached decision, or the table agent's pick. */
  def tablesFor(workspace: String, question: String, pickTables: (String, String) => List[String]): List[String] = {
    val key = decisionKey(workspace, question)
    Option(jedis.get(key)) match {
      case Some(cached) => ujson.read(cached).arr.map(_.str).toList
      case None =>
        val tables = pickTables(question, workspace)
        jedis.set(key, ujson.write(ujson.Arr.from(tables.map(ujson.Str(_)))), SetParams.setParams().ex(DecisionTtlSeconds))
        tables
    }
  }

  /** One query out of the user's hourly budget: (allowed, retry-after seconds). */
  def reserve(user: String): (Boolean, Long) = {
    val reply = jedis
      .eval(Reserve, List(s"budget:$user").asJava, List(QueryBudget.toString, WindowSeconds.toString).asJava)
      .asInstanceOf[java.util.List[java.lang.Long]]
      .asScala
      .map(_.longValue)
      .toList
    (reply.head == 1L, reply(1))
  }

  /** The proposal for one question, or over_budget with when to come back. */
  def propose(user: String, workspace: String, question: String, pickTables: (String, String) => List[String]): Proposal = {
    val (allowed, retryAfter) = reserve(user)
    if (!allowed) Proposal("over_budget", retryAfter = retryAfter)
    else Proposal("proposed", tables = tablesFor(workspace, question, pickTables))
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <functional>
#include <string>
#include <vector>

constexpr long long kQueryBudget = 50;
constexpr long long kWindowSeconds = 3600;

sw::redis::Redis redis("tcp://redis:6379");

// The table agent: the tables it proposes for a question in a workspace.
using TablePicker = std::function<std::vector<std::string>(const std::string& question, const std::string& workspace)>;

// reserve's answer: allowed, and retry-after seconds when not.
struct Budget {
  bool allowed = false;
  long long retry_after = 0;
};

// propose's answer: proposed with the tables, or over_budget with when to come back.
struct Proposal {
  std::string status;
  std::vector<std::string> tables;
  long long retry_after = 0;
};

// The tables proposed for a question: the cached decision, or the table agent's pick.
std::vector<std::string> tables_for(const std::string& workspace, const std::string& question, const TablePicker& pick_tables) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string key = "decision:" + question;
  if (const auto cached = redis.get(key)) return nlohmann::json::parse(*cached).get<std::vector<std::string>>();
  const std::vector<std::string> tables = pick_tables(question, workspace);
  redis.set(key, nlohmann::json(tables).dump());
  return tables;
}

// One query out of the user's hourly budget.
Budget reserve(const std::string& user) {
  const std::string key = "budget:" + user;
  const auto used = redis.get(key);
  if (used && std::stoll(*used) >= kQueryBudget) return {false, kWindowSeconds};
  redis.incr(key);
  return {true, 0};
}

// The proposal for one question, or over_budget with when to come back.
Proposal propose(const std::string& user, const std::string& workspace, const std::string& question, const TablePicker& pick_tables) {
  const std::vector<std::string> tables = tables_for(workspace, question, pick_tables);
  const Budget budget = reserve(user);
  if (!budget.allowed) return {"over_budget", {}, budget.retry_after};
  return {"proposed", tables, 0};
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <cctype>
#include <chrono>
#include <functional>
#include <string>
#include <vector>

#include "digest.h"  // sha256_hex(bytes) — provided

constexpr long long kDecisionTtlSeconds = 86400;
constexpr long long kQueryBudget = 50;
constexpr long long kWindowSeconds = 3600;

sw::redis::Redis redis("tcp://redis:6379");

// Redis runs a script alone: no other server's command lands between the read and the increment.
const std::string kReserve = R"lua(
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then
  return {0, redis.call('TTL', KEYS[1])}
end
used = redis.call('INCR', KEYS[1])
if used == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return {1, 0}
)lua";

// The table agent: the tables it proposes for a question in a workspace.
using TablePicker = std::function<std::vector<std::string>(const std::string& question, const std::string& workspace)>;

// reserve's answer: allowed, and retry-after seconds when not.
struct Budget {
  bool allowed = false;
  long long retry_after = 0;
};

// propose's answer: proposed with the tables, or over_budget with when to come back.
struct Proposal {
  std::string status;
  std::vector<std::string> tables;
  long long retry_after = 0;
};

std::string decision_key(const std::string& workspace, const std::string& question) {
  std::string normalised;
  bool gap = false;
  for (const unsigned char c : question) {
    if (std::isspace(c)) {
      gap = !normalised.empty();
      continue;
    }
    if (gap) normalised += ' ';
    gap = false;
    normalised += static_cast<char>(std::tolower(c));
  }
  return "decision:" + workspace + ":" + sha256_hex(normalised);
}

// The tables proposed for a question: the cached decision, or the table agent's pick.
std::vector<std::string> tables_for(const std::string& workspace, const std::string& question, const TablePicker& pick_tables) {
  const std::string key = decision_key(workspace, question);
  if (const auto cached = redis.get(key)) return nlohmann::json::parse(*cached).get<std::vector<std::string>>();
  const std::vector<std::string> tables = pick_tables(question, workspace);
  redis.set(key, nlohmann::json(tables).dump(), std::chrono::seconds(kDecisionTtlSeconds));
  return tables;
}

// One query out of the user's hourly budget.
Budget reserve(const std::string& user) {
  const auto reply = redis.eval<std::vector<long long>>(kReserve, {"budget:" + user},
                                                        {std::to_string(kQueryBudget), std::to_string(kWindowSeconds)});
  return {reply.at(0) == 1, reply.at(1)};
}

// The proposal for one question, or over_budget with when to come back.
Proposal propose(const std::string& user, const std::string& workspace, const std::string& question, const TablePicker& pick_tables) {
  const Budget budget = reserve(user);
  if (!budget.allowed) return {"over_budget", {}, budget.retry_after};
  return {"proposed", tables_for(workspace, question, pick_tables), 0};
}
`,
    },
  },
  harness: {
    python: `import hashlib

from querygen import agents

QUESTION = "Trips in Seattle last week"


def _picker():
    picks = []

    def pick(question, workspace):
        picks.append((question, workspace))
        return agents.pick_tables(question, workspace)

    return pick, picks


def _qhash(normalised):
    return hashlib.sha256(normalised.encode("utf-8")).hexdigest()


def check_normalised_key(ctx):
    m = ctx.load("decisions")
    pick, picks = _picker()
    first = m.tables_for("mobility", QUESTION, pick)
    assert first == ["trips", "drivers"], f"a miss returns the table agent's pick, got {first}"
    again = m.tables_for("mobility", "  trips IN seattle\\tlast   week ", pick)
    assert len(picks) == 1, f"the same question with other capitals and spacing asked the table agent again ({len(picks)} picks): normalise before you hash"
    assert again == first, f"the cache hit must return the cached tables, got {again}"
    key = f"decision:mobility:{_qhash('trips in seattle last week')}"
    assert ctx.redis.get(key) is not None, f"the decision must live at decision:{{workspace}}:{{sha256 of the normalised question}} ({key[:30]}…), keys are {ctx.redis.keys('decision:*')}"
    ads = m.tables_for("ads", QUESTION, pick)
    assert len(picks) == 2 and ads == ["ad_campaigns"], f"an Ads question must not read Mobility's decision: {len(picks)} picks, tables {ads}"


def check_decision_ttl(ctx):
    m = ctx.load("decisions")
    pick, picks = _picker()
    m.tables_for("mobility", QUESTION, pick)
    keys = ctx.redis.keys("decision:*")
    assert len(keys) == 1, f"one question, one decision entry: {keys}"
    ttl = ctx.redis.ttl(keys[0])
    assert 86_000 < ttl <= 86_400, f"the decision has TTL {ttl}: it must expire DECISION_TTL_S (86400 s) after it was written"
    m.tables_for("mobility", QUESTION, pick)
    assert len(picks) == 1, "within the day the decision is served from the cache"
    ctx.clock.advance(86_401)
    m.tables_for("mobility", QUESTION, pick)
    assert len(picks) == 2, "a day later the table agent must be asked again: the workspace may have been re-curated"


def check_atomic_budget(ctx):
    m = ctx.load("decisions")
    allowed, _ = m.reserve("ana")
    assert allowed, "a user's first query is within budget"
    assert ctx.redis.get("budget:ana") == "1", f"budget:ana must count 1, holds {ctx.redis.get('budget:ana')!r}"
    ttl = ctx.redis.ttl("budget:ana")
    assert 0 < ttl <= 3_600, f"budget:ana has TTL {ttl}: the window must expire WINDOW_S (3600 s) after the first query, or the user is locked out for good"
    ctx.redis.set("budget:bo", 49, ex=1_800)

    def other_server():
        # another app server reserving bo's query, landing between two of this server's commands
        if int(ctx.redis.get("budget:bo") or 0) >= 50:
            return False
        ctx.redis.incr("budget:bo")
        return True

    probe = ctx.redis_after("budget:bo", other_server)
    mine, _ = m.reserve("bo")
    assert probe.fired, "reserve never touched budget:bo"
    winners = [mine, probe.result].count(True)
    assert winners == 1, f"two servers reserved bo's 50th query and {winners} got through: the read, the check and the increment must run in one script"
    assert ctx.redis.get("budget:bo") == "50", f"budget:bo must stop at 50, holds {ctx.redis.get('budget:bo')}"
    ctx.clock.advance(3_601)
    allowed, _ = m.reserve("ana")
    assert allowed and ctx.redis.get("budget:ana") == "1", f"after the hour the window starts over at 1, holds {ctx.redis.get('budget:ana')!r}"


def check_budget_first(ctx):
    m = ctx.load("decisions")
    pick, picks = _picker()
    ctx.redis.set("budget:cy", 50, ex=1_200)
    out = m.propose("cy", "mobility", QUESTION, pick)
    assert out.get("status") == "over_budget", f"a user at 50 queries must get over_budget, got {out}"
    assert picks == [], f"the table agent was called {len(picks)} time(s) for a user already over budget: reserve before the agent call"
    assert 1_190 <= out.get("retry_after", 0) <= 1_200, f"retry_after must be the window's TTL (about 1200 s), got {out.get('retry_after')}"
    assert ctx.redis.get("budget:cy") == "50", f"a refused query must not count, budget:cy holds {ctx.redis.get('budget:cy')}"
    out = m.propose("dee", "mobility", QUESTION, pick)
    assert out.get("status") == "proposed" and out.get("tables") == ["trips", "drivers"], f"a user within budget gets the proposal, got {out}"
    assert ctx.redis.get("budget:dee") == "1", f"the proposal counts against dee's budget, budget:dee holds {ctx.redis.get('budget:dee')!r}"
`,
    typescript: `import {createHash} from 'node:crypto';

const QUESTION = 'Trips in Seattle last week';

function picker(ctx) {
  const agents = ctx.load('/support/querygen/agents.ts');
  const picks: [string, string][] = [];
  const pick = async (question: string, workspace: string) => {
    picks.push([question, workspace]);
    return agents.pickTables(question, workspace);
  };
  return {pick, picks};
}

const qhash = (normalised: string) => createHash('sha256').update(normalised).digest('hex');

export async function check_normalised_key(ctx) {
  const m = ctx.load('decisions');
  const {pick, picks} = picker(ctx);
  const first = await m.tablesFor('mobility', QUESTION, pick);
  assert.deepStrictEqual(first, ['trips', 'drivers'], \`a miss returns the table agent's pick, got \${JSON.stringify(first)}\`);
  const again = await m.tablesFor('mobility', '  trips IN seattle\\tlast   week ', pick);
  assert.equal(picks.length, 1, \`the same question with other capitals and spacing asked the table agent again (\${picks.length} picks): normalise before you hash\`);
  assert.deepStrictEqual(again, first, \`the cache hit must return the cached tables, got \${JSON.stringify(again)}\`);
  const key = \`decision:mobility:\${qhash('trips in seattle last week')}\`;
  assert(ctx.redis.get(key) !== null, \`the decision must live at decision:{workspace}:{sha256 of the normalised question}, keys are \${JSON.stringify(ctx.redis.keys('decision:*'))}\`);
  const ads = await m.tablesFor('ads', QUESTION, pick);
  assert(picks.length === 2 && JSON.stringify(ads) === JSON.stringify(['ad_campaigns']), \`an Ads question must not read Mobility's decision: \${picks.length} picks, tables \${JSON.stringify(ads)}\`);
}

export async function check_decision_ttl(ctx) {
  const m = ctx.load('decisions');
  const {pick, picks} = picker(ctx);
  await m.tablesFor('mobility', QUESTION, pick);
  const keys = ctx.redis.keys('decision:*');
  assert.equal(keys.length, 1, \`one question, one decision entry: \${JSON.stringify(keys)}\`);
  const ttl = ctx.redis.ttl(keys[0]);
  assert(ttl > 86_000 && ttl <= 86_400, \`the decision has TTL \${ttl}: it must expire DECISION_TTL_S (86400 s) after it was written\`);
  await m.tablesFor('mobility', QUESTION, pick);
  assert.equal(picks.length, 1, 'within the day the decision is served from the cache');
  ctx.clock.advance(86_401);
  await m.tablesFor('mobility', QUESTION, pick);
  assert.equal(picks.length, 2, 'a day later the table agent must be asked again: the workspace may have been re-curated');
}

export async function check_atomic_budget(ctx) {
  const m = ctx.load('decisions');
  const first = await m.reserve('ana');
  assert(first.allowed, "a user's first query is within budget");
  assert.equal(ctx.redis.get('budget:ana'), '1', \`budget:ana must count 1, holds \${ctx.redis.get('budget:ana')}\`);
  const ttl = ctx.redis.ttl('budget:ana');
  assert(ttl > 0 && ttl <= 3_600, \`budget:ana has TTL \${ttl}: the window must expire WINDOW_S (3600 s) after the first query, or the user is locked out for good\`);
  ctx.redis.set('budget:bo', '49', 'EX', 1_800);
  const probe = ctx.redisAfter('budget:bo', () => {
    // another app server reserving bo's query, landing between two of this server's commands
    if (Number(ctx.redis.get('budget:bo') ?? 0) >= 50) return false;
    ctx.redis.incr('budget:bo');
    return true;
  });
  const mine = await m.reserve('bo');
  assert(probe.fired, 'reserve never touched budget:bo');
  const winners = [mine.allowed, probe.result].filter(v => v === true).length;
  assert.equal(winners, 1, \`two servers reserved bo's 50th query and \${winners} got through: the read, the check and the increment must run in one script\`);
  assert.equal(ctx.redis.get('budget:bo'), '50', \`budget:bo must stop at 50, holds \${ctx.redis.get('budget:bo')}\`);
  ctx.clock.advance(3_601);
  const next = await m.reserve('ana');
  assert(next.allowed && ctx.redis.get('budget:ana') === '1', \`after the hour the window starts over at 1, holds \${ctx.redis.get('budget:ana')}\`);
}

export async function check_budget_first(ctx) {
  const m = ctx.load('decisions');
  const {pick, picks} = picker(ctx);
  ctx.redis.set('budget:cy', '50', 'EX', 1_200);
  let out = await m.propose('cy', 'mobility', QUESTION, pick);
  assert.equal(out.status, 'over_budget', \`a user at 50 queries must get over_budget, got \${JSON.stringify(out)}\`);
  assert.equal(picks.length, 0, \`the table agent was called \${picks.length} time(s) for a user already over budget: reserve before the agent call\`);
  assert(out.retry_after >= 1_190 && out.retry_after <= 1_200, \`retry_after must be the window's TTL (about 1200 s), got \${out.retry_after}\`);
  assert.equal(ctx.redis.get('budget:cy'), '50', \`a refused query must not count, budget:cy holds \${ctx.redis.get('budget:cy')}\`);
  out = await m.propose('dee', 'mobility', QUESTION, pick);
  assert(out.status === 'proposed' && JSON.stringify(out.tables) === JSON.stringify(['trips', 'drivers']), \`a user within budget gets the proposal, got \${JSON.stringify(out)}\`);
  assert.equal(ctx.redis.get('budget:dee'), '1', \`the proposal counts against dee's budget, budget:dee holds \${ctx.redis.get('budget:dee')}\`);
}
`,
    go: `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"querygen/agents"

	"leetbuild/harness"
)

const decisionsQuestion = "Trips in Seattle last week"

func decisionsPicker() (TablePicker, *int) {
	picks := 0
	return func(_ context.Context, question, workspace string) ([]string, error) {
		picks++
		return agents.PickTables(question, workspace), nil
	}, &picks
}

func decisionsTables(ctx *harness.Ctx, workspace, question string, pick TablePicker) []string {
	tables, err := tablesFor(context.Background(), workspace, question, pick)
	ctx.NoError(err, "tablesFor(%q, %q)", workspace, question)
	return tables
}

func decisionsReserve(ctx *harness.Ctx, user string) (bool, int64) {
	allowed, retryAfter, err := reserve(context.Background(), user)
	ctx.NoError(err, "reserve(%q)", user)
	return allowed, retryAfter
}

func CheckNormalisedKey(ctx *harness.Ctx) {
	pick, picks := decisionsPicker()
	first := decisionsTables(ctx, "mobility", decisionsQuestion, pick)
	ctx.Equal(first, []string{"trips", "drivers"}, "a miss returns the table agent's pick")
	again := decisionsTables(ctx, "mobility", "  trips IN seattle\\tlast   week ", pick)
	ctx.Equal(*picks, 1, "the same question with other capitals and spacing asked the table agent again (normalise before you hash); picks")
	ctx.Equal(again, first, "the cache hit must return the cached tables")
	sum := sha256.Sum256([]byte("trips in seattle last week"))
	key := "decision:mobility:" + hex.EncodeToString(sum[:])
	_, ok := ctx.Redis.Get(key)
	ctx.Assert(ok, "the decision must live at decision:{workspace}:{sha256 of the normalised question}, keys are %v", ctx.Redis.Keys("decision:*"))
	ads := decisionsTables(ctx, "ads", decisionsQuestion, pick)
	ctx.Assert(*picks == 2 && len(ads) == 1 && ads[0] == "ad_campaigns", "an Ads question must not read Mobility's decision: %d picks, tables %v", *picks, ads)
}

func CheckDecisionTtl(ctx *harness.Ctx) {
	pick, picks := decisionsPicker()
	decisionsTables(ctx, "mobility", decisionsQuestion, pick)
	keys := ctx.Redis.Keys("decision:*")
	ctx.Equal(len(keys), 1, "one question, one decision entry; entries")
	ttl := ctx.Redis.TTL(keys[0])
	ctx.Assert(ttl > 86000 && ttl <= 86400, "the decision has TTL %d: it must expire after 86400 s", ttl)
	decisionsTables(ctx, "mobility", decisionsQuestion, pick)
	ctx.Equal(*picks, 1, "within the day the decision is served from the cache; picks")
	ctx.Clock.Advance(86401)
	decisionsTables(ctx, "mobility", decisionsQuestion, pick)
	ctx.Equal(*picks, 2, "a day later the table agent must be asked again (the workspace may have been re-curated); picks")
}

func CheckAtomicBudget(ctx *harness.Ctx) {
	allowed, _ := decisionsReserve(ctx, "ana")
	ctx.Assert(allowed, "a user's first query is within budget")
	used, _ := ctx.Redis.Get("budget:ana")
	ctx.Equal(used, "1", "budget:ana")
	ttl := ctx.Redis.TTL("budget:ana")
	ctx.Assert(ttl > 0 && ttl <= 3600, "budget:ana has TTL %d: the window must expire 3600 s after the first query, or the user is locked out for good", ttl)
	ctx.Redis.Set("budget:bo", 49, "EX", 1800)
	fired, other := false, false
	ctx.Redis.After("budget:bo", func() any {
		// another app server reserving bo's query, landing between two of this server's commands
		fired = true
		raw, _ := ctx.Redis.Get("budget:bo")
		if raw == "50" {
			return nil
		}
		ctx.Redis.Do("INCR", "budget:bo")
		other = true
		return nil
	})
	mine, _ := decisionsReserve(ctx, "bo")
	ctx.Assert(fired, "reserve never touched budget:bo")
	winners := 0
	for _, won := range []bool{mine, other} {
		if won {
			winners++
		}
	}
	ctx.Equal(winners, 1, "two servers reserved bo's 50th query (the read, the check and the increment must run in one script); servers that got through")
	bo, _ := ctx.Redis.Get("budget:bo")
	ctx.Equal(bo, "50", "budget:bo must stop at 50")
	ctx.Clock.Advance(3601)
	allowed, _ = decisionsReserve(ctx, "ana")
	used, _ = ctx.Redis.Get("budget:ana")
	ctx.Assert(allowed && used == "1", "after the hour the window starts over at 1, holds %q", used)
}

func CheckBudgetFirst(ctx *harness.Ctx) {
	pick, picks := decisionsPicker()
	ctx.Redis.Set("budget:cy", 50, "EX", 1200)
	out, err := propose(context.Background(), "cy", "mobility", decisionsQuestion, pick)
	ctx.NoError(err, "propose for cy")
	ctx.Equal(out.Status, "over_budget", "a user at 50 queries")
	ctx.Equal(*picks, 0, "the table agent was called for a user already over budget (reserve before the agent call); picks")
	ctx.Assert(out.RetryAfter >= 1190 && out.RetryAfter <= 1200, "RetryAfter must be the window's TTL (about 1200 s), got %d", out.RetryAfter)
	cy, _ := ctx.Redis.Get("budget:cy")
	ctx.Equal(cy, "50", "a refused query must not count; budget:cy")
	out, err = propose(context.Background(), "dee", "mobility", decisionsQuestion, pick)
	ctx.NoError(err, "propose for dee")
	ctx.Assert(out.Status == "proposed" && len(out.Tables) == 2 && out.Tables[0] == "trips", "a user within budget gets the proposal, got %+v", out)
	dee, _ := ctx.Redis.Get("budget:dee")
	ctx.Equal(dee, "1", "the proposal counts against dee's budget; budget:dee")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <vector>

#include "digest.h"
#include "querygen/agents.h"

namespace {

const std::string kQuestion = "Trips in Seattle last week";

struct Picker {
  int picks = 0;
  TablePicker fn() {
    return [this](const std::string& question, const std::string& workspace) {
      picks++;
      return agents::pick_tables(question, workspace);
    };
  }
};

}  // namespace

void CheckNormalisedKey(harness::Ctx& ctx) {
  Picker p;
  const auto first = tables_for("mobility", kQuestion, p.fn());
  ctx.Equal(first, std::vector<std::string>{"trips", "drivers"}, "a miss returns the table agent's pick");
  const auto again = tables_for("mobility", "  trips IN seattle\\tlast   week ", p.fn());
  ctx.Equal(p.picks, 1, "the same question with other capitals and spacing asked the table agent again (normalise before you hash); picks");
  ctx.Equal(again, first, "the cache hit must return the cached tables");
  const std::string key = "decision:mobility:" + sha256_hex("trips in seattle last week");
  ctx.Assert(ctx.Redis.Get(key).has_value(), "the decision must live at decision:{workspace}:{sha256 of the normalised question}, keys are %v", ctx.Redis.Keys("decision:*"));
  const auto ads = tables_for("ads", kQuestion, p.fn());
  ctx.Assert(p.picks == 2 && ads == std::vector<std::string>{"ad_campaigns"}, "an Ads question must not read Mobility's decision: %d picks, tables %v", p.picks, ads);
}

void CheckDecisionTtl(harness::Ctx& ctx) {
  Picker p;
  tables_for("mobility", kQuestion, p.fn());
  const auto keys = ctx.Redis.Keys("decision:*");
  ctx.Equal(keys.size(), 1, "one question, one decision entry; entries");
  const long long ttl = ctx.Redis.TTL(keys[0]);
  ctx.Assert(ttl > 86000 && ttl <= 86400, "the decision has TTL %d: it must expire after 86400 s", ttl);
  tables_for("mobility", kQuestion, p.fn());
  ctx.Equal(p.picks, 1, "within the day the decision is served from the cache; picks");
  ctx.Clock.Advance(86401);
  tables_for("mobility", kQuestion, p.fn());
  ctx.Equal(p.picks, 2, "a day later the table agent must be asked again (the workspace may have been re-curated); picks");
}

void CheckAtomicBudget(harness::Ctx& ctx) {
  ctx.Assert(reserve("ana").allowed, "a user's first query is within budget");
  ctx.Equal(ctx.Redis.Get("budget:ana").value_or(""), "1", "budget:ana");
  const long long ttl = ctx.Redis.TTL("budget:ana");
  ctx.Assert(ttl > 0 && ttl <= 3600, "budget:ana has TTL %d: the window must expire 3600 s after the first query, or the user is locked out for good", ttl);
  ctx.Redis.Set("budget:bo", 49, "EX", 1800);
  bool fired = false;
  bool other = false;
  ctx.Redis.After("budget:bo", [&] {
    // another app server reserving bo's query, landing between two of this server's commands
    fired = true;
    if (ctx.Redis.Get("budget:bo").value_or("0") == "50") return;
    ctx.Redis.Do("INCR", "budget:bo");
    other = true;
  });
  const bool mine = reserve("bo").allowed;
  ctx.Assert(fired, "reserve never touched budget:bo");
  ctx.Equal(int(mine) + int(other), 1, "two servers reserved bo's 50th query (the read, the check and the increment must run in one script); servers that got through");
  ctx.Equal(ctx.Redis.Get("budget:bo").value_or(""), "50", "budget:bo must stop at 50");
  ctx.Clock.Advance(3601);
  const bool next = reserve("ana").allowed;
  ctx.Assert(next && ctx.Redis.Get("budget:ana").value_or("") == "1", "after the hour the window starts over at 1, holds %s", ctx.Redis.Get("budget:ana").value_or("(none)"));
}

void CheckBudgetFirst(harness::Ctx& ctx) {
  Picker p;
  ctx.Redis.Set("budget:cy", 50, "EX", 1200);
  Proposal out = propose("cy", "mobility", kQuestion, p.fn());
  ctx.Equal(out.status, "over_budget", "a user at 50 queries");
  ctx.Equal(p.picks, 0, "the table agent was called for a user already over budget (reserve before the agent call); picks");
  ctx.Assert(out.retry_after >= 1190 && out.retry_after <= 1200, "retry_after must be the window's TTL (about 1200 s), got %d", out.retry_after);
  ctx.Equal(ctx.Redis.Get("budget:cy").value_or(""), "50", "a refused query must not count; budget:cy");
  out = propose("dee", "mobility", kQuestion, p.fn());
  ctx.Assert(out.status == "proposed" && out.tables == std::vector<std::string>{"trips", "drivers"}, "a user within budget gets the proposal, got %s", out.status);
  ctx.Equal(ctx.Redis.Get("budget:dee").value_or(""), "1", "the proposal counts against dee's budget; budget:dee");
}
`,
  },
  hints: [
    'Symptom: "Trips in Seattle" asks the table agent again after "trips in seattle" was cached, an Ads question can get Mobility\'s tables, two servers both let a user\'s 51st query through, and a user who hit the limit stays locked out the next day.',
    'Mechanism: the key is the raw question with no workspace and the `SET` has no expiry; `reserve` is a GET, a compare and an INCR in separate round trips on a key that never expires; `propose` calls the table agent before it reserves.',
    'Change: `decision:{workspace}:{sha256(normalised)}` with `ex=DECISION_TTL_S`; one `register_script`/`eval` that GETs, refuses at the limit with the TTL, INCRs and EXPIREs on 1; in `propose`, `reserve` first and return before `pick_tables`.',
  ],
  debrief: `A cache key is a statement about which requests are the same. Normalising the question and adding the workspace says capitals and spacing do not matter and the curated table set does; the TTL says a decision is only as good as the curation it came from. The budget is one script because Redis runs a script alone: no other server's command lands between the read and the increment, and the expiry set on the first query starts the window. Reserving before the agent call is step 1's rule again: refuse while refusing is free. A fixed hour lets a user spend 100 queries across a window boundary; services that care use a sliding window or a token bucket in the same single script.`,
};
