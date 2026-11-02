import type {Step} from '@/lib/types';

export const shadowStateStep: Step = {
  id: 'state',
  title: 'Redis shadow state with isolated namespaces',
  concept: 'redis',
  file: 'state',
  focus: ['shadow', 'redis'],
  task: `## Task

**Starting point.** The starter is the Redis state layer the request path calls before it runs a
shadow: \`admit\` reads an enabled flag keyed by shard, then reads the tenant's production quota
counter, compares it with \`PRODUCTION_LIMIT\` and increments it. It compiles, the demo admits
traffic, and it hides five flaws.

**Failure mode the checks target.** A shadow that spends production state. The starter meters
shadow traffic on the tenant's production quota key, so a 20 percent shadow can exhaust a tenant's
real quota; it reads a per-shard flag, so some instances keep shadowing after a disable; and it
reserves with GET-then-INCR, so two concurrent shadows both spend the last unit.

Requirements:

- Every key is scoped to the config: \`shadow:{config_id}:…\`, sharing no key with production.
- The enabled state is **one atomic flag** at \`shadow:{config_id}:enabled\`, read **once per
  request**; no per-shard copy, so a disable takes effect fleet-wide on the next request.
- The budget lives at \`shadow:{config_id}:budget\` with its **own** cap and TTL, reserved by **one
  atomic operation** (a Lua \`EVAL\` script), not a read, a check and a separate increment.
- A disabled shadow returns without writing anything: no reservation, no counter, no partial state.
- The budget key expires on first write (\`EXPIRE\` in the same atomic call).`,
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
        'All keys are built from the config-scoped prefix `shadow:{config_id}:` (or the stack’s equivalent). The starter writes shadow traffic into the tenant’s production keys, so a shadow spends production budget.',
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
        'The enabled state is a single key `shadow:{config_id}:enabled`, read once per request. The starter keys the flag per shard, so some instances keep shadowing after a disable.',
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
        'The budget key `shadow:{config_id}:budget` has its own limit, separate from any production counter. The starter spends the tenant’s production quota, so exhausting the shadow starves the real path.',
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
        'The reservation is one atomic script (`EVAL`/`NewScript`/`eval`) that refunds an over-budget increment and sets the TTL on first write. The starter does GET-then-INCR, so two concurrent shadows both spend the last unit.',
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
        'The enabled flag is read before the budget reservation, so a disabled shadow leaves no partial state (no reservation, no counter). The starter admits first and cleans up later, if at all.',
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
        """The starter toggles the flag per shard, so a disable is not fleet-wide."""
        return self.redis.get(f"shadow:enabled:{config_id}:{shard}") == "1"

    def admit(self, config_id: str, tenant: str) -> bool:
        # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
      starter: `/** Redis shadow state: flawed code that shares production state. */
import type {Redis} from 'ioredis';

const PRODUCTION_QUOTA_KEY = 'quota:{tenant}:{window}';
const PRODUCTION_LIMIT = 1000;

export class ShadowState {
  constructor(private readonly redis: Redis) {}

  private async isEnabled(configId: string, shard: string): Promise<boolean> {
    return (await this.redis.get(\`shadow:enabled:\${configId}:\${shard}\`)) === '1';
  }

  async admit(configId: string, tenant: string): Promise<boolean> {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
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
    'Symptom: a tenant with a 5 percent shadow starts getting 429s on real traffic at 95 percent of its quota, and an operator who disables the config still sees samples arriving from some instances.',
    'Mechanism: `admit` increments `quota:{tenant}:{window}`, the same key the production limiter reads, after a flag lookup keyed by `"shard-0"`; and `get` followed by `incr` lets two concurrent requests both see `used < limit`.',
    'Change: build keys from `SHADOW_PREFIX` (`ENABLED_KEY`, `BUDGET_KEY` with `BUDGET_LIMIT`), read `self.enabled(config_id)` first and return on false, then reserve with one `self.redis.eval(RESERVE_LUA, …)` that refunds over-budget and sets the TTL.',
  ],
  debrief: `The fix is a data-model change before it is a Redis change. Scoping every key under \`shadow:{config_id}:\` is what keeps a shadow off production state: once the budget and the flag live under that prefix, the shadow can exhaust itself without touching \`quota:{tenant}:…\`. One flag in one key makes a disable true fleet-wide on the next read instead of eventually, and reading it before the reservation is what guarantees a disabled shadow leaves no partial counter. GET-then-INCR is the classic read-modify-write race; the Lua script increments, refunds an over-budget increment and sets the TTL in one round trip, so concurrency and expiry are handled in the same place. Production shadow runners also put a config version in every key, so a rolled-back config cannot read the previous run's counters.`,
};
