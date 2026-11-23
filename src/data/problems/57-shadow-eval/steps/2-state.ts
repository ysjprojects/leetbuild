import type {Step} from '@/lib/types';

export const shadowStateStep: Step = {
  id: 'state',
  title: 'Redis admission: a kill switch read per request and a budget of its own',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['shadow', 'redis'],
  task: `## Task

**Starting point.** The starter is the admission the request path asks before it shadows a request:
\`admit(config_id)\` looks up the config's tenant, compares the tenant's request counter
\`quota:{tenant}\` with \`TENANT_QUOTA\`, increments it, and returns \`enabled(config_id)\`, which reads
\`shadow:{config_id}:enabled\` once and keeps the answer in \`flag_cache\`. It admits the demo's
requests and hides four flaws.

**Failure mode the checks target.** An operator flips the kill switch and the shadow keeps running;
the shadow spends production's quota counter, so shadow traffic throttles real requests; two
instances read the same counter and both take the last unit; and a disabled shadow still spends.

- \`enabled\` reads \`shadow:{config_id}:enabled\` on every call (\`"1"\` is on).
- The budget is the shadow's own: \`shadow:{config_id}:budget\`, at most \`BUDGET_LIMIT\` = 1000
  reservations per \`BUDGET_WINDOW_S\` = 3600 s. \`quota:{tenant}\` is never touched.
- A reservation is one Lua script (\`RESERVE_LUA\`): \`INCR\`, \`EXPIRE\` on the window's first
  reservation, and past the limit a refund (\`DECR\`) and 0.
- \`admit\` reads the switch first: a disabled config answers false and writes nothing.`,
  sequence: {
    participants: ['Shadow runner', 'Redis'],
    messages: [
      {from: 'Shadow runner', to: 'Redis', label: 'GET shadow:{id}:enabled (every request)', kind: 'sync'},
      {from: 'Redis', to: 'Shadow runner', label: '"1" / "0"', kind: 'reply'},
      {from: 'Shadow runner', to: 'Shadow runner', label: 'off → false, nothing written', kind: 'sync'},
      {from: 'Shadow runner', to: 'Redis', label: 'EVAL reserve shadow:{id}:budget 1000 3600', kind: 'sync'},
      {from: 'Redis', to: 'Shadow runner', label: '1 admitted / 0 over budget (refunded)', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'flag',
      title: 'Reads the kill switch on every request',
      detail:
        '`enabled` reads `shadow:{config_id}:enabled` each time it is asked, and only `"1"` is on: a switch that is `"0"` or missing stops the shadow. The starter keeps the first answer in `flag_cache`, so flipping the switch stops nothing until every instance restarts.',
      match: {
        python: {all: [/shadow:\{config_id\}:enabled/], none: [/flag_cache\[/]},
        typescript: {all: [/shadow:\$\{configId\}:enabled/], none: [/flagCache\.(get|set|has)\(/]},
        go: {all: [/":enabled"/], none: [/flagCache\[/]},
        cpp: {all: [/":enabled"/], none: [/flag_cache\[|flag_cache\.(find|emplace|insert)\(/]},
      },
    },
    {
      id: 'budget',
      title: 'Spends its own budget, not the tenant quota',
      detail:
        "Reservations land on `shadow:{config_id}:budget` and stop at `BUDGET_LIMIT`: the 1000th of a window is admitted, the next is refused and leaves the count at 1000. `quota:{tenant}` keeps its value. The starter increments the tenant's production counter, so shadow traffic eats the quota real requests are throttled by.",
      match: {
        python: {all: [/:budget/, /BUDGET_LIMIT\s*=\s*1000\b/], none: [/quota:/]},
        typescript: {all: [/:budget/, /BUDGET_LIMIT\s*=\s*1000\b/], none: [/quota:/]},
        go: {all: [/:budget/, /budgetLimit\s*=\s*1000\b/], none: [/quota:/]},
        cpp: {all: [/:budget/, /kBudgetLimit\s*=\s*1000\b/], none: [/quota:/]},
      },
    },
    {
      id: 'atomic',
      title: 'Reserves in one script that starts the window',
      detail:
        "The check, the increment and the window's `EXPIRE` are one Lua script (`RESERVE_LUA` through `eval`/`NewScript`), so two instances cannot both take the last unit and the budget refills. The key has its 3600 s TTL from the command that creates it, and later reservations leave the TTL alone. The starter reads, compares and increments in three commands with no TTL.",
      match: {
        python: {
          all: [/\.eval\(|register_script\(/, /redis\.call\(\s*['"]INCR['"]/, /redis\.call\(\s*['"]EXPIRE['"]/],
          none: [/\br\.incr\(/],
        },
        typescript: {
          all: [/\.eval\(|defineCommand\(/, /redis\.call\(\s*['"]INCR['"]/, /redis\.call\(\s*['"]EXPIRE['"]/],
          none: [/redis\.incr\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]INCR['"]/, /redis\.call\(\s*['"]EXPIRE['"]/],
          none: [/rdb\.Incr\(/],
        },
        cpp: {
          all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]INCR['"]/, /redis\.call\(\s*['"]EXPIRE['"]/],
          none: [/redis\.incr\(/],
        },
      },
    },
    {
      id: 'no-partial',
      title: 'Reads the switch before it writes anything',
      detail:
        '`admit` asks `enabled` first and returns before any reservation when the switch is off. The starter spends first and asks last, so a disabled config still burns budget on every request.',
      match: {
        python: {order: [/def admit/, /if not enabled\(config_id\)/, /\.eval\(|register_script|reserve\(/]},
        typescript: {order: [/function admit/, /if \(!\(await enabled\(configId\)\)\)/, /\.eval\(|reserve\(/]},
        go: {order: [/func admit/, /if !enabled\(ctx, configID\)/, /\.Run\(|\.Eval\(/]},
        cpp: {order: [/bool admit\(/, /if \(!enabled\(config_id\)\)/, /redis\.eval/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from shadow import store  # get_config

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TENANT_QUOTA = 10_000

# A config's switch is read once per process and kept here.
flag_cache: dict[str, bool] = {}


def enabled(config_id: str) -> bool:
    """Whether the config's kill switch is on."""
    if config_id not in flag_cache:
        flag_cache[config_id] = r.get(f"shadow:{config_id}:enabled") == "1"
    return flag_cache[config_id]


def admit(config_id: str) -> bool:
    """Whether this request may be shadowed; a True answer has reserved one unit of budget."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = store.get_config(config_id)["tenant"]
    used = int(r.get(f"quota:{tenant}") or 0)
    if used >= TENANT_QUOTA:
        return False
    r.incr(f"quota:{tenant}")
    return enabled(config_id)
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

BUDGET_LIMIT = 1000
BUDGET_WINDOW_S = 3600

# One script: count the reservation, start the window with the first one, refund past the limit.
RESERVE_LUA = """
local used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if used > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
"""


def enabled(config_id: str) -> bool:
    """Whether the config's kill switch is on, read now."""
    return r.get(f"shadow:{config_id}:enabled") == "1"


def admit(config_id: str) -> bool:
    """Whether this request may be shadowed; a True answer has reserved one unit of budget."""
    if not enabled(config_id):
        return False  # a disabled shadow writes nothing
    return r.eval(RESERVE_LUA, 1, f"shadow:{config_id}:budget", BUDGET_LIMIT, BUDGET_WINDOW_S) == 1
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {getConfig} from 'shadow/store';

const redis = new Redis({host: 'redis', port: 6379});

export const TENANT_QUOTA = 10_000;

// A config's switch is read once per process and kept here.
const flagCache = new Map<string, boolean>();

/** Whether the config's kill switch is on. */
export async function enabled(configId: string): Promise<boolean> {
  if (!flagCache.has(configId)) flagCache.set(configId, (await redis.get(\`shadow:\${configId}:enabled\`)) === '1');
  return flagCache.get(configId) === true;
}

/** Whether this request may be shadowed; a true answer has reserved one unit of budget. */
export async function admit(configId: string): Promise<boolean> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const config = await getConfig(configId);
  const quota = \`quota:\${config?.tenant ?? ''}\`;
  const used = Number((await redis.get(quota)) ?? 0);
  if (used >= TENANT_QUOTA) return false;
  await redis.incr(quota);
  return enabled(configId);
}
`,
      solution: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const BUDGET_LIMIT = 1000;
export const BUDGET_WINDOW_S = 3600;

// One script: count the reservation, start the window with the first one, refund past the limit.
export const RESERVE_LUA = \`
local used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if used > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
\`;

/** Whether the config's kill switch is on, read now. */
export async function enabled(configId: string): Promise<boolean> {
  return (await redis.get(\`shadow:\${configId}:enabled\`)) === '1';
}

/** Whether this request may be shadowed; a true answer has reserved one unit of budget. */
export async function admit(configId: string): Promise<boolean> {
  if (!(await enabled(configId))) return false; // a disabled shadow writes nothing
  return (await redis.eval(RESERVE_LUA, 1, \`shadow:\${configId}:budget\`, BUDGET_LIMIT, BUDGET_WINDOW_S)) === 1;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"

	"shadow/store" // store.GetConfig
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const tenantQuota = 10000

// A config's switch is read once per process and kept here.
var flagCache = map[string]bool{}

// enabled reports whether the config's kill switch is on.
func enabled(ctx context.Context, configID string) bool {
	if on, seen := flagCache[configID]; seen {
		return on
	}
	on := rdb.Get(ctx, "shadow:"+configID+":enabled").Val() == "1"
	flagCache[configID] = on
	return on
}

// admit reports whether this request may be shadowed; true has reserved one unit of budget.
func admit(ctx context.Context, configID string) (bool, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	config := store.GetConfig(ctx, configID)
	if config == nil {
		return false, fmt.Errorf("no config %s", configID)
	}
	quota := "quota:" + config.Tenant
	used, _ := rdb.Get(ctx, quota).Int()
	if used >= tenantQuota {
		return false, nil
	}
	if err := rdb.Incr(ctx, quota).Err(); err != nil {
		return false, err
	}
	return enabled(ctx, configID), nil
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const (
	budgetLimit   = 1000
	budgetWindowS = 3600
)

// reserve counts the reservation, starts the window with the first one, and refunds past the limit.
var reserve = redis.NewScript(\`
local used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if used > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
\`)

// enabled reports whether the config's kill switch is on, read now.
func enabled(ctx context.Context, configID string) bool {
	return rdb.Get(ctx, "shadow:"+configID+":enabled").Val() == "1"
}

// admit reports whether this request may be shadowed; true has reserved one unit of budget.
func admit(ctx context.Context, configID string) (bool, error) {
	if !enabled(ctx, configID) {
		return false, nil // a disabled shadow writes nothing
	}
	n, err := reserve.Run(ctx, rdb, []string{"shadow:" + configID + ":budget"}, budgetLimit, budgetWindowS).Int64()
	return n == 1, err
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>
#include <unordered_map>

#include "shadow/store.h"  // store::getConfig

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kTenantQuota = 10000;

// A config's switch is read once per process and kept here.
std::unordered_map<std::string, bool> flag_cache;

// Whether the config's kill switch is on.
bool enabled(const std::string& config_id) {
  const auto seen = flag_cache.find(config_id);
  if (seen != flag_cache.end()) return seen->second;
  const bool on = redis.get("shadow:" + config_id + ":enabled").value_or("") == "1";
  flag_cache[config_id] = on;
  return on;
}

// Whether this request may be shadowed; true has reserved one unit of budget.
bool admit(const std::string& config_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto config = store::getConfig(config_id);
  const std::string quota = "quota:" + (config ? config->tenant : "");
  const auto used = redis.get(quota);
  if (used && std::stoll(*used) >= kTenantQuota) return false;
  redis.incr(quota);
  return enabled(config_id);
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <string>

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kBudgetLimit = 1000;
constexpr long long kBudgetWindowS = 3600;

// One script: count the reservation, start the window with the first one, refund past the limit.
const std::string kReserveLua = R"lua(
local used = redis.call('INCR', KEYS[1])
if used == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if used > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
)lua";

// Whether the config's kill switch is on, read now.
bool enabled(const std::string& config_id) { return redis.get("shadow:" + config_id + ":enabled").value_or("") == "1"; }

// Whether this request may be shadowed; true has reserved one unit of budget.
bool admit(const std::string& config_id) {
  if (!enabled(config_id)) return false;  // a disabled shadow writes nothing
  return redis.eval<long long>(kReserveLua, {"shadow:" + config_id + ":budget"},
                               {std::to_string(kBudgetLimit), std::to_string(kBudgetWindowS)}) == 1;
}
`,
    },
  },
  harness: {
    python: `from shadow import store


def _config():
    return store.create_config("t1", "cand-2026-04", 5, ["latency"])["config_id"]


def check_flag(ctx):
    m = ctx.load("state")
    cfg = _config()
    assert m.admit(cfg) is True, "an enabled config with an empty budget must be admitted"
    store.set_enabled(cfg, False)
    assert m.admit(cfg) is False, f"shadow:{cfg}:enabled was flipped to 0 and admit still answered True: the switch must be read on every request, or an operator cannot stop a shadow"
    store.set_enabled(cfg, True)
    assert m.admit(cfg) is True, "once the switch is back on, admit must answer True again"
    ctx.redis.delete(f"shadow:{cfg}:enabled")
    assert m.admit(cfg) is False, f"shadow:{cfg}:enabled was deleted and admit answered True: only \\"1\\" is on, so a missing switch stops the shadow"


def check_budget(ctx):
    m = ctx.load("state")
    cfg = _config()
    budget = f"shadow:{cfg}:budget"
    ctx.redis.set("quota:t1", 7)  # production's request counter for t1
    for n in range(3):
        assert m.admit(cfg) is True, f"reservation {n + 1} of an empty budget was refused"
    assert ctx.redis.get("quota:t1") == "7", f"three shadowed requests moved production's counter quota:t1 from 7 to {ctx.redis.get('quota:t1')}: shadow traffic spends the quota real requests are throttled by"
    assert ctx.redis.get(budget) == "3", f"{budget} holds {ctx.redis.get(budget)!r} after three reservations, expected 3"
    ctx.redis.set(budget, 999)
    assert m.admit(cfg) is True, f"with {budget} at 999 admit answered False: the 1000th reservation of the window is still within BUDGET_LIMIT (1000)"
    assert ctx.redis.get(budget) == "1000", f"the 1000th reservation left {budget} at {ctx.redis.get(budget)!r}, expected 1000"
    assert m.admit(cfg) is False, f"with {budget} at BUDGET_LIMIT (1000) admit answered True"
    assert ctx.redis.get(budget) == "1000", f"a refused reservation left {budget} at {ctx.redis.get(budget)}, expected 1000"


def check_atomic(ctx):
    m = ctx.load("state")
    cfg = _config()
    budget = f"shadow:{cfg}:budget"
    created = {}
    ctx.redis_after(budget, lambda: created.setdefault("ttl", ctx.redis.ttl(budget)))
    assert m.admit(cfg) is True, "an enabled config with an empty budget must be admitted"
    assert ctx.redis.exists(budget), f"admit reserved nothing on {budget}: the shadow's budget is its own key"
    assert created.get("ttl") == 3600, f"right after the command that created {budget} its TTL was {created.get('ttl')}, expected BUDGET_WINDOW_S (3600): the EXPIRE belongs in the same script, or a crash in between leaves a budget that never refills"
    ctx.clock.advance(600)
    assert m.admit(cfg) is True, "a second reservation in the window was refused"
    ttl = ctx.redis.ttl(budget)
    assert 0 < ttl <= 3000, f"600 s into the window a second reservation left {budget} with TTL {ttl}, expected 3000: only the window's first reservation sets the EXPIRE, or steady traffic keeps the budget from ever refilling"
    ctx.redis.set(budget, 999)

    def rival():  # another instance reserves the last unit right after this one touched the budget
        if int(ctx.redis.get(budget) or 0) < 1000:
            ctx.redis.incr(budget)

    ctx.redis_after(budget, rival)
    m.admit(cfg)
    used = int(ctx.redis.get(budget))
    assert used <= 1000, f"two instances racing for the last unit left {budget} at {used}, over BUDGET_LIMIT 1000: the check and the increment must be one script"


def check_no_partial(ctx):
    m = ctx.load("state")
    cfg = _config()
    budget = f"shadow:{cfg}:budget"
    ctx.redis.set("quota:t1", 7)
    store.set_enabled(cfg, False)
    assert m.admit(cfg) is False, "a disabled config must not be admitted"
    assert ctx.redis.get("quota:t1") == "7" and ctx.redis.exists(budget) == 0, f"a disabled config spent: quota:t1 is {ctx.redis.get('quota:t1')}, {budget} is {ctx.redis.get(budget)!r}. Read the switch before anything is written"
`,
    typescript: `function world(ctx) {
  const m = ctx.load('state');
  const store = ctx.load('/support/shadow/store.ts');
  return {m, store};
}

const newConfig = async (store): Promise<string> => (await store.createConfig('t1', 'cand-2026-04', 5, ['latency'])).config_id;

export async function check_flag(ctx) {
  const {m, store} = world(ctx);
  const cfg = await newConfig(store);
  assert.equal(await m.admit(cfg), true, 'an enabled config with an empty budget must be admitted');
  await store.setEnabled(cfg, false);
  assert.equal(await m.admit(cfg), false, \`shadow:\${cfg}:enabled was flipped to 0 and admit still answered true: the switch must be read on every request, or an operator cannot stop a shadow\`);
  await store.setEnabled(cfg, true);
  assert.equal(await m.admit(cfg), true, 'once the switch is back on, admit must answer true again');
  ctx.redis.del(\`shadow:\${cfg}:enabled\`);
  assert.equal(await m.admit(cfg), false, \`shadow:\${cfg}:enabled was deleted and admit answered true: only "1" is on, so a missing switch stops the shadow\`);
}

export async function check_budget(ctx) {
  const {m, store} = world(ctx);
  const cfg = await newConfig(store);
  const budget = \`shadow:\${cfg}:budget\`;
  ctx.redis.set('quota:t1', '7'); // production's request counter for t1
  for (let n = 1; n <= 3; n += 1) assert.equal(await m.admit(cfg), true, \`reservation \${n} of an empty budget was refused\`);
  assert.equal(ctx.redis.get('quota:t1'), '7', \`three shadowed requests moved production's counter quota:t1 from 7 to \${ctx.redis.get('quota:t1')}: shadow traffic spends the quota real requests are throttled by\`);
  assert.equal(ctx.redis.get(budget), '3', \`\${budget} holds \${JSON.stringify(ctx.redis.get(budget))} after three reservations, expected 3\`);
  ctx.redis.set(budget, '999');
  assert.equal(await m.admit(cfg), true, \`with \${budget} at 999 admit answered false: the 1000th reservation of the window is still within BUDGET_LIMIT (1000)\`);
  assert.equal(ctx.redis.get(budget), '1000', \`the 1000th reservation left \${budget} at \${ctx.redis.get(budget)}, expected 1000\`);
  assert.equal(await m.admit(cfg), false, \`with \${budget} at BUDGET_LIMIT (1000) admit answered true\`);
  assert.equal(ctx.redis.get(budget), '1000', \`a refused reservation left \${budget} at \${ctx.redis.get(budget)}, expected 1000\`);
}

export async function check_atomic(ctx) {
  const {m, store} = world(ctx);
  const cfg = await newConfig(store);
  const budget = \`shadow:\${cfg}:budget\`;
  let created: number | undefined;
  ctx.redisAfter(budget, () => {
    created ??= ctx.redis.ttl(budget);
  });
  assert.equal(await m.admit(cfg), true, 'an enabled config with an empty budget must be admitted');
  assert.equal(ctx.redis.exists(budget), 1, \`admit reserved nothing on \${budget}: the shadow's budget is its own key\`);
  assert.equal(created, 3600, \`right after the command that created \${budget} its TTL was \${created}, expected BUDGET_WINDOW_S (3600): the EXPIRE belongs in the same script, or a crash in between leaves a budget that never refills\`);
  ctx.clock.advance(600);
  assert.equal(await m.admit(cfg), true, 'a second reservation in the window was refused');
  const ttl = ctx.redis.ttl(budget);
  assert(ttl > 0 && ttl <= 3000, \`600 s into the window a second reservation left \${budget} with TTL \${ttl}, expected 3000: only the window's first reservation sets the EXPIRE, or steady traffic keeps the budget from ever refilling\`);
  ctx.redis.set(budget, '999');
  // Another instance reserves the last unit right after this one touched the budget.
  ctx.redisAfter(budget, () => {
    if (Number(ctx.redis.get(budget) ?? 0) < 1000) ctx.redis.incr(budget);
  });
  await m.admit(cfg);
  const used = Number(ctx.redis.get(budget));
  assert(used <= 1000, \`two instances racing for the last unit left \${budget} at \${used}, over BUDGET_LIMIT 1000: the check and the increment must be one script\`);
}

export async function check_no_partial(ctx) {
  const {m, store} = world(ctx);
  const cfg = await newConfig(store);
  const budget = \`shadow:\${cfg}:budget\`;
  ctx.redis.set('quota:t1', '7');
  await store.setEnabled(cfg, false);
  assert.equal(await m.admit(cfg), false, 'a disabled config must not be admitted');
  assert(ctx.redis.get('quota:t1') === '7' && ctx.redis.exists(budget) === 0, \`a disabled config spent: quota:t1 is \${ctx.redis.get('quota:t1')}, \${budget} is \${JSON.stringify(ctx.redis.get(budget))}. Read the switch before anything is written\`);
}
`,
    go: `package main

import (
	"context"
	"strconv"

	"shadow/store"

	"leetbuild/harness"
)

var hStateBg = context.Background()

func hStateConfig() string {
	return store.CreateConfig(hStateBg, "t1", "cand-2026-04", 5, []string{"latency"}).ConfigID
}

func hAdmit(ctx *harness.Ctx, configID string) bool {
	ok, err := admit(hStateBg, configID)
	ctx.NoError(err, "admit(%s) failed", configID)
	return ok
}

func hRedisInt(ctx *harness.Ctx, key string) int {
	value, _ := ctx.Redis.Get(key)
	n, _ := strconv.Atoi(value)
	return n
}

func CheckFlag(ctx *harness.Ctx) {
	cfg := hStateConfig()
	ctx.Equal(hAdmit(ctx, cfg), true, "an enabled config with an empty budget must be admitted; admitted")
	store.SetEnabled(hStateBg, cfg, false)
	ctx.Equal(hAdmit(ctx, cfg), false, "shadow:%s:enabled was flipped to 0: the switch must be read on every request, or an operator cannot stop a shadow; admitted", cfg)
	store.SetEnabled(hStateBg, cfg, true)
	ctx.Equal(hAdmit(ctx, cfg), true, "once the switch is back on, admit must answer true again; admitted")
	ctx.Redis.Del("shadow:" + cfg + ":enabled")
	ctx.Equal(hAdmit(ctx, cfg), false, "shadow:%s:enabled was deleted: only \\"1\\" is on, so a missing switch stops the shadow; admitted", cfg)
}

func CheckBudget(ctx *harness.Ctx) {
	cfg := hStateConfig()
	budget := "shadow:" + cfg + ":budget"
	ctx.Redis.Set("quota:t1", "7") // production's request counter for t1
	for n := 1; n <= 3; n++ {
		ctx.Equal(hAdmit(ctx, cfg), true, "reservation %d of an empty budget; admitted", n)
	}
	ctx.Equal(hRedisInt(ctx, "quota:t1"), 7, "three shadowed requests must leave production's counter quota:t1 alone (shadow traffic would spend the quota real requests are throttled by); quota:t1")
	ctx.Equal(hRedisInt(ctx, budget), 3, "%s after three reservations", budget)
	ctx.Redis.Set(budget, "999")
	ctx.Equal(hAdmit(ctx, cfg), true, "with %s at 999 the 1000th reservation of the window is still within BUDGET_LIMIT (1000); admitted", budget)
	ctx.Equal(hRedisInt(ctx, budget), 1000, "the 1000th reservation must leave %s at 1000", budget)
	ctx.Equal(hAdmit(ctx, cfg), false, "with %s at BUDGET_LIMIT (1000); admitted", budget)
	ctx.Equal(hRedisInt(ctx, budget), 1000, "a refused reservation must leave %s at the limit", budget)
}

func CheckAtomic(ctx *harness.Ctx) {
	cfg := hStateConfig()
	budget := "shadow:" + cfg + ":budget"
	created := int64(-3)
	ctx.Redis.After(budget, func() any {
		created = ctx.Redis.TTL(budget)
		return nil
	})
	ctx.Equal(hAdmit(ctx, cfg), true, "an enabled config with an empty budget must be admitted; admitted")
	ctx.Equal(ctx.Redis.Exists(budget), int64(1), "admit must reserve on %s, the shadow's own key; it exists", budget)
	ctx.Equal(created, int64(3600), "the EXPIRE belongs in the same script, or a crash in between leaves a budget that never refills; the TTL of %s right after the command that created it", budget)
	ctx.Clock.Advance(600)
	ctx.Equal(hAdmit(ctx, cfg), true, "a second reservation in the window; admitted")
	ttl := ctx.Redis.TTL(budget)
	ctx.Assert(ttl > 0 && ttl <= 3000, "600 s into the window a second reservation left %s with TTL %d, expected 3000: only the window's first reservation sets the EXPIRE, or steady traffic keeps the budget from ever refilling", budget, ttl)
	ctx.Redis.Set(budget, "999")
	// Another instance reserves the last unit right after this one touched the budget.
	ctx.Redis.After(budget, func() any {
		if hRedisInt(ctx, budget) < 1000 {
			ctx.Redis.Do("INCR", budget)
		}
		return nil
	})
	hAdmit(ctx, cfg)
	used := hRedisInt(ctx, budget)
	ctx.Assert(used <= 1000, "two instances racing for the last unit left %s at %d, over BUDGET_LIMIT 1000: the check and the increment must be one script", budget, used)
}

func CheckNoPartial(ctx *harness.Ctx) {
	cfg := hStateConfig()
	budget := "shadow:" + cfg + ":budget"
	ctx.Redis.Set("quota:t1", "7")
	store.SetEnabled(hStateBg, cfg, false)
	ctx.Equal(hAdmit(ctx, cfg), false, "a disabled config must not be admitted; admitted")
	ctx.Assert(hRedisInt(ctx, "quota:t1") == 7 && ctx.Redis.Exists(budget) == 0, "a disabled config spent: quota:t1 is %d, %s is %d. Read the switch before anything is written", hRedisInt(ctx, "quota:t1"), budget, hRedisInt(ctx, budget))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>

#include "shadow/store.h"

namespace {

std::string hStateConfig() { return store::createConfig("t1", "cand-2026-04", 5, {"latency"}).config_id; }

long long hRedisInt(harness::Ctx& ctx, const std::string& key) {
  const auto value = ctx.Redis.Get(key);
  return value && !value->empty() ? std::stoll(*value) : 0;
}

}  // namespace

void CheckFlag(harness::Ctx& ctx) {
  const std::string cfg = hStateConfig();
  ctx.Equal(admit(cfg), true, "an enabled config with an empty budget must be admitted; admitted");
  store::setEnabled(cfg, false);
  ctx.Equal(admit(cfg), false, "shadow:%s:enabled was flipped to 0: the switch must be read on every request, or an operator cannot stop a shadow; admitted", cfg);
  store::setEnabled(cfg, true);
  ctx.Equal(admit(cfg), true, "once the switch is back on, admit must answer true again; admitted");
  ctx.Redis.Del("shadow:" + cfg + ":enabled");
  ctx.Equal(admit(cfg), false, "shadow:%s:enabled was deleted: only \\"1\\" is on, so a missing switch stops the shadow; admitted", cfg);
}

void CheckBudget(harness::Ctx& ctx) {
  const std::string cfg = hStateConfig();
  const std::string budget = "shadow:" + cfg + ":budget";
  ctx.Redis.Set("quota:t1", "7");  // production's request counter for t1
  for (int n = 1; n <= 3; n++) ctx.Equal(admit(cfg), true, "reservation %d of an empty budget; admitted", n);
  ctx.Equal(hRedisInt(ctx, "quota:t1"), 7, "three shadowed requests must leave production's counter quota:t1 alone (shadow traffic would spend the quota real requests are throttled by); quota:t1");
  ctx.Equal(hRedisInt(ctx, budget), 3, "%s after three reservations", budget);
  ctx.Redis.Set(budget, "999");
  ctx.Equal(admit(cfg), true, "with %s at 999 the 1000th reservation of the window is still within BUDGET_LIMIT (1000); admitted", budget);
  ctx.Equal(hRedisInt(ctx, budget), 1000, "the 1000th reservation must leave %s at 1000", budget);
  ctx.Equal(admit(cfg), false, "with %s at BUDGET_LIMIT (1000); admitted", budget);
  ctx.Equal(hRedisInt(ctx, budget), 1000, "a refused reservation must leave %s at the limit", budget);
}

void CheckAtomic(harness::Ctx& ctx) {
  const std::string cfg = hStateConfig();
  const std::string budget = "shadow:" + cfg + ":budget";
  long long created = -3;
  ctx.Redis.After(budget, [&ctx, &created, budget] { created = ctx.Redis.TTL(budget); });
  ctx.Equal(admit(cfg), true, "an enabled config with an empty budget must be admitted; admitted");
  ctx.Equal(ctx.Redis.Exists(budget), 1, "admit must reserve on %s, the shadow's own key; it exists", budget);
  ctx.Equal(created, 3600, "the EXPIRE belongs in the same script, or a crash in between leaves a budget that never refills; the TTL of %s right after the command that created it", budget);
  ctx.Clock.Advance(600);
  ctx.Equal(admit(cfg), true, "a second reservation in the window; admitted");
  const long long ttl = ctx.Redis.TTL(budget);
  ctx.Assert(ttl > 0 && ttl <= 3000, "600 s into the window a second reservation left %s with TTL %d, expected 3000: only the window's first reservation sets the EXPIRE, or steady traffic keeps the budget from ever refilling", budget, ttl);
  ctx.Redis.Set(budget, "999");
  // Another instance reserves the last unit right after this one touched the budget.
  ctx.Redis.After(budget, [&ctx, budget] {
    if (hRedisInt(ctx, budget) < 1000) ctx.Redis.Do("INCR", budget);
  });
  admit(cfg);
  const long long used = hRedisInt(ctx, budget);
  ctx.Assert(used <= 1000, "two instances racing for the last unit left %s at %d, over BUDGET_LIMIT 1000: the check and the increment must be one script", budget, used);
}

void CheckNoPartial(harness::Ctx& ctx) {
  const std::string cfg = hStateConfig();
  const std::string budget = "shadow:" + cfg + ":budget";
  ctx.Redis.Set("quota:t1", "7");
  store::setEnabled(cfg, false);
  ctx.Equal(admit(cfg), false, "a disabled config must not be admitted; admitted");
  ctx.Assert(hRedisInt(ctx, "quota:t1") == 7 && ctx.Redis.Exists(budget) == 0, "a disabled config spent: quota:t1 is %d, %s is %d. Read the switch before anything is written", hRedisInt(ctx, "quota:t1"), budget, hRedisInt(ctx, budget));
}
`,
  },
  hints: [
    'Flip a running config\'s switch to "0": shadowed requests keep coming. Meanwhile the tenant\'s real requests start hitting their quota on a day with normal traffic.',
    "The switch is read once into a process cache, the budget is the tenant's production counter, and the counter is read, compared and incremented in three round trips another instance can land between. The spending happens before the switch is asked.",
    'Drop `flag_cache` and GET `shadow:{config_id}:enabled` per call; return False first when it is off; then one `eval` of a script that INCRs `shadow:{config_id}:budget`, EXPIREs it on 1, and DECRs and returns 0 past 1000.',
  ],
  debrief: `Every rule here is about where the shadow's state lives. A switch that is cached is a switch nobody can flip, so it is read where it is used, and one key serves the whole fleet. A budget that shares production's counter couples the experiment to production's throttling, so the shadow gets its own key and its own window. The reservation is a single script because the race is between instances, not threads: only Redis sees both. Production runners usually push the switch instead of polling it (a pub/sub channel or a config service watch) to save the extra GET, and size the budget from the share and the candidate's capacity rather than a fixed constant.`,
};
