import type {Step} from '@/lib/types';

export const invoiceDependencyStep: Step = {
  id: 'dependency',
  title: 'Tax calls that hold the invoice when unsure',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'tax', 'db'],
  task: `## Task

An invoice is only issued once its tax is decided, and the tax figure comes from another service over
gRPC. That call fails in two very different ways: **transiently** (the service is briefly unavailable,
or the answer did not arrive inside the deadline) or **terminally** (the invoicing jurisdiction itself
refuses to tax the document). The two demand opposite responses, and the starter gets both wrong.

The starter is a plausible model-generated draft: it quotes the tax service, retries, and finalizes,
so the happy-path demo passes. Every failure path is wrong. It calls \`Quote\` **without a deadline**,
so one stuck tax service pins the finalize. On \`DEADLINE_EXCEEDED\` it swallows the error and
finalizes anyway with \`tax_cents = 0\` — an accounting incident nobody reconciles. And it treats
\`INVALID_ARGUMENT\` / \`FAILED_PRECONDITION\` — a jurisdiction that refuses to tax this document — as
retryable, hammering a permanent rejection and then finalizing with zero once the attempts run out.

Implement the tax leg of finalization:

- **A 2-second deadline on the quote** (\`TAX_DEADLINE_MS = 2000\` …), passed as the call's
  deadline/timeout — \`timeout=\`, \`deadline: Date.now() + TAX_DEADLINE_MS\`, a \`context.WithTimeout\`
  context, \`withDeadlineAfter\`, \`set_deadline\` — never a client-side sleep, which cancels nothing.
- **A bounded retry**: at most \`TAX_MAX_ATTEMPTS = 3\` attempts, and **only** \`UNAVAILABLE\` and
  \`DEADLINE_EXCEEDED\` are retried; every other status returns immediately.
- **A jurisdiction rejection is terminal**: \`INVALID_ARGUMENT\` / \`FAILED_PRECONDITION\` is never
  retried; the finalize is refused with **422** and the blocking \`jurisdiction\` is named in the
  payload, so support can tell the customer which jurisdiction blocks them.
- **An unsure answer holds the invoice**: on \`DEADLINE_EXCEEDED\` / \`UNAVAILABLE\` the finalize is
  held — the invoice stays a \`draft\`, a \`tax_hold\` marker with the \`reason\` and the \`attempts\` is
  persisted, and the API answers **202** with a \`held\` body so a later retry can pick the same draft
  up. Never finalize without a tax figure.
- **No invoice is finalized without a recorded tax source**: \`tax_source\` is one of \`quote\`,
  \`exempt\`, \`zero_rated\`, \`reverse_charge\`; it is persisted with the finalized invoice, and a
  finalize path that would store tax without a source is refused with **422**.

**Failure mode the checks target.** A swallowed timeout issues a legally-binding document with zero
tax that nobody reconciles; a retried jurisdiction rejection turns a deterministic refusal into a hot
loop and then issues the same zero-tax document; and a finalize that forgets \`tax_source\` leaves an
amount on the books that no rule can be reconstructed from. Each one is silent on the happy path and
loud in an audit.`,
  sequence: {
    participants: ['Client', 'Invoice Service', 'Tax service', 'Invoice store'],
    messages: [
      {from: 'Client', to: 'Invoice Service', label: 'POST /v1/invoices/inv_01/finalize', kind: 'sync'},
      {
        from: 'Invoice Service',
        to: 'Tax service',
        label: 'Quote · deadline 2000 ms · attempt ≤ 3',
        kind: 'sync',
      },
      {from: 'Tax service', to: 'Invoice Service', label: 'UNAVAILABLE / DEADLINE_EXCEEDED', kind: 'reply'},
      {
        from: 'Invoice Service',
        to: 'Invoice store',
        label: 'status = draft · tax_hold {reason, attempts}',
        kind: 'sync',
      },
      {from: 'Invoice Service', to: 'Client', label: '202 {status: held} — retry the same draft later', kind: 'reply'},
      {from: 'Tax service', to: 'Invoice Service', label: 'INVALID_ARGUMENT · jurisdiction = BR', kind: 'reply'},
      {from: 'Invoice Service', to: 'Client', label: '422 {jurisdiction: BR} — no retry', kind: 'reply'},
      {
        from: 'Invoice Service',
        to: 'Invoice store',
        label: 'finalized · tax_source = quote | exempt | …',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'The deadline is an argument on the call itself — `timeout=`, `deadline: Date.now() + TAX_DEADLINE_MS`, a `context.WithTimeout` context, `withDeadlineAfter`, `set_deadline`. Wrapping the call in `asyncio.wait_for` or a sleep does not cancel the RPC; pass the deadline on the call and let the transport enforce it.',
    'Retryability is a property of the status, not of “it threw”. Capture the error, compare its code against `UNAVAILABLE` / `DEADLINE_EXCEEDED`, and return every other status — especially `INVALID_ARGUMENT` / `FAILED_PRECONDITION` — as terminal: 422 naming the jurisdiction, with no retry.',
    'When the deadline or the retry budget is spent, do not finalize: write `tax_hold = {reason, attempts}`, leave the invoice `draft`, and answer 202. And make `tax_source` part of the persisted invoice — a finalize that would record tax without a source is refused with 422.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every quote carries a 2 s deadline',
      detail:
        'The quote is created with a 2000 ms deadline — a call timeout, a context with timeout, `withDeadlineAfter`, `set_deadline` or `deadline: Date.now() + TAX_DEADLINE_MS`. Without it one stuck tax service pins the finalize open, and a client-side sleep or a wrapper never cancels the RPC at all.',
      match: {
        python: {all: [/TAX_DEADLINE_MS\s*=\s*2000/, /timeout\s*=\s*TAX_DEADLINE_MS/, /\.Quote\(/]},
        typescript: {
          all: [/TAX_DEADLINE_MS\s*=\s*2000/, /deadline:\s*Date\.now\(\)\s*\+\s*TAX_DEADLINE_MS/, /\.Quote\(/],
        },
        go: {all: [/taxDeadlineMs\s*=\s*2000/, /context\.WithTimeout\(/, /\.Quote\(/]},
        scala: {all: [/TaxDeadlineMs\s*=\s*2000/, /withDeadlineAfter\(TaxDeadlineMs/, /\.quote\(/]},
        cpp: {all: [/kTaxDeadlineMs\s*=\s*2000/, /set_deadline\(/, /->Quote\(/]},
      },
    },
    {
      id: 'hold-marker',
      title: 'An unanswered quote holds the invoice as a draft',
      detail:
        'A `DEADLINE_EXCEEDED` / `UNAVAILABLE` outcome must **not** finalize: the invoice stays a `draft`, a `tax_hold` marker records the `reason` and the `attempts`, and the API answers 202 with a `held` body. The draft swallows the timeout and finalizes with `tax_cents = 0`, issuing a document nobody reconciles.',
      match: {
        python: {all: [/tax_hold/, /reason/, /attempts/, /"held"/, /202/]},
        typescript: {all: [/tax_hold/, /reason/, /attempts/, /'held'/, /202/]},
        go: {all: [/tax_hold/, /"reason"/, /attempts/, /"held"/, /202/]},
        scala: {all: [/tax_hold/, /"reason"/, /attempts/, /"held"/, /202/]},
        cpp: {all: [/tax_hold/, /"reason"/, /attempts/, /"held"/, /202/]},
      },
    },
    {
      id: 'terminal-jurisdiction',
      title: 'A jurisdiction rejection is terminal, named and 422',
      detail:
        'A jurisdiction that refuses the document (`INVALID_ARGUMENT` / `FAILED_PRECONDITION`) is a permanent business answer, not a transient one: it is **never** retried, the finalize is refused with **422**, and the blocking `jurisdiction` is named in the payload. The draft lists both codes as retryable, so it hammers a deterministic refusal and then finalizes with zero.',
      match: {
        python: {
          all: [/StatusCode\.INVALID_ARGUMENT/, /StatusCode\.FAILED_PRECONDITION/, /jurisdiction/, /422/],
          none: [/RETRYABLE\s*=\s*\{[^}]*StatusCode\.INVALID_ARGUMENT/],
        },
        typescript: {
          all: [/grpc\.status\.INVALID_ARGUMENT/, /grpc\.status\.FAILED_PRECONDITION/, /jurisdiction/, /422/],
          none: [/RETRYABLE\s*:\s*Record<number,\s*true>\s*=\s*\{[^}]*INVALID_ARGUMENT/],
        },
        go: {
          all: [/codes\.InvalidArgument/, /codes\.FailedPrecondition/, /jurisdiction/, /422/],
          none: [/retryable\s*=\s*map\[codes\.Code\]bool\{[^}]*codes\.InvalidArgument/],
        },
        scala: {
          all: [/Status\.Code\.INVALID_ARGUMENT/, /Status\.Code\.FAILED_PRECONDITION/, /jurisdiction/, /422/],
          none: [/Retryable\s*:\s*Set\[Status\.Code\]\s*=\s*Set\([^)]*Status\.Code\.INVALID_ARGUMENT/],
        },
        cpp: {
          all: [/StatusCode::INVALID_ARGUMENT/, /StatusCode::FAILED_PRECONDITION/, /jurisdiction/, /422/],
          none: [/kRetryable[^=]*=[^}]*StatusCode::INVALID_ARGUMENT/],
        },
      },
    },
    {
      id: 'tax-source',
      title: 'A finalized invoice records where its tax came from',
      detail:
        'The four `tax_source` values — `quote`, `exempt`, `zero_rated`, `reverse_charge` — are the only ways an amount becomes auditable, and the finalize path must refuse with **422** when a tax figure would be stored without a source. A value with no provenance is a journal entry nobody can reconstruct.',
      match: {
        python: {
          all: [/tax_source/, /["']quote["']/, /["']exempt["']/, /["']zero_rated["']/, /["']reverse_charge["']/, /422/],
        },
        typescript: {all: [/tax_source/, /'quote'/, /'exempt'/, /'zero_rated'/, /'reverse_charge'/, /422/]},
        go: {all: [/tax_source/, /"quote"/, /"exempt"/, /"zero_rated"/, /"reverse_charge"/, /422/]},
        scala: {all: [/tax_source/, /"quote"/, /"exempt"/, /"zero_rated"/, /"reverse_charge"/, /422/]},
        cpp: {all: [/tax_source/, /"quote"/, /"exempt"/, /"zero_rated"/, /"reverse_charge"/, /422/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'At most three attempts, only the two retryable codes',
      detail:
        'Attempts are bounded by `TAX_MAX_ATTEMPTS = 3` and only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried — the retryable set never contains `INVALID_ARGUMENT` / `FAILED_PRECONDITION`. The draft retries every status and finalizes when they run out.',
      match: {
        python: {
          all: [
            /TAX_MAX_ATTEMPTS\s*=\s*3/,
            /range\(TAX_MAX_ATTEMPTS\)/,
            /StatusCode\.UNAVAILABLE/,
            /StatusCode\.DEADLINE_EXCEEDED/,
          ],
          none: [/while\s+True/, /RETRYABLE\s*=\s*\{[^}]*StatusCode\.INVALID_ARGUMENT/],
        },
        typescript: {
          all: [
            /TAX_MAX_ATTEMPTS\s*=\s*3/,
            /attempt\s*<\s*TAX_MAX_ATTEMPTS/,
            /grpc\.status\.UNAVAILABLE/,
            /grpc\.status\.DEADLINE_EXCEEDED/,
          ],
          none: [/while\s*\(\s*true\s*\)/, /RETRYABLE\s*:\s*Record<number,\s*true>\s*=\s*\{[^}]*INVALID_ARGUMENT/],
        },
        go: {
          all: [
            /taxMaxAttempts\s*=\s*3/,
            /attempt\s*<\s*taxMaxAttempts/,
            /codes\.Unavailable/,
            /codes\.DeadlineExceeded/,
          ],
          none: [/for\s*\{/, /retryable\s*=\s*map\[codes\.Code\]bool\{[^}]*codes\.InvalidArgument/],
        },
        scala: {
          all: [
            /TaxMaxAttempts\s*=\s*3/,
            /attempt\s*<\s*TaxMaxAttempts/,
            /Status\.Code\.UNAVAILABLE/,
            /Status\.Code\.DEADLINE_EXCEEDED/,
          ],
          none: [
            /while\s*\(\s*true\s*\)/,
            /Retryable\s*:\s*Set\[Status\.Code\]\s*=\s*Set\([^)]*Status\.Code\.INVALID_ARGUMENT/,
          ],
        },
        cpp: {
          all: [
            /kTaxMaxAttempts\s*=\s*3/,
            /attempt\s*<\s*kTaxMaxAttempts/,
            /StatusCode::UNAVAILABLE/,
            /StatusCode::DEADLINE_EXCEEDED/,
          ],
          none: [/while\s*\(\s*true\s*\)/, /kRetryable[^=]*=[^}]*StatusCode::INVALID_ARGUMENT/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

TAX_MAX_ATTEMPTS = 5
RETRYABLE = {
    grpc.StatusCode.UNAVAILABLE,
    grpc.StatusCode.DEADLINE_EXCEEDED,
    grpc.StatusCode.INVALID_ARGUMENT,
    grpc.StatusCode.FAILED_PRECONDITION,
}


def finalize_with_tax(stub, invoice):
    # TODO: quote under a 2 s deadline, retry only the transient statuses, hold the invoice when the
    # answer is unknown, and never finalize without a recorded tax source.
    for _ in range(TAX_MAX_ATTEMPTS):
        try:
            request = QuoteRequest(jurisdiction=invoice["jurisdiction"], lines=invoice["lines"])
            quote = stub.Quote(request)
            invoice["tax_cents"] = quote.tax_cents
            invoice["tax_source"] = "quote"
            invoice["status"] = "finalized"
            return 200, invoice
        except grpc.RpcError as exc:
            if exc.code() in RETRYABLE:
                continue
            break
    invoice["tax_cents"] = 0
    invoice["tax_source"] = "quote"
    invoice["status"] = "finalized"
    return 200, invoice
`,
      solution: `import grpc

TAX_DEADLINE_MS = 2000
TAX_MAX_ATTEMPTS = 3
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}
JURISDICTION_REJECTED = {grpc.StatusCode.INVALID_ARGUMENT, grpc.StatusCode.FAILED_PRECONDITION}
TAX_SOURCES = {"quote", "exempt", "zero_rated", "reverse_charge"}


def finalize_with_tax(stub, invoice):
    attempts = 0
    last_error = None
    for _ in range(TAX_MAX_ATTEMPTS):
        attempts += 1
        try:
            request = QuoteRequest(jurisdiction=invoice["jurisdiction"], lines=invoice["lines"])
            quote = stub.Quote(request, timeout=TAX_DEADLINE_MS / 1000.0)
            invoice["tax_cents"] = quote.tax_cents
            invoice["tax_source"] = "quote"
            invoice["status"] = "finalized"
            return 200, invoice
        except grpc.RpcError as exc:
            code = exc.code()
            if code in JURISDICTION_REJECTED:
                return 422, {"error": "jurisdiction_rejected", "jurisdiction": invoice["jurisdiction"]}
            if code not in RETRYABLE:
                return 422, {"error": "tax_quote_refused", "status": code.name}
            last_error = exc
    invoice["status"] = "draft"
    invoice["tax_hold"] = {"reason": last_error.code().name, "attempts": attempts}
    return 202, {"status": "held", "tax_hold": invoice["tax_hold"]}


def finalize_manual(invoice, tax_cents, tax_source):
    if tax_source not in TAX_SOURCES:
        return 422, {"error": "tax_source_required", "allowed": sorted(TAX_SOURCES)}
    invoice["tax_cents"] = tax_cents
    invoice["tax_source"] = tax_source
    invoice["status"] = "finalized"
    return 200, invoice
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';

interface TaxClient {
  Quote(
    request: {jurisdiction: string; lines: unknown[]},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply?: {tax_cents: number}) => void,
  ): grpc.ClientUnaryCall;
}

export interface Invoice {
  jurisdiction: string;
  lines: unknown[];
  tax_cents?: number;
  tax_source?: string;
  tax_hold?: {reason: string; attempts: number};
  status: string;
}

export interface Result {
  status: number;
  body: unknown;
}

const TAX_MAX_ATTEMPTS = 5;

const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
  [grpc.status.INVALID_ARGUMENT]: true,
  [grpc.status.FAILED_PRECONDITION]: true,
};

function quoteOnce(client: TaxClient, invoice: Invoice): Promise<{tax_cents: number}> {
  const {promise, resolve, reject} = Promise.withResolvers<{tax_cents: number}>();
  client.Quote(
    {jurisdiction: invoice.jurisdiction, lines: invoice.lines},
    new grpc.Metadata(),
    {},
    (error, reply) => (error !== null ? reject(error) : resolve(reply as {tax_cents: number})),
  );
  return promise;
}

// TODO: quote under a 2 s deadline, retry only the transient statuses, hold the invoice when the
// answer is unknown, and never finalize without a recorded tax source.
export async function finalizeWithTax(client: TaxClient, invoice: Invoice): Promise<Result> {
  for (let attempt = 0; attempt < TAX_MAX_ATTEMPTS; attempt++) {
    try {
      const quote = await quoteOnce(client, invoice);
      invoice.tax_cents = quote.tax_cents;
      invoice.tax_source = 'quote';
      invoice.status = 'finalized';
      return {status: 200, body: invoice};
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      if (RETRYABLE[serviceError.code] === true) continue;
      break;
    }
  }
  invoice.tax_cents = 0;
  invoice.tax_source = 'quote';
  invoice.status = 'finalized';
  return {status: 200, body: invoice};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';

interface TaxClient {
  Quote(
    request: {jurisdiction: string; lines: unknown[]},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply?: {tax_cents: number}) => void,
  ): grpc.ClientUnaryCall;
}

export interface Invoice {
  jurisdiction: string;
  lines: unknown[];
  tax_cents?: number;
  tax_source?: string;
  tax_hold?: {reason: string; attempts: number};
  status: string;
}

export interface Result {
  status: number;
  body: unknown;
}

const TAX_DEADLINE_MS = 2000;
const TAX_MAX_ATTEMPTS = 3;

const RETRYABLE: Record<number, true> = {
  [grpc.status.UNAVAILABLE]: true,
  [grpc.status.DEADLINE_EXCEEDED]: true,
};

const TAX_SOURCES = ['quote', 'exempt', 'zero_rated', 'reverse_charge'] as const;

function quoteOnce(client: TaxClient, invoice: Invoice): Promise<{tax_cents: number}> {
  const {promise, resolve, reject} = Promise.withResolvers<{tax_cents: number}>();
  client.Quote(
    {jurisdiction: invoice.jurisdiction, lines: invoice.lines},
    new grpc.Metadata(),
    {deadline: Date.now() + TAX_DEADLINE_MS},
    (error, reply) => (error !== null ? reject(error) : resolve(reply as {tax_cents: number})),
  );
  return promise;
}

export async function finalizeWithTax(client: TaxClient, invoice: Invoice): Promise<Result> {
  let attempts = 0;
  let lastError: grpc.ServiceError | null = null;
  for (let attempt = 0; attempt < TAX_MAX_ATTEMPTS; attempt++) {
    attempts += 1;
    try {
      const quote = await quoteOnce(client, invoice);
      invoice.tax_cents = quote.tax_cents;
      invoice.tax_source = 'quote';
      invoice.status = 'finalized';
      return {status: 200, body: invoice};
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      if (
        serviceError.code === grpc.status.INVALID_ARGUMENT ||
        serviceError.code === grpc.status.FAILED_PRECONDITION
      ) {
        return {status: 422, body: {error: 'jurisdiction_rejected', jurisdiction: invoice.jurisdiction}};
      }
      if (RETRYABLE[serviceError.code] !== true) {
        return {status: 422, body: {error: 'tax_quote_refused', code: serviceError.code}};
      }
      lastError = serviceError;
    }
  }
  invoice.status = 'draft';
  invoice.tax_hold = {reason: String(lastError?.code), attempts};
  return {status: 202, body: {status: 'held', tax_hold: invoice.tax_hold}};
}

export function finalizeManual(invoice: Invoice, taxCents: number, taxSource: string): Result {
  if (!(TAX_SOURCES as readonly string[]).includes(taxSource)) {
    return {status: 422, body: {error: 'tax_source_required', allowed: TAX_SOURCES}};
  }
  invoice.tax_cents = taxCents;
  invoice.tax_source = taxSource;
  invoice.status = 'finalized';
  return {status: 200, body: invoice};
}
`,
    },
    go: {
      starter: `package client

import (
	"context"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "invoice/taxpb"
)

const taxMaxAttempts = 5

var retryable = map[codes.Code]bool{
	codes.Unavailable:        true,
	codes.DeadlineExceeded:   true,
	codes.InvalidArgument:    true,
	codes.FailedPrecondition: true,
}

// TODO: quote under a 2 s deadline, retry only the transient statuses, hold the invoice when the
// answer is unknown, and never finalize without a recorded tax source.
func FinalizeWithTax(ctx context.Context, client pb.TaxClient, invoice *Invoice) (*Result, error) {
	for attempt := 0; attempt < taxMaxAttempts; attempt++ {
		reply, err := client.Quote(ctx, &pb.QuoteRequest{
			Jurisdiction: invoice.Jurisdiction,
			Lines:        invoice.Lines,
		})
		if err == nil {
			invoice.TaxCents = reply.TaxCents
			invoice.TaxSource = "quote"
			invoice.Status = "finalized"
			return &Result{Status: 200, Body: invoice}, nil
		}
		if retryable[status.Code(err)] {
			continue
		}
		break
	}
	invoice.TaxCents = 0
	invoice.TaxSource = "quote"
	invoice.Status = "finalized"
	return &Result{Status: 200, Body: invoice}, nil
}
`,
      solution: `package client

import (
	"context"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "invoice/taxpb"
)

const (
	taxDeadlineMs  = 2000
	taxMaxAttempts = 3
	statusHeld     = 202
	statusRefused  = 422
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

var jurisdictionRejected = map[codes.Code]bool{
	codes.InvalidArgument:    true,
	codes.FailedPrecondition: true,
}

var taxSources = map[string]bool{
	"quote":          true,
	"exempt":         true,
	"zero_rated":     true,
	"reverse_charge": true,
}

func FinalizeWithTax(ctx context.Context, client pb.TaxClient, invoice *Invoice) (*Result, error) {
	attempts := 0
	var lastErr error
	for attempt := 0; attempt < taxMaxAttempts; attempt++ {
		attempts++
		callCtx, cancel := context.WithTimeout(ctx, taxDeadlineMs*time.Millisecond)
		reply, err := client.Quote(callCtx, &pb.QuoteRequest{
			Jurisdiction: invoice.Jurisdiction,
			Lines:        invoice.Lines,
		})
		cancel()
		if err == nil {
			invoice.TaxCents = reply.TaxCents
			invoice.TaxSource = "quote"
			invoice.Status = "finalized"
			return &Result{Status: 200, Body: invoice}, nil
		}
		code := status.Code(err)
		if jurisdictionRejected[code] {
			return &Result{
				Status: statusRefused,
				Body:   map[string]any{"error": "jurisdiction_rejected", "jurisdiction": invoice.Jurisdiction},
			}, nil
		}
		if !retryable[code] {
			return &Result{
				Status: statusRefused,
				Body:   map[string]any{"error": "tax_quote_refused", "code": code.String()},
			}, nil
		}
		lastErr = err
	}
	invoice.Status = "draft"
	invoice.TaxHold = map[string]any{
		"reason":   status.Code(lastErr).String(),
		"attempts": attempts,
	}
	return &Result{
		Status: statusHeld,
		Body:   map[string]any{"status": "held", "tax_hold": invoice.TaxHold},
	}, nil
}

func FinalizeManual(invoice *Invoice, taxCents int64, taxSource string) (*Result, error) {
	if !taxSources[taxSource] {
		return &Result{Status: statusRefused, Body: map[string]any{"error": "tax_source_required"}}, nil
	}
	invoice.TaxCents = taxCents
	invoice.TaxSource = taxSource
	invoice.Status = "finalized"
	return &Result{Status: 200, Body: invoice}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{Status, StatusRuntimeException}

object TaxDependency {
  val TaxMaxAttempts = 5
  val Retryable: Set[Status.Code] = Set(
    Status.Code.UNAVAILABLE,
    Status.Code.DEADLINE_EXCEEDED,
    Status.Code.INVALID_ARGUMENT,
    Status.Code.FAILED_PRECONDITION,
  )

  // TODO: quote under a 2 s deadline, retry only the transient statuses, hold the invoice when the
  // answer is unknown, and never finalize without a recorded tax source.
  def finalizeWithTax(stub: TaxServiceGrpc.TaxServiceBlockingStub, invoice: Invoice): Result = {
    var attempt = 0
    var stop = false
    while (attempt < TaxMaxAttempts && !stop) {
      try {
        val quote = stub.quote(QuoteRequest(jurisdiction = invoice.jurisdiction, lines = invoice.lines))
        invoice.taxCents = quote.taxCents
        invoice.taxSource = "quote"
        invoice.status = "finalized"
        return Result(200, invoice)
      } catch {
        case exc: StatusRuntimeException =>
          if (!Retryable.contains(exc.getStatus.getCode)) stop = true
      }
      attempt += 1
    }
    invoice.taxCents = 0
    invoice.taxSource = "quote"
    invoice.status = "finalized"
    Result(200, invoice)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{Status, StatusRuntimeException}

object TaxDependency {
  val TaxDeadlineMs = 2000
  val TaxMaxAttempts = 3
  val Retryable: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)
  val JurisdictionRejected: Set[Status.Code] =
    Set(Status.Code.INVALID_ARGUMENT, Status.Code.FAILED_PRECONDITION)
  val TaxSources: Set[String] = Set("quote", "exempt", "zero_rated", "reverse_charge")

  def finalizeWithTax(stub: TaxServiceGrpc.TaxServiceBlockingStub, invoice: Invoice): Result = {
    var attempts = 0
    var lastError: StatusRuntimeException = null
    var attempt = 0
    var stop = false
    while (attempt < TaxMaxAttempts && !stop) {
      attempts += 1
      try {
        val quote = stub
          .withDeadlineAfter(TaxDeadlineMs, TimeUnit.MILLISECONDS)
          .quote(QuoteRequest(jurisdiction = invoice.jurisdiction, lines = invoice.lines))
        invoice.taxCents = quote.taxCents
        invoice.taxSource = "quote"
        invoice.status = "finalized"
        return Result(200, invoice)
      } catch {
        case exc: StatusRuntimeException =>
          val code = exc.getStatus.getCode
          if (JurisdictionRejected.contains(code)) {
            return Result(422, Map("error" -> "jurisdiction_rejected", "jurisdiction" -> invoice.jurisdiction))
          }
          if (!Retryable.contains(code)) {
            return Result(422, Map("error" -> "tax_quote_refused", "code" -> code.toString))
          }
          lastError = exc
      }
      attempt += 1
    }
    invoice.status = "draft"
    invoice.taxHold = Map("reason" -> lastError.getStatus.getCode.toString, "attempts" -> attempts)
    Result(202, Map("status" -> "held", "tax_hold" -> invoice.taxHold))
  }

  def finalizeManual(invoice: Invoice, taxCents: Long, taxSource: String): Result = {
    if (!TaxSources.contains(taxSource)) {
      return Result(422, Map("error" -> "tax_source_required", "allowed" -> TaxSources.toList))
    }
    invoice.taxCents = taxCents
    invoice.taxSource = taxSource
    invoice.status = "finalized"
    Result(200, invoice)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "tax.grpc.pb.h"

#include <string>
#include <unordered_set>

constexpr int kTaxMaxAttempts = 5;

const std::unordered_set<grpc::StatusCode> kRetryable = {
    grpc::StatusCode::UNAVAILABLE,
    grpc::StatusCode::DEADLINE_EXCEEDED,
    grpc::StatusCode::INVALID_ARGUMENT,
    grpc::StatusCode::FAILED_PRECONDITION,
};

// TODO: quote under a 2 s deadline, retry only the transient statuses, hold the invoice when the
// answer is unknown, and never finalize without a recorded tax source.
Result FinalizeWithTax(TaxService::Stub* stub, Invoice& invoice) {
  for (int attempt = 0; attempt < kTaxMaxAttempts; ++attempt) {
    grpc::ClientContext context;
    QuoteRequest request;
    request.set_jurisdiction(invoice.jurisdiction);
    QuoteReply reply;
    const grpc::Status status = stub->Quote(&context, request, &reply);
    if (status.ok()) {
      invoice.tax_cents = reply.tax_cents();
      invoice.tax_source = "quote";
      invoice.status = "finalized";
      return Result{200, invoice};
    }
    if (kRetryable.count(status.error_code()) > 0) {
      continue;
    }
    break;
  }
  invoice.tax_cents = 0;
  invoice.tax_source = "quote";
  invoice.status = "finalized";
  return Result{200, invoice};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "tax.grpc.pb.h"

#include <chrono>
#include <string>
#include <unordered_set>

constexpr int kTaxDeadlineMs = 2000;
constexpr int kTaxMaxAttempts = 3;

const std::unordered_set<grpc::StatusCode> kRetryable = {
    grpc::StatusCode::UNAVAILABLE,
    grpc::StatusCode::DEADLINE_EXCEEDED,
};

const std::unordered_set<grpc::StatusCode> kJurisdictionRejected = {
    grpc::StatusCode::INVALID_ARGUMENT,
    grpc::StatusCode::FAILED_PRECONDITION,
};

const std::unordered_set<std::string> kTaxSources = {"quote", "exempt", "zero_rated", "reverse_charge"};

Result FinalizeWithTax(TaxService::Stub* stub, Invoice& invoice) {
  int attempts = 0;
  grpc::Status last_status;
  for (int attempt = 0; attempt < kTaxMaxAttempts; ++attempt) {
    ++attempts;
    grpc::ClientContext context;
    context.set_deadline(std::chrono::system_clock::now() +
                         std::chrono::milliseconds(kTaxDeadlineMs));
    QuoteRequest request;
    request.set_jurisdiction(invoice.jurisdiction);
    QuoteReply reply;
    const grpc::Status status = stub->Quote(&context, request, &reply);
    if (status.ok()) {
      invoice.tax_cents = reply.tax_cents();
      invoice.tax_source = "quote";
      invoice.status = "finalized";
      return Result{200, invoice};
    }
    if (kJurisdictionRejected.count(status.error_code()) > 0) {
      return Result{422, {{"error", "jurisdiction_rejected"}, {"jurisdiction", invoice.jurisdiction}}};
    }
    if (kRetryable.count(status.error_code()) == 0) {
      return Result{422, {{"error", "tax_quote_refused"}, {"code", status.error_message()}}};
    }
    last_status = status;
  }
  invoice.status = "draft";
  invoice.tax_hold = {{"reason", last_status.error_message()}, {"attempts", std::to_string(attempts)}};
  return Result{202, {{"status", "held"}, {"tax_hold", invoice.tax_hold}}};
}

Result FinalizeManual(Invoice& invoice, long tax_cents, const std::string& tax_source) {
  if (kTaxSources.count(tax_source) == 0) {
    return Result{422, {{"error", "tax_source_required"}}};
  }
  invoice.tax_cents = tax_cents;
  invoice.tax_source = tax_source;
  invoice.status = "finalized";
  return Result{200, invoice};
}
`,
    },
  },
  debrief: `The interview question is really "what does the tax call do when it cannot answer?" A deadline bounds one attempt, \`TAX_MAX_ATTEMPTS\` bounds the whole call, and the retryable set is the policy: only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are transient, so a jurisdiction rejection and every other status must return immediately. The draft's two bugs are the same bug in two directions — it treats every failure as retryable, and it treats "no answer" as "zero tax". Once the deadline or the retry budget is spent, the honest outcome is a hold: the invoice is still a draft, a \`tax_hold\` marker records why and how many attempts it took, and a 202 tells the caller to come back, so a later retry picks up the same draft instead of the system guessing a figure nobody can defend. Finally, the \`tax_source\` is what makes the amount auditable: a persisted quote, an exemption, a zero-rated line or a reverse-charge note is the difference between a number an auditor can reconstruct and one nobody can explain. Real tax clients add jittered backoff, a circuit breaker so a struggling tax service is not hammered, cached quotes keyed by a rule version so a retry does not re-price the invoice, and a reconciliation job that sweeps \`tax_hold\` drafts.`,
};
