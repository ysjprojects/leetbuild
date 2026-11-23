import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Auto-resolve: a granted safe class, a deadline, a person when in doubt',
  concept: 'grpc',
  guides: ['failing-dependencies', 'model-output', 'deadlines-and-retries'],
  file: 'client',
  focus: ['queue', 'enforcement', 'items'],
  task: `## Task

**Starting point.** The starter is the queue's auto-resolve: \`try_auto_resolve(item_id, category,
confidence)\` answers \`human_review\` below \`CONFIDENCE_THRESHOLD\` (0.5); otherwise it asks the
enforcement service for a grant, with no deadline, up to three times, and on a grant records
\`store.resolve(item_id, "auto_resolved", grant_id)\`. After three failures it resolves the item
anyway with the grant \`fallback\`. With enforcement healthy a spam duplicate clears; it hides 4
flaws.

**Failure mode the checks target.** A self-harm report at 0.97 confidence clears without a person;
an enforcement outage during a spam wave holds every call open, then clears everything with
\`fallback\`; and a category the policy refused is asked three times.

\`\`\`proto
service Enforcement { rpc AutoResolve(AutoResolveRequest) returns (Grant); }  // PERMISSION_DENIED: refused
\`\`\`

- Only \`SAFE_CATEGORIES\` (\`spam_duplicate\`, \`known_safe_false_positive\`) at or above the
  threshold may auto-resolve; anything else is \`human_review\` with no call.
- The call carries a **\`DEADLINE_S\` = 1 s** deadline.
- No grant, no auto-resolve: \`PERMISSION_DENIED\` is \`store.escalate(item_id, "policy_denied")\`, any
  other failure \`store.escalate(item_id, "enforcement_unavailable")\`; both answer \`escalated\`, after
  one call.`,
  sequence: {
    participants: ['Review Queue', 'Enforcement', 'Review store'],
    messages: [
      {from: 'Review Queue', to: 'Review Queue', label: 'category in SAFE_CATEGORIES?', kind: 'sync'},
      {from: 'Review Queue', to: 'Enforcement', label: 'AutoResolve · deadline 1 s', kind: 'sync'},
      {from: 'Enforcement', to: 'Review Queue', label: 'Grant · PERMISSION_DENIED · DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Review Queue', to: 'Review store', label: 'resolve(grant_id) · escalate(reason)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'grant',
      title: 'A granted auto-resolve records its grant',
      detail:
        "A safe category with a grant is resolved as `auto_resolved` with the enforcement service's `grant_id` recorded on the item.",
      match: {
        python: {all: [/store\.resolve\(/, /grant_id/]},
        typescript: {all: [/resolve\(/, /grant_id/]},
        go: {all: [/store\.Resolve\(/, /GetGrantId\(\)/]},
        cpp: {all: [/store::resolve\(/, /grant_id\(\)/]},
      },
    },
    {
      id: 'safe-class',
      title: 'Only the safe categories auto-resolve',
      detail:
        'Auto-resolve is gated on `SAFE_CATEGORIES` (`spam_duplicate`, `known_safe_false_positive`) as well as the threshold (a confidence of exactly 0.5 qualifies); any other category, or a confidence under the threshold, is `human_review` and the enforcement service is not called. The starter gates on confidence alone.',
      match: {
        python: {all: [/SAFE_CATEGORIES\s*=/, /category (not )?in SAFE_CATEGORIES/]},
        typescript: {all: [/SAFE_CATEGORIES\s*[:=]/, /SAFE_CATEGORIES,\s*category\)|SAFE_CATEGORIES\[category\]/]},
        go: {all: [/safeCategories\s*=/, /safeCategories\[category\]/]},
        cpp: {all: [/kSafeCategories\s*=/, /kSafeCategories\.(count|find|contains)\(category\)/]},
      },
    },
    {
      id: 'deadline',
      title: 'The enforcement call carries a 1-second deadline',
      detail:
        'AutoResolve is called with `DEADLINE_S` (1 s), so a stalled enforcement service costs a second and an escalation; the starter waits as long as the service takes.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*1(\.0)?\b/, /AutoResolve\([\s\S]{0,120}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*1000\b/, /AutoResolve\([\s\S]{0,200}?deadline:[^\n]*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*(1\s*\*\s*)?time\.Second\b/, /context\.WithTimeout\([^\n]*deadline\)/]},
        cpp: {all: [/kDeadline\{1\}|kDeadline\(1\)/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'fail-closed',
      title: 'No grant sends the item to a person',
      detail:
        'A failed or timed-out call, whatever its status other than `PERMISSION_DENIED`, escalates the item (`escalate`, reason `enforcement_unavailable`) after one call and answers `escalated`; the starter resolves it anyway with a `fallback` grant.',
      match: {
        python: {all: [/store\.escalate\(/, /enforcement_unavailable/], none: [/["']fallback["']/]},
        typescript: {all: [/escalate\(/, /enforcement_unavailable/], none: [/['"]fallback['"]/]},
        go: {all: [/store\.Escalate\(/, /enforcement_unavailable/], none: [/"fallback"/]},
        cpp: {all: [/store::escalate\(/, /enforcement_unavailable/], none: [/"fallback"/]},
      },
    },
    {
      id: 'rejection-terminal',
      title: 'A policy refusal is final',
      detail:
        '`PERMISSION_DENIED` escalates with reason `policy_denied` after one call; the starter retries every error three times, asking again about a category the policy already refused.',
      match: {
        python: {all: [/PERMISSION_DENIED/, /policy_denied/], none: [/for attempt in|while True/]},
        typescript: {all: [/PERMISSION_DENIED/, /policy_denied/], none: [/for \(let attempt|while \(true\)/]},
        go: {all: [/codes\.PermissionDenied/, /policy_denied/], none: [/for attempt :=/]},
        cpp: {all: [/PERMISSION_DENIED/, /policy_denied/], none: [/for \(int attempt/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import reviewq_pb2
import reviewq_pb2_grpc
from review import store  # get_item, resolve, escalate

CONFIDENCE_THRESHOLD = 0.5

enforcement = reviewq_pb2_grpc.EnforcementStub(grpc.insecure_channel("enforcement:9000"))


def try_auto_resolve(item_id: str, category: str, confidence: float) -> str:
    """Clear the item without a reviewer when enforcement grants it: auto_resolved, escalated or human_review."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    if confidence < CONFIDENCE_THRESHOLD:
        return "human_review"
    item = store.get_item(item_id)
    request = reviewq_pb2.AutoResolveRequest(tenant=item["tenant"], item_id=item_id, category=category)
    for attempt in range(3):
        try:
            grant = enforcement.AutoResolve(request)
            store.resolve(item_id, "auto_resolved", grant.grant_id)
            return "auto_resolved"
        except grpc.RpcError:
            continue  # enforcement is flaky: try again
    store.resolve(item_id, "auto_resolved", "fallback")  # the model was confident: clear it anyway
    return "auto_resolved"
`,
      solution: `import grpc

import reviewq_pb2
import reviewq_pb2_grpc
from review import store  # get_item, resolve, escalate

CONFIDENCE_THRESHOLD = 0.5
DEADLINE_S = 1.0
# The only categories the queue may clear without a person, and only with a grant.
SAFE_CATEGORIES = {"spam_duplicate", "known_safe_false_positive"}

enforcement = reviewq_pb2_grpc.EnforcementStub(grpc.insecure_channel("enforcement:9000"))


def try_auto_resolve(item_id: str, category: str, confidence: float) -> str:
    """Clear the item without a reviewer when enforcement grants it: auto_resolved, escalated or human_review."""
    if category not in SAFE_CATEGORIES or confidence < CONFIDENCE_THRESHOLD:
        return "human_review"
    item = store.get_item(item_id)
    request = reviewq_pb2.AutoResolveRequest(tenant=item["tenant"], item_id=item_id, category=category)
    try:
        grant = enforcement.AutoResolve(request, timeout=DEADLINE_S)
    except grpc.RpcError as exc:
        # No grant, no auto-resolve: a refusal is final, an outage or a timeout is a person's call.
        reason = "policy_denied" if exc.code() == grpc.StatusCode.PERMISSION_DENIED else "enforcement_unavailable"
        store.escalate(item_id, reason)
        return "escalated"
    store.resolve(item_id, "auto_resolved", grant.grant_id)
    return "auto_resolved"
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {escalate, getItem, resolve} from 'review/store';

export const CONFIDENCE_THRESHOLD = 0.5;

interface AutoResolveRequest {
  tenant: string;
  item_id: string;
  category: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('reviewq.proto')) as unknown as {
  reviewq: {Enforcement: grpc.ServiceClientConstructor};
};
const enforcement = new pkg.reviewq.Enforcement('enforcement:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  AutoResolve(request: AutoResolveRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{grant_id: string}>;
};

/** Clear the item without a reviewer when enforcement grants it: auto_resolved, escalated or human_review. */
export async function tryAutoResolve(itemId: string, category: string, confidence: number): Promise<string> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  if (confidence < CONFIDENCE_THRESHOLD) return 'human_review';
  const item = await getItem(itemId);
  if (item === null) throw new Error(\`no item \${itemId}\`);
  const request = {tenant: item.tenant, item_id: itemId, category};
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const grant = await enforcement.AutoResolve(request, new grpc.Metadata(), {});
      await resolve(itemId, 'auto_resolved', grant.grant_id);
      return 'auto_resolved';
    } catch {
      // enforcement is flaky: try again
    }
  }
  await resolve(itemId, 'auto_resolved', 'fallback'); // the model was confident: clear it anyway
  return 'auto_resolved';
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {escalate, getItem, resolve} from 'review/store';

export const CONFIDENCE_THRESHOLD = 0.5;
export const DEADLINE_MS = 1000;
/** The only categories the queue may clear without a person, and only with a grant. */
export const SAFE_CATEGORIES: Record<string, true> = {spam_duplicate: true, known_safe_false_positive: true};

interface AutoResolveRequest {
  tenant: string;
  item_id: string;
  category: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('reviewq.proto')) as unknown as {
  reviewq: {Enforcement: grpc.ServiceClientConstructor};
};
const enforcement = new pkg.reviewq.Enforcement('enforcement:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  AutoResolve(request: AutoResolveRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{grant_id: string}>;
};

/** Clear the item without a reviewer when enforcement grants it: auto_resolved, escalated or human_review. */
export async function tryAutoResolve(itemId: string, category: string, confidence: number): Promise<string> {
  if (!Object.hasOwn(SAFE_CATEGORIES, category) || confidence < CONFIDENCE_THRESHOLD) return 'human_review';
  const item = await getItem(itemId);
  if (item === null) throw new Error(\`no item \${itemId}\`);
  const request = {tenant: item.tenant, item_id: itemId, category};
  let grant: {grant_id: string};
  try {
    grant = await enforcement.AutoResolve(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
  } catch (e) {
    // No grant, no auto-resolve: a refusal is final, an outage or a timeout is a person's call.
    const {code} = e as grpc.ServiceError;
    await escalate(itemId, code === grpc.status.PERMISSION_DENIED ? 'policy_denied' : 'enforcement_unavailable');
    return 'escalated';
  }
  await resolve(itemId, 'auto_resolved', grant.grant_id);
  return 'auto_resolved';
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "review/gen/reviewq"
	"review/store" // store.GetItem, Resolve, Escalate
)

const confidenceThreshold = 0.5

var (
	enforcementConn, _ = grpc.NewClient("enforcement:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	enforcement        = pb.NewEnforcementClient(enforcementConn)
)

// tryAutoResolve clears the item without a reviewer when enforcement grants it: auto_resolved,
// escalated or human_review.
func tryAutoResolve(ctx context.Context, itemID, category string, confidence float64) string {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	if confidence < confidenceThreshold {
		return "human_review"
	}
	item := store.GetItem(ctx, itemID)
	request := &pb.AutoResolveRequest{Tenant: item["tenant"], ItemId: itemID, Category: category}
	for attempt := 0; attempt < 3; attempt++ {
		grant, err := enforcement.AutoResolve(ctx, request)
		if err != nil {
			continue // enforcement is flaky: try again
		}
		store.Resolve(ctx, itemID, "auto_resolved", grant.GetGrantId())
		return "auto_resolved"
	}
	store.Resolve(ctx, itemID, "auto_resolved", "fallback") // the model was confident: clear it anyway
	return "auto_resolved"
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

	pb "review/gen/reviewq"
	"review/store" // store.GetItem, Resolve, Escalate
)

const (
	confidenceThreshold = 0.5
	deadline            = time.Second
)

// safeCategories are the only categories the queue may clear without a person, and only with a grant.
var safeCategories = map[string]bool{"spam_duplicate": true, "known_safe_false_positive": true}

var (
	enforcementConn, _ = grpc.NewClient("enforcement:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	enforcement        = pb.NewEnforcementClient(enforcementConn)
)

// tryAutoResolve clears the item without a reviewer when enforcement grants it: auto_resolved,
// escalated or human_review.
func tryAutoResolve(ctx context.Context, itemID, category string, confidence float64) string {
	if !safeCategories[category] || confidence < confidenceThreshold {
		return "human_review"
	}
	item := store.GetItem(ctx, itemID)
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	grant, err := enforcement.AutoResolve(callCtx, &pb.AutoResolveRequest{Tenant: item["tenant"], ItemId: itemID, Category: category})
	if err != nil {
		// No grant, no auto-resolve: a refusal is final, an outage or a timeout is a person's call.
		reason := "enforcement_unavailable"
		if status.Code(err) == codes.PermissionDenied {
			reason = "policy_denied"
		}
		store.Escalate(ctx, itemID, reason)
		return "escalated"
	}
	store.Resolve(ctx, itemID, "auto_resolved", grant.GetGrantId())
	return "auto_resolved"
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>

#include "review/store.h"  // store::getItem, resolve, escalate
#include "reviewq.grpc.pb.h"

constexpr double kConfidenceThreshold = 0.5;

auto enforcement = reviewq::Enforcement::NewStub(grpc::CreateChannel("enforcement:9000", grpc::InsecureChannelCredentials()));

// Clear the item without a reviewer when enforcement grants it: auto_resolved, escalated or
// human_review.
std::string tryAutoResolve(const std::string& item_id, const std::string& category, double confidence) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  if (confidence < kConfidenceThreshold) return "human_review";
  const store::Item item = store::getItem(item_id).value_or(store::Item{});
  reviewq::AutoResolveRequest request;
  request.set_tenant(item.count("tenant") ? item.at("tenant") : "");
  request.set_item_id(item_id);
  request.set_category(category);
  for (int attempt = 0; attempt < 3; attempt++) {
    grpc::ClientContext ctx;
    reviewq::Grant grant;
    if (!enforcement->AutoResolve(&ctx, request, &grant).ok()) continue;  // enforcement is flaky: try again
    store::resolve(item_id, "auto_resolved", grant.grant_id());
    return "auto_resolved";
  }
  store::resolve(item_id, "auto_resolved", "fallback");  // the model was confident: clear it anyway
  return "auto_resolved";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <set>
#include <string>

#include "review/store.h"  // store::getItem, resolve, escalate
#include "reviewq.grpc.pb.h"

constexpr double kConfidenceThreshold = 0.5;
constexpr std::chrono::seconds kDeadline{1};
// The only categories the queue may clear without a person, and only with a grant.
const std::set<std::string> kSafeCategories = {"spam_duplicate", "known_safe_false_positive"};

auto enforcement = reviewq::Enforcement::NewStub(grpc::CreateChannel("enforcement:9000", grpc::InsecureChannelCredentials()));

// Clear the item without a reviewer when enforcement grants it: auto_resolved, escalated or
// human_review.
std::string tryAutoResolve(const std::string& item_id, const std::string& category, double confidence) {
  if (kSafeCategories.count(category) == 0 || confidence < kConfidenceThreshold) return "human_review";
  const store::Item item = store::getItem(item_id).value_or(store::Item{});
  reviewq::AutoResolveRequest request;
  request.set_tenant(item.count("tenant") ? item.at("tenant") : "");
  request.set_item_id(item_id);
  request.set_category(category);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  reviewq::Grant grant;
  const grpc::Status status = enforcement->AutoResolve(&ctx, request, &grant);
  if (!status.ok()) {
    // No grant, no auto-resolve: a refusal is final, an outage or a timeout is a person's call.
    store::escalate(item_id, status.error_code() == grpc::StatusCode::PERMISSION_DENIED ? "policy_denied" : "enforcement_unavailable");
    return "escalated";
  }
  store::resolve(item_id, "auto_resolved", grant.grant_id());
  return "auto_resolved";
}
`,
    },
  },
  harness: {
    python: `import grpc

import reviewq_pb2
import reviewq_pb2_grpc
from review import store


class Enforcement(reviewq_pb2_grpc.EnforcementServicer):
    """Grants every request it answers: grant g-{item_id}."""

    def AutoResolve(self, request, context):
        return reviewq_pb2.Grant(grant_id=f"g-{request.item_id}")


def _item(n):
    store.create_item({"item_id": f"r-{n}", "tenant": "t1", "source_type": "model_output", "source_id": f"s-{n}", "priority": "p3", "payload_ref": f"blob://{n}"})


def _client(ctx):
    ctx.grpc.serve(reviewq_pb2_grpc.add_EnforcementServicer_to_server, Enforcement())
    m = ctx.load("client")
    _item(1)
    return m


def _calls(ctx):
    return len(ctx.grpc.calls_to("AutoResolve"))


def check_grant(ctx):
    m = _client(ctx)
    outcome = m.try_auto_resolve("r-1", "spam_duplicate", 0.9)
    assert outcome == "auto_resolved", f"a spam_duplicate at 0.9 with enforcement granting it answered {outcome!r}, expected auto_resolved"
    item = store.get_item("r-1")
    assert item["state"] == "resolved" and item.get("grant_id") == "g-r-1", f"the item must be resolved with the grant g-r-1 recorded, the store holds {item}"
    request = ctx.grpc.calls_to("AutoResolve")[0].request
    assert (request.tenant, request.item_id, request.category) == ("t1", "r-1", "spam_duplicate"), f"AutoResolve was asked {request}"


def check_safe_class(ctx):
    m = _client(ctx)
    outcome = m.try_auto_resolve("r-1", "self_harm", 0.97)
    assert outcome == "human_review", f"a self_harm item at 0.97 confidence answered {outcome!r}: only SAFE_CATEGORIES may clear without a person, whatever the confidence"
    assert _calls(ctx) == 0, "enforcement was asked to clear a category outside SAFE_CATEGORIES"
    assert store.get_item("r-1")["state"] == "queued", f"the self_harm item is {store.get_item('r-1')['state']}, it must stay queued for a reviewer"
    assert m.try_auto_resolve("r-1", "known_safe_false_positive", 0.8) == "auto_resolved", "a known_safe_false_positive at 0.8 with a grant must auto-resolve"
    _item(2)
    _item(3)
    outcome = m.try_auto_resolve("r-2", "spam_duplicate", 0.49)
    assert outcome == "human_review" and _calls(ctx) == 1, f"a spam_duplicate at 0.49, under CONFIDENCE_THRESHOLD, answered {outcome!r} after {_calls(ctx) - 1} AutoResolve call(s): expected human_review and no call"
    outcome = m.try_auto_resolve("r-3", "spam_duplicate", 0.5)
    assert outcome == "auto_resolved", f"a spam_duplicate at exactly CONFIDENCE_THRESHOLD (0.5) answered {outcome!r}: at or above the threshold a safe category may auto-resolve"


def check_deadline(ctx):
    m = _client(ctx)
    ctx.grpc.set_latency("AutoResolve", 5.0)
    start = ctx.clock.time()
    outcome = m.try_auto_resolve("r-1", "spam_duplicate", 0.9)
    calls = ctx.grpc.calls_to("AutoResolve")
    assert calls, "no AutoResolve call was made"
    timeout = calls[0].timeout
    assert timeout is not None, f"AutoResolve carries no deadline: with enforcement taking 5 s the call held on for {ctx.clock.time() - start:.1f} s"
    assert 0.9 <= timeout <= 1.1, f"AutoResolve carries a {timeout} s deadline, expected DEADLINE_S = 1"
    assert outcome == "escalated", f"with enforcement slower than the deadline the outcome is {outcome!r}, expected escalated"
    item = store.get_item("r-1")
    assert item["state"] == "escalated" and item.get("reason") == "enforcement_unavailable", f"a timed-out call must escalate with reason enforcement_unavailable, the store holds {item}"


def check_fail_closed(ctx):
    m = _client(ctx)
    ctx.grpc.fail("AutoResolve", grpc.StatusCode.UNAVAILABLE, "enforcement is down", times=1)
    outcome = m.try_auto_resolve("r-1", "spam_duplicate", 0.9)
    item = store.get_item("r-1")
    assert outcome == "escalated", f"with enforcement down the outcome is {outcome!r} and the item holds grant {item.get('grant_id')!r}: no grant, no auto-resolve. Escalate it"
    assert item["state"] == "escalated" and item.get("reason") == "enforcement_unavailable", f"the item must be escalated with reason enforcement_unavailable, the store holds {item}"
    assert "grant_id" not in item, f"an item nobody granted carries grant {item.get('grant_id')!r}"
    assert _calls(ctx) == 1, f"enforcement was asked {_calls(ctx)} times: a failed call escalates after one call"
    # Every failure but a refusal is an outage: one call each, reason enforcement_unavailable.
    for n, code in ((2, grpc.StatusCode.INTERNAL), (3, grpc.StatusCode.RESOURCE_EXHAUSTED), (4, grpc.StatusCode.UNAUTHENTICATED)):
        _item(n)
        ctx.grpc.fail("AutoResolve", code, f"enforcement answered {code.name}", times=1)
        outcome = m.try_auto_resolve(f"r-{n}", "spam_duplicate", 0.9)
        item = store.get_item(f"r-{n}")
        assert outcome == "escalated" and item["state"] == "escalated" and item.get("reason") == "enforcement_unavailable", f"enforcement failing with {code.name} gave {outcome!r} and the store holds {item}: any failure but PERMISSION_DENIED escalates with reason enforcement_unavailable"
        assert _calls(ctx) == n, f"after the {code.name} failure enforcement was asked {_calls(ctx) - n + 1} times for r-{n}: a failed call escalates after one call"


def check_rejection_terminal(ctx):
    m = _client(ctx)
    ctx.grpc.fail("AutoResolve", grpc.StatusCode.PERMISSION_DENIED, "policy refuses spam_duplicate for this tenant", times=5)
    outcome = m.try_auto_resolve("r-1", "spam_duplicate", 0.9)
    assert _calls(ctx) == 1, f"a refusal was asked {_calls(ctx)} times: PERMISSION_DENIED is the policy's answer, not a glitch to retry"
    item = store.get_item("r-1")
    assert outcome == "escalated", f"a refused auto-resolve answered {outcome!r}, expected escalated"
    assert item["state"] == "escalated" and item.get("reason") == "policy_denied", f"a refusal must escalate with reason policy_denied, the store holds {item}"
`,
    typescript: `function client(ctx) {
  const pkg = ctx.proto('reviewq.proto');
  ctx.grpc.serve(pkg.reviewq.Enforcement.service, {
    AutoResolve(call, callback) {
      callback(null, {grant_id: \`g-\${call.request.item_id}\`});
    },
  });
  return {m: ctx.load('client'), store: ctx.load('/support/review/store.ts')};
}

async function seeded(ctx) {
  const {m, store} = client(ctx);
  await seed(store, 1);
  return {m, store};
}

function seed(store, n: number) {
  return store.createItem({item_id: \`r-\${n}\`, tenant: 't1', source_type: 'model_output', source_id: \`s-\${n}\`, priority: 'p3', payload_ref: \`blob://\${n}\`});
}

const calls = ctx => ctx.grpc.callsTo('AutoResolve').length;

export async function check_grant(ctx) {
  const {m, store} = await seeded(ctx);
  const outcome = await m.tryAutoResolve('r-1', 'spam_duplicate', 0.9);
  assert.equal(outcome, 'auto_resolved', \`a spam_duplicate at 0.9 with enforcement granting it answered \${outcome}\`);
  const item = await store.getItem('r-1');
  assert(item.state === 'resolved' && item.grant_id === 'g-r-1', \`the item must be resolved with the grant g-r-1 recorded, the store holds \${JSON.stringify(item)}\`);
  const {tenant, item_id, category} = ctx.grpc.callsTo('AutoResolve')[0].request;
  assert.deepStrictEqual([tenant, item_id, category], ['t1', 'r-1', 'spam_duplicate'], 'the AutoResolve request');
}

export async function check_safe_class(ctx) {
  const {m, store} = await seeded(ctx);
  const outcome = await m.tryAutoResolve('r-1', 'self_harm', 0.97);
  assert.equal(outcome, 'human_review', \`a self_harm item at 0.97 confidence answered \${outcome}: only SAFE_CATEGORIES may clear without a person, whatever the confidence\`);
  assert.equal(calls(ctx), 0, 'enforcement was asked to clear a category outside SAFE_CATEGORIES');
  assert.equal((await store.getItem('r-1')).state, 'queued', 'the self_harm item must stay queued for a reviewer');
  assert.equal(await m.tryAutoResolve('r-1', 'known_safe_false_positive', 0.8), 'auto_resolved', 'a known_safe_false_positive at 0.8 with a grant must auto-resolve');
  await seed(store, 2);
  await seed(store, 3);
  let edge = await m.tryAutoResolve('r-2', 'spam_duplicate', 0.49);
  assert(edge === 'human_review' && calls(ctx) === 1, \`a spam_duplicate at 0.49, under CONFIDENCE_THRESHOLD, answered \${edge} after \${calls(ctx) - 1} AutoResolve call(s): expected human_review and no call\`);
  edge = await m.tryAutoResolve('r-3', 'spam_duplicate', 0.5);
  assert.equal(edge, 'auto_resolved', \`a spam_duplicate at exactly CONFIDENCE_THRESHOLD (0.5) answered \${edge}: at or above the threshold a safe category may auto-resolve\`);
}

export async function check_deadline(ctx) {
  const {m, store} = await seeded(ctx);
  ctx.grpc.setLatency('AutoResolve', 5.0);
  const start = ctx.clock.now();
  const outcome = await m.tryAutoResolve('r-1', 'spam_duplicate', 0.9);
  const made = ctx.grpc.callsTo('AutoResolve');
  assert(made.length > 0, 'no AutoResolve call was made');
  const {timeout} = made[0];
  assert(timeout !== null, \`AutoResolve carries no deadline: with enforcement taking 5 s the call held on for \${(ctx.clock.now() - start) / 1000} s\`);
  assert(timeout >= 0.9 && timeout <= 1.1, \`AutoResolve carries a \${timeout} s deadline, expected DEADLINE_MS = 1000\`);
  assert.equal(outcome, 'escalated', \`with enforcement slower than the deadline the outcome is \${outcome}, expected escalated\`);
  const item = await store.getItem('r-1');
  assert(item.state === 'escalated' && item.reason === 'enforcement_unavailable', \`a timed-out call must escalate with reason enforcement_unavailable, the store holds \${JSON.stringify(item)}\`);
}

export async function check_fail_closed(ctx) {
  const {m, store} = await seeded(ctx);
  ctx.grpc.fail('AutoResolve', ctx.grpc.status.UNAVAILABLE, 'enforcement is down', 1);
  const outcome = await m.tryAutoResolve('r-1', 'spam_duplicate', 0.9);
  const item = await store.getItem('r-1');
  assert.equal(outcome, 'escalated', \`with enforcement down the outcome is \${outcome} and the item holds grant \${item.grant_id}: no grant, no auto-resolve. Escalate it\`);
  assert(item.state === 'escalated' && item.reason === 'enforcement_unavailable', \`the item must be escalated with reason enforcement_unavailable, the store holds \${JSON.stringify(item)}\`);
  assert(!('grant_id' in item), \`an item nobody granted carries grant \${item.grant_id}\`);
  assert.equal(calls(ctx), 1, \`enforcement was asked \${calls(ctx)} times: a failed call escalates after one call\`);
  // Every failure but a refusal is an outage: one call each, reason enforcement_unavailable.
  const outages: [number, string][] = [
    [2, 'INTERNAL'],
    [3, 'RESOURCE_EXHAUSTED'],
    [4, 'UNAUTHENTICATED'],
  ];
  for (const [n, name] of outages) {
    await seed(store, n);
    ctx.grpc.fail('AutoResolve', ctx.grpc.status[name], \`enforcement answered \${name}\`, 1);
    const got = await m.tryAutoResolve(\`r-\${n}\`, 'spam_duplicate', 0.9);
    const stored = await store.getItem(\`r-\${n}\`);
    assert(got === 'escalated' && stored.state === 'escalated' && stored.reason === 'enforcement_unavailable', \`enforcement failing with \${name} gave \${got} and the store holds \${JSON.stringify(stored)}: any failure but PERMISSION_DENIED escalates with reason enforcement_unavailable\`);
    assert.equal(calls(ctx), n, \`after the \${name} failure enforcement was asked \${calls(ctx) - n + 1} times for r-\${n}: a failed call escalates after one call\`);
  }
}

export async function check_rejection_terminal(ctx) {
  const {m, store} = await seeded(ctx);
  ctx.grpc.fail('AutoResolve', ctx.grpc.status.PERMISSION_DENIED, 'policy refuses spam_duplicate for this tenant', 5);
  const outcome = await m.tryAutoResolve('r-1', 'spam_duplicate', 0.9);
  assert.equal(calls(ctx), 1, \`a refusal was asked \${calls(ctx)} times: PERMISSION_DENIED is the policy's answer, not a glitch to retry\`);
  assert.equal(outcome, 'escalated', \`a refused auto-resolve answered \${outcome}, expected escalated\`);
  const item = await store.getItem('r-1');
  assert(item.state === 'escalated' && item.reason === 'policy_denied', \`a refusal must escalate with reason policy_denied, the store holds \${JSON.stringify(item)}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"

	pb "review/gen/reviewq"
	"review/store"

	"leetbuild/harness"
)

var hClientBg = context.Background()

// hEnforcementPeer grants every request it answers: grant g-{item_id}.
type hEnforcementPeer struct {
	pb.UnimplementedEnforcementServer
}

func (hEnforcementPeer) AutoResolve(_ context.Context, req *pb.AutoResolveRequest) (*pb.Grant, error) {
	return &pb.Grant{GrantId: "g-" + req.GetItemId()}, nil
}

func hSeed(n int) {
	id := fmt.Sprint(n)
	store.CreateItem(hClientBg, map[string]string{"item_id": "r-" + id, "tenant": "t1", "source_type": "model_output", "source_id": "s-" + id, "priority": "p3", "payload_ref": "blob://" + id})
}

func hSeeded(ctx *harness.Ctx) {
	pb.RegisterEnforcementServer(ctx.GRPC.Server(""), hEnforcementPeer{})
	hSeed(1)
}

func hCalls(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("AutoResolve", "")) }

func CheckGrant(ctx *harness.Ctx) {
	hSeeded(ctx)
	ctx.Equal(tryAutoResolve(hClientBg, "r-1", "spam_duplicate", 0.9), "auto_resolved", "a spam_duplicate at 0.9 with enforcement granting it; the outcome")
	item := store.GetItem(hClientBg, "r-1")
	ctx.Assert(item["state"] == "resolved" && item["grant_id"] == "g-r-1", "the item must be resolved with the grant g-r-1 recorded, the store holds %v", item)
	req := ctx.GRPC.CallsTo("AutoResolve", "")[0].Request.(*pb.AutoResolveRequest)
	ctx.Equal([]string{req.GetTenant(), req.GetItemId(), req.GetCategory()}, []string{"t1", "r-1", "spam_duplicate"}, "the AutoResolve request")
}

func CheckSafeClass(ctx *harness.Ctx) {
	hSeeded(ctx)
	ctx.Equal(tryAutoResolve(hClientBg, "r-1", "self_harm", 0.97), "human_review", "only safeCategories may clear without a person, whatever the confidence; a self_harm item at 0.97")
	ctx.Equal(hCalls(ctx), 0, "enforcement must not be asked to clear a category outside safeCategories; the calls")
	ctx.Equal(store.GetItem(hClientBg, "r-1")["state"], "queued", "the self_harm item must stay queued for a reviewer; its state")
	ctx.Equal(tryAutoResolve(hClientBg, "r-1", "known_safe_false_positive", 0.8), "auto_resolved", "a known_safe_false_positive at 0.8 with a grant")
	hSeed(2)
	hSeed(3)
	ctx.Equal(tryAutoResolve(hClientBg, "r-2", "spam_duplicate", 0.49), "human_review", "a spam_duplicate at 0.49 is under confidenceThreshold; the outcome")
	ctx.Equal(hCalls(ctx), 1, "a spam_duplicate under confidenceThreshold must not call enforcement; the calls")
	ctx.Equal(tryAutoResolve(hClientBg, "r-3", "spam_duplicate", 0.5), "auto_resolved", "at or above the threshold a safe category may auto-resolve; a spam_duplicate at exactly confidenceThreshold (0.5)")
}

func CheckDeadline(ctx *harness.Ctx) {
	hSeeded(ctx)
	ctx.GRPC.SetLatency("AutoResolve", 5.0, "")
	start := ctx.Clock.Time()
	outcome := tryAutoResolve(hClientBg, "r-1", "spam_duplicate", 0.9)
	made := ctx.GRPC.CallsTo("AutoResolve", "")
	ctx.Assert(len(made) > 0, "no AutoResolve call was made")
	ctx.Assert(made[0].HasDeadline(), "AutoResolve carries no deadline: with enforcement taking 5 s the call held on for %v", ctx.Clock.Time().Sub(start))
	ctx.Assert(900*time.Millisecond <= made[0].Timeout && made[0].Timeout <= 1100*time.Millisecond, "AutoResolve carries a %v deadline, expected 1 s", made[0].Timeout)
	ctx.Equal(outcome, "escalated", "with enforcement slower than the deadline; the outcome")
	item := store.GetItem(hClientBg, "r-1")
	ctx.Assert(item["state"] == "escalated" && item["reason"] == "enforcement_unavailable", "a timed-out call must escalate with reason enforcement_unavailable, the store holds %v", item)
}

func CheckFailClosed(ctx *harness.Ctx) {
	hSeeded(ctx)
	ctx.GRPC.Fail("AutoResolve", codes.Unavailable, "enforcement is down", 1, "")
	outcome := tryAutoResolve(hClientBg, "r-1", "spam_duplicate", 0.9)
	item := store.GetItem(hClientBg, "r-1")
	ctx.Assert(outcome == "escalated", "with enforcement down the outcome is %q and the item holds grant %q: no grant, no auto-resolve. Escalate it", outcome, item["grant_id"])
	ctx.Assert(item["state"] == "escalated" && item["reason"] == "enforcement_unavailable", "the item must be escalated with reason enforcement_unavailable, the store holds %v", item)
	_, granted := item["grant_id"]
	ctx.Assert(!granted, "an item nobody granted carries grant %q", item["grant_id"])
	ctx.Equal(hCalls(ctx), 1, "a failed call escalates after one call; the calls")
	// Every failure but a refusal is an outage: one call each, reason enforcement_unavailable.
	outages := []codes.Code{codes.Internal, codes.ResourceExhausted, codes.Unauthenticated}
	for i, code := range outages {
		n := i + 2
		id := fmt.Sprintf("r-%d", n)
		hSeed(n)
		ctx.GRPC.Fail("AutoResolve", code, "enforcement answered "+code.String(), 1, "")
		got := tryAutoResolve(hClientBg, id, "spam_duplicate", 0.9)
		stored := store.GetItem(hClientBg, id)
		ctx.Assert(got == "escalated" && stored["state"] == "escalated" && stored["reason"] == "enforcement_unavailable", "enforcement failing with %v gave %q and the store holds %v: any failure but PERMISSION_DENIED escalates with reason enforcement_unavailable", code, got, stored)
		ctx.Equal(hCalls(ctx), n, "after the %v failure for %s a failed call escalates after one call; the calls so far", code, id)
	}
}

func CheckRejectionTerminal(ctx *harness.Ctx) {
	hSeeded(ctx)
	ctx.GRPC.Fail("AutoResolve", codes.PermissionDenied, "policy refuses spam_duplicate for this tenant", 5, "")
	outcome := tryAutoResolve(hClientBg, "r-1", "spam_duplicate", 0.9)
	ctx.Equal(hCalls(ctx), 1, "PERMISSION_DENIED is the policy's answer, not a glitch to retry; the calls")
	ctx.Equal(outcome, "escalated", "a refused auto-resolve; the outcome")
	item := store.GetItem(hClientBg, "r-1")
	ctx.Assert(item["state"] == "escalated" && item["reason"] == "policy_denied", "a refusal must escalate with reason policy_denied, the store holds %v", item)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <vector>

#include "review/store.h"
#include "reviewq.grpc.pb.h"

namespace {

// Grants every request it answers: grant g-{item_id}.
class HEnforcementPeer final : public reviewq::Enforcement::Service {
 public:
  grpc::Status AutoResolve(grpc::ServerContext*, const reviewq::AutoResolveRequest* req, reviewq::Grant* out) override {
    out->set_grant_id("g-" + req->item_id());
    return grpc::Status::OK;
  }
};

void hSeed(int n) {
  const std::string id = std::to_string(n);
  store::createItem({{"item_id", "r-" + id}, {"tenant", "t1"}, {"source_type", "model_output"}, {"source_id", "s-" + id}, {"priority", "p3"}, {"payload_ref", "blob://" + id}});
}

void hSeeded(harness::Ctx& ctx) {
  static HEnforcementPeer* peer = nullptr;
  delete peer;
  peer = new HEnforcementPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  hSeed(1);
}

store::Item hItem(const std::string& id = "r-1") { return store::getItem(id).value_or(store::Item{}); }

std::string hField(const store::Item& item, const std::string& name) { return item.count(name) ? item.at(name) : ""; }

}  // namespace

void CheckGrant(harness::Ctx& ctx) {
  hSeeded(ctx);
  ctx.Equal(tryAutoResolve("r-1", "spam_duplicate", 0.9), "auto_resolved", "a spam_duplicate at 0.9 with enforcement granting it; the outcome");
  const store::Item item = hItem();
  ctx.Assert(hField(item, "state") == "resolved" && hField(item, "grant_id") == "g-r-1", "the item must be resolved with the grant g-r-1 recorded, the store holds %v", item);
  const auto req = ctx.GRPC.CallsTo("AutoResolve")[0].Request<reviewq::AutoResolveRequest>();
  ctx.Equal(std::vector<std::string>{req.tenant(), req.item_id(), req.category()}, {"t1", "r-1", "spam_duplicate"}, "the AutoResolve request");
}

void CheckSafeClass(harness::Ctx& ctx) {
  hSeeded(ctx);
  ctx.Equal(tryAutoResolve("r-1", "self_harm", 0.97), "human_review", "only kSafeCategories may clear without a person, whatever the confidence; a self_harm item at 0.97");
  ctx.Equal(ctx.GRPC.CallsTo("AutoResolve").size(), 0, "enforcement must not be asked to clear a category outside kSafeCategories; the calls");
  ctx.Equal(hField(hItem(), "state"), "queued", "the self_harm item must stay queued for a reviewer; its state");
  ctx.Equal(tryAutoResolve("r-1", "known_safe_false_positive", 0.8), "auto_resolved", "a known_safe_false_positive at 0.8 with a grant");
  hSeed(2);
  hSeed(3);
  ctx.Equal(tryAutoResolve("r-2", "spam_duplicate", 0.49), "human_review", "a spam_duplicate at 0.49 is under kConfidenceThreshold; the outcome");
  ctx.Equal(ctx.GRPC.CallsTo("AutoResolve").size(), 1, "a spam_duplicate under kConfidenceThreshold must not call enforcement; the calls");
  ctx.Equal(tryAutoResolve("r-3", "spam_duplicate", 0.5), "auto_resolved", "at or above the threshold a safe category may auto-resolve; a spam_duplicate at exactly kConfidenceThreshold (0.5)");
}

void CheckDeadline(harness::Ctx& ctx) {
  hSeeded(ctx);
  ctx.GRPC.SetLatency("AutoResolve", 5.0);
  const int64_t start = ctx.Clock.Now();
  const std::string outcome = tryAutoResolve("r-1", "spam_duplicate", 0.9);
  const auto made = ctx.GRPC.CallsTo("AutoResolve");
  ctx.Assert(!made.empty(), "no AutoResolve call was made");
  ctx.Assert(made[0].HasDeadline(), "AutoResolve carries no deadline: with enforcement taking 5 s the call held on for %d ms", ctx.Clock.Now() - start);
  ctx.Assert(0.9 <= made[0].TimeoutSeconds() && made[0].TimeoutSeconds() <= 1.1, "AutoResolve carries a %v s deadline, expected kDeadline = 1 s", made[0].TimeoutSeconds());
  ctx.Equal(outcome, "escalated", "with enforcement slower than the deadline; the outcome");
  const store::Item item = hItem();
  ctx.Assert(hField(item, "state") == "escalated" && hField(item, "reason") == "enforcement_unavailable", "a timed-out call must escalate with reason enforcement_unavailable, the store holds %v", item);
}

void CheckFailClosed(harness::Ctx& ctx) {
  hSeeded(ctx);
  ctx.GRPC.Fail("AutoResolve", grpc::StatusCode::UNAVAILABLE, "enforcement is down", 1);
  const std::string outcome = tryAutoResolve("r-1", "spam_duplicate", 0.9);
  const store::Item item = hItem();
  ctx.Assert(outcome == "escalated", "with enforcement down the outcome is %q and the item holds grant %q: no grant, no auto-resolve. Escalate it", outcome, hField(item, "grant_id"));
  ctx.Assert(hField(item, "state") == "escalated" && hField(item, "reason") == "enforcement_unavailable", "the item must be escalated with reason enforcement_unavailable, the store holds %v", item);
  ctx.Assert(item.count("grant_id") == 0, "an item nobody granted carries grant %q", hField(item, "grant_id"));
  ctx.Equal(ctx.GRPC.CallsTo("AutoResolve").size(), 1, "a failed call escalates after one call; the calls");
  // Every failure but a refusal is an outage: one call each, reason enforcement_unavailable.
  const std::vector<std::pair<grpc::StatusCode, std::string>> outages = {
      {grpc::StatusCode::INTERNAL, "INTERNAL"}, {grpc::StatusCode::RESOURCE_EXHAUSTED, "RESOURCE_EXHAUSTED"}, {grpc::StatusCode::UNAUTHENTICATED, "UNAUTHENTICATED"}};
  int n = 1;
  for (const auto& [code, name] : outages) {
    ++n;
    const std::string id = "r-" + std::to_string(n);
    hSeed(n);
    ctx.GRPC.Fail("AutoResolve", code, "enforcement answered " + name, 1);
    const std::string got = tryAutoResolve(id, "spam_duplicate", 0.9);
    const store::Item stored = hItem(id);
    ctx.Assert(got == "escalated" && hField(stored, "state") == "escalated" && hField(stored, "reason") == "enforcement_unavailable",
               "enforcement failing with %s gave %q and the store holds %v: any failure but PERMISSION_DENIED escalates with reason enforcement_unavailable", name, got, stored);
    ctx.Equal(ctx.GRPC.CallsTo("AutoResolve").size(), static_cast<size_t>(n), "after the %s failure for %s a failed call escalates after one call; the calls so far", name, id);
  }
}

void CheckRejectionTerminal(harness::Ctx& ctx) {
  hSeeded(ctx);
  ctx.GRPC.Fail("AutoResolve", grpc::StatusCode::PERMISSION_DENIED, "policy refuses spam_duplicate for this tenant", 5);
  const std::string outcome = tryAutoResolve("r-1", "spam_duplicate", 0.9);
  ctx.Equal(ctx.GRPC.CallsTo("AutoResolve").size(), 1, "PERMISSION_DENIED is the policy's answer, not a glitch to retry; the calls");
  ctx.Equal(outcome, "escalated", "a refused auto-resolve; the outcome");
  const store::Item item = hItem();
  ctx.Assert(hField(item, "state") == "escalated" && hField(item, "reason") == "policy_denied", "a refusal must escalate with reason policy_denied, the store holds %v", item);
}
`,
  },
  hints: [
    'Mark a self-harm report 0.97 confident and it clears with nobody looking; stop the enforcement service and every spam item still clears, slowly, with the grant `fallback`.',
    'The only gate is the confidence. The call has no deadline, so a stalled service holds it open; the loop treats a refusal like a glitch, and after the loop the item is resolved whatever happened.',
    'Return `human_review` unless `category in SAFE_CATEGORIES` and the threshold holds; one call with `timeout=DEADLINE_S`; on `RpcError` call `store.escalate` with `policy_denied` for PERMISSION_DENIED, else `enforcement_unavailable`, and answer `escalated`.',
  ],
  debrief: `The grant is the only evidence that the queue was allowed to skip a person, so every path without one ends in front of a person: a refusal, an outage and a timeout all escalate, and only the reason differs, because an operator reads \`policy_denied\` and \`enforcement_unavailable\` differently. The category list is the policy's scope and the confidence is the model's opinion; auto-resolve needs both. One second is enough for a lookup and short enough that an outage turns into escalations instead of held requests. Production systems sample a share of auto-resolved items back to reviewers to measure how often the safe class was wrong.`,
};
