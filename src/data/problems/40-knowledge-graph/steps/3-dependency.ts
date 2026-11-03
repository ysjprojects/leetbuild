import type {Step} from '@/lib/types';

export const resolutionClientStep: Step = {
  id: 'dependency',
  title: 'Entity resolution over gRPC: a timeout parks, it does not decide',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'resolver', 'review'],
  task: `## Task

**Starting point.** The starter is \`resolve_pair(tenant, left, right)\`, which the graph runs when
two entities of a tenant look alike. It calls \`Resolver.Score\` with a 10-second deadline, up to
\`MAX_ATTEMPTS\` times: \`DEADLINE_EXCEEDED\` returns \`"rejected"\`, any other error tries again, any
answer merges \`right\` into \`left\` with \`store.merge\`, and when the attempts run out it merges
anyway. It resolves the demo pairs and hides four flaws.

**Failure mode the checks target.** A slow resolver holds every caller for ten seconds and its
timeouts split real duplicates for good; a pair the resolver refused is merged after three tries;
and a 0.6 score merges like a certainty.

\`\`\`proto
service Resolver { rpc Score(PairRequest) returns (PairScore); }  // FAILED_PRECONDITION: refused
\`\`\`

- One call with a **1-second** deadline (\`DEADLINE_S = 1\`), no retry loop.
- \`FAILED_PRECONDITION\` returns \`"rejected"\`: terminal, nothing merged, nothing parked.
- Any other error (\`DEADLINE_EXCEEDED\`, \`UNAVAILABLE\`) parks the pair with
  \`store.park(tenant, left, right, "unresolved")\` and returns \`"parked"\`.
- A score \`>= MERGE_THRESHOLD\` (0.9) merges and returns \`"merged"\`; a lower one is parked with
  reason \`"below_threshold"\` and its score.`,
  sequence: {
    participants: ['graph-api', 'Resolver', 'Graph store', 'Review queue'],
    messages: [
      {from: 'graph-api', to: 'Resolver', label: 'Score(tenant, left, right) · deadline 1 s', kind: 'sync'},
      {from: 'Resolver', to: 'graph-api', label: 'score ≥ 0.9', kind: 'reply'},
      {from: 'graph-api', to: 'Graph store', label: 'merge(left, right) → "merged"', kind: 'sync'},
      {from: 'Resolver', to: 'graph-api', label: 'score < 0.9 · DEADLINE_EXCEEDED · UNAVAILABLE', kind: 'reply'},
      {
        from: 'graph-api',
        to: 'Review queue',
        label: 'park(tenant, left, right, reason[, score]) → "parked"',
        kind: 'async',
      },
      {from: 'Resolver', to: 'graph-api', label: 'FAILED_PRECONDITION → "rejected", one call', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every Score call carries a 1-second deadline',
      detail:
        'The call is made with `DEADLINE_S` (1 s); the starter gives it ten seconds, so one stalled resolver holds the request that triggered the resolution open that long.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*1(\.0)?\b/, /Score\([\s\S]{0,200}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*1_?000\b/, /Score\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/]},
        go: {
          all: [/deadline\s*=\s*(1\s*\*\s*)?time\.Second\b/, /context\.WithTimeout\([^\n]*deadline\s*\)/],
          none: [/10\s*\*\s*time\.Second/],
        },
        scala: {
          all: [/DeadlineSeconds\s*=\s*1L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/],
          none: [/withDeadlineAfter\(\s*10/],
        },
        cpp: {all: [/kDeadline\{1\}/, /set_deadline\([^\n]*kDeadline\)/], none: [/seconds\{10\}|seconds\(10\)/]},
      },
    },
    {
      id: 'timeout-parks',
      title: 'A timeout parks the pair for review',
      detail:
        'An error other than `FAILED_PRECONDITION` parks the pair (`park`, reason `unresolved`) and merges nothing; the starter reads `DEADLINE_EXCEEDED` as a mismatch and returns `rejected`, so an outage splits real duplicates.',
      match: {
        python: {all: [/store\.park\(/], none: [/DEADLINE_EXCEEDED:\s*\n\s*return\s+["']rejected["']/]},
        typescript: {all: [/await park\(/], none: [/DEADLINE_EXCEEDED\)\s*return\s*['"]rejected['"]/]},
        go: {all: [/store\.Park\(/], none: [/codes\.DeadlineExceeded\s*\{\s*\n\s*return "rejected"/]},
        scala: {all: [/Store\.park\(/], none: [/DEADLINE_EXCEEDED\s*=>\s*return\s*"rejected"/]},
        cpp: {all: [/store::park\(/], none: [/DEADLINE_EXCEEDED\)\s*return\s*"rejected"/]},
      },
    },
    {
      id: 'rejection-terminal',
      title: 'A refused pair is rejected after one call',
      detail:
        '`FAILED_PRECONDITION` returns `rejected` without another call and without a merge; the starter retries it up to `MAX_ATTEMPTS` and then merges the pair the resolver refused.',
      match: {
        python: {all: [/FAILED_PRECONDITION/], none: [/for \w+ in range\(/, /\n\s*continue\b/]},
        typescript: {all: [/FAILED_PRECONDITION/], none: [/for \(let attempt/, /\bcontinue;/]},
        go: {all: [/codes\.FailedPrecondition/], none: [/for attempt :=/, /\bcontinue\b/]},
        scala: {all: [/FAILED_PRECONDITION/], none: [/while \(attempt/, /MaxAttempts/]},
        cpp: {all: [/FAILED_PRECONDITION/], none: [/for \(int attempt/, /\bcontinue;/]},
      },
    },
    {
      id: 'threshold-merge',
      title: 'Only a score at or above 0.9 merges',
      detail:
        'A score `>= MERGE_THRESHOLD` (0.9) merges; a lower one is parked with reason `below_threshold` and its score. The starter merges whatever the resolver answers.',
      match: {
        python: {all: [/MERGE_THRESHOLD\s*=\s*0\.9\b/, />=\s*MERGE_THRESHOLD/]},
        typescript: {all: [/MERGE_THRESHOLD\s*=\s*0\.9\b/, />=\s*MERGE_THRESHOLD/]},
        go: {all: [/mergeThreshold\s*=\s*0\.9\b/, />=\s*mergeThreshold/]},
        scala: {all: [/MergeThreshold\s*=\s*0\.9\b/, />=\s*MergeThreshold/]},
        cpp: {all: [/kMergeThreshold\s*=\s*0\.9\b/, />=\s*kMergeThreshold/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import resolver_pb2
import resolver_pb2_grpc
from graph import store  # merge, park

MAX_ATTEMPTS = 3

resolver = resolver_pb2_grpc.ResolverStub(grpc.insecure_channel("resolver:9000"))


def resolve_pair(tenant: str, left: str, right: str) -> str:
    """Ask the resolver whether right is left: "merged", "parked" (on the review queue) or "rejected"."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    for attempt in range(MAX_ATTEMPTS):
        try:
            resolver.Score(resolver_pb2.PairRequest(tenant=tenant, left=left, right=right), timeout=10)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
                return "rejected"  # no match found in time
            continue  # the resolver may answer differently next time
        store.merge(left, right)
        return "merged"
    store.merge(left, right)  # every attempt failed: the aliases already matched
    return "merged"
`,
      solution: `import grpc

import resolver_pb2
import resolver_pb2_grpc
from graph import store  # merge, park

DEADLINE_S = 1
MERGE_THRESHOLD = 0.9

resolver = resolver_pb2_grpc.ResolverStub(grpc.insecure_channel("resolver:9000"))


def resolve_pair(tenant: str, left: str, right: str) -> str:
    """Ask the resolver whether right is left: "merged", "parked" (on the review queue) or "rejected"."""
    try:
        verdict = resolver.Score(resolver_pb2.PairRequest(tenant=tenant, left=left, right=right), timeout=DEADLINE_S)
    except grpc.RpcError as exc:
        if exc.code() == grpc.StatusCode.FAILED_PRECONDITION:
            return "rejected"  # the resolver refused the pair: terminal, a retry gets the same answer
        # DEADLINE_EXCEEDED, UNAVAILABLE: no answer is not a "no". An operator decides.
        store.park(tenant, left, right, "unresolved")
        return "parked"
    if verdict.score >= MERGE_THRESHOLD:
        store.merge(left, right)
        return "merged"
    store.park(tenant, left, right, "below_threshold", verdict.score)
    return "parked"
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {merge, park} from 'graph/store';

const MAX_ATTEMPTS = 3;

interface PairRequest {
  tenant: string;
  left: string;
  right: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('resolver.proto')) as unknown as {
  graph: {Resolver: grpc.ServiceClientConstructor};
};
const resolver = new pkg.graph.Resolver('resolver:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Score(request: PairRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{score: number; model: string}>;
};

/** Ask the resolver whether right is left: "merged", "parked" (on the review queue) or "rejected". */
export async function resolvePair(tenant: string, left: string, right: string): Promise<string> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await resolver.Score({tenant, left, right}, new grpc.Metadata(), {deadline: Date.now() + 10_000});
    } catch (e) {
      if ((e as grpc.ServiceError).code === grpc.status.DEADLINE_EXCEEDED) return 'rejected'; // no match found in time
      continue; // the resolver may answer differently next time
    }
    await merge(left, right);
    return 'merged';
  }
  await merge(left, right); // every attempt failed: the aliases already matched
  return 'merged';
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {merge, park} from 'graph/store';

export const DEADLINE_MS = 1000;
export const MERGE_THRESHOLD = 0.9;

interface PairRequest {
  tenant: string;
  left: string;
  right: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('resolver.proto')) as unknown as {
  graph: {Resolver: grpc.ServiceClientConstructor};
};
const resolver = new pkg.graph.Resolver('resolver:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Score(request: PairRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{score: number; model: string}>;
};

/** Ask the resolver whether right is left: "merged", "parked" (on the review queue) or "rejected". */
export async function resolvePair(tenant: string, left: string, right: string): Promise<string> {
  let score: number;
  try {
    ({score} = await resolver.Score({tenant, left, right}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS}));
  } catch (e) {
    // The resolver refused the pair: terminal, a retry gets the same answer.
    if ((e as grpc.ServiceError).code === grpc.status.FAILED_PRECONDITION) return 'rejected';
    // DEADLINE_EXCEEDED, UNAVAILABLE: no answer is not a "no". An operator decides.
    await park(tenant, left, right, 'unresolved');
    return 'parked';
  }
  if (score >= MERGE_THRESHOLD) {
    await merge(left, right);
    return 'merged';
  }
  await park(tenant, left, right, 'below_threshold', score);
  return 'parked';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "graph/gen/resolver"
	"graph/store" // store.Merge, store.Park
)

const maxAttempts = 3

var (
	resolverConn, _ = grpc.NewClient("resolver:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	resolver        = pb.NewResolverClient(resolverConn)
)

// resolvePair asks the resolver whether right is left: "merged", "parked" (on the review queue) or "rejected".
func resolvePair(ctx context.Context, tenant, left, right string) (string, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		_, err := resolver.Score(callCtx, &pb.PairRequest{Tenant: tenant, Left: left, Right: right})
		cancel()
		if err != nil {
			if status.Code(err) == codes.DeadlineExceeded {
				return "rejected", nil // no match found in time
			}
			continue // the resolver may answer differently next time
		}
		if _, err := store.Merge(ctx, left, right); err != nil {
			return "", err
		}
		return "merged", nil
	}
	// Every attempt failed: the aliases already matched.
	if _, err := store.Merge(ctx, left, right); err != nil {
		return "", err
	}
	return "merged", nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "graph/gen/resolver"
	"graph/store" // store.Merge, store.Park
)

const (
	deadline       = time.Second
	mergeThreshold = 0.9
)

var (
	resolverConn, _ = grpc.NewClient("resolver:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	resolver        = pb.NewResolverClient(resolverConn)
)

// resolvePair asks the resolver whether right is left: "merged", "parked" (on the review queue) or "rejected".
func resolvePair(ctx context.Context, tenant, left, right string) (string, error) {
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	verdict, err := resolver.Score(callCtx, &pb.PairRequest{Tenant: tenant, Left: left, Right: right})
	if err != nil {
		if status.Code(err) == codes.FailedPrecondition {
			return "rejected", nil // the resolver refused the pair: terminal, a retry gets the same answer
		}
		// DeadlineExceeded, Unavailable: no answer is not a "no". An operator decides.
		store.Park(ctx, tenant, left, right, "unresolved", nil)
		return "parked", nil
	}
	score := verdict.GetScore()
	if score >= mergeThreshold {
		if _, err := store.Merge(ctx, left, right); err != nil {
			return "", err
		}
		return "merged", nil
	}
	store.Park(ctx, tenant, left, right, "below_threshold", &score)
	return "parked", nil
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import graph.Store // Store.merge, Store.park
import graph.resolver.{PairRequest, ResolverGrpc}

object Client {
  val MaxAttempts = 3

  private val resolver = ResolverGrpc.blockingStub(ManagedChannelBuilder.forAddress("resolver", 9000).usePlaintext().build())

  /** Ask the resolver whether right is left: "merged", "parked" (on the review queue) or "rejected". */
  def resolvePair(tenant: String, left: String, right: String): String = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    var attempt = 0
    while (attempt < MaxAttempts) {
      attempt += 1
      try {
        resolver.withDeadlineAfter(10, TimeUnit.SECONDS).score(PairRequest(tenant, left, right))
        Store.merge(left, right)
        return "merged"
      } catch {
        // No match found in time.
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED => return "rejected"
        // The resolver may answer differently next time.
        case _: StatusRuntimeException => ()
      }
    }
    Store.merge(left, right) // every attempt failed: the aliases already matched
    "merged"
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import graph.Store // Store.merge, Store.park
import graph.resolver.{PairRequest, ResolverGrpc}

object Client {
  val DeadlineSeconds = 1L
  val MergeThreshold = 0.9

  private val resolver = ResolverGrpc.blockingStub(ManagedChannelBuilder.forAddress("resolver", 9000).usePlaintext().build())

  /** Ask the resolver whether right is left: "merged", "parked" (on the review queue) or "rejected". */
  def resolvePair(tenant: String, left: String, right: String): String = {
    val verdict =
      try resolver.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).score(PairRequest(tenant, left, right))
      catch {
        // The resolver refused the pair: terminal, a retry gets the same answer.
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.FAILED_PRECONDITION => return "rejected"
        // DEADLINE_EXCEEDED, UNAVAILABLE: no answer is not a "no". An operator decides.
        case _: StatusRuntimeException =>
          Store.park(tenant, left, right, "unresolved")
          return "parked"
      }
    if (verdict.score >= MergeThreshold) {
      Store.merge(left, right)
      "merged"
    } else {
      Store.park(tenant, left, right, "below_threshold", Some(verdict.score))
      "parked"
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

#include "graph/store.h"  // store::merge, store::park
#include "resolver.grpc.pb.h"

const int kMaxAttempts = 3;

auto resolver = graph::Resolver::NewStub(grpc::CreateChannel("resolver:9000", grpc::InsecureChannelCredentials()));

// Ask the resolver whether right is left: "merged", "parked" (on the review queue) or "rejected".
std::string resolvePair(const std::string& tenant, const std::string& left, const std::string& right) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  graph::PairRequest request;
  request.set_tenant(tenant);
  request.set_left(left);
  request.set_right(right);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds{10});
    graph::PairScore verdict;
    const grpc::Status status = resolver->Score(&ctx, request, &verdict);
    if (!status.ok()) {
      if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) return "rejected";  // no match found in time
      continue;  // the resolver may answer differently next time
    }
    store::merge(left, right);
    return "merged";
  }
  store::merge(left, right);  // every attempt failed: the aliases already matched
  return "merged";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

#include "graph/store.h"  // store::merge, store::park
#include "resolver.grpc.pb.h"

constexpr std::chrono::seconds kDeadline{1};
constexpr double kMergeThreshold = 0.9;

auto resolver = graph::Resolver::NewStub(grpc::CreateChannel("resolver:9000", grpc::InsecureChannelCredentials()));

// Ask the resolver whether right is left: "merged", "parked" (on the review queue) or "rejected".
std::string resolvePair(const std::string& tenant, const std::string& left, const std::string& right) {
  graph::PairRequest request;
  request.set_tenant(tenant);
  request.set_left(left);
  request.set_right(right);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  graph::PairScore verdict;
  const grpc::Status status = resolver->Score(&ctx, request, &verdict);
  if (!status.ok()) {
    // The resolver refused the pair: terminal, a retry gets the same answer.
    if (status.error_code() == grpc::StatusCode::FAILED_PRECONDITION) return "rejected";
    // DEADLINE_EXCEEDED, UNAVAILABLE: no answer is not a "no". An operator decides.
    store::park(tenant, left, right, "unresolved");
    return "parked";
  }
  if (verdict.score() >= kMergeThreshold) {
    store::merge(left, right);
    return "merged";
  }
  store::park(tenant, left, right, "below_threshold", verdict.score());
  return "parked";
}
`,
    },
  },
  harness: {
    python: `import json

import grpc

import resolver_pb2
import resolver_pb2_grpc
from graph import store


class Resolver(resolver_pb2_grpc.ResolverServicer):
    """Scores a pair from scores (0 when unknown); refuses the pairs in refused."""

    def __init__(self):
        self.scores = {}
        self.refused = set()

    def Score(self, request, context):
        pair = (request.left, request.right)
        if pair in self.refused:
            context.abort(grpc.StatusCode.FAILED_PRECONDITION, f"do-not-merge rule for {request.left} and {request.right}")
        return resolver_pb2.PairScore(score=self.scores.get(pair, 0.0), model="er-2026-10")


def _world(ctx):
    resolver = Resolver()
    ctx.grpc.serve(resolver_pb2_grpc.add_ResolverServicer_to_server, resolver)
    m = ctx.load("client")
    left = store.create_entity("t1", "person", "Ada Lovelace", ["ada"])["id"]
    right = store.create_entity("t1", "person", "A. Lovelace", ["a. lovelace"])["id"]
    return m, resolver, left, right


def _parked(ctx):
    return [json.loads(row) for row in ctx.redis.lrange("review:t1", 0, -1)]


def _merged_into(entity_id):
    return store.get_entity(entity_id)["merged_into"]


def check_deadline(ctx):
    m, resolver, left, right = _world(ctx)
    resolver.scores[(left, right)] = 0.95
    outcome = m.resolve_pair("t1", left, right)
    assert outcome == "merged", f"a 0.95 score from a healthy resolver gave {outcome!r}, expected merged"
    calls = ctx.grpc.calls_to("Score")
    assert calls, "no Score call was made"
    for call in calls:
        assert call.timeout is not None, "a Score call carries no deadline: a stalled resolver would hold the caller forever"
        assert 0.5 <= call.timeout <= 1.5, f"a Score call carries a {call.timeout} s deadline, expected DEADLINE_S = 1: a stalled resolver holds the request that long"


def check_timeout_parks(ctx):
    m, resolver, left, right = _world(ctx)
    resolver.scores[(left, right)] = 0.95
    ctx.grpc.set_latency("Score", 5.0)
    outcome = m.resolve_pair("t1", left, right)
    assert _merged_into(right) is None, f"a resolver slower than the 1-second deadline still produced a merge ({right} into {_merged_into(right)}): a timeout decides nothing"
    assert outcome == "parked", f"a resolver that timed out gave {outcome!r}: no answer is not a mismatch, park the pair for review"
    rows = _parked(ctx)
    assert len(rows) == 1 and rows[0].get("left") == left and rows[0].get("right") == right and rows[0].get("reason") == "unresolved", f"the review queue holds {rows}, expected the pair with reason unresolved"


def check_rejection_terminal(ctx):
    m, resolver, left, right = _world(ctx)
    resolver.refused.add((left, right))
    outcome = m.resolve_pair("t1", left, right)
    assert _merged_into(right) is None, f"a pair the resolver refused was merged ({right} into {_merged_into(right)}): FAILED_PRECONDITION is terminal"
    calls = len(ctx.grpc.calls_to("Score"))
    assert calls == 1, f"a refused pair was sent to the resolver {calls} times: the refusal will not change on a retry"
    assert outcome == "rejected", f"a refused pair gave {outcome!r}, expected rejected"
    assert _parked(ctx) == [], f"a rejected pair is settled, yet the review queue holds {_parked(ctx)}"


def check_threshold_merge(ctx):
    m, resolver, left, right = _world(ctx)
    resolver.scores[(left, right)] = 0.6
    outcome = m.resolve_pair("t1", left, right)
    assert _merged_into(right) is None, f"a 0.6 score merged {right} into {_merged_into(right)}: below MERGE_THRESHOLD (0.9) a pair goes to review"
    assert outcome == "parked", f"a 0.6 score gave {outcome!r}, expected parked"
    rows = _parked(ctx)
    assert len(rows) == 1 and rows[0].get("reason") == "below_threshold" and rows[0].get("score") == 0.6, f"the review queue holds {rows}, expected the pair with reason below_threshold and score 0.6"
    resolver.scores[(left, right)] = 0.95
    outcome = m.resolve_pair("t1", left, right)
    assert outcome == "merged" and _merged_into(right) == left, f"a 0.95 score gave {outcome!r} and {right} is merged into {_merged_into(right)}, expected a merge into {left}"
    assert "a. lovelace" in store.get_entity(left)["aliases"], f"the merge must move the aliases to {left}: {store.get_entity(left)}"
`,
    typescript: `async function world(ctx) {
  const pkg = ctx.proto('resolver.proto');
  const scores = new Map<string, number>();
  const refused = new Set<string>();
  ctx.grpc.serve(pkg.graph.Resolver.service, {
    Score(call, callback) {
      const {left, right} = call.request;
      if (refused.has(\`\${left}/\${right}\`)) return callback({code: ctx.grpc.status.FAILED_PRECONDITION, details: \`do-not-merge rule for \${left} and \${right}\`});
      callback(null, {score: scores.get(\`\${left}/\${right}\`) ?? 0, model: 'er-2026-10'});
    },
  });
  const m = ctx.load('client');
  const store = ctx.load('/support/graph/store.ts');
  const left = (await store.createEntity('t1', 'person', 'Ada Lovelace', ['ada'])).id;
  const right = (await store.createEntity('t1', 'person', 'A. Lovelace', ['a. lovelace'])).id;
  return {m, store, scores, refused, left, right, pair: \`\${left}/\${right}\`};
}

const parked = ctx => (ctx.redis.lrange('review:t1', 0, -1) as string[]).map(row => JSON.parse(row));

export async function check_deadline(ctx) {
  const {m, scores, left, right, pair} = await world(ctx);
  scores.set(pair, 0.95);
  const outcome = await m.resolvePair('t1', left, right);
  assert.equal(outcome, 'merged', \`a 0.95 score from a healthy resolver gave \${outcome}, expected merged\`);
  const calls = ctx.grpc.callsTo('Score');
  assert(calls.length > 0, 'no Score call was made');
  for (const call of calls) {
    assert(call.timeout !== null, 'a Score call carries no deadline: a stalled resolver would hold the caller forever');
    assert(0.5 <= call.timeout && call.timeout <= 1.5, \`a Score call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 1000: a stalled resolver holds the request that long\`);
  }
}

export async function check_timeout_parks(ctx) {
  const {m, store, scores, left, right, pair} = await world(ctx);
  scores.set(pair, 0.95);
  ctx.grpc.setLatency('Score', 5.0);
  const outcome = await m.resolvePair('t1', left, right);
  const into = (await store.getEntity(right)).merged_into;
  assert.equal(into, null, \`a resolver slower than the 1-second deadline still produced a merge (\${right} into \${into}): a timeout decides nothing\`);
  assert.equal(outcome, 'parked', \`a resolver that timed out gave \${outcome}: no answer is not a mismatch, park the pair for review\`);
  const rows = parked(ctx);
  assert(rows.length === 1 && rows[0].left === left && rows[0].right === right && rows[0].reason === 'unresolved', \`the review queue holds \${JSON.stringify(rows)}, expected the pair with reason unresolved\`);
}

export async function check_rejection_terminal(ctx) {
  const {m, store, refused, left, right, pair} = await world(ctx);
  refused.add(pair);
  const outcome = await m.resolvePair('t1', left, right);
  const into = (await store.getEntity(right)).merged_into;
  assert.equal(into, null, \`a pair the resolver refused was merged (\${right} into \${into}): FAILED_PRECONDITION is terminal\`);
  const calls = ctx.grpc.callsTo('Score').length;
  assert.equal(calls, 1, \`a refused pair was sent to the resolver \${calls} times: the refusal will not change on a retry\`);
  assert.equal(outcome, 'rejected', \`a refused pair gave \${outcome}, expected rejected\`);
  assert.deepEqual(parked(ctx), [], \`a rejected pair is settled, yet the review queue holds \${JSON.stringify(parked(ctx))}\`);
}

export async function check_threshold_merge(ctx) {
  const {m, store, scores, left, right, pair} = await world(ctx);
  scores.set(pair, 0.6);
  let outcome = await m.resolvePair('t1', left, right);
  let into = (await store.getEntity(right)).merged_into;
  assert.equal(into, null, \`a 0.6 score merged \${right} into \${into}: below MERGE_THRESHOLD (0.9) a pair goes to review\`);
  assert.equal(outcome, 'parked', \`a 0.6 score gave \${outcome}, expected parked\`);
  const rows = parked(ctx);
  assert(rows.length === 1 && rows[0].reason === 'below_threshold' && rows[0].score === 0.6, \`the review queue holds \${JSON.stringify(rows)}, expected the pair with reason below_threshold and score 0.6\`);
  scores.set(pair, 0.95);
  outcome = await m.resolvePair('t1', left, right);
  into = (await store.getEntity(right)).merged_into;
  assert(outcome === 'merged' && into === left, \`a 0.95 score gave \${outcome} and \${right} is merged into \${into}, expected a merge into \${left}\`);
  assert((await store.getEntity(left)).aliases.includes('a. lovelace'), \`the merge must move the aliases to \${left}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "graph/gen/resolver"
	"graph/store"

	"leetbuild/harness"
)

var clientBg = context.Background()

// resolverPeer scores a pair from scores (0 when unknown) and refuses the pairs in refused ("left/right").
type resolverPeer struct {
	pb.UnimplementedResolverServer
	scores  map[string]float64
	refused map[string]bool
}

func (p *resolverPeer) Score(_ context.Context, req *pb.PairRequest) (*pb.PairScore, error) {
	pair := req.GetLeft() + "/" + req.GetRight()
	if p.refused[pair] {
		return nil, status.Errorf(codes.FailedPrecondition, "do-not-merge rule for %s and %s", req.GetLeft(), req.GetRight())
	}
	return &pb.PairScore{Score: p.scores[pair], Model: "er-2026-10"}, nil
}

type parkedRow struct {
	Left   string   \`json:"left"\`
	Right  string   \`json:"right"\`
	Reason string   \`json:"reason"\`
	Score  *float64 \`json:"score"\`
}

func clientWorld(ctx *harness.Ctx) (*resolverPeer, string, string) {
	peer := &resolverPeer{scores: map[string]float64{}, refused: map[string]bool{}}
	pb.RegisterResolverServer(ctx.GRPC.Server(""), peer)
	left := store.CreateEntity(clientBg, "t1", "person", "Ada Lovelace", []string{"ada"}).ID
	right := store.CreateEntity(clientBg, "t1", "person", "A. Lovelace", []string{"a. lovelace"}).ID
	return peer, left, right
}

func clientResolve(ctx *harness.Ctx, left, right string) string {
	outcome, err := resolvePair(clientBg, "t1", left, right)
	ctx.NoError(err, "resolvePair(t1, %s, %s) failed", left, right)
	return outcome
}

func clientParked(ctx *harness.Ctx) []parkedRow {
	rows := []parkedRow{}
	for _, text := range ctx.Redis.LRange("review:t1", 0, -1) {
		row := parkedRow{}
		ctx.NoError(json.Unmarshal([]byte(text), &row), "a review row must be JSON")
		rows = append(rows, row)
	}
	return rows
}

func mergedInto(entityID string) string { return store.GetEntity(clientBg, entityID).MergedInto }

func CheckDeadline(ctx *harness.Ctx) {
	peer, left, right := clientWorld(ctx)
	peer.scores[left+"/"+right] = 0.95
	ctx.Equal(clientResolve(ctx, left, right), "merged", "a 0.95 score from a healthy resolver")
	calls := ctx.GRPC.CallsTo("Score", "")
	ctx.Assert(len(calls) > 0, "no Score call was made")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "a Score call carries no deadline: a stalled resolver would hold the caller forever")
		ctx.Assert(500*time.Millisecond <= call.Timeout && call.Timeout <= 1500*time.Millisecond, "a Score call carries a %v deadline, expected 1 s: a stalled resolver holds the request that long", call.Timeout)
	}
}

func CheckTimeoutParks(ctx *harness.Ctx) {
	peer, left, right := clientWorld(ctx)
	peer.scores[left+"/"+right] = 0.95
	ctx.GRPC.SetLatency("Score", 5.0, "")
	outcome := clientResolve(ctx, left, right)
	ctx.Assert(mergedInto(right) == "", "a resolver slower than the 1-second deadline still produced a merge (%s into %s): a timeout decides nothing", right, mergedInto(right))
	ctx.Equal(outcome, "parked", "a resolver that timed out must park the pair (no answer is not a mismatch); the outcome")
	rows := clientParked(ctx)
	ctx.Assert(len(rows) == 1 && rows[0].Left == left && rows[0].Right == right && rows[0].Reason == "unresolved", "the review queue holds %+v, expected the pair with reason unresolved", rows)
}

func CheckRejectionTerminal(ctx *harness.Ctx) {
	peer, left, right := clientWorld(ctx)
	peer.refused[left+"/"+right] = true
	outcome := clientResolve(ctx, left, right)
	ctx.Assert(mergedInto(right) == "", "a pair the resolver refused was merged (%s into %s): FAILED_PRECONDITION is terminal", right, mergedInto(right))
	ctx.Equal(len(ctx.GRPC.CallsTo("Score", "")), 1, "a refused pair must be sent to the resolver once (the refusal will not change on a retry); the calls")
	ctx.Equal(outcome, "rejected", "a refused pair; the outcome")
	ctx.Equal(len(clientParked(ctx)), 0, "a rejected pair is settled; the review queue rows")
}

func CheckThresholdMerge(ctx *harness.Ctx) {
	peer, left, right := clientWorld(ctx)
	peer.scores[left+"/"+right] = 0.6
	outcome := clientResolve(ctx, left, right)
	ctx.Assert(mergedInto(right) == "", "a 0.6 score merged %s into %s: below the 0.9 threshold a pair goes to review", right, mergedInto(right))
	ctx.Equal(outcome, "parked", "a 0.6 score; the outcome")
	rows := clientParked(ctx)
	ctx.Assert(len(rows) == 1 && rows[0].Reason == "below_threshold" && rows[0].Score != nil && *rows[0].Score == 0.6, "the review queue holds %+v, expected the pair with reason below_threshold and score 0.6", rows)
	peer.scores[left+"/"+right] = 0.95
	outcome = clientResolve(ctx, left, right)
	ctx.Assert(outcome == "merged" && mergedInto(right) == left, "a 0.95 score gave %q and %s is merged into %q, expected a merge into %s", outcome, right, mergedInto(right), left)
	ctx.Assert(len(store.GetEntity(clientBg, left).Aliases) == 2, "the merge must move the aliases to %s: %+v", left, store.GetEntity(clientBg, left))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <set>
#include <string>
#include <vector>

namespace {

// Scores a pair from scores (0 when unknown); refuses the pairs in refused ("left/right").
class ResolverPeer final : public graph::Resolver::Service {
 public:
  std::map<std::string, double> scores;
  std::set<std::string> refused;
  grpc::Status Score(grpc::ServerContext*, const graph::PairRequest* req, graph::PairScore* out) override {
    const std::string pair = req->left() + "/" + req->right();
    if (refused.count(pair)) return grpc::Status(grpc::StatusCode::FAILED_PRECONDITION, "do-not-merge rule for " + req->left() + " and " + req->right());
    out->set_score(scores.count(pair) ? scores[pair] : 0.0);
    out->set_model("er-2026-10");
    return grpc::Status::OK;
  }
};

struct World {
  ResolverPeer& peer;
  std::string left;
  std::string right;
  std::string pair() const { return left + "/" + right; }
};

World clientWorld(harness::Ctx& ctx) {
  static ResolverPeer* peer = nullptr;
  delete peer;
  peer = new ResolverPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  const std::string left = store::createEntity("t1", "person", "Ada Lovelace", {"ada"}).id;
  const std::string right = store::createEntity("t1", "person", "A. Lovelace", {"a. lovelace"}).id;
  return World{*peer, left, right};
}

std::vector<nlohmann::json> clientParked(harness::Ctx& ctx) {
  std::vector<nlohmann::json> rows;
  for (const auto& text : ctx.Redis.LRange("review:t1", 0, -1)) rows.push_back(nlohmann::json::parse(text, nullptr, false));
  return rows;
}

std::string mergedInto(const std::string& entity_id) { return store::getEntity(entity_id)->merged_into; }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  World w = clientWorld(ctx);
  w.peer.scores[w.pair()] = 0.95;
  ctx.Equal(resolvePair("t1", w.left, w.right), "merged", "a 0.95 score from a healthy resolver");
  const auto calls = ctx.GRPC.CallsTo("Score");
  ctx.Assert(!calls.empty(), "no Score call was made");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "a Score call carries no deadline: a stalled resolver would hold the caller forever");
    ctx.Assert(0.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 1.5, "a Score call carries a %v s deadline, expected kDeadline = 1 s: a stalled resolver holds the request that long", call.TimeoutSeconds());
  }
}

void CheckTimeoutParks(harness::Ctx& ctx) {
  World w = clientWorld(ctx);
  w.peer.scores[w.pair()] = 0.95;
  ctx.GRPC.SetLatency("Score", 5.0);
  const std::string outcome = resolvePair("t1", w.left, w.right);
  ctx.Assert(mergedInto(w.right).empty(), "a resolver slower than the 1-second deadline still produced a merge (%s into %s): a timeout decides nothing", w.right, mergedInto(w.right));
  ctx.Equal(outcome, "parked", "a resolver that timed out must park the pair (no answer is not a mismatch); the outcome");
  const auto rows = clientParked(ctx);
  ctx.Assert(rows.size() == 1 && rows[0].value("left", "") == w.left && rows[0].value("right", "") == w.right && rows[0].value("reason", "") == "unresolved",
             "the review queue holds %d rows (%s), expected the pair with reason unresolved", rows.size(), rows.empty() ? "" : rows[0].dump());
}

void CheckRejectionTerminal(harness::Ctx& ctx) {
  World w = clientWorld(ctx);
  w.peer.refused.insert(w.pair());
  const std::string outcome = resolvePair("t1", w.left, w.right);
  ctx.Assert(mergedInto(w.right).empty(), "a pair the resolver refused was merged (%s into %s): FAILED_PRECONDITION is terminal", w.right, mergedInto(w.right));
  ctx.Equal(ctx.GRPC.CallsTo("Score").size(), 1, "a refused pair must be sent to the resolver once (the refusal will not change on a retry); the calls");
  ctx.Equal(outcome, "rejected", "a refused pair; the outcome");
  ctx.Equal(clientParked(ctx).size(), 0, "a rejected pair is settled; the review queue rows");
}

void CheckThresholdMerge(harness::Ctx& ctx) {
  World w = clientWorld(ctx);
  w.peer.scores[w.pair()] = 0.6;
  std::string outcome = resolvePair("t1", w.left, w.right);
  ctx.Assert(mergedInto(w.right).empty(), "a 0.6 score merged %s into %s: below kMergeThreshold (0.9) a pair goes to review", w.right, mergedInto(w.right));
  ctx.Equal(outcome, "parked", "a 0.6 score; the outcome");
  const auto rows = clientParked(ctx);
  ctx.Assert(rows.size() == 1 && rows[0].value("reason", "") == "below_threshold" && rows[0].contains("score") && rows[0]["score"].is_number() && rows[0]["score"].get<double>() == 0.6,
             "the review queue holds %d rows (%s), expected the pair with reason below_threshold and score 0.6", rows.size(), rows.empty() ? "" : rows[0].dump());
  w.peer.scores[w.pair()] = 0.95;
  outcome = resolvePair("t1", w.left, w.right);
  ctx.Assert(outcome == "merged" && mergedInto(w.right) == w.left, "a 0.95 score gave %q and %s is merged into %q, expected a merge into %s", outcome, w.right, mergedInto(w.right), w.left);
  ctx.Equal(store::getEntity(w.left)->aliases.size(), 2, "the merge must move the aliases to %s; its alias count", w.left);
}
`,
  },
  hints: [
    'Slow the resolver down for a minute: duplicate people stay apart for good. Refuse a pair: three calls later it is merged anyway. Score a pair 0.6: it is merged too.',
    'The status code is the only thing that tells "no" from "no answer": `DEADLINE_EXCEEDED` says nothing about the pair, `FAILED_PRECONDITION` is a decision. The loop and the unconditional merge ignore that, and the score is never read.',
    'One `Score` call with `timeout=DEADLINE_S`; `FAILED_PRECONDITION` → `"rejected"`; any other error → `store.park(..., "unresolved")`; `score >= MERGE_THRESHOLD` → `store.merge`, else `store.park(..., "below_threshold", score)`.',
  ],
  debrief: `A resolver has three answers and the client's job is to keep them apart: yes (a high score), no (a refusal), and nothing (a deadline or an outage). Only yes changes the graph, because a merge is the one outcome that is expensive to undo; no is final; nothing goes to a queue a person works through. The short deadline is affordable for the same reason: a timeout costs a review-queue row, never a wrong merge. Resolution services in production record the model version and the evidence behind each score with the parked pair, and replay the queue automatically once the resolver is healthy again, so most parked pairs settle without a person.`,
};
