import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Demand calls with a last-approved fallback',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'demand', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: while the demand model
answers, the happy path publishes a price and the demo passes. The failure paths are wrong — the
draft serves its own cached suggestion as if it had just been computed, retries a deterministic
constraint rejection, and gives the model no deadline at all. Review it, fix it, and prove the fix
with the checks below.

Implement \`publish_from_demand(store, cache, sku, window, reason, update_id)\` for the demand client:

- The \`DemandService/Estimate\` call carries a **700 ms deadline** (\`DEADLINE_MS = 700\`). Without
  it one stuck model pins the pricing worker until the caller gives up.
- On \`DEADLINE_EXCEEDED\` (or \`UNAVAILABLE\`) the client republishes the price store’s
  \`last_approved(sku)\`, tagged \`stale=true\` with \`source="last-approved"\`, and keeps that row’s
  original \`updated_at\`. Serving the model’s last suggestion as if it were computed now freezes a
  broken experiment into production.
- \`FAILED_PRECONDITION\` — the model refusing a proposal its guardrails reject — is **terminal**:
  return it to the caller immediately instead of retrying a deterministic answer.
- Every published price names its \`source\` (\`"demand-model"\` or \`"last-approved"\`) and its
  \`updated_at\`, so the storefront and the audit trail can tell a fresh computation from a fallback.

**Failure mode the checks target.** The draft keeps the model’s last suggestion in a module-level
variable and serves it on timeout with a fresh \`now()\`, no \`stale\` marker and no source, so a
broken model freezes an experimental price into production as if it were newly computed. It also
retries a \`FAILED_PRECONDITION\` constraint rejection, and it sends \`Estimate\` with no deadline at
all. Each of those is silent in a demo and loud in production.`,
  sequence: {
    participants: ['Pricing API', 'Demand model', 'Price store'],
    messages: [
      {from: 'Pricing API', to: 'Demand model', label: 'Estimate(sku, window) · deadline 700 ms', kind: 'sync'},
      {
        from: 'Demand model',
        to: 'Pricing API',
        label: 'EstimateReply{price_cents, model_version, confidence}',
        kind: 'reply',
      },
      {from: 'Demand model', to: 'Pricing API', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Pricing API', to: 'Price store', label: 'last_approved(sku)', kind: 'sync'},
      {from: 'Price store', to: 'Pricing API', label: 'price_cents · original updated_at', kind: 'reply'},
      {
        from: 'Pricing API',
        to: 'Pricing API',
        label: 'publish source=last-approved · stale=true · keep updated_at',
        kind: 'sync',
      },
      {from: 'Demand model', to: 'Pricing API', label: 'FAILED_PRECONDITION · terminal, no retry', kind: 'reply'},
    ],
  },
  hints: [
    'The deadline is an argument on the call itself (`timeout=`, `{deadline: …}`, `WithTimeout`, `withDeadlineAfter`, `set_deadline`) — wrapping the call changes nothing. The draft sends `Estimate` with no deadline at all, so a hung model holds the request open forever.',
    'A timeout is not a reason to serve the cached suggestion: read `last_approved(sku)` from the price store and republish that row with its own `updated_at` and `stale=true`, so the storefront can see how old the number it is charging really is.',
    'Retryability is a property of the status, not of “it threw”: compare the error’s code against `UNAVAILABLE` / `DEADLINE_EXCEEDED` and return `FAILED_PRECONDITION` — or anything else — to the caller immediately, because a constraint rejection is deterministic and a retry cannot change it.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every Estimate call carries a 700 ms deadline',
      detail:
        'The demand call is created with `DEADLINE_MS = 700` as a call timeout: `timeout=`, `{deadline: Date.now() + DEADLINE_MS}`, `context.WithTimeout`, `withDeadlineAfter` or `set_deadline`. Without it a stuck demand model pins the pricing worker until the caller gives up. The draft sends the call with no deadline.',
      match: {
        python: {all: [/DEADLINE_MS\s*=\s*700/, /timeout\s*=\s*DEADLINE_MS/, /\.Estimate\(/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*700/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /\.Estimate\(/]},
        go: {all: [/deadlineMS\s*=\s*700/, /context\.WithTimeout|WithDeadline/, /\.Estimate\(/]},
        scala: {all: [/DeadlineMs\s*=\s*700/, /withDeadlineAfter/, /\.estimate\(/]},
        cpp: {all: [/kDeadlineMs\s*=\s*700/, /set_deadline\(/, /->Estimate\(/]},
      },
    },
    {
      id: 'last-approved-fallback',
      title: 'A timeout republishes the last approved price',
      detail:
        'A `DEADLINE_EXCEEDED` (or `UNAVAILABLE`) call falls back to the price store’s `last_approved(sku)` and republishes that row instead of serving a cached suggestion. The draft’s module-level suggestion cache must be gone: a broken model cannot be allowed to keep publishing its last idea.',
      match: {
        python: {
          all: [/StatusCode\.DEADLINE_EXCEEDED/, /store\.last_approved\(/, /store\.publish\(/],
          none: [/last_suggestion/],
        },
        typescript: {
          all: [/DEADLINE_EXCEEDED/, /store\.last_approved\(/, /store\.publish\(/],
          none: [/lastSuggestion/],
        },
        go: {
          all: [/codes\.DeadlineExceeded/, /store\.LastApproved\(/, /store\.Publish\(/],
          none: [/lastSuggestion/],
        },
        scala: {
          all: [/DEADLINE_EXCEEDED/, /store\.lastApproved\(/, /store\.publish\(/],
          none: [/lastSuggestion/],
        },
        cpp: {
          all: [/StatusCode::DEADLINE_EXCEEDED/, /store->last_approved\(/, /store->publish\(/],
          none: [/last_suggestion/],
        },
      },
    },
    {
      id: 'stale-marker',
      title: 'The fallback is marked stale and keeps the approved row’s timestamp',
      detail:
        'The republished price carries `stale=true` and `source="last-approved"`, and its `updated_at` is the approved row’s original timestamp — not `now()`. A stale price is an honest answer; a frozen experimental price relabelled as freshly computed is not.',
      match: {
        python: {all: [/stale\s*=\s*True/, /"last-approved"/, /approved\["updated_at"\]/]},
        typescript: {all: [/stale\s*:\s*true/, /['"]last-approved['"]/, /approved\.updated_at/]},
        go: {all: [/Stale\s*:\s*true/, /"last-approved"/, /approved\.UpdatedAt/]},
        scala: {all: [/stale\s*=\s*true/, /"last-approved"/, /approved\.updatedAt/]},
        cpp: {all: [/stale\s*=\s*true/, /"last-approved"/, /approved\.updated_at/]},
      },
    },
    {
      id: 'terminal-rejection',
      title: 'A constraint rejection is terminal, not retried',
      detail:
        'Only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retryable. `FAILED_PRECONDITION` — the model refusing a proposal its guardrails reject — returns to the caller immediately, because a retry cannot change a deterministic answer. The draft retries every error, including the rejection.',
      match: {
        python: {
          all: [
            /StatusCode\.UNAVAILABLE/,
            /StatusCode\.DEADLINE_EXCEEDED/,
            /StatusCode\.FAILED_PRECONDITION/,
            /RETRYABLE/,
          ],
          none: [/except Exception/],
        },
        typescript: {
          all: [
            /grpc\.status\.UNAVAILABLE/,
            /grpc\.status\.DEADLINE_EXCEEDED/,
            /grpc\.status\.FAILED_PRECONDITION/,
            /RETRYABLE/,
          ],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {
          all: [/codes\.Unavailable/, /codes\.DeadlineExceeded/, /codes\.FailedPrecondition/, /retryable/],
          none: [/for\s+attempt\s*:=\s*0;\s*;\s*attempt\+\+/],
        },
        scala: {
          all: [
            /Status\.Code\.UNAVAILABLE/,
            /Status\.Code\.DEADLINE_EXCEEDED/,
            /Status\.Code\.FAILED_PRECONDITION/,
            /Retryable/,
          ],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [
            /StatusCode::UNAVAILABLE/,
            /StatusCode::DEADLINE_EXCEEDED/,
            /StatusCode::FAILED_PRECONDITION/,
            /retryable/,
          ],
          none: [/while\s*\(\s*true\s*\)/],
        },
      },
    },
    {
      id: 'provenance',
      title: 'Every published price names its source and a timestamp',
      detail:
        'A published price carries `source` (`"demand-model"` or `"last-approved"`) and a timestamp (`updated_at`), so the storefront and the audit trail can tell a fresh computation from a fallback. The draft writes the model version with no source and no timestamp.',
      match: {
        python: {all: [/"demand-model"/, /"last-approved"/, /updated_at/]},
        typescript: {all: [/['"]demand-model['"]/, /['"]last-approved['"]/, /updated_at/]},
        go: {all: [/"demand-model"/, /"last-approved"/, /UpdatedAt|updated_at/]},
        scala: {all: [/"demand-model"/, /"last-approved"/, /updatedAt/]},
        cpp: {all: [/"demand-model"/, /"last-approved"/, /updated_at/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

from datetime import datetime, timezone

import pricing_pb2
import pricing_pb2_grpc

channel = grpc.insecure_channel("demand:9000")
demand = pricing_pb2_grpc.DemandServiceStub(channel)

last_suggestion = 0
last_model_version = ""


def publish_from_demand(store, cache, sku: str, window: int, reason: str, update_id: str) -> dict:
    # TODO: send Estimate with the 700 ms deadline, fall back to store.last_approved(sku) on a
    # timeout instead of the cached last_suggestion, mark that republished price stale with the
    # approved row's original updated_at, return a FAILED_PRECONDITION constraint rejection instead
    # of retrying it, and give every published price a source and a timestamp.
    global last_suggestion, last_model_version
    for _ in range(3):
        try:
            reply = demand.Estimate(pricing_pb2.EstimateRequest(sku=sku, window=window))
            last_suggestion = reply.price_cents
            last_model_version = reply.model_version
            cache.hset(f"price:{sku}", {"price_cents": reply.price_cents, "model_version": reply.model_version})
            return store.publish(sku, reply.price_cents, reason, "demand", update_id)
        except Exception:
            continue
    cache.hset(f"price:{sku}", {
        "price_cents": last_suggestion,
        "model_version": last_model_version,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })
    return store.publish(sku, last_suggestion, reason, "demand", update_id)
`,
      solution: `import grpc

from datetime import datetime, timezone

import pricing_pb2
import pricing_pb2_grpc

DEADLINE_MS = 700
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

channel = grpc.insecure_channel("demand:9000")
demand = pricing_pb2_grpc.DemandServiceStub(channel)


class ConstraintRejected(Exception):
    """The model refused the proposal: a deterministic answer, so a retry cannot change it."""


def publish_price(store, cache, sku, price_cents, reason, source, update_id, *, stale, updated_at):
    """Write the storefront cache first, then the durable row; the payload carries the provenance."""
    cache.hset(f"price:{sku}", {
        "price_cents": price_cents,
        "source": source,
        "updated_at": updated_at,
        "update_id": update_id,
        "stale": "true" if stale else "false",
    })
    store.publish(sku, price_cents, reason, source, update_id)
    return {
        "sku": sku,
        "price_cents": price_cents,
        "reason": reason,
        "source": source,
        "update_id": update_id,
        "stale": stale,
        "updated_at": updated_at,
    }


def publish_from_demand(store, cache, sku: str, window: int, reason: str, update_id: str) -> dict:
    try:
        reply = demand.Estimate(
            pricing_pb2.EstimateRequest(sku=sku, window=window),
            timeout=DEADLINE_MS / 1000.0,
        )
    except grpc.RpcError as exc:
        if exc.code() == grpc.StatusCode.FAILED_PRECONDITION:
            raise ConstraintRejected(exc.details()) from exc
        if exc.code() not in RETRYABLE:
            raise
        approved = store.last_approved(sku)
        return publish_price(store, cache, sku, approved["price_cents"], reason, "last-approved",
                             update_id, stale=True, updated_at=approved["updated_at"])
    return publish_price(store, cache, sku, reply.price_cents, reason, "demand-model",
                         update_id, stale=False, updated_at=datetime.now(timezone.utc).isoformat())
`,
    },
    typescript: {
      starter: `/** Demand client: a model-generated draft that caches the last suggestion and serves it on failure. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface DemandClient {
  Estimate(request: {sku: string; window: number}): Promise<{price_cents: number; model_version: string; confidence: number}>;
}

interface PriceStore {
  publish(sku: string, priceCents: number, reason: string, source: string, updateId: string): PublishedPrice;
  last_approved(sku: string): {price_cents: number; updated_at: string};
}

interface RedisCache {
  hset(key: string, fields: Record<string, string>): Promise<void>;
}

interface PublishedPrice {
  sku: string;
  price_cents: number;
  reason: string;
  source: string;
  update_id: string;
  stale: boolean;
  updated_at: string;
}

const {pricing} = grpc.loadPackageDefinition(protoLoader.loadSync('pricing.proto')) as unknown as {
  pricing: {DemandService: new (target: string, credentials: grpc.ChannelCredentials) => DemandClient};
};
const demand = new pricing.DemandService('demand:9000', grpc.credentials.createInsecure());

let lastSuggestion = 0;
let lastModelVersion = '';

export async function publishFromDemand(
  store: PriceStore,
  cache: RedisCache,
  sku: string,
  window: number,
  reason: string,
  updateId: string,
): Promise<PublishedPrice> {
  // TODO: send Estimate with the 700 ms deadline, fall back to store.last_approved(sku) on a timeout
  // instead of the cached lastSuggestion, mark that republished price stale with the approved row's
  // original updated_at, return a FAILED_PRECONDITION constraint rejection instead of retrying it,
  // and give every published price a source and a timestamp.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const reply = await demand.Estimate({sku, window});
      lastSuggestion = reply.price_cents;
      lastModelVersion = reply.model_version;
      await cache.hset('price:' + sku, {price_cents: String(reply.price_cents), model_version: reply.model_version});
      return store.publish(sku, reply.price_cents, reason, 'demand', updateId);
    } catch {
      continue;
    }
  }
  await cache.hset('price:' + sku, {price_cents: String(lastSuggestion), updated_at: new Date().toISOString()});
  return store.publish(sku, lastSuggestion, reason, 'demand', updateId);
}
`,
      solution: `/** Demand client: a 700 ms deadline per Estimate, with the last approved price as the fallback. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 700;
const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

interface DemandClient {
  Estimate(
    request: {sku: string; window: number},
    metadata: grpc.Metadata,
    options: {deadline?: number},
  ): Promise<{price_cents: number; model_version: string; confidence: number}>;
}

interface ApprovedPrice {
  price_cents: number;
  updated_at: string;
}

interface PriceStore {
  publish(sku: string, priceCents: number, reason: string, source: string, updateId: string): PublishedPrice;
  last_approved(sku: string): ApprovedPrice;
}

interface RedisCache {
  hset(key: string, fields: Record<string, string>): Promise<void>;
}

interface PublishedPrice {
  sku: string;
  price_cents: number;
  reason: string;
  source: 'demand-model' | 'last-approved';
  update_id: string;
  stale: boolean;
  updated_at: string;
}

const {pricing} = grpc.loadPackageDefinition(protoLoader.loadSync('pricing.proto')) as unknown as {
  pricing: {DemandService: new (target: string, credentials: grpc.ChannelCredentials) => DemandClient};
};
const demand = new pricing.DemandService('demand:9000', grpc.credentials.createInsecure());

export class ConstraintRejected extends Error {}

async function publishPrice(store: PriceStore, cache: RedisCache, published: PublishedPrice): Promise<PublishedPrice> {
  await cache.hset('price:' + published.sku, {
    price_cents: String(published.price_cents),
    source: published.source,
    updated_at: published.updated_at,
    update_id: published.update_id,
    stale: published.stale ? 'true' : 'false',
  });
  return store.publish(
    published.sku,
    published.price_cents,
    published.reason,
    published.source,
    published.update_id,
  );
}

export async function publishFromDemand(
  store: PriceStore,
  cache: RedisCache,
  sku: string,
  window: number,
  reason: string,
  updateId: string,
): Promise<PublishedPrice> {
  try {
    const reply = await demand.Estimate(
      {sku, window},
      new grpc.Metadata(),
      {deadline: Date.now() + DEADLINE_MS},
    );
    return publishPrice(store, cache, {
      sku,
      price_cents: reply.price_cents,
      reason,
      source: 'demand-model',
      update_id: updateId,
      stale: false,
      updated_at: new Date().toISOString(),
    });
  } catch (error) {
    const serviceError = error as grpc.ServiceError;
    if (serviceError.code === grpc.status.FAILED_PRECONDITION) {
      throw new ConstraintRejected(serviceError.details);
    }
    if (RETRYABLE[serviceError.code] !== true) throw serviceError;
    const approved = store.last_approved(sku);
    return publishPrice(store, cache, {
      sku,
      price_cents: approved.price_cents,
      reason,
      source: 'last-approved',
      update_id: updateId,
      stale: true,
      updated_at: approved.updated_at,
    });
  }
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"strconv"
	"time"

	pb "pricing/pricingpb"
)

var lastSuggestion int64
var lastModelVersion string

// TODO: send Estimate with the 700 ms deadline, fall back to store.LastApproved(sku) on a timeout
// instead of the cached lastSuggestion, mark that republished price stale with the approved row's
// original UpdatedAt, return a FailedPrecondition constraint rejection instead of retrying it, and
// give every published price a source and a timestamp.
func PublishFromDemand(
	ctx context.Context,
	demand pb.DemandServiceClient,
	store PriceStore,
	cache RedisCache,
	sku string,
	window int64,
	reason, updateID string,
) (PublishedPrice, error) {
	for attempt := 0; attempt < 3; attempt++ {
		reply, err := demand.Estimate(ctx, &pb.EstimateRequest{Sku: sku, Window: window})
		if err == nil {
			lastSuggestion = reply.PriceCents
			lastModelVersion = reply.ModelVersion
			cache.HSet(ctx, "price:"+sku, map[string]string{
				"price_cents":   strconv.FormatInt(reply.PriceCents, 10),
				"model_version": reply.ModelVersion,
			})
			return store.Publish(sku, reply.PriceCents, reason, "demand", updateID)
		}
	}
	cache.HSet(ctx, "price:"+sku, map[string]string{
		"price_cents":   strconv.FormatInt(lastSuggestion, 10),
		"model_version": lastModelVersion,
		"updated_at":    time.Now().UTC().Format(time.RFC3339),
	})
	return store.Publish(sku, lastSuggestion, reason, "demand", updateID)
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"strconv"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "pricing/pricingpb"
)

const deadlineMS = 700

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

var errConstraintRejected = errors.New("demand model rejected the proposal")

func estimate(ctx context.Context, demand pb.DemandServiceClient, sku string, window int64) (*pb.EstimateReply, error) {
	callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
	defer cancel()
	return demand.Estimate(callCtx, &pb.EstimateRequest{Sku: sku, Window: window})
}

func publishPrice(ctx context.Context, store PriceStore, cache RedisCache, published PublishedPrice) (PublishedPrice, error) {
	if err := cache.HSet(ctx, "price:"+published.Sku, map[string]string{
		"price_cents": strconv.FormatInt(published.PriceCents, 10),
		"source":      published.Source,
		"updated_at":  published.UpdatedAt,
		"update_id":   published.UpdateID,
		"stale":       strconv.FormatBool(published.Stale),
	}); err != nil {
		return PublishedPrice{}, err
	}
	return store.Publish(published.Sku, published.PriceCents, published.Reason, published.Source, published.UpdateID)
}

func PublishFromDemand(
	ctx context.Context,
	demand pb.DemandServiceClient,
	store PriceStore,
	cache RedisCache,
	sku string,
	window int64,
	reason, updateID string,
) (PublishedPrice, error) {
	reply, err := estimate(ctx, demand, sku, window)
	if err != nil {
		switch status.Code(err) {
		case codes.FailedPrecondition:
			return PublishedPrice{}, errConstraintRejected
		case codes.Unavailable, codes.DeadlineExceeded:
			approved, err := store.LastApproved(ctx, sku)
			if err != nil {
				return PublishedPrice{}, err
			}
			return publishPrice(ctx, store, cache, PublishedPrice{
				Sku:        sku,
				PriceCents: approved.PriceCents,
				Reason:     reason,
				Source:     "last-approved",
				UpdateID:   updateID,
				Stale:      true,
				UpdatedAt:  approved.UpdatedAt,
			})
		default:
			return PublishedPrice{}, err
		}
	}
	return publishPrice(ctx, store, cache, PublishedPrice{
		Sku:        sku,
		PriceCents: reply.PriceCents,
		Reason:     reason,
		Source:     "demand-model",
		UpdateID:   updateID,
		Stale:      false,
		UpdatedAt:  time.Now().UTC().Format(time.RFC3339),
	})
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

object DemandClient {
  val stub: DemandServiceGrpc.DemandServiceBlockingStub =
    DemandServiceGrpc.blockingStub(ManagedChannelBuilder.forAddress("demand", 9000).usePlaintext().build())

  private var lastSuggestion: Int = 0
  private var lastModelVersion: String = ""

  // TODO: send estimate with the 700 ms deadline, fall back to store.lastApproved(sku) on a timeout
  // instead of the cached lastSuggestion, mark that republished price stale with the approved row's
  // original updatedAt, return a FAILED_PRECONDITION constraint rejection instead of retrying it, and
  // give every published price a source and a timestamp.
  def publishFromDemand(
      store: PriceStore,
      cache: RedisCache,
      sku: String,
      window: Long,
      reason: String,
      updateId: String,
  ): PublishedPrice = {
    var attempt = 0
    while (attempt < 3) {
      try {
        val reply = stub.estimate(EstimateRequest(sku = sku, window = window))
        lastSuggestion = reply.priceCents
        lastModelVersion = reply.modelVersion
        cache.hset("price:" + sku, Map(
          "price_cents" -> reply.priceCents.toString,
          "model_version" -> reply.modelVersion,
        ))
        return store.publish(sku, reply.priceCents, reason, "demand", updateId)
      } catch {
        case _: StatusRuntimeException => ()
      }
      attempt += 1
    }
    cache.hset("price:" + sku, Map(
      "price_cents" -> lastSuggestion.toString,
      "model_version" -> lastModelVersion,
      "updated_at" -> java.time.Instant.now().toString,
    ))
    store.publish(sku, lastSuggestion, reason, "demand", updateId)
  }
}
`,
      solution: `import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

object DemandClient {
  val DeadlineMs = 700
  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  val stub: DemandServiceGrpc.DemandServiceBlockingStub =
    DemandServiceGrpc.blockingStub(ManagedChannelBuilder.forAddress("demand", 9000).usePlaintext().build())

  class ConstraintRejected(message: String) extends RuntimeException(message)

  private def publishPrice(store: PriceStore, cache: RedisCache, published: PublishedPrice): PublishedPrice = {
    cache.hset("price:" + published.sku, Map(
      "price_cents" -> published.priceCents.toString,
      "source" -> published.source,
      "updated_at" -> published.updatedAt,
      "update_id" -> published.updateId,
      "stale" -> published.stale.toString,
    ))
    store.publish(published.sku, published.priceCents, published.reason, published.source, published.updateId)
  }

  def publishFromDemand(
      store: PriceStore,
      cache: RedisCache,
      sku: String,
      window: Long,
      reason: String,
      updateId: String,
  ): PublishedPrice =
    try {
      val reply = stub
        .withDeadlineAfter(DeadlineMs, java.util.concurrent.TimeUnit.MILLISECONDS)
        .estimate(EstimateRequest(sku = sku, window = window))
      publishPrice(store, cache, PublishedPrice(
        sku = sku,
        priceCents = reply.priceCents,
        reason = reason,
        source = "demand-model",
        updateId = updateId,
        stale = false,
        updatedAt = java.time.Instant.now().toString,
      ))
    } catch {
      case exc: StatusRuntimeException =>
        if (exc.getStatus.getCode == Status.Code.FAILED_PRECONDITION)
          throw new ConstraintRejected(exc.getStatus.getDescription)
        if (!Retryable.contains(exc.getStatus.getCode)) throw exc
        val approved = store.lastApproved(sku)
        publishPrice(store, cache, PublishedPrice(
          sku = sku,
          priceCents = approved.priceCents,
          reason = reason,
          source = "last-approved",
          updateId = updateId,
          stale = true,
          updatedAt = approved.updatedAt,
        ))
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "pricing.grpc.pb.h"

#include <chrono>
#include <ctime>
#include <string>

namespace {

int last_suggestion = 0;
std::string last_model_version;

std::string NowIso() {
  const std::time_t stamp = std::time(nullptr);
  char buffer[32];
  std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", std::gmtime(&stamp));
  return buffer;
}

}  // namespace

// TODO: send Estimate with the 700 ms deadline, fall back to store->last_approved(sku) on a timeout
// instead of the cached last_suggestion, mark that republished price stale with the approved row's
// original updated_at, return a FAILED_PRECONDITION constraint rejection instead of retrying it, and
// give every published price a source and a timestamp.
PublishedPrice publish_from_demand(
    DemandService::Stub* demand,
    PriceStore* store,
    RedisCache* cache,
    const std::string& sku,
    long window,
    const std::string& reason,
    const std::string& update_id) {
  for (int attempt = 0; attempt < 3; ++attempt) {
    grpc::ClientContext ctx;
    EstimateRequest request;
    request.set_sku(sku);
    request.set_window(window);
    EstimateReply reply;
    const grpc::Status status = demand->Estimate(&ctx, request, &reply);
    if (status.ok()) {
      last_suggestion = reply.price_cents();
      last_model_version = reply.model_version();
      cache->hset("price:" + sku, {{"price_cents", std::to_string(reply.price_cents())},
                                   {"model_version", reply.model_version()}});
      return store->publish(sku, reply.price_cents(), reason, "demand", update_id);
    }
  }
  cache->hset("price:" + sku, {{"price_cents", std::to_string(last_suggestion)},
                               {"model_version", last_model_version},
                               {"updated_at", NowIso()}});
  return store->publish(sku, last_suggestion, reason, "demand", update_id);
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "pricing.grpc.pb.h"

#include <chrono>
#include <ctime>
#include <stdexcept>
#include <string>

constexpr int kDeadlineMs = 700;

namespace {

const std::string kDemandModel = "demand-model";
const std::string kLastApproved = "last-approved";

std::string NowIso() {
  const std::time_t stamp = std::time(nullptr);
  char buffer[32];
  std::strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", std::gmtime(&stamp));
  return buffer;
}

PublishedPrice PublishPrice(
    PriceStore* store,
    RedisCache* cache,
    const PublishedPrice& published) {
  cache->hset("price:" + published.sku, {
      {"price_cents", std::to_string(published.price_cents)},
      {"source", published.source},
      {"updated_at", published.updated_at},
      {"update_id", published.update_id},
      {"stale", published.stale ? "true" : "false"},
  });
  store->publish(published.sku, published.price_cents, published.reason, published.source, published.update_id);
  return published;
}

}  // namespace

PublishedPrice publish_from_demand(
    DemandService::Stub* demand,
    PriceStore* store,
    RedisCache* cache,
    const std::string& sku,
    long window,
    const std::string& reason,
    const std::string& update_id) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
  EstimateRequest request;
  request.set_sku(sku);
  request.set_window(window);
  EstimateReply reply;
  const grpc::Status status = demand->Estimate(&ctx, request, &reply);
  if (status.error_code() == grpc::StatusCode::FAILED_PRECONDITION) {
    throw ConstraintRejected(status.error_message());
  }
  if (status.ok()) {
    PublishedPrice published;
    published.sku = sku;
    published.price_cents = reply.price_cents();
    published.reason = reason;
    published.source = kDemandModel;
    published.update_id = update_id;
    published.stale = false;
    published.updated_at = NowIso();
    return PublishPrice(store, cache, published);
  }
  const bool retryable = status.error_code() == grpc::StatusCode::UNAVAILABLE ||
                         status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
  if (!retryable) throw std::runtime_error(status.error_message());
  const auto approved = store->last_approved(sku);
  PublishedPrice published;
  published.sku = sku;
  published.price_cents = approved.price_cents;
  published.reason = reason;
  published.source = kLastApproved;
  published.update_id = update_id;
  published.stale = true;
  published.updated_at = approved.updated_at;
  return PublishPrice(store, cache, published);
}
`,
    },
  },
  debrief: `The demand model is an untrusted dependency with a deadline, and this step is the review you owe it. Three decisions separate a safe client from the draft. First, the deadline: a 700 ms budget on the call itself bounds one stuck model instead of letting it pin the pricing worker — a model that hangs is the normal failure, not the exceptional one. Second, the fallback: when the deadline fires, the honest answer is the last price the platform actually approved, republished with \`stale=true\` and the approved row's original \`updated_at\`. Serving the model's own last suggestion as if it were freshly computed is how a broken deployment freezes an experimental price into production — the number looks current, the reasoning is gone, and nobody can tell from the storefront. Third, the retryable set: \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are worth another attempt, but \`FAILED_PRECONDITION\` is the model refusing a proposal its guardrails reject — a deterministic answer that no retry can change, so retrying it only burns the deadline and hides the rejection from the operator. Provenance closes the loop: every published price names \`source\` and \`updated_at\`, so the audit trail and the storefront can distinguish a computed price from a fallback long after the incident. Real clients add jittered backoff, a per-sku single-flight so concurrent estimates share one call, and a fallback that degrades further — to the last approved price with an operator alert — when the model stays down past the window.`,
};
