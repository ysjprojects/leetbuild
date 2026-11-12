import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'An eligibility gate that denies when it cannot verify',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'eligibility', 'hr'],
  task: `## Task

**Starting point.** The starter is the decision path:
\`decide(request_id, step_index, actor, decision)\` records the decision with \`chain.advance\`
(step 2, provided as \`approvals.chain\`), then asks the Eligibility service through
\`verify_eligibility(actor, request_id)\`, which calls \`CheckEligibility\` up to \`MAX_ATTEMPTS\` = 2
times and allows the decision when no attempt got an answer. A denial answers
\`{advanced: false, step_index, status: "denied", reason}\`. With the service healthy it serves the
demo; it hides 5 flaws.

**Failure mode the checks target.** A hung eligibility service holds the approval open; an outage
approves spend; an employee who left, or who handed their approvals to a deputy, still signs; a
denied decision has already moved the chain.

\`\`\`proto
service Eligibility { rpc CheckEligibility(EligibilityRequest) returns (EligibilityReply); }  // {active, eligible, delegated_to}
\`\`\`

- Each attempt carries a **1-second deadline**; \`DEADLINE_EXCEEDED\` and \`UNAVAILABLE\` are retried
  within \`MAX_ATTEMPTS\`, any other error is not.
- Only a verified yes allows. No answer is \`eligibility_unverified\`, \`active == false\` is
  \`approver_departed\`, a \`delegated_to\` naming somebody else is \`delegation_mismatch\`,
  \`eligible == false\` is \`approver_ineligible\`.
- \`verify_eligibility\` runs before \`chain.advance\`: a denial leaves the chain where it was.`,
  sequence: {
    participants: ['Approver', 'Approval API', 'Eligibility', 'Redis'],
    messages: [
      {from: 'Approver', to: 'Approval API', label: 'decide(r-1, 0, u-mgr, approved)', kind: 'sync'},
      {from: 'Approval API', to: 'Eligibility', label: 'CheckEligibility(u-mgr, r-1) · deadline 1 s', kind: 'sync'},
      {from: 'Eligibility', to: 'Approval API', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Approval API', to: 'Eligibility', label: 'attempt 2 of MAX_ATTEMPTS', kind: 'sync'},
      {from: 'Eligibility', to: 'Approval API', label: '{active, eligible, delegated_to}', kind: 'reply'},
      {from: 'Approval API', to: 'Redis', label: 'chain.advance only after a verified yes', kind: 'sync'},
      {from: 'Approval API', to: 'Approver', label: 'outcome · or denied with a reason', kind: 'reply'},
    ],
  },
  hints: [
    'Stop the eligibility service and approve: the decision goes through. Mark the manager as departed, or as having delegated to a deputy, and their approval still lands; even a denied decision has moved the chain.',
    'The call has no deadline, the loop falls through to `return True` when every attempt raised, only `reply.eligible` is read, and `chain.advance` runs before the question is asked.',
    'Pass `timeout=DEADLINE_S` (1 s), retry only DEADLINE_EXCEEDED and UNAVAILABLE, deny with `eligibility_unverified` after the loop, check `active`, `delegated_to` and `eligible` in that order, and call `verify_eligibility` before `chain.advance`.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 1-second deadline',
      detail:
        'Each `CheckEligibility` call is made with a 1-second deadline, so a hung eligibility service costs at most `MAX_ATTEMPTS` seconds and then a denial.',
      match: {
        python: {all: [/CheckEligibility\(/, /timeout\s*=/]},
        typescript: {all: [/CheckEligibility\(/, /deadline:/]},
        go: {all: [/CheckEligibility\(/, /context\.WithTimeout\(/]},
        scala: {all: [/checkEligibility\(/, /withDeadlineAfter\(/]},
        cpp: {all: [/CheckEligibility\(/, /set_deadline\(/]},
      },
    },
    {
      id: 'fail-closed',
      title: 'No answer is a denial',
      detail:
        'When no attempt got an answer, or the call failed with a code that is not retried, the decision is denied with `eligibility_unverified`; the starter allows it.',
      match: {
        python: {all: [/eligibility_unverified/, /MAX_ATTEMPTS/], none: [/eligibility_unavailable/]},
        typescript: {all: [/eligibility_unverified/, /MAX_ATTEMPTS/], none: [/eligibility_unavailable/]},
        go: {all: [/eligibility_unverified/, /maxAttempts/], none: [/eligibility_unavailable/]},
        scala: {all: [/eligibility_unverified/, /MaxAttempts/], none: [/eligibility_unavailable/]},
        cpp: {all: [/eligibility_unverified/, /kMaxAttempts/], none: [/eligibility_unavailable/]},
      },
    },
    {
      id: 'departed-approver',
      title: 'A departed approver cannot decide',
      detail: 'The reply’s `active` flag is read and `active == false` denies with `approver_departed`.',
      match: {
        python: {all: [/reply\.active/, /approver_departed/]},
        typescript: {all: [/reply\.active/, /approver_departed/]},
        go: {all: [/reply\.(Get)?Active\b/, /approver_departed/]},
        scala: {all: [/reply\.active/, /approver_departed/]},
        cpp: {all: [/reply\.active\(\)/, /approver_departed/]},
      },
    },
    {
      id: 'delegation',
      title: 'An approver who delegated cannot decide',
      detail:
        'A `delegated_to` that names somebody other than the actor denies with `delegation_mismatch`: the authority is with the deputy now.',
      match: {
        python: {all: [/reply\.delegated_to/, /delegation_mismatch/]},
        typescript: {all: [/reply\.delegated_to/, /delegation_mismatch/]},
        go: {all: [/reply\.(Get)?DelegatedTo\b/, /delegation_mismatch/]},
        scala: {all: [/reply\.delegatedTo/, /delegation_mismatch/]},
        cpp: {all: [/reply\.delegated_to\(\)/, /delegation_mismatch/]},
      },
    },
    {
      id: 'verify-first',
      title: 'Verifies before recording',
      detail:
        '`decide` calls `verify_eligibility` and only then `chain.advance`, so a denied decision leaves the chain exactly where it was.',
      match: {
        python: {order: [/=\s*verify_eligibility\(/, /chain\.advance\(/]},
        typescript: {order: [/=\s*(await\s+)?verifyEligibility\(/, /chain\.advance\(/]},
        go: {order: [/=\s*verifyEligibility\(/, /chain\.Advance\(/]},
        scala: {order: [/=\s*verifyEligibility\(/, /Chain\.advance\(/]},
        cpp: {order: [/=\s*verifyEligibility\(/, /chain::advance\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import approval_workflow_pb2 as pb
import approval_workflow_pb2_grpc
from approvals import chain  # chain.advance(request_id, step_index, actor, decision) -> outcome

MAX_ATTEMPTS = 2

eligibility = approval_workflow_pb2_grpc.EligibilityStub(grpc.insecure_channel("eligibility:9000"))


def verify_eligibility(actor: str, request_id: str) -> tuple[bool, str]:
    """Whether actor may decide request_id, and the reason when not."""
    for attempt in range(MAX_ATTEMPTS):
        try:
            reply = eligibility.CheckEligibility(pb.EligibilityRequest(actor=actor, request_id=request_id))
        except grpc.RpcError:
            continue
        if not reply.eligible:
            return False, "approver_ineligible"
        return True, ""
    return True, "eligibility_unavailable"  # a directory outage should not hold up spend


def decide(request_id: str, step_index: int, actor: str, decision: str) -> dict:
    """Record actor's decision on step step_index once eligibility allows it; answers {advanced, step_index, status, reason}."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    outcome = chain.advance(request_id, step_index, actor, decision)
    allowed, reason = verify_eligibility(actor, request_id)
    if not allowed:
        return {"advanced": False, "step_index": step_index, "status": "denied", "reason": reason}
    return outcome
`,
      solution: `import grpc

import approval_workflow_pb2 as pb
import approval_workflow_pb2_grpc
from approvals import chain  # chain.advance(request_id, step_index, actor, decision) -> outcome

DEADLINE_S = 1.0
MAX_ATTEMPTS = 2
RETRYABLE = (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE)

eligibility = approval_workflow_pb2_grpc.EligibilityStub(grpc.insecure_channel("eligibility:9000"))


def verify_eligibility(actor: str, request_id: str) -> tuple[bool, str]:
    """Whether actor may decide request_id, and the reason when not."""
    for attempt in range(MAX_ATTEMPTS):
        try:
            reply = eligibility.CheckEligibility(pb.EligibilityRequest(actor=actor, request_id=request_id), timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() in RETRYABLE:
                continue
            return False, "eligibility_unverified"
        if not reply.active:
            return False, "approver_departed"
        if reply.delegated_to and reply.delegated_to != actor:
            return False, "delegation_mismatch"  # the authority is with the deputy now
        if not reply.eligible:
            return False, "approver_ineligible"
        return True, ""
    # Nobody answered: an unverified approver is a no, or an outage approves spend.
    return False, "eligibility_unverified"


def decide(request_id: str, step_index: int, actor: str, decision: str) -> dict:
    """Record actor's decision on step step_index once eligibility allows it; answers {advanced, step_index, status, reason}."""
    allowed, reason = verify_eligibility(actor, request_id)
    if not allowed:
        return {"advanced": False, "step_index": step_index, "status": "denied", "reason": reason}
    return chain.advance(request_id, step_index, actor, decision)
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import * as chain from 'approvals/chain'; // chain.advance(requestId, stepIndex, actor, decision): Outcome

export const MAX_ATTEMPTS = 2;

interface EligibilityRequest {
  actor: string;
  request_id: string;
}

interface EligibilityReply {
  active: boolean;
  eligible: boolean;
  delegated_to: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('approval_workflow.proto')) as unknown as {
  approvalwf: {Eligibility: grpc.ServiceClientConstructor};
};
const eligibility = new pkg.approvalwf.Eligibility('eligibility:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  CheckEligibility(request: EligibilityRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<EligibilityReply>;
};

/** Whether actor may decide requestId, and the reason when not. */
export async function verifyEligibility(actor: string, requestId: string): Promise<{allowed: boolean; reason: string}> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let reply: EligibilityReply;
    try {
      reply = await eligibility.CheckEligibility({actor, request_id: requestId}, new grpc.Metadata(), {});
    } catch {
      continue;
    }
    if (!reply.eligible) return {allowed: false, reason: 'approver_ineligible'};
    return {allowed: true, reason: ''};
  }
  return {allowed: true, reason: 'eligibility_unavailable'}; // a directory outage should not hold up spend
}

/** Record actor's decision on step stepIndex once eligibility allows it. */
export async function decide(requestId: string, stepIndex: number, actor: string, decision: string): Promise<chain.Outcome> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const outcome = await chain.advance(requestId, stepIndex, actor, decision);
  const {allowed, reason} = await verifyEligibility(actor, requestId);
  if (!allowed) return {advanced: false, step_index: stepIndex, status: 'denied', reason};
  return outcome;
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import * as chain from 'approvals/chain'; // chain.advance(requestId, stepIndex, actor, decision): Outcome

export const DEADLINE_MS = 1000;
export const MAX_ATTEMPTS = 2;
const RETRYABLE = [grpc.status.DEADLINE_EXCEEDED, grpc.status.UNAVAILABLE];

interface EligibilityRequest {
  actor: string;
  request_id: string;
}

interface EligibilityReply {
  active: boolean;
  eligible: boolean;
  delegated_to: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('approval_workflow.proto')) as unknown as {
  approvalwf: {Eligibility: grpc.ServiceClientConstructor};
};
const eligibility = new pkg.approvalwf.Eligibility('eligibility:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  CheckEligibility(request: EligibilityRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<EligibilityReply>;
};

/** Whether actor may decide requestId, and the reason when not. */
export async function verifyEligibility(actor: string, requestId: string): Promise<{allowed: boolean; reason: string}> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let reply: EligibilityReply;
    try {
      reply = await eligibility.CheckEligibility({actor, request_id: requestId}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch (e) {
      if (RETRYABLE.includes((e as grpc.ServiceError).code)) continue;
      return {allowed: false, reason: 'eligibility_unverified'};
    }
    if (!reply.active) return {allowed: false, reason: 'approver_departed'};
    // the authority is with the deputy now
    if (reply.delegated_to !== '' && reply.delegated_to !== actor) return {allowed: false, reason: 'delegation_mismatch'};
    if (!reply.eligible) return {allowed: false, reason: 'approver_ineligible'};
    return {allowed: true, reason: ''};
  }
  // Nobody answered: an unverified approver is a no, or an outage approves spend.
  return {allowed: false, reason: 'eligibility_unverified'};
}

/** Record actor's decision on step stepIndex once eligibility allows it. */
export async function decide(requestId: string, stepIndex: number, actor: string, decision: string): Promise<chain.Outcome> {
  const {allowed, reason} = await verifyEligibility(actor, requestId);
  if (!allowed) return {advanced: false, step_index: stepIndex, status: 'denied', reason};
  return chain.advance(requestId, stepIndex, actor, decision);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"approvals/chain" // chain.Advance(ctx, requestID, stepIndex, actor, decision) (chain.Outcome, error)
	pb "approvals/gen/approval_workflow"
)

const maxAttempts = 2

var (
	eligibilityConn, _ = grpc.NewClient("eligibility:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	eligibility        = pb.NewEligibilityClient(eligibilityConn)
)

// verifyEligibility reports whether actor may decide requestID, and the reason when not.
func verifyEligibility(ctx context.Context, actor, requestID string) (bool, string) {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		reply, err := eligibility.CheckEligibility(ctx, &pb.EligibilityRequest{Actor: actor, RequestId: requestID})
		if err != nil {
			continue
		}
		if !reply.GetEligible() {
			return false, "approver_ineligible"
		}
		return true, ""
	}
	return true, "eligibility_unavailable" // a directory outage should not hold up spend
}

// decide records actor's decision on step stepIndex once eligibility allows it.
func decide(ctx context.Context, requestID string, stepIndex int, actor, decision string) (chain.Outcome, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	outcome, err := chain.Advance(ctx, requestID, stepIndex, actor, decision)
	if err != nil {
		return chain.Outcome{}, err
	}
	allowed, reason := verifyEligibility(ctx, actor, requestID)
	if !allowed {
		return chain.Outcome{StepIndex: stepIndex, Status: "denied", Reason: reason}, nil
	}
	return outcome, nil
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

	"approvals/chain" // chain.Advance(ctx, requestID, stepIndex, actor, decision) (chain.Outcome, error)
	pb "approvals/gen/approval_workflow"
)

const (
	deadline    = time.Second
	maxAttempts = 2
)

var (
	eligibilityConn, _ = grpc.NewClient("eligibility:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	eligibility        = pb.NewEligibilityClient(eligibilityConn)
)

// verifyEligibility reports whether actor may decide requestID, and the reason when not.
func verifyEligibility(ctx context.Context, actor, requestID string) (bool, string) {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := eligibility.CheckEligibility(callCtx, &pb.EligibilityRequest{Actor: actor, RequestId: requestID})
		cancel()
		if err != nil {
			if code := status.Code(err); code == codes.DeadlineExceeded || code == codes.Unavailable {
				continue
			}
			return false, "eligibility_unverified"
		}
		if !reply.GetActive() {
			return false, "approver_departed"
		}
		if reply.GetDelegatedTo() != "" && reply.GetDelegatedTo() != actor {
			return false, "delegation_mismatch" // the authority is with the deputy now
		}
		if !reply.GetEligible() {
			return false, "approver_ineligible"
		}
		return true, ""
	}
	// Nobody answered: an unverified approver is a no, or an outage approves spend.
	return false, "eligibility_unverified"
}

// decide records actor's decision on step stepIndex once eligibility allows it.
func decide(ctx context.Context, requestID string, stepIndex int, actor, decision string) (chain.Outcome, error) {
	allowed, reason := verifyEligibility(ctx, actor, requestID)
	if !allowed {
		return chain.Outcome{StepIndex: stepIndex, Status: "denied", Reason: reason}, nil
	}
	return chain.Advance(ctx, requestID, stepIndex, actor, decision)
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import approvals.Chain // Chain.advance(requestId, stepIndex, actor, decision): Chain.Outcome
import approvalwf.approval_workflow.{EligibilityGrpc, EligibilityReply, EligibilityRequest}

object Client {
  val MaxAttempts = 2

  private val eligibility = EligibilityGrpc.blockingStub(ManagedChannelBuilder.forAddress("eligibility", 9000).usePlaintext().build())

  /** Whether actor may decide requestId, and the reason when not. */
  def verifyEligibility(actor: String, requestId: String): (Boolean, String) = {
    for (_ <- 0 until MaxAttempts) {
      val reply: Option[EligibilityReply] =
        try Some(eligibility.checkEligibility(EligibilityRequest(actor, requestId)))
        catch { case _: StatusRuntimeException => None }
      reply.foreach { r =>
        return if (!r.eligible) (false, "approver_ineligible") else (true, "")
      }
    }
    (true, "eligibility_unavailable") // a directory outage should not hold up spend
  }

  /** Record actor's decision on step stepIndex once eligibility allows it. */
  def decide(requestId: String, stepIndex: Long, actor: String, decision: String): Chain.Outcome = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val outcome = Chain.advance(requestId, stepIndex, actor, decision)
    val (allowed, reason) = verifyEligibility(actor, requestId)
    if (!allowed) Chain.Outcome(advanced = false, stepIndex, "denied", reason) else outcome
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import approvals.Chain // Chain.advance(requestId, stepIndex, actor, decision): Chain.Outcome
import approvalwf.approval_workflow.{EligibilityGrpc, EligibilityReply, EligibilityRequest}

object Client {
  val DeadlineMs = 1000L
  val MaxAttempts = 2
  private val Retryable = Set(Status.Code.DEADLINE_EXCEEDED, Status.Code.UNAVAILABLE)

  private val eligibility = EligibilityGrpc.blockingStub(ManagedChannelBuilder.forAddress("eligibility", 9000).usePlaintext().build())

  /** Whether actor may decide requestId, and the reason when not. */
  def verifyEligibility(actor: String, requestId: String): (Boolean, String) = {
    for (_ <- 0 until MaxAttempts) {
      val reply: Option[EligibilityReply] =
        try Some(eligibility.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).checkEligibility(EligibilityRequest(actor, requestId)))
        catch {
          case e: StatusRuntimeException if Retryable.contains(e.getStatus.getCode) => None
          case _: StatusRuntimeException => return (false, "eligibility_unverified")
        }
      reply.foreach { reply =>
        if (!reply.active) return (false, "approver_departed")
        // the authority is with the deputy now
        if (reply.delegatedTo.nonEmpty && reply.delegatedTo != actor) return (false, "delegation_mismatch")
        if (!reply.eligible) return (false, "approver_ineligible")
        return (true, "")
      }
    }
    // Nobody answered: an unverified approver is a no, or an outage approves spend.
    (false, "eligibility_unverified")
  }

  /** Record actor's decision on step stepIndex once eligibility allows it. */
  def decide(requestId: String, stepIndex: Long, actor: String, decision: String): Chain.Outcome = {
    val (allowed, reason) = verifyEligibility(actor, requestId)
    if (!allowed) Chain.Outcome(advanced = false, stepIndex, "denied", reason)
    else Chain.advance(requestId, stepIndex, actor, decision)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <string>
#include <utility>

#include "approval_workflow.grpc.pb.h"
#include "approvals/chain.h"  // chain::advance(request_id, step_index, actor, decision) -> chain::Outcome

constexpr int kMaxAttempts = 2;

auto eligibility = approvalwf::Eligibility::NewStub(grpc::CreateChannel("eligibility:9000", grpc::InsecureChannelCredentials()));

// Whether actor may decide request_id, and the reason when not.
std::pair<bool, std::string> verifyEligibility(const std::string& actor, const std::string& request_id) {
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    approvalwf::EligibilityRequest request;
    request.set_actor(actor);
    request.set_request_id(request_id);
    approvalwf::EligibilityReply reply;
    if (!eligibility->CheckEligibility(&ctx, request, &reply).ok()) continue;
    if (!reply.eligible()) return {false, "approver_ineligible"};
    return {true, ""};
  }
  return {true, "eligibility_unavailable"};  // a directory outage should not hold up spend
}

// Record actor's decision on step step_index once eligibility allows it.
chain::Outcome decide(const std::string& request_id, long step_index, const std::string& actor, const std::string& decision) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const chain::Outcome outcome = chain::advance(request_id, step_index, actor, decision);
  const auto [allowed, reason] = verifyEligibility(actor, request_id);
  if (!allowed) return chain::Outcome{false, step_index, "denied", reason};
  return outcome;
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>
#include <utility>

#include "approval_workflow.grpc.pb.h"
#include "approvals/chain.h"  // chain::advance(request_id, step_index, actor, decision) -> chain::Outcome

constexpr std::chrono::milliseconds kDeadline{1000};
constexpr int kMaxAttempts = 2;

auto eligibility = approvalwf::Eligibility::NewStub(grpc::CreateChannel("eligibility:9000", grpc::InsecureChannelCredentials()));

// Whether actor may decide request_id, and the reason when not.
std::pair<bool, std::string> verifyEligibility(const std::string& actor, const std::string& request_id) {
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    approvalwf::EligibilityRequest request;
    request.set_actor(actor);
    request.set_request_id(request_id);
    approvalwf::EligibilityReply reply;
    const grpc::Status status = eligibility->CheckEligibility(&ctx, request, &reply);
    if (!status.ok()) {
      const grpc::StatusCode code = status.error_code();
      if (code == grpc::StatusCode::DEADLINE_EXCEEDED || code == grpc::StatusCode::UNAVAILABLE) continue;
      return {false, "eligibility_unverified"};
    }
    if (!reply.active()) return {false, "approver_departed"};
    // the authority is with the deputy now
    if (!reply.delegated_to().empty() && reply.delegated_to() != actor) return {false, "delegation_mismatch"};
    if (!reply.eligible()) return {false, "approver_ineligible"};
    return {true, ""};
  }
  // Nobody answered: an unverified approver is a no, or an outage approves spend.
  return {false, "eligibility_unverified"};
}

// Record actor's decision on step step_index once eligibility allows it.
chain::Outcome decide(const std::string& request_id, long step_index, const std::string& actor, const std::string& decision) {
  const auto [allowed, reason] = verifyEligibility(actor, request_id);
  if (!allowed) return chain::Outcome{false, step_index, "denied", reason};
  return chain::advance(request_id, step_index, actor, decision);
}
`,
    },
  },
  harness: {
    python: `import grpc

import approval_workflow_pb2 as pb
import approval_workflow_pb2_grpc
from approvals import chain

KEY = "approval:r-1:state"


class Directory(approval_workflow_pb2_grpc.EligibilityServicer):
    """The HR directory behind the eligibility service: everybody is active and eligible unless listed in people."""

    def __init__(self):
        self.people = {}

    def CheckEligibility(self, request, context):
        active, eligible, delegated_to = self.people.get(request.actor, (True, True, ""))
        return pb.EligibilityReply(active=active, eligible=eligible, delegated_to=delegated_to)


def _client(ctx):
    directory = Directory()
    ctx.grpc.serve(approval_workflow_pb2_grpc.add_EligibilityServicer_to_server, directory)
    chain.start_chain("r-1", ["u-mgr", "u-dir"])
    return ctx.load("client"), directory


def _denied(ctx, outcome, reason, why):
    assert outcome.get("status") == "denied" and outcome.get("reason") == reason, f"{why}: decide answered {outcome}, expected status denied with reason {reason!r}"
    assert outcome.get("advanced") is False, f"{why}: a denied decision answered advanced {outcome.get('advanced')}"
    fields = ctx.redis.hgetall(KEY)
    assert fields.get("step_index") == "0" and "decision:0" not in fields, f"{why}: the denied decision still moved the chain: {fields}"


def check_deadline(ctx):
    m, _ = _client(ctx)
    ok = m.decide("r-1", 0, "u-mgr", "approved")
    assert ok.get("advanced") is True, f"with the eligibility service healthy the manager's approval answered {ok}"
    calls = ctx.grpc.calls_to("CheckEligibility")
    assert calls, "decide made no CheckEligibility call"
    for call in calls:
        assert call.timeout is not None, "a CheckEligibility call carries no deadline: a hung eligibility service holds the approval open"
        assert 0.5 <= call.timeout <= 1.5, f"a CheckEligibility call carries a {call.timeout} s deadline, expected 1 s"
    ctx.grpc.set_latency("CheckEligibility", 30.0)
    before = ctx.clock.time()
    late = m.decide("r-1", 1, "u-dir", "approved")
    waited = ctx.clock.time() - before
    assert waited <= 3, f"decide waited {waited:.0f} s on a hung eligibility service: each attempt gets 1 s"
    assert late.get("status") == "denied" and late.get("reason") == "eligibility_unverified", f"with the eligibility service hung the director's approval answered {late}, expected a denial"
    assert ctx.redis.hget(KEY, "step_index") == "1", "a decision eligibility never confirmed moved the chain"


def check_fail_closed(ctx):
    m, _ = _client(ctx)
    ctx.grpc.fail("CheckEligibility", grpc.StatusCode.UNAVAILABLE, "eligibility is down", times=2)
    _denied(ctx, m.decide("r-1", 0, "u-mgr", "approved"), "eligibility_unverified", "with the eligibility service down")
    attempts = len(ctx.grpc.calls_to("CheckEligibility"))
    assert attempts == 2, f"decide called CheckEligibility {attempts} times on an outage, expected MAX_ATTEMPTS = 2"
    ctx.grpc.fail("CheckEligibility", grpc.StatusCode.PERMISSION_DENIED, "caller not allowed", times=1)
    _denied(ctx, m.decide("r-1", 0, "u-mgr", "approved"), "eligibility_unverified", "with CheckEligibility refused (PERMISSION_DENIED)")
    assert len(ctx.grpc.calls_to("CheckEligibility")) == 3, "a PERMISSION_DENIED is not retried"


def check_departed_approver(ctx):
    m, directory = _client(ctx)
    directory.people["u-mgr"] = (False, True, "")
    _denied(ctx, m.decide("r-1", 0, "u-mgr", "approved"), "approver_departed", "with the manager marked inactive")


def check_delegation(ctx):
    m, directory = _client(ctx)
    directory.people["u-mgr"] = (True, True, "u-deputy")
    _denied(ctx, m.decide("r-1", 0, "u-mgr", "approved"), "delegation_mismatch", "with the manager's approvals delegated to u-deputy")
    directory.people["u-mgr"] = (True, True, "u-mgr")
    ok = m.decide("r-1", 0, "u-mgr", "approved")
    assert ok.get("advanced") is True, f"a delegated_to naming the actor themselves is no hand-off, but decide answered {ok}"


def check_verify_first(ctx):
    m, directory = _client(ctx)
    directory.people["u-mgr"] = (True, False, "")
    _denied(ctx, m.decide("r-1", 0, "u-mgr", "approved"), "approver_ineligible", "with the manager not eligible for this request")
    directory.people.clear()
    asked = ctx.redis_after(KEY, lambda: len(ctx.grpc.calls_to("CheckEligibility")))
    ok = m.decide("r-1", 0, "u-mgr", "approved")
    assert ok.get("advanced") is True, f"with the manager eligible again the approval answered {ok}"
    assert asked.fired and asked.result == 2, f"when decide touched the chain, eligibility had answered {asked.result} of 2 questions: verify first, then record"
`,
    typescript: `const KEY = 'approval:r-1:state';

async function client(ctx) {
  const people = new Map<string, {active: boolean; eligible: boolean; delegated_to: string}>();
  const pkg = ctx.proto('approval_workflow.proto');
  ctx.grpc.serve(pkg.approvalwf.Eligibility.service, {
    CheckEligibility(call, callback) {
      callback(null, people.get(call.request.actor) ?? {active: true, eligible: true, delegated_to: ''});
    },
  });
  await ctx.load('/support/approvals/chain.ts').startChain('r-1', ['u-mgr', 'u-dir']);
  return {m: ctx.load('client'), people};
}

function denied(ctx, outcome, reason: string, why: string): void {
  assert(outcome.status === 'denied' && outcome.reason === reason, \`\${why}: decide answered \${JSON.stringify(outcome)}, expected status denied with reason \${reason}\`);
  assert.equal(outcome.advanced, false, \`\${why}: a denied decision answered advanced \${outcome.advanced}\`);
  const f = ctx.redis.hgetall(KEY);
  assert(f.step_index === '0' && f['decision:0'] === undefined, \`\${why}: the denied decision still moved the chain: \${JSON.stringify(f)}\`);
}

export async function check_deadline(ctx) {
  const {m} = await client(ctx);
  const ok = await m.decide('r-1', 0, 'u-mgr', 'approved');
  assert.equal(ok.advanced, true, \`with the eligibility service healthy the manager's approval answered \${JSON.stringify(ok)}\`);
  const calls = ctx.grpc.callsTo('CheckEligibility');
  assert(calls.length > 0, 'decide made no CheckEligibility call');
  for (const call of calls) {
    assert(call.timeout !== null, 'a CheckEligibility call carries no deadline: a hung eligibility service holds the approval open');
    assert(0.5 <= call.timeout && call.timeout <= 1.5, \`a CheckEligibility call carries a \${call.timeout} s deadline, expected 1 s\`);
  }
  ctx.grpc.setLatency('CheckEligibility', 30);
  const before = ctx.clock.now();
  const late = await m.decide('r-1', 1, 'u-dir', 'approved');
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 3, \`decide waited \${waited.toFixed(0)} s on a hung eligibility service: each attempt gets 1 s\`);
  assert(late.status === 'denied' && late.reason === 'eligibility_unverified', \`with the eligibility service hung the director's approval answered \${JSON.stringify(late)}, expected a denial\`);
  assert.equal(ctx.redis.hget(KEY, 'step_index'), '1', 'a decision eligibility never confirmed moved the chain');
}

export async function check_fail_closed(ctx) {
  const {m} = await client(ctx);
  ctx.grpc.fail('CheckEligibility', ctx.grpc.status.UNAVAILABLE, 'eligibility is down', 2);
  denied(ctx, await m.decide('r-1', 0, 'u-mgr', 'approved'), 'eligibility_unverified', 'with the eligibility service down');
  const attempts = ctx.grpc.callsTo('CheckEligibility').length;
  assert.equal(attempts, 2, \`decide called CheckEligibility \${attempts} times on an outage, expected MAX_ATTEMPTS = 2\`);
  ctx.grpc.fail('CheckEligibility', ctx.grpc.status.PERMISSION_DENIED, 'caller not allowed', 1);
  denied(ctx, await m.decide('r-1', 0, 'u-mgr', 'approved'), 'eligibility_unverified', 'with CheckEligibility refused (PERMISSION_DENIED)');
  assert.equal(ctx.grpc.callsTo('CheckEligibility').length, 3, 'a PERMISSION_DENIED is not retried');
}

export async function check_departed_approver(ctx) {
  const {m, people} = await client(ctx);
  people.set('u-mgr', {active: false, eligible: true, delegated_to: ''});
  denied(ctx, await m.decide('r-1', 0, 'u-mgr', 'approved'), 'approver_departed', 'with the manager marked inactive');
}

export async function check_delegation(ctx) {
  const {m, people} = await client(ctx);
  people.set('u-mgr', {active: true, eligible: true, delegated_to: 'u-deputy'});
  denied(ctx, await m.decide('r-1', 0, 'u-mgr', 'approved'), 'delegation_mismatch', "with the manager's approvals delegated to u-deputy");
  people.set('u-mgr', {active: true, eligible: true, delegated_to: 'u-mgr'});
  const ok = await m.decide('r-1', 0, 'u-mgr', 'approved');
  assert.equal(ok.advanced, true, \`a delegated_to naming the actor themselves is no hand-off, but decide answered \${JSON.stringify(ok)}\`);
}

export async function check_verify_first(ctx) {
  const {m, people} = await client(ctx);
  people.set('u-mgr', {active: true, eligible: false, delegated_to: ''});
  denied(ctx, await m.decide('r-1', 0, 'u-mgr', 'approved'), 'approver_ineligible', 'with the manager not eligible for this request');
  people.clear();
  const asked = ctx.redisAfter(KEY, () => ctx.grpc.callsTo('CheckEligibility').length);
  const ok = await m.decide('r-1', 0, 'u-mgr', 'approved');
  assert.equal(ok.advanced, true, \`with the manager eligible again the approval answered \${JSON.stringify(ok)}\`);
  assert(asked.fired && asked.result === 2, \`when decide touched the chain, eligibility had answered \${asked.result} of 2 questions: verify first, then record\`);
}
`,
    go: `package main

import (
	"context"

	"google.golang.org/grpc/codes"

	"approvals/chain"
	pb "approvals/gen/approval_workflow"

	"leetbuild/harness"
)

var clientBg = context.Background()

const clientKey = "approval:r-1:state"

// directoryPeer is the HR directory behind the eligibility service: everybody is active and
// eligible unless listed in people.
type directoryPeer struct {
	pb.UnimplementedEligibilityServer
	people map[string]*pb.EligibilityReply
}

func (d *directoryPeer) CheckEligibility(_ context.Context, req *pb.EligibilityRequest) (*pb.EligibilityReply, error) {
	if reply, ok := d.people[req.GetActor()]; ok {
		return reply, nil
	}
	return &pb.EligibilityReply{Active: true, Eligible: true}, nil
}

func clientSetup(ctx *harness.Ctx) *directoryPeer {
	directory := &directoryPeer{people: map[string]*pb.EligibilityReply{}}
	pb.RegisterEligibilityServer(ctx.GRPC.Server(""), directory)
	ctx.NoError(chain.StartChain(clientBg, "r-1", []string{"u-mgr", "u-dir"}), "chain.StartChain(r-1)")
	return directory
}

func clientDecide(ctx *harness.Ctx, step int, actor string) chain.Outcome {
	o, err := decide(clientBg, "r-1", step, actor, "approved")
	ctx.NoError(err, "decide(r-1, %d, %s)", step, actor)
	return o
}

func clientDenied(ctx *harness.Ctx, o chain.Outcome, reason, why string) {
	ctx.Assert(o.Status == "denied" && o.Reason == reason, "%s: decide answered %+v, expected status denied with reason %q", why, o, reason)
	ctx.Assert(!o.Advanced, "%s: a denied decision answered advanced true", why)
	f := ctx.Redis.HGetAll(clientKey)
	_, decided := f["decision:0"]
	ctx.Assert(f["step_index"] == "0" && !decided, "%s: the denied decision still moved the chain: %v", why, f)
}

func CheckDeadline(ctx *harness.Ctx) {
	clientSetup(ctx)
	ok := clientDecide(ctx, 0, "u-mgr")
	ctx.Assert(ok.Advanced, "with the eligibility service healthy the manager's approval answered %+v", ok)
	calls := ctx.GRPC.CallsTo("CheckEligibility", "")
	ctx.Assert(len(calls) > 0, "decide made no CheckEligibility call")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "a CheckEligibility call carries no deadline: a hung eligibility service holds the approval open")
		ctx.Assert(call.Timeout.Seconds() >= 0.5 && call.Timeout.Seconds() <= 1.5, "a CheckEligibility call carries a %v deadline, expected 1 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("CheckEligibility", 30, "")
	before := ctx.Clock.Now()
	late := clientDecide(ctx, 1, "u-dir")
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 3, "decide waited %.0f s on a hung eligibility service: each attempt gets 1 s", waited)
	ctx.Assert(late.Status == "denied" && late.Reason == "eligibility_unverified", "with the eligibility service hung the director's approval answered %+v, expected a denial", late)
	index, _ := ctx.Redis.HGet(clientKey, "step_index")
	ctx.Equal(index, "1", "a decision eligibility never confirmed must not move the chain; step_index")
}

func CheckFailClosed(ctx *harness.Ctx) {
	clientSetup(ctx)
	ctx.GRPC.Fail("CheckEligibility", codes.Unavailable, "eligibility is down", 2, "")
	clientDenied(ctx, clientDecide(ctx, 0, "u-mgr"), "eligibility_unverified", "with the eligibility service down")
	ctx.Equal(len(ctx.GRPC.CallsTo("CheckEligibility", "")), 2, "on an outage decide must stop after MAX_ATTEMPTS; the CheckEligibility calls")
	ctx.GRPC.Fail("CheckEligibility", codes.PermissionDenied, "caller not allowed", 1, "")
	clientDenied(ctx, clientDecide(ctx, 0, "u-mgr"), "eligibility_unverified", "with CheckEligibility refused (PERMISSION_DENIED)")
	ctx.Equal(len(ctx.GRPC.CallsTo("CheckEligibility", "")), 3, "a PERMISSION_DENIED is not retried; the CheckEligibility calls")
}

func CheckDepartedApprover(ctx *harness.Ctx) {
	directory := clientSetup(ctx)
	directory.people["u-mgr"] = &pb.EligibilityReply{Active: false, Eligible: true}
	clientDenied(ctx, clientDecide(ctx, 0, "u-mgr"), "approver_departed", "with the manager marked inactive")
}

func CheckDelegation(ctx *harness.Ctx) {
	directory := clientSetup(ctx)
	directory.people["u-mgr"] = &pb.EligibilityReply{Active: true, Eligible: true, DelegatedTo: "u-deputy"}
	clientDenied(ctx, clientDecide(ctx, 0, "u-mgr"), "delegation_mismatch", "with the manager's approvals delegated to u-deputy")
	directory.people["u-mgr"] = &pb.EligibilityReply{Active: true, Eligible: true, DelegatedTo: "u-mgr"}
	ok := clientDecide(ctx, 0, "u-mgr")
	ctx.Assert(ok.Advanced, "a delegated_to naming the actor themselves is no hand-off, but decide answered %+v", ok)
}

func CheckVerifyFirst(ctx *harness.Ctx) {
	directory := clientSetup(ctx)
	directory.people["u-mgr"] = &pb.EligibilityReply{Active: true, Eligible: false}
	clientDenied(ctx, clientDecide(ctx, 0, "u-mgr"), "approver_ineligible", "with the manager not eligible for this request")
	delete(directory.people, "u-mgr")
	asked := ctx.Redis.After(clientKey, func() any { return len(ctx.GRPC.CallsTo("CheckEligibility", "")) })
	ok := clientDecide(ctx, 0, "u-mgr")
	ctx.Assert(ok.Advanced, "with the manager eligible again the approval answered %+v", ok)
	ctx.Assert(asked.Fired && asked.Result == 2, "when decide touched the chain, eligibility had answered %v of 2 questions: verify first, then record", asked.Result)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <memory>
#include <string>

#include "approval_workflow.grpc.pb.h"
#include "approvals/chain.h"

namespace {

const std::string kClientKey = "approval:r-1:state";

// The HR directory behind the eligibility service: everybody is active and eligible unless listed in people.
class DirectoryPeer final : public approvalwf::Eligibility::Service {
 public:
  std::map<std::string, approvalwf::EligibilityReply> people;
  grpc::Status CheckEligibility(grpc::ServerContext*, const approvalwf::EligibilityRequest* req, approvalwf::EligibilityReply* out) override {
    const auto found = people.find(req->actor());
    if (found != people.end()) {
      *out = found->second;
    } else {
      out->set_active(true);
      out->set_eligible(true);
    }
    return grpc::Status::OK;
  }
};

approvalwf::EligibilityReply person(bool active, bool eligible, const std::string& delegated_to) {
  approvalwf::EligibilityReply reply;
  reply.set_active(active);
  reply.set_eligible(eligible);
  reply.set_delegated_to(delegated_to);
  return reply;
}

DirectoryPeer& clientSetup(harness::Ctx& ctx) {
  static DirectoryPeer* directory = nullptr;
  delete directory;
  directory = new DirectoryPeer;
  ctx.GRPC.Server("")->RegisterService(directory);
  chain::startChain("r-1", {"u-mgr", "u-dir"});
  return *directory;
}

std::string show(const chain::Outcome& o) {
  return "{advanced " + std::string(o.advanced ? "true" : "false") + ", step_index " + std::to_string(o.step_index) + ", status " + o.status + ", reason " + o.reason + "}";
}

void clientDenied(harness::Ctx& ctx, const chain::Outcome& o, const std::string& reason, const std::string& why) {
  ctx.Assert(o.status == "denied" && o.reason == reason, "%s: decide answered %s, expected status denied with reason %q", why, show(o), reason);
  ctx.Assert(!o.advanced, "%s: a denied decision answered advanced true", why);
  auto f = ctx.Redis.HGetAll(kClientKey);
  ctx.Assert(f["step_index"] == "0" && f.count("decision:0") == 0, "%s: the denied decision still moved the chain: %v", why, f);
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  clientSetup(ctx);
  const chain::Outcome ok = decide("r-1", 0, "u-mgr", "approved");
  ctx.Assert(ok.advanced, "with the eligibility service healthy the manager's approval answered %s", show(ok));
  const auto calls = ctx.GRPC.CallsTo("CheckEligibility");
  ctx.Assert(!calls.empty(), "decide made no CheckEligibility call");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "a CheckEligibility call carries no deadline: a hung eligibility service holds the approval open");
    ctx.Assert(0.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 1.5, "a CheckEligibility call carries a %v s deadline, expected 1 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("CheckEligibility", 30.0);
  const int64_t before = ctx.Clock.Now();
  const chain::Outcome late = decide("r-1", 1, "u-dir", "approved");
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 3, "decide waited %.0f s on a hung eligibility service: each attempt gets 1 s", waited);
  ctx.Assert(late.status == "denied" && late.reason == "eligibility_unverified", "with the eligibility service hung the director's approval answered %s, expected a denial", show(late));
  ctx.Equal(ctx.Redis.HGet(kClientKey, "step_index"), std::optional<std::string>("1"), "a decision eligibility never confirmed must not move the chain; step_index");
}

void CheckFailClosed(harness::Ctx& ctx) {
  clientSetup(ctx);
  ctx.GRPC.Fail("CheckEligibility", grpc::StatusCode::UNAVAILABLE, "eligibility is down", 2);
  clientDenied(ctx, decide("r-1", 0, "u-mgr", "approved"), "eligibility_unverified", "with the eligibility service down");
  ctx.Equal(ctx.GRPC.CallsTo("CheckEligibility").size(), 2, "on an outage decide must stop after MAX_ATTEMPTS; the CheckEligibility calls");
  ctx.GRPC.Fail("CheckEligibility", grpc::StatusCode::PERMISSION_DENIED, "caller not allowed", 1);
  clientDenied(ctx, decide("r-1", 0, "u-mgr", "approved"), "eligibility_unverified", "with CheckEligibility refused (PERMISSION_DENIED)");
  ctx.Equal(ctx.GRPC.CallsTo("CheckEligibility").size(), 3, "a PERMISSION_DENIED is not retried; the CheckEligibility calls");
}

void CheckDepartedApprover(harness::Ctx& ctx) {
  DirectoryPeer& directory = clientSetup(ctx);
  directory.people["u-mgr"] = person(false, true, "");
  clientDenied(ctx, decide("r-1", 0, "u-mgr", "approved"), "approver_departed", "with the manager marked inactive");
}

void CheckDelegation(harness::Ctx& ctx) {
  DirectoryPeer& directory = clientSetup(ctx);
  directory.people["u-mgr"] = person(true, true, "u-deputy");
  clientDenied(ctx, decide("r-1", 0, "u-mgr", "approved"), "delegation_mismatch", "with the manager's approvals delegated to u-deputy");
  directory.people["u-mgr"] = person(true, true, "u-mgr");
  const chain::Outcome ok = decide("r-1", 0, "u-mgr", "approved");
  ctx.Assert(ok.advanced, "a delegated_to naming the actor themselves is no hand-off, but decide answered %s", show(ok));
}

void CheckVerifyFirst(harness::Ctx& ctx) {
  DirectoryPeer& directory = clientSetup(ctx);
  directory.people["u-mgr"] = person(true, false, "");
  clientDenied(ctx, decide("r-1", 0, "u-mgr", "approved"), "approver_ineligible", "with the manager not eligible for this request");
  directory.people.clear();
  auto asked = std::make_shared<long>(-1);
  ctx.Redis.After(kClientKey, [&ctx, asked] { *asked = static_cast<long>(ctx.GRPC.CallsTo("CheckEligibility").size()); });
  const chain::Outcome ok = decide("r-1", 0, "u-mgr", "approved");
  ctx.Assert(ok.advanced, "with the manager eligible again the approval answered %s", show(ok));
  ctx.Equal(*asked, 2, "verify first, then record: the CheckEligibility calls answered when decide touched the chain");
}
`,
  },
  debrief: `The gate has two jobs, and the order is one of them: a decision that is recorded before it is verified cannot be taken back by the verification, which is why \`verify_eligibility\` runs first and \`chain.advance\` only on a yes. The other job is to treat silence as a no. A deadline turns a hung directory into an answer within seconds, and the retry budget only covers the two codes that say nothing about the person (deadline, unavailable); every other path ends in a denial with a reason someone can act on. Production approval systems cache recent eligibility answers for a short time to ride out a blip, and alert on the rate of \`eligibility_unverified\` denials, since a steady stream of them is an outage nobody else sees.`,
};
