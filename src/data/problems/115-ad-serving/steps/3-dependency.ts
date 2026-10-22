import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Exchange calls with a house-ad fallback',
  concept: 'grpc',
  file: 'client',
  focus: ['server', 'exchange', 'house', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the exchange client: it opens
a channel, calls \`SelectAd\` with a deadline and maps the bid into the serve response. It hides two
production flaws that only show up when the exchange is slow. Review it like the service owner, fix
it, and prove the fix with the checks below.

Implement \`select(placement, user_hash)\` — the only hop a serve makes outside this service.

- The exchange is called **once per serve**, over gRPC, with a hard **150 ms** deadline
  (\`EXCHANGE_DEADLINE_MS\`). The deadline is the whole latency budget for the hop; there is **no**
  second call, no loop and no sleep inside the request.
- On \`DEADLINE_EXCEEDED\` (or \`UNAVAILABLE\`) the request serves the **house ad** — a real creative
  that keeps the slot filled — marked \`fallback: true\` with the reason the fallback happened. An
  empty slot is not an acceptable answer: it is revenue lost with nothing in the logs to reconcile.
- The house ad carries \`price_micros = 0\` and the impression it produces is of a different kind
  from a paid one, so billing and the delivery reports can separate them.
- Other status codes are not the exchange being down: propagate them instead of quietly filling the
  slot with house inventory.

**Failure mode the checks target.** The draft returns \`{"ad": None}\` on a timeout — an empty slot
that nobody is billed for and nobody sees in a report — and it hides a second flaw: it loops over
\`SelectAd\` inside the same request, so a slow exchange adds the deadline to the page load twice
over. Both are deadline bugs, and both look fine in a demo where the exchange always answers on the
first try.`,
  sequence: {
    participants: ['Ad Server', 'exchange', 'house ad'],
    messages: [
      {from: 'Ad Server', to: 'exchange', label: 'SelectAd(placement, user_hash) · deadline 150 ms', kind: 'sync'},
      {from: 'exchange', to: 'Ad Server', label: 'bid · campaign_version · price_micros', kind: 'reply'},
      {from: 'Ad Server', to: 'Ad Server', label: 'DEADLINE_EXCEEDED / UNAVAILABLE → fallback', kind: 'sync'},
      {from: 'Ad Server', to: 'house ad', label: 'pick the house creative', kind: 'sync'},
      {from: 'house ad', to: 'Ad Server', label: 'creative · price_micros = 0', kind: 'reply'},
      {from: 'Ad Server', to: 'Ad Server', label: 'impression_kind = fallback · fallback_reason', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Calls the exchange under a 150 ms deadline',
      detail:
        'The hop carries a hard 150 ms deadline (`EXCHANGE_DEADLINE_MS`): the caller gets an answer or a deadline error inside the page-load budget. The draft already sets it — it is the retry and the empty slot around it that are wrong.',
      match: {
        python: {all: [/EXCHANGE_DEADLINE_MS\s*=\s*150/, /timeout\s*=/]},
        typescript: {all: [/EXCHANGE_DEADLINE_MS\s*=\s*150/, /\bdeadline\b/]},
        go: {all: [/exchangeDeadlineMs\s*=\s*150/, /context\.WithTimeout/]},
        scala: {all: [/ExchangeDeadlineMs\s*=\s*150/, /withDeadlineAfter/]},
        cpp: {all: [/kExchangeDeadlineMs\s*=\s*150/, /set_deadline/]},
      },
    },
    {
      id: 'no-inline-retry',
      title: 'Makes exactly one exchange call per serve',
      detail:
        'No loop over `SelectAd`, no backoff, no sleep inside the request: a slow exchange costs one deadline, not several. The draft loops until it has tried `MAX_ATTEMPTS` times, so page load pays the deadline again for every extra call.',
      match: {
        python: {all: [/SelectAd/], none: [/\bfor\s+attempt\b/, /MAX_ATTEMPTS/, /\bretry\b/]},
        typescript: {all: [/SelectAd/], none: [/\bfor\s*\([^)]*attempt/, /MAX_ATTEMPTS/, /\bretry\b/]},
        go: {all: [/SelectAd/], none: [/\bfor\s+attempt/, /maxAttempts/, /\bretry\b/]},
        scala: {all: [/selectAd/], none: [/\bfor\s*\([^)]*attempt/, /\bMaxAttempts\b/, /\bretry\b/]},
        cpp: {all: [/SelectAd/], none: [/\bfor\s*\([^)]*attempt/, /kMaxAttempts/, /\bretry\b/]},
      },
    },
    {
      id: 'house-fallback',
      title: 'Serves the house ad, marked, when the exchange times out',
      detail:
        'A `DEADLINE_EXCEEDED` (or `UNAVAILABLE`) response is a house ad with `fallback: true`, not an empty slot. The draft answers `{"ad": null}` and the impression simply disappears.',
      match: {
        python: {all: [/HOUSE_AD_CREATIVE/, /fallback/, /DEADLINE_EXCEEDED/]},
        typescript: {all: [/HOUSE_AD_CREATIVE/, /fallback/, /DEADLINE_EXCEEDED/]},
        go: {all: [/houseAdCreative/, /Fallback/, /DeadlineExceeded/]},
        scala: {all: [/HouseAdCreative/, /fallback/, /DEADLINE_EXCEEDED/]},
        cpp: {all: [/kHouseAdCreative/, /fallback/, /DEADLINE_EXCEEDED/]},
      },
    },
    {
      id: 'counted-separately',
      title: 'Marks fallback impressions apart from paid ones',
      detail:
        'The response says which kind of impression it is: a paid bid and a house fallback are different kinds, so delivery and billing can count them separately instead of crediting the fallback to a campaign that never paid.',
      match: {
        python: {all: [/IMPRESSION_KIND_PAID/, /IMPRESSION_KIND_FALLBACK/]},
        typescript: {all: [/IMPRESSION_KIND_PAID/, /IMPRESSION_KIND_FALLBACK/]},
        go: {all: [/ImpressionKindPaid/, /ImpressionKindFallback/]},
        scala: {all: [/ImpressionKindPaid/, /ImpressionKindFallback/]},
        cpp: {all: [/kImpressionPaid/, /kImpressionFallback/]},
      },
    },
    {
      id: 'fallback-marker',
      title: 'Names why the fallback was served',
      detail:
        'The house ad carries `fallback_reason` — `"timeout"` here — so on-call can tell a deadline from a hard error without guessing, and the delivery report can show fallback share per placement.',
      match: {
        python: {all: [/fallback_reason/, /['"]timeout['"]/]},
        typescript: {all: [/fallback_reason/, /['"]timeout['"]/]},
        go: {all: [/FallbackReason/, /['"]timeout['"]/]},
        scala: {all: [/fallback_reason/, /['"]timeout['"]/]},
        cpp: {all: [/fallback_reason/, /['"]timeout['"]/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

import grpc  # grpcio

logger = logging.getLogger("adserver.exchange")

EXCHANGE_DEADLINE_MS = 150
MAX_ATTEMPTS = 3


class ExchangeClient:
    def __init__(self, stub) -> None:
        self._stub = stub

    def select(self, placement: str, user_hash: str) -> dict:
        # TODO: this draft returns an empty slot when the exchange times out, so the ad is lost
        # silently, and it calls SelectAd up to MAX_ATTEMPTS times inside the request, adding the
        # deadline to the page load again and again. Review both flaws.
        last_error = None
        for attempt in range(MAX_ATTEMPTS):
            try:
                bid = self._stub.SelectAd(
                    SelectAdRequest(placement=placement, user_hash=user_hash),
                    timeout=EXCHANGE_DEADLINE_MS / 1000,
                )
                return {
                    "ad": {
                        "campaign_id": bid.campaign_id,
                        "creative_id": bid.creative_id,
                        "price_micros": bid.price_micros,
                    },
                    "campaign_version": bid.campaign_version,
                    "fallback": False,
                }
            except grpc.RpcError as err:
                last_error = err
                time.sleep(EXCHANGE_DEADLINE_MS / 1000)
        logger.warning("exchange gave up: %s", last_error)
        return {"ad": None, "reason": "exchange_unavailable", "fallback": False}
`,
      solution: `import logging

import grpc  # grpcio

logger = logging.getLogger("adserver.exchange")

EXCHANGE_DEADLINE_MS = 150
HOUSE_AD_CAMPAIGN = "house"
HOUSE_AD_CREATIVE = "house_default_banner"
IMPRESSION_KIND_PAID = "paid"
IMPRESSION_KIND_FALLBACK = "fallback"


class ExchangeClient:
    """One call per serve, one deadline, and a house creative when the exchange does not answer."""

    def __init__(self, stub) -> None:
        self._stub = stub

    def select(self, placement: str, user_hash: str) -> dict:
        """The deadline is the whole latency budget for this hop: exactly one SelectAd."""
        try:
            bid = self._stub.SelectAd(
                SelectAdRequest(placement=placement, user_hash=user_hash),
                timeout=EXCHANGE_DEADLINE_MS / 1000,
            )
        except grpc.RpcError as err:
            code = err.code()
            if code not in (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE):
                raise
            logger.warning("exchange down code=%s placement=%s", code, placement)
            return house_ad("timeout")
        return {
            "ad": {
                "campaign_id": bid.campaign_id,
                "creative_id": bid.creative_id,
                "price_micros": bid.price_micros,
            },
            "campaign_version": bid.campaign_version,
            "fallback": False,
            "impression_kind": IMPRESSION_KIND_PAID,
        }


def house_ad(fallback_reason: str) -> dict:
    """Fills the slot at price 0, and is counted under its own impression kind."""
    return {
        "ad": {"campaign_id": HOUSE_AD_CAMPAIGN, "creative_id": HOUSE_AD_CREATIVE, "price_micros": 0},
        "campaign_version": HOUSE_AD_CAMPAIGN + ":v1",
        "fallback": True,
        "fallback_reason": fallback_reason,
        "impression_kind": IMPRESSION_KIND_FALLBACK,
    }
`,
    },
    typescript: {
      starter: `/** Exchange client: a model-generated draft that hides two deadline bugs. */
import * as grpc from '@grpc/grpc-js';

const EXCHANGE_DEADLINE_MS = 150;
const MAX_ATTEMPTS = 3;

export interface Bid {
  campaign_id: string;
  campaign_version: string;
  creative_id: string;
  price_micros: number;
}

export interface Selection {
  ad: {campaign_id: string; creative_id: string; price_micros: number} | null;
  campaign_version?: string;
  fallback: boolean;
  reason?: string;
}

export class ExchangeClient {
  constructor(private readonly client: grpc.Client) {}

  select(placement: string, userHash: string): Promise<Selection> {
    // TODO: this draft returns an empty slot when the exchange times out, so the ad is lost
    // silently, and it calls selectAd up to MAX_ATTEMPTS times inside the request, adding the
    // deadline to the page load again and again. Review both flaws.
    const call = (attempt: number): Promise<Selection> =>
      new Promise((resolve, reject) => {
        this.client.makeUnaryRequest(
          '/ads.Exchange/SelectAd',
          (value: unknown) => Buffer.from(JSON.stringify(value)),
          (bytes: Buffer) => JSON.parse(bytes.toString()) as Bid,
          {placement, user_hash: userHash},
          {deadline: Date.now() + EXCHANGE_DEADLINE_MS},
          (error, bid) => {
            if (error !== null && error !== undefined) {
              if (attempt + 1 < MAX_ATTEMPTS) resolve(call(attempt + 1));
              else reject(error);
              return;
            }
            resolve({
              ad: {
                campaign_id: (bid as Bid).campaign_id,
                creative_id: (bid as Bid).creative_id,
                price_micros: (bid as Bid).price_micros,
              },
              campaign_version: (bid as Bid).campaign_version,
              fallback: false,
            });
          },
        );
      });

    return call(0).catch(() => ({ad: null, reason: 'exchange_unavailable', fallback: false}));
  }
}
`,
      solution: `/** Exchange client: one call under a 150 ms deadline, house ad on timeout. */
import * as grpc from '@grpc/grpc-js';

const EXCHANGE_DEADLINE_MS = 150;
const HOUSE_AD_CAMPAIGN = 'house';
const HOUSE_AD_CREATIVE = 'house_default_banner';
const IMPRESSION_KIND_PAID = 'paid';
const IMPRESSION_KIND_FALLBACK = 'fallback';

export interface Bid {
  campaign_id: string;
  campaign_version: string;
  creative_id: string;
  price_micros: number;
}

export interface Selection {
  ad: {campaign_id: string; creative_id: string; price_micros: number};
  campaign_version: string;
  fallback: boolean;
  fallback_reason?: string;
  impression_kind: string;
}

export function houseAd(fallbackReason: string): Selection {
  return {
    ad: {campaign_id: HOUSE_AD_CAMPAIGN, creative_id: HOUSE_AD_CREATIVE, price_micros: 0},
    campaign_version: \`\${HOUSE_AD_CAMPAIGN}:v1\`,
    fallback: true,
    fallback_reason: fallbackReason,
    impression_kind: IMPRESSION_KIND_FALLBACK,
  };
}

export class ExchangeClient {
  constructor(private readonly client: grpc.Client) {}

  select(placement: string, userHash: string): Promise<Selection> {
    return new Promise((resolve, reject) => {
      this.client.makeUnaryRequest(
        '/ads.Exchange/SelectAd',
        (value: unknown) => Buffer.from(JSON.stringify(value)),
        (bytes: Buffer) => JSON.parse(bytes.toString()) as Bid,
        {placement, user_hash: userHash},
        {deadline: Date.now() + EXCHANGE_DEADLINE_MS},
        (error, bid) => {
          if (error !== null && error !== undefined) {
            const down =
              error.code === grpc.status.DEADLINE_EXCEEDED || error.code === grpc.status.UNAVAILABLE;
            if (!down) {
              reject(error);
              return;
            }
            resolve(houseAd('timeout'));
            return;
          }
          resolve({
            ad: {
              campaign_id: (bid as Bid).campaign_id,
              creative_id: (bid as Bid).creative_id,
              price_micros: (bid as Bid).price_micros,
            },
            campaign_version: (bid as Bid).campaign_version,
            fallback: false,
            impression_kind: IMPRESSION_KIND_PAID,
          });
        },
      );
    });
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc"
)

const (
	exchangeDeadlineMs = 150
	maxAttempts        = 3
)

type Bid struct {
	CampaignID      string
	CampaignVersion string
	CreativeID      string
	PriceMicros     int64
}

type Selection struct {
	Ad              *Ad
	CampaignVersion string
	Fallback        bool
	Reason          string
}

type Ad struct {
	CampaignID  string
	CreativeID  string
	PriceMicros int64
}

type ExchangeClient struct {
	client ExchangeServiceClient
}

func (c *ExchangeClient) Select(ctx context.Context, placement, userHash string) (Selection, error) {
	// TODO: this draft returns an empty slot when the exchange times out, so the ad is lost
	// silently, and it calls SelectAd up to maxAttempts times inside the request, adding the
	// deadline to the page load again and again. Review both flaws.
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, exchangeDeadlineMs*time.Millisecond)
		bid, err := c.client.SelectAd(callCtx, &SelectAdRequest{Placement: placement, UserHash: userHash})
		cancel()
		if err == nil {
			return Selection{
				Ad:              &Ad{CampaignID: bid.CampaignID, CreativeID: bid.CreativeID, PriceMicros: bid.PriceMicros},
				CampaignVersion: bid.CampaignVersion,
			}, nil
		}
		lastErr = err
		time.Sleep(exchangeDeadlineMs * time.Millisecond)
	}
	log.Printf("exchange gave up: %v", lastErr)
	return Selection{Reason: "exchange_unavailable"}, nil
}
`,
      solution: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	exchangeDeadlineMs     = 150
	houseAdCampaign        = "house"
	houseAdCreative        = "house_default_banner"
	ImpressionKindPaid     = "paid"
	ImpressionKindFallback = "fallback"
)

type Bid struct {
	CampaignID      string
	CampaignVersion string
	CreativeID      string
	PriceMicros     int64
}

type Ad struct {
	CampaignID  string
	CreativeID  string
	PriceMicros int64
}

type Selection struct {
	Ad             *Ad
	CampaignVersion string
	Fallback       bool
	FallbackReason string
	ImpressionKind string
}

type ExchangeClient struct {
	client ExchangeServiceClient
}

func houseAd(fallbackReason string) Selection {
	return Selection{
		Ad:             &Ad{CampaignID: houseAdCampaign, CreativeID: houseAdCreative, PriceMicros: 0},
		CampaignVersion: houseAdCampaign + ":v1",
		Fallback:       true,
		FallbackReason: fallbackReason,
		ImpressionKind: ImpressionKindFallback,
	}
}

func (c *ExchangeClient) Select(ctx context.Context, placement, userHash string) (Selection, error) {
	// The deadline is the whole latency budget for this hop: exactly one SelectAd.
	callCtx, cancel := context.WithTimeout(ctx, exchangeDeadlineMs*time.Millisecond)
	defer cancel()
	bid, err := c.client.SelectAd(callCtx, &SelectAdRequest{Placement: placement, UserHash: userHash})
	if err != nil {
		code := status.Code(err)
		if code != codes.DeadlineExceeded && code != codes.Unavailable {
			return Selection{}, err
		}
		log.Printf("exchange down code=%s placement=%s", code, placement)
		return houseAd("timeout"), nil
	}
	return Selection{
		Ad:             &Ad{CampaignID: bid.CampaignID, CreativeID: bid.CreativeID, PriceMicros: bid.PriceMicros},
		CampaignVersion: bid.CampaignVersion,
		Fallback:       false,
		ImpressionKind: ImpressionKindPaid,
	}, nil
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import scala.concurrent.{ExecutionContext, Future}

object ExchangeClient {
  val ExchangeDeadlineMs = 150
  val MaxAttempts = 3
}

final case class Bid(campaign_id: String, campaign_version: String, creative_id: String, price_micros: Long)

final case class Selection(ad: Option[Bid], campaign_version: String, fallback: Boolean, reason: String)

class ExchangeClient(stub: ExchangeServiceGrpc.ExchangeServiceStub)(implicit ec: ExecutionContext) {
  import ExchangeClient._

  def select(placement: String, userHash: String): Future[Selection] = {
    // TODO: this draft returns an empty slot when the exchange times out, so the ad is lost
    // silently, and it calls selectAd up to MaxAttempts times inside the request, adding the
    // deadline to the page load again and again. Review both flaws.
    def call(attempt: Int): Future[Selection] =
      stub
        .withDeadlineAfter(ExchangeDeadlineMs, TimeUnit.MILLISECONDS)
        .selectAd(SelectAdRequest(placement, userHash))
        .map(bid => Selection(Some(bid), bid.campaign_version, fallback = false, reason = ""))
        .recoverWith { case _ if attempt + 1 < MaxAttempts => call(attempt + 1) }

    call(0).recover { case _ => Selection(None, "", fallback = false, reason = "exchange_unavailable") }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import scala.concurrent.{ExecutionContext, Future}

object ExchangeClient {
  val ExchangeDeadlineMs = 150
  val HouseAdCampaign = "house"
  val HouseAdCreative = "house_default_banner"
  val ImpressionKindPaid = "paid"
  val ImpressionKindFallback = "fallback"
}

final case class Bid(campaign_id: String, campaign_version: String, creative_id: String, price_micros: Long)

final case class Ad(campaign_id: String, creative_id: String, price_micros: Long)

final case class Selection(
    ad: Ad,
    campaign_version: String,
    fallback: Boolean,
    fallback_reason: String,
    impression_kind: String)

class ExchangeClient(stub: ExchangeServiceGrpc.ExchangeServiceStub)(implicit ec: ExecutionContext) {
  import ExchangeClient._

  def houseAd(fallbackReason: String): Selection =
    Selection(
      Ad(HouseAdCampaign, HouseAdCreative, 0L),
      s"$HouseAdCampaign:v1",
      fallback = true,
      fallback_reason = fallbackReason,
      impression_kind = ImpressionKindFallback)

  def select(placement: String, userHash: String): Future[Selection] = {
    // The deadline is the whole latency budget for this hop: exactly one selectAd.
    stub
      .withDeadlineAfter(ExchangeDeadlineMs, TimeUnit.MILLISECONDS)
      .selectAd(SelectAdRequest(placement, userHash))
      .map { bid =>
        Selection(
          Ad(bid.campaign_id, bid.creative_id, bid.price_micros),
          bid.campaign_version,
          fallback = false,
          fallback_reason = "",
          impression_kind = ImpressionKindPaid)
      }
      .recoverWith {
        case status if status.getStatus.getCode == io.grpc.Status.Code.DEADLINE_EXCEEDED =>
          Future.successful(houseAd("timeout"))
        case status if status.getStatus.getCode == io.grpc.Status.Code.UNAVAILABLE =>
          Future.successful(houseAd("timeout"))
      }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>
#include <thread>

constexpr int kExchangeDeadlineMs = 150;
constexpr int kMaxAttempts = 3;

struct Bid {
  std::string campaign_id;
  std::string campaign_version;
  std::string creative_id;
  long price_micros;
};

struct Ad {
  std::string campaign_id;
  std::string creative_id;
  long price_micros;
};

struct Selection {
  Ad ad;
  std::string campaign_version;
  bool fallback;
};

class ExchangeClient {
 public:
  explicit ExchangeClient(std::shared_ptr<ads::Exchange::Stub> stub) : stub_(std::move(stub)) {}

  Selection Select(const std::string& placement, const std::string& userHash) {
    // TODO: this draft returns an empty slot when the exchange times out, so the ad is lost
    // silently, and it calls SelectAd up to kMaxAttempts times inside the request, adding the
    // deadline to the page load again and again. Review both flaws.
    grpc::Status last_status;
    for (int attempt = 0; attempt < kMaxAttempts; ++attempt) {
      grpc::ClientContext context;
      context.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kExchangeDeadlineMs));
      ads::SelectAdRequest request;
      request.set_placement(placement);
      request.set_user_hash(userHash);
      ads::Bid bid;
      const auto status = stub_->SelectAd(&context, request, &bid);
      if (status.ok()) {
        return Selection{Ad{bid.campaign_id(), bid.creative_id(), bid.price_micros()}, bid.campaign_version(), false};
      }
      last_status = status;
      std::this_thread::sleep_for(std::chrono::milliseconds(kExchangeDeadlineMs));
    }
    return Selection{Ad{}, "", false};
  }

 private:
  std::shared_ptr<ads::Exchange::Stub> stub_;
};
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

constexpr int kExchangeDeadlineMs = 150;
const std::string kHouseAdCampaign = "house";
const std::string kHouseAdCreative = "house_default_banner";
const std::string kImpressionPaid = "paid";
const std::string kImpressionFallback = "fallback";

struct Bid {
  std::string campaign_id;
  std::string campaign_version;
  std::string creative_id;
  long price_micros;
};

struct Ad {
  std::string campaign_id;
  std::string creative_id;
  long price_micros;
};

struct Selection {
  Ad ad;
  std::string campaign_version;
  bool fallback;
  std::string fallback_reason;
  std::string impression_kind;
};

/** Fills the slot at price 0, counted under its own impression kind. */
Selection HouseAd(const std::string& fallbackReason) {
  return Selection{Ad{kHouseAdCampaign, kHouseAdCreative, 0},
                   kHouseAdCampaign + ":v1",
                   true,
                   fallbackReason,
                   kImpressionFallback};
}

class ExchangeClient {
 public:
  explicit ExchangeClient(std::shared_ptr<ads::Exchange::Stub> stub) : stub_(std::move(stub)) {}

  Selection Select(const std::string& placement, const std::string& userHash) {
    // The deadline is the whole latency budget for this hop: exactly one SelectAd.
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kExchangeDeadlineMs));
    ads::SelectAdRequest request;
    request.set_placement(placement);
    request.set_user_hash(userHash);
    ads::Bid bid;
    const auto status = stub_->SelectAd(&context, request, &bid);
    if (!status.ok()) {
      if (status.error_code() != grpc::StatusCode::DEADLINE_EXCEEDED &&
          status.error_code() != grpc::StatusCode::UNAVAILABLE) {
        throw std::runtime_error(status.error_message());
      }
      return HouseAd("timeout");
    }
    return Selection{Ad{bid.campaign_id(), bid.creative_id(), bid.price_micros()},
                     bid.campaign_version(),
                     false,
                     "",
                     kImpressionPaid};
  }

 private:
  std::shared_ptr<ads::Exchange::Stub> stub_;
};
`,
    },
  },
  hints: [
    'Write the failure policy before the call: which status codes mean "the exchange is not answering" (DEADLINE_EXCEEDED, UNAVAILABLE) and which ones must propagate (INVALID_ARGUMENT, PERMISSION_DENIED). Only the first group earns a fallback.',
    'The fallback is a house creative, not an absence: return a real ad with `price_micros = 0`, `fallback: true` and the reason. An empty slot is invisible in every report, which is why it survives review.',
    'One call per serve. If you find yourself inside a loop, remember that the caller already has a latency budget: a second SelectAd spends it again and the user waits twice for an auction that has already lost.',
  ],
  debrief: `The interviewer is testing your failure policy for a hard dependency. The draft is the shape most candidates write first: a call with a deadline, then a loop "just in case", then a null when everything fails. Both choices are wrong in the same direction — they trade a deterministic user experience for a chance at a slightly better bid. The fix is to make the timeout part of the product: a house creative fills the slot, the response says it is a fallback and why, and the impression kind keeps house inventory out of campaign billing. Real exchanges add a circuit breaker so a dead upstream is not probed on every request, deadline propagation from the inbound request (the remaining budget, not a fresh 150 ms), hedged requests at the second percentile instead of blind retries, and a bid floor below which the house ad wins anyway.`,
};
