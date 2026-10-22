import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis policy cache and violation counters',
  concept: 'redis',
  file: 'state',
  focus: ['guardrail', 'redis', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: the rule set lands in Redis and
the counter moves, so the demo shows a cached policy and a rising block count. It publishes half a
policy to every reader that arrives mid-refresh, it loses counts under concurrency, and it keeps every
tenant's counter alive forever. Review it, fix it, and prove the fix with the checks below.

Implement the two Redis paths the check endpoint depends on.

- **Policy cache.** \`refreshPolicy(tenant, rules, version)\` publishes the tenant's rule set at
  \`guardrails:policies:{tenant}\`: build the **whole** object in memory, serialise it, and publish it
  with **one \`SET\`** carrying \`POLICY_TTL_S = 300\` seconds. The draft refreshes from a background
  thread that writes field by field (\`HSET\` per rule), so a request that reads the cache during a
  refresh sees a half-written rule set — and a half-written gate allows what the new version blocks.
- **Violation counters.** \`recordBlock(tenant)\` increments the block count for the **current hour
  window**: key \`guardrails:violations:{tenant}:{bucket}\`, where
  \`bucket = now // WINDOW_S\` and \`WINDOW_S = 3600\`. The draft does a client-side \`GET\` and then
  \`SET\`s the number it read, so two blocks that land together both read the same value and one
  increment is lost — which is exactly the number a reviewer trusts.
- Both paths are **per tenant**: \`guardrails:policies:{tenant}\` and
  \`guardrails:violations:{tenant}:…\`. A shared key would mix tenants' policies and counts.
- The increment and the window expiry happen in **one Lua \`EVAL\`**: \`INCR\` the key, and only when
  the writer actually created it (\`count == 1\`) set \`EXPIRE\` to the seconds left in the hour
  (\`WINDOW_S - now % WINDOW_S\`). The draft sets no TTL at all, so the counter outlives the tenant,
  the release and any reason anyone had for the number.
- Return what the caller reads: the fresh count and the seconds until the window resets.

**Failure mode the checks target.** The subtle one is the partial refresh: HSET-per-rule looks
harmless until a rule promotion races a request, and the gate answers from a rule set that never
existed. The loud one is the lost increment under concurrency, and the silent one is the missing
\`EXPIRE\`: a counter with no TTL grows a key per tenant per hour forever.`,
  sequence: {
    participants: ['Guardrail worker', 'Second worker', 'Redis'],
    messages: [
      {from: 'Guardrail worker', to: 'Redis', label: 'SET guardrails:policies:acme EX 300 (whole set)', kind: 'sync'},
      {from: 'Guardrail worker', to: 'Redis', label: 'EVAL INCR violations:acme:bucket', kind: 'sync'},
      {from: 'Redis', to: 'Guardrail worker', label: 'count = 1 → script sets EXPIRE', kind: 'reply'},
      {from: 'Second worker', to: 'Redis', label: 'EVAL INCR same window concurrently', kind: 'sync'},
      {from: 'Redis', to: 'Second worker', label: 'count = 2 · both increments survive', kind: 'reply'},
      {from: 'Redis', to: 'Guardrail worker', label: 'key expires at the hour boundary', kind: 'async'},
    ],
  },
  hints: [
    'The refresh is a publish, not a patch: read the tenant’s rules from the config store, build the full payload, and hand it to Redis in one `SET … EX POLICY_TTL_S`. Nothing a reader can observe may be a partially applied rule set.',
    'Everything that decides the count runs inside the script: `INCR` returns the value after the increment, so the client never reads a number it might have to write back. A client-side `GET` followed by `SET` is the race the draft has.',
    'Expire from the script and expire to the **window boundary**, not to a fixed 3600: `remaining = WINDOW_S - now % WINDOW_S` means the key always dies at the end of the hour it belongs to, so the next window starts at zero instead of inheriting a stale count.',
  ],
  checks: [
    {
      id: 'atomic-refresh',
      title: 'Publishes the rule set with one SET',
      detail:
        'The whole rule set is built in memory and written with a single `SET … EX POLICY_TTL_S`. The draft writes field by field with `HSET`, so a reader that arrives mid-refresh sees a partial rule set.',
      match: {
        python: {all: [/POLICY_TTL_S/, /def refresh_policy\(/, /\.set\(/], none: [/hset/]},
        typescript: {all: [/POLICY_TTL_S/, /function refreshPolicy\(/, /\.set\(/], none: [/\.hset\(/]},
        go: {all: [/policyTTLS/, /func refreshPolicy\(/, /\.Set\(/], none: [/\.HSet\(/]},
        scala: {all: [/PolicyTtlS/, /def refreshPolicy\(/, /\.set\(/], none: [/\.hset\(/]},
        cpp: {all: [/kPolicyTtlS/, /refreshPolicy\(/, /\.set\(/], none: [/hset/]},
      },
    },
    {
      id: 'counter-script',
      title: 'Moves the violation counter with one script',
      detail:
        'The increment is one Lua `EVAL` (`VIOLATION_LUA`) containing `INCR`. The draft reads with `GET` and writes the value back from the client, so two concurrent blocks lose an increment.',
      match: {
        python: {all: [/VIOLATION_LUA/, /INCR/, /\.eval\(/]},
        typescript: {all: [/VIOLATION_LUA/, /INCR/, /\.eval\(/]},
        go: {all: [/violationLua/, /INCR/, /\.Eval\(/]},
        scala: {all: [/ViolationLua/, /INCR/, /\.eval\(/]},
        cpp: {all: [/kViolationLua/, /INCR/, /\.eval</]},
      },
    },
    {
      id: 'hourly-window',
      title: 'Counts into the current hour window',
      detail:
        'The counter key is `guardrails:violations:{tenant}:{bucket}` with `bucket = now // WINDOW_S` (`WINDOW_S = 3600`), so the count resets at the hour boundary. The draft uses one forever key with no window and no TTL.',
      match: {
        python: {all: [/WINDOW_S/, /violations:/, /bucket/]},
        typescript: {all: [/WINDOW_S/, /violations:/, /bucket/]},
        go: {all: [/windowS/, /violations:/, /bucket/]},
        scala: {all: [/WindowS/, /violations:/, /bucket/]},
        cpp: {all: [/kWindowS/, /violations:/, /bucket/]},
      },
    },
    {
      id: 'tenant-scoped-keys',
      title: 'Scopes both keys to the tenant',
      detail:
        'The cache lives at `guardrails:policies:{tenant}` and the counter at `guardrails:violations:{tenant}:…`, both built from the authenticated tenant. The draft uses tenant-less keys, so one tenant’s rules and blocks are visible to another.',
      match: {
        python: {all: [/guardrails:policies:/, /guardrails:violations:/, /tenant/]},
        typescript: {all: [/guardrails:policies:/, /guardrails:violations:/, /tenant/]},
        go: {all: [/guardrails:policies:/, /guardrails:violations:/, /tenant/]},
        scala: {all: [/guardrails:policies:/, /guardrails:violations:/, /tenant/]},
        cpp: {all: [/guardrails:policies:/, /guardrails:violations:/, /tenant/]},
      },
    },
    {
      id: 'expiry-in-script',
      title: 'Expires the window inside the same script',
      detail:
        'Within the script the `INCR` comes first and the `EXPIRE` follows it, so the key that was just created gets the window TTL. A TTL set from the client after the script can be skipped entirely when the process dies.',
      match: {
        python: {order: [/INCR/, /EXPIRE/]},
        typescript: {order: [/INCR/, /EXPIRE/]},
        go: {order: [/INCR/, /EXPIRE/]},
        scala: {order: [/INCR/, /EXPIRE/]},
        cpp: {order: [/INCR/, /EXPIRE/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import threading
import time

import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Rule(BaseModel):
    id: str
    pattern: str
    severity: str


def cache_key() -> str:
    return "policies:cache"


def counter_key() -> str:
    return "violations:count"


def refresh(tenant: str, rules: list[Rule], version: int) -> None:
    # The draft refreshes in the background, one rule at a time.
    threading.Thread(target=_write_fields, args=(tenant, rules, version), daemon=True).start()


def _write_fields(tenant: str, rules: list[Rule], version: int) -> None:
    for rule in rules:
        r.hset(cache_key(), rule.id, json.dumps({"pattern": rule.pattern, "severity": rule.severity}))


def record_block(tenant: str) -> dict:
    # TODO: publish the whole rule set with one SET and POLICY_TTL_S, INCR the per-tenant counter for
    # the current hour window inside one script, and set the window EXPIRE from that same script.
    current = int(r.get(counter_key()) or 0)
    r.set(counter_key(), current + 1)
    return {"count": current + 1, "window_ends_in": 3600 - int(time.time()) % 3600}
`,
      solution: `import json
import time

import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

POLICY_TTL_S = 300
WINDOW_S = 3600

# INCR first; only the writer that created the key sets the window expiry.
VIOLATION_LUA = """
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
"""


class Rule(BaseModel):
    id: str
    pattern: str
    severity: str


def policy_key(tenant: str) -> str:
    return f"guardrails:policies:{tenant}"


def violation_key(tenant: str, now: int) -> str:
    bucket = now // WINDOW_S
    return f"guardrails:violations:{tenant}:{bucket}"


def refresh_policy(tenant: str, rules: list[Rule], version: int) -> None:
    """Build the whole set, then publish it with one SET: a reader never sees a partial rule set."""
    payload = json.dumps({"tenant": tenant, "version": version, "rules": [r.model_dump() for r in rules]})
    r.set(policy_key(tenant), payload, ex=POLICY_TTL_S)


def load_policy(tenant: str) -> dict | None:
    payload = r.get(policy_key(tenant))
    return json.loads(payload) if payload else None


def record_block(tenant: str, now: int | None = None) -> dict:
    instant = int(time.time()) if now is None else now
    remaining = WINDOW_S - instant % WINDOW_S
    count = int(r.eval(VIOLATION_LUA, 1, violation_key(tenant, instant), remaining))
    return {"count": count, "window_ends_in": remaining}
`,
    },
    typescript: {
      starter: `/** Policy cache and violation counter: a model-generated draft that patches and loses counts. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const cacheKey = (): string => 'policies:cache';
const counterKey = (): string => 'violations:count';

export interface Rule {
  id: string;
  pattern: string;
  severity: string;
}

export async function refresh(tenant: string, rules: Rule[], version: number): Promise<void> {
  // The draft refreshes in the background, one rule at a time.
  for (const rule of rules) {
    await r.hset(cacheKey(), rule.id, JSON.stringify({pattern: rule.pattern, severity: rule.severity}));
  }
}

export async function recordBlock(tenant: string): Promise<{count: number; window_ends_in: number}> {
  // TODO: publish the whole rule set with one SET and POLICY_TTL_S, INCR the per-tenant counter for
  // the current hour window inside one script, and set the window EXPIRE from that same script.
  const current = Number((await r.get(counterKey())) ?? 0);
  await r.set(counterKey(), String(current + 1));
  return {count: current + 1, window_ends_in: 3600 - (Math.floor(Date.now() / 1000) % 3600)};
}
`,
      solution: `/** Policy cache and violation counter: one SET to publish, one script to count. */
import {Redis} from 'ioredis';

const r = new Redis('redis://redis:6379');

const POLICY_TTL_S = 300;
const WINDOW_S = 3600;

// INCR first; only the writer that created the key sets the window expiry.
const VIOLATION_LUA = \`
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
\`;

export interface Rule {
  id: string;
  pattern: string;
  severity: string;
}

function policyKey(tenant: string): string {
  return \`guardrails:policies:\${tenant}\`;
}

function violationKey(tenant: string, now: number): string {
  const bucket = Math.floor(now / WINDOW_S);
  return \`guardrails:violations:\${tenant}:\${bucket}\`;
}

/** Build the whole set, then publish it with one SET: a reader never sees a partial rule set. */
export async function refreshPolicy(tenant: string, rules: Rule[], version: number): Promise<void> {
  await r.set(policyKey(tenant), JSON.stringify({tenant, version, rules}), 'EX', POLICY_TTL_S);
}

export async function loadPolicy(tenant: string): Promise<{tenant: string; version: number; rules: Rule[]} | null> {
  const payload = await r.get(policyKey(tenant));
  return payload === null ? null : (JSON.parse(payload) as {tenant: string; version: number; rules: Rule[]});
}

export async function recordBlock(
  tenant: string,
  now = Math.floor(Date.now() / 1000),
): Promise<{count: number; window_ends_in: number}> {
  const remaining = WINDOW_S - (now % WINDOW_S);
  const count = (await r.eval(VIOLATION_LUA, 1, violationKey(tenant, now), String(remaining))) as number;
  return {count, window_ends_in: remaining};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Rule struct {
	ID       string \`json:"id"\`
	Pattern  string \`json:"pattern"\`
	Severity string \`json:"severity"\`
}

func cacheKey() string   { return "policies:cache" }
func counterKey() string { return "violations:count" }

// refresh publishes one field at a time, in the background.
func refresh(ctx context.Context, tenant string, rules []Rule, version int) {
	go func() {
		for _, rule := range rules {
			payload, _ := json.Marshal(rule)
			rdb.HSet(ctx, cacheKey(), rule.ID, payload)
		}
	}()
}

func recordBlock(ctx context.Context, tenant string) (int64, int64, error) {
	// TODO: publish the whole rule set with one Set and policyTTLS, INCR the per-tenant counter for
	// the current hour window inside one script, and set the window EXPIRE from that same script.
	current, _ := rdb.Get(ctx, counterKey()).Int64()
	if err := rdb.Set(ctx, counterKey(), current+1, 0).Err(); err != nil {
		return 0, 0, err
	}
	remaining := int64(3600) - time.Now().Unix()%3600
	return current + 1, remaining, nil
}

func main() {
	log.Println(fmt.Sprintf("guardrail state ready: %s", cacheKey()))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	policyTTLS = 300
	windowS    = 3600
)

// INCR first; only the writer that created the key sets the window expiry.
const violationLua = \`
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
\`

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type Rule struct {
	ID       string \`json:"id"\`
	Pattern  string \`json:"pattern"\`
	Severity string \`json:"severity"\`
}

type RuleSet struct {
	Tenant  string \`json:"tenant"\`
	Version int    \`json:"version"\`
	Rules   []Rule \`json:"rules"\`
}

func policyKey(tenant string) string { return fmt.Sprintf("guardrails:policies:%s", tenant) }

func violationKey(tenant string, now int64) string {
	bucket := now / windowS
	return fmt.Sprintf("guardrails:violations:%s:%d", tenant, bucket)
}

// refreshPolicy builds the whole set, then publishes it with one Set: a reader never sees a partial set.
func refreshPolicy(ctx context.Context, tenant string, rules []Rule, version int) error {
	payload, err := json.Marshal(RuleSet{Tenant: tenant, Version: version, Rules: rules})
	if err != nil {
		return err
	}
	return rdb.Set(ctx, policyKey(tenant), payload, policyTTLS*time.Second).Err()
}

func loadPolicy(ctx context.Context, tenant string) (*RuleSet, error) {
	payload, err := rdb.Get(ctx, policyKey(tenant)).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var set RuleSet
	if err := json.Unmarshal([]byte(payload), &set); err != nil {
		return nil, err
	}
	return &set, nil
}

// recordBlock runs one script: INCR the hour's counter, and only the creator sets the expiry.
func recordBlock(ctx context.Context, tenant string, now time.Time) (int64, int64, error) {
	instant := now.Unix()
	remaining := int64(windowS) - instant%int64(windowS)
	count, err := rdb.Eval(ctx, violationLua, []string{violationKey(tenant, instant)}, remaining).Int64()
	if err != nil {
		return 0, 0, err
	}
	return count, remaining, nil
}

func main() {
	log.Println("guardrail state ready: guardrails:policies:{tenant} · guardrails:violations:{tenant}")
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis
import spray.json._
import DefaultJsonProtocol._

final case class Rule(id: String, pattern: String, severity: String)

object GuardrailState {
  implicit val ruleFormat: RootJsonFormat[Rule] = jsonFormat3(Rule)

  val redis = new Jedis("redis", 6379)

  def cacheKey: String = "policies:cache"
  def counterKey: String = "violations:count"

  /** The draft patches the cache one field at a time. */
  def refresh(tenant: String, rules: List[Rule], version: Int): Unit = {
    rules.foreach(rule => redis.hset(cacheKey, rule.id, rule.toJson.compactPrint))
  }

  def recordBlock(tenant: String): (Long, Long) = {
    // TODO: publish the whole rule set with one set and PolicyTtlS, INCR the per-tenant counter for
    // the current hour window inside one script, and set the window EXPIRE from that same script.
    val current = Option(redis.get(counterKey)).map(_.toLong).getOrElse(0L)
    redis.set(counterKey, (current + 1).toString)
    // TODO: give the counter key the window expiry inside the script.
    (current + 1, 3600L - System.currentTimeMillis() / 1000L % 3600L)
  }
}
`,
      solution: `import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams
import spray.json._
import DefaultJsonProtocol._

import scala.jdk.CollectionConverters._

final case class Rule(id: String, pattern: String, severity: String)
final case class RuleSet(tenant: String, version: Int, rules: List[Rule])

object GuardrailState {
  implicit val ruleFormat: RootJsonFormat[Rule] = jsonFormat3(Rule)
  implicit val ruleSetFormat: RootJsonFormat[RuleSet] = jsonFormat3(RuleSet)

  val PolicyTtlS = 300
  val WindowS = 3600L

  // INCR first; only the writer that created the key sets the window expiry.
  val ViolationLua: String =
    """
      |local count = redis.call('INCR', KEYS[1])
      |if count == 1 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[1])
      |end
      |return count
      |""".stripMargin

  val redis = new Jedis("redis", 6379)

  def policyKey(tenant: String): String = s"guardrails:policies:$tenant"

  def violationKey(tenant: String, now: Long): String = {
    val bucket = now / WindowS
    s"guardrails:violations:$tenant:$bucket"
  }

  /** Build the whole set, then publish it with one set: a reader never sees a partial rule set. */
  def refreshPolicy(tenant: String, rules: List[Rule], version: Int): Unit = {
    val payload = RuleSet(tenant, version, rules).toJson.compactPrint
    redis.set(policyKey(tenant), payload, SetParams.setParams().ex(PolicyTtlS))
  }

  def loadPolicy(tenant: String): Option[RuleSet] =
    Option(redis.get(policyKey(tenant))).map(_.parseJson.convertTo[RuleSet])

  def recordBlock(tenant: String, now: Long): (Long, Long) = {
    val remaining = WindowS - now % WindowS
    val count = redis
      .eval(ViolationLua, List(violationKey(tenant, now)).asJava, List(remaining.toString).asJava)
      .asInstanceOf[java.lang.Long]
      .longValue()
    (count, remaining)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

std::string cacheKey() { return "policies:cache"; }
std::string counterKey() { return "violations:count"; }

// The draft patches the cache one field at a time.
void refresh(const std::string& tenant, const std::vector<std::string>& rule_fields) {
  for (const auto& field : rule_fields) {
    redis.hset(cacheKey(), field, "{}");
  }
}

long long recordBlock(const std::string& tenant) {
  // TODO: publish the whole rule set with one set and kPolicyTtlS, INCR the per-tenant counter for
  // the current hour window inside one script, and set the window EXPIRE from that same script.
  auto current = redis.get(counterKey());
  const long long count = current ? std::stoll(*current) : 0;
  redis.set(counterKey(), std::to_string(count + 1));
  return count + 1;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <utility>
#include <vector>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kPolicyTtlS = 300;
constexpr long long kWindowS = 3600;

// INCR first; only the writer that created the key sets the window expiry.
const std::string kViolationLua = R"(
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
)";

std::string policyKey(const std::string& tenant) { return "guardrails:policies:" + tenant; }

std::string violationKey(const std::string& tenant, long long now) {
  const long long bucket = now / kWindowS;
  return "guardrails:violations:" + tenant + ":" + std::to_string(bucket);
}

/** Build the whole set, then publish it with one set: a reader never sees a partial rule set. */
void refreshPolicy(const std::string& tenant, const std::string& rules_json, int version) {
  const std::string payload = R"({"tenant":")" + tenant + R"(","version":)" + std::to_string(version) +
                              R"(,"rules":)" + rules_json + "}";
  redis.set(policyKey(tenant), payload, std::chrono::seconds(kPolicyTtlS));
}

std::optional<std::string> loadPolicy(const std::string& tenant) { return redis.get(policyKey(tenant)); }

std::pair<long long, long long> recordBlock(const std::string& tenant, long long now) {
  const long long remaining = kWindowS - now % kWindowS;
  const long long count = redis.eval<long long>(kViolationLua, {violationKey(tenant, now)}, {std::to_string(remaining)});
  return {count, remaining};
}
`,
    },
  },
  debrief: `The interviewer is testing whether you can review the two Redis paths every guardrail stands on. The draft’s refresh is the subtle one: HSET-per-rule is a patch, so any read that races a promotion sees a rule set that never existed, and the gate allows text the new version blocks — a window where the service is silently weaker than its own config. The counter is the loud one: a client-side GET-then-SET loses increments exactly when blocks arrive together, which is when the number matters. The missing TTL is the quiet one: per-tenant, per-hour keys with no expiry grow without bound. The fix is a publish with a single SET and an increment that happens entirely inside one script, including the expiry. Real deployments add a ruleset version to the cache value so a stale read is detectable, and they reconcile counters from the Kafka review queue rather than trusting Redis alone.`,
};
