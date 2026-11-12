import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'One atomic Redis decision per serve',
  concept: 'redis',
  file: 'state',
  focus: ['server', 'redis'],
  task: `## Task

**Starting point.** The starter is \`reserve(campaign, user_hash, price_micros)\`, the decision a
serve makes once its campaign has won: it runs \`INCR freq:{campaign_id}:{user_hash}\`, reads
\`pace:{campaign_id}\`, refuses when the count is over \`freq_cap\` or the price does not fit
\`paced_budget_micros\`, and otherwise \`INCRBY\`s the pacing counter. It answers
\`{"allowed", "seen", "spent_micros"}\` and hides three flaws.

**Failure mode the checks target.** A refused serve still burns one of the user's impressions, two
serves that race for the last of a budget both pass, and a user who reached the cap stays capped
forever.

- The decision is **one Lua script** (\`register_script\`/\`EVAL\`): it reads both counters, refuses
  when \`seen >= freq_cap\` or \`spent + price > paced_budget_micros\`, and only then increments
  both, so nothing moves on a refusal and no other serve can land in between.
- The user's counter gets its TTL, \`freq_window_s\`, **at its first write** (\`EXPIRE\` when
  \`INCR\` returns 1), so the window starts at the first impression and then rolls off.
- \`seen\` and \`spent_micros\` are the counters after the decision.`,
  sequence: {
    participants: ['Ad Server', 'Redis'],
    messages: [
      {
        from: 'Ad Server',
        to: 'Redis',
        label: 'EVALSHA reserve · freq:{id}:{user} pace:{id} · cap window price budget',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Redis', label: 'GET both · refuse, or INCR (+EXPIRE at 1) and INCRBY', kind: 'sync'},
      {from: 'Redis', to: 'Ad Server', label: '{allowed, seen, spent}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'no-burn',
      title: 'A refused serve moves no counter',
      detail:
        'Inside the script the user counter is read and compared with `freq_cap` before any `INCR`, and both counters move only on the allowed path. The starter increments the user first, so a capped or unfunded request burns an impression it never showed.',
      match: {
        python: {
          all: [/register_script\(|\.eval\(/],
          order: [/redis\.call\(\s*['"]GET['"],\s*KEYS\[1\]\s*\)/, /redis\.call\(\s*['"]INCR['"],\s*KEYS\[1\]\s*\)/],
          none: [/\br\.incr\(/],
        },
        typescript: {
          all: [/defineCommand\(|\.eval\(/],
          order: [/redis\.call\(\s*['"]GET['"],\s*KEYS\[1\]\s*\)/, /redis\.call\(\s*['"]INCR['"],\s*KEYS\[1\]\s*\)/],
          none: [/redis\.incr\(/],
        },
        go: {
          all: [/redis\.NewScript\(|\.Eval\(/],
          order: [/redis\.call\(\s*['"]GET['"],\s*KEYS\[1\]\s*\)/, /redis\.call\(\s*['"]INCR['"],\s*KEYS\[1\]\s*\)/],
          none: [/rdb\.Incr\(/],
        },
        scala: {
          all: [/jedis\.eval(sha)?\(/],
          order: [/redis\.call\(\s*['"]GET['"],\s*KEYS\[1\]\s*\)/, /redis\.call\(\s*['"]INCR['"],\s*KEYS\[1\]\s*\)/],
          none: [/jedis\.incr\(/],
        },
        cpp: {
          all: [/redis\.eval(sha)?[<(]/],
          order: [/redis\.call\(\s*['"]GET['"],\s*KEYS\[1\]\s*\)/, /redis\.call\(\s*['"]INCR['"],\s*KEYS\[1\]\s*\)/],
          none: [/redis\.incr\(/],
        },
      },
    },
    {
      id: 'one-decision',
      title: 'Two racing serves cannot both spend the last of a budget',
      detail:
        'The pacing counter is read and incremented by `INCRBY` inside the same script (`KEYS[2]`), so a second serve landing between the read and the write sees the new total. The starter reads `pace:{id}` and increments it in two round trips.',
      match: {
        python: {
          all: [/redis\.call\(\s*['"]GET['"],\s*KEYS\[2\]\s*\)/, /redis\.call\(\s*['"]INCRBY['"],\s*KEYS\[2\]/],
          none: [/\br\.incrby\(/, /\br\.get\(\s*pace_key\(/],
        },
        typescript: {
          all: [/redis\.call\(\s*['"]GET['"],\s*KEYS\[2\]\s*\)/, /redis\.call\(\s*['"]INCRBY['"],\s*KEYS\[2\]/],
          none: [/redis\.incrby\(/, /redis\.get\(\s*paceKey\(/],
        },
        go: {
          all: [/redis\.call\(\s*['"]GET['"],\s*KEYS\[2\]\s*\)/, /redis\.call\(\s*['"]INCRBY['"],\s*KEYS\[2\]/],
          none: [/rdb\.IncrBy\(/, /rdb\.Get\([^\n]*paceKey\(/],
        },
        scala: {
          all: [/redis\.call\(\s*['"]GET['"],\s*KEYS\[2\]\s*\)/, /redis\.call\(\s*['"]INCRBY['"],\s*KEYS\[2\]/],
          none: [/jedis\.incrBy\(/, /jedis\.get\(\s*paceKey\(/],
        },
        cpp: {
          all: [/redis\.call\(\s*['"]GET['"],\s*KEYS\[2\]\s*\)/, /redis\.call\(\s*['"]INCRBY['"],\s*KEYS\[2\]/],
          none: [/redis\.incrby\(/, /redis\.get\(\s*paceKey\(/],
        },
      },
    },
    {
      id: 'window-ttl',
      title: 'The cap key expires at the frequency window',
      detail:
        'The script runs `EXPIRE KEYS[1] freq_window_s` when `INCR` returns 1, so the window starts at the first impression, is not pushed back by later ones, and the user can be served again once it ends. The starter never sets a TTL.',
      match: {
        python: {all: [/redis\.call\(\s*['"]EXPIRE['"],\s*KEYS\[1\]/, /==\s*1\s+then/]},
        typescript: {all: [/redis\.call\(\s*['"]EXPIRE['"],\s*KEYS\[1\]/, /==\s*1\s+then/]},
        go: {all: [/redis\.call\(\s*['"]EXPIRE['"],\s*KEYS\[1\]/, /==\s*1\s+then/]},
        scala: {all: [/redis\.call\(\s*['"]EXPIRE['"],\s*KEYS\[1\]/, /==\s*1\s+then/]},
        cpp: {all: [/redis\.call\(\s*['"]EXPIRE['"],\s*KEYS\[1\]/, /==\s*1\s+then/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def freq_key(campaign_id: str, user_hash: str) -> str:
    return f"freq:{campaign_id}:{user_hash}"


def pace_key(campaign_id: str) -> str:
    return f"pace:{campaign_id}"


def reserve(campaign: dict, user_hash: str, price_micros: int) -> dict:
    """Decide one serve against the user's frequency cap and the campaign's paced budget, and count it when allowed."""
    # TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    seen = r.incr(freq_key(campaign["campaign_id"], user_hash))
    spent = int(r.get(pace_key(campaign["campaign_id"])) or 0)
    if seen > campaign["freq_cap"] or spent + price_micros > campaign["paced_budget_micros"]:
        return {"allowed": False, "seen": seen, "spent_micros": spent}
    spent = r.incrby(pace_key(campaign["campaign_id"]), price_micros)
    return {"allowed": True, "seen": seen, "spent_micros": spent}
`,
      solution: `import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

# KEYS: the user's counter, the campaign's pacing counter. ARGV: freq_cap, freq_window_s, price, paced budget.
# Redis runs the script to completion: no other serve can land between the reads and the writes.
RESERVE_LUA = """
local seen = tonumber(redis.call('GET', KEYS[1]) or '0')
local spent = tonumber(redis.call('GET', KEYS[2]) or '0')
if seen >= tonumber(ARGV[1]) or spent + tonumber(ARGV[3]) > tonumber(ARGV[4]) then
  return {0, seen, spent}
end
seen = redis.call('INCR', KEYS[1])
if seen == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
spent = redis.call('INCRBY', KEYS[2], ARGV[3])
return {1, seen, spent}
"""
reserve_script = r.register_script(RESERVE_LUA)


def freq_key(campaign_id: str, user_hash: str) -> str:
    return f"freq:{campaign_id}:{user_hash}"


def pace_key(campaign_id: str) -> str:
    return f"pace:{campaign_id}"


def reserve(campaign: dict, user_hash: str, price_micros: int) -> dict:
    """Decide one serve against the user's frequency cap and the campaign's paced budget, and count it when allowed."""
    allowed, seen, spent = reserve_script(
        keys=[freq_key(campaign["campaign_id"], user_hash), pace_key(campaign["campaign_id"])],
        args=[campaign["freq_cap"], campaign["freq_window_s"], price_micros, campaign["paced_budget_micros"]],
    )
    return {"allowed": allowed == 1, "seen": seen, "spent_micros": spent}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import type {Campaign} from 'ads/store';

const redis = new Redis({host: 'redis', port: 6379});

export interface Reservation {
  allowed: boolean;
  seen: number;
  spent_micros: number;
}

export const freqKey = (campaignId: string, userHash: string): string => \`freq:\${campaignId}:\${userHash}\`;
export const paceKey = (campaignId: string): string => \`pace:\${campaignId}\`;

/** Decide one serve against the user's frequency cap and the campaign's paced budget, and count it when allowed. */
export async function reserve(campaign: Campaign, userHash: string, priceMicros: number): Promise<Reservation> {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const seen = await redis.incr(freqKey(campaign.campaign_id, userHash));
  const spent = Number((await redis.get(paceKey(campaign.campaign_id))) ?? 0);
  if (seen > campaign.freq_cap || spent + priceMicros > campaign.paced_budget_micros) return {allowed: false, seen, spent_micros: spent};
  return {allowed: true, seen, spent_micros: await redis.incrby(paceKey(campaign.campaign_id), priceMicros)};
}
`,
      solution: `import Redis from 'ioredis';

import type {Campaign} from 'ads/store';

// KEYS: the user's counter, the campaign's pacing counter. ARGV: freq_cap, freq_window_s, price, paced budget.
// Redis runs the script to completion: no other serve can land between the reads and the writes.
export const RESERVE_LUA = \`
local seen = tonumber(redis.call('GET', KEYS[1]) or '0')
local spent = tonumber(redis.call('GET', KEYS[2]) or '0')
if seen >= tonumber(ARGV[1]) or spent + tonumber(ARGV[3]) > tonumber(ARGV[4]) then
  return {0, seen, spent}
end
seen = redis.call('INCR', KEYS[1])
if seen == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
spent = redis.call('INCRBY', KEYS[2], ARGV[3])
return {1, seen, spent}
\`;

interface ReserveRedis extends Redis {
  reserveServe(freqKey: string, paceKey: string, cap: number, windowS: number, price: number, budget: number): Promise<[number, number, number]>;
}

const redis = new Redis({host: 'redis', port: 6379}) as ReserveRedis;
redis.defineCommand('reserveServe', {numberOfKeys: 2, lua: RESERVE_LUA});

export interface Reservation {
  allowed: boolean;
  seen: number;
  spent_micros: number;
}

export const freqKey = (campaignId: string, userHash: string): string => \`freq:\${campaignId}:\${userHash}\`;
export const paceKey = (campaignId: string): string => \`pace:\${campaignId}\`;

/** Decide one serve against the user's frequency cap and the campaign's paced budget, and count it when allowed. */
export async function reserve(campaign: Campaign, userHash: string, priceMicros: number): Promise<Reservation> {
  const [allowed, seen, spent] = await redis.reserveServe(
    freqKey(campaign.campaign_id, userHash),
    paceKey(campaign.campaign_id),
    campaign.freq_cap,
    campaign.freq_window_s,
    priceMicros,
    campaign.paced_budget_micros,
  );
  return {allowed: allowed === 1, seen, spent_micros: spent};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"ads/store" // store.Campaign
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Reservation is the decision for one serve and the counters after it.
type Reservation struct {
	Allowed     bool  \`json:"allowed"\`
	Seen        int64 \`json:"seen"\`
	SpentMicros int64 \`json:"spent_micros"\`
}

func freqKey(campaignID, userHash string) string { return "freq:" + campaignID + ":" + userHash }

func paceKey(campaignID string) string { return "pace:" + campaignID }

// reserve decides one serve against the user's frequency cap and the campaign's paced budget, and counts it when allowed.
func reserve(ctx context.Context, c store.Campaign, userHash string, priceMicros int64) (Reservation, error) {
	// TODO: this starter has three flaws. The task says where to look; the checks say what must change.
	seen, err := rdb.Incr(ctx, freqKey(c.CampaignID, userHash)).Result()
	if err != nil {
		return Reservation{}, err
	}
	spent, err := rdb.Get(ctx, paceKey(c.CampaignID)).Int64()
	if err != nil && err != redis.Nil {
		return Reservation{}, err
	}
	if seen > c.FreqCap || spent+priceMicros > c.PacedBudgetMicros {
		return Reservation{Allowed: false, Seen: seen, SpentMicros: spent}, nil
	}
	spent, err = rdb.IncrBy(ctx, paceKey(c.CampaignID), priceMicros).Result()
	return Reservation{Allowed: true, Seen: seen, SpentMicros: spent}, err
}
`,
      solution: `package main

import (
	"context"

	"github.com/redis/go-redis/v9"

	"ads/store" // store.Campaign
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// reserveScript: KEYS the user's counter and the campaign's pacing counter; ARGV freq_cap,
// freq_window_s, price, paced budget. Redis runs it to completion: no other serve can land between
// the reads and the writes.
var reserveScript = redis.NewScript(\`
local seen = tonumber(redis.call('GET', KEYS[1]) or '0')
local spent = tonumber(redis.call('GET', KEYS[2]) or '0')
if seen >= tonumber(ARGV[1]) or spent + tonumber(ARGV[3]) > tonumber(ARGV[4]) then
  return {0, seen, spent}
end
seen = redis.call('INCR', KEYS[1])
if seen == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
spent = redis.call('INCRBY', KEYS[2], ARGV[3])
return {1, seen, spent}
\`)

// Reservation is the decision for one serve and the counters after it.
type Reservation struct {
	Allowed     bool  \`json:"allowed"\`
	Seen        int64 \`json:"seen"\`
	SpentMicros int64 \`json:"spent_micros"\`
}

func freqKey(campaignID, userHash string) string { return "freq:" + campaignID + ":" + userHash }

func paceKey(campaignID string) string { return "pace:" + campaignID }

// reserve decides one serve against the user's frequency cap and the campaign's paced budget, and counts it when allowed.
func reserve(ctx context.Context, c store.Campaign, userHash string, priceMicros int64) (Reservation, error) {
	keys := []string{freqKey(c.CampaignID, userHash), paceKey(c.CampaignID)}
	out, err := reserveScript.Run(ctx, rdb, keys, c.FreqCap, c.FreqWindowS, priceMicros, c.PacedBudgetMicros).Int64Slice()
	if err != nil {
		return Reservation{}, err
	}
	return Reservation{Allowed: out[0] == 1, Seen: out[1], SpentMicros: out[2]}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

import ads.Store // Store.Campaign

/** The decision for one serve and the counters after it. */
final case class Reservation(allowed: Boolean, seen: Long, spentMicros: Long)

object State {
  val jedis = new JedisPooled("redis", 6379)

  def freqKey(campaignId: String, userHash: String): String = s"freq:$campaignId:$userHash"
  def paceKey(campaignId: String): String = s"pace:$campaignId"

  /** Decide one serve against the user's frequency cap and the campaign's paced budget, and count it when allowed. */
  def reserve(c: Store.Campaign, userHash: String, priceMicros: Long): Reservation = {
    // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
    val seen = jedis.incr(freqKey(c.campaignId, userHash))
    val spent = Option(jedis.get(paceKey(c.campaignId))).map(_.toLong).getOrElse(0L)
    if (seen > c.freqCap || spent + priceMicros > c.pacedBudgetMicros) Reservation(allowed = false, seen, spent)
    else Reservation(allowed = true, seen, jedis.incrBy(paceKey(c.campaignId), priceMicros))
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import ads.Store // Store.Campaign

/** The decision for one serve and the counters after it. */
final case class Reservation(allowed: Boolean, seen: Long, spentMicros: Long)

object State {
  val jedis = new JedisPooled("redis", 6379)

  /**
   * KEYS the user's counter and the campaign's pacing counter; ARGV freq_cap, freq_window_s, price,
   * paced budget. Redis runs it to completion: no other serve can land between the reads and the writes.
   */
  val ReserveLua: String =
    """local seen = tonumber(redis.call('GET', KEYS[1]) or '0')
      |local spent = tonumber(redis.call('GET', KEYS[2]) or '0')
      |if seen >= tonumber(ARGV[1]) or spent + tonumber(ARGV[3]) > tonumber(ARGV[4]) then
      |  return {0, seen, spent}
      |end
      |seen = redis.call('INCR', KEYS[1])
      |if seen == 1 then
      |  redis.call('EXPIRE', KEYS[1], ARGV[2])
      |end
      |spent = redis.call('INCRBY', KEYS[2], ARGV[3])
      |return {1, seen, spent}
      |""".stripMargin

  def freqKey(campaignId: String, userHash: String): String = s"freq:$campaignId:$userHash"
  def paceKey(campaignId: String): String = s"pace:$campaignId"

  /** Decide one serve against the user's frequency cap and the campaign's paced budget, and count it when allowed. */
  def reserve(c: Store.Campaign, userHash: String, priceMicros: Long): Reservation = {
    val keys = List(freqKey(c.campaignId, userHash), paceKey(c.campaignId)).asJava
    val args = List(c.freqCap, c.freqWindowS, priceMicros, c.pacedBudgetMicros).map(_.toString).asJava
    val out = jedis.eval(ReserveLua, keys, args).asInstanceOf[java.util.List[java.lang.Long]].asScala.map(_.longValue)
    Reservation(allowed = out(0) == 1L, out(1), out(2))
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <string>

#include "ads/store.h"  // store::Campaign

sw::redis::Redis redis("tcp://redis:6379");

// The decision for one serve and the counters after it.
struct Reservation {
  bool allowed = false;
  long long seen = 0;
  long long spent_micros = 0;
};

std::string freqKey(const std::string& campaign_id, const std::string& user_hash) { return "freq:" + campaign_id + ":" + user_hash; }

std::string paceKey(const std::string& campaign_id) { return "pace:" + campaign_id; }

// Decide one serve against the user's frequency cap and the campaign's paced budget, and count it when allowed.
Reservation reserve(const store::Campaign& c, const std::string& user_hash, long long price_micros) {
  // TODO: this starter has three flaws. The task says where to look; the checks say what must change.
  const long long seen = redis.incr(freqKey(c.campaign_id, user_hash));
  const auto raw = redis.get(paceKey(c.campaign_id));
  const long long spent = raw ? std::stoll(*raw) : 0;
  if (seen > c.freq_cap || spent + price_micros > c.paced_budget_micros) return Reservation{false, seen, spent};
  return Reservation{true, seen, redis.incrby(paceKey(c.campaign_id), price_micros)};
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <vector>

#include "ads/store.h"  // store::Campaign

sw::redis::Redis redis("tcp://redis:6379");

// KEYS the user's counter and the campaign's pacing counter; ARGV freq_cap, freq_window_s, price,
// paced budget. Redis runs it to completion: no other serve can land between the reads and the writes.
const std::string kReserveLua = R"lua(
local seen = tonumber(redis.call('GET', KEYS[1]) or '0')
local spent = tonumber(redis.call('GET', KEYS[2]) or '0')
if seen >= tonumber(ARGV[1]) or spent + tonumber(ARGV[3]) > tonumber(ARGV[4]) then
  return {0, seen, spent}
end
seen = redis.call('INCR', KEYS[1])
if seen == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
spent = redis.call('INCRBY', KEYS[2], ARGV[3])
return {1, seen, spent}
)lua";

// The decision for one serve and the counters after it.
struct Reservation {
  bool allowed = false;
  long long seen = 0;
  long long spent_micros = 0;
};

std::string freqKey(const std::string& campaign_id, const std::string& user_hash) { return "freq:" + campaign_id + ":" + user_hash; }

std::string paceKey(const std::string& campaign_id) { return "pace:" + campaign_id; }

// Decide one serve against the user's frequency cap and the campaign's paced budget, and count it when allowed.
Reservation reserve(const store::Campaign& c, const std::string& user_hash, long long price_micros) {
  std::vector<long long> out;
  redis.eval(kReserveLua, {freqKey(c.campaign_id, user_hash), paceKey(c.campaign_id)},
             {std::to_string(c.freq_cap), std::to_string(c.freq_window_s), std::to_string(price_micros), std::to_string(c.paced_budget_micros)},
             std::back_inserter(out));
  return Reservation{out.at(0) == 1, out.at(1), out.at(2)};
}
`,
    },
  },
  harness: {
    python: `def _campaign(**fields):
    campaign = {
        "campaign_id": "c-1", "advertiser_id": "adv-1", "version": 1, "state": "active", "placement": "home-top",
        "creative_id": "cr-c-1", "bid_micros": 1000, "freq_cap": 2, "freq_window_s": 3600,
        "paced_budget_micros": 3000, "goal_impressions": 1000, "start_ts": 0, "end_ts": 86400,
    }
    campaign.update(fields)
    return campaign


def check_no_burn(ctx):
    m = ctx.load("state")
    c = _campaign()
    for n in (1, 2):
        got = m.reserve(c, "u-1", 1000)
        assert got["allowed"] is True and got["seen"] == n, f"reserve #{n} for u-1 (freq_cap 2) answered {got}, expected allowed with seen {n}"
    refused = m.reserve(c, "u-1", 1000)
    assert refused["allowed"] is False, f"a third serve for u-1 with freq_cap 2 answered {refused}, expected a refusal"
    assert ctx.redis.get("freq:c-1:u-1") == "2", f"the refused serve moved freq:c-1:u-1 to {ctx.redis.get('freq:c-1:u-1')}: a serve that was never shown burned one of the user's impressions. Compare before INCR"
    assert ctx.redis.get("pace:c-1") == "2000", f"pace:c-1 is {ctx.redis.get('pace:c-1')} after a refused serve, expected the 2000 the two allowed serves reserved"
    ctx.redis.set("pace:c-1", 3000)
    broke = m.reserve(c, "u-2", 1000)
    assert broke["allowed"] is False, f"a serve with the budget spent answered {broke}, expected a refusal"
    assert ctx.redis.get("freq:c-1:u-2") in (None, "0"), f"a serve refused for budget moved freq:c-1:u-2 to {ctx.redis.get('freq:c-1:u-2')}: u-2 never saw the ad"
    assert ctx.redis.get("pace:c-1") == "3000", f"a serve refused for budget moved pace:c-1 to {ctx.redis.get('pace:c-1')}"


def check_one_decision(ctx):
    m = ctx.load("state")
    c = _campaign(freq_cap=10, paced_budget_micros=2000)
    ctx.redis.set("pace:c-1", 1000)
    # Another app server's serve lands right after this one first touches the pacing counter.
    rival = ctx.redis_after("pace:c-1", lambda: m.reserve(c, "u-2", 1000))
    mine = m.reserve(c, "u-1", 1000)
    assert rival.fired, "reserve never touched pace:c-1"
    if rival.error is not None:
        raise rival.error
    allowed = [got for got in (mine, rival.result) if got["allowed"]]
    assert len(allowed) == 1, f"two serves raced for the last 1000 micros of a 2000-micro budget and {len(allowed)} were allowed (pace:c-1 is now {ctx.redis.get('pace:c-1')}): the read and the increment must be one atomic decision"
    assert ctx.redis.get("pace:c-1") == "2000", f"pace:c-1 is {ctx.redis.get('pace:c-1')} after the race, expected the 2000-micro budget, not more"


def check_window_ttl(ctx):
    m = ctx.load("state")
    c = _campaign(freq_cap=5, paced_budget_micros=1_000_000)
    m.reserve(c, "u-1", 1000)
    ttl = ctx.redis.ttl("freq:c-1:u-1")
    assert 3590 <= ttl <= 3600, f"freq:c-1:u-1 has TTL {ttl} after the first impression, expected the campaign's 3600 s frequency window: without it the cap never rolls off"
    ctx.clock.advance(600)
    m.reserve(c, "u-1", 1000)
    ttl = ctx.redis.ttl("freq:c-1:u-1")
    assert 2990 <= ttl <= 3000, f"freq:c-1:u-1 has TTL {ttl} after a second impression 600 s later, expected about 3000: the window starts at the first impression (EXPIRE when INCR returns 1)"
    ctx.clock.advance(3001)
    assert ctx.redis.exists("freq:c-1:u-1") == 0, "freq:c-1:u-1 is still there after the frequency window"
    got = m.reserve(c, "u-1", 1000)
    assert got["allowed"] is True and got["seen"] == 1, f"after the window ended u-1's next serve answered {got}, expected allowed with seen 1"
`,
    typescript: `const campaign = (fields = {}) => ({
  campaign_id: 'c-1',
  advertiser_id: 'adv-1',
  version: 1,
  state: 'active',
  placement: 'home-top',
  creative_id: 'cr-c-1',
  bid_micros: 1000,
  freq_cap: 2,
  freq_window_s: 3600,
  paced_budget_micros: 3000,
  goal_impressions: 1000,
  start_ts: 0,
  end_ts: 86400,
  ...fields,
});

export async function check_no_burn(ctx) {
  const m = ctx.load('state');
  const c = campaign();
  for (const n of [1, 2]) {
    const got = await m.reserve(c, 'u-1', 1000);
    assert(got.allowed === true && got.seen === n, \`reserve #\${n} for u-1 (freq_cap 2) answered \${JSON.stringify(got)}, expected allowed with seen \${n}\`);
  }
  const refused = await m.reserve(c, 'u-1', 1000);
  assert.equal(refused.allowed, false, \`a third serve for u-1 with freq_cap 2 answered \${JSON.stringify(refused)}, expected a refusal\`);
  assert.equal(ctx.redis.get('freq:c-1:u-1'), '2', \`the refused serve moved freq:c-1:u-1 to \${ctx.redis.get('freq:c-1:u-1')}: a serve that was never shown burned one of the user's impressions. Compare before INCR\`);
  assert.equal(ctx.redis.get('pace:c-1'), '2000', \`pace:c-1 is \${ctx.redis.get('pace:c-1')} after a refused serve, expected the 2000 the two allowed serves reserved\`);
  ctx.redis.set('pace:c-1', '3000');
  const broke = await m.reserve(c, 'u-2', 1000);
  assert.equal(broke.allowed, false, \`a serve with the budget spent answered \${JSON.stringify(broke)}, expected a refusal\`);
  const u2 = ctx.redis.get('freq:c-1:u-2');
  assert(u2 === null || u2 === '0', \`a serve refused for budget moved freq:c-1:u-2 to \${u2}: u-2 never saw the ad\`);
  assert.equal(ctx.redis.get('pace:c-1'), '3000', \`a serve refused for budget moved pace:c-1 to \${ctx.redis.get('pace:c-1')}\`);
}

export async function check_one_decision(ctx) {
  const m = ctx.load('state');
  const c = campaign({freq_cap: 10, paced_budget_micros: 2000});
  ctx.redis.set('pace:c-1', '1000');
  // Another app server's serve lands right after this one first touches the pacing counter.
  const rival = ctx.redisAfter('pace:c-1', () => m.reserve(c, 'u-2', 1000));
  const mine = await m.reserve(c, 'u-1', 1000);
  assert(rival.fired, 'reserve never touched pace:c-1');
  if (rival.error !== undefined) throw rival.error;
  const theirs = await rival.result;
  const allowed = [mine, theirs].filter(got => got.allowed).length;
  assert.equal(allowed, 1, \`two serves raced for the last 1000 micros of a 2000-micro budget and \${allowed} were allowed (pace:c-1 is now \${ctx.redis.get('pace:c-1')}): the read and the increment must be one atomic decision\`);
  assert.equal(ctx.redis.get('pace:c-1'), '2000', \`pace:c-1 is \${ctx.redis.get('pace:c-1')} after the race, expected the 2000-micro budget, not more\`);
}

export async function check_window_ttl(ctx) {
  const m = ctx.load('state');
  const c = campaign({freq_cap: 5, paced_budget_micros: 1000000});
  await m.reserve(c, 'u-1', 1000);
  let ttl = ctx.redis.ttl('freq:c-1:u-1');
  assert(3590 <= ttl && ttl <= 3600, \`freq:c-1:u-1 has TTL \${ttl} after the first impression, expected the campaign's 3600 s frequency window: without it the cap never rolls off\`);
  ctx.clock.advance(600);
  await m.reserve(c, 'u-1', 1000);
  ttl = ctx.redis.ttl('freq:c-1:u-1');
  assert(2990 <= ttl && ttl <= 3000, \`freq:c-1:u-1 has TTL \${ttl} after a second impression 600 s later, expected about 3000: the window starts at the first impression (EXPIRE when INCR returns 1)\`);
  ctx.clock.advance(3001);
  assert.equal(ctx.redis.exists('freq:c-1:u-1'), 0, 'freq:c-1:u-1 is still there after the frequency window');
  const got = await m.reserve(c, 'u-1', 1000);
  assert(got.allowed === true && got.seen === 1, \`after the window ended u-1's next serve answered \${JSON.stringify(got)}, expected allowed with seen 1\`);
}
`,
    go: `package main

import (
	"context"

	"ads/store"

	"leetbuild/harness"
)

var stateBg = context.Background()

func stateCampaign() store.Campaign {
	return store.Campaign{
		CampaignID: "c-1", AdvertiserID: "adv-1", Version: 1, State: "active", Placement: "home-top", CreativeID: "cr-c-1",
		BidMicros: 1000, FreqCap: 2, FreqWindowS: 3600, PacedBudgetMicros: 3000, GoalImpressions: 1000, StartTs: 0, EndTs: 86400,
	}
}

func stateReserve(ctx *harness.Ctx, c store.Campaign, user string) Reservation {
	got, err := reserve(stateBg, c, user, 1000)
	ctx.NoError(err, "reserve(c-1, %s, 1000)", user)
	return got
}

func stateGet(ctx *harness.Ctx, key string) string {
	v, _ := ctx.Redis.Get(key)
	return v
}

func CheckNoBurn(ctx *harness.Ctx) {
	c := stateCampaign()
	for n := int64(1); n <= 2; n++ {
		got := stateReserve(ctx, c, "u-1")
		ctx.Assert(got.Allowed && got.Seen == n, "reserve #%d for u-1 (freq_cap 2) answered %+v, expected allowed with seen %d", n, got, n)
	}
	refused := stateReserve(ctx, c, "u-1")
	ctx.Equal(refused.Allowed, false, "a third serve for u-1 with freq_cap 2 must be refused; allowed")
	ctx.Equal(stateGet(ctx, "freq:c-1:u-1"), "2", "a serve that was never shown must not burn one of the user's impressions (compare before INCR); freq:c-1:u-1 after the refusal")
	ctx.Equal(stateGet(ctx, "pace:c-1"), "2000", "pace:c-1 after a refused serve")
	ctx.Redis.Set("pace:c-1", "3000")
	broke := stateReserve(ctx, c, "u-2")
	ctx.Equal(broke.Allowed, false, "a serve with the budget spent must be refused; allowed")
	u2 := stateGet(ctx, "freq:c-1:u-2")
	ctx.Assert(u2 == "" || u2 == "0", "a serve refused for budget moved freq:c-1:u-2 to %s: u-2 never saw the ad", u2)
	ctx.Equal(stateGet(ctx, "pace:c-1"), "3000", "pace:c-1 after a serve refused for budget")
}

func CheckOneDecision(ctx *harness.Ctx) {
	c := stateCampaign()
	c.FreqCap = 10
	c.PacedBudgetMicros = 2000
	ctx.Redis.Set("pace:c-1", "1000")
	// Another app server's serve lands right after this one first touches the pacing counter.
	rival := ctx.Redis.After("pace:c-1", func() any {
		got, err := reserve(stateBg, c, "u-2", 1000)
		ctx.NoError(err, "the rival reserve failed")
		return got
	})
	mine := stateReserve(ctx, c, "u-1")
	ctx.Assert(rival.Fired, "reserve never touched pace:c-1")
	ctx.Assert(rival.Err == nil, "the rival reserve failed: %v", rival.Err)
	theirs, _ := rival.Result.(Reservation)
	allowed := 0
	for _, got := range []Reservation{mine, theirs} {
		if got.Allowed {
			allowed++
		}
	}
	ctx.Equal(allowed, 1, "two serves raced for the last 1000 micros of a 2000-micro budget (pace:c-1 is now %s): the read and the increment must be one atomic decision; serves allowed", stateGet(ctx, "pace:c-1"))
	ctx.Equal(stateGet(ctx, "pace:c-1"), "2000", "pace:c-1 after the race must not pass the 2000-micro budget")
}

func CheckWindowTtl(ctx *harness.Ctx) {
	c := stateCampaign()
	c.FreqCap = 5
	c.PacedBudgetMicros = 1000000
	stateReserve(ctx, c, "u-1")
	ttl := ctx.Redis.TTL("freq:c-1:u-1")
	ctx.Assert(3590 <= ttl && ttl <= 3600, "freq:c-1:u-1 has TTL %d after the first impression, expected the campaign's 3600 s frequency window: without it the cap never rolls off", ttl)
	ctx.Clock.Advance(600)
	stateReserve(ctx, c, "u-1")
	ttl = ctx.Redis.TTL("freq:c-1:u-1")
	ctx.Assert(2990 <= ttl && ttl <= 3000, "freq:c-1:u-1 has TTL %d after a second impression 600 s later, expected about 3000: the window starts at the first impression (EXPIRE when INCR returns 1)", ttl)
	ctx.Clock.Advance(3001)
	ctx.Equal(ctx.Redis.Exists("freq:c-1:u-1"), 0, "freq:c-1:u-1 after the frequency window")
	got := stateReserve(ctx, c, "u-1")
	ctx.Assert(got.Allowed && got.Seen == 1, "after the window ended u-1's next serve answered %+v, expected allowed with seen 1", got)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <memory>
#include <optional>
#include <string>

#include "ads/store.h"

namespace {

store::Campaign stateCampaign() {
  store::Campaign c;
  c.campaign_id = "c-1";
  c.advertiser_id = "adv-1";
  c.version = 1;
  c.state = "active";
  c.placement = "home-top";
  c.creative_id = "cr-c-1";
  c.bid_micros = 1000;
  c.freq_cap = 2;
  c.freq_window_s = 3600;
  c.paced_budget_micros = 3000;
  c.goal_impressions = 1000;
  c.start_ts = 0;
  c.end_ts = 86400;
  return c;
}

std::string stateGet(harness::Ctx& ctx, const std::string& key) { return ctx.Redis.Get(key).value_or(""); }

std::string stateShow(const Reservation& r) {
  return std::string("{allowed ") + (r.allowed ? "true" : "false") + ", seen " + std::to_string(r.seen) + ", spent_micros " + std::to_string(r.spent_micros) + "}";
}

// A probe's outcome: whether it fired, what the rival reserve returned, what it threw.
struct StateRival {
  bool fired = false;
  Reservation got;
  std::optional<std::string> err;
};

}  // namespace

void CheckNoBurn(harness::Ctx& ctx) {
  const store::Campaign c = stateCampaign();
  for (long long n = 1; n <= 2; n++) {
    const Reservation got = reserve(c, "u-1", 1000);
    ctx.Assert(got.allowed && got.seen == n, "reserve #%d for u-1 (freq_cap 2) answered %s, expected allowed with seen %d", n, stateShow(got), n);
  }
  const Reservation refused = reserve(c, "u-1", 1000);
  ctx.Equal(refused.allowed, false, "a third serve for u-1 with freq_cap 2 must be refused; allowed");
  ctx.Equal(stateGet(ctx, "freq:c-1:u-1"), std::string("2"), "a serve that was never shown must not burn one of the user's impressions (compare before INCR); freq:c-1:u-1 after the refusal");
  ctx.Equal(stateGet(ctx, "pace:c-1"), std::string("2000"), "pace:c-1 after a refused serve");
  ctx.Redis.Set("pace:c-1", "3000");
  const Reservation broke = reserve(c, "u-2", 1000);
  ctx.Equal(broke.allowed, false, "a serve with the budget spent must be refused; allowed");
  const std::string u2 = stateGet(ctx, "freq:c-1:u-2");
  ctx.Assert(u2.empty() || u2 == "0", "a serve refused for budget moved freq:c-1:u-2 to %s: u-2 never saw the ad", u2);
  ctx.Equal(stateGet(ctx, "pace:c-1"), std::string("3000"), "pace:c-1 after a serve refused for budget");
}

void CheckOneDecision(harness::Ctx& ctx) {
  store::Campaign c = stateCampaign();
  c.freq_cap = 10;
  c.paced_budget_micros = 2000;
  ctx.Redis.Set("pace:c-1", "1000");
  // Another app server's serve lands right after this one first touches the pacing counter.
  auto rival = std::make_shared<StateRival>();
  ctx.Redis.After("pace:c-1", [rival, c] {
    rival->fired = true;
    try {
      rival->got = reserve(c, "u-2", 1000);
    } catch (const std::exception& e) {
      rival->err = e.what();
    }
  });
  const Reservation mine = reserve(c, "u-1", 1000);
  ctx.Assert(rival->fired, "reserve never touched pace:c-1");
  ctx.Assert(!rival->err, "the rival reserve failed: %s", rival->err.value_or(""));
  const int allowed = (mine.allowed ? 1 : 0) + (rival->got.allowed ? 1 : 0);
  ctx.Equal(allowed, 1, "two serves raced for the last 1000 micros of a 2000-micro budget (pace:c-1 is now %s): the read and the increment must be one atomic decision; serves allowed", stateGet(ctx, "pace:c-1"));
  ctx.Equal(stateGet(ctx, "pace:c-1"), std::string("2000"), "pace:c-1 after the race must not pass the 2000-micro budget");
}

void CheckWindowTtl(harness::Ctx& ctx) {
  store::Campaign c = stateCampaign();
  c.freq_cap = 5;
  c.paced_budget_micros = 1000000;
  reserve(c, "u-1", 1000);
  long long ttl = ctx.Redis.TTL("freq:c-1:u-1");
  ctx.Assert(3590 <= ttl && ttl <= 3600, "freq:c-1:u-1 has TTL %d after the first impression, expected the campaign's 3600 s frequency window: without it the cap never rolls off", ttl);
  ctx.Clock.Advance(600);
  reserve(c, "u-1", 1000);
  ttl = ctx.Redis.TTL("freq:c-1:u-1");
  ctx.Assert(2990 <= ttl && ttl <= 3000, "freq:c-1:u-1 has TTL %d after a second impression 600 s later, expected about 3000: the window starts at the first impression (EXPIRE when INCR returns 1)", ttl);
  ctx.Clock.Advance(3001);
  ctx.Equal(ctx.Redis.Exists("freq:c-1:u-1"), 0, "freq:c-1:u-1 after the frequency window");
  const Reservation got = reserve(c, "u-1", 1000);
  ctx.Assert(got.allowed && got.seen == 1, "after the window ended u-1's next serve answered %s, expected allowed with seen 1", stateShow(got));
}
`,
  },
  hints: [
    'Cap a user at two impressions and ask a third time: the answer is a refusal, yet the counter reads 3. Two serves fired together at the last of a budget both come back allowed.',
    'The user is counted with `INCR` before anything is decided, and the pacing counter is read in one round trip and written in another; between them another serve reads the same total. Nothing ever sets a TTL.',
    'Move the decision into one Lua script: GET both keys, return `{0, seen, spent}` when `seen >= cap` or `spent + price > budget`, else INCR (EXPIRE the key when it returns 1) and INCRBY.',
  ],
  debrief: `Redis runs a script to completion, so putting the reads and the writes in one script turns a read-modify-write that a burst can interleave into one decision. The order inside it matters as much as the fence: comparing before incrementing is what makes the counters count impressions that were allowed rather than requests that arrived. Setting the TTL only when the counter is created gives a fixed window from the first impression; refreshing it on every write would let a frequent visitor stay capped forever. Production pacing usually spreads a daily budget across the hours with a target curve, and keeps one counter per pacing interval so a slow morning does not leave the whole day's money for the evening.`,
};
