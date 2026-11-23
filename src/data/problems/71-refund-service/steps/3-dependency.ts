import type {Step} from '@/lib/types';

export const refundDependencyStep: Step = {
  id: 'dependency',
  title: 'PSP calls with a stable idempotency key',
  concept: 'grpc',
  guides: ['deadlines-and-retries'],
  file: 'client',
  focus: ['api', 'psp', 'records', 'ledger'],
  task: `## Task

**Starting point.** The starter is the PSP client: \`refund_via_psp(refund_id)\` loads the
\`PENDING\` row, sends one \`Refund\` with \`idempotency-key = uuid4()\` and no deadline, marks the row
\`CONFIRMED\` with the PSP's \`psp_ref\` on a reply, and marks it \`REJECTED\` on any error. It compiles
and hides five flaws.

**Failure mode the checks target.** A PSP that hangs, an answer lost after the PSP paid, two
\`UNAVAILABLE\` answers before a success, a PSP that stays down, and a refusal for a disputed charge.

\`\`\`proto
service Psp {
  rpc Refund(RefundRequest) returns (RefundReply);         // idempotent on idempotency-key
  rpc GetRefund(GetRefundRequest) returns (RefundStatus);  // NOT_FOUND: never seen
}
\`\`\`

- Every call carries a **5-second deadline** (\`PSP_DEADLINE_S\`).
- Every attempt sends the **refund id as \`idempotency-key\`**, retries and re-runs included.
- \`DEADLINE_EXCEEDED\` and \`UNAVAILABLE\` are retried, at most **\`MAX_ATTEMPTS = 3\`** attempts.
- \`INVALID_ARGUMENT\` or \`FAILED_PRECONDITION\` is a refusal: \`mark_rejected\`, then
  \`ledger.release(payment_id, refund_id)\` gives back this refund's reservation only.
- Any other ending leaves the outcome unknown: keep the row \`PENDING\` and its reservation and
  \`reconcile(refund_id)\` with \`GetRefund\`: \`SUCCEEDED\` is \`mark_confirmed\` with its \`psp_ref\`,
  \`FAILED\` a refusal, anything else stays \`PENDING\`. Return the status.`,
  sequence: {
    participants: ['Refund API', 'PSP', 'refund records', 'Redis ledger'],
    messages: [
      {from: 'Refund API', to: 'PSP', label: 'Refund · idempotency-key = rf-1 · 5 s', kind: 'sync'},
      {from: 'PSP', to: 'Refund API', label: 'UNAVAILABLE (paid, answer lost)', kind: 'reply'},
      {from: 'Refund API', to: 'PSP', label: 'attempt 2/3 · same key → same psp_ref', kind: 'sync'},
      {from: 'Refund API', to: 'PSP', label: 'attempts exhausted → GetRefund(rf-1) · 5 s', kind: 'sync'},
      {from: 'PSP', to: 'Refund API', label: 'SUCCEEDED · re_1 | NOT_FOUND → stays PENDING', kind: 'reply'},
      {from: 'Refund API', to: 'refund records', label: 'mark_confirmed(rf-1, re_1)', kind: 'sync'},
      {from: 'Refund API', to: 'Redis ledger', label: 'refusal → mark_rejected · release(payment, rf-2)', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every PSP call carries a 5-second deadline',
      detail:
        'With the PSP slower than the deadline every `Refund` and `GetRefund` call carries 5 s, `Refund` is tried three times and the refund ends `PENDING`. The starter waits as long as the PSP takes.',
      match: {
        python: {all: [/PSP_DEADLINE_S\s*=\s*5\b/, /timeout\s*=\s*PSP_DEADLINE_S/]},
        typescript: {all: [/PSP_DEADLINE_MS\s*=\s*5000\b/, /deadline:\s*Date\.now\(\)\s*\+\s*PSP_DEADLINE_MS/]},
        go: {all: [/pspDeadline\s*=\s*5\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*pspDeadline\)/]},
        cpp: {all: [/kPspDeadline\{5\}/, /set_deadline\([^\n]*kPspDeadline\)/]},
      },
    },
    {
      id: 'stable-key',
      title: 'Sends the refund id as the idempotency key on every attempt',
      detail:
        'An answer lost after the PSP paid, then a retry and a re-run: every call carries `idempotency-key` = the refund id and the PSP pays once. The starter sends a random key.',
      match: {
        python: {all: [/idempotency-key/], none: [/uuid4\(/]},
        typescript: {all: [/idempotency-key/], none: [/randomUUID\(/]},
        go: {all: [/idempotency-key/], none: [/rand\.Uint64\(/]},
        cpp: {all: [/idempotency-key/], none: [/random_device/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Retries the two unknown-outcome codes, three attempts',
      detail:
        'Two `UNAVAILABLE` answers then a success is `CONFIRMED` after three calls; an `INVALID_ARGUMENT` is one call, and so is an `INTERNAL` or a `RESOURCE_EXHAUSTED`, which leave the refund `PENDING`. The starter makes one attempt.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*3\b/, /DEADLINE_EXCEEDED/, /UNAVAILABLE/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*3\b/, /DEADLINE_EXCEEDED/, /UNAVAILABLE/]},
        go: {all: [/maxAttempts\s*=\s*3\b/, /codes\.DeadlineExceeded/, /codes\.Unavailable/]},
        cpp: {all: [/kMaxAttempts\s*=\s*3\b/, /DEADLINE_EXCEEDED/, /UNAVAILABLE/]},
      },
    },
    {
      id: 'pending-reconcile',
      title: 'Keeps an unknown outcome PENDING and reconciles it',
      detail:
        'A refund the PSP paid while every answer was lost ends `CONFIRMED` with the reference `GetRefund` reports; a PSP that stays down, or a `GetRefund` answering `PROCESSING`, leaves it `PENDING` with its reservation. The starter writes both off as `REJECTED`.',
      match: {
        python: {all: [/GetRefund\(/], order: [/psp\.Refund\(/, /return reconcile\(/]},
        typescript: {all: [/GetRefund\(/], order: [/psp\.Refund\(/, /return reconcile\(/]},
        go: {all: [/GetRefund\(/], order: [/psp\.Refund\(/, /return reconcile\(/]},
        cpp: {all: [/GetRefund\(/], order: [/psp->Refund\(/, /return reconcile\(/]},
      },
    },
    {
      id: 'terminal-release',
      title: 'A refusal releases exactly its reservation',
      detail:
        'The PSP refuses a refund on a disputed charge: the row is `REJECTED`, its 4000 leaves the ledger and the confirmed 3000 stays. A refund `GetRefund` reports `FAILED` is released the same way. The starter keeps the 4000 reserved for a refund that will not happen.',
      match: {
        python: {all: [/FAILED_PRECONDITION/, /ledger\.release\(/]},
        typescript: {all: [/FAILED_PRECONDITION/, /\brelease\(/]},
        go: {all: [/codes\.FailedPrecondition/, /ledger\.Release\(/]},
        cpp: {all: [/FAILED_PRECONDITION/, /ledger::release\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

import grpc

import refund_service_pb2
import refund_service_pb2_grpc
from refunds import ledger, records  # records.find_refund, mark_confirmed, mark_rejected; ledger.release

psp = refund_service_pb2_grpc.PspStub(grpc.insecure_channel("psp:9000"))


def refund_via_psp(refund_id: str) -> str:
    """Pay a PENDING refund out through the PSP; answers CONFIRMED, REJECTED or PENDING."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    refund = records.find_refund(refund_id)
    request = refund_service_pb2.RefundRequest(
        refund_id=refund_id, payment_id=refund["payment_id"], amount_minor=refund["amount_minor"], reason_code=refund["reason_code"]
    )
    try:
        reply = psp.Refund(request, metadata=[("idempotency-key", str(uuid.uuid4()))])
    except grpc.RpcError:
        records.mark_rejected(refund_id)
        return "REJECTED"
    records.mark_confirmed(refund_id, reply.psp_ref)
    return "CONFIRMED"
`,
      solution: `import grpc

import refund_service_pb2
import refund_service_pb2_grpc
from refunds import ledger, records  # records.find_refund, mark_confirmed, mark_rejected; ledger.release

PSP_DEADLINE_S = 5
MAX_ATTEMPTS = 3
RETRYABLE = (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE)
REFUSALS = (grpc.StatusCode.INVALID_ARGUMENT, grpc.StatusCode.FAILED_PRECONDITION)

psp = refund_service_pb2_grpc.PspStub(grpc.insecure_channel("psp:9000"))


def reject(refund: dict) -> str:
    records.mark_rejected(refund["refund_id"])
    ledger.release(refund["payment_id"], refund["refund_id"])  # this refund's reservation, nothing else
    return "REJECTED"


def reconcile(refund_id: str) -> str:
    """Ask the PSP what became of the refund; settle the record when it knows."""
    refund = records.find_refund(refund_id)
    try:
        status = psp.GetRefund(refund_service_pb2.GetRefundRequest(refund_id=refund_id), timeout=PSP_DEADLINE_S)
    except grpc.RpcError:
        return "PENDING"  # still unknown: the next pass asks again
    if status.status == "SUCCEEDED":
        records.mark_confirmed(refund_id, status.psp_ref)
        return "CONFIRMED"
    if status.status == "FAILED":
        return reject(refund)
    return "PENDING"


def refund_via_psp(refund_id: str) -> str:
    """Pay a PENDING refund out through the PSP; answers CONFIRMED, REJECTED or PENDING."""
    refund = records.find_refund(refund_id)
    request = refund_service_pb2.RefundRequest(
        refund_id=refund_id, payment_id=refund["payment_id"], amount_minor=refund["amount_minor"], reason_code=refund["reason_code"]
    )
    for _attempt in range(MAX_ATTEMPTS):
        try:
            # The same key on every attempt: the PSP answers a repeat with the first result.
            reply = psp.Refund(request, timeout=PSP_DEADLINE_S, metadata=[("idempotency-key", refund_id)])
        except grpc.RpcError as exc:
            if exc.code() in REFUSALS:
                return reject(refund)
            if exc.code() in RETRYABLE:
                continue
            break
        records.mark_confirmed(refund_id, reply.psp_ref)
        return "CONFIRMED"
    # No answer: the PSP may have paid. Keep the reservation and ask.
    return reconcile(refund_id)
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {release} from 'refunds/ledger';
import {type Refund, findRefund, markConfirmed, markRejected} from 'refunds/records';

interface RefundRequest {
  refund_id: string;
  payment_id: string;
  amount_minor: number;
  reason_code: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('refund_service.proto')) as unknown as {
  refundd: {Psp: grpc.ServiceClientConstructor};
};
const psp = new pkg.refundd.Psp('psp:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Refund(request: RefundRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{psp_ref: string; status: string}>;
  GetRefund(request: {refund_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{status: string; psp_ref: string}>;
};

/** Pay a PENDING refund out through the PSP; answers CONFIRMED, REJECTED or PENDING. */
export async function refundViaPsp(refundId: string): Promise<string> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const refund = (await findRefund(refundId)) as Refund;
  const metadata = new grpc.Metadata();
  metadata.set('idempotency-key', randomUUID());
  try {
    const reply = await psp.Refund(
      {refund_id: refundId, payment_id: refund.payment_id, amount_minor: refund.amount_minor, reason_code: refund.reason_code},
      metadata,
      {},
    );
    await markConfirmed(refundId, reply.psp_ref);
    return 'CONFIRMED';
  } catch {
    await markRejected(refundId);
    return 'REJECTED';
  }
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {release} from 'refunds/ledger';
import {type Refund, findRefund, markConfirmed, markRejected} from 'refunds/records';

export const PSP_DEADLINE_MS = 5000;
export const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set<number>([grpc.status.DEADLINE_EXCEEDED, grpc.status.UNAVAILABLE]);
const REFUSALS = new Set<number>([grpc.status.INVALID_ARGUMENT, grpc.status.FAILED_PRECONDITION]);

interface RefundRequest {
  refund_id: string;
  payment_id: string;
  amount_minor: number;
  reason_code: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('refund_service.proto')) as unknown as {
  refundd: {Psp: grpc.ServiceClientConstructor};
};
const psp = new pkg.refundd.Psp('psp:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Refund(request: RefundRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{psp_ref: string; status: string}>;
  GetRefund(request: {refund_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{status: string; psp_ref: string}>;
};

async function reject(refund: Refund): Promise<string> {
  await markRejected(refund.refund_id);
  await release(refund.payment_id, refund.refund_id); // this refund's reservation, nothing else
  return 'REJECTED';
}

/** Ask the PSP what became of the refund; settle the record when it knows. */
export async function reconcile(refundId: string): Promise<string> {
  const refund = (await findRefund(refundId)) as Refund;
  let status;
  try {
    status = await psp.GetRefund({refund_id: refundId}, new grpc.Metadata(), {deadline: Date.now() + PSP_DEADLINE_MS});
  } catch {
    return 'PENDING'; // still unknown: the next pass asks again
  }
  if (status.status === 'SUCCEEDED') {
    await markConfirmed(refundId, status.psp_ref);
    return 'CONFIRMED';
  }
  if (status.status === 'FAILED') return reject(refund);
  return 'PENDING';
}

/** Pay a PENDING refund out through the PSP; answers CONFIRMED, REJECTED or PENDING. */
export async function refundViaPsp(refundId: string): Promise<string> {
  const refund = (await findRefund(refundId)) as Refund;
  const request = {refund_id: refundId, payment_id: refund.payment_id, amount_minor: refund.amount_minor, reason_code: refund.reason_code};
  // The same key on every attempt: the PSP answers a repeat with the first result.
  const metadata = new grpc.Metadata();
  metadata.set('idempotency-key', refundId);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await psp.Refund(request, metadata, {deadline: Date.now() + PSP_DEADLINE_MS});
      await markConfirmed(refundId, reply.psp_ref);
      return 'CONFIRMED';
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      if (REFUSALS.has(code)) return reject(refund);
      if (!RETRYABLE.has(code)) break;
    }
  }
  // No answer: the PSP may have paid. Keep the reservation and ask.
  return reconcile(refundId);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"
	"math/rand/v2"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"

	pb "refunds/gen/refund_service"
	"refunds/records" // records.FindRefund, MarkConfirmed, MarkRejected
)

var (
	pspConn, _ = grpc.NewClient("psp:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	psp        = pb.NewPspClient(pspConn)
)

// refundViaPSP pays a PENDING refund out through the PSP; it answers CONFIRMED, REJECTED or PENDING.
func refundViaPSP(ctx context.Context, refundID string) (string, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	refund := records.FindRefund(ctx, refundID)
	request := &pb.RefundRequest{RefundId: refundID, PaymentId: refund.PaymentID, AmountMinor: refund.AmountMinor, ReasonCode: refund.ReasonCode}
	key := fmt.Sprintf("%016x", rand.Uint64())
	reply, err := psp.Refund(metadata.AppendToOutgoingContext(ctx, "idempotency-key", key), request)
	if err != nil {
		records.MarkRejected(ctx, refundID)
		return "REJECTED", nil
	}
	records.MarkConfirmed(ctx, refundID, reply.GetPspRef())
	return "CONFIRMED", nil
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "refunds/gen/refund_service"
	"refunds/ledger"  // ledger.Release
	"refunds/records" // records.FindRefund, MarkConfirmed, MarkRejected
)

const (
	pspDeadline = 5 * time.Second
	maxAttempts = 3
)

var (
	pspConn, _ = grpc.NewClient("psp:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	psp        = pb.NewPspClient(pspConn)
)

func reject(ctx context.Context, refund *records.Refund) (string, error) {
	records.MarkRejected(ctx, refund.RefundID)
	// This refund's reservation, nothing else.
	if _, err := ledger.Release(ctx, refund.PaymentID, refund.RefundID); err != nil {
		return "", err
	}
	return "REJECTED", nil
}

// reconcile asks the PSP what became of the refund and settles the record when it knows.
func reconcile(ctx context.Context, refundID string) (string, error) {
	refund := records.FindRefund(ctx, refundID)
	callCtx, cancel := context.WithTimeout(ctx, pspDeadline)
	defer cancel()
	got, err := psp.GetRefund(callCtx, &pb.GetRefundRequest{RefundId: refundID})
	if err != nil {
		return "PENDING", nil // still unknown: the next pass asks again
	}
	switch got.GetStatus() {
	case "SUCCEEDED":
		records.MarkConfirmed(ctx, refundID, got.GetPspRef())
		return "CONFIRMED", nil
	case "FAILED":
		return reject(ctx, refund)
	}
	return "PENDING", nil
}

// refundViaPSP pays a PENDING refund out through the PSP; it answers CONFIRMED, REJECTED or PENDING.
func refundViaPSP(ctx context.Context, refundID string) (string, error) {
	refund := records.FindRefund(ctx, refundID)
	request := &pb.RefundRequest{RefundId: refundID, PaymentId: refund.PaymentID, AmountMinor: refund.AmountMinor, ReasonCode: refund.ReasonCode}
	// The same key on every attempt: the PSP answers a repeat with the first result.
	keyed := metadata.AppendToOutgoingContext(ctx, "idempotency-key", refundID)
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(keyed, pspDeadline)
		reply, err := psp.Refund(callCtx, request)
		cancel()
		if err == nil {
			records.MarkConfirmed(ctx, refundID, reply.GetPspRef())
			return "CONFIRMED", nil
		}
		code := status.Code(err)
		if code == codes.InvalidArgument || code == codes.FailedPrecondition {
			return reject(ctx, refund)
		}
		if code != codes.DeadlineExceeded && code != codes.Unavailable {
			break
		}
	}
	// No answer: the PSP may have paid. Keep the reservation and ask.
	return reconcile(ctx, refundID)
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <random>
#include <string>

#include "refund_service.grpc.pb.h"
#include "refunds/ledger.h"   // ledger::release
#include "refunds/records.h"  // records::findRefund, markConfirmed, markRejected

auto psp = refundd::Psp::NewStub(grpc::CreateChannel("psp:9000", grpc::InsecureChannelCredentials()));

// Pay a PENDING refund out through the PSP; answers CONFIRMED, REJECTED or PENDING.
std::string refundViaPsp(const std::string& refund_id) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const records::Refund refund = *records::findRefund(refund_id);
  refundd::RefundRequest request;
  request.set_refund_id(refund_id);
  request.set_payment_id(refund.payment_id);
  request.set_amount_minor(refund.amount_minor);
  request.set_reason_code(refund.reason_code);
  grpc::ClientContext ctx;
  ctx.AddMetadata("idempotency-key", std::to_string(std::random_device{}()));
  refundd::RefundReply reply;
  if (!psp->Refund(&ctx, request, &reply).ok()) {
    records::markRejected(refund_id);
    return "REJECTED";
  }
  records::markConfirmed(refund_id, reply.psp_ref());
  return "CONFIRMED";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>

#include "refund_service.grpc.pb.h"
#include "refunds/ledger.h"   // ledger::release
#include "refunds/records.h"  // records::findRefund, markConfirmed, markRejected

constexpr std::chrono::seconds kPspDeadline{5};
constexpr int kMaxAttempts = 3;

auto psp = refundd::Psp::NewStub(grpc::CreateChannel("psp:9000", grpc::InsecureChannelCredentials()));

std::string reject(const records::Refund& refund) {
  records::markRejected(refund.refund_id);
  ledger::release(refund.payment_id, refund.refund_id);  // this refund's reservation, nothing else
  return "REJECTED";
}

// Ask the PSP what became of the refund; settle the record when it knows.
std::string reconcile(const std::string& refund_id) {
  const records::Refund refund = *records::findRefund(refund_id);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kPspDeadline);
  refundd::GetRefundRequest request;
  request.set_refund_id(refund_id);
  refundd::RefundStatus got;
  if (!psp->GetRefund(&ctx, request, &got).ok()) return "PENDING";  // still unknown: the next pass asks again
  if (got.status() == "SUCCEEDED") {
    records::markConfirmed(refund_id, got.psp_ref());
    return "CONFIRMED";
  }
  if (got.status() == "FAILED") return reject(refund);
  return "PENDING";
}

// Pay a PENDING refund out through the PSP; answers CONFIRMED, REJECTED or PENDING.
std::string refundViaPsp(const std::string& refund_id) {
  const records::Refund refund = *records::findRefund(refund_id);
  refundd::RefundRequest request;
  request.set_refund_id(refund_id);
  request.set_payment_id(refund.payment_id);
  request.set_amount_minor(refund.amount_minor);
  request.set_reason_code(refund.reason_code);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kPspDeadline);
    // The same key on every attempt: the PSP answers a repeat with the first result.
    ctx.AddMetadata("idempotency-key", refund_id);
    refundd::RefundReply reply;
    const grpc::Status status = psp->Refund(&ctx, request, &reply);
    if (status.ok()) {
      records::markConfirmed(refund_id, reply.psp_ref());
      return "CONFIRMED";
    }
    const grpc::StatusCode code = status.error_code();
    if (code == grpc::StatusCode::INVALID_ARGUMENT || code == grpc::StatusCode::FAILED_PRECONDITION) return reject(refund);
    if (code != grpc::StatusCode::DEADLINE_EXCEEDED && code != grpc::StatusCode::UNAVAILABLE) break;
  }
  // No answer: the PSP may have paid. Keep the reservation and ask.
  return reconcile(refund_id);
}
`,
    },
  },
  harness: {
    python: `import grpc

import refund_service_pb2
import refund_service_pb2_grpc
from refunds import ledger, records


class Psp(refund_service_pb2_grpc.PspServicer):
    """The PSP stand-in: Refund is idempotent on the idempotency-key metadata, refuses a disputed
    charge, and while drop > 0 pays the refund out but loses the answer (UNAVAILABLE). GetRefund
    answers statuses[refund_id] when set (FAILED, PROCESSING)."""

    def __init__(self):
        self.by_key = {}
        self.applied = {}
        self.payouts = []
        self.keys = []
        self.drop = 0
        self.statuses = {}

    def Refund(self, request, context):
        key = dict(context.invocation_metadata()).get("idempotency-key", "")
        self.keys.append(key)
        if request.payment_id == "pay_disputed":
            context.abort(grpc.StatusCode.FAILED_PRECONDITION, "charge_for_pending_refund_disputed")
        ref = self.by_key.get(key) if key else None
        if ref is None:
            ref = f"re_{len(self.payouts) + 1}"
            self.payouts.append((request.refund_id, request.amount_minor))
            self.applied[request.refund_id] = ref
            if key:
                self.by_key[key] = ref
        if self.drop > 0:
            self.drop -= 1
            context.abort(grpc.StatusCode.UNAVAILABLE, "connection reset after the refund was paid out")
        return refund_service_pb2.RefundReply(psp_ref=ref, status="SUCCEEDED")

    def GetRefund(self, request, context):
        if request.refund_id in self.statuses:
            return refund_service_pb2.RefundStatus(refund_id=request.refund_id, status=self.statuses[request.refund_id], psp_ref="")
        ref = self.applied.get(request.refund_id)
        if ref is None:
            context.abort(grpc.StatusCode.NOT_FOUND, f"no refund {request.refund_id}")
        return refund_service_pb2.RefundStatus(refund_id=request.refund_id, status="SUCCEEDED", psp_ref=ref)


def _client(ctx, payment="pay_1", refunds=(("rf-1", 3000),)):
    psp = Psp()
    ctx.grpc.serve(refund_service_pb2_grpc.add_PspServicer_to_server, psp)
    records.add_payment(payment, "t1", 10000)
    for refund_id, amount in refunds:
        ledger.claim(payment, refund_id, amount, 10000)
        records.insert_refund(refund_id, "t1", payment, amount, "damaged", "")
    return ctx.load("client"), psp


def check_deadline(ctx):
    m, psp = _client(ctx)
    ctx.grpc.set_latency("Refund", 10.0)
    before = ctx.clock.time()
    status = m.refund_via_psp("rf-1")
    calls = ctx.grpc.calls_to("Refund") + ctx.grpc.calls_to("GetRefund")
    assert len(ctx.grpc.calls_to("Refund")) == 3, f"with the PSP slower than the deadline refund_via_psp sent {len(ctx.grpc.calls_to('Refund'))} Refund calls, expected 3: DEADLINE_EXCEEDED leaves the outcome unknown and is retried"
    for call in calls:
        assert call.timeout is not None, f"a {call.method} call carries no deadline: a PSP that hangs holds the refund open"
        assert 4.5 <= call.timeout <= 5.5, f"a {call.method} call carries a {call.timeout} s deadline, expected PSP_DEADLINE_S = 5"
    assert status == "PENDING" and records.find_refund("rf-1")["status"] == "PENDING", f"with the PSP slower than the deadline on every attempt refund_via_psp answered {status!r}, expected PENDING: nobody knows whether it paid"
    waited = ctx.clock.time() - before
    assert waited <= 21, f"refund_via_psp took {waited:.0f} s against a PSP that does not answer, expected at most 3 attempts of 5 s and one GetRefund"


def check_stable_key(ctx):
    m, psp = _client(ctx)
    psp.drop = 1
    status = m.refund_via_psp("rf-1")
    assert psp.keys and all(key == "rf-1" for key in psp.keys), f"the Refund calls carried idempotency-key {psp.keys}, expected rf-1 on every attempt: a fresh key makes a retry a second refund"
    assert status == "CONFIRMED", f"the PSP paid rf-1 and lost the first answer; refund_via_psp answered {status!r}, expected CONFIRMED"
    m.refund_via_psp("rf-1")
    assert psp.payouts == [("rf-1", 3000)], f"the PSP paid out {psp.payouts} for one refund of 3000 after a lost answer and a re-run"
    assert records.find_refund("rf-1")["psp_ref"] == "re_1", f"the record holds psp_ref {records.find_refund('rf-1')['psp_ref']!r}, expected re_1"


def check_retry_policy(ctx):
    m, psp = _client(ctx, refunds=(("rf-1", 3000), ("rf-2", 2000), ("rf-3", 1000), ("rf-4", 1000)))
    ctx.grpc.fail("Refund", grpc.StatusCode.UNAVAILABLE, times=2)
    status = m.refund_via_psp("rf-1")
    calls = len(ctx.grpc.calls_to("Refund"))
    assert status == "CONFIRMED" and calls == 3, f"with two UNAVAILABLE answers then a success refund_via_psp answered {status!r} after {calls} calls, expected CONFIRMED after 3"
    ctx.grpc.fail("Refund", grpc.StatusCode.INVALID_ARGUMENT, "amount_minor exceeds the charge", times=1)
    status = m.refund_via_psp("rf-2")
    calls = len(ctx.grpc.calls_to("Refund")) - 3
    assert status == "REJECTED" and calls == 1, f"an INVALID_ARGUMENT answered {status!r} after {calls} calls, expected REJECTED after 1: a refusal is not retried"
    for n, (refund_id, code) in enumerate((("rf-3", grpc.StatusCode.INTERNAL), ("rf-4", grpc.StatusCode.RESOURCE_EXHAUSTED))):
        ctx.grpc.fail("Refund", code, "the PSP broke", times=1)
        status = m.refund_via_psp(refund_id)
        calls = len(ctx.grpc.calls_to("Refund")) - 4 - n
        row = records.find_refund(refund_id)
        assert calls == 1 and status == "PENDING" and row["status"] == "PENDING", f"{code.name} answered {status!r} after {calls} Refund calls and left the row {row['status']}, expected PENDING after 1: only DEADLINE_EXCEEDED and UNAVAILABLE are retried, and another code is no refusal"
    assert ledger.refunded_total("pay_1") == 5000, f"the ledger holds {ledger.refunded_total('pay_1')}, expected 5000: only the refusal of rf-2 gives its reservation back"


def check_pending_reconcile(ctx):
    m, psp = _client(ctx, refunds=(("rf-1", 3000), ("rf-2", 2000)))
    psp.drop = 3
    status = m.refund_via_psp("rf-1")
    row = records.find_refund("rf-1")
    assert status == "CONFIRMED" and row["status"] == "CONFIRMED" and row["psp_ref"] == "re_1", f"the PSP paid rf-1 but every answer was lost: refund_via_psp answered {status!r} and the record holds {row['status']} {row['psp_ref']!r}, expected CONFIRMED with re_1 from GetRefund"
    ctx.grpc.fail("Refund", grpc.StatusCode.UNAVAILABLE, times=3)
    status = m.refund_via_psp("rf-2")
    row = records.find_refund("rf-2")
    assert status == "PENDING" and row["status"] == "PENDING", f"with the PSP down for every attempt and GetRefund answering NOT_FOUND, refund_via_psp answered {status!r} and the record holds {row['status']}, expected PENDING"
    assert ledger.refunded_total("pay_1") == 5000, f"the ledger holds {ledger.refunded_total('pay_1')}, expected 5000: an unknown outcome keeps its reservation"
    records.insert_refund("rf-3", "t1", "pay_1", 1000, "damaged", "")
    ledger.claim("pay_1", "rf-3", 1000, 10000)
    psp.statuses["rf-3"] = "PROCESSING"
    ctx.grpc.fail("Refund", grpc.StatusCode.UNAVAILABLE, times=3)
    status = m.refund_via_psp("rf-3")
    row = records.find_refund("rf-3")
    assert ctx.grpc.calls_to("GetRefund") and status == "PENDING" and row["status"] == "PENDING", f"with the PSP down and GetRefund answering PROCESSING, refund_via_psp answered {status!r} and the record holds {row['status']}, expected PENDING: only SUCCEEDED and FAILED settle a refund"
    assert ledger.refunded_total("pay_1") == 6000, f"the ledger holds {ledger.refunded_total('pay_1')}, expected 6000: a refund still PROCESSING keeps its reservation"


def check_terminal_release(ctx):
    m, psp = _client(ctx, payment="pay_disputed", refunds=(("rf-1", 3000), ("rf-2", 4000)))
    records.mark_confirmed("rf-1", "re_0")
    status = m.refund_via_psp("rf-2")
    assert status == "REJECTED" and records.find_refund("rf-2")["status"] == "REJECTED", f"the PSP refused rf-2 with FAILED_PRECONDITION; refund_via_psp answered {status!r}, expected REJECTED"
    total = ledger.refunded_total("pay_disputed")
    held = ctx.redis.hgetall("refunded:pay_disputed")
    assert total == 3000 and "rf-2" not in held and "rf-1" in held, f"after the refusal the ledger holds {total} over {held}, expected 3000 over rf-1: release exactly the refused refund's reservation"
    assert len(ctx.grpc.calls_to("Refund")) == 1, f"a refusal was sent {len(ctx.grpc.calls_to('Refund'))} times: it is not retried"
    # The PSP's answers are lost, and GetRefund reports the refund FAILED: a refusal too.
    records.insert_refund("rf-3", "t1", "pay_disputed", 1000, "damaged", "")
    ledger.claim("pay_disputed", "rf-3", 1000, 10000)
    psp.statuses["rf-3"] = "FAILED"
    ctx.grpc.fail("Refund", grpc.StatusCode.UNAVAILABLE, times=3)
    status = m.refund_via_psp("rf-3")
    row = records.find_refund("rf-3")
    total = ledger.refunded_total("pay_disputed")
    held = ctx.redis.hgetall("refunded:pay_disputed")
    assert status == "REJECTED" and row["status"] == "REJECTED", f"GetRefund reported rf-3 FAILED; refund_via_psp answered {status!r} and the record holds {row['status']}, expected REJECTED"
    assert total == 3000 and "rf-3" not in held and "rf-1" in held, f"after GetRefund reported rf-3 FAILED the ledger holds {total} over {held}, expected 3000 over rf-1: a FAILED refund gives its reservation back"
`,
    typescript: `function client(ctx, payment = 'pay_1', refunds: [string, number][] = [['rf-1', 3000]]) {
  const peer = {byKey: new Map<string, string>(), applied: new Map<string, string>(), payouts: [] as string[], keys: [] as string[], drop: 0, statuses: new Map<string, string>()};
  const pkg = ctx.proto('refund_service.proto');
  ctx.grpc.serve(pkg.refundd.Psp.service, {
    Refund(call, callback) {
      const key = String(call.metadata.get('idempotency-key')[0] ?? '');
      peer.keys.push(key);
      const {refund_id, payment_id, amount_minor} = call.request;
      if (payment_id === 'pay_disputed') return callback({code: ctx.grpc.status.FAILED_PRECONDITION, details: 'charge_for_pending_refund_disputed'});
      let ref = key === '' ? undefined : peer.byKey.get(key);
      if (ref === undefined) {
        ref = \`re_\${peer.payouts.length + 1}\`;
        peer.payouts.push(\`\${refund_id}:\${Number(amount_minor)}\`);
        peer.applied.set(refund_id, ref);
        if (key !== '') peer.byKey.set(key, ref);
      }
      if (peer.drop > 0) {
        peer.drop--;
        return callback({code: ctx.grpc.status.UNAVAILABLE, details: 'connection reset after the refund was paid out'});
      }
      callback(null, {psp_ref: ref, status: 'SUCCEEDED'});
    },
    GetRefund(call, callback) {
      const forced = peer.statuses.get(call.request.refund_id);
      if (forced !== undefined) return callback(null, {refund_id: call.request.refund_id, status: forced, psp_ref: ''});
      const ref = peer.applied.get(call.request.refund_id);
      if (ref === undefined) return callback({code: ctx.grpc.status.NOT_FOUND, details: \`no refund \${call.request.refund_id}\`});
      callback(null, {refund_id: call.request.refund_id, status: 'SUCCEEDED', psp_ref: ref});
    },
  });
  const records = ctx.load('/support/refunds/records.ts');
  const ledger = ctx.load('/support/refunds/ledger.ts');
  const seed = async () => {
    await records.addPayment(payment, 't1', 10000);
    for (const [refundId, amount] of refunds) {
      await ledger.claim(payment, refundId, amount, 10000);
      await records.insertRefund(refundId, 't1', payment, amount, 'damaged', '');
    }
  };
  return {m: ctx.load('client'), peer, records, ledger, seed};
}

export async function check_deadline(ctx) {
  const {m, records, seed} = client(ctx);
  await seed();
  ctx.grpc.setLatency('Refund', 10.0);
  const before = ctx.clock.now();
  const status = await m.refundViaPsp('rf-1');
  assert(ctx.grpc.callsTo('Refund').length > 0, 'refundViaPsp made no Refund call');
  assert.equal(ctx.grpc.callsTo('Refund').length, 3, \`with the PSP slower than the deadline refundViaPsp sent \${ctx.grpc.callsTo('Refund').length} Refund calls, expected 3: DEADLINE_EXCEEDED leaves the outcome unknown and is retried\`);
  for (const call of [...ctx.grpc.callsTo('Refund'), ...ctx.grpc.callsTo('GetRefund')]) {
    assert(call.timeout !== null, \`a \${call.method} call carries no deadline: a PSP that hangs holds the refund open\`);
    assert(4.5 <= call.timeout && call.timeout <= 5.5, \`a \${call.method} call carries a \${call.timeout} s deadline, expected PSP_DEADLINE_MS = 5000\`);
  }
  const row = await records.findRefund('rf-1');
  assert(status === 'PENDING' && row.status === 'PENDING', \`with the PSP slower than the deadline on every attempt refundViaPsp resolved \${status}, expected PENDING: nobody knows whether it paid\`);
  const waited = (ctx.clock.now() - before) / 1000;
  assert(waited <= 21, \`refundViaPsp took \${waited.toFixed(0)} s against a PSP that does not answer, expected at most 3 attempts of 5 s and one GetRefund\`);
}

export async function check_stable_key(ctx) {
  const {m, peer, records, seed} = client(ctx);
  await seed();
  peer.drop = 1;
  const status = await m.refundViaPsp('rf-1');
  assert(peer.keys.length > 0 && peer.keys.every(key => key === 'rf-1'), \`the Refund calls carried idempotency-key \${JSON.stringify(peer.keys)}, expected rf-1 on every attempt: a fresh key makes a retry a second refund\`);
  assert.equal(status, 'CONFIRMED', \`the PSP paid rf-1 and lost the first answer; refundViaPsp resolved \${status}, expected CONFIRMED\`);
  await m.refundViaPsp('rf-1');
  assert.deepEqual(peer.payouts, ['rf-1:3000'], \`the PSP paid out \${JSON.stringify(peer.payouts)} for one refund of 3000 after a lost answer and a re-run\`);
  assert.equal((await records.findRefund('rf-1')).psp_ref, 're_1', 'the record must hold psp_ref re_1');
}

export async function check_retry_policy(ctx) {
  const {m, records, ledger, seed} = client(ctx, 'pay_1', [['rf-1', 3000], ['rf-2', 2000], ['rf-3', 1000], ['rf-4', 1000]]);
  await seed();
  ctx.grpc.fail('Refund', ctx.grpc.status.UNAVAILABLE, '', 2);
  let status = await m.refundViaPsp('rf-1');
  let calls = ctx.grpc.callsTo('Refund').length;
  assert(status === 'CONFIRMED' && calls === 3, \`with two UNAVAILABLE answers then a success refundViaPsp resolved \${status} after \${calls} calls, expected CONFIRMED after 3\`);
  ctx.grpc.fail('Refund', ctx.grpc.status.INVALID_ARGUMENT, 'amount_minor exceeds the charge', 1);
  status = await m.refundViaPsp('rf-2');
  calls = ctx.grpc.callsTo('Refund').length - 3;
  assert(status === 'REJECTED' && calls === 1, \`an INVALID_ARGUMENT resolved \${status} after \${calls} calls, expected REJECTED after 1: a refusal is not retried\`);
  const others: [string, string][] = [['rf-3', 'INTERNAL'], ['rf-4', 'RESOURCE_EXHAUSTED']];
  for (const [n, [refundId, code]] of others.entries()) {
    ctx.grpc.fail('Refund', ctx.grpc.status[code], 'the PSP broke', 1);
    status = await m.refundViaPsp(refundId);
    calls = ctx.grpc.callsTo('Refund').length - 4 - n;
    const row = await records.findRefund(refundId);
    assert(calls === 1 && status === 'PENDING' && row.status === 'PENDING', \`\${code} resolved \${status} after \${calls} Refund calls and left the row \${row.status}, expected PENDING after 1: only DEADLINE_EXCEEDED and UNAVAILABLE are retried, and another code is no refusal\`);
  }
  const total = await ledger.refundedTotal('pay_1');
  assert.equal(total, 5000, \`the ledger holds \${total}, expected 5000: only the refusal of rf-2 gives its reservation back\`);
}

export async function check_pending_reconcile(ctx) {
  const {m, peer, records, ledger, seed} = client(ctx, 'pay_1', [['rf-1', 3000], ['rf-2', 2000]]);
  await seed();
  peer.drop = 3;
  let status = await m.refundViaPsp('rf-1');
  let row = await records.findRefund('rf-1');
  assert(status === 'CONFIRMED' && row.status === 'CONFIRMED' && row.psp_ref === 're_1', \`the PSP paid rf-1 but every answer was lost: refundViaPsp resolved \${status} and the record holds \${row.status} \${row.psp_ref}, expected CONFIRMED with re_1 from GetRefund\`);
  ctx.grpc.fail('Refund', ctx.grpc.status.UNAVAILABLE, '', 3);
  status = await m.refundViaPsp('rf-2');
  row = await records.findRefund('rf-2');
  assert(status === 'PENDING' && row.status === 'PENDING', \`with the PSP down for every attempt and GetRefund answering NOT_FOUND, refundViaPsp resolved \${status} and the record holds \${row.status}, expected PENDING\`);
  const total = await ledger.refundedTotal('pay_1');
  assert.equal(total, 5000, \`the ledger holds \${total}, expected 5000: an unknown outcome keeps its reservation\`);
  await records.insertRefund('rf-3', 't1', 'pay_1', 1000, 'damaged', '');
  await ledger.claim('pay_1', 'rf-3', 1000, 10000);
  peer.statuses.set('rf-3', 'PROCESSING');
  ctx.grpc.fail('Refund', ctx.grpc.status.UNAVAILABLE, '', 3);
  status = await m.refundViaPsp('rf-3');
  row = await records.findRefund('rf-3');
  assert(ctx.grpc.callsTo('GetRefund').length > 0 && status === 'PENDING' && row.status === 'PENDING', \`with the PSP down and GetRefund answering PROCESSING, refundViaPsp resolved \${status} and the record holds \${row.status}, expected PENDING: only SUCCEEDED and FAILED settle a refund\`);
  const kept = await ledger.refundedTotal('pay_1');
  assert.equal(kept, 6000, \`the ledger holds \${kept}, expected 6000: a refund still PROCESSING keeps its reservation\`);
}

export async function check_terminal_release(ctx) {
  const {m, peer, records, ledger, seed} = client(ctx, 'pay_disputed', [['rf-1', 3000], ['rf-2', 4000]]);
  await seed();
  await records.markConfirmed('rf-1', 're_0');
  const status = await m.refundViaPsp('rf-2');
  const row = await records.findRefund('rf-2');
  assert(status === 'REJECTED' && row.status === 'REJECTED', \`the PSP refused rf-2 with FAILED_PRECONDITION; refundViaPsp resolved \${status}, expected REJECTED\`);
  const total = await ledger.refundedTotal('pay_disputed');
  const held = ctx.redis.hgetall('refunded:pay_disputed');
  assert(total === 3000 && !('rf-2' in held) && 'rf-1' in held, \`after the refusal the ledger holds \${total} over \${JSON.stringify(held)}, expected 3000 over rf-1: release exactly the refused refund's reservation\`);
  assert.equal(ctx.grpc.callsTo('Refund').length, 1, 'a refusal is not retried');
  // The PSP's answers are lost, and GetRefund reports the refund FAILED: a refusal too.
  await records.insertRefund('rf-3', 't1', 'pay_disputed', 1000, 'damaged', '');
  await ledger.claim('pay_disputed', 'rf-3', 1000, 10000);
  peer.statuses.set('rf-3', 'FAILED');
  ctx.grpc.fail('Refund', ctx.grpc.status.UNAVAILABLE, '', 3);
  const failed = await m.refundViaPsp('rf-3');
  const failedRow = await records.findRefund('rf-3');
  assert(failed === 'REJECTED' && failedRow.status === 'REJECTED', \`GetRefund reported rf-3 FAILED; refundViaPsp resolved \${failed} and the record holds \${failedRow.status}, expected REJECTED\`);
  const left = await ledger.refundedTotal('pay_disputed');
  const after = ctx.redis.hgetall('refunded:pay_disputed');
  assert(left === 3000 && !('rf-3' in after) && 'rf-1' in after, \`after GetRefund reported rf-3 FAILED the ledger holds \${left} over \${JSON.stringify(after)}, expected 3000 over rf-1: a FAILED refund gives its reservation back\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "refunds/gen/refund_service"
	"refunds/ledger"
	"refunds/records"

	"leetbuild/harness"
)

var hClientBg = context.Background()

// HPspPeer is the PSP stand-in: Refund is idempotent on the idempotency-key metadata, refuses a
// disputed charge, and while drop > 0 pays the refund out but loses the answer (UNAVAILABLE).
// GetRefund answers statuses[refundID] when set (FAILED, PROCESSING).
type HPspPeer struct {
	pb.UnimplementedPspServer
	byKey    map[string]string
	applied  map[string]string
	statuses map[string]string
	payouts  []string
	keys     []string
	drop     int
}

func (p *HPspPeer) Refund(ctx context.Context, req *pb.RefundRequest) (*pb.RefundReply, error) {
	key := ""
	if md, ok := metadata.FromIncomingContext(ctx); ok {
		if values := md.Get("idempotency-key"); len(values) > 0 {
			key = values[0]
		}
	}
	p.keys = append(p.keys, key)
	if req.GetPaymentId() == "pay_disputed" {
		return nil, status.Error(codes.FailedPrecondition, "charge_for_pending_refund_disputed")
	}
	ref := ""
	if key != "" {
		ref = p.byKey[key]
	}
	if ref == "" {
		ref = fmt.Sprintf("re_%d", len(p.payouts)+1)
		p.payouts = append(p.payouts, fmt.Sprintf("%s:%d", req.GetRefundId(), req.GetAmountMinor()))
		p.applied[req.GetRefundId()] = ref
		if key != "" {
			p.byKey[key] = ref
		}
	}
	if p.drop > 0 {
		p.drop--
		return nil, status.Error(codes.Unavailable, "connection reset after the refund was paid out")
	}
	return &pb.RefundReply{PspRef: ref, Status: "SUCCEEDED"}, nil
}

func (p *HPspPeer) GetRefund(_ context.Context, req *pb.GetRefundRequest) (*pb.RefundStatus, error) {
	if forced, ok := p.statuses[req.GetRefundId()]; ok {
		return &pb.RefundStatus{RefundId: req.GetRefundId(), Status: forced}, nil
	}
	ref, ok := p.applied[req.GetRefundId()]
	if !ok {
		return nil, status.Errorf(codes.NotFound, "no refund %s", req.GetRefundId())
	}
	return &pb.RefundStatus{RefundId: req.GetRefundId(), Status: "SUCCEEDED", PspRef: ref}, nil
}

type HClientSeed struct {
	id     string
	amount int64
}

func hClientServe(ctx *harness.Ctx, payment string, refunds ...HClientSeed) *HPspPeer {
	peer := &HPspPeer{byKey: map[string]string{}, applied: map[string]string{}, statuses: map[string]string{}}
	pb.RegisterPspServer(ctx.GRPC.Server(""), peer)
	records.AddPayment(hClientBg, payment, "t1", 10000)
	for _, r := range refunds {
		ledger.Claim(hClientBg, payment, r.id, r.amount, 10000)
		records.InsertRefund(hClientBg, r.id, "t1", payment, r.amount, "damaged", "")
	}
	return peer
}

func hClientPay(ctx *harness.Ctx, refundID string) string {
	got, err := refundViaPSP(hClientBg, refundID)
	ctx.NoError(err, "refundViaPSP(%s)", refundID)
	return got
}

func CheckDeadline(ctx *harness.Ctx) {
	hClientServe(ctx, "pay_1", HClientSeed{"rf-1", 3000})
	ctx.GRPC.SetLatency("Refund", 10.0, "")
	before := ctx.Clock.Now()
	got := hClientPay(ctx, "rf-1")
	ctx.Assert(len(ctx.GRPC.CallsTo("Refund", "")) > 0, "refundViaPSP made no Refund call")
	ctx.Equal(len(ctx.GRPC.CallsTo("Refund", "")), 3, "with the PSP slower than the deadline (DEADLINE_EXCEEDED leaves the outcome unknown and is retried) the Refund calls")
	for _, method := range []string{"Refund", "GetRefund"} {
		for _, call := range ctx.GRPC.CallsTo(method, "") {
			ctx.Assert(call.HasDeadline(), "a %s call carries no deadline: a PSP that hangs holds the refund open", method)
			ctx.Assert(4500*time.Millisecond <= call.Timeout && call.Timeout <= 5500*time.Millisecond, "a %s call carries a %v deadline, expected pspDeadline = 5 s", method, call.Timeout)
		}
	}
	ctx.Assert(got == "PENDING" && records.FindRefund(hClientBg, "rf-1").Status == "PENDING", "with the PSP slower than the deadline on every attempt refundViaPSP answered %q, expected PENDING: nobody knows whether it paid", got)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Assert(waited <= 21, "refundViaPSP took %.0f s against a PSP that does not answer, expected at most 3 attempts of 5 s and one GetRefund", waited)
}

func CheckStableKey(ctx *harness.Ctx) {
	peer := hClientServe(ctx, "pay_1", HClientSeed{"rf-1", 3000})
	peer.drop = 1
	got := hClientPay(ctx, "rf-1")
	ctx.Assert(len(peer.keys) > 0, "refundViaPSP made no Refund call")
	for _, key := range peer.keys {
		ctx.Assert(key == "rf-1", "the Refund calls carried idempotency-key %v, expected rf-1 on every attempt: a fresh key makes a retry a second refund", peer.keys)
	}
	ctx.Equal(got, "CONFIRMED", "the PSP paid rf-1 and lost the first answer; refundViaPSP's status")
	hClientPay(ctx, "rf-1")
	ctx.Equal(peer.payouts, []string{"rf-1:3000"}, "after a lost answer and a re-run the PSP must pay one refund of 3000 once; the payouts")
	ctx.Equal(records.FindRefund(hClientBg, "rf-1").PspRef, "re_1", "the record's psp_ref")
}

func CheckRetryPolicy(ctx *harness.Ctx) {
	hClientServe(ctx, "pay_1", HClientSeed{"rf-1", 3000}, HClientSeed{"rf-2", 2000}, HClientSeed{"rf-3", 1000}, HClientSeed{"rf-4", 1000})
	ctx.GRPC.Fail("Refund", codes.Unavailable, "", 2, "")
	got := hClientPay(ctx, "rf-1")
	calls := len(ctx.GRPC.CallsTo("Refund", ""))
	ctx.Assert(got == "CONFIRMED" && calls == 3, "with two UNAVAILABLE answers then a success refundViaPSP answered %q after %d calls, expected CONFIRMED after 3", got, calls)
	ctx.GRPC.Fail("Refund", codes.InvalidArgument, "amount_minor exceeds the charge", 1, "")
	got = hClientPay(ctx, "rf-2")
	calls = len(ctx.GRPC.CallsTo("Refund", "")) - 3
	ctx.Assert(got == "REJECTED" && calls == 1, "an INVALID_ARGUMENT answered %q after %d calls, expected REJECTED after 1: a refusal is not retried", got, calls)
	others := []struct {
		id   string
		code codes.Code
		name string
	}{{"rf-3", codes.Internal, "INTERNAL"}, {"rf-4", codes.ResourceExhausted, "RESOURCE_EXHAUSTED"}}
	for n, other := range others {
		ctx.GRPC.Fail("Refund", other.code, "the PSP broke", 1, "")
		got = hClientPay(ctx, other.id)
		calls = len(ctx.GRPC.CallsTo("Refund", "")) - 4 - n
		row := records.FindRefund(hClientBg, other.id)
		ctx.Assert(calls == 1 && got == "PENDING" && row.Status == "PENDING", "%s answered %q after %d Refund calls and left the row %s, expected PENDING after 1: only DEADLINE_EXCEEDED and UNAVAILABLE are retried, and another code is no refusal", other.name, got, calls, row.Status)
	}
	ctx.Equal(ledger.RefundedTotal(hClientBg, "pay_1"), 5000, "only the refusal of rf-2 gives its reservation back; the ledger")
}

func CheckPendingReconcile(ctx *harness.Ctx) {
	peer := hClientServe(ctx, "pay_1", HClientSeed{"rf-1", 3000}, HClientSeed{"rf-2", 2000})
	peer.drop = 3
	got := hClientPay(ctx, "rf-1")
	row := records.FindRefund(hClientBg, "rf-1")
	ctx.Assert(got == "CONFIRMED" && row.Status == "CONFIRMED" && row.PspRef == "re_1", "the PSP paid rf-1 but every answer was lost: refundViaPSP answered %q and the record holds %s %q, expected CONFIRMED with re_1 from GetRefund", got, row.Status, row.PspRef)
	ctx.GRPC.Fail("Refund", codes.Unavailable, "", 3, "")
	got = hClientPay(ctx, "rf-2")
	row = records.FindRefund(hClientBg, "rf-2")
	ctx.Assert(got == "PENDING" && row.Status == "PENDING", "with the PSP down for every attempt and GetRefund answering NOT_FOUND, refundViaPSP answered %q and the record holds %s, expected PENDING", got, row.Status)
	ctx.Equal(ledger.RefundedTotal(hClientBg, "pay_1"), 5000, "an unknown outcome keeps its reservation; the ledger")
	records.InsertRefund(hClientBg, "rf-3", "t1", "pay_1", 1000, "damaged", "")
	ledger.Claim(hClientBg, "pay_1", "rf-3", 1000, 10000)
	peer.statuses["rf-3"] = "PROCESSING"
	ctx.GRPC.Fail("Refund", codes.Unavailable, "", 3, "")
	got = hClientPay(ctx, "rf-3")
	row = records.FindRefund(hClientBg, "rf-3")
	ctx.Assert(len(ctx.GRPC.CallsTo("GetRefund", "")) > 0 && got == "PENDING" && row.Status == "PENDING", "with the PSP down and GetRefund answering PROCESSING, refundViaPSP answered %q and the record holds %s, expected PENDING: only SUCCEEDED and FAILED settle a refund", got, row.Status)
	ctx.Equal(ledger.RefundedTotal(hClientBg, "pay_1"), 6000, "a refund still PROCESSING keeps its reservation; the ledger")
}

func CheckTerminalRelease(ctx *harness.Ctx) {
	peer := hClientServe(ctx, "pay_disputed", HClientSeed{"rf-1", 3000}, HClientSeed{"rf-2", 4000})
	records.MarkConfirmed(hClientBg, "rf-1", "re_0")
	got := hClientPay(ctx, "rf-2")
	ctx.Assert(got == "REJECTED" && records.FindRefund(hClientBg, "rf-2").Status == "REJECTED", "the PSP refused rf-2 with FAILED_PRECONDITION; refundViaPSP answered %q, expected REJECTED", got)
	total := ledger.RefundedTotal(hClientBg, "pay_disputed")
	held := ctx.Redis.HGetAll("refunded:pay_disputed")
	_, stillHeld := held["rf-2"]
	_, kept := held["rf-1"]
	ctx.Assert(total == 3000 && !stillHeld && kept, "after the refusal the ledger holds %d over %v, expected 3000 over rf-1: release exactly the refused refund's reservation", total, held)
	ctx.Equal(len(ctx.GRPC.CallsTo("Refund", "")), 1, "a refusal is not retried; the Refund calls")
	// The PSP's answers are lost, and GetRefund reports the refund FAILED: a refusal too.
	records.InsertRefund(hClientBg, "rf-3", "t1", "pay_disputed", 1000, "damaged", "")
	ledger.Claim(hClientBg, "pay_disputed", "rf-3", 1000, 10000)
	peer.statuses["rf-3"] = "FAILED"
	ctx.GRPC.Fail("Refund", codes.Unavailable, "", 3, "")
	got = hClientPay(ctx, "rf-3")
	row := records.FindRefund(hClientBg, "rf-3")
	ctx.Assert(got == "REJECTED" && row.Status == "REJECTED", "GetRefund reported rf-3 FAILED; refundViaPSP answered %q and the record holds %s, expected REJECTED", got, row.Status)
	total = ledger.RefundedTotal(hClientBg, "pay_disputed")
	held = ctx.Redis.HGetAll("refunded:pay_disputed")
	_, failedHeld := held["rf-3"]
	_, kept = held["rf-1"]
	ctx.Assert(total == 3000 && !failedHeld && kept, "after GetRefund reported rf-3 FAILED the ledger holds %d over %v, expected 3000 over rf-1: a FAILED refund gives its reservation back", total, held)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <string>
#include <tuple>
#include <utility>
#include <vector>

#include "refund_service.grpc.pb.h"
#include "refunds/ledger.h"
#include "refunds/records.h"

namespace {

// The PSP stand-in: Refund is idempotent on the idempotency-key metadata, refuses a disputed charge,
// and while drop > 0 pays the refund out but loses the answer (UNAVAILABLE). GetRefund answers
// statuses[refund_id] when set (FAILED, PROCESSING).
class HPspPeer final : public refundd::Psp::Service {
 public:
  std::map<std::string, std::string> by_key;
  std::map<std::string, std::string> applied;
  std::map<std::string, std::string> statuses;
  std::vector<std::string> payouts;
  std::vector<std::string> keys;
  int drop = 0;

  grpc::Status Refund(grpc::ServerContext* context, const refundd::RefundRequest* req, refundd::RefundReply* out) override {
    std::string key;
    const auto found = context->client_metadata().find("idempotency-key");
    if (found != context->client_metadata().end()) key = std::string(found->second.data(), found->second.length());
    keys.push_back(key);
    if (req->payment_id() == "pay_disputed") return grpc::Status(grpc::StatusCode::FAILED_PRECONDITION, "charge_for_pending_refund_disputed");
    std::string ref = key.empty() || !by_key.count(key) ? "" : by_key[key];
    if (ref.empty()) {
      ref = "re_" + std::to_string(payouts.size() + 1);
      payouts.push_back(req->refund_id() + ":" + std::to_string(req->amount_minor()));
      applied[req->refund_id()] = ref;
      if (!key.empty()) by_key[key] = ref;
    }
    if (drop > 0) {
      drop--;
      return grpc::Status(grpc::StatusCode::UNAVAILABLE, "connection reset after the refund was paid out");
    }
    out->set_psp_ref(ref);
    out->set_status("SUCCEEDED");
    return grpc::Status::OK;
  }

  grpc::Status GetRefund(grpc::ServerContext*, const refundd::GetRefundRequest* req, refundd::RefundStatus* out) override {
    if (statuses.count(req->refund_id())) {
      out->set_refund_id(req->refund_id());
      out->set_status(statuses[req->refund_id()]);
      return grpc::Status::OK;
    }
    if (!applied.count(req->refund_id())) return grpc::Status(grpc::StatusCode::NOT_FOUND, "no refund " + req->refund_id());
    out->set_refund_id(req->refund_id());
    out->set_status("SUCCEEDED");
    out->set_psp_ref(applied[req->refund_id()]);
    return grpc::Status::OK;
  }
};

HPspPeer& hClientServe(harness::Ctx& ctx, const std::string& payment, const std::vector<std::pair<std::string, long long>>& refunds) {
  static HPspPeer* peer = nullptr;
  delete peer;
  peer = new HPspPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  records::addPayment(payment, "t1", 10000);
  for (const auto& [refund_id, amount] : refunds) {
    ledger::claim(payment, refund_id, amount, 10000);
    records::insertRefund(refund_id, "t1", payment, amount, "damaged", "");
  }
  return *peer;
}

std::string hClientText(const std::vector<std::string>& items) {
  std::string out;
  for (const auto& item : items) out += (out.empty() ? "" : ", ") + item;
  return "[" + out + "]";
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  hClientServe(ctx, "pay_1", {{"rf-1", 3000}});
  ctx.GRPC.SetLatency("Refund", 10.0);
  const int64_t before = ctx.Clock.Now();
  const std::string got = refundViaPsp("rf-1");
  ctx.Assert(!ctx.GRPC.CallsTo("Refund").empty(), "refundViaPsp made no Refund call");
  ctx.Equal(ctx.GRPC.CallsTo("Refund").size(), 3, "with the PSP slower than the deadline (DEADLINE_EXCEEDED leaves the outcome unknown and is retried) the Refund calls");
  for (const std::string method : {"Refund", "GetRefund"}) {
    for (const auto& call : ctx.GRPC.CallsTo(method)) {
      ctx.Assert(call.HasDeadline(), "a %s call carries no deadline: a PSP that hangs holds the refund open", method);
      ctx.Assert(4.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 5.5, "a %s call carries a %v s deadline, expected kPspDeadline = 5 s", method, call.TimeoutSeconds());
    }
  }
  ctx.Assert(got == "PENDING" && records::findRefund("rf-1")->status == "PENDING",
             "with the PSP slower than the deadline on every attempt refundViaPsp answered %q, expected PENDING: nobody knows whether it paid", got);
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Assert(waited <= 21, "refundViaPsp took %.0f s against a PSP that does not answer, expected at most 3 attempts of 5 s and one GetRefund", waited);
}

void CheckStableKey(harness::Ctx& ctx) {
  HPspPeer& peer = hClientServe(ctx, "pay_1", {{"rf-1", 3000}});
  peer.drop = 1;
  const std::string got = refundViaPsp("rf-1");
  bool stable = !peer.keys.empty();
  for (const auto& key : peer.keys) stable = stable && key == "rf-1";
  ctx.Assert(stable, "the Refund calls carried idempotency-key %s, expected rf-1 on every attempt: a fresh key makes a retry a second refund", hClientText(peer.keys));
  ctx.Equal(got, "CONFIRMED", "the PSP paid rf-1 and lost the first answer; refundViaPsp's status");
  refundViaPsp("rf-1");
  ctx.Equal(peer.payouts, std::vector<std::string>{"rf-1:3000"}, "after a lost answer and a re-run the PSP must pay one refund of 3000 once; the payouts");
  ctx.Equal(records::findRefund("rf-1")->psp_ref, "re_1", "the record's psp_ref");
}

void CheckRetryPolicy(harness::Ctx& ctx) {
  hClientServe(ctx, "pay_1", {{"rf-1", 3000}, {"rf-2", 2000}, {"rf-3", 1000}, {"rf-4", 1000}});
  ctx.GRPC.Fail("Refund", grpc::StatusCode::UNAVAILABLE, "", 2);
  std::string got = refundViaPsp("rf-1");
  size_t calls = ctx.GRPC.CallsTo("Refund").size();
  ctx.Assert(got == "CONFIRMED" && calls == 3, "with two UNAVAILABLE answers then a success refundViaPsp answered %q after %d calls, expected CONFIRMED after 3", got, calls);
  ctx.GRPC.Fail("Refund", grpc::StatusCode::INVALID_ARGUMENT, "amount_minor exceeds the charge", 1);
  got = refundViaPsp("rf-2");
  calls = ctx.GRPC.CallsTo("Refund").size() - 3;
  ctx.Assert(got == "REJECTED" && calls == 1, "an INVALID_ARGUMENT answered %q after %d calls, expected REJECTED after 1: a refusal is not retried", got, calls);
  const std::vector<std::tuple<std::string, grpc::StatusCode, std::string>> others = {
      {"rf-3", grpc::StatusCode::INTERNAL, "INTERNAL"}, {"rf-4", grpc::StatusCode::RESOURCE_EXHAUSTED, "RESOURCE_EXHAUSTED"}};
  for (size_t n = 0; n < others.size(); n++) {
    const auto& [refund_id, code, name] = others[n];
    ctx.GRPC.Fail("Refund", code, "the PSP broke", 1);
    got = refundViaPsp(refund_id);
    calls = ctx.GRPC.CallsTo("Refund").size() - 4 - n;
    const std::string row_status = records::findRefund(refund_id)->status;
    ctx.Assert(calls == 1 && got == "PENDING" && row_status == "PENDING",
               "%s answered %q after %d Refund calls and left the row %s, expected PENDING after 1: only DEADLINE_EXCEEDED and UNAVAILABLE are retried, and another code is no refusal",
               name, got, calls, row_status);
  }
  ctx.Equal(ledger::refundedTotal("pay_1"), 5000, "only the refusal of rf-2 gives its reservation back; the ledger");
}

void CheckPendingReconcile(harness::Ctx& ctx) {
  HPspPeer& peer = hClientServe(ctx, "pay_1", {{"rf-1", 3000}, {"rf-2", 2000}});
  peer.drop = 3;
  std::string got = refundViaPsp("rf-1");
  auto row = *records::findRefund("rf-1");
  ctx.Assert(got == "CONFIRMED" && row.status == "CONFIRMED" && row.psp_ref == "re_1",
             "the PSP paid rf-1 but every answer was lost: refundViaPsp answered %q and the record holds %s %q, expected CONFIRMED with re_1 from GetRefund",
             got, row.status, row.psp_ref);
  ctx.GRPC.Fail("Refund", grpc::StatusCode::UNAVAILABLE, "", 3);
  got = refundViaPsp("rf-2");
  row = *records::findRefund("rf-2");
  ctx.Assert(got == "PENDING" && row.status == "PENDING",
             "with the PSP down for every attempt and GetRefund answering NOT_FOUND, refundViaPsp answered %q and the record holds %s, expected PENDING", got, row.status);
  ctx.Equal(ledger::refundedTotal("pay_1"), 5000, "an unknown outcome keeps its reservation; the ledger");
  records::insertRefund("rf-3", "t1", "pay_1", 1000, "damaged", "");
  ledger::claim("pay_1", "rf-3", 1000, 10000);
  peer.statuses["rf-3"] = "PROCESSING";
  ctx.GRPC.Fail("Refund", grpc::StatusCode::UNAVAILABLE, "", 3);
  got = refundViaPsp("rf-3");
  row = *records::findRefund("rf-3");
  ctx.Assert(!ctx.GRPC.CallsTo("GetRefund").empty() && got == "PENDING" && row.status == "PENDING",
             "with the PSP down and GetRefund answering PROCESSING, refundViaPsp answered %q and the record holds %s, expected PENDING: only SUCCEEDED and FAILED settle a refund",
             got, row.status);
  ctx.Equal(ledger::refundedTotal("pay_1"), 6000, "a refund still PROCESSING keeps its reservation; the ledger");
}

void CheckTerminalRelease(harness::Ctx& ctx) {
  HPspPeer& peer = hClientServe(ctx, "pay_disputed", {{"rf-1", 3000}, {"rf-2", 4000}});
  records::markConfirmed("rf-1", "re_0");
  const std::string got = refundViaPsp("rf-2");
  ctx.Assert(got == "REJECTED" && records::findRefund("rf-2")->status == "REJECTED",
             "the PSP refused rf-2 with FAILED_PRECONDITION; refundViaPsp answered %q, expected REJECTED", got);
  const long long total = ledger::refundedTotal("pay_disputed");
  const auto held = ctx.Redis.HGetAll("refunded:pay_disputed");
  ctx.Assert(total == 3000 && !held.count("rf-2") && held.count("rf-1"),
             "after the refusal the ledger holds %d, expected 3000 over rf-1: release exactly the refused refund's reservation", total);
  ctx.Equal(ctx.GRPC.CallsTo("Refund").size(), 1, "a refusal is not retried; the Refund calls");
  // The PSP's answers are lost, and GetRefund reports the refund FAILED: a refusal too.
  records::insertRefund("rf-3", "t1", "pay_disputed", 1000, "damaged", "");
  ledger::claim("pay_disputed", "rf-3", 1000, 10000);
  peer.statuses["rf-3"] = "FAILED";
  ctx.GRPC.Fail("Refund", grpc::StatusCode::UNAVAILABLE, "", 3);
  const std::string failed = refundViaPsp("rf-3");
  const std::string failed_status = records::findRefund("rf-3")->status;
  ctx.Assert(failed == "REJECTED" && failed_status == "REJECTED", "GetRefund reported rf-3 FAILED; refundViaPsp answered %q and the record holds %s, expected REJECTED", failed, failed_status);
  const long long left = ledger::refundedTotal("pay_disputed");
  const auto after = ctx.Redis.HGetAll("refunded:pay_disputed");
  ctx.Assert(left == 3000 && !after.count("rf-3") && after.count("rf-1"),
             "after GetRefund reported rf-3 FAILED the ledger holds %d, expected 3000 over rf-1: a FAILED refund gives its reservation back", left);
}
`,
  },
  hints: [
    'Make the PSP lose its first answer after paying: the refund is written off as rejected while the customer has the money, and a re-run pays again. A PSP that hangs keeps the call open as long as it likes.',
    'A fresh random key per call tells the PSP every attempt is a new refund. One attempt and one catch-all cannot tell a refusal from a lost answer, and a refusal never gives its reservation back.',
    'Send `idempotency-key = refund_id` with `timeout=PSP_DEADLINE_S` on up to `MAX_ATTEMPTS`; retry `DEADLINE_EXCEEDED`/`UNAVAILABLE`; on a refusal `mark_rejected` and `ledger.release`; otherwise `return reconcile(refund_id)` via `GetRefund`.',
  ],
  debrief: `The idempotency key is what turns "retry" from a risk into a tool: once every attempt names the same refund, the PSP can answer a repeat with the first result, so the client may retry the codes that leave the outcome unknown without paying twice. The other half is honesty about what a timeout means. It does not mean "failed", so the row stays PENDING and keeps its reservation until GetRefund says otherwise; only an explicit refusal gives the reservation back, and only this refund's. A production client spaces its retries with jittered backoff inside an overall budget, runs reconciliation as a scheduled sweep over old PENDING rows, and pages someone when a refund stays unknown past the PSP's settlement window.`,
};
