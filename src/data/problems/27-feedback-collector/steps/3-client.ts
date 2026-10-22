import type {Step} from '@/lib/types';

/**
 * Step 3 — the attribution client. A rating must remember the model, prompt and route that served
 * the request, and a slow lookup must not become a guess at the currently active model.
 */
export const clientStep: Step = {
  id: 'client',
  title: 'Attribution lookup with a safe fallback',
  concept: 'grpc',
  file: 'client',
  focus: ['collector', 'attribution', 'registry'],
  sequence: {
    participants: ['Feedback Collector', 'Attribution service', 'feedback store'],
    messages: [
      {
        from: 'Feedback Collector',
        to: 'Attribution service',
        label: 'GetAttribution(tenant, request_id) · 200 ms deadline',
        kind: 'sync',
      },
      {
        from: 'Attribution service',
        to: 'Feedback Collector',
        label: 'model_version, prompt_version, route',
        kind: 'reply',
      },
      {
        from: 'Feedback Collector',
        to: 'feedback store',
        label: 'insert the rating pinned to the served model',
        kind: 'async',
      },
      {from: 'Attribution service', to: 'Feedback Collector', label: 'deadline exceeded — no reply', kind: 'reply'},
      {
        from: 'Feedback Collector',
        to: 'Feedback Collector',
        label: 'store as unattributed, do not cache the miss',
        kind: 'sync',
      },
      {
        from: 'Attribution service',
        to: 'Feedback Collector',
        label: 'late reply — backfill the attribution only',
        kind: 'reply',
      },
    ],
  },
  task: `## Task

**Review premise.** You are the AI platform engineer on call. After a model rollout, a week of feedback
that belonged to the previous model showed up under the new one, because the attribution client fell
back to whatever model was active when the lookup was slow. A second bug hid in the same file: a failed
lookup was cached for a day, so one slow request poisoned attribution for every request that followed.

Review \`client\` and make a failed lookup honest instead of convenient.

- The lookup carries a \`200\` ms deadline. Express it as \`DEADLINE_MS = 200\` and pass it to the stub
  (\`timeout=\`, \`deadline:\`, \`withDeadlineAfter\`, \`set_deadline\` — whatever the stack calls it).
- When the lookup fails or times out, the rating is stored as \`unattributed\`. It must never be attributed
  to the currently active model, because that is how a rollout silently rewrites history.
- Failures are not cached. Only a successful reply may be cached, with a short TTL; a miss must be
  retried on the next request instead of being remembered for a day.
- A late attribution may \`backfill\` a stored rating's model, prompt and route — but it must not change
  the rating itself.

**Failure mode the checks target.** A timeout answered with "the active model" is a misattribution that
survives every audit, and a cached failure turns one slow lookup into a day of wrong attribution. The
checks below require the deadline, the honest \`unattributed\` fallback, a failure-free cache, and a
backfill that only moves attribution fields.`,
  hints: [
    'Set `DEADLINE_MS = 200` and hand it to the gRPC call. In Python the timeout is in seconds, so `timeout=DEADLINE_MS / 1000`; in Node it is `deadline: Date.now() + DEADLINE_MS`.',
    'On failure, return a fallback whose `model_version` is the literal `unattributed` — never the active model. Make the fallback a named function (`fallback_attribution`) so the check can see the honest default.',
    'Cache only successful replies, keyed by request id with a short TTL (`CACHE_TTL_SECONDS = 300`). Keep a separate `backfill(record, attribution)` that writes `model_version`, `prompt_version` and `route` and leaves `rating` untouched.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'The lookup carries a 200 ms deadline',
      detail:
        'Bound the attribution lookup with a `200` ms deadline (`DEADLINE_MS = 200`) so a slow registry cannot hold the write path open.',
      match: {
        python: {all: [/DEADLINE_MS\s*=\s*200/, /timeout\s*=\s*DEADLINE_MS\s*\/\s*1000/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*200/, /deadline\s*:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*200\s*\*\s*time\.Millisecond/, /context\.WithTimeout\(/]},
        scala: {all: [/DeadlineMs\s*=\s*200/, /withDeadlineAfter\(DeadlineMs/]},
        cpp: {all: [/kDeadlineMs\s*=\s*200/, /set_deadline\(/]},
      },
    },
    {
      id: 'unattributed',
      title: 'A failed lookup stores the rating as unattributed',
      detail:
        'When the lookup cannot answer, fall back to an `unattributed` attribution instead of the active model, so the rating stays honest about what served it.',
      match: {
        python: {all: [/UNATTRIBUTED/, /fallback_attribution\(/]},
        typescript: {all: [/UNATTRIBUTED/, /fallbackAttribution\(/]},
        go: {all: [/unattributed/, /fallbackAttribution\(/]},
        scala: {all: [/Unattributed/, /fallbackAttribution\(/]},
        cpp: {all: [/kUnattributed/, /fallbackAttribution\(/]},
      },
    },
    {
      id: 'no-failure-cache',
      title: 'Failures are not cached',
      detail:
        'Cache only successful replies, with a short TTL (`CACHE_TTL_SECONDS = 300`); a timeout or a rejected lookup must be retried, never remembered for a day.',
      match: {
        python: {all: [/CACHE_TTL_SECONDS\s*=\s*300/], none: [/CACHE_FAILURE|FAILURE_TTL/i]},
        typescript: {all: [/CACHE_TTL_SECONDS\s*=\s*300/], none: [/CACHE_FAILURE|FAILURE_TTL/i]},
        go: {all: [/cacheTtlSeconds\s*=\s*300/], none: [/cacheFailure|failureTtl/i]},
        scala: {all: [/CacheTtlSeconds\s*=\s*300/], none: [/CacheFailure|FailureTtl/]},
        cpp: {all: [/kCacheTtlSeconds\s*=\s*300/], none: [/kCacheFailure|FailureTtl/]},
      },
    },
    {
      id: 'no-active-fallback',
      title: 'Never attributes to the currently active model',
      detail:
        'The active model is not the model that served the request; the fallback must be `unattributed`, so a rollout cannot rewrite last week\u2019s feedback.',
      match: {
        python: {all: [/UNATTRIBUTED/], none: [/ACTIVE_MODEL|active_model/i]},
        typescript: {all: [/UNATTRIBUTED/], none: [/ACTIVE_MODEL|activeModel/i]},
        go: {all: [/unattributed/], none: [/ACTIVE_MODEL|activeModel|ActiveModel/i]},
        scala: {all: [/Unattributed/], none: [/ACTIVE_MODEL|ActiveModel|activeModel/]},
        cpp: {all: [/kUnattributed/], none: [/kActiveModel|ACTIVE_MODEL/]},
      },
    },
    {
      id: 'late-backfill',
      title: 'Late attribution backfills without changing the rating',
      detail:
        'A reply that arrives after the write may fill in `model_version`, `prompt_version` and `route` on the stored row, but the rating itself must never move.',
      match: {
        python: {all: [/def backfill\(/, /model_version/]},
        typescript: {all: [/function backfill\(/, /model_version/]},
        go: {all: [/func backfill\(/, /ModelVersion/]},
        scala: {all: [/def backfill\(/, /model_version/]},
        cpp: {all: [/backfill\(/, /model_version/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

import grpc

logger = logging.getLogger("feedback")

TIMEOUT_SECONDS = 1
CACHE_FAILURE_TTL = 24 * 60 * 60
ACTIVE_MODEL = "gpt-4o-current"

_failure_cache: dict[str, float] = {}


class GetAttributionRequest:
    def __init__(self, tenant: str, request_id: str) -> None:
        self.tenant = tenant
        self.request_id = request_id


class AttributionReply:
    model_version: str
    prompt_version: str
    route: str


class AttributionService:
    """The generated gRPC stub for the attribution service."""

    def GetAttribution(self, request: GetAttributionRequest, timeout: float) -> AttributionReply:
        raise NotImplementedError


attribution_service = AttributionService()


class Attribution:
    """The model, prompt and route that served one request."""

    def __init__(self, model_version: str, prompt_version: str, route: str) -> None:
        self.model_version = model_version
        self.prompt_version = prompt_version
        self.route = route


def _active_model_attribution() -> Attribution:
    return Attribution(model_version=ACTIVE_MODEL, prompt_version="current", route="default")


def attribute(tenant: str, request_id: str) -> Attribution:
    # TODO: this draft drops the rating when the lookup is slow, caches the failure for a day, and
    # falls back to whatever model is active, so a rollout rewrites last week's feedback.
    if request_id in _failure_cache and time.time() - _failure_cache[request_id] < CACHE_FAILURE_TTL:
        return _active_model_attribution()
    try:
        reply = attribution_service.GetAttribution(
            GetAttributionRequest(tenant=tenant, request_id=request_id),
            timeout=TIMEOUT_SECONDS,
        )
    except grpc.RpcError:
        _failure_cache[request_id] = time.time()
        return _active_model_attribution()
    return Attribution(reply.model_version, reply.prompt_version, reply.route)
`,
      solution: `import logging
import time

import grpc

logger = logging.getLogger("feedback")

DEADLINE_MS = 200
CACHE_TTL_SECONDS = 300
UNATTRIBUTED = "unattributed"

_cache: dict[str, tuple[float, "Attribution"]] = {}


class GetAttributionRequest:
    def __init__(self, tenant: str, request_id: str) -> None:
        self.tenant = tenant
        self.request_id = request_id


class AttributionReply:
    model_version: str
    prompt_version: str
    route: str


class AttributionService:
    """The generated gRPC stub for the attribution service."""

    def GetAttribution(self, request: GetAttributionRequest, timeout: float) -> AttributionReply:
        raise NotImplementedError


attribution_service = AttributionService()


class Attribution:
    """The model, prompt and route that served one request."""

    def __init__(self, model_version: str, prompt_version: str, route: str) -> None:
        self.model_version = model_version
        self.prompt_version = prompt_version
        self.route = route


def fallback_attribution() -> Attribution:
    """What to store when the lookup cannot answer: honest, not a guess at the model in use."""
    return Attribution(
        model_version=UNATTRIBUTED,
        prompt_version=UNATTRIBUTED,
        route=UNATTRIBUTED,
    )


def attribute(tenant: str, request_id: str) -> Attribution:
    now = time.time()
    cached = _cache.get(request_id)
    if cached is not None and now - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]
    try:
        reply = attribution_service.GetAttribution(
            GetAttributionRequest(tenant=tenant, request_id=request_id),
            timeout=DEADLINE_MS / 1000,
        )
    except grpc.RpcError:
        # A timeout is not an attribution: store the rating unattributed and never cache the miss.
        logger.info("attribution unavailable tenant=%s request=%s", tenant, request_id)
        return fallback_attribution()

    attribution = Attribution(reply.model_version, reply.prompt_version, reply.route)
    _cache[request_id] = (now, attribution)
    return attribution


def backfill(record: dict, attribution: Attribution) -> dict:
    """Attach a late attribution to a stored rating without changing the rating."""
    record["model_version"] = attribution.model_version
    record["prompt_version"] = attribution.prompt_version
    record["route"] = attribution.route
    return record
`,
    },
    typescript: {
      starter: `/** Attribution lookup for feedback. */
import * as grpc from '@grpc/grpc-js';

const TIMEOUT_SECONDS = 1;
const CACHE_FAILURE_TTL = 24 * 60 * 60;
const ACTIVE_MODEL = 'gpt-4o-current';

export interface Attribution {
  model_version: string;
  prompt_version: string;
  route: string;
}

export interface AttributionClient {
  getAttribution(
    request: {tenant: string; request_id: string},
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: Attribution) => void,
  ): void;
}

const failureCache = new Map<string, number>();

export async function attribute(
  client: AttributionClient,
  tenant: string,
  requestId: string,
): Promise<Attribution> {
  // TODO: this draft drops the rating when the lookup is slow, caches the failure for a day, and
  // falls back to whatever model is active, so a rollout rewrites last week's feedback.
  const cached = failureCache.get(requestId);
  if (cached !== undefined && Date.now() / 1000 - cached < CACHE_FAILURE_TTL) {
    return {model_version: ACTIVE_MODEL, prompt_version: 'current', route: 'default'};
  }
  const {promise, resolve} = Promise.withResolvers<Attribution>();
  client.getAttribution(
    {tenant, request_id: requestId},
    {deadline: Date.now() + TIMEOUT_SECONDS * 1000},
    error => {
      if (error !== null) {
        failureCache.set(requestId, Date.now() / 1000);
      }
      resolve({model_version: ACTIVE_MODEL, prompt_version: 'current', route: 'default'});
    },
  );
  return promise;
}
`,
      solution: `/** Attribution lookup with a safe fallback. */
import * as grpc from '@grpc/grpc-js';

const DEADLINE_MS = 200;
const CACHE_TTL_SECONDS = 300;
const UNATTRIBUTED = 'unattributed';

export interface Attribution {
  model_version: string;
  prompt_version: string;
  route: string;
}

export interface AttributionClient {
  getAttribution(
    request: {tenant: string; request_id: string},
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: Attribution) => void,
  ): void;
}

const cache = new Map<string, {cachedAt: number; attribution: Attribution}>();

export function fallbackAttribution(): Attribution {
  return {model_version: UNATTRIBUTED, prompt_version: UNATTRIBUTED, route: UNATTRIBUTED};
}

export async function attribute(
  client: AttributionClient,
  tenant: string,
  requestId: string,
): Promise<Attribution> {
  const hit = cache.get(requestId);
  if (hit !== undefined && Date.now() - hit.cachedAt < CACHE_TTL_SECONDS * 1000) {
    return hit.attribution;
  }
  const {promise, resolve} = Promise.withResolvers<Attribution>();
  client.getAttribution({tenant, request_id: requestId}, {deadline: Date.now() + DEADLINE_MS}, error => {
    if (error !== null) {
      // A timeout is not an attribution: store the rating unattributed and never cache the miss.
      resolve(fallbackAttribution());
      return;
    }
    const attribution = {
      model_version: UNATTRIBUTED,
      prompt_version: UNATTRIBUTED,
      route: UNATTRIBUTED,
    };
    cache.set(requestId, {cachedAt: Date.now(), attribution});
    resolve(attribution);
  });
  return promise;
}

export function backfill(record: Attribution & {rating: number}, attribution: Attribution): void {
  record.model_version = attribution.model_version;
  record.prompt_version = attribution.prompt_version;
  record.route = attribution.route;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"

	pb "example.com/feedback/attributionpb"
)

const (
	timeoutSeconds  = 1
	cacheFailureTtl = 24 * 60 * 60
)

const activeModel = "gpt-4o-current"

// Attribution is the model, prompt and route that served one request.
type Attribution struct {
	ModelVersion  string
	PromptVersion string
	Route         string
}

var failureCache = map[string]time.Time{}

func attribute(ctx context.Context, client pb.AttributionClient, tenant, requestID string) Attribution {
	// TODO: this draft drops the rating when the lookup is slow, caches the failure for a day, and
	// falls back to whatever model is active, so a rollout rewrites last week's feedback.
	if seenAt, ok := failureCache[requestID]; ok && time.Since(seenAt) < time.Duration(cacheFailureTtl)*time.Second {
		return Attribution{ModelVersion: activeModel, PromptVersion: "current", Route: "default"}
	}
	tctx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSeconds)*time.Second)
	defer cancel()
	reply, err := client.GetAttribution(tctx, &pb.GetAttributionRequest{Tenant: tenant, RequestId: requestID})
	if err != nil {
		failureCache[requestID] = time.Now()
		return Attribution{ModelVersion: activeModel, PromptVersion: "current", Route: "default"}
	}
	return Attribution{ModelVersion: reply.ModelVersion, PromptVersion: reply.PromptVersion, Route: reply.Route}
}

var _ = grpc.WithInsecure
`,
      solution: `package main

import (
	"context"
	"time"

	pb "example.com/feedback/attributionpb"
)

const (
	deadline        = 200 * time.Millisecond
	cacheTtlSeconds = 300
)

const unattributed = "unattributed"

// Attribution is the model, prompt and route that served one request.
type Attribution struct {
	ModelVersion  string
	PromptVersion string
	Route         string
}

type cachedAttribution struct {
	cachedAt    time.Time
	attribution Attribution
}

var cache = map[string]cachedAttribution{}

func fallbackAttribution() Attribution {
	return Attribution{ModelVersion: unattributed, PromptVersion: unattributed, Route: unattributed}
}

func attribute(ctx context.Context, client pb.AttributionClient, tenant, requestID string) Attribution {
	if hit, ok := cache[requestID]; ok && time.Since(hit.cachedAt) < time.Duration(cacheTtlSeconds)*time.Second {
		return hit.attribution
	}
	tctx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	reply, err := client.GetAttribution(tctx, &pb.GetAttributionRequest{Tenant: tenant, RequestId: requestID})
	if err != nil {
		// A timeout is not an attribution: store the rating unattributed and never cache the miss.
		return fallbackAttribution()
	}
	attribution := Attribution{ModelVersion: reply.ModelVersion, PromptVersion: reply.PromptVersion, Route: reply.Route}
	cache[requestID] = cachedAttribution{cachedAt: time.Now(), attribution: attribution}
	return attribution
}

func backfill(record *FeedbackRecord, attribution Attribution) {
	record.ModelVersion = attribution.ModelVersion
	record.PromptVersion = attribution.PromptVersion
	record.Route = attribution.Route
}
`,
    },
    scala: {
      starter: `package feedback

import scala.concurrent.Future

import io.grpc.StatusRuntimeException

final case class Attribution(model_version: String, prompt_version: String, route: String)

object AttributionLookup {
  val TimeoutSeconds = 1
  val CacheFailureTtl = 24 * 60 * 60
  val ActiveModel = "gpt-4o-current"

  private var failureCache: Map[String, Long] = Map.empty

  def attribute(tenant: String, requestId: String): Future[Attribution] = {
    // TODO: this draft drops the rating when the lookup is slow, caches the failure for a day, and
    // falls back to whatever model is active, so a rollout rewrites last week's feedback.
    val now = System.currentTimeMillis()
    failureCache.get(requestId) match {
      case Some(seenAt) if now - seenAt < CacheFailureTtl * 1000L =>
        Future.successful(Attribution(ActiveModel, "current", "default"))
      case _ =>
        try {
          val reply = stub.withDeadlineAfter(TimeoutSeconds * 1000L, java.util.concurrent.TimeUnit.MILLISECONDS)
            .getAttribution(GetAttributionRequest(tenant, requestId))
          Future.successful(Attribution(reply.model_version, reply.prompt_version, reply.route))
        } catch {
          case _: StatusRuntimeException =>
            failureCache = failureCache.updated(requestId, now)
            Future.successful(Attribution(ActiveModel, "current", "default"))
        }
    }
  }
}
`,
      solution: `package feedback

import scala.concurrent.Future

import io.grpc.StatusRuntimeException

final case class Attribution(model_version: String, prompt_version: String, route: String)

final case class FeedbackRecord(
    request_id: String,
    rating: Int,
    model_version: String,
    prompt_version: String,
    route: String,
)

object AttributionLookup {
  val DeadlineMs = 200
  val CacheTtlSeconds = 300
  val Unattributed = "unattributed"

  private var cache: Map[String, (Long, Attribution)] = Map.empty

  def fallbackAttribution(): Attribution =
    Attribution(Unattributed, Unattributed, Unattributed)

  def attribute(tenant: String, requestId: String): Future[Attribution] = {
    val now = System.currentTimeMillis()
    cache.get(requestId) match {
      case Some((cachedAt, attribution)) if now - cachedAt < CacheTtlSeconds * 1000L =>
        Future.successful(attribution)
      case _ =>
        try {
          val reply = stub
            .withDeadlineAfter(DeadlineMs, java.util.concurrent.TimeUnit.MILLISECONDS)
            .getAttribution(GetAttributionRequest(tenant, requestId))
          val attribution = Attribution(reply.model_version, reply.prompt_version, reply.route)
          cache = cache.updated(requestId, (now, attribution))
          Future.successful(attribution)
        } catch {
          case _: StatusRuntimeException =>
            // A timeout is not an attribution: store the rating unattributed and never cache it.
            Future.successful(fallbackAttribution())
        }
    }
  }

  def backfill(record: FeedbackRecord, attribution: Attribution): FeedbackRecord =
    record.copy(
      model_version = attribution.model_version,
      prompt_version = attribution.prompt_version,
      route = attribution.route,
    )
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

constexpr int kTimeoutSeconds = 1;
constexpr int kCacheFailureTtl = 24 * 60 * 60;
const char* const kActiveModel = "gpt-4o-current";

struct Attribution {
  std::string model_version;
  std::string prompt_version;
  std::string route;
};

Attribution attribute(const std::string& tenant, const std::string& requestId) {
  // TODO: this draft drops the rating when the lookup is slow, caches the failure for a day, and
  // falls back to whatever model is active, so a rollout rewrites last week's feedback.
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kTimeoutSeconds));
  GetAttributionRequest request;
  request.set_tenant(tenant);
  request.set_request_id(requestId);
  GetAttributionReply reply;
  const grpc::Status status = stub->GetAttribution(&ctx, request, &reply);
  if (!status.ok()) {
    return Attribution{kActiveModel, "current", "default"};
  }
  return Attribution{reply.model_version(), reply.prompt_version(), reply.route()};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

constexpr int kDeadlineMs = 200;
constexpr int kCacheTtlSeconds = 300;
const char* const kUnattributed = "unattributed";

struct Attribution {
  std::string model_version;
  std::string prompt_version;
  std::string route;
};

struct FeedbackRecord {
  std::string request_id;
  int rating;
  std::string model_version;
  std::string prompt_version;
  std::string route;
};

Attribution fallbackAttribution() {
  return Attribution{kUnattributed, kUnattributed, kUnattributed};
}

Attribution attribute(const std::string& tenant, const std::string& requestId) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
  GetAttributionRequest request;
  request.set_tenant(tenant);
  request.set_request_id(requestId);
  GetAttributionReply reply;
  const grpc::Status status = stub->GetAttribution(&ctx, request, &reply);
  if (!status.ok()) {
    // A timeout is not an attribution: store the rating unattributed and never cache the miss.
    return fallbackAttribution();
  }
  return Attribution{reply.model_version(), reply.prompt_version(), reply.route()};
}

void backfill(FeedbackRecord& record, const Attribution& attribution) {
  record.model_version = attribution.model_version;
  record.prompt_version = attribution.prompt_version;
  record.route = attribution.route;
}
`,
    },
  },
  debrief: `Attribution is the difference between "users disliked *this* answer" and "users disliked
something, somewhere". A timeout must not be answered with the model that happens to be active, because
the whole point of pinning feedback to a request id is that the answer stops moving when a rollout
happens. Caching the failure for a day is the second half of the same bug: one slow lookup would pin a
whole day of ratings to the wrong model.

Real systems keep the deadline short because the write path is user-facing, record an explicit
\`unattributed\` bucket so the gap is measurable, and let a background worker backfill attribution when
the registry recovers — always as a metadata update, never as a change to the rating.`,
};
