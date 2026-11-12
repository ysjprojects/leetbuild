import type {Step} from '@/lib/types';

export const processorClientStep: Step = {
  id: 'dependency',
  title: 'Processor calls with invoice-scoped idempotency',
  concept: 'grpc',
  file: 'client',
  focus: ['billing', 'processor'],
  task: `## Task

**Starting point.** The starter is the processor client the billing run charges through:
\`charge_invoice(invoice)\` sends \`Charge\` up to \`MAX_ATTEMPTS\` times, retrying on any error, and
answers \`{state, reference, reason}\`; \`lookup_invoice(invoice_id)\` asks \`GetInvoice\` what the
processor holds and answers \`None\` when it holds nothing. With a healthy processor it charges, and
it hides four flaws.

**Failure mode the checks target.** A processor that stops answering holds the run forever; every
retry carries a new idempotency key, so the processor sees a new charge; a reply lost after the
charge landed is answered with a second charge; and a declined card is tried three times.

\`\`\`proto
service Processor {
  rpc Charge(ChargeRequest) returns (ChargeResult);              // status: succeeded | declined
  rpc GetInvoice(GetInvoiceRequest) returns (ProcessorInvoice);  // NOT_FOUND: nothing charged
}
\`\`\`

- Every call carries a **\`DEADLINE_S\` = 5 s** deadline.
- The idempotency key is the **invoice id**, the same on every attempt.
- \`DEADLINE_EXCEEDED\` leaves the outcome unknown: \`lookup_invoice\` first, and adopt the reference
  when the processor holds a charge; retry only when it holds none. \`UNAVAILABLE\` is retried.
- A \`declined\` result is final after one call: \`{state: "failed", reason: decline_code}\`.`,
  sequence: {
    participants: ['Billing run', 'Payment processor'],
    messages: [
      {
        from: 'Billing run',
        to: 'Payment processor',
        label: 'Charge {invoice_id, amount, idempotency_key = invoice_id} · 5 s',
        kind: 'sync',
      },
      {from: 'Payment processor', to: 'Billing run', label: 'DEADLINE_EXCEEDED: did it land?', kind: 'reply'},
      {from: 'Billing run', to: 'Payment processor', label: 'GetInvoice {invoice_id} · 5 s', kind: 'sync'},
      {
        from: 'Payment processor',
        to: 'Billing run',
        label: 'charged + reference → adopt · NOT_FOUND → retry',
        kind: 'reply',
      },
      {
        from: 'Payment processor',
        to: 'Billing run',
        label: 'declined + decline_code → failed, no retry',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every processor call carries a 5-second deadline',
      detail:
        '`Charge` and `GetInvoice` are sent with `DEADLINE_S` (5 s), so a processor that stops answering costs the run seconds, not the night. The starter sets no deadline.',
      match: {
        python: {
          all: [
            /DEADLINE_S\s*=\s*5\b/,
            /\.Charge\([\s\S]{0,120}?timeout\s*=\s*DEADLINE_S/,
            /\.GetInvoice\([\s\S]{0,160}?timeout\s*=\s*DEADLINE_S/,
          ],
        },
        typescript: {
          all: [
            /DEADLINE_MS\s*=\s*5000\b/,
            /\.Charge\([\s\S]{0,160}?deadline:[^\n]*DEADLINE_MS/,
            /\.GetInvoice\([\s\S]{0,160}?deadline:[^\n]*DEADLINE_MS/,
          ],
        },
        go: {all: [/deadline\s*=\s*5\s*\*\s*time\.Second/, /context\.WithTimeout\([^\n]*deadline\s*\)/]},
        scala: {all: [/DeadlineSeconds\s*=\s*5L?\b/, /withDeadlineAfter\(\s*DeadlineSeconds/]},
        cpp: {all: [/kDeadline\{5\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'invoice-key',
      title: 'Keys every attempt by the invoice id',
      detail:
        'Every `Charge` for an invoice carries the invoice id as its idempotency key, so a retry after `UNAVAILABLE` is the same charge to the processor. The starter mints `{invoice_id}-{attempt}`, a new charge per attempt.',
      match: {
        python: {all: [/idempotency_key\s*=\s*invoice\[["']invoice_id["']\]\s*[,)\n]/]},
        typescript: {all: [/idempotency_key:\s*invoice\.invoice_id\s*[,}\n]/]},
        go: {all: [/IdempotencyKey:\s*invoice\.InvoiceID\s*[,}\n]/]},
        scala: {all: [/idempotencyKey\s*=\s*invoice\.invoiceId\s*[,)\n]/]},
        cpp: {all: [/set_idempotency_key\(\s*invoice\.invoice_id\s*\)/]},
      },
    },
    {
      id: 'reconcile-before-retry',
      title: 'Asks GetInvoice before retrying a deadline',
      detail:
        'After `DEADLINE_EXCEEDED` the client calls `lookup_invoice`/`lookupInvoice` and adopts the reference of a charge that landed; only an invoice the processor does not hold is charged again. The starter retries at once.',
      match: {
        python: {all: [/DEADLINE_EXCEEDED/], order: [/processor\.Charge\(/, /lookup_invoice\(\s*invoice\[/]},
        typescript: {all: [/DEADLINE_EXCEEDED/], order: [/processor\.Charge\(/, /lookupInvoice\(\s*invoice\./]},
        go: {
          all: [/codes\.DeadlineExceeded/],
          order: [/processorClient\.Charge\(/, /lookupInvoice\([^)\n]*invoice\.InvoiceID/],
        },
        scala: {all: [/DEADLINE_EXCEEDED/], order: [/\.charge\(/, /lookupInvoice\(\s*invoice\.invoiceId/]},
        cpp: {all: [/DEADLINE_EXCEEDED/], order: [/->Charge\(/, /lookupInvoice\(\s*invoice\.invoice_id/]},
      },
    },
    {
      id: 'decline-terminal',
      title: 'A decline is final and carries its code',
      detail:
        'A `declined` result ends the call after one attempt with `state: "failed"` and the issuer\'s `decline_code` as the reason. The starter retries it until the attempts run out.',
      match: {
        python: {all: [/["']declined["']/, /decline_code/]},
        typescript: {all: [/['"]declined['"]/, /decline_code/]},
        go: {all: [/"declined"/, /GetDeclineCode\(\)|DeclineCode/]},
        scala: {all: [/"declined"/, /declineCode/]},
        cpp: {all: [/"declined"/, /decline_code\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import subscription_billing_pb2 as pb
import subscription_billing_pb2_grpc

MAX_ATTEMPTS = 3

processor = subscription_billing_pb2_grpc.ProcessorStub(grpc.insecure_channel("processor:9000"))


def lookup_invoice(invoice_id: str) -> dict | None:
    """What the processor holds for the invoice ({invoice_id, state, reference, total_cents}), or None."""
    try:
        found = processor.GetInvoice(pb.GetInvoiceRequest(invoice_id=invoice_id))
    except grpc.RpcError:
        return None
    return {"invoice_id": found.invoice_id, "state": found.state, "reference": found.reference, "total_cents": found.total_cents}


def charge_invoice(invoice: dict) -> dict:
    """Charge the invoice row; answers {state: charged or failed, reference, reason}."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    for attempt in range(MAX_ATTEMPTS):
        request = pb.ChargeRequest(
            invoice_id=invoice["invoice_id"],
            subscription_id=invoice["subscription_id"],
            amount_cents=invoice["amount_cents"],
            idempotency_key=f"{invoice['invoice_id']}-{attempt}",
        )
        try:
            result = processor.Charge(request)
        except grpc.RpcError:
            continue
        if result.status == "succeeded":
            return {"state": "charged", "reference": result.reference, "reason": ""}
    return {"state": "failed", "reference": "", "reason": "processor_unavailable"}
`,
      solution: `import grpc

import subscription_billing_pb2 as pb
import subscription_billing_pb2_grpc

DEADLINE_S = 5
MAX_ATTEMPTS = 3

processor = subscription_billing_pb2_grpc.ProcessorStub(grpc.insecure_channel("processor:9000"))


def lookup_invoice(invoice_id: str) -> dict | None:
    """What the processor holds for the invoice ({invoice_id, state, reference, total_cents}), or None."""
    try:
        found = processor.GetInvoice(pb.GetInvoiceRequest(invoice_id=invoice_id), timeout=DEADLINE_S)
    except grpc.RpcError:
        return None
    return {"invoice_id": found.invoice_id, "state": found.state, "reference": found.reference, "total_cents": found.total_cents}


def charge_invoice(invoice: dict) -> dict:
    """Charge the invoice row; answers {state: charged or failed, reference, reason}."""
    # One key for every attempt: to the processor a retry is the same charge.
    request = pb.ChargeRequest(
        invoice_id=invoice["invoice_id"],
        subscription_id=invoice["subscription_id"],
        amount_cents=invoice["amount_cents"],
        idempotency_key=invoice["invoice_id"],
    )
    for _attempt in range(MAX_ATTEMPTS):
        try:
            result = processor.Charge(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
                # Unknown outcome: the charge may have landed. Ask before charging again.
                found = lookup_invoice(invoice["invoice_id"])
                if found is not None and found["state"] == "charged":
                    return {"state": "charged", "reference": found["reference"], "reason": ""}
                continue
            if exc.code() == grpc.StatusCode.UNAVAILABLE:
                continue
            return {"state": "failed", "reference": "", "reason": exc.code().name.lower()}
        if result.status == "declined":
            return {"state": "failed", "reference": "", "reason": result.decline_code}  # final: the issuer said no
        return {"state": "charged", "reference": result.reference, "reason": ""}
    return {"state": "failed", "reference": "", "reason": "processor_unavailable"}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Invoice, Outcome, ProcessorInvoice} from 'billing/store';

export const MAX_ATTEMPTS = 3;

interface ChargeRequest {
  invoice_id: string;
  subscription_id: string;
  amount_cents: number;
  idempotency_key: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('subscription_billing.proto')) as unknown as {
  subbilling: {Processor: grpc.ServiceClientConstructor};
};
const processor = new pkg.subbilling.Processor('processor:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Charge(request: ChargeRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{status: string; reference: string; decline_code: string}>;
  GetInvoice(request: {invoice_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<ProcessorInvoice>;
};

/** What the processor holds for the invoice, or null. */
export async function lookupInvoice(invoiceId: string): Promise<ProcessorInvoice | null> {
  try {
    const found = await processor.GetInvoice({invoice_id: invoiceId}, new grpc.Metadata(), {});
    return {invoice_id: found.invoice_id, state: found.state, reference: found.reference, total_cents: Number(found.total_cents)};
  } catch {
    return null;
  }
}

/** Charge the invoice row; answers {state: charged or failed, reference, reason}. */
export async function chargeInvoice(invoice: Invoice): Promise<Outcome> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const request = {
      invoice_id: invoice.invoice_id,
      subscription_id: invoice.subscription_id,
      amount_cents: invoice.amount_cents,
      idempotency_key: \`\${invoice.invoice_id}-\${attempt}\`,
    };
    let result;
    try {
      result = await processor.Charge(request, new grpc.Metadata(), {});
    } catch {
      continue;
    }
    if (result.status === 'succeeded') return {state: 'charged', reference: result.reference, reason: ''};
  }
  return {state: 'failed', reference: '', reason: 'processor_unavailable'};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import type {Invoice, Outcome, ProcessorInvoice} from 'billing/store';

export const DEADLINE_MS = 5000;
export const MAX_ATTEMPTS = 3;

interface ChargeRequest {
  invoice_id: string;
  subscription_id: string;
  amount_cents: number;
  idempotency_key: string;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('subscription_billing.proto')) as unknown as {
  subbilling: {Processor: grpc.ServiceClientConstructor};
};
const processor = new pkg.subbilling.Processor('processor:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Charge(request: ChargeRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{status: string; reference: string; decline_code: string}>;
  GetInvoice(request: {invoice_id: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<ProcessorInvoice>;
};

/** What the processor holds for the invoice, or null. */
export async function lookupInvoice(invoiceId: string): Promise<ProcessorInvoice | null> {
  try {
    const found = await processor.GetInvoice({invoice_id: invoiceId}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    return {invoice_id: found.invoice_id, state: found.state, reference: found.reference, total_cents: Number(found.total_cents)};
  } catch {
    return null;
  }
}

/** Charge the invoice row; answers {state: charged or failed, reference, reason}. */
export async function chargeInvoice(invoice: Invoice): Promise<Outcome> {
  // One key for every attempt: to the processor a retry is the same charge.
  const request = {
    invoice_id: invoice.invoice_id,
    subscription_id: invoice.subscription_id,
    amount_cents: invoice.amount_cents,
    idempotency_key: invoice.invoice_id,
  };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let result;
    try {
      result = await processor.Charge(request, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
    } catch (e) {
      const {code} = e as grpc.ServiceError;
      if (code === grpc.status.DEADLINE_EXCEEDED) {
        // Unknown outcome: the charge may have landed. Ask before charging again.
        const found = await lookupInvoice(invoice.invoice_id);
        if (found !== null && found.state === 'charged') return {state: 'charged', reference: found.reference, reason: ''};
        continue;
      }
      if (code === grpc.status.UNAVAILABLE) continue;
      return {state: 'failed', reference: '', reason: String(grpc.status[code]).toLowerCase()};
    }
    // Final: the issuer said no.
    if (result.status === 'declined') return {state: 'failed', reference: '', reason: result.decline_code};
    return {state: 'charged', reference: result.reference, reason: ''};
  }
  return {state: 'failed', reference: '', reason: 'processor_unavailable'};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"fmt"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "billing/gen/subscription_billing"
	"billing/store" // store.Invoice, store.Outcome, store.ProcessorInvoice
)

const maxAttempts = 3

var (
	processorConn, _ = grpc.NewClient("processor:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	processorClient  = pb.NewProcessorClient(processorConn)
)

// lookupInvoice is what the processor holds for the invoice, or nil.
func lookupInvoice(ctx context.Context, invoiceID string) *store.ProcessorInvoice {
	found, err := processorClient.GetInvoice(ctx, &pb.GetInvoiceRequest{InvoiceId: invoiceID})
	if err != nil {
		return nil
	}
	return &store.ProcessorInvoice{InvoiceID: found.GetInvoiceId(), State: found.GetState(), Reference: found.GetReference(), TotalCents: found.GetTotalCents()}
}

// chargeInvoice charges the invoice row and answers what came of it.
func chargeInvoice(ctx context.Context, invoice *store.Invoice) store.Outcome {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	for attempt := 0; attempt < maxAttempts; attempt++ {
		request := &pb.ChargeRequest{
			InvoiceId:      invoice.InvoiceID,
			SubscriptionId: invoice.SubscriptionID,
			AmountCents:    invoice.AmountCents,
			IdempotencyKey: fmt.Sprintf("%s-%d", invoice.InvoiceID, attempt),
		}
		result, err := processorClient.Charge(ctx, request)
		if err != nil {
			continue
		}
		if result.GetStatus() == "succeeded" {
			return store.Outcome{State: "charged", Reference: result.GetReference()}
		}
	}
	return store.Outcome{State: "failed", Reason: "processor_unavailable"}
}
`,
      solution: `package main

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "billing/gen/subscription_billing"
	"billing/store" // store.Invoice, store.Outcome, store.ProcessorInvoice
)

const (
	deadline    = 5 * time.Second
	maxAttempts = 3
)

var (
	processorConn, _ = grpc.NewClient("processor:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	processorClient  = pb.NewProcessorClient(processorConn)
)

// lookupInvoice is what the processor holds for the invoice, or nil.
func lookupInvoice(ctx context.Context, invoiceID string) *store.ProcessorInvoice {
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	found, err := processorClient.GetInvoice(callCtx, &pb.GetInvoiceRequest{InvoiceId: invoiceID})
	if err != nil {
		return nil
	}
	return &store.ProcessorInvoice{InvoiceID: found.GetInvoiceId(), State: found.GetState(), Reference: found.GetReference(), TotalCents: found.GetTotalCents()}
}

// chargeInvoice charges the invoice row and answers what came of it.
func chargeInvoice(ctx context.Context, invoice *store.Invoice) store.Outcome {
	// One key for every attempt: to the processor a retry is the same charge.
	request := &pb.ChargeRequest{
		InvoiceId:      invoice.InvoiceID,
		SubscriptionId: invoice.SubscriptionID,
		AmountCents:    invoice.AmountCents,
		IdempotencyKey: invoice.InvoiceID,
	}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		result, err := processorClient.Charge(callCtx, request)
		cancel()
		if err != nil {
			switch status.Code(err) {
			case codes.DeadlineExceeded:
				// Unknown outcome: the charge may have landed. Ask before charging again.
				if found := lookupInvoice(ctx, invoice.InvoiceID); found != nil && found.State == "charged" {
					return store.Outcome{State: "charged", Reference: found.Reference}
				}
				continue
			case codes.Unavailable:
				continue
			}
			return store.Outcome{State: "failed", Reason: strings.ToLower(status.Code(err).String())}
		}
		if result.GetStatus() == "declined" {
			return store.Outcome{State: "failed", Reason: result.GetDeclineCode()} // final: the issuer said no
		}
		return store.Outcome{State: "charged", Reference: result.GetReference()}
	}
	return store.Outcome{State: "failed", Reason: "processor_unavailable"}
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import billing.Store // Store.Invoice, Store.Outcome, Store.ProcessorInvoice
import subbilling.subscription_billing.{ChargeRequest, GetInvoiceRequest, ProcessorGrpc}

object Client {
  val MaxAttempts = 3

  private val stub = ProcessorGrpc.blockingStub(ManagedChannelBuilder.forAddress("processor", 9000).usePlaintext().build())

  /** What the processor holds for the invoice, if anything. */
  def lookupInvoice(invoiceId: String): Option[Store.ProcessorInvoice] =
    try {
      val found = stub.getInvoice(GetInvoiceRequest(invoiceId))
      Some(Store.ProcessorInvoice(found.invoiceId, found.state, found.reference, found.totalCents))
    } catch {
      case _: StatusRuntimeException => None
    }

  /** Charge the invoice row and answer what came of it. */
  def chargeInvoice(invoice: Store.Invoice): Store.Outcome = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    for (attempt <- 0 until MaxAttempts) {
      val request = ChargeRequest(invoiceId = invoice.invoiceId, subscriptionId = invoice.subscriptionId,
        amountCents = invoice.amountCents, idempotencyKey = s"\${invoice.invoiceId}-$attempt")
      try {
        val result = stub.charge(request)
        if (result.status == "succeeded") return Store.Outcome("charged", result.reference, "")
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
    Store.Outcome("failed", "", "processor_unavailable")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import billing.Store // Store.Invoice, Store.Outcome, Store.ProcessorInvoice
import subbilling.subscription_billing.{ChargeRequest, GetInvoiceRequest, ProcessorGrpc}

object Client {
  val DeadlineSeconds = 5L
  val MaxAttempts = 3

  private val stub = ProcessorGrpc.blockingStub(ManagedChannelBuilder.forAddress("processor", 9000).usePlaintext().build())

  /** What the processor holds for the invoice, if anything. */
  def lookupInvoice(invoiceId: String): Option[Store.ProcessorInvoice] =
    try {
      val found = stub.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).getInvoice(GetInvoiceRequest(invoiceId))
      Some(Store.ProcessorInvoice(found.invoiceId, found.state, found.reference, found.totalCents))
    } catch {
      case _: StatusRuntimeException => None
    }

  /** Charge the invoice row and answer what came of it. */
  def chargeInvoice(invoice: Store.Invoice): Store.Outcome = {
    // One key for every attempt: to the processor a retry is the same charge.
    val request = ChargeRequest(invoiceId = invoice.invoiceId, subscriptionId = invoice.subscriptionId,
      amountCents = invoice.amountCents, idempotencyKey = invoice.invoiceId)
    for (_ <- 0 until MaxAttempts) {
      try {
        val result = stub.withDeadlineAfter(DeadlineSeconds, TimeUnit.SECONDS).charge(request)
        // A decline is final: the issuer said no.
        return if (result.status == "declined") Store.Outcome("failed", "", result.declineCode) else Store.Outcome("charged", result.reference, "")
      } catch {
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
          // Unknown outcome: the charge may have landed. Ask before charging again.
          lookupInvoice(invoice.invoiceId).filter(_.state == "charged").foreach(found => return Store.Outcome("charged", found.reference, ""))
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.UNAVAILABLE => ()
        case e: StatusRuntimeException => return Store.Outcome("failed", "", e.getStatus.getCode.toString.toLowerCase)
      }
    }
    Store.Outcome("failed", "", "processor_unavailable")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <optional>
#include <string>

#include "billing/store.h"  // store::Invoice, store::Outcome, store::ProcessorInvoice
#include "subscription_billing.grpc.pb.h"

constexpr int kMaxAttempts = 3;

auto processorStub = subbilling::Processor::NewStub(grpc::CreateChannel("processor:9000", grpc::InsecureChannelCredentials()));

// What the processor holds for the invoice, or none.
std::optional<store::ProcessorInvoice> lookupInvoice(const std::string& invoice_id) {
  grpc::ClientContext ctx;
  subbilling::GetInvoiceRequest request;
  request.set_invoice_id(invoice_id);
  subbilling::ProcessorInvoice found;
  if (!processorStub->GetInvoice(&ctx, request, &found).ok()) return std::nullopt;
  return store::ProcessorInvoice{found.invoice_id(), found.state(), found.reference(), found.total_cents()};
}

// Charge the invoice row and answer what came of it.
store::Outcome chargeInvoice(const store::Invoice& invoice) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    subbilling::ChargeRequest request;
    request.set_invoice_id(invoice.invoice_id);
    request.set_subscription_id(invoice.subscription_id);
    request.set_amount_cents(invoice.amount_cents);
    request.set_idempotency_key(invoice.invoice_id + "-" + std::to_string(attempt));
    grpc::ClientContext ctx;
    subbilling::ChargeResult result;
    if (!processorStub->Charge(&ctx, request, &result).ok()) continue;
    if (result.status() == "succeeded") return store::Outcome{"charged", result.reference(), ""};
  }
  return store::Outcome{"failed", "", "processor_unavailable"};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <optional>
#include <string>

#include "billing/store.h"  // store::Invoice, store::Outcome, store::ProcessorInvoice
#include "subscription_billing.grpc.pb.h"

constexpr std::chrono::seconds kDeadline{5};
constexpr int kMaxAttempts = 3;

auto processorStub = subbilling::Processor::NewStub(grpc::CreateChannel("processor:9000", grpc::InsecureChannelCredentials()));

// What the processor holds for the invoice, or none.
std::optional<store::ProcessorInvoice> lookupInvoice(const std::string& invoice_id) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  subbilling::GetInvoiceRequest request;
  request.set_invoice_id(invoice_id);
  subbilling::ProcessorInvoice found;
  if (!processorStub->GetInvoice(&ctx, request, &found).ok()) return std::nullopt;
  return store::ProcessorInvoice{found.invoice_id(), found.state(), found.reference(), found.total_cents()};
}

// Charge the invoice row and answer what came of it.
store::Outcome chargeInvoice(const store::Invoice& invoice) {
  // One key for every attempt: to the processor a retry is the same charge.
  subbilling::ChargeRequest request;
  request.set_invoice_id(invoice.invoice_id);
  request.set_subscription_id(invoice.subscription_id);
  request.set_amount_cents(invoice.amount_cents);
  request.set_idempotency_key(invoice.invoice_id);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    subbilling::ChargeResult result;
    const grpc::Status status = processorStub->Charge(&ctx, request, &result);
    if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
      // Unknown outcome: the charge may have landed. Ask before charging again.
      const auto found = lookupInvoice(invoice.invoice_id);
      if (found && found->state == "charged") return store::Outcome{"charged", found->reference, ""};
      continue;
    }
    if (status.error_code() == grpc::StatusCode::UNAVAILABLE) continue;
    if (!status.ok()) return store::Outcome{"failed", "", "processor_error"};
    // Final: the issuer said no.
    if (result.status() == "declined") return store::Outcome{"failed", "", result.decline_code()};
    return store::Outcome{"charged", result.reference(), ""};
  }
  return store::Outcome{"failed", "", "processor_unavailable"};
}
`,
    },
  },
  harness: {
    python: `import grpc

import subscription_billing_pb2 as pb
import subscription_billing_pb2_grpc

INVOICE = {
    "invoice_id": "in_1", "subscription_id": "sub_1", "tenant": "t-acme", "period_start": "2026-03-01",
    "period_end": "2026-04-01", "amount_cents": 9900, "state": "open", "reference": "", "reason": "",
}


class Processor(subscription_billing_pb2_grpc.ProcessorServicer):
    """Keeps what it charged per invoice; a repeated idempotency key answers the first charge. declines
    lists invoices the issuer refuses; lose_replies is how many next charges land but lose their reply."""

    def __init__(self):
        self.charged = {}
        self.keys = {}
        self.charges = 0
        self.declines = set()
        self.lose_replies = 0

    def Charge(self, request, context):
        if request.invoice_id in self.declines:
            return pb.ChargeResult(status="declined", decline_code="card_declined")
        if request.idempotency_key not in self.keys:
            self.charges += 1
            self.keys[request.idempotency_key] = f"ch_{self.charges}"
            reference, total = self.charged.get(request.invoice_id, ("", 0))
            self.charged[request.invoice_id] = (self.keys[request.idempotency_key], total + request.amount_cents)
        if self.lose_replies > 0:
            self.lose_replies -= 1
            context.abort(grpc.StatusCode.DEADLINE_EXCEEDED, "the charge landed; the reply was lost")
        return pb.ChargeResult(status="succeeded", reference=self.keys[request.idempotency_key])

    def GetInvoice(self, request, context):
        if request.invoice_id not in self.charged:
            context.abort(grpc.StatusCode.NOT_FOUND, f"no charge for {request.invoice_id}")
        reference, total = self.charged[request.invoice_id]
        return pb.ProcessorInvoice(invoice_id=request.invoice_id, state="charged", reference=reference, total_cents=total)


def _world(ctx):
    processor = Processor()
    ctx.grpc.serve(subscription_billing_pb2_grpc.add_ProcessorServicer_to_server, processor)
    return ctx.load("client"), processor


def check_deadline(ctx):
    m, processor = _world(ctx)
    outcome = m.charge_invoice(INVOICE)
    assert outcome["state"] == "charged", f"with a healthy processor charge_invoice answered {outcome}"
    assert m.lookup_invoice("in_1") is not None, "lookup_invoice found nothing for the invoice the processor just charged"
    for method in ("Charge", "GetInvoice"):
        for call in ctx.grpc.calls_to(method):
            assert call.timeout is not None, f"a {method} call carries no deadline: a processor that stops answering holds the billing run"
            assert 4.5 <= call.timeout <= 5.5, f"a {method} call carries a {call.timeout} s deadline, expected DEADLINE_S = 5"
    ctx.grpc.set_latency("Charge", 120.0)
    before = ctx.clock.time()
    outcome = m.charge_invoice({**INVOICE, "invoice_id": "in_2"})
    waited = ctx.clock.time() - before
    assert outcome["state"] == "failed", f"against a processor that never answers charge_invoice answered {outcome}"
    assert waited <= 40, f"charge_invoice waited {waited:.0f} s on a processor that never answers"


def check_invoice_key(ctx):
    m, processor = _world(ctx)
    ctx.grpc.fail("Charge", grpc.StatusCode.UNAVAILABLE, "connection reset", times=1)
    outcome = m.charge_invoice(INVOICE)
    assert outcome["state"] == "charged", f"a charge retried after UNAVAILABLE answered {outcome}"
    keys = [c.request.idempotency_key for c in ctx.grpc.calls_to("Charge")]
    assert len(keys) == 2, f"expected the failed attempt and one retry, the processor saw {len(keys)} Charge calls"
    assert keys == ["in_1", "in_1"], f"the attempts carried the idempotency keys {keys}: every attempt must carry the invoice id in_1, or the processor takes a retry for a new charge"


def check_reconcile_before_retry(ctx):
    m, processor = _world(ctx)
    processor.lose_replies = 1
    outcome = m.charge_invoice(INVOICE)
    assert processor.charges == 1, f"the charge landed and only its reply was lost, yet the processor made {processor.charges} charges for in_1: ask GetInvoice before charging again"
    assert outcome["state"] == "charged" and outcome["reference"] == "ch_1", f"charge_invoice answered {outcome}, expected the reference of the charge that landed, ch_1"
    assert ctx.grpc.calls_to("GetInvoice"), "a DEADLINE_EXCEEDED must be followed by GetInvoice for the invoice"


def check_decline_terminal(ctx):
    m, processor = _world(ctx)
    processor.declines.add("in_1")
    outcome = m.charge_invoice(INVOICE)
    calls = len(ctx.grpc.calls_to("Charge"))
    assert calls == 1, f"a declined card was charged {calls} times: a decline is final"
    assert outcome == {"state": "failed", "reference": "", "reason": "card_declined"}, f"a decline answered {outcome}, expected state failed with the decline code card_declined as the reason"
`,
    typescript: `const INVOICE = {
  invoice_id: 'in_1', subscription_id: 'sub_1', tenant: 't-acme', period_start: '2026-03-01',
  period_end: '2026-04-01', amount_cents: 9900, state: 'open', reference: '', reason: '',
};

/**
 * Keeps what it charged per invoice; a repeated idempotency key answers the first charge. declines
 * lists invoices the issuer refuses; loseReplies is how many next charges land but lose their reply.
 */
function world(ctx) {
  const pkg = ctx.proto('subscription_billing.proto');
  const p = {charged: new Map<string, {reference: string; total: number}>(), keys: new Map<string, string>(), charges: 0, declines: new Set<string>(), loseReplies: 0};
  ctx.grpc.serve(pkg.subbilling.Processor.service, {
    Charge(call, callback) {
      const {invoice_id, amount_cents, idempotency_key} = call.request;
      if (p.declines.has(invoice_id)) return callback(null, {status: 'declined', reference: '', decline_code: 'card_declined'});
      if (!p.keys.has(idempotency_key)) {
        p.charges += 1;
        p.keys.set(idempotency_key, \`ch_\${p.charges}\`);
        p.charged.set(invoice_id, {reference: p.keys.get(idempotency_key) as string, total: (p.charged.get(invoice_id)?.total ?? 0) + Number(amount_cents)});
      }
      if (p.loseReplies > 0) {
        p.loseReplies -= 1;
        return callback({code: ctx.grpc.status.DEADLINE_EXCEEDED, details: 'the charge landed; the reply was lost'});
      }
      callback(null, {status: 'succeeded', reference: p.keys.get(idempotency_key), decline_code: ''});
    },
    GetInvoice(call, callback) {
      const found = p.charged.get(call.request.invoice_id);
      if (found === undefined) return callback({code: ctx.grpc.status.NOT_FOUND, details: \`no charge for \${call.request.invoice_id}\`});
      callback(null, {invoice_id: call.request.invoice_id, state: 'charged', reference: found.reference, total_cents: found.total});
    },
  });
  return {m: ctx.load('client'), p};
}

export async function check_deadline(ctx) {
  const {m} = world(ctx);
  let outcome = await m.chargeInvoice(INVOICE);
  assert.equal(outcome.state, 'charged', \`with a healthy processor chargeInvoice answered \${JSON.stringify(outcome)}\`);
  assert.notEqual(await m.lookupInvoice('in_1'), null, 'lookupInvoice found nothing for the invoice the processor just charged');
  for (const method of ['Charge', 'GetInvoice']) {
    for (const call of ctx.grpc.callsTo(method)) {
      assert(call.timeout !== null, \`a \${method} call carries no deadline: a processor that stops answering holds the billing run\`);
      assert(4.5 <= call.timeout && call.timeout <= 5.5, \`a \${method} call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 5000\`);
    }
  }
  ctx.grpc.setLatency('Charge', 120.0);
  const before = ctx.clock.now();
  outcome = await m.chargeInvoice({...INVOICE, invoice_id: 'in_2'});
  const waited = (ctx.clock.now() - before) / 1000;
  assert.equal(outcome.state, 'failed', \`against a processor that never answers chargeInvoice answered \${JSON.stringify(outcome)}\`);
  assert(waited <= 40, \`chargeInvoice waited \${waited.toFixed(0)} s on a processor that never answers\`);
}

export async function check_invoice_key(ctx) {
  const {m} = world(ctx);
  ctx.grpc.fail('Charge', ctx.grpc.status.UNAVAILABLE, 'connection reset', 1);
  const outcome = await m.chargeInvoice(INVOICE);
  assert.equal(outcome.state, 'charged', \`a charge retried after UNAVAILABLE answered \${JSON.stringify(outcome)}\`);
  const keys = ctx.grpc.callsTo('Charge').map(c => c.request.idempotency_key);
  assert.equal(keys.length, 2, \`expected the failed attempt and one retry, the processor saw \${keys.length} Charge calls\`);
  assert.deepEqual(keys, ['in_1', 'in_1'], \`the attempts carried the idempotency keys \${JSON.stringify(keys)}: every attempt must carry the invoice id in_1, or the processor takes a retry for a new charge\`);
}

export async function check_reconcile_before_retry(ctx) {
  const {m, p} = world(ctx);
  p.loseReplies = 1;
  const outcome = await m.chargeInvoice(INVOICE);
  assert.equal(p.charges, 1, \`the charge landed and only its reply was lost, yet the processor made \${p.charges} charges for in_1: ask GetInvoice before charging again\`);
  assert(outcome.state === 'charged' && outcome.reference === 'ch_1', \`chargeInvoice answered \${JSON.stringify(outcome)}, expected the reference of the charge that landed, ch_1\`);
  assert(ctx.grpc.callsTo('GetInvoice').length > 0, 'a DEADLINE_EXCEEDED must be followed by GetInvoice for the invoice');
}

export async function check_decline_terminal(ctx) {
  const {m, p} = world(ctx);
  p.declines.add('in_1');
  const outcome = await m.chargeInvoice(INVOICE);
  const calls = ctx.grpc.callsTo('Charge').length;
  assert.equal(calls, 1, \`a declined card was charged \${calls} times: a decline is final\`);
  assert.deepEqual(outcome, {state: 'failed', reference: '', reason: 'card_declined'}, \`a decline answered \${JSON.stringify(outcome)}, expected state failed with the decline code card_declined as the reason\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "billing/gen/subscription_billing"
	"billing/store"

	"leetbuild/harness"
)

var (
	clientBg  = context.Background()
	invoiceIn = store.Invoice{InvoiceID: "in_1", SubscriptionID: "sub_1", Tenant: "t-acme", PeriodStart: "2026-03-01", PeriodEnd: "2026-04-01", AmountCents: 9900, State: "open"}
)

type landed struct {
	reference string
	total     int64
}

// clientPeer keeps what it charged per invoice; a repeated idempotency key answers the first charge.
// declines lists invoices the issuer refuses; loseReplies is how many next charges land but lose their reply.
type clientPeer struct {
	pb.UnimplementedProcessorServer
	charged     map[string]landed
	keys        map[string]string
	charges     int
	declines    map[string]bool
	loseReplies int
}

func (p *clientPeer) Charge(_ context.Context, req *pb.ChargeRequest) (*pb.ChargeResult, error) {
	if p.declines[req.GetInvoiceId()] {
		return &pb.ChargeResult{Status: "declined", DeclineCode: "card_declined"}, nil
	}
	if _, seen := p.keys[req.GetIdempotencyKey()]; !seen {
		p.charges++
		p.keys[req.GetIdempotencyKey()] = fmt.Sprintf("ch_%d", p.charges)
		p.charged[req.GetInvoiceId()] = landed{p.keys[req.GetIdempotencyKey()], p.charged[req.GetInvoiceId()].total + req.GetAmountCents()}
	}
	if p.loseReplies > 0 {
		p.loseReplies--
		return nil, status.Error(codes.DeadlineExceeded, "the charge landed; the reply was lost")
	}
	return &pb.ChargeResult{Status: "succeeded", Reference: p.keys[req.GetIdempotencyKey()]}, nil
}

func (p *clientPeer) GetInvoice(_ context.Context, req *pb.GetInvoiceRequest) (*pb.ProcessorInvoice, error) {
	found, ok := p.charged[req.GetInvoiceId()]
	if !ok {
		return nil, status.Errorf(codes.NotFound, "no charge for %s", req.GetInvoiceId())
	}
	return &pb.ProcessorInvoice{InvoiceId: req.GetInvoiceId(), State: "charged", Reference: found.reference, TotalCents: found.total}, nil
}

func clientWorld(ctx *harness.Ctx) *clientPeer {
	p := &clientPeer{charged: map[string]landed{}, keys: map[string]string{}, declines: map[string]bool{}}
	pb.RegisterProcessorServer(ctx.GRPC.Server(""), p)
	return p
}

func CheckDeadline(ctx *harness.Ctx) {
	clientWorld(ctx)
	invoice := invoiceIn
	outcome := chargeInvoice(clientBg, &invoice)
	ctx.Equal(outcome.State, "charged", "with a healthy processor, chargeInvoice's state")
	ctx.Assert(lookupInvoice(clientBg, "in_1") != nil, "lookupInvoice found nothing for the invoice the processor just charged")
	for _, method := range []string{"Charge", "GetInvoice"} {
		for _, call := range ctx.GRPC.CallsTo(method, "") {
			ctx.Assert(call.HasDeadline(), "a %s call carries no deadline: a processor that stops answering holds the billing run", method)
			ctx.Assert(4500*time.Millisecond <= call.Timeout && call.Timeout <= 5500*time.Millisecond, "a %s call carries a %v deadline, expected 5 s", method, call.Timeout)
		}
	}
	ctx.GRPC.SetLatency("Charge", 120.0, "")
	before := ctx.Clock.Now()
	other := invoiceIn
	other.InvoiceID = "in_2"
	outcome = chargeInvoice(clientBg, &other)
	waited := float64(ctx.Clock.Now()-before) / 1000
	ctx.Equal(outcome.State, "failed", "against a processor that never answers, chargeInvoice's state")
	ctx.Assert(waited <= 40, "chargeInvoice waited %.0f s on a processor that never answers", waited)
}

func CheckInvoiceKey(ctx *harness.Ctx) {
	clientWorld(ctx)
	ctx.GRPC.Fail("Charge", codes.Unavailable, "connection reset", 1, "")
	invoice := invoiceIn
	outcome := chargeInvoice(clientBg, &invoice)
	ctx.Equal(outcome.State, "charged", "a charge retried after UNAVAILABLE; the state")
	var keys []string
	for _, c := range ctx.GRPC.CallsTo("Charge", "") {
		keys = append(keys, c.Request.(*pb.ChargeRequest).GetIdempotencyKey())
	}
	ctx.Equal(len(keys), 2, "the failed attempt and one retry; Charge calls")
	ctx.Equal(keys, []string{"in_1", "in_1"}, "every attempt must carry the invoice id in_1, or the processor takes a retry for a new charge; the idempotency keys")
}

func CheckReconcileBeforeRetry(ctx *harness.Ctx) {
	p := clientWorld(ctx)
	p.loseReplies = 1
	invoice := invoiceIn
	outcome := chargeInvoice(clientBg, &invoice)
	ctx.Assert(p.charges == 1, "the charge landed and only its reply was lost, yet the processor made %d charges for in_1: ask GetInvoice before charging again", p.charges)
	ctx.Assert(outcome.State == "charged" && outcome.Reference == "ch_1", "chargeInvoice answered %+v, expected the reference of the charge that landed, ch_1", outcome)
	ctx.Assert(len(ctx.GRPC.CallsTo("GetInvoice", "")) > 0, "a DEADLINE_EXCEEDED must be followed by GetInvoice for the invoice")
}

func CheckDeclineTerminal(ctx *harness.Ctx) {
	p := clientWorld(ctx)
	p.declines["in_1"] = true
	invoice := invoiceIn
	outcome := chargeInvoice(clientBg, &invoice)
	ctx.Equal(len(ctx.GRPC.CallsTo("Charge", "")), 1, "a decline is final; Charge calls for a declined card")
	ctx.Equal(outcome, store.Outcome{State: "failed", Reason: "card_declined"}, "a decline must answer state failed with the decline code as the reason")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <set>
#include <string>
#include <vector>

#include "billing/store.h"
#include "subscription_billing.grpc.pb.h"

namespace {

const store::Invoice kInvoice{"in_1", "sub_1", "t-acme", "2026-03-01", "2026-04-01", 9900, "open", "", ""};

struct Landed {
  std::string reference;
  long long total = 0;
};

// Keeps what it charged per invoice; a repeated idempotency key answers the first charge. declines
// lists invoices the issuer refuses; lose_replies is how many next charges land but lose their reply.
class ProcessorPeer final : public subbilling::Processor::Service {
 public:
  std::map<std::string, Landed> charged;
  std::map<std::string, std::string> keys;
  int charges = 0;
  std::set<std::string> declines;
  int lose_replies = 0;

  grpc::Status Charge(grpc::ServerContext*, const subbilling::ChargeRequest* req, subbilling::ChargeResult* out) override {
    if (declines.count(req->invoice_id())) {
      out->set_status("declined");
      out->set_decline_code("card_declined");
      return grpc::Status::OK;
    }
    if (!keys.count(req->idempotency_key())) {
      charges++;
      keys[req->idempotency_key()] = "ch_" + std::to_string(charges);
      charged[req->invoice_id()] = {keys[req->idempotency_key()], charged[req->invoice_id()].total + req->amount_cents()};
    }
    if (lose_replies > 0) {
      lose_replies--;
      return grpc::Status(grpc::StatusCode::DEADLINE_EXCEEDED, "the charge landed; the reply was lost");
    }
    out->set_status("succeeded");
    out->set_reference(keys[req->idempotency_key()]);
    return grpc::Status::OK;
  }

  grpc::Status GetInvoice(grpc::ServerContext*, const subbilling::GetInvoiceRequest* req, subbilling::ProcessorInvoice* out) override {
    const auto it = charged.find(req->invoice_id());
    if (it == charged.end()) return grpc::Status(grpc::StatusCode::NOT_FOUND, "no charge for " + req->invoice_id());
    out->set_invoice_id(req->invoice_id());
    out->set_state("charged");
    out->set_reference(it->second.reference);
    out->set_total_cents(it->second.total);
    return grpc::Status::OK;
  }
};

ProcessorPeer& world(harness::Ctx& ctx) {
  static ProcessorPeer* peer = nullptr;
  delete peer;
  peer = new ProcessorPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  return *peer;
}

std::string show(const store::Outcome& o) { return "{" + o.state + ", " + o.reference + ", " + o.reason + "}"; }

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  world(ctx);
  store::Outcome outcome = chargeInvoice(kInvoice);
  ctx.Equal(outcome.state, "charged", "with a healthy processor, chargeInvoice's state");
  ctx.Assert(lookupInvoice("in_1").has_value(), "lookupInvoice found nothing for the invoice the processor just charged");
  for (const std::string method : {"Charge", "GetInvoice"}) {
    for (const auto& call : ctx.GRPC.CallsTo(method)) {
      ctx.Assert(call.HasDeadline(), "a %s call carries no deadline: a processor that stops answering holds the billing run", method);
      ctx.Assert(4.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 5.5, "a %s call carries a %v s deadline, expected kDeadline = 5 s", method, call.TimeoutSeconds());
    }
  }
  ctx.GRPC.SetLatency("Charge", 120.0);
  const int64_t before = ctx.Clock.Now();
  store::Invoice other = kInvoice;
  other.invoice_id = "in_2";
  outcome = chargeInvoice(other);
  const double waited = static_cast<double>(ctx.Clock.Now() - before) / 1000;
  ctx.Equal(outcome.state, "failed", "against a processor that never answers, chargeInvoice's state");
  ctx.Assert(waited <= 40, "chargeInvoice waited %.0f s on a processor that never answers", waited);
}

void CheckInvoiceKey(harness::Ctx& ctx) {
  world(ctx);
  ctx.GRPC.Fail("Charge", grpc::StatusCode::UNAVAILABLE, "connection reset", 1);
  const store::Outcome outcome = chargeInvoice(kInvoice);
  ctx.Equal(outcome.state, "charged", "a charge retried after UNAVAILABLE; the state");
  std::vector<std::string> keys;
  for (const auto& c : ctx.GRPC.CallsTo("Charge")) keys.push_back(c.Request<subbilling::ChargeRequest>().idempotency_key());
  ctx.Equal(keys.size(), 2, "the failed attempt and one retry; Charge calls");
  ctx.Equal(keys, {"in_1", "in_1"}, "every attempt must carry the invoice id in_1, or the processor takes a retry for a new charge; the idempotency keys");
}

void CheckReconcileBeforeRetry(harness::Ctx& ctx) {
  ProcessorPeer& peer = world(ctx);
  peer.lose_replies = 1;
  const store::Outcome outcome = chargeInvoice(kInvoice);
  ctx.Assert(peer.charges == 1, "the charge landed and only its reply was lost, yet the processor made %d charges for in_1: ask GetInvoice before charging again", peer.charges);
  ctx.Assert(outcome.state == "charged" && outcome.reference == "ch_1", "chargeInvoice answered %s, expected the reference of the charge that landed, ch_1", show(outcome));
  ctx.Assert(!ctx.GRPC.CallsTo("GetInvoice").empty(), "a DEADLINE_EXCEEDED must be followed by GetInvoice for the invoice");
}

void CheckDeclineTerminal(harness::Ctx& ctx) {
  ProcessorPeer& peer = world(ctx);
  peer.declines.insert("in_1");
  const store::Outcome outcome = chargeInvoice(kInvoice);
  ctx.Equal(ctx.GRPC.CallsTo("Charge").size(), 1, "a decline is final; Charge calls for a declined card");
  ctx.Assert(outcome.state == "failed" && outcome.reference.empty() && outcome.reason == "card_declined",
             "a decline answered %s, expected state failed with the decline code card_declined as the reason", show(outcome));
}
`,
  },
  hints: [
    'Make the processor slow: the billing run waits as long as it does. Lose one reply after a charge landed: the customer is charged twice. Decline the card: the issuer sees three attempts.',
    'No call sets a deadline; each attempt builds a new key (`{invoice_id}-{attempt}`), so the processor cannot tell a retry from a new charge; the loop retries any error, a deadline included, and treats `declined` like a failure to try again.',
    'Build the request once with `idempotency_key=invoice["invoice_id"]`, pass `timeout=DEADLINE_S` to both calls, on `DEADLINE_EXCEEDED` call `lookup_invoice` and adopt a `charged` reference before retrying, and return `failed` with `decline_code` on `declined`.',
  ],
  debrief: `What does the client know when a call comes back empty-handed? \`UNAVAILABLE\` means the request never reached the processor, so a retry is safe; \`DEADLINE_EXCEEDED\` means it may have done everything, which is why the client asks \`GetInvoice\` before charging again. The invoice id is the idempotency key because it survives the retry, a restart and the reconciler that runs hours later; a key minted per attempt is a new charge. A decline is the issuer's answer, not a failure of the call, so it ends the attempt. Card processors add more states than this one: pending and authorized charges a run must not treat as settled, webhooks for replies that never arrived, and soft declines worth retrying days later.`,
};
