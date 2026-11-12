import type {Step} from '@/lib/types';

export const invoiceLedgerStep: Step = {
  id: 'read',
  title: 'GET /v1/subscriptions/{id}/invoices: a ledger that ties out',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'billing', 'db', 'processor'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/subscriptions/{id}/invoices\`: it loads the
subscription, lists its invoices (\`store.invoices_of\`) and answers each with its period, state and
reference and an \`amount_cents\` it computes from the plan price minus the credits granted against
it (\`store.credits_of\`). It serves the demo and hides four flaws.

**Failure mode the checks target.** Any caller reads any tenant's ledger; a prorated invoice is
reported at the full plan price; a credit disappears into a smaller number nobody can explain; and
an invoice the processor charged twice looks like one it charged once.

- \`X-Tenant-Id\` is required (**401**); another tenant's subscription is **404**, like a missing one.
- \`amount_cents\` is the stored invoice's amount: what was billed, not a recomputation.
- \`credits\` lists every credit (\`credit_id\`, \`amount_cents\`, \`reason\`) as its own line; nothing is
  netted into the amount.
- Each invoice carries \`processor_total_cents\` from \`processor.lookup_invoice\` (0 when the
  processor holds nothing) and \`reconciled\`: whether that total equals the stored amount.
- The read charges nothing.`,
  sequence: {
    participants: ['Client', 'Billing Service', 'billing store', 'Payment processor'],
    messages: [
      {
        from: 'Client',
        to: 'Billing Service',
        label: 'GET /v1/subscriptions/sub_1/invoices · X-Tenant-Id',
        kind: 'sync',
      },
      {from: 'Billing Service', to: 'billing store', label: 'find_subscription · owner tenant → 401/404', kind: 'sync'},
      {from: 'Billing Service', to: 'billing store', label: 'invoices_of · credits_of(invoice)', kind: 'sync'},
      {from: 'Billing Service', to: 'Payment processor', label: 'GetInvoice(invoice_id) · 5 s', kind: 'sync'},
      {from: 'Payment processor', to: 'Billing Service', label: 'total_cents', kind: 'reply'},
      {
        from: 'Billing Service',
        to: 'Client',
        label: '200 {invoices[{amount_cents, credits, processor_total_cents, reconciled}]}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: "Lists a subscription's invoices",
      detail:
        'Register `GET /v1/subscriptions/{id}/invoices`: the owner gets every invoice of the subscription, oldest first.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/subscriptions\/\{subscription_id\}\/invoices["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/subscriptions\/:subscriptionId\/invoices['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/subscriptions\/\{id\}\/invoices"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"subscriptions"\s*\/\s*Segment\s*\/\s*"invoices"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\([^\n]*\/v1\/subscriptions\/[^\n]*\/invoices/]},
      },
    },
    {
      id: 'tenant',
      title: 'Answers a foreign subscription with 404',
      detail:
        'A read without `X-Tenant-Id` is **401**, and a subscription owned by another tenant is **404**, the answer a missing one gets. The starter serves any subscription id it is handed.',
      match: {
        python: {all: [/x-tenant-id/i, /\b401\b/, /\[["']tenant["']\]/]},
        typescript: {all: [/x-tenant-id/i, /\b401\b/, /\.tenant\b/]},
        go: {all: [/X-Tenant-Id/i, /StatusUnauthorized|\b401\b/, /\.Tenant\b/]},
        scala: {all: [/X-Tenant-Id/i, /Unauthorized|\b401\b/, /\.tenant\b/]},
        cpp: {all: [/X-Tenant-Id/i, /\b401\b/, /(->|\.)tenant\b/]},
      },
    },
    {
      id: 'stored-invoices',
      title: 'Amounts come from the stored invoices',
      detail:
        "Each invoice's `amount_cents` is the stored amount, so a prorated invoice reads as what was billed. The starter recomputes it from the plan price.",
      match: {
        python: {all: [/["']amount_cents["']\s*:\s*invoice\[["']amount_cents["']\]/], none: [/plan_price\(/]},
        typescript: {all: [/amount_cents:\s*invoice\.amount_cents/], none: [/planPrice\(/]},
        go: {all: [/AmountCents:\s*invoice\.AmountCents/], none: [/PlanPrice\(/]},
        scala: {all: [/invoice\.amountCents/], none: [/planPrice\(/]},
        cpp: {all: [/invoice\.amount_cents/], none: [/planPrice\(/]},
      },
    },
    {
      id: 'credits',
      title: 'Credits appear as their own lines',
      detail:
        'Every credit is listed with its `credit_id`, amount and reason under `credits`, and the invoice amount stays what was billed. The starter subtracts the credits, so the customer sees a number nobody can explain.',
      match: {
        python: {all: [/["']credits["']\s*:/], none: [/\bcredited\b/]},
        typescript: {all: [/\bcredits:/], none: [/\bcredited\b/]},
        go: {all: [/json:"credits"/], none: [/\bcredited\b/]},
        scala: {all: [/"credits"/], none: [/\bcredited\b/]},
        cpp: {all: [/"credits"/], none: [/\bcredited\b/]},
      },
    },
    {
      id: 'reconciled',
      title: 'Ties each invoice out against the processor',
      detail:
        "Each invoice carries the processor's own total (`processor_total_cents`, from `lookup_invoice`/`lookupInvoice`) and `reconciled`, true only when it equals the stored amount; nothing is charged. The starter never asks the processor.",
      match: {
        python: {all: [/processor\.lookup_invoice\(/, /processor_total_cents/, /reconciled/]},
        typescript: {all: [/lookupInvoice\(/, /processor_total_cents/, /reconciled/]},
        go: {all: [/processor\.LookupInvoice\(/, /processor_total_cents/, /reconciled/]},
        scala: {all: [/Processor\.lookupInvoice\(/, /processor_total_cents/, /reconciled/]},
        cpp: {all: [/processor::lookupInvoice\(/, /processor_total_cents/, /reconciled/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request

from billing import processor, store  # store.find_subscription, invoices_of, credits_of, plan_price; processor.lookup_invoice

app = FastAPI()


@app.get("/v1/subscriptions/{subscription_id}/invoices")
def list_invoices(subscription_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    subscription = store.find_subscription(subscription_id)
    if subscription is None:
        raise HTTPException(status_code=404, detail="no such subscription")
    price = store.plan_price(subscription["plan"]) or 0
    invoices = []
    for invoice in store.invoices_of(subscription_id):
        credited = sum(credit["amount_cents"] for credit in store.credits_of(invoice["invoice_id"]))
        invoices.append({
            "invoice_id": invoice["invoice_id"],
            "period_start": invoice["period_start"],
            "period_end": invoice["period_end"],
            "state": invoice["state"],
            "reference": invoice["reference"],
            "amount_cents": price - credited,
        })
    return {"subscription_id": subscription_id, "invoices": invoices}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from billing import processor, store  # store.find_subscription, invoices_of, credits_of, plan_price; processor.lookup_invoice

app = FastAPI()


@app.get("/v1/subscriptions/{subscription_id}/invoices")
def list_invoices(subscription_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    subscription = store.find_subscription(subscription_id)
    if subscription is None or subscription["tenant"] != tenant:
        # Another tenant's subscription answers like a missing one: the id is not confirmed.
        raise HTTPException(status_code=404, detail="no such subscription")
    invoices = []
    for invoice in store.invoices_of(subscription_id):
        found = processor.lookup_invoice(invoice["invoice_id"])
        processor_total = found["total_cents"] if found is not None else 0
        invoices.append({
            "invoice_id": invoice["invoice_id"],
            "period_start": invoice["period_start"],
            "period_end": invoice["period_end"],
            "state": invoice["state"],
            "reference": invoice["reference"],
            "amount_cents": invoice["amount_cents"],  # what was billed, as stored
            "credits": store.credits_of(invoice["invoice_id"]),  # each its own line, never netted
            "processor_total_cents": processor_total,
            "reconciled": processor_total == invoice["amount_cents"],
        })
    return {"subscription_id": subscription_id, "invoices": invoices}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {lookupInvoice} from 'billing/processor';
import {creditsOf, findSubscription, invoicesOf, planPrice} from 'billing/store';

export const app = Fastify();

app.get('/v1/subscriptions/:subscriptionId/invoices', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {subscriptionId} = request.params as {subscriptionId: string};
  const subscription = await findSubscription(subscriptionId);
  if (subscription === null) return reply.code(404).send({error: 'no such subscription'});
  const price = planPrice(subscription.plan) ?? 0;
  const invoices = [];
  for (const invoice of await invoicesOf(subscriptionId)) {
    const credited = (await creditsOf(invoice.invoice_id)).reduce((sum, credit) => sum + credit.amount_cents, 0);
    invoices.push({
      invoice_id: invoice.invoice_id,
      period_start: invoice.period_start,
      period_end: invoice.period_end,
      state: invoice.state,
      reference: invoice.reference,
      amount_cents: price - credited,
    });
  }
  return {subscription_id: subscriptionId, invoices};
});
`,
      solution: `import Fastify from 'fastify';

import {lookupInvoice} from 'billing/processor';
import {creditsOf, findSubscription, invoicesOf} from 'billing/store';

export const app = Fastify();

app.get('/v1/subscriptions/:subscriptionId/invoices', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {subscriptionId} = request.params as {subscriptionId: string};
  const subscription = await findSubscription(subscriptionId);
  // Another tenant's subscription answers like a missing one: the id is not confirmed.
  if (subscription === null || subscription.tenant !== tenant) return reply.code(404).send({error: 'no such subscription'});
  const invoices = [];
  for (const invoice of await invoicesOf(subscriptionId)) {
    const found = await lookupInvoice(invoice.invoice_id);
    const processorTotal = found?.total_cents ?? 0;
    invoices.push({
      invoice_id: invoice.invoice_id,
      period_start: invoice.period_start,
      period_end: invoice.period_end,
      state: invoice.state,
      reference: invoice.reference,
      amount_cents: invoice.amount_cents, // what was billed, as stored
      credits: await creditsOf(invoice.invoice_id), // each its own line, never netted
      processor_total_cents: processorTotal,
      reconciled: processorTotal === invoice.amount_cents,
    });
  }
  return {subscription_id: subscriptionId, invoices};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"billing/store" // store.FindSubscription, InvoicesOf, CreditsOf, PlanPrice
)

type ledgerLine struct {
	InvoiceID   string \`json:"invoice_id"\`
	PeriodStart string \`json:"period_start"\`
	PeriodEnd   string \`json:"period_end"\`
	State       string \`json:"state"\`
	Reference   string \`json:"reference"\`
	AmountCents int64  \`json:"amount_cents"\`
}

func listInvoices(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	subscriptionID := r.PathValue("id")
	sub := store.FindSubscription(r.Context(), subscriptionID)
	if sub == nil {
		http.Error(rw, "no such subscription", http.StatusNotFound)
		return
	}
	price, _ := store.PlanPrice(sub.Plan)
	invoices := []ledgerLine{}
	for _, invoice := range store.InvoicesOf(r.Context(), subscriptionID) {
		var credited int64
		for _, credit := range store.CreditsOf(r.Context(), invoice.InvoiceID) {
			credited += credit.AmountCents
		}
		invoices = append(invoices, ledgerLine{
			InvoiceID: invoice.InvoiceID, PeriodStart: invoice.PeriodStart, PeriodEnd: invoice.PeriodEnd,
			State: invoice.State, Reference: invoice.Reference, AmountCents: price - credited,
		})
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{"subscription_id": subscriptionID, "invoices": invoices})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/subscriptions/{id}/invoices", listInvoices)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"billing/processor" // processor.LookupInvoice
	"billing/store"     // store.FindSubscription, InvoicesOf, CreditsOf, PlanPrice
)

type ledgerLine struct {
	InvoiceID           string         \`json:"invoice_id"\`
	PeriodStart         string         \`json:"period_start"\`
	PeriodEnd           string         \`json:"period_end"\`
	State               string         \`json:"state"\`
	Reference           string         \`json:"reference"\`
	AmountCents         int64          \`json:"amount_cents"\`
	Credits             []store.Credit \`json:"credits"\`
	ProcessorTotalCents int64          \`json:"processor_total_cents"\`
	Reconciled          bool           \`json:"reconciled"\`
}

func listInvoices(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	subscriptionID := r.PathValue("id")
	sub := store.FindSubscription(r.Context(), subscriptionID)
	if sub == nil || sub.Tenant != tenant {
		// Another tenant's subscription answers like a missing one: the id is not confirmed.
		http.Error(rw, "no such subscription", http.StatusNotFound)
		return
	}
	invoices := []ledgerLine{}
	for _, invoice := range store.InvoicesOf(r.Context(), subscriptionID) {
		var processorTotal int64
		if found := processor.LookupInvoice(r.Context(), invoice.InvoiceID); found != nil {
			processorTotal = found.TotalCents
		}
		invoices = append(invoices, ledgerLine{
			InvoiceID: invoice.InvoiceID, PeriodStart: invoice.PeriodStart, PeriodEnd: invoice.PeriodEnd,
			State: invoice.State, Reference: invoice.Reference,
			AmountCents:         invoice.AmountCents,                                  // what was billed, as stored
			Credits:             store.CreditsOf(r.Context(), invoice.InvoiceID), // each its own line, never netted
			ProcessorTotalCents: processorTotal,
			Reconciled:          processorTotal == invoice.AmountCents,
		})
	}
	rw.Header().Set("Content-Type", "application/json")
	json.NewEncoder(rw).Encode(map[string]any{"subscription_id": subscriptionID, "invoices": invoices})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/subscriptions/{id}/invoices", listInvoices)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import billing.{Processor, Store} // Store.findSubscription, invoicesOf, creditsOf, planPrice; Processor.lookupInvoice

object Read {
  val route: Route =
    path("v1" / "subscriptions" / Segment / "invoices") { subscriptionId =>
      get {
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        Store.findSubscription(subscriptionId) match {
          case None => complete(StatusCodes.NotFound -> "no such subscription")
          case Some(subscription) =>
            val price = Store.planPrice(subscription.plan).getOrElse(0L)
            val invoices = Store.invoicesOf(subscriptionId).map { invoice =>
              val credited = Store.creditsOf(invoice.invoiceId).map(_.amountCents).sum
              JsObject(
                "invoice_id" -> JsString(invoice.invoiceId), "period_start" -> JsString(invoice.periodStart),
                "period_end" -> JsString(invoice.periodEnd), "state" -> JsString(invoice.state),
                "reference" -> JsString(invoice.reference), "amount_cents" -> JsNumber(price - credited))
            }
            val body = JsObject("subscription_id" -> JsString(subscriptionId), "invoices" -> JsArray(invoices.toVector))
            complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import billing.{Processor, Store} // Store.findSubscription, invoicesOf, creditsOf, planPrice; Processor.lookupInvoice

object Read {
  private def creditJson(credit: Store.Credit): JsObject =
    JsObject("credit_id" -> JsString(credit.creditId), "amount_cents" -> JsNumber(credit.amountCents), "reason" -> JsString(credit.reason))

  private def ledger(subscriptionId: String): JsObject = {
    val invoices = Store.invoicesOf(subscriptionId).map { invoice =>
      val processorTotal = Processor.lookupInvoice(invoice.invoiceId).map(_.totalCents).getOrElse(0L)
      JsObject(
        "invoice_id" -> JsString(invoice.invoiceId), "period_start" -> JsString(invoice.periodStart),
        "period_end" -> JsString(invoice.periodEnd), "state" -> JsString(invoice.state),
        "reference" -> JsString(invoice.reference),
        "amount_cents" -> JsNumber(invoice.amountCents), // what was billed, as stored
        "credits" -> JsArray(Store.creditsOf(invoice.invoiceId).map(creditJson).toVector), // each its own line, never netted
        "processor_total_cents" -> JsNumber(processorTotal),
        "reconciled" -> JsBoolean(processorTotal == invoice.amountCents))
    }
    JsObject("subscription_id" -> JsString(subscriptionId), "invoices" -> JsArray(invoices.toVector))
  }

  val route: Route =
    path("v1" / "subscriptions" / Segment / "invoices") { subscriptionId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
          case Some(tenant) =>
            // Another tenant's subscription answers like a missing one: the id is not confirmed.
            Store.findSubscription(subscriptionId).filter(_.tenant == tenant) match {
              case None => complete(StatusCodes.NotFound -> "no such subscription")
              case Some(_) =>
                complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, ledger(subscriptionId).compactPrint)))
            }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "billing/processor.h"  // processor::lookupInvoice
#include "billing/store.h"      // store::findSubscription, invoicesOf, creditsOf, planPrice

using json = nlohmann::json;

void list_invoices(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string subscription_id = req.matches[1];
  const auto subscription = store::findSubscription(subscription_id);
  if (!subscription) {
    res.status = 404;
    res.set_content("no such subscription", "text/plain");
    return;
  }
  const long long price = store::planPrice(subscription->plan).value_or(0);
  json invoices = json::array();
  for (const store::Invoice& invoice : store::invoicesOf(subscription_id)) {
    long long credited = 0;
    for (const store::Credit& credit : store::creditsOf(invoice.invoice_id)) credited += credit.amount_cents;
    invoices.push_back(json{{"invoice_id", invoice.invoice_id}, {"period_start", invoice.period_start},
                            {"period_end", invoice.period_end}, {"state", invoice.state},
                            {"reference", invoice.reference}, {"amount_cents", price - credited}});
  }
  res.set_content(json{{"subscription_id", subscription_id}, {"invoices", invoices}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/subscriptions/([\\w-]+)/invoices)", list_invoices);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "billing/processor.h"  // processor::lookupInvoice
#include "billing/store.h"      // store::findSubscription, invoicesOf, creditsOf, planPrice

using json = nlohmann::json;

json creditsJson(const std::string& invoice_id) {
  json credits = json::array();
  for (const store::Credit& credit : store::creditsOf(invoice_id)) {
    credits.push_back(json{{"credit_id", credit.credit_id}, {"amount_cents", credit.amount_cents}, {"reason", credit.reason}});
  }
  return credits;
}

void list_invoices(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const std::string subscription_id = req.matches[1];
  const auto subscription = store::findSubscription(subscription_id);
  if (!subscription || subscription->tenant != tenant) {
    // Another tenant's subscription answers like a missing one: the id is not confirmed.
    res.status = 404;
    res.set_content("no such subscription", "text/plain");
    return;
  }
  json invoices = json::array();
  for (const store::Invoice& invoice : store::invoicesOf(subscription_id)) {
    const auto found = processor::lookupInvoice(invoice.invoice_id);
    const long long processor_total = found ? found->total_cents : 0;
    invoices.push_back(json{{"invoice_id", invoice.invoice_id},
                            {"period_start", invoice.period_start},
                            {"period_end", invoice.period_end},
                            {"state", invoice.state},
                            {"reference", invoice.reference},
                            {"amount_cents", invoice.amount_cents},  // what was billed, as stored
                            {"credits", creditsJson(invoice.invoice_id)},  // each its own line, never netted
                            {"processor_total_cents", processor_total},
                            {"reconciled", processor_total == invoice.amount_cents}});
  }
  res.set_content(json{{"subscription_id", subscription_id}, {"invoices", invoices}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/subscriptions/([\\w-]+)/invoices)", list_invoices);
}
`,
    },
  },
  harness: {
    python: `import grpc

import subscription_billing_pb2 as pb
import subscription_billing_pb2_grpc
from billing import store

OWNER = {"X-Tenant-Id": "t-acme"}


class Processor(subscription_billing_pb2_grpc.ProcessorServicer):
    """Answers GetInvoice from what it charged: totals per invoice id."""

    def __init__(self):
        self.charged = {}

    def GetInvoice(self, request, context):
        if request.invoice_id not in self.charged:
            context.abort(grpc.StatusCode.NOT_FOUND, f"no charge for {request.invoice_id}")
        reference, total = self.charged[request.invoice_id]
        return pb.ProcessorInvoice(invoice_id=request.invoice_id, state="charged", reference=reference, total_cents=total)


def _world(ctx):
    processor = Processor()
    ctx.grpc.serve(subscription_billing_pb2_grpc.add_ProcessorServicer_to_server, processor)
    store.put_subscription("sub_1", "t-acme", "scale", "2026-02-01", "2026-04-01")
    store.put_subscription("sub_2", "t-other", "scale", "2026-02-01", "2026-04-01")
    return ctx.client(ctx.load("read").app), processor


def _charged(processor, period_start, period_end, amount, total=None, subscription_id="sub_1"):
    """A stored, charged invoice the processor holds for total (amount when not given)."""
    invoice = store.open_invoice(subscription_id, period_start, period_end, amount)
    reference = f"ch_{invoice['invoice_id']}"
    store.mark_charged(invoice["invoice_id"], reference)
    processor.charged[invoice["invoice_id"]] = (reference, amount if total is None else total)
    return invoice["invoice_id"]


async def _ledger(c, subscription_id="sub_1", headers=OWNER):
    r = await c.get(f"/v1/subscriptions/{subscription_id}/invoices", headers=headers)
    assert r.status_code == 200, f"GET /v1/subscriptions/{subscription_id}/invoices answered {r.status_code}: {r.text}"
    invoices = r.json().get("invoices")
    assert isinstance(invoices, list), f"the answer must carry an invoices list, got {r.text}"
    return invoices


async def check_route(ctx):
    c, processor = _world(ctx)
    first = _charged(processor, "2026-02-01", "2026-03-01", 9900)
    second = _charged(processor, "2026-03-01", "2026-04-01", 9900)
    async with c:
        invoices = await _ledger(c)
    assert [i.get("invoice_id") for i in invoices] == [first, second], f"the ledger lists {[i.get('invoice_id') for i in invoices]}, expected {[first, second]} oldest first"
    assert invoices[0].get("reference") == f"ch_{first}" and invoices[0].get("state") == "charged", f"the first invoice reads {invoices[0]}"


async def check_tenant(ctx):
    c, processor = _world(ctx)
    _charged(processor, "2026-03-01", "2026-04-01", 9900, subscription_id="sub_2")
    async with c:
        anonymous = await c.get("/v1/subscriptions/sub_1/invoices")
        assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 401"
        foreign = await c.get("/v1/subscriptions/sub_2/invoices", headers=OWNER)
        assert foreign.status_code == 404, f"t-acme reading t-other's subscription answered {foreign.status_code}, expected 404"
        assert "in_" not in foreign.text, f"the foreign read leaked invoices: {foreign.text}"
        missing = await c.get("/v1/subscriptions/sub_9/invoices", headers=OWNER)
    assert missing.status_code == 404, f"a missing subscription answered {missing.status_code}, expected 404"


async def check_stored_invoices(ctx):
    c, processor = _world(ctx)
    prorated = _charged(processor, "2026-03-01", "2026-04-01", 4790)
    async with c:
        invoices = await _ledger(c)
    assert invoices and invoices[0].get("amount_cents") == 4790, f"the prorated invoice {prorated} was billed 4790 cents and the ledger reports {invoices[0].get('amount_cents') if invoices else None}: report the stored amount, not the plan price"


async def check_credits(ctx):
    c, processor = _world(ctx)
    invoice_id = _charged(processor, "2026-03-01", "2026-04-01", 9900)
    credit = store.grant_credit(invoice_id, 500, "service outage")
    async with c:
        invoices = await _ledger(c)
    line = invoices[0]
    assert line.get("amount_cents") == 9900, f"an invoice billed 9900 with a 500 credit reads amount_cents {line.get('amount_cents')}: the amount stays what was billed"
    assert line.get("credits") == [credit], f"the invoice's credits read {line.get('credits')!r}, expected the credit as its own line {[credit]}"


async def check_reconciled(ctx):
    c, processor = _world(ctx)
    once = _charged(processor, "2026-01-01", "2026-02-01", 9900)
    twice = _charged(processor, "2026-02-01", "2026-03-01", 9900, total=19800)
    unknown = store.open_invoice("sub_1", "2026-03-01", "2026-04-01", 9900)["invoice_id"]
    async with c:
        invoices = {i.get("invoice_id"): i for i in await _ledger(c)}
    assert invoices[once].get("processor_total_cents") == 9900 and invoices[once].get("reconciled") is True, f"an invoice the processor charged once reads {invoices[once]}, expected processor_total_cents 9900 and reconciled true"
    assert invoices[twice].get("processor_total_cents") == 19800 and invoices[twice].get("reconciled") is False, f"an invoice the processor charged twice reads {invoices[twice]}, expected processor_total_cents 19800 and reconciled false"
    assert invoices[unknown].get("processor_total_cents") == 0 and invoices[unknown].get("reconciled") is False, f"an invoice the processor never charged reads {invoices[unknown]}, expected processor_total_cents 0 and reconciled false"
    assert not ctx.grpc.calls_to("Charge"), "a ledger read must not charge"
`,
    typescript: `const OWNER = {'X-Tenant-Id': 't-acme'};

/** The processor answers GetInvoice from what it charged: totals per invoice id. */
async function world(ctx) {
  const pkg = ctx.proto('subscription_billing.proto');
  const charged = new Map<string, {reference: string; total: number}>();
  ctx.grpc.serve(pkg.subbilling.Processor.service, {
    GetInvoice(call, callback) {
      const found = charged.get(call.request.invoice_id);
      if (found === undefined) return callback({code: ctx.grpc.status.NOT_FOUND, details: \`no charge for \${call.request.invoice_id}\`});
      callback(null, {invoice_id: call.request.invoice_id, state: 'charged', reference: found.reference, total_cents: found.total});
    },
  });
  const store = ctx.load('/support/billing/store.ts');
  await store.putSubscription('sub_1', 't-acme', 'scale', '2026-02-01', '2026-04-01');
  await store.putSubscription('sub_2', 't-other', 'scale', '2026-02-01', '2026-04-01');
  /** A stored, charged invoice the processor holds for total (amount when not given). */
  const charge = async (periodStart: string, periodEnd: string, amount: number, total?: number, subscriptionId = 'sub_1'): Promise<string> => {
    const invoice = await store.openInvoice(subscriptionId, periodStart, periodEnd, amount);
    const reference = \`ch_\${invoice.invoice_id}\`;
    await store.markCharged(invoice.invoice_id, reference);
    charged.set(invoice.invoice_id, {reference, total: total ?? amount});
    return invoice.invoice_id;
  };
  const c = ctx.client(ctx.load('read').app);
  const ledger = async (subscriptionId = 'sub_1') => {
    const r = await c.get(\`/v1/subscriptions/\${subscriptionId}/invoices\`, {headers: OWNER});
    assert.equal(r.status, 200, \`GET /v1/subscriptions/\${subscriptionId}/invoices answered \${r.status}: \${r.text}\`);
    const invoices = r.json().invoices;
    assert(Array.isArray(invoices), \`the answer must carry an invoices list, got \${r.text}\`);
    return invoices;
  };
  return {c, store, charge, ledger};
}

export async function check_route(ctx) {
  const {charge, ledger} = await world(ctx);
  const first = await charge('2026-02-01', '2026-03-01', 9900);
  const second = await charge('2026-03-01', '2026-04-01', 9900);
  const invoices = await ledger();
  const ids = invoices.map(i => i.invoice_id);
  assert.deepEqual(ids, [first, second], \`the ledger lists \${JSON.stringify(ids)}, expected \${JSON.stringify([first, second])} oldest first\`);
  assert(invoices[0].reference === \`ch_\${first}\` && invoices[0].state === 'charged', \`the first invoice reads \${JSON.stringify(invoices[0])}\`);
}

export async function check_tenant(ctx) {
  const {c, charge} = await world(ctx);
  await charge('2026-03-01', '2026-04-01', 9900, undefined, 'sub_2');
  const anonymous = await c.get('/v1/subscriptions/sub_1/invoices');
  assert.equal(anonymous.status, 401, \`a read without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  const foreign = await c.get('/v1/subscriptions/sub_2/invoices', {headers: OWNER});
  assert.equal(foreign.status, 404, \`t-acme reading t-other's subscription answered \${foreign.status}, expected 404\`);
  assert(!foreign.text.includes('in_'), \`the foreign read leaked invoices: \${foreign.text}\`);
  const missing = await c.get('/v1/subscriptions/sub_9/invoices', {headers: OWNER});
  assert.equal(missing.status, 404, \`a missing subscription answered \${missing.status}, expected 404\`);
}

export async function check_stored_invoices(ctx) {
  const {charge, ledger} = await world(ctx);
  const prorated = await charge('2026-03-01', '2026-04-01', 4790);
  const invoices = await ledger();
  assert.equal(invoices[0]?.amount_cents, 4790, \`the prorated invoice \${prorated} was billed 4790 cents and the ledger reports \${invoices[0]?.amount_cents}: report the stored amount, not the plan price\`);
}

export async function check_credits(ctx) {
  const {store, charge, ledger} = await world(ctx);
  const invoiceId = await charge('2026-03-01', '2026-04-01', 9900);
  const credit = await store.grantCredit(invoiceId, 500, 'service outage');
  const [line] = await ledger();
  assert.equal(line.amount_cents, 9900, \`an invoice billed 9900 with a 500 credit reads amount_cents \${line.amount_cents}: the amount stays what was billed\`);
  assert.deepEqual(line.credits, [credit], \`the invoice's credits read \${JSON.stringify(line.credits)}, expected the credit as its own line \${JSON.stringify([credit])}\`);
}

export async function check_reconciled(ctx) {
  const {store, charge, ledger} = await world(ctx);
  const once = await charge('2026-01-01', '2026-02-01', 9900);
  const twice = await charge('2026-02-01', '2026-03-01', 9900, 19800);
  const unknown = (await store.openInvoice('sub_1', '2026-03-01', '2026-04-01', 9900)).invoice_id;
  const invoices = Object.fromEntries((await ledger()).map(i => [i.invoice_id, i]));
  assert(invoices[once].processor_total_cents === 9900 && invoices[once].reconciled === true, \`an invoice the processor charged once reads \${JSON.stringify(invoices[once])}, expected processor_total_cents 9900 and reconciled true\`);
  assert(invoices[twice].processor_total_cents === 19800 && invoices[twice].reconciled === false, \`an invoice the processor charged twice reads \${JSON.stringify(invoices[twice])}, expected processor_total_cents 19800 and reconciled false\`);
  assert(invoices[unknown].processor_total_cents === 0 && invoices[unknown].reconciled === false, \`an invoice the processor never charged reads \${JSON.stringify(invoices[unknown])}, expected processor_total_cents 0 and reconciled false\`);
  assert.equal(ctx.grpc.callsTo('Charge').length, 0, 'a ledger read must not charge');
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "billing/gen/subscription_billing"
	"billing/store"

	"leetbuild/harness"
)

var readBg = context.Background()

type readCharge struct {
	reference string
	total     int64
}

// readPeer answers GetInvoice from what it charged: totals per invoice id.
type readPeer struct {
	pb.UnimplementedProcessorServer
	charged map[string]readCharge
}

func (p *readPeer) GetInvoice(_ context.Context, req *pb.GetInvoiceRequest) (*pb.ProcessorInvoice, error) {
	found, ok := p.charged[req.GetInvoiceId()]
	if !ok {
		return nil, status.Errorf(codes.NotFound, "no charge for %s", req.GetInvoiceId())
	}
	return &pb.ProcessorInvoice{InvoiceId: req.GetInvoiceId(), State: "charged", Reference: found.reference, TotalCents: found.total}, nil
}

type readLine struct {
	InvoiceID           string         \`json:"invoice_id"\`
	State               string         \`json:"state"\`
	Reference           string         \`json:"reference"\`
	AmountCents         int64          \`json:"amount_cents"\`
	Credits             []store.Credit \`json:"credits"\`
	ProcessorTotalCents *int64         \`json:"processor_total_cents"\`
	Reconciled          *bool          \`json:"reconciled"\`
}

func readWorld(ctx *harness.Ctx) (*harness.HTTP, *readPeer) {
	p := &readPeer{charged: map[string]readCharge{}}
	pb.RegisterProcessorServer(ctx.GRPC.Server(""), p)
	store.PutSubscription(readBg, "sub_1", "t-acme", "scale", "2026-02-01", "2026-04-01")
	store.PutSubscription(readBg, "sub_2", "t-other", "scale", "2026-02-01", "2026-04-01")
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux), p
}

// readCharged stores a charged invoice the processor holds for total.
func readCharged(p *readPeer, subscriptionID, periodStart, periodEnd string, amount, total int64) string {
	invoice := store.OpenInvoice(readBg, subscriptionID, periodStart, periodEnd, amount)
	reference := "ch_" + invoice.InvoiceID
	store.MarkCharged(readBg, invoice.InvoiceID, reference)
	p.charged[invoice.InvoiceID] = readCharge{reference, total}
	return invoice.InvoiceID
}

func readLedger(ctx *harness.Ctx, c *harness.HTTP) []readLine {
	r := c.Get("/v1/subscriptions/sub_1/invoices", "X-Tenant-Id", "t-acme")
	ctx.Equal(r.Status, 200, "GET /v1/subscriptions/sub_1/invoices (%s)", r.Text())
	var body struct {
		Invoices []readLine \`json:"invoices"\`
	}
	r.Decode(&body)
	return body.Invoices
}

func CheckRoute(ctx *harness.Ctx) {
	c, p := readWorld(ctx)
	first := readCharged(p, "sub_1", "2026-02-01", "2026-03-01", 9900, 9900)
	second := readCharged(p, "sub_1", "2026-03-01", "2026-04-01", 9900, 9900)
	invoices := readLedger(ctx, c)
	var ids []string
	for _, i := range invoices {
		ids = append(ids, i.InvoiceID)
	}
	ctx.Equal(ids, []string{first, second}, "the ledger must list the invoices oldest first")
	ctx.Assert(invoices[0].Reference == "ch_"+first && invoices[0].State == "charged", "the first invoice reads %+v", invoices[0])
}

func CheckTenant(ctx *harness.Ctx) {
	c, p := readWorld(ctx)
	readCharged(p, "sub_2", "2026-03-01", "2026-04-01", 9900, 9900)
	anonymous := c.Get("/v1/subscriptions/sub_1/invoices")
	ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id")
	foreign := c.Get("/v1/subscriptions/sub_2/invoices", "X-Tenant-Id", "t-acme")
	ctx.Equal(foreign.Status, 404, "t-acme reading t-other's subscription")
	ctx.Assert(!strings.Contains(foreign.Text(), "in_"), "the foreign read leaked invoices: %s", foreign.Text())
	missing := c.Get("/v1/subscriptions/sub_9/invoices", "X-Tenant-Id", "t-acme")
	ctx.Equal(missing.Status, 404, "a missing subscription")
}

func CheckStoredInvoices(ctx *harness.Ctx) {
	c, p := readWorld(ctx)
	prorated := readCharged(p, "sub_1", "2026-03-01", "2026-04-01", 4790, 4790)
	invoices := readLedger(ctx, c)
	ctx.Assert(len(invoices) == 1 && invoices[0].AmountCents == 4790, "the prorated invoice %s was billed 4790 cents and the ledger reports %+v: report the stored amount, not the plan price", prorated, invoices)
}

func CheckCredits(ctx *harness.Ctx) {
	c, p := readWorld(ctx)
	invoiceID := readCharged(p, "sub_1", "2026-03-01", "2026-04-01", 9900, 9900)
	credit := store.GrantCredit(readBg, invoiceID, 500, "service outage")
	line := readLedger(ctx, c)[0]
	ctx.Equal(line.AmountCents, int64(9900), "an invoice billed 9900 with a 500 credit: the amount stays what was billed; amount_cents")
	ctx.Equal(line.Credits, []store.Credit{credit}, "the credit must be listed as its own line; credits")
}

func CheckReconciled(ctx *harness.Ctx) {
	c, p := readWorld(ctx)
	once := readCharged(p, "sub_1", "2026-01-01", "2026-02-01", 9900, 9900)
	twice := readCharged(p, "sub_1", "2026-02-01", "2026-03-01", 9900, 19800)
	unknown := store.OpenInvoice(readBg, "sub_1", "2026-03-01", "2026-04-01", 9900).InvoiceID
	invoices := map[string]readLine{}
	for _, i := range readLedger(ctx, c) {
		invoices[i.InvoiceID] = i
	}
	tiesOut := func(id string, total int64, reconciled bool, what string) {
		line := invoices[id]
		ctx.Assert(line.ProcessorTotalCents != nil && *line.ProcessorTotalCents == total && line.Reconciled != nil && *line.Reconciled == reconciled,
			"an invoice the processor %s must read processor_total_cents %d and reconciled %t, got %+v", what, total, reconciled, line)
	}
	tiesOut(once, 9900, true, "charged once")
	tiesOut(twice, 19800, false, "charged twice")
	tiesOut(unknown, 0, false, "never charged")
	ctx.Equal(len(ctx.GRPC.CallsTo("Charge", "")), 0, "a ledger read must not charge; Charge calls")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <map>
#include <string>
#include <vector>

#include "billing/store.h"
#include "subscription_billing.grpc.pb.h"

namespace {

struct ReadCharge {
  std::string reference;
  long long total = 0;
};

// Answers GetInvoice from what it charged: totals per invoice id.
class ReadPeer final : public subbilling::Processor::Service {
 public:
  std::map<std::string, ReadCharge> charged;

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

ReadPeer& readWorld(harness::Ctx& ctx) {
  static ReadPeer* peer = nullptr;
  delete peer;
  peer = new ReadPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  store::putSubscription("sub_1", "t-acme", "scale", "2026-02-01", "2026-04-01");
  store::putSubscription("sub_2", "t-other", "scale", "2026-02-01", "2026-04-01");
  return *peer;
}

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

// A stored, charged invoice the processor holds for total.
std::string readCharged(ReadPeer& peer, const std::string& subscription_id, const std::string& start, const std::string& stop, long long amount,
                        long long total) {
  const store::Invoice invoice = store::openInvoice(subscription_id, start, stop, amount);
  const std::string reference = "ch_" + invoice.invoice_id;
  store::markCharged(invoice.invoice_id, reference);
  peer.charged[invoice.invoice_id] = {reference, total};
  return invoice.invoice_id;
}

nlohmann::json readLedger(harness::Ctx& ctx, harness::HTTP& c) {
  const auto r = c.Get("/v1/subscriptions/sub_1/invoices", "X-Tenant-Id", "t-acme");
  ctx.Equal(r.Status, 200, "GET /v1/subscriptions/sub_1/invoices (%s)", r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object() && body.contains("invoices") && body["invoices"].is_array(), "the answer must carry an invoices list, got %s", r.Text());
  return body["invoices"];
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  ReadPeer& peer = readWorld(ctx);
  auto c = api(ctx);
  const std::string first = readCharged(peer, "sub_1", "2026-02-01", "2026-03-01", 9900, 9900);
  const std::string second = readCharged(peer, "sub_1", "2026-03-01", "2026-04-01", 9900, 9900);
  const auto invoices = readLedger(ctx, c);
  std::vector<std::string> ids;
  for (const auto& i : invoices) ids.push_back(i.value("invoice_id", ""));
  ctx.Equal(ids, {first, second}, "the ledger must list the invoices oldest first");
  ctx.Assert(invoices[0].value("reference", "") == "ch_" + first && invoices[0].value("state", "") == "charged", "the first invoice reads %s", invoices[0].dump());
}

void CheckTenant(harness::Ctx& ctx) {
  ReadPeer& peer = readWorld(ctx);
  auto c = api(ctx);
  readCharged(peer, "sub_2", "2026-03-01", "2026-04-01", 9900, 9900);
  const auto anonymous = c.Get("/v1/subscriptions/sub_1/invoices");
  ctx.Equal(anonymous.Status, 401, "a read without X-Tenant-Id");
  const auto foreign = c.Get("/v1/subscriptions/sub_2/invoices", "X-Tenant-Id", "t-acme");
  ctx.Equal(foreign.Status, 404, "t-acme reading t-other's subscription");
  ctx.Assert(foreign.Text().find("in_") == std::string::npos, "the foreign read leaked invoices: %s", foreign.Text());
  const auto missing = c.Get("/v1/subscriptions/sub_9/invoices", "X-Tenant-Id", "t-acme");
  ctx.Equal(missing.Status, 404, "a missing subscription");
}

void CheckStoredInvoices(harness::Ctx& ctx) {
  ReadPeer& peer = readWorld(ctx);
  auto c = api(ctx);
  const std::string prorated = readCharged(peer, "sub_1", "2026-03-01", "2026-04-01", 4790, 4790);
  const auto invoices = readLedger(ctx, c);
  ctx.Assert(invoices.size() == 1 && invoices[0].value("amount_cents", 0LL) == 4790,
             "the prorated invoice %s was billed 4790 cents and the ledger reports %s: report the stored amount, not the plan price", prorated, invoices.dump());
}

void CheckCredits(harness::Ctx& ctx) {
  ReadPeer& peer = readWorld(ctx);
  auto c = api(ctx);
  const std::string invoice_id = readCharged(peer, "sub_1", "2026-03-01", "2026-04-01", 9900, 9900);
  const store::Credit credit = store::grantCredit(invoice_id, 500, "service outage");
  const auto line = readLedger(ctx, c)[0];
  ctx.Equal(line.value("amount_cents", 0LL), 9900LL, "an invoice billed 9900 with a 500 credit: the amount stays what was billed; amount_cents");
  nlohmann::json want = nlohmann::json::array();
  want.push_back(nlohmann::json{{"credit_id", credit.credit_id}, {"amount_cents", 500}, {"reason", "service outage"}});
  ctx.Assert(line.contains("credits") && line["credits"] == want, "the invoice's credits read %s, expected the credit as its own line %s",
             line.contains("credits") ? line["credits"].dump() : "nothing", want.dump());
}

void CheckReconciled(harness::Ctx& ctx) {
  ReadPeer& peer = readWorld(ctx);
  auto c = api(ctx);
  const std::string once = readCharged(peer, "sub_1", "2026-01-01", "2026-02-01", 9900, 9900);
  const std::string twice = readCharged(peer, "sub_1", "2026-02-01", "2026-03-01", 9900, 19800);
  const std::string unknown = store::openInvoice("sub_1", "2026-03-01", "2026-04-01", 9900).invoice_id;
  std::map<std::string, nlohmann::json> invoices;
  for (const auto& i : readLedger(ctx, c)) invoices[i.value("invoice_id", "")] = i;
  const auto tiesOut = [&](const std::string& id, long long total, bool reconciled, const std::string& what) {
    const auto& line = invoices[id];
    const bool ok = line.is_object() && line.contains("processor_total_cents") && line["processor_total_cents"] == total &&
                    line.contains("reconciled") && line["reconciled"] == reconciled;
    ctx.Assert(ok, "an invoice the processor %s must read processor_total_cents %d and reconciled %t, got %s", what, total, reconciled, line.dump());
  };
  tiesOut(once, 9900, true, "charged once");
  tiesOut(twice, 19800, false, "charged twice");
  tiesOut(unknown, 0, false, "never charged");
  ctx.Equal(ctx.GRPC.CallsTo("Charge").size(), 0, "a ledger read must not charge; Charge calls");
}
`,
  },
  hints: [
    'A customer whose plan changed mid-period sees the full plan price on the invoice; one with a 500-cent credit sees a smaller amount and no credit; any caller who knows a subscription id reads its ledger.',
    'The amount is recomputed as `plan_price - credited` instead of read from the invoice row; the credits are summed away; nothing reads `X-Tenant-Id`, and nothing asks the processor what it charged.',
    'Check `X-Tenant-Id` (401) against `subscription["tenant"]` (404); answer `invoice["amount_cents"]`, `credits_of(invoice_id)` as `credits`, and `processor_total_cents` from `lookup_invoice` (0 when None) with `reconciled` when it equals the amount.',
  ],
  debrief: `A read that reports money and a read that invents it look identical on a seeded demo, which is why the fix is about sources. The stored invoice is the record of what was billed; a recomputation from the plan price is a second opinion that drifts at the first proration. Credits stay visible because a customer who cannot see a credit cannot check it. Putting the processor's own total next to the stored amount moves a disagreement, such as a double charge, into the response a support agent is already reading. Billing systems run the same comparison in bulk against the processor's settlement files and raise the mismatches as tasks rather than leaving them to whoever happens to open the page.`,
};
