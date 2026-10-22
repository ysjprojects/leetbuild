import type {Step} from '@/lib/types';

/**
 * Step 3 — the feature client. Tiered deadlines, a model score that is skipped when the remaining
 * budget cannot fit it, and a conservative degraded bid instead of a late one.
 */
export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Feature calls with tiered degradation',
  concept: 'grpc',
  file: 'client',
  focus: ['bidding', 'features', 'model'],
  task: `## Task

**Review premise.** You are the AI platform engineer on call. The bidding service's p99 is 180 ms on a
100 ms budget, every bid is answered late, and the median response still carries a model score even
though the feature fetch alone consumed the auction. The model-generated client below waits the full
latency of both feature calls with no per-tier deadline, retries the identity lookup once inside the
auction, and scores the model unconditionally.

Review \`client\` and give each tier a slice of the auction budget, then prove the fix.

- Two feature tiers, each with its own slice of the budget: **identity at 30 ms** and **contextual at
  50 ms**. Define both as named constants.
- A tier may spend only \`min(remaining_ms, tier_ms)\` of the auction budget — never its full slice when
  less is left. Express that as one helper that both calls go through.
- The **model score is skipped entirely** when the remaining budget cannot fit it
  (\`remaining_ms() < MODEL_MIN_BUDGET_MS\`). A skipped model must not be replaced by a stale or a
  fabricated score.
- A skipped model (or a feature tier that failed) yields a **conservative bid**: priced at the floor,
  marked \`degraded\`, with a reason the stats read can count. Define it as a named function.
- **No tier retries**: one attempt per tier, inside that tier's slice. The draft's second identity
  attempt starts after the first timeout and eats whatever the remaining tiers needed.

**Failure mode the checks target.** The draft treats the auction budget as decoration. It waits the
feature service's own latency, retries the identity lookup once — a retry that cannot finish inside a
100 ms auction but is issued anyway — and then asks the model for a score no matter how little time is
left. The result is the symptom from the briefing: bids that are always late and a score that is only
ever computed from a budget that was already spent.`,
  sequence: {
    participants: ['Bidding service', 'Identity features', 'Contextual features', 'Model scorer'],
    messages: [
      {from: 'Bidding service', to: 'Bidding service', label: 'slice = min(remaining_ms, 30)', kind: 'sync'},
      {from: 'Bidding service', to: 'Identity features', label: 'Fetch(user_hash, deadline = 30 ms)', kind: 'sync'},
      {from: 'Identity features', to: 'Bidding service', label: 'identity features / DEADLINE_EXCEEDED', kind: 'reply'},
      {
        from: 'Bidding service',
        to: 'Contextual features',
        label: 'Fetch(auction_id, deadline = min(left, 50))',
        kind: 'sync',
      },
      {from: 'Contextual features', to: 'Bidding service', label: 'contextual features', kind: 'reply'},
      {
        from: 'Bidding service',
        to: 'Bidding service',
        label: 'left < MODEL_MIN_BUDGET_MS → skip the score',
        kind: 'sync',
      },
      {from: 'Bidding service', to: 'Bidding service', label: 'conservative_bid(floor, degraded)', kind: 'sync'},
      {from: 'Model scorer', to: 'Bidding service', label: 'score (only when it fits)', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'tier-deadlines',
      title: 'Identity gets 30 ms and contextual features get 50 ms',
      detail:
        'Both tiers carry their own named slice of the auction budget: identity **30 ms**, contextual **50 ms**. The draft has no per-tier budget at all, so each call runs to the feature service’s own timeout.',
      match: {
        python: {all: [/IDENTITY_DEADLINE_MS = 30/, /CONTEXT_DEADLINE_MS = 50/]},
        typescript: {all: [/IDENTITY_DEADLINE_MS = 30/, /CONTEXT_DEADLINE_MS = 50/]},
        go: {all: [/identityDeadlineMs\s+= 30/, /contextDeadlineMs\s+= 50/]},
        scala: {all: [/IdentityDeadlineMs = 30/, /ContextDeadlineMs = 50/]},
        cpp: {all: [/kIdentityDeadlineMs = 30/, /kContextDeadlineMs = 50/]},
      },
    },
    {
      id: 'budget-clamp',
      title: 'A tier spends the smaller of its slice and what is left',
      detail:
        'One helper computes `min(remaining_ms, tier_ms)` and both feature calls go through it, so a 30 ms slice inside a 20 ms budget is a 20 ms call. The draft passes no budget to either call.',
      match: {
        python: {all: [/def tier_slice\(/, /min\(deadline\.remaining_ms\(\), tier_ms\)/]},
        typescript: {
          all: [
            /function tierSlice\(/,
            /const remaining = Math\.max\(deadline\.remainingMs\(\), 0\)/,
            /if \(remaining < tierMs\) return remaining/,
          ],
        },
        go: {all: [/func tierSlice\(/, /remaining := d\.RemainingMs\(\)/, /if remaining < tierMs/]},
        scala: {all: [/def tierSlice\(/, /math\.min\(deadline\.remainingMs, tierMs\)/]},
        cpp: {all: [/int tierSlice\(/, /std::min\(deadline\.remainingMs\(\), tierMs\)/]},
      },
    },
    {
      id: 'skip-model',
      title: 'The model score is skipped when the budget cannot fit it',
      detail:
        'The remaining budget is compared against `MODEL_MIN_BUDGET_MS` before the scoring call, and the degraded flag is set when a tier fails or the score is skipped. The draft always scores.',
      match: {
        python: {all: [/remaining_ms\(\) < MODEL_MIN_BUDGET_MS/, /degraded = True/]},
        typescript: {all: [/remainingMs\(\) < MODEL_MIN_BUDGET_MS/, /degraded = true/]},
        go: {all: [/RemainingMs\(\) < modelMinBudgetMs/, /degraded = true/]},
        scala: {all: [/remainingMs\s*<\s*BidClient\.ModelMinBudgetMs/, /degraded = true/]},
        cpp: {all: [/remainingMs\(\) < kModelMinBudgetMs/, /degraded = true/]},
      },
    },
    {
      id: 'conservative-bid',
      title: 'A degraded path bids conservatively at the floor',
      detail:
        'A named `conservative_bid` prices the degraded bid at the floor and marks it `"degraded": true` with a reason, so the answer stays inside the auction and the stats can count it. The draft has no degraded path.',
      match: {
        python: {all: [/def conservative_bid\(/, /"degraded": True/]},
        typescript: {all: [/function conservativeBid\(/, /degraded: true/]},
        go: {all: [/func conservativeBid\(/, /"degraded": true/]},
        scala: {all: [/def conservativeBid\(/, /"degraded" -> true/]},
        cpp: {all: [/conservativeBid\(/, /"degraded":true/]},
      },
    },
    {
      id: 'no-retry',
      title: 'No tier retries inside the auction',
      detail:
        'Each tier is called once: a retry inside a 100 ms auction cannot complete anyway, and the attempt it burns is the attempt the remaining tiers needed. The draft loops the identity lookup twice.',
      match: {
        python: {all: [/self\.identity\.fetch\(/], none: [/for attempt in range\(/, /retry|sleep\(/i]},
        typescript: {all: [/deps\.identity\.fetch\(/], none: [/attempt|retry/i]},
        go: {all: [/identity\.Fetch\(/], none: [/attempt|retry/i]},
        scala: {all: [/identity\.fetch\(/], none: [/attempt|retry/i]},
        cpp: {all: [/identity_\.fetch\(/], none: [/attempt|retry/i]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

logger = logging.getLogger("bid-client")

FEATURE_TIMEOUT_S = 0.2


class BidClient:
    """Fetches the feature tiers over gRPC and scores the bid."""

    def __init__(self, identity, context, scorer, floor_cents: int) -> None:
        self.identity = identity
        self.context = context
        self.scorer = scorer
        self.floor_cents = floor_cents

    def collect(self, deadline, user_hash: str, auction_id: str) -> dict:
        # TODO: this draft gives neither tier a slice of the auction budget, retries the identity
        # lookup once (which cannot finish inside the auction and eats the remaining tiers), and
        # asks the model for a score even when nothing is left, so every bid is late.
        for attempt in range(2):
            try:
                identity = self.identity.fetch(user_hash, timeout=FEATURE_TIMEOUT_S)
                break
            except grpc.RpcError:
                identity = {}
        context = self.context.fetch(auction_id, timeout=FEATURE_TIMEOUT_S)
        score = self.scorer.score({**identity, **context}, timeout=FEATURE_TIMEOUT_S)
        return {"score": score, "bid_cents": max(self.floor_cents, score + 1), "degraded": False}
`,
      solution: `import logging

import grpc

logger = logging.getLogger("bid-client")

IDENTITY_DEADLINE_MS = 30
CONTEXT_DEADLINE_MS = 50
MODEL_MIN_BUDGET_MS = 40


def tier_slice(deadline, tier_ms: int) -> int:
    """The slice of the auction budget this tier may spend: never more than what is left."""
    return min(deadline.remaining_ms(), tier_ms)


def conservative_bid(deadline, floor_cents: int, reason: str) -> dict:
    """A degraded bid: priced at the floor and marked, not a fabricated score."""
    left = deadline.remaining_ms()
    logger.info("conservative bid floor=%d reason=%s left=%d", floor_cents, reason, left)
    return {"bid_cents": floor_cents, "degraded": True, "reason": reason}


class BidClient:
    """Fetches the feature tiers over gRPC inside their slices and scores only what fits."""

    def __init__(self, identity, context, scorer, floor_cents: int) -> None:
        self.identity = identity
        self.context = context
        self.scorer = scorer
        self.floor_cents = floor_cents

    def collect(self, deadline, user_hash: str, auction_id: str) -> dict:
        degraded = False
        identity = {}
        try:
            identity = self.identity.fetch(user_hash, budget_ms=tier_slice(deadline, IDENTITY_DEADLINE_MS))
        except grpc.RpcError:
            degraded = True

        context = {}
        try:
            context = self.context.fetch(auction_id, budget_ms=tier_slice(deadline, CONTEXT_DEADLINE_MS))
        except grpc.RpcError:
            degraded = True

        if deadline.remaining_ms() < MODEL_MIN_BUDGET_MS:
            return conservative_bid(deadline, self.floor_cents, "model_skipped")

        score = self.scorer.score({**identity, **context}, budget_ms=deadline.remaining_ms())
        if degraded:
            return conservative_bid(deadline, self.floor_cents, "tier_degraded")
        return {"score": score, "bid_cents": max(self.floor_cents, score + 1), "degraded": False}
`,
    },
    typescript: {
      starter: `/** Feature tiers and the model score, over gRPC. */
import * as grpc from '@grpc/grpc-js';

interface IdentityClient {
  fetch(userHash: string, options: {timeoutS: number}): Promise<Record<string, number>>;
}

interface ContextClient {
  fetch(auctionId: string, options: {timeoutS: number}): Promise<Record<string, number>>;
}

interface Scorer {
  score(features: Record<string, number>, options: {timeoutS: number}): Promise<number>;
}

const FEATURE_TIMEOUT_S = 0.2;

export class BidClient {
  constructor(
    private readonly deps: {identity: IdentityClient; context: ContextClient; scorer: Scorer},
    private readonly floorCents: number,
  ) {}

  async collect(deadline: {remainingMs(): number}, userHash: string, auctionId: string) {
    // TODO: this draft gives neither tier a slice of the auction budget, retries the identity
    // lookup once (which cannot finish inside the auction and eats the remaining tiers), and asks
    // the model for a score even when nothing is left, so every bid is late.
    let identity: Record<string, number> = {};
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        identity = await this.deps.identity.fetch(userHash, {timeoutS: FEATURE_TIMEOUT_S});
        break;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        identity = {};
      }
    }
    const context = await this.deps.context.fetch(auctionId, {timeoutS: FEATURE_TIMEOUT_S});
    const score = await this.deps.scorer.score({...identity, ...context}, {timeoutS: FEATURE_TIMEOUT_S});
    return {score, bid_cents: Math.max(this.floorCents, score + 1), degraded: false};
  }
}

export const grpcStatus = grpc.status;
`,
      solution: `/** Feature tiers and the model score, each inside its slice of the auction budget. */
import * as grpc from '@grpc/grpc-js';

const IDENTITY_DEADLINE_MS = 30;
const CONTEXT_DEADLINE_MS = 50;
const MODEL_MIN_BUDGET_MS = 40;

interface Deadline {
  remainingMs(): number;
}

interface IdentityClient {
  fetch(userHash: string, options: {budgetMs: number}): Promise<Record<string, number>>;
}

interface ContextClient {
  fetch(auctionId: string, options: {budgetMs: number}): Promise<Record<string, number>>;
}

interface Scorer {
  score(features: Record<string, number>, options: {budgetMs: number}): Promise<number>;
}

/** The slice of the auction budget this tier may spend: never more than what is left. */
function tierSlice(deadline: Deadline, tierMs: number): number {
  const remaining = Math.max(deadline.remainingMs(), 0);
  if (remaining < tierMs) return remaining;
  return tierMs;
}

/** A degraded bid: priced at the floor and marked, not a fabricated score. */
function conservativeBid(deadline: Deadline, floorCents: number, reason: string) {
  const left = Math.max(deadline.remainingMs(), 0);
  console.info({floorCents, reason, left}, 'conservative bid');
  return {bid_cents: floorCents, degraded: true, reason};
}

export class BidClient {
  constructor(
    private readonly deps: {identity: IdentityClient; context: ContextClient; scorer: Scorer},
    private readonly floorCents: number,
  ) {}

  async collect(deadline: Deadline, userHash: string, auctionId: string) {
    let degraded = false;
    let identity: Record<string, number> = {};
    try {
      identity = await this.deps.identity.fetch(userHash, {budgetMs: tierSlice(deadline, IDENTITY_DEADLINE_MS)});
    } catch {
      degraded = true;
    }

    let context: Record<string, number> = {};
    try {
      context = await this.deps.context.fetch(auctionId, {budgetMs: tierSlice(deadline, CONTEXT_DEADLINE_MS)});
    } catch {
      degraded = true;
    }

    if (deadline.remainingMs() < MODEL_MIN_BUDGET_MS) {
      return conservativeBid(deadline, this.floorCents, 'model_skipped');
    }

    const score = await this.deps.scorer.score({...identity, ...context}, {budgetMs: deadline.remainingMs()});
    if (degraded) return conservativeBid(deadline, this.floorCents, 'tier_degraded');
    return {score, bid_cents: Math.max(this.floorCents, score + 1), degraded: false};
  }
}

export const grpcStatus = grpc.status;
`,
    },
    go: {
      starter: `package client

import (
	"context"
	"log"
	"time"
)

const featureTimeout = 200 * time.Millisecond

type IdentityClient interface {
	Fetch(ctx context.Context, userHash string, timeout time.Duration) (map[string]float64, error)
}

type ContextClient interface {
	Fetch(ctx context.Context, auctionID string, timeout time.Duration) (map[string]float64, error)
}

type Scorer interface {
	Score(ctx context.Context, features map[string]float64, timeout time.Duration) (int, error)
}

type BidClient struct {
	identity   IdentityClient
	context    ContextClient
	scorer     Scorer
	floorCents int
}

func (c *BidClient) Collect(ctx context.Context, deadline *Deadline, userHash, auctionID string) map[string]any {
	// TODO: this draft gives neither tier a slice of the auction budget, retries the identity
	// lookup once (which cannot finish inside the auction and eats the remaining tiers), and asks
	// the model for a score even when nothing is left, so every bid is late.
	var identity map[string]float64
	for attempt := 0; attempt < 2; attempt++ {
		feats, err := c.identity.Fetch(ctx, userHash, featureTimeout)
		if err == nil {
			identity = feats
			break
		}
	}
	context_, _ := c.context.Fetch(ctx, auctionID, featureTimeout)
	merged := map[string]float64{}
	for k, v := range identity {
		merged[k] = v
	}
	for k, v := range context_ {
		merged[k] = v
	}
	score, _ := c.scorer.Score(ctx, merged, featureTimeout)
	bidCents := c.floorCents
	if score+1 > bidCents {
		bidCents = score + 1
	}
	log.Printf("collected score=%d bid=%d", score, bidCents)
	return map[string]any{"score": score, "bid_cents": bidCents, "degraded": false}
}
`,
      solution: `package client

import (
	"context"
	"log"
)

const (
	identityDeadlineMs = 30
	contextDeadlineMs  = 50
	modelMinBudgetMs   = 40
)

type Deadline struct {
	remainingMs int
}

func (d *Deadline) RemainingMs() int {
	return d.remainingMs
}

type IdentityClient interface {
	Fetch(ctx context.Context, userHash string, budgetMs int) (map[string]float64, error)
}

type ContextClient interface {
	Fetch(ctx context.Context, auctionID string, budgetMs int) (map[string]float64, error)
}

type Scorer interface {
	Score(ctx context.Context, features map[string]float64, budgetMs int) (int, error)
}

// tierSlice is the slice of the auction budget this tier may spend: never more than what is left.
func tierSlice(d *Deadline, tierMs int) int {
	remaining := d.RemainingMs()
	if remaining < tierMs {
		return remaining
	}
	return tierMs
}

// conservativeBid prices a degraded bid at the floor and marks it, instead of inventing a score.
func conservativeBid(floorCents int, reason string) map[string]any {
	log.Printf("conservative bid floor=%d reason=%s", floorCents, reason)
	return map[string]any{"bid_cents": floorCents, "degraded": true, "reason": reason}
}

type BidClient struct {
	identity   IdentityClient
	context    ContextClient
	scorer     Scorer
	floorCents int
}

func (c *BidClient) Collect(ctx context.Context, deadline *Deadline, userHash, auctionID string) map[string]any {
	degraded := false
	merged := map[string]float64{}

	identity, err := c.identity.Fetch(ctx, userHash, tierSlice(deadline, identityDeadlineMs))
	if err != nil {
		degraded = true
	}
	for k, v := range identity {
		merged[k] = v
	}

	context_, err := c.context.Fetch(ctx, auctionID, tierSlice(deadline, contextDeadlineMs))
	if err != nil {
		degraded = true
	}
	for k, v := range context_ {
		merged[k] = v
	}

	if deadline.RemainingMs() < modelMinBudgetMs {
		return conservativeBid(c.floorCents, "model_skipped")
	}

	score, err := c.scorer.Score(ctx, merged, deadline.RemainingMs())
	if err != nil || degraded {
		return conservativeBid(c.floorCents, "tier_degraded")
	}
	bidCents := c.floorCents
	if score+1 > bidCents {
		bidCents = score + 1
	}
	return map[string]any{"score": score, "bid_cents": bidCents, "degraded": false}
}
`,
    },
    scala: {
      starter: `import scala.util.control.NonFatal

trait IdentityFeatures {
  def fetch(userHash: String, timeoutS: Double): Map[String, Double]
}

trait ContextFeatures {
  def fetch(auctionId: String, timeoutS: Double): Map[String, Double]
}

trait ScoreClient {
  def score(features: Map[String, Double], timeoutS: Double): Int
}

class BidClient(identity: IdentityFeatures, context: ContextFeatures, scorer: ScoreClient, floorCents: Int) {

  val FeatureTimeoutS = 0.2

  def collect(deadline: Deadline, userHash: String, auctionId: String): Map[String, Any] = {
    // TODO: this draft gives neither tier a slice of the auction budget, retries the identity
    // lookup once (which cannot finish inside the auction and eats the remaining tiers), and asks
    // the model for a score even when nothing is left, so every bid is late.
    var identityFeatures = Map.empty[String, Double]
    var attempt = 0
    while (attempt < 2 && identityFeatures.isEmpty) {
      try {
        identityFeatures = identity.fetch(userHash, FeatureTimeoutS)
      } catch {
        case NonFatal(_) => identityFeatures = Map.empty
      }
      attempt += 1
    }
    val contextFeatures = context.fetch(auctionId, FeatureTimeoutS)
    val score = scorer.score(identityFeatures ++ contextFeatures, FeatureTimeoutS)
    Map("score" -> score, "bid_cents" -> math.max(floorCents, score + 1), "degraded" -> false)
  }
}
`,
      solution: `trait IdentityFeatures {
  def fetch(userHash: String, budgetMs: Int): Map[String, Double]
}

trait ContextFeatures {
  def fetch(auctionId: String, budgetMs: Int): Map[String, Double]
}

trait ScoreClient {
  def score(features: Map[String, Double], budgetMs: Int): Int
}

object BidClient {
  val IdentityDeadlineMs = 30
  val ContextDeadlineMs = 50
  val ModelMinBudgetMs = 40

  /** The slice of the auction budget this tier may spend: never more than what is left. */
  def tierSlice(deadline: Deadline, tierMs: Int): Int = math.min(deadline.remainingMs, tierMs)

  /** A degraded bid: priced at the floor and marked, not a fabricated score. */
  def conservativeBid(floorCents: Int, reason: String): Map[String, Any] = {
    println(s"conservative bid floor=$floorCents reason=$reason")
    Map("bid_cents" -> floorCents, "degraded" -> true, "reason" -> reason)
  }
}

class BidClient(identity: IdentityFeatures, context: ContextFeatures, scorer: ScoreClient, floorCents: Int) {

  def collect(deadline: Deadline, userHash: String, auctionId: String): Map[String, Any] = {
    var degraded = false

    val identityFeatures =
      try identity.fetch(userHash, BidClient.tierSlice(deadline, BidClient.IdentityDeadlineMs))
      catch {
        case _: RuntimeException =>
          degraded = true
          Map.empty[String, Double]
      }

    val contextFeatures =
      try context.fetch(auctionId, BidClient.tierSlice(deadline, BidClient.ContextDeadlineMs))
      catch {
        case _: RuntimeException =>
          degraded = true
          Map.empty[String, Double]
      }

    if (deadline.remainingMs < BidClient.ModelMinBudgetMs) {
      BidClient.conservativeBid(floorCents, "model_skipped")
    } else {
      val score = scorer.score(identityFeatures ++ contextFeatures, deadline.remainingMs)
      if (degraded) BidClient.conservativeBid(floorCents, "tier_degraded")
      else Map("score" -> score, "bid_cents" -> math.max(floorCents, score + 1), "degraded" -> false)
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <iostream>
#include <map>
#include <string>

struct IdentityClient {
  std::map<std::string, double> fetch(const std::string& userHash, double timeoutS);
};

struct ContextClient {
  std::map<std::string, double> fetch(const std::string& auctionId, double timeoutS);
};

struct Scorer {
  int score(const std::map<std::string, double>& features, double timeoutS);
};

constexpr double kFeatureTimeoutS = 0.2;

class BidClient {
 public:
  BidClient(IdentityClient& identity, ContextClient& context, Scorer& scorer, int floorCents)
      : identity_(identity), context_(context), scorer_(scorer), floorCents_(floorCents) {}

  std::map<std::string, int> collect(const std::string& userHash, const std::string& auctionId) {
    // TODO: this draft gives neither tier a slice of the auction budget, retries the identity
    // lookup once (which cannot finish inside the auction and eats the remaining tiers), and asks
    // the model for a score even when nothing is left, so every bid is late.
    std::map<std::string, double> features;
    for (int attempt = 0; attempt < 2 && features.empty(); ++attempt) {
      features = identity_.fetch(userHash, kFeatureTimeoutS);
    }
    const auto context = context_.fetch(auctionId, kFeatureTimeoutS);
    features.insert(context.begin(), context.end());
    const int score = scorer_.score(features, kFeatureTimeoutS);
    std::cerr << "collected score=" << score << "\\n";
    return {{"score", score}, {"bid_cents", std::max(floorCents_, score + 1)}, {"degraded", 0}};
  }

 private:
  IdentityClient& identity_;
  ContextClient& context_;
  Scorer& scorer_;
  int floorCents_;
};
`,
      solution: `#include <algorithm>
#include <iostream>
#include <map>
#include <optional>
#include <string>

struct Deadline {
  int remainingMs() const;
};

struct IdentityClient {
  std::map<std::string, double> fetch(const std::string& userHash, int budgetMs);
};

struct ContextClient {
  std::map<std::string, double> fetch(const std::string& auctionId, int budgetMs);
};

struct Scorer {
  int score(const std::map<std::string, double>& features, int budgetMs);
};

constexpr int kIdentityDeadlineMs = 30;
constexpr int kContextDeadlineMs = 50;
constexpr int kModelMinBudgetMs = 40;

/** The slice of the auction budget this tier may spend: never more than what is left. */
int tierSlice(const Deadline& deadline, int tierMs) {
  return std::min(deadline.remainingMs(), tierMs);
}

/** A degraded bid: priced at the floor and marked, not a fabricated score. */
std::string conservativeBid(int floorCents, const std::string& reason) {
  std::cerr << "conservative bid floor=" << floorCents << " reason=" << reason << "\\n";
  return R"({"bid_cents":)" + std::to_string(floorCents) + R"(,"degraded":true,"reason":")" + reason + R"("})";
}

class BidClient {
 public:
  BidClient(IdentityClient& identity, ContextClient& context, Scorer& scorer, int floorCents)
      : identity_(identity), context_(context), scorer_(scorer), floorCents_(floorCents) {}

  std::string collect(const Deadline& deadline, const std::string& userHash, const std::string& auctionId) {
    bool degraded = false;
    std::map<std::string, double> features;

    try {
      const auto identity =
          identity_.fetch(userHash, tierSlice(deadline, kIdentityDeadlineMs));
      features.insert(identity.begin(), identity.end());
    } catch (const std::exception&) {
      degraded = true;
    }

    try {
      const auto context =
          context_.fetch(auctionId, tierSlice(deadline, kContextDeadlineMs));
      features.insert(context.begin(), context.end());
    } catch (const std::exception&) {
      degraded = true;
    }

    if (deadline.remainingMs() < kModelMinBudgetMs) {
      return conservativeBid(floorCents_, "model_skipped");
    }

    const int score = scorer_.score(features, deadline.remainingMs());
    if (degraded) return conservativeBid(floorCents_, "tier_degraded");
    return R"({"score":)" + std::to_string(score) + R"(,"bid_cents":)" +
           std::to_string(std::max(floorCents_, score + 1)) + R"(,"degraded":false})";
  }

 private:
  IdentityClient& identity_;
  ContextClient& context_;
  Scorer& scorer_;
  int floorCents_;
};
`,
    },
  },
  hints: [
    'Name the slices: `IDENTITY_DEADLINE_MS = 30`, `CONTEXT_DEADLINE_MS = 50`, and a helper that returns `min(remaining_ms, tier_ms)`. A tier that always gets its full slice is a tier that does not know the auction is nearly over.',
    'Skip, do not guess: before the scoring call compare `remaining_ms() < MODEL_MIN_BUDGET_MS` and return a conservative bid at the floor, marked degraded. A score computed from an exhausted budget is a fabricated one, and it is worse than an honest low bid.',
    'Delete the retry. One attempt per tier, inside its slice — a second identity attempt after a 30 ms timeout is issued into a budget that no longer exists, and whatever it burns is what the contextual tier and the model needed.',
  ],
  debrief: `The interviewer is testing whether you can turn a latency budget into a decision policy. The draft
reads fine because the feature service is fast in the demo, so nobody notices that the auction's 100 ms
is never consulted.

Three defects are being checked. Tiered budgets: each feature tier gets a named slice, clamped to what
is left, so a slow identity lookup shortens the contextual fetch instead of pushing the bid past the
close. Graceful degradation: when the remaining budget cannot fit the model, the correct answer is a
conservative bid at the floor marked \`degraded\`, and the stats read later counts it — an honest cheap
bid wins a floor auction, a fabricated score wins a bad one. Retries: inside a 100 ms auction a retry
is not resilience, it is spending someone else's slice, and the identity tier's second attempt is
exactly why the contextual fetch then times out.

Real bidders go further: they keep a per-tier budget table ordered by value, drop the cheapest tier
first when the deadline tightens, and shadow-test a degraded path against a no-bid to learn whether a
floor bid is worth placing at all.`,
};
