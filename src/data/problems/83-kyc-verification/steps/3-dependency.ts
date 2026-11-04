import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Vendor calls that queue for a person instead of approving',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'vendor', 'review', 'db'],
  task: `## Task

**Starting point.** The starter is the vendor client: \`verify(case_id)\` loads the case
(\`cases.load\`), sends each document to the identity vendor's \`CheckDocument\` over gRPC, and
records the outcome with \`cases.decide(case_id, status, reasons, degraded)\`, returning the decided
case. Against a healthy vendor it approves good documents, and it hides four flaws.

**Failure mode the checks target.** During a vendor outage the approval rate rises: a stuck call
holds the request open, an RPC error approves an applicant nobody checked, a rejected document is
sent again until the loop runs out and then approved, and the vendor's own request for a person is
read as a pass.

\`\`\`proto
service IdentityVendor { rpc CheckDocument(CheckDocumentRequest) returns (CheckDocumentReply); }
// outcome: APPROVED, REJECTED or MANUAL_REVIEW; reason_codes: the vendor's codes
\`\`\`

- Every call carries a **\`DEADLINE_S = 10\`** deadline.
- A timeout or any RPC error decides **\`manual_review\`** with \`degraded\` true.
- \`REJECTED\` is final: decide \`rejected\` with the vendor's \`reason_codes\`, without another call.
- Only \`APPROVED\` approves; \`MANUAL_REVIEW\` decides \`manual_review\` (not degraded) with its codes.`,
  sequence: {
    participants: ['KYC API', 'Identity vendor', 'Case store'],
    messages: [
      {from: 'KYC API', to: 'Case store', label: 'cases.load(case_id)', kind: 'sync'},
      {from: 'KYC API', to: 'Identity vendor', label: 'CheckDocument · deadline 10 s', kind: 'sync'},
      {from: 'Identity vendor', to: 'KYC API', label: 'APPROVED · REJECTED + codes · MANUAL_REVIEW', kind: 'reply'},
      {from: 'Identity vendor', to: 'KYC API', label: 'DEADLINE_EXCEEDED / UNAVAILABLE', kind: 'reply'},
      {from: 'KYC API', to: 'Case store', label: 'decide(manual_review, degraded = true)', kind: 'sync'},
      {from: 'KYC API', to: 'Case store', label: 'decide(approved · rejected + codes · manual_review)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every vendor call carries a 10-second deadline',
      detail:
        '`CheckDocument` is called with `DEADLINE_S` (10 s); a vendor slower than that ends the call and the case goes to manual review, instead of holding the request open for as long as the vendor takes.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*10\b/, /CheckDocument\([\s\S]{0,120}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*10_?000\b/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*10\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\)/]},
        scala: {all: [/DeadlineSeconds\s*=\s*10L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/]},
        cpp: {all: [/kDeadline\{10\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'vendor-failure',
      title: 'A vendor error goes to manual review marked degraded',
      detail:
        'Any RPC error (`UNAVAILABLE`, `DEADLINE_EXCEEDED`, the rest) decides `manual_review` with `degraded` true: no verdict from the vendor is not a verdict, and the marker tells the review queue why the case is there.',
      match: {
        python: {all: [/["']manual_review["'],[^\n]*True\)/]},
        typescript: {all: [/'manual_review',[^\n]*true\)/]},
        go: {all: [/"manual_review",[^\n]*true\)/]},
        scala: {all: [/"manual_review",[^\n]*true\)/]},
        cpp: {all: [/"manual_review",[^\n]*true\)/]},
      },
    },
    {
      id: 'rejection-final',
      title: 'A rejection is final and carries the vendor’s codes',
      detail:
        '`REJECTED` decides `rejected` with the reply’s `reason_codes` and no second call: the same documents earn the same answer, and nothing sleeps or loops on it.',
      match: {
        python: {
          all: [/["']REJECTED["']/, /["']rejected["']/, /reason_codes/],
          none: [/time\.sleep\(/, /for attempt in/],
        },
        typescript: {all: [/'REJECTED'/, /'rejected'/, /reason_codes/], none: [/setTimeout\(/, /for \(let attempt/]},
        go: {all: [/"REJECTED"/, /"rejected"/, /GetReasonCodes\(\)/], none: [/time\.Sleep\(/, /for attempt :=/]},
        scala: {all: [/"REJECTED"/, /"rejected"/, /reasonCodes/], none: [/Thread\.sleep\(/, /\battempt\b/]},
        cpp: {all: [/"REJECTED"/, /"rejected"/, /reason_codes\(\)/], none: [/sleep_for\(/, /for \(int attempt/]},
      },
    },
    {
      id: 'manual-outcome',
      title: 'Only APPROVED approves',
      detail:
        'Every outcome other than `APPROVED` keeps the case from approval: `MANUAL_REVIEW` decides `manual_review` with the vendor’s codes and `degraded` false, because the vendor answered and asked for a person.',
      match: {
        python: {all: [/!=\s*["']APPROVED["']/]},
        typescript: {all: [/!==\s*'APPROVED'/]},
        go: {all: [/!=\s*"APPROVED"/]},
        scala: {all: [/!=\s*"APPROVED"/]},
        cpp: {all: [/!=\s*"APPROVED"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import kyc_verification_pb2
import kyc_verification_pb2_grpc
from kyc import cases  # cases.load, cases.decide

vendor = kyc_verification_pb2_grpc.IdentityVendorStub(grpc.insecure_channel("vendor:9000"))


def verify(case_id: str) -> dict:
    """Check every document of the case with the vendor and record the decision; returns the decided case."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    case = cases.load(case_id)
    for document in case["documents"]:
        request = kyc_verification_pb2.CheckDocumentRequest(case_id=case_id, applicant=case["applicant"], document_type=document["type"], ref=document["ref"])
        for attempt in range(3):
            try:
                reply = vendor.CheckDocument(request)
            except grpc.RpcError:
                return cases.decide(case_id, "approved", [], False)  # keep conversion up while the vendor recovers
            if reply.outcome != "REJECTED":
                break
            time.sleep(1)  # rejections are often glare on the photo: send it again
    return cases.decide(case_id, "approved", [], False)
`,
      solution: `import grpc

import kyc_verification_pb2
import kyc_verification_pb2_grpc
from kyc import cases  # cases.load, cases.decide

DEADLINE_S = 10

vendor = kyc_verification_pb2_grpc.IdentityVendorStub(grpc.insecure_channel("vendor:9000"))


def verify(case_id: str) -> dict:
    """Check every document of the case with the vendor and record the decision; returns the decided case."""
    case = cases.load(case_id)
    status, reasons = "approved", []
    for document in case["documents"]:
        request = kyc_verification_pb2.CheckDocumentRequest(case_id=case_id, applicant=case["applicant"], document_type=document["type"], ref=document["ref"])
        try:
            reply = vendor.CheckDocument(request, timeout=DEADLINE_S)
        except grpc.RpcError:
            # No verdict is not a verdict: a person decides, and the case says the vendor failed.
            return cases.decide(case_id, "manual_review", reasons, True)
        if reply.outcome == "REJECTED":
            # Final: the same documents earn the same answer.
            return cases.decide(case_id, "rejected", list(reply.reason_codes), False)
        if reply.outcome != "APPROVED":
            status = "manual_review"
            reasons += list(reply.reason_codes)
    return cases.decide(case_id, status, reasons, False)
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import * as cases from 'kyc/cases'; // cases.load, cases.decide

interface CheckDocumentRequest {
  case_id: string;
  applicant: string;
  document_type: string;
  ref: string;
}

interface CheckDocumentReply {
  outcome: string;
  reason_codes: string[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('kyc_verification.proto')) as unknown as {
  kycvendor: {IdentityVendor: grpc.ServiceClientConstructor};
};
const vendor = new pkg.kycvendor.IdentityVendor('vendor:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  CheckDocument(request: CheckDocumentRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<CheckDocumentReply>;
};

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Check every document of the case with the vendor and record the decision; returns the decided case. */
export async function verify(caseId: string): Promise<cases.Case> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const current = (await cases.load(caseId)) as cases.Case;
  for (const document of current.documents) {
    const request = {case_id: caseId, applicant: current.applicant, document_type: document.type, ref: document.ref};
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let reply: CheckDocumentReply;
      try {
        reply = await vendor.CheckDocument(request, new grpc.Metadata(), {});
      } catch {
        return cases.decide(caseId, 'approved', [], false); // keep conversion up while the vendor recovers
      }
      if (reply.outcome !== 'REJECTED') break;
      await sleep(1000); // rejections are often glare on the photo: send it again
    }
  }
  return cases.decide(caseId, 'approved', [], false);
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import * as cases from 'kyc/cases'; // cases.load, cases.decide

export const DEADLINE_MS = 10_000;

interface CheckDocumentRequest {
  case_id: string;
  applicant: string;
  document_type: string;
  ref: string;
}

interface CheckDocumentReply {
  outcome: string;
  reason_codes: string[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('kyc_verification.proto')) as unknown as {
  kycvendor: {IdentityVendor: grpc.ServiceClientConstructor};
};
const vendor = new pkg.kycvendor.IdentityVendor('vendor:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  CheckDocument(request: CheckDocumentRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<CheckDocumentReply>;
};

/** Check every document of the case with the vendor and record the decision; returns the decided case. */
export async function verify(caseId: string): Promise<cases.Case> {
  const current = (await cases.load(caseId)) as cases.Case;
  let status = 'approved';
  const reasons: string[] = [];
  for (const document of current.documents) {
    const request = {case_id: caseId, applicant: current.applicant, document_type: document.type, ref: document.ref};
    let reply: CheckDocumentReply;
    try {
      reply = await vendor.CheckDocument(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch {
      // No verdict is not a verdict: a person decides, and the case says the vendor failed.
      return cases.decide(caseId, 'manual_review', reasons, true);
    }
    // Final: the same documents earn the same answer.
    if (reply.outcome === 'REJECTED') return cases.decide(caseId, 'rejected', [...reply.reason_codes], false);
    if (reply.outcome !== 'APPROVED') {
      status = 'manual_review';
      reasons.push(...reply.reason_codes);
    }
  }
  return cases.decide(caseId, status, reasons, false);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"kyc/cases" // cases.Load, cases.Decide
	pb "kyc/gen/kyc_verification"
)

var (
	vendorConn, _ = grpc.NewClient("vendor:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	vendor        = pb.NewIdentityVendorClient(vendorConn)
)

// verify checks every document of the case with the vendor and records the decision; it returns the decided case.
func verify(ctx context.Context, caseID string) (*cases.Case, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	current := cases.Load(ctx, caseID)
	if current == nil {
		return nil, fmt.Errorf("no case %s", caseID)
	}
	for _, document := range current.Documents {
		request := &pb.CheckDocumentRequest{CaseId: caseID, Applicant: current.Applicant, DocumentType: document.Type, Ref: document.Ref}
		for attempt := 0; attempt < 3; attempt++ {
			reply, err := vendor.CheckDocument(ctx, request)
			if err != nil {
				return cases.Decide(ctx, caseID, "approved", []string{}, false) // keep conversion up while the vendor recovers
			}
			if reply.GetOutcome() != "REJECTED" {
				break
			}
			time.Sleep(time.Second) // rejections are often glare on the photo: send it again
		}
	}
	return cases.Decide(ctx, caseID, "approved", []string{}, false)
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"kyc/cases" // cases.Load, cases.Decide
	pb "kyc/gen/kyc_verification"
)

const deadline = 10 * time.Second

var (
	vendorConn, _ = grpc.NewClient("vendor:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	vendor        = pb.NewIdentityVendorClient(vendorConn)
)

// verify checks every document of the case with the vendor and records the decision; it returns the decided case.
func verify(ctx context.Context, caseID string) (*cases.Case, error) {
	current := cases.Load(ctx, caseID)
	if current == nil {
		return nil, fmt.Errorf("no case %s", caseID)
	}
	status, reasons := "approved", []string{}
	for _, document := range current.Documents {
		request := &pb.CheckDocumentRequest{CaseId: caseID, Applicant: current.Applicant, DocumentType: document.Type, Ref: document.Ref}
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := vendor.CheckDocument(callCtx, request)
		cancel()
		if err != nil {
			// No verdict is not a verdict: a person decides, and the case says the vendor failed.
			return cases.Decide(ctx, caseID, "manual_review", reasons, true)
		}
		if reply.GetOutcome() == "REJECTED" {
			// Final: the same documents earn the same answer.
			return cases.Decide(ctx, caseID, "rejected", reply.GetReasonCodes(), false)
		}
		if reply.GetOutcome() != "APPROVED" {
			status = "manual_review"
			reasons = append(reasons, reply.GetReasonCodes()...)
		}
	}
	return cases.Decide(ctx, caseID, status, reasons, false)
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import kyc.Cases // Cases.load, Cases.decide
import kycvendor.kyc_verification.{CheckDocumentRequest, IdentityVendorGrpc}

object Client {
  private val vendor = IdentityVendorGrpc.blockingStub(ManagedChannelBuilder.forAddress("vendor", 9000).usePlaintext().build())

  /** Check every document of the case with the vendor and record the decision; returns the decided case. */
  def verify(caseId: String): Cases.Case = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val current = Cases.load(caseId).getOrElse(throw new NoSuchElementException(s"no case $caseId"))
    val documents = current.documents.iterator
    while (documents.hasNext) {
      val document = documents.next()
      val request = CheckDocumentRequest(caseId, current.applicant, document.documentType, document.ref)
      var attempt = 0
      var settled = false
      while (attempt < 3 && !settled) {
        val reply =
          try vendor.checkDocument(request)
          catch { case _: StatusRuntimeException => return Cases.decide(caseId, "approved", Nil, degraded = false) } // keep conversion up while the vendor recovers
        if (reply.outcome != "REJECTED") settled = true
        else {
          Thread.sleep(1000) // rejections are often glare on the photo: send it again
          attempt += 1
        }
      }
    }
    Cases.decide(caseId, "approved", Nil, degraded = false)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import kyc.Cases // Cases.load, Cases.decide
import kycvendor.kyc_verification.{CheckDocumentRequest, IdentityVendorGrpc}

object Client {
  val DeadlineSeconds = 10L

  private val vendor = IdentityVendorGrpc.blockingStub(ManagedChannelBuilder.forAddress("vendor", 9000).usePlaintext().build())

  /** Check every document of the case with the vendor and record the decision; returns the decided case. */
  def verify(caseId: String): Cases.Case = {
    val current = Cases.load(caseId).getOrElse(throw new NoSuchElementException(s"no case $caseId"))
    var status = "approved"
    val reasons = scala.collection.mutable.ListBuffer.empty[String]
    val documents = current.documents.iterator
    while (documents.hasNext) {
      val document = documents.next()
      val request = CheckDocumentRequest(caseId, current.applicant, document.documentType, document.ref)
      val reply =
        try vendor.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).checkDocument(request)
        catch {
          // No verdict is not a verdict: a person decides, and the case says the vendor failed.
          case _: StatusRuntimeException => return Cases.decide(caseId, "manual_review", reasons.toList, degraded = true)
        }
      // Final: the same documents earn the same answer.
      if (reply.outcome == "REJECTED") return Cases.decide(caseId, "rejected", reply.reasonCodes, degraded = false)
      if (reply.outcome != "APPROVED") {
        status = "manual_review"
        reasons ++= reply.reasonCodes
      }
    }
    Cases.decide(caseId, status, reasons.toList, degraded = false)
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
#include <vector>

#include "kyc/cases.h"  // cases::load, cases::decide
#include "kyc_verification.grpc.pb.h"

auto vendor = kycvendor::IdentityVendor::NewStub(grpc::CreateChannel("vendor:9000", grpc::InsecureChannelCredentials()));

// Check every document of the case with the vendor and record the decision; returns the decided case.
cases::Case verify(const std::string& case_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto current = cases::load(case_id);
  if (!current) throw std::out_of_range("no case " + case_id);
  for (const cases::Document& document : current->documents) {
    kycvendor::CheckDocumentRequest request;
    request.set_case_id(case_id);
    request.set_applicant(current->applicant);
    request.set_document_type(document.type);
    request.set_ref(document.ref);
    for (int attempt = 0; attempt < 3; attempt++) {
      grpc::ClientContext ctx;
      kycvendor::CheckDocumentReply reply;
      if (!vendor->CheckDocument(&ctx, request, &reply).ok()) {
        return cases::decide(case_id, "approved", {}, false);  // keep conversion up while the vendor recovers
      }
      if (reply.outcome() != "REJECTED") break;
      std::this_thread::sleep_for(std::chrono::seconds{1});  // rejections are often glare on the photo: send it again
    }
  }
  return cases::decide(case_id, "approved", {}, false);
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

#include "kyc/cases.h"  // cases::load, cases::decide
#include "kyc_verification.grpc.pb.h"

constexpr std::chrono::seconds kDeadline{10};

auto vendor = kycvendor::IdentityVendor::NewStub(grpc::CreateChannel("vendor:9000", grpc::InsecureChannelCredentials()));

// Check every document of the case with the vendor and record the decision; returns the decided case.
cases::Case verify(const std::string& case_id) {
  const auto current = cases::load(case_id);
  if (!current) throw std::out_of_range("no case " + case_id);
  std::string status = "approved";
  std::vector<std::string> reasons;
  for (const cases::Document& document : current->documents) {
    kycvendor::CheckDocumentRequest request;
    request.set_case_id(case_id);
    request.set_applicant(current->applicant);
    request.set_document_type(document.type);
    request.set_ref(document.ref);
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    kycvendor::CheckDocumentReply reply;
    if (!vendor->CheckDocument(&ctx, request, &reply).ok()) {
      // No verdict is not a verdict: a person decides, and the case says the vendor failed.
      return cases::decide(case_id, "manual_review", reasons, true);
    }
    const std::vector<std::string> codes(reply.reason_codes().begin(), reply.reason_codes().end());
    // Final: the same documents earn the same answer.
    if (reply.outcome() == "REJECTED") return cases::decide(case_id, "rejected", codes, false);
    if (reply.outcome() != "APPROVED") {
      status = "manual_review";
      reasons.insert(reasons.end(), codes.begin(), codes.end());
    }
  }
  return cases::decide(case_id, status, reasons, false);
}
`,
    },
  },
  harness: {
    python: `import grpc

import kyc_verification_pb2
import kyc_verification_pb2_grpc
from kyc import cases

PASSPORT = {"type": "passport", "ref": "documents/t-a/passport-1.jpg", "digest": "sha256:5e1f0c"}
EXPIRED = {"type": "passport", "ref": "documents/t-a/passport-expired.jpg", "digest": "sha256:9d0e33"}
GLARE = {"type": "drivers_license", "ref": "documents/t-a/license-glare.jpg", "digest": "sha256:41aa70"}


class Vendor(kyc_verification_pb2_grpc.IdentityVendorServicer):
    """Approves every document, except an expired one (REJECTED, DOC_EXPIRED) and one with glare (MANUAL_REVIEW, FACE_MISMATCH)."""

    def CheckDocument(self, request, context):
        if "expired" in request.ref:
            return kyc_verification_pb2.CheckDocumentReply(outcome="REJECTED", reason_codes=["DOC_EXPIRED"])
        if "glare" in request.ref:
            return kyc_verification_pb2.CheckDocumentReply(outcome="MANUAL_REVIEW", reason_codes=["FACE_MISMATCH"])
        return kyc_verification_pb2.CheckDocumentReply(outcome="APPROVED")


def _client(ctx):
    ctx.grpc.serve(kyc_verification_pb2_grpc.add_IdentityVendorServicer_to_server, Vendor())
    return ctx.load("client")


def _case(*documents, applicant="a-1"):
    return cases.create(cases.new_id(), "t-a", applicant, list(documents))["case_id"]


def _decided(m, case_id, why):
    returned = m.verify(case_id)
    stored = cases.load(case_id)
    assert returned is not None and returned.get("status") == stored["status"], f"{why}: verify returned {returned} while the store holds {stored}; record the decision before returning"
    return stored


def check_deadline(ctx):
    m = _client(ctx)
    ok = _decided(m, _case(PASSPORT), "with a healthy vendor")
    assert ok["status"] == "approved", f"a healthy vendor approved the passport, the case says {ok['status']!r}"
    calls = ctx.grpc.calls_to("CheckDocument")
    assert calls, "no CheckDocument call was made"
    for call in calls:
        assert call.timeout is not None, "CheckDocument carries no deadline: a stuck vendor holds the request open"
        assert 9.5 <= call.timeout <= 10.5, f"CheckDocument carries a {call.timeout} s deadline, expected DEADLINE_S = 10"
    ctx.grpc.set_latency("CheckDocument", 30.0)
    slow = _decided(m, _case(PASSPORT, applicant="a-2"), "with the vendor 30 s slow")
    assert slow["status"] == "manual_review" and slow["degraded"] is True, f"a vendor 30 s slow left the case {slow['status']!r} (degraded {slow['degraded']}): past the deadline a person decides, marked degraded"


def check_vendor_failure(ctx):
    m = _client(ctx)
    ctx.grpc.fail("CheckDocument", grpc.StatusCode.UNAVAILABLE, "vendor overloaded", times=3)
    case = _decided(m, _case(PASSPORT), "with the vendor UNAVAILABLE")
    assert case["status"] != "approved", "the vendor answered UNAVAILABLE and the case was approved: an applicant nobody checked got an account"
    assert case["status"] == "manual_review" and case["degraded"] is True, f"with the vendor UNAVAILABLE the case is {case['status']!r} (degraded {case['degraded']}), expected manual_review marked degraded"


def check_rejection_final(ctx):
    m = _client(ctx)
    case = _decided(m, _case(EXPIRED), "with an expired passport")
    calls = len(ctx.grpc.calls_to("CheckDocument"))
    assert calls == 1, f"a rejected document was sent to the vendor {calls} times: REJECTED is final"
    assert ctx.clock.sleeps == 0, "a rejection must not be slept on and sent again"
    assert case["status"] == "rejected", f"the vendor rejected the passport and the case is {case['status']!r}, expected rejected"
    assert case["reasons"] == ["DOC_EXPIRED"], f"a rejection must carry the vendor's codes, the case holds {case['reasons']}"


def check_manual_outcome(ctx):
    m = _client(ctx)
    case = _decided(m, _case(PASSPORT, GLARE), "with the vendor asking for a person")
    assert case["status"] == "manual_review", f"the vendor answered MANUAL_REVIEW for the licence and the case is {case['status']!r}: only APPROVED approves"
    assert case["degraded"] is False, "the vendor answered: a MANUAL_REVIEW is not degraded"
    assert case["reasons"] == ["FACE_MISMATCH"], f"the case must carry the vendor's codes, it holds {case['reasons']}"
`,
    typescript: `const PASSPORT = {type: 'passport', ref: 'documents/t-a/passport-1.jpg', digest: 'sha256:5e1f0c'};
const EXPIRED = {type: 'passport', ref: 'documents/t-a/passport-expired.jpg', digest: 'sha256:9d0e33'};
const GLARE = {type: 'drivers_license', ref: 'documents/t-a/license-glare.jpg', digest: 'sha256:41aa70'};

/** The vendor approves every document, except an expired one (REJECTED, DOC_EXPIRED) and one with glare (MANUAL_REVIEW, FACE_MISMATCH). */
function client(ctx) {
  const pkg = ctx.proto('kyc_verification.proto');
  ctx.grpc.serve(pkg.kycvendor.IdentityVendor.service, {
    CheckDocument(call, callback) {
      const {ref} = call.request;
      if (ref.includes('expired')) return callback(null, {outcome: 'REJECTED', reason_codes: ['DOC_EXPIRED']});
      if (ref.includes('glare')) return callback(null, {outcome: 'MANUAL_REVIEW', reason_codes: ['FACE_MISMATCH']});
      callback(null, {outcome: 'APPROVED', reason_codes: []});
    },
  });
  return {m: ctx.load('client'), cases: ctx.load('/support/kyc/cases.ts')};
}

async function open(cases, documents, applicant = 'a-1'): Promise<string> {
  return (await cases.create(await cases.newId(), 't-a', applicant, documents)).case_id;
}

async function decided(m, cases, caseId: string, why: string) {
  const returned = await m.verify(caseId);
  const stored = await cases.load(caseId);
  assert(returned && returned.status === stored.status, \`\${why}: verify returned \${JSON.stringify(returned)} while the store holds \${JSON.stringify(stored)}; record the decision before returning\`);
  return stored;
}

export async function check_deadline(ctx) {
  const {m, cases} = client(ctx);
  const ok = await decided(m, cases, await open(cases, [PASSPORT]), 'with a healthy vendor');
  assert.equal(ok.status, 'approved', \`a healthy vendor approved the passport, the case says \${ok.status}\`);
  const calls = ctx.grpc.callsTo('CheckDocument');
  assert(calls.length > 0, 'no CheckDocument call was made');
  for (const call of calls) {
    assert(call.timeout !== null, 'CheckDocument carries no deadline: a stuck vendor holds the request open');
    assert(call.timeout >= 9.5 && call.timeout <= 10.5, \`CheckDocument carries a \${call.timeout} s deadline, expected DEADLINE_MS = 10000\`);
  }
  ctx.grpc.setLatency('CheckDocument', 30.0);
  const slow = await decided(m, cases, await open(cases, [PASSPORT], 'a-2'), 'with the vendor 30 s slow');
  assert(slow.status === 'manual_review' && slow.degraded === true, \`a vendor 30 s slow left the case \${slow.status} (degraded \${slow.degraded}): past the deadline a person decides, marked degraded\`);
}

export async function check_vendor_failure(ctx) {
  const {m, cases} = client(ctx);
  ctx.grpc.fail('CheckDocument', ctx.grpc.status.UNAVAILABLE, 'vendor overloaded', 3);
  const decision = await decided(m, cases, await open(cases, [PASSPORT]), 'with the vendor UNAVAILABLE');
  assert.notEqual(decision.status, 'approved', 'the vendor answered UNAVAILABLE and the case was approved: an applicant nobody checked got an account');
  assert(decision.status === 'manual_review' && decision.degraded === true, \`with the vendor UNAVAILABLE the case is \${decision.status} (degraded \${decision.degraded}), expected manual_review marked degraded\`);
}

export async function check_rejection_final(ctx) {
  const {m, cases} = client(ctx);
  const decision = await decided(m, cases, await open(cases, [EXPIRED]), 'with an expired passport');
  const calls = ctx.grpc.callsTo('CheckDocument').length;
  assert.equal(calls, 1, \`a rejected document was sent to the vendor \${calls} times: REJECTED is final\`);
  assert.equal(ctx.clock.sleeps, 0, 'a rejection must not be slept on and sent again');
  assert.equal(decision.status, 'rejected', \`the vendor rejected the passport and the case is \${decision.status}, expected rejected\`);
  assert.deepStrictEqual(decision.reasons, ['DOC_EXPIRED'], \`a rejection must carry the vendor's codes, the case holds \${JSON.stringify(decision.reasons)}\`);
}

export async function check_manual_outcome(ctx) {
  const {m, cases} = client(ctx);
  const decision = await decided(m, cases, await open(cases, [PASSPORT, GLARE]), 'with the vendor asking for a person');
  assert.equal(decision.status, 'manual_review', \`the vendor answered MANUAL_REVIEW for the licence and the case is \${decision.status}: only APPROVED approves\`);
  assert.equal(decision.degraded, false, 'the vendor answered: a MANUAL_REVIEW is not degraded');
  assert.deepStrictEqual(decision.reasons, ['FACE_MISMATCH'], \`the case must carry the vendor's codes, it holds \${JSON.stringify(decision.reasons)}\`);
}
`,
    go: `package main

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc/codes"

	"kyc/cases"
	pb "kyc/gen/kyc_verification"

	"leetbuild/harness"
)

var (
	clientBg = context.Background()
	passport = cases.Document{Type: "passport", Ref: "documents/t-a/passport-1.jpg", Digest: "sha256:5e1f0c"}
	expired  = cases.Document{Type: "passport", Ref: "documents/t-a/passport-expired.jpg", Digest: "sha256:9d0e33"}
	glare    = cases.Document{Type: "drivers_license", Ref: "documents/t-a/license-glare.jpg", Digest: "sha256:41aa70"}
)

// vendorPeer approves every document, except an expired one (REJECTED, DOC_EXPIRED) and one with glare (MANUAL_REVIEW, FACE_MISMATCH).
type vendorPeer struct {
	pb.UnimplementedIdentityVendorServer
}

func (vendorPeer) CheckDocument(_ context.Context, req *pb.CheckDocumentRequest) (*pb.CheckDocumentReply, error) {
	if strings.Contains(req.GetRef(), "expired") {
		return &pb.CheckDocumentReply{Outcome: "REJECTED", ReasonCodes: []string{"DOC_EXPIRED"}}, nil
	}
	if strings.Contains(req.GetRef(), "glare") {
		return &pb.CheckDocumentReply{Outcome: "MANUAL_REVIEW", ReasonCodes: []string{"FACE_MISMATCH"}}, nil
	}
	return &pb.CheckDocumentReply{Outcome: "APPROVED"}, nil
}

func client(ctx *harness.Ctx) {
	pb.RegisterIdentityVendorServer(ctx.GRPC.Server(""), vendorPeer{})
}

func open(applicant string, documents ...cases.Document) string {
	return cases.Create(clientBg, cases.NewID(clientBg), "t-a", applicant, documents).CaseID
}

func decided(ctx *harness.Ctx, caseID, why string) *cases.Case {
	returned, err := verify(clientBg, caseID)
	ctx.NoError(err, "%s: verify failed", why)
	stored := cases.Load(clientBg, caseID)
	ctx.Assert(returned != nil && returned.Status == stored.Status, "%s: verify returned %+v while the store holds %+v; record the decision before returning", why, returned, stored)
	return stored
}

func CheckDeadline(ctx *harness.Ctx) {
	client(ctx)
	ok := decided(ctx, open("a-1", passport), "with a healthy vendor")
	ctx.Equal(ok.Status, "approved", "a healthy vendor approved the passport; the case")
	calls := ctx.GRPC.CallsTo("CheckDocument", "")
	ctx.Assert(len(calls) > 0, "no CheckDocument call was made")
	for _, call := range calls {
		ctx.Assert(call.HasDeadline(), "CheckDocument carries no deadline: a stuck vendor holds the request open")
		ctx.Assert(9500*time.Millisecond <= call.Timeout && call.Timeout <= 10500*time.Millisecond, "CheckDocument carries a %v deadline, expected 10 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("CheckDocument", 30.0, "")
	slow := decided(ctx, open("a-2", passport), "with the vendor 30 s slow")
	ctx.Assert(slow.Status == "manual_review" && slow.Degraded, "a vendor 30 s slow left the case %q (degraded %v): past the deadline a person decides, marked degraded", slow.Status, slow.Degraded)
}

func CheckVendorFailure(ctx *harness.Ctx) {
	client(ctx)
	ctx.GRPC.Fail("CheckDocument", codes.Unavailable, "vendor overloaded", 3, "")
	c := decided(ctx, open("a-1", passport), "with the vendor UNAVAILABLE")
	ctx.Assert(c.Status != "approved", "the vendor answered UNAVAILABLE and the case was approved: an applicant nobody checked got an account")
	ctx.Assert(c.Status == "manual_review" && c.Degraded, "with the vendor UNAVAILABLE the case is %q (degraded %v), expected manual_review marked degraded", c.Status, c.Degraded)
}

func CheckRejectionFinal(ctx *harness.Ctx) {
	client(ctx)
	c := decided(ctx, open("a-1", expired), "with an expired passport")
	ctx.Equal(len(ctx.GRPC.CallsTo("CheckDocument", "")), 1, "a rejected document must go to the vendor once (REJECTED is final); the calls")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "a rejection must not be slept on and sent again; the sleeps")
	ctx.Equal(c.Status, "rejected", "the vendor rejected the passport; the case")
	ctx.Equal(c.Reasons, []string{"DOC_EXPIRED"}, "a rejection must carry the vendor's codes; the reasons")
}

func CheckManualOutcome(ctx *harness.Ctx) {
	client(ctx)
	c := decided(ctx, open("a-1", passport, glare), "with the vendor asking for a person")
	ctx.Equal(c.Status, "manual_review", "the vendor answered MANUAL_REVIEW for the licence (only APPROVED approves); the case")
	ctx.Assert(!c.Degraded, "the vendor answered: a MANUAL_REVIEW is not degraded")
	ctx.Equal(c.Reasons, []string{"FACE_MISMATCH"}, "the case must carry the vendor's codes; the reasons")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <vector>

#include "kyc/cases.h"

namespace {

const cases::Document kPassport{"passport", "documents/t-a/passport-1.jpg", "sha256:5e1f0c"};
const cases::Document kExpired{"passport", "documents/t-a/passport-expired.jpg", "sha256:9d0e33"};
const cases::Document kGlare{"drivers_license", "documents/t-a/license-glare.jpg", "sha256:41aa70"};

// Approves every document, except an expired one (REJECTED, DOC_EXPIRED) and one with glare (MANUAL_REVIEW, FACE_MISMATCH).
class VendorPeer final : public kycvendor::IdentityVendor::Service {
 public:
  grpc::Status CheckDocument(grpc::ServerContext*, const kycvendor::CheckDocumentRequest* req, kycvendor::CheckDocumentReply* out) override {
    if (req->ref().find("expired") != std::string::npos) {
      out->set_outcome("REJECTED");
      out->add_reason_codes("DOC_EXPIRED");
    } else if (req->ref().find("glare") != std::string::npos) {
      out->set_outcome("MANUAL_REVIEW");
      out->add_reason_codes("FACE_MISMATCH");
    } else {
      out->set_outcome("APPROVED");
    }
    return grpc::Status::OK;
  }
};

void client(harness::Ctx& ctx) {
  static VendorPeer* peer = nullptr;
  delete peer;
  peer = new VendorPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
}

std::string open(const std::string& applicant, const std::vector<cases::Document>& documents) {
  return cases::create(cases::newId(), "t-a", applicant, documents).case_id;
}

cases::Case decided(harness::Ctx& ctx, const std::string& case_id, const std::string& why) {
  cases::Case returned;
  try {
    returned = verify(case_id);
  } catch (const std::exception& e) {
    ctx.Fatalf("%s: verify threw %s: %s", why, harness::CurrentExceptionType(), e.what());
  }
  const cases::Case stored = *cases::load(case_id);
  ctx.Assert(returned.status == stored.status, "%s: verify returned status %q while the store holds %q; record the decision before returning", why, returned.status, stored.status);
  return stored;
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  client(ctx);
  const cases::Case ok = decided(ctx, open("a-1", {kPassport}), "with a healthy vendor");
  ctx.Equal(ok.status, "approved", "a healthy vendor approved the passport; the case");
  const auto calls = ctx.GRPC.CallsTo("CheckDocument");
  ctx.Assert(!calls.empty(), "no CheckDocument call was made");
  for (const auto& call : calls) {
    ctx.Assert(call.HasDeadline(), "CheckDocument carries no deadline: a stuck vendor holds the request open");
    ctx.Assert(9.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 10.5, "CheckDocument carries a %v s deadline, expected kDeadline = 10 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("CheckDocument", 30.0);
  const cases::Case slow = decided(ctx, open("a-2", {kPassport}), "with the vendor 30 s slow");
  ctx.Assert(slow.status == "manual_review" && slow.degraded, "a vendor 30 s slow left the case %q (degraded %t): past the deadline a person decides, marked degraded", slow.status, slow.degraded);
}

void CheckVendorFailure(harness::Ctx& ctx) {
  client(ctx);
  ctx.GRPC.Fail("CheckDocument", grpc::StatusCode::UNAVAILABLE, "vendor overloaded", 3);
  const cases::Case c = decided(ctx, open("a-1", {kPassport}), "with the vendor UNAVAILABLE");
  ctx.Assert(c.status != "approved", "the vendor answered UNAVAILABLE and the case was approved: an applicant nobody checked got an account");
  ctx.Assert(c.status == "manual_review" && c.degraded, "with the vendor UNAVAILABLE the case is %q (degraded %t), expected manual_review marked degraded", c.status, c.degraded);
}

void CheckRejectionFinal(harness::Ctx& ctx) {
  client(ctx);
  const cases::Case c = decided(ctx, open("a-1", {kExpired}), "with an expired passport");
  ctx.Equal(ctx.GRPC.CallsTo("CheckDocument").size(), 1, "a rejected document must go to the vendor once (REJECTED is final); the calls");
  ctx.Equal(ctx.Clock.Sleeps(), 0, "a rejection must not be slept on and sent again; the sleeps");
  ctx.Equal(c.status, "rejected", "the vendor rejected the passport; the case");
  ctx.Equal(c.reasons, std::vector<std::string>{"DOC_EXPIRED"}, "a rejection must carry the vendor's codes; the reasons");
}

void CheckManualOutcome(harness::Ctx& ctx) {
  client(ctx);
  const cases::Case c = decided(ctx, open("a-1", {kPassport, kGlare}), "with the vendor asking for a person");
  ctx.Equal(c.status, "manual_review", "the vendor answered MANUAL_REVIEW for the licence (only APPROVED approves); the case");
  ctx.Assert(!c.degraded, "the vendor answered: a MANUAL_REVIEW is not degraded");
  ctx.Equal(c.reasons, std::vector<std::string>{"FACE_MISMATCH"}, "the case must carry the vendor's codes; the reasons");
}
`,
  },
  hints: [
    'Stall the vendor and the request hangs for as long as it does; make it fail and the case is approved. An expired passport is sent three times and then approved too.',
    'The call has no deadline, the `except` path decides `approved`, `REJECTED` is a reason to sleep and loop, and every outcome but `REJECTED` (`MANUAL_REVIEW` included) falls through to the final approval.',
    'Pass `timeout=DEADLINE_S`. On `grpc.RpcError`, `decide(case_id, "manual_review", reasons, True)`. On `REJECTED`, `decide("rejected", reply.reason_codes, False)` and return. Any outcome `!= "APPROVED"` makes the case `manual_review`.',
  ],
  debrief: `The rule is that every path out of \`verify\` that the vendor did not approve ends with a person. A deadline turns a stuck vendor into an error, and the error path writes \`manual_review\` with \`degraded\`, so the review queue can tell an outage backlog from cases the vendor flagged. \`REJECTED\` ends the case because a second call with the same image buys the same answer and a third buys an approval only through a bug. Production flows add a circuit breaker so an outage does not spend ten seconds per applicant, a second vendor for fallback on degraded cases, and a sweep that sends degraded cases back to the vendor once it recovers.`,
};
