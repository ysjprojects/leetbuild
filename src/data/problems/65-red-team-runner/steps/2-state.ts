import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis probe dedupe and per-target budgets',
  concept: 'redis',
  file: 'state',
  focus: ['runner', 'redis', 'sandbox'],
  task: `## Task

The starter is a plausible model-generated draft: a probe runs, the target's counter goes up, and a
duplicate is skipped. It races under concurrency, it keeps spending after the cap is reached, and
its keys never die. Find the flaws, fix them, and prove the fix.

Implement \`record_probe\`, called once per executed probe with
\`{"target": "checkout-shadow", "probe_hash": "9f2c…", "category": "prompt-injection"}\`:

- A probe is identified by \`(target, probe_hash)\` and lives under its **own dedupe key**
  \`redteam:probe:{target}:{probe_hash}\`, claimed with **one atomic \`SET\` … \`NX\` \`EX\`** with
  \`DEDUPE_TTL_S = 86_400\`. Two workers replaying the same probe must not both run it; a client-side
  \`GET\` followed by a \`SET\` is exactly the race the draft has.
- Each target gets an **hourly probe budget** under \`redteam:budget:{target}:{window}\`, where the
  window is \`int(time.time()) // WINDOW_S\` and \`WINDOW_S = 3600\`. The read, the check and the
  increment happen in **one atomic Lua \`EVAL\`** that also sets \`EXPIRE\` from the window at first
  write, so the budget resets with its hour instead of accumulating forever.
- A **destructive** category (\`resource-exhaustion\`, \`data-exfil\`) draws from its own smaller cap
  \`DESTRUCTIVE_PROBE_BUDGET = 20\` under its own key suffix, so it can never spend the general
  budget of \`PROBE_BUDGET = 200\` even when the general budget has room.
- The dedupe claim happens **before** the budget is reserved: a replayed probe must not count and
  must not re-spend. When the reservation is refused, release the claim so an operator can retry
  after the window rolls.
- Return \`{applied, remaining, ttl}\`; \`applied\` is false for a replayed probe or a refused
  reservation.

**Failure mode the checks target.** The subtle one is the order of the two steps: mark-then-spend
means a replay is free, spend-then-mark means every retry buys more adversarial traffic. The loud
one is the read-modify-write budget, which two concurrent probes both pass. The silent one is the
missing expiry and the missing window bucket: one shared key per target means its probe history
blocks every future run, forever.`,
  sequence: {
    participants: ['Probe runner', 'Second runner', 'Redis'],
    messages: [
      {from: 'Probe runner', to: 'Redis', label: 'SET redteam:probe:t:hash NX EX 86400', kind: 'sync'},
      {from: 'Redis', to: 'Probe runner', label: 'OK — the probe is ours', kind: 'reply'},
      {from: 'Probe runner', to: 'Redis', label: 'EVAL budget INCRBY · EXPIRE 3600', kind: 'sync'},
      {from: 'Redis', to: 'Probe runner', label: '{1, remaining, ttl}', kind: 'reply'},
      {from: 'Second runner', to: 'Redis', label: 'SET same probe NX EX', kind: 'sync'},
      {from: 'Redis', to: 'Second runner', label: 'nil — replay changes nothing', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'dedupe-atomic',
      title: 'Claims the probe with one SET NX EX',
      detail:
        '`(target, probe_hash)` is claimed with a single atomic `SET … NX … EX`, so concurrent duplicates cannot both win. The draft reads the key with `GET` and writes it back, which is a check-then-set race.',
      match: {
        python: {all: [/nx=True/, /ex=DEDUPE_TTL_S/, /dedupe_key\(/], none: [/r\.get\(\s*dedupe_key\(/]},
        typescript: {all: [/'NX'/, /'EX'/, /dedupeKey\(/], none: [/\.get\(\s*dedupeKey\(/]},
        go: {all: [/SetNX\(ctx/, /dedupeTTL/, /dedupeKey\(/], none: [/rdb\.Get\(ctx, dedupeKey\(/]},
        scala: {all: [/\.nx\(\)/, /\.ex\(/, /dedupeKey\(/], none: [/jedis\.get\(dedupeKey\(/]},
        cpp: {all: [/UpdateType::NOT_EXIST/, /kDedupeTtlS/, /dedupeKey\(/], none: [/redis\.get\(dedupeKey\(/]},
      },
    },
    {
      id: 'budget-script',
      title: 'Reserves the hourly budget inside one script',
      detail:
        'One Lua `EVAL` reads the spent count, compares it against the cap, increments and sets `EXPIRE` from the window. The draft increments from the client and never expires the key.',
      match: {
        python: {all: [/RESERVE_LUA/, /INCRBY/, /EXPIRE/, /\.eval\(/]},
        typescript: {all: [/RESERVE_LUA/, /INCRBY/, /EXPIRE/, /\.eval\(/]},
        go: {all: [/reserveScript/, /INCRBY/, /EXPIRE/, /\.Run\(/]},
        scala: {all: [/ReserveLua/, /INCRBY/, /EXPIRE/, /\.eval\(/]},
        cpp: {all: [/kReserveLua/, /INCRBY/, /EXPIRE/, /\.eval</]},
      },
    },
    {
      id: 'destructive-budget',
      title: 'Caps destructive categories on their own budget',
      detail:
        'A destructive category draws from `DESTRUCTIVE_PROBE_BUDGET` under its own key, checked against `DESTRUCTIVE_CATEGORIES` before the reservation. The draft has one shared cap, so destructive payloads can consume the whole target budget.',
      match: {
        python: {all: [/DESTRUCTIVE_PROBE_BUDGET/, /DESTRUCTIVE_CATEGORIES/, /budget_key\(/]},
        typescript: {all: [/DESTRUCTIVE_PROBE_BUDGET/, /DESTRUCTIVE_CATEGORIES/, /budgetKey\(/]},
        go: {all: [/destructiveProbeBudget/, /destructiveCategories/, /budgetKey\(/]},
        scala: {all: [/DestructiveProbeBudget/, /DestructiveCategories/, /budgetKey\(/]},
        cpp: {all: [/kDestructiveProbeBudget/, /kDestructiveCategories/, /budgetKey\(/]},
      },
    },
    {
      id: 'claim-before-reserve',
      title: 'Claims the probe before it spends budget',
      detail:
        'The dedupe claim happens before the budget reservation, so a replayed probe neither counts nor re-spends. A draft that reserves first charges the target for every retry of a probe it already ran.',
      match: {
        python: {order: [/nx=True/, /reserve_budget\(/]},
        typescript: {order: [/'NX'/, /reserveBudget\(/]},
        go: {order: [/SetNX\(ctx/, /reserveBudget\(/]},
        scala: {order: [/SetParams/, /reserveBudget\(/]},
        cpp: {order: [/UpdateType::NOT_EXIST/, /reserveBudget\(/]},
      },
    },
    {
      id: 'window-scoped-keys',
      title: 'Scopes keys to the target and the hour',
      detail:
        'Keys are built by a `budget_key`/`dedupe_key` helper from the target and the hour window, with the TTL taken from `WINDOW_S`/`DEDUPE_TTL_S`. The draft writes one key per target with no expiry, so an exhausted target stays exhausted.',
      match: {
        python: {all: [/def budget_key\(/, /WINDOW_S/]},
        typescript: {all: [/function budgetKey\(/, /WINDOW_S/]},
        go: {all: [/func budgetKey\(/, /windowSeconds/]},
        scala: {all: [/def budgetKey\(/, /WindowSeconds/]},
        cpp: {all: [/budgetKey\(/, /kWindowSeconds/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

PROBE_BUDGET = 200


class ProbeResult(BaseModel):
    target: str
    probe_hash: str
    category: str


def dedupe_key(target: str, probe_hash: str) -> str:
    return f"redteam:probe:{target}:{probe_hash}"


@app.post("/v1/redteam/probes")
def record_probe(body: ProbeResult) -> dict:
    # TODO: this draft reads the dedupe key with GET before writing it, so two concurrent
    # duplicates both run; it increments a single never-expiring counter per target with no window,
    # and it has no separate cap for destructive categories. Make the claim atomic, move the budget
    # into one script with a TTL, and give destructive probes their own cap.
    seen = r.get(dedupe_key(body.target, body.probe_hash))
    if seen is not None:
        return {"applied": False}
    r.set(dedupe_key(body.target, body.probe_hash), "1")
    used = r.incr(f"redteam:budget:{body.target}")
    if used > PROBE_BUDGET:
        r.decr(f"redteam:budget:{body.target}")
        return {"applied": False, "budget_exhausted": True}
    return {"applied": True, "remaining": PROBE_BUDGET - used}
`,
      solution: `import time

import redis
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_S = 3600
DEDUPE_TTL_S = 86_400
PROBE_BUDGET = 200
DESTRUCTIVE_PROBE_BUDGET = 20
DESTRUCTIVE_CATEGORIES = {"resource-exhaustion", "data-exfil"}

RESERVE_LUA = """
local used = tonumber(redis.call('GET', KEYS[1])) or 0
local want = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if used + want > limit then
  return {0, limit - used, redis.call('TTL', KEYS[1])}
end
redis.call('INCRBY', KEYS[1], want)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {1, limit - used - want, redis.call('TTL', KEYS[1])}
"""


class ProbeResult(BaseModel):
    target: str
    probe_hash: str
    category: str


def dedupe_key(target: str, probe_hash: str) -> str:
    return f"redteam:probe:{target}:{probe_hash}"


def budget_key(target: str, window: int) -> str:
    return f"redteam:budget:{target}:{window}"


def mark_probe(target: str, probe_hash: str) -> bool:
    """Claim (target, probe hash) with one SET NX EX: exactly one duplicate wins."""
    claimed = r.set(dedupe_key(target, probe_hash), "1", nx=True, ex=DEDUPE_TTL_S)
    return bool(claimed)


def reserve_budget(target: str, category: str) -> tuple[bool, int, int]:
    window = int(time.time()) // WINDOW_S
    destructive = category in DESTRUCTIVE_CATEGORIES
    limit = DESTRUCTIVE_PROBE_BUDGET if destructive else PROBE_BUDGET
    key = budget_key(target, window) + (":destructive" if destructive else "")
    ok, remaining, ttl = r.eval(RESERVE_LUA, 1, key, 1, limit, WINDOW_S)
    return bool(ok), int(remaining), int(ttl)


@app.post("/v1/redteam/probes")
def record_probe(body: ProbeResult) -> dict:
    if not mark_probe(body.target, body.probe_hash):
        return {"applied": False, "reason": "duplicate"}
    ok, remaining, ttl = reserve_budget(body.target, body.category)
    if not ok:
        r.delete(dedupe_key(body.target, body.probe_hash))
        return {"applied": False, "reason": "budget exhausted", "remaining": remaining}
    return {"applied": True, "remaining": remaining, "ttl": ttl}
`,
    },
    typescript: {
      starter: `/** POST /v1/redteam/probes: a model-generated draft that counts its own duplicates. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const PROBE_BUDGET = 200;

interface ProbeBody {
  target: string;
  probe_hash: string;
  category: string;
}

function dedupeKey(target: string, probeHash: string): string {
  return \`redteam:probe:\${target}:\${probeHash}\`;
}

app.post('/v1/redteam/probes', async (request, reply) => {
  // TODO: this draft reads the dedupe key with get before writing it, so two concurrent duplicates
  // both run; it increments a single never-expiring counter per target with no window, and it has
  // no separate cap for destructive categories. Make the claim atomic, move the budget into one
  // script with a TTL, and give destructive probes their own cap.
  const body = request.body as ProbeBody;
  const key = dedupeKey(body.target, body.probe_hash);
  const seen = await r.get(key);
  if (seen !== null) return reply.code(200).send({applied: false});
  await r.set(key, '1');
  const used = await r.incr(\`redteam:budget:\${body.target}\`);
  if (used > PROBE_BUDGET) {
    await r.decr(\`redteam:budget:\${body.target}\`);
    return reply.code(200).send({applied: false, budget_exhausted: true});
  }
  return reply.code(200).send({applied: true, remaining: PROBE_BUDGET - used});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/redteam/probes: one atomic claim, one atomic reservation, one hour at a time. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const WINDOW_S = 3600;
const DEDUPE_TTL_S = 86_400;
const PROBE_BUDGET = 200;
const DESTRUCTIVE_PROBE_BUDGET = 20;
const DESTRUCTIVE_CATEGORIES: Record<string, true> = {'resource-exhaustion': true, 'data-exfil': true};

const RESERVE_LUA = \`
local used = tonumber(redis.call('GET', KEYS[1])) or 0
local want = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if used + want > limit then
  return {0, limit - used, redis.call('TTL', KEYS[1])}
end
redis.call('INCRBY', KEYS[1], want)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {1, limit - used - want, redis.call('TTL', KEYS[1])}
\`;

interface ProbeBody {
  target: string;
  probe_hash: string;
  category: string;
}

function dedupeKey(target: string, probeHash: string): string {
  return \`redteam:probe:\${target}:\${probeHash}\`;
}

function budgetKey(target: string, window: number): string {
  return \`redteam:budget:\${target}:\${window}\`;
}

async function markProbe(target: string, probeHash: string): Promise<boolean> {
  const claimed = await r.set(dedupeKey(target, probeHash), '1', 'NX', 'EX', DEDUPE_TTL_S);
  return claimed === 'OK';
}

async function reserveBudget(target: string, category: string): Promise<[boolean, number, number]> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_S);
  const destructive = DESTRUCTIVE_CATEGORIES[category] === true;
  const limit = destructive ? DESTRUCTIVE_PROBE_BUDGET : PROBE_BUDGET;
  const key = budgetKey(target, window) + (destructive ? ':destructive' : '');
  const reply = (await r.eval(RESERVE_LUA, 1, key, '1', String(limit), String(WINDOW_S))) as [
    number,
    number,
    number,
  ];
  return [reply[0] === 1, reply[1], reply[2]];
}

app.post('/v1/redteam/probes', async (request, reply) => {
  const body = request.body as ProbeBody;
  if (!(await markProbe(body.target, body.probe_hash))) return reply.code(200).send({applied: false, reason: 'duplicate'});
  const [ok, remaining, ttl] = await reserveBudget(body.target, body.category);
  if (!ok) {
    await r.del(dedupeKey(body.target, body.probe_hash));
    return reply.code(200).send({applied: false, reason: 'budget exhausted', remaining});
  }
  return reply.code(200).send({applied: true, remaining, ttl});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/redis/go-redis/v9"
)

const probeBudget = 200

var rdb *redis.Client

type ProbeResult struct {
	Target    string \`json:"target"\`
	ProbeHash string \`json:"probe_hash"\`
	Category  string \`json:"category"\`
}

func dedupeKey(target, probeHash string) string {
	return fmt.Sprintf("redteam:probe:%s:%s", target, probeHash)
}

func recordProbe(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft reads the dedupe key with Get before writing it, so two concurrent
	// duplicates both run; it increments a single never-expiring counter per target with no window,
	// and it has no separate cap for destructive categories. Make the claim atomic, move the budget
	// into one script with a TTL, and give destructive probes their own cap.
	var body ProbeResult
	_ = json.NewDecoder(r.Body).Decode(&body)
	ctx := r.Context()
	if seen, _ := rdb.Get(ctx, dedupeKey(body.Target, body.ProbeHash)).Result(); seen != "" {
		writeJSON(rw, http.StatusOK, map[string]any{"applied": false})
		return
	}
	rdb.Set(ctx, dedupeKey(body.Target, body.ProbeHash), "1", 0)
	used, _ := rdb.Incr(ctx, "redteam:budget:"+body.Target).Result()
	if used > probeBudget {
		rdb.Decr(ctx, "redteam:budget:"+body.Target)
		writeJSON(rw, http.StatusOK, map[string]any{"applied": false, "budget_exhausted": true})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"applied": true, "remaining": probeBudget - used})
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	windowSeconds          = 3600
	dedupeTTL              = 24 * time.Hour
	probeBudget            = 200
	destructiveProbeBudget = 20
)

var destructiveCategories = map[string]bool{"resource-exhaustion": true, "data-exfil": true}

var rdb *redis.Client

var reserveScript = redis.NewScript(\`
local used = tonumber(redis.call('GET', KEYS[1])) or 0
local want = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if used + want > limit then
  return {0, limit - used, redis.call('TTL', KEYS[1])}
end
redis.call('INCRBY', KEYS[1], want)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {1, limit - used - want, redis.call('TTL', KEYS[1])}
\`)

type ProbeResult struct {
	Target    string \`json:"target"\`
	ProbeHash string \`json:"probe_hash"\`
	Category  string \`json:"category"\`
}

func dedupeKey(target, probeHash string) string {
	return fmt.Sprintf("redteam:probe:%s:%s", target, probeHash)
}

func budgetKey(target string, window int64) string {
	return fmt.Sprintf("redteam:budget:%s:%d", target, window)
}

func markProbe(ctx context.Context, target, probeHash string) bool {
	claimed, err := rdb.SetNX(ctx, dedupeKey(target, probeHash), "1", dedupeTTL).Result()
	return err == nil && claimed
}

func reserveBudget(ctx context.Context, target, category string) (bool, int64, int64) {
	window := time.Now().Unix() / windowSeconds
	destructive := destructiveCategories[category]
	limit := int64(probeBudget)
	key := budgetKey(target, window)
	if destructive {
		limit = destructiveProbeBudget
		key += ":destructive"
	}
	values, err := reserveScript.Run(ctx, rdb, []string{key}, 1, limit, windowSeconds).Int64Slice()
	if err != nil {
		return false, 0, 0
	}
	return values[0] == 1, values[1], values[2]
}

func recordProbe(rw http.ResponseWriter, r *http.Request) {
	var body ProbeResult
	_ = json.NewDecoder(r.Body).Decode(&body)
	ctx := r.Context()
	if !markProbe(ctx, body.Target, body.ProbeHash) {
		writeJSON(rw, http.StatusOK, map[string]any{"applied": false, "reason": "duplicate"})
		return
	}
	ok, remaining, ttl := reserveBudget(ctx, body.Target, body.Category)
	if !ok {
		rdb.Del(ctx, dedupeKey(body.Target, body.ProbeHash))
		writeJSON(rw, http.StatusOK, map[string]any{"applied": false, "reason": "budget exhausted", "remaining": remaining})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"applied": true, "remaining": remaining, "ttl": ttl})
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import redis.clients.jedis.Jedis

final case class ProbeResult(target: String, probe_hash: String, category: String)

object State {
  implicit val system: ActorSystem = ActorSystem("red-team-runner")

  val ProbeBudget = 200L
  val jedis = new Jedis("redis", 6379)

  def dedupeKey(target: String, probeHash: String): String = s"redteam:probe:$target:$probeHash"

  // TODO: this draft reads the dedupe key with get before writing it, so two concurrent duplicates
  // both run; it increments a single never-expiring counter per target with no window, and it has
  // no separate cap for destructive categories. Make the claim atomic, move the budget into one
  // script with a TTL, and give destructive probes their own cap.
  def recordProbe(body: ProbeResult): String = {
    val key = dedupeKey(body.target, body.probe_hash)
    if (jedis.get(key) != null) {
      """{"applied":false}"""
    } else {
      jedis.set(key, "1")
      val used = jedis.incr(s"redteam:budget:\${body.target}")
      if (used > ProbeBudget) {
        jedis.decr(s"redteam:budget:\${body.target}")
        """{"applied":false,"budget_exhausted":true}"""
      } else {
        s"""{"applied":true,"remaining":\${ProbeBudget - used}}"""
      }
    }
  }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind()
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import redis.clients.jedis.Jedis
import redis.clients.jedis.params.SetParams

final case class ProbeResult(target: String, probe_hash: String, category: String)

object State {
  implicit val system: ActorSystem = ActorSystem("red-team-runner")

  val WindowSeconds = 3600L
  val DedupeTtlS = 86400L
  val ProbeBudget = 200L
  val DestructiveProbeBudget = 20L
  val DestructiveCategories = Set("resource-exhaustion", "data-exfil")

  val jedis = new Jedis("redis", 6379)

  val ReserveLua =
    """
      |local used = tonumber(redis.call('GET', KEYS[1])) or 0
      |local want = tonumber(ARGV[1])
      |local limit = tonumber(ARGV[2])
      |if used + want > limit then
      |  return {0, limit - used, redis.call('TTL', KEYS[1])}
      |end
      |redis.call('INCRBY', KEYS[1], want)
      |if redis.call('TTL', KEYS[1]) < 0 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[3])
      |end
      |return {1, limit - used - want, redis.call('TTL', KEYS[1])}
      |""".stripMargin

  def dedupeKey(target: String, probeHash: String): String = s"redteam:probe:$target:$probeHash"

  def budgetKey(target: String, window: Long): String = s"redteam:budget:$target:$window"

  def markProbe(target: String, probeHash: String): Boolean =
    jedis.set(dedupeKey(target, probeHash), "1", SetParams.setParams().nx().ex(DedupeTtlS)) == "OK"

  def reserveBudget(target: String, category: String): (Boolean, Long, Long) = {
    val window = System.currentTimeMillis() / 1000 / WindowSeconds
    val destructive = DestructiveCategories.contains(category)
    val limit = if (destructive) DestructiveProbeBudget else ProbeBudget
    val key = budgetKey(target, window) + (if (destructive) ":destructive" else "")
    val result = jedis
      .eval(ReserveLua, 1, key, "1", limit.toString, WindowSeconds.toString)
      .asInstanceOf[java.util.List[Long]]
    (result.get(0) == 1L, result.get(1), result.get(2))
  }

  def recordProbe(body: ProbeResult): String = {
    if (!markProbe(body.target, body.probe_hash)) {
      """{"applied":false,"reason":"duplicate"}"""
    } else {
      val (ok, remaining, ttl) = reserveBudget(body.target, body.category)
      if (!ok) {
        jedis.del(dedupeKey(body.target, body.probe_hash))
        s"""{"applied":false,"reason":"budget exhausted","remaining":$remaining}"""
      } else {
        s"""{"applied":true,"remaining":$remaining,"ttl":$ttl}"""
      }
    }
  }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind()
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

constexpr long long kProbeBudget = 200;

std::string dedupeKey(const std::string& target, const std::string& probeHash) {
  return "redteam:probe:" + target + ":" + probeHash;
}

// TODO: this draft reads the dedupe key with get before writing it, so two concurrent duplicates
// both run; it increments a single never-expiring counter per target with no window, and it has no
// separate cap for destructive categories. Make the claim atomic, move the budget into one script
// with a TTL, and give destructive probes their own cap.
std::string recordProbe(
    sw::redis::Redis& redis,
    const std::string& target,
    const std::string& probeHash,
    const std::string& category) {
  const auto key = dedupeKey(target, probeHash);
  if (redis.get(key)) return R"({"applied":false})";
  redis.set(key, "1");
  const auto used = redis.incr("redteam:budget:" + target);
  if (used > kProbeBudget) {
    redis.decr("redteam:budget:" + target);
    return R"({"applied":false,"budget_exhausted":true})";
  }
  return R"({"applied":true,"remaining":)" + std::to_string(kProbeBudget - used) + "}";
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <set>
#include <string>
#include <vector>

constexpr long long kWindowSeconds = 3600;
constexpr long long kDedupeTtlS = 86400;
constexpr long long kProbeBudget = 200;
constexpr long long kDestructiveProbeBudget = 20;
const std::set<std::string> kDestructiveCategories = {"resource-exhaustion", "data-exfil"};

const char* kReserveLua = R"LUA(
local used = tonumber(redis.call('GET', KEYS[1])) or 0
local want = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if used + want > limit then
  return {0, limit - used, redis.call('TTL', KEYS[1])}
end
redis.call('INCRBY', KEYS[1], want)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
end
return {1, limit - used - want, redis.call('TTL', KEYS[1])}
)LUA";

std::string dedupeKey(const std::string& target, const std::string& probeHash) {
  return "redteam:probe:" + target + ":" + probeHash;
}

std::string budgetKey(const std::string& target, long long window) {
  return "redteam:budget:" + target + ":" + std::to_string(window);
}

bool markProbe(sw::redis::Redis& redis, const std::string& target, const std::string& probeHash) {
  return redis.set(
      dedupeKey(target, probeHash),
      "1",
      std::chrono::seconds(kDedupeTtlS),
      sw::redis::UpdateType::NOT_EXIST);
}

std::vector<long long> reserveBudget(sw::redis::Redis& redis, const std::string& target, const std::string& category) {
  const auto window = std::chrono::duration_cast<std::chrono::seconds>(
                          std::chrono::system_clock::now().time_since_epoch())
                          .count() /
                      kWindowSeconds;
  const bool destructive = kDestructiveCategories.count(category) > 0;
  const long long limit = destructive ? kDestructiveProbeBudget : kProbeBudget;
  const auto key = budgetKey(target, window) + (destructive ? ":destructive" : "");
  return redis.eval<std::vector<long long>>(kReserveLua, {key}, {1, limit, kWindowSeconds});
}

std::string recordProbe(
    sw::redis::Redis& redis,
    const std::string& target,
    const std::string& probeHash,
    const std::string& category) {
  if (!markProbe(redis, target, probeHash)) return R"({"applied":false,"reason":"duplicate"})";
  const auto reserved = reserveBudget(redis, target, category);
  if (reserved[0] != 1) {
    redis.del(dedupeKey(target, probeHash));
    return R"({"applied":false,"reason":"budget exhausted","remaining":)" + std::to_string(reserved[1]) + "}";
  }
  return R"({"applied":true,"remaining":)" + std::to_string(reserved[1]) + R"(,"ttl":)" +
         std::to_string(reserved[2]) + "}";
}
`,
    },
  },
  hints: [
    'Two workers, one probe: only the command itself can decide the winner. `SET key value NX EX ttl` returns `OK` for exactly one of them, so the loser returns "duplicate" without running anything. A `GET` before the write cannot distinguish them.',
    'Put read, compare and increment in the Lua body and let Redis serialize it. Set the TTL inside the script only when the key was created, so a window that started 59 minutes ago expires in a minute rather than living for a day.',
    'The category is data, not decoration: it selects the cap and the key suffix. Separate the destructive cap from the general one, and keep the general key untouched so an aggressive probe set cannot starve the next ordinary run against the same target.',
  ],
  debrief: `The interviewer is testing atomicity and lifetime in one shot. Two contracts are being checked. First, a replay must be free: the dedupe claim is a single atomic command, and it runs before the budget is reserved, so a redelivered probe neither executes twice nor spends twice. Second, a budget must be a window, not a monument: the counter is keyed by the hour and expires with it, which is the difference between throttling a target for an hour and locking it out until someone deletes a key by hand. The separate destructive cap is the third, quieter contract: probe categories are not interchangeable, and a shared cap lets the most aggressive category decide whether harmless probes can run at all. Real platforms add per-target approval limits, a global circuit breaker for the fleet, and an audit row for every refused reservation so a coverage gap is visible.`,
};
