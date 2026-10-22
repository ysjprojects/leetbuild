import type {Step} from '@/lib/types';

export const refundDependencyStep: Step = {
  id: 'dependency',
  title: 'PSP calls with a stable idempotency key',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'psp', 'records'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the PSP client: the happy
path refunds correctly, so the demo passes. Every failure path is wrong, and one of them pays twice.
Find them, fix them, and prove the fix.

Implement \`refund_via_psp(refund_id, payment_id, amount_minor)\` — the only way this service moves
money at the provider:

- Each attempt carries a **5-second deadline** (\`PSP_DEADLINE_S = 5\`). Without one, a wedged PSP
  holds the refund open and the customer waits forever.
- Every attempt sends the **refund id as the \`idempotency-key\` metadata** — the same key on the
  first try and on every retry. A key generated per attempt makes the PSP see independent refunds,
  which is exactly how one return gets paid twice.
- **\`DEADLINE_EXCEEDED\` and \`UNAVAILABLE\` are retryable**, at most **3 attempts**, with the same
  key and the same deadline each time. Any other status is terminal.
- A timeout is **not** a failure: the PSP may have applied the refund. When the attempts are
  exhausted with no answer, record the refund as **\`PENDING\`** and **reconcile** it with
  \`GetRefund(refund_id)\` before anything is shown to the customer. Reconciliation may turn it into
  \`CONFIRMED\` with the PSP reference, into \`REJECTED\`, or leave it \`PENDING\` for the next pass.
- A **terminal rejection** (\`INVALID_ARGUMENT\`, \`FAILED_PRECONDITION\`) records \`REJECTED\` and
  **releases exactly what was reserved** — the reservation this refund took, never the payment's
  whole refundable balance.

**Failure mode the checks target.** The draft calls the PSP once with
\`idempotency-key = uuid4()\`, so the first retry by any layer in the call chain is a second refund at
the provider; it treats the resulting timeout as a failure in its own records while the PSP may have
succeeded; and it releases the payment's balance on a terminal rejection, handing the customer a
credit it never took.`,
  sequence: {
    participants: ['Refund API', 'PSP', 'refund records'],
    messages: [
      {
        from: 'Refund API',
        to: 'PSP',
        label: 'Refund(payment_id, amount_minor) · idempotency-key = refund_id · 5 s',
        kind: 'sync',
      },
      {from: 'PSP', to: 'Refund API', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {from: 'Refund API', to: 'PSP', label: 'retry attempt 2/3 · same idempotency-key', kind: 'sync'},
      {from: 'PSP', to: 'Refund API', label: 'still no answer', kind: 'reply'},
      {from: 'Refund API', to: 'refund records', label: 'mark_pending(refund_id, psp_ref = null)', kind: 'async'},
      {
        from: 'Refund API',
        to: 'PSP',
        label: 'GetRefund(refund_id) · reconcile before the customer sees anything',
        kind: 'sync',
      },
      {from: 'PSP', to: 'Refund API', label: 'SUCCEEDED · psp_ref', kind: 'reply'},
      {from: 'Refund API', to: 'refund records', label: 'mark_confirmed(refund_id, psp_ref)', kind: 'async'},
      {
        from: 'Refund API',
        to: 'refund records',
        label: 'terminal rejection → mark_rejected + release the reservation',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 5-second deadline',
      detail:
        'The call is made with a 5-second deadline — a call timeout, a context with timeout, `withDeadlineAfter`, `set_deadline` or `deadline: Date.now() + PSP_DEADLINE_MS`. The draft calls the PSP with no deadline at all.',
      match: {
        python: {all: [/PSP_DEADLINE_S\s*=\s*5/, /timeout=PSP_DEADLINE_S/, /\.Refund\(/]},
        typescript: {
          all: [/PSP_DEADLINE_MS\s*=\s*5000/, /deadline:\s*Date\.now\(\)\s*\+\s*PSP_DEADLINE_MS/, /\.Refund\(/],
        },
        go: {all: [/pspDeadlineS\s*=\s*5/, /context\.WithTimeout|WithDeadline/, /\.Refund\(/]},
        scala: {all: [/PspDeadlineS\s*=\s*5/, /withDeadlineAfter/, /\.refund\(/]},
        cpp: {all: [/kPspDeadlineS\s*=\s*5/, /set_deadline\(/, /->Refund\(/]},
      },
    },
    {
      id: 'stable-key',
      title: 'Sends the refund id as the idempotency key',
      detail:
        'The `idempotency-key` metadata is the refund id on every attempt, and no key is generated per call. The draft sends `uuid4()`/`randomUUID()`/`NewString()`, so a retry is an independent refund to the PSP.',
      match: {
        python: {all: [/idempotency-key/, /refund_id/], none: [/uuid4\(\)/]},
        typescript: {all: [/idempotency-key/, /refundId/], none: [/randomUUID\(/]},
        go: {all: [/idempotency-key/, /refundID/], none: [/uuid\.NewString\(/]},
        scala: {all: [/idempotency-key/, /refundId/], none: [/UUID\.randomUUID\(/]},
        cpp: {all: [/idempotency-key/, /refund_id/], none: [/uuidString\(/]},
      },
    },
    {
      id: 'retry-policy',
      title: 'Retries the two unknown-outcome codes, three attempts',
      detail:
        'At most `MAX_ATTEMPTS = 3` attempts, retrying only `DEADLINE_EXCEEDED` and `UNAVAILABLE`; everything else is terminal. The draft makes one attempt and gives up.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*3/, /range\(MAX_ATTEMPTS\)/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*3/, /attempt\s*<\s*MAX_ATTEMPTS/]},
        go: {all: [/maxAttempts\s*=\s*3/, /attempt\s*<\s*maxAttempts/]},
        scala: {all: [/MaxAttempts\s*=\s*3/, /attempt\s*<\s*MaxAttempts/]},
        cpp: {all: [/kMaxAttempts\s*=\s*3/, /attempt\s*<\s*kMaxAttempts/]},
      },
    },
    {
      id: 'pending-reconcile',
      title: 'Records an unknown outcome as pending and reconciles it',
      detail:
        'When the attempts are exhausted the refund is recorded **PENDING** and reconciled with the PSP (`GetRefund`) before the customer is told anything. The draft writes it off as a failure while the PSP may have succeeded.',
      match: {
        python: {all: [/PENDING/, /mark_pending\(/, /GetRefund/]},
        typescript: {all: [/PENDING/, /markPending\(/, /GetRefund/]},
        go: {all: [/Pending|PENDING/, /MarkPending\(/, /GetRefund\(/]},
        scala: {all: [/Pending/, /markPending\(/, /getRefund\(/]},
        cpp: {all: [/PENDING/, /markPending\(/, /GetRefund\(/]},
      },
    },
    {
      id: 'terminal-release',
      title: 'A terminal rejection releases only the reservation',
      detail:
        'A terminal rejection marks the refund `REJECTED` and releases the reservation this refund took — never the payment’s balance. The draft releases the payment, giving away credit it never held.',
      match: {
        python: {all: [/REJECTED/, /release_reservation\(/]},
        typescript: {all: [/REJECTED/, /releaseReservation\(/]},
        go: {all: [/return "REJECTED"/, /ledger\.ReleaseReservation\(ctx, refundID\)/]},
        scala: {all: [/return "REJECTED"/, /ledger\.releaseReservation\(refundId\)/]},
        cpp: {all: [/REJECTED/, /releaseReservation\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc
import uuid

import psp_pb2
import psp_pb2_grpc

channel = grpc.insecure_channel("psp:9000")
psp = psp_pb2_grpc.PspStub(channel)


class RefundStore:
    def mark_confirmed(self, refund_id: str, psp_ref: str) -> None:
        """The PSP applied the refund."""
        raise NotImplementedError

    def mark_pending(self, refund_id: str, psp_ref: str | None) -> None:
        """The PSP's answer is unknown; reconcile before telling the customer anything."""
        raise NotImplementedError

    def mark_rejected(self, refund_id: str, reason: str) -> None:
        raise NotImplementedError


class Ledger:
    def release_reservation(self, refund_id: str) -> None:
        """Release the amount this refund reserved."""
        raise NotImplementedError

    def release_payment(self, payment_id: str) -> None:
        """Drop the payment's whole refunded total."""
        raise NotImplementedError


records = RefundStore()
ledger = Ledger()


def refund_via_psp(refund_id: str, payment_id: str, amount_minor: int) -> str:
    # TODO: this draft mints a fresh idempotency key for every call, so a retry after a timeout
    # refunds the customer twice; it has no deadline, treats a timeout as a permanent failure, and
    # releases the whole payment when the PSP rejects the refund. Review all four.
    metadata = (("idempotency-key", str(uuid.uuid4())),)
    request = psp_pb2.RefundRequest(payment_id=payment_id, amount_minor=amount_minor, ref=refund_id)
    try:
        reply = psp.Refund(request, metadata=metadata)
    except grpc.RpcError as exc:
        records.mark_rejected(refund_id, exc.details())
        ledger.release_payment(payment_id)
        return "FAILED"
    records.mark_confirmed(refund_id, reply.psp_ref)
    return "CONFIRMED"
`,
      solution: `import grpc

import psp_pb2
import psp_pb2_grpc

PSP_DEADLINE_S = 5
MAX_ATTEMPTS = 3
RECONCILE_DEADLINE_S = 5
RETRYABLE = {grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE}
TERMINAL = {grpc.StatusCode.INVALID_ARGUMENT, grpc.StatusCode.FAILED_PRECONDITION}

channel = grpc.insecure_channel("psp:9000")
psp = psp_pb2_grpc.PspStub(channel)


class RefundStore:
    def mark_confirmed(self, refund_id: str, psp_ref: str) -> None:
        """The PSP applied the refund."""
        raise NotImplementedError

    def mark_pending(self, refund_id: str, psp_ref: str | None) -> None:
        """The PSP's answer is unknown; reconcile before telling the customer anything."""
        raise NotImplementedError

    def mark_rejected(self, refund_id: str, reason: str) -> None:
        raise NotImplementedError


class Ledger:
    def release_reservation(self, refund_id: str) -> None:
        """Release the amount this refund reserved."""
        raise NotImplementedError


records = RefundStore()
ledger = Ledger()


def reconcile(refund_id: str) -> str:
    """Ask the PSP what really happened before anything is shown to the customer."""
    try:
        status = psp.GetRefund(psp_pb2.GetRefundRequest(refund_id=refund_id), timeout=RECONCILE_DEADLINE_S)
    except grpc.RpcError:
        return "PENDING"
    if status.state == "SUCCEEDED":
        records.mark_confirmed(refund_id, status.psp_ref)
        return "CONFIRMED"
    if status.state == "REJECTED":
        records.mark_rejected(refund_id, "psp rejected the refund during reconciliation")
        ledger.release_reservation(refund_id)
        return "REJECTED"
    return "PENDING"


def refund_via_psp(refund_id: str, payment_id: str, amount_minor: int) -> str:
    # The key is the refund id, so every retry of one intent is still one intent at the PSP.
    metadata = (("idempotency-key", refund_id),)
    request = psp_pb2.RefundRequest(payment_id=payment_id, amount_minor=amount_minor, ref=refund_id)
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = psp.Refund(request, metadata=metadata, timeout=PSP_DEADLINE_S)
            records.mark_confirmed(refund_id, reply.psp_ref)
            return "CONFIRMED"
        except grpc.RpcError as exc:
            if exc.code() in TERMINAL or exc.code() not in RETRYABLE:
                records.mark_rejected(refund_id, exc.details())
                # A terminal no took nothing: release exactly what this refund reserved.
                ledger.release_reservation(refund_id)
                return "REJECTED"
    # Unknown outcome: the PSP may have applied the refund. Record it pending and reconcile first.
    records.mark_pending(refund_id, None)
    return reconcile(refund_id)
`,
    },
    typescript: {
      starter: `/** PSP refund call: a model-generated draft that mints a key per attempt. */
import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface PspClient {
  Refund(request: {payment_id: string; amount_minor: number; ref: string}, metadata: grpc.Metadata): grpc.ClientUnaryCall;
}

const {psp} = grpc.loadPackageDefinition(protoLoader.loadSync('psp.proto')) as unknown as {
  psp: {Psp: new (target: string, credentials: grpc.ChannelCredentials) => PspClient};
};
const client = new psp.Psp('psp:9000', grpc.credentials.createInsecure());

export const records = {
  markConfirmed(refundId: string, pspRef: string): void {
    throw new Error('not implemented');
  },
  markPending(refundId: string, pspRef: string | null): void {
    throw new Error('not implemented');
  },
  markRejected(refundId: string, reason: string): void {
    throw new Error('not implemented');
  },
};

export const ledger = {
  releaseReservation(refundId: string): void {
    throw new Error('not implemented');
  },
  releasePayment(paymentId: string): void {
    throw new Error('not implemented');
  },
};

export async function refundViaPsp(refundId: string, paymentId: string, amountMinor: number): Promise<string> {
  // TODO: this draft mints a fresh idempotency key for every call, so a retry after a timeout
  // refunds the customer twice; it has no deadline, treats a timeout as a permanent failure, and
  // releases the whole payment when the PSP rejects the refund. Review all four.
  const metadata = new grpc.Metadata();
  metadata.set('idempotency-key', randomUUID());
  try {
    await new Promise<void>((resolve, reject) => {
      client.Refund({payment_id: paymentId, amount_minor: amountMinor, ref: refundId}, metadata, (error: grpc.ServiceError | null) =>
        error === null ? resolve() : reject(error),
      );
    });
  } catch (error) {
    records.markRejected(refundId, String(error));
    ledger.releasePayment(paymentId);
    return 'FAILED';
  }
  records.markConfirmed(refundId, 'psp_ref');
  return 'CONFIRMED';
}
`,
      solution: `/** PSP refund call: one stable idempotency key, a 5-second deadline, reconciliation on unknowns. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const PSP_DEADLINE_MS = 5000;
const MAX_ATTEMPTS = 3;
const RETRYABLE: Record<number, true> = {
  [grpc.status.DEADLINE_EXCEEDED]: true,
  [grpc.status.UNAVAILABLE]: true,
};
const TERMINAL: Record<number, true> = {
  [grpc.status.INVALID_ARGUMENT]: true,
  [grpc.status.FAILED_PRECONDITION]: true,
};

interface PspClient {
  Refund(
    request: {payment_id: string; amount_minor: number; ref: string},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply?: {psp_ref: string}) => void,
  ): grpc.ClientUnaryCall;
  GetRefund(
    request: {refund_id: string},
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, reply?: {state: string; psp_ref: string}) => void,
  ): grpc.ClientUnaryCall;
}

const {psp} = grpc.loadPackageDefinition(protoLoader.loadSync('psp.proto')) as unknown as {
  psp: {Psp: new (target: string, credentials: grpc.ChannelCredentials) => PspClient};
};
const pspClient = new psp.Psp('psp:9000', grpc.credentials.createInsecure());

export const records = {
  markConfirmed(refundId: string, pspRef: string): void {
    throw new Error('not implemented');
  },
  markPending(refundId: string, pspRef: string | null): void {
    throw new Error('not implemented');
  },
  markRejected(refundId: string, reason: string): void {
    throw new Error('not implemented');
  },
};

export const ledger = {
  releaseReservation(refundId: string): void {
    throw new Error('not implemented');
  },
};

async function reconcile(refundId: string): Promise<string> {
  try {
    const status = await new Promise<{state: string; psp_ref: string}>((resolve, reject) => {
      pspClient.GetRefund({refund_id: refundId}, {deadline: Date.now() + PSP_DEADLINE_MS}, (error, reply) =>
        error === null && reply !== undefined ? resolve(reply) : reject(error),
      );
    });
    if (status.state === 'SUCCEEDED') {
      records.markConfirmed(refundId, status.psp_ref);
      return 'CONFIRMED';
    }
    if (status.state === 'REJECTED') {
      records.markRejected(refundId, 'psp rejected the refund during reconciliation');
      ledger.releaseReservation(refundId);
      return 'REJECTED';
    }
  } catch {
    return 'PENDING';
  }
  return 'PENDING';
}

export async function refundViaPsp(refundId: string, paymentId: string, amountMinor: number): Promise<string> {
  const metadata = new grpc.Metadata();
  metadata.set('idempotency-key', refundId);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await new Promise<{psp_ref: string}>((resolve, reject) => {
        pspClient.Refund(
          {payment_id: paymentId, amount_minor: amountMinor, ref: refundId},
          metadata,
          {deadline: Date.now() + PSP_DEADLINE_MS},
          (error, result) => (error === null && result !== undefined ? resolve(result) : reject(error)),
        );
      });
      records.markConfirmed(refundId, reply.psp_ref);
      return 'CONFIRMED';
    } catch (error) {
      const status = error as grpc.ServiceError;
      if (TERMINAL[status.code] === true || RETRYABLE[status.code] !== true) {
        records.markRejected(refundId, status.details ?? String(error));
        // A terminal no took nothing: release exactly what this refund reserved.
        ledger.releaseReservation(refundId);
        return 'REJECTED';
      }
    }
  }
  // Unknown outcome: the PSP may have applied the refund. Record it pending and reconcile first.
  records.markPending(refundId, null);
  return reconcile(refundId);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"

	pb "refunds/psppb"
	"github.com/google/uuid"
)

var psp pb.PspClient

type RefundStore struct{}

func (s *RefundStore) MarkConfirmed(ctx context.Context, refundID, pspRef string) error { return nil }
func (s *RefundStore) MarkPending(ctx context.Context, refundID string, pspRef *string) error {
	return nil
}
func (s *RefundStore) MarkRejected(ctx context.Context, refundID, reason string) error { return nil }

type Ledger struct{}

func (l *Ledger) ReleaseReservation(ctx context.Context, refundID string) error { return nil }
func (l *Ledger) ReleasePayment(ctx context.Context, paymentID string) error     { return nil }

var (
	records = &RefundStore{}
	ledger  = &Ledger{}
)

// TODO: this draft mints a fresh idempotency key for every call, so a retry after a timeout refunds
// the customer twice; it has no deadline, treats a timeout as a permanent failure, and releases the
// whole payment when the PSP rejects the refund. Review all four.
func refundViaPSP(ctx context.Context, refundID, paymentID string, amountMinor int64) string {
	callCtx := metadata.NewOutgoingContext(ctx, metadata.Pairs("idempotency-key", uuid.NewString()))
	reply, err := psp.Refund(callCtx, &pb.RefundRequest{PaymentId: paymentID, AmountMinor: amountMinor, Ref: refundID})
	if err != nil {
		_ = records.MarkRejected(ctx, refundID, err.Error())
		_ = ledger.ReleasePayment(ctx, paymentID)
		return "FAILED"
	}
	_ = records.MarkConfirmed(ctx, refundID, reply.PspRef)
	return "CONFIRMED"
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	pb "refunds/psppb"
)

const (
	pspDeadlineS = 5
	maxAttempts  = 3
)

var retryable = map[codes.Code]bool{codes.DeadlineExceeded: true, codes.Unavailable: true}
var terminal = map[codes.Code]bool{codes.InvalidArgument: true, codes.FailedPrecondition: true}

var psp pb.PspClient

type RefundStore struct{}

func (s *RefundStore) MarkConfirmed(ctx context.Context, refundID, pspRef string) error { return nil }
func (s *RefundStore) MarkPending(ctx context.Context, refundID string, pspRef *string) error {
	return nil
}
func (s *RefundStore) MarkRejected(ctx context.Context, refundID, reason string) error { return nil }

type Ledger struct{}

func (l *Ledger) ReleaseReservation(ctx context.Context, refundID string) error { return nil }

var (
	records = &RefundStore{}
	ledger  = &Ledger{}
)

func reconcile(ctx context.Context, refundID string) string {
	callCtx, cancel := context.WithTimeout(ctx, pspDeadlineS*time.Second)
	defer cancel()
	answer, err := psp.GetRefund(callCtx, &pb.GetRefundRequest{RefundId: refundID})
	if err != nil {
		return "PENDING"
	}
	switch answer.State {
	case "SUCCEEDED":
		_ = records.MarkConfirmed(ctx, refundID, answer.PspRef)
		return "CONFIRMED"
	case "REJECTED":
		_ = records.MarkRejected(ctx, refundID, "psp rejected the refund during reconciliation")
		_ = ledger.ReleaseReservation(ctx, refundID)
		return "REJECTED"
	}
	return "Pending"
}

func refundViaPSP(ctx context.Context, refundID, paymentID string, amountMinor int64) string {
	// The key is the refund id, so every retry of one intent is still one intent at the PSP.
	callCtx := metadata.NewOutgoingContext(ctx, metadata.Pairs("idempotency-key", refundID))
	request := &pb.RefundRequest{PaymentId: paymentID, AmountMinor: amountMinor, Ref: refundID}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		attemptCtx, cancel := context.WithTimeout(callCtx, pspDeadlineS*time.Second)
		reply, err := psp.Refund(attemptCtx, request)
		cancel()
		if err == nil {
			_ = records.MarkConfirmed(ctx, refundID, reply.PspRef)
			return "CONFIRMED"
		}
		code := status.Code(err)
		if terminal[code] || !retryable[code] {
			_ = records.MarkRejected(ctx, refundID, err.Error())
			// A terminal no took nothing: release exactly what this refund reserved.
			_ = ledger.ReleaseReservation(ctx, refundID)
			return "REJECTED"
		}
	}
	// Unknown outcome: the PSP may have applied the refund. Record it pending and reconcile first.
	_ = records.MarkPending(ctx, refundID, nil)
	return reconcile(ctx, refundID)
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import io.grpc.{Metadata, MetadataUtils}

object Client {
  val psp = PspGrpc.blockingStub(io.grpc.ManagedChannelBuilder.forAddress("psp", 9000).usePlaintext().build())

  object records {
    def markConfirmed(refundId: String, pspRef: String): Unit = ()
    def markPending(refundId: String, pspRef: Option[String]): Unit = ()
    def markRejected(refundId: String, reason: String): Unit = ()
  }

  object ledger {
    def releaseReservation(refundId: String): Unit = ()
    def releasePayment(paymentId: String): Unit = ()
  }

  // TODO: this draft mints a fresh idempotency key for every call, so a retry after a timeout
  // refunds the customer twice; it has no deadline, treats a timeout as a permanent failure, and
  // releases the whole payment when the PSP rejects the refund. Review all four.
  def refundViaPsp(refundId: String, paymentId: String, amountMinor: Long): String = {
    val headers = new Metadata()
    headers.put(Metadata.Key.of("idempotency-key", Metadata.ASCII_STRING_MARSHALLER), UUID.randomUUID().toString)
    try {
      val reply = MetadataUtils.attachHeaders(psp, headers).refund(
        RefundRequest(paymentId = paymentId, amountMinor = amountMinor, ref = refundId)
      )
      records.markConfirmed(refundId, reply.pspRef)
      "CONFIRMED"
    } catch {
      case exc: Throwable =>
        records.markRejected(refundId, exc.getMessage)
        ledger.releasePayment(paymentId)
        "FAILED"
    }
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{Metadata, MetadataUtils, Status, StatusRuntimeException}

object Client {
  val PspDeadlineS = 5
  val MaxAttempts = 3
  val Retryable = Set(Status.Code.DEADLINE_EXCEEDED, Status.Code.UNAVAILABLE)
  val Terminal = Set(Status.Code.INVALID_ARGUMENT, Status.Code.FAILED_PRECONDITION)

  val psp = PspGrpc.blockingStub(io.grpc.ManagedChannelBuilder.forAddress("psp", 9000).usePlaintext().build())

  object records {
    def markConfirmed(refundId: String, pspRef: String): Unit = ()
    def markPending(refundId: String, pspRef: Option[String]): Unit = ()
    def markRejected(refundId: String, reason: String): Unit = ()
  }

  object ledger {
    def releaseReservation(refundId: String): Unit = ()
  }

  def reconcile(refundId: String): String =
    try {
      val answer = psp
        .withDeadlineAfter(PspDeadlineS, TimeUnit.SECONDS)
        .getRefund(GetRefundRequest(refundId = refundId))
      answer.state match {
        case "SUCCEEDED" =>
          records.markConfirmed(refundId, answer.pspRef)
          "CONFIRMED"
        case "REJECTED" =>
          records.markRejected(refundId, "psp rejected the refund during reconciliation")
          ledger.releaseReservation(refundId)
          "REJECTED"
        case _ => "PENDING"
      }
    } catch {
      case _: StatusRuntimeException => "PENDING"
    }

  def refundViaPsp(refundId: String, paymentId: String, amountMinor: Long): String = {
    // The key is the refund id, so every retry of one intent is still one intent at the PSP.
    val headers = new Metadata()
    headers.put(Metadata.Key.of("idempotency-key", Metadata.ASCII_STRING_MARSHALLER), refundId)
    val stub = MetadataUtils.attachHeaders(psp, headers)
    val request = RefundRequest(paymentId = paymentId, amountMinor = amountMinor, ref = refundId)
    var attempt = 0
    while (attempt < MaxAttempts) {
      try {
        val reply = stub.withDeadlineAfter(PspDeadlineS, TimeUnit.SECONDS).refund(request)
        records.markConfirmed(refundId, reply.pspRef)
        return "CONFIRMED"
      } catch {
        case exc: StatusRuntimeException =>
          val code = exc.getStatus.getCode
          if (Terminal.contains(code) || !Retryable.contains(code)) {
            records.markRejected(refundId, exc.getStatus.getDescription)
            // A terminal no took nothing: release exactly what this refund reserved.
            ledger.releaseReservation(refundId)
            return "REJECTED"
          }
      }
      attempt += 1
    }
    // Unknown outcome: the PSP may have applied the refund. Record it pending and reconcile first.
    records.markPending(refundId, None)
    reconcile(refundId)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "psp.grpc.pb.h"

#include <string>

std::unique_ptr<Psp::Stub> psp;

struct RefundStore {
  void markConfirmed(const std::string& refundId, const std::string& pspRef);
  void markPending(const std::string& refundId, const std::string& pspRef);
  void markRejected(const std::string& refundId, const std::string& reason);
};

struct Ledger {
  void releaseReservation(const std::string& refundId);
  void releasePayment(const std::string& paymentId);
};

RefundStore records;
Ledger ledger;
std::string uuidString();

// TODO: this draft mints a fresh idempotency key for every call, so a retry after a timeout refunds
// the customer twice; it has no deadline, treats a timeout as a permanent failure, and releases the
// whole payment when the PSP rejects the refund. Review all four.
std::string refund_via_psp(const std::string& refund_id, const std::string& payment_id, long long amount_minor) {
  grpc::ClientContext ctx;
  ctx.AddMetadata("idempotency-key", uuidString());
  RefundRequest request;
  request.set_payment_id(payment_id);
  request.set_amount_minor(amount_minor);
  request.set_ref(refund_id);
  RefundReply reply;
  const grpc::Status status = psp->Refund(&ctx, request, &reply);
  if (!status.ok()) {
    records.markRejected(refund_id, status.error_message());
    ledger.releasePayment(payment_id);
    return "FAILED";
  }
  records.markConfirmed(refund_id, reply.psp_ref());
  return "CONFIRMED";
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "psp.grpc.pb.h"

#include <chrono>
#include <string>

constexpr int kPspDeadlineS = 5;
constexpr int kMaxAttempts = 3;

std::unique_ptr<Psp::Stub> psp;

struct RefundStore {
  void markConfirmed(const std::string& refundId, const std::string& pspRef);
  void markPending(const std::string& refundId, const std::string& pspRef);
  void markRejected(const std::string& refundId, const std::string& reason);
};

struct Ledger {
  void releaseReservation(const std::string& refundId);
};

RefundStore records;
Ledger ledger;

std::string reconcile(const std::string& refund_id) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kPspDeadlineS));
  GetRefundRequest request;
  request.set_refund_id(refund_id);
  GetRefundReply answer;
  if (!psp->GetRefund(&ctx, request, &answer).ok()) return "PENDING";
  if (answer.state() == "SUCCEEDED") {
    records.markConfirmed(refund_id, answer.psp_ref());
    return "CONFIRMED";
  }
  if (answer.state() == "REJECTED") {
    records.markRejected(refund_id, "psp rejected the refund during reconciliation");
    ledger.releaseReservation(refund_id);
    return "REJECTED";
  }
  return "PENDING";
}

std::string refund_via_psp(const std::string& refund_id, const std::string& payment_id, long long amount_minor) {
  RefundRequest request;
  request.set_payment_id(payment_id);
  request.set_amount_minor(amount_minor);
  request.set_ref(refund_id);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    // The key is the refund id, so every retry of one intent is still one intent at the PSP.
    ctx.AddMetadata("idempotency-key", refund_id);
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kPspDeadlineS));
    RefundReply reply;
    const grpc::Status status = psp->Refund(&ctx, request, &reply);
    if (status.ok()) {
      records.markConfirmed(refund_id, reply.psp_ref());
      return "CONFIRMED";
    }
    const auto code = status.error_code();
    if (code == grpc::StatusCode::INVALID_ARGUMENT || code == grpc::StatusCode::FAILED_PRECONDITION ||
        (code != grpc::StatusCode::DEADLINE_EXCEEDED && code != grpc::StatusCode::UNAVAILABLE)) {
      records.markRejected(refund_id, status.error_message());
      // A terminal no took nothing: release exactly what this refund reserved.
      ledger.releaseReservation(refund_id);
      return "REJECTED";
    }
  }
  // Unknown outcome: the PSP may have applied the refund. Record it pending and reconcile first.
  records.markPending(refund_id, "");
  return reconcile(refund_id);
}
`,
    },
  },
  hints: [
    'The idempotency key is derived from the refund, not generated at the call site: `metadata=(("idempotency-key", refund_id),)`, `metadata.Pairs(...)`, `headers.put(...)`, `AddMetadata(...)`. Keep it in one constant outside the loop so the retry cannot accidentally compute a new one.',
    'Bound the retries with `MAX_ATTEMPTS = 3` and retry only `DEADLINE_EXCEEDED` / `UNAVAILABLE`. The deadline goes on the call itself (`timeout=`, `deadline: Date.now() + …`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`) — wrapping the call in a helper changes nothing.',
    'A timeout is an **unknown outcome**, not a failure: `mark_pending`, then ask the PSP with `GetRefund` and fold the answer back in. On a terminal rejection, release the reservation this refund took (`release_reservation(refund_id)`) — releasing the payment hands the customer credit the service never held.',
  ],
  debrief: `The interviewer is asking one question under several names: what is the worst case of this call, and what do you know after it? A deadline bounds a single attempt; a bounded retry loop with a fixed retryable set bounds the call. The idempotency key is the correctness answer: money movement is not idempotent by default, so the client has to make it so, and the key must be a property of the refund — never of the attempt — or the retry that saves you from a timeout is the retry that pays twice. The third answer is the one candidates miss: a timeout tells you nothing about whether the PSP applied the refund, so the honest local state is \`PENDING\`, and reconciliation with \`GetRefund\` is what turns an unknown into an answer before the customer reads anything. The fourth is the ledger's books: a terminal rejection must release exactly what this refund reserved, because releasing the payment would invent a balance nobody paid. Real clients add jittered backoff, per-PSP concurrency limits, and a reconciliation worker that sweeps pending refunds until the PSP answers.`,
};
