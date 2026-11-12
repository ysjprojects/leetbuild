import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Demand model calls with a last-approved fallback',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'demand', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter reprices a sku from the demand model:
\`price_from_demand(sku, reason)\` reads the row (\`store.get_sku\`), calls \`DemandModel/Estimate\` up to
three times, publishes the estimate with source \`demand-model\` and keeps it in \`last_suggestion\`;
when every attempt fails it publishes that cached suggestion again. It serves the demo and hides
four flaws.

**Failure mode the checks target.** A model that hangs holds the pricing worker with it; a sku the
model refuses is asked three times and never reported; an outage republishes an old suggestion
with a fresh timestamp over a price an operator approved since; and an estimate jumps the price past
the window budget.

\`\`\`proto
service DemandModel { rpc Estimate(EstimateRequest) returns (PriceEstimate); }  // FAILED_PRECONDITION: refused
\`\`\`

- Every call carries a **\`DEADLINE_S\` = 0.7 s** deadline.
- \`FAILED_PRECONDITION\` raises \`PriceRejected\` after that one call; the price is untouched.
- \`DEADLINE_EXCEEDED\` or \`UNAVAILABLE\` keeps the last approved price: \`store.mark_stale(sku)\` (source
  \`last-approved\`, \`stale\`, its own \`updated_at\`), returned as the row.
- An estimate moves the price only through \`guard.reserve\` (step 2, provided as \`pricing.guard\`); a
  refusal leaves the price as it is.`,
  sequence: {
    participants: ['Pricing worker', 'Demand model', 'Redis guard', 'Price store'],
    messages: [
      {from: 'Pricing worker', to: 'Demand model', label: 'Estimate(sku, current) · deadline 0.7 s', kind: 'sync'},
      {
        from: 'Demand model',
        to: 'Pricing worker',
        label: 'PriceEstimate · FAILED_PRECONDITION → PriceRejected',
        kind: 'reply',
      },
      {from: 'Pricing worker', to: 'Redis guard', label: 'reserve(sku, current, estimate)', kind: 'sync'},
      {from: 'Pricing worker', to: 'Price store', label: 'publish(…, "demand-model") only when reserved', kind: 'sync'},
      {
        from: 'Pricing worker',
        to: 'Price store',
        label: 'DEADLINE_EXCEEDED / UNAVAILABLE → mark_stale(sku)',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every Estimate call carries a 0.7-second deadline',
      detail:
        'The demand call is made with `DEADLINE_S` (0.7 s) as its deadline (`timeout=`, `deadline:`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`). The starter sends it with none, so a model that hangs holds the pricing worker with it.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*0\.7\b/, /Estimate\([\s\S]{0,200}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*700\b/, /Estimate\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*700\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        scala: {all: [/DeadlineMillis\s*=\s*700L?\b/, /withDeadlineAfter\(\s*DeadlineMillis/]},
        cpp: {all: [/kDeadline\{700\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'terminal-rejection',
      title: 'A refusal is raised after one call',
      detail:
        '`FAILED_PRECONDITION` raises `PriceRejected` at once: the model refused on its own constraints and asks again get the same answer. The starter retries every error three times and then returns the row as if nothing happened.',
      match: {
        python: {all: [/FAILED_PRECONDITION/, /raise PriceRejected/], none: [/for \w+ in range\(/]},
        typescript: {all: [/FAILED_PRECONDITION/, /throw new PriceRejected/], none: [/for \(let attempt/]},
        go: {all: [/codes\.FailedPrecondition/, /ErrPriceRejected/], none: [/for attempt :=/]},
        scala: {all: [/FAILED_PRECONDITION/, /throw new PriceRejected/], none: [/\(1 to \d\)|while \(attempt/]},
        cpp: {all: [/FAILED_PRECONDITION/, /throw PriceRejected/], none: [/for \(int attempt/]},
      },
    },
    {
      id: 'last-approved-fallback',
      title: 'An outage keeps the last approved price, marked stale',
      detail:
        "`DEADLINE_EXCEEDED` or `UNAVAILABLE` calls `store.mark_stale(sku)`: the published price stays, with source `last-approved`, `stale` set and its own `updated_at`. The starter republishes the model's cached `last_suggestion` with a fresh timestamp, over whatever an operator approved since.",
      match: {
        python: {all: [/store\.mark_stale\(/], none: [/last_suggestion/]},
        typescript: {all: [/markStale\(/], none: [/lastSuggestion/]},
        go: {all: [/store\.MarkStale\(/], none: [/lastSuggestion/]},
        scala: {all: [/Store\.markStale\(/], none: [/lastSuggestion/]},
        cpp: {all: [/store::markStale\(/], none: [/lastSuggestion|last_suggestion/]},
      },
    },
    {
      id: 'guarded-estimate',
      title: 'An estimate moves the price only through the window guard',
      detail:
        'The estimate is reserved with `guard.reserve(sku, current, estimate)` before `store.publish`, and a refusal leaves the price alone. The starter publishes whatever the model returns, so one bad estimate can move a price 50 % in a second.',
      match: {
        python: {order: [/guard\.reserve\(/, /store\.publish\(/]},
        typescript: {order: [/reserve\(/, /\bpublish\(/]},
        go: {order: [/guard\.Reserve\(/, /store\.Publish\(/]},
        scala: {order: [/Guard\.reserve\(/, /Store\.publish\(/]},
        cpp: {order: [/guard::reserve\(/, /store::publish\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import dynamic_pricing_pb2
import dynamic_pricing_pb2_grpc
from pricing import guard, store  # guard.reserve; store.get_sku, publish, mark_stale

demand = dynamic_pricing_pb2_grpc.DemandModelStub(grpc.insecure_channel("demand:9000"))


class PriceRejected(Exception):
    """The demand model refused to price the sku."""


# The model's latest estimate per sku.
last_suggestion: dict[str, int] = {}


def price_from_demand(sku: str, reason: str) -> dict:
    """Reprice the sku from the demand model; returns the sku's row afterwards."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    current = store.get_sku(sku)
    request = dynamic_pricing_pb2.EstimateRequest(sku=sku, current_price_cents=current["price_cents"])
    for attempt in range(3):
        try:
            estimate = demand.Estimate(request)
        except grpc.RpcError:
            continue
        last_suggestion[sku] = estimate.price_cents
        return store.publish(sku, estimate.price_cents, reason, "demand-model")
    if sku in last_suggestion:
        return store.publish(sku, last_suggestion[sku], reason, "demand-model")
    return current
`,
      solution: `import grpc

import dynamic_pricing_pb2
import dynamic_pricing_pb2_grpc
from pricing import guard, store  # guard.reserve; store.get_sku, publish, mark_stale

DEADLINE_S = 0.7

demand = dynamic_pricing_pb2_grpc.DemandModelStub(grpc.insecure_channel("demand:9000"))


class PriceRejected(Exception):
    """The demand model refused to price the sku."""


def price_from_demand(sku: str, reason: str) -> dict:
    """Reprice the sku from the demand model; returns the sku's row afterwards."""
    current = store.get_sku(sku)
    request = dynamic_pricing_pb2.EstimateRequest(sku=sku, current_price_cents=current["price_cents"])
    try:
        estimate = demand.Estimate(request, timeout=DEADLINE_S)
    except grpc.RpcError as exc:
        if exc.code() == grpc.StatusCode.FAILED_PRECONDITION:
            # The model refused on its own constraints: asking again gets the same answer.
            raise PriceRejected(exc.details()) from exc
        # DEADLINE_EXCEEDED, UNAVAILABLE: the approved price stays, labelled for what it is.
        return store.mark_stale(sku)
    reservation = guard.reserve(sku, current["price_cents"], estimate.price_cents)
    if not reservation["ok"]:
        return current  # the window has no room for this move: the approved price stays
    return store.publish(sku, estimate.price_cents, reason, "demand-model")
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {reserve} from 'pricing/guard';
import {type Row, getSku, markStale, publish} from 'pricing/store';

interface EstimateRequest {
  sku: string;
  current_price_cents: number;
}

interface PriceEstimate {
  price_cents: number | string;
  model_version: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('dynamic_pricing.proto')) as unknown as {
  priced: {DemandModel: grpc.ServiceClientConstructor};
};
const demand = new pkg.priced.DemandModel('demand:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Estimate(request: EstimateRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<PriceEstimate>;
};

/** The demand model refused to price the sku. */
export class PriceRejected extends Error {}

/** The model's latest estimate per sku. */
const lastSuggestion = new Map<string, number>();

/** Reprice the sku from the demand model; resolves to the sku's row afterwards. */
export async function priceFromDemand(sku: string, reason: string): Promise<Row | null> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const current = (await getSku(sku)) as Row;
  const request = {sku, current_price_cents: current.price_cents};
  for (let attempt = 0; attempt < 3; attempt++) {
    let estimate: PriceEstimate;
    try {
      estimate = await demand.Estimate(request, new grpc.Metadata(), {});
    } catch {
      continue;
    }
    lastSuggestion.set(sku, Number(estimate.price_cents));
    return publish(sku, Number(estimate.price_cents), reason, 'demand-model');
  }
  const cached = lastSuggestion.get(sku);
  if (cached !== undefined) return publish(sku, cached, reason, 'demand-model');
  return current;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {reserve} from 'pricing/guard';
import {type Row, getSku, markStale, publish} from 'pricing/store';

export const DEADLINE_MS = 700;

interface EstimateRequest {
  sku: string;
  current_price_cents: number;
}

interface PriceEstimate {
  price_cents: number | string;
  model_version: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('dynamic_pricing.proto')) as unknown as {
  priced: {DemandModel: grpc.ServiceClientConstructor};
};
const demand = new pkg.priced.DemandModel('demand:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Estimate(request: EstimateRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<PriceEstimate>;
};

/** The demand model refused to price the sku. */
export class PriceRejected extends Error {}

/** Reprice the sku from the demand model; resolves to the sku's row afterwards. */
export async function priceFromDemand(sku: string, reason: string): Promise<Row | null> {
  const current = (await getSku(sku)) as Row;
  const request = {sku, current_price_cents: current.price_cents};
  let estimate: PriceEstimate;
  try {
    estimate = await demand.Estimate(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
  } catch (e) {
    const {code, details} = e as grpc.ServiceError;
    // The model refused on its own constraints: asking again gets the same answer.
    if (code === grpc.status.FAILED_PRECONDITION) throw new PriceRejected(details);
    // DEADLINE_EXCEEDED, UNAVAILABLE: the approved price stays, labelled for what it is.
    return markStale(sku);
  }
  const target = Number(estimate.price_cents);
  const reservation = await reserve(sku, current.price_cents, target);
  if (!reservation.ok) return current; // the window has no room for this move: the approved price stays
  return publish(sku, target, reason, 'demand-model');
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "pricing/gen/dynamic_pricing"
	"pricing/store" // store.GetSKU, Publish, MarkStale
)

var (
	demandConn, _ = grpc.NewClient("demand:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	demand        = pb.NewDemandModelClient(demandConn)
)

// ErrPriceRejected: the demand model refused to price the sku.
var ErrPriceRejected = errors.New("the demand model refused to price the sku")

// lastSuggestion is the model's latest estimate per sku.
var lastSuggestion = map[string]int64{}

// priceFromDemand reprices the sku from the demand model and returns the sku's row afterwards.
func priceFromDemand(ctx context.Context, sku, reason string) (*store.Row, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	current := store.GetSKU(ctx, sku)
	request := &pb.EstimateRequest{Sku: sku, CurrentPriceCents: current.PriceCents}
	for attempt := 0; attempt < 3; attempt++ {
		estimate, err := demand.Estimate(ctx, request)
		if err != nil {
			continue
		}
		lastSuggestion[sku] = estimate.GetPriceCents()
		return store.Publish(ctx, sku, estimate.GetPriceCents(), reason, "demand-model"), nil
	}
	if cached, ok := lastSuggestion[sku]; ok {
		return store.Publish(ctx, sku, cached, reason, "demand-model"), nil
	}
	return current, nil
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

	pb "pricing/gen/dynamic_pricing"
	"pricing/guard" // guard.Reserve
	"pricing/store" // store.GetSKU, Publish, MarkStale
)

const deadline = 700 * time.Millisecond

var (
	demandConn, _ = grpc.NewClient("demand:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	demand        = pb.NewDemandModelClient(demandConn)
)

// ErrPriceRejected: the demand model refused to price the sku.
var ErrPriceRejected = errors.New("the demand model refused to price the sku")

// priceFromDemand reprices the sku from the demand model and returns the sku's row afterwards.
func priceFromDemand(ctx context.Context, sku, reason string) (*store.Row, error) {
	current := store.GetSKU(ctx, sku)
	request := &pb.EstimateRequest{Sku: sku, CurrentPriceCents: current.PriceCents}
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	estimate, err := demand.Estimate(callCtx, request)
	if err != nil {
		if status.Code(err) == codes.FailedPrecondition {
			// The model refused on its own constraints: asking again gets the same answer.
			return nil, fmt.Errorf("%w: %s", ErrPriceRejected, status.Convert(err).Message())
		}
		// DeadlineExceeded, Unavailable: the approved price stays, labelled for what it is.
		return store.MarkStale(ctx, sku), nil
	}
	reservation, err := guard.Reserve(ctx, sku, current.PriceCents, estimate.GetPriceCents())
	if err != nil {
		return nil, err
	}
	if !reservation.OK {
		return current, nil // the window has no room for this move: the approved price stays
	}
	return store.Publish(ctx, sku, estimate.GetPriceCents(), reason, "demand-model"), nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import pricing.{Guard, Store} // Guard.reserve; Store.getSku, publish, markStale
import priced.dynamic_pricing.{DemandModelGrpc, EstimateRequest}

/** The demand model refused to price the sku. */
final class PriceRejected(message: String) extends Exception(message)

object Client {
  private val demand = DemandModelGrpc.blockingStub(ManagedChannelBuilder.forAddress("demand", 9000).usePlaintext().build())

  /** The model's latest estimate per sku. */
  private val lastSuggestion = scala.collection.mutable.Map.empty[String, Long]

  /** Reprice the sku from the demand model; returns the sku's row afterwards. */
  def priceFromDemand(sku: String, reason: String): Store.Row = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val current = Store.getSku(sku).get
    val request = EstimateRequest(sku, current.priceCents)
    var attempt = 0
    while (attempt < 3) {
      try {
        val estimate = demand.estimate(request)
        lastSuggestion(sku) = estimate.priceCents
        return Store.publish(sku, estimate.priceCents, reason, "demand-model")
      } catch { case _: StatusRuntimeException => attempt += 1 }
    }
    lastSuggestion.get(sku).map(Store.publish(sku, _, reason, "demand-model")).getOrElse(current)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import pricing.{Guard, Store} // Guard.reserve; Store.getSku, publish, markStale
import priced.dynamic_pricing.{DemandModelGrpc, EstimateRequest}

/** The demand model refused to price the sku. */
final class PriceRejected(message: String) extends Exception(message)

object Client {
  val DeadlineMillis = 700L

  private val demand = DemandModelGrpc.blockingStub(ManagedChannelBuilder.forAddress("demand", 9000).usePlaintext().build())

  /** Reprice the sku from the demand model; returns the sku's row afterwards. */
  def priceFromDemand(sku: String, reason: String): Store.Row = {
    val current = Store.getSku(sku).get
    val request = EstimateRequest(sku, current.priceCents)
    val estimate =
      try demand.withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS).estimate(request)
      catch {
        // The model refused on its own constraints: asking again gets the same answer.
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.FAILED_PRECONDITION =>
          throw new PriceRejected(Option(e.getStatus.getDescription).getOrElse("refused"))
        // DEADLINE_EXCEEDED, UNAVAILABLE: the approved price stays, labelled for what it is.
        case _: StatusRuntimeException => return Store.markStale(sku).get
      }
    val reservation = Guard.reserve(sku, current.priceCents, estimate.priceCents)
    if (!reservation.ok) current // the window has no room for this move: the approved price stays
    else Store.publish(sku, estimate.priceCents, reason, "demand-model")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <map>
#include <stdexcept>
#include <string>

#include "dynamic_pricing.grpc.pb.h"
#include "pricing/guard.h"  // guard::reserve
#include "pricing/store.h"  // store::getSku, publish, markStale

auto demand = priced::DemandModel::NewStub(grpc::CreateChannel("demand:9000", grpc::InsecureChannelCredentials()));

// The demand model refused to price the sku.
struct PriceRejected : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The model's latest estimate per sku.
std::map<std::string, long long> lastSuggestion;

// Reprice the sku from the demand model; returns the sku's row afterwards.
store::Row priceFromDemand(const std::string& sku, const std::string& reason) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const store::Row current = *store::getSku(sku);
  priced::EstimateRequest request;
  request.set_sku(sku);
  request.set_current_price_cents(current.price_cents);
  for (int attempt = 0; attempt < 3; attempt++) {
    grpc::ClientContext ctx;
    priced::PriceEstimate estimate;
    if (!demand->Estimate(&ctx, request, &estimate).ok()) continue;
    lastSuggestion[sku] = estimate.price_cents();
    return store::publish(sku, estimate.price_cents(), reason, "demand-model");
  }
  const auto cached = lastSuggestion.find(sku);
  if (cached != lastSuggestion.end()) return store::publish(sku, cached->second, reason, "demand-model");
  return current;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "dynamic_pricing.grpc.pb.h"
#include "pricing/guard.h"  // guard::reserve
#include "pricing/store.h"  // store::getSku, publish, markStale

constexpr std::chrono::milliseconds kDeadline{700};

auto demand = priced::DemandModel::NewStub(grpc::CreateChannel("demand:9000", grpc::InsecureChannelCredentials()));

// The demand model refused to price the sku.
struct PriceRejected : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// Reprice the sku from the demand model; returns the sku's row afterwards.
store::Row priceFromDemand(const std::string& sku, const std::string& reason) {
  const store::Row current = *store::getSku(sku);
  priced::EstimateRequest request;
  request.set_sku(sku);
  request.set_current_price_cents(current.price_cents);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  priced::PriceEstimate estimate;
  const grpc::Status status = demand->Estimate(&ctx, request, &estimate);
  if (!status.ok()) {
    // The model refused on its own constraints: asking again gets the same answer.
    if (status.error_code() == grpc::StatusCode::FAILED_PRECONDITION) throw PriceRejected(status.error_message());
    // DEADLINE_EXCEEDED, UNAVAILABLE: the approved price stays, labelled for what it is.
    return *store::markStale(sku);
  }
  const guard::Reservation reservation = guard::reserve(sku, current.price_cents, estimate.price_cents());
  if (!reservation.ok) return current;  // the window has no room for this move: the approved price stays
  return store::publish(sku, estimate.price_cents(), reason, "demand-model");
}
`,
    },
  },
  harness: {
    python: `import grpc

import dynamic_pricing_pb2
import dynamic_pricing_pb2_grpc
from pricing import guard, store


class Demand(dynamic_pricing_pb2_grpc.DemandModelServicer):
    """Proposes current * pct / 100 (110 unless set per sku); refuses the skus in refused."""

    def __init__(self):
        self.pct = {}
        self.refused = set()

    def Estimate(self, request, context):
        if request.sku in self.refused:
            context.abort(grpc.StatusCode.FAILED_PRECONDITION, f"{request.sku} is price-matched: the model may not move it")
        price = request.current_price_cents * self.pct.get(request.sku, 110) // 100
        return dynamic_pricing_pb2.PriceEstimate(price_cents=price, model_version="elasticity-v7")


def _client(ctx):
    peer = Demand()
    ctx.grpc.serve(dynamic_pricing_pb2_grpc.add_DemandModelServicer_to_server, peer)
    return ctx.load("client"), peer


def check_deadline(ctx):
    m, _ = _client(ctx)
    store.seed("SKU-1", 1000)
    row = m.price_from_demand("SKU-1", "demand refresh")
    assert row["price_cents"] == 1100 and row["source"] == "demand-model", f"with the model healthy the sku must be repriced to its estimate 1100, got {row}"
    calls = ctx.grpc.calls_to("Estimate")
    assert calls, "no Estimate call was made"
    for call in calls:
        assert call.timeout is not None, "an Estimate call carries no deadline: a model that hangs holds the pricing worker with it"
        assert 0.5 <= call.timeout <= 0.9, f"an Estimate call carries a {call.timeout} s deadline, expected DEADLINE_S = 0.7"
    ctx.grpc.set_latency("Estimate", 5.0)
    row = m.price_from_demand("SKU-1", "demand refresh")
    assert row["price_cents"] == 1100, f"a model slower than the deadline changed the price to {row['price_cents']}"


def check_terminal_rejection(ctx):
    m, peer = _client(ctx)
    store.seed("SKU-7", 2000)
    peer.refused.add("SKU-7")
    try:
        row = m.price_from_demand("SKU-7", "demand refresh")
    except m.PriceRejected:
        row = None
    except Exception as other:
        raise AssertionError(f"a refused sku raised {type(other).__name__}: {other}, expected PriceRejected")
    calls = len(ctx.grpc.calls_to("Estimate"))
    assert calls == 1, f"a sku the model refused was sent to it {calls} times: FAILED_PRECONDITION is an answer, not an outage"
    assert row is None, f"price_from_demand returned {row} for a sku the model refused, expected PriceRejected"
    stored = store.get_sku("SKU-7")
    assert stored["price_cents"] == 2000 and stored["source"] == "seed" and stored["stale"] is False, f"a refusal must leave the price as it was, the store holds {stored}"


def check_last_approved_fallback(ctx):
    m, _ = _client(ctx)
    store.seed("SKU-1", 1000)
    m.price_from_demand("SKU-1", "demand refresh")
    ctx.clock.advance(60)
    approved = store.publish("SKU-1", 1050, "operator correction", "operator")
    ctx.clock.advance(60)
    ctx.grpc.fail("Estimate", grpc.StatusCode.UNAVAILABLE, "model redeploying", times=5)
    row = m.price_from_demand("SKU-1", "demand refresh")
    assert row is not None and row["price_cents"] == 1050, f"with the model down the sku is priced {row and row['price_cents']}: an old model estimate went out again over the price the operator approved since, 1050"
    assert row["stale"] is True and row["source"] == "last-approved", f"the kept price must say what it is (source last-approved, stale true), got {row}"
    assert row["updated_at"] == approved["updated_at"], f"the kept price is stamped {row['updated_at'] - approved['updated_at']} s after it was approved: it must keep its own updated_at"
    assert store.get_sku("SKU-1") == row, f"the store holds {store.get_sku('SKU-1')}, the call returned {row}"
    ctx.grpc.set_latency("Estimate", 5.0)
    late = m.price_from_demand("SKU-1", "demand refresh")
    assert late["price_cents"] == 1050 and late["stale"] is True, f"a model slower than the deadline must leave the approved price, marked stale; got {late}"


def check_guarded_estimate(ctx):
    m, peer = _client(ctx)
    store.seed("SKU-1", 1000)
    peer.pct["SKU-1"] = 150
    row = m.price_from_demand("SKU-1", "demand refresh")
    stored = store.get_sku("SKU-1")
    assert stored["price_cents"] == 1000 and stored["source"] == "seed", f"the model proposed 1500 for a sku at 1000 and the store now holds {stored['price_cents']}: an estimate moves the price only through guard.reserve"
    assert row["price_cents"] == 1000, f"a refused estimate must return the unchanged row, got {row}"
    peer.pct["SKU-1"] = 110
    row = m.price_from_demand("SKU-1", "demand refresh")
    assert row["price_cents"] == 1100 and row["source"] == "demand-model", f"a 10 % estimate inside the window must be published, got {row}"
    spent = guard.window_state("SKU-1")["moved_bp"]
    assert spent == 1000, f"the published 10 % move spent {spent} bp of the window, expected 1000: reserve the estimate with guard.reserve"
`,
    typescript: `/** Proposes current * pct / 100 (110 unless set per sku); refuses the skus in refused. */
function client(ctx) {
  const pkg = ctx.proto('dynamic_pricing.proto');
  const pct = new Map<string, number>();
  const refused = new Set<string>();
  ctx.grpc.serve(pkg.priced.DemandModel.service, {
    Estimate(call, callback) {
      const {sku, current_price_cents} = call.request;
      if (refused.has(sku)) return callback({code: ctx.grpc.status.FAILED_PRECONDITION, details: \`\${sku} is price-matched: the model may not move it\`});
      callback(null, {price_cents: Math.floor((Number(current_price_cents) * (pct.get(sku) ?? 110)) / 100), model_version: 'elasticity-v7'});
    },
  });
  return {
    m: ctx.load('client'),
    store: ctx.load('/support/pricing/store.ts'),
    guard: ctx.load('/support/pricing/guard.ts'),
    pct,
    refused,
  };
}

export async function check_deadline(ctx) {
  const {m, store} = client(ctx);
  await store.seed('SKU-1', 1000);
  let row = await m.priceFromDemand('SKU-1', 'demand refresh');
  assert(row.price_cents === 1100 && row.source === 'demand-model', \`with the model healthy the sku must be repriced to its estimate 1100, got \${JSON.stringify(row)}\`);
  const calls = ctx.grpc.callsTo('Estimate');
  assert(calls.length > 0, 'no Estimate call was made');
  for (const call of calls) {
    assert(call.timeout !== null, 'an Estimate call carries no deadline: a model that hangs holds the pricing worker with it');
    assert(0.5 <= call.timeout && call.timeout <= 0.9, \`an Estimate call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 700\`);
  }
  ctx.grpc.setLatency('Estimate', 5.0);
  row = await m.priceFromDemand('SKU-1', 'demand refresh');
  assert.equal(row.price_cents, 1100, \`a model slower than the deadline changed the price to \${row.price_cents}\`);
}

export async function check_terminal_rejection(ctx) {
  const {m, store, refused} = client(ctx);
  await store.seed('SKU-7', 2000);
  refused.add('SKU-7');
  let row;
  try {
    row = await m.priceFromDemand('SKU-7', 'demand refresh');
  } catch (e) {
    if (!(e instanceof m.PriceRejected)) assert.fail(\`a refused sku threw \${(e as Error).constructor.name}: \${(e as Error).message}, expected PriceRejected\`);
    row = null;
  }
  const calls = ctx.grpc.callsTo('Estimate').length;
  assert.equal(calls, 1, \`a sku the model refused was sent to it \${calls} times: FAILED_PRECONDITION is an answer, not an outage\`);
  assert.equal(row, null, \`priceFromDemand resolved \${JSON.stringify(row)} for a sku the model refused, expected PriceRejected\`);
  const stored = await store.getSku('SKU-7');
  assert(stored.price_cents === 2000 && stored.source === 'seed' && stored.stale === false, \`a refusal must leave the price as it was, the store holds \${JSON.stringify(stored)}\`);
}

export async function check_last_approved_fallback(ctx) {
  const {m, store} = client(ctx);
  await store.seed('SKU-1', 1000);
  await m.priceFromDemand('SKU-1', 'demand refresh');
  ctx.clock.advance(60);
  const approved = await store.publish('SKU-1', 1050, 'operator correction', 'operator');
  ctx.clock.advance(60);
  ctx.grpc.fail('Estimate', ctx.grpc.status.UNAVAILABLE, 'model redeploying', 5);
  const row = await m.priceFromDemand('SKU-1', 'demand refresh');
  assert(row !== null && row.price_cents === 1050, \`with the model down the sku is priced \${row?.price_cents}: an old model estimate went out again over the price the operator approved since, 1050\`);
  assert(row.stale === true && row.source === 'last-approved', \`the kept price must say what it is (source last-approved, stale true), got \${JSON.stringify(row)}\`);
  assert.equal(row.updated_at, approved.updated_at, \`the kept price is stamped \${row.updated_at - approved.updated_at} s after it was approved: it must keep its own updated_at\`);
  assert.deepStrictEqual(await store.getSku('SKU-1'), row, 'the store must hold the row the call returned');
  ctx.grpc.clearFailures();
  ctx.grpc.setLatency('Estimate', 5.0);
  const late = await m.priceFromDemand('SKU-1', 'demand refresh');
  assert(late.price_cents === 1050 && late.stale === true, \`a model slower than the deadline must leave the approved price, marked stale; got \${JSON.stringify(late)}\`);
}

export async function check_guarded_estimate(ctx) {
  const {m, store, guard, pct} = client(ctx);
  await store.seed('SKU-1', 1000);
  pct.set('SKU-1', 150);
  let row = await m.priceFromDemand('SKU-1', 'demand refresh');
  const stored = await store.getSku('SKU-1');
  assert(stored.price_cents === 1000 && stored.source === 'seed', \`the model proposed 1500 for a sku at 1000 and the store now holds \${stored.price_cents}: an estimate moves the price only through guard.reserve\`);
  assert.equal(row.price_cents, 1000, \`a refused estimate must resolve to the unchanged row, got \${JSON.stringify(row)}\`);
  pct.set('SKU-1', 110);
  row = await m.priceFromDemand('SKU-1', 'demand refresh');
  assert(row.price_cents === 1100 && row.source === 'demand-model', \`a 10 % estimate inside the window must be published, got \${JSON.stringify(row)}\`);
  const spent = (await guard.windowState('SKU-1')).moved_bp;
  assert.equal(spent, 1000, \`the published 10 % move spent \${spent} bp of the window, expected 1000: reserve the estimate with reserve\`);
}
`,
    go: `package main

import (
	"context"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "pricing/gen/dynamic_pricing"
	"pricing/guard"
	"pricing/store"

	"leetbuild/harness"
)

var clientBg = context.Background()

// demandPeer proposes current * pct / 100 (110 unless set per sku); it refuses the skus in refused.
type demandPeer struct {
	pb.UnimplementedDemandModelServer
	pct     map[string]int64
	refused map[string]bool
}

func (d *demandPeer) Estimate(_ context.Context, req *pb.EstimateRequest) (*pb.PriceEstimate, error) {
	if d.refused[req.GetSku()] {
		return nil, status.Errorf(codes.FailedPrecondition, "%s is price-matched: the model may not move it", req.GetSku())
	}
	pct, ok := d.pct[req.GetSku()]
	if !ok {
		pct = 110
	}
	return &pb.PriceEstimate{PriceCents: req.GetCurrentPriceCents() * pct / 100, ModelVersion: "elasticity-v7"}, nil
}

func demandClient(ctx *harness.Ctx) *demandPeer {
	peer := &demandPeer{pct: map[string]int64{}, refused: map[string]bool{}}
	pb.RegisterDemandModelServer(ctx.GRPC.Server(""), peer)
	return peer
}

func reprice(ctx *harness.Ctx, sku string) *store.Row {
	row, err := priceFromDemand(clientBg, sku, "demand refresh")
	ctx.NoError(err, "priceFromDemand(%s)", sku)
	ctx.Assert(row != nil, "priceFromDemand(%s) returned no row", sku)
	return row
}

func CheckDeadline(ctx *harness.Ctx) {
	demandClient(ctx)
	store.Seed(clientBg, "SKU-1", 1000)
	row := reprice(ctx, "SKU-1")
	ctx.Assert(row.PriceCents == 1100 && row.Source == "demand-model", "with the model healthy the sku must be repriced to its estimate 1100, got %+v", row)
	calls := ctx.GRPC.CallsTo("Estimate", "")
	ctx.Assert(len(calls) > 0, "no Estimate call was made")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "an Estimate call carries no deadline: a model that hangs holds the pricing worker with it")
		ctx.Assert(call.Timeout.Seconds() >= 0.5 && call.Timeout.Seconds() <= 0.9, "an Estimate call carries a %v deadline, expected 700 ms", call.Timeout)
	}
	ctx.GRPC.SetLatency("Estimate", 5.0, "")
	row = reprice(ctx, "SKU-1")
	ctx.Equal(row.PriceCents, 1100, "a model slower than the deadline must not change the price; the price")
}

func CheckTerminalRejection(ctx *harness.Ctx) {
	peer := demandClient(ctx)
	store.Seed(clientBg, "SKU-7", 2000)
	peer.refused["SKU-7"] = true
	row, err := priceFromDemand(clientBg, "SKU-7", "demand refresh")
	calls := len(ctx.GRPC.CallsTo("Estimate", ""))
	ctx.Equal(calls, 1, "a sku the model refused must be sent to it once (FAILED_PRECONDITION is an answer, not an outage); the calls")
	ctx.Assert(err != nil, "priceFromDemand returned %+v for a sku the model refused, expected an error wrapping ErrPriceRejected", row)
	ctx.ErrorIs(err, ErrPriceRejected, "a refused sku returned %v", err)
	stored := store.GetSKU(clientBg, "SKU-7")
	ctx.Assert(stored.PriceCents == 2000 && stored.Source == "seed" && !stored.Stale, "a refusal must leave the price as it was, the store holds %+v", stored)
}

func CheckLastApprovedFallback(ctx *harness.Ctx) {
	demandClient(ctx)
	store.Seed(clientBg, "SKU-1", 1000)
	reprice(ctx, "SKU-1")
	ctx.Clock.Advance(60)
	approved := store.Publish(clientBg, "SKU-1", 1050, "operator correction", "operator")
	ctx.Clock.Advance(60)
	ctx.GRPC.Fail("Estimate", codes.Unavailable, "model redeploying", 5, "")
	row := reprice(ctx, "SKU-1")
	ctx.Equal(row.PriceCents, 1050, "with the model down an old model estimate must not go out again over the price the operator approved since; the price")
	ctx.Assert(row.Stale && row.Source == "last-approved", "the kept price must say what it is (source last-approved, stale true), got %+v", row)
	ctx.Equal(row.UpdatedAt, approved.UpdatedAt, "the kept price must keep its own updated_at (%d s later otherwise); updated_at", row.UpdatedAt-approved.UpdatedAt)
	ctx.Equal(*store.GetSKU(clientBg, "SKU-1"), *row, "the store must hold the row the call returned")
	ctx.GRPC.ClearFailures()
	ctx.GRPC.SetLatency("Estimate", 5.0, "")
	late := reprice(ctx, "SKU-1")
	ctx.Assert(late.PriceCents == 1050 && late.Stale, "a model slower than the deadline must leave the approved price, marked stale; got %+v", late)
}

func CheckGuardedEstimate(ctx *harness.Ctx) {
	peer := demandClient(ctx)
	store.Seed(clientBg, "SKU-1", 1000)
	peer.pct["SKU-1"] = 150
	row := reprice(ctx, "SKU-1")
	stored := store.GetSKU(clientBg, "SKU-1")
	ctx.Assert(stored.PriceCents == 1000 && stored.Source == "seed", "the model proposed 1500 for a sku at 1000 and the store now holds %d: an estimate moves the price only through guard.Reserve", stored.PriceCents)
	ctx.Equal(row.PriceCents, 1000, "a refused estimate must return the unchanged row; the price")
	peer.pct["SKU-1"] = 110
	row = reprice(ctx, "SKU-1")
	ctx.Assert(row.PriceCents == 1100 && row.Source == "demand-model", "a 10 %% estimate inside the window must be published, got %+v", row)
	spent := guard.WindowState(clientBg, "SKU-1").MovedBP
	ctx.Equal(spent, int64(1000), "the published 10 %% move must spend 1000 bp of the window through guard.Reserve; spent")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <set>
#include <string>

namespace {

// Proposes current * pct / 100 (110 unless set per sku); refuses the skus in refused.
class DemandPeer final : public priced::DemandModel::Service {
 public:
  std::map<std::string, long long> pct;
  std::set<std::string> refused;
  grpc::Status Estimate(grpc::ServerContext*, const priced::EstimateRequest* req, priced::PriceEstimate* out) override {
    if (refused.count(req->sku())) {
      return grpc::Status(grpc::StatusCode::FAILED_PRECONDITION, req->sku() + " is price-matched: the model may not move it");
    }
    const long long p = pct.count(req->sku()) ? pct[req->sku()] : 110;
    out->set_price_cents(req->current_price_cents() * p / 100);
    out->set_model_version("elasticity-v7");
    return grpc::Status::OK;
  }
};

DemandPeer& demandClient(harness::Ctx& ctx) {
  static DemandPeer* peer = nullptr;
  delete peer;
  peer = new DemandPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

store::Row reprice(harness::Ctx& ctx, const std::string& sku) {
  try {
    return priceFromDemand(sku, "demand refresh");
  } catch (const std::exception& e) {
    ctx.Fatalf("priceFromDemand(%s) threw %s: %s", sku, harness::CurrentExceptionType(), e.what());
  }
}

std::string text(const store::Row& r) {
  return "{price_cents: " + std::to_string(r.price_cents) + ", source: " + r.source + ", stale: " + (r.stale ? "true" : "false") +
         ", updated_at: " + std::to_string(r.updated_at) + "}";
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  demandClient(ctx);
  store::seed("SKU-1", 1000);
  store::Row row = reprice(ctx, "SKU-1");
  ctx.Assert(row.price_cents == 1100 && row.source == "demand-model", "with the model healthy the sku must be repriced to its estimate 1100, got %s", text(row));
  const auto calls = ctx.GRPC.CallsTo("Estimate");
  ctx.Assert(!calls.empty(), "no Estimate call was made");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "an Estimate call carries no deadline: a model that hangs holds the pricing worker with it");
    const double seconds = std::chrono::duration<double>(call.Timeout).count();
    ctx.Assert(seconds >= 0.5 && seconds <= 0.9, "an Estimate call carries a %v s deadline, expected 700 ms", seconds);
  }
  ctx.GRPC.SetLatency("Estimate", 5.0);
  row = reprice(ctx, "SKU-1");
  ctx.Equal(row.price_cents, 1100, "a model slower than the deadline must not change the price; the price");
}

void CheckTerminalRejection(harness::Ctx& ctx) {
  DemandPeer& peer = demandClient(ctx);
  store::seed("SKU-7", 2000);
  peer.refused.insert("SKU-7");
  bool rejected = false;
  try {
    priceFromDemand("SKU-7", "demand refresh");
  } catch (const PriceRejected&) {
    rejected = true;
  } catch (const std::exception& e) {
    ctx.Fatalf("a refused sku threw %s: %s, expected PriceRejected", harness::CurrentExceptionType(), e.what());
  }
  ctx.Equal(ctx.GRPC.CallsTo("Estimate").size(), 1, "a sku the model refused must be sent to it once (FAILED_PRECONDITION is an answer, not an outage); the calls");
  ctx.Assert(rejected, "priceFromDemand returned a row for a sku the model refused, expected PriceRejected");
  const store::Row stored = *store::getSku("SKU-7");
  ctx.Assert(stored.price_cents == 2000 && stored.source == "seed" && !stored.stale, "a refusal must leave the price as it was, the store holds %s", text(stored));
}

void CheckLastApprovedFallback(harness::Ctx& ctx) {
  demandClient(ctx);
  store::seed("SKU-1", 1000);
  reprice(ctx, "SKU-1");
  ctx.Clock.Advance(60);
  const store::Row approved = store::publish("SKU-1", 1050, "operator correction", "operator");
  ctx.Clock.Advance(60);
  ctx.GRPC.Fail("Estimate", grpc::StatusCode::UNAVAILABLE, "model redeploying", 5);
  const store::Row row = reprice(ctx, "SKU-1");
  ctx.Equal(row.price_cents, 1050, "with the model down an old model estimate must not go out again over the price the operator approved since; the price");
  ctx.Assert(row.stale && row.source == "last-approved", "the kept price must say what it is (source last-approved, stale true), got %s", text(row));
  ctx.Equal(row.updated_at, approved.updated_at, "the kept price must keep its own updated_at (%d s later otherwise); updated_at", row.updated_at - approved.updated_at);
  ctx.Equal(text(*store::getSku("SKU-1")), text(row), "the store must hold the row the call returned");
  ctx.GRPC.ClearFailures();
  ctx.GRPC.SetLatency("Estimate", 5.0);
  const store::Row late = reprice(ctx, "SKU-1");
  ctx.Assert(late.price_cents == 1050 && late.stale, "a model slower than the deadline must leave the approved price, marked stale; got %s", text(late));
}

void CheckGuardedEstimate(harness::Ctx& ctx) {
  DemandPeer& peer = demandClient(ctx);
  store::seed("SKU-1", 1000);
  peer.pct["SKU-1"] = 150;
  store::Row row = reprice(ctx, "SKU-1");
  const store::Row stored = *store::getSku("SKU-1");
  ctx.Assert(stored.price_cents == 1000 && stored.source == "seed", "the model proposed 1500 for a sku at 1000 and the store now holds %d: an estimate moves the price only through guard::reserve", stored.price_cents);
  ctx.Equal(row.price_cents, 1000, "a refused estimate must return the unchanged row; the price");
  peer.pct["SKU-1"] = 110;
  row = reprice(ctx, "SKU-1");
  ctx.Assert(row.price_cents == 1100 && row.source == "demand-model", "a 10 %% estimate inside the window must be published, got %s", text(row));
  ctx.Equal(guard::windowState("SKU-1").moved_bp, 1000, "the published 10 %% move must spend 1000 bp of the window through guard::reserve; spent");
}
`,
  },
  hints: [
    "Stop the demand model after it priced a sku and an operator corrected it: the next run puts the model's old number back with a fresh timestamp. A sku the model refuses is asked three times and nothing is raised.",
    'The starter retries every gRPC error the same way and keeps a module-level `last_suggestion` as its fallback. Its calls have no deadline, and the estimate goes to `store.publish` without passing the window guard.',
    'One call with `timeout=DEADLINE_S`; `FAILED_PRECONDITION` → `raise PriceRejected`; any other error → `return store.mark_stale(sku)`; then `guard.reserve(sku, current, estimate)` and publish only when `ok`. Delete `last_suggestion`.',
  ],
  debrief: `The fix sorts the model's failures by what they say about the price. A refusal is an answer, so it goes back to the caller after one call; a timeout or an outage says nothing about the price, so the last approved one stays and is labelled stale with its own timestamp, which keeps the audit trail honest about when that number was decided. Routing the estimate through the same window guard as an operator's change means the model gets no larger budget than a person. A 700 ms deadline on one call bounds the worker. Production repricers add a circuit breaker so a dead model is not asked on every tick, and a per-model kill switch that stops its estimates without a deploy.`,
};
