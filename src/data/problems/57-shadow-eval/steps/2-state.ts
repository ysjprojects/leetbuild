import type {Step} from '@/lib/types';

export const shadowStateStep: Step = {
  id: 'state',
  title: 'Redis shadow state with isolated namespaces',
  concept: 'redis',
  file: 'state',
  focus: ['shadow', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it reads a config flag, checks
a budget and lets the shadow proceed. It compiles and the demo admits traffic. What it does when a
shadow is disabled or when it runs out of budget is the flaw. Review it, fix it, and prove the fix.

Implement the Redis state layer the request path calls before it runs a shadow.

- Every key is scoped to the config: \`shadow:{config_id}:…\`. The shadow's state never shares a key
  with production, so a shadow at 20 percent can never draw down a tenant's production quota.
- The config's enabled state is **one atomic flag** at \`shadow:{config_id}:enabled\`, read **once per
  request**. There is no per-shard copy: a disable must take effect fleet-wide on the very next
  request, not after every instance happens to refresh.
- The shadow budget lives at \`shadow:{config_id}:budget\` with its **own** cap and TTL, reserved by
  **one atomic operation** (a Lua \`EVAL\`/script or a single atomic counter) — never a read, a check
  and a separate increment, which two concurrent requests both pass.
- A disabled shadow returns without writing anything: no reservation, no sample counter, no partial
  state left behind.
- The budget key expires on first write (\`EXPIRE\` in the same atomic call), so a stale window cannot
  silently block a config forever.

**Failure mode the checks target.** The draft uses the tenant's **production** rate-limit buckets for
shadow traffic, so a shadow can exhaust a tenant's real quota; it toggles the flag per shard, so some
instances keep shadowing after a disable; and it reserves with GET-then-INCR, so two concurrent
shadows both spend the last unit of budget. A disabled shadow still leaves a half-written counter.`,
  sequence: {
    participants: ['Shadow Service', 'Redis'],
    messages: [
      {from: 'Shadow Service', to: 'Redis', label: 'GET shadow:{cfg}:enabled (once per request)', kind: 'sync'},
      {from: 'Redis', to: 'Shadow Service', label: '"1" / nil', kind: 'reply'},
      {from: 'Shadow Service', to: 'Shadow Service', label: 'disabled → return, write nothing', kind: 'sync'},
      {from: 'Shadow Service', to: 'Redis', label: 'EVAL reserve shadow:{cfg}:budget · TTL', kind: 'sync'},
      {from: 'Redis', to: 'Shadow Service', label: '1 admitted / 0 over budget', kind: 'reply'},
      {from: 'Shadow Service', to: 'Redis', label: 'HINCRBY shadow:{cfg}:samples admitted', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'namespace',
      title: 'Every shadow key is scoped to the config',
      detail:
        'All keys are built from the config-scoped prefix `shadow:{config_id}:` (or the stack’s equivalent). The draft writes shadow traffic into the tenant’s production keys, so a shadow spends production budget.',
      match: {
        python: {all: [/SHADOW_PREFIX/, /shadow:\{config_id\}/]},
        typescript: {all: [/SHADOW_PREFIX/, /shadow:\{configId\}/]},
        go: {all: [/shadowPrefix/, /shadow:\{configID\}/]},
        scala: {all: [/ShadowPrefix/, /shadow:\{configId\}/]},
        cpp: {all: [/kShadowPrefix/, /shadow:\{configId\}/]},
      },
    },
    {
      id: 'flag',
      title: 'One fleet-wide enabled flag',
      detail:
        'The enabled state is a single key `shadow:{config_id}:enabled`, read once per request. The draft keys the flag per shard, so some instances keep shadowing after a disable.',
      match: {
        python: {all: [/ENABLED_KEY/, /:enabled/]},
        typescript: {all: [/ENABLED_KEY/, /:enabled/]},
        go: {all: [/enabledKey/, /:enabled/]},
        scala: {all: [/EnabledKey/, /:enabled/]},
        cpp: {all: [/kEnabledKey/, /:enabled/]},
      },
    },
    {
      id: 'budget',
      title: 'The shadow draws from its own budget',
      detail:
        'The budget key `shadow:{config_id}:budget` has its own limit, separate from any production counter. The draft spends the tenant’s production quota, so exhausting the shadow starves the real path.',
      match: {
        python: {all: [/BUDGET_KEY/, /BUDGET_LIMIT/]},
        typescript: {all: [/BUDGET_KEY/, /BUDGET_LIMIT/]},
        go: {all: [/budgetKey/, /budgetLimit/]},
        scala: {all: [/BudgetKey/, /BudgetLimit/]},
        cpp: {all: [/kBudgetKey/, /kBudgetLimit/]},
      },
    },
    {
      id: 'atomic',
      title: 'Reserves the budget atomically with a TTL',
      detail:
        'The reservation is one atomic script (`EVAL`/`NewScript`/`eval`) that refunds an over-budget increment and sets the TTL on first write. The draft does GET-then-INCR, so two concurrent shadows both spend the last unit.',
      match: {
        python: {all: [/RESERVE_LUA/, /\.eval\(/]},
        typescript: {all: [/RESERVE_LUA/, /\.eval\(/]},
        go: {all: [/reserveLua/, /NewScript\(/]},
        scala: {all: [/ReserveLua/, /\.eval\(/]},
        cpp: {all: [/kReserveLua/, /\.eval[<(]/]},
      },
    },
    {
      id: 'no-partial',
      title: 'Reads the flag before it writes anything',
      detail:
        'The enabled flag is read before the budget reservation, so a disabled shadow leaves no partial state (no reservation, no counter). The draft admits first and cleans up later, if at all.',
      match: {
        python: {order: [/admit\(/, /self\.enabled\(config_id\)/, /self\.redis\.eval\(/]},
        typescript: {order: [/admit\(/, /this\.enabled\(configId\)/, /this\.redis\.eval\(/]},
        go: {order: [/Admit\(/, /s\.enabled\(/, /\.Run\(/]},
        scala: {order: [/def admit/, /this\.enabled\(configId\)/, /\.eval\(/]},
        cpp: {order: [/bool admit\(/, /enabled\(configId\)/, /\.eval[<(]/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

logger = logging.getLogger("shadow.state")

PRODUCTION_QUOTA_KEY = "quota:{tenant}:{window}"
PRODUCTION_LIMIT = 1000


class ShadowState:
    def __init__(self, redis):
        self.redis = redis

    def is_enabled(self, config_id: str, shard: str) -> bool:
        """The draft toggles the flag per shard, so a disable is not fleet-wide."""
        return self.redis.get(f"shadow:enabled:{config_id}:{shard}") == "1"

    def admit(self, config_id: str, tenant: str) -> bool:
        # TODO: the draft reads the flag per shard, draws the shadow from the tenant's production
        # quota, and reserves with GET-then-INCR so two concurrent shadows double-spend. A disabled
        # shadow still leaves the counter half-written. Review all four.
        if not self.is_enabled(config_id, "shard-0"):
            return False
        window = int(time.time() // 60)
        key = PRODUCTION_QUOTA_KEY.format(tenant=tenant, window=window)
        used = int(self.redis.get(key) or 0)
        if used >= PRODUCTION_LIMIT:
            return False
        self.redis.incr(key)
        return True
`,
      solution: `import logging

logger = logging.getLogger("shadow.state")

SHADOW_PREFIX = "shadow:"
ENABLED_KEY = "shadow:{config_id}:enabled"
BUDGET_KEY = "shadow:{config_id}:budget"
SAMPLES_KEY = "shadow:{config_id}:samples"
BUDGET_LIMIT = 500
BUDGET_TTL_S = 60
DEFAULT_COST = 1

# One atomic reservation: increment, refund when over budget, expire the key on first write.
RESERVE_LUA = """
local used = redis.call('INCRBY', KEYS[1], ARGV[1])
if used > tonumber(ARGV[2]) then
  redis.call('DECRBY', KEYS[1], ARGV[1])
  return 0
end
if used == tonumber(ARGV[1]) then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return 1
"""


class ShadowState:
    def __init__(self, redis):
        self.redis = redis

    def enabled(self, config_id: str) -> bool:
        """The single fleet-wide flag: one key, no per-shard suffix."""
        return self.redis.get(ENABLED_KEY.format(config_id=config_id)) == "1"

    def admit(self, config_id: str, cost: int = DEFAULT_COST) -> bool:
        # Read the fleet-wide flag once, before any write: a disabled shadow writes nothing.
        if not self.enabled(config_id):
            return False
        reserved = self.redis.eval(
            RESERVE_LUA,
            1,
            BUDGET_KEY.format(config_id=config_id),
            cost,
            BUDGET_LIMIT,
            BUDGET_TTL_S,
        )
        if reserved != 1:
            return False
        samples = SAMPLES_KEY.format(config_id=config_id)
        self.redis.hincrby(samples, "admitted", 1)
        self.redis.expire(samples, BUDGET_TTL_S)
        return True
`,
    },
    typescript: {
      starter: `/** Redis shadow state: a model-generated draft that shares production state. */
import type {Redis} from 'ioredis';

const PRODUCTION_QUOTA_KEY = 'quota:{tenant}:{window}';
const PRODUCTION_LIMIT = 1000;

export class ShadowState {
  constructor(private readonly redis: Redis) {}

  private async isEnabled(configId: string, shard: string): Promise<boolean> {
    return (await this.redis.get(\`shadow:enabled:\${configId}:\${shard}\`)) === '1';
  }

  async admit(configId: string, tenant: string): Promise<boolean> {
    // TODO: the draft reads the flag per shard, draws the shadow from the tenant's production
    // quota, and reserves with GET-then-INCR so two concurrent shadows double-spend. A disabled
    // shadow still leaves the counter half-written. Review all four.
    if (!(await this.isEnabled(configId, 'shard-0'))) return false;
    const window = Math.floor(Date.now() / 60000);
    const key = PRODUCTION_QUOTA_KEY.replace('{tenant}', tenant).replace('{window}', String(window));
    const used = Number((await this.redis.get(key)) ?? 0);
    if (used >= PRODUCTION_LIMIT) return false;
    await this.redis.incr(key);
    return true;
  }
}
`,
      solution: `/** Redis shadow state: config-scoped keys, one fleet-wide flag, its own budget. */
import type {Redis} from 'ioredis';

export const SHADOW_PREFIX = 'shadow:';
export const ENABLED_KEY = 'shadow:{configId}:enabled';
export const BUDGET_KEY = 'shadow:{configId}:budget';
export const SAMPLES_KEY = 'shadow:{configId}:samples';
export const BUDGET_LIMIT = 500;
export const BUDGET_TTL_S = 60;

/** One atomic reservation: increment, refund when over budget, expire the key on first write. */
export const RESERVE_LUA = \`
local used = redis.call('INCRBY', KEYS[1], ARGV[1])
if used > tonumber(ARGV[2]) then
  redis.call('DECRBY', KEYS[1], ARGV[1])
  return 0
end
if used == tonumber(ARGV[1]) then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return 1
\`;

const keyOf = (template: string, configId: string): string => template.replace('{configId}', configId);

export class ShadowState {
  constructor(private readonly redis: Redis) {}

  /** The single fleet-wide flag: one key, no per-shard suffix. */
  private async enabled(configId: string): Promise<boolean> {
    return (await this.redis.get(keyOf(ENABLED_KEY, configId))) === '1';
  }

  async admit(configId: string, cost = 1): Promise<boolean> {
    // Read the fleet-wide flag once, before any write: a disabled shadow writes nothing.
    if (!(await this.enabled(configId))) return false;
    const reserved = await this.redis.eval(
      RESERVE_LUA,
      1,
      keyOf(BUDGET_KEY, configId),
      cost,
      BUDGET_LIMIT,
      BUDGET_TTL_S,
    );
    if (reserved !== 1) return false;
    const samples = keyOf(SAMPLES_KEY, configId);
    await this.redis.hincrby(samples, 'admitted', 1);
    await this.redis.expire(samples, BUDGET_TTL_S);
    return true;
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	productionQuotaKey = "quota:{tenant}:{window}"
	productionLimit    = 1000
)

type ShadowState struct {
	redis *redis.Client
}

func NewShadowState(client *redis.Client) *ShadowState {
	return &ShadowState{redis: client}
}

func (s *ShadowState) isEnabled(ctx context.Context, configID, shard string) bool {
	value, _ := s.redis.Get(ctx, fmt.Sprintf("shadow:enabled:%s:%s", configID, shard)).Result()
	return value == "1"
}

func (s *ShadowState) Admit(ctx context.Context, configID, tenant string) bool {
	// TODO: the draft reads the flag per shard, draws the shadow from the tenant's production
	// quota, and reserves with GET-then-INCR so two concurrent shadows double-spend. A disabled
	// shadow still leaves the counter half-written. Review all four.
	if !s.isEnabled(ctx, configID, "shard-0") {
		return false
	}
	window := time.Now().Unix() / 60
	key := fmt.Sprintf(productionQuotaKey, tenant, window)
	used, _ := s.redis.Get(ctx, key).Int()
	if used >= productionLimit {
		return false
	}
	s.redis.Incr(ctx, key)
	return true
}
`,
      solution: `package main

import (
	"context"
	"strings"

	"github.com/redis/go-redis/v9"
)

const (
	shadowPrefix  = "shadow:"
	enabledKey    = "shadow:{configID}:enabled"
	budgetKey     = "shadow:{configID}:budget"
	samplesKey    = "shadow:{configID}:samples"
	budgetLimit   = 500
	budgetTTLSecs = 60
)

// One atomic reservation: increment, refund when over budget, expire the key on first write.
const reserveLua = \`
local used = redis.call('INCRBY', KEYS[1], ARGV[1])
if used > tonumber(ARGV[2]) then
  redis.call('DECRBY', KEYS[1], ARGV[1])
  return 0
end
if used == tonumber(ARGV[1]) then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return 1
\`

type ShadowState struct {
	redis   *redis.Client
	reserve *redis.Script
}

func NewShadowState(client *redis.Client) *ShadowState {
	return &ShadowState{redis: client, reserve: redis.NewScript(reserveLua)}
}

func keyOf(template, configID string) string {
	return strings.ReplaceAll(template, "{configID}", configID)
}

// enabled reads the single fleet-wide flag: one key, no per-shard suffix.
func (s *ShadowState) enabled(ctx context.Context, configID string) (bool, error) {
	value, err := s.redis.Get(ctx, keyOf(enabledKey, configID)).Result()
	return value == "1", err
}

func (s *ShadowState) Admit(ctx context.Context, configID string, cost int) (bool, error) {
	// Read the fleet-wide flag once, before any write: a disabled shadow writes nothing.
	on, err := s.enabled(ctx, configID)
	if err != nil || !on {
		return false, err
	}
	reserved, err := s.reserve.Run(ctx, s.redis, []string{keyOf(budgetKey, configID)}, cost, budgetLimit, budgetTTLSecs).Int()
	if err != nil || reserved != 1 {
		return false, err
	}
	samples := keyOf(samplesKey, configID)
	s.redis.HIncrBy(ctx, samples, "admitted", 1)
	s.redis.Expire(ctx, samples, budgetTTLSecs)
	return true, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

final class ShadowState(jedis: Jedis) {
  private def isEnabled(configId: String, shard: String): Boolean =
    jedis.get(s"shadow:enabled:$configId:$shard") == "1"

  def admit(configId: String, tenant: String): Boolean = {
    // TODO: the draft reads the flag per shard, draws the shadow from the tenant's production
    // quota, and reserves with GET-then-INCR so two concurrent shadows double-spend. A disabled
    // shadow still leaves the counter half-written. Review all four.
    if (!isEnabled(configId, "shard-0")) return false
    val window = (System.currentTimeMillis() / 60000L).toString
    val key = s"quota:$tenant:$window"
    val used = Option(jedis.get(key)).map(_.toInt).getOrElse(0)
    if (used >= 1000) return false
    jedis.incr(key)
    true
  }
}
`,
      solution: `import redis.clients.jedis.Jedis

object ShadowState {
  val ShadowPrefix = "shadow:"
  val EnabledKey = "shadow:{configId}:enabled"
  val BudgetKey = "shadow:{configId}:budget"
  val SamplesKey = "shadow:{configId}:samples"
  val BudgetLimit = 500
  val BudgetTtlSeconds = 60

  /** One atomic reservation: increment, refund when over budget, expire the key on first write. */
  val ReserveLua =
    """
      |local used = redis.call('INCRBY', KEYS[1], ARGV[1])
      |if used > tonumber(ARGV[2]) then
      |  redis.call('DECRBY', KEYS[1], ARGV[1])
      |  return 0
      |end
      |if used == tonumber(ARGV[1]) then
      |  redis.call('EXPIRE', KEYS[1], ARGV[3])
      |end
      |return 1
      |""".stripMargin

  def keyOf(template: String, configId: String): String = template.replace("{configId}", configId)
}

final class ShadowState(jedis: Jedis) {
  import ShadowState._

  /** The single fleet-wide flag: one key, no per-shard suffix. */
  def enabled(configId: String): Boolean =
    jedis.get(keyOf(EnabledKey, configId)) == "1"

  def admit(configId: String, cost: Int = 1): Boolean = {
    // Read the fleet-wide flag once, before any write: a disabled shadow writes nothing.
    if (!this.enabled(configId)) return false
    val reserved = jedis.eval(
      ReserveLua,
      java.util.List.of(keyOf(BudgetKey, configId)),
      java.util.List.of(cost.toString, BudgetLimit.toString, BudgetTtlSeconds.toString)
    )
    if (reserved.toString.toInt != 1) return false
    val samples = keyOf(SamplesKey, configId)
    jedis.hincrBy(samples, "admitted", 1)
    jedis.expire(samples, BudgetTtlSeconds.toLong)
    true
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

using sw::redis::Redis;

constexpr int kProductionLimit = 1000;

class ShadowState {
 public:
  explicit ShadowState(Redis& redis) : redis_(redis) {}

  bool isEnabled(const std::string& configId, const std::string& shard) {
    auto value = redis_.get("shadow:enabled:" + configId + ":" + shard);
    return value && *value == "1";
  }

  bool admit(const std::string& configId, const std::string& tenant) {
    // TODO: the draft reads the flag per shard, draws the shadow from the tenant's production
    // quota, and reserves with GET-then-INCR so two concurrent shadows double-spend. A disabled
    // shadow still leaves the counter half-written. Review all four.
    if (!isEnabled(configId, "shard-0")) return false;
    auto used = redis_.get("quota:" + tenant);
    if (used && std::stoi(*used) >= kProductionLimit) return false;
    redis_.incr("quota:" + tenant);
    return true;
  }

 private:
  Redis& redis_;
};
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

using sw::redis::Redis;

const std::string kShadowPrefix = "shadow:";
const std::string kEnabledKey = "shadow:{configId}:enabled";
const std::string kBudgetKey = "shadow:{configId}:budget";
const std::string kSamplesKey = "shadow:{configId}:samples";
constexpr int kBudgetLimit = 500;
constexpr int kBudgetTtlSeconds = 60;

// One atomic reservation: increment, refund when over budget, expire the key on first write.
const std::string kReserveLua = R"(
local used = redis.call('INCRBY', KEYS[1], ARGV[1])
if used > tonumber(ARGV[2]) then
  redis.call('DECRBY', KEYS[1], ARGV[1])
  return 0
end
if used == tonumber(ARGV[1]) then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return 1
)";

std::string keyOf(const std::string& tmpl, const std::string& configId) {
  auto out = tmpl;
  const std::string needle = "{configId}";
  for (auto pos = out.find(needle); pos != std::string::npos; pos = out.find(needle, pos))
    out.replace(pos, needle.size(), configId);
  return out;
}

class ShadowState {
 public:
  explicit ShadowState(Redis& redis) : redis_(redis) {}

  /** The single fleet-wide flag: one key, no per-shard suffix. */
  bool enabled(const std::string& configId) {
    auto value = redis_.get(keyOf(kEnabledKey, configId));
    return value && *value == "1";
  }

  bool admit(const std::string& configId, int cost = 1) {
    // Read the fleet-wide flag once, before any write: a disabled shadow writes nothing.
    if (!enabled(configId)) return false;
    auto reserved = redis_.eval<int>(
        kReserveLua,
        {keyOf(kBudgetKey, configId)},
        {std::to_string(cost), std::to_string(kBudgetLimit), std::to_string(kBudgetTtlSeconds)});
    if (reserved != 1) return false;
    const auto samples = keyOf(kSamplesKey, configId);
    redis_.hincrby(samples, "admitted", 1);
    redis_.expire(samples, std::chrono::seconds(kBudgetTtlSeconds));
    return true;
  }

 private:
  Redis& redis_;
};
`,
    },
  },
  hints: [
    'Isolate first, then meter: every key includes the config id, so `shadow:{config_id}:budget` and `shadow:{config_id}:enabled` can never collide with `quota:{tenant}:…`. If you cannot point at the prefix in the key you just built, the shadow can reach production.',
    'One atomic operation for the reservation. Read the counter, compare it and write it back in one Lua `EVAL` that also sets the TTL on the first increment; a GET followed by an INCR is a race that two concurrent shadows both win.',
    'Read the flag once, before any write, from one key. A per-shard or per-instance flag means a disable is only eventually true; an early return before the reservation is what guarantees a disabled shadow leaves no partial state behind.',
  ],
  debrief: `The interviewer is testing whether you can keep a shadow off production state, which is a data-model question, not a Redis trivia question. Three defects are being checked. The namespace: if shadow keys are not scoped by config id they collide with the tenant's production keys, and then a 20 percent shadow can exhaust 100 percent of a tenant's quota — the shadow reached production without calling it. The flag: a per-shard enabled key makes a disable eventually consistent, so the operator turns the shadow off and some instances keep observing. The reservation: GET-then-INCR is the classic read-modify-write race; only one atomic script that increments, refunds and sets the TTL on first write is safe under concurrency, and it is also what makes a disabled shadow leave no partial state. Real runners add a config version to every key so a rolled-back config cannot read the previous run's counters.`,
};
