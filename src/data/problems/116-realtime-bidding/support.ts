/**
 * Hand-written support modules the realtime-bidding steps import but no step builds: the `rtb`
 * package. `rtb.deadline` is the auction budget (`Deadline.start(budget_ms)`, `remaining_ms()`);
 * `rtb.pricing` is step 3's `quote_bid` as the bid endpoint uses it (tiered feature calls over gRPC,
 * the model score when it fits, a degraded bid at the floor otherwise); `rtb.spend` is step 2's
 * daily spend cap (`claim`, `settle`) with the helpers the other steps read it through; `rtb.outbox`
 * is where a bid event goes when the broker will not take it. The five languages keep the same
 * keys, so a harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'rtb/__init__.py': '',
  'rtb/deadline.py': `"""
The auction budget (provided): Deadline.start(budget_ms) starts the clock once, at the top of the
request; remaining_ms() is what is left of it, never below 0. Every stage of a bid is handed the
same Deadline, so a slow stage shortens the ones after it.
"""
import time


class Deadline:
    def __init__(self, budget_ms: int) -> None:
        self.budget_ms = budget_ms
        self.started = time.monotonic()

    @classmethod
    def start(cls, budget_ms: int) -> "Deadline":
        return cls(budget_ms)

    def remaining_ms(self) -> int:
        elapsed_ms = round((time.monotonic() - self.started) * 1000)
        return max(0, self.budget_ms - elapsed_ms)
`,
  'rtb/pricing.py': `"""
Bid pricing over the feature service and the model scorer (provided; step 3 builds the same
quote_bid). Each feature tier gets its own slice of the auction budget, clamped to what is left:
identity IDENTITY_MS, contextual CONTEXT_MS. A tier that fails or runs out of time degrades the
quote to a bid at the floor; the model is asked only while MODEL_MIN_MS is still left. Nothing is
retried inside an auction.
"""
from dataclasses import dataclass

import grpc

import realtime_bidding_pb2 as pb
import realtime_bidding_pb2_grpc as pb_grpc
from rtb.deadline import Deadline

IDENTITY_MS = 30
CONTEXT_MS = 50
MODEL_MIN_MS = 20

features = pb_grpc.FeaturesStub(grpc.insecure_channel("features:9000"))
scorer = pb_grpc.ScorerStub(grpc.insecure_channel("scorer:9000"))


@dataclass
class Quote:
    bid_cents: int
    degraded: bool
    reason: str


def tier_ms(deadline: Deadline, slice_ms: int) -> int:
    """A tier's budget: its own slice, or what is left of the auction when that is less."""
    return min(slice_ms, deadline.remaining_ms())


def _ask(method, request, budget_ms: int):
    if budget_ms <= 0:
        return None
    try:
        return method(request, timeout=budget_ms / 1000)
    except grpc.RpcError:
        return None


def quote_bid(user_hash: str, auction_id: str, floor_cents: int, deadline: Deadline) -> Quote:
    """The price to bid for this impression, inside what is left of the auction's budget."""
    identity = _ask(features.Identity, pb.IdentityRequest(user_hash=user_hash), tier_ms(deadline, IDENTITY_MS))
    if identity is None:
        return Quote(floor_cents, True, "identity_unavailable")
    context = _ask(features.Contextual, pb.ContextRequest(auction_id=auction_id), tier_ms(deadline, CONTEXT_MS))
    if context is None:
        return Quote(floor_cents, True, "context_unavailable")
    if deadline.remaining_ms() < MODEL_MIN_MS:
        return Quote(floor_cents, True, "model_skipped")
    request = pb.ScoreRequest(user_hash=user_hash, auction_id=auction_id, segment=identity.segment, category=context.category)
    score = _ask(scorer.Score, request, deadline.remaining_ms())
    if score is None:
        return Quote(floor_cents, True, "model_unavailable")
    return Quote(score.value_cents, False, "")
`,
  'rtb/spend.py': `"""
The daily spend cap (provided; step 2 builds claim and settle): cap:{bidder} is the bidder's daily
cap in cents, spend:{bidder}:{yyyymmdd} what it has claimed that UTC day (kept TTL_S, two days),
and the hash claim:{bidder}:{auction_id} (spend_key, cents) the claim one auction holds until the
exchange reports the result. claim reserves cents in one Lua script and refuses what the cap
cannot cover; settle keeps a won auction's charge and gives a lost one's back, once.
"""
import time

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

TTL_S = 2 * 86400

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

SETTLE_LUA = """
local spend_key = redis.call('HGET', KEYS[1], 'spend_key')
if not spend_key then return 0 end
local cents = tonumber(redis.call('HGET', KEYS[1], 'cents'))
redis.call('DEL', KEYS[1])
if ARGV[1] == '1' then return 0 end
redis.call('DECRBY', spend_key, cents)
return cents
"""

_claim = r.register_script(CLAIM_LUA)
_settle = r.register_script(SETTLE_LUA)


def today() -> str:
    """The current UTC day as yyyymmdd."""
    return time.strftime("%Y%m%d", time.gmtime())


def cap_key(bidder: str) -> str:
    return f"cap:{bidder}"


def spend_key(bidder: str, day: str) -> str:
    return f"spend:{bidder}:{day}"


def claim_key(bidder: str, auction_id: str) -> str:
    return f"claim:{bidder}:{auction_id}"


def set_cap(bidder: str, cents: int) -> None:
    r.set(cap_key(bidder), cents)


def cap_of(bidder: str) -> int:
    """The bidder's daily cap in cents; 0 when none is set."""
    return int(r.get(cap_key(bidder)) or 0)


def spent(bidder: str, day: str) -> int:
    """What the bidder has claimed on day (yyyymmdd), in cents."""
    return int(r.get(spend_key(bidder, day)) or 0)


def claim(bidder: str, auction_id: str, cents: int) -> bool:
    """Reserve cents of today's cap for the auction; False when the cap cannot cover them."""
    keys = [spend_key(bidder, today()), claim_key(bidder, auction_id), cap_key(bidder)]
    return _claim(keys=keys, args=[cents, TTL_S]) == 1


def settle(bidder: str, auction_id: str, won: bool) -> int:
    """Apply the exchange's result to the auction's claim; the cents given back to the cap."""
    return int(_settle(keys=[claim_key(bidder, auction_id)], args=["1" if won else "0"]))
`,
  'rtb/outbox.py': `"""
The bid-event outbox (provided): insert(event, reason) appends {"event": …, "reason": …} as JSON
to the Redis list outbox:bid.event; a relay produces the rows later. rows() reads them back.
"""
import json

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)

KEY = "outbox:bid.event"


def insert(event: dict, reason: str) -> None:
    r.rpush(KEY, json.dumps({"event": event, "reason": reason}))


def rows() -> list[dict]:
    return [json.loads(row) for row in r.lrange(KEY, 0, -1)]
`,
};

export const supportModulesTs: Record<string, string> = {
  'rtb/deadline.ts': `/**
 * The auction budget (provided): Deadline.start(budgetMs) starts the clock once, at the top of the
 * request; remainingMs() is what is left of it, never below 0. Every stage of a bid is handed the
 * same Deadline, so a slow stage shortens the ones after it.
 */
export class Deadline {
  private constructor(
    readonly budgetMs: number,
    private readonly started: number,
  ) {}

  static start(budgetMs: number): Deadline {
    return new Deadline(budgetMs, Date.now());
  }

  remainingMs(): number {
    return Math.max(0, this.budgetMs - Math.round(Date.now() - this.started));
  }
}
`,
  'rtb/pricing.ts': `/**
 * Bid pricing over the feature service and the model scorer (provided; step 3 builds the same
 * quoteBid). Each feature tier gets its own slice of the auction budget, clamped to what is left:
 * identity IDENTITY_MS, contextual CONTEXT_MS. A tier that fails or runs out of time degrades the
 * quote to a bid at the floor; the model is asked only while MODEL_MIN_MS is still left. Nothing is
 * retried inside an auction.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Deadline} from 'rtb/deadline';

export const IDENTITY_MS = 30;
export const CONTEXT_MS = 50;
export const MODEL_MIN_MS = 20;

export interface Quote {
  bid_cents: number;
  degraded: boolean;
  reason: string;
}

type Unary<Req, Res> = (request: Req, metadata: grpc.Metadata, options: grpc.CallOptions) => Promise<Res>;

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('realtime_bidding.proto')) as unknown as {
  rtbfeatures: {Features: grpc.ServiceClientConstructor; Scorer: grpc.ServiceClientConstructor};
};
const features = new pkg.rtbfeatures.Features('features:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Identity: Unary<{user_hash: string}, {segment: string; frequency: number}>;
  Contextual: Unary<{auction_id: string}, {category: string; viewability_pct: number}>;
};
const scorer = new pkg.rtbfeatures.Scorer('scorer:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Score: Unary<{user_hash: string; auction_id: string; segment: string; category: string}, {value_cents: number | string}>;
};

/** A tier's budget: its own slice, or what is left of the auction when that is less. */
export const tierMs = (deadline: Deadline, sliceMs: number): number => Math.min(sliceMs, deadline.remainingMs());

async function ask<T>(budgetMs: number, call: (options: grpc.CallOptions) => Promise<T>): Promise<T | null> {
  if (budgetMs <= 0) return null;
  try {
    return await call({deadline: Date.now() + budgetMs});
  } catch {
    return null;
  }
}

/** The price to bid for this impression, inside what is left of the auction's budget. */
export async function quoteBid(userHash: string, auctionId: string, floorCents: number, deadline: Deadline): Promise<Quote> {
  const identity = await ask(tierMs(deadline, IDENTITY_MS), options => features.Identity({user_hash: userHash}, new grpc.Metadata(), options));
  if (identity === null) return {bid_cents: floorCents, degraded: true, reason: 'identity_unavailable'};
  const context = await ask(tierMs(deadline, CONTEXT_MS), options => features.Contextual({auction_id: auctionId}, new grpc.Metadata(), options));
  if (context === null) return {bid_cents: floorCents, degraded: true, reason: 'context_unavailable'};
  if (deadline.remainingMs() < MODEL_MIN_MS) return {bid_cents: floorCents, degraded: true, reason: 'model_skipped'};
  const request = {user_hash: userHash, auction_id: auctionId, segment: identity.segment, category: context.category};
  const score = await ask(deadline.remainingMs(), options => scorer.Score(request, new grpc.Metadata(), options));
  if (score === null) return {bid_cents: floorCents, degraded: true, reason: 'model_unavailable'};
  return {bid_cents: Number(score.value_cents), degraded: false, reason: ''};
}
`,
  'rtb/spend.ts': `/**
 * The daily spend cap (provided; step 2 builds claim and settle): cap:{bidder} is the bidder's daily
 * cap in cents, spend:{bidder}:{yyyymmdd} what it has claimed that UTC day (kept TTL_S, two days),
 * and the hash claim:{bidder}:{auction_id} (spend_key, cents) the claim one auction holds until the
 * exchange reports the result. claim reserves cents in one Lua script and refuses what the cap
 * cannot cover; settle keeps a won auction's charge and gives a lost one's back, once.
 */
import Redis from 'ioredis';

export const TTL_S = 2 * 86400;

export const CLAIM_LUA = \`
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

export const SETTLE_LUA = \`
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

/** The current UTC day as yyyymmdd. */
export const today = (): string => new Date(Date.now()).toISOString().slice(0, 10).replace(/-/g, '');

export const capKey = (bidder: string): string => \`cap:\${bidder}\`;
export const spendKey = (bidder: string, day: string): string => \`spend:\${bidder}:\${day}\`;
export const claimKey = (bidder: string, auctionId: string): string => \`claim:\${bidder}:\${auctionId}\`;

export async function setCap(bidder: string, cents: number): Promise<void> {
  await redis.set(capKey(bidder), cents);
}

/** The bidder's daily cap in cents; 0 when none is set. */
export async function capOf(bidder: string): Promise<number> {
  return Number((await redis.get(capKey(bidder))) ?? 0);
}

/** What the bidder has claimed on day (yyyymmdd), in cents. */
export async function spent(bidder: string, day: string): Promise<number> {
  return Number((await redis.get(spendKey(bidder, day))) ?? 0);
}

/** Reserve cents of today's cap for the auction; false when the cap cannot cover them. */
export async function claim(bidder: string, auctionId: string, cents: number): Promise<boolean> {
  return (await redis.claimSpend(spendKey(bidder, today()), claimKey(bidder, auctionId), capKey(bidder), cents, TTL_S)) === 1;
}

/** Apply the exchange's result to the auction's claim; the cents given back to the cap. */
export async function settle(bidder: string, auctionId: string, won: boolean): Promise<number> {
  return Number(await redis.settleClaim(claimKey(bidder, auctionId), won ? '1' : '0'));
}
`,
  'rtb/outbox.ts': `/**
 * The bid-event outbox (provided): insert(event, reason) appends {"event": …, "reason": …} as JSON
 * to the Redis list outbox:bid.event; a relay produces the rows later. rows() reads them back.
 */
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const KEY = 'outbox:bid.event';

export async function insert(event: Record<string, unknown>, reason: string): Promise<void> {
  await redis.rpush(KEY, JSON.stringify({event, reason}));
}

export async function rows(): Promise<{event: Record<string, unknown>; reason: string}[]> {
  return (await redis.lrange(KEY, 0, -1)).map(row => JSON.parse(row));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'rtb/deadline/deadline.go': `// Package deadline is the auction budget (provided): Start(budgetMs) starts the clock once, at the
// top of the request; RemainingMs() is what is left of it, never below 0. Every stage of a bid is
// handed the same Deadline, so a slow stage shortens the ones after it.
package deadline

import "time"

// Deadline is one auction's budget.
type Deadline struct {
	budget  time.Duration
	started time.Time
}

// Start starts an auction budget of budgetMs milliseconds now.
func Start(budgetMs int64) *Deadline {
	return &Deadline{budget: time.Duration(budgetMs) * time.Millisecond, started: time.Now()}
}

// RemainingMs is what is left of the budget, in milliseconds, never below 0.
func (d *Deadline) RemainingMs() int64 {
	left := d.budget - time.Since(d.started)
	if left < 0 {
		return 0
	}
	return left.Milliseconds()
}
`,
  'rtb/pricing/pricing.go': `// Package pricing prices a bid over the feature service and the model scorer (provided; step 3
// builds the same quoteBid). Each feature tier gets its own slice of the auction budget, clamped to
// what is left: identity IdentityMs, contextual ContextMs. A tier that fails or runs out of time
// degrades the quote to a bid at the floor; the model is asked only while ModelMinMs is still
// left. Nothing is retried inside an auction.
package pricing

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"rtb/deadline"
	pb "rtb/gen/realtime_bidding"
)

const (
	IdentityMs = 30
	ContextMs  = 50
	ModelMinMs = 20
)

// Quote is the price to bid and whether it came from a degraded path.
type Quote struct {
	BidCents int64  \`json:"bid_cents"\`
	Degraded bool   \`json:"degraded"\`
	Reason   string \`json:"reason"\`
}

var (
	featuresConn, _ = grpc.NewClient("features:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	scorerConn, _   = grpc.NewClient("scorer:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	features        = pb.NewFeaturesClient(featuresConn)
	scorer          = pb.NewScorerClient(scorerConn)
)

// TierMs is a tier's budget: its own slice, or what is left of the auction when that is less.
func TierMs(d *deadline.Deadline, sliceMs int64) int64 {
	if left := d.RemainingMs(); left < sliceMs {
		return left
	}
	return sliceMs
}

func within(ctx context.Context, budgetMs int64) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, time.Duration(budgetMs)*time.Millisecond)
}

// QuoteBid is the price to bid for this impression, inside what is left of the auction's budget.
func QuoteBid(ctx context.Context, userHash, auctionID string, floorCents int64, d *deadline.Deadline) Quote {
	budget := TierMs(d, IdentityMs)
	if budget <= 0 {
		return Quote{floorCents, true, "identity_unavailable"}
	}
	callCtx, cancel := within(ctx, budget)
	identity, err := features.Identity(callCtx, &pb.IdentityRequest{UserHash: userHash})
	cancel()
	if err != nil {
		return Quote{floorCents, true, "identity_unavailable"}
	}
	budget = TierMs(d, ContextMs)
	if budget <= 0 {
		return Quote{floorCents, true, "context_unavailable"}
	}
	callCtx, cancel = within(ctx, budget)
	contextual, err := features.Contextual(callCtx, &pb.ContextRequest{AuctionId: auctionID})
	cancel()
	if err != nil {
		return Quote{floorCents, true, "context_unavailable"}
	}
	if d.RemainingMs() < ModelMinMs {
		return Quote{floorCents, true, "model_skipped"}
	}
	callCtx, cancel = within(ctx, d.RemainingMs())
	defer cancel()
	score, err := scorer.Score(callCtx, &pb.ScoreRequest{UserHash: userHash, AuctionId: auctionID, Segment: identity.GetSegment(), Category: contextual.GetCategory()})
	if err != nil {
		return Quote{floorCents, true, "model_unavailable"}
	}
	return Quote{score.GetValueCents(), false, ""}
}
`,
  'rtb/spend/spend.go': `// Package spend is the daily spend cap (provided; step 2 builds claim and settle): cap:{bidder} is
// the bidder's daily cap in cents, spend:{bidder}:{yyyymmdd} what it has claimed that UTC day (kept
// TTLSeconds, two days), and the hash claim:{bidder}:{auction_id} (spend_key, cents) the claim one
// auction holds until the exchange reports the result. Claim reserves cents in one Lua script and
// refuses what the cap cannot cover; Settle keeps a won auction's charge and gives a lost one's
// back, once.
package spend

import (
	"context"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// TTLSeconds is how long a day's counter and a claim are kept: two days.
const TTLSeconds = 2 * 86400

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// ClaimScript reserves ARGV[1] cents on KEYS[1] for the claim KEYS[2] when the cap KEYS[3] covers them.
var ClaimScript = redis.NewScript(\`
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

// SettleScript removes the claim KEYS[1] and, unless ARGV[1] is "1" (won), gives its cents back.
var SettleScript = redis.NewScript(\`
local spend_key = redis.call('HGET', KEYS[1], 'spend_key')
if not spend_key then return 0 end
local cents = tonumber(redis.call('HGET', KEYS[1], 'cents'))
redis.call('DEL', KEYS[1])
if ARGV[1] == '1' then return 0 end
redis.call('DECRBY', spend_key, cents)
return cents
\`)

// Today is the current UTC day as yyyymmdd.
func Today() string { return time.Now().UTC().Format("20060102") }

// CapKey holds the bidder's daily cap in cents.
func CapKey(bidder string) string { return "cap:" + bidder }

// SpendKey holds what the bidder claimed on day.
func SpendKey(bidder, day string) string { return "spend:" + bidder + ":" + day }

// ClaimKey is the claim one auction holds.
func ClaimKey(bidder, auctionID string) string { return "claim:" + bidder + ":" + auctionID }

// SetCap sets the bidder's daily cap.
func SetCap(ctx context.Context, bidder string, cents int64) error {
	return rdb.Set(ctx, CapKey(bidder), cents, 0).Err()
}

// CapOf is the bidder's daily cap in cents; 0 when none is set.
func CapOf(ctx context.Context, bidder string) int64 {
	n, _ := strconv.ParseInt(rdb.Get(ctx, CapKey(bidder)).Val(), 10, 64)
	return n
}

// Spent is what the bidder has claimed on day (yyyymmdd), in cents.
func Spent(ctx context.Context, bidder, day string) int64 {
	n, _ := strconv.ParseInt(rdb.Get(ctx, SpendKey(bidder, day)).Val(), 10, 64)
	return n
}

// Claim reserves cents of today's cap for the auction; false when the cap cannot cover them.
func Claim(ctx context.Context, bidder, auctionID string, cents int64) (bool, error) {
	keys := []string{SpendKey(bidder, Today()), ClaimKey(bidder, auctionID), CapKey(bidder)}
	n, err := ClaimScript.Run(ctx, rdb, keys, cents, TTLSeconds).Int64()
	return n == 1, err
}

// Settle applies the exchange's result to the auction's claim; the cents given back to the cap.
func Settle(ctx context.Context, bidder, auctionID string, won bool) (int64, error) {
	flag := "0"
	if won {
		flag = "1"
	}
	return SettleScript.Run(ctx, rdb, []string{ClaimKey(bidder, auctionID)}, flag).Int64()
}
`,
  'rtb/outbox/outbox.go': `// Package outbox is the bid-event outbox (provided): Insert appends {"event": …, "reason": …} as
// JSON to the Redis list outbox:bid.event; a relay produces the rows later.
package outbox

import (
	"context"
	"encoding/json"

	"github.com/redis/go-redis/v9"
)

// Key is the Redis list the relay drains.
const Key = "outbox:bid.event"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Insert keeps event with the reason the broker did not take it.
func Insert(ctx context.Context, event any, reason string) error {
	row, err := json.Marshal(map[string]any{"event": event, "reason": reason})
	if err != nil {
		return err
	}
	return rdb.RPush(ctx, Key, row).Err()
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'rtb/deadline.h': `// The auction budget (provided): Deadline::start(budget_ms) starts the clock once, at the top of the
// request; remainingMs() is what is left of it, never below 0. Every stage of a bid is handed the
// same Deadline, so a slow stage shortens the ones after it.
#pragma once

#include <chrono>

namespace rtb {

class Deadline {
 public:
  static Deadline start(long budget_ms) { return Deadline(budget_ms); }

  long remainingMs() const {
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - started_);
    const long left = budget_ms_ - static_cast<long>(elapsed.count());
    return left > 0 ? left : 0;
  }

 private:
  explicit Deadline(long budget_ms) : budget_ms_(budget_ms), started_(std::chrono::steady_clock::now()) {}
  long budget_ms_;
  std::chrono::steady_clock::time_point started_;
};

}  // namespace rtb
`,
  'rtb/pricing.h': `// Bid pricing over the feature service and the model scorer (provided; step 3 builds the same
// quoteBid). Each feature tier gets its own slice of the auction budget, clamped to what is left:
// identity kIdentityMs, contextual kContextMs. A tier that fails or runs out of time degrades the
// quote to a bid at the floor; the model is asked only while kModelMinMs is still left. Nothing is
// retried inside an auction.
#pragma once

#include <grpcpp/grpcpp.h>

#include <chrono>
#include <memory>
#include <string>

#include "realtime_bidding.grpc.pb.h"
#include "rtb/deadline.h"

namespace rtb::pricing {

constexpr long kIdentityMs = 30;
constexpr long kContextMs = 50;
constexpr long kModelMinMs = 20;

struct Quote {
  long bid_cents = 0;
  bool degraded = false;
  std::string reason;
};

inline rtbfeatures::Features::Stub& features() {
  static auto stub = rtbfeatures::Features::NewStub(grpc::CreateChannel("features:9000", grpc::InsecureChannelCredentials()));
  return *stub;
}

inline rtbfeatures::Scorer::Stub& scorer() {
  static auto stub = rtbfeatures::Scorer::NewStub(grpc::CreateChannel("scorer:9000", grpc::InsecureChannelCredentials()));
  return *stub;
}

// A tier's budget: its own slice, or what is left of the auction when that is less.
inline long tierMs(const Deadline& deadline, long slice_ms) {
  const long left = deadline.remainingMs();
  return left < slice_ms ? left : slice_ms;
}

inline void within(grpc::ClientContext& ctx, long budget_ms) {
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(budget_ms));
}

// The price to bid for this impression, inside what is left of the auction's budget.
inline Quote quoteBid(const std::string& user_hash, const std::string& auction_id, long floor_cents, const Deadline& deadline) {
  long budget = tierMs(deadline, kIdentityMs);
  if (budget <= 0) return {floor_cents, true, "identity_unavailable"};
  rtbfeatures::IdentityFeatures identity;
  {
    grpc::ClientContext ctx;
    within(ctx, budget);
    rtbfeatures::IdentityRequest request;
    request.set_user_hash(user_hash);
    if (!features().Identity(&ctx, request, &identity).ok()) return {floor_cents, true, "identity_unavailable"};
  }
  budget = tierMs(deadline, kContextMs);
  if (budget <= 0) return {floor_cents, true, "context_unavailable"};
  rtbfeatures::ContextFeatures context;
  {
    grpc::ClientContext ctx;
    within(ctx, budget);
    rtbfeatures::ContextRequest request;
    request.set_auction_id(auction_id);
    if (!features().Contextual(&ctx, request, &context).ok()) return {floor_cents, true, "context_unavailable"};
  }
  if (deadline.remainingMs() < kModelMinMs) return {floor_cents, true, "model_skipped"};
  grpc::ClientContext ctx;
  within(ctx, deadline.remainingMs());
  rtbfeatures::ScoreRequest request;
  request.set_user_hash(user_hash);
  request.set_auction_id(auction_id);
  request.set_segment(identity.segment());
  request.set_category(context.category());
  rtbfeatures::ScoreReply score;
  if (!scorer().Score(&ctx, request, &score).ok()) return {floor_cents, true, "model_unavailable"};
  return {static_cast<long>(score.value_cents()), false, ""};
}

}  // namespace rtb::pricing
`,
  'rtb/spend.h': `// The daily spend cap (provided; step 2 builds claim and settle): cap:{bidder} is the bidder's daily
// cap in cents, spend:{bidder}:{yyyymmdd} what it has claimed that UTC day (kept kTtlSeconds, two
// days), and the hash claim:{bidder}:{auction_id} (spend_key, cents) the claim one auction holds
// until the exchange reports the result. claim reserves cents in one Lua script and refuses what
// the cap cannot cover; settle keeps a won auction's charge and gives a lost one's back, once.
#pragma once

#include <sw/redis++/redis++.h>

#include <chrono>
#include <ctime>
#include <string>

namespace rtb::spend {

constexpr long kTtlSeconds = 2 * 86400;

inline const std::string kClaimLua = R"lua(
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

inline const std::string kSettleLua = R"lua(
local spend_key = redis.call('HGET', KEYS[1], 'spend_key')
if not spend_key then return 0 end
local cents = tonumber(redis.call('HGET', KEYS[1], 'cents'))
redis.call('DEL', KEYS[1])
if ARGV[1] == '1' then return 0 end
redis.call('DECRBY', spend_key, cents)
return cents
)lua";

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

// The current UTC day as yyyymmdd.
inline std::string today() {
  const std::time_t now = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  std::tm utc{};
  gmtime_r(&now, &utc);
  char out[9];
  std::strftime(out, sizeof out, "%Y%m%d", &utc);
  return out;
}

inline std::string capKey(const std::string& bidder) { return "cap:" + bidder; }
inline std::string spendKey(const std::string& bidder, const std::string& day) { return "spend:" + bidder + ":" + day; }
inline std::string claimKey(const std::string& bidder, const std::string& auction_id) { return "claim:" + bidder + ":" + auction_id; }

inline void setCap(const std::string& bidder, long cents) { redis().set(capKey(bidder), std::to_string(cents)); }

// The bidder's daily cap in cents; 0 when none is set.
inline long capOf(const std::string& bidder) {
  const auto raw = redis().get(capKey(bidder));
  return raw ? std::stol(*raw) : 0;
}

// What the bidder has claimed on day (yyyymmdd), in cents.
inline long spent(const std::string& bidder, const std::string& day) {
  const auto raw = redis().get(spendKey(bidder, day));
  return raw ? std::stol(*raw) : 0;
}

// Reserve cents of today's cap for the auction; false when the cap cannot cover them.
inline bool claim(const std::string& bidder, const std::string& auction_id, long cents) {
  const auto keys = {spendKey(bidder, today()), claimKey(bidder, auction_id), capKey(bidder)};
  const auto args = {std::to_string(cents), std::to_string(kTtlSeconds)};
  return redis().eval<long long>(kClaimLua, keys.begin(), keys.end(), args.begin(), args.end()) == 1;
}

// Apply the exchange's result to the auction's claim; the cents given back to the cap.
inline long settle(const std::string& bidder, const std::string& auction_id, bool won) {
  return static_cast<long>(redis().eval<long long>(kSettleLua, {claimKey(bidder, auction_id)}, {std::string(won ? "1" : "0")}));
}

}  // namespace rtb::spend
`,
  'rtb/outbox.h': `// The bid-event outbox (provided): insert(event, reason) appends {"event": …, "reason": …} as JSON
// to the Redis list outbox:bid.event; a relay produces the rows later.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>

namespace rtb::outbox {

inline const std::string kKey = "outbox:bid.event";

inline void insert(const nlohmann::json& event, const std::string& reason) {
  static sw::redis::Redis redis("tcp://redis:6379");
  redis.rpush(kKey, nlohmann::json{{"event", event}, {"reason", reason}}.dump());
}

}  // namespace rtb::outbox
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('rtb', 'Deadline')]: `package rtb

/**
 * The auction budget (provided): Deadline.start(budgetMs) starts the clock once, at the top of the
 * request; remainingMs is what is left of it, never below 0. Every stage of a bid is handed the
 * same Deadline, so a slow stage shortens the ones after it.
 */
final class Deadline private (val budgetMs: Long, startedNanos: Long) {
  def remainingMs: Long = math.max(0L, budgetMs - (System.nanoTime() - startedNanos) / 1000000L)
}

object Deadline {
  def start(budgetMs: Long): Deadline = new Deadline(budgetMs, System.nanoTime())
}
`,
  [scalaPath('rtb', 'Pricing')]: `package rtb

import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import rtbfeatures.realtime_bidding.{ContextRequest, FeaturesGrpc, IdentityRequest, ScoreRequest, ScorerGrpc}

/**
 * Bid pricing over the feature service and the model scorer (provided; step 3 builds the same
 * quoteBid). Each feature tier gets its own slice of the auction budget, clamped to what is left:
 * identity IdentityMs, contextual ContextMs. A tier that fails or runs out of time degrades the
 * quote to a bid at the floor; the model is asked only while ModelMinMs is still left. Nothing is
 * retried inside an auction.
 */
object Pricing {
  val IdentityMs = 30L
  val ContextMs = 50L
  val ModelMinMs = 20L

  final case class Quote(bidCents: Long, degraded: Boolean, reason: String)

  private val features = FeaturesGrpc.blockingStub(ManagedChannelBuilder.forAddress("features", 9000).usePlaintext().build())
  private val scorer = ScorerGrpc.blockingStub(ManagedChannelBuilder.forAddress("scorer", 9000).usePlaintext().build())

  /** A tier's budget: its own slice, or what is left of the auction when that is less. */
  def tierMs(deadline: Deadline, sliceMs: Long): Long = math.min(sliceMs, deadline.remainingMs)

  private def ask[T](budgetMs: Long)(call: Long => T): Option[T] =
    if (budgetMs <= 0) None
    else
      try Some(call(budgetMs))
      catch { case _: StatusRuntimeException => None }

  /** The price to bid for this impression, inside what is left of the auction's budget. */
  def quoteBid(userHash: String, auctionId: String, floorCents: Long, deadline: Deadline): Quote = {
    val identity = ask(tierMs(deadline, IdentityMs))(ms => features.withDeadlineAfter(ms, TimeUnit.MILLISECONDS).identity(IdentityRequest(userHash)))
    identity match {
      case None => Quote(floorCents, degraded = true, "identity_unavailable")
      case Some(id) =>
        val context = ask(tierMs(deadline, ContextMs))(ms => features.withDeadlineAfter(ms, TimeUnit.MILLISECONDS).contextual(ContextRequest(auctionId)))
        context match {
          case None => Quote(floorCents, degraded = true, "context_unavailable")
          case Some(_) if deadline.remainingMs < ModelMinMs => Quote(floorCents, degraded = true, "model_skipped")
          case Some(ctx) =>
            val request = ScoreRequest(userHash, auctionId, id.segment, ctx.category)
            ask(deadline.remainingMs)(ms => scorer.withDeadlineAfter(ms, TimeUnit.MILLISECONDS).score(request)) match {
              case None => Quote(floorCents, degraded = true, "model_unavailable")
              case Some(score) => Quote(score.valueCents, degraded = false, "")
            }
        }
    }
  }
}
`,
  [scalaPath('rtb', 'Spend')]: `package rtb

import java.time.{LocalDate, ZoneOffset}
import java.time.format.DateTimeFormatter

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * The daily spend cap (provided; step 2 builds claim and settle): cap:{bidder} is the bidder's daily
 * cap in cents, spend:{bidder}:{yyyymmdd} what it has claimed that UTC day (kept TtlSeconds, two
 * days), and the hash claim:{bidder}:{auction_id} (spend_key, cents) the claim one auction holds
 * until the exchange reports the result. claim reserves cents in one Lua script and refuses what
 * the cap cannot cover; settle keeps a won auction's charge and gives a lost one's back, once.
 */
object Spend {
  val TtlSeconds: Long = 2L * 86400L

  val jedis = new JedisPooled("redis", 6379)

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

  val SettleLua: String =
    """local spend_key = redis.call('HGET', KEYS[1], 'spend_key')
      |if not spend_key then return 0 end
      |local cents = tonumber(redis.call('HGET', KEYS[1], 'cents'))
      |redis.call('DEL', KEYS[1])
      |if ARGV[1] == '1' then return 0 end
      |redis.call('DECRBY', spend_key, cents)
      |return cents
      |""".stripMargin

  /** The current UTC day as yyyymmdd. */
  def today(): String = LocalDate.now(ZoneOffset.UTC).format(DateTimeFormatter.BASIC_ISO_DATE)

  def capKey(bidder: String): String = s"cap:$bidder"
  def spendKey(bidder: String, day: String): String = s"spend:$bidder:$day"
  def claimKey(bidder: String, auctionId: String): String = s"claim:$bidder:$auctionId"

  def setCap(bidder: String, cents: Long): Unit = jedis.set(capKey(bidder), cents.toString)

  /** The bidder's daily cap in cents; 0 when none is set. */
  def capOf(bidder: String): Long = Option(jedis.get(capKey(bidder))).map(_.toLong).getOrElse(0L)

  /** What the bidder has claimed on day (yyyymmdd), in cents. */
  def spent(bidder: String, day: String): Long = Option(jedis.get(spendKey(bidder, day))).map(_.toLong).getOrElse(0L)

  /** Reserve cents of today's cap for the auction; false when the cap cannot cover them. */
  def claim(bidder: String, auctionId: String, cents: Long): Boolean = {
    val keys = List(spendKey(bidder, today()), claimKey(bidder, auctionId), capKey(bidder)).asJava
    jedis.eval(ClaimLua, keys, List(cents.toString, TtlSeconds.toString).asJava).asInstanceOf[java.lang.Long] == 1L
  }

  /** Apply the exchange's result to the auction's claim; the cents given back to the cap. */
  def settle(bidder: String, auctionId: String, won: Boolean): Long =
    jedis.eval(SettleLua, List(claimKey(bidder, auctionId)).asJava, List(if (won) "1" else "0").asJava).asInstanceOf[java.lang.Long]
}
`,
  [scalaPath('rtb', 'Outbox')]: `package rtb

import redis.clients.jedis.JedisPooled
import spray.json._

/**
 * The bid-event outbox (provided): insert(event, reason) appends {"event": …, "reason": …} as JSON
 * to the Redis list outbox:bid.event; a relay produces the rows later.
 */
object Outbox {
  val Key = "outbox:bid.event"

  private val jedis = new JedisPooled("redis", 6379)

  def insert(event: JsObject, reason: String): Unit =
    jedis.rpush(Key, JsObject("event" -> event, "reason" -> JsString(reason)).compactPrint)
}
`,
};
