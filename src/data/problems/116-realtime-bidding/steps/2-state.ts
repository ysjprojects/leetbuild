import type {Step} from '@/lib/types';

/**
 * Step 2 — the spend cap. One atomic claim per bidder per day, a release when the auction is lost,
 * and a window bucket so the counter resets with the day.
 */
export const stateStep: Step = {
  id: 'state',
  title: 'Redis spend caps with atomic claim and release',
  concept: 'redis',
  file: 'state',
  focus: ['bidding', 'redis'],
  task: `## Task

**Review premise.** You are the AI platform engineer on call. Three bidders hit their daily cap before
noon on a quiet day, one bidder's spend went negative in a dashboard, and a load test showed four bids
in the same millisecond all passing the cap check with room for one. The model-generated module below
reads the counter with \`GET\` and then decrements it in a second round trip, never returns a claim
when the auction is lost, and keys the counter without a day bucket.

Review \`state\` and make the cap correct under concurrency, then prove the fix.

- Reserve spend with **one atomic operation**: a Lua script run through \`EVAL\`. Inside the script,
  read the usage, compare \`current + cost > cap\`, and only then increment. A \`GET\` followed by a
  \`DECRBY\` is the bug, not the fix: two concurrent bids both read the last unit and both spend it.
- The claim must return the exact amount reserved (the cost), or \`0\` when the cap would be
  exceeded, so the caller can release precisely what it took.
- A **lost** auction must return its claim, and a won auction must keep it charged. Express that as a
  \`release\` plus the settlement the caller runs on the auction result (\`"lost"\` / \`"won"\`).
- The release must be safe to repeat: a release that drives the counter below zero grants free spend
  for the rest of the day. Clamp it inside its own Lua script (\`DECRBY\`, then \`left < 0\` → set back
  to 0).
- The counter is **per bidder per day**: key it \`spend:cap:{bidder}:{day}\` and set the expiry with
  \`EXPIREAT\` to the next UTC midnight on the first write of the window, so the cap resets with the
  day instead of living forever.

**Failure mode the checks target.** The draft's claim is a read and a write, so it cannot hold a cap
under load: every concurrent bid that arrives in the same millisecond sees the same remaining budget.
The missing release is the quiet one — the draft charges at bid time and keeps the charge even when
the auction is lost, so a bidder that loses 90% of its auctions burns its whole daily cap in minutes
while winning almost nothing. The missing day bucket turns a bad afternoon into a permanently
exhausted account.`,
  sequence: {
    participants: ['Bidding service', 'Redis', 'Ad exchange'],
    messages: [
      {
        from: 'Bidding service',
        to: 'Redis',
        label: 'EVAL claim(spend:cap:b-7:2026-10-21, 240, 500000, expireat)',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Bidding service', label: '1 (claimed) / 0 (cap exceeded)', kind: 'reply'},
      {from: 'Bidding service', to: 'Ad exchange', label: 'bid 240 cents on the claim', kind: 'sync'},
      {from: 'Ad exchange', to: 'Bidding service', label: 'lost · floor not met', kind: 'reply'},
      {from: 'Bidding service', to: 'Redis', label: 'EVAL release(spend:cap:b-7:2026-10-21, 240)', kind: 'sync'},
      {from: 'Redis', to: 'Bidding service', label: 'used again = 0 (clamped at 0)', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'atomic-claim',
      title: 'The claim is one Lua script, not a read then a write',
      detail:
        'Reserve the spend with a single Lua script run through `EVAL`, and never read the counter with a client-side `GET` first. The draft’s `GET`-then-`DECRBY` pair lets two concurrent bids both pass the last unit.',
      match: {
        python: {all: [/CLAIM_SCRIPT/, /\.eval\(/], none: [/\.get\(/]},
        typescript: {all: [/CLAIM_SCRIPT/, /\.eval\(/], none: [/\.get\(/]},
        go: {all: [/claimScript/, /\.Run\(/], none: [/\.Get\(/]},
        scala: {all: [/ClaimScript/, /\.eval\(/], none: [/\.get\(/]},
        cpp: {all: [/kClaimScript/, /\.eval/], none: [/\.get\(/]},
      },
    },
    {
      id: 'cap-guard',
      title: 'The cap is decided inside the script',
      detail:
        'The script itself compares `current + cost > cap` and returns 0 without incrementing, so the cap cannot be exceeded by any interleaving. The draft compares in the client, where the check and the write can be separated.',
      match: {
        python: {all: [/current \+ cost > cap/]},
        typescript: {all: [/current \+ cost > cap/]},
        go: {all: [/current \+ cost > cap/]},
        scala: {all: [/current \+ cost > cap/]},
        cpp: {all: [/current \+ cost > cap/]},
      },
    },
    {
      id: 'release-on-loss',
      title: 'A lost auction returns its claim',
      detail:
        'A `release` exists and the settlement runs it when the auction result is `"lost"` — a win keeps the charge. The draft has no release at all, so losing auctions still consume the daily cap.',
      match: {
        python: {all: [/def release\(/, /def settle\(/, /"lost"/]},
        typescript: {all: [/async release\(/, /function settle\(/, /'lost'/]},
        go: {all: [/func \(c \*SpendCap\) Release\(/, /func settle\(/, /"lost"/]},
        scala: {all: [/def release\(/, /def settle\(/, /"lost"/]},
        cpp: {all: [/int release\(/, /void settle\(/, /"lost"/]},
      },
    },
    {
      id: 'release-clamped',
      title: 'The release is clamped and repeatable',
      detail:
        'The release runs its own Lua script that subtracts the claim and clamps a negative result back to 0 (`left < 0` after `DECRBY`). An unclamped release lets a duplicate loss report hand the bidder free spend.',
      match: {
        python: {all: [/RELEASE_SCRIPT/, /DECRBY/, /left < 0/]},
        typescript: {all: [/RELEASE_SCRIPT/, /DECRBY/, /left < 0/]},
        go: {all: [/releaseScript/, /DECRBY/, /left < 0/]},
        scala: {all: [/ReleaseScript/, /DECRBY/, /left < 0/]},
        cpp: {all: [/kReleaseScript/, /DECRBY/, /left < 0/]},
      },
    },
    {
      id: 'daily-window',
      title: 'The cap counter resets with the day',
      detail:
        'The key carries the day bucket (`spend:cap:{bidder}:{day}`) and the script sets its expiry with `EXPIREAT` at the next UTC midnight on the first write, so the counter is per day and cannot outlive its window.',
      match: {
        python: {all: [/SPEND_KEY_PREFIX/, /EXPIREAT/, /timedelta\(days=1\)/]},
        typescript: {all: [/SPEND_KEY_PREFIX/, /EXPIREAT/, /getUTCDate\(\) \+ 1/]},
        go: {all: [/spendKeyPrefix/, /EXPIREAT/, /Add\(24 \* time\.Hour\)/]},
        scala: {all: [/SpendKeyPrefix/, /EXPIREAT/, /plusDays\(1\)/]},
        cpp: {all: [/kSpendKeyPrefix/, /EXPIREAT/, /86400/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import redis as redis_client

logger = logging.getLogger("bidding")

CAP_CENTS_PER_DAY = 500_000


class SpendCap:
    """Keeps a bidder inside its daily spend cap."""

    def __init__(self, redis: "redis_client.Redis", cap_cents: int = CAP_CENTS_PER_DAY) -> None:
        self.redis = redis
        self.cap_cents = cap_cents

    def claim(self, bidder: str, cost_cents: int) -> int:
        # TODO: this draft reads the counter and decrements it in a second round trip, so two
        # concurrent bids both pass the last unit; the key has no day bucket, so the cap never
        # resets; and nothing ever returns a claim when the auction is lost, so a bidder that
        # loses most of its auctions drains the cap while winning almost nothing.
        key = f"spend:{bidder}"
        remaining = int(self.redis.get(key) or self.cap_cents)
        if remaining - cost_cents < 0:
            return 0
        self.redis.decrby(key, cost_cents)
        return cost_cents
`,
      solution: `import logging
from datetime import datetime, time, timedelta, timezone

import redis as redis_client

logger = logging.getLogger("bidding")

CAP_CENTS_PER_DAY = 500_000
SPEND_KEY_PREFIX = "spend:cap"

# Claim and cap in one round trip: 1 when the bidder has room for the cost, 0 when the cap would be
# exceeded. A client-side GET then DECRBY lets two concurrent bids both pass the last unit.
CLAIM_SCRIPT = """
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if current + cost > cap then
  return 0
end
redis.call('INCRBY', KEYS[1], cost)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIREAT', KEYS[1], ARGV[3])
end
return 1
"""

# A release repeats safely: subtracting below zero would hand the bidder free spend for the day.
RELEASE_SCRIPT = """
local left = tonumber(redis.call('DECRBY', KEYS[1], ARGV[1]))
if left < 0 then
  redis.call('SET', KEYS[1], 0)
  return 0
end
return left
"""


class SpendCap:
    """Keeps a bidder inside its daily spend cap, one atomic claim at a time."""

    def __init__(self, redis: "redis_client.Redis", cap_cents: int = CAP_CENTS_PER_DAY) -> None:
        self.redis = redis
        self.cap_cents = cap_cents

    def key(self, bidder: str, day: str) -> str:
        return f"{SPEND_KEY_PREFIX}:{bidder}:{day}"

    def claim(self, bidder: str, cost_cents: int) -> int:
        """Reserve cost_cents against the bidder's daily cap; 0 means the cap would be exceeded."""
        now = datetime.now(timezone.utc)
        day = now.strftime("%Y-%m-%d")
        expire_at = int(
            datetime.combine(now.date() + timedelta(days=1), time.min, tzinfo=timezone.utc).timestamp()
        )
        granted = self.redis.eval(CLAIM_SCRIPT, 1, self.key(bidder, day), cost_cents, self.cap_cents, expire_at)
        return cost_cents if granted == 1 else 0

    def release(self, bidder: str, claimed_cents: int) -> int:
        """Return a claim the auction did not use, clamped so the counter never goes negative."""
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        used = self.redis.eval(RELEASE_SCRIPT, 1, self.key(bidder, day), claimed_cents)
        logger.info("release bidder=%s cents=%d used=%s", bidder, claimed_cents, used)
        return int(used)


def settle(cap: SpendCap, bidder: str, claim_cents: int, outcome: str) -> None:
    """A lost auction returns its claim; a win keeps the spend charged."""
    if outcome == "lost":
        cap.release(bidder, claim_cents)
    logger.info("settle bidder=%s outcome=%s cents=%d", bidder, outcome, claim_cents)
`,
    },
    typescript: {
      starter: `/** Redis spend caps for one bidder's day. */
import Redis from 'ioredis';

const CAP_CENTS_PER_DAY = 500_000;

export class SpendCap {
  constructor(
    private readonly redis: Redis,
    private readonly capCents = CAP_CENTS_PER_DAY,
  ) {}

  async claim(bidder: string, costCents: number): Promise<number> {
    // TODO: this draft reads the counter and decrements it in a second round trip, so two
    // concurrent bids both pass the last unit; the key has no day bucket, so the cap never
    // resets; and nothing ever returns a claim when the auction is lost, so a bidder that loses
    // most of its auctions drains the cap while winning almost nothing.
    const key = \`spend:\${bidder}\`;
    const remaining = Number((await this.redis.get(key)) ?? this.capCents);
    if (remaining - costCents < 0) return 0;
    await this.redis.decrby(key, costCents);
    return costCents;
  }
}
`,
      solution: `/** Redis spend caps for one bidder's day: one atomic claim, one clamped release. */
import Redis from 'ioredis';

const CAP_CENTS_PER_DAY = 500_000;
const SPEND_KEY_PREFIX = 'spend:cap';

// Claim and cap in one round trip: 1 when the bidder has room for the cost, 0 when the cap would be
// exceeded. A client-side GET then DECRBY lets two concurrent bids both pass the last unit.
const CLAIM_SCRIPT = \`
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if current + cost > cap then
  return 0
end
redis.call('INCRBY', KEYS[1], cost)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIREAT', KEYS[1], ARGV[3])
end
return 1
\`;

// A release repeats safely: subtracting below zero would hand the bidder free spend for the day.
const RELEASE_SCRIPT = \`
local left = tonumber(redis.call('DECRBY', KEYS[1], ARGV[1]))
if left < 0 then
  redis.call('SET', KEYS[1], 0)
  return 0
end
return left
\`;

export interface CapClaim {
  bidder: string;
  cents: number;
}

export class SpendCap {
  constructor(
    private readonly redis: Redis,
    private readonly capCents = CAP_CENTS_PER_DAY,
  ) {}

  async claim(bidder: string, costCents: number): Promise<number> {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const key = \`\${SPEND_KEY_PREFIX}:\${bidder}:\${day}\`;
    const expireAt = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1000);
    const granted = await this.redis.eval(CLAIM_SCRIPT, 1, key, costCents, this.capCents, expireAt);
    return granted === 1 ? costCents : 0;
  }

  async release(bidder: string, claimedCents: number): Promise<number> {
    const day = new Date().toISOString().slice(0, 10);
    const key = \`\${SPEND_KEY_PREFIX}:\${bidder}:\${day}\`;
    const used = await this.redis.eval(RELEASE_SCRIPT, 1, key, claimedCents);
    return Number(used);
  }
}

export async function settle(
  cap: SpendCap,
  bidder: string,
  claimCents: number,
  outcome: string,
): Promise<void> {
  if (outcome === 'lost') await cap.release(bidder, claimCents);
  console.info({bidder, outcome, claimCents}, 'settle');
}
`,
    },
    go: {
      starter: `package state

import (
	"context"
	"log"

	"github.com/redis/go-redis/v9"
)

const capCentsPerDay = 500_000

type SpendCap struct {
	rdb      *redis.Client
	capCents int
}

func NewSpendCap(rdb *redis.Client) *SpendCap {
	return &SpendCap{rdb: rdb, capCents: capCentsPerDay}
}

func (c *SpendCap) Claim(ctx context.Context, bidder string, costCents int) int {
	// TODO: this draft reads the counter and decrements it in a second round trip, so two
	// concurrent bids both pass the last unit; the key has no day bucket, so the cap never
	// resets; and nothing ever returns a claim when the auction is lost, so a bidder that loses
	// most of its auctions drains the cap while winning almost nothing.
	key := "spend:" + bidder
	remaining, err := c.rdb.Get(ctx, key).Int()
	if err == redis.Nil {
		remaining = c.capCents
	}
	if remaining-costCents < 0 {
		log.Printf("cap exceeded bidder=%s", bidder)
		return 0
	}
	c.rdb.DecrBy(ctx, key, int64(costCents))
	return costCents
}
`,
      solution: `package state

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	capCentsPerDay = 500_000
	spendKeyPrefix = "spend:cap"
)

// Claim and cap in one round trip: 1 when the bidder has room for the cost, 0 when the cap would be
// exceeded. A client-side GET then DECRBY lets two concurrent bids both pass the last unit.
var claimScript = redis.NewScript(\`
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if current + cost > cap then
  return 0
end
redis.call('INCRBY', KEYS[1], cost)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIREAT', KEYS[1], ARGV[3])
end
return 1
\`)

// A release repeats safely: subtracting below zero would hand the bidder free spend for the day.
var releaseScript = redis.NewScript(\`
local left = tonumber(redis.call('DECRBY', KEYS[1], ARGV[1]))
if left < 0 then
  redis.call('SET', KEYS[1], 0)
  return 0
end
return left
\`)

type SpendCap struct {
	rdb      *redis.Client
	capCents int
}

func NewSpendCap(rdb *redis.Client) *SpendCap {
	return &SpendCap{rdb: rdb, capCents: capCentsPerDay}
}

func (c *SpendCap) key(bidder, day string) string {
	return fmt.Sprintf("%s:%s:%s", spendKeyPrefix, bidder, day)
}

// Claim reserves costCents against the bidder's daily cap; 0 means the cap would be exceeded.
func (c *SpendCap) Claim(ctx context.Context, bidder string, costCents int) int {
	now := time.Now().UTC()
	day := now.Format("2006-01-02")
	expireAt := now.Truncate(24 * time.Hour).Add(24 * time.Hour).Unix()
	granted, err := claimScript.Run(ctx, c.rdb, []string{c.key(bidder, day)}, costCents, c.capCents, expireAt).Int()
	if err != nil || granted != 1 {
		return 0
	}
	return costCents
}

// Release returns a claim the auction did not use, clamped at 0 so the counter cannot go negative.
func (c *SpendCap) Release(ctx context.Context, bidder string, claimedCents int) int {
	day := time.Now().UTC().Format("2006-01-02")
	used, err := releaseScript.Run(ctx, c.rdb, []string{c.key(bidder, day)}, claimedCents).Int()
	if err != nil {
		log.Printf("release failed bidder=%s err=%v", bidder, err)
		return 0
	}
	return used
}

func settle(cap *SpendCap, ctx context.Context, bidder string, claimCents int, outcome string) {
	if outcome == "lost" {
		cap.Release(ctx, bidder, claimCents)
	}
	log.Printf("settle bidder=%s outcome=%s cents=%d", bidder, outcome, claimCents)
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.Jedis

object SpendCap {
  val CapCentsPerDay = 500_000
}

class SpendCap(redis: Jedis, capCents: Int = SpendCap.CapCentsPerDay) {

  def claim(bidder: String, costCents: Int): Int = {
    // TODO: this draft reads the counter and decrements it in a second round trip, so two
    // concurrent bids both pass the last unit; the key has no day bucket, so the cap never
    // resets; and nothing ever returns a claim when the auction is lost, so a bidder that loses
    // most of its auctions drains the cap while winning almost nothing.
    val key = s"spend:$bidder"
    val remaining = Option(redis.get(key)).map(_.toInt).getOrElse(capCents)
    if (remaining - costCents < 0) 0
    else {
      redis.decrBy(key, costCents.toLong)
      costCents
    }
  }
}
`,
      solution: `import java.time.{Instant, LocalDate, ZoneOffset}
import java.util

import redis.clients.jedis.Jedis

object SpendCap {
  val CapCentsPerDay = 500_000
  val SpendKeyPrefix = "spend:cap"

  // Claim and cap in one round trip: 1 when the bidder has room for the cost, 0 when the cap would
  // be exceeded. A client-side GET then DECRBY lets two concurrent bids both pass the last unit.
  val ClaimScript =
    """
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if current + cost > cap then
  return 0
end
redis.call('INCRBY', KEYS[1], cost)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIREAT', KEYS[1], ARGV[3])
end
return 1
"""

  // A release repeats safely: subtracting below zero would hand the bidder free spend for the day.
  val ReleaseScript =
    """
local left = tonumber(redis.call('DECRBY', KEYS[1], ARGV[1]))
if left < 0 then
  redis.call('SET', KEYS[1], 0)
  return 0
end
return left
"""
}

class SpendCap(redis: Jedis, capCents: Int = SpendCap.CapCentsPerDay) {

  def key(bidder: String, day: String): String = s"$SpendKeyPrefix:$bidder:$day"

  /** Reserve costCents against the bidder's daily cap; 0 means the cap would be exceeded. */
  def claim(bidder: String, costCents: Int): Int = {
    val today = LocalDate.ofInstant(Instant.now(), ZoneOffset.UTC)
    val expireAt = today.plusDays(1).atStartOfDay(ZoneOffset.UTC).toEpochSecond
    val granted = redis
      .eval(
        SpendCap.ClaimScript,
        util.List.of(key(bidder, today.toString)),
        util.List.of(costCents.toString, capCents.toString, expireAt.toString)
      )
      .asInstanceOf[java.lang.Long]
      .longValue()
    if (granted == 1L) costCents else 0
  }

  /** Return a claim the auction did not use, clamped at 0 so the counter cannot go negative. */
  def release(bidder: String, claimedCents: Int): Int = {
    val day = LocalDate.ofInstant(Instant.now(), ZoneOffset.UTC).toString
    redis
      .eval(SpendCap.ReleaseScript, util.List.of(key(bidder, day)), util.List.of(claimedCents.toString))
      .asInstanceOf[java.lang.Long]
      .longValue()
      .toInt
  }
}

def settle(cap: SpendCap, bidder: String, claimCents: Int, outcome: String): Unit = {
  if (outcome == "lost") cap.release(bidder, claimCents)
  println(s"settle bidder=$bidder outcome=$outcome cents=$claimCents")
}
`,
    },
    cpp: {
      starter: `#include <redis-plus-plus/redis.h>

#include <iostream>
#include <string>

constexpr int kCapCentsPerDay = 500000;

class SpendCap {
 public:
  explicit SpendCap(sw::redis::Redis& redis, int capCents = kCapCentsPerDay) : redis_(redis), capCents_(capCents) {}

  int claim(const std::string& bidder, int costCents) {
    // TODO: this draft reads the counter and decrements it in a second round trip, so two
    // concurrent bids both pass the last unit; the key has no day bucket, so the cap never
    // resets; and nothing ever returns a claim when the auction is lost, so a bidder that loses
    // most of its auctions drains the cap while winning almost nothing.
    const std::string key = "spend:" + bidder;
    const auto stored = redis_.get(key);
    const int remaining = stored ? std::stoi(*stored) : capCents_;
    if (remaining - costCents < 0) return 0;
    redis_.decrby(key, static_cast<long long>(costCents));
    return costCents;
  }

 private:
  sw::redis::Redis& redis_;
  int capCents_;
};
`,
      solution: `#include <redis-plus-plus/redis.h>

#include <chrono>
#include <ctime>
#include <iostream>
#include <string>
#include <vector>

constexpr int kCapCentsPerDay = 500000;
const std::string kSpendKeyPrefix = "spend:cap";

// Claim and cap in one round trip: 1 when the bidder has room for the cost, 0 when the cap would be
// exceeded. A client-side GET then DECRBY lets two concurrent bids both pass the last unit.
const std::string kClaimScript = R"(
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local cost = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if current + cost > cap then
  return 0
end
redis.call('INCRBY', KEYS[1], cost)
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIREAT', KEYS[1], ARGV[3])
end
return 1
)";

// A release repeats safely: subtracting below zero would hand the bidder free spend for the day.
const std::string kReleaseScript = R"(
local left = tonumber(redis.call('DECRBY', KEYS[1], ARGV[1]))
if left < 0 then
  redis.call('SET', KEYS[1], 0)
  return 0
end
return left
)";

class SpendCap {
 public:
  explicit SpendCap(sw::redis::Redis& redis, int capCents = kCapCentsPerDay) : redis_(redis), capCents_(capCents) {}

  std::string key(const std::string& bidder, const std::string& day) const {
    return kSpendKeyPrefix + ":" + bidder + ":" + day;
  }

  /** Reserve costCents against the bidder's daily cap; 0 means the cap would be exceeded. */
  int claim(const std::string& bidder, int costCents) {
    const auto now = std::chrono::system_clock::now();
    const std::time_t nowSecs = std::chrono::system_clock::to_time_t(now);
    std::tm utc{};
    gmtime_r(&nowSecs, &utc);
    char day[11];
    std::strftime(day, sizeof(day), "%Y-%m-%d", &utc);
    const long expireAt = static_cast<long>(nowSecs) + 86400 - (static_cast<long>(nowSecs) % 86400);
    const auto granted = redis_.eval<int>(
        kClaimScript,
        {key(bidder, day)},
        {std::to_string(costCents), std::to_string(capCents_), std::to_string(expireAt)});
    return granted == 1 ? costCents : 0;
  }

  /** Return a claim the auction did not use, clamped at 0 so the counter cannot go negative. */
  int release(const std::string& bidder, int claimedCents) {
    const std::time_t nowSecs = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
    std::tm utc{};
    gmtime_r(&nowSecs, &utc);
    char day[11];
    std::strftime(day, sizeof(day), "%Y-%m-%d", &utc);
    return redis_.eval<int>(kReleaseScript, {key(bidder, day)}, {std::to_string(claimedCents)});
  }

 private:
  sw::redis::Redis& redis_;
  int capCents_;
};

void settle(SpendCap& cap, const std::string& bidder, int claimCents, const std::string& outcome) {
  if (outcome == "lost") cap.release(bidder, claimCents);
  std::cerr << "settle bidder=" << bidder << " outcome=" << outcome << " cents=" << claimCents << "\\n";
}
`,
    },
  },
  hints: [
    'Write the claim as one script: read the usage, compare, increment — all inside `EVAL` / `Script.Run`. Two round trips from the client are two opportunities for another bidder to slip between the check and the write.',
    'Have the claim return the amount it reserved (`cost_cents`, or the granted value) instead of a bool, so `release` can subtract exactly what was taken and a double release is visible.',
    'Daily means a bucket: `spend:cap:{bidder}:{day}` with `EXPIREAT` at the next UTC midnight, set on the first write of the window. A counter without a day key never resets, and a counter without a TTL outlives the bidder.',
  ],
  debrief: `The interviewer is testing whether you can review a generated spend limiter under concurrency and
whether you understand that a cap is only as good as its accounting. The draft reads fine because the
demo bids once, wins, and never reloads the counter.

Three defects are being checked. Atomicity: a client-side read then write cannot hold a cap, because
the window between them is where the second bid lives — the guard belongs inside the script. Release:
the cap is charged when the bid is placed and must be returned when the auction is lost; without it,
a bidder that loses most auctions burns its whole budget paying for nothing, which is exactly the
"healthy dashboard, no wins" symptom in the briefing. Window: the counter is per bidder per day, so
it needs both the day in the key and an expiry at the window's end.

Real bidders go further: they hold the claim as a reservation with a settlement id, reconcile
reservations against wins in a background job, and cap on both a daily and a pacing budget so a
single cheap auction cannot consume the whole morning.`,
};
