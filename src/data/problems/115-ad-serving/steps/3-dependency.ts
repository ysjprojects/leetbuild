import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'One exchange call under 150 ms, with a house ad',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies'],
  file: 'client',
  focus: ['server', 'exchange', 'house'],
  task: `## Task

**Starting point.** The starter is \`select_ad(placement, user_hash)\`, the hop a serve makes when
no direct campaign won: it calls \`Exchange.SelectAd\` on \`exchange:9000\` with a 1-second
deadline, retries any error up to \`MAX_ATTEMPTS\` times with a short sleep, and answers
\`{"ad": {...}, "kind": "paid", "fallback": false, "fallback_reason": null}\` with the bid, or
\`{"ad": null, ...}\` when every try failed. It serves the demo and hides four flaws.

**Failure mode the checks target.** A slow exchange holds the page for seconds, an exchange that is
down is asked three times per page, the slot it leaves is blank and nobody can count it, and a
request the exchange refuses as malformed is retried until it happens to pass.

- **One** \`SelectAd\` per serve, with an \`EXCHANGE_DEADLINE_S\` of **0.15 s**: no loop, no sleep.
- On \`DEADLINE_EXCEEDED\` or \`UNAVAILABLE\` the answer is the house ad: \`{"ad": HOUSE_AD,
  "kind": "house", "fallback": true, "fallback_reason": "deadline_exceeded"}\` (or
  \`"unavailable"\`), so billing and the delivery report count it apart from paid impressions.
- Any other status raises \`ExchangeError\`: the exchange rejected the request itself.`,
  sequence: {
    participants: ['Ad Server', 'Ad exchange', 'House ads'],
    messages: [
      {from: 'Ad Server', to: 'Ad exchange', label: 'SelectAd(placement, user_hash) · deadline 150 ms', kind: 'sync'},
      {from: 'Ad exchange', to: 'Ad Server', label: 'Bid → kind paid', kind: 'reply'},
      {from: 'Ad exchange', to: 'Ad Server', label: 'DEADLINE_EXCEEDED / UNAVAILABLE', kind: 'reply'},
      {from: 'Ad Server', to: 'House ads', label: 'HOUSE_AD · kind house · fallback_reason', kind: 'sync'},
      {from: 'Ad exchange', to: 'Ad Server', label: 'INVALID_ARGUMENT → raise ExchangeError', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Calls the exchange under a 150 ms deadline',
      detail:
        'The `SelectAd` call carries a deadline of 150 ms (`EXCHANGE_DEADLINE_S`), the share of the page budget the exchange gets; the starter gives it a full second.',
      match: {
        python: {
          all: [/EXCHANGE_DEADLINE_S\s*=\s*0?\.15\b/, /SelectAd\([\s\S]{0,200}?timeout\s*=\s*EXCHANGE_DEADLINE_S/],
        },
        typescript: {
          all: [/EXCHANGE_DEADLINE_MS\s*=\s*150\b/, /SelectAd\([\s\S]{0,200}?deadline:[^\n]*EXCHANGE_DEADLINE_MS/],
        },
        go: {
          all: [
            /exchangeDeadline\s*=\s*150\s*\*\s*time\.Millisecond/,
            /context\.WithTimeout\([^\n]*exchangeDeadline\s*\)/,
          ],
        },
        scala: {
          all: [
            /ExchangeDeadlineMs\s*=\s*150L?\b/,
            /withDeadlineAfter\(\s*ExchangeDeadlineMs,\s*TimeUnit\.MILLISECONDS/,
          ],
        },
        cpp: {all: [/kExchangeDeadline\{150\}/, /set_deadline\([^\n]*kExchangeDeadline\)/]},
      },
    },
    {
      id: 'one-call',
      title: 'Makes exactly one exchange call per serve',
      detail:
        'An exchange that is down or slow costs one call and one deadline: no retry loop and no sleep inside the request. The starter tries `MAX_ATTEMPTS` times and sleeps between tries.',
      match: {
        python: {none: [/time\.sleep\(/, /for \w+ in range\(/, /while\s+True/]},
        typescript: {none: [/setTimeout\(/, /for \(let attempt/, /for \(;;\)/, /while \(true\)/]},
        go: {none: [/time\.Sleep\(/, /for attempt :=/]},
        scala: {none: [/Thread\.sleep\(/, /\(1 to MaxAttempts\)/, /while \(true\)/]},
        cpp: {none: [/sleep_for\(/, /for \(int attempt/, /while \(true\)/]},
      },
    },
    {
      id: 'house-fallback',
      title: 'Serves the house ad, marked, when the exchange cannot answer',
      detail:
        '`DEADLINE_EXCEEDED` or `UNAVAILABLE` answers `HOUSE_AD` with `kind: "house"`, `fallback: true` and the status as `fallback_reason`; a bid answers `kind: "paid"`, `fallback: false`. The starter leaves the slot empty.',
      match: {
        python: {all: [/DEADLINE_EXCEEDED/, /UNAVAILABLE/, /HOUSE_AD/, /["']kind["']\s*:\s*["']house["']/]},
        typescript: {all: [/DEADLINE_EXCEEDED/, /UNAVAILABLE/, /HOUSE_AD/, /kind:\s*['"]house['"]/]},
        go: {all: [/codes\.DeadlineExceeded/, /codes\.Unavailable/, /store\.HouseAd/, /Kind:\s*"house"/]},
        scala: {all: [/DEADLINE_EXCEEDED/, /UNAVAILABLE/, /Store\.HouseAd/, /"house"/]},
        cpp: {all: [/DEADLINE_EXCEEDED/, /UNAVAILABLE/, /store::kHouseAd/, /"house"/]},
      },
    },
    {
      id: 'propagate-errors',
      title: 'Raises ExchangeError for any other status',
      detail:
        'An `INVALID_ARGUMENT` (or any status other than the two above) raises `ExchangeError` after one call: the exchange refused this request, and another try or a house ad would hide the bug. The starter retries it.',
      match: {
        python: {all: [/raise ExchangeError\(/]},
        typescript: {all: [/throw new ExchangeError\(/]},
        go: {all: [/fmt\.Errorf\(\s*"%w[^"]*",\s*ErrExchange/]},
        scala: {all: [/throw new ExchangeError\(/]},
        cpp: {all: [/throw ExchangeError\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import ad_serving_pb2
import ad_serving_pb2_grpc
from ads.store import HOUSE_AD

EXCHANGE_DEADLINE_S = 1.0
MAX_ATTEMPTS = 3

exchange = ad_serving_pb2_grpc.ExchangeStub(grpc.insecure_channel("exchange:9000"))


class ExchangeError(Exception):
    """The exchange refused the request itself."""


def select_ad(placement: str, user_hash: str) -> dict:
    """The ad for a slot no direct campaign filled."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    for _ in range(MAX_ATTEMPTS):
        try:
            bid = exchange.SelectAd(ad_serving_pb2.SelectAdRequest(placement=placement, user_hash=user_hash), timeout=EXCHANGE_DEADLINE_S)
            ad = {"campaign_id": bid.campaign_id, "creative_id": bid.creative_id, "price_micros": bid.price_micros}
            return {"ad": ad, "kind": "paid", "fallback": False, "fallback_reason": None}
        except grpc.RpcError:
            time.sleep(0.05)
    return {"ad": None, "kind": "paid", "fallback": False, "fallback_reason": None}
`,
      solution: `import grpc

import ad_serving_pb2
import ad_serving_pb2_grpc
from ads.store import HOUSE_AD

EXCHANGE_DEADLINE_S = 0.15
# The exchange could not answer in time: the slot is still ours to fill.
FALLBACK_CODES = (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE)

exchange = ad_serving_pb2_grpc.ExchangeStub(grpc.insecure_channel("exchange:9000"))


class ExchangeError(Exception):
    """The exchange refused the request itself."""


def select_ad(placement: str, user_hash: str) -> dict:
    """The ad for a slot no direct campaign filled."""
    try:
        bid = exchange.SelectAd(ad_serving_pb2.SelectAdRequest(placement=placement, user_hash=user_hash), timeout=EXCHANGE_DEADLINE_S)
    except grpc.RpcError as exc:
        if exc.code() in FALLBACK_CODES:
            # A house ad keeps the page whole; kind and reason keep it out of the advertisers' bills.
            return {"ad": dict(HOUSE_AD), "kind": "house", "fallback": True, "fallback_reason": exc.code().name.lower()}
        # A request the exchange rejected is a bug to surface, not a slot to fill.
        raise ExchangeError(f"exchange: {exc.code().name}: {exc.details()}") from exc
    ad = {"campaign_id": bid.campaign_id, "creative_id": bid.creative_id, "price_micros": bid.price_micros}
    return {"ad": ad, "kind": "paid", "fallback": False, "fallback_reason": None}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Ad, HOUSE_AD} from 'ads/store';

export const EXCHANGE_DEADLINE_MS = 1000;
export const MAX_ATTEMPTS = 3;

interface Bid {
  campaign_id: string;
  creative_id: string;
  price_micros: number | string;
}

/** The ad for one slot and how it was filled. */
export interface Selection {
  ad: Ad | null;
  kind: 'paid' | 'house';
  fallback: boolean;
  fallback_reason: string | null;
}

type BidCallback = (error: grpc.ServiceError | null, bid?: Bid) => void;

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('ad_serving.proto')) as unknown as {
  adserved: {Exchange: grpc.ServiceClientConstructor};
};
const exchange = new pkg.adserved.Exchange('exchange:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  SelectAd(request: {placement: string; user_hash: string}, options: grpc.CallOptions, callback: BidCallback): grpc.ClientUnaryCall;
};

/** The exchange refused the request itself. */
export class ExchangeError extends Error {}

function selectAdCall(placement: string, userHash: string): Promise<Bid> {
  const {promise, resolve, reject} = Promise.withResolvers<Bid>();
  exchange.SelectAd({placement, user_hash: userHash}, {deadline: Date.now() + EXCHANGE_DEADLINE_MS}, (error, bid) => (error ? reject(error) : resolve(bid as Bid)));
  return promise;
}

/** The ad for a slot no direct campaign filled. */
export async function selectAd(placement: string, userHash: string): Promise<Selection> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const bid = await selectAdCall(placement, userHash);
      return {ad: {campaign_id: bid.campaign_id, creative_id: bid.creative_id, price_micros: Number(bid.price_micros)}, kind: 'paid', fallback: false, fallback_reason: null};
    } catch {
      const {promise, resolve} = Promise.withResolvers<void>();
      setTimeout(resolve, 50);
      await promise;
    }
  }
  return {ad: null, kind: 'paid', fallback: false, fallback_reason: null};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Ad, HOUSE_AD} from 'ads/store';

export const EXCHANGE_DEADLINE_MS = 150;
// The exchange could not answer in time: the slot is still ours to fill.
const FALLBACK_CODES: readonly number[] = [grpc.status.DEADLINE_EXCEEDED, grpc.status.UNAVAILABLE];

interface Bid {
  campaign_id: string;
  creative_id: string;
  price_micros: number | string;
}

/** The ad for one slot and how it was filled. */
export interface Selection {
  ad: Ad | null;
  kind: 'paid' | 'house';
  fallback: boolean;
  fallback_reason: string | null;
}

type BidCallback = (error: grpc.ServiceError | null, bid?: Bid) => void;

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('ad_serving.proto')) as unknown as {
  adserved: {Exchange: grpc.ServiceClientConstructor};
};
const exchange = new pkg.adserved.Exchange('exchange:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  SelectAd(request: {placement: string; user_hash: string}, options: grpc.CallOptions, callback: BidCallback): grpc.ClientUnaryCall;
};

/** The exchange refused the request itself. */
export class ExchangeError extends Error {}

function selectAdCall(placement: string, userHash: string): Promise<Bid> {
  const {promise, resolve, reject} = Promise.withResolvers<Bid>();
  exchange.SelectAd({placement, user_hash: userHash}, {deadline: Date.now() + EXCHANGE_DEADLINE_MS}, (error, bid) => (error ? reject(error) : resolve(bid as Bid)));
  return promise;
}

/** The ad for a slot no direct campaign filled. */
export async function selectAd(placement: string, userHash: string): Promise<Selection> {
  let bid: Bid;
  try {
    bid = await selectAdCall(placement, userHash);
  } catch (e) {
    const {code, details} = e as grpc.ServiceError;
    if (FALLBACK_CODES.includes(code)) {
      // A house ad keeps the page whole; kind and reason keep it out of the advertisers' bills.
      return {ad: {...HOUSE_AD}, kind: 'house', fallback: true, fallback_reason: grpc.status[code].toLowerCase()};
    }
    // A request the exchange rejected is a bug to surface, not a slot to fill.
    throw new ExchangeError(\`exchange: \${grpc.status[code]}: \${details}\`);
  }
  return {ad: {campaign_id: bid.campaign_id, creative_id: bid.creative_id, price_micros: Number(bid.price_micros)}, kind: 'paid', fallback: false, fallback_reason: null};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"ads/store" // store.Ad, store.HouseAd
	pb "ads/gen/ad_serving"
)

const (
	exchangeDeadline = time.Second
	maxAttempts      = 3
)

var (
	exchangeConn, _ = grpc.NewClient("exchange:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	exchange        = pb.NewExchangeClient(exchangeConn)
)

// ErrExchange: the exchange refused the request itself.
var ErrExchange = errors.New("exchange error")

// Selection is the ad for one slot and how it was filled.
type Selection struct {
	Ad             store.Ad \`json:"ad"\`
	Kind           string   \`json:"kind"\`
	Fallback       bool     \`json:"fallback"\`
	FallbackReason string   \`json:"fallback_reason"\`
}

// selectAd is the ad for a slot no direct campaign filled.
func selectAd(ctx context.Context, placement, userHash string) (Selection, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, exchangeDeadline)
		bid, err := exchange.SelectAd(callCtx, &pb.SelectAdRequest{Placement: placement, UserHash: userHash})
		cancel()
		if err == nil {
			return Selection{Ad: store.Ad{CampaignID: bid.GetCampaignId(), CreativeID: bid.GetCreativeId(), PriceMicros: bid.GetPriceMicros()}, Kind: "paid"}, nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return Selection{Kind: "paid"}, nil
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"ads/store" // store.Ad, store.HouseAd
	pb "ads/gen/ad_serving"
)

const exchangeDeadline = 150 * time.Millisecond

var (
	exchangeConn, _ = grpc.NewClient("exchange:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	exchange        = pb.NewExchangeClient(exchangeConn)
)

// ErrExchange: the exchange refused the request itself.
var ErrExchange = errors.New("exchange error")

// fallbackReasons: the exchange could not answer in time, so the slot is still ours to fill.
var fallbackReasons = map[codes.Code]string{codes.DeadlineExceeded: "deadline_exceeded", codes.Unavailable: "unavailable"}

// Selection is the ad for one slot and how it was filled.
type Selection struct {
	Ad             store.Ad \`json:"ad"\`
	Kind           string   \`json:"kind"\`
	Fallback       bool     \`json:"fallback"\`
	FallbackReason string   \`json:"fallback_reason"\`
}

// selectAd is the ad for a slot no direct campaign filled.
func selectAd(ctx context.Context, placement, userHash string) (Selection, error) {
	callCtx, cancel := context.WithTimeout(ctx, exchangeDeadline)
	defer cancel()
	bid, err := exchange.SelectAd(callCtx, &pb.SelectAdRequest{Placement: placement, UserHash: userHash})
	if err != nil {
		if reason, ok := fallbackReasons[status.Code(err)]; ok {
			// A house ad keeps the page whole; kind and reason keep it out of the advertisers' bills.
			return Selection{Ad: store.HouseAd, Kind: "house", Fallback: true, FallbackReason: reason}, nil
		}
		// A request the exchange rejected is a bug to surface, not a slot to fill.
		return Selection{}, fmt.Errorf("%w: %v", ErrExchange, err)
	}
	return Selection{Ad: store.Ad{CampaignID: bid.GetCampaignId(), CreativeID: bid.GetCreativeId(), PriceMicros: bid.GetPriceMicros()}, Kind: "paid"}, nil
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import ads.Store // Store.Ad, Store.HouseAd
import adserved.ad_serving.{ExchangeGrpc, SelectAdRequest}

/** The exchange refused the request itself. */
final class ExchangeError(message: String) extends Exception(message)

/** The ad for one slot and how it was filled. */
final case class Selection(ad: Option[Store.Ad], kind: String, fallback: Boolean, fallbackReason: Option[String])

object Client {
  val ExchangeDeadlineMs = 1000L
  val MaxAttempts = 3

  private val exchange = ExchangeGrpc.blockingStub(ManagedChannelBuilder.forAddress("exchange", 9000).usePlaintext().build())

  /** The ad for a slot no direct campaign filled. */
  def selectAd(placement: String, userHash: String): Selection = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val bids = (1 to MaxAttempts).iterator.map { _ =>
      try Some(exchange.withDeadlineAfter(ExchangeDeadlineMs, TimeUnit.MILLISECONDS).selectAd(SelectAdRequest(placement, userHash)))
      catch {
        case _: StatusRuntimeException =>
          Thread.sleep(50)
          None
      }
    }
    bids
      .collectFirst { case Some(bid) => Selection(Some(Store.Ad(bid.campaignId, bid.creativeId, bid.priceMicros)), "paid", fallback = false, None) }
      .getOrElse(Selection(None, "paid", fallback = false, None))
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import ads.Store // Store.Ad, Store.HouseAd
import adserved.ad_serving.{ExchangeGrpc, SelectAdRequest}

/** The exchange refused the request itself. */
final class ExchangeError(message: String) extends Exception(message)

/** The ad for one slot and how it was filled. */
final case class Selection(ad: Option[Store.Ad], kind: String, fallback: Boolean, fallbackReason: Option[String])

object Client {
  val ExchangeDeadlineMs = 150L
  /** The exchange could not answer in time: the slot is still ours to fill. */
  private val FallbackCodes = Set(Status.Code.DEADLINE_EXCEEDED, Status.Code.UNAVAILABLE)

  private val exchange = ExchangeGrpc.blockingStub(ManagedChannelBuilder.forAddress("exchange", 9000).usePlaintext().build())

  /** The ad for a slot no direct campaign filled. */
  def selectAd(placement: String, userHash: String): Selection =
    try {
      val bid = exchange.withDeadlineAfter(ExchangeDeadlineMs, TimeUnit.MILLISECONDS).selectAd(SelectAdRequest(placement, userHash))
      Selection(Some(Store.Ad(bid.campaignId, bid.creativeId, bid.priceMicros)), "paid", fallback = false, None)
    } catch {
      // A house ad keeps the page whole; kind and reason keep it out of the advertisers' bills.
      case e: StatusRuntimeException if FallbackCodes.contains(e.getStatus.getCode) =>
        Selection(Some(Store.HouseAd), "house", fallback = true, Some(e.getStatus.getCode.name.toLowerCase))
      // A request the exchange rejected is a bug to surface, not a slot to fill.
      case e: StatusRuntimeException => throw new ExchangeError(s"exchange: \${e.getStatus.getCode}")
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>

#include "ad_serving.grpc.pb.h"
#include "ads/store.h"  // store::Ad, store::kHouseAd

constexpr std::chrono::milliseconds kExchangeDeadline{1000};
constexpr int kMaxAttempts = 3;

auto exchange = adserved::Exchange::NewStub(grpc::CreateChannel("exchange:9000", grpc::InsecureChannelCredentials()));

// The exchange refused the request itself.
struct ExchangeError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The ad for one slot and how it was filled.
struct Selection {
  store::Ad ad;
  std::string kind;
  bool fallback = false;
  std::string fallback_reason;
};

// The ad for a slot no direct campaign filled.
Selection selectAd(const std::string& placement, const std::string& user_hash) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kExchangeDeadline);
    adserved::SelectAdRequest request;
    request.set_placement(placement);
    request.set_user_hash(user_hash);
    adserved::Bid bid;
    if (exchange->SelectAd(&ctx, request, &bid).ok()) {
      return Selection{store::Ad{bid.campaign_id(), bid.creative_id(), bid.price_micros()}, "paid", false, ""};
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
  return Selection{store::Ad{}, "paid", false, ""};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <map>
#include <stdexcept>
#include <string>

#include "ad_serving.grpc.pb.h"
#include "ads/store.h"  // store::Ad, store::kHouseAd

constexpr std::chrono::milliseconds kExchangeDeadline{150};

auto exchange = adserved::Exchange::NewStub(grpc::CreateChannel("exchange:9000", grpc::InsecureChannelCredentials()));

// The exchange could not answer in time: the slot is still ours to fill.
const std::map<grpc::StatusCode, std::string> kFallbackReasons = {
    {grpc::StatusCode::DEADLINE_EXCEEDED, "deadline_exceeded"},
    {grpc::StatusCode::UNAVAILABLE, "unavailable"},
};

// The exchange refused the request itself.
struct ExchangeError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The ad for one slot and how it was filled.
struct Selection {
  store::Ad ad;
  std::string kind;
  bool fallback = false;
  std::string fallback_reason;
};

// The ad for a slot no direct campaign filled.
Selection selectAd(const std::string& placement, const std::string& user_hash) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kExchangeDeadline);
  adserved::SelectAdRequest request;
  request.set_placement(placement);
  request.set_user_hash(user_hash);
  adserved::Bid bid;
  const grpc::Status status = exchange->SelectAd(&ctx, request, &bid);
  if (!status.ok()) {
    const auto reason = kFallbackReasons.find(status.error_code());
    // A house ad keeps the page whole; kind and reason keep it out of the advertisers' bills.
    if (reason != kFallbackReasons.cend()) return Selection{store::kHouseAd, "house", true, reason->second};
    // A request the exchange rejected is a bug to surface, not a slot to fill.
    throw ExchangeError("exchange: " + status.error_message());
  }
  return Selection{store::Ad{bid.campaign_id(), bid.creative_id(), bid.price_micros()}, "paid", false, ""};
}
`,
    },
  },
  harness: {
    python: `import grpc

import ad_serving_pb2
import ad_serving_pb2_grpc

BID = {"campaign_id": "c-9", "creative_id": "cr-c-9", "price_micros": 1200}
HOUSE = {"campaign_id": "house", "creative_id": "house-default", "price_micros": 0}
PAID = {"ad": BID, "kind": "paid", "fallback": False, "fallback_reason": None}


class Exchange(ad_serving_pb2_grpc.ExchangeServicer):
    """Bids 1200 micros for c-9 on every slot."""

    def SelectAd(self, request, context):
        return ad_serving_pb2.Bid(**BID)


def _client(ctx):
    ctx.grpc.serve(ad_serving_pb2_grpc.add_ExchangeServicer_to_server, Exchange())
    return ctx.load("client")


def _select(m):
    try:
        return m.select_ad("home-top", "u-1")
    except m.ExchangeError:
        return None


def check_deadline(ctx):
    m = _client(ctx)
    got = m.select_ad("home-top", "u-1")
    assert got == PAID, f"with the exchange answering, select_ad returned {got}, expected the paid bid {PAID}"
    calls = ctx.grpc.calls_to("SelectAd")
    assert len(calls) == 1, f"one serve made {len(calls)} SelectAd calls"
    assert calls[0].timeout is not None, "SelectAd carries no deadline: a stalled exchange holds the page"
    assert 0.1 <= calls[0].timeout <= 0.2, f"SelectAd carries a {calls[0].timeout} s deadline, expected EXCHANGE_DEADLINE_S = 0.15: the exchange gets a slice of the page budget, not a second"


def check_one_call(ctx):
    m = _client(ctx)
    ctx.grpc.fail("SelectAd", grpc.StatusCode.UNAVAILABLE, times=3)
    _select(m)
    calls = len(ctx.grpc.calls_to("SelectAd"))
    assert calls == 1, f"with the exchange down one serve made {calls} SelectAd calls: every page paid for the outage {calls} times. Call once"
    assert ctx.clock.sleeps == 0, f"select_ad slept {ctx.clock.sleeps} times inside the request"
    ctx.grpc.failures.clear()
    ctx.grpc.set_latency("SelectAd", 5.0)
    before = ctx.clock.time()
    _select(m)
    waited = ctx.clock.time() - before
    assert waited <= 0.2, f"with the exchange taking 5 s the serve waited {waited:.2f} s, expected one 150 ms deadline"
    assert len(ctx.grpc.calls_to("SelectAd")) == 2, "a slow exchange gets one call per serve"


def check_house_fallback(ctx):
    m = _client(ctx)
    ctx.grpc.set_latency("SelectAd", 5.0)
    got = m.select_ad("home-top", "u-1")
    want = {"ad": HOUSE, "kind": "house", "fallback": True, "fallback_reason": "deadline_exceeded"}
    assert got == want, f"with the exchange past its deadline select_ad returned {got}, expected the marked house ad {want}: an empty slot is revenue lost with nothing to count"
    ctx.grpc.set_latency("SelectAd", 0.0)
    ctx.grpc.fail("SelectAd", grpc.StatusCode.UNAVAILABLE)
    got = m.select_ad("home-top", "u-1")
    assert got == {**want, "fallback_reason": "unavailable"}, f"with the exchange UNAVAILABLE select_ad returned {got}, expected the house ad with fallback_reason unavailable"
    got = m.select_ad("home-top", "u-1")
    assert got == PAID, f"once the exchange answers again select_ad returned {got}, expected the paid bid"


def check_propagate_errors(ctx):
    m = _client(ctx)
    ctx.grpc.fail("SelectAd", grpc.StatusCode.INVALID_ARGUMENT, "placement home-top is not registered")
    try:
        got = m.select_ad("home-top", "u-1")
    except m.ExchangeError:
        pass
    except Exception as other:
        raise AssertionError(f"INVALID_ARGUMENT raised {type(other).__name__}: {other}, expected ExchangeError")
    else:
        raise AssertionError(f"INVALID_ARGUMENT from the exchange answered {got}: a request the exchange refuses is a bug to surface, not a slot to fill. Raise ExchangeError")
    calls = len(ctx.grpc.calls_to("SelectAd"))
    assert calls == 1, f"an INVALID_ARGUMENT was sent {calls} times: the same request fails the same way"
`,
    typescript: `const BID = {campaign_id: 'c-9', creative_id: 'cr-c-9', price_micros: 1200};
const HOUSE = {campaign_id: 'house', creative_id: 'house-default', price_micros: 0};
const PAID = {ad: BID, kind: 'paid', fallback: false, fallback_reason: null};

/** An exchange that bids 1200 micros for c-9 on every slot. */
function client(ctx) {
  const pkg = ctx.proto('ad_serving.proto');
  ctx.grpc.serve(pkg.adserved.Exchange.service, {
    SelectAd(_call, callback) {
      callback(null, BID);
    },
  });
  return ctx.load('client');
}

async function select(m) {
  try {
    return await m.selectAd('home-top', 'u-1');
  } catch (e) {
    if (e instanceof m.ExchangeError) return null;
    throw e;
  }
}

export async function check_deadline(ctx) {
  const m = client(ctx);
  const got = await m.selectAd('home-top', 'u-1');
  assert.deepStrictEqual(got, PAID, \`with the exchange answering, selectAd returned \${JSON.stringify(got)}, expected the paid bid\`);
  const calls = ctx.grpc.callsTo('SelectAd');
  assert.equal(calls.length, 1, \`one serve made \${calls.length} SelectAd calls\`);
  assert(calls[0].timeout !== null, 'SelectAd carries no deadline: a stalled exchange holds the page');
  assert(0.1 <= calls[0].timeout && calls[0].timeout <= 0.2, \`SelectAd carries a \${calls[0].timeout} s deadline, expected EXCHANGE_DEADLINE_MS = 150: the exchange gets a slice of the page budget, not a second\`);
}

export async function check_one_call(ctx) {
  const m = client(ctx);
  ctx.grpc.fail('SelectAd', ctx.grpc.status.UNAVAILABLE, '', 3);
  await select(m);
  const calls = ctx.grpc.callsTo('SelectAd').length;
  assert.equal(calls, 1, \`with the exchange down one serve made \${calls} SelectAd calls: every page paid for the outage \${calls} times. Call once\`);
  assert.equal(ctx.clock.sleeps, 0, \`selectAd slept \${ctx.clock.sleeps} times inside the request\`);
  ctx.grpc.clearFailures();
  ctx.grpc.setLatency('SelectAd', 5.0);
  const before = ctx.clock.now();
  await select(m);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 0.2, \`with the exchange taking 5 s the serve waited \${waited.toFixed(2)} s, expected one 150 ms deadline\`);
  assert.equal(ctx.grpc.callsTo('SelectAd').length, 2, 'a slow exchange gets one call per serve');
}

export async function check_house_fallback(ctx) {
  const m = client(ctx);
  ctx.grpc.setLatency('SelectAd', 5.0);
  let got = await m.selectAd('home-top', 'u-1');
  const want = {ad: HOUSE, kind: 'house', fallback: true, fallback_reason: 'deadline_exceeded'};
  assert.deepStrictEqual(got, want, \`with the exchange past its deadline selectAd returned \${JSON.stringify(got)}, expected the marked house ad: an empty slot is revenue lost with nothing to count\`);
  ctx.grpc.setLatency('SelectAd', 0);
  ctx.grpc.fail('SelectAd', ctx.grpc.status.UNAVAILABLE);
  got = await m.selectAd('home-top', 'u-1');
  assert.deepStrictEqual(got, {...want, fallback_reason: 'unavailable'}, \`with the exchange UNAVAILABLE selectAd returned \${JSON.stringify(got)}, expected the house ad with fallback_reason unavailable\`);
  got = await m.selectAd('home-top', 'u-1');
  assert.deepStrictEqual(got, PAID, \`once the exchange answers again selectAd returned \${JSON.stringify(got)}, expected the paid bid\`);
}

export async function check_propagate_errors(ctx) {
  const m = client(ctx);
  ctx.grpc.fail('SelectAd', ctx.grpc.status.INVALID_ARGUMENT, 'placement home-top is not registered');
  let got;
  try {
    got = await m.selectAd('home-top', 'u-1');
  } catch (e) {
    assert(e instanceof m.ExchangeError, \`INVALID_ARGUMENT threw \${(e as Error).constructor.name}: \${(e as Error).message}, expected ExchangeError\`);
    const calls = ctx.grpc.callsTo('SelectAd').length;
    assert.equal(calls, 1, \`an INVALID_ARGUMENT was sent \${calls} times: the same request fails the same way\`);
    return;
  }
  assert.fail(\`INVALID_ARGUMENT from the exchange answered \${JSON.stringify(got)}: a request the exchange refuses is a bug to surface, not a slot to fill. Throw ExchangeError\`);
}
`,
    go: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"

	"ads/store"
	pb "ads/gen/ad_serving"

	"leetbuild/harness"
)

var clientBg = context.Background()

// exchangePeer bids 1200 micros for c-9 on every slot.
type exchangePeer struct {
	pb.UnimplementedExchangeServer
}

func (exchangePeer) SelectAd(_ context.Context, _ *pb.SelectAdRequest) (*pb.Bid, error) {
	return &pb.Bid{CampaignId: "c-9", CreativeId: "cr-c-9", PriceMicros: 1200}, nil
}

var (
	clientBid  = store.Ad{CampaignID: "c-9", CreativeID: "cr-c-9", PriceMicros: 1200}
	clientPaid = Selection{Ad: clientBid, Kind: "paid"}
)

func clientPeer(ctx *harness.Ctx) {
	pb.RegisterExchangeServer(ctx.GRPC.Server(""), exchangePeer{})
}

func clientSelect(ctx *harness.Ctx, why string) Selection {
	got, err := selectAd(clientBg, "home-top", "u-1")
	ctx.NoError(err, "%s: selectAd", why)
	return got
}

func CheckDeadline(ctx *harness.Ctx) {
	clientPeer(ctx)
	ctx.Equal(clientSelect(ctx, "with the exchange answering"), clientPaid, "with the exchange answering, selectAd must return the paid bid")
	calls := ctx.GRPC.CallsTo("SelectAd", "")
	ctx.Equal(len(calls), 1, "one serve's SelectAd calls")
	ctx.Assert(calls[0].HasDeadline(), "SelectAd carries no deadline: a stalled exchange holds the page")
	ctx.Assert(100*time.Millisecond <= calls[0].Timeout && calls[0].Timeout <= 200*time.Millisecond, "SelectAd carries a %v deadline, expected exchangeDeadline = 150 ms: the exchange gets a slice of the page budget, not a second", calls[0].Timeout)
}

func CheckOneCall(ctx *harness.Ctx) {
	clientPeer(ctx)
	ctx.GRPC.Fail("SelectAd", codes.Unavailable, "", 3, "")
	selectAd(clientBg, "home-top", "u-1")
	calls := len(ctx.GRPC.CallsTo("SelectAd", ""))
	ctx.Equal(calls, 1, "with the exchange down one serve must make one SelectAd call, not pay for the outage on every try; the calls")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "selectAd must not sleep inside the request; the sleeps")
	ctx.GRPC.ClearFailures()
	ctx.GRPC.SetLatency("SelectAd", 5.0, "")
	before := ctx.Clock.Now()
	selectAd(clientBg, "home-top", "u-1")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 0.2, "with the exchange taking 5 s the serve waited %.2f s, expected one 150 ms deadline", waited)
	ctx.Equal(len(ctx.GRPC.CallsTo("SelectAd", "")), 2, "a slow exchange gets one call per serve; the calls")
}

func CheckHouseFallback(ctx *harness.Ctx) {
	clientPeer(ctx)
	ctx.GRPC.SetLatency("SelectAd", 5.0, "")
	want := Selection{Ad: store.HouseAd, Kind: "house", Fallback: true, FallbackReason: "deadline_exceeded"}
	ctx.Equal(clientSelect(ctx, "with the exchange past its deadline"), want, "with the exchange past its deadline selectAd must return the marked house ad (an empty slot is revenue lost with nothing to count)")
	ctx.GRPC.SetLatency("SelectAd", 0, "")
	ctx.GRPC.Fail("SelectAd", codes.Unavailable, "", 1, "")
	want.FallbackReason = "unavailable"
	ctx.Equal(clientSelect(ctx, "with the exchange UNAVAILABLE"), want, "with the exchange UNAVAILABLE selectAd must return the house ad with fallback_reason unavailable")
	ctx.Equal(clientSelect(ctx, "once the exchange answers again"), clientPaid, "once the exchange answers again selectAd must return the paid bid")
}

func CheckPropagateErrors(ctx *harness.Ctx) {
	clientPeer(ctx)
	ctx.GRPC.Fail("SelectAd", codes.InvalidArgument, "placement home-top is not registered", 1, "")
	got, err := selectAd(clientBg, "home-top", "u-1")
	ctx.Assert(err != nil, "INVALID_ARGUMENT from the exchange answered %+v: a request the exchange refuses is a bug to surface, not a slot to fill. Return an error wrapping ErrExchange", got)
	ctx.ErrorIs(err, ErrExchange, "INVALID_ARGUMENT returned %v", err)
	ctx.Equal(len(ctx.GRPC.CallsTo("SelectAd", "")), 1, "an INVALID_ARGUMENT fails the same way every time; the calls")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>

#include "ad_serving.grpc.pb.h"
#include "ads/store.h"

namespace {

// Bids 1200 micros for c-9 on every slot.
class ExchangePeer final : public adserved::Exchange::Service {
 public:
  grpc::Status SelectAd(grpc::ServerContext*, const adserved::SelectAdRequest*, adserved::Bid* out) override {
    out->set_campaign_id("c-9");
    out->set_creative_id("cr-c-9");
    out->set_price_micros(1200);
    return grpc::Status::OK;
  }
};

void clientPeer(harness::Ctx& ctx) {
  static ExchangePeer* peer = nullptr;
  delete peer;
  peer = new ExchangePeer;
  ctx.GRPC.Server("")->RegisterService(peer);
}

std::string clientShow(const Selection& s) {
  return "{ad " + s.ad.campaign_id + "/" + s.ad.creative_id + "/" + std::to_string(s.ad.price_micros) + ", kind " + s.kind +
         ", fallback " + (s.fallback ? "true" : "false") + ", fallback_reason \\"" + s.fallback_reason + "\\"}";
}

bool clientSame(const Selection& s, const std::string& campaign, const std::string& creative, long long price, const std::string& kind, bool fallback,
                const std::string& reason) {
  return s.ad.campaign_id == campaign && s.ad.creative_id == creative && s.ad.price_micros == price && s.kind == kind && s.fallback == fallback &&
         s.fallback_reason == reason;
}

Selection clientSelect(harness::Ctx& ctx, const std::string& why) {
  try {
    return selectAd("home-top", "u-1");
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: selectAd threw %s: %s", why, harness::CurrentExceptionType(), e.what());
  }
}

void clientQuiet() {
  try {
    selectAd("home-top", "u-1");
  } catch (const ExchangeError&) {
  }
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  clientPeer(ctx);
  const Selection got = clientSelect(ctx, "with the exchange answering");
  ctx.Assert(clientSame(got, "c-9", "cr-c-9", 1200, "paid", false, ""), "with the exchange answering, selectAd returned %s, expected the paid bid", clientShow(got));
  const auto calls = ctx.GRPC.CallsTo("SelectAd");
  ctx.Equal(calls.size(), 1, "one serve's SelectAd calls");
  ctx.Assert(calls[0].HasDeadline(), "SelectAd carries no deadline: a stalled exchange holds the page");
  ctx.Assert(0.1 <= calls[0].TimeoutSeconds() && calls[0].TimeoutSeconds() <= 0.2,
             "SelectAd carries a %v s deadline, expected kExchangeDeadline = 150 ms: the exchange gets a slice of the page budget, not a second", calls[0].TimeoutSeconds());
}

void CheckOneCall(harness::Ctx& ctx) {
  clientPeer(ctx);
  ctx.GRPC.Fail("SelectAd", grpc::StatusCode::UNAVAILABLE, "", 3);
  clientQuiet();
  ctx.Equal(ctx.GRPC.CallsTo("SelectAd").size(), 1, "with the exchange down one serve must make one SelectAd call, not pay for the outage on every try; the calls");
  ctx.Equal(ctx.Clock.Sleeps(), 0, "selectAd must not sleep inside the request; the sleeps");
  ctx.GRPC.ClearFailures();
  ctx.GRPC.SetLatency("SelectAd", 5.0);
  const int64_t before = ctx.Clock.Now();
  clientQuiet();
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 0.2, "with the exchange taking 5 s the serve waited %.2f s, expected one 150 ms deadline", waited);
  ctx.Equal(ctx.GRPC.CallsTo("SelectAd").size(), 2, "a slow exchange gets one call per serve; the calls");
}

void CheckHouseFallback(harness::Ctx& ctx) {
  clientPeer(ctx);
  ctx.GRPC.SetLatency("SelectAd", 5.0);
  Selection got = clientSelect(ctx, "with the exchange past its deadline");
  ctx.Assert(clientSame(got, "house", "house-default", 0, "house", true, "deadline_exceeded"),
             "with the exchange past its deadline selectAd returned %s, expected the marked house ad: an empty slot is revenue lost with nothing to count", clientShow(got));
  ctx.GRPC.SetLatency("SelectAd", 0);
  ctx.GRPC.Fail("SelectAd", grpc::StatusCode::UNAVAILABLE);
  got = clientSelect(ctx, "with the exchange UNAVAILABLE");
  ctx.Assert(clientSame(got, "house", "house-default", 0, "house", true, "unavailable"),
             "with the exchange UNAVAILABLE selectAd returned %s, expected the house ad with fallback_reason unavailable", clientShow(got));
  got = clientSelect(ctx, "once the exchange answers again");
  ctx.Assert(clientSame(got, "c-9", "cr-c-9", 1200, "paid", false, ""), "once the exchange answers again selectAd returned %s, expected the paid bid", clientShow(got));
}

void CheckPropagateErrors(harness::Ctx& ctx) {
  clientPeer(ctx);
  ctx.GRPC.Fail("SelectAd", grpc::StatusCode::INVALID_ARGUMENT, "placement home-top is not registered");
  bool raised = false;
  Selection got;
  try {
    got = selectAd("home-top", "u-1");
  } catch (const ExchangeError&) {
    raised = true;
  } catch (const std::exception& e) {
    ctx.Fatalf("INVALID_ARGUMENT threw %s: %s, expected ExchangeError", harness::CurrentExceptionType(), e.what());
  }
  ctx.Assert(raised, "INVALID_ARGUMENT from the exchange answered %s: a request the exchange refuses is a bug to surface, not a slot to fill. Throw ExchangeError", clientShow(got));
  ctx.Equal(ctx.GRPC.CallsTo("SelectAd").size(), 1, "an INVALID_ARGUMENT fails the same way every time; the calls");
}
`,
  },
  hints: [
    'Make the exchange slow and the page waits three seconds, then renders an empty slot; take it down and every page asks it three times.',
    'The loop catches every `RpcError`, sleeps and tries again under a one-second deadline, whatever the status; when it gives up it returns `ad: None` with nothing saying why.',
    'One `SelectAd` with `timeout=EXCHANGE_DEADLINE_S` (0.15). In the `except`: for DEADLINE_EXCEEDED or UNAVAILABLE return `HOUSE_AD` with `kind: "house"`, `fallback: True` and the code’s name lowercased; otherwise raise `ExchangeError`.',
  ],
  debrief: `A serve is inside a page load, so the exchange gets a fixed slice of it and the fallback has to be as good as an answer: a house ad fills the slot, and the kind and reason travel with it so billing and the delivery report never credit it to a campaign. Retrying inside the request spends the deadline again on a dependency that has already said it is slow or down. The status code decides the branch: a deadline or an outage says nothing about the request, while INVALID_ARGUMENT says the request itself is wrong, so filling the slot would hide a bug. Production clients also propagate the caller's remaining budget as the deadline, and trip a breaker so a dead exchange is skipped instead of waited on.`,
};
