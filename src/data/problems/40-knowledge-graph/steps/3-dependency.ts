import type {Step} from '@/lib/types';

export const resolutionClientStep: Step = {
  id: 'dependency',
  title: 'Entity-resolution calls that never auto-merge on timeout',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'resolver', 'review'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the entity-resolution client.
It calls the resolver, reads the response, and merges or splits. It compiles, it resolves the demo
pairs, and it hides three production flaws. Review it like the platform owner, fix it, and prove the
fix with the checks below.

Implement \`resolve_pair(tenant, left, right)\` over gRPC:

- Every attempt carries a **1-second deadline** (\`DEADLINE_S = 1\`). A resolver that misses the
  deadline is *not* evidence that two entities differ.
- \`DEADLINE_EXCEEDED\` **parks** the candidate pair in the review queue (\`review_queue.put\`) with a
  \`PARKED\` outcome. It neither auto-merges nor auto-rejects: an outage hour must not split the
  graph.
- A resolver **rejection** is **terminal** (\`TERMINAL_REJECTION\`): it is returned as
  \`rejected\` and is never retried, never upgraded to a merge. The draft retries a rejection up to
  the deadline and merges on the final attempt.
- Only a **scored match at or above \`MERGE_THRESHOLD\`** (\`score >= MERGE_THRESHOLD\`) merges
  without review (\`merge_entities\`). A match below the threshold is parked with its score.
- \`UNAVAILABLE\` is the only status worth another attempt (bounded by \`MAX_ATTEMPTS\`); anything
  else returns to the caller instead of looping.

**Failure mode the checks target.** The draft maps a timeout to *not a match*, so every hour the
resolver is slow the graph silently gains duplicate entities — a correctness bug disguised as a
performance problem. It also retries a rejection until the deadline and then merges "because we ran
out of attempts", so a pair the resolver explicitly refused becomes a merge. And it merges on any
non-rejection response without looking at the score, so weak candidates are treated as certainties.
The deadline is the one thing the draft gets right; the policy around it is what the checks target.`,
  sequence: {
    participants: ['graph-api', 'Entity resolver', 'Review queue'],
    messages: [
      {from: 'graph-api', to: 'Entity resolver', label: 'Resolve(pair) · deadline 1s', kind: 'sync'},
      {from: 'Entity resolver', to: 'graph-api', label: 'UNAVAILABLE (retryable)', kind: 'reply'},
      {from: 'graph-api', to: 'Entity resolver', label: 'Resolve(pair) · deadline 1s (attempt 2)', kind: 'sync'},
      {from: 'Entity resolver', to: 'graph-api', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'graph-api', to: 'Review queue', label: 'put(pair, PARKED)', kind: 'async'},
      {from: 'graph-api', to: 'Review queue', label: 'put(pair, PARKED, score) when below threshold', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Bounds every attempt with a 1-second deadline',
      detail:
        'Each resolve attempt carries `DEADLINE_S = 1` (a timeout context, a deadline instant, or `withDeadlineAfter`). The draft does set the deadline — keep it while you fix the policy.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*1/, /timeout=DEADLINE_S/]},
        typescript: {all: [/DEADLINE_S\s*=\s*1/, /DEADLINE_S \* 1000/]},
        go: {all: [/deadlineS\s*=\s*1/, /deadlineS\s*\*\s*time\.Second/]},
        scala: {all: [/DeadlineS\s*=\s*1/, /withDeadlineAfter\(DeadlineS/]},
        cpp: {all: [/kDeadlineSeconds\s*=\s*1/, /set_deadline\(/]},
      },
    },
    {
      id: 'timeout-parks',
      title: 'A timeout parks the pair instead of splitting it',
      detail:
        '`DEADLINE_EXCEEDED` produces a `PARKED` outcome for review — never a rejection and never a merge. The draft treats a timeout as not a match and splits the entity.',
      match: {
        python: {all: [/DEADLINE_EXCEEDED/, /PARKED/]},
        typescript: {all: [/DEADLINE_EXCEEDED/, /PARKED/]},
        go: {all: [/DeadlineExceeded/, /PARKED/]},
        scala: {all: [/DEADLINE_EXCEEDED/, /PARKED/]},
        cpp: {all: [/DEADLINE_EXCEEDED/, /PARKED/]},
      },
    },
    {
      id: 'rejection-terminal',
      title: 'A rejection is terminal and is never retried',
      detail:
        '`TERMINAL_REJECTION` returns immediately; no retry and no merge on the rejection path. The draft retries a rejection and merges on the final attempt.',
      match: {
        python: {all: [/TERMINAL_REJECTION/, /Outcome\.REJECTED/], none: [/Outcome\.REJECTED[^\n]*retry/]},
        typescript: {all: [/TERMINAL_REJECTION/], none: [/TERMINAL_REJECTION[^\n]*retry/]},
        go: {all: [/terminalRejection/, /OutcomeRejected/], none: [/OutcomeRejected[^\n]*retry/]},
        scala: {all: [/TerminalRejection/, /Outcome\.Rejected/], none: [/Outcome\.Rejected[^\n]*retry/]},
        cpp: {all: [/kTerminalRejection/, /Outcome::Rejected/], none: [/Outcome::Rejected[^\n]*retry/]},
      },
    },
    {
      id: 'threshold-merge',
      title: 'Only a scored match above the threshold merges without review',
      detail:
        'A merge requires `score >= MERGE_THRESHOLD` and goes through `merge_entities`; below the threshold the pair is parked with its score. The draft merges anything that is not a rejection.',
      match: {
        python: {all: [/MERGE_THRESHOLD/, /response\.score\s*>=/, /merge_entities\(/]},
        typescript: {all: [/MERGE_THRESHOLD/, /response\.score\s*>=/, /mergeEntities\(/]},
        go: {all: [/mergeThreshold/, /\.Score\s*>=/, /mergeEntities\(/]},
        scala: {all: [/MergeThreshold/, /\.score\s*>=/, /mergeEntities\(/]},
        cpp: {all: [/kMergeThreshold/, /score\(\)\s*>=/, /mergeEntities\(/]},
      },
    },
    {
      id: 'parked-persisted',
      title: 'The parked pair is written to the review queue',
      detail:
        'Parking means `review_queue.put(...)` with the `PARKED` outcome, so the decision outlives the request. The draft has no review queue at all.',
      match: {
        python: {all: [/review_queue\.put\(/, /PARKED/]},
        typescript: {all: [/reviewQueue\.put\(/, /PARKED/]},
        go: {all: [/reviewQueue\.Put\(/, /PARKED/]},
        scala: {all: [/reviewQueue\.put\(/, /PARKED/]},
        cpp: {all: [/reviewQueue\.put\(/, /PARKED/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
from enum import Enum

import grpc

logger = logging.getLogger("graph")

DEADLINE_S = 1
MAX_ATTEMPTS = 3


class Outcome(str, Enum):
    MERGED = "merged"
    REJECTED = "rejected"


class ResolverStub:
    def Resolve(self, request, timeout):  # noqa: N802
        raise NotImplementedError


stub = ResolverStub()


def retry_resolve(tenant: str, left: str, right: str) -> Outcome:
    raise NotImplementedError


def resolve_pair(tenant: str, left: str, right: str) -> Outcome:
    # TODO: this draft reads a timeout as not a match, retries a rejection up to the deadline and
    # merges on the final attempt, and merges without ever looking at the score. Review all three.
    for _ in range(MAX_ATTEMPTS):
        try:
            response = stub.Resolve({"tenant": tenant, "left": left, "right": right}, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
                return Outcome.REJECTED
            continue
        if response.status == "REJECTED":
            return retry_resolve(tenant, left, right)
        merge_entities(tenant, left, right)
        return Outcome.MERGED
    return Outcome.REJECTED
`,
      solution: `import logging
from enum import Enum

import grpc

logger = logging.getLogger("graph")

DEADLINE_S = 1
MERGE_THRESHOLD = 0.85
TERMINAL_REJECTION = "rejected"
MAX_ATTEMPTS = 3


class Outcome(str, Enum):
    MERGED = "merged"
    PARKED = "PARKED"
    REJECTED = "rejected"


class ResolverStub:
    def Resolve(self, request, timeout):  # noqa: N802
        raise NotImplementedError


class ReviewQueue:
    def put(self, tenant: str, left: str, right: str, outcome: str, score: float | None = None) -> None:
        raise NotImplementedError


stub = ResolverStub()
review_queue = ReviewQueue()


def resolve_pair(tenant: str, left: str, right: str) -> Outcome:
    request = {"tenant": tenant, "left": left, "right": right}
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            response = stub.Resolve(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            code = exc.code()
            if code == grpc.StatusCode.DEADLINE_EXCEEDED:
                # A slow resolver is not evidence of a mismatch: park the pair for review.
                review_queue.put(tenant, left, right, "PARKED")
                return Outcome.PARKED
            if code != grpc.StatusCode.UNAVAILABLE or attempt == MAX_ATTEMPTS:
                raise
            continue
        if response.status == TERMINAL_REJECTION:
            # Terminal: never retried, never upgraded to a merge.
            return Outcome.REJECTED
        if response.score >= MERGE_THRESHOLD:
            merge_entities(tenant, left, right, score=response.score)
            return Outcome.MERGED
        review_queue.put(tenant, left, right, "PARKED", score=response.score)
        return Outcome.PARKED
    raise RuntimeError("resolver unavailable")
`,
    },
    typescript: {
      starter: `/** Entity resolution: a model-generated draft that merges on the last attempt. */
import {status} from '@grpc/grpc-js';

import {client} from './resolver_client';
import {mergeEntities, type Outcome} from './graph';

const DEADLINE_S = 1;
const MAX_ATTEMPTS = 3;

async function retryResolve(tenant: string, left: string, right: string): Promise<Outcome> {
  throw new Error('not implemented');
}

export async function resolvePair(tenant: string, left: string, right: string): Promise<Outcome> {
  // TODO: this draft reads a timeout as not a match, retries a rejection up to the deadline and
  // merges on the final attempt, and merges without ever looking at the score. Review all three.
  const deadline = new Date(Date.now() + DEADLINE_S * 1000);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await client.resolve({tenant, left, right}, {deadline});
      if (response.status === 'REJECTED') return retryResolve(tenant, left, right);
      await mergeEntities(tenant, left, right, response.score);
      return 'merged';
    } catch (error) {
      const code = (error as {code?: number}).code;
      if (code === status.DEADLINE_EXCEEDED) return 'rejected';
      if (code !== status.UNAVAILABLE || attempt === MAX_ATTEMPTS) throw error;
    }
  }
  return 'rejected';
}
`,
      solution: `/** Entity resolution: a timeout parks, a rejection is terminal, only a scored match merges. */
import {status} from '@grpc/grpc-js';

import {client} from './resolver_client';
import {mergeEntities, reviewQueue, type Outcome} from './graph';

const DEADLINE_S = 1;
const MERGE_THRESHOLD = 0.85;
const TERMINAL_REJECTION = 'rejected';
const MAX_ATTEMPTS = 3;

export async function resolvePair(tenant: string, left: string, right: string): Promise<Outcome> {
  const deadline = new Date(Date.now() + DEADLINE_S * 1000);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await client.resolve({tenant, left, right}, {deadline});
      if (response.status === TERMINAL_REJECTION) {
        // Terminal: never retried, never upgraded to a merge.
        return 'rejected';
      }
      if (response.score >= MERGE_THRESHOLD) {
        await mergeEntities(tenant, left, right, response.score);
        return 'merged';
      }
      await reviewQueue.put(tenant, left, right, 'PARKED', response.score);
      return 'PARKED';
    } catch (error) {
      const code = (error as {code?: number}).code;
      if (code === status.DEADLINE_EXCEEDED) {
        // A slow resolver is not evidence of a mismatch: park the pair for review.
        await reviewQueue.put(tenant, left, right, 'PARKED');
        return 'PARKED';
      }
      if (code !== status.UNAVAILABLE || attempt === MAX_ATTEMPTS) throw error;
    }
  }
  throw new Error('resolver unavailable');
}
`,
    },
    go: {
      starter: `package client

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const deadlineS = 1
const maxAttempts = 3

type Outcome string

const (
	OutcomeMerged   Outcome = "merged"
	OutcomeRejected Outcome = "rejected"
)

type ResolveResponse struct {
	Status string
	Score  float64
}

type ResolverClient interface {
	Resolve(ctx context.Context, tenant, left, right string) (*ResolveResponse, error)
}

func resolvePair(ctx context.Context, client ResolverClient, tenant, left, right string) (Outcome, error) {
	// TODO: this draft reads a timeout as not a match, retries a rejection up to the deadline and
	// merges on the final attempt, and merges without ever looking at the score. Review all three.
	ctx, cancel := context.WithTimeout(ctx, deadlineS*time.Second)
	defer cancel()
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		response, err := client.Resolve(ctx, tenant, left, right)
		if err != nil {
			if status.Code(err) == codes.DeadlineExceeded {
				return OutcomeRejected, nil
			}
			continue
		}
		if response.Status == "REJECTED" {
			return resolvePair(ctx, client, tenant, left, right)
		}
		mergeEntities(tenant, left, right, response.Score)
		return OutcomeMerged, nil
	}
	return OutcomeRejected, nil
}
`,
      solution: `package client

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const deadlineS = 1
const mergeThreshold = 0.85
const terminalRejection = "rejected"
const maxAttempts = 3

type Outcome string

const (
	OutcomeMerged   Outcome = "merged"
	OutcomeParked   Outcome = "PARKED"
	OutcomeRejected Outcome = "rejected"
)

type ResolveResponse struct {
	Status string
	Score  float64
}

type ResolverClient interface {
	Resolve(ctx context.Context, tenant, left, right string) (*ResolveResponse, error)
}

func resolvePair(ctx context.Context, client ResolverClient, tenant, left, right string) (Outcome, error) {
	ctx, cancel := context.WithTimeout(ctx, deadlineS*time.Second)
	defer cancel()
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		response, err := client.Resolve(ctx, tenant, left, right)
		if err != nil {
			code := status.Code(err)
			if code == codes.DeadlineExceeded {
				// A slow resolver is not evidence of a mismatch: park the pair for review.
				reviewQueue.Put(tenant, left, right, "PARKED")
				return OutcomeParked, nil
			}
			if code != codes.Unavailable || attempt == maxAttempts {
				return "", err
			}
			continue
		}
		if response.Status == terminalRejection {
			// Terminal: never retried, never upgraded to a merge.
			return OutcomeRejected, nil
		}
		if response.Score >= mergeThreshold {
			if err := mergeEntities(tenant, left, right, response.Score); err != nil {
				return "", err
			}
			return OutcomeMerged, nil
		}
		reviewQueue.Put(tenant, left, right, "PARKED")
		return OutcomeParked, nil
	}
	return "", status.Error(codes.Unavailable, "resolver unavailable")
}
`,
    },
    scala: {
      starter: `import io.grpc.Status
import java.util.concurrent.TimeUnit
import scala.util.control.NonFatal

object ResolutionClient {
  val DeadlineS = 1
  val MaxAttempts = 3

  def resolvePair(tenant: String, left: String, right: String): String = {
    // TODO: this draft reads a timeout as not a match, retries a rejection up to the deadline and
    // merges on the final attempt, and merges without ever looking at the score. Review all three.
    val stub = ResolverGrpc.blockingStub.withDeadlineAfter(DeadlineS, TimeUnit.SECONDS)
    var attempt = 1
    while (attempt <= MaxAttempts) {
      try {
        val response = stub.resolve(ResolveRequest(tenant, left, right))
        if (response.status == "REJECTED") return resolvePair(tenant, left, right)
        mergeEntities(tenant, left, right, response.score)
        return Outcome.Merged
      } catch {
        case e: io.grpc.StatusRuntimeException =>
          if (e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED) return Outcome.Rejected
        case NonFatal(_) => ()
      }
      attempt += 1
    }
    Outcome.Rejected
  }
}
`,
      solution: `import io.grpc.Status
import java.util.concurrent.TimeUnit
import scala.util.control.NonFatal

object ResolutionClient {
  val DeadlineS = 1
  val MergeThreshold = 0.85
  val TerminalRejection = "rejected"
  val MaxAttempts = 3

  def resolvePair(tenant: String, left: String, right: String): String = {
    val stub = ResolverGrpc.blockingStub.withDeadlineAfter(DeadlineS, TimeUnit.SECONDS)
    var attempt = 1
    while (attempt <= MaxAttempts) {
      try {
        val response = stub.resolve(ResolveRequest(tenant, left, right))
        if (response.status == TerminalRejection) {
          // Terminal: never retried, never upgraded to a merge.
          return Outcome.Rejected
        }
        if (response.score >= MergeThreshold) {
          mergeEntities(tenant, left, right, response.score)
          return Outcome.Merged
        }
        reviewQueue.put(tenant, left, right, "PARKED", Some(response.score))
        return Outcome.Parked
      } catch {
        case e: io.grpc.StatusRuntimeException =>
          val code = e.getStatus.getCode
          if (code == Status.Code.DEADLINE_EXCEEDED) {
            // A slow resolver is not evidence of a mismatch: park the pair for review.
            reviewQueue.put(tenant, left, right, "PARKED", None)
            return Outcome.Parked
          }
          if (code != Status.Code.UNAVAILABLE || attempt == MaxAttempts) throw e
        case NonFatal(_) => ()
      }
      attempt += 1
    }
    throw new RuntimeException("resolver unavailable")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

constexpr int kDeadlineSeconds = 1;
constexpr int kMaxAttempts = 3;

void mergeEntities(const std::string& tenant, const std::string& left, const std::string& right, double score);

enum class Outcome { Merged, Rejected };

Outcome resolvePair(Resolver::Stub& stub, const std::string& tenant, const std::string& left,
                    const std::string& right) {
  // TODO: this draft reads a timeout as not a match, retries a rejection up to the deadline and
  // merges on the final attempt, and merges without ever looking at the score. Review all three.
  for (int attempt = 1; attempt <= kMaxAttempts; ++attempt) {
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineSeconds));
    ResolveRequest request;
    request.set_tenant(tenant);
    request.set_left(left);
    request.set_right(right);
    ResolveResponse response;
    const grpc::Status status = stub.Resolve(&context, request, &response);
    if (!status.ok()) {
      if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) return Outcome::Rejected;
      continue;
    }
    if (response.status() == "REJECTED") return resolvePair(stub, tenant, left, right);
    mergeEntities(tenant, left, right, response.score());
    return Outcome::Merged;
  }
  return Outcome::Rejected;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>

constexpr int kDeadlineSeconds = 1;
constexpr double kMergeThreshold = 0.85;
const std::string kTerminalRejection = "rejected";
constexpr int kMaxAttempts = 3;

void mergeEntities(const std::string& tenant, const std::string& left, const std::string& right, double score);

enum class Outcome { Merged, Parked, Rejected };

Outcome resolvePair(Resolver::Stub& stub, const std::string& tenant, const std::string& left,
                    const std::string& right) {
  for (int attempt = 1; attempt <= kMaxAttempts; ++attempt) {
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kDeadlineSeconds));
    ResolveRequest request;
    request.set_tenant(tenant);
    request.set_left(left);
    request.set_right(right);
    ResolveResponse response;
    const grpc::Status status = stub.Resolve(&context, request, &response);
    if (!status.ok()) {
      if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
        // A slow resolver is not evidence of a mismatch: park the pair for review.
        reviewQueue.put(tenant, left, right, "PARKED");
        return Outcome::Parked;
      }
      if (status.error_code() != grpc::StatusCode::UNAVAILABLE || attempt == kMaxAttempts)
        throw std::runtime_error("resolver unavailable");
      continue;
    }
    if (response.status() == kTerminalRejection) {
      // Terminal: never retried, never upgraded to a merge.
      return Outcome::Rejected;
    }
    if (response.score() >= kMergeThreshold) {
      mergeEntities(tenant, left, right, response.score());
      return Outcome::Merged;
    }
    reviewQueue.put(tenant, left, right, "PARKED");
    return Outcome::Parked;
  }
  throw std::runtime_error("resolver unavailable");
}
`,
    },
  },
  hints: [
    'Map the gRPC status code to a policy, not to a verdict about the pair: `DEADLINE_EXCEEDED` and `UNAVAILABLE` describe the resolver, not the entities. Only a scored response says anything about whether two nodes are the same.',
    'A rejection is an answer. Return it and stop; the retry loop exists for statuses that mean "try again", which is `UNAVAILABLE` alone, bounded by `MAX_ATTEMPTS`.',
    'Parking is a write, not a log line: `review_queue.put(...)` with the `PARKED` outcome and the score, so an operator can settle the pair later and a restart does not lose it. Below `MERGE_THRESHOLD` a positive score is still a candidate, never an automatic merge.',
  ],
  debrief: `The interviewer is testing whether you can read a failure policy instead of a status code. Three defects are checked. A timeout mapped to "not a match" is the expensive one: outages become silent data corruption, because the resolver being slow says nothing about whether the entities are the same. A retried rejection that merges on the last attempt is worse than a bug — it turns an explicit refusal into a merge. And merging on any non-rejection response treats a 0.6 score as a certainty; the threshold is what makes resolution deliberate. The deadline itself is right in the draft and worth keeping: without it a slow resolver stalls the request path. Real systems add idempotency keys on resolution calls, a review queue with an owner and an SLA, a merge audit with undo, and a circuit breaker so a sick resolver is skipped rather than retried by every caller.`,
};
