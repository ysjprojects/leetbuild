import type {Step} from '@/lib/types';

export const invoiceDependencyStep: Step = {
  id: 'dependency',
  title: 'Tax calls that hold the invoice when unsure',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies'],
  file: 'client',
  focus: ['api', 'tax', 'redis'],
  task: `## Task

**Starting point.** The starter is the tax leg of finalization: \`finalize_with_tax(tenant,
invoice_id)\` calls the tax service's \`Quote\` over gRPC with no deadline, up to
\`TAX_MAX_ATTEMPTS = 5\` times, sleeping a second between attempts and retrying every status in
\`RETRYABLE\` (which lists \`FAILED_PRECONDITION\`); then it records the tax (\`store.set_tax\`, zero
with source \`quote\` when no answer came) and claims the number (\`sequence.claim_number\`). It
defines \`JurisdictionRejected\` but never raises it. With the tax service healthy it finalizes, and
it hides four flaws.

**Failure mode the checks target.** A stuck tax service holds the finalize open; an outage is
retried five times and then issues invoices with zero tax; and a jurisdiction that refuses the
document is asked five times and invoiced anyway.

\`\`\`proto
service Tax { rpc Quote(QuoteRequest) returns (TaxQuote); }  // FAILED_PRECONDITION: the jurisdiction refuses
\`\`\`

- Every \`Quote\` carries a \`TAX_DEADLINE_S\` = 2 s deadline of its own: a retry does not inherit
  what is left of the first attempt's.
- At most \`TAX_MAX_ATTEMPTS\` = 3 attempts; only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are
  retried, after a short backoff.
- \`FAILED_PRECONDITION\` raises \`JurisdictionRejected\` naming the invoice's \`jurisdiction\`, after
  one call.
- No quote, no number: \`store.hold(invoice_id, reason, attempts)\` (the last status in lower case)
  and return \`{status: "held", reason, attempts}\`. With a quote: \`store.set_tax\`, then
  \`claim_number\`, and return \`{status: "finalized", number, tax_cents, tax_source}\`.`,
  sequence: {
    participants: ['Finalize path', 'Tax service', 'Redis'],
    messages: [
      {from: 'Finalize path', to: 'Tax service', label: 'Quote · deadline 2 s · attempt ≤ 3', kind: 'sync'},
      {
        from: 'Tax service',
        to: 'Finalize path',
        label: 'UNAVAILABLE / DEADLINE_EXCEEDED → back off, retry',
        kind: 'reply',
      },
      {
        from: 'Finalize path',
        to: 'Redis',
        label: 'out of attempts: hold(reason, attempts) · stays draft',
        kind: 'sync',
      },
      {
        from: 'Tax service',
        to: 'Finalize path',
        label: 'FAILED_PRECONDITION → JurisdictionRejected, no retry',
        kind: 'reply',
      },
      {from: 'Tax service', to: 'Finalize path', label: 'TaxQuote {tax_cents, tax_source}', kind: 'reply'},
      {from: 'Finalize path', to: 'Redis', label: 'set_tax · claim_number → finalized', kind: 'sync'},
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every quote carries a 2-second deadline',
      detail:
        'Each `Quote`, every retry included, is made with a full `TAX_DEADLINE_S` (2 s) as its deadline (a call `timeout`, `deadline`, `context.WithTimeout`, `set_deadline`); without one, a stuck tax service holds the finalize open.',
      match: {
        python: {all: [/TAX_DEADLINE_S\s*=\s*2\b/, /\.Quote\([^)]*timeout\s*=\s*TAX_DEADLINE_S/]},
        typescript: {all: [/TAX_DEADLINE_MS\s*=\s*2000\b/, /deadline:\s*Date\.now\(\)\s*\+\s*TAX_DEADLINE_MS/]},
        go: {all: [/taxDeadline\s*=\s*2\s*\*\s*time\.Second/, /context\.WithTimeout\([^)]*taxDeadline/]},
        cpp: {all: [/kTaxDeadline\{2\}/, /set_deadline\([^;]*kTaxDeadline/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'At most three attempts, on the transient statuses only',
      detail:
        'Attempts are bounded by `TAX_MAX_ATTEMPTS` = 3 and only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried, the latter whether the deadline ran out or the service answered it; any other status ends the attempts at once.',
      match: {
        python: {all: [/TAX_MAX_ATTEMPTS\s*=\s*3\b/, /range\(TAX_MAX_ATTEMPTS\)/]},
        typescript: {all: [/TAX_MAX_ATTEMPTS\s*=\s*3\b/, /<\s*TAX_MAX_ATTEMPTS/]},
        go: {all: [/taxMaxAttempts\s*=\s*3\b/, /<\s*taxMaxAttempts/]},
        cpp: {all: [/kTaxMaxAttempts\s*=\s*3\b/, /<\s*kTaxMaxAttempts/]},
      },
    },
    {
      id: 'terminal-jurisdiction',
      title: 'A jurisdiction refusal is terminal and named',
      detail:
        "`FAILED_PRECONDITION` is the jurisdiction refusing the document: it is not in the retryable set, and it raises `JurisdictionRejected` with the invoice's `jurisdiction` after one call, leaving the draft without a number.",
      match: {
        python: {
          all: [/StatusCode\.FAILED_PRECONDITION/, /raise JurisdictionRejected\(/],
          none: [/RETRYABLE\s*=\s*\{[^}]*FAILED_PRECONDITION/],
        },
        typescript: {
          all: [/grpc\.status\.FAILED_PRECONDITION/, /throw new JurisdictionRejected\(/],
          none: [/RETRYABLE[^;]*FAILED_PRECONDITION/],
        },
        go: {
          all: [/codes\.FailedPrecondition/, /&JurisdictionRejected\{/],
          none: [/retryable\s*=[^}]*FailedPrecondition/],
        },
        cpp: {
          all: [/StatusCode::FAILED_PRECONDITION/, /throw JurisdictionRejected\(/],
          none: [/kRetryable[^;]*FAILED_PRECONDITION/],
        },
      },
    },
    {
      id: 'hold-marker',
      title: 'An unanswered quote holds the draft',
      detail:
        'When no quote arrives, the invoice stays a draft: `hold` records the reason (the last status, in lower case) and the attempts and the outcome is `held`; the starter records zero tax with source `quote` and claims a number, issuing a document nobody reconciles.',
      match: {
        python: {all: [/store\.hold\(/, /["']held["']/]},
        typescript: {all: [/\bhold\(/, /'held'/]},
        go: {all: [/store\.Hold\(/, /"held"/]},
        cpp: {all: [/store::hold\(/, /"held"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import invoice_service_pb2
import invoice_service_pb2_grpc
from invoice import sequence, store  # store.get, set_tax, hold; sequence.claim_number

TAX_MAX_ATTEMPTS = 5
RETRYABLE = {
    grpc.StatusCode.UNAVAILABLE,
    grpc.StatusCode.DEADLINE_EXCEEDED,
    grpc.StatusCode.FAILED_PRECONDITION,
    grpc.StatusCode.INVALID_ARGUMENT,
}

tax = invoice_service_pb2_grpc.TaxStub(grpc.insecure_channel("tax:9000"))


class JurisdictionRejected(Exception):
    """The customer's jurisdiction refuses this document: terminal, the invoice stays a draft."""

    def __init__(self, jurisdiction: str, detail: str) -> None:
        super().__init__(f"jurisdiction {jurisdiction} refused the invoice: {detail}")
        self.jurisdiction = jurisdiction


def finalize_with_tax(tenant: str, invoice_id: str) -> dict:
    """Quote the tax, then finalize the draft."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    invoice = store.get(invoice_id)
    request = invoice_service_pb2.QuoteRequest(
        invoice_id=invoice_id,
        tenant_id=tenant,
        currency=invoice["currency"],
        jurisdiction=invoice["jurisdiction"],
        subtotal_cents=invoice["subtotal_cents"],
    )
    tax_cents, tax_source = 0, "quote"
    for _ in range(TAX_MAX_ATTEMPTS):
        try:
            quote = tax.Quote(request)
            tax_cents, tax_source = quote.tax_cents, quote.tax_source
            break
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE:
                break
            time.sleep(1)  # the tax service is flaky: try again
    store.set_tax(invoice_id, tax_cents, tax_source)
    number = sequence.claim_number(tenant, invoice_id)
    return {"status": "finalized", "number": number, "tax_cents": tax_cents, "tax_source": tax_source}
`,
      solution: `import time

import grpc

import invoice_service_pb2
import invoice_service_pb2_grpc
from invoice import sequence, store  # store.get, set_tax, hold; sequence.claim_number

TAX_DEADLINE_S = 2
TAX_MAX_ATTEMPTS = 3
TAX_BACKOFF_S = 0.2
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

tax = invoice_service_pb2_grpc.TaxStub(grpc.insecure_channel("tax:9000"))


class JurisdictionRejected(Exception):
    """The customer's jurisdiction refuses this document: terminal, the invoice stays a draft."""

    def __init__(self, jurisdiction: str, detail: str) -> None:
        super().__init__(f"jurisdiction {jurisdiction} refused the invoice: {detail}")
        self.jurisdiction = jurisdiction


def finalize_with_tax(tenant: str, invoice_id: str) -> dict:
    """Quote the tax, then finalize the draft."""
    invoice = store.get(invoice_id)
    request = invoice_service_pb2.QuoteRequest(
        invoice_id=invoice_id,
        tenant_id=tenant,
        currency=invoice["currency"],
        jurisdiction=invoice["jurisdiction"],
        subtotal_cents=invoice["subtotal_cents"],
    )
    quote, reason, attempts = None, "", 0
    for attempt in range(TAX_MAX_ATTEMPTS):
        attempts += 1
        try:
            quote = tax.Quote(request, timeout=TAX_DEADLINE_S)
            break
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.FAILED_PRECONDITION:
                raise JurisdictionRejected(invoice["jurisdiction"], exc.details()) from exc
            reason = exc.code().name.lower()
            if exc.code() not in RETRYABLE or attempts == TAX_MAX_ATTEMPTS:
                break
            time.sleep(TAX_BACKOFF_S * 2**attempt)
    if quote is None:
        # No answer is not "no tax": the invoice stays a draft until a quote arrives.
        store.hold(invoice_id, reason, attempts)
        return {"status": "held", "reason": reason, "attempts": attempts}
    store.set_tax(invoice_id, quote.tax_cents, quote.tax_source)
    number = sequence.claim_number(tenant, invoice_id)
    return {"status": "finalized", "number": number, "tax_cents": quote.tax_cents, "tax_source": quote.tax_source}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {claimNumber} from 'invoice/sequence';
import {get, hold, setTax} from 'invoice/store';

export const TAX_MAX_ATTEMPTS = 5;
export const RETRYABLE = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED, grpc.status.FAILED_PRECONDITION, grpc.status.INVALID_ARGUMENT];

interface QuoteRequest {
  invoice_id: string;
  tenant_id: string;
  currency: string;
  jurisdiction: string;
  subtotal_cents: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('invoice_service.proto')) as unknown as {
  invoicetax: {Tax: grpc.ServiceClientConstructor};
};
const tax = new pkg.invoicetax.Tax('tax:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Quote(request: QuoteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{tax_cents: number; tax_source: string}>;
};

/** The customer's jurisdiction refuses this document: terminal, the invoice stays a draft. */
export class JurisdictionRejected extends Error {
  constructor(
    readonly jurisdiction: string,
    detail: string,
  ) {
    super(\`jurisdiction \${jurisdiction} refused the invoice: \${detail}\`);
  }
}

export interface Outcome {
  status: string;
  number?: number | null;
  tax_cents?: number;
  tax_source?: string;
  reason?: string;
  attempts?: number;
}

/** Quote the tax, then finalize the draft. */
export async function finalizeWithTax(tenant: string, invoiceId: string): Promise<Outcome> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const invoice = await get(invoiceId);
  if (invoice === null) throw new Error(\`no invoice \${invoiceId}\`);
  const {currency, jurisdiction, subtotal_cents} = invoice;
  const request = {invoice_id: invoiceId, tenant_id: tenant, currency, jurisdiction, subtotal_cents};
  let taxCents = 0;
  let taxSource = 'quote';
  for (let attempt = 0; attempt < TAX_MAX_ATTEMPTS; attempt++) {
    try {
      const quote = await tax.Quote(request, new grpc.Metadata(), {});
      taxCents = Number(quote.tax_cents);
      taxSource = quote.tax_source;
      break;
    } catch (e) {
      if (!RETRYABLE.includes((e as grpc.ServiceError).code)) break;
      await new Promise(resolve => setTimeout(resolve, 1000)); // the tax service is flaky: try again
    }
  }
  await setTax(invoiceId, taxCents, taxSource);
  const number = await claimNumber(tenant, invoiceId);
  return {status: 'finalized', number, tax_cents: taxCents, tax_source: taxSource};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {claimNumber} from 'invoice/sequence';
import {get, hold, setTax} from 'invoice/store';

export const TAX_DEADLINE_MS = 2000;
export const TAX_MAX_ATTEMPTS = 3;
export const TAX_BACKOFF_MS = 200;
export const RETRYABLE = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

interface QuoteRequest {
  invoice_id: string;
  tenant_id: string;
  currency: string;
  jurisdiction: string;
  subtotal_cents: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('invoice_service.proto')) as unknown as {
  invoicetax: {Tax: grpc.ServiceClientConstructor};
};
const tax = new pkg.invoicetax.Tax('tax:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Quote(request: QuoteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<{tax_cents: number; tax_source: string}>;
};

/** The customer's jurisdiction refuses this document: terminal, the invoice stays a draft. */
export class JurisdictionRejected extends Error {
  constructor(
    readonly jurisdiction: string,
    detail: string,
  ) {
    super(\`jurisdiction \${jurisdiction} refused the invoice: \${detail}\`);
  }
}

export interface Outcome {
  status: string;
  number?: number | null;
  tax_cents?: number;
  tax_source?: string;
  reason?: string;
  attempts?: number;
}

/** Quote the tax, then finalize the draft. */
export async function finalizeWithTax(tenant: string, invoiceId: string): Promise<Outcome> {
  const invoice = await get(invoiceId);
  if (invoice === null) throw new Error(\`no invoice \${invoiceId}\`);
  const {currency, jurisdiction, subtotal_cents} = invoice;
  const request = {invoice_id: invoiceId, tenant_id: tenant, currency, jurisdiction, subtotal_cents};
  let quote: {tax_cents: number; tax_source: string} | null = null;
  let reason = '';
  let attempts = 0;
  while (quote === null && attempts < TAX_MAX_ATTEMPTS) {
    attempts++;
    try {
      quote = await tax.Quote(request, new grpc.Metadata(), {deadline: Date.now() + TAX_DEADLINE_MS});
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      if (code === grpc.status.FAILED_PRECONDITION) throw new JurisdictionRejected(jurisdiction, details);
      reason = grpc.status[code].toLowerCase();
      if (!RETRYABLE.includes(code) || attempts === TAX_MAX_ATTEMPTS) break;
      await new Promise(resolve => setTimeout(resolve, TAX_BACKOFF_MS * 2 ** (attempts - 1)));
    }
  }
  if (quote === null) {
    // No answer is not "no tax": the invoice stays a draft until a quote arrives.
    await hold(invoiceId, reason, attempts);
    return {status: 'held', reason, attempts};
  }
  const taxCents = Number(quote.tax_cents);
  await setTax(invoiceId, taxCents, quote.tax_source);
  const number = await claimNumber(tenant, invoiceId);
  return {status: 'finalized', number, tax_cents: taxCents, tax_source: quote.tax_source};
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
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "invoice/gen/invoice_service"
	"invoice/sequence" // sequence.ClaimNumber
	"invoice/store"    // store.Get, SetTax, Hold
)

const taxMaxAttempts = 5

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true, codes.FailedPrecondition: true, codes.InvalidArgument: true}

var (
	taxConn, _ = grpc.NewClient("tax:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	tax        = pb.NewTaxClient(taxConn)
)

// JurisdictionRejected: the customer's jurisdiction refuses this document; terminal, the invoice
// stays a draft.
type JurisdictionRejected struct {
	Jurisdiction string
	Detail       string
}

func (e *JurisdictionRejected) Error() string {
	return fmt.Sprintf("jurisdiction %s refused the invoice: %s", e.Jurisdiction, e.Detail)
}

// Outcome is what a finalize came to: "finalized" with its number and tax, or "held" with why.
type Outcome struct {
	Status    string \`json:"status"\`
	Number    int64  \`json:"number,omitempty"\`
	TaxCents  int64  \`json:"tax_cents,omitempty"\`
	TaxSource string \`json:"tax_source,omitempty"\`
	Reason    string \`json:"reason,omitempty"\`
	Attempts  int    \`json:"attempts,omitempty"\`
}

// finalizeWithTax quotes the tax, then finalizes the draft.
func finalizeWithTax(ctx context.Context, tenant, invoiceID string) (Outcome, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	invoice := store.Get(ctx, invoiceID)
	if invoice == nil {
		return Outcome{}, fmt.Errorf("no invoice %s", invoiceID)
	}
	request := &pb.QuoteRequest{InvoiceId: invoiceID, TenantId: tenant, Currency: invoice.Currency, Jurisdiction: invoice.Jurisdiction, SubtotalCents: invoice.SubtotalCents}
	taxCents, taxSource := int64(0), "quote"
	for attempt := 0; attempt < taxMaxAttempts; attempt++ {
		quote, err := tax.Quote(ctx, request)
		if err == nil {
			taxCents, taxSource = quote.GetTaxCents(), quote.GetTaxSource()
			break
		}
		if !retryable[status.Code(err)] {
			break
		}
		time.Sleep(time.Second) // the tax service is flaky: try again
	}
	store.SetTax(ctx, invoiceID, taxCents, taxSource)
	number, err := sequence.ClaimNumber(ctx, tenant, invoiceID)
	return Outcome{Status: "finalized", Number: number, TaxCents: taxCents, TaxSource: taxSource}, err
}
`,
      solution: `package main

import (
	"context"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "invoice/gen/invoice_service"
	"invoice/sequence" // sequence.ClaimNumber
	"invoice/store"    // store.Get, SetTax, Hold
)

const (
	taxDeadline    = 2 * time.Second
	taxMaxAttempts = 3
	taxBackoff     = 200 * time.Millisecond
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

var (
	taxConn, _ = grpc.NewClient("tax:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	tax        = pb.NewTaxClient(taxConn)
)

// JurisdictionRejected: the customer's jurisdiction refuses this document; terminal, the invoice
// stays a draft.
type JurisdictionRejected struct {
	Jurisdiction string
	Detail       string
}

func (e *JurisdictionRejected) Error() string {
	return fmt.Sprintf("jurisdiction %s refused the invoice: %s", e.Jurisdiction, e.Detail)
}

// Outcome is what a finalize came to: "finalized" with its number and tax, or "held" with why.
type Outcome struct {
	Status    string \`json:"status"\`
	Number    int64  \`json:"number,omitempty"\`
	TaxCents  int64  \`json:"tax_cents,omitempty"\`
	TaxSource string \`json:"tax_source,omitempty"\`
	Reason    string \`json:"reason,omitempty"\`
	Attempts  int    \`json:"attempts,omitempty"\`
}

// statusNames names every gRPC status code in lower snake case, indexed by its number.
var statusNames = [...]string{"ok", "cancelled", "unknown", "invalid_argument", "deadline_exceeded", "not_found", "already_exists", "permission_denied", "resource_exhausted", "failed_precondition", "aborted", "out_of_range", "unimplemented", "internal", "unavailable", "data_loss", "unauthenticated"}

// reasonOf is a status as the hold records it: "unavailable", "deadline_exceeded", "permission_denied".
func reasonOf(code codes.Code) string {
	if int(code) < len(statusNames) {
		return statusNames[code]
	}
	return "unknown"
}

// finalizeWithTax quotes the tax, then finalizes the draft.
func finalizeWithTax(ctx context.Context, tenant, invoiceID string) (Outcome, error) {
	invoice := store.Get(ctx, invoiceID)
	if invoice == nil {
		return Outcome{}, fmt.Errorf("no invoice %s", invoiceID)
	}
	request := &pb.QuoteRequest{InvoiceId: invoiceID, TenantId: tenant, Currency: invoice.Currency, Jurisdiction: invoice.Jurisdiction, SubtotalCents: invoice.SubtotalCents}
	var quote *pb.TaxQuote
	reason, attempts := "", 0
	for attempts < taxMaxAttempts {
		attempts++
		callCtx, cancel := context.WithTimeout(ctx, taxDeadline)
		answer, err := tax.Quote(callCtx, request)
		cancel()
		if err == nil {
			quote = answer
			break
		}
		code := status.Code(err)
		if code == codes.FailedPrecondition {
			return Outcome{}, &JurisdictionRejected{Jurisdiction: invoice.Jurisdiction, Detail: status.Convert(err).Message()}
		}
		reason = reasonOf(code)
		if !retryable[code] || attempts == taxMaxAttempts {
			break
		}
		time.Sleep(taxBackoff << (attempts - 1))
	}
	if quote == nil {
		// No answer is not "no tax": the invoice stays a draft until a quote arrives.
		store.Hold(ctx, invoiceID, reason, attempts)
		return Outcome{Status: "held", Reason: reason, Attempts: attempts}, nil
	}
	store.SetTax(ctx, invoiceID, quote.GetTaxCents(), quote.GetTaxSource())
	number, err := sequence.ClaimNumber(ctx, tenant, invoiceID)
	return Outcome{Status: "finalized", Number: number, TaxCents: quote.GetTaxCents(), TaxSource: quote.GetTaxSource()}, err
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>

#include "invoice/sequence.h"  // sequence::claimNumber
#include "invoice/store.h"     // store::get, setTax, hold
#include "invoice_service.grpc.pb.h"

constexpr int kTaxMaxAttempts = 5;
const std::set<grpc::StatusCode> kRetryable = {grpc::StatusCode::UNAVAILABLE, grpc::StatusCode::DEADLINE_EXCEEDED, grpc::StatusCode::FAILED_PRECONDITION,
                                               grpc::StatusCode::INVALID_ARGUMENT};

auto tax = invoicetax::Tax::NewStub(grpc::CreateChannel("tax:9000", grpc::InsecureChannelCredentials()));

// The customer's jurisdiction refuses this document: terminal, the invoice stays a draft.
struct JurisdictionRejected : std::runtime_error {
  JurisdictionRejected(const std::string& j, const std::string& detail)
      : std::runtime_error("jurisdiction " + j + " refused the invoice: " + detail), jurisdiction(j) {}
  std::string jurisdiction;
};

// What a finalize came to: "finalized" with its number and tax, or "held" with why.
struct Outcome {
  std::string status;
  long number = 0;
  long tax_cents = 0;
  std::string tax_source;
  std::string reason;
  int attempts = 0;
};

// Quote the tax, then finalize the draft.
Outcome finalizeWithTax(const std::string& tenant, const std::string& invoice_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const auto invoice = store::get(invoice_id);
  if (!invoice) throw std::out_of_range("no invoice " + invoice_id);
  invoicetax::QuoteRequest request;
  request.set_invoice_id(invoice_id);
  request.set_tenant_id(tenant);
  request.set_currency(invoice->currency);
  request.set_jurisdiction(invoice->jurisdiction);
  request.set_subtotal_cents(invoice->subtotal_cents);
  long tax_cents = 0;
  std::string tax_source = "quote";
  for (int attempt = 0; attempt < kTaxMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    invoicetax::TaxQuote quote;
    const grpc::Status status = tax->Quote(&ctx, request, &quote);
    if (status.ok()) {
      tax_cents = quote.tax_cents();
      tax_source = quote.tax_source();
      break;
    }
    if (!kRetryable.count(status.error_code())) break;
    std::this_thread::sleep_for(std::chrono::seconds{1});  // the tax service is flaky: try again
  }
  store::setTax(invoice_id, tax_cents, tax_source);
  return Outcome{"finalized", sequence::claimNumber(tenant, invoice_id), tax_cents, tax_source, "", 0};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>

#include "invoice/sequence.h"  // sequence::claimNumber
#include "invoice/store.h"     // store::get, setTax, hold
#include "invoice_service.grpc.pb.h"

constexpr std::chrono::seconds kTaxDeadline{2};
constexpr int kTaxMaxAttempts = 3;
constexpr std::chrono::milliseconds kTaxBackoff{200};
const std::set<grpc::StatusCode> kRetryable = {grpc::StatusCode::UNAVAILABLE, grpc::StatusCode::DEADLINE_EXCEEDED};

auto tax = invoicetax::Tax::NewStub(grpc::CreateChannel("tax:9000", grpc::InsecureChannelCredentials()));

// The customer's jurisdiction refuses this document: terminal, the invoice stays a draft.
struct JurisdictionRejected : std::runtime_error {
  JurisdictionRejected(const std::string& j, const std::string& detail)
      : std::runtime_error("jurisdiction " + j + " refused the invoice: " + detail), jurisdiction(j) {}
  std::string jurisdiction;
};

// What a finalize came to: "finalized" with its number and tax, or "held" with why.
struct Outcome {
  std::string status;
  long number = 0;
  long tax_cents = 0;
  std::string tax_source;
  std::string reason;
  int attempts = 0;
};

// A status as the hold records it: "unavailable", "deadline_exceeded", "permission_denied".
std::string reasonOf(grpc::StatusCode code) {
  static const char* const kNames[] = {"ok", "cancelled", "unknown", "invalid_argument", "deadline_exceeded", "not_found",
                                       "already_exists", "permission_denied", "resource_exhausted", "failed_precondition", "aborted",
                                       "out_of_range", "unimplemented", "internal", "unavailable", "data_loss", "unauthenticated"};
  const int n = static_cast<int>(code);
  return n >= 0 && n < 17 ? kNames[n] : "unknown";
}

// Quote the tax, then finalize the draft.
Outcome finalizeWithTax(const std::string& tenant, const std::string& invoice_id) {
  const auto invoice = store::get(invoice_id);
  if (!invoice) throw std::out_of_range("no invoice " + invoice_id);
  invoicetax::QuoteRequest request;
  request.set_invoice_id(invoice_id);
  request.set_tenant_id(tenant);
  request.set_currency(invoice->currency);
  request.set_jurisdiction(invoice->jurisdiction);
  request.set_subtotal_cents(invoice->subtotal_cents);
  std::optional<invoicetax::TaxQuote> quote;
  std::string reason;
  int attempts = 0;
  while (attempts < kTaxMaxAttempts) {
    attempts++;
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kTaxDeadline);
    invoicetax::TaxQuote answer;
    const grpc::Status status = tax->Quote(&ctx, request, &answer);
    if (status.ok()) {
      quote = answer;
      break;
    }
    if (status.error_code() == grpc::StatusCode::FAILED_PRECONDITION) throw JurisdictionRejected(invoice->jurisdiction, status.error_message());
    reason = reasonOf(status.error_code());
    if (!kRetryable.count(status.error_code()) || attempts == kTaxMaxAttempts) break;
    std::this_thread::sleep_for(kTaxBackoff * (1 << (attempts - 1)));
  }
  if (!quote) {
    // No answer is not "no tax": the invoice stays a draft until a quote arrives.
    store::hold(invoice_id, reason, attempts);
    return Outcome{"held", 0, 0, "", reason, attempts};
  }
  store::setTax(invoice_id, quote->tax_cents(), quote->tax_source());
  return Outcome{"finalized", sequence::claimNumber(tenant, invoice_id), static_cast<long>(quote->tax_cents()), quote->tax_source(), "", 0};
}
`,
    },
  },
  harness: {
    python: `import grpc

import invoice_service_pb2
import invoice_service_pb2_grpc
from invoice import store

LINES = [{"description": "Consulting", "quantity": 2, "unit_price_cents": 25000}]


class Tax(invoice_service_pb2_grpc.TaxServicer):
    """19% in DE, exempt in US-OR; jurisdiction XX refuses invoices from this seller."""

    def Quote(self, request, context):
        if request.jurisdiction == "XX":
            context.abort(grpc.StatusCode.FAILED_PRECONDITION, "jurisdiction XX does not accept invoices from this seller")
        if request.jurisdiction == "US-OR":
            return invoice_service_pb2.TaxQuote(tax_cents=0, tax_source="exempt")
        return invoice_service_pb2.TaxQuote(tax_cents=request.subtotal_cents * 19 // 100, tax_source="quote")


def _client(ctx):
    ctx.grpc.serve(invoice_service_pb2_grpc.add_TaxServicer_to_server, Tax())
    return ctx.load("client")


def _draft(jurisdiction="DE"):
    return store.create("t-1", "eur", LINES, "cus-1", jurisdiction)["id"]


def _unclaimed(ctx, invoice_id, why):
    stored = store.get(invoice_id)
    assert stored["status"] == "draft" and stored["number"] is None, f"{why}: the invoice must stay a draft without a number, the store holds {stored['status']} number {stored['number']}"
    assert ctx.redis.get("invoice:seq:t-1") is None, f"{why}: a number was claimed ({ctx.redis.get('invoice:seq:t-1')})"


def check_deadline(ctx):
    m = _client(ctx)
    a = _draft()
    out = m.finalize_with_tax("t-1", a)
    assert out.get("status") == "finalized" and out.get("tax_cents") == 9500 and out.get("number") == 1, f"with the tax service healthy the invoice must finalize as number 1 with 9500 tax, got {out}"
    for call in ctx.grpc.calls_to("Quote"):
        assert call.timeout is not None, "a Quote call carries no deadline: a stuck tax service would hold the finalize open"
        assert 1.5 <= call.timeout <= 2.5, f"a Quote call carries a {call.timeout} s deadline, expected TAX_DEADLINE_S = 2"
    ctx.grpc.set_latency("Quote", 10.0)
    b = _draft()
    out = m.finalize_with_tax("t-1", b)
    assert out.get("status") == "held" and out.get("reason") == "deadline_exceeded", f"with the tax service slower than the deadline finalize_with_tax answered {out}, expected held with reason deadline_exceeded"
    assert store.get(b)["number"] is None, f"an invoice whose quote timed out got number {store.get(b)['number']}"
    for i, call in enumerate(ctx.grpc.calls_to("Quote")[1:], start=1):
        assert call.timeout is not None and 1.5 <= call.timeout <= 2.5, f"attempt {i} at a slow tax service carries a {call.timeout} s deadline: every attempt gets its own TAX_DEADLINE_S = 2, not what is left of the first one's"


def check_bounded_retry(ctx):
    m = _client(ctx)
    ctx.grpc.fail("Quote", grpc.StatusCode.UNAVAILABLE, times=10)
    m.finalize_with_tax("t-1", _draft())
    calls = len(ctx.grpc.calls_to("Quote"))
    assert calls == 3, f"an unavailable tax service was called {calls} times for one finalize, expected TAX_MAX_ATTEMPTS = 3"
    ctx.grpc.failures.clear()
    ctx.grpc.fail("Quote", grpc.StatusCode.DEADLINE_EXCEEDED, times=10)
    m.finalize_with_tax("t-1", _draft())
    again = len(ctx.grpc.calls_to("Quote")) - calls
    assert again == 3, f"a tax service answering DEADLINE_EXCEEDED was called {again} times for one finalize, expected TAX_MAX_ATTEMPTS = 3: it is transient"
    for code in (grpc.StatusCode.INTERNAL, grpc.StatusCode.INVALID_ARGUMENT, grpc.StatusCode.PERMISSION_DENIED, grpc.StatusCode.RESOURCE_EXHAUSTED):
        ctx.grpc.failures.clear()
        before = len(ctx.grpc.calls_to("Quote"))
        ctx.grpc.fail("Quote", code, times=1)
        out = m.finalize_with_tax("t-1", _draft())
        again = len(ctx.grpc.calls_to("Quote")) - before
        assert again == 1, f"an answer of {code.name} was retried ({again} calls): only UNAVAILABLE and DEADLINE_EXCEEDED are transient"
        assert out.get("status") == "held" and out.get("reason") == code.name.lower(), f"an answer of {code.name} gave {out}, expected held with reason {code.name.lower()}"


def check_terminal_jurisdiction(ctx):
    m = _client(ctx)
    a = _draft("XX")
    try:
        out = m.finalize_with_tax("t-1", a)
    except m.JurisdictionRejected as exc:
        assert exc.jurisdiction == "XX", f"JurisdictionRejected names {exc.jurisdiction!r}, expected the invoice's jurisdiction XX"
    except Exception as other:
        raise AssertionError(f"a refusing jurisdiction raised {type(other).__name__}: {other}, expected JurisdictionRejected")
    else:
        raise AssertionError(f"finalize_with_tax answered {out} for an invoice its jurisdiction refuses: raise JurisdictionRejected")
    calls = len(ctx.grpc.calls_to("Quote"))
    assert calls == 1, f"a jurisdiction refusal was asked {calls} times: it is terminal, not retried"
    assert ctx.clock.sleeps == 0, "a jurisdiction refusal must not be slept on and retried"
    _unclaimed(ctx, a, "after a jurisdiction refusal")


def check_hold_marker(ctx):
    m = _client(ctx)
    a = _draft()
    ctx.grpc.fail("Quote", grpc.StatusCode.UNAVAILABLE, times=10)
    out = m.finalize_with_tax("t-1", a)
    calls = len(ctx.grpc.calls_to("Quote"))
    assert out.get("status") == "held", f"with the tax service unavailable finalize_with_tax answered {out}: an unknown tax is not zero tax. Hold the draft"
    assert out.get("reason") == "unavailable" and out.get("attempts") == calls, f"the held outcome must carry reason unavailable and the {calls} attempts made, got {out}"
    _unclaimed(ctx, a, "with no quote")
    stored = store.get(a)
    assert stored["tax_cents"] is None, f"an invoice without a quote recorded {stored['tax_cents']} tax"
    assert stored["tax_hold"] == {"reason": "unavailable", "attempts": calls}, f"the store's tax hold is {stored['tax_hold']}, expected reason unavailable after {calls} attempts"
    ctx.grpc.failures.clear()
    out = m.finalize_with_tax("t-1", a)
    assert out.get("status") == "finalized" and out.get("number") == 1 and out.get("tax_cents") == 9500 and out.get("tax_source") == "quote", f"once the tax service answers the held draft must finalize as number 1 with the quoted 9500, got {out}"
    assert store.get(a)["tax_hold"] is None, "a finalized invoice still carries its tax hold"
    ctx.grpc.failures.clear()
    ctx.grpc.fail("Quote", grpc.StatusCode.DEADLINE_EXCEEDED, times=1)
    ctx.grpc.fail("Quote", grpc.StatusCode.UNAVAILABLE, times=10)
    before = len(ctx.grpc.calls_to("Quote"))
    b = _draft()
    out = m.finalize_with_tax("t-1", b)
    calls = len(ctx.grpc.calls_to("Quote")) - before
    hold = store.get(b)["tax_hold"]
    assert out.get("status") == "held" and out.get("reason") == "unavailable" and out.get("attempts") == calls and hold == {"reason": "unavailable", "attempts": calls}, f"after a DEADLINE_EXCEEDED, then UNAVAILABLE answers, the outcome is {out} and the hold {hold}, expected held with reason unavailable after the {calls} attempts made: the reason is the last status, in lower case"
`,
    typescript: `const LINES = [{description: 'Consulting', quantity: 2, unit_price_cents: 25000}];

/** 19% in DE, exempt in US-OR; jurisdiction XX refuses invoices from this seller. */
function client(ctx) {
  const pkg = ctx.proto('invoice_service.proto');
  ctx.grpc.serve(pkg.invoicetax.Tax.service, {
    Quote(call, callback) {
      const {jurisdiction, subtotal_cents} = call.request;
      if (jurisdiction === 'XX') return callback({code: ctx.grpc.status.FAILED_PRECONDITION, details: 'jurisdiction XX does not accept invoices from this seller'});
      if (jurisdiction === 'US-OR') return callback(null, {tax_cents: 0, tax_source: 'exempt'});
      callback(null, {tax_cents: Math.floor((Number(subtotal_cents) * 19) / 100), tax_source: 'quote'});
    },
  });
  return {m: ctx.load('client'), store: ctx.load('/support/invoice/store.ts')};
}

async function draft(store, jurisdiction = 'DE'): Promise<string> {
  return (await store.create('t-1', 'eur', LINES, 'cus-1', jurisdiction)).id;
}

async function unclaimed(ctx, store, invoiceId: string, why: string): Promise<void> {
  const stored = await store.get(invoiceId);
  assert(stored.status === 'draft' && stored.number === null, \`\${why}: the invoice must stay a draft without a number, the store holds \${stored.status} number \${stored.number}\`);
  assert.equal(ctx.redis.get('invoice:seq:t-1'), null, \`\${why}: a number was claimed (\${ctx.redis.get('invoice:seq:t-1')})\`);
}

export async function check_deadline(ctx) {
  const {m, store} = client(ctx);
  let out = await m.finalizeWithTax('t-1', await draft(store));
  assert(out.status === 'finalized' && out.tax_cents === 9500 && out.number === 1, \`with the tax service healthy the invoice must finalize as number 1 with 9500 tax, got \${JSON.stringify(out)}\`);
  for (const call of ctx.grpc.callsTo('Quote')) {
    assert(call.timeout !== null, 'a Quote call carries no deadline: a stuck tax service would hold the finalize open');
    assert(1.5 <= call.timeout && call.timeout <= 2.5, \`a Quote call carries a \${call.timeout} s deadline, expected TAX_DEADLINE_MS = 2000\`);
  }
  ctx.grpc.setLatency('Quote', 10.0);
  const b = await draft(store);
  out = await m.finalizeWithTax('t-1', b);
  assert(out.status === 'held' && out.reason === 'deadline_exceeded', \`with the tax service slower than the deadline finalizeWithTax answered \${JSON.stringify(out)}, expected held with reason deadline_exceeded\`);
  assert.equal((await store.get(b)).number, null, 'an invoice whose quote timed out got a number');
  ctx.grpc.callsTo('Quote').slice(1).forEach((call, i) => {
    assert(call.timeout !== null && 1.5 <= call.timeout && call.timeout <= 2.5, \`attempt \${i + 1} at a slow tax service carries a \${call.timeout} s deadline: every attempt gets its own TAX_DEADLINE_MS = 2000, not what is left of the first one's\`);
  });
}

export async function check_bounded_retry(ctx) {
  const {m, store} = client(ctx);
  ctx.grpc.fail('Quote', ctx.grpc.status.UNAVAILABLE, '', 10);
  await m.finalizeWithTax('t-1', await draft(store));
  const calls = ctx.grpc.callsTo('Quote').length;
  assert.equal(calls, 3, \`an unavailable tax service was called \${calls} times for one finalize, expected TAX_MAX_ATTEMPTS = 3\`);
  ctx.grpc.clearFailures();
  ctx.grpc.fail('Quote', ctx.grpc.status.DEADLINE_EXCEEDED, '', 10);
  await m.finalizeWithTax('t-1', await draft(store));
  const slow = ctx.grpc.callsTo('Quote').length - calls;
  assert.equal(slow, 3, \`a tax service answering DEADLINE_EXCEEDED was called \${slow} times for one finalize, expected TAX_MAX_ATTEMPTS = 3: it is transient\`);
  for (const code of ['INTERNAL', 'INVALID_ARGUMENT', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED']) {
    ctx.grpc.clearFailures();
    const before = ctx.grpc.callsTo('Quote').length;
    ctx.grpc.fail('Quote', ctx.grpc.status[code], '', 1);
    const out = await m.finalizeWithTax('t-1', await draft(store));
    const again = ctx.grpc.callsTo('Quote').length - before;
    assert.equal(again, 1, \`an answer of \${code} was retried (\${again} calls): only UNAVAILABLE and DEADLINE_EXCEEDED are transient\`);
    assert(out.status === 'held' && out.reason === code.toLowerCase(), \`an answer of \${code} gave \${JSON.stringify(out)}, expected held with reason \${code.toLowerCase()}\`);
  }
}

export async function check_terminal_jurisdiction(ctx) {
  const {m, store} = client(ctx);
  const a = await draft(store, 'XX');
  let out;
  try {
    out = await m.finalizeWithTax('t-1', a);
  } catch (e) {
    assert(e instanceof m.JurisdictionRejected, \`a refusing jurisdiction threw \${(e as Error).constructor.name}: \${(e as Error).message}, expected JurisdictionRejected\`);
    assert.equal(e.jurisdiction, 'XX', \`JurisdictionRejected names \${e.jurisdiction}, expected the invoice's jurisdiction XX\`);
  }
  assert.equal(out, undefined, \`finalizeWithTax answered \${JSON.stringify(out)} for an invoice its jurisdiction refuses: throw JurisdictionRejected\`);
  const calls = ctx.grpc.callsTo('Quote').length;
  assert.equal(calls, 1, \`a jurisdiction refusal was asked \${calls} times: it is terminal, not retried\`);
  assert.equal(ctx.clock.sleeps, 0, 'a jurisdiction refusal must not be slept on and retried');
  await unclaimed(ctx, store, a, 'after a jurisdiction refusal');
}

export async function check_hold_marker(ctx) {
  const {m, store} = client(ctx);
  const a = await draft(store);
  ctx.grpc.fail('Quote', ctx.grpc.status.UNAVAILABLE, '', 10);
  let out = await m.finalizeWithTax('t-1', a);
  const calls = ctx.grpc.callsTo('Quote').length;
  assert.equal(out.status, 'held', \`with the tax service unavailable finalizeWithTax answered \${JSON.stringify(out)}: an unknown tax is not zero tax. Hold the draft\`);
  assert(out.reason === 'unavailable' && out.attempts === calls, \`the held outcome must carry reason unavailable and the \${calls} attempts made, got \${JSON.stringify(out)}\`);
  await unclaimed(ctx, store, a, 'with no quote');
  const stored = await store.get(a);
  assert.equal(stored.tax_cents, null, \`an invoice without a quote recorded \${stored.tax_cents} tax\`);
  assert.deepStrictEqual(stored.tax_hold, {reason: 'unavailable', attempts: calls}, \`the store's tax hold is \${JSON.stringify(stored.tax_hold)}, expected reason unavailable after \${calls} attempts\`);
  ctx.grpc.clearFailures();
  out = await m.finalizeWithTax('t-1', a);
  assert(out.status === 'finalized' && out.number === 1 && out.tax_cents === 9500 && out.tax_source === 'quote', \`once the tax service answers the held draft must finalize as number 1 with the quoted 9500, got \${JSON.stringify(out)}\`);
  assert.equal((await store.get(a)).tax_hold, null, 'a finalized invoice still carries its tax hold');
  ctx.grpc.clearFailures();
  ctx.grpc.fail('Quote', ctx.grpc.status.DEADLINE_EXCEEDED, '', 1);
  ctx.grpc.fail('Quote', ctx.grpc.status.UNAVAILABLE, '', 10);
  const before = ctx.grpc.callsTo('Quote').length;
  const b = await draft(store);
  out = await m.finalizeWithTax('t-1', b);
  const made = ctx.grpc.callsTo('Quote').length - before;
  const hold = (await store.get(b)).tax_hold;
  assert(out.status === 'held' && out.reason === 'unavailable' && out.attempts === made && JSON.stringify(hold) === JSON.stringify({reason: 'unavailable', attempts: made}), \`after a DEADLINE_EXCEEDED, then UNAVAILABLE answers, the outcome is \${JSON.stringify(out)} and the hold \${JSON.stringify(hold)}, expected held with reason unavailable after the \${made} attempts made: the reason is the last status, in lower case\`);
}
`,
    go: `package main

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "invoice/gen/invoice_service"
	"invoice/store"

	"leetbuild/harness"
)

var (
	hBg    = context.Background()
	hLines = []store.Line{{Description: "Consulting", Quantity: 2, UnitPriceCents: 25000}}
)

// hTaxPeer: 19% in DE, exempt in US-OR; jurisdiction XX refuses invoices from this seller.
type hTaxPeer struct {
	pb.UnimplementedTaxServer
}

func (hTaxPeer) Quote(_ context.Context, req *pb.QuoteRequest) (*pb.TaxQuote, error) {
	switch req.GetJurisdiction() {
	case "XX":
		return nil, status.Error(codes.FailedPrecondition, "jurisdiction XX does not accept invoices from this seller")
	case "US-OR":
		return &pb.TaxQuote{TaxCents: 0, TaxSource: "exempt"}, nil
	}
	return &pb.TaxQuote{TaxCents: req.GetSubtotalCents() * 19 / 100, TaxSource: "quote"}, nil
}

func hServeTax(ctx *harness.Ctx) {
	pb.RegisterTaxServer(ctx.GRPC.Server(""), hTaxPeer{})
}

func hDraft(jurisdiction string) string {
	return store.Create(hBg, "t-1", "eur", hLines, "cus-1", jurisdiction, "").ID
}

func hMustFinalize(ctx *harness.Ctx, invoiceID string) Outcome {
	out, err := finalizeWithTax(hBg, "t-1", invoiceID)
	ctx.NoError(err, "finalizeWithTax(t-1, %s) failed", invoiceID)
	return out
}

func hUnclaimed(ctx *harness.Ctx, invoiceID, why string) {
	stored := store.Get(hBg, invoiceID)
	ctx.Assert(stored.Status == "draft" && stored.Number == 0, "%s: the invoice must stay a draft without a number, the store holds %s number %d", why, stored.Status, stored.Number)
	seq, claimed := ctx.Redis.Get("invoice:seq:t-1")
	ctx.Assert(!claimed, "%s: a number was claimed (%s)", why, seq)
}

func CheckDeadline(ctx *harness.Ctx) {
	hServeTax(ctx)
	out := hMustFinalize(ctx, hDraft("DE"))
	ctx.Assert(out.Status == "finalized" && out.TaxCents == 9500 && out.Number == 1, "with the tax service healthy the invoice must finalize as number 1 with 9500 tax, got %+v", out)
	for _, call := range ctx.GRPC.CallsTo("Quote", "") {
		ctx.Assert(call.HasDeadline(), "a Quote call carries no deadline: a stuck tax service would hold the finalize open")
		ctx.Assert(1500*time.Millisecond <= call.Timeout && call.Timeout <= 2500*time.Millisecond, "a Quote call carries a %v deadline, expected taxDeadline = 2 s", call.Timeout)
	}
	ctx.GRPC.SetLatency("Quote", 10.0, "")
	b := hDraft("DE")
	out = hMustFinalize(ctx, b)
	ctx.Assert(out.Status == "held" && out.Reason == "deadline_exceeded", "with the tax service slower than the deadline finalizeWithTax answered %+v, expected held with reason deadline_exceeded", out)
	ctx.Equal(store.Get(hBg, b).Number, int64(0), "an invoice whose quote timed out must not get a number; its number")
	for i, call := range ctx.GRPC.CallsTo("Quote", "")[1:] {
		ctx.Assert(call.HasDeadline() && 1500*time.Millisecond <= call.Timeout && call.Timeout <= 2500*time.Millisecond, "attempt %d at a slow tax service carries a %v deadline: every attempt gets its own taxDeadline = 2 s, not what is left of the first one's", i+1, call.Timeout)
	}
}

func CheckBoundedRetry(ctx *harness.Ctx) {
	hServeTax(ctx)
	ctx.GRPC.Fail("Quote", codes.Unavailable, "", 10, "")
	finalizeWithTax(hBg, "t-1", hDraft("DE"))
	calls := len(ctx.GRPC.CallsTo("Quote", ""))
	ctx.Equal(calls, 3, "an unavailable tax service, the calls for one finalize (taxMaxAttempts = 3)")
	ctx.GRPC.ClearFailures()
	ctx.GRPC.Fail("Quote", codes.DeadlineExceeded, "", 10, "")
	finalizeWithTax(hBg, "t-1", hDraft("DE"))
	ctx.Equal(len(ctx.GRPC.CallsTo("Quote", ""))-calls, 3, "a tax service answering DeadlineExceeded (transient), the calls for one finalize (taxMaxAttempts = 3)")
	for _, terminal := range []struct {
		code   codes.Code
		reason string
	}{{codes.Internal, "internal"}, {codes.InvalidArgument, "invalid_argument"}, {codes.PermissionDenied, "permission_denied"}, {codes.ResourceExhausted, "resource_exhausted"}} {
		code := terminal.code
		ctx.GRPC.ClearFailures()
		before := len(ctx.GRPC.CallsTo("Quote", ""))
		ctx.GRPC.Fail("Quote", code, "", 1, "")
		out, _ := finalizeWithTax(hBg, "t-1", hDraft("DE"))
		ctx.Equal(len(ctx.GRPC.CallsTo("Quote", ""))-before, 1, "an answer of %v must not be retried (only Unavailable and DeadlineExceeded are transient); the calls", code)
		ctx.Assert(out.Status == "held" && out.Reason == terminal.reason, "an answer of %v gave %+v, expected held with reason %s", code, out, terminal.reason)
	}
}

func CheckTerminalJurisdiction(ctx *harness.Ctx) {
	hServeTax(ctx)
	a := hDraft("XX")
	out, err := finalizeWithTax(hBg, "t-1", a)
	var rejected *JurisdictionRejected
	ctx.Assert(errors.As(err, &rejected), "finalizeWithTax answered %+v, %v for an invoice its jurisdiction refuses: return a *JurisdictionRejected", out, err)
	ctx.Equal(rejected.Jurisdiction, "XX", "JurisdictionRejected must name the invoice's jurisdiction")
	ctx.Equal(len(ctx.GRPC.CallsTo("Quote", "")), 1, "a jurisdiction refusal is terminal, not retried; the calls")
	ctx.Equal(ctx.Clock.Sleeps(), 0, "a jurisdiction refusal must not be slept on and retried; the sleeps")
	hUnclaimed(ctx, a, "after a jurisdiction refusal")
}

func CheckHoldMarker(ctx *harness.Ctx) {
	hServeTax(ctx)
	a := hDraft("DE")
	ctx.GRPC.Fail("Quote", codes.Unavailable, "", 10, "")
	out := hMustFinalize(ctx, a)
	calls := len(ctx.GRPC.CallsTo("Quote", ""))
	ctx.Equal(out.Status, "held", "with the tax service unavailable finalizeWithTax answered %+v: an unknown tax is not zero tax. Hold the draft; the status", out)
	ctx.Assert(out.Reason == "unavailable" && out.Attempts == calls, "the held outcome must carry reason unavailable and the %d attempts made, got %+v", calls, out)
	hUnclaimed(ctx, a, "with no quote")
	stored := store.Get(hBg, a)
	ctx.Equal(stored.TaxSource, "", "an invoice without a quote must record no tax; its tax source")
	ctx.Assert(stored.HoldReason == "unavailable" && stored.HoldAttempts == calls, "the store's tax hold is %q after %d attempts, expected unavailable after %d", stored.HoldReason, stored.HoldAttempts, calls)
	ctx.GRPC.ClearFailures()
	out = hMustFinalize(ctx, a)
	ctx.Assert(out.Status == "finalized" && out.Number == 1 && out.TaxCents == 9500 && out.TaxSource == "quote", "once the tax service answers the held draft must finalize as number 1 with the quoted 9500, got %+v", out)
	ctx.Equal(store.Get(hBg, a).HoldReason, "", "a finalized invoice still carries its tax hold; the hold")
	ctx.GRPC.ClearFailures()
	ctx.GRPC.Fail("Quote", codes.DeadlineExceeded, "", 1, "")
	ctx.GRPC.Fail("Quote", codes.Unavailable, "", 10, "")
	before := len(ctx.GRPC.CallsTo("Quote", ""))
	b := hDraft("DE")
	out = hMustFinalize(ctx, b)
	made := len(ctx.GRPC.CallsTo("Quote", "")) - before
	held := store.Get(hBg, b)
	ctx.Assert(out.Status == "held" && out.Reason == "unavailable" && out.Attempts == made && held.HoldReason == "unavailable" && held.HoldAttempts == made, "after a DeadlineExceeded, then Unavailable answers, the outcome is %+v and the hold %q after %d attempts, expected held with reason unavailable after the %d attempts made: the reason is the last status, in lower case", out, held.HoldReason, held.HoldAttempts, made)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <utility>
#include <vector>

#include "invoice/store.h"
#include "invoice_service.grpc.pb.h"

namespace {

const std::vector<store::Line> hLines = {{"Consulting", 2, 25000}};

// 19% in DE, exempt in US-OR; jurisdiction XX refuses invoices from this seller.
class HTaxPeer final : public invoicetax::Tax::Service {
 public:
  grpc::Status Quote(grpc::ServerContext*, const invoicetax::QuoteRequest* req, invoicetax::TaxQuote* out) override {
    if (req->jurisdiction() == "XX") return grpc::Status(grpc::StatusCode::FAILED_PRECONDITION, "jurisdiction XX does not accept invoices from this seller");
    if (req->jurisdiction() == "US-OR") {
      out->set_tax_cents(0);
      out->set_tax_source("exempt");
      return grpc::Status::OK;
    }
    out->set_tax_cents(req->subtotal_cents() * 19 / 100);
    out->set_tax_source("quote");
    return grpc::Status::OK;
  }
};

void hServeTax(harness::Ctx& ctx) {
  static HTaxPeer* peer = nullptr;
  delete peer;
  peer = new HTaxPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
}

std::string hDraft(const std::string& jurisdiction) { return store::create("t-1", "eur", hLines, "cus-1", jurisdiction).id; }

Outcome hMustFinalize(harness::Ctx& ctx, const std::string& invoice_id) {
  try {
    return finalizeWithTax("t-1", invoice_id);
  } catch (const std::exception& e) {
    ctx.Fatalf("finalizeWithTax(t-1, %s) threw %s: %s", invoice_id, harness::CurrentExceptionType(), e.what());
  }
}

std::string hShow(const Outcome& out) {
  return harness::Sprintf("{status %s number %d tax_cents %d tax_source %s reason %s attempts %d}", out.status, out.number, out.tax_cents, out.tax_source,
                          out.reason, out.attempts);
}

void hUnclaimed(harness::Ctx& ctx, const std::string& invoice_id, const std::string& why) {
  const auto stored = store::get(invoice_id);
  ctx.Assert(stored->status == "draft" && stored->number == 0, "%s: the invoice must stay a draft without a number, the store holds %s number %d", why, stored->status,
             stored->number);
  const auto seq = ctx.Redis.Get("invoice:seq:t-1");
  ctx.Assert(!seq, "%s: a number was claimed (%s)", why, seq.value_or(""));
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  hServeTax(ctx);
  Outcome out = hMustFinalize(ctx, hDraft("DE"));
  ctx.Assert(out.status == "finalized" && out.tax_cents == 9500 && out.number == 1, "with the tax service healthy the invoice must finalize as number 1 with 9500 tax, got %s", hShow(out));
  for (const auto& call : ctx.GRPC.CallsTo("Quote")) {
    ctx.Assert(call.HasDeadline(), "a Quote call carries no deadline: a stuck tax service would hold the finalize open");
    ctx.Assert(1.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 2.5, "a Quote call carries a %v s deadline, expected kTaxDeadline = 2 s", call.TimeoutSeconds());
  }
  ctx.GRPC.SetLatency("Quote", 10.0);
  const std::string b = hDraft("DE");
  out = hMustFinalize(ctx, b);
  ctx.Assert(out.status == "held" && out.reason == "deadline_exceeded", "with the tax service slower than the deadline finalizeWithTax answered %s, expected held with reason deadline_exceeded", hShow(out));
  ctx.Equal(store::get(b)->number, 0, "an invoice whose quote timed out must not get a number; its number");
  const auto slow = ctx.GRPC.CallsTo("Quote");
  for (size_t i = 1; i < slow.size(); i++) {
    ctx.Assert(slow[i].HasDeadline() && 1.5 <= slow[i].TimeoutSeconds() && slow[i].TimeoutSeconds() <= 2.5,
               "attempt %d at a slow tax service carries a %v s deadline: every attempt gets its own kTaxDeadline = 2 s, not what is left of the first one's", i,
               slow[i].TimeoutSeconds());
  }
}

void CheckBoundedRetry(harness::Ctx& ctx) {
  hServeTax(ctx);
  ctx.GRPC.Fail("Quote", grpc::StatusCode::UNAVAILABLE, "", 10);
  finalizeWithTax("t-1", hDraft("DE"));
  const size_t calls = ctx.GRPC.CallsTo("Quote").size();
  ctx.Equal(calls, 3, "an unavailable tax service, the calls for one finalize (kTaxMaxAttempts = 3)");
  ctx.GRPC.ClearFailures();
  ctx.GRPC.Fail("Quote", grpc::StatusCode::DEADLINE_EXCEEDED, "", 10);
  finalizeWithTax("t-1", hDraft("DE"));
  ctx.Equal(ctx.GRPC.CallsTo("Quote").size() - calls, 3, "a tax service answering DEADLINE_EXCEEDED (transient), the calls for one finalize (kTaxMaxAttempts = 3)");
  const std::vector<std::tuple<grpc::StatusCode, std::string, std::string>> terminal = {
      {grpc::StatusCode::INTERNAL, "INTERNAL", "internal"},
      {grpc::StatusCode::INVALID_ARGUMENT, "INVALID_ARGUMENT", "invalid_argument"},
      {grpc::StatusCode::PERMISSION_DENIED, "PERMISSION_DENIED", "permission_denied"},
      {grpc::StatusCode::RESOURCE_EXHAUSTED, "RESOURCE_EXHAUSTED", "resource_exhausted"}};
  for (const auto& [code, name, reason] : terminal) {
    ctx.GRPC.ClearFailures();
    const size_t before = ctx.GRPC.CallsTo("Quote").size();
    ctx.GRPC.Fail("Quote", code, "", 1);
    const Outcome out = finalizeWithTax("t-1", hDraft("DE"));
    ctx.Equal(ctx.GRPC.CallsTo("Quote").size() - before, 1, "an answer of %s must not be retried (only UNAVAILABLE and DEADLINE_EXCEEDED are transient); the calls", name);
    ctx.Assert(out.status == "held" && out.reason == reason, "an answer of %s gave %s, expected held with reason %s", name, hShow(out), reason);
  }
}

void CheckTerminalJurisdiction(harness::Ctx& ctx) {
  hServeTax(ctx);
  const std::string a = hDraft("XX");
  bool rejected = false;
  try {
    const Outcome out = finalizeWithTax("t-1", a);
    ctx.Fatalf("finalizeWithTax answered %s for an invoice its jurisdiction refuses: throw JurisdictionRejected", hShow(out));
  } catch (const JurisdictionRejected& e) {
    rejected = true;
    ctx.Equal(e.jurisdiction, "XX", "JurisdictionRejected must name the invoice's jurisdiction");
  } catch (const harness::Failure&) {
    throw;
  } catch (const std::exception& e) {
    ctx.Fatalf("a refusing jurisdiction threw %s: %s, expected JurisdictionRejected", harness::CurrentExceptionType(), e.what());
  }
  ctx.Assert(rejected, "a refusing jurisdiction must throw JurisdictionRejected");
  ctx.Equal(ctx.GRPC.CallsTo("Quote").size(), 1, "a jurisdiction refusal is terminal, not retried; the calls");
  ctx.Equal(ctx.Clock.Sleeps(), 0, "a jurisdiction refusal must not be slept on and retried; the sleeps");
  hUnclaimed(ctx, a, "after a jurisdiction refusal");
}

void CheckHoldMarker(harness::Ctx& ctx) {
  hServeTax(ctx);
  const std::string a = hDraft("DE");
  ctx.GRPC.Fail("Quote", grpc::StatusCode::UNAVAILABLE, "", 10);
  Outcome out = hMustFinalize(ctx, a);
  const long calls = static_cast<long>(ctx.GRPC.CallsTo("Quote").size());
  ctx.Assert(out.status == "held", "with the tax service unavailable finalizeWithTax answered %s: an unknown tax is not zero tax. Hold the draft", hShow(out));
  ctx.Assert(out.reason == "unavailable" && out.attempts == calls, "the held outcome must carry reason unavailable and the %d attempts made, got %s", calls, hShow(out));
  hUnclaimed(ctx, a, "with no quote");
  const auto stored = store::get(a);
  ctx.Equal(stored->tax_source, "", "an invoice without a quote must record no tax; its tax source");
  ctx.Assert(stored->hold_reason == "unavailable" && stored->hold_attempts == calls, "the store's tax hold is %q after %d attempts, expected unavailable after %d",
             stored->hold_reason, stored->hold_attempts, calls);
  ctx.GRPC.ClearFailures();
  out = hMustFinalize(ctx, a);
  ctx.Assert(out.status == "finalized" && out.number == 1 && out.tax_cents == 9500 && out.tax_source == "quote",
             "once the tax service answers the held draft must finalize as number 1 with the quoted 9500, got %s", hShow(out));
  ctx.Equal(store::get(a)->hold_reason, "", "a finalized invoice still carries its tax hold; the hold");
  ctx.GRPC.ClearFailures();
  ctx.GRPC.Fail("Quote", grpc::StatusCode::DEADLINE_EXCEEDED, "", 1);
  ctx.GRPC.Fail("Quote", grpc::StatusCode::UNAVAILABLE, "", 10);
  const long before = static_cast<long>(ctx.GRPC.CallsTo("Quote").size());
  const std::string b = hDraft("DE");
  out = hMustFinalize(ctx, b);
  const long made = static_cast<long>(ctx.GRPC.CallsTo("Quote").size()) - before;
  const auto held = store::get(b);
  ctx.Assert(out.status == "held" && out.reason == "unavailable" && out.attempts == made && held->hold_reason == "unavailable" && held->hold_attempts == made,
             "after a DEADLINE_EXCEEDED, then UNAVAILABLE answers, the outcome is %s and the hold %q after %d attempts, expected held with reason unavailable after the %d "
             "attempts made: the reason is the last status, in lower case",
             hShow(out), held->hold_reason, held->hold_attempts, made);
}
`,
  },
  hints: [
    'Take the tax service down for a minute and finalize: every invoice issued in that minute carries zero tax and a source of `quote`. A customer in a jurisdiction that refuses the document is invoiced too, after five identical refusals.',
    '`Quote` has no deadline, so one stuck call holds the finalize. `RETRYABLE` lists `FAILED_PRECONDITION`, a refusal no retry changes. When the loop ends without a quote, the zero it started with is written as the tax and a number is claimed.',
    'Pass `timeout=TAX_DEADLINE_S` (2); set `TAX_MAX_ATTEMPTS = 3` and `RETRYABLE` to `UNAVAILABLE` and `DEADLINE_EXCEEDED`; raise `JurisdictionRejected` on `FAILED_PRECONDITION`; with no quote call `store.hold` and return `held` before `set_tax` and `claim_number`.',
  ],
  debrief: `Tax is part of the document, so the finalize waits for it: an unknown answer holds the draft instead of turning into zero, and the number is claimed only once a quote is recorded, which keeps the series free of documents that might need voiding. The deadline bounds what one stuck dependency can cost, the attempt budget bounds what an outage can cost, and only the statuses that say nothing about the invoice are retried; a refusal is the tax service's answer, so it ends the attempt and names the jurisdiction for whoever fixes the customer record. A production tax integration also retries held drafts from a scheduled job, caches quotes per invoice so a retry does not quote twice, and records the rate and the rule version next to the amount.`,
};
