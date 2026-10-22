import type {Step} from '@/lib/types';

export const invoiceLedgerStep: Step = {
  id: 'read',
  title: 'GET /v1/subscriptions/{id}/invoices: a ledger that ties out',
  concept: 'http',
  file: 'read',
  focus: ['client', 'billing', 'db', 'processor'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the ledger route,
reads the periods and returns an amount per period. It compiles, it serves the demo, and it hides four
production flaws. Review it like the billing owner, fix it, and prove the fix with the checks below.

Implement the ledger read on \`GET /v1/subscriptions/{id}/invoices\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**, and a
  subscription that belongs to another tenant is **404** — never another tenant's ledger. A **403**
  would confirm that the id exists, so it is the wrong answer.
- Each period carries \`period_start\`, \`period_end\` and \`amount_cents\` read from the **stored
  invoice row** — the amount that was actually charged — never a figure recomputed from plan prices.
  A ledger that re-derives the number cannot be tied out against the processor.
- Credits are always returned as their own lines (\`credit_id\`, \`amount_cents\`, \`reason\`), never
  netted into the period's amount: the customer is entitled to see why the total is what it is.
- \`payment_references\` lists the processor charge references for the period.
- \`reconciled\` is true only when the stored invoiced amount agrees with the processor's own records
  for that period: read the processor's total with \`GetInvoice\` and report the comparison as
  \`processor_total_cents\`, so a missing or a duplicated charge is visible to the customer and to
  support instead of surfacing in a nightly report nobody reads.
- The endpoint is read-only: it charges nothing, mutates nothing, and never puts card data in the
  response or in the logs.

**Failure mode the checks target.** Every one of these flaws survives a demo. The seeded subscription
belongs to the caller and its plan never changes, so a figure recomputed from plan prices agrees with
the invoice by accident — until a proration or a mid-period change makes the two disagree. No credit
has been granted yet, so a response that nets credits into the amount looks correct. And the
processor's records have never differed from the ledger, so a response that never asks it looks
reconciled. Each of those is silent in a demo and loud in production.`,
  sequence: {
    participants: ['Client', 'Billing Service', 'billing db', 'Payment processor'],
    messages: [
      {
        from: 'Client',
        to: 'Billing Service',
        label: 'GET /v1/subscriptions/sub_8d1/invoices · X-Tenant-Id',
        kind: 'sync',
      },
      {
        from: 'Billing Service',
        to: 'Billing Service',
        label: 'missing X-Tenant-Id → 401',
        kind: 'sync',
      },
      {from: 'Billing Service', to: 'billing db', label: 'load subscription · tenant', kind: 'sync'},
      {from: 'billing db', to: 'Billing Service', label: 'subscription row · owner tenant', kind: 'reply'},
      {
        from: 'Billing Service',
        to: 'Billing Service',
        label: 'owner ≠ tenant → 404, never another tenant’s ledger',
        kind: 'sync',
      },
      {
        from: 'Billing Service',
        to: 'billing db',
        label: 'list_invoices · list_credits(subscription_id)',
        kind: 'sync',
      },
      {from: 'billing db', to: 'Billing Service', label: 'stored invoice rows · credits', kind: 'reply'},
      {
        from: 'Billing Service',
        to: 'Payment processor',
        label: 'GetInvoice(invoice_id) for each period · 5 s deadline',
        kind: 'sync',
      },
      {from: 'Payment processor', to: 'Billing Service', label: 'processor_total_cents', kind: 'reply'},
      {
        from: 'Billing Service',
        to: 'Billing Service',
        label: 'stored amount_cents == processor_total_cents → reconciled',
        kind: 'sync',
      },
      {
        from: 'Billing Service',
        to: 'Client',
        label: '200 {periods[{amount_cents, credits[{credit_id}], payment_references, reconciled}]}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/subscriptions/{id}/invoices',
      detail: 'Register the ledger route on `GET /v1/subscriptions/{id}/invoices`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/subscriptions\/\{subscription_id\}\/invoices["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/subscriptions\/:subscriptionId\/invoices['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/subscriptions\/\{subscriptionID\}\/invoices"/]},
        scala: {
          all: [/path\(\s*"v1"\s*\/\s*"subscriptions"\s*\/\s*Segment\s*\/\s*"invoices"\s*\)/, /\bget\s*\{/],
        },
        cpp: {all: [/svr\.Get\(\s*"\/v1\/subscriptions\/:id\/invoices"/]},
      },
    },
    {
      id: 'tenant',
      title: 'Answers a foreign subscription with 404',
      detail:
        'A missing `X-Tenant-Id` is **401** and a subscription owned by another tenant is **404**. The draft serves any subscription id it is handed, which turns the endpoint into a cross-tenant read.',
      match: {
        python: {all: [/X-Tenant-Id/, /status_code\s*=\s*401/, /status_code\s*=\s*404/]},
        typescript: {all: [/x-tenant-id/, /code\(\s*401\s*\)/, /code\(\s*404\s*\)/]},
        go: {all: [/X-Tenant-Id/, /StatusUnauthorized/, /StatusNotFound/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.Unauthorized/, /StatusCodes\.NotFound/]},
        cpp: {all: [/X-Tenant-Id/, /res\.status\s*=\s*401/, /res\.status\s*=\s*404/]},
      },
    },
    {
      id: 'stored-invoices',
      title: 'Amounts come from the stored invoices',
      detail:
        'Each period’s `amount_cents` is the stored invoice’s amount (`invoice.amount_cents`), not a number recomputed from plan prices. The draft re-derives the figure with plan math, so the ledger can disagree with what was actually charged.',
      match: {
        python: {all: [/invoice\.amount_cents/], none: [/PLANS\[[^\]]*\]\s*\*/]},
        typescript: {all: [/invoice\.amount_cents/], none: [/PLANS\[[^\]]*\]\s*\*/]},
        go: {all: [/invoice\.AmountCents/], none: [/plans\[[^\]]*\]\s*\*/]},
        scala: {all: [/invoice\.amount_cents/], none: [/Plans\([^)]*\)\s*\*/]},
        cpp: {all: [/invoice\.amount_cents/], none: [/kPlans\.at\([^)]*\)\s*\*/]},
      },
    },
    {
      id: 'credits',
      title: 'Credits appear as their own lines',
      detail:
        'Every credit is returned as its own line with its `credit_id`, amount and reason, instead of being netted into the period total. The draft subtracts credits from the amount, so the customer cannot see why the total is what it is.',
      match: {
        python: {all: [/credits/, /credit_id/, /credit\.amount_cents/]},
        typescript: {all: [/credits/, /credit_id/]},
        go: {all: [/Credits/, /CreditID/]},
        scala: {all: [/credits/, /credit_id/]},
        cpp: {all: [/credits/, /credit_id/]},
      },
    },
    {
      id: 'reconciled',
      title: 'Reconciles each period against the processor',
      detail:
        'The response reports `reconciled` by comparing the stored amount with the processor’s own total for the period (`processor_total_cents`, read with `GetInvoice`). The draft never contacts the processor, so a missing or duplicated charge is invisible to the customer and to support.',
      match: {
        python: {all: [/reconciled/, /processor_total_cents/, /GetInvoice/]},
        typescript: {all: [/reconciled/, /processor_total_cents/, /GetInvoice/]},
        go: {all: [/Reconciled/, /ProcessorTotalCents/, /GetInvoice/]},
        scala: {all: [/reconciled/, /processor_total_cents/, /getInvoice/]},
        cpp: {all: [/reconciled/, /processor_total_cents/, /GetInvoice/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
from datetime import date

from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("billing")

MONTH_DAYS = 30
PLANS = {"starter-monthly": 1900, "scale-monthly": 9900}


class SubscriptionStore:
    def load(self, subscription_id: str) -> dict:
        """The subscription row: tenant, plan, period bounds, credits already netted."""
        raise NotImplementedError

    def list_periods(self, subscription_id: str) -> list[dict]:
        """The billing periods, oldest first."""
        raise NotImplementedError


subscriptions = SubscriptionStore()


@app.get("/v1/subscriptions/{subscription_id}/invoices")
def read_ledger(subscription_id: str) -> JSONResponse:
    # TODO: a model-generated draft. It re-derives each period's amount_cents from the plan price
    # (PLANS[plan] * days / MONTH_DAYS) instead of reading the stored invoice row, subtracts the
    # period's credit from the amount so the customer never sees a credit line or its credit_id,
    # takes the subscription id straight from the path with no tenant check (any tenant can read any
    # ledger, and a foreign subscription is answered with the ledger instead of a 404), and never
    # contacts the processor, so the response carries no reconciled flag and no processor_total_cents.
    subscription = subscriptions.load(subscription_id)
    periods = []
    for period in subscriptions.list_periods(subscription_id):
        days = (period["period_end"] - period["period_start"]).days
        amount_cents = round(PLANS[subscription["plan"]] * days / MONTH_DAYS) - period["credit_cents"]
        periods.append(
            {
                "period_start": period["period_start"].isoformat(),
                "period_end": period["period_end"].isoformat(),
                "amount_cents": amount_cents,
                "payment_references": period["payment_references"],
            }
        )
    logger.info("ledger read subscription=%s periods=%d", subscription_id, len(periods))
    return JSONResponse({"subscription_id": subscription_id, "periods": periods}, status_code=200)
`,
      solution: `import logging
from dataclasses import dataclass
from datetime import date

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("billing")

PROCESSOR_DEADLINE_S = 5


@dataclass
class Invoice:
    """A stored invoice row: the amount the period was actually billed."""

    period_start: date
    period_end: date
    amount_cents: int
    invoice_id: str
    payment_references: list[str]


@dataclass
class Credit:
    """A credit granted against a period, shown as its own line."""

    credit_id: str
    period_start: date
    amount_cents: int
    reason: str


class SubscriptionStore:
    def load(self, subscription_id: str) -> dict | None:
        """{"tenant": ..., "plan": ...} for the subscription, or None."""
        raise NotImplementedError


class InvoiceStore:
    def list_invoices(self, subscription_id: str) -> list[Invoice]:
        """Every stored invoice row for the subscription, oldest period first."""
        raise NotImplementedError

    def list_credits(self, subscription_id: str) -> list[Credit]:
        """Every credit granted on the subscription's periods."""
        raise NotImplementedError


class ProcessorClient:
    def GetInvoice(self, invoice_id: str):
        """The processor's own view of the invoice."""
        raise NotImplementedError


subscriptions = SubscriptionStore()
invoices = InvoiceStore()
processor = ProcessorClient()


def assert_tenant_owns(tenant: str, subscription_id: str) -> None:
    subscription = subscriptions.load(subscription_id)
    if subscription is None or subscription["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="subscription not found")


def processor_total(invoice_id: str) -> int:
    """The processor's own total for the period, read under a deadline."""
    return processor.GetInvoice(invoice_id).processor_total_cents


@app.get("/v1/subscriptions/{subscription_id}/invoices")
def read_ledger(
    subscription_id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    assert_tenant_owns(tenant, subscription_id)

    granted = invoices.list_credits(subscription_id)
    periods = []
    for invoice in invoices.list_invoices(subscription_id):
        processor_total_cents = processor_total(invoice.invoice_id)
        periods.append(
            {
                "period_start": invoice.period_start.isoformat(),
                "period_end": invoice.period_end.isoformat(),
                "amount_cents": invoice.amount_cents,
                "credits": [
                    {
                        "credit_id": credit.credit_id,
                        "amount_cents": credit.amount_cents,
                        "reason": credit.reason,
                    }
                    for credit in granted
                    if credit.period_start == invoice.period_start
                ],
                "payment_references": invoice.payment_references,
                "processor_total_cents": processor_total_cents,
                "reconciled": invoice.amount_cents == processor_total_cents,
            }
        )

    logger.info(
        "ledger read tenant=%s subscription=%s periods=%d", tenant, subscription_id, len(periods)
    )
    return JSONResponse({"subscription_id": subscription_id, "periods": periods}, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/subscriptions/:subscriptionId/invoices: a model-generated draft of the ledger read. */
import Fastify from 'fastify';

export const app = Fastify();

const MONTH_DAYS = 30;
const PLANS: Record<string, number> = {'starter-monthly': 1900, 'scale-monthly': 9900};

interface Subscription {
  tenant: string;
  plan: string;
}

interface Period {
  period_start: string;
  period_end: string;
  credit_cents: number;
  payment_references: string[];
}

async function loadSubscription(subscriptionId: string): Promise<Subscription | null> {
  return null;
}

async function listPeriods(subscriptionId: string): Promise<Period[]> {
  return [];
}

function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000);
}

app.get('/v1/subscriptions/:subscriptionId/invoices', async (request, reply) => {
  const {subscriptionId} = request.params as {subscriptionId: string};
  // TODO: a model-generated draft. It re-derives each period's amount_cents from the plan price
  // (PLANS[plan] * days / MONTH_DAYS) instead of reading the stored invoice row, subtracts the
  // period's credit from the amount so the customer never sees a credit line or its credit_id,
  // takes the subscription id straight from the path with no tenant check (any tenant can read any
  // ledger, and a foreign subscription is answered with the ledger instead of a 404), and never
  // contacts the processor, so the response carries no reconciled flag and no processor_total_cents.
  const subscription = await loadSubscription(subscriptionId);
  const periods = [];
  for (const period of await listPeriods(subscriptionId)) {
    const days = daysBetween(period.period_start, period.period_end);
    const amount_cents = Math.round((PLANS[subscription!.plan] * days) / MONTH_DAYS) - period.credit_cents;
    periods.push({
      period_start: period.period_start,
      period_end: period.period_end,
      amount_cents,
      payment_references: period.payment_references,
    });
  }
  return reply.code(200).send({subscription_id: subscriptionId, periods});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/subscriptions/:subscriptionId/invoices: the ledger read, tied out against the processor. */
import Fastify from 'fastify';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

export const app = Fastify();

const PROCESSOR_DEADLINE_MS = 5000;

interface ProcessorClient {
  GetInvoice(
    request: {invoice_id: string},
    options: grpc.CallOptions,
    callback: (error: grpc.ServiceError | null, answer: {processor_total_cents: number}) => void,
  ): grpc.ClientUnaryCall;
}

const {billing} = grpc.loadPackageDefinition(protoLoader.loadSync('processor.proto', {keepCase: true})) as unknown as {
  billing: {Processor: new (target: string, credentials: grpc.ChannelCredentials) => ProcessorClient};
};
const processor = new billing.Processor('processor:9000', grpc.credentials.createInsecure());

interface Invoice {
  period_start: string;
  period_end: string;
  amount_cents: number;
  invoice_id: string;
  payment_references: string[];
}

interface Credit {
  credit_id: string;
  period_start: string;
  amount_cents: number;
  reason: string;
}

async function loadSubscription(subscriptionId: string): Promise<{tenant: string} | null> {
  return null;
}

async function listInvoices(subscriptionId: string): Promise<Invoice[]> {
  return [];
}

async function listCredits(subscriptionId: string): Promise<Credit[]> {
  return [];
}

function processorTotal(invoiceId: string): Promise<number> {
  const {promise, resolve, reject} = Promise.withResolvers<number>();
  processor.GetInvoice(
    {invoice_id: invoiceId},
    {deadline: Date.now() + PROCESSOR_DEADLINE_MS},
    (error: grpc.ServiceError | null, answer: {processor_total_cents: number}) => {
      if (error !== null) return reject(error);
      resolve(answer.processor_total_cents);
    },
  );
  return promise;
}

app.get('/v1/subscriptions/:subscriptionId/invoices', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {subscriptionId} = request.params as {subscriptionId: string};
  const subscription = await loadSubscription(subscriptionId);
  if (subscription === null || subscription.tenant !== tenant)
    return reply.code(404).send({error: 'subscription not found'});

  const granted = await listCredits(subscriptionId);
  const periods = [];
  for (const invoice of await listInvoices(subscriptionId)) {
    const processor_total_cents = await processorTotal(invoice.invoice_id);
    periods.push({
      period_start: invoice.period_start,
      period_end: invoice.period_end,
      amount_cents: invoice.amount_cents,
      credits: granted
        .filter(credit => credit.period_start === invoice.period_start)
        .map(credit => ({
          credit_id: credit.credit_id,
          amount_cents: credit.amount_cents,
          reason: credit.reason,
        })),
      payment_references: invoice.payment_references,
      processor_total_cents,
      reconciled: invoice.amount_cents === processor_total_cents,
    });
  }

  request.log.info({tenant, subscriptionId, periods: periods.length}, 'ledger read');
  return reply.code(200).send({subscription_id: subscriptionId, periods});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

const monthDays = 30

var plans = map[string]int64{"starter-monthly": 1900, "scale-monthly": 9900}

type Subscription struct {
	Tenant string \`json:"tenant"\`
	Plan   string \`json:"plan"\`
}

type Period struct {
	PeriodStart       time.Time \`json:"period_start"\`
	PeriodEnd         time.Time \`json:"period_end"\`
	CreditCents       int64     \`json:"credit_cents"\`
	PaymentReferences []string  \`json:"payment_references"\`
}

type subscriptionStore struct{}

func (subscriptionStore) Load(ctx context.Context, subscriptionID string) (*Subscription, error) {
	return nil, nil
}

func (subscriptionStore) ListPeriods(ctx context.Context, subscriptionID string) ([]Period, error) {
	return nil, nil
}

var subscriptions = subscriptionStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func readLedger(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	subscriptionID := r.PathValue("subscriptionID")
	// TODO: a model-generated draft. It re-derives each period's amount_cents from the plan price
	// (plans[plan] * days / monthDays) instead of reading the stored invoice row, subtracts the
	// period's credit from the amount so the customer never sees a credit line or its credit_id,
	// takes the subscription id straight from the path with no tenant check (any tenant can read any
	// ledger, and a foreign subscription is answered with the ledger instead of a 404), and never
	// contacts the processor, so the response carries no reconciled flag and no ProcessorTotalCents.
	subscription, _ := subscriptions.Load(ctx, subscriptionID)
	stored, _ := subscriptions.ListPeriods(ctx, subscriptionID)
	periods := make([]map[string]any, 0, len(stored))
	for _, period := range stored {
		days := int64(period.PeriodEnd.Sub(period.PeriodStart).Hours() / 24)
		amountCents := plans[subscription.Plan]*days/monthDays - period.CreditCents
		periods = append(periods, map[string]any{
			"period_start":       period.PeriodStart.Format(time.RFC3339),
			"period_end":         period.PeriodEnd.Format(time.RFC3339),
			"amount_cents":       amountCents,
			"payment_references": period.PaymentReferences,
		})
	}
	writeJSON(rw, http.StatusOK, map[string]any{"subscription_id": subscriptionID, "periods": periods})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/subscriptions/{subscriptionID}/invoices", readLedger)
	_ = http.ListenAndServe(":8443", mux)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	pb "billing/processorpb"
)

const processorDeadlineS = 5

var processor pb.ProcessorClient

type Subscription struct {
	Tenant string \`json:"tenant"\`
	Plan   string \`json:"plan"\`
}

type Invoice struct {
	PeriodStart       string   \`json:"period_start"\`
	PeriodEnd         string   \`json:"period_end"\`
	AmountCents       int64    \`json:"amount_cents"\`
	InvoiceID         string   \`json:"invoice_id"\`
	PaymentReferences []string \`json:"payment_references"\`
}

type Credit struct {
	CreditID    string \`json:"credit_id"\`
	PeriodStart string \`json:"period_start"\`
	AmountCents int64  \`json:"amount_cents"\`
	Reason      string \`json:"reason"\`
}

type PeriodView struct {
	PeriodStart         string   \`json:"period_start"\`
	PeriodEnd           string   \`json:"period_end"\`
	AmountCents         int64    \`json:"amount_cents"\`
	Credits             []Credit \`json:"credits"\`
	PaymentReferences   []string \`json:"payment_references"\`
	ProcessorTotalCents int64    \`json:"processor_total_cents"\`
	Reconciled          bool     \`json:"reconciled"\`
}

type subscriptionStore struct{}

func (subscriptionStore) Load(ctx context.Context, subscriptionID string) (*Subscription, error) {
	return nil, nil
}

type invoiceStore struct{}

func (invoiceStore) ListInvoices(ctx context.Context, subscriptionID string) ([]Invoice, error) {
	return nil, nil
}

func (invoiceStore) ListCredits(ctx context.Context, subscriptionID string) ([]Credit, error) {
	return nil, nil
}

var subscriptions = subscriptionStore{}
var invoices = invoiceStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func assertTenantOwns(subscription *Subscription, tenant string) error {
	if subscription == nil || subscription.Tenant != tenant {
		return errors.New("subscription not found")
	}
	return nil
}

func reconcilePeriod(ctx context.Context, invoice Invoice) (int64, bool) {
	callCtx, cancel := context.WithTimeout(ctx, processorDeadlineS*time.Second)
	defer cancel()
	answer, err := processor.GetInvoice(callCtx, &pb.GetInvoiceRequest{InvoiceId: invoice.InvoiceID})
	if err != nil {
		return -1, false
	}
	processorTotalCents := answer.ProcessorTotalCents
	return processorTotalCents, invoice.AmountCents == processorTotalCents
}

func readLedger(rw http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	subscriptionID := r.PathValue("subscriptionID")
	subscription, _ := subscriptions.Load(ctx, subscriptionID)
	if err := assertTenantOwns(subscription, tenant); err != nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "subscription not found"})
		return
	}
	stored, _ := invoices.ListInvoices(ctx, subscriptionID)
	granted, _ := invoices.ListCredits(ctx, subscriptionID)

	periods := make([]PeriodView, 0, len(stored))
	for _, invoice := range stored {
		lines := make([]Credit, 0, len(granted))
		for _, credit := range granted {
			if credit.PeriodStart == invoice.PeriodStart {
				lines = append(lines, credit)
			}
		}
		processorTotalCents, reconciled := reconcilePeriod(ctx, invoice)
		periods = append(periods, PeriodView{
			PeriodStart:         invoice.PeriodStart,
			PeriodEnd:           invoice.PeriodEnd,
			AmountCents:         invoice.AmountCents,
			Credits:             lines,
			PaymentReferences:   invoice.PaymentReferences,
			ProcessorTotalCents: processorTotalCents,
			Reconciled:          reconciled,
		})
	}
	writeJSON(rw, http.StatusOK, map[string]any{"subscription_id": subscriptionID, "periods": periods})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/subscriptions/{subscriptionID}/invoices", readLedger)
	_ = http.ListenAndServe(":8443", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object Read {
  implicit val system: ActorSystem = ActorSystem("billing")

  val MonthDays = 30
  val Plans: Map[String, Long] = Map("starter-monthly" -> 1900L, "scale-monthly" -> 9900L)

  object subscriptions {
    def plan(subscriptionId: String): String = ""
    def periods(subscriptionId: String): List[Map[String, Long]] = Nil
  }

  val route: Route =
    path("v1" / "subscriptions" / Segment / "invoices") { subscriptionId =>
      get {
        // TODO: a model-generated draft. It re-derives each period's amount_cents from the plan price
        // (Plans(plan) * days / MonthDays) instead of reading the stored invoice row, subtracts the
        // period's credit from the amount so the customer never sees a credit line or its credit_id,
        // takes the subscription id straight from the path with no tenant check (any tenant can read
        // any ledger, and a foreign subscription is answered with the ledger instead of a 404), and
        // never contacts the processor, so the response carries no reconciled flag and no
        // processor_total_cents.
        val plan = subscriptions.plan(subscriptionId)
        val periods = subscriptions.periods(subscriptionId).map { period =>
          val days = (period("period_end") - period("period_start")) / 86400L
          val amountCents = Plans(plan) * days / MonthDays - period("credit_cents")
          s"""{"period_start":\${period("period_start")},"period_end":\${period("period_end")},"amount_cents":$amountCents}"""
        }
        complete(StatusCodes.OK, periods.mkString("[", ",", "]"))
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Invoice(
    period_start: String,
    period_end: String,
    amount_cents: Long,
    invoice_id: String,
    payment_references: List[String]
)

final case class Credit(credit_id: String, period_start: String, amount_cents: Long, reason: String)

final case class PeriodView(
    period_start: String,
    period_end: String,
    amount_cents: Long,
    credits: List[Credit],
    payment_references: List[String],
    processor_total_cents: Long,
    reconciled: Boolean
)

final case class Ledger(subscription_id: String, periods: List[PeriodView])

object Read {
  implicit val system: ActorSystem = ActorSystem("billing")
  implicit val invoiceFormat: RootJsonFormat[Invoice] = jsonFormat5(Invoice)
  implicit val creditFormat: RootJsonFormat[Credit] = jsonFormat4(Credit)
  implicit val periodFormat: RootJsonFormat[PeriodView] = jsonFormat7(PeriodView)
  implicit val ledgerFormat: RootJsonFormat[Ledger] = jsonFormat2(Ledger)

  val ProcessorDeadlineS = 5

  object subscriptions {
    def owner(subscriptionId: String): Option[String] = None
  }

  object invoices {
    def listInvoices(subscriptionId: String): List[Invoice] = Nil
    def listCredits(subscriptionId: String): List[Credit] = Nil
  }

  def processorTotal(invoiceId: String): Long =
    ProcessorGrpc.blockingStub
      .withDeadlineAfter(ProcessorDeadlineS, TimeUnit.SECONDS)
      .getInvoice(GetInvoiceRequest(invoiceId = invoiceId))
      .processorTotalCents

  val route: Route =
    path("v1" / "subscriptions" / Segment / "invoices") { subscriptionId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            subscriptions.owner(subscriptionId).filter(_ == tenantOpt.get) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"subscription not found"}""")
              case Some(_) =>
                val granted = invoices.listCredits(subscriptionId)
                val periods = invoices.listInvoices(subscriptionId).map { invoice =>
                  val processorTotalCents = processorTotal(invoice.invoice_id)
                  PeriodView(
                    period_start = invoice.period_start,
                    period_end = invoice.period_end,
                    amount_cents = invoice.amount_cents,
                    credits = granted.filter(_.period_start == invoice.period_start),
                    payment_references = invoice.payment_references,
                    processor_total_cents = processorTotalCents,
                    reconciled = invoice.amount_cents == processorTotalCents
                  )
                }
                complete(StatusCodes.OK, Ledger(subscriptionId, periods))
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kMonthDays = 30;
const std::map<std::string, long long> kPlans = {{"starter-monthly", 1900}, {"scale-monthly", 9900}};

struct Subscriptions {
  std::string plan_of(const std::string& subscriptionId);
  std::vector<std::map<std::string, long long>> list_periods(const std::string& subscriptionId);
};

Subscriptions subscriptions;

int main() {
  httplib::Server svr;

  svr.Get("/v1/subscriptions/:id/invoices", [](const httplib::Request& req, httplib::Response& res) {
    const auto subscription_id = req.path_params.at("id");
    // TODO: a model-generated draft. It re-derives each period's amount_cents from the plan price
    // (kPlans.at(plan) * days / kMonthDays) instead of reading the stored invoice row, subtracts the
    // period's credit from the amount so the customer never sees a credit line or its credit_id,
    // takes the subscription id straight from the path with no tenant check (any tenant can read any
    // ledger, and a foreign subscription is answered with the ledger instead of a 404), and never
    // contacts the processor, so the response carries no reconciled flag and no processor_total_cents.
    const auto plan = subscriptions.plan_of(subscription_id);
    json periods = json::array();
    for (const auto& period : subscriptions.list_periods(subscription_id)) {
      const auto days = (period.at("period_end") - period.at("period_start")) / 86400;
      const long long amount_cents = kPlans.at(plan) * days / kMonthDays - period.at("credit_cents");
      periods.push_back(json{{"period_start", period.at("period_start")},
                             {"period_end", period.at("period_end")},
                             {"amount_cents", amount_cents}});
    }
    res.status = 200;
    res.set_content(json{{"subscription_id", subscription_id}, {"periods", periods}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include "processor.grpc.pb.h"

#include <chrono>
#include <memory>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kProcessorDeadlineS = 5;

struct Invoice {
  std::string period_start;
  std::string period_end;
  long long amount_cents;
  std::string invoice_id;
  std::vector<std::string> payment_references;
};

struct Credit {
  std::string credit_id;
  std::string period_start;
  long long amount_cents;
  std::string reason;
};

struct Subscriptions {
  std::optional<std::string> owner_of(const std::string& subscriptionId);
};

struct Invoices {
  std::vector<Invoice> list_invoices(const std::string& subscriptionId);
  std::vector<Credit> list_credits(const std::string& subscriptionId);
};

Subscriptions subscriptions;
Invoices invoices;
std::unique_ptr<Processor::Stub> processor;

long long processor_total(const std::string& invoiceId) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kProcessorDeadlineS));
  GetInvoiceRequest request;
  request.set_invoice_id(invoiceId);
  GetInvoiceReply answer;
  if (!processor->GetInvoice(&ctx, request, &answer).ok()) return -1;
  return answer.processor_total_cents();
}

int main() {
  httplib::Server svr;
  processor = Processor::NewStub(grpc::CreateChannel("processor:9000", grpc::InsecureChannelCredentials()));

  svr.Get("/v1/subscriptions/:id/invoices", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto subscription_id = req.path_params.at("id");
    const auto owner = subscriptions.owner_of(subscription_id);
    if (!owner || *owner != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"subscription not found"})", "application/json");
      return;
    }
    const auto granted = invoices.list_credits(subscription_id);
    json periods = json::array();
    for (const auto& invoice : invoices.list_invoices(subscription_id)) {
      json lines = json::array();
      for (const auto& credit : granted) {
        if (credit.period_start != invoice.period_start) continue;
        lines.push_back(json{{"credit_id", credit.credit_id},
                             {"amount_cents", credit.amount_cents},
                             {"reason", credit.reason}});
      }
      const long long processor_total_cents = processor_total(invoice.invoice_id);
      periods.push_back(json{{"period_start", invoice.period_start},
                             {"period_end", invoice.period_end},
                             {"amount_cents", invoice.amount_cents},
                             {"credits", lines},
                             {"payment_references", invoice.payment_references},
                             {"processor_total_cents", processor_total_cents},
                             {"reconciled", invoice.amount_cents == processor_total_cents}});
    }
    res.status = 200;
    res.set_content(json{{"subscription_id", subscription_id}, {"periods", periods}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The ledger is a read of what was charged, so read the invoice rows: `invoices.list_invoices(subscription_id)` returns the stored rows and `invoice.amount_cents` is the number to report. Re-deriving it from the plan price makes the ledger a second, weaker opinion about a figure the invoice already fixed.',
    'Credits are information, not arithmetic: keep the granted credits out of the amount and emit them as their own lines with `credit_id`, `amount_cents` and `reason`, filtered to the period they belong to. Subtracting them into the total hides the only explanation the customer has for a total that differs from the plan price.',
    'A total nobody reconciled is an assertion. For every period, call the processor with `GetInvoice(invoice_id)` under a deadline, take its own total, compare it with the stored `amount_cents`, and publish both the figure and the flag. Support needs to see the disagreement, not a promise that there is none.',
  ],
  debrief: `The interviewer is testing whether you can tell a read that reports money from a read that invents it. Four defects are being checked: tenancy at the boundary (another tenant's ledger is not yours to serve, and a 404 is the answer that does not confirm the id exists), the source of the amount (the stored invoice row is the record of what was charged, while a recomputation from plan prices is a second opinion that drifts the moment a proration, a discount or a mid-period change happens), credits as visible lines rather than arithmetic buried in a total (a customer who cannot see the credit cannot dispute it), and reconciliation as part of the response (the processor's own total per period, compared and reported, so a missing or a duplicated charge is caught by the read that a support agent is looking at rather than by a nightly job that nobody reads). The second one is what candidates miss: recomputing a stored figure feels like verification, but it silently overwrites the record with arithmetic the processor never agreed to. Real billing systems add explicit adjustment actions rather than edits to a closed period, credit notes instead of negative amounts, and a durable audit trail of every reconciliation run with what it compared and what it found.`,
};
