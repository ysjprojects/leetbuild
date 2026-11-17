import type {Step} from '@/lib/types';

const CLAIM_LUA = `local probe, budget = KEYS[1], KEYS[2]
local destructive = ARGV[1] == '1'
local cap, destructive_cap = tonumber(ARGV[2]), tonumber(ARGV[3])
local window_s, dedupe_ttl = tonumber(ARGV[4]), tonumber(ARGV[5])
local used = tonumber(redis.call('HGET', budget, 'probes') or '0')
if redis.call('EXISTS', probe) == 1 then
  return {'duplicate', tostring(cap - used)}
end
local used_destructive = tonumber(redis.call('HGET', budget, 'destructive') or '0')
if used >= cap or (destructive and used_destructive >= destructive_cap) then
  return {'budget', tostring(cap - used)}
end
redis.call('SET', probe, '1', 'EX', dedupe_ttl)
redis.call('HINCRBY', budget, 'probes', 1)
if destructive then
  redis.call('HINCRBY', budget, 'destructive', 1)
end
redis.call('EXPIRE', budget, window_s)
return {'ok', tostring(cap - used - 1)}`;

const scalaLua = CLAIM_LUA.split('\n')
  .map((line, i) => (i === 0 ? line : `      |${line}`))
  .join('\n');

export const stateStep: Step = {
  id: 'state',
  title: 'Redis probe claims inside an hourly budget',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['runner', 'redis'],
  task: `## Task

**Starting point.** The starter's \`claim_probe(target, probe_hash, category)\` is what every runner
calls before it sends a probe. It bumps a \`probes\` counter in \`redteam:budget:{target}\`, \`GET\`s the probe
key from \`config.probe_key\` and answers \`duplicate\` if it is there, refuses above \`PROBE_BUDGET\`, and
otherwise \`SET\`s the probe key and answers \`{verdict: "ok", remaining}\`. It serves the demo and hides 5
flaws.

**Failure mode the checks target.** Two runner replicas replaying one probe set both send the same
probe, because nothing stops a second runner landing between the \`GET\` and the \`SET\`. Replays drain
the budget. A target that hit its cap once stays capped forever, a probe claimed once can never run
again, and destructive probes can spend the whole hour.

Requirements, kept by **one Lua script**:

- A claimed \`probe_key\` is \`duplicate\` and draws nothing.
- The budget is \`budget_key(target, window)\` with \`window = unix seconds // WINDOW_S\`: a hash of
  \`probes\` and \`destructive\`. At \`PROBE_BUDGET\`, or at \`DESTRUCTIVE_PROBE_BUDGET\` for a category in
  \`DESTRUCTIVE_CATEGORIES\`, the verdict is \`budget\` and nothing is claimed.
- Otherwise \`SET\` the probe key \`EX DEDUPE_TTL_S\`, \`HINCRBY\` the counters, \`EXPIRE\` the budget \`WINDOW_S\`.
- Answer \`{verdict, remaining}\`: probes left this hour.`,
  sequence: {
    participants: ['Runner', 'Second runner', 'Redis'],
    messages: [
      {
        from: 'Runner',
        to: 'Redis',
        label: 'EVALSHA claim · probe key, budget key · destructive, caps, ttls',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'EXISTS probe → 0 · HGET probes, destructive < caps', kind: 'sync'},
      {from: 'Redis', to: 'Redis', label: 'SET probe EX 86400 · HINCRBY · EXPIRE 3600', kind: 'sync'},
      {from: 'Redis', to: 'Runner', label: '{ok, remaining}', kind: 'reply'},
      {from: 'Second runner', to: 'Redis', label: 'EVALSHA claim · same probe', kind: 'sync'},
      {from: 'Redis', to: 'Second runner', label: '{duplicate, remaining}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'duplicate-free',
      title: 'A duplicate draws nothing from the budget',
      detail:
        'The probe key is tested before any counter moves, so a replayed probe answers duplicate with the remaining budget unchanged. The starter increments first and looks second.',
      match: {
        python: {order: [/['"]EXISTS['"]/, /['"]HINCRBY['"]/], none: [/\.hincrby\(/]},
        typescript: {order: [/['"]EXISTS['"]/, /['"]HINCRBY['"]/], none: [/\.hincrby\(/]},
        go: {order: [/['"]EXISTS['"]/, /['"]HINCRBY['"]/], none: [/\.HIncrBy\(/]},
        scala: {order: [/['"]EXISTS['"]/, /['"]HINCRBY['"]/], none: [/\.hincrBy\(/]},
        cpp: {order: [/['"]EXISTS['"]/, /['"]HINCRBY['"]/], none: [/\.hincrby\(/]},
      },
    },
    {
      id: 'atomic-claim',
      title: 'Claims the probe in one Lua script',
      detail:
        'The test, the budget and the claim run in one EVAL/EVALSHA, so when a second runner claims the same probe at the same moment exactly one of them gets ok, and when two runners reach for the hour’s last slot exactly one gets it. The starter reads the key with GET and writes it with SET, and a second runner lands between them.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]EXISTS['"]/],
          none: [/\.get\(\s*probe_key\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]EXISTS['"]/],
          none: [/\.get\(\s*probeKey\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]EXISTS['"]/],
          none: [/\.Get\(\s*\w+,\s*config\.ProbeKey\(/],
        },
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]EXISTS['"]/], none: [/\.get\(\s*Config\.probeKey\(/]},
        cpp: {
          all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]EXISTS['"]/],
          none: [/\.get\(\s*config::probe_key\(/],
        },
      },
    },
    {
      id: 'destructive-cap',
      title: 'Caps destructive categories at their own budget',
      detail:
        'A category in DESTRUCTIVE_CATEGORIES stops at DESTRUCTIVE_PROBE_BUDGET (20) an hour, counting destructive probes only, while other categories go on. The starter has one shared cap, so destructive probes can spend the whole hour.',
      match: {
        python: {all: [/DESTRUCTIVE_PROBE_BUDGET/, /DESTRUCTIVE_CATEGORIES/]},
        typescript: {all: [/DESTRUCTIVE_PROBE_BUDGET/, /DESTRUCTIVE_CATEGORIES/]},
        go: {all: [/config\.DestructiveProbeBudget/, /config\.DestructiveCategories/]},
        scala: {all: [/Config\.DestructiveProbeBudget/, /Config\.DestructiveCategories/]},
        cpp: {all: [/config::kDestructiveProbeBudget/, /config::kDestructiveCategories/]},
      },
    },
    {
      id: 'hourly-window',
      title: 'Keeps the budget per hour window, with an expiry',
      detail:
        'The counters live in budget_key(target, window); the script that counts sets a TTL of at most WINDOW_S seconds, so the budget holds until the window ends and a target that spent its 200 probes can be probed again the next hour. The starter counts in one key with no window and no expiry.',
      match: {
        python: {all: [/budget_key\(/, /WINDOW_S/], none: [/["']redteam:budget:/]},
        typescript: {all: [/budgetKey\(/, /WINDOW_S/], none: [/['"`]redteam:budget:/]},
        go: {all: [/config\.BudgetKey\(/, /config\.WindowSeconds/], none: [/"redteam:budget:/]},
        scala: {all: [/Config\.budgetKey\(/, /Config\.WindowSeconds/], none: [/"redteam:budget:/]},
        cpp: {all: [/config::budget_key\(/, /config::kWindowSeconds/], none: [/"redteam:budget:/]},
      },
    },
    {
      id: 'claim-ttl',
      title: 'Expires a claimed probe after DEDUPE_TTL_S',
      detail:
        'The claiming script sets the probe key with EX DEDUPE_TTL_S (a day), so the probe stays a duplicate all day and tomorrow’s run can send it again. The starter sets it with no expiry, so a probe runs once per target forever.',
      match: {
        python: {all: [/DEDUPE_TTL_S/]},
        typescript: {all: [/DEDUPE_TTL_S/]},
        go: {all: [/config\.DedupeTTLSeconds/]},
        scala: {all: [/Config\.DedupeTtlSeconds/]},
        cpp: {all: [/config::kDedupeTtlSeconds/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from redteam.config import PROBE_BUDGET, probe_key

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def claim_probe(target: str, probe_hash: str, category: str) -> dict:
    """Claim one probe before a runner sends it: {verdict: ok | duplicate | budget, remaining}."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    budget = f"redteam:budget:{target}"
    used = r.hincrby(budget, "probes", 1)
    if r.get(probe_key(target, probe_hash)) is not None:
        return {"verdict": "duplicate", "remaining": PROBE_BUDGET - used}
    if used > PROBE_BUDGET:
        r.hincrby(budget, "probes", -1)
        return {"verdict": "budget", "remaining": 0}
    r.set(probe_key(target, probe_hash), "1")
    return {"verdict": "ok", "remaining": PROBE_BUDGET - used}
`,
      solution: `import time

import redis

from redteam.config import (
    DEDUPE_TTL_S,
    DESTRUCTIVE_CATEGORIES,
    DESTRUCTIVE_PROBE_BUDGET,
    PROBE_BUDGET,
    WINDOW_S,
    budget_key,
    probe_key,
)

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CLAIM = """
${CLAIM_LUA}
"""

claim_script = r.register_script(CLAIM)


def claim_probe(target: str, probe_hash: str, category: str) -> dict:
    """Claim one probe before a runner sends it: {verdict: ok | duplicate | budget, remaining}."""
    window = int(time.time()) // WINDOW_S
    verdict, remaining = claim_script(
        keys=[probe_key(target, probe_hash), budget_key(target, window)],
        args=["1" if category in DESTRUCTIVE_CATEGORIES else "0", PROBE_BUDGET, DESTRUCTIVE_PROBE_BUDGET, WINDOW_S, DEDUPE_TTL_S],
    )
    return {"verdict": verdict, "remaining": int(remaining)}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {PROBE_BUDGET, probeKey} from 'redteam/config';

export const redis = new Redis({host: 'redis', port: 6379});

export interface Claim {
  verdict: 'ok' | 'duplicate' | 'budget';
  remaining: number;
}

/** Claim one probe before a runner sends it. */
export async function claimProbe(target: string, probeHash: string, category: string): Promise<Claim> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  void category;
  const budget = \`redteam:budget:\${target}\`;
  const used = await redis.hincrby(budget, 'probes', 1);
  if ((await redis.get(probeKey(target, probeHash))) !== null) return {verdict: 'duplicate', remaining: PROBE_BUDGET - used};
  if (used > PROBE_BUDGET) {
    await redis.hincrby(budget, 'probes', -1);
    return {verdict: 'budget', remaining: 0};
  }
  await redis.set(probeKey(target, probeHash), '1');
  return {verdict: 'ok', remaining: PROBE_BUDGET - used};
}
`,
      solution: `import Redis from 'ioredis';

import {
  DEDUPE_TTL_S,
  DESTRUCTIVE_CATEGORIES,
  DESTRUCTIVE_PROBE_BUDGET,
  PROBE_BUDGET,
  WINDOW_S,
  budgetKey,
  probeKey,
} from 'redteam/config';

const CLAIM = \`
${CLAIM_LUA}
\`;

interface StateRedis extends Redis {
  claimProbe(probe: string, budget: string, destructive: string, cap: number, destructiveCap: number, windowS: number, dedupeTtl: number): Promise<[string, string]>;
}

export const redis = new Redis({host: 'redis', port: 6379}) as StateRedis;
redis.defineCommand('claimProbe', {numberOfKeys: 2, lua: CLAIM});

export interface Claim {
  verdict: 'ok' | 'duplicate' | 'budget';
  remaining: number;
}

/** Claim one probe before a runner sends it. */
export async function claimProbe(target: string, probeHash: string, category: string): Promise<Claim> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const [verdict, remaining] = await redis.claimProbe(
    probeKey(target, probeHash),
    budgetKey(target, window),
    DESTRUCTIVE_CATEGORIES[category] === true ? '1' : '0',
    PROBE_BUDGET,
    DESTRUCTIVE_PROBE_BUDGET,
    WINDOW_S,
    DEDUPE_TTL_S,
  );
  return {verdict: verdict as Claim['verdict'], remaining: Number(remaining)};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"

	"redteam/config" // config.ProbeBudget, config.ProbeKey — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Claim is claimProbe's answer: the verdict (ok, duplicate, budget) and the probes left this hour.
type Claim struct {
	Verdict   string
	Remaining int64
}

// claimProbe claims one probe before a runner sends it.
func claimProbe(ctx context.Context, target, probeHash, category string) (Claim, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	budget := "redteam:budget:" + target
	used, err := rdb.HIncrBy(ctx, budget, "probes", 1).Result()
	if err != nil {
		return Claim{}, err
	}
	_, err = rdb.Get(ctx, config.ProbeKey(target, probeHash)).Result()
	if err == nil {
		return Claim{Verdict: "duplicate", Remaining: config.ProbeBudget - used}, nil
	}
	if !errors.Is(err, redis.Nil) {
		return Claim{}, err
	}
	if used > config.ProbeBudget {
		rdb.HIncrBy(ctx, budget, "probes", -1)
		return Claim{Verdict: "budget"}, nil
	}
	if err := rdb.Set(ctx, config.ProbeKey(target, probeHash), "1", 0).Err(); err != nil {
		return Claim{}, err
	}
	return Claim{Verdict: "ok", Remaining: config.ProbeBudget - used}, nil
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"redteam/config" // config.ProbeBudget, config.DestructiveProbeBudget, config.DestructiveCategories, config.WindowSeconds, config.DedupeTTLSeconds, config.ProbeKey/BudgetKey — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

var claimScript = redis.NewScript(\`
${CLAIM_LUA}
\`)

// Claim is claimProbe's answer: the verdict (ok, duplicate, budget) and the probes left this hour.
type Claim struct {
	Verdict   string
	Remaining int64
}

// claimProbe claims one probe before a runner sends it.
func claimProbe(ctx context.Context, target, probeHash, category string) (Claim, error) {
	window := time.Now().Unix() / config.WindowSeconds
	destructive := "0"
	if config.DestructiveCategories[category] {
		destructive = "1"
	}
	keys := []string{config.ProbeKey(target, probeHash), config.BudgetKey(target, window)}
	reply, err := claimScript.Run(ctx, rdb, keys, destructive, config.ProbeBudget, config.DestructiveProbeBudget, config.WindowSeconds, config.DedupeTTLSeconds).Slice()
	if err != nil {
		return Claim{}, err
	}
	remaining, _ := strconv.ParseInt(fmt.Sprint(reply[1]), 10, 64)
	return Claim{Verdict: fmt.Sprint(reply[0]), Remaining: remaining}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import redteam.Config

/** claimProbe's answer: the verdict (ok, duplicate, budget) and the probes left this hour. */
final case class Claim(verdict: String, remaining: Long)

object ProbeState {
  val jedis = new JedisPooled("redis", 6379)

  /** Claim one probe before a runner sends it. */
  def claimProbe(target: String, probeHash: String, category: String): Claim = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val budget = s"redteam:budget:$target"
    val used = jedis.hincrBy(budget, "probes", 1)
    if (jedis.get(Config.probeKey(target, probeHash)) != null) {
      Claim("duplicate", Config.ProbeBudget - used)
    } else if (used > Config.ProbeBudget) {
      jedis.hincrBy(budget, "probes", -1)
      Claim("budget", 0)
    } else {
      jedis.set(Config.probeKey(target, probeHash), "1")
      Claim("ok", Config.ProbeBudget - used)
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import redteam.Config

/** claimProbe's answer: the verdict (ok, duplicate, budget) and the probes left this hour. */
final case class Claim(verdict: String, remaining: Long)

object ProbeState {
  val jedis = new JedisPooled("redis", 6379)

  val ClaimScript: String =
    """${scalaLua}""".stripMargin

  /** Claim one probe before a runner sends it. */
  def claimProbe(target: String, probeHash: String, category: String): Claim = {
    val window = System.currentTimeMillis() / 1000 / Config.WindowSeconds
    val keys = List(Config.probeKey(target, probeHash), Config.budgetKey(target, window))
    val args = List(
      if (Config.DestructiveCategories.contains(category)) "1" else "0",
      Config.ProbeBudget.toString,
      Config.DestructiveProbeBudget.toString,
      Config.WindowSeconds.toString,
      Config.DedupeTtlSeconds.toString
    )
    val reply = jedis.eval(ClaimScript, keys.asJava, args.asJava).asInstanceOf[java.util.List[AnyRef]].asScala.map(_.toString)
    Claim(reply(0), reply(1).toLong)
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

#include "redteam/config.h"  // config::kProbeBudget, config::probe_key — provided

sw::redis::Redis redis("tcp://redis:6379");

// claim_probe's answer: the verdict (ok, duplicate, budget) and the probes left this hour.
struct Claim {
  std::string verdict;
  long long remaining = 0;
};

// Claim one probe before a runner sends it.
Claim claim_probe(const std::string& target, const std::string& probe_hash, const std::string& category) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  (void)category;
  const std::string budget = "redteam:budget:" + target;
  const long long used = redis.hincrby(budget, "probes", 1);
  if (redis.get(config::probe_key(target, probe_hash))) return {"duplicate", config::kProbeBudget - used};
  if (used > config::kProbeBudget) {
    redis.hincrby(budget, "probes", -1);
    return {"budget", 0};
  }
  redis.set(config::probe_key(target, probe_hash), "1");
  return {"ok", config::kProbeBudget - used};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>
#include <tuple>

#include "redteam/config.h"  // config::kProbeBudget, kDestructiveProbeBudget, kDestructiveCategories, kWindowSeconds, kDedupeTtlSeconds, probe_key, budget_key — provided

sw::redis::Redis redis("tcp://redis:6379");

const std::string kClaim = R"lua(
${CLAIM_LUA}
)lua";

// claim_probe's answer: the verdict (ok, duplicate, budget) and the probes left this hour.
struct Claim {
  std::string verdict;
  long long remaining = 0;
};

// Claim one probe before a runner sends it.
Claim claim_probe(const std::string& target, const std::string& probe_hash, const std::string& category) {
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long long window = now / config::kWindowSeconds;
  const auto [verdict, remaining] = redis.eval<std::string, std::string>(
      kClaim, {config::probe_key(target, probe_hash), config::budget_key(target, window)},
      {config::kDestructiveCategories.count(category) > 0 ? std::string("1") : std::string("0"),
       std::to_string(config::kProbeBudget), std::to_string(config::kDestructiveProbeBudget),
       std::to_string(config::kWindowSeconds), std::to_string(config::kDedupeTtlSeconds)});
  return {verdict, std::stoll(remaining)};
}
`,
    },
  },
  harness: {
    python: `import time

from redteam import config

TARGET = "checkout-shadow"


def _claim(m, probe_hash, category="prompt-injection"):
    result = m.claim_probe(TARGET, probe_hash, category)
    assert isinstance(result, dict) and "verdict" in result, f"claim_probe must return {{verdict, remaining}}, got {result!r}"
    return result


def _align(ctx):
    """Move the clock to one second into a fresh budget window, so a scenario never straddles two."""
    ctx.clock.advance(config.WINDOW_S - time.time() % config.WINDOW_S + 1)


def _budget(ctx):
    return config.budget_key(TARGET, int(time.time()) // config.WINDOW_S)


def check_duplicate_free(ctx):
    m = ctx.load("state")
    first = _claim(m, "h-1")
    assert first["verdict"] == "ok" and first["remaining"] == 199, f"a fresh probe is claimed with 199 left this hour, got {first}"
    again = _claim(m, "h-1")
    assert again["verdict"] == "duplicate", f"the same probe again must be a duplicate, got {again}"
    assert again["remaining"] == 199, f"a duplicate draws nothing: {again['remaining']} left after the replay, expected 199 (the counter moved before the probe key was tested)"
    second = _claim(m, "h-2")
    assert second["verdict"] == "ok" and second["remaining"] == 198, f"the second distinct probe leaves 198, got {second}: replays were charged"


def check_atomic_claim(ctx):
    m = ctx.load("state")
    key = config.probe_key(TARGET, "h-race")

    def other_runner():
        # a second runner replaying the same probe, landing between two of this runner's commands
        return "ok" if ctx.redis.set(key, "1", nx=True, ex=config.DEDUPE_TTL_S) else "duplicate"

    probe = ctx.redis_after(key, other_runner)
    mine = _claim(m, "h-race")
    assert probe.fired, "claim_probe never touched the probe key"
    verdicts = sorted([mine["verdict"], probe.result])
    assert verdicts == ["duplicate", "ok"], f"two runners claimed the same probe and got {verdicts}: the test and the claim must run in one script, so exactly one runner sends it"

    # the hour's last slot: another runner takes it between this runner's budget read and its count
    _align(ctx)
    budget = _budget(ctx)
    ctx.redis.hset(budget, "probes", config.PROBE_BUDGET - 1)

    def last_slot():
        if int(ctx.redis.hget(budget, "probes") or 0) >= config.PROBE_BUDGET:
            return "budget"
        ctx.redis.hincrby(budget, "probes", 1)
        return "ok"

    rival = ctx.redis_after(budget, last_slot)
    mine = _claim(m, "h-last")
    assert rival.fired, f"claim_probe never touched this hour's budget {budget}"
    verdicts = sorted([mine["verdict"], rival.result])
    assert verdicts == ["budget", "ok"], f"two runners took the hour's last probe slot and got {verdicts}: the budget test and the count must run in the same script, so the budget holds at {config.PROBE_BUDGET}"


def check_destructive_cap(ctx):
    m = ctx.load("state")
    for i in range(5):
        r = _claim(m, f"n-{i}", "jailbreak")
        assert r["verdict"] == "ok", f"non-destructive probe {i + 1} must be claimed, got {r}"
    for i in range(20):
        r = _claim(m, f"d-{i}", "data-exfil")
        assert r["verdict"] == "ok", f"destructive probe {i + 1} of 20 must be claimed after 5 non-destructive ones, got {r}: only destructive probes count toward DESTRUCTIVE_PROBE_BUDGET"
    over = _claim(m, "d-20", "resource-exhaustion")
    assert over["verdict"] == "budget", f"the 21st destructive probe this hour answered {over}: DESTRUCTIVE_PROBE_BUDGET is 20"
    other = _claim(m, "p-1", "prompt-injection")
    assert other["verdict"] == "ok" and other["remaining"] == 174, f"other categories go on with the hour's budget (174 left after 26 claims), got {other}"
    again = _claim(m, "d-20", "data-exfil")
    assert again["verdict"] == "budget", f"a refused probe is not claimed: asking again must still be budget, got {again}"


def check_hourly_window(ctx):
    m = ctx.load("state")
    _align(ctx)
    key = _budget(ctx)
    at_first = ctx.redis_after(key, lambda: ctx.redis.ttl(key))
    for i in range(200):
        r = _claim(m, f"p-{i}")
        assert r["verdict"] == "ok", f"probe {i + 1} of 200 must be claimed, got {r}"
    assert at_first.fired, f"the hour's counters belong in {key} (budget_key(target, window)), the budget keys are {ctx.redis.keys('redteam:budget:*')}"
    assert at_first.result != -1, f"right after the first claim {key} existed with no expiry: the expiry is set by the same script that counts"
    refused = _claim(m, "p-200")
    assert refused["verdict"] == "budget", f"the 201st probe this hour answered {refused}"
    assert ctx.redis.hget(key, "probes") == "200", f"the hour's counters belong in {key} (budget_key(target, window)), the budget keys are {ctx.redis.keys('redteam:budget:*')}"
    ttl = ctx.redis.ttl(key)
    assert 0 < ttl <= config.WINDOW_S, f"{key} has TTL {ttl}: a window's counters expire within WINDOW_S"
    ctx.clock.advance(config.WINDOW_S - 10)
    late = _claim(m, "p-201")
    assert late["verdict"] == "budget", f"10 s before the hour ends the target's budget is still spent, got {late}: the counters expired inside their window (EXPIRE takes seconds)"
    ctx.clock.advance(10)
    later = _claim(m, "p-200")
    assert later["verdict"] == "ok", f"an hour later the target has a fresh budget, got {later}: the cap became permanent"


def check_claim_ttl(ctx):
    m = ctx.load("state")
    key = config.probe_key(TARGET, "h-1")
    at_claim = ctx.redis_after(key, lambda: ctx.redis.ttl(key))
    assert _claim(m, "h-1")["verdict"] == "ok"
    assert at_claim.fired and at_claim.result != -1, "right after the claim the probe key existed with no expiry: SET it with EX in the claiming script"
    ttl = ctx.redis.ttl(key)
    assert 0 < ttl <= config.DEDUPE_TTL_S, f"the claimed probe key has TTL {ttl}: it expires after DEDUPE_TTL_S (86400 s)"
    ctx.clock.advance(config.DEDUPE_TTL_S - 60)
    same_day = _claim(m, "h-1")
    assert same_day["verdict"] == "duplicate", f"a minute short of a day the probe is still claimed, got {same_day}: the claim lasts DEDUPE_TTL_S (86400 s)"
    ctx.clock.advance(61)
    again = _claim(m, "h-1")
    assert again["verdict"] == "ok", f"a day later the probe may run again, got {again}: the claim never expires"
`,
    typescript: `const TARGET = 'checkout-shadow';

function world(ctx) {
  return {m: ctx.load('state'), config: ctx.load('/support/redteam/config.ts')};
}

async function claim(m, probeHash: string, category = 'prompt-injection') {
  const result = await m.claimProbe(TARGET, probeHash, category);
  assert(result !== null && typeof result === 'object' && 'verdict' in result, \`claimProbe must resolve to {verdict, remaining}, got \${JSON.stringify(result)}\`);
  return result;
}

/** Move the clock to one second into a fresh budget window, so a scenario never straddles two. */
function align(ctx, config) {
  const nowS = ctx.clock.now() / 1000;
  ctx.clock.advance(config.WINDOW_S - (nowS % config.WINDOW_S) + 1);
  return config.budgetKey(TARGET, Math.floor(ctx.clock.now() / 1000 / config.WINDOW_S));
}

export async function check_duplicate_free(ctx) {
  const {m} = world(ctx);
  const first = await claim(m, 'h-1');
  assert(first.verdict === 'ok' && first.remaining === 199, \`a fresh probe is claimed with 199 left this hour, got \${JSON.stringify(first)}\`);
  const again = await claim(m, 'h-1');
  assert.equal(again.verdict, 'duplicate', \`the same probe again must be a duplicate, got \${JSON.stringify(again)}\`);
  assert.equal(again.remaining, 199, \`a duplicate draws nothing: \${again.remaining} left after the replay, expected 199 (the counter moved before the probe key was tested)\`);
  const second = await claim(m, 'h-2');
  assert(second.verdict === 'ok' && second.remaining === 198, \`the second distinct probe leaves 198, got \${JSON.stringify(second)}: replays were charged\`);
}

export async function check_atomic_claim(ctx) {
  const {m, config} = world(ctx);
  const key = config.probeKey(TARGET, 'h-race');
  // a second runner replaying the same probe, landing between two of this runner's commands
  const probe = ctx.redisAfter(key, () => (ctx.redis.set(key, '1', 'NX', 'EX', config.DEDUPE_TTL_S) === 'OK' ? 'ok' : 'duplicate'));
  const mine = await claim(m, 'h-race');
  assert(probe.fired, 'claimProbe never touched the probe key');
  const verdicts = [mine.verdict, probe.result].sort();
  assert.deepEqual(verdicts, ['duplicate', 'ok'], \`two runners claimed the same probe and got \${JSON.stringify(verdicts)}: the test and the claim must run in one script, so exactly one runner sends it\`);

  // the hour's last slot: another runner takes it between this runner's budget read and its count
  const budget = align(ctx, config);
  ctx.redis.hset(budget, 'probes', config.PROBE_BUDGET - 1);
  const rival = ctx.redisAfter(budget, () => {
    if (Number(ctx.redis.hget(budget, 'probes') ?? 0) >= config.PROBE_BUDGET) return 'budget';
    ctx.redis.hincrby(budget, 'probes', 1);
    return 'ok';
  });
  const last = await claim(m, 'h-last');
  assert(rival.fired, \`claimProbe never touched this hour's budget \${budget}\`);
  const lastVerdicts = [last.verdict, rival.result].sort();
  assert.deepEqual(lastVerdicts, ['budget', 'ok'], \`two runners took the hour's last probe slot and got \${JSON.stringify(lastVerdicts)}: the budget test and the count must run in the same script, so the budget holds at \${config.PROBE_BUDGET}\`);
}

export async function check_destructive_cap(ctx) {
  const {m} = world(ctx);
  for (let i = 0; i < 5; i += 1) {
    const r = await claim(m, \`n-\${i}\`, 'jailbreak');
    assert.equal(r.verdict, 'ok', \`non-destructive probe \${i + 1} must be claimed, got \${JSON.stringify(r)}\`);
  }
  for (let i = 0; i < 20; i += 1) {
    const r = await claim(m, \`d-\${i}\`, 'data-exfil');
    assert.equal(r.verdict, 'ok', \`destructive probe \${i + 1} of 20 must be claimed after 5 non-destructive ones, got \${JSON.stringify(r)}: only destructive probes count toward DESTRUCTIVE_PROBE_BUDGET\`);
  }
  const over = await claim(m, 'd-20', 'resource-exhaustion');
  assert.equal(over.verdict, 'budget', \`the 21st destructive probe this hour answered \${JSON.stringify(over)}: DESTRUCTIVE_PROBE_BUDGET is 20\`);
  const other = await claim(m, 'p-1', 'prompt-injection');
  assert(other.verdict === 'ok' && other.remaining === 174, \`other categories go on with the hour's budget (174 left after 26 claims), got \${JSON.stringify(other)}\`);
  const again = await claim(m, 'd-20', 'data-exfil');
  assert.equal(again.verdict, 'budget', \`a refused probe is not claimed: asking again must still be budget, got \${JSON.stringify(again)}\`);
}

export async function check_hourly_window(ctx) {
  const {m, config} = world(ctx);
  const key = align(ctx, config);
  const atFirst = ctx.redisAfter(key, () => Number(ctx.redis.ttl(key)));
  for (let i = 0; i < 200; i += 1) {
    const r = await claim(m, \`p-\${i}\`);
    assert.equal(r.verdict, 'ok', \`probe \${i + 1} of 200 must be claimed, got \${JSON.stringify(r)}\`);
  }
  assert(atFirst.fired, \`the hour's counters belong in \${key} (budgetKey(target, window)), the budget keys are \${JSON.stringify(ctx.redis.keys('redteam:budget:*'))}\`);
  assert(atFirst.result !== -1, \`right after the first claim \${key} existed with no expiry: the expiry is set by the same script that counts\`);
  const refused = await claim(m, 'p-200');
  assert.equal(refused.verdict, 'budget', \`the 201st probe this hour answered \${JSON.stringify(refused)}\`);
  assert.equal(ctx.redis.hget(key, 'probes'), '200', \`the hour's counters belong in \${key} (budgetKey(target, window)), the budget keys are \${JSON.stringify(ctx.redis.keys('redteam:budget:*'))}\`);
  const ttl = Number(ctx.redis.ttl(key));
  assert(0 < ttl && ttl <= config.WINDOW_S, \`\${key} has TTL \${ttl}: a window's counters expire within WINDOW_S\`);
  ctx.clock.advance(config.WINDOW_S - 10);
  const late = await claim(m, 'p-201');
  assert.equal(late.verdict, 'budget', \`10 s before the hour ends the target's budget is still spent, got \${JSON.stringify(late)}: the counters expired inside their window (EXPIRE takes seconds)\`);
  ctx.clock.advance(10);
  const later = await claim(m, 'p-200');
  assert.equal(later.verdict, 'ok', \`an hour later the target has a fresh budget, got \${JSON.stringify(later)}: the cap became permanent\`);
}

export async function check_claim_ttl(ctx) {
  const {m, config} = world(ctx);
  const key = config.probeKey(TARGET, 'h-1');
  const atClaim = ctx.redisAfter(key, () => Number(ctx.redis.ttl(key)));
  assert.equal((await claim(m, 'h-1')).verdict, 'ok');
  assert(atClaim.fired && atClaim.result !== -1, 'right after the claim the probe key existed with no expiry: SET it with EX in the claiming script');
  const ttl = Number(ctx.redis.ttl(key));
  assert(0 < ttl && ttl <= config.DEDUPE_TTL_S, \`the claimed probe key has TTL \${ttl}: it expires after DEDUPE_TTL_S (86400 s)\`);
  ctx.clock.advance(config.DEDUPE_TTL_S - 60);
  const sameDay = await claim(m, 'h-1');
  assert.equal(sameDay.verdict, 'duplicate', \`a minute short of a day the probe is still claimed, got \${JSON.stringify(sameDay)}: the claim lasts DEDUPE_TTL_S (86400 s)\`);
  ctx.clock.advance(61);
  const again = await claim(m, 'h-1');
  assert.equal(again.verdict, 'ok', \`a day later the probe may run again, got \${JSON.stringify(again)}: the claim never expires\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"sort"
	"strconv"

	"redteam/config"

	"leetbuild/harness"
)

const stateTarget = "checkout-shadow"

func stateClaim(ctx *harness.Ctx, probeHash, category string) Claim {
	c, err := claimProbe(context.Background(), stateTarget, probeHash, category)
	ctx.NoError(err, "claimProbe(%q)", probeHash)
	return c
}

// stateAlign moves the clock to one second into a fresh budget window, so a scenario never straddles two, and returns that window's budget key.
func stateAlign(ctx *harness.Ctx) string {
	windowMs := int64(config.WindowSeconds) * 1000
	ctx.Clock.Advance(float64(windowMs-ctx.Clock.Now()%windowMs)/1000 + 1)
	return config.BudgetKey(stateTarget, ctx.Clock.Now()/1000/config.WindowSeconds)
}

func CheckDuplicateFree(ctx *harness.Ctx) {
	first := stateClaim(ctx, "h-1", "prompt-injection")
	ctx.Assert(first.Verdict == "ok" && first.Remaining == 199, "a fresh probe is claimed with 199 left this hour, got %+v", first)
	again := stateClaim(ctx, "h-1", "prompt-injection")
	ctx.Equal(again.Verdict, "duplicate", "the same probe again; the verdict")
	ctx.Equal(again.Remaining, int64(199), "a duplicate draws nothing (the counter moved before the probe key was tested); remaining after the replay")
	second := stateClaim(ctx, "h-2", "prompt-injection")
	ctx.Assert(second.Verdict == "ok" && second.Remaining == 198, "the second distinct probe leaves 198, got %+v: replays were charged", second)
}

func CheckAtomicClaim(ctx *harness.Ctx) {
	key := config.ProbeKey(stateTarget, "h-race")
	other := ""
	// a second runner replaying the same probe, landing between two of this runner's commands
	ctx.Redis.After(key, func() any {
		if ctx.Redis.Set(key, "1", "NX", "EX", config.DedupeTTLSeconds) {
			other = "ok"
		} else {
			other = "duplicate"
		}
		return nil
	})
	mine := stateClaim(ctx, "h-race", "prompt-injection")
	ctx.Assert(other != "", "claimProbe never touched the probe key")
	verdicts := []string{mine.Verdict, other}
	sort.Strings(verdicts)
	ctx.Equal(verdicts, []string{"duplicate", "ok"}, "two runners claimed the same probe: the test and the claim must run in one script, so exactly one runner sends it; the verdicts")

	// the hour's last slot: another runner takes it between this runner's budget read and its count
	budget := stateAlign(ctx)
	ctx.Redis.Do("HSET", budget, "probes", config.ProbeBudget-1)
	rival := ""
	ctx.Redis.After(budget, func() any {
		used, _ := ctx.Redis.HGet(budget, "probes")
		if n, _ := strconv.Atoi(used); n >= config.ProbeBudget {
			rival = "budget"
		} else {
			ctx.Redis.Do("HINCRBY", budget, "probes", 1)
			rival = "ok"
		}
		return nil
	})
	last := stateClaim(ctx, "h-last", "prompt-injection")
	ctx.Assert(rival != "", "claimProbe never touched this hour's budget %s", budget)
	lastVerdicts := []string{last.Verdict, rival}
	sort.Strings(lastVerdicts)
	ctx.Equal(lastVerdicts, []string{"budget", "ok"}, "two runners took the hour's last probe slot: the budget test and the count must run in the same script, so the budget holds at 200; the verdicts")
}

func CheckDestructiveCap(ctx *harness.Ctx) {
	for i := 0; i < 5; i++ {
		r := stateClaim(ctx, fmt.Sprintf("n-%d", i), "jailbreak")
		ctx.Equal(r.Verdict, "ok", "non-destructive probe %d; the verdict", i+1)
	}
	for i := 0; i < 20; i++ {
		r := stateClaim(ctx, fmt.Sprintf("d-%d", i), "data-exfil")
		ctx.Equal(r.Verdict, "ok", "destructive probe %d of 20 after 5 non-destructive ones (only destructive probes count toward DestructiveProbeBudget); the verdict", i+1)
	}
	over := stateClaim(ctx, "d-20", "resource-exhaustion")
	ctx.Equal(over.Verdict, "budget", "the 21st destructive probe this hour (DestructiveProbeBudget is 20); the verdict")
	other := stateClaim(ctx, "p-1", "prompt-injection")
	ctx.Assert(other.Verdict == "ok" && other.Remaining == 174, "other categories go on with the hour's budget (174 left after 26 claims), got %+v", other)
	again := stateClaim(ctx, "d-20", "data-exfil")
	ctx.Equal(again.Verdict, "budget", "a refused probe is not claimed: asking again; the verdict")
}

func CheckHourlyWindow(ctx *harness.Ctx) {
	key := stateAlign(ctx)
	atFirst := int64(-3)
	ctx.Redis.After(key, func() any {
		atFirst = ctx.Redis.TTL(key)
		return nil
	})
	for i := 0; i < 200; i++ {
		r := stateClaim(ctx, fmt.Sprintf("p-%d", i), "prompt-injection")
		ctx.Equal(r.Verdict, "ok", "probe %d of 200; the verdict", i+1)
	}
	ctx.Assert(atFirst != -3, "the hour's counters belong in %s (BudgetKey(target, window)); budget keys %v", key, ctx.Redis.Keys("redteam:budget:*"))
	ctx.Assert(atFirst != -1, "right after the first claim %s existed with no expiry: the expiry is set by the same script that counts", key)
	refused := stateClaim(ctx, "p-200", "prompt-injection")
	ctx.Equal(refused.Verdict, "budget", "the 201st probe this hour; the verdict")
	probes, _ := ctx.Redis.HGet(key, "probes")
	ctx.Equal(probes, "200", "the hour's counters belong in %s (BudgetKey(target, window)); budget keys %v; its probes", key, ctx.Redis.Keys("redteam:budget:*"))
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(0 < ttl && ttl <= config.WindowSeconds, "%s has TTL %d: a window's counters expire within WindowSeconds", key, ttl)
	ctx.Clock.Advance(config.WindowSeconds - 10)
	late := stateClaim(ctx, "p-201", "prompt-injection")
	ctx.Equal(late.Verdict, "budget", "10 s before the hour ends the target's budget is still spent (the counters expired inside their window; EXPIRE takes seconds); the verdict")
	ctx.Clock.Advance(10)
	later := stateClaim(ctx, "p-200", "prompt-injection")
	ctx.Equal(later.Verdict, "ok", "an hour later the target has a fresh budget (the cap became permanent); the verdict")
}

func CheckClaimTtl(ctx *harness.Ctx) {
	key := config.ProbeKey(stateTarget, "h-1")
	atClaim := int64(-3)
	ctx.Redis.After(key, func() any {
		atClaim = ctx.Redis.TTL(key)
		return nil
	})
	ctx.Equal(stateClaim(ctx, "h-1", "prompt-injection").Verdict, "ok", "a fresh probe; the verdict")
	ctx.Assert(atClaim != -3 && atClaim != -1, "right after the claim the probe key existed with no expiry: SET it with EX in the claiming script")
	ttl := ctx.Redis.TTL(key)
	ctx.Assert(0 < ttl && ttl <= config.DedupeTTLSeconds, "the claimed probe key has TTL %d: it expires after DedupeTTLSeconds (86400 s)", ttl)
	ctx.Clock.Advance(config.DedupeTTLSeconds - 60)
	ctx.Equal(stateClaim(ctx, "h-1", "prompt-injection").Verdict, "duplicate", "a minute short of a day the probe is still claimed (the claim lasts DedupeTTLSeconds, 86400 s); the verdict")
	ctx.Clock.Advance(61)
	again := stateClaim(ctx, "h-1", "prompt-injection")
	ctx.Equal(again.Verdict, "ok", "a day later the probe may run again (the claim never expires); the verdict")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <string>
#include <vector>

namespace {

const std::string kStateTarget = "checkout-shadow";

// Move the clock to one second into a fresh budget window, so a scenario never straddles two; that window's budget key.
std::string harness_align_window(harness::Ctx& ctx) {
  const long long window_ms = config::kWindowSeconds * 1000;
  ctx.Clock.Advance(static_cast<double>(window_ms - ctx.Clock.Now() % window_ms) / 1000 + 1);
  return config::budget_key(kStateTarget, ctx.Clock.Now() / 1000 / config::kWindowSeconds);
}

}  // namespace

void CheckDuplicateFree(harness::Ctx& ctx) {
  const Claim first = claim_probe(kStateTarget, "h-1", "prompt-injection");
  ctx.Assert(first.verdict == "ok" && first.remaining == 199, "a fresh probe is claimed with 199 left this hour, got %s with %d left", first.verdict, first.remaining);
  const Claim again = claim_probe(kStateTarget, "h-1", "prompt-injection");
  ctx.Equal(again.verdict, "duplicate", "the same probe again; the verdict");
  ctx.Equal(again.remaining, 199, "a duplicate draws nothing (the counter moved before the probe key was tested); remaining after the replay");
  const Claim second = claim_probe(kStateTarget, "h-2", "prompt-injection");
  ctx.Assert(second.verdict == "ok" && second.remaining == 198, "the second distinct probe leaves 198, got %s with %d left: replays were charged", second.verdict, second.remaining);
}

void CheckAtomicClaim(harness::Ctx& ctx) {
  const std::string key = config::probe_key(kStateTarget, "h-race");
  std::string other;
  // a second runner replaying the same probe, landing between two of this runner's commands
  ctx.Redis.After(key, [&] { other = ctx.Redis.Set(key, "1", "NX", "EX", config::kDedupeTtlSeconds) ? "ok" : "duplicate"; });
  const Claim mine = claim_probe(kStateTarget, "h-race", "prompt-injection");
  ctx.Assert(!other.empty(), "claim_probe never touched the probe key");
  std::vector<std::string> verdicts = {mine.verdict, other};
  std::sort(verdicts.begin(), verdicts.end());
  ctx.Equal(verdicts, {"duplicate", "ok"}, "two runners claimed the same probe: the test and the claim must run in one script, so exactly one runner sends it; the verdicts");

  // the hour's last slot: another runner takes it between this runner's budget read and its count
  const std::string budget = harness_align_window(ctx);
  ctx.Redis.Do("HSET", budget, "probes", config::kProbeBudget - 1);
  std::string rival;
  ctx.Redis.After(budget, [&] {
    const auto used = ctx.Redis.HGet(budget, "probes");
    if (used && std::stoll(*used) >= config::kProbeBudget) {
      rival = "budget";
    } else {
      ctx.Redis.Do("HINCRBY", budget, "probes", 1);
      rival = "ok";
    }
  });
  const Claim last = claim_probe(kStateTarget, "h-last", "prompt-injection");
  ctx.Assert(!rival.empty(), "claim_probe never touched this hour's budget %s", budget);
  std::vector<std::string> last_verdicts = {last.verdict, rival};
  std::sort(last_verdicts.begin(), last_verdicts.end());
  ctx.Equal(last_verdicts, {"budget", "ok"}, "two runners took the hour's last probe slot: the budget test and the count must run in the same script, so the budget holds at 200; the verdicts");
}

void CheckDestructiveCap(harness::Ctx& ctx) {
  for (int i = 0; i < 5; i++) {
    ctx.Equal(claim_probe(kStateTarget, "n-" + std::to_string(i), "jailbreak").verdict, "ok", "non-destructive probe %d; the verdict", i + 1);
  }
  for (int i = 0; i < 20; i++) {
    ctx.Equal(claim_probe(kStateTarget, "d-" + std::to_string(i), "data-exfil").verdict, "ok", "destructive probe %d of 20 after 5 non-destructive ones (only destructive probes count toward kDestructiveProbeBudget); the verdict", i + 1);
  }
  const Claim over = claim_probe(kStateTarget, "d-20", "resource-exhaustion");
  ctx.Equal(over.verdict, "budget", "the 21st destructive probe this hour (kDestructiveProbeBudget is 20); the verdict");
  const Claim other = claim_probe(kStateTarget, "p-1", "prompt-injection");
  ctx.Assert(other.verdict == "ok" && other.remaining == 174, "other categories go on with the hour's budget (174 left after 26 claims), got %s with %d left", other.verdict, other.remaining);
  ctx.Equal(claim_probe(kStateTarget, "d-20", "data-exfil").verdict, "budget", "a refused probe is not claimed: asking again; the verdict");
}

void CheckHourlyWindow(harness::Ctx& ctx) {
  const std::string key = harness_align_window(ctx);
  long long at_first = -3;
  ctx.Redis.After(key, [&] { at_first = ctx.Redis.TTL(key); });
  for (int i = 0; i < 200; i++) {
    ctx.Equal(claim_probe(kStateTarget, "p-" + std::to_string(i), "prompt-injection").verdict, "ok", "probe %d of 200; the verdict", i + 1);
  }
  ctx.Assert(at_first != -3, "the hour's counters belong in %s (budget_key(target, window)), the budget keys are %v", key, ctx.Redis.Keys("redteam:budget:*"));
  ctx.Assert(at_first != -1, "right after the first claim %s existed with no expiry: the expiry is set by the same script that counts", key);
  ctx.Equal(claim_probe(kStateTarget, "p-200", "prompt-injection").verdict, "budget", "the 201st probe this hour; the verdict");
  const auto probes = ctx.Redis.HGet(key, "probes");
  ctx.Assert(probes && *probes == "200", "the hour's counters belong in %s (budget_key(target, window)), the budget keys are %v", key, ctx.Redis.Keys("redteam:budget:*"));
  const long long ttl = ctx.Redis.TTL(key);
  ctx.Assert(0 < ttl && ttl <= config::kWindowSeconds, "%s has TTL %d: a window's counters expire within kWindowSeconds", key, ttl);
  ctx.Clock.Advance(config::kWindowSeconds - 10);
  ctx.Equal(claim_probe(kStateTarget, "p-201", "prompt-injection").verdict, "budget", "10 s before the hour ends the target's budget is still spent (the counters expired inside their window; EXPIRE takes seconds); the verdict");
  ctx.Clock.Advance(10);
  ctx.Equal(claim_probe(kStateTarget, "p-200", "prompt-injection").verdict, "ok", "an hour later the target has a fresh budget (the cap became permanent); the verdict");
}

void CheckClaimTtl(harness::Ctx& ctx) {
  const std::string key = config::probe_key(kStateTarget, "h-1");
  long long at_claim = -3;
  ctx.Redis.After(key, [&] { at_claim = ctx.Redis.TTL(key); });
  ctx.Equal(claim_probe(kStateTarget, "h-1", "prompt-injection").verdict, "ok", "a fresh probe; the verdict");
  ctx.Assert(at_claim != -3 && at_claim != -1, "right after the claim the probe key existed with no expiry: SET it with EX in the claiming script");
  const long long ttl = ctx.Redis.TTL(key);
  ctx.Assert(0 < ttl && ttl <= config::kDedupeTtlSeconds, "the claimed probe key has TTL %d: it expires after kDedupeTtlSeconds (86400 s)", ttl);
  ctx.Clock.Advance(config::kDedupeTtlSeconds - 60);
  ctx.Equal(claim_probe(kStateTarget, "h-1", "prompt-injection").verdict, "duplicate", "a minute short of a day the probe is still claimed (the claim lasts kDedupeTtlSeconds, 86400 s); the verdict");
  ctx.Clock.Advance(61);
  ctx.Equal(claim_probe(kStateTarget, "h-1", "prompt-injection").verdict, "ok", "a day later the probe may run again (the claim never expires); the verdict");
}
`,
  },
  hints: [
    'Symptom: two runner replicas send the same probe within a millisecond, replays shrink the hour’s budget, a target capped yesterday is still capped today, and destructive probes use all 200 slots.',
    'Mechanism: the counter moves before the probe key is read; GET and SET are separate round trips another runner can land between; the budget key has no window or TTL, the probe key no TTL, and one cap covers every category.',
    'Change: one `register_script` / `defineCommand` / `NewScript` / `eval`: EXISTS the probe key, HGET both counters against the two caps, then SET EX `DEDUPE_TTL_S`, HINCRBY, EXPIRE `WINDOW_S` on `budget_key(target, window)`.',
  ],
  debrief: `One script answers three questions in a fixed order (claimed already? affordable? then take it) because Redis runs it alone, so no second runner can land between them, and a duplicate is free because the test comes before any counter moves. A refused probe is not claimed, which leaves it runnable next hour. Putting the window in the key makes the hour a property of the data: when the clock moves on, a new key starts at zero and the old one expires on its own. The destructive cap is a second counter in the same hash, checked in the same script. A fleet of runners in Redis Cluster would add a hash tag such as \`{target}\` to both keys so the script's keys share a slot.`,
};
