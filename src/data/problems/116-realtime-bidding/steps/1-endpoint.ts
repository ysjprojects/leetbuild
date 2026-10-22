import type {Step} from '@/lib/types';

/**
 * Step 1 — the bid endpoint. One auction budget, started once, shared by every downstream call, and
 * a graceful no-bid when the budget cannot cover another stage.
 */
export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/bids: a request with a deadline the caller sets',
  concept: 'http',
  file: 'api',
  focus: ['exchange', 'bidding', 'features', 'creatives'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, decodes
the body, calls the feature service, the scorer and the creative cache and returns a bid. It
compiles, it answers the demo request, and it hides three production flaws. Review it like the
service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/bids\` with body
\`{"auction_id": "a-1", "floor_cents": 250, "timeout_ms": 100, "user_hash": "u-9"}\`.

- The bidder comes from the authenticated \`X-Bidder-Id\` header; a missing bidder is **401**.
- \`auction_id\` is a non-empty string (**400** otherwise).
- \`timeout_ms\` is the auction's **total** budget: an integer from **1** to **200**, defaulting to
  **100**; anything else is **400**.
- \`floor_cents\` is an integer from **0** to **1 000 000**; a negative or absurd floor is **400**.
  The draft accepts both, so \`max(floor_cents, score + 1)\` turns a negative floor into a
  nonsense bid that wins the auction and loses money.
- The budget is started **once**, at the top of the handler, as a \`Deadline\`/clock object; every
  downstream call is handed \`remaining_ms()\` (\`budget_ms=\` / \`budgetMs:\` / \`BudgetMs:\`) instead of
  a fresh full timeout. The feature fetch, the creative lookup and the scoring call all spend from
  the same budget.
- Before spending on the next stage, compare the remaining budget against a floor
  (\`MIN_BID_MS\`) and, when the request cannot finish inside the auction's budget, abandon
  gracefully: **200** with \`{"auction_id": …, "bid": null, "reason": "deadline_exceeded",
  "degraded": true}\`. A late bid is worse than no bid — the auction has already closed.
- A bid that did finish returns \`{"auction_id", "bid_cents", "creative_id", "degraded"}\`.

**Failure mode the checks target.** The draft never reads \`timeout_ms\`, so the budget exists only in
the caller's head: features, scoring and the creative cache run back to back at their own latency and
the response lands after the exchange's 100 ms close. It validates nothing either, so one negative
\`floor_cents\` produces a bid the bidder cannot afford. The checks below require the validation
funnel, one shared deadline that reaches every stage, and a no-bid path that answers inside the
budget.`,
  sequence: {
    participants: ['Ad exchange', 'Bidding service', 'Feature service', 'Creative cache'],
    messages: [
      {from: 'Ad exchange', to: 'Bidding service', label: 'POST /v1/bids · timeout_ms = 100', kind: 'sync'},
      {from: 'Bidding service', to: 'Bidding service', label: 'Deadline.start(timeout_ms)', kind: 'sync'},
      {from: 'Bidding service', to: 'Feature service', label: 'Fetch(user_hash, budget_ms = 100)', kind: 'sync'},
      {from: 'Feature service', to: 'Bidding service', label: 'identity + contextual features', kind: 'reply'},
      {from: 'Bidding service', to: 'Creative cache', label: 'Pick(auction_id, budget_ms = 61)', kind: 'sync'},
      {from: 'Creative cache', to: 'Bidding service', label: 'creative', kind: 'reply'},
      {from: 'Bidding service', to: 'Bidding service', label: 'remaining_ms() < MIN_BID_MS → no bid', kind: 'sync'},
      {from: 'Bidding service', to: 'Ad exchange', label: '200 {bid_cents} / 200 {bid: null}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/bids',
      detail: 'Register the bid route on `POST /v1/bids`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/bids["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/bids['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/bids"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"bids"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/bids"/]},
      },
    },
    {
      id: 'validate',
      title: 'Rejects a negative floor and a nonsense budget with 400',
      detail:
        '`floor_cents` must be an integer in 0..1 000 000 and `timeout_ms` in 1..200, both **400** on violation. The draft validates neither, so a negative floor becomes a winning bid and a 5 s `timeout_ms` becomes a budget the exchange never offered.',
      match: {
        python: {all: [/MAX_FLOOR_CENTS/, /MAX_BUDGET_MS/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_FLOOR_CENTS/, /MAX_BUDGET_MS/, /code\(\s*400\s*\)/]},
        go: {all: [/maxFloorCents/, /maxBudgetMs/, /StatusBadRequest/]},
        scala: {all: [/MaxFloorCents/, /MaxBudgetMs/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxFloorCents/, /kMaxBudgetMs/, /\b400\b/]},
      },
    },
    {
      id: 'deadline',
      title: 'Starts one deadline and hands its remaining time to every stage',
      detail:
        'The budget is started once at the top of the handler and each downstream call receives `remaining_ms()` of that same deadline — never a fresh full timeout. The draft passes no budget at all, so every stage waits its own full latency.',
      match: {
        python: {all: [/class Deadline/, /def remaining_ms\(/, /Deadline\.start\(/]},
        typescript: {all: [/class Deadline/, /remainingMs\(\)/, /Deadline\.start\(/]},
        go: {all: [/type Deadline struct/, /func \(d \*Deadline\) RemainingMs\(\)/, /startDeadline\(/]},
        scala: {all: [/class Deadline/, /def remainingMs/, /Deadline\.start\(/]},
        cpp: {all: [/class Deadline/, /remainingMs\(\)/, /Deadline::start\(/]},
      },
    },
    {
      id: 'budget-shared',
      title: 'No stage starts without checking what is left',
      detail:
        'The remaining budget is compared against the minimum a bid needs before the next stage runs, and each stage is called with the remaining budget. The draft calls features, the scorer and the creative cache in sequence with no guard.',
      match: {
        python: {all: [/remaining_ms\(\)\s*<\s*MIN_BID_MS/, /budget_ms\s*=\s*deadline\.remaining_ms\(\)/]},
        typescript: {all: [/remainingMs\(\)\s*<\s*MIN_BID_MS/, /budgetMs:\s*deadline\.remainingMs\(\)/]},
        go: {all: [/RemainingMs\(\)\s*<\s*minBidMs/, /,\s*deadline\.RemainingMs\(\)/]},
        scala: {all: [/remainingMs\s*<\s*MinBidMs/, /budgetMs\s*=\s*deadline\.remainingMs/]},
        cpp: {all: [/remainingMs\(\)\s*<\s*kMinBidMs/, /,\s*deadline\.remainingMs\(\)/]},
      },
    },
    {
      id: 'no-late-bid',
      title: 'Abandons with a marked no-bid instead of a late bid',
      detail:
        'A request that cannot finish inside the budget answers 200 with `bid: null` and `reason: "deadline_exceeded"`, so the exchange gets an honest no-bid. The draft always answers with a bid, even one that arrives after the close.',
      match: {
        python: {all: [/no_bid\(/, /deadline_exceeded/, /"bid": None/]},
        typescript: {all: [/noBid\(/, /deadline_exceeded/, /bid: null/]},
        go: {all: [/noBid\(/, /deadline_exceeded/, /"bid":\s+nil/]},
        scala: {all: [/noBid\(/, /deadline_exceeded/, /"bid":null/]},
        cpp: {all: [/noBid\(/, /deadline_exceeded/, /"bid", nullptr/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("bidding")


class BidRequest(BaseModel):
    auction_id: str
    floor_cents: int
    timeout_ms: int = 100
    user_hash: str


class Features:
    def fetch(self, user_hash: str, budget_ms: int) -> dict:
        """Identity and contextual features for the user, over the feature service."""
        raise NotImplementedError


class Scorer:
    def score(self, features: dict, budget_ms: int) -> int:
        """The model's estimate of the winning bid, in cents."""
        raise NotImplementedError


class Creatives:
    def pick(self, auction_id: str, budget_ms: int) -> dict:
        """The creative the exchange has already pre-rendered for this auction."""
        raise NotImplementedError


features = Features()
scorer = Scorer()
creatives = Creatives()


@app.post("/v1/bids")
def bid(body: BidRequest, bidder: str = Header(alias="X-Bidder-Id")) -> JSONResponse:
    # TODO: this draft never reads timeout_ms, so no stage shares the auction's budget: features,
    # the scorer and the creative cache run back to back at their own latency and the bid lands
    # after the exchange closed. It also validates nothing, so a negative floor_cents produces a
    # nonsense bid. Review all three.
    feats = features.fetch(body.user_hash, budget_ms=body.timeout_ms)
    score = scorer.score(feats, budget_ms=body.timeout_ms)
    creative = creatives.pick(body.auction_id, budget_ms=body.timeout_ms)
    bid_cents = max(body.floor_cents, score + 1)
    logger.info("bid auction=%s bidder=%s cents=%d", body.auction_id, bidder, bid_cents)
    return JSONResponse(
        {"auction_id": body.auction_id, "bid_cents": bid_cents, "creative_id": creative["id"]},
        status_code=200,
    )
`,
      solution: `import logging
import time

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("bidding")

MIN_BUDGET_MS = 1
MAX_BUDGET_MS = 200
DEFAULT_BUDGET_MS = 100
MAX_FLOOR_CENTS = 1_000_000
MIN_BID_MS = 5


class Deadline:
    """The auction's budget, started once and shared by every downstream call."""

    def __init__(self, budget_ms: int) -> None:
        self.budget_ms = budget_ms
        self.started = time.monotonic()

    @classmethod
    def start(cls, budget_ms: int) -> "Deadline":
        return cls(budget_ms)

    def remaining_ms(self) -> int:
        return self.budget_ms - int((time.monotonic() - self.started) * 1000)


class BidRequest(BaseModel):
    auction_id: str
    floor_cents: int
    timeout_ms: int = DEFAULT_BUDGET_MS
    user_hash: str


class Features:
    def fetch(self, user_hash: str, budget_ms: int) -> dict:
        """Identity and contextual features for the user, over the feature service."""
        raise NotImplementedError


class Scorer:
    def score(self, features: dict, budget_ms: int) -> int:
        """The model's estimate of the winning bid, in cents."""
        raise NotImplementedError


class Creatives:
    def pick(self, auction_id: str, budget_ms: int) -> dict:
        """The creative the exchange has already pre-rendered for this auction."""
        raise NotImplementedError


features = Features()
scorer = Scorer()
creatives = Creatives()


def no_bid(auction_id: str, reason: str) -> JSONResponse:
    """Nothing that can finish inside the budget: answer the exchange instead of bidding late."""
    logger.info("no-bid auction=%s reason=%s", auction_id, reason)
    return JSONResponse(
        {"auction_id": auction_id, "bid": None, "reason": reason, "degraded": True},
        status_code=200,
    )


@app.post("/v1/bids")
def bid(body: BidRequest, bidder: str | None = Header(default=None, alias="X-Bidder-Id")) -> JSONResponse:
    if bidder is None or bidder == "":
        raise HTTPException(status_code=401, detail="missing X-Bidder-Id")
    if body.auction_id == "":
        raise HTTPException(status_code=400, detail="auction_id is required")
    if not MIN_BUDGET_MS <= body.timeout_ms <= MAX_BUDGET_MS:
        raise HTTPException(status_code=400, detail="timeout_ms must be 1..200")
    if body.floor_cents < 0 or body.floor_cents > MAX_FLOOR_CENTS:
        raise HTTPException(status_code=400, detail="floor_cents is out of range")

    deadline = Deadline.start(body.timeout_ms)
    feats = features.fetch(body.user_hash, budget_ms=deadline.remaining_ms())
    if deadline.remaining_ms() < MIN_BID_MS:
        return no_bid(body.auction_id, "deadline_exceeded")
    creative = creatives.pick(body.auction_id, budget_ms=deadline.remaining_ms())
    if deadline.remaining_ms() < MIN_BID_MS:
        return no_bid(body.auction_id, "deadline_exceeded")
    score = scorer.score(feats, budget_ms=deadline.remaining_ms())
    bid_cents = max(body.floor_cents, score + 1)
    logger.info(
        "bid auction=%s bidder=%s cents=%d left=%d",
        body.auction_id,
        bidder,
        bid_cents,
        deadline.remaining_ms(),
    )
    return JSONResponse(
        {
            "auction_id": body.auction_id,
            "bid_cents": bid_cents,
            "creative_id": creative["id"],
            "degraded": False,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/bids: a model-generated draft that never reads the auction budget. */
import Fastify from 'fastify';

export const app = Fastify();

interface BidBody {
  auction_id: string;
  floor_cents: number;
  timeout_ms?: number;
  user_hash: string;
}

interface CallOptions {
  budgetMs: number;
}

interface Features {
  fetch(userHash: string, options: CallOptions): Promise<Record<string, number>>;
}

interface Scorer {
  score(features: Record<string, number>, options: CallOptions): Promise<number>;
}

interface Creatives {
  pick(auctionId: string, options: CallOptions): Promise<{id: string}>;
}

const deps = {
  features: {} as Features,
  scorer: {} as Scorer,
  creatives: {} as Creatives,
};

app.post('/v1/bids', async (request, reply) => {
  // TODO: this draft never reads timeout_ms, so no stage shares the auction's budget: features,
  // the scorer and the creative cache run back to back at their own latency and the bid lands
  // after the exchange closed. It also validates nothing, so a negative floor_cents produces a
  // nonsense bid. Review all three.
  const body = request.body as BidBody;
  const features = await deps.features.fetch(body.user_hash, {budgetMs: body.timeout_ms ?? 100});
  const score = await deps.scorer.score(features, {budgetMs: body.timeout_ms ?? 100});
  const creative = await deps.creatives.pick(body.auction_id, {budgetMs: body.timeout_ms ?? 100});
  const bidCents = Math.max(body.floor_cents, score + 1);
  request.log.info({auction: body.auction_id, bidCents}, 'bid');
  return reply.code(200).send({auction_id: body.auction_id, bid_cents: bidCents, creative_id: creative.id});
});
`,
      solution: `/** POST /v1/bids: one auction budget, validated input, and a marked no-bid. */
import Fastify, {type FastifyReply} from 'fastify';

export const app = Fastify();

const MIN_BUDGET_MS = 1;
const MAX_BUDGET_MS = 200;
const DEFAULT_BUDGET_MS = 100;
const MAX_FLOOR_CENTS = 1_000_000;
const MIN_BID_MS = 5;

interface BidBody {
  auction_id: string;
  floor_cents: number;
  timeout_ms?: number;
  user_hash: string;
}

interface CallOptions {
  budgetMs: number;
}

interface Features {
  fetch(userHash: string, options: CallOptions): Promise<Record<string, number>>;
}

interface Scorer {
  score(features: Record<string, number>, options: CallOptions): Promise<number>;
}

interface Creatives {
  pick(auctionId: string, options: CallOptions): Promise<{id: string}>;
}

const deps = {
  features: {} as Features,
  scorer: {} as Scorer,
  creatives: {} as Creatives,
};

/** The auction's budget, started once and shared by every downstream call. */
class Deadline {
  private readonly started = Date.now();

  private constructor(private readonly budgetMs: number) {}

  static start(budgetMs: number): Deadline {
    return new Deadline(budgetMs);
  }

  remainingMs(): number {
    return this.budgetMs - (Date.now() - this.started);
  }
}

function noBid(reply: FastifyReply, auctionId: string, reason: string) {
  app.log.info({auction: auctionId, reason}, 'no-bid');
  return reply.code(200).send({auction_id: auctionId, bid: null, reason, degraded: true});
}

app.post('/v1/bids', async (request, reply) => {
  const bidder = request.headers['x-bidder-id'];
  if (typeof bidder !== 'string' || bidder === '') return reply.code(401).send({error: 'missing X-Bidder-Id'});
  const body = request.body as Partial<BidBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.auction_id !== 'string' || body.auction_id === '')
    return reply.code(400).send({error: 'auction_id is required'});
  const timeoutMs = body.timeout_ms ?? DEFAULT_BUDGET_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_BUDGET_MS || timeoutMs > MAX_BUDGET_MS)
    return reply.code(400).send({error: 'timeout_ms must be 1..200'});
  const floorCents = body.floor_cents;
  if (!Number.isInteger(floorCents) || floorCents < 0 || floorCents > MAX_FLOOR_CENTS)
    return reply.code(400).send({error: 'floor_cents is out of range'});

  const deadline = Deadline.start(timeoutMs);
  const features = await deps.features.fetch(body.user_hash, {budgetMs: deadline.remainingMs()});
  if (deadline.remainingMs() < MIN_BID_MS) return noBid(reply, body.auction_id, 'deadline_exceeded');
  const creative = await deps.creatives.pick(body.auction_id, {budgetMs: deadline.remainingMs()});
  if (deadline.remainingMs() < MIN_BID_MS) return noBid(reply, body.auction_id, 'deadline_exceeded');
  const score = await deps.scorer.score(features, {budgetMs: deadline.remainingMs()});
  const bidCents = Math.max(floorCents, score + 1);
  request.log.info({auction: body.auction_id, bidder, bidCents, left: deadline.remainingMs()}, 'bid');
  return reply.code(200).send({
    auction_id: body.auction_id,
    bid_cents: bidCents,
    creative_id: creative.id,
    degraded: false,
  });
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

type BidRequest struct {
	AuctionID  string \`json:"auction_id"\`
	FloorCents int    \`json:"floor_cents"\`
	TimeoutMs  int    \`json:"timeout_ms"\`
	UserHash   string \`json:"user_hash"\`
}

type Features struct{}

func (f *Features) Fetch(ctx context.Context, userHash string, budgetMs int) (map[string]float64, error) {
	return nil, nil
}

type Scorer struct{}

func (s *Scorer) Score(ctx context.Context, features map[string]float64, budgetMs int) (int, error) {
	return 0, nil
}

type Creatives struct{}

type Creative struct {
	ID string
}

func (c *Creatives) Pick(ctx context.Context, auctionID string, budgetMs int) (Creative, error) {
	return Creative{}, nil
}

var (
	features  = &Features{}
	scorer    = &Scorer{}
	creatives = &Creatives{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func bid(rw http.ResponseWriter, r *http.Request) {
	bidder := r.Header.Get("X-Bidder-Id")
	var body BidRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft never reads TimeoutMs, so no stage shares the auction's budget: features,
	// the scorer and the creative cache run back to back at their own latency and the bid lands
	// after the exchange closed. It also validates nothing, so a negative FloorCents produces a
	// nonsense bid. Review all three.
	feats, _ := features.Fetch(r.Context(), body.UserHash, body.TimeoutMs)
	score, _ := scorer.Score(r.Context(), feats, body.TimeoutMs)
	creative, _ := creatives.Pick(r.Context(), body.AuctionID, body.TimeoutMs)
	bidCents := body.FloorCents
	if score+1 > bidCents {
		bidCents = score + 1
	}
	log.Printf("bid auction=%s bidder=%s cents=%d", body.AuctionID, bidder, bidCents)
	writeJSON(rw, http.StatusOK, map[string]any{
		"auction_id":  body.AuctionID,
		"bid_cents":   bidCents,
		"creative_id": creative.ID,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/bids", bid)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

const (
	minBudgetMs    = 1
	maxBudgetMs    = 200
	defaultBudgetMs = 100
	maxFloorCents  = 1_000_000
	minBidMs       = 5
)

// Deadline is the auction's budget, started once and shared by every downstream call.
type Deadline struct {
	budgetMs int
	started  time.Time
}

func startDeadline(budgetMs int) *Deadline {
	return &Deadline{budgetMs: budgetMs, started: time.Now()}
}

func (d *Deadline) RemainingMs() int {
	return d.budgetMs - int(time.Since(d.started).Milliseconds())
}

type BidRequest struct {
	AuctionID  string \`json:"auction_id"\`
	FloorCents int    \`json:"floor_cents"\`
	TimeoutMs  int    \`json:"timeout_ms"\`
	UserHash   string \`json:"user_hash"\`
}

type Features struct{}

func (f *Features) Fetch(ctx context.Context, userHash string, budgetMs int) (map[string]float64, error) {
	return nil, nil
}

type Scorer struct{}

func (s *Scorer) Score(ctx context.Context, features map[string]float64, budgetMs int) (int, error) {
	return 0, nil
}

type Creatives struct{}

type Creative struct {
	ID string
}

func (c *Creatives) Pick(ctx context.Context, auctionID string, budgetMs int) (Creative, error) {
	return Creative{}, nil
}

var (
	features  = &Features{}
	scorer    = &Scorer{}
	creatives = &Creatives{}
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func noBid(rw http.ResponseWriter, auctionID, reason string) {
	log.Printf("no-bid auction=%s reason=%s", auctionID, reason)
	writeJSON(rw, http.StatusOK, map[string]any{
		"auction_id": auctionID,
		"bid":        nil,
		"reason":     reason,
		"degraded":   true,
	})
}

func bid(rw http.ResponseWriter, r *http.Request) {
	bidder := r.Header.Get("X-Bidder-Id")
	if bidder == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Bidder-Id"})
		return
	}
	var body BidRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.AuctionID == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "auction_id is required"})
		return
	}
	timeoutMs := body.TimeoutMs
	if timeoutMs == 0 {
		timeoutMs = defaultBudgetMs
	}
	if timeoutMs < minBudgetMs || timeoutMs > maxBudgetMs {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "timeout_ms must be 1..200"})
		return
	}
	if body.FloorCents < 0 || body.FloorCents > maxFloorCents {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "floor_cents is out of range"})
		return
	}

	deadline := startDeadline(timeoutMs)
	feats, _ := features.Fetch(r.Context(), body.UserHash, deadline.RemainingMs())
	if deadline.RemainingMs() < minBidMs {
		noBid(rw, body.AuctionID, "deadline_exceeded")
		return
	}
	creative, _ := creatives.Pick(r.Context(), body.AuctionID, deadline.RemainingMs())
	if deadline.RemainingMs() < minBidMs {
		noBid(rw, body.AuctionID, "deadline_exceeded")
		return
	}
	score, _ := scorer.Score(r.Context(), feats, deadline.RemainingMs())
	bidCents := body.FloorCents
	if score+1 > bidCents {
		bidCents = score + 1
	}
	log.Printf("bid auction=%s bidder=%s cents=%d left=%d", body.AuctionID, bidder, bidCents, deadline.RemainingMs())
	writeJSON(rw, http.StatusOK, map[string]any{
		"auction_id":  body.AuctionID,
		"bid_cents":   bidCents,
		"creative_id": creative.ID,
		"degraded":    false,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/bids", bid)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class BidRequest(auction_id: String, floor_cents: Int, timeout_ms: Int, user_hash: String)

trait Features {
  def fetch(userHash: String, budgetMs: Int): Map[String, Double]
}

trait Scorer {
  def score(features: Map[String, Double], budgetMs: Int): Int
}

trait Creatives {
  def pick(auctionId: String, budgetMs: Int): String
}

object BiddingApi extends Features with Scorer with Creatives {
  implicit val system: ActorSystem = ActorSystem("bidding")
  implicit val bidFormat: RootJsonFormat[BidRequest] = jsonFormat4(BidRequest)

  def fetch(userHash: String, budgetMs: Int): Map[String, Double] = Map.empty
  def score(features: Map[String, Double], budgetMs: Int): Int = 0
  def pick(auctionId: String, budgetMs: Int): String = "creative"

  val route: Route =
    path("v1" / "bids") {
      post {
        headerValueByName("X-Bidder-Id") { bidder =>
          entity(as[BidRequest]) { body =>
            // TODO: this draft never reads body.timeout_ms, so no stage shares the auction's
            // budget: features, the scorer and the creative cache run back to back at their own
            // latency and the bid lands after the exchange closed. It also validates nothing, so a
            // negative floor_cents produces a nonsense bid. Review all three.
            val feats = fetch(body.user_hash, body.timeout_ms)
            val score = this.score(feats, body.timeout_ms)
            val creative = pick(body.auction_id, body.timeout_ms)
            val bidCents = math.max(body.floor_cents, score + 1)
            system.log.info(s"bid auction=\${body.auction_id} bidder=$bidder cents=$bidCents")
            complete(StatusCodes.OK, s"""{"auction_id":"\${body.auction_id}","bid_cents":$bidCents,"creative_id":"$creative"}""")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class BidRequest(auction_id: String, floor_cents: Int, timeout_ms: Int, user_hash: String)

trait Features {
  def fetch(userHash: String, budgetMs: Int): Map[String, Double]
}

trait Scorer {
  def score(features: Map[String, Double], budgetMs: Int): Int
}

trait Creatives {
  def pick(auctionId: String, budgetMs: Int): String
}

/** The auction's budget, started once and shared by every downstream call. */
class Deadline private (budgetMs: Int) {
  private val started = System.nanoTime()
  def remainingMs: Int = budgetMs - ((System.nanoTime() - started) / 1000000L).toInt
}

object Deadline {
  def start(budgetMs: Int): Deadline = new Deadline(budgetMs)
}

object BiddingApi extends Features with Scorer with Creatives {
  implicit val system: ActorSystem = ActorSystem("bidding")
  implicit val bidFormat: RootJsonFormat[BidRequest] = jsonFormat4(BidRequest)

  val MinBudgetMs = 1
  val MaxBudgetMs = 200
  val DefaultBudgetMs = 100
  val MaxFloorCents = 1_000_000
  val MinBidMs = 5

  def fetch(userHash: String, budgetMs: Int): Map[String, Double] = Map.empty
  def score(features: Map[String, Double], budgetMs: Int): Int = 0
  def pick(auctionId: String, budgetMs: Int): String = "creative"

  def noBid(auctionId: String, reason: String): Route = {
    system.log.info(s"no-bid auction=$auctionId reason=$reason")
    complete(StatusCodes.OK, s"""{"auction_id":"$auctionId","bid":null,"reason":"$reason","degraded":true}""")
  }

  val route: Route =
    path("v1" / "bids") {
      post {
        optionalHeaderValueByName("X-Bidder-Id") { bidderOpt =>
          entity(as[BidRequest]) { body =>
            if (!bidderOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Bidder-Id"}""")
            } else if (body.auction_id.isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"auction_id is required"}""")
            } else if (body.timeout_ms < MinBudgetMs || body.timeout_ms > MaxBudgetMs) {
              complete(StatusCodes.BadRequest, """{"error":"timeout_ms must be 1..200"}""")
            } else if (body.floor_cents < 0 || body.floor_cents > MaxFloorCents) {
              complete(StatusCodes.BadRequest, """{"error":"floor_cents is out of range"}""")
            } else {
              val deadline = Deadline.start(body.timeout_ms)
              val feats = fetch(body.user_hash, budgetMs = deadline.remainingMs)
              if (deadline.remainingMs < MinBidMs) {
                noBid(body.auction_id, "deadline_exceeded")
              } else {
                val creative = pick(body.auction_id, budgetMs = deadline.remainingMs)
                val score = this.score(feats, budgetMs = deadline.remainingMs)
                val bidCents = math.max(body.floor_cents, score + 1)
                system.log.info(s"bid auction=\${body.auction_id} cents=$bidCents left=\${deadline.remainingMs}")
                complete(StatusCodes.OK, s"""{"auction_id":"\${body.auction_id}","bid_cents":$bidCents,"creative_id":"$creative","degraded":false}""")
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

struct Features {
  std::map<std::string, double> fetch(const std::string& userHash, int budgetMs);
};

struct Scorer {
  int score(const std::map<std::string, double>& features, int budgetMs);
};

struct Creatives {
  std::string pick(const std::string& auctionId, int budgetMs);
};

Features features;
Scorer scorer;
Creatives creatives;

int main() {
  httplib::Server svr;

  svr.Post("/v1/bids", [](const httplib::Request& req, httplib::Response& res) {
    const auto bidder = req.get_header_value("X-Bidder-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft never reads timeout_ms, so no stage shares the auction's budget: features,
    // the scorer and the creative cache run back to back at their own latency and the bid lands
    // after the exchange closed. It also validates nothing, so a negative floor_cents produces a
    // nonsense bid. Review all three.
    const auto userHash = body.value("user_hash", std::string());
    const auto auctionId = body.value("auction_id", std::string());
    const int timeoutMs = body.value("timeout_ms", 100);
    const auto feats = features.fetch(userHash, timeoutMs);
    const int score = scorer.score(feats, timeoutMs);
    const auto creative = creatives.pick(auctionId, timeoutMs);
    const int bidCents = std::max(body.value("floor_cents", 0), score + 1);
    std::cerr << "bid auction=" << auctionId << " bidder=" << bidder << " cents=" << bidCents << "\\n";
    res.status = 200;
    res.set_content(
        json{{"auction_id", auctionId}, {"bid_cents", bidCents}, {"creative_id", creative}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <iostream>
#include <map>
#include <string>

using json = nlohmann::json;

constexpr int kMinBudgetMs = 1;
constexpr int kMaxBudgetMs = 200;
constexpr int kDefaultBudgetMs = 100;
constexpr int kMaxFloorCents = 1000000;
constexpr int kMinBidMs = 5;

/** The auction's budget, started once and shared by every downstream call. */
class Deadline {
 public:
  static Deadline start(int budgetMs) { return Deadline(budgetMs); }
  int remainingMs() const {
    const auto elapsed = std::chrono::steady_clock::now() - started_;
    return budgetMs_ - static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count());
  }

 private:
  Deadline(int budgetMs) : budgetMs_(budgetMs), started_(std::chrono::steady_clock::now()) {}
  int budgetMs_;
  std::chrono::steady_clock::time_point started_;
};

struct Features {
  std::map<std::string, double> fetch(const std::string& userHash, int budgetMs);
};

struct Scorer {
  int score(const std::map<std::string, double>& features, int budgetMs);
};

struct Creatives {
  std::string pick(const std::string& auctionId, int budgetMs);
};

Features features;
Scorer scorer;
Creatives creatives;

void noBid(httplib::Response& res, const std::string& auctionId, const std::string& reason) {
  std::cerr << "no-bid auction=" << auctionId << " reason=" << reason << "\\n";
  res.status = 200;
  res.set_content(
      json{{"auction_id", auctionId}, {"bid", nullptr}, {"reason", reason}, {"degraded", true}}.dump(),
      "application/json");
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/bids", [](const httplib::Request& req, httplib::Response& res) {
    const auto bidder = req.get_header_value("X-Bidder-Id");
    if (bidder.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Bidder-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("auction_id") || !body["auction_id"].is_string() ||
        body["auction_id"].get<std::string>().empty()) {
      res.status = 400;
      res.set_content(R"({"error":"auction_id is required"})", "application/json");
      return;
    }
    const int timeoutMs = body.value("timeout_ms", kDefaultBudgetMs);
    if (timeoutMs < kMinBudgetMs || timeoutMs > kMaxBudgetMs) {
      res.status = 400;
      res.set_content(R"({"error":"timeout_ms must be 1..200"})", "application/json");
      return;
    }
    const int floorCents = body.value("floor_cents", -1);
    if (floorCents < 0 || floorCents > kMaxFloorCents) {
      res.status = 400;
      res.set_content(R"({"error":"floor_cents is out of range"})", "application/json");
      return;
    }

    const auto auctionId = body["auction_id"].get<std::string>();
    const auto userHash = body.value("user_hash", std::string());
    const auto deadline = Deadline::start(timeoutMs);

    const auto feats = features.fetch(userHash, deadline.remainingMs());
    if (deadline.remainingMs() < kMinBidMs) {
      noBid(res, auctionId, "deadline_exceeded");
      return;
    }
    const auto creative = creatives.pick(auctionId, deadline.remainingMs());
    if (deadline.remainingMs() < kMinBidMs) {
      noBid(res, auctionId, "deadline_exceeded");
      return;
    }
    const int score = scorer.score(feats, deadline.remainingMs());
    const int bidCents = std::max(floorCents, score + 1);
    std::cerr << "bid auction=" << auctionId << " bidder=" << bidder << " cents=" << bidCents
              << " left=" << deadline.remainingMs() << "\\n";
    res.status = 200;
    res.set_content(
        json{{"auction_id", auctionId},
             {"bid_cents", bidCents},
             {"creative_id", creative},
             {"degraded", false}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Start the budget once, at the top of the handler: `deadline = Deadline.start(body.timeout_ms)`. Every stage afterwards takes `budget_ms=deadline.remaining_ms()` / `budgetMs: deadline.remainingMs()` — a stage that gets its own full timeout is a stage that does not share the auction.',
    'Validate before spending: tenant, `auction_id`, `timeout_ms` in 1..200, `floor_cents` in 0..1 000 000, each an early 400. A negative floor is not a cheap bid — `max(floor, score + 1)` makes it a *winning* bid the bidder never agreed to.',
    'The guard is what makes the deadline real: before each stage compare `remaining_ms() < MIN_BID_MS` and return the no-bid — 200 with `bid: null`, `reason: "deadline_exceeded"`, `degraded: true`. The exchange would rather hear "no bid" than receive a bid after the auction closed.',
  ],
  debrief: `The interviewer is testing whether you can review a generated handler at the trust boundary and
whether you understand that an auction's budget is one number shared by every stage, not a timeout
per call. The draft reads fine because the demo has a fast feature service and never sends a timeout.

Three defects are being checked. Validation: a negative floor and a five-second budget both travel
through an endpoint that trusts the caller, and the first one produces a bid the bidder cannot pay.
Budget propagation: the deadline must be started once and its remaining time handed to each stage, so
a slow feature service shortens the time the creative cache and the model may take — not lengthen the
request. Graceful abandonment: when the remaining budget cannot cover the next stage, the correct
answer is a marked no-bid inside the auction window, because a late bid is not just useless, it is
a request that costs money and wins nothing.

Real bidders go further: they keep a per-stage budget table, cut the lowest-value stages first,
and record which stage squeezed the request so the stats read in step 5 can show a timeout rate
rather than a mystery.`,
};
