import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Vendor calls that queue for humans instead of auto-approving',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'vendor', 'review', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the KYC service’s vendor
client: it calls the vendor’s \`CheckDocument\` and moves the case along, and against a healthy vendor
the demo verifies applicants and the funnel stays open. It hides three production flaws, and all
three look like features on a conversion dashboard. Review it like the compliance owner, fix it, and
prove the fix with the checks below.

Implement \`check_document(applicant, doc_type, ref)\` — the gRPC call that decides one document — and
the paths around it:

- The \`CheckDocument\` call carries a **10 s** deadline as a named constant on the call itself
  (\`DEADLINE_S = 10\` with \`timeout=DEADLINE_S\`, \`DEADLINE_MS = 10_000\` with
  \`deadline: Date.now() + DEADLINE_MS\`, a \`context.WithTimeout\`, a \`withDeadlineAfter\`, a
  \`set_deadline\`): with no deadline, one stuck vendor pins a verification request until the client
  gives up.
- The vendor answers **\`APPROVED\`**, **\`REJECTED\`** or **\`MANUAL_REVIEW\`**, and nothing else counts
  as an approval — the vendor’s own \`MANUAL_REVIEW\`, and any outcome you cannot classify, is a
  human’s call.
- A **timeout or a vendor error** — \`DEADLINE_EXCEEDED\`, \`UNAVAILABLE\`, anything else — routes the
  case to **manual review** with a **\`degraded\`** marker: identity is a legal decision, and an
  outage is not a verification. No path from a vendor failure to \`APPROVED\` without a human.
- A **rejection is terminal**: it carries the vendor’s **reason**, and the case ends there. The same
  documents buy the same answer, so a second call only adds latency.
- The outcome — decision, reason and the \`degraded\` flag — is **persisted to the decision store**
  before \`check_document\` returns, so the case record cannot disagree with what the vendor said.

**Failure mode the checks target.** The draft keeps conversion up three ways: it approves on a
timeout, so a vendor outage silently verifies identities nobody checked; it returns \`VERIFIED\` from
its catch block, so a bad deployment mints approved applicants; and it re-calls the vendor after a
\`REJECTED\` to “give it another chance”, so the applicant whose documents are wrong is approved when
the loop runs out. Every one of those is invisible while the vendor is healthy — the demo never sees
a timeout, an error or a rejection — and every one of them is a finding in production.`,
  sequence: {
    participants: ['KYC API', 'Vendor', 'Review queue', 'Decision store'],
    messages: [
      {from: 'KYC API', to: 'Vendor', label: 'CheckDocument · deadline 10 s', kind: 'sync'},
      {from: 'Vendor', to: 'KYC API', label: 'APPROVED / REJECTED · reason', kind: 'reply'},
      {from: 'KYC API', to: 'Decision store', label: 'put(applicant, outcome, reason, degraded = false)', kind: 'sync'},
      {from: 'Vendor', to: 'KYC API', label: 'DEADLINE_EXCEEDED / UNAVAILABLE', kind: 'reply'},
      {from: 'KYC API', to: 'KYC API', label: 'no verdict → MANUAL_REVIEW · degraded', kind: 'sync'},
      {from: 'KYC API', to: 'Review queue', label: 'enqueue(applicant) · degraded', kind: 'async'},
      {from: 'KYC API', to: 'Decision store', label: 'put(applicant, MANUAL_REVIEW, degraded = true)', kind: 'sync'},
      {from: 'Decision store', to: 'KYC API', label: 'stored', kind: 'reply'},
    ],
  },
  hints: [
    'A deadline is an argument on the call itself — `timeout=`, `deadline: Date.now() + DEADLINE_MS`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline` — not a wrapper around it. The draft calls `CheckDocument` bare, so one stuck vendor holds the verification request (and the worker behind it) open until the client gives up.',
    'Failure is a statement about the system, not about the applicant: catch the RPC error, classify `DEADLINE_EXCEEDED`, `UNAVAILABLE` or anything else as “the vendor did not answer”, write `MANUAL_REVIEW` with `degraded` set, and enqueue the case for a reviewer. The draft answers `APPROVED`/`VERIFIED`, which is the one outcome a failure can never justify.',
    'A `REJECTED` is terminal: keep the vendor’s `reason`, persist it, and stop — the same documents would be rejected the same way, so a second call buys latency and, in the draft, an approval. Persist every outcome to the decision store before returning it, so the case record and the vendor’s answer can never disagree.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every vendor call carries a 10-second deadline',
      detail:
        '`CheckDocument` is invoked with a **10 s** deadline: `DEADLINE_S = 10` and `timeout=DEADLINE_S` (Python), `DEADLINE_MS = 10_000` and `deadline: Date.now() + DEADLINE_MS` (TypeScript), `context.WithTimeout(ctx, vendorDeadline)` (Go), `withDeadlineAfter(VendorDeadlineSeconds, TimeUnit.SECONDS)` (Scala), `ctx.set_deadline(… std::chrono::milliseconds(kVendorDeadlineMs))` (C++). The draft calls the vendor with no deadline at all.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*10/, /timeout=DEADLINE_S/, /CheckDocument/]},
        typescript: {
          all: [/DEADLINE_MS\s*=\s*(10000|10_000)/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /CheckDocument/],
        },
        go: {all: [/(vendorDeadline|10\s*\*\s*time\.Second)/, /context\.WithTimeout/, /CheckDocument/]},
        scala: {all: [/(VendorDeadline|DeadlineSeconds\s*=\s*10)/, /withDeadlineAfter/, /CheckDocument/]},
        cpp: {all: [/(kVendorDeadlineMs|kDeadlineMs|10000)/, /set_deadline\(/, /CheckDocument/]},
      },
    },
    {
      id: 'timeout-manual',
      title: 'A timeout lands in manual review marked degraded',
      detail:
        'The failure path writes `MANUAL_REVIEW` with a `degraded` marker — a timeout means a human has to look, and the marker tells the queue the vendor was unhealthy when the case arrived. The draft has neither: its timeout path returns `APPROVED`/`VERIFIED` to protect conversion.',
      match: {
        python: {all: [/MANUAL_REVIEW/, /degraded/]},
        typescript: {all: [/MANUAL_REVIEW/, /degraded/]},
        go: {all: [/MANUAL_REVIEW/, /degraded/]},
        scala: {all: [/MANUAL_REVIEW/, /degraded/]},
        cpp: {all: [/MANUAL_REVIEW/, /degraded/]},
      },
    },
    {
      id: 'rejection-terminal',
      title: 'A rejection is terminal and carries the vendor reason',
      detail:
        'A `REJECTED` ends the case with the vendor’s `reason`; the word *retry* never appears in the client, because a second call with the same documents buys the same rejection. The draft loops on `REJECTED` and approves the applicant when the loop runs out.',
      match: {
        python: {all: [/REJECTED/, /reason/], none: [/\bretry/i]},
        typescript: {all: [/REJECTED/, /reason/], none: [/\bretry/i]},
        go: {all: [/REJECTED/, /reason/], none: [/\bretry/i]},
        scala: {all: [/REJECTED/, /reason/], none: [/\bretry/i]},
        cpp: {all: [/REJECTED/, /reason/], none: [/\bretry/i]},
      },
    },
    {
      id: 'error-manual',
      title: 'A vendor error never becomes approved',
      detail:
        'Any RPC error — `UNAVAILABLE`, `DEADLINE_EXCEEDED`, anything else — becomes `MANUAL_REVIEW`, and `VERIFIED` appears nowhere in the client. The draft writes `VERIFIED` in its catch block, so a bad deployment approves applicants nobody checked.',
      match: {
        python: {all: [/MANUAL_REVIEW/, /UNAVAILABLE|DEADLINE_EXCEEDED/], none: [/VERIFIED/]},
        typescript: {all: [/MANUAL_REVIEW/, /UNAVAILABLE|DEADLINE_EXCEEDED/], none: [/VERIFIED/]},
        go: {all: [/MANUAL_REVIEW/, /UNAVAILABLE|DEADLINE_EXCEEDED/], none: [/VERIFIED/]},
        scala: {all: [/MANUAL_REVIEW/, /UNAVAILABLE|DEADLINE_EXCEEDED/], none: [/VERIFIED/]},
        cpp: {all: [/MANUAL_REVIEW/, /UNAVAILABLE|DEADLINE_EXCEEDED/], none: [/VERIFIED/]},
      },
    },
    {
      id: 'stub-call',
      title: 'Calls CheckDocument on the vendor stub',
      detail:
        'The vendor stub’s `CheckDocument` is the only way a case gets a verdict, and the draft already calls it — so this check passes on the starter. It is here to pin the call site that the rest of the step hardens.',
      match: {
        python: {all: [/CheckDocument/]},
        typescript: {all: [/CheckDocument/]},
        go: {all: [/CheckDocument/]},
        scala: {all: [/CheckDocument/]},
        cpp: {all: [/CheckDocument/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Vendor document checks: a model-generated draft that keeps conversion up."""
import asyncio

import grpc
import grpc.aio

import vendor_pb2
import vendor_pb2_grpc

APPROVED = "APPROVED"
REJECTED = "REJECTED"
VERIFIED = "VERIFIED"

vendor = vendor_pb2_grpc.VendorStub(grpc.aio.insecure_channel("vendor:9000"))


async def check_document(decisions, applicant: str, doc_type: str, ref: str) -> str:
    # TODO: give the CheckDocument call the 10 s deadline, route a timeout or a vendor error to
    # manual review marked degraded, keep a rejection terminal with the vendor's reason, and persist
    # the outcome to the decision store — the draft approves the applicant instead.
    for retry in range(3):
        try:
            request = vendor_pb2.CheckDocumentRequest(applicant=applicant, doc_type=doc_type, ref=ref)
            reply = await vendor.CheckDocument(request)
        except grpc.RpcError:
            await decisions.put(applicant, VERIFIED, "vendor unavailable")
            return VERIFIED
        if reply.outcome == REJECTED:
            await asyncio.sleep(1)  # the documents must have been wrong: send them through again
            continue
        await decisions.put(applicant, APPROVED, reply.reason)
        return APPROVED
    await decisions.put(applicant, APPROVED, "no rejection after three calls")
    return APPROVED
`,
      solution: `"""Vendor document checks: a 10 s deadline, and a human on every failure."""
import logging

import grpc
import grpc.aio

import vendor_pb2
import vendor_pb2_grpc

DEADLINE_S = 10

APPROVED = "APPROVED"
REJECTED = "REJECTED"
MANUAL_REVIEW = "MANUAL_REVIEW"

logger = logging.getLogger("kycd.vendor")

vendor = vendor_pb2_grpc.VendorStub(grpc.aio.insecure_channel("vendor:9000"))


class VendorDecision:
    """What the vendor decided, or the fact that nobody decided yet."""

    def __init__(self, outcome: str, reason: str | None = None, degraded: bool = False) -> None:
        self.outcome = outcome
        self.reason = reason
        self.degraded = degraded


def failure_reason(exc: grpc.RpcError) -> str:
    """DEADLINE_EXCEEDED and UNAVAILABLE read the same to a reviewer: the vendor did not answer."""
    if exc.code() in (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE):
        return "vendor did not answer within the deadline"
    return f"vendor error: {exc.details()}"


async def persist(decisions, applicant: str, decision: VendorDecision) -> VendorDecision:
    """The decision store is the case record: the outcome is written before anyone reads it."""
    await decisions.put(applicant, decision.outcome, reason=decision.reason, degraded=decision.degraded)
    return decision


async def check_document(decisions, applicant: str, doc_type: str, ref: str) -> VendorDecision:
    """Check one document. A vendor that cannot answer sends the case to a human, marked degraded."""
    request = vendor_pb2.CheckDocumentRequest(applicant=applicant, doc_type=doc_type, ref=ref)
    try:
        reply = await vendor.CheckDocument(request, timeout=DEADLINE_S)
    except grpc.RpcError as exc:
        logger.warning("vendor call failed applicant=%s code=%s", applicant, exc.code().name)
        return await persist(decisions, applicant, VendorDecision(MANUAL_REVIEW, failure_reason(exc), degraded=True))
    if reply.outcome == REJECTED:
        # Terminal: the vendor asked for different documents, and the same ones buy the same answer.
        return await persist(decisions, applicant, VendorDecision(REJECTED, reply.reason))
    if reply.outcome == APPROVED:
        return await persist(decisions, applicant, VendorDecision(APPROVED, reply.reason))
    # Anything else — including the vendor's own MANUAL_REVIEW — is a reviewer's call.
    return await persist(decisions, applicant, VendorDecision(MANUAL_REVIEW, reply.reason))
`,
    },
    typescript: {
      starter: `/** Vendor document checks: a model-generated draft that keeps conversion up. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const APPROVED = 'APPROVED';
const REJECTED = 'REJECTED';
const VERIFIED = 'VERIFIED';

interface DecisionStore {
  put(applicant: string, outcome: string, reason: string): Promise<void>;
}

interface VendorClient {
  CheckDocument(
    request: {applicant: string; docType: string; ref: string},
    callback: (error: grpc.ServiceError | null, reply: {outcome: string; reason: string}) => void,
  ): grpc.ClientUnaryCall;
}

const {vendor: vendorProto} = grpc.loadPackageDefinition(protoLoader.loadSync('vendor.proto')) as unknown as {
  vendor: {Vendor: new (target: string, credentials: grpc.ChannelCredentials) => VendorClient};
};
const vendor = new vendorProto.Vendor('vendor:9000', grpc.credentials.createInsecure());

export async function checkDocument(
  decisions: DecisionStore,
  applicant: string,
  docType: string,
  ref: string,
): Promise<string> {
  // TODO: give the CheckDocument call the 10 s deadline, route a timeout or a vendor error to
  // manual review marked degraded, keep a rejection terminal with the vendor's reason, and persist
  // the outcome to the decision store — the draft approves the applicant instead.
  for (let retry = 0; retry < 3; retry++) {
    try {
      const reply = await new Promise<{outcome: string; reason: string}>((resolve, reject) => {
        vendor.CheckDocument({applicant, docType, ref}, (error, value) => (error ? reject(error) : resolve(value)));
      });
      if (reply.outcome === REJECTED) continue; // the documents must have been wrong: send them again
      await decisions.put(applicant, APPROVED, reply.reason);
      return APPROVED;
    } catch {
      await decisions.put(applicant, VERIFIED, 'vendor unavailable');
      return VERIFIED;
    }
  }
  await decisions.put(applicant, APPROVED, 'no rejection after three calls');
  return APPROVED;
}
`,
      solution: `/** Vendor document checks: a 10 s deadline, and a human on every failure. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 10_000;

const APPROVED = 'APPROVED';
const REJECTED = 'REJECTED';
const MANUAL_REVIEW = 'MANUAL_REVIEW';

/** What the vendor decided, or the fact that nobody decided yet. */
export interface DocumentDecision {
  outcome: string;
  reason: string | null;
  degraded: boolean;
}

interface DecisionStore {
  put(applicant: string, decision: DocumentDecision): Promise<void>;
}

interface VendorClient {
  CheckDocument(
    request: {applicant: string; docType: string; ref: string},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply: {outcome: string; reason: string}) => void,
  ): grpc.ClientUnaryCall;
}

const {vendor: vendorProto} = grpc.loadPackageDefinition(protoLoader.loadSync('vendor.proto')) as unknown as {
  vendor: {Vendor: new (target: string, credentials: grpc.ChannelCredentials) => VendorClient};
};
const vendor = new vendorProto.Vendor('vendor:9000', grpc.credentials.createInsecure());

/** DEADLINE_EXCEEDED and UNAVAILABLE read the same to a reviewer: the vendor did not answer. */
function failureReason(error: grpc.ServiceError): string {
  if (error.code === grpc.status.DEADLINE_EXCEEDED || error.code === grpc.status.UNAVAILABLE) {
    return 'vendor did not answer within the deadline';
  }
  return \`vendor error: \${error.details}\`;
}

function checkOnce(request: {
  applicant: string;
  docType: string;
  ref: string;
}): Promise<{outcome: string; reason: string}> {
  return new Promise((resolve, reject) => {
    vendor.CheckDocument(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS}, (error, reply) =>
      error ? reject(error) : resolve(reply),
    );
  });
}

async function persist(
  decisions: DecisionStore,
  applicant: string,
  decision: DocumentDecision,
): Promise<DocumentDecision> {
  await decisions.put(applicant, decision);
  return decision;
}

/** Check one document. A vendor that cannot answer sends the case to a human, marked degraded. */
export async function checkDocument(
  decisions: DecisionStore,
  applicant: string,
  docType: string,
  ref: string,
): Promise<DocumentDecision> {
  let reply: {outcome: string; reason: string};
  try {
    reply = await checkOnce({applicant, docType, ref});
  } catch (error) {
    return persist(decisions, applicant, {
      outcome: MANUAL_REVIEW,
      reason: failureReason(error as grpc.ServiceError),
      degraded: true,
    });
  }
  if (reply.outcome === REJECTED) {
    // Terminal: the vendor asked for different documents, and the same ones buy the same answer.
    return persist(decisions, applicant, {outcome: REJECTED, reason: reply.reason, degraded: false});
  }
  if (reply.outcome === APPROVED) {
    return persist(decisions, applicant, {outcome: APPROVED, reason: reply.reason, degraded: false});
  }
  // Anything else — including the vendor's own MANUAL_REVIEW — is a reviewer's call.
  return persist(decisions, applicant, {outcome: MANUAL_REVIEW, reason: reply.reason, degraded: false});
}
`,
    },
    go: {
      starter: `package client

import (
	"context"
	"time"

	pb "kycd/vendorpb"
)

const verified = "VERIFIED"

// DecisionStore is the cases table the outcome is written to.
type DecisionStore interface {
	Put(ctx context.Context, applicant, outcome, reason string) error
}

type Client struct {
	vendor    pb.VendorClient
	decisions DecisionStore
}

// CheckDocument asks the vendor and moves the case along, so a vendor hiccup never blocks an
// applicant.
func (c *Client) CheckDocument(ctx context.Context, applicant, docType, ref string) (string, error) {
	// TODO: give the CheckDocument call the 10 s deadline, route a timeout or a vendor error to
	// manual review marked degraded, keep a rejection terminal with the vendor's reason, and persist
	// the outcome to the decision store — the draft approves the applicant instead.
	for retry := 0; retry < 3; retry++ {
		reply, err := c.vendor.CheckDocument(ctx, &pb.CheckDocumentRequest{
			Applicant: applicant,
			DocType:   docType,
			Ref:       ref,
		})
		if err != nil {
			if perr := c.decisions.Put(ctx, applicant, verified, "vendor unavailable"); perr != nil {
				return "", perr
			}
			return verified, nil
		}
		if reply.Outcome == "REJECTED" {
			time.Sleep(500 * time.Millisecond) // the documents must have been wrong: send them again
			continue
		}
		if perr := c.decisions.Put(ctx, applicant, "APPROVED", reply.Reason); perr != nil {
			return "", perr
		}
		return "APPROVED", nil
	}
	if perr := c.decisions.Put(ctx, applicant, "APPROVED", "no rejection after three calls"); perr != nil {
		return "", perr
	}
	return "APPROVED", nil
}
`,
      solution: `package client

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "kycd/vendorpb"
)

// vendorDeadline is the only deadline a document check ever gets: one call, ten seconds.
const vendorDeadline = 10 * time.Second

const (
	OutcomeApproved     = "APPROVED"
	OutcomeRejected     = "REJECTED"
	OutcomeManualReview = "MANUAL_REVIEW"
)

// Decision is the vendor's answer as the decision store records it.
type Decision struct {
	Outcome  string \`json:"outcome"\`
	Reason   string \`json:"reason"\`
	Degraded bool   \`json:"degraded"\`
}

// DecisionStore is the cases table: every outcome is persisted before it is returned.
type DecisionStore interface {
	Put(ctx context.Context, applicant string, decision Decision) error
}

type Client struct {
	vendor    pb.VendorClient
	decisions DecisionStore
}

// vendorSilent maps the two statuses that mean the vendor never answered to the labels the
// vendor_failure metric records.
var vendorSilent = map[codes.Code]string{
	codes.DeadlineExceeded: "DEADLINE_EXCEEDED",
	codes.Unavailable:      "UNAVAILABLE",
}

// failureReason turns a failed call into the reason a reviewer reads: a vendor that times out or
// errors has not decided, and has certainly not approved anybody.
func failureReason(err error) string {
	code := status.Code(err)
	if label, silent := vendorSilent[code]; silent {
		return "vendor did not answer: " + label
	}
	return "vendor error: " + status.Convert(err).Message()
}

// CheckDocument checks one document; a vendor that cannot answer queues a human, marked degraded.
func (c *Client) CheckDocument(ctx context.Context, applicant, docType, ref string) (Decision, error) {
	callCtx, cancel := context.WithTimeout(ctx, vendorDeadline)
	defer cancel()
	reply, err := c.vendor.CheckDocument(callCtx, &pb.CheckDocumentRequest{
		Applicant: applicant,
		DocType:   docType,
		Ref:       ref,
	})
	var decision Decision
	switch {
	case err != nil:
		decision = Decision{Outcome: OutcomeManualReview, Reason: failureReason(err), Degraded: true}
	case reply.Outcome == OutcomeRejected:
		// Terminal: the vendor asked for different documents, and the same ones buy the same answer.
		decision = Decision{Outcome: OutcomeRejected, Reason: reply.Reason}
	case reply.Outcome == OutcomeApproved:
		decision = Decision{Outcome: OutcomeApproved, Reason: reply.Reason}
	default:
		// Anything else — including the vendor's own MANUAL_REVIEW — is a reviewer's call.
		decision = Decision{Outcome: OutcomeManualReview, Reason: reply.Reason}
	}
	if err := c.decisions.Put(ctx, applicant, decision); err != nil {
		return Decision{}, err
	}
	return decision, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

object VendorClient {
  val Verified = "VERIFIED"

  trait Decisions {
    def put(applicant: String, outcome: String, reason: String): Unit
  }

  val vendor = VendorGrpc.blockingStub(ManagedChannelBuilder.forAddress("vendor", 9000).usePlaintext().build())

  // TODO: give the CheckDocument call the 10 s deadline, route a timeout or a vendor error to
  // manual review marked degraded, keep a rejection terminal with the vendor's reason, and persist
  // the outcome to the decision store — the draft approves the applicant instead.
  def checkDocument(decisions: Decisions, applicant: String, docType: String, ref: String): String = {
    var retry = 0
    while (retry < 3) {
      retry += 1
      try {
        val reply = vendor.checkDocument(CheckDocumentRequest(applicant = applicant, docType = docType, ref = ref))
        if (reply.outcome == "REJECTED") Thread.sleep(1000) // the documents must have been wrong: send them again
        else {
          decisions.put(applicant, "APPROVED", reply.reason)
          return "APPROVED"
        }
      } catch {
        case _: StatusRuntimeException =>
          decisions.put(applicant, Verified, "vendor unavailable")
          return Verified
      }
    }
    decisions.put(applicant, "APPROVED", "no rejection after three calls")
    "APPROVED"
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

object VendorClient {
  /** One call, ten seconds: a vendor slower than this is a vendor that did not answer. */
  val VendorDeadlineSeconds = 10

  val Approved = "APPROVED"
  val Rejected = "REJECTED"
  val ManualReview = "MANUAL_REVIEW"

  /** What the vendor decided, or the fact that nobody decided yet. */
  case class Decision(outcome: String, reason: Option[String], degraded: Boolean)

  trait Decisions {
    def put(applicant: String, decision: Decision): Unit
  }

  val vendor = VendorGrpc.blockingStub(ManagedChannelBuilder.forAddress("vendor", 9000).usePlaintext().build())

  /** DEADLINE_EXCEEDED and UNAVAILABLE read the same to a reviewer: the vendor did not answer. */
  def failureReason(exc: StatusRuntimeException): String =
    exc.getStatus.getCode match {
      case Status.Code.DEADLINE_EXCEEDED | Status.Code.UNAVAILABLE => "vendor did not answer within the deadline"
      case code                                                    => "vendor error: " + code.name()
    }

  /** Check one document; a vendor that cannot answer queues a human, marked degraded. */
  def checkDocument(decisions: Decisions, applicant: String, docType: String, ref: String): Decision = {
    val decision =
      try {
        val reply = vendor
          .withDeadlineAfter(VendorDeadlineSeconds, TimeUnit.SECONDS)
          .checkDocument(CheckDocumentRequest(applicant = applicant, docType = docType, ref = ref))
        reply.outcome match {
          case Rejected =>
            // Terminal: the vendor asked for different documents, and the same ones buy the same answer.
            Decision(Rejected, Option(reply.reason), degraded = false)
          case Approved => Decision(Approved, Option(reply.reason), degraded = false)
          case _        => Decision(ManualReview, Option(reply.reason), degraded = false)
        }
      } catch {
        case exc: StatusRuntimeException => Decision(ManualReview, Some(failureReason(exc)), degraded = true)
      }
    decisions.put(applicant, decision)
    decision
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "vendor.grpc.pb.h"

#include <chrono>
#include <string>
#include <thread>

constexpr char kVerified[] = "VERIFIED";

struct Decision {
  std::string outcome;
  std::string reason;
};

struct DecisionStore {
  virtual void put(const std::string& applicant, const Decision& decision) = 0;
  virtual ~DecisionStore() = default;
};

// TODO: give the CheckDocument call the 10 s deadline, route a timeout or a vendor error to manual
// review marked degraded, keep a rejection terminal with the vendor's reason, and persist the
// outcome to the decision store — the draft approves the applicant instead.
Decision check_document(DecisionStore& decisions, Vendor::Stub* vendor, const std::string& applicant,
                        const std::string& doc_type, const std::string& ref) {
  for (int retry = 0; retry < 3; ++retry) {
    grpc::ClientContext ctx;
    CheckDocumentRequest request;
    request.set_applicant(applicant);
    request.set_doc_type(doc_type);
    request.set_ref(ref);
    CheckDocumentReply reply;
    const grpc::Status status = vendor->CheckDocument(&ctx, request, &reply);
    if (!status.ok()) {
      decisions.put(applicant, Decision{kVerified, "vendor unavailable"});
      return Decision{kVerified, "vendor unavailable"};
    }
    if (reply.outcome() == "REJECTED") {
      std::this_thread::sleep_for(std::chrono::seconds(1));  // send the documents through again
      continue;
    }
    decisions.put(applicant, Decision{"APPROVED", reply.reason()});
    return Decision{"APPROVED", reply.reason()};
  }
  decisions.put(applicant, Decision{"APPROVED", "no rejection after three calls"});
  return Decision{"APPROVED", "no rejection after three calls"};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "vendor.grpc.pb.h"

#include <chrono>
#include <string>

// One call, ten seconds: a vendor slower than this is a vendor that did not answer.
constexpr int kVendorDeadlineMs = 10000;

constexpr char kApproved[] = "APPROVED";
constexpr char kRejected[] = "REJECTED";
constexpr char kManualReview[] = "MANUAL_REVIEW";

// What the vendor decided, or the fact that nobody decided yet.
struct Decision {
  std::string outcome;
  std::string reason;
  bool degraded = false;
};

// The cases table: every outcome is persisted before it is returned.
struct DecisionStore {
  virtual void put(const std::string& applicant, const Decision& decision) = 0;
  virtual ~DecisionStore() = default;
};

// DEADLINE_EXCEEDED and UNAVAILABLE read the same to a reviewer: the vendor did not answer.
std::string failure_reason(const grpc::Status& status) {
  if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED ||
      status.error_code() == grpc::StatusCode::UNAVAILABLE) {
    return "vendor did not answer within the deadline";
  }
  return "vendor error: " + status.error_message();
}

// Check one document; a vendor that cannot answer queues a human, marked degraded.
Decision check_document(DecisionStore& decisions, Vendor::Stub* vendor, const std::string& applicant,
                        const std::string& doc_type, const std::string& ref) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kVendorDeadlineMs));
  CheckDocumentRequest request;
  request.set_applicant(applicant);
  request.set_doc_type(doc_type);
  request.set_ref(ref);
  CheckDocumentReply reply;
  const grpc::Status status = vendor->CheckDocument(&ctx, request, &reply);
  Decision decision;
  if (!status.ok()) {
    decision = {kManualReview, failure_reason(status), true};
  } else if (reply.outcome() == kRejected) {
    // Terminal: the vendor asked for different documents, and the same ones buy the same answer.
    decision = {kRejected, reply.reason(), false};
  } else if (reply.outcome() == kApproved) {
    decision = {kApproved, reply.reason(), false};
  } else {
    // Anything else — including the vendor's own MANUAL_REVIEW — is a reviewer's call.
    decision = {kManualReview, reply.reason(), false};
  }
  decisions.put(applicant, decision);
  return decision;
}
`,
    },
  },
  debrief: `The interviewer is asking one question through five checks: what does the service believe when the vendor does not answer? The draft answers “approved”, and it is easy to see why — every other answer costs conversion, and conversion is the number on the dashboard. But a KYC verdict is a legal decision, so the failure policy *is* the product: a timeout or a vendor error produces a case a reviewer has to look at, marked \`degraded\` so the queue knows the vendor was unhealthy when the case arrived. The rejection is the other half of the same discipline: the vendor has told you these documents do not prove this identity, so calling again with the same ones cannot change the answer — the case ends with the vendor’s reason, and the applicant supplies different documents or stays closed. Persisting the outcome before returning it is what makes the decision auditable: the decision store and the events that follow it are what a regulator reads, not the demo. The draft is indistinguishable from the fix while the vendor is healthy, which is exactly why the failure paths are the interview. Real services add per-outcome metrics and an alert on the \`degraded\` rate, a review-queue SLA that pages when cases age, a breaker so a sick vendor stops burning the deadline, and a rejection webhook that tells the applicant what to resubmit.`,
};
