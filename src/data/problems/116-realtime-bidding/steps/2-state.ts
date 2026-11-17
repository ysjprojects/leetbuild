import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'Redis spend caps with an atomic claim and a release that happens once',
  concept: 'redis',
  guides: ['atomic-state', 'keys-and-expiry'],
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the spend cap behind every bid: \`claim(bidder, auction_id, cents)\`
reads \`cap:{bidder}\` and the counter \`spend:{bidder}\` with two \`GET\`s, compares in the client and
\`INCRBY\`s; \`settle(bidder, auction_id, won)\`, called when the exchange reports the result, logs it
and returns 0. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** Two bids in the same millisecond both pass the last unit of the
cap, a lost auction keeps its charge, a loss notice delivered twice would give the charge back twice,
and a counter with no day spends today's cap on yesterday's bids.

- \`claim\` decides and reserves in **one Lua script**: refuse when \`spent + cents > cap\`, else
  \`INCRBY\` and record the claim in the hash \`claim:{bidder}:{auction_id}\` (\`spend_key\`, \`cents\`).
- \`settle\` runs one script: read the claim, delete it, and on a loss \`DECRBY\` its cents from the
  counter it came from. It returns the cents given back: 0 on a win, 0 when the claim is gone.
- The counter is per UTC day, \`spend:{bidder}:{yyyymmdd}\`; the script sets a two-day expiry
  (\`TTL_S\`) on its first write, and the claim hash expires with it.`,
  sequence: {
    participants: ['Bid path', 'Redis', 'Result notice'],
    messages: [
      {from: 'Bid path', to: 'Redis', label: 'EVAL claim spend:b-1:20261103 claim:b-1:a-1 cap:b-1 · 310', kind: 'sync'},
      {from: 'Redis', to: 'Bid path', label: '1 reserved · 0 the cap cannot cover it', kind: 'reply'},
      {from: 'Result notice', to: 'Redis', label: 'EVAL settle claim:b-1:a-1 · lost', kind: 'sync'},
      {from: 'Redis', to: 'Result notice', label: '310 given back · 0 already settled', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-claim',
      title: 'The cap is checked and reserved in one script',
      detail:
        'Two claims racing for the last headroom: exactly one passes, and a claim that brings the counter exactly to the cap passes too. The check and the `INCRBY` run inside one Lua script; the starter reads in one round trip and writes in another, so a second bid lands between them.',
      match: {
        python: {all: [/register_script\(|\.eval\(/, /redis\.call\(\s*['"]INCRBY['"]/], none: [/\.incrby\(/]},
        typescript: {all: [/defineCommand\(|\.eval\(/, /redis\.call\(\s*['"]INCRBY['"]/], none: [/\.incrby\(/]},
        go: {all: [/redis\.NewScript\(|\.Eval\(/, /redis\.call\(\s*['"]INCRBY['"]/], none: [/\.IncrBy\(/]},
        scala: {all: [/jedis\.eval(sha)?\(/, /redis\.call\(\s*['"]INCRBY['"]/], none: [/\.incrBy\(/]},
        cpp: {all: [/redis\.eval(sha)?[<(]/, /redis\.call\(\s*['"]INCRBY['"]/], none: [/\.incrby\(/]},
      },
    },
    {
      id: 'release-on-loss',
      title: 'A lost auction gives its claim back',
      detail:
        '`settle` on a loss returns the claimed cents and the counter drops by them; a win keeps the charge and returns 0. The starter only logs, so every lost auction still spends the cap.',
      match: {
        python: {all: [/redis\.call\(\s*['"]DECRBY['"]/]},
        typescript: {all: [/redis\.call\(\s*['"]DECRBY['"]/]},
        go: {all: [/redis\.call\(\s*['"]DECRBY['"]/]},
        scala: {all: [/redis\.call\(\s*['"]DECRBY['"]/]},
        cpp: {all: [/redis\.call\(\s*['"]DECRBY['"]/]},
      },
    },
    {
      id: 'release-once',
      title: 'A claim is settled once',
      detail:
        "The claim is recorded in `claim:{bidder}:{auction_id}` and the settle script deletes it as it reads it: a duplicate loss notice, even one racing the first, a notice for an auction never claimed or a loss after a win gives back nothing, and one bidder's loss never touches another bidder's claim of the same auction.",
      match: {
        python: {all: [/redis\.call\(\s*['"]HSET['"]/, /redis\.call\(\s*['"]DEL['"]/]},
        typescript: {all: [/redis\.call\(\s*['"]HSET['"]/, /redis\.call\(\s*['"]DEL['"]/]},
        go: {all: [/redis\.call\(\s*['"]HSET['"]/, /redis\.call\(\s*['"]DEL['"]/]},
        scala: {all: [/redis\.call\(\s*['"]HSET['"]/, /redis\.call\(\s*['"]DEL['"]/]},
        cpp: {all: [/redis\.call\(\s*['"]HSET['"]/, /redis\.call\(\s*['"]DEL['"]/]},
      },
    },
    {
      id: 'daily-window',
      title: 'The counter is per UTC day and expires',
      detail:
        'The counter is `spend:{bidder}:{yyyymmdd}`, and the claim script itself gives it a TTL of at most two days on its first write, so a new UTC day starts a fresh cap; a later claim does not push the expiry back, the claim hash expires too, and a loss settled the next day gives back to the day it was claimed on. The starter keeps one counter forever.',
      match: {
        python: {all: [/%Y%m%d/, /['"]EXPIRE(AT)?['"]/i]},
        typescript: {all: [/toISOString\(\)|getUTC/, /['"]EXPIRE(AT)?['"]/i]},
        go: {all: [/"20060102"/, /['"]EXPIRE(AT)?['"]/i]},
        scala: {all: [/BASIC_ISO_DATE|yyyyMMdd/, /['"]EXPIRE(AT)?['"]/i]},
        cpp: {all: [/%Y%m%d/, /['"]EXPIRE(AT)?['"]/i]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)
logger = logging.getLogger("rtb.spend")


def claim(bidder: str, auction_id: str, cents: int) -> bool:
    """Reserve cents of the bidder's daily cap (cap:{bidder}) for the auction; False when the cap cannot cover them."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    key = f"spend:{bidder}"
    cap = int(r.get(f"cap:{bidder}") or 0)
    spent = int(r.get(key) or 0)
    if spent + cents > cap:
        return False
    r.incrby(key, cents)
    return True


def settle(bidder: str, auction_id: str, won: bool) -> int:
    """Apply the exchange's result to the auction's claim; returns the cents given back to the cap."""
    logger.info("settled auction=%s bidder=%s won=%s", auction_id, bidder, won)
    return 0
`,
      solution: `import logging
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)
logger = logging.getLogger("rtb.spend")

TTL_S = 2 * 86400  # a day's counter outlives its day by one, for the stats read and late results

# KEYS: the day's counter, the claim, the cap. ARGV: cents, TTL_S. The check and the write are one step.
CLAIM_LUA = """
local cap = tonumber(redis.call('GET', KEYS[3]) or '0')
local spent = tonumber(redis.call('GET', KEYS[1]) or '0')
local cents = tonumber(ARGV[1])
if spent + cents > cap then return 0 end
redis.call('INCRBY', KEYS[1], cents)
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
redis.call('HSET', KEYS[2], 'spend_key', KEYS[1], 'cents', cents)
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1
"""

# KEYS: the claim. ARGV: '1' won, '0' lost. Reading and deleting the claim together settles it once.
SETTLE_LUA = """
local spend_key = redis.call('HGET', KEYS[1], 'spend_key')
if not spend_key then return 0 end
local cents = tonumber(redis.call('HGET', KEYS[1], 'cents'))
redis.call('DEL', KEYS[1])
if ARGV[1] == '1' then return 0 end
redis.call('DECRBY', spend_key, cents)
return cents
"""

claim_script = r.register_script(CLAIM_LUA)
settle_script = r.register_script(SETTLE_LUA)


def claim(bidder: str, auction_id: str, cents: int) -> bool:
    """Reserve cents of the bidder's daily cap (cap:{bidder}) for the auction; False when the cap cannot cover them."""
    day = time.strftime("%Y%m%d", time.gmtime())
    keys = [f"spend:{bidder}:{day}", f"claim:{bidder}:{auction_id}", f"cap:{bidder}"]
    return claim_script(keys=keys, args=[cents, TTL_S]) == 1


def settle(bidder: str, auction_id: str, won: bool) -> int:
    """Apply the exchange's result to the auction's claim; returns the cents given back to the cap."""
    logger.info("settled auction=%s bidder=%s won=%s", auction_id, bidder, won)
    return int(settle_script(keys=[f"claim:{bidder}:{auction_id}"], args=["1" if won else "0"]))
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

/** Reserve cents of the bidder's daily cap (cap:{bidder}) for the auction; false when the cap cannot cover them. */
export async function claim(bidder: string, auctionId: string, cents: number): Promise<boolean> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const key = \`spend:\${bidder}\`;
  const cap = Number((await redis.get(\`cap:\${bidder}\`)) ?? 0);
  const spent = Number((await redis.get(key)) ?? 0);
  if (spent + cents > cap) return false;
  await redis.incrby(key, cents);
  return true;
}

/** Apply the exchange's result to the auction's claim; resolves to the cents given back to the cap. */
export async function settle(bidder: string, auctionId: string, won: boolean): Promise<number> {
  console.log(\`settled auction=\${auctionId} bidder=\${bidder} won=\${won}\`);
  return 0;
}
`,
      solution: `import Redis from 'ioredis';

export const TTL_S = 2 * 86400; // a day's counter outlives its day by one, for the stats read and late results

// KEYS: the day's counter, the claim, the cap. ARGV: cents, TTL_S. The check and the write are one step.
const CLAIM_LUA = \`
local cap = tonumber(redis.call('GET', KEYS[3]) or '0')
local spent = tonumber(redis.call('GET', KEYS[1]) or '0')
local cents = tonumber(ARGV[1])
if spent + cents > cap then return 0 end
redis.call('INCRBY', KEYS[1], cents)
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
redis.call('HSET', KEYS[2], 'spend_key', KEYS[1], 'cents', cents)
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1
\`;

// KEYS: the claim. ARGV: '1' won, '0' lost. Reading and deleting the claim together settles it once.
const SETTLE_LUA = \`
local spend_key = redis.call('HGET', KEYS[1], 'spend_key')
if not spend_key then return 0 end
local cents = tonumber(redis.call('HGET', KEYS[1], 'cents'))
redis.call('DEL', KEYS[1])
if ARGV[1] == '1' then return 0 end
redis.call('DECRBY', spend_key, cents)
return cents
\`;

interface SpendRedis extends Redis {
  claimSpend(spendKey: string, claimKey: string, capKey: string, cents: number, ttl: number): Promise<number>;
  settleClaim(claimKey: string, won: string): Promise<number>;
}

const redis = new Redis({host: 'redis', port: 6379}) as SpendRedis;
redis.defineCommand('claimSpend', {numberOfKeys: 3, lua: CLAIM_LUA});
redis.defineCommand('settleClaim', {numberOfKeys: 1, lua: SETTLE_LUA});

/** Reserve cents of the bidder's daily cap (cap:{bidder}) for the auction; false when the cap cannot cover them. */
export async function claim(bidder: string, auctionId: string, cents: number): Promise<boolean> {
  const day = new Date(Date.now()).toISOString().slice(0, 10).replace(/-/g, '');
  return (await redis.claimSpend(\`spend:\${bidder}:\${day}\`, \`claim:\${bidder}:\${auctionId}\`, \`cap:\${bidder}\`, cents, TTL_S)) === 1;
}

/** Apply the exchange's result to the auction's claim; resolves to the cents given back to the cap. */
export async function settle(bidder: string, auctionId: string, won: boolean): Promise<number> {
  console.log(\`settled auction=\${auctionId} bidder=\${bidder} won=\${won}\`);
  return Number(await redis.settleClaim(\`claim:\${bidder}:\${auctionId}\`, won ? '1' : '0'));
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// claim reserves cents of the bidder's daily cap (cap:{bidder}) for the auction; false when the cap cannot cover them.
func claim(ctx context.Context, bidder, auctionID string, cents int64) (bool, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	key := "spend:" + bidder
	limit, _ := rdb.Get(ctx, "cap:"+bidder).Int64()
	spent, _ := rdb.Get(ctx, key).Int64()
	if spent+cents > limit {
		return false, nil
	}
	return true, rdb.IncrBy(ctx, key, cents).Err()
}

// settle applies the exchange's result to the auction's claim; it returns the cents given back to the cap.
func settle(ctx context.Context, bidder, auctionID string, won bool) (int64, error) {
	log.Printf("settled auction=%s bidder=%s won=%v", auctionID, bidder, won)
	return 0, nil
}
`,
      solution: `package main

import (
	"context"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// ttlSeconds: a day's counter outlives its day by one, for the stats read and late results.
const ttlSeconds = 2 * 86400

// claimScript: KEYS the day's counter, the claim, the cap; ARGV cents, ttlSeconds. The check and the write are one step.
var claimScript = redis.NewScript(\`
local cap = tonumber(redis.call('GET', KEYS[3]) or '0')
local spent = tonumber(redis.call('GET', KEYS[1]) or '0')
local cents = tonumber(ARGV[1])
if spent + cents > cap then return 0 end
redis.call('INCRBY', KEYS[1], cents)
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
redis.call('HSET', KEYS[2], 'spend_key', KEYS[1], 'cents', cents)
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1
\`)

// settleScript: KEYS the claim; ARGV "1" won, "0" lost. Reading and deleting the claim together settles it once.
var settleScript = redis.NewScript(\`
local spend_key = redis.call('HGET', KEYS[1], 'spend_key')
if not spend_key then return 0 end
local cents = tonumber(redis.call('HGET', KEYS[1], 'cents'))
redis.call('DEL', KEYS[1])
if ARGV[1] == '1' then return 0 end
redis.call('DECRBY', spend_key, cents)
return cents
\`)

// claim reserves cents of the bidder's daily cap (cap:{bidder}) for the auction; false when the cap cannot cover them.
func claim(ctx context.Context, bidder, auctionID string, cents int64) (bool, error) {
	day := time.Now().UTC().Format("20060102")
	keys := []string{"spend:" + bidder + ":" + day, "claim:" + bidder + ":" + auctionID, "cap:" + bidder}
	n, err := claimScript.Run(ctx, rdb, keys, cents, ttlSeconds).Int64()
	return n == 1, err
}

// settle applies the exchange's result to the auction's claim; it returns the cents given back to the cap.
func settle(ctx context.Context, bidder, auctionID string, won bool) (int64, error) {
	log.Printf("settled auction=%s bidder=%s won=%v", auctionID, bidder, won)
	flag := "0"
	if won {
		flag = "1"
	}
	return settleScript.Run(ctx, rdb, []string{"claim:" + bidder + ":" + auctionID}, flag).Int64()
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** Reserve cents of the bidder's daily cap (cap:{bidder}) for the auction; false when the cap cannot cover them. */
  def claim(bidder: String, auctionId: String, cents: Long): Boolean = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    val key = s"spend:$bidder"
    val cap = Option(jedis.get(s"cap:$bidder")).map(_.toLong).getOrElse(0L)
    val spent = Option(jedis.get(key)).map(_.toLong).getOrElse(0L)
    if (spent + cents > cap) false
    else {
      jedis.incrBy(key, cents)
      true
    }
  }

  /** Apply the exchange's result to the auction's claim; returns the cents given back to the cap. */
  def settle(bidder: String, auctionId: String, won: Boolean): Long = {
    println(s"settled auction=$auctionId bidder=$bidder won=$won")
    0L
  }
}
`,
      solution: `import java.time.{LocalDate, ZoneOffset}
import java.time.format.DateTimeFormatter

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object State {
  val jedis = new JedisPooled("redis", 6379)

  /** A day's counter outlives its day by one, for the stats read and late results. */
  val TtlSeconds: Long = 2L * 86400L

  /** KEYS: the day's counter, the claim, the cap. ARGV: cents, TtlSeconds. The check and the write are one step. */
  val ClaimLua: String =
    """local cap = tonumber(redis.call('GET', KEYS[3]) or '0')
      |local spent = tonumber(redis.call('GET', KEYS[1]) or '0')
      |local cents = tonumber(ARGV[1])
      |if spent + cents > cap then return 0 end
      |redis.call('INCRBY', KEYS[1], cents)
      |if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
      |redis.call('HSET', KEYS[2], 'spend_key', KEYS[1], 'cents', cents)
      |redis.call('EXPIRE', KEYS[2], ARGV[2])
      |return 1
      |""".stripMargin

  /** KEYS: the claim. ARGV: '1' won, '0' lost. Reading and deleting the claim together settles it once. */
  val SettleLua: String =
    """local spend_key = redis.call('HGET', KEYS[1], 'spend_key')
      |if not spend_key then return 0 end
      |local cents = tonumber(redis.call('HGET', KEYS[1], 'cents'))
      |redis.call('DEL', KEYS[1])
      |if ARGV[1] == '1' then return 0 end
      |redis.call('DECRBY', spend_key, cents)
      |return cents
      |""".stripMargin

  /** Reserve cents of the bidder's daily cap (cap:{bidder}) for the auction; false when the cap cannot cover them. */
  def claim(bidder: String, auctionId: String, cents: Long): Boolean = {
    val day = LocalDate.now(ZoneOffset.UTC).format(DateTimeFormatter.BASIC_ISO_DATE)
    val keys = List(s"spend:$bidder:$day", s"claim:$bidder:$auctionId", s"cap:$bidder").asJava
    jedis.eval(ClaimLua, keys, List(cents.toString, TtlSeconds.toString).asJava).asInstanceOf[java.lang.Long] == 1L
  }

  /** Apply the exchange's result to the auction's claim; returns the cents given back to the cap. */
  def settle(bidder: String, auctionId: String, won: Boolean): Long = {
    println(s"settled auction=$auctionId bidder=$bidder won=$won")
    jedis.eval(SettleLua, List(s"claim:$bidder:$auctionId").asJava, List(if (won) "1" else "0").asJava).asInstanceOf[java.lang.Long]
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <iostream>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

// Reserve cents of the bidder's daily cap (cap:{bidder}) for the auction; false when the cap cannot cover them.
bool claim(const std::string& bidder, const std::string& auction_id, long cents) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string key = "spend:" + bidder;
  const auto cap = redis.get("cap:" + bidder);
  const auto spent = redis.get(key);
  if ((spent ? std::stol(*spent) : 0) + cents > (cap ? std::stol(*cap) : 0)) return false;
  redis.incrby(key, cents);
  return true;
}

// Apply the exchange's result to the auction's claim; returns the cents given back to the cap.
long settle(const std::string& bidder, const std::string& auction_id, bool won) {
  std::clog << "settled auction=" << auction_id << " bidder=" << bidder << " won=" << won << "\\n";
  return 0;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <ctime>
#include <iostream>
#include <string>

sw::redis::Redis redis("tcp://redis:6379");

// A day's counter outlives its day by one, for the stats read and late results.
constexpr long kTtlSeconds = 2 * 86400;

// KEYS: the day's counter, the claim, the cap. ARGV: cents, kTtlSeconds. The check and the write are one step.
const std::string kClaimLua = R"lua(
local cap = tonumber(redis.call('GET', KEYS[3]) or '0')
local spent = tonumber(redis.call('GET', KEYS[1]) or '0')
local cents = tonumber(ARGV[1])
if spent + cents > cap then return 0 end
redis.call('INCRBY', KEYS[1], cents)
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
redis.call('HSET', KEYS[2], 'spend_key', KEYS[1], 'cents', cents)
redis.call('EXPIRE', KEYS[2], ARGV[2])
return 1
)lua";

// KEYS: the claim. ARGV: '1' won, '0' lost. Reading and deleting the claim together settles it once.
const std::string kSettleLua = R"lua(
local spend_key = redis.call('HGET', KEYS[1], 'spend_key')
if not spend_key then return 0 end
local cents = tonumber(redis.call('HGET', KEYS[1], 'cents'))
redis.call('DEL', KEYS[1])
if ARGV[1] == '1' then return 0 end
redis.call('DECRBY', spend_key, cents)
return cents
)lua";

std::string utcDay() {
  const std::time_t now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  std::tm utc{};
  gmtime_r(&now, &utc);
  char out[9];
  std::strftime(out, sizeof out, "%Y%m%d", &utc);
  return out;
}

// Reserve cents of the bidder's daily cap (cap:{bidder}) for the auction; false when the cap cannot cover them.
bool claim(const std::string& bidder, const std::string& auction_id, long cents) {
  const auto keys = {"spend:" + bidder + ":" + utcDay(), "claim:" + bidder + ":" + auction_id, "cap:" + bidder};
  const auto args = {std::to_string(cents), std::to_string(kTtlSeconds)};
  return redis.eval<long long>(kClaimLua, keys.begin(), keys.end(), args.begin(), args.end()) == 1;
}

// Apply the exchange's result to the auction's claim; returns the cents given back to the cap.
long settle(const std::string& bidder, const std::string& auction_id, bool won) {
  std::clog << "settled auction=" << auction_id << " bidder=" << bidder << " won=" << won << "\\n";
  return static_cast<long>(redis.eval<long long>(kSettleLua, {"claim:" + bidder + ":" + auction_id}, {std::string(won ? "1" : "0")}));
}
`,
    },
  },
  harness: {
    python: `import time

CAP = 1000


def _day(offset_s=0):
    return time.strftime("%Y%m%d", time.gmtime(time.time() + offset_s))


def _state(ctx, cap=CAP):
    ctx.redis.set("cap:b-1", cap)
    return ctx.load("state")


def _spent(ctx, bidder="b-1"):
    """Every cent the bidder's counters hold, whatever the key."""
    return sum(int(ctx.redis.get(k) or 0) for k in ctx.redis.keys(f"spend:{bidder}*"))


def check_atomic_claim(ctx):
    m = _state(ctx)
    rival = {}

    def race():
        if not rival:
            rival["passed"] = m.claim("b-1", "a-2", 600)

    # A second bid claims the same headroom right after this claim first touches the counter.
    ctx.redis_after("spend:b-1", race)
    ctx.redis_after(f"spend:b-1:{_day()}", race)
    ours = m.claim("b-1", "a-1", 600)
    assert rival, "claim never touched the bidder's spend counter (spend:b-1:{yyyymmdd})"
    passed = [ours, rival["passed"]].count(True)
    assert passed == 1, f"two claims of 600 raced for a cap of 1000 and {passed} passed (the counters hold {_spent(ctx)}): the check and the INCRBY must run in one script"
    assert _spent(ctx) == 600, f"after one passing claim of 600 the counters hold {_spent(ctx)}"
    assert m.claim("b-1", "a-3", 400) is True, "with 600 of a 1000 cap spent a claim of 400 reaches the cap exactly and must pass"
    assert m.claim("b-1", "a-4", 1) is False and _spent(ctx) == 1000, f"with the cap reached a claim of 1 must be refused; the counters hold {_spent(ctx)}"


def check_release_on_loss(ctx):
    m = _state(ctx)
    assert m.claim("b-1", "a-1", 600) is True, "a claim of 600 under a cap of 1000 must pass"
    returned = m.settle("b-1", "a-1", False)
    assert returned == 600, f"settle of a lost auction that claimed 600 gave back {returned!r}: a lost auction spends nothing"
    assert _spent(ctx) == 0, f"after the loss the counters still hold {_spent(ctx)}"
    assert m.claim("b-1", "a-2", 900) is True, "with the loss given back a claim of 900 must fit the cap of 1000"
    assert m.settle("b-1", "a-2", True) == 0, "a won auction keeps its charge: settle must give back 0"
    assert _spent(ctx) == 900, f"after a win of 900 the counters hold {_spent(ctx)}"


def check_release_once(ctx):
    m = _state(ctx)
    m.claim("b-1", "a-1", 600)
    m.claim("b-1", "a-2", 300)
    first = m.settle("b-1", "a-1", False)
    second = m.settle("b-1", "a-1", False)  # the exchange delivered the loss notice twice
    assert (first, second) == (600, 0), f"two loss notices for one claim of 600 gave back {first!r} then {second!r}, expected 600 once"
    assert _spent(ctx) == 300, f"after a duplicate loss notice the counters hold {_spent(ctx)}, expected the 300 still claimed"
    assert m.settle("b-1", "a-9", False) == 0, "a loss notice for an auction never claimed must give back 0"
    assert m.settle("b-1", "a-2", True) == 0 and m.settle("b-1", "a-2", False) == 0, "a loss notice after the win of a-2 must give back 0"
    assert _spent(ctx) == 300, f"the counters hold {_spent(ctx)}, expected the 300 a-2 won"
    m.claim("b-1", "a-3", 200)
    given = []
    # A second loss notice for a-3 is handled right after the first one first touches the claim.
    ctx.redis_after("claim:b-1:a-3", lambda: given.append(m.settle("b-1", "a-3", False)))
    given.append(m.settle("b-1", "a-3", False))
    assert sum(given) == 200 and _spent(ctx) == 300, f"two racing loss notices for a claim of 200 gave back {given} and left the counters at {_spent(ctx)}: reading the claim, deleting it and the DECRBY must be one script"
    ctx.redis.set("cap:b-2", 1000)
    assert m.claim("b-1", "a-5", 100) and m.claim("b-2", "a-5", 500), "claims of 100 by b-1 and 500 by b-2 for the same auction must both pass"
    assert m.settle("b-1", "a-5", False) == 100, "b-1's loss of a-5 must give back b-1's 100: the claim is per bidder and auction"
    assert _spent(ctx, "b-2") == 500 and m.settle("b-2", "a-5", False) == 500, f"b-2's claim of a-5 must be untouched by b-1's loss and give back its 500 (b-2's counters hold {_spent(ctx, 'b-2')})"


def check_daily_window(ctx):
    m = _state(ctx)
    ctx.clock.advance(86400 - ctx.clock.time() % 86400 + 10)  # 00:00:10 UTC: the next hour stays on this day
    key = f"spend:b-1:{_day()}"
    created = ctx.redis_after(key, lambda: ctx.redis.ttl(key))
    assert m.claim("b-1", "a-1", 900) is True, "a claim of 900 under a cap of 1000 must pass"
    assert ctx.redis.get(key) == "900", f"{key} holds {ctx.redis.get(key)!r} (keys {sorted(ctx.redis.keys('spend:*'))}): the counter must be per UTC day"
    assert created.fired and 0 < created.result <= 2 * 86400, f"right after the claim first wrote {key} its TTL was {created.result}: the script itself sets the expiry, at most two days, on its first write"
    ttl = ctx.redis.ttl("claim:b-1:a-1")
    assert 0 < ttl <= 2 * 86400, f"claim:b-1:a-1 has TTL {ttl}: the claim hash expires with the counter"
    ctx.clock.advance(3600)
    assert m.claim("b-1", "a-2", 50) is True, "an hour later a claim of 50 must fit the 100 left"
    ttl = ctx.redis.ttl(key)
    assert 0 < ttl <= 2 * 86400 - 3600, f"an hour after its first write {key} has TTL {ttl}: the expiry is set on the first write, not pushed back by every claim"
    assert m.claim("b-1", "a-3", 200) is False, "the same day a claim of 200 must not fit the 50 left"
    ctx.clock.advance(86400)
    assert m.claim("b-1", "a-4", 200) is True, "a new UTC day must start with a fresh cap"
    today = f"spend:b-1:{_day()}"
    assert ctx.redis.get(today) == "200", f"the new day's counter holds {ctx.redis.get(today)!r}, expected 200"
    assert m.settle("b-1", "a-1", False) == 900, "yesterday's lost auction must give back its 900"
    assert ctx.redis.get(today) == "200" and ctx.redis.get(key) == "50", f"a loss gives back to the counter its claim came from: yesterday's {key} holds {ctx.redis.get(key)!r} (expected 50), today's {ctx.redis.get(today)!r} (expected 200)"
`,
    typescript: `const CAP = 1000;

const day = (offsetS = 0): string => new Date(Date.now() + offsetS * 1000).toISOString().slice(0, 10).replace(/-/g, '');

function state(ctx, cap = CAP) {
  ctx.redis.set('cap:b-1', cap);
  return ctx.load('state');
}

/** Every cent the bidder's counters hold, whatever the key. */
const spent = (ctx, bidder = 'b-1'): number => (ctx.redis.keys(\`spend:\${bidder}*\`) as string[]).reduce((sum, k) => sum + Number(ctx.redis.get(k) ?? 0), 0);

export async function check_atomic_claim(ctx) {
  const m = state(ctx);
  let rival: Promise<boolean> | null = null;
  const race = () => {
    rival ??= m.claim('b-1', 'a-2', 600);
    return null;
  };
  // A second bid claims the same headroom right after this claim first touches the counter.
  ctx.redisAfter('spend:b-1', race);
  ctx.redisAfter(\`spend:b-1:\${day()}\`, race);
  const ours = await m.claim('b-1', 'a-1', 600);
  assert(rival !== null, 'claim never touched the bidder\\'s spend counter (spend:b-1:{yyyymmdd})');
  const passed = [ours, await rival].filter(p => p === true).length;
  assert.equal(passed, 1, \`two claims of 600 raced for a cap of 1000 and \${passed} passed (the counters hold \${spent(ctx)}): the check and the INCRBY must run in one script\`);
  assert.equal(spent(ctx), 600, \`after one passing claim of 600 the counters hold \${spent(ctx)}\`);
  assert.equal(await m.claim('b-1', 'a-3', 400), true, 'with 600 of a 1000 cap spent a claim of 400 reaches the cap exactly and must pass');
  assert((await m.claim('b-1', 'a-4', 1)) === false && spent(ctx) === 1000, \`with the cap reached a claim of 1 must be refused; the counters hold \${spent(ctx)}\`);
}

export async function check_release_on_loss(ctx) {
  const m = state(ctx);
  assert.equal(await m.claim('b-1', 'a-1', 600), true, 'a claim of 600 under a cap of 1000 must pass');
  const returned = await m.settle('b-1', 'a-1', false);
  assert.equal(returned, 600, \`settle of a lost auction that claimed 600 gave back \${returned}: a lost auction spends nothing\`);
  assert.equal(spent(ctx), 0, \`after the loss the counters still hold \${spent(ctx)}\`);
  assert.equal(await m.claim('b-1', 'a-2', 900), true, 'with the loss given back a claim of 900 must fit the cap of 1000');
  assert.equal(await m.settle('b-1', 'a-2', true), 0, 'a won auction keeps its charge: settle must give back 0');
  assert.equal(spent(ctx), 900, \`after a win of 900 the counters hold \${spent(ctx)}\`);
}

export async function check_release_once(ctx) {
  const m = state(ctx);
  await m.claim('b-1', 'a-1', 600);
  await m.claim('b-1', 'a-2', 300);
  const first = await m.settle('b-1', 'a-1', false);
  const second = await m.settle('b-1', 'a-1', false); // the exchange delivered the loss notice twice
  assert(first === 600 && second === 0, \`two loss notices for one claim of 600 gave back \${first} then \${second}, expected 600 once\`);
  assert.equal(spent(ctx), 300, \`after a duplicate loss notice the counters hold \${spent(ctx)}, expected the 300 still claimed\`);
  assert.equal(await m.settle('b-1', 'a-9', false), 0, 'a loss notice for an auction never claimed must give back 0');
  assert.equal(await m.settle('b-1', 'a-2', true), 0, 'a won auction keeps its charge');
  assert.equal(await m.settle('b-1', 'a-2', false), 0, 'a loss notice after the win of a-2 must give back 0');
  assert.equal(spent(ctx), 300, \`the counters hold \${spent(ctx)}, expected the 300 a-2 won\`);
  await m.claim('b-1', 'a-3', 200);
  let rival: Promise<number> | null = null;
  // A second loss notice for a-3 is handled right after the first one first touches the claim.
  ctx.redisAfter('claim:b-1:a-3', () => {
    rival ??= m.settle('b-1', 'a-3', false);
    return null;
  });
  const given = [await m.settle('b-1', 'a-3', false), await rival];
  assert(given[0] + (given[1] ?? 0) === 200 && spent(ctx) === 300, \`two racing loss notices for a claim of 200 gave back \${JSON.stringify(given)} and left the counters at \${spent(ctx)}: reading the claim, deleting it and the DECRBY must be one script\`);
  ctx.redis.set('cap:b-2', 1000);
  assert((await m.claim('b-1', 'a-5', 100)) && (await m.claim('b-2', 'a-5', 500)), 'claims of 100 by b-1 and 500 by b-2 for the same auction must both pass');
  assert.equal(await m.settle('b-1', 'a-5', false), 100, "b-1's loss of a-5 must give back b-1's 100: the claim is per bidder and auction");
  assert(spent(ctx, 'b-2') === 500 && (await m.settle('b-2', 'a-5', false)) === 500, \`b-2's claim of a-5 must be untouched by b-1's loss and give back its 500 (b-2's counters hold \${spent(ctx, 'b-2')})\`);
}

export async function check_daily_window(ctx) {
  const m = state(ctx);
  ctx.clock.advance(86400 - ((Date.now() / 1000) % 86400) + 10); // 00:00:10 UTC: the next hour stays on this day
  const key = \`spend:b-1:\${day()}\`;
  const created = ctx.redisAfter(key, () => ctx.redis.ttl(key));
  assert.equal(await m.claim('b-1', 'a-1', 900), true, 'a claim of 900 under a cap of 1000 must pass');
  assert.equal(ctx.redis.get(key), '900', \`\${key} holds \${JSON.stringify(ctx.redis.get(key))} (keys \${JSON.stringify(ctx.redis.keys('spend:*'))}): the counter must be per UTC day\`);
  assert(created.fired && created.result > 0 && created.result <= 2 * 86400, \`right after the claim first wrote \${key} its TTL was \${created.result}: the script itself sets the expiry, at most two days, on its first write\`);
  let ttl = ctx.redis.ttl('claim:b-1:a-1');
  assert(ttl > 0 && ttl <= 2 * 86400, \`claim:b-1:a-1 has TTL \${ttl}: the claim hash expires with the counter\`);
  ctx.clock.advance(3600);
  assert.equal(await m.claim('b-1', 'a-2', 50), true, 'an hour later a claim of 50 must fit the 100 left');
  ttl = ctx.redis.ttl(key);
  assert(ttl > 0 && ttl <= 2 * 86400 - 3600, \`an hour after its first write \${key} has TTL \${ttl}: the expiry is set on the first write, not pushed back by every claim\`);
  assert.equal(await m.claim('b-1', 'a-3', 200), false, 'the same day a claim of 200 must not fit the 50 left');
  ctx.clock.advance(86400);
  assert.equal(await m.claim('b-1', 'a-4', 200), true, 'a new UTC day must start with a fresh cap');
  const today = \`spend:b-1:\${day()}\`;
  assert.equal(ctx.redis.get(today), '200', 'the new day\\'s counter must hold 200');
  assert.equal(await m.settle('b-1', 'a-1', false), 900, "yesterday's lost auction must give back its 900");
  assert(ctx.redis.get(today) === '200' && ctx.redis.get(key) === '50', \`a loss gives back to the counter its claim came from: yesterday's \${key} holds \${JSON.stringify(ctx.redis.get(key))} (expected 50), today's \${JSON.stringify(ctx.redis.get(today))} (expected 200)\`);
}
`,
    go: `package main

import (
	"context"
	"strconv"
	"time"

	"leetbuild/harness"
)

const stateCap = 1000

var stateBg = context.Background()

func stateDay(ctx *harness.Ctx) string { return ctx.Clock.Time().UTC().Format("20060102") }

func stateSetup(ctx *harness.Ctx) { ctx.Redis.Set("cap:b-1", stateCap) }

// stateSpent is every cent the bidder's counters hold, whatever the key.
func stateSpent(ctx *harness.Ctx, bidder string) int64 {
	var sum int64
	for _, k := range ctx.Redis.Keys("spend:" + bidder + "*") {
		v, _ := ctx.Redis.Get(k)
		n, _ := strconv.ParseInt(v, 10, 64)
		sum += n
	}
	return sum
}

func stateClaim(ctx *harness.Ctx, bidder, auctionID string, cents int64) bool {
	ok, err := claim(stateBg, bidder, auctionID, cents)
	ctx.NoError(err, "claim(%s, %s, %d) failed", bidder, auctionID, cents)
	return ok
}

func stateSettle(ctx *harness.Ctx, bidder, auctionID string, won bool) int64 {
	n, err := settle(stateBg, bidder, auctionID, won)
	ctx.NoError(err, "settle(%s, %s, %v) failed", bidder, auctionID, won)
	return n
}

func CheckAtomicClaim(ctx *harness.Ctx) {
	stateSetup(ctx)
	fired, rival := false, false
	var rivalErr error
	race := func() any {
		if !fired {
			fired = true
			rival, rivalErr = claim(stateBg, "b-1", "a-2", 600)
		}
		return nil
	}
	// A second bid claims the same headroom right after this claim first touches the counter.
	ctx.Redis.After("spend:b-1", race)
	ctx.Redis.After("spend:b-1:"+stateDay(ctx), race)
	ours := stateClaim(ctx, "b-1", "a-1", 600)
	ctx.Assert(fired, "claim never touched the bidder's spend counter (spend:b-1:{yyyymmdd})")
	ctx.NoError(rivalErr, "the racing claim failed")
	passed := 0
	for _, p := range []bool{ours, rival} {
		if p {
			passed++
		}
	}
	ctx.Assert(passed == 1, "two claims of 600 raced for a cap of 1000 and %d passed (the counters hold %d): the check and the INCRBY must run in one script", passed, stateSpent(ctx, "b-1"))
	ctx.Equal(stateSpent(ctx, "b-1"), 600, "after one passing claim of 600, the counters")
	ctx.Equal(stateClaim(ctx, "b-1", "a-3", 400), true, "with 600 of a 1000 cap spent a claim of 400 reaches the cap exactly and must pass; passed")
	ctx.Assert(!stateClaim(ctx, "b-1", "a-4", 1) && stateSpent(ctx, "b-1") == 1000, "with the cap reached a claim of 1 must be refused; the counters hold %d", stateSpent(ctx, "b-1"))
}

func CheckReleaseOnLoss(ctx *harness.Ctx) {
	stateSetup(ctx)
	ctx.Equal(stateClaim(ctx, "b-1", "a-1", 600), true, "a claim of 600 under a cap of 1000 must pass; passed")
	ctx.Equal(stateSettle(ctx, "b-1", "a-1", false), 600, "settle of a lost auction that claimed 600 must give it back (a lost auction spends nothing); given back")
	ctx.Equal(stateSpent(ctx, "b-1"), 0, "after the loss, the counters")
	ctx.Equal(stateClaim(ctx, "b-1", "a-2", 900), true, "with the loss given back a claim of 900 must fit the cap of 1000; passed")
	ctx.Equal(stateSettle(ctx, "b-1", "a-2", true), 0, "a won auction keeps its charge; given back")
	ctx.Equal(stateSpent(ctx, "b-1"), 900, "after a win of 900, the counters")
}

func CheckReleaseOnce(ctx *harness.Ctx) {
	stateSetup(ctx)
	stateClaim(ctx, "b-1", "a-1", 600)
	stateClaim(ctx, "b-1", "a-2", 300)
	first := stateSettle(ctx, "b-1", "a-1", false)
	second := stateSettle(ctx, "b-1", "a-1", false) // the exchange delivered the loss notice twice
	ctx.Assert(first == 600 && second == 0, "two loss notices for one claim of 600 gave back %d then %d, expected 600 once", first, second)
	ctx.Equal(stateSpent(ctx, "b-1"), 300, "after a duplicate loss notice the counters must hold the 300 still claimed; they hold")
	ctx.Equal(stateSettle(ctx, "b-1", "a-9", false), 0, "a loss notice for an auction never claimed; given back")
	ctx.Equal(stateSettle(ctx, "b-1", "a-2", true), 0, "a won auction keeps its charge; given back")
	ctx.Equal(stateSettle(ctx, "b-1", "a-2", false), 0, "a loss notice after the win of a-2; given back")
	ctx.Equal(stateSpent(ctx, "b-1"), 300, "the counters must hold the 300 a-2 won; they hold")
	stateClaim(ctx, "b-1", "a-3", 200)
	var rival int64
	raced := false
	// A second loss notice for a-3 is handled right after the first one first touches the claim.
	ctx.Redis.After("claim:b-1:a-3", func() any {
		if !raced {
			raced = true
			rival, _ = settle(stateBg, "b-1", "a-3", false)
		}
		return nil
	})
	ours := stateSettle(ctx, "b-1", "a-3", false)
	ctx.Assert(ours+rival == 200 && stateSpent(ctx, "b-1") == 300, "two racing loss notices for a claim of 200 gave back %d and %d and left the counters at %d: reading the claim, deleting it and the DECRBY must be one script", ours, rival, stateSpent(ctx, "b-1"))
	ctx.Redis.Set("cap:b-2", 1000)
	ctx.Assert(stateClaim(ctx, "b-1", "a-5", 100) && stateClaim(ctx, "b-2", "a-5", 500), "claims of 100 by b-1 and 500 by b-2 for the same auction must both pass")
	ctx.Equal(stateSettle(ctx, "b-1", "a-5", false), 100, "b-1's loss of a-5 must give back b-1's 100 (the claim is per bidder and auction); given back")
	ctx.Equal(stateSpent(ctx, "b-2"), 500, "b-2's claim of a-5 must be untouched by b-1's loss; b-2's counters")
	ctx.Equal(stateSettle(ctx, "b-2", "a-5", false), 500, "b-2's loss of a-5; given back")
}

func CheckDailyWindow(ctx *harness.Ctx) {
	stateSetup(ctx)
	now := ctx.Clock.Time().UTC()
	ctx.Clock.AdvanceBy(now.Truncate(24*time.Hour).Add(24*time.Hour + 10*time.Second).Sub(now)) // 00:00:10 UTC: the next hour stays on this day
	key := "spend:b-1:" + stateDay(ctx)
	var created int64
	probe := ctx.Redis.After(key, func() any {
		created = ctx.Redis.TTL(key)
		return nil
	})
	ctx.Equal(stateClaim(ctx, "b-1", "a-1", 900), true, "a claim of 900 under a cap of 1000 must pass; passed")
	got, _ := ctx.Redis.Get(key)
	ctx.Equal(got, "900", "the counter must be per UTC day (keys %q); %s", ctx.Redis.Keys("spend:*"), key)
	ctx.Assert(probe.Fired && created > 0 && created <= 2*86400, "right after the claim first wrote %s its TTL was %d: the script itself sets the expiry, at most two days, on its first write", key, created)
	ttl := ctx.Redis.TTL("claim:b-1:a-1")
	ctx.Assert(ttl > 0 && ttl <= 2*86400, "claim:b-1:a-1 has TTL %d: the claim hash expires with the counter", ttl)
	ctx.Clock.AdvanceBy(time.Hour)
	ctx.Equal(stateClaim(ctx, "b-1", "a-2", 50), true, "an hour later a claim of 50 must fit the 100 left; passed")
	ttl = ctx.Redis.TTL(key)
	ctx.Assert(ttl > 0 && ttl <= 2*86400-3600, "an hour after its first write %s has TTL %d: the expiry is set on the first write, not pushed back by every claim", key, ttl)
	ctx.Equal(stateClaim(ctx, "b-1", "a-3", 200), false, "the same day a claim of 200 must not fit the 50 left; passed")
	ctx.Clock.AdvanceBy(24 * time.Hour)
	ctx.Equal(stateClaim(ctx, "b-1", "a-4", 200), true, "a new UTC day must start with a fresh cap; passed")
	today := "spend:b-1:" + stateDay(ctx)
	got, _ = ctx.Redis.Get(today)
	ctx.Equal(got, "200", "the new day's counter")
	ctx.Equal(stateSettle(ctx, "b-1", "a-1", false), 900, "yesterday's lost auction must give back its 900; given back")
	got, _ = ctx.Redis.Get(today)
	old, _ := ctx.Redis.Get(key)
	ctx.Assert(got == "200" && old == "50", "a loss gives back to the counter its claim came from: yesterday's %s holds %q (expected 50), today's %q (expected 200)", key, old, got)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <chrono>
#include <ctime>
#include <memory>
#include <string>

namespace {

constexpr long kStateCap = 1000;

std::string stateDay() {
  const std::time_t now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  std::tm utc{};
  gmtime_r(&now, &utc);
  char out[9];
  std::strftime(out, sizeof out, "%Y%m%d", &utc);
  return out;
}

void stateSetup(harness::Ctx& ctx) { ctx.Redis.Set("cap:b-1", kStateCap); }

// Every cent the bidder's counters hold, whatever the key.
long stateSpent(harness::Ctx& ctx, const std::string& bidder = "b-1") {
  long sum = 0;
  for (const auto& k : ctx.Redis.Keys("spend:" + bidder + "*")) sum += std::stol(ctx.Redis.Get(k).value_or("0"));
  return sum;
}

struct StateRival {
  bool fired = false;
  bool passed = false;
  long given = 0;
  std::string error;
};

}  // namespace

void CheckAtomicClaim(harness::Ctx& ctx) {
  stateSetup(ctx);
  auto rival = std::make_shared<StateRival>();
  const auto race = [rival] {
    if (rival->fired) return;
    rival->fired = true;
    try {
      rival->passed = claim("b-1", "a-2", 600);
    } catch (const std::exception& e) {
      rival->error = e.what();
    }
  };
  // A second bid claims the same headroom right after this claim first touches the counter.
  ctx.Redis.After("spend:b-1", race);
  ctx.Redis.After("spend:b-1:" + stateDay(), race);
  const bool ours = claim("b-1", "a-1", 600);
  ctx.Assert(rival->fired, "claim never touched the bidder's spend counter (spend:b-1:{yyyymmdd})");
  ctx.Assert(rival->error.empty(), "the racing claim failed: %s", rival->error);
  const int passed = (ours ? 1 : 0) + (rival->passed ? 1 : 0);
  ctx.Assert(passed == 1, "two claims of 600 raced for a cap of 1000 and %d passed (the counters hold %d): the check and the INCRBY must run in one script", passed, stateSpent(ctx));
  ctx.Equal(stateSpent(ctx), 600, "after one passing claim of 600, the counters");
  ctx.Equal(claim("b-1", "a-3", 400), true, "with 600 of a 1000 cap spent a claim of 400 reaches the cap exactly and must pass; passed");
  ctx.Assert(!claim("b-1", "a-4", 1) && stateSpent(ctx) == 1000, "with the cap reached a claim of 1 must be refused; the counters hold %d", stateSpent(ctx));
}

void CheckReleaseOnLoss(harness::Ctx& ctx) {
  stateSetup(ctx);
  ctx.Equal(claim("b-1", "a-1", 600), true, "a claim of 600 under a cap of 1000 must pass; passed");
  ctx.Equal(settle("b-1", "a-1", false), 600, "settle of a lost auction that claimed 600 must give it back (a lost auction spends nothing); given back");
  ctx.Equal(stateSpent(ctx), 0, "after the loss, the counters");
  ctx.Equal(claim("b-1", "a-2", 900), true, "with the loss given back a claim of 900 must fit the cap of 1000; passed");
  ctx.Equal(settle("b-1", "a-2", true), 0, "a won auction keeps its charge; given back");
  ctx.Equal(stateSpent(ctx), 900, "after a win of 900, the counters");
}

void CheckReleaseOnce(harness::Ctx& ctx) {
  stateSetup(ctx);
  claim("b-1", "a-1", 600);
  claim("b-1", "a-2", 300);
  const long first = settle("b-1", "a-1", false);
  const long second = settle("b-1", "a-1", false);  // the exchange delivered the loss notice twice
  ctx.Assert(first == 600 && second == 0, "two loss notices for one claim of 600 gave back %d then %d, expected 600 once", first, second);
  ctx.Equal(stateSpent(ctx), 300, "after a duplicate loss notice the counters must hold the 300 still claimed; they hold");
  ctx.Equal(settle("b-1", "a-9", false), 0, "a loss notice for an auction never claimed; given back");
  ctx.Equal(settle("b-1", "a-2", true), 0, "a won auction keeps its charge; given back");
  ctx.Equal(settle("b-1", "a-2", false), 0, "a loss notice after the win of a-2; given back");
  ctx.Equal(stateSpent(ctx), 300, "the counters must hold the 300 a-2 won; they hold");
  claim("b-1", "a-3", 200);
  auto rival = std::make_shared<StateRival>();
  // A second loss notice for a-3 is handled right after the first one first touches the claim.
  ctx.Redis.After("claim:b-1:a-3", [rival] {
    if (rival->fired) return;
    rival->fired = true;
    try {
      rival->given = settle("b-1", "a-3", false);
    } catch (const std::exception& e) {
      rival->error = e.what();
    }
  });
  const long ours = settle("b-1", "a-3", false);
  ctx.Assert(ours + rival->given == 200 && stateSpent(ctx) == 300, "two racing loss notices for a claim of 200 gave back %d and %d and left the counters at %d: reading the claim, deleting it and the DECRBY must be one script", ours, rival->given, stateSpent(ctx));
  ctx.Redis.Set("cap:b-2", 1000);
  ctx.Assert(claim("b-1", "a-5", 100) && claim("b-2", "a-5", 500), "claims of 100 by b-1 and 500 by b-2 for the same auction must both pass");
  ctx.Equal(settle("b-1", "a-5", false), 100, "b-1's loss of a-5 must give back b-1's 100 (the claim is per bidder and auction); given back");
  ctx.Equal(stateSpent(ctx, "b-2"), 500, "b-2's claim of a-5 must be untouched by b-1's loss; b-2's counters");
  ctx.Equal(settle("b-2", "a-5", false), 500, "b-2's loss of a-5; given back");
}

void CheckDailyWindow(harness::Ctx& ctx) {
  stateSetup(ctx);
  const int64_t now_ms = ctx.Clock.Now();
  ctx.Clock.Advance(static_cast<double>(86400000 - now_ms % 86400000) / 1000 + 10);  // 00:00:10 UTC: the next hour stays on this day
  const std::string key = "spend:b-1:" + stateDay();
  bool fired = false;
  long long created = 0;
  ctx.Redis.After(key, [&] {
    fired = true;
    created = ctx.Redis.TTL(key);
  });
  ctx.Equal(claim("b-1", "a-1", 900), true, "a claim of 900 under a cap of 1000 must pass; passed");
  ctx.Equal(ctx.Redis.Get(key).value_or(""), "900", "the counter must be per UTC day (keys %q); %s", ctx.Redis.Keys("spend:*"), key);
  ctx.Assert(fired && created > 0 && created <= 2 * 86400, "right after the claim first wrote %s its TTL was %d: the script itself sets the expiry, at most two days, on its first write", key, created);
  long long ttl = ctx.Redis.TTL("claim:b-1:a-1");
  ctx.Assert(ttl > 0 && ttl <= 2 * 86400, "claim:b-1:a-1 has TTL %d: the claim hash expires with the counter", ttl);
  ctx.Clock.Advance(3600);
  ctx.Equal(claim("b-1", "a-2", 50), true, "an hour later a claim of 50 must fit the 100 left; passed");
  ttl = ctx.Redis.TTL(key);
  ctx.Assert(ttl > 0 && ttl <= 2 * 86400 - 3600, "an hour after its first write %s has TTL %d: the expiry is set on the first write, not pushed back by every claim", key, ttl);
  ctx.Equal(claim("b-1", "a-3", 200), false, "the same day a claim of 200 must not fit the 50 left; passed");
  ctx.Clock.Advance(86400);
  ctx.Equal(claim("b-1", "a-4", 200), true, "a new UTC day must start with a fresh cap; passed");
  const std::string today = "spend:b-1:" + stateDay();
  ctx.Equal(ctx.Redis.Get(today).value_or(""), "200", "the new day's counter");
  ctx.Equal(settle("b-1", "a-1", false), 900, "yesterday's lost auction must give back its 900; given back");
  const std::string now_today = ctx.Redis.Get(today).value_or(""), old = ctx.Redis.Get(key).value_or("");
  ctx.Assert(now_today == "200" && old == "50", "a loss gives back to the counter its claim came from: yesterday's %s holds %q (expected 50), today's %q (expected 200)", key, old, now_today);
}
`,
  },
  hints: [
    'After a busy second the cap reads 1 200 of 1 000, auctions the bidder lost still count against its budget, and once the counter fills up no new day ever frees it.',
    "Between the starter's `GET` and its `INCRBY` another bid can claim the same headroom. `settle` never touches the counter, and the counter has no day in its key and no expiry, so it neither gives losses back nor resets.",
    'One script for `claim`: `GET` cap and counter, return 0 when over, else `INCRBY`, `EXPIRE` when there is no TTL, `HSET` the claim. One for `settle`: `HGET` the claim, 0 if absent, `DEL` it, `DECRBY` on a loss. Key the counter `spend:{bidder}:{yyyymmdd}`.',
  ],
  debrief: `The claim record is what makes the release safe: once the cents a claim took live next to the counter they came from, a loss notice can give back exactly that much, and deleting the record in the same script turns a repeated notice into a no-op. The cap check moves into the script for the same reason a lock would be wrong here: the decision and the write have to be one step, and one step costs one round trip. The day in the key turns a reset job into an expiry. Production bidders pace the cap across the day instead of letting the first hour spend it, and reconcile the counter against the exchange's billing report, since a win notice can arrive late or not at all.`,
};
