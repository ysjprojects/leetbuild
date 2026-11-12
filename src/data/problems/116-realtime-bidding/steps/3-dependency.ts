import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Feature calls with a slice of the auction each, and a degraded bid at the floor',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies'],
  file: 'client',
  focus: ['api', 'features', 'scorer'],
  task: `## Task

**Starting point.** The starter is \`quote_bid(user_hash, auction_id, floor_cents, deadline)\`, which
prices a bid over gRPC: \`Features.Identity\` (retried once on failure), then \`Features.Contextual\`,
then \`Scorer.Score\`, and returns \`Quote(bid_cents, degraded, reason)\` with the model's value. It
serves the demo and hides 4 flaws.

**Failure mode the checks target.** The feature service has a slow minute: every call waits as long
as the service takes, an identity lookup is retried inside a 100 ms auction, the model is asked with
5 ms left, and a tier that failed is priced as if it had answered.

- Each tier gets its own deadline: identity \`IDENTITY_MS\` (30), contextual \`CONTEXT_MS\` (50), each
  clamped to \`deadline.remaining_ms()\`; the score gets what is left.
- Ask the model only while \`MODEL_MIN_MS\` (20) is left.
- Call each tier once.
- When a tier fails or runs out of time, or the score is skipped or fails, return
  \`Quote(floor_cents, True, reason)\`: a bid at the floor, marked degraded, with the reason
  (\`identity_unavailable\`, \`context_unavailable\`, \`model_skipped\`, \`model_unavailable\`).`,
  sequence: {
    participants: ['biddingd', 'Feature service', 'Model scorer'],
    messages: [
      {from: 'biddingd', to: 'Feature service', label: 'Identity · deadline min(30, left)', kind: 'sync'},
      {
        from: 'Feature service',
        to: 'biddingd',
        label: 'segment · or DEADLINE_EXCEEDED → floor, degraded',
        kind: 'reply',
      },
      {from: 'biddingd', to: 'Feature service', label: 'Contextual · deadline min(50, left)', kind: 'sync'},
      {from: 'Feature service', to: 'biddingd', label: 'category', kind: 'reply'},
      {from: 'biddingd', to: 'biddingd', label: 'left < MODEL_MIN_MS → floor, degraded', kind: 'sync'},
      {from: 'biddingd', to: 'Model scorer', label: 'Score · deadline = left', kind: 'sync'},
      {from: 'Model scorer', to: 'biddingd', label: 'value_cents', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'tier-deadlines',
      title: 'Each tier gets its slice, clamped to what is left',
      detail:
        'Identity calls carry at most 30 ms, contextual calls at most 50 ms and never more than the auction has left, so an identity service answering in 200 ms costs the quote 30 ms. The starter sets no deadline at all.',
      match: {
        python: {all: [/timeout\s*=/, /\bmin\(/, /remaining_ms\(\)/]},
        typescript: {all: [/deadline:\s*Date\.now\(\)\s*\+/, /Math\.min\(/, /remainingMs\(\)/]},
        go: {all: [/context\.WithTimeout\(/, /RemainingMs\(\)/]},
        scala: {all: [/withDeadlineAfter\(/, /\bmin\(/, /remainingMs/]},
        cpp: {all: [/set_deadline\(/, /remainingMs\(\)/]},
      },
    },
    {
      id: 'skip-model',
      title: 'The model is skipped when it cannot fit',
      detail:
        'With less than `MODEL_MIN_MS` left after the features, `Score` is not called and the quote is degraded. The starter scores whatever is left.',
      match: {
        python: {all: [/remaining_ms\(\)\s*<\s*MODEL_MIN_MS/]},
        typescript: {all: [/remainingMs\(\)\s*<\s*MODEL_MIN_MS/]},
        go: {all: [/RemainingMs\(\)\s*<\s*modelMinMs/]},
        scala: {all: [/remainingMs\s*<\s*ModelMinMs/]},
        cpp: {all: [/remainingMs\(\)\s*<\s*kModelMinMs/]},
      },
    },
    {
      id: 'no-retry',
      title: 'No tier is retried inside an auction',
      detail:
        'A failed identity lookup is one call: the retry cannot finish inside the budget and spends the time the other tiers need. The starter loops the identity call twice.',
      match: {
        python: {none: [/range\(\s*\d+\s*\)/, /\battempts?\b/]},
        typescript: {none: [/\battempts?\b/]},
        go: {none: [/\battempts?\b/]},
        scala: {none: [/\battempts?\b/]},
        cpp: {none: [/\battempts?\b/]},
      },
    },
    {
      id: 'degraded-floor',
      title: 'A failed tier bids the floor, marked degraded',
      detail:
        'When a tier fails, the quote is the floor with `degraded` set and a reason, and the model is not scored on features that never arrived. The starter scores empty features and reports a healthy bid.',
      match: {
        python: {all: [/Quote\(\s*floor_cents\s*,\s*True/]},
        typescript: {all: [/bid_cents:\s*floorCents,\s*degraded:\s*true/]},
        go: {all: [/Quote\{\s*floorCents,\s*true/]},
        scala: {all: [/Quote\(\s*floorCents\s*,\s*degraded\s*=\s*true/]},
        cpp: {all: [/\{\s*floor_cents\s*,\s*true/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from dataclasses import dataclass

import grpc

import realtime_bidding_pb2 as pb
import realtime_bidding_pb2_grpc as pb_grpc
from rtb.deadline import Deadline  # Deadline.start(budget_ms), deadline.remaining_ms()

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


def quote_bid(user_hash: str, auction_id: str, floor_cents: int, deadline: Deadline) -> Quote:
    """The price to bid for this impression, inside what is left of the auction's budget."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    identity = pb.IdentityFeatures()
    for _ in range(2):
        try:
            identity = features.Identity(pb.IdentityRequest(user_hash=user_hash))
            break
        except grpc.RpcError:
            continue
    try:
        context = features.Contextual(pb.ContextRequest(auction_id=auction_id))
    except grpc.RpcError:
        context = pb.ContextFeatures()
    request = pb.ScoreRequest(user_hash=user_hash, auction_id=auction_id, segment=identity.segment, category=context.category)
    score = scorer.Score(request)
    return Quote(score.value_cents, False, "")
`,
      solution: `from dataclasses import dataclass

import grpc

import realtime_bidding_pb2 as pb
import realtime_bidding_pb2_grpc as pb_grpc
from rtb.deadline import Deadline  # Deadline.start(budget_ms), deadline.remaining_ms()

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


def ask(method, request, budget_ms: int):
    """One call inside budget_ms, or None: no time left, a failure or a deadline. Never retried."""
    if budget_ms <= 0:
        return None
    try:
        return method(request, timeout=budget_ms / 1000)
    except grpc.RpcError:
        return None


def quote_bid(user_hash: str, auction_id: str, floor_cents: int, deadline: Deadline) -> Quote:
    """The price to bid for this impression, inside what is left of the auction's budget."""
    identity = ask(features.Identity, pb.IdentityRequest(user_hash=user_hash), tier_ms(deadline, IDENTITY_MS))
    if identity is None:
        return Quote(floor_cents, True, "identity_unavailable")
    context = ask(features.Contextual, pb.ContextRequest(auction_id=auction_id), tier_ms(deadline, CONTEXT_MS))
    if context is None:
        return Quote(floor_cents, True, "context_unavailable")
    if deadline.remaining_ms() < MODEL_MIN_MS:
        return Quote(floor_cents, True, "model_skipped")
    request = pb.ScoreRequest(user_hash=user_hash, auction_id=auction_id, segment=identity.segment, category=context.category)
    score = ask(scorer.Score, request, deadline.remaining_ms())
    if score is None:
        return Quote(floor_cents, True, "model_unavailable")
    return Quote(score.value_cents, False, "")
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Deadline} from 'rtb/deadline'; // Deadline.start(budgetMs), deadline.remainingMs()

export const IDENTITY_MS = 30;
export const CONTEXT_MS = 50;
export const MODEL_MIN_MS = 20;

export interface Quote {
  bid_cents: number;
  degraded: boolean;
  reason: string;
}

interface IdentityFeatures {
  segment: string;
  frequency: number;
}

interface ContextFeatures {
  category: string;
  viewability_pct: number;
}

type Unary<Req, Res> = (request: Req, metadata: grpc.Metadata, options: grpc.CallOptions) => Promise<Res>;

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('realtime_bidding.proto')) as unknown as {
  rtbfeatures: {Features: grpc.ServiceClientConstructor; Scorer: grpc.ServiceClientConstructor};
};
const features = new pkg.rtbfeatures.Features('features:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Identity: Unary<{user_hash: string}, IdentityFeatures>;
  Contextual: Unary<{auction_id: string}, ContextFeatures>;
};
const scorer = new pkg.rtbfeatures.Scorer('scorer:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Score: Unary<{user_hash: string; auction_id: string; segment: string; category: string}, {value_cents: number | string}>;
};

/** The price to bid for this impression, inside what is left of the auction's budget. */
export async function quoteBid(userHash: string, auctionId: string, floorCents: number, deadline: Deadline): Promise<Quote> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  let identity: IdentityFeatures = {segment: '', frequency: 0};
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      identity = await features.Identity({user_hash: userHash}, new grpc.Metadata(), {});
      break;
    } catch {
      continue;
    }
  }
  let context: ContextFeatures = {category: '', viewability_pct: 0};
  try {
    context = await features.Contextual({auction_id: auctionId}, new grpc.Metadata(), {});
  } catch {
    // scored without the contextual tier
  }
  const request = {user_hash: userHash, auction_id: auctionId, segment: identity.segment, category: context.category};
  const score = await scorer.Score(request, new grpc.Metadata(), {});
  return {bid_cents: Number(score.value_cents), degraded: false, reason: ''};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Deadline} from 'rtb/deadline'; // Deadline.start(budgetMs), deadline.remainingMs()

export const IDENTITY_MS = 30;
export const CONTEXT_MS = 50;
export const MODEL_MIN_MS = 20;

export interface Quote {
  bid_cents: number;
  degraded: boolean;
  reason: string;
}

interface IdentityFeatures {
  segment: string;
  frequency: number;
}

interface ContextFeatures {
  category: string;
  viewability_pct: number;
}

type Unary<Req, Res> = (request: Req, metadata: grpc.Metadata, options: grpc.CallOptions) => Promise<Res>;

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('realtime_bidding.proto')) as unknown as {
  rtbfeatures: {Features: grpc.ServiceClientConstructor; Scorer: grpc.ServiceClientConstructor};
};
const features = new pkg.rtbfeatures.Features('features:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Identity: Unary<{user_hash: string}, IdentityFeatures>;
  Contextual: Unary<{auction_id: string}, ContextFeatures>;
};
const scorer = new pkg.rtbfeatures.Scorer('scorer:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Score: Unary<{user_hash: string; auction_id: string; segment: string; category: string}, {value_cents: number | string}>;
};

/** A tier's budget: its own slice, or what is left of the auction when that is less. */
export const tierMs = (deadline: Deadline, sliceMs: number): number => Math.min(sliceMs, deadline.remainingMs());

/** One call inside budgetMs, or null: no time left, a failure or a deadline. Never retried. */
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
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"rtb/deadline" // deadline.Start(budgetMs), d.RemainingMs()
	pb "rtb/gen/realtime_bidding"
)

const (
	identityMs = 30
	contextMs  = 50
	modelMinMs = 20
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

// quoteBid is the price to bid for this impression, inside what is left of the auction's budget.
func quoteBid(ctx context.Context, userHash, auctionID string, floorCents int64, d *deadline.Deadline) Quote {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	identity := &pb.IdentityFeatures{}
	for attempt := 0; attempt < 2; attempt++ {
		if got, err := features.Identity(ctx, &pb.IdentityRequest{UserHash: userHash}); err == nil {
			identity = got
			break
		}
	}
	contextual, err := features.Contextual(ctx, &pb.ContextRequest{AuctionId: auctionID})
	if err != nil {
		contextual = &pb.ContextFeatures{}
	}
	score, _ := scorer.Score(ctx, &pb.ScoreRequest{UserHash: userHash, AuctionId: auctionID, Segment: identity.GetSegment(), Category: contextual.GetCategory()})
	return Quote{score.GetValueCents(), false, ""}
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"rtb/deadline" // deadline.Start(budgetMs), d.RemainingMs()
	pb "rtb/gen/realtime_bidding"
)

const (
	identityMs = 30
	contextMs  = 50
	modelMinMs = 20
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

// tierMs is a tier's budget: its own slice, or what is left of the auction when that is less.
func tierMs(d *deadline.Deadline, sliceMs int64) int64 {
	if left := d.RemainingMs(); left < sliceMs {
		return left
	}
	return sliceMs
}

// within bounds one call to budgetMs. Each tier is called once: a retry cannot finish inside the auction.
func within(ctx context.Context, budgetMs int64) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, time.Duration(budgetMs)*time.Millisecond)
}

// quoteBid is the price to bid for this impression, inside what is left of the auction's budget.
func quoteBid(ctx context.Context, userHash, auctionID string, floorCents int64, d *deadline.Deadline) Quote {
	budget := tierMs(d, identityMs)
	if budget <= 0 {
		return Quote{floorCents, true, "identity_unavailable"}
	}
	callCtx, cancel := within(ctx, budget)
	identity, err := features.Identity(callCtx, &pb.IdentityRequest{UserHash: userHash})
	cancel()
	if err != nil {
		return Quote{floorCents, true, "identity_unavailable"}
	}
	budget = tierMs(d, contextMs)
	if budget <= 0 {
		return Quote{floorCents, true, "context_unavailable"}
	}
	callCtx, cancel = within(ctx, budget)
	contextual, err := features.Contextual(callCtx, &pb.ContextRequest{AuctionId: auctionID})
	cancel()
	if err != nil {
		return Quote{floorCents, true, "context_unavailable"}
	}
	if d.RemainingMs() < modelMinMs {
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
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import rtb.Deadline // Deadline.start(budgetMs), deadline.remainingMs
import rtbfeatures.realtime_bidding.{ContextFeatures, ContextRequest, FeaturesGrpc, IdentityFeatures, IdentityRequest, ScoreRequest, ScorerGrpc}

object Client {
  val IdentityMs = 30L
  val ContextMs = 50L
  val ModelMinMs = 20L

  final case class Quote(bidCents: Long, degraded: Boolean, reason: String)

  private val features = FeaturesGrpc.blockingStub(ManagedChannelBuilder.forAddress("features", 9000).usePlaintext().build())
  private val scorer = ScorerGrpc.blockingStub(ManagedChannelBuilder.forAddress("scorer", 9000).usePlaintext().build())

  /** The price to bid for this impression, inside what is left of the auction's budget. */
  def quoteBid(userHash: String, auctionId: String, floorCents: Long, deadline: Deadline): Quote = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    var identity = IdentityFeatures()
    var attempt = 0
    while (attempt < 2) {
      try {
        identity = features.identity(IdentityRequest(userHash))
        attempt = 2
      } catch { case _: StatusRuntimeException => attempt += 1 }
    }
    val context =
      try features.contextual(ContextRequest(auctionId))
      catch { case _: StatusRuntimeException => ContextFeatures() }
    val score = scorer.score(ScoreRequest(userHash, auctionId, identity.segment, context.category))
    Quote(score.valueCents, degraded = false, "")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import rtb.Deadline // Deadline.start(budgetMs), deadline.remainingMs
import rtbfeatures.realtime_bidding.{ContextRequest, FeaturesGrpc, IdentityRequest, ScoreRequest, ScorerGrpc}

object Client {
  val IdentityMs = 30L
  val ContextMs = 50L
  val ModelMinMs = 20L

  final case class Quote(bidCents: Long, degraded: Boolean, reason: String)

  private val features = FeaturesGrpc.blockingStub(ManagedChannelBuilder.forAddress("features", 9000).usePlaintext().build())
  private val scorer = ScorerGrpc.blockingStub(ManagedChannelBuilder.forAddress("scorer", 9000).usePlaintext().build())

  /** A tier's budget: its own slice, or what is left of the auction when that is less. */
  def tierMs(deadline: Deadline, sliceMs: Long): Long = math.min(sliceMs, deadline.remainingMs)

  /** One call inside budgetMs, or None: no time left, a failure or a deadline. Never retried. */
  private def ask[T](budgetMs: Long)(call: Long => T): Option[T] =
    if (budgetMs <= 0) None
    else
      try Some(call(budgetMs))
      catch { case _: StatusRuntimeException => None }

  /** The price to bid for this impression, inside what is left of the auction's budget. */
  def quoteBid(userHash: String, auctionId: String, floorCents: Long, deadline: Deadline): Quote =
    ask(tierMs(deadline, IdentityMs))(ms => features.withDeadlineAfter(ms, TimeUnit.MILLISECONDS).identity(IdentityRequest(userHash))) match {
      case None => Quote(floorCents, degraded = true, "identity_unavailable")
      case Some(identity) =>
        ask(tierMs(deadline, ContextMs))(ms => features.withDeadlineAfter(ms, TimeUnit.MILLISECONDS).contextual(ContextRequest(auctionId))) match {
          case None => Quote(floorCents, degraded = true, "context_unavailable")
          case Some(_) if deadline.remainingMs < ModelMinMs => Quote(floorCents, degraded = true, "model_skipped")
          case Some(context) =>
            val request = ScoreRequest(userHash, auctionId, identity.segment, context.category)
            ask(deadline.remainingMs)(ms => scorer.withDeadlineAfter(ms, TimeUnit.MILLISECONDS).score(request)) match {
              case None => Quote(floorCents, degraded = true, "model_unavailable")
              case Some(score) => Quote(score.valueCents, degraded = false, "")
            }
        }
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>

#include "realtime_bidding.grpc.pb.h"
#include "rtb/deadline.h"  // rtb::Deadline::start(budget_ms), deadline.remainingMs()

constexpr long kIdentityMs = 30;
constexpr long kContextMs = 50;
constexpr long kModelMinMs = 20;

struct Quote {
  long bid_cents = 0;
  bool degraded = false;
  std::string reason;
};

auto features = rtbfeatures::Features::NewStub(grpc::CreateChannel("features:9000", grpc::InsecureChannelCredentials()));
auto scorer = rtbfeatures::Scorer::NewStub(grpc::CreateChannel("scorer:9000", grpc::InsecureChannelCredentials()));

// The price to bid for this impression, inside what is left of the auction's budget.
Quote quoteBid(const std::string& user_hash, const std::string& auction_id, long floor_cents, const rtb::Deadline& deadline) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  rtbfeatures::IdentityFeatures identity;
  for (int attempt = 0; attempt < 2; attempt++) {
    grpc::ClientContext ctx;
    rtbfeatures::IdentityRequest request;
    request.set_user_hash(user_hash);
    if (features->Identity(&ctx, request, &identity).ok()) break;
  }
  rtbfeatures::ContextFeatures context;
  {
    grpc::ClientContext ctx;
    rtbfeatures::ContextRequest request;
    request.set_auction_id(auction_id);
    features->Contextual(&ctx, request, &context);
  }
  grpc::ClientContext ctx;
  rtbfeatures::ScoreRequest request;
  request.set_user_hash(user_hash);
  request.set_auction_id(auction_id);
  request.set_segment(identity.segment());
  request.set_category(context.category());
  rtbfeatures::ScoreReply score;
  scorer->Score(&ctx, request, &score);
  return {static_cast<long>(score.value_cents()), false, ""};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

#include "realtime_bidding.grpc.pb.h"
#include "rtb/deadline.h"  // rtb::Deadline::start(budget_ms), deadline.remainingMs()

constexpr long kIdentityMs = 30;
constexpr long kContextMs = 50;
constexpr long kModelMinMs = 20;

struct Quote {
  long bid_cents = 0;
  bool degraded = false;
  std::string reason;
};

auto features = rtbfeatures::Features::NewStub(grpc::CreateChannel("features:9000", grpc::InsecureChannelCredentials()));
auto scorer = rtbfeatures::Scorer::NewStub(grpc::CreateChannel("scorer:9000", grpc::InsecureChannelCredentials()));

// A tier's budget: its own slice, or what is left of the auction when that is less.
long tierMs(const rtb::Deadline& deadline, long slice_ms) {
  const long left = deadline.remainingMs();
  return left < slice_ms ? left : slice_ms;
}

// One call per tier, bounded to budget_ms: a retry cannot finish inside the auction.
void within(grpc::ClientContext& ctx, long budget_ms) {
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(budget_ms));
}

// The price to bid for this impression, inside what is left of the auction's budget.
Quote quoteBid(const std::string& user_hash, const std::string& auction_id, long floor_cents, const rtb::Deadline& deadline) {
  long budget = tierMs(deadline, kIdentityMs);
  if (budget <= 0) return {floor_cents, true, "identity_unavailable"};
  rtbfeatures::IdentityFeatures identity;
  {
    grpc::ClientContext ctx;
    within(ctx, budget);
    rtbfeatures::IdentityRequest request;
    request.set_user_hash(user_hash);
    if (!features->Identity(&ctx, request, &identity).ok()) return {floor_cents, true, "identity_unavailable"};
  }
  budget = tierMs(deadline, kContextMs);
  if (budget <= 0) return {floor_cents, true, "context_unavailable"};
  rtbfeatures::ContextFeatures context;
  {
    grpc::ClientContext ctx;
    within(ctx, budget);
    rtbfeatures::ContextRequest request;
    request.set_auction_id(auction_id);
    if (!features->Contextual(&ctx, request, &context).ok()) return {floor_cents, true, "context_unavailable"};
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
  if (!scorer->Score(&ctx, request, &score).ok()) return {floor_cents, true, "model_unavailable"};
  return {static_cast<long>(score.value_cents()), false, ""};
}
`,
    },
  },
  harness: {
    python: `import grpc

import realtime_bidding_pb2 as pb
import realtime_bidding_pb2_grpc as pb_grpc
from rtb.deadline import Deadline

FLOOR = 250
VALUE = 310


class Features(pb_grpc.FeaturesServicer):
    def Identity(self, request, context):
        return pb.IdentityFeatures(segment="sports", frequency=2)

    def Contextual(self, request, context):
        return pb.ContextFeatures(category="news", viewability_pct=70)


class Scorer(pb_grpc.ScorerServicer):
    def Score(self, request, context):
        return pb.ScoreReply(value_cents=VALUE)


def _client(ctx):
    ctx.grpc.serve(pb_grpc.add_FeaturesServicer_to_server, Features())
    ctx.grpc.serve(pb_grpc.add_ScorerServicer_to_server, Scorer())
    return ctx.load("client")


def _quote(ctx, m, budget_ms):
    try:
        return m.quote_bid("u-9", "a-1", FLOOR, Deadline.start(budget_ms))
    except grpc.RpcError as exc:
        raise AssertionError(f"quote_bid raised {exc.code().name}: a failed or late tier degrades the bid, it does not fail the auction") from exc


def _degraded(q, why):
    assert q.degraded is True and q.bid_cents == FLOOR and q.reason, f"{why} the quote is {q}: it must bid the floor ({FLOOR}), marked degraded, with a reason"


def check_tier_deadlines(ctx):
    m = _client(ctx)
    q = _quote(ctx, m, 100)
    assert (q.bid_cents, q.degraded) == (VALUE, False), f"with every service healthy the quote is {q}, expected the model's {VALUE} cents, not degraded"
    for method, slice_ms in (("Identity", 30), ("Contextual", 50)):
        calls = ctx.grpc.calls_to(method)
        assert calls, f"no {method} call was made"
        for call in calls:
            assert call.timeout is not None, f"the {method} call carries no deadline: a slow feature service holds the whole auction"
            assert 0 < call.timeout <= slice_ms / 1000 + 0.001, f"the {method} call carries a {call.timeout * 1000:.0f} ms deadline, expected its slice of {slice_ms} ms"
    ctx.grpc.set_latency("Identity", 0.2)
    started = ctx.clock.time()
    q = _quote(ctx, m, 100)
    took_ms = (ctx.clock.time() - started) * 1000
    assert took_ms <= 31, f"an identity service answering in 200 ms held the quote for {took_ms:.0f} ms: identity gets its 30 ms slice, not the auction"
    _degraded(q, "with identity slower than its slice")
    ctx.grpc.set_latency("Identity", 0.025)
    _quote(ctx, m, 40)
    last = ctx.grpc.calls_to("Contextual")[-1]
    assert last.timeout is not None and last.timeout <= 0.0151, f"with 15 ms of the auction left the contextual call got a {(last.timeout or 0) * 1000:.0f} ms deadline: a slice is clamped to what is left"


def check_skip_model(ctx):
    m = _client(ctx)
    ctx.grpc.set_latency("Identity", 0.025)
    ctx.grpc.set_latency("Contextual", 0.030)
    q = _quote(ctx, m, 60)
    assert not ctx.grpc.calls_to("Score"), "the model was asked with 5 ms of the auction left: below MODEL_MIN_MS = 20 the score is skipped"
    _degraded(q, "with 5 ms left after the features")
    ctx.grpc.set_latency("Identity", 0)
    ctx.grpc.set_latency("Contextual", 0)
    q = _quote(ctx, m, 100)
    assert len(ctx.grpc.calls_to("Score")) == 1 and (q.bid_cents, q.degraded) == (VALUE, False), f"with the whole budget left the model must be asked once and its value bid, got {q}"


def check_no_retry(ctx):
    m = _client(ctx)
    ctx.grpc.fail("Identity", grpc.StatusCode.UNAVAILABLE, "identity store restarting", times=1)
    q = _quote(ctx, m, 100)
    calls = len(ctx.grpc.calls_to("Identity"))
    assert calls == 1, f"one failed identity lookup became {calls} Identity calls in one auction: a retry cannot finish inside the budget, degrade instead"
    _degraded(q, "with the identity lookup failed")


def check_degraded_floor(ctx):
    m = _client(ctx)
    ctx.grpc.fail("Contextual", grpc.StatusCode.UNAVAILABLE, "contextual tier down", times=1)
    q = _quote(ctx, m, 100)
    _degraded(q, "with the contextual tier down")
    assert not ctx.grpc.calls_to("Score"), "the model was scored on contextual features that never arrived"
    ctx.grpc.fail("Identity", grpc.StatusCode.UNAVAILABLE, "identity store restarting", times=1)
    q = _quote(ctx, m, 100)
    _degraded(q, "with the identity tier down")
    q = _quote(ctx, m, 100)
    assert (q.bid_cents, q.degraded, q.reason) == (VALUE, False, ""), f"once the tiers answer again the quote is {q}, expected the model's {VALUE} cents"
`,
    typescript: `const FLOOR = 250;
const VALUE = 310;

function client(ctx) {
  const pkg = ctx.proto('realtime_bidding.proto');
  ctx.grpc.serve(pkg.rtbfeatures.Features.service, {
    Identity(_call, callback) {
      callback(null, {segment: 'sports', frequency: 2});
    },
    Contextual(_call, callback) {
      callback(null, {category: 'news', viewability_pct: 70});
    },
  });
  ctx.grpc.serve(pkg.rtbfeatures.Scorer.service, {
    Score(_call, callback) {
      callback(null, {value_cents: VALUE});
    },
  });
  const m = ctx.load('client');
  const {Deadline} = ctx.load('/support/rtb/deadline.ts');
  return async (budgetMs: number) => {
    try {
      return await m.quoteBid('u-9', 'a-1', FLOOR, Deadline.start(budgetMs));
    } catch (e) {
      assert.fail(\`quoteBid threw \${(e as Error).message}: a failed or late tier degrades the bid, it does not fail the auction\`);
    }
  };
}

function degraded(q, why: string): void {
  assert(q.degraded === true && q.bid_cents === FLOOR && q.reason, \`\${why} the quote is \${JSON.stringify(q)}: it must bid the floor (\${FLOOR}), marked degraded, with a reason\`);
}

export async function check_tier_deadlines(ctx) {
  const quote = client(ctx);
  let q = await quote(100);
  assert(q.bid_cents === VALUE && q.degraded === false, \`with every service healthy the quote is \${JSON.stringify(q)}, expected the model's \${VALUE} cents, not degraded\`);
  for (const [method, sliceMs] of [['Identity', 30], ['Contextual', 50]] as const) {
    const calls = ctx.grpc.callsTo(method);
    assert(calls.length > 0, \`no \${method} call was made\`);
    for (const call of calls) {
      assert(call.timeout !== null, \`the \${method} call carries no deadline: a slow feature service holds the whole auction\`);
      assert(call.timeout > 0 && call.timeout <= sliceMs / 1000 + 0.001, \`the \${method} call carries a \${Math.round(call.timeout * 1000)} ms deadline, expected its slice of \${sliceMs} ms\`);
    }
  }
  ctx.grpc.setLatency('Identity', 0.2);
  const started = ctx.clock.now();
  q = await quote(100);
  const tookMs = ctx.clock.now() - started;
  assert(tookMs <= 31, \`an identity service answering in 200 ms held the quote for \${tookMs} ms: identity gets its 30 ms slice, not the auction\`);
  degraded(q, 'with identity slower than its slice');
  ctx.grpc.setLatency('Identity', 0.025);
  await quote(40);
  const contextual = ctx.grpc.callsTo('Contextual');
  const last = contextual[contextual.length - 1];
  assert(last.timeout !== null && last.timeout <= 0.0151, \`with 15 ms of the auction left the contextual call got a \${Math.round((last.timeout ?? 0) * 1000)} ms deadline: a slice is clamped to what is left\`);
}

export async function check_skip_model(ctx) {
  const quote = client(ctx);
  ctx.grpc.setLatency('Identity', 0.025);
  ctx.grpc.setLatency('Contextual', 0.03);
  let q = await quote(60);
  assert.equal(ctx.grpc.callsTo('Score').length, 0, 'the model was asked with 5 ms of the auction left: below MODEL_MIN_MS = 20 the score is skipped');
  degraded(q, 'with 5 ms left after the features');
  ctx.grpc.setLatency('Identity', 0);
  ctx.grpc.setLatency('Contextual', 0);
  q = await quote(100);
  assert(ctx.grpc.callsTo('Score').length === 1 && q.bid_cents === VALUE && q.degraded === false, \`with the whole budget left the model must be asked once and its value bid, got \${JSON.stringify(q)}\`);
}

export async function check_no_retry(ctx) {
  const quote = client(ctx);
  ctx.grpc.fail('Identity', ctx.grpc.status.UNAVAILABLE, 'identity store restarting', 1);
  const q = await quote(100);
  const calls = ctx.grpc.callsTo('Identity').length;
  assert.equal(calls, 1, \`one failed identity lookup became \${calls} Identity calls in one auction: a retry cannot finish inside the budget, degrade instead\`);
  degraded(q, 'with the identity lookup failed');
}

export async function check_degraded_floor(ctx) {
  const quote = client(ctx);
  ctx.grpc.fail('Contextual', ctx.grpc.status.UNAVAILABLE, 'contextual tier down', 1);
  let q = await quote(100);
  degraded(q, 'with the contextual tier down');
  assert.equal(ctx.grpc.callsTo('Score').length, 0, 'the model was scored on contextual features that never arrived');
  ctx.grpc.fail('Identity', ctx.grpc.status.UNAVAILABLE, 'identity store restarting', 1);
  q = await quote(100);
  degraded(q, 'with the identity tier down');
  q = await quote(100);
  assert(q.bid_cents === VALUE && q.degraded === false && q.reason === '', \`once the tiers answer again the quote is \${JSON.stringify(q)}, expected the model's \${VALUE} cents\`);
}
`,
    go: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"

	"rtb/deadline"
	pb "rtb/gen/realtime_bidding"

	"leetbuild/harness"
)

const (
	clientFloor = 250
	clientValue = 310
)

type featuresPeer struct {
	pb.UnimplementedFeaturesServer
}

func (featuresPeer) Identity(context.Context, *pb.IdentityRequest) (*pb.IdentityFeatures, error) {
	return &pb.IdentityFeatures{Segment: "sports", Frequency: 2}, nil
}

func (featuresPeer) Contextual(context.Context, *pb.ContextRequest) (*pb.ContextFeatures, error) {
	return &pb.ContextFeatures{Category: "news", ViewabilityPct: 70}, nil
}

type scorerPeer struct {
	pb.UnimplementedScorerServer
}

func (scorerPeer) Score(context.Context, *pb.ScoreRequest) (*pb.ScoreReply, error) {
	return &pb.ScoreReply{ValueCents: clientValue}, nil
}

func clientSetup(ctx *harness.Ctx) {
	pb.RegisterFeaturesServer(ctx.GRPC.Server(""), featuresPeer{})
	pb.RegisterScorerServer(ctx.GRPC.Server(""), scorerPeer{})
}

func clientQuote(budgetMs int64) Quote {
	return quoteBid(context.Background(), "u-9", "a-1", clientFloor, deadline.Start(budgetMs))
}

func clientDegraded(ctx *harness.Ctx, q Quote, why string) {
	ctx.Assert(q.Degraded && q.BidCents == clientFloor && q.Reason != "", "%s the quote is %+v: it must bid the floor (%d), marked degraded, with a reason", why, q, clientFloor)
}

func CheckTierDeadlines(ctx *harness.Ctx) {
	clientSetup(ctx)
	q := clientQuote(100)
	ctx.Assert(q.BidCents == clientValue && !q.Degraded, "with every service healthy the quote is %+v, expected the model's %d cents, not degraded", q, clientValue)
	for method, slice := range map[string]time.Duration{"Identity": 30 * time.Millisecond, "Contextual": 50 * time.Millisecond} {
		calls := ctx.GRPC.CallsTo(method, "")
		ctx.Assert(len(calls) > 0, "no %s call was made", method)
		for _, call := range calls {
			ctx.Assert(call.HasDeadline(), "the %s call carries no deadline: a slow feature service holds the whole auction", method)
			ctx.Assert(call.Timeout > 0 && call.Timeout <= slice+time.Millisecond, "the %s call carries a %v deadline, expected its slice of %v", method, call.Timeout, slice)
		}
	}
	ctx.GRPC.SetLatency("Identity", 0.2, "")
	started := ctx.Clock.Now()
	q = clientQuote(100)
	took := ctx.Clock.Now() - started
	ctx.Assert(took <= 31, "an identity service answering in 200 ms held the quote for %d ms: identity gets its 30 ms slice, not the auction", took)
	clientDegraded(ctx, q, "with identity slower than its slice")
	ctx.GRPC.SetLatency("Identity", 0.025, "")
	clientQuote(40)
	calls := ctx.GRPC.CallsTo("Contextual", "")
	last := calls[len(calls)-1]
	ctx.Assert(last.HasDeadline() && last.Timeout <= 15*time.Millisecond+100*time.Microsecond, "with 15 ms of the auction left the contextual call got a %v deadline: a slice is clamped to what is left", last.Timeout)
}

func CheckSkipModel(ctx *harness.Ctx) {
	clientSetup(ctx)
	ctx.GRPC.SetLatency("Identity", 0.025, "")
	ctx.GRPC.SetLatency("Contextual", 0.030, "")
	q := clientQuote(60)
	ctx.Equal(len(ctx.GRPC.CallsTo("Score", "")), 0, "the model was asked with 5 ms of the auction left: below modelMinMs = 20 the score is skipped; Score calls")
	clientDegraded(ctx, q, "with 5 ms left after the features")
	ctx.GRPC.SetLatency("Identity", 0, "")
	ctx.GRPC.SetLatency("Contextual", 0, "")
	q = clientQuote(100)
	ctx.Assert(len(ctx.GRPC.CallsTo("Score", "")) == 1 && q.BidCents == clientValue && !q.Degraded, "with the whole budget left the model must be asked once and its value bid, got %+v", q)
}

func CheckNoRetry(ctx *harness.Ctx) {
	clientSetup(ctx)
	ctx.GRPC.Fail("Identity", codes.Unavailable, "identity store restarting", 1, "")
	q := clientQuote(100)
	calls := len(ctx.GRPC.CallsTo("Identity", ""))
	ctx.Assert(calls == 1, "one failed identity lookup became %d Identity calls in one auction: a retry cannot finish inside the budget, degrade instead", calls)
	clientDegraded(ctx, q, "with the identity lookup failed")
}

func CheckDegradedFloor(ctx *harness.Ctx) {
	clientSetup(ctx)
	ctx.GRPC.Fail("Contextual", codes.Unavailable, "contextual tier down", 1, "")
	q := clientQuote(100)
	clientDegraded(ctx, q, "with the contextual tier down")
	ctx.Equal(len(ctx.GRPC.CallsTo("Score", "")), 0, "the model was scored on contextual features that never arrived; Score calls")
	ctx.GRPC.Fail("Identity", codes.Unavailable, "identity store restarting", 1, "")
	q = clientQuote(100)
	clientDegraded(ctx, q, "with the identity tier down")
	q = clientQuote(100)
	ctx.Assert(q.BidCents == clientValue && !q.Degraded && q.Reason == "", "once the tiers answer again the quote is %+v, expected the model's %d cents", q, clientValue)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <utility>
#include <vector>

#include "realtime_bidding.grpc.pb.h"
#include "rtb/deadline.h"

namespace {

constexpr long kFloor = 250;
constexpr long kValue = 310;

class FeaturesPeer final : public rtbfeatures::Features::Service {
 public:
  grpc::Status Identity(grpc::ServerContext*, const rtbfeatures::IdentityRequest*, rtbfeatures::IdentityFeatures* out) override {
    out->set_segment("sports");
    out->set_frequency(2);
    return grpc::Status::OK;
  }
  grpc::Status Contextual(grpc::ServerContext*, const rtbfeatures::ContextRequest*, rtbfeatures::ContextFeatures* out) override {
    out->set_category("news");
    out->set_viewability_pct(70);
    return grpc::Status::OK;
  }
};

class ScorerPeer final : public rtbfeatures::Scorer::Service {
 public:
  grpc::Status Score(grpc::ServerContext*, const rtbfeatures::ScoreRequest*, rtbfeatures::ScoreReply* out) override {
    out->set_value_cents(kValue);
    return grpc::Status::OK;
  }
};

struct Peers {
  FeaturesPeer features;
  ScorerPeer scorer;
};

void clientSetup(harness::Ctx& ctx) {
  static Peers* peers = nullptr;
  delete peers;
  peers = new Peers;
  ctx.GRPC.Server("")->RegisterService(&peers->features);
  ctx.GRPC.Server("")->RegisterService(&peers->scorer);
}

Quote clientQuote(harness::Ctx& ctx, long budget_ms) {
  try {
    return quoteBid("u-9", "a-1", kFloor, rtb::Deadline::start(budget_ms));
  } catch (const std::exception& e) {
    ctx.Fatalf("quoteBid threw %s: %s. A failed or late tier degrades the bid, it does not fail the auction", harness::CurrentExceptionType(), e.what());
  }
  return {};
}

void clientDegraded(harness::Ctx& ctx, const Quote& q, const std::string& why) {
  ctx.Assert(q.degraded && q.bid_cents == kFloor && !q.reason.empty(),
             "%s the quote is {bid_cents %d, degraded %t, reason %q}: it must bid the floor (%d), marked degraded, with a reason", why, q.bid_cents,
             q.degraded, q.reason, kFloor);
}

}  // namespace

void CheckTierDeadlines(harness::Ctx& ctx) {
  clientSetup(ctx);
  Quote q = clientQuote(ctx, 100);
  ctx.Assert(q.bid_cents == kValue && !q.degraded, "with every service healthy the quote is %d cents (degraded %t), expected the model's %d cents, not degraded", q.bid_cents, q.degraded, kValue);
  for (const auto& [method, slice_ms] : std::vector<std::pair<std::string, double>>{{"Identity", 30}, {"Contextual", 50}}) {
    const auto calls = ctx.GRPC.CallsTo(method);
    ctx.Assert(!calls.empty(), "no %s call was made", method);
    for (const auto& call : calls) {
      ctx.Assert(call.HasDeadline(), "the %s call carries no deadline: a slow feature service holds the whole auction", method);
      ctx.Assert(call.TimeoutSeconds() > 0 && call.TimeoutSeconds() <= slice_ms / 1000 + 0.001, "the %s call carries a %v s deadline, expected its slice of %v ms", method, call.TimeoutSeconds(), slice_ms);
    }
  }
  ctx.GRPC.SetLatency("Identity", 0.2);
  const int64_t started = ctx.Clock.Now();
  q = clientQuote(ctx, 100);
  const int64_t took = ctx.Clock.Now() - started;
  ctx.Assert(took <= 31, "an identity service answering in 200 ms held the quote for %d ms: identity gets its 30 ms slice, not the auction", took);
  clientDegraded(ctx, q, "with identity slower than its slice");
  ctx.GRPC.SetLatency("Identity", 0.025);
  clientQuote(ctx, 40);
  const auto calls = ctx.GRPC.CallsTo("Contextual");
  const auto& last = calls.back();
  ctx.Assert(last.HasDeadline() && last.TimeoutSeconds() <= 0.0151, "with 15 ms of the auction left the contextual call got a %v s deadline: a slice is clamped to what is left", last.TimeoutSeconds());
}

void CheckSkipModel(harness::Ctx& ctx) {
  clientSetup(ctx);
  ctx.GRPC.SetLatency("Identity", 0.025);
  ctx.GRPC.SetLatency("Contextual", 0.030);
  Quote q = clientQuote(ctx, 60);
  ctx.Equal(ctx.GRPC.CallsTo("Score").size(), 0, "the model was asked with 5 ms of the auction left: below kModelMinMs = 20 the score is skipped; Score calls");
  clientDegraded(ctx, q, "with 5 ms left after the features");
  ctx.GRPC.SetLatency("Identity", 0);
  ctx.GRPC.SetLatency("Contextual", 0);
  q = clientQuote(ctx, 100);
  ctx.Assert(ctx.GRPC.CallsTo("Score").size() == 1 && q.bid_cents == kValue && !q.degraded, "with the whole budget left the model must be asked once and its value bid, got %d cents (degraded %t)", q.bid_cents, q.degraded);
}

void CheckNoRetry(harness::Ctx& ctx) {
  clientSetup(ctx);
  ctx.GRPC.Fail("Identity", grpc::StatusCode::UNAVAILABLE, "identity store restarting", 1);
  const Quote q = clientQuote(ctx, 100);
  const size_t calls = ctx.GRPC.CallsTo("Identity").size();
  ctx.Assert(calls == 1, "one failed identity lookup became %d Identity calls in one auction: a retry cannot finish inside the budget, degrade instead", calls);
  clientDegraded(ctx, q, "with the identity lookup failed");
}

void CheckDegradedFloor(harness::Ctx& ctx) {
  clientSetup(ctx);
  ctx.GRPC.Fail("Contextual", grpc::StatusCode::UNAVAILABLE, "contextual tier down", 1);
  Quote q = clientQuote(ctx, 100);
  clientDegraded(ctx, q, "with the contextual tier down");
  ctx.Equal(ctx.GRPC.CallsTo("Score").size(), 0, "the model was scored on contextual features that never arrived; Score calls");
  ctx.GRPC.Fail("Identity", grpc::StatusCode::UNAVAILABLE, "identity store restarting", 1);
  q = clientQuote(ctx, 100);
  clientDegraded(ctx, q, "with the identity tier down");
  q = clientQuote(ctx, 100);
  ctx.Assert(q.bid_cents == kValue && !q.degraded && q.reason.empty(), "once the tiers answer again the quote is %d cents (degraded %t), expected the model's %d cents", q.bid_cents, q.degraded, kValue);
}
`,
  },
  hints: [
    'During a slow minute at the feature service every bid lands after the auction closed, and the bids that do land price users the feature service never described at the full model value.',
    'No call carries a deadline, so each waits for the service; the identity loop spends a second attempt the auction cannot afford; the score is requested whatever is left; a failed tier is replaced by empty features and scored.',
    'Pass `timeout=min(SLICE, deadline.remaining_ms()) / 1000` to each tier, call each once, skip `Score` when `remaining_ms() < MODEL_MIN_MS`, and return `Quote(floor_cents, True, reason)` on any failure or skip.',
  ],
  debrief: `A per-tier slice is a priority order written as numbers: identity may spend 30 ms, contextual 50, and whatever survives both decides whether the model runs. Clamping each slice to the auction's remaining time is what keeps a slow first tier from pushing the second one past the close, and the floor bid is what the bidder can still defend without the model: the cheapest price that can win, marked so the stats can count it. A retry fits a budget measured in seconds, not one measured in tens of milliseconds. Production bidders also cache identity features near the bidder and keep a per-tier latency histogram, so the slices can be tuned from the p99 rather than guessed.`,
};
