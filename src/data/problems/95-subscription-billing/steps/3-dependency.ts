import type {Step} from '@/lib/types';

export const processorClientStep: Step = {
  id: 'dependency',
  title: 'Processor calls with invoice-scoped idempotency',
  concept: 'grpc',
  file: 'client',
  focus: ['billing', 'processor', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft of the processor client: it
charges the invoice, loops three times over anything that throws, and returns a charge reference
when the processor is healthy. The happy path bills correctly, so the demo passes and every defect
sits in a branch a healthy processor never takes. Review it like the billing owner and fix it.

Implement the charge of one invoice against the payment processor's gRPC service — \`Charge\` and
\`GetInvoice\` on the same stub:

- Every processor call carries a **5-second** deadline (\`PROCESSOR_DEADLINE_S\` /
  \`PROCESSOR_DEADLINE_MS\` / \`processorDeadline\` / \`ProcessorDeadlineS\` /
  \`kProcessorDeadlineS\`). A processor that accepts the connection and then stalls must not pin the
  billing run.
- The idempotency key is the **invoice id**, and every attempt of the same charge sends the **same**
  key: only a repeated call that looks like the same charge can be collapsed by the processor.
- A \`DEADLINE_EXCEEDED\` is an unknown outcome, not a failure. Read the processor's invoice state
  with \`GetInvoice\` for the same invoice id **before** deciding anything, and adopt the charge
  reference it reports when the charge already landed instead of sending another one.
- A hard decline — \`HARD_DECLINE\`, \`CARD_DECLINED\`, \`INSUFFICIENT_FUNDS\` — is terminal: one
  attempt, then the invoice is marked \`failed\` with the decline code as its \`reason\`. A bounced
  card does not become healthy because you asked again.
- Attempts are bounded by \`MAX_ATTEMPTS = 3\`, and only the failures a retry can change — the
  deadline and an unavailable processor — may be retried. A decline is a business answer, not a
  transport error.
- Store the outcome on the invoice: the reference when the charge landed, \`failed\` and the reason
  when the issuer refused it. Log the invoice id and the outcome, never card data.

**Failure mode the checks target.** Every defect is invisible while the processor is healthy: three
attempts over every error, a fresh \`uuid\` key minted inside the loop (so a retry is a brand-new
charge and the customer is billed twice), no \`GetInvoice\` reconciliation after a timeout, a hard
decline retried three times at the customer's issuer, no deadline at all, and a \`pending\` return
with no reason when the loop runs out — an invoice that actually failed looking like one still on its
way.`,
  sequence: {
    participants: ['Billing Service', 'Payment processor', 'billing db'],
    messages: [
      {
        from: 'Billing Service',
        to: 'Payment processor',
        label: 'Charge {invoice_id, subscription_id, amount_cents, idempotency_key = invoice_id} — 5 s deadline',
        kind: 'sync',
      },
      {
        from: 'Payment processor',
        to: 'Billing Service',
        label: 'DEADLINE_EXCEEDED — no answer within the deadline',
        kind: 'reply',
      },
      {
        from: 'Billing Service',
        to: 'Payment processor',
        label: 'GetInvoice {invoice_id} — did the charge land?',
        kind: 'sync',
      },
      {
        from: 'Payment processor',
        to: 'Billing Service',
        label: 'invoice state: reference (already charged) or no charge',
        kind: 'reply',
      },
      {
        from: 'Billing Service',
        to: 'Billing Service',
        label: 'adopt the reference, or retry with the same key (MAX_ATTEMPTS = 3)',
        kind: 'sync',
      },
      {
        from: 'Payment processor',
        to: 'Billing Service',
        label: 'HARD_DECLINE · CARD_DECLINED · INSUFFICIENT_FUNDS — terminal, one attempt',
        kind: 'reply',
      },
      {
        from: 'Billing Service',
        to: 'billing db',
        label: 'store the invoice: charged + reference, or failed + reason',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Sends the charge under a 5-second deadline',
      detail:
        'Every processor call sets a **5-second** deadline (the stack’s equivalent of `timeout=PROCESSOR_DEADLINE_S`). The draft calls the processor with no deadline at all, so a hung processor pins the billing run forever.',
      match: {
        python: {all: [/PROCESSOR_DEADLINE_S/, /timeout=PROCESSOR_DEADLINE_S/]},
        typescript: {all: [/PROCESSOR_DEADLINE_MS/, /deadline:\s*Date\.now\(\)\s*\+\s*PROCESSOR_DEADLINE_MS/]},
        go: {all: [/processorDeadline/, /context\.WithTimeout/]},
        scala: {all: [/ProcessorDeadline/, /DeadlineAfter/]},
        cpp: {all: [/kProcessorDeadlineS/, /set_deadline/]},
      },
    },
    {
      id: 'invoice-key',
      title: 'Keys the charge by the invoice id',
      detail:
        'The idempotency key is the invoice id, so the processor can recognise a repeated charge. The draft mints a fresh `uuid` per attempt, so a retry looks like a brand-new charge and the customer is billed twice.',
      match: {
        python: {all: [/idempotency_key=invoice\.id/, /invoice_id/]},
        typescript: {all: [/idempotencyKey:\s*invoice\.id/, /invoice_id/]},
        go: {all: [/IdempotencyKey:\s*invoice\.ID/, /InvoiceId/]},
        scala: {all: [/idempotency_key\s*=\s*invoice\.id/, /invoice_id/]},
        cpp: {all: [/set_idempotency_key\(invoice\.id\(\)\)/, /invoice_id/]},
      },
    },
    {
      id: 'reconcile-before-retry',
      title: 'Reconciles the processor invoice before any retry',
      detail:
        'A `DEADLINE_EXCEEDED` is followed by `GetInvoice` for the same invoice id, and the charge is only retried when the processor reports no charge. The draft retries the charge immediately, so a charge that actually landed is charged again.',
      match: {
        python: {all: [/DEADLINE_EXCEEDED/], order: [/processor\.Charge\(/, /processor\.GetInvoice\(/]},
        typescript: {all: [/DEADLINE_EXCEEDED/], order: [/processor\.Charge\(/, /processor\.GetInvoice\(/]},
        go: {all: [/codes\.DeadlineExceeded/], order: [/client\.Charge\(/, /client\.GetInvoice\(/]},
        scala: {all: [/DEADLINE_EXCEEDED/], order: [/stub\.charge\(/, /stub\.getInvoice\(/]},
        cpp: {all: [/DEADLINE_EXCEEDED/], order: [/Charge\(/, /GetInvoice\(/]},
      },
    },
    {
      id: 'decline-terminal',
      title: 'A hard decline is terminal and records a reason',
      detail:
        'A hard decline stops after one attempt and marks the invoice **failed** with the decline code as its `reason`. The draft treats it as retryable and fires three charges at the customer’s issuer.',
      match: {
        python: {all: [/TERMINAL_DECLINES/, /"failed"/, /reason/, /decline_code/]},
        typescript: {all: [/TERMINAL_DECLINES/, /'failed'/, /reason/, /decline_code/]},
        go: {all: [/terminalDeclines/, /"failed"/, /Reason/, /DeclineCode/]},
        scala: {all: [/TerminalDeclines/, /"failed"/, /reason/, /declineCode/]},
        cpp: {all: [/kTerminalDeclines/, /"failed"/, /reason/, /decline_code/]},
      },
    },
    {
      id: 'retry-same-key',
      title: 'Retries reuse the invoice-scoped key',
      detail:
        'Retries are bounded (`MAX_ATTEMPTS`) and every attempt sends the same invoice-scoped key. A key minted per attempt makes each retry a new charge in the processor’s ledger.',
      match: {
        python: {all: [/for attempt in range\(/, /MAX_ATTEMPTS/], none: [/idempotency_key[^\n]*uuid/i]},
        typescript: {all: [/for \(let attempt = 0/, /MAX_ATTEMPTS/], none: [/idempotencyKey[^\n]*randomUUID/]},
        go: {all: [/for attempt := 0/, /maxAttempts/], none: [/IdempotencyKey[^\n]*uuid/]},
        scala: {all: [/for \(attempt <-/, /MaxAttempts/], none: [/idempotency_key[^\n]*UUID/]},
        cpp: {all: [/for \(int attempt = 0/, /kMaxAttempts/], none: [/set_idempotency_key\([^\n]*uuid/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Billing run: charge each invoice on the payment processor."""

import logging
import uuid

import grpc
from fastapi import FastAPI

import billing_pb2
import billing_pb2_grpc

app = FastAPI()
log = logging.getLogger("billing.processor")

DECLINE_RETRIES = 3

processor = billing_pb2_grpc.ProcessorStub(grpc.insecure_channel("processor:9000"))


class Invoice:
    """The \`invoices\` row this run updates; InvoiceStore stands in for the billing db."""

    def __init__(self, invoice_id: str, subscription_id: str, amount_cents: int) -> None:
        self.id = invoice_id
        self.subscription_id = subscription_id
        self.amount_cents = amount_cents
        self.status = "pending"
        self.reason = ""
        self.reference = ""


class InvoiceStore:
    def __init__(self) -> None:
        self.rows: dict[str, Invoice] = {}

    def save(self, invoice: Invoice) -> None:
        self.rows[invoice.id] = invoice
        log.info("invoice %s %s", invoice.id, invoice.status)


store = InvoiceStore()


@app.post("/v1/invoices/charge")
def charge(body: dict) -> dict:
    invoice = Invoice(body["invoice_id"], body["subscription_id"], body["amount_cents"])
    return charge_invoice(invoice)


def charge_invoice(invoice: Invoice) -> dict:
    # TODO: a model-generated draft. It retries DECLINE_RETRIES times over every error, mints a
    # fresh uuid as the idempotency key inside the loop, sets no deadline, never reconciles a
    # timeout with GetInvoice, retries a hard decline at the customer's issuer and returns
    # {"status": "pending"} with no reason once the attempts run out.
    for attempt in range(DECLINE_RETRIES):
        try:
            reply = processor.Charge(
                billing_pb2.ChargeRequest(
                    invoice_id=invoice.id,
                    subscription_id=invoice.subscription_id,
                    amount_cents=invoice.amount_cents,
                    idempotency_key=str(uuid.uuid4()),
                )
            )
        except grpc.RpcError:
            continue
        if reply.decline_code:
            continue
        invoice.status = "charged"
        invoice.reference = reply.reference
        store.save(invoice)
        return {"invoice_id": invoice.id, "status": "charged", "reference": reply.reference}
    log.warning("charge attempts exhausted invoice=%s", invoice.id)
    return {"invoice_id": invoice.id, "status": "pending"}
`,
      solution: `"""Billing run: charge each invoice on the payment processor exactly once."""

import logging

import grpc
from fastapi import FastAPI

import billing_pb2
import billing_pb2_grpc

app = FastAPI()
log = logging.getLogger("billing.processor")

PROCESSOR_DEADLINE_S = 5.0
MAX_ATTEMPTS = 3
TERMINAL_DECLINES = {"HARD_DECLINE", "CARD_DECLINED", "INSUFFICIENT_FUNDS"}
RETRYABLE = {grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE}

processor = billing_pb2_grpc.ProcessorStub(grpc.insecure_channel("processor:9000"))


class Invoice:
    """The \`invoices\` row this run updates; InvoiceStore stands in for the billing db."""

    def __init__(self, invoice_id: str, subscription_id: str, amount_cents: int) -> None:
        self.id = invoice_id
        self.subscription_id = subscription_id
        self.amount_cents = amount_cents
        self.status = "pending"
        self.reason = ""
        self.reference = ""


class InvoiceStore:
    def __init__(self) -> None:
        self.rows: dict[str, Invoice] = {}

    def save(self, invoice: Invoice) -> None:
        self.rows[invoice.id] = invoice
        log.info("invoice %s %s reference=%s", invoice.id, invoice.status, invoice.reference)

    def fail(self, invoice: Invoice, decline_code: str) -> dict:
        invoice.status = "failed"
        invoice.reason = decline_code
        self.save(invoice)
        return {"invoice_id": invoice.id, "status": "failed", "reason": decline_code}


store = InvoiceStore()


@app.post("/v1/invoices/charge")
def charge(body: dict) -> dict:
    invoice = Invoice(body["invoice_id"], body["subscription_id"], body["amount_cents"])
    return charge_invoice(invoice)


def charge_invoice(invoice: Invoice) -> dict:
    """Charge once per invoice: every attempt sends the same invoice-scoped key."""
    last_error: grpc.RpcError | None = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            reply = processor.Charge(
                billing_pb2.ChargeRequest(
                    invoice_id=invoice.id,
                    subscription_id=invoice.subscription_id,
                    amount_cents=invoice.amount_cents,
                    idempotency_key=invoice.id,
                ),
                timeout=PROCESSOR_DEADLINE_S,
            )
        except grpc.RpcError as exc:
            last_error = exc
            if exc.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
                # A timeout is an unknown outcome, not a failure: read the processor's state first.
                reference = reconcile(invoice)
                if reference is not None:
                    return confirm(invoice, reference)
            if exc.code() not in RETRYABLE:
                raise
            continue
        if reply.decline_code:
            if reply.decline_code in TERMINAL_DECLINES:
                # A hard decline is the issuer's answer: one attempt, then the invoice is failed.
                return store.fail(invoice, reply.decline_code)
            raise RuntimeError("soft decline: " + reply.decline_code)
        return confirm(invoice, reply.reference)
    raise last_error or RuntimeError("charge attempts exhausted")


def reconcile(invoice: Invoice) -> str | None:
    """The processor's own state for this invoice: its reference when the charge landed."""
    state = processor.GetInvoice(
        billing_pb2.GetInvoiceRequest(invoice_id=invoice.id),
        timeout=PROCESSOR_DEADLINE_S,
    )
    return state.reference or None


def confirm(invoice: Invoice, reference: str) -> dict:
    invoice.status = "charged"
    invoice.reference = reference
    store.save(invoice)
    return {"invoice_id": invoice.id, "status": "charged", "reference": reference}
`,
    },
    typescript: {
      starter: `/** Billing run: charge an invoice on the payment processor (model-generated draft). */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';
import {randomUUID} from 'node:crypto';

export const app = Fastify();

const declineRetries = 3;

interface ChargeRequest {
  invoiceId: string;
  subscriptionId: string;
  amountCents: number;
  idempotencyKey: string;
}

interface ChargeReply {
  reference: string;
  declineCode: string;
}

/** The \`invoices\` row this run updates; \`store\` stands in for the billing db. */
interface Invoice {
  id: string;
  subscriptionId: string;
  amountCents: number;
  status: string;
  reason: string;
  reference: string;
}

interface ProcessorClient {
  Charge(request: ChargeRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: (error: grpc.ServiceError | null, reply: ChargeReply) => void): void;
  GetInvoice(request: {invoiceId: string}, metadata: grpc.Metadata, options: grpc.CallOptions, callback: (error: grpc.ServiceError | null, reply: {reference: string}) => void): void;
}

const {processor: processorPackage} = grpc.loadPackageDefinition(protoLoader.loadSync('billing.proto')) as unknown as {
  processor: {Processor: new (target: string, credentials: grpc.ChannelCredentials) => ProcessorClient};
};
const processor = new processorPackage.Processor('processor:9000', grpc.credentials.createInsecure());

const rows = new Map<string, Invoice>();

export const store = {
  save(invoice: Invoice): void {
    rows.set(invoice.id, invoice);
    app.log.info({invoice_id: invoice.id, status: invoice.status}, 'invoice stored');
  },
};

function unary<R>(
  invoke: (options: grpc.CallOptions, callback: (error: grpc.ServiceError | null, reply: R) => void) => void,
): Promise<R> {
  const {promise, resolve, reject} = Promise.withResolvers<R>();
  invoke({}, (error, reply) => (error ? reject(error) : resolve(reply)));
  return promise;
}

export async function chargeInvoice(invoice: Invoice): Promise<Record<string, string>> {
  // TODO: a model-generated draft. It retries declineRetries times over every error, mints a fresh
  // randomUUID inside the loop as the key, sets no deadline, never reconciles a timeout with
  // GetInvoice, retries a hard decline at the customer's issuer and reports 'pending' with no
  // reason once the attempts run out.
  for (let attempt = 0; attempt < declineRetries; attempt++) {
    try {
      const reply = await unary<ChargeReply>((options, callback) =>
        processor.Charge(
          {
            invoiceId: invoice.id,
            subscriptionId: invoice.subscriptionId,
            amountCents: invoice.amountCents,
            idempotencyKey: randomUUID(),
          },
          new grpc.Metadata(),
          options,
          callback,
        ),
      );
      if (reply.declineCode !== '') continue;
      invoice.status = 'charged';
      invoice.reference = reply.reference;
      store.save(invoice);
      return {invoice_id: invoice.id, status: 'charged', reference: reply.reference};
    } catch {
      continue;
    }
  }
  return {invoice_id: invoice.id, status: 'pending'};
}

app.post('/v1/invoices/charge', async request => {
  const body = request.body as {invoiceId: string; subscriptionId: string; amountCents: number};
  return chargeInvoice({...body, id: body.invoiceId, status: 'pending', reason: '', reference: ''});
});
`,
      solution: `/** Billing run: charge an invoice with a deadline and an invoice-scoped idempotency key. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

export const app = Fastify();

const PROCESSOR_DEADLINE_MS = 5_000;
const MAX_ATTEMPTS = 3;
const TERMINAL_DECLINES: Record<string, true> = {HARD_DECLINE: true, CARD_DECLINED: true, INSUFFICIENT_FUNDS: true};
const RETRYABLE: Record<number, true> = {[grpc.status.DEADLINE_EXCEEDED]: true, [grpc.status.UNAVAILABLE]: true};

interface ChargeRequest {
  invoiceId: string;
  subscriptionId: string;
  amountCents: number;
  idempotencyKey: string;
}

interface ChargeReply {
  reference: string;
  declineCode: string;
}

/** The \`invoices\` row this run updates; \`store\` stands in for the billing db. */
interface Invoice {
  id: string;
  subscriptionId: string;
  amountCents: number;
  status: string;
  reason: string;
  reference: string;
}

interface ProcessorClient {
  Charge(request: ChargeRequest, metadata: grpc.Metadata, options: grpc.CallOptions, callback: (error: grpc.ServiceError | null, reply: ChargeReply) => void): void;
  GetInvoice(request: {invoiceId: string}, metadata: grpc.Metadata, options: grpc.CallOptions, callback: (error: grpc.ServiceError | null, reply: {reference: string}) => void): void;
}

const {processor: processorPackage} = grpc.loadPackageDefinition(protoLoader.loadSync('billing.proto')) as unknown as {
  processor: {Processor: new (target: string, credentials: grpc.ChannelCredentials) => ProcessorClient};
};
const processor = new processorPackage.Processor('processor:9000', grpc.credentials.createInsecure());

const rows = new Map<string, Invoice>();

export const store = {
  save(invoice: Invoice): void {
    rows.set(invoice.id, invoice);
    app.log.info({invoice_id: invoice.id, status: invoice.status}, 'invoice stored');
  },
  fail(invoice: Invoice, declineCode: string): Record<string, string> {
    invoice.status = 'failed';
    invoice.reason = declineCode;
    store.save(invoice);
    app.log.warn({invoice_id: invoice.id, decline_code: declineCode}, 'charge declined');
    return {invoice_id: invoice.id, status: 'failed', reason: declineCode};
  },
};

/** Every processor call carries the deadline: the options are built here, never defaulted. */
const callOptions = (): grpc.CallOptions => ({deadline: Date.now() + PROCESSOR_DEADLINE_MS});

function unary<R>(
  invoke: (options: grpc.CallOptions, callback: (error: grpc.ServiceError | null, reply: R) => void) => void,
): Promise<R> {
  const {promise, resolve, reject} = Promise.withResolvers<R>();
  invoke(callOptions(), (error, reply) => (error ? reject(error) : resolve(reply)));
  return promise;
}

export async function chargeInvoice(invoice: Invoice): Promise<Record<string, string>> {
  let lastError: grpc.ServiceError | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await unary<ChargeReply>((options, callback) =>
        processor.Charge(
          {
            invoiceId: invoice.id,
            subscriptionId: invoice.subscriptionId,
            amountCents: invoice.amountCents,
            idempotencyKey: invoice.id,
          },
          new grpc.Metadata(),
          options,
          callback,
        ),
      );
      if (reply.declineCode !== '') {
        if (TERMINAL_DECLINES[reply.declineCode] === true) return store.fail(invoice, reply.declineCode);
        throw new Error('soft decline: ' + reply.declineCode);
      }
      return confirm(invoice, reply.reference);
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      lastError = serviceError;
      if (serviceError.code === grpc.status.DEADLINE_EXCEEDED) {
        // A timeout is an unknown outcome: read the processor's state before charging again.
        const reference = await reconcile(invoice);
        if (reference !== null) return confirm(invoice, reference);
      }
      if (RETRYABLE[serviceError.code] !== true) throw serviceError;
    }
  }
  throw lastError ?? new Error('charge attempts exhausted');
}

async function reconcile(invoice: Invoice): Promise<string | null> {
  const state = await unary<{reference: string}>((options, callback) =>
    processor.GetInvoice({invoiceId: invoice.id}, new grpc.Metadata(), options, callback),
  );
  return state.reference === '' ? null : state.reference;
}

function confirm(invoice: Invoice, reference: string): Record<string, string> {
  invoice.status = 'charged';
  invoice.reference = reference;
  store.save(invoice);
  return {invoice_id: invoice.id, status: 'charged', reference};
}

app.post('/v1/invoices/charge', async request => {
  const body = request.body as {invoiceId: string; subscriptionId: string; amountCents: number};
  return chargeInvoice({...body, id: body.invoiceId, status: 'pending', reason: '', reference: ''});
});
`,
    },
    go: {
      starter: `package main

import (
	"context"

	"github.com/google/uuid"
	"google.golang.org/grpc"

	pb "billing/processorpb"
)

const declineRetries = 3

// Invoice is the \`invoices\` row the run updates; InvoiceStore stands in for the billing db.
type Invoice struct {
	ID             string
	SubscriptionID string
	AmountCents    int64
	Status         string
	Reason         string
	Reference      string
}

type InvoiceStore struct{ rows map[string]*Invoice }

func (s *InvoiceStore) Save(invoice *Invoice) { s.rows[invoice.ID] = invoice }

var store = &InvoiceStore{rows: map[string]*Invoice{}}

// TODO: a model-generated draft. It retries declineRetries times over every error, mints a fresh
// uuid as the idempotency key inside the loop, sets no deadline, never reconciles a timeout with
// GetInvoice, retries a hard decline at the customer's issuer and leaves the row pending with no
// reason.
func ChargeInvoice(ctx context.Context, client pb.ProcessorClient, invoice *Invoice) error {
	for attempt := 0; attempt < declineRetries; attempt++ {
		reply, err := client.Charge(ctx, &pb.ChargeRequest{
			InvoiceId:      invoice.ID,
			SubscriptionId: invoice.SubscriptionID,
			AmountCents:    invoice.AmountCents,
			IdempotencyKey: uuid.NewString(),
		})
		if err != nil {
			continue
		}
		if reply.GetDeclineCode() != "" {
			continue
		}
		invoice.Status = "charged"
		invoice.Reference = reply.GetReference()
		store.Save(invoice)
		return nil
	}
	return nil
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "billing/processorpb"
)

const (
	// processorDeadline bounds one attempt; the draft sets none at all.
	processorDeadline = 5 * time.Second
	maxAttempts       = 3
)

var terminalDeclines = map[string]bool{"HARD_DECLINE": true, "CARD_DECLINED": true, "INSUFFICIENT_FUNDS": true}

var retryable = map[codes.Code]bool{codes.DeadlineExceeded: true, codes.Unavailable: true}

// Invoice is the \`invoices\` row the run updates; InvoiceStore stands in for the billing db.
type Invoice struct {
	ID             string
	SubscriptionID string
	AmountCents    int64
	Status         string
	Reason         string
	Reference      string
}

type InvoiceStore struct{ rows map[string]*Invoice }

func (s *InvoiceStore) Save(invoice *Invoice) { s.rows[invoice.ID] = invoice }

func (s *InvoiceStore) Fail(invoice *Invoice, declineCode string) error {
	invoice.Status = "failed"
	invoice.Reason = declineCode
	s.Save(invoice)
	return status.Errorf(codes.FailedPrecondition, "invoice %s declined: %s", invoice.ID, declineCode)
}

var store = &InvoiceStore{rows: map[string]*Invoice{}}

// ChargeInvoice charges one invoice: the invoice id is the idempotency key of every attempt.
func ChargeInvoice(ctx context.Context, client pb.ProcessorClient, invoice *Invoice) error {
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, processorDeadline)
		reply, err := client.Charge(callCtx, &pb.ChargeRequest{
			InvoiceId:      invoice.ID,
			SubscriptionId: invoice.SubscriptionID,
			AmountCents:    invoice.AmountCents,
			IdempotencyKey: invoice.ID,
		})
		cancel()
		if err != nil {
			lastErr = err
			if status.Code(err) == codes.DeadlineExceeded {
				// A timeout is an unknown outcome: ask the processor before charging again.
				reference, reconcileErr := reconcile(ctx, client, invoice.ID)
				if reconcileErr != nil {
					lastErr = reconcileErr
				} else if reference != "" {
					confirm(invoice, reference)
					return nil
				}
			}
			if !retryable[status.Code(err)] {
				return err
			}
			continue
		}
		declineCode := reply.GetDeclineCode()
		if terminalDeclines[declineCode] {
			// A hard decline is the issuer's answer: one attempt, then the invoice is failed.
			return store.Fail(invoice, declineCode)
		}
		if declineCode != "" {
			return status.Errorf(codes.FailedPrecondition, "soft decline: %s", declineCode)
		}
		confirm(invoice, reply.GetReference())
		return nil
	}
	if lastErr == nil {
		lastErr = errors.New("charge attempts exhausted")
	}
	return lastErr
}

func reconcile(ctx context.Context, client pb.ProcessorClient, invoiceID string) (string, error) {
	callCtx, cancel := context.WithTimeout(ctx, processorDeadline)
	defer cancel()
	state, err := client.GetInvoice(callCtx, &pb.GetInvoiceRequest{InvoiceId: invoiceID})
	if err != nil {
		return "", err
	}
	return state.GetReference(), nil
}

func confirm(invoice *Invoice, reference string) {
	invoice.Status = "charged"
	invoice.Reference = reference
	store.Save(invoice)
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import java.util.UUID

object ProcessorClient {
  val DeclineRetries = 3

  val stub = ProcessorGrpc.blockingStub(ManagedChannelBuilder.forAddress("processor", 9000).usePlaintext().build())

  /** The \`invoices\` row this run updates; Store stands in for the billing db. */
  class Invoice(val id: String, val subscriptionId: String, val amountCents: Long) {
    var status: String = "pending"
    var reason: String = ""
    var reference: String = ""
  }

  case class ChargeOutcome(invoice_id: String, status: String, reference: String = "", reason: String = "")

  object Store {
    private val rows = scala.collection.mutable.Map.empty[String, Invoice]

    def save(invoice: Invoice): Unit = rows(invoice.id) = invoice
  }

  // TODO: a model-generated draft. It retries DeclineRetries times over every error, mints a fresh
  // UUID inside the loop as the idempotency key, sets no deadline, never reconciles a timeout with
  // getInvoice, retries a hard decline at the customer's issuer and reports "pending" with no
  // reason once the attempts run out.
  def chargeInvoice(invoice: Invoice): ChargeOutcome = {
    var attempt = 0
    while (attempt < DeclineRetries) {
      try {
        val reply = stub.charge(
          ChargeRequest(
            invoice_id = invoice.id,
            subscription_id = invoice.subscriptionId,
            amount_cents = invoice.amountCents,
            idempotency_key = UUID.randomUUID().toString
          )
        )
        if (reply.decline_code.isEmpty) {
          invoice.status = "charged"
          invoice.reference = reply.reference
          Store.save(invoice)
          return ChargeOutcome(invoice_id = invoice.id, status = "charged", reference = reply.reference)
        }
      } catch {
        case _: StatusRuntimeException => ()
      }
      attempt += 1
    }
    ChargeOutcome(invoice_id = invoice.id, status = "pending")
  }
}
`,
      solution: `import io.grpc.ManagedChannelBuilder

import java.util.concurrent.TimeUnit

object ProcessorClient {
  val ProcessorDeadlineS = 5L
  val MaxAttempts = 3
  val TerminalDeclines = Set("HARD_DECLINE", "CARD_DECLINED", "INSUFFICIENT_FUNDS")
  val Retryable = Set(io.grpc.Status.Code.DEADLINE_EXCEEDED, io.grpc.Status.Code.UNAVAILABLE)

  /** Every call goes through this stub, so the 5 s deadline is not something a caller can forget. */
  val stub = ProcessorGrpc
    .blockingStub(ManagedChannelBuilder.forAddress("processor", 9000).usePlaintext().build())
    .withDeadlineAfter(ProcessorDeadlineS, TimeUnit.SECONDS)

  /** The \`invoices\` row this run updates; Store stands in for the billing db. */
  class Invoice(val id: String, val subscriptionId: String, val amountCents: Long) {
    var status: String = "pending"
    var reason: String = ""
    var reference: String = ""
  }

  case class ChargeOutcome(invoice_id: String, status: String, reference: String = "", reason: String = "")

  object Store {
    private val rows = scala.collection.mutable.Map.empty[String, Invoice]

    def save(invoice: Invoice): Unit = rows(invoice.id) = invoice

    def fail(invoice: Invoice, declineCode: String): ChargeOutcome = {
      invoice.status = "failed"
      invoice.reason = declineCode
      save(invoice)
      ChargeOutcome(invoice_id = invoice.id, status = "failed", reason = declineCode)
    }
  }

  /** Charge once per invoice: every attempt sends the same invoice-scoped key. */
  def chargeInvoice(invoice: Invoice): ChargeOutcome = {
    var lastError: Option[io.grpc.StatusRuntimeException] = None
    for (attempt <- 0 until MaxAttempts) {
      try {
        val reply = stub.charge(
          ChargeRequest(
            invoice_id = invoice.id,
            subscription_id = invoice.subscriptionId,
            amount_cents = invoice.amountCents,
            idempotency_key = invoice.id
          )
        )
        if (TerminalDeclines.contains(reply.decline_code)) {
          // A hard decline is the issuer's answer: one attempt, then the invoice is failed.
          return Store.fail(invoice, reply.decline_code)
        }
        if (reply.decline_code.nonEmpty) throw new RuntimeException("soft decline: " + reply.decline_code)
        return confirm(invoice, reply.reference)
      } catch {
        case exc: io.grpc.StatusRuntimeException =>
          lastError = Some(exc)
          if (exc.getStatus.getCode == io.grpc.Status.Code.DEADLINE_EXCEEDED) {
            // A timeout is an unknown outcome: read the processor's state before charging again.
            val reference = reconcile(invoice.id)
            if (reference.nonEmpty) return confirm(invoice, reference)
          }
          if (!Retryable.contains(exc.getStatus.getCode)) throw exc
      }
    }
    throw lastError.getOrElse(new RuntimeException("charge attempts exhausted"))
  }

  def reconcile(invoiceId: String): String = {
    val state = stub.getInvoice(GetInvoiceRequest(invoice_id = invoiceId))
    state.reference
  }

  def confirm(invoice: Invoice, reference: String): ChargeOutcome = {
    invoice.status = "charged"
    invoice.reference = reference
    Store.save(invoice)
    ChargeOutcome(invoice_id = invoice.id, status = "charged", reference = reference)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "billing.grpc.pb.h"

#include <map>
#include <random>
#include <string>

constexpr int kDeclineRetries = 3;

/** The \`invoices\` row this run updates; the store stands in for the billing db. */
class InvoiceStore {
 public:
  void save(const Invoice& invoice) { rows_[invoice.id()] = invoice; }

 private:
  std::map<std::string, Invoice> rows_;
};

InvoiceStore store;

// Stand-in for the uuid library: the draft mints a fresh key for every attempt.
std::string new_uuid() {
  static std::mt19937_64 rng{std::random_device{}()};
  return std::to_string(std::uniform_int_distribution<unsigned long long>{}(rng));
}

ChargeOutcome outcome_for(const Invoice& invoice, const std::string& status) {
  ChargeOutcome outcome;
  outcome.set_invoice_id(invoice.id());
  outcome.set_status(status);
  return outcome;
}

// TODO: a model-generated draft. It retries kDeclineRetries times over every error, mints a fresh
// uuid inside the loop as the idempotency key, sets no deadline, never reconciles a timeout with
// GetInvoice, retries a hard decline at the customer's issuer and reports "pending" with no reason.
ChargeOutcome ChargeInvoice(Processor::Stub* stub, const Invoice& invoice) {
  for (int attempt = 0; attempt < kDeclineRetries; attempt++) {
    ChargeRequest request;
    request.set_invoice_id(invoice.id());
    request.set_subscription_id(invoice.subscription_id());
    request.set_amount_cents(invoice.amount_cents());
    request.set_idempotency_key(new_uuid());
    grpc::ClientContext ctx;
    ChargeReply reply;
    if (!stub->Charge(&ctx, request, &reply).ok()) continue;
    if (!reply.decline_code().empty()) continue;
    store.save(invoice);
    return outcome_for(invoice, "charged");
  }
  return outcome_for(invoice, "pending");
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "billing.grpc.pb.h"

#include <algorithm>
#include <chrono>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

constexpr int kProcessorDeadlineS = 5;
constexpr int kMaxAttempts = 3;
const std::vector<std::string> kTerminalDeclines = {"HARD_DECLINE", "CARD_DECLINED", "INSUFFICIENT_FUNDS"};

/** The \`invoices\` row this run updates; the store stands in for the billing db. */
class InvoiceStore {
 public:
  void save(const Invoice& invoice) { rows_[invoice.id()] = invoice; }

  ChargeOutcome fail(const Invoice& invoice, const std::string& decline_code) {
    Invoice row = invoice;
    row.set_status("failed");
    row.set_reason(decline_code);
    save(row);
    ChargeOutcome outcome;
    outcome.set_invoice_id(invoice.id());
    outcome.set_status("failed");
    outcome.set_reason(decline_code);
    return outcome;
  }

 private:
  std::map<std::string, Invoice> rows_;
};

InvoiceStore store;

ChargeOutcome outcome_for(const Invoice& invoice, const std::string& status, const std::string& reference) {
  ChargeOutcome outcome;
  outcome.set_invoice_id(invoice.id());
  outcome.set_status(status);
  outcome.set_reference(reference);
  return outcome;
}

/** Reads the processor's own state for the invoice: non-empty only when the charge landed. */
std::string Reconcile(Processor::Stub* stub, const std::string& invoice_id);

ChargeOutcome ChargeInvoice(Processor::Stub* stub, const Invoice& invoice) {
  std::string last_error;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    ChargeRequest request;
    request.set_invoice_id(invoice.id());
    request.set_subscription_id(invoice.subscription_id());
    request.set_amount_cents(invoice.amount_cents());
    request.set_idempotency_key(invoice.id());
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kProcessorDeadlineS));
    ChargeReply reply;
    const grpc::Status status = stub->Charge(&ctx, request, &reply);
    if (!status.ok()) {
      last_error = status.error_message();
      if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
        // A timeout is an unknown outcome: ask the processor before charging again.
        const std::string reference = Reconcile(stub, invoice.id());
        if (!reference.empty()) return outcome_for(invoice, "charged", reference);
      }
      if (status.error_code() != grpc::StatusCode::UNAVAILABLE &&
          status.error_code() != grpc::StatusCode::DEADLINE_EXCEEDED)
        throw std::runtime_error("charge failed: " + status.error_message());
      continue;
    }
    const std::string decline_code = reply.decline_code();
    if (!decline_code.empty()) {
      const bool terminal = std::find(kTerminalDeclines.begin(), kTerminalDeclines.end(), decline_code) !=
                            kTerminalDeclines.end();
      // A hard decline is the issuer's answer: one attempt, then the invoice is failed.
      if (terminal) return store.fail(invoice, decline_code);
      throw std::runtime_error("soft decline: " + decline_code);
    }
    return outcome_for(invoice, "charged", reply.reference());
  }
  throw std::runtime_error("charge attempts exhausted: " + last_error);
}

std::string Reconcile(Processor::Stub* stub, const std::string& invoice_id) {
  GetInvoiceRequest request;
  request.set_invoice_id(invoice_id);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kProcessorDeadlineS));
  InvoiceState state;
  if (!stub->GetInvoice(&ctx, request, &state).ok()) return "";
  return state.reference();
}
`,
    },
  },
  hints: [
    'The deadline and the key are the two things a generated client always forgets. The deadline is an argument on the call itself (`timeout=`, `deadline: Date.now() + …`, `WithTimeout`, `withDeadlineAfter`, `set_deadline`) and the key has to be derived from the invoice (`invoice.id`), never minted — a generated key is a new charge to the processor on every attempt.',
    'A timeout is an unknown outcome, not a failure: the processor may have charged and lost the reply. Read its state with `GetInvoice` for the same invoice id first, adopt the reference it reports when the charge already landed, and only then decide whether another attempt is allowed — with the same key, so the processor can collapse it.',
    'A decline is a business answer, not a transient error. `HARD_DECLINE`, `CARD_DECLINED` and `INSUFFICIENT_FUNDS` stop after the first attempt and mark the invoice `failed` with the code as its `reason`; only the deadline and an unavailable processor are worth another attempt, and `MAX_ATTEMPTS` bounds even those.',
  ],
  debrief: `All five checks are one question: what does this call know when it comes back empty-handed? A retry assumes the first attempt did nothing; a deadline means it may have done everything, which is why reconciliation beats retrying — \`GetInvoice\` for the same invoice id tells the client whether a charge exists and lets it adopt that reference instead of creating a second one. That is also why the invoice id, not a generated uuid, is the idempotency unit: a key only protects a customer if it survives the retry, the process restart and the reconciler that runs hours later, and the invoice is the only identifier stable across all three. A key minted per attempt does not make the retry safe, it makes it a new charge. Real processors add the rest of the picture: webhooks for the charges whose reply was lost, pending/authorized states a run must not treat as settled, settlement and payout files that reconcile the ledger days later, per-issuer retry windows that make a decline and a busy processor different answers, and a dunning workflow for soft declines — none of which belongs inside the client, and all of which start from the invoice-scoped key and the reconciliation read.`,
};
