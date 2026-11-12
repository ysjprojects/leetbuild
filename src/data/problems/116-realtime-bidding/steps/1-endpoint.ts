import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/bids: the exchange sets the deadline',
  concept: 'http',
  file: 'api',
  focus: ['exchange', 'api', 'features', 'scorer', 'redis'],
  task: `## Task

**Starting point.** The starter registers \`POST /v1/bids\` for the body
\`{"auction_id": "a-1", "floor_cents": 250, "timeout_ms": 100, "user_hash": "u-9"}\` with the bidder in
\`X-Bidder-Id\`. It starts a \`Deadline\` (provided, \`rtb.deadline\`) of \`DEFAULT_BUDGET_MS\`, prices the
bid with the provided \`quote_bid\` (step 3's), claims the price with \`spend.claim\` (step 2's) and
answers \`{"auction_id", "bid_cents", "degraded"}\`. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** The exchange sends a 20 ms budget and gets a bid after 75 ms; a
request with a negative floor or no bidder is priced; a quote that used up the budget is still sent;
a bid the cap refused goes out anyway.

- A missing \`X-Bidder-Id\` is **401**; an empty \`auction_id\`, a \`timeout_ms\` outside **1..200**
  (\`MAX_BUDGET_MS\`) or a \`floor_cents\` outside **0..1 000 000** (\`MAX_FLOOR_CENTS\`) is **400**.
- The deadline is the request's \`timeout_ms\`, started once.
- After pricing, with less than \`MIN_BID_MS\` (10) left, answer the no-bid
  \`{"auction_id", "bid_cents": null, "reason": "deadline_exceeded"}\` and claim nothing.
- When \`spend.claim\` returns false, answer the no-bid with \`"reason": "budget_exhausted"\`.`,
  sequence: {
    participants: ['Ad exchange', 'biddingd', 'Feature service', 'Redis'],
    messages: [
      {from: 'Ad exchange', to: 'biddingd', label: 'POST /v1/bids · timeout_ms = 100 · X-Bidder-Id', kind: 'sync'},
      {from: 'biddingd', to: 'biddingd', label: 'Deadline.start(timeout_ms)', kind: 'sync'},
      {from: 'biddingd', to: 'Feature service', label: 'quote_bid(…, deadline): tiers, then Score', kind: 'sync'},
      {from: 'Feature service', to: 'biddingd', label: 'Quote(bid_cents, degraded)', kind: 'reply'},
      {from: 'biddingd', to: 'biddingd', label: 'remaining_ms() < MIN_BID_MS → no-bid', kind: 'sync'},
      {from: 'biddingd', to: 'Redis', label: 'spend.claim(bidder, auction, cents)', kind: 'sync'},
      {from: 'Redis', to: 'biddingd', label: 'false → no-bid budget_exhausted', kind: 'reply'},
      {from: 'biddingd', to: 'Ad exchange', label: '200 {bid_cents} · {bid_cents: null, reason}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/bids',
      detail: "A healthy auction is answered 200 with the model's price, and that price is claimed from the day's cap.",
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
      title: 'Rejects a request with no bidder or out-of-range numbers',
      detail:
        'No `X-Bidder-Id` is **401**; an empty `auction_id`, `timeout_ms` outside 1..200 or `floor_cents` outside 0..1 000 000 is **400**, and nothing is priced or claimed. The starter prices whatever arrives.',
      match: {
        python: {all: [/\b401\b/, /[<>]=?\s*MAX_FLOOR_CENTS/, /[<>]=?\s*MAX_BUDGET_MS/]},
        typescript: {all: [/\b401\b/, /[<>]=?\s*MAX_FLOOR_CENTS/, /[<>]=?\s*MAX_BUDGET_MS/]},
        go: {all: [/StatusUnauthorized|\b401\b/, /[<>]=?\s*maxFloorCents/, /[<>]=?\s*maxBudgetMs/]},
        scala: {all: [/Unauthorized|\b401\b/, /[<>]=?\s*MaxFloorCents/, /[<>]=?\s*MaxBudgetMs/]},
        cpp: {all: [/\b401\b/, /[<>]=?\s*kMaxFloorCents/, /[<>]=?\s*kMaxBudgetMs/]},
      },
    },
    {
      id: 'deadline',
      title: "The budget is the request's timeout_ms",
      detail:
        'With `timeout_ms: 20` and features answering in 25 ms, the service answers a no-bid within 20 ms and no call carries more than 20 ms. The starter starts its own 100 ms budget and bids after 75 ms.',
      match: {
        python: {all: [/Deadline\.start\(/], none: [/Deadline\.start\(\s*DEFAULT_BUDGET_MS\s*\)/]},
        typescript: {all: [/Deadline\.start\(/], none: [/Deadline\.start\(\s*DEFAULT_BUDGET_MS\s*\)/]},
        go: {all: [/deadline\.Start\(/], none: [/deadline\.Start\(\s*defaultBudgetMs\s*\)/]},
        scala: {all: [/Deadline\.start\(/], none: [/Deadline\.start\(\s*DefaultBudgetMs\s*\)/]},
        cpp: {all: [/Deadline::start\(/], none: [/Deadline::start\(\s*kDefaultBudgetMs\s*\)/]},
      },
    },
    {
      id: 'no-late-bid',
      title: 'A quote that used up the budget is a no-bid',
      detail:
        'With less than `MIN_BID_MS` left after pricing, the answer is `bid_cents: null` with `reason: "deadline_exceeded"` and no spend is claimed. The starter sends the bid however late it is.',
      match: {
        python: {all: [/remaining_ms\(\)\s*<\s*MIN_BID_MS/, /deadline_exceeded/]},
        typescript: {all: [/remainingMs\(\)\s*<\s*MIN_BID_MS/, /deadline_exceeded/]},
        go: {all: [/RemainingMs\(\)\s*<\s*minBidMs/, /deadline_exceeded/]},
        scala: {all: [/remainingMs\s*<\s*MinBidMs/, /deadline_exceeded/]},
        cpp: {all: [/remainingMs\(\)\s*<\s*kMinBidMs/, /deadline_exceeded/]},
      },
    },
    {
      id: 'budget',
      title: 'A bid the cap refused is a no-bid',
      detail:
        'When `claim` returns false the answer is `bid_cents: null` with `reason: "budget_exhausted"`. The starter ignores the result and bids money the bidder does not have.',
      match: {
        python: {all: [/budget_exhausted/], none: [/^\s*spend\.claim\(/m]},
        typescript: {all: [/budget_exhausted/], none: [/^\s*await claim\(/m]},
        go: {all: [/budget_exhausted/], none: [/^\s*spend\.Claim\(/m]},
        scala: {all: [/budget_exhausted/], none: [/^\s*Spend\.claim\(/m]},
        cpp: {all: [/budget_exhausted/], none: [/^\s*rtb::spend::claim\(/m]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from pydantic import BaseModel

from rtb import spend  # spend.claim(bidder, auction_id, cents) -> bool
from rtb.deadline import Deadline  # Deadline.start(budget_ms), deadline.remaining_ms()
from rtb.pricing import quote_bid  # quote_bid(user_hash, auction_id, floor_cents, deadline) -> Quote(bid_cents, degraded, reason)

app = FastAPI()

DEFAULT_BUDGET_MS = 100
MAX_BUDGET_MS = 200
MAX_FLOOR_CENTS = 1_000_000
MIN_BID_MS = 10  # the answer's trip back to the exchange


class BidRequest(BaseModel):
    auction_id: str
    floor_cents: int
    timeout_ms: int = DEFAULT_BUDGET_MS
    user_hash: str


def no_bid(auction_id: str, reason: str) -> dict:
    return {"auction_id": auction_id, "bid_cents": None, "reason": reason}


@app.post("/v1/bids")
def bid(body: BidRequest, request: Request) -> dict:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    bidder = request.headers.get("x-bidder-id", "")
    deadline = Deadline.start(DEFAULT_BUDGET_MS)
    quote = quote_bid(body.user_hash, body.auction_id, body.floor_cents, deadline)
    if quote.bid_cents < body.floor_cents:
        return no_bid(body.auction_id, "below_floor")
    spend.claim(bidder, body.auction_id, quote.bid_cents)
    return {"auction_id": body.auction_id, "bid_cents": quote.bid_cents, "degraded": quote.degraded}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from rtb import spend  # spend.claim(bidder, auction_id, cents) -> bool
from rtb.deadline import Deadline  # Deadline.start(budget_ms), deadline.remaining_ms()
from rtb.pricing import quote_bid  # quote_bid(user_hash, auction_id, floor_cents, deadline) -> Quote(bid_cents, degraded, reason)

app = FastAPI()

DEFAULT_BUDGET_MS = 100
MAX_BUDGET_MS = 200
MAX_FLOOR_CENTS = 1_000_000
MIN_BID_MS = 10  # the answer's trip back to the exchange


class BidRequest(BaseModel):
    auction_id: str
    floor_cents: int
    timeout_ms: int = DEFAULT_BUDGET_MS
    user_hash: str


def no_bid(auction_id: str, reason: str) -> dict:
    return {"auction_id": auction_id, "bid_cents": None, "reason": reason}


@app.post("/v1/bids")
def bid(body: BidRequest, request: Request) -> dict:
    bidder = request.headers.get("x-bidder-id", "")
    if not bidder:
        raise HTTPException(status_code=401, detail="X-Bidder-Id is required")
    if not body.auction_id:
        raise HTTPException(status_code=400, detail="auction_id is required")
    if not 1 <= body.timeout_ms <= MAX_BUDGET_MS:
        raise HTTPException(status_code=400, detail="timeout_ms must be 1..200")
    if not 0 <= body.floor_cents <= MAX_FLOOR_CENTS:
        raise HTTPException(status_code=400, detail="floor_cents must be 0..1000000")
    deadline = Deadline.start(body.timeout_ms)  # the exchange's budget, shared by every stage
    quote = quote_bid(body.user_hash, body.auction_id, body.floor_cents, deadline)
    if deadline.remaining_ms() < MIN_BID_MS:
        return no_bid(body.auction_id, "deadline_exceeded")  # it would arrive after the auction closed
    if quote.bid_cents < body.floor_cents:
        return no_bid(body.auction_id, "below_floor")
    if not spend.claim(bidder, body.auction_id, quote.bid_cents):
        return no_bid(body.auction_id, "budget_exhausted")
    return {"auction_id": body.auction_id, "bid_cents": quote.bid_cents, "degraded": quote.degraded}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {Deadline} from 'rtb/deadline'; // Deadline.start(budgetMs), deadline.remainingMs()
import {quoteBid} from 'rtb/pricing'; // quoteBid(userHash, auctionId, floorCents, deadline) -> {bid_cents, degraded, reason}
import {claim} from 'rtb/spend'; // claim(bidder, auctionId, cents) -> boolean

export const app = Fastify();

export const DEFAULT_BUDGET_MS = 100;
export const MAX_BUDGET_MS = 200;
export const MAX_FLOOR_CENTS = 1_000_000;
export const MIN_BID_MS = 10; // the answer's trip back to the exchange

interface BidRequest {
  auction_id: string;
  floor_cents: number;
  timeout_ms?: number;
  user_hash: string;
}

const noBid = (auctionId: string, reason: string) => ({auction_id: auctionId, bid_cents: null, reason});

app.post('/v1/bids', async request => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const bidder = String(request.headers['x-bidder-id'] ?? '');
  const body = request.body as BidRequest;
  const deadline = Deadline.start(DEFAULT_BUDGET_MS);
  const quote = await quoteBid(body.user_hash, body.auction_id, body.floor_cents, deadline);
  if (quote.bid_cents < body.floor_cents) return noBid(body.auction_id, 'below_floor');
  await claim(bidder, body.auction_id, quote.bid_cents);
  return {auction_id: body.auction_id, bid_cents: quote.bid_cents, degraded: quote.degraded};
});
`,
      solution: `import Fastify from 'fastify';

import {Deadline} from 'rtb/deadline'; // Deadline.start(budgetMs), deadline.remainingMs()
import {quoteBid} from 'rtb/pricing'; // quoteBid(userHash, auctionId, floorCents, deadline) -> {bid_cents, degraded, reason}
import {claim} from 'rtb/spend'; // claim(bidder, auctionId, cents) -> boolean

export const app = Fastify();

export const DEFAULT_BUDGET_MS = 100;
export const MAX_BUDGET_MS = 200;
export const MAX_FLOOR_CENTS = 1_000_000;
export const MIN_BID_MS = 10; // the answer's trip back to the exchange

interface BidRequest {
  auction_id: string;
  floor_cents: number;
  timeout_ms?: number;
  user_hash: string;
}

const noBid = (auctionId: string, reason: string) => ({auction_id: auctionId, bid_cents: null, reason});

app.post('/v1/bids', async (request, reply) => {
  const bidder = String(request.headers['x-bidder-id'] ?? '');
  if (bidder === '') return reply.code(401).send({error: 'X-Bidder-Id is required'});
  const body = request.body as BidRequest;
  const timeoutMs = body.timeout_ms ?? DEFAULT_BUDGET_MS;
  if (typeof body.auction_id !== 'string' || body.auction_id === '') return reply.code(400).send({error: 'auction_id is required'});
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_BUDGET_MS) return reply.code(400).send({error: 'timeout_ms must be 1..200'});
  if (!Number.isInteger(body.floor_cents) || body.floor_cents < 0 || body.floor_cents > MAX_FLOOR_CENTS) {
    return reply.code(400).send({error: 'floor_cents must be 0..1000000'});
  }
  const deadline = Deadline.start(timeoutMs); // the exchange's budget, shared by every stage
  const quote = await quoteBid(body.user_hash, body.auction_id, body.floor_cents, deadline);
  if (deadline.remainingMs() < MIN_BID_MS) return noBid(body.auction_id, 'deadline_exceeded'); // it would arrive after the auction closed
  if (quote.bid_cents < body.floor_cents) return noBid(body.auction_id, 'below_floor');
  if (!(await claim(bidder, body.auction_id, quote.bid_cents))) return noBid(body.auction_id, 'budget_exhausted');
  return {auction_id: body.auction_id, bid_cents: quote.bid_cents, degraded: quote.degraded};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"rtb/deadline" // deadline.Start(budgetMs), d.RemainingMs()
	"rtb/pricing"  // pricing.QuoteBid(ctx, userHash, auctionID, floorCents, d) pricing.Quote{BidCents, Degraded, Reason}
	"rtb/spend"    // spend.Claim(ctx, bidder, auctionID, cents) (bool, error)
)

const (
	defaultBudgetMs = 100
	maxBudgetMs     = 200
	maxFloorCents   = 1000000
	minBidMs        = 10 // the answer's trip back to the exchange
)

type bidRequest struct {
	AuctionID  string \`json:"auction_id"\`
	FloorCents int64  \`json:"floor_cents"\`
	TimeoutMs  *int64 \`json:"timeout_ms"\`
	UserHash   string \`json:"user_hash"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func noBid(rw http.ResponseWriter, auctionID, reason string) {
	writeJSON(rw, http.StatusOK, map[string]any{"auction_id": auctionID, "bid_cents": nil, "reason": reason})
}

func bid(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	bidder := r.Header.Get("X-Bidder-Id")
	var body bidRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body is not a bid request", http.StatusBadRequest)
		return
	}
	d := deadline.Start(defaultBudgetMs)
	quote := pricing.QuoteBid(r.Context(), body.UserHash, body.AuctionID, body.FloorCents, d)
	if quote.BidCents < body.FloorCents {
		noBid(rw, body.AuctionID, "below_floor")
		return
	}
	spend.Claim(r.Context(), bidder, body.AuctionID, quote.BidCents)
	writeJSON(rw, http.StatusOK, map[string]any{"auction_id": body.AuctionID, "bid_cents": quote.BidCents, "degraded": quote.Degraded})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/bids", bid)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"rtb/deadline" // deadline.Start(budgetMs), d.RemainingMs()
	"rtb/pricing"  // pricing.QuoteBid(ctx, userHash, auctionID, floorCents, d) pricing.Quote{BidCents, Degraded, Reason}
	"rtb/spend"    // spend.Claim(ctx, bidder, auctionID, cents) (bool, error)
)

const (
	defaultBudgetMs = 100
	maxBudgetMs     = 200
	maxFloorCents   = 1000000
	minBidMs        = 10 // the answer's trip back to the exchange
)

type bidRequest struct {
	AuctionID  string \`json:"auction_id"\`
	FloorCents int64  \`json:"floor_cents"\`
	TimeoutMs  *int64 \`json:"timeout_ms"\`
	UserHash   string \`json:"user_hash"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func noBid(rw http.ResponseWriter, auctionID, reason string) {
	writeJSON(rw, http.StatusOK, map[string]any{"auction_id": auctionID, "bid_cents": nil, "reason": reason})
}

func bid(rw http.ResponseWriter, r *http.Request) {
	bidder := r.Header.Get("X-Bidder-Id")
	if bidder == "" {
		http.Error(rw, "X-Bidder-Id is required", http.StatusUnauthorized)
		return
	}
	var body bidRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body is not a bid request", http.StatusBadRequest)
		return
	}
	timeoutMs := int64(defaultBudgetMs)
	if body.TimeoutMs != nil {
		timeoutMs = *body.TimeoutMs
	}
	if body.AuctionID == "" || timeoutMs < 1 || timeoutMs > maxBudgetMs || body.FloorCents < 0 || body.FloorCents > maxFloorCents {
		http.Error(rw, "auction_id is required, timeout_ms must be 1..200 and floor_cents 0..1000000", http.StatusBadRequest)
		return
	}
	d := deadline.Start(timeoutMs) // the exchange's budget, shared by every stage
	quote := pricing.QuoteBid(r.Context(), body.UserHash, body.AuctionID, body.FloorCents, d)
	if d.RemainingMs() < minBidMs {
		noBid(rw, body.AuctionID, "deadline_exceeded") // it would arrive after the auction closed
		return
	}
	if quote.BidCents < body.FloorCents {
		noBid(rw, body.AuctionID, "below_floor")
		return
	}
	claimed, err := spend.Claim(r.Context(), bidder, body.AuctionID, quote.BidCents)
	if err != nil || !claimed {
		noBid(rw, body.AuctionID, "budget_exhausted")
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"auction_id": body.AuctionID, "bid_cents": quote.BidCents, "degraded": quote.Degraded})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/bids", bid)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import rtb.{Deadline, Pricing, Spend} // Deadline.start(budgetMs); Pricing.quoteBid(userHash, auctionId, floorCents, deadline); Spend.claim(bidder, auctionId, cents)

object Api {
  val DefaultBudgetMs = 100L
  val MaxBudgetMs = 200L
  val MaxFloorCents = 1000000L
  val MinBidMs = 10L // the answer's trip back to the exchange

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def noBid(auctionId: String, reason: String): HttpResponse =
    json(StatusCodes.OK, JsObject("auction_id" -> JsString(auctionId), "bid_cents" -> JsNull, "reason" -> JsString(reason)))

  val route: Route = path("v1" / "bids") {
    post {
      optionalHeaderValueByName("X-Bidder-Id") { bidderHeader =>
        entity(as[String]) { raw =>
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
          val bidder = bidderHeader.getOrElse("")
          val fields = raw.parseJson.asJsObject.fields
          val auctionId = fields.get("auction_id").collect { case JsString(s) => s }.getOrElse("")
          val floorCents = fields.get("floor_cents").collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
          val userHash = fields.get("user_hash").collect { case JsString(s) => s }.getOrElse("")
          val deadline = Deadline.start(DefaultBudgetMs)
          val quote = Pricing.quoteBid(userHash, auctionId, floorCents, deadline)
          if (quote.bidCents < floorCents) complete(noBid(auctionId, "below_floor"))
          else {
            Spend.claim(bidder, auctionId, quote.bidCents)
            complete(json(StatusCodes.OK, JsObject("auction_id" -> JsString(auctionId), "bid_cents" -> JsNumber(quote.bidCents), "degraded" -> JsBoolean(quote.degraded))))
          }
        }
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import rtb.{Deadline, Pricing, Spend} // Deadline.start(budgetMs); Pricing.quoteBid(userHash, auctionId, floorCents, deadline); Spend.claim(bidder, auctionId, cents)

object Api {
  val DefaultBudgetMs = 100L
  val MaxBudgetMs = 200L
  val MaxFloorCents = 1000000L
  val MinBidMs = 10L // the answer's trip back to the exchange

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def noBid(auctionId: String, reason: String): HttpResponse =
    json(StatusCodes.OK, JsObject("auction_id" -> JsString(auctionId), "bid_cents" -> JsNull, "reason" -> JsString(reason)))

  private def integer(fields: Map[String, JsValue], name: String, fallback: Option[Long]): Option[Long] =
    fields.get(name) match {
      case Some(JsNumber(n)) if n.isValidLong => Some(n.toLong)
      case None => fallback
      case _ => None
    }

  val route: Route = path("v1" / "bids") {
    post {
      optionalHeaderValueByName("X-Bidder-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Bidder-Id is required")
        case Some(bidder) =>
          entity(as[String]) { raw =>
            val fields = raw.parseJson.asJsObject.fields
            val auctionId = fields.get("auction_id").collect { case JsString(s) => s }.getOrElse("")
            val userHash = fields.get("user_hash").collect { case JsString(s) => s }.getOrElse("")
            (integer(fields, "timeout_ms", Some(DefaultBudgetMs)), integer(fields, "floor_cents", None)) match {
              case (Some(timeoutMs), Some(floorCents))
                  if auctionId.nonEmpty && timeoutMs >= 1 && timeoutMs <= MaxBudgetMs && floorCents >= 0 && floorCents <= MaxFloorCents =>
                val deadline = Deadline.start(timeoutMs) // the exchange's budget, shared by every stage
                val quote = Pricing.quoteBid(userHash, auctionId, floorCents, deadline)
                if (deadline.remainingMs < MinBidMs) complete(noBid(auctionId, "deadline_exceeded")) // it would arrive after the auction closed
                else if (quote.bidCents < floorCents) complete(noBid(auctionId, "below_floor"))
                else if (!Spend.claim(bidder, auctionId, quote.bidCents)) complete(noBid(auctionId, "budget_exhausted"))
                else complete(json(StatusCodes.OK, JsObject("auction_id" -> JsString(auctionId), "bid_cents" -> JsNumber(quote.bidCents), "degraded" -> JsBoolean(quote.degraded))))
              case _ => complete(StatusCodes.BadRequest -> "auction_id is required, timeout_ms must be 1..200 and floor_cents 0..1000000")
            }
          }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "rtb/deadline.h"  // rtb::Deadline::start(budget_ms), deadline.remainingMs()
#include "rtb/pricing.h"   // rtb::pricing::quoteBid(user_hash, auction_id, floor_cents, deadline) -> Quote{bid_cents, degraded, reason}
#include "rtb/spend.h"     // rtb::spend::claim(bidder, auction_id, cents) -> bool

using json = nlohmann::json;

constexpr long kDefaultBudgetMs = 100;
constexpr long kMaxBudgetMs = 200;
constexpr long kMaxFloorCents = 1000000;
constexpr long kMinBidMs = 10;  // the answer's trip back to the exchange

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

json noBid(const std::string& auction_id, const std::string& reason) {
  return {{"auction_id", auction_id}, {"bid_cents", nullptr}, {"reason", reason}};
}

void bid(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string bidder = req.get_header_value("X-Bidder-Id");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "the body is not a bid request"}});
  const std::string auction_id = body.value("auction_id", "");
  const long floor_cents = body.value("floor_cents", 0L);
  const rtb::Deadline deadline = rtb::Deadline::start(kDefaultBudgetMs);
  const rtb::pricing::Quote quote = rtb::pricing::quoteBid(body.value("user_hash", ""), auction_id, floor_cents, deadline);
  if (quote.bid_cents < floor_cents) return reply(res, 200, noBid(auction_id, "below_floor"));
  rtb::spend::claim(bidder, auction_id, quote.bid_cents);
  reply(res, 200, {{"auction_id", auction_id}, {"bid_cents", quote.bid_cents}, {"degraded", quote.degraded}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/bids", bid); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "rtb/deadline.h"  // rtb::Deadline::start(budget_ms), deadline.remainingMs()
#include "rtb/pricing.h"   // rtb::pricing::quoteBid(user_hash, auction_id, floor_cents, deadline) -> Quote{bid_cents, degraded, reason}
#include "rtb/spend.h"     // rtb::spend::claim(bidder, auction_id, cents) -> bool

using json = nlohmann::json;

constexpr long kDefaultBudgetMs = 100;
constexpr long kMaxBudgetMs = 200;
constexpr long kMaxFloorCents = 1000000;
constexpr long kMinBidMs = 10;  // the answer's trip back to the exchange

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

json noBid(const std::string& auction_id, const std::string& reason) {
  return {{"auction_id", auction_id}, {"bid_cents", nullptr}, {"reason", reason}};
}

void bid(const httplib::Request& req, httplib::Response& res) {
  const std::string bidder = req.get_header_value("X-Bidder-Id");
  if (bidder.empty()) return reply(res, 401, {{"error", "X-Bidder-Id is required"}});
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return reply(res, 400, {{"error", "the body is not a bid request"}});
  const std::string auction_id = body.value("auction_id", "");
  const json timeout = body.value("timeout_ms", json(kDefaultBudgetMs));
  const json floor = body.value("floor_cents", json());
  if (auction_id.empty() || !timeout.is_number_integer() || timeout.get<long>() < 1 || timeout.get<long>() > kMaxBudgetMs ||
      !floor.is_number_integer() || floor.get<long>() < 0 || floor.get<long>() > kMaxFloorCents) {
    return reply(res, 400, {{"error", "auction_id is required, timeout_ms must be 1..200 and floor_cents 0..1000000"}});
  }
  const long floor_cents = floor.get<long>();
  const rtb::Deadline deadline = rtb::Deadline::start(timeout.get<long>());  // the exchange's budget, shared by every stage
  const rtb::pricing::Quote quote = rtb::pricing::quoteBid(body.value("user_hash", ""), auction_id, floor_cents, deadline);
  if (deadline.remainingMs() < kMinBidMs) return reply(res, 200, noBid(auction_id, "deadline_exceeded"));  // it would arrive after the auction closed
  if (quote.bid_cents < floor_cents) return reply(res, 200, noBid(auction_id, "below_floor"));
  if (!rtb::spend::claim(bidder, auction_id, quote.bid_cents)) return reply(res, 200, noBid(auction_id, "budget_exhausted"));
  reply(res, 200, {{"auction_id", auction_id}, {"bid_cents", quote.bid_cents}, {"degraded", quote.degraded}});
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/bids", bid); }
`,
    },
  },
  harness: {
    python: `import realtime_bidding_pb2 as pb
import realtime_bidding_pb2_grpc as pb_grpc

BODY = {"auction_id": "a-1", "floor_cents": 250, "timeout_ms": 100, "user_hash": "u-9"}
HEADERS = {"X-Bidder-Id": "b-1"}
VALUE = 310


class Features(pb_grpc.FeaturesServicer):
    def Identity(self, request, context):
        return pb.IdentityFeatures(segment="sports", frequency=2)

    def Contextual(self, request, context):
        return pb.ContextFeatures(category="news", viewability_pct=70)


class Scorer(pb_grpc.ScorerServicer):
    def Score(self, request, context):
        return pb.ScoreReply(value_cents=VALUE)


def _api(ctx, cap=100_000):
    ctx.grpc.serve(pb_grpc.add_FeaturesServicer_to_server, Features())
    ctx.grpc.serve(pb_grpc.add_ScorerServicer_to_server, Scorer())
    ctx.redis.set("cap:b-1", cap)
    return ctx.client(ctx.load("api").app)


def _spent(ctx):
    return sum(int(ctx.redis.get(k) or 0) for k in ctx.redis.keys("spend:*"))


async def _bid(c, **changes):
    return await c.post("/v1/bids", json={**BODY, **changes}, headers=HEADERS)


def _no_bid(r, reason, why):
    assert r.status_code == 200, f"{why}: POST /v1/bids answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("bid_cents", 0) is None and body.get("reason") == reason, f"{why} the service answered {body}, expected the no-bid {{bid_cents: null, reason: {reason!r}}}"


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _bid(c)
    assert r.status_code == 200, f"POST /v1/bids answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("auction_id") == "a-1" and body.get("bid_cents") == VALUE and body.get("degraded") is False, f"a healthy auction must bid the model's {VALUE} cents, not degraded, got {body}"
    assert _spent(ctx) == VALUE, f"the bid must claim its {VALUE} cents of the day's cap; the counters hold {_spent(ctx)}"


async def check_validate(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/bids", json=BODY)
        assert r.status_code == 401, f"a bid request without X-Bidder-Id answered {r.status_code}, expected 401: there is no budget to bid from"
        for changes, why in (
            ({"floor_cents": -1}, "a negative floor_cents"),
            ({"floor_cents": 1_000_001}, "floor_cents above 1 000 000"),
            ({"timeout_ms": 0}, "timeout_ms 0"),
            ({"timeout_ms": 5000}, "timeout_ms 5000"),
            ({"auction_id": ""}, "an empty auction_id"),
        ):
            r = await _bid(c, **changes)
            assert r.status_code == 400, f"{why} answered {r.status_code}: {r.text}, expected 400"
        assert _spent(ctx) == 0 and not ctx.grpc.calls_to("Identity"), "a rejected request must be neither priced nor claimed"
        r = await _bid(c, timeout_ms=200, floor_cents=0)
    assert r.status_code == 200 and r.json().get("bid_cents") == VALUE, f"timeout_ms 200 and floor_cents 0 are in range: the service answered {r.status_code} {r.text}"


async def check_deadline(ctx):
    async with _api(ctx) as c:
        for method in ("Identity", "Contextual", "Score"):
            ctx.grpc.set_latency(method, 0.025)
        started = ctx.clock.time()
        r = await _bid(c, timeout_ms=20)
        took_ms = (ctx.clock.time() - started) * 1000
    assert r.status_code == 200, f"POST /v1/bids answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("bid_cents", 0) is None and body.get("reason") == "deadline_exceeded", f"an auction with timeout_ms 20 and features answering in 25 ms got {body} after {took_ms:.0f} ms: the budget is the request's timeout_ms, and a quote that used it up is a no-bid"
    assert took_ms <= 21, f"the answer to a 20 ms auction took {took_ms:.0f} ms"
    for call in ctx.grpc.calls_to("Identity") + ctx.grpc.calls_to("Contextual") + ctx.grpc.calls_to("Score"):
        assert call.timeout is not None and call.timeout <= 0.0201, f"a {call.method} call got a {(call.timeout or 0) * 1000:.0f} ms deadline inside a 20 ms auction"
    assert _spent(ctx) == 0, f"a no-bid must claim nothing; the counters hold {_spent(ctx)}"


async def check_no_late_bid(ctx):
    async with _api(ctx) as c:
        ctx.grpc.set_latency("Identity", 0.025)
        ctx.grpc.set_latency("Contextual", 0.030)
        r = await _bid(c, timeout_ms=60)
        _no_bid(r, "deadline_exceeded", "with 5 ms of a 60 ms budget left after pricing (MIN_BID_MS is 10)")
        assert _spent(ctx) == 0, f"a no-bid must claim nothing; the counters hold {_spent(ctx)}"
        ctx.grpc.set_latency("Identity", 0)
        ctx.grpc.set_latency("Contextual", 0)
        r = await _bid(c, auction_id="a-2")
    assert r.json().get("bid_cents") == VALUE, f"with the whole budget left the service must bid, got {r.text}"


async def check_budget(ctx):
    async with _api(ctx, cap=300) as c:
        r = await _bid(c)
        _no_bid(r, "budget_exhausted", "with 300 cents of cap left and a quote of 310")
        assert _spent(ctx) == 0, f"the refused claim must leave the counters at 0, they hold {_spent(ctx)}"
        ctx.redis.set("cap:b-1", 1000)
        r = await _bid(c, auction_id="a-2")
    assert r.json().get("bid_cents") == VALUE and _spent(ctx) == VALUE, f"with the cap raised to 1000 the service must bid {VALUE} and claim it, got {r.text} with {_spent(ctx)} claimed"
`,
    typescript: `const BODY = {auction_id: 'a-1', floor_cents: 250, timeout_ms: 100, user_hash: 'u-9'};
const HEADERS = {'X-Bidder-Id': 'b-1'};
const VALUE = 310;

function api(ctx, cap = 100_000) {
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
  ctx.redis.set('cap:b-1', cap);
  return ctx.client(ctx.load('api').app);
}

const spent = (ctx): number => (ctx.redis.keys('spend:*') as string[]).reduce((sum, k) => sum + Number(ctx.redis.get(k) ?? 0), 0);

const bid = (c, changes: Record<string, unknown> = {}) => c.post('/v1/bids', {json: {...BODY, ...changes}, headers: HEADERS});

function noBid(r, reason: string, why: string): void {
  assert.equal(r.status, 200, \`\${why}: POST /v1/bids answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.bid_cents === null && body.reason === reason, \`\${why} the service answered \${r.text}, expected the no-bid {bid_cents: null, reason: "\${reason}"}\`);
}

export async function check_route(ctx) {
  const c = api(ctx);
  const r = await bid(c);
  assert.equal(r.status, 200, \`POST /v1/bids answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.auction_id === 'a-1' && body.bid_cents === VALUE && body.degraded === false, \`a healthy auction must bid the model's \${VALUE} cents, not degraded, got \${r.text}\`);
  assert.equal(spent(ctx), VALUE, \`the bid must claim its \${VALUE} cents of the day's cap; the counters hold \${spent(ctx)}\`);
}

export async function check_validate(ctx) {
  const c = api(ctx);
  let r = await c.post('/v1/bids', {json: BODY});
  assert.equal(r.status, 401, \`a bid request without X-Bidder-Id answered \${r.status}, expected 401: there is no budget to bid from\`);
  const cases: [Record<string, unknown>, string][] = [
    [{floor_cents: -1}, 'a negative floor_cents'],
    [{floor_cents: 1_000_001}, 'floor_cents above 1 000 000'],
    [{timeout_ms: 0}, 'timeout_ms 0'],
    [{timeout_ms: 5000}, 'timeout_ms 5000'],
    [{auction_id: ''}, 'an empty auction_id'],
  ];
  for (const [changes, why] of cases) {
    r = await bid(c, changes);
    assert.equal(r.status, 400, \`\${why} answered \${r.status}: \${r.text}, expected 400\`);
  }
  assert(spent(ctx) === 0 && ctx.grpc.callsTo('Identity').length === 0, 'a rejected request must be neither priced nor claimed');
  r = await bid(c, {timeout_ms: 200, floor_cents: 0});
  assert(r.status === 200 && r.json().bid_cents === VALUE, \`timeout_ms 200 and floor_cents 0 are in range: the service answered \${r.status} \${r.text}\`);
}

export async function check_deadline(ctx) {
  const c = api(ctx);
  for (const method of ['Identity', 'Contextual', 'Score']) ctx.grpc.setLatency(method, 0.025);
  const started = ctx.clock.now();
  const r = await bid(c, {timeout_ms: 20});
  const tookMs = ctx.clock.now() - started;
  assert.equal(r.status, 200, \`POST /v1/bids answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.bid_cents === null && body.reason === 'deadline_exceeded', \`an auction with timeout_ms 20 and features answering in 25 ms got \${r.text} after \${tookMs} ms: the budget is the request's timeout_ms, and a quote that used it up is a no-bid\`);
  assert(tookMs <= 21, \`the answer to a 20 ms auction took \${tookMs} ms\`);
  for (const call of ctx.grpc.calls) {
    assert(call.timeout !== null && call.timeout <= 0.0201, \`a \${call.path} call got a \${Math.round((call.timeout ?? 0) * 1000)} ms deadline inside a 20 ms auction\`);
  }
  assert.equal(spent(ctx), 0, \`a no-bid must claim nothing; the counters hold \${spent(ctx)}\`);
}

export async function check_no_late_bid(ctx) {
  const c = api(ctx);
  ctx.grpc.setLatency('Identity', 0.025);
  ctx.grpc.setLatency('Contextual', 0.03);
  let r = await bid(c, {timeout_ms: 60});
  noBid(r, 'deadline_exceeded', 'with 5 ms of a 60 ms budget left after pricing (MIN_BID_MS is 10)');
  assert.equal(spent(ctx), 0, \`a no-bid must claim nothing; the counters hold \${spent(ctx)}\`);
  ctx.grpc.setLatency('Identity', 0);
  ctx.grpc.setLatency('Contextual', 0);
  r = await bid(c, {auction_id: 'a-2'});
  assert.equal(r.json().bid_cents, VALUE, \`with the whole budget left the service must bid, got \${r.text}\`);
}

export async function check_budget(ctx) {
  const c = api(ctx, 300);
  let r = await bid(c);
  noBid(r, 'budget_exhausted', 'with 300 cents of cap left and a quote of 310');
  assert.equal(spent(ctx), 0, \`the refused claim must leave the counters at 0, they hold \${spent(ctx)}\`);
  ctx.redis.set('cap:b-1', 1000);
  r = await bid(c, {auction_id: 'a-2'});
  assert(r.json().bid_cents === VALUE && spent(ctx) === VALUE, \`with the cap raised to 1000 the service must bid \${VALUE} and claim it, got \${r.text} with \${spent(ctx)} claimed\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	pb "rtb/gen/realtime_bidding"

	"leetbuild/harness"
)

const apiValue = 310

type apiFeatures struct {
	pb.UnimplementedFeaturesServer
}

func (apiFeatures) Identity(context.Context, *pb.IdentityRequest) (*pb.IdentityFeatures, error) {
	return &pb.IdentityFeatures{Segment: "sports", Frequency: 2}, nil
}

func (apiFeatures) Contextual(context.Context, *pb.ContextRequest) (*pb.ContextFeatures, error) {
	return &pb.ContextFeatures{Category: "news", ViewabilityPct: 70}, nil
}

type apiScorer struct {
	pb.UnimplementedScorerServer
}

func (apiScorer) Score(context.Context, *pb.ScoreRequest) (*pb.ScoreReply, error) {
	return &pb.ScoreReply{ValueCents: apiValue}, nil
}

func api(ctx *harness.Ctx, cap int64) *harness.HTTP {
	pb.RegisterFeaturesServer(ctx.GRPC.Server(""), apiFeatures{})
	pb.RegisterScorerServer(ctx.GRPC.Server(""), apiScorer{})
	ctx.Redis.Set("cap:b-1", cap)
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiBody(changes map[string]any) map[string]any {
	body := map[string]any{"auction_id": "a-1", "floor_cents": 250, "timeout_ms": 100, "user_hash": "u-9"}
	for k, v := range changes {
		body[k] = v
	}
	return body
}

func apiBid(c *harness.HTTP, changes map[string]any) *harness.Response {
	return c.Post("/v1/bids", apiBody(changes), "X-Bidder-Id", "b-1")
}

func apiSpent(ctx *harness.Ctx) int64 {
	var sum int64
	for _, k := range ctx.Redis.Keys("spend:*") {
		v, _ := ctx.Redis.Get(k)
		n, _ := strconv.ParseInt(v, 10, 64)
		sum += n
	}
	return sum
}

type apiAnswer struct {
	AuctionID string \`json:"auction_id"\`
	BidCents  *int64 \`json:"bid_cents"\`
	Degraded  bool   \`json:"degraded"\`
	Reason    string \`json:"reason"\`
}

func apiDecode(ctx *harness.Ctx, r *harness.Response, why string) apiAnswer {
	ctx.Equal(r.Status, 200, "%s: POST /v1/bids (%s)", why, r.Text())
	var a apiAnswer
	r.Decode(&a)
	return a
}

func apiBids(a apiAnswer, cents int64) bool { return a.BidCents != nil && *a.BidCents == cents }

func apiNoBid(ctx *harness.Ctx, r *harness.Response, reason, why string) {
	a := apiDecode(ctx, r, why)
	ctx.Assert(a.BidCents == nil && a.Reason == reason, "%s the service answered %s, expected the no-bid {bid_cents: null, reason: %q}", why, strings.TrimSpace(r.Text()), reason)
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx, 100000)
	a := apiDecode(ctx, apiBid(c, nil), "a healthy auction")
	ctx.Assert(a.AuctionID == "a-1" && apiBids(a, apiValue) && !a.Degraded, "a healthy auction must bid the model's %d cents, not degraded, got %+v", apiValue, a)
	ctx.Equal(apiSpent(ctx), apiValue, "the bid must claim its cents of the day's cap; the counters")
}

func CheckValidate(ctx *harness.Ctx) {
	c := api(ctx, 100000)
	r := c.Post("/v1/bids", apiBody(nil))
	ctx.Equal(r.Status, 401, "a bid request without X-Bidder-Id (there is no budget to bid from)")
	cases := []struct {
		changes map[string]any
		why     string
	}{
		{map[string]any{"floor_cents": -1}, "a negative floor_cents"},
		{map[string]any{"floor_cents": 1000001}, "floor_cents above 1 000 000"},
		{map[string]any{"timeout_ms": 0}, "timeout_ms 0"},
		{map[string]any{"timeout_ms": 5000}, "timeout_ms 5000"},
		{map[string]any{"auction_id": ""}, "an empty auction_id"},
	}
	for _, tc := range cases {
		r = apiBid(c, tc.changes)
		ctx.Equal(r.Status, 400, "%s (%s)", tc.why, r.Text())
	}
	ctx.Assert(apiSpent(ctx) == 0 && len(ctx.GRPC.CallsTo("Identity", "")) == 0, "a rejected request must be neither priced nor claimed")
	a := apiDecode(ctx, apiBid(c, map[string]any{"timeout_ms": 200, "floor_cents": 0}), "timeout_ms 200 and floor_cents 0 are in range")
	ctx.Assert(apiBids(a, apiValue), "timeout_ms 200 and floor_cents 0 are in range: the service answered %+v", a)
}

func CheckDeadline(ctx *harness.Ctx) {
	c := api(ctx, 100000)
	for _, method := range []string{"Identity", "Contextual", "Score"} {
		ctx.GRPC.SetLatency(method, 0.025, "")
	}
	started := ctx.Clock.Now()
	r := apiBid(c, map[string]any{"timeout_ms": 20})
	took := ctx.Clock.Now() - started
	a := apiDecode(ctx, r, "a 20 ms auction")
	ctx.Assert(a.BidCents == nil && a.Reason == "deadline_exceeded", "an auction with timeout_ms 20 and features answering in 25 ms got %s after %d ms: the budget is the request's timeout_ms, and a quote that used it up is a no-bid", strings.TrimSpace(r.Text()), took)
	ctx.Assert(took <= 21, "the answer to a 20 ms auction took %d ms", took)
	for _, call := range ctx.GRPC.Calls() {
		ctx.Assert(call.HasDeadline() && call.Timeout <= 20*time.Millisecond+100*time.Microsecond, "a %s call got a %v deadline inside a 20 ms auction", call.Method, call.Timeout)
	}
	ctx.Equal(apiSpent(ctx), 0, "a no-bid must claim nothing; the counters")
}

func CheckNoLateBid(ctx *harness.Ctx) {
	c := api(ctx, 100000)
	ctx.GRPC.SetLatency("Identity", 0.025, "")
	ctx.GRPC.SetLatency("Contextual", 0.030, "")
	apiNoBid(ctx, apiBid(c, map[string]any{"timeout_ms": 60}), "deadline_exceeded", "with 5 ms of a 60 ms budget left after pricing (minBidMs is 10)")
	ctx.Equal(apiSpent(ctx), 0, "a no-bid must claim nothing; the counters")
	ctx.GRPC.SetLatency("Identity", 0, "")
	ctx.GRPC.SetLatency("Contextual", 0, "")
	a := apiDecode(ctx, apiBid(c, map[string]any{"auction_id": "a-2"}), "with the whole budget left")
	ctx.Assert(apiBids(a, apiValue), "with the whole budget left the service must bid, got %+v", a)
}

func CheckBudget(ctx *harness.Ctx) {
	c := api(ctx, 300)
	apiNoBid(ctx, apiBid(c, nil), "budget_exhausted", "with 300 cents of cap left and a quote of 310")
	ctx.Equal(apiSpent(ctx), 0, "the refused claim must leave the counters at 0; they hold")
	ctx.Redis.Set("cap:b-1", 1000)
	a := apiDecode(ctx, apiBid(c, map[string]any{"auction_id": "a-2"}), "with the cap raised to 1000")
	ctx.Assert(apiBids(a, apiValue) && apiSpent(ctx) == apiValue, "with the cap raised to 1000 the service must bid %d and claim it, got %+v with %d claimed", apiValue, a, apiSpent(ctx))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <utility>
#include <vector>

#include "realtime_bidding.grpc.pb.h"

using json = nlohmann::json;

namespace {

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

struct World {
  FeaturesPeer features;
  ScorerPeer scorer;
  httplib::Server svr;
};

harness::HTTP api(harness::Ctx& ctx, long cap) {
  static World* world = nullptr;
  delete world;
  world = new World;
  ctx.GRPC.Server("")->RegisterService(&world->features);
  ctx.GRPC.Server("")->RegisterService(&world->scorer);
  ctx.Redis.Set("cap:b-1", cap);
  register_routes(world->svr);
  return ctx.HTTP(world->svr);
}

json body(const json& changes = json::object()) {
  json out = {{"auction_id", "a-1"}, {"floor_cents", 250}, {"timeout_ms", 100}, {"user_hash", "u-9"}};
  for (const auto& [k, v] : changes.items()) out[k] = v;
  return out;
}

harness::Response bid(harness::HTTP& c, const json& changes = json::object()) {
  return c.Post("/v1/bids", body(changes).dump(), "Content-Type", "application/json", "X-Bidder-Id", "b-1");
}

long spent(harness::Ctx& ctx) {
  long sum = 0;
  for (const auto& k : ctx.Redis.Keys("spend:*")) sum += std::stol(ctx.Redis.Get(k).value_or("0"));
  return sum;
}

json answer(harness::Ctx& ctx, const harness::Response& r, const std::string& why) {
  ctx.Equal(r.Status, 200, "%s: POST /v1/bids (%s)", why, r.Text());
  const json a = json::parse(r.Text(), nullptr, false);
  ctx.Assert(a.is_object(), "%s: the answer is not a JSON object: %s", why, r.Text());
  return a;
}

bool bids(const json& a, long cents) { return a.contains("bid_cents") && a["bid_cents"].is_number_integer() && a["bid_cents"].get<long>() == cents; }

bool noBidWith(const json& a, const std::string& reason) {
  return a.contains("bid_cents") && a["bid_cents"].is_null() && a.value("reason", "") == reason;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx, 100000);
  const auto r = bid(c);
  const json a = answer(ctx, r, "a healthy auction");
  ctx.Assert(a.value("auction_id", "") == "a-1" && bids(a, kValue) && a.value("degraded", true) == false, "a healthy auction must bid the model's %d cents, not degraded, got %s", kValue, r.Text());
  ctx.Equal(spent(ctx), kValue, "the bid must claim its cents of the day's cap; the counters");
}

void CheckValidate(harness::Ctx& ctx) {
  auto c = api(ctx, 100000);
  auto r = c.Post("/v1/bids", body().dump(), "Content-Type", "application/json");
  ctx.Equal(r.Status, 401, "a bid request without X-Bidder-Id (there is no budget to bid from)");
  const std::vector<std::pair<json, std::string>> cases = {
      {{{"floor_cents", -1}}, "a negative floor_cents"},
      {{{"floor_cents", 1000001}}, "floor_cents above 1 000 000"},
      {{{"timeout_ms", 0}}, "timeout_ms 0"},
      {{{"timeout_ms", 5000}}, "timeout_ms 5000"},
      {{{"auction_id", ""}}, "an empty auction_id"},
  };
  for (const auto& [changes, why] : cases) {
    r = bid(c, changes);
    ctx.Equal(r.Status, 400, "%s (%s)", why, r.Text());
  }
  ctx.Assert(spent(ctx) == 0 && ctx.GRPC.CallsTo("Identity").empty(), "a rejected request must be neither priced nor claimed");
  r = bid(c, {{"timeout_ms", 200}, {"floor_cents", 0}});
  ctx.Assert(r.Status == 200 && bids(json::parse(r.Text(), nullptr, false), kValue), "timeout_ms 200 and floor_cents 0 are in range: the service answered %d %s", r.Status, r.Text());
}

void CheckDeadline(harness::Ctx& ctx) {
  auto c = api(ctx, 100000);
  for (const char* method : {"Identity", "Contextual", "Score"}) ctx.GRPC.SetLatency(method, 0.025);
  const int64_t started = ctx.Clock.Now();
  const auto r = bid(c, {{"timeout_ms", 20}});
  const int64_t took = ctx.Clock.Now() - started;
  const json a = answer(ctx, r, "a 20 ms auction");
  ctx.Assert(noBidWith(a, "deadline_exceeded"), "an auction with timeout_ms 20 and features answering in 25 ms got %s after %d ms: the budget is the request's timeout_ms, and a quote that used it up is a no-bid", r.Text(), took);
  ctx.Assert(took <= 21, "the answer to a 20 ms auction took %d ms", took);
  for (const auto& call : ctx.GRPC.Calls()) {
    ctx.Assert(call.HasDeadline() && call.TimeoutSeconds() <= 0.0201, "a %s call got a %v s deadline inside a 20 ms auction", call.Method, call.TimeoutSeconds());
  }
  ctx.Equal(spent(ctx), 0, "a no-bid must claim nothing; the counters");
}

void CheckNoLateBid(harness::Ctx& ctx) {
  auto c = api(ctx, 100000);
  ctx.GRPC.SetLatency("Identity", 0.025);
  ctx.GRPC.SetLatency("Contextual", 0.030);
  auto r = bid(c, {{"timeout_ms", 60}});
  ctx.Assert(noBidWith(answer(ctx, r, "a 60 ms auction"), "deadline_exceeded"), "with 5 ms of a 60 ms budget left after pricing (kMinBidMs is 10) the service answered %s, expected the no-bid {bid_cents: null, reason: \\"deadline_exceeded\\"}", r.Text());
  ctx.Equal(spent(ctx), 0, "a no-bid must claim nothing; the counters");
  ctx.GRPC.SetLatency("Identity", 0);
  ctx.GRPC.SetLatency("Contextual", 0);
  r = bid(c, {{"auction_id", "a-2"}});
  ctx.Assert(bids(answer(ctx, r, "with the whole budget left"), kValue), "with the whole budget left the service must bid, got %s", r.Text());
}

void CheckBudget(harness::Ctx& ctx) {
  auto c = api(ctx, 300);
  auto r = bid(c);
  ctx.Assert(noBidWith(answer(ctx, r, "a capped bidder"), "budget_exhausted"), "with 300 cents of cap left and a quote of 310 the service answered %s, expected the no-bid {bid_cents: null, reason: \\"budget_exhausted\\"}", r.Text());
  ctx.Equal(spent(ctx), 0, "the refused claim must leave the counters at 0; they hold");
  ctx.Redis.Set("cap:b-1", 1000);
  r = bid(c, {{"auction_id", "a-2"}});
  ctx.Assert(bids(answer(ctx, r, "with the cap raised"), kValue) && spent(ctx) == kValue, "with the cap raised to 1000 the service must bid %d and claim it, got %s with %d claimed", kValue, r.Text(), spent(ctx));
}
`,
  },
  hints: [
    'Send a bid request with `timeout_ms: 20` while the feature service answers in 25 ms: the bid comes back after 75 ms. Send one with `floor_cents: -1` or no `X-Bidder-Id`: it is priced too.',
    "The deadline is started from `DEFAULT_BUDGET_MS`, so the exchange's budget never reaches the pricing. Nothing compares what is left with `MIN_BID_MS`, nothing validates the body, and the result of `spend.claim` is dropped.",
    'Answer 401/400 before pricing, `Deadline.start(body.timeout_ms)`, return `no_bid(…, "deadline_exceeded")` when `remaining_ms() < MIN_BID_MS` after the quote, and `no_bid(…, "budget_exhausted")` when `spend.claim` returns false.',
  ],
  debrief: `The exchange owns the clock: \`timeout_ms\` is the time it waits, so the bidder's job is to spend that number, not one of its own. Starting the deadline once and handing it to every stage is what makes a slow first tier shorten the later ones; checking what is left before answering accounts for the trip back, which the bidder cannot speed up. A late bid and an unfunded bid look healthy in the bidder's own logs and cost the same at the exchange: discarded responses that count against the bidder's timeout rate. Production bidders read the budget from OpenRTB's \`tmax\`, subtract a measured network allowance per exchange, and send an explicit no-bid (HTTP 204 or an \`nbr\` code) so the exchange can tell "no" from "slow".`,
};
