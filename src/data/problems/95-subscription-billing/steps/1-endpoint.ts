import type {Step} from '@/lib/types';

export const changePlanStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/subscriptions: plan changes prorated over the real period',
  concept: 'http',
  file: 'api',
  focus: ['client', 'billing', 'db'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/subscriptions\` with a body \`{subscription_id, plan,
effective_date, proration_policy}\`: it loads the subscription (\`billing.store\`, provided), takes
\`now\` as today (\`billing.dates\`) and any other value as the change date, prices an old-plan line
and a new-plan line, opens the period's invoice for the total and answers \`{subscription_id, plan,
effective_at, lines, total_cents, invoice_id}\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** Any caller changes any tenant's plan; a date the period cannot
place, a policy nobody implemented or a plan with no price reaches an invoice; a 31-day period is
priced as 30 days; and the switch day is billed on both plans.

- \`X-Tenant-Id\` is required (**401**); another tenant's subscription is **404**.
- \`plan\` must have a price (\`store.plan_price\`), \`proration_policy\` must be in
  \`PRORATION_POLICIES\`, and \`effective_date\` is \`now\` or the subscription's \`period_end\` (the
  next period start); anything else is **400**.
- Prorate over the period's own length, \`period_days = dates.days_between(period_start,
  period_end)\`: a line is \`round(price * days / period_days)\`.
- Periods are half-open: the old plan covers \`[period_start, change_at)\`, the new plan
  \`[change_at, period_end)\`, so the two lines' days add up to the period.`,
  sequence: {
    participants: ['Client', 'Billing Service', 'billing store'],
    messages: [
      {
        from: 'Client',
        to: 'Billing Service',
        label: 'POST /v1/subscriptions · X-Tenant-Id · plan · effective_date',
        kind: 'sync',
      },
      {from: 'Billing Service', to: 'billing store', label: 'find_subscription(id) · tenant, period', kind: 'sync'},
      {
        from: 'Billing Service',
        to: 'Billing Service',
        label: 'tenant → 401/404 · plan, policy, date → 400',
        kind: 'sync',
      },
      {
        from: 'Billing Service',
        to: 'Billing Service',
        label: '[start, change) old · [change, end) new · ÷ period_days',
        kind: 'sync',
      },
      {from: 'Billing Service', to: 'billing store', label: 'open_invoice(period, total)', kind: 'sync'},
      {from: 'Billing Service', to: 'Client', label: '200 {lines, total_cents, invoice_id}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Prices a plan change and opens the invoice',
      detail:
        'Register `POST /v1/subscriptions`: a change answers an old-plan line, a new-plan line, their total, and the id of the invoice it opened for that total.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/subscriptions["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/subscriptions['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/subscriptions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"subscriptions"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/subscriptions"/]},
      },
    },
    {
      id: 'tenant',
      title: 'Authenticates the tenant',
      detail:
        "A change without `X-Tenant-Id` is **401**, and a subscription owned by another tenant is **404** with no invoice opened; the starter never reads the header, so any caller re-prices any tenant's subscription.",
      match: {
        python: {all: [/x-tenant-id/i, /\b401\b/, /\[["']tenant["']\]/]},
        typescript: {all: [/x-tenant-id/i, /\b401\b/, /\.tenant\b/]},
        go: {all: [/X-Tenant-Id/i, /StatusUnauthorized|\b401\b/, /\.Tenant\b/]},
        scala: {all: [/X-Tenant-Id/i, /Unauthorized|\b401\b/, /\.tenant\b/]},
        cpp: {all: [/X-Tenant-Id/i, /\b401\b/, /(->|\.)tenant\b/]},
      },
    },
    {
      id: 'effective-date',
      title: 'Rejects a date, policy or plan it cannot price',
      detail:
        "`effective_date` is `now` or the subscription's `period_end`, `proration_policy` is one of `PRORATION_POLICIES` and `plan` has a price; anything else is **400** and opens no invoice. The starter prices whatever it is sent.",
      match: {
        python: {all: [/not in PRORATION_POLICIES/, /\b400\b/]},
        typescript: {all: [/PRORATION_POLICIES\.includes\(/, /\b400\b/]},
        go: {all: [/prorationPolicies\[/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/ProrationPolicies\.contains\(/, /BadRequest|\b400\b/]},
        cpp: {all: [/kProrationPolicies\.(count|find|contains)\(/, /\b400\b/]},
      },
    },
    {
      id: 'actual-days',
      title: 'Prorates over the actual days of the period',
      detail:
        "The divisor is the period's own length, `days_between(period_start, period_end)`: 31 for a 31-day period, 28 for February. The starter divides by `MONTH_DAYS = 30`.",
      match: {
        python: {all: [/days_between\([^,\n]*period_start\s*,[^)\n]*period_end\s*\)/], none: [/MONTH_DAYS/]},
        typescript: {all: [/daysBetween\([^,\n]*period_start\s*,[^)\n]*period_end\s*\)/], none: [/MONTH_DAYS/]},
        go: {all: [/DaysBetween\([^,\n]*PeriodStart\s*,[^)\n]*PeriodEnd\s*\)/], none: [/monthDays/]},
        scala: {all: [/daysBetween\([^,\n]*periodStart\s*,[^)\n]*periodEnd\s*\)/], none: [/MonthDays/]},
        cpp: {all: [/daysBetween\([^,\n]*period_start\s*,[^)\n]*period_end\s*\)/], none: [/kMonthDays/]},
      },
    },
    {
      id: 'exclusive-day',
      title: 'Charges the switch day exactly once',
      detail:
        'The old plan covers `[period_start, change_at)` and the new plan `[change_at, period_end)`, so their days add up to the period. The starter counts the old plan through the switch day (`+ 1`), billing that day on both plans.',
      match: {
        python: {all: [/days_between\(/], none: [/days_between\([^)\n]*\)\s*\+\s*1\b/]},
        typescript: {all: [/daysBetween\(/], none: [/daysBetween\([^)\n]*\)\s*\+\s*1\b/]},
        go: {all: [/DaysBetween\(/], none: [/DaysBetween\([^)\n]*\)\s*\+\s*1\b/]},
        scala: {all: [/daysBetween\(/], none: [/daysBetween\([^)\n]*\)\s*\+\s*1\b/]},
        cpp: {all: [/daysBetween\(/], none: [/daysBetween\([^)\n]*\)\s*\+\s*1\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from billing import dates, store  # dates.today, days_between; store.find_subscription, plan_price, open_invoice

app = FastAPI()

MONTH_DAYS = 30
PRORATION_POLICIES = ("actual_days",)


class PlanChange(BaseModel):
    subscription_id: str
    plan: str
    effective_date: str
    proration_policy: str = "actual_days"


def schedule(subscription: dict, plan: str, change_at: str, lines: list[dict]) -> dict:
    """The answer: the lines, their total, and the period's invoice opened for that total."""
    total = sum(line["amount_cents"] for line in lines)
    invoice = store.open_invoice(subscription["subscription_id"], subscription["period_start"], subscription["period_end"], total)
    return {
        "subscription_id": subscription["subscription_id"],
        "plan": plan,
        "effective_at": change_at,
        "lines": lines,
        "total_cents": total,
        "invoice_id": invoice["invoice_id"],
    }


@app.post("/v1/subscriptions")
def change_plan(body: PlanChange, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    subscription = store.find_subscription(body.subscription_id)
    if subscription is None:
        raise HTTPException(status_code=404, detail="no such subscription")
    change_at = dates.today() if body.effective_date == "now" else body.effective_date
    old_days = dates.days_between(subscription["period_start"], change_at) + 1
    new_days = dates.days_between(change_at, subscription["period_end"])
    old_price = store.plan_price(subscription["plan"])
    new_price = store.plan_price(body.plan)
    lines = [
        {"plan": subscription["plan"], "days": old_days, "amount_cents": round(old_price * old_days / MONTH_DAYS)},
        {"plan": body.plan, "days": new_days, "amount_cents": round(new_price * new_days / MONTH_DAYS)},
    ]
    return schedule(subscription, body.plan, change_at, lines)
`,
      solution: `from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from billing import dates, store  # dates.today, days_between; store.find_subscription, plan_price, open_invoice

app = FastAPI()

PRORATION_POLICIES = ("actual_days",)


class PlanChange(BaseModel):
    subscription_id: str
    plan: str
    effective_date: str
    proration_policy: str = "actual_days"


def schedule(subscription: dict, plan: str, change_at: str, lines: list[dict]) -> dict:
    """The answer: the lines, their total, and the period's invoice opened for that total."""
    total = sum(line["amount_cents"] for line in lines)
    invoice = store.open_invoice(subscription["subscription_id"], subscription["period_start"], subscription["period_end"], total)
    return {
        "subscription_id": subscription["subscription_id"],
        "plan": plan,
        "effective_at": change_at,
        "lines": lines,
        "total_cents": total,
        "invoice_id": invoice["invoice_id"],
    }


@app.post("/v1/subscriptions")
def change_plan(body: PlanChange, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    subscription = store.find_subscription(body.subscription_id)
    if subscription is None or subscription["tenant"] != tenant:
        # Another tenant's subscription answers like a missing one: the id is not confirmed.
        raise HTTPException(status_code=404, detail="no such subscription")
    period_start, period_end = subscription["period_start"], subscription["period_end"]
    new_price = store.plan_price(body.plan)
    if new_price is None:
        raise HTTPException(status_code=400, detail=f"unknown plan {body.plan}")
    if body.proration_policy not in PRORATION_POLICIES:
        raise HTTPException(status_code=400, detail=f"unsupported proration_policy {body.proration_policy}")
    if body.effective_date not in ("now", period_end):
        raise HTTPException(status_code=400, detail="effective_date is now or the next period start")
    change_at = dates.today() if body.effective_date == "now" else period_end
    # Half-open: the old plan covers [period_start, change_at), the new one [change_at, period_end).
    period_days = dates.days_between(period_start, period_end)
    old_days = dates.days_between(period_start, change_at)
    new_days = dates.days_between(change_at, period_end)
    old_price = store.plan_price(subscription["plan"])
    lines = [
        {"plan": subscription["plan"], "days": old_days, "amount_cents": round(old_price * old_days / period_days)},
        {"plan": body.plan, "days": new_days, "amount_cents": round(new_price * new_days / period_days)},
    ]
    return schedule(subscription, body.plan, change_at, lines)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {daysBetween, today} from 'billing/dates';
import {type Subscription, findSubscription, openInvoice, planPrice} from 'billing/store';

export const app = Fastify();

export const MONTH_DAYS = 30;
export const PRORATION_POLICIES = ['actual_days'];

interface PlanChange {
  subscription_id: string;
  plan: string;
  effective_date: string;
  proration_policy?: string;
}

interface Line {
  plan: string;
  days: number;
  amount_cents: number;
}

/** The answer: the lines, their total, and the period's invoice opened for that total. */
async function schedule(subscription: Subscription, plan: string, changeAt: string, lines: Line[]) {
  const total = lines.reduce((sum, line) => sum + line.amount_cents, 0);
  const invoice = await openInvoice(subscription.subscription_id, subscription.period_start, subscription.period_end, total);
  return {subscription_id: subscription.subscription_id, plan, effective_at: changeAt, lines, total_cents: total, invoice_id: invoice.invoice_id};
}

app.post('/v1/subscriptions', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const body = request.body as PlanChange;
  const subscription = await findSubscription(body.subscription_id);
  if (subscription === null) return reply.code(404).send({error: 'no such subscription'});
  const changeAt = body.effective_date === 'now' ? today() : body.effective_date;
  const oldDays = daysBetween(subscription.period_start, changeAt) + 1;
  const newDays = daysBetween(changeAt, subscription.period_end);
  const oldPrice = planPrice(subscription.plan) ?? 0;
  const newPrice = planPrice(body.plan) ?? 0;
  const lines = [
    {plan: subscription.plan, days: oldDays, amount_cents: Math.round((oldPrice * oldDays) / MONTH_DAYS)},
    {plan: body.plan, days: newDays, amount_cents: Math.round((newPrice * newDays) / MONTH_DAYS)},
  ];
  return schedule(subscription, body.plan, changeAt, lines);
});
`,
      solution: `import Fastify from 'fastify';

import {daysBetween, today} from 'billing/dates';
import {type Subscription, findSubscription, openInvoice, planPrice} from 'billing/store';

export const app = Fastify();

export const PRORATION_POLICIES = ['actual_days'];

interface PlanChange {
  subscription_id: string;
  plan: string;
  effective_date: string;
  proration_policy?: string;
}

interface Line {
  plan: string;
  days: number;
  amount_cents: number;
}

/** The answer: the lines, their total, and the period's invoice opened for that total. */
async function schedule(subscription: Subscription, plan: string, changeAt: string, lines: Line[]) {
  const total = lines.reduce((sum, line) => sum + line.amount_cents, 0);
  const invoice = await openInvoice(subscription.subscription_id, subscription.period_start, subscription.period_end, total);
  return {subscription_id: subscription.subscription_id, plan, effective_at: changeAt, lines, total_cents: total, invoice_id: invoice.invoice_id};
}

app.post('/v1/subscriptions', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const body = request.body as PlanChange;
  const subscription = await findSubscription(body.subscription_id);
  // Another tenant's subscription answers like a missing one: the id is not confirmed.
  if (subscription === null || subscription.tenant !== tenant) return reply.code(404).send({error: 'no such subscription'});
  const {period_start, period_end} = subscription;
  const newPrice = planPrice(body.plan);
  if (newPrice === null) return reply.code(400).send({error: \`unknown plan \${body.plan}\`});
  const policy = body.proration_policy ?? 'actual_days';
  if (!PRORATION_POLICIES.includes(policy)) return reply.code(400).send({error: \`unsupported proration_policy \${policy}\`});
  if (body.effective_date !== 'now' && body.effective_date !== period_end) {
    return reply.code(400).send({error: 'effective_date is now or the next period start'});
  }
  const changeAt = body.effective_date === 'now' ? today() : period_end;
  // Half-open: the old plan covers [period_start, changeAt), the new one [changeAt, period_end).
  const periodDays = daysBetween(period_start, period_end);
  const oldDays = daysBetween(period_start, changeAt);
  const newDays = daysBetween(changeAt, period_end);
  const oldPrice = planPrice(subscription.plan) ?? 0;
  const lines = [
    {plan: subscription.plan, days: oldDays, amount_cents: Math.round((oldPrice * oldDays) / periodDays)},
    {plan: body.plan, days: newDays, amount_cents: Math.round((newPrice * newDays) / periodDays)},
  ];
  return schedule(subscription, body.plan, changeAt, lines);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"math"
	"net/http"

	"billing/dates" // dates.Today, DaysBetween
	"billing/store" // store.FindSubscription, PlanPrice, OpenInvoice
)

const monthDays = 30

var prorationPolicies = map[string]bool{"actual_days": true}

type planChange struct {
	SubscriptionID  string \`json:"subscription_id"\`
	Plan            string \`json:"plan"\`
	EffectiveDate   string \`json:"effective_date"\`
	ProrationPolicy string \`json:"proration_policy"\`
}

type line struct {
	Plan        string \`json:"plan"\`
	Days        int    \`json:"days"\`
	AmountCents int64  \`json:"amount_cents"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func prorate(price int64, days, over int) int64 {
	return int64(math.Round(float64(price) * float64(days) / float64(over)))
}

// schedule answers the lines, their total, and the period's invoice opened for that total.
func schedule(rw http.ResponseWriter, r *http.Request, sub *store.Subscription, plan, changeAt string, lines []line) {
	var total int64
	for _, l := range lines {
		total += l.AmountCents
	}
	invoice := store.OpenInvoice(r.Context(), sub.SubscriptionID, sub.PeriodStart, sub.PeriodEnd, total)
	writeJSON(rw, http.StatusOK, map[string]any{
		"subscription_id": sub.SubscriptionID, "plan": plan, "effective_at": changeAt, "lines": lines, "total_cents": total, "invoice_id": invoice.InvoiceID,
	})
}

func changePlan(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	var body planChange
	json.NewDecoder(r.Body).Decode(&body)
	sub := store.FindSubscription(r.Context(), body.SubscriptionID)
	if sub == nil {
		http.Error(rw, "no such subscription", http.StatusNotFound)
		return
	}
	changeAt := body.EffectiveDate
	if changeAt == "now" {
		changeAt = dates.Today()
	}
	oldDays := dates.DaysBetween(sub.PeriodStart, changeAt) + 1
	newDays := dates.DaysBetween(changeAt, sub.PeriodEnd)
	oldPrice, _ := store.PlanPrice(sub.Plan)
	newPrice, _ := store.PlanPrice(body.Plan)
	lines := []line{
		{Plan: sub.Plan, Days: oldDays, AmountCents: prorate(oldPrice, oldDays, monthDays)},
		{Plan: body.Plan, Days: newDays, AmountCents: prorate(newPrice, newDays, monthDays)},
	}
	schedule(rw, r, sub, body.Plan, changeAt, lines)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/subscriptions", changePlan)
}
`,
      solution: `package main

import (
	"encoding/json"
	"math"
	"net/http"

	"billing/dates" // dates.Today, DaysBetween
	"billing/store" // store.FindSubscription, PlanPrice, OpenInvoice
)

var prorationPolicies = map[string]bool{"actual_days": true}

type planChange struct {
	SubscriptionID  string \`json:"subscription_id"\`
	Plan            string \`json:"plan"\`
	EffectiveDate   string \`json:"effective_date"\`
	ProrationPolicy string \`json:"proration_policy"\`
}

type line struct {
	Plan        string \`json:"plan"\`
	Days        int    \`json:"days"\`
	AmountCents int64  \`json:"amount_cents"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func prorate(price int64, days, over int) int64 {
	return int64(math.Round(float64(price) * float64(days) / float64(over)))
}

// schedule answers the lines, their total, and the period's invoice opened for that total.
func schedule(rw http.ResponseWriter, r *http.Request, sub *store.Subscription, plan, changeAt string, lines []line) {
	var total int64
	for _, l := range lines {
		total += l.AmountCents
	}
	invoice := store.OpenInvoice(r.Context(), sub.SubscriptionID, sub.PeriodStart, sub.PeriodEnd, total)
	writeJSON(rw, http.StatusOK, map[string]any{
		"subscription_id": sub.SubscriptionID, "plan": plan, "effective_at": changeAt, "lines": lines, "total_cents": total, "invoice_id": invoice.InvoiceID,
	})
}

func changePlan(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	var body planChange
	json.NewDecoder(r.Body).Decode(&body)
	sub := store.FindSubscription(r.Context(), body.SubscriptionID)
	if sub == nil || sub.Tenant != tenant {
		// Another tenant's subscription answers like a missing one: the id is not confirmed.
		http.Error(rw, "no such subscription", http.StatusNotFound)
		return
	}
	newPrice, ok := store.PlanPrice(body.Plan)
	if !ok {
		http.Error(rw, "unknown plan "+body.Plan, http.StatusBadRequest)
		return
	}
	policy := body.ProrationPolicy
	if policy == "" {
		policy = "actual_days"
	}
	if !prorationPolicies[policy] {
		http.Error(rw, "unsupported proration_policy "+policy, http.StatusBadRequest)
		return
	}
	if body.EffectiveDate != "now" && body.EffectiveDate != sub.PeriodEnd {
		http.Error(rw, "effective_date is now or the next period start", http.StatusBadRequest)
		return
	}
	changeAt := sub.PeriodEnd
	if body.EffectiveDate == "now" {
		changeAt = dates.Today()
	}
	// Half-open: the old plan covers [PeriodStart, changeAt), the new one [changeAt, PeriodEnd).
	periodDays := dates.DaysBetween(sub.PeriodStart, sub.PeriodEnd)
	oldDays := dates.DaysBetween(sub.PeriodStart, changeAt)
	newDays := dates.DaysBetween(changeAt, sub.PeriodEnd)
	oldPrice, _ := store.PlanPrice(sub.Plan)
	lines := []line{
		{Plan: sub.Plan, Days: oldDays, AmountCents: prorate(oldPrice, oldDays, periodDays)},
		{Plan: body.Plan, Days: newDays, AmountCents: prorate(newPrice, newDays, periodDays)},
	}
	schedule(rw, r, sub, body.Plan, changeAt, lines)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/subscriptions", changePlan)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import billing.{Dates, Store} // Dates.today, daysBetween; Store.findSubscription, planPrice, openInvoice

object Api {
  val MonthDays = 30
  val ProrationPolicies: Set[String] = Set("actual_days")

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(body: JsObject, name: String): Option[String] = body.fields.get(name).collect { case JsString(s) => s }

  private def line(plan: String, days: Long, amountCents: Long): JsObject =
    JsObject("plan" -> JsString(plan), "days" -> JsNumber(days), "amount_cents" -> JsNumber(amountCents))

  /** The answer: the lines, their total, and the period's invoice opened for that total. */
  private def schedule(subscription: Store.Subscription, plan: String, changeAt: String, lines: Seq[JsObject]): JsObject = {
    val total = lines.map(_.fields("amount_cents").asInstanceOf[JsNumber].value.toLong).sum
    val invoice = Store.openInvoice(subscription.subscriptionId, subscription.periodStart, subscription.periodEnd, total)
    JsObject("subscription_id" -> JsString(subscription.subscriptionId), "plan" -> JsString(plan), "effective_at" -> JsString(changeAt),
      "lines" -> JsArray(lines.toVector), "total_cents" -> JsNumber(total), "invoice_id" -> JsString(invoice.invoiceId))
  }

  val route: Route =
    path("v1" / "subscriptions") {
      post {
        entity(as[String]) { raw =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val body = raw.parseJson.asJsObject
          Store.findSubscription(text(body, "subscription_id").getOrElse("")) match {
            case None => complete(json(StatusCodes.NotFound, JsObject("error" -> JsString("no such subscription"))))
            case Some(subscription) =>
              val plan = text(body, "plan").getOrElse("")
              val effective = text(body, "effective_date").getOrElse("")
              val changeAt = if (effective == "now") Dates.today() else effective
              val oldDays = Dates.daysBetween(subscription.periodStart, changeAt) + 1
              val newDays = Dates.daysBetween(changeAt, subscription.periodEnd)
              val oldPrice = Store.planPrice(subscription.plan).getOrElse(0L)
              val newPrice = Store.planPrice(plan).getOrElse(0L)
              val lines = Seq(
                line(subscription.plan, oldDays, math.round(oldPrice.toDouble * oldDays / MonthDays)),
                line(plan, newDays, math.round(newPrice.toDouble * newDays / MonthDays)))
              complete(json(StatusCodes.OK, schedule(subscription, plan, changeAt, lines)))
          }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import billing.{Dates, Store} // Dates.today, daysBetween; Store.findSubscription, planPrice, openInvoice

object Api {
  val ProrationPolicies: Set[String] = Set("actual_days")

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  private def text(body: JsObject, name: String): Option[String] = body.fields.get(name).collect { case JsString(s) => s }

  private def line(plan: String, days: Long, amountCents: Long): JsObject =
    JsObject("plan" -> JsString(plan), "days" -> JsNumber(days), "amount_cents" -> JsNumber(amountCents))

  /** The answer: the lines, their total, and the period's invoice opened for that total. */
  private def schedule(subscription: Store.Subscription, plan: String, changeAt: String, lines: Seq[JsObject]): JsObject = {
    val total = lines.map(_.fields("amount_cents").asInstanceOf[JsNumber].value.toLong).sum
    val invoice = Store.openInvoice(subscription.subscriptionId, subscription.periodStart, subscription.periodEnd, total)
    JsObject("subscription_id" -> JsString(subscription.subscriptionId), "plan" -> JsString(plan), "effective_at" -> JsString(changeAt),
      "lines" -> JsArray(lines.toVector), "total_cents" -> JsNumber(total), "invoice_id" -> JsString(invoice.invoiceId))
  }

  private def change(tenant: String, body: JsObject): HttpResponse =
    // Another tenant's subscription answers like a missing one: the id is not confirmed.
    Store.findSubscription(text(body, "subscription_id").getOrElse("")).filter(_.tenant == tenant) match {
      case None => error(StatusCodes.NotFound, "no such subscription")
      case Some(subscription) =>
        val plan = text(body, "plan").getOrElse("")
        val policy = text(body, "proration_policy").getOrElse("actual_days")
        val effective = text(body, "effective_date").getOrElse("")
        (Store.planPrice(plan), Store.planPrice(subscription.plan)) match {
          case (None, _) => error(StatusCodes.BadRequest, s"unknown plan $plan")
          case _ if !ProrationPolicies.contains(policy) => error(StatusCodes.BadRequest, s"unsupported proration_policy $policy")
          case _ if effective != "now" && effective != subscription.periodEnd => error(StatusCodes.BadRequest, "effective_date is now or the next period start")
          case (Some(newPrice), oldPrice) =>
            val changeAt = if (effective == "now") Dates.today() else subscription.periodEnd
            // Half-open: the old plan covers [periodStart, changeAt), the new one [changeAt, periodEnd).
            val periodDays = Dates.daysBetween(subscription.periodStart, subscription.periodEnd)
            val oldDays = Dates.daysBetween(subscription.periodStart, changeAt)
            val newDays = Dates.daysBetween(changeAt, subscription.periodEnd)
            val lines = Seq(
              line(subscription.plan, oldDays, math.round(oldPrice.getOrElse(0L).toDouble * oldDays / periodDays)),
              line(plan, newDays, math.round(newPrice.toDouble * newDays / periodDays)))
            json(StatusCodes.OK, schedule(subscription, plan, changeAt, lines))
        }
    }

  val route: Route =
    path("v1" / "subscriptions") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => complete(error(StatusCodes.Unauthorized, "X-Tenant-Id is required"))
          case Some(tenant) => entity(as[String]) { raw => complete(change(tenant, raw.parseJson.asJsObject)) }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cmath>
#include <set>
#include <string>

#include "billing/dates.h"  // dates::today, daysBetween
#include "billing/store.h"  // store::findSubscription, planPrice, openInvoice

using json = nlohmann::json;

constexpr long kMonthDays = 30;
const std::set<std::string> kProrationPolicies = {"actual_days"};

json line(const std::string& plan, long days, long long amount_cents) {
  return json{{"plan", plan}, {"days", days}, {"amount_cents", amount_cents}};
}

long long prorate(long long price, long days, long over) { return std::llround(static_cast<double>(price) * days / over); }

// The answer: the lines, their total, and the period's invoice opened for that total.
json schedule(const store::Subscription& subscription, const std::string& plan, const std::string& change_at, const json& lines) {
  long long total = 0;
  for (const json& l : lines) total += l["amount_cents"].get<long long>();
  const store::Invoice invoice = store::openInvoice(subscription.subscription_id, subscription.period_start, subscription.period_end, total);
  return json{{"subscription_id", subscription.subscription_id}, {"plan", plan}, {"effective_at", change_at},
              {"lines", lines}, {"total_cents", total}, {"invoice_id", invoice.invoice_id}};
}

void change_plan(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body);
  const auto subscription = store::findSubscription(body.value("subscription_id", ""));
  if (!subscription) {
    res.status = 404;
    res.set_content("no such subscription", "text/plain");
    return;
  }
  const std::string plan = body.value("plan", "");
  const std::string effective = body.value("effective_date", "");
  const std::string change_at = effective == "now" ? dates::today() : effective;
  const long old_days = dates::daysBetween(subscription->period_start, change_at) + 1;
  const long new_days = dates::daysBetween(change_at, subscription->period_end);
  const long long old_price = store::planPrice(subscription->plan).value_or(0);
  const long long new_price = store::planPrice(plan).value_or(0);
  const json lines = json::array({line(subscription->plan, old_days, prorate(old_price, old_days, kMonthDays)),
                                  line(plan, new_days, prorate(new_price, new_days, kMonthDays))});
  res.set_content(schedule(*subscription, plan, change_at, lines).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/subscriptions", change_plan);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cmath>
#include <set>
#include <string>

#include "billing/dates.h"  // dates::today, daysBetween
#include "billing/store.h"  // store::findSubscription, planPrice, openInvoice

using json = nlohmann::json;

const std::set<std::string> kProrationPolicies = {"actual_days"};

json line(const std::string& plan, long days, long long amount_cents) {
  return json{{"plan", plan}, {"days", days}, {"amount_cents", amount_cents}};
}

long long prorate(long long price, long days, long over) { return std::llround(static_cast<double>(price) * days / over); }

// The answer: the lines, their total, and the period's invoice opened for that total.
json schedule(const store::Subscription& subscription, const std::string& plan, const std::string& change_at, const json& lines) {
  long long total = 0;
  for (const json& l : lines) total += l["amount_cents"].get<long long>();
  const store::Invoice invoice = store::openInvoice(subscription.subscription_id, subscription.period_start, subscription.period_end, total);
  return json{{"subscription_id", subscription.subscription_id}, {"plan", plan}, {"effective_at", change_at},
              {"lines", lines}, {"total_cents", total}, {"invoice_id", invoice.invoice_id}};
}

void reject(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(message, "text/plain");
}

void change_plan(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reject(res, 401, "X-Tenant-Id is required");
  const json body = json::parse(req.body);
  const auto subscription = store::findSubscription(body.value("subscription_id", ""));
  // Another tenant's subscription answers like a missing one: the id is not confirmed.
  if (!subscription || subscription->tenant != tenant) return reject(res, 404, "no such subscription");
  const std::string plan = body.value("plan", "");
  const auto new_price = store::planPrice(plan);
  if (!new_price) return reject(res, 400, "unknown plan " + plan);
  const std::string policy = body.value("proration_policy", "actual_days");
  if (!kProrationPolicies.count(policy)) return reject(res, 400, "unsupported proration_policy " + policy);
  const std::string effective = body.value("effective_date", "");
  if (effective != "now" && effective != subscription->period_end) {
    return reject(res, 400, "effective_date is now or the next period start");
  }
  const std::string change_at = effective == "now" ? dates::today() : subscription->period_end;
  // Half-open: the old plan covers [period_start, change_at), the new one [change_at, period_end).
  const long period_days = dates::daysBetween(subscription->period_start, subscription->period_end);
  const long old_days = dates::daysBetween(subscription->period_start, change_at);
  const long new_days = dates::daysBetween(change_at, subscription->period_end);
  const long long old_price = store::planPrice(subscription->plan).value_or(0);
  const json lines = json::array({line(subscription->plan, old_days, prorate(old_price, old_days, period_days)),
                                  line(plan, new_days, prorate(*new_price, new_days, period_days))});
  res.set_content(schedule(*subscription, plan, change_at, lines).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/subscriptions", change_plan);
}
`,
    },
  },
  harness: {
    python: `from billing import dates, store

OWNER = {"X-Tenant-Id": "t-acme"}


def _seed(subscription_id="sub_1", tenant="t-acme", before=16, after=15):
    """A starter-plan subscription whose period started before days ago and ends after days from today."""
    today = dates.today()
    start, end = dates.add_days(today, -before), dates.add_days(today, after)
    store.put_subscription(subscription_id, tenant, "starter", start, end)
    return start, end


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _change(c, subscription_id="sub_1", plan="scale", effective="now", policy="actual_days", headers=OWNER):
    body = {"subscription_id": subscription_id, "plan": plan, "effective_date": effective, "proration_policy": policy}
    return await c.post("/v1/subscriptions", json=body, headers=headers)


def _lines(r):
    assert r.status_code == 200, f"a plan change from starter to scale answered {r.status_code}: {r.text}"
    lines = r.json().get("lines")
    assert isinstance(lines, list) and len(lines) == 2, f"the answer must carry two lines (old plan, new plan), got {r.text}"
    return lines


async def check_route(ctx):
    _seed()
    async with _api(ctx) as c:
        r = await _change(c)
    lines = _lines(r)
    body = r.json()
    assert [line.get("plan") for line in lines] == ["starter", "scale"], f"the lines are {lines}, expected the starter line then the scale line"
    assert body.get("total_cents") == sum(line["amount_cents"] for line in lines), f"total_cents {body.get('total_cents')} is not the sum of the lines {lines}"
    invoice = store.find_invoice(body.get("invoice_id", ""))
    assert invoice is not None and invoice["amount_cents"] == body["total_cents"], f"the change must open the period's invoice for the total, the store holds {invoice}"


async def check_tenant(ctx):
    _seed()
    _seed("sub_2", tenant="t-other")
    async with _api(ctx) as c:
        anonymous = await _change(c, headers={})
        assert anonymous.status_code == 401, f"a plan change without X-Tenant-Id answered {anonymous.status_code}, expected 401"
        foreign = await _change(c, subscription_id="sub_2")
        assert foreign.status_code == 404, f"t-acme changing t-other's subscription answered {foreign.status_code}, expected 404"
        assert store.invoices_of("sub_2") == [], f"a foreign tenant's change opened an invoice on sub_2: {store.invoices_of('sub_2')}"
        own = await _change(c)
    assert own.status_code == 200, f"the owner's change answered {own.status_code}: {own.text}"


async def check_effective_date(ctx):
    _, end = _seed()
    async with _api(ctx) as c:
        r = await _change(c, effective=dates.add_days(dates.today(), 3))
        assert r.status_code == 400, f"effective_date three days from now (neither now nor the period end) answered {r.status_code}, expected 400"
        r = await _change(c, policy="thirty_day_month")
        assert r.status_code == 400, f"proration_policy thirty_day_month answered {r.status_code}, expected 400"
        r = await _change(c, plan="enterprise")
        assert r.status_code == 400, f"a plan with no price answered {r.status_code}, expected 400"
        assert store.invoices_of("sub_1") == [], f"a rejected change opened an invoice: {store.invoices_of('sub_1')}"
        r = await _change(c, effective=end)
    assert r.status_code == 200 and r.json().get("effective_at") == end, f"a change at the period end {end} answered {r.status_code} {r.text}"


async def check_actual_days(ctx):
    for subscription_id, before, after in (("sub_1", 16, 15), ("sub_2", 10, 18)):
        _seed(subscription_id, before=before, after=after)
        period = before + after
        async with _api(ctx) as c:
            r = await _change(c, subscription_id=subscription_id)
        for line, price in zip(_lines(r), (1900, 9900)):
            expected = round(price * line["days"] / period)
            assert line["amount_cents"] == expected, f"in a {period}-day period the {line['plan']} line covers {line['days']} days and costs {line['amount_cents']} cents; over the period's {period} days it is {expected}. Divide by the period's own length"


async def check_exclusive_day(ctx):
    start, end = _seed(before=16, after=15)
    async with _api(ctx) as c:
        r = await _change(c)
    old, new = _lines(r)
    assert old["days"] == 16, f"the starter line covers {old['days']} days of [{start}, today): 16 days. The switch day belongs to the new plan"
    assert new["days"] == 15, f"the scale line covers {new['days']} days of [today, {end}), expected 15"
    assert old["days"] + new["days"] == 31, f"the lines count {old['days'] + new['days']} days in a 31-day period"
`,
    typescript: `const OWNER = {'X-Tenant-Id': 't-acme'};

function world(ctx) {
  const dates = ctx.load('/support/billing/dates.ts');
  const store = ctx.load('/support/billing/store.ts');
  /** A starter-plan subscription whose period started before days ago and ends after days from today. */
  const seed = async (subscriptionId = 'sub_1', tenant = 't-acme', before = 16, after = 15) => {
    const today = dates.today();
    const start = dates.addDays(today, -before);
    const end = dates.addDays(today, after);
    await store.putSubscription(subscriptionId, tenant, 'starter', start, end);
    return {start, end};
  };
  const c = ctx.client(ctx.load('api').app);
  const change = (opts: {subscriptionId?: string; plan?: string; effective?: string; policy?: string; headers?: Record<string, string>} = {}) =>
    c.post('/v1/subscriptions', {
      json: {subscription_id: opts.subscriptionId ?? 'sub_1', plan: opts.plan ?? 'scale', effective_date: opts.effective ?? 'now', proration_policy: opts.policy ?? 'actual_days'},
      headers: opts.headers ?? OWNER,
    });
  return {dates, store, seed, change};
}

function lines(r) {
  assert.equal(r.status, 200, \`a plan change from starter to scale answered \${r.status}: \${r.text}\`);
  const out = r.json().lines;
  assert(Array.isArray(out) && out.length === 2, \`the answer must carry two lines (old plan, new plan), got \${r.text}\`);
  return out;
}

export async function check_route(ctx) {
  const {store, seed, change} = world(ctx);
  await seed();
  const r = await change();
  const out = lines(r);
  const body = r.json();
  assert.deepEqual(out.map(l => l.plan), ['starter', 'scale'], \`the lines are \${JSON.stringify(out)}, expected the starter line then the scale line\`);
  assert.equal(body.total_cents, out.reduce((sum, l) => sum + l.amount_cents, 0), \`total_cents \${body.total_cents} is not the sum of the lines \${JSON.stringify(out)}\`);
  const invoice = await store.findInvoice(String(body.invoice_id));
  assert(invoice !== null && invoice.amount_cents === body.total_cents, \`the change must open the period's invoice for the total, the store holds \${JSON.stringify(invoice)}\`);
}

export async function check_tenant(ctx) {
  const {store, seed, change} = world(ctx);
  await seed();
  await seed('sub_2', 't-other');
  const anonymous = await change({headers: {}});
  assert.equal(anonymous.status, 401, \`a plan change without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  const foreign = await change({subscriptionId: 'sub_2'});
  assert.equal(foreign.status, 404, \`t-acme changing t-other's subscription answered \${foreign.status}, expected 404\`);
  assert.deepEqual(await store.invoicesOf('sub_2'), [], "a foreign tenant's change opened an invoice on sub_2");
  const own = await change();
  assert.equal(own.status, 200, \`the owner's change answered \${own.status}: \${own.text}\`);
}

export async function check_effective_date(ctx) {
  const {dates, store, seed, change} = world(ctx);
  const {end} = await seed();
  let r = await change({effective: dates.addDays(dates.today(), 3)});
  assert.equal(r.status, 400, \`effective_date three days from now (neither now nor the period end) answered \${r.status}, expected 400\`);
  r = await change({policy: 'thirty_day_month'});
  assert.equal(r.status, 400, \`proration_policy thirty_day_month answered \${r.status}, expected 400\`);
  r = await change({plan: 'enterprise'});
  assert.equal(r.status, 400, \`a plan with no price answered \${r.status}, expected 400\`);
  assert.deepEqual(await store.invoicesOf('sub_1'), [], 'a rejected change opened an invoice');
  r = await change({effective: end});
  assert(r.status === 200 && r.json().effective_at === end, \`a change at the period end \${end} answered \${r.status} \${r.text}\`);
}

export async function check_actual_days(ctx) {
  const {seed, change} = world(ctx);
  for (const [subscriptionId, before, after] of [['sub_1', 16, 15], ['sub_2', 10, 18]] as const) {
    await seed(subscriptionId, 't-acme', before, after);
    const period = before + after;
    const out = lines(await change({subscriptionId}));
    out.forEach((l, i) => {
      const expected = Math.round(([1900, 9900][i] * l.days) / period);
      assert.equal(l.amount_cents, expected, \`in a \${period}-day period the \${l.plan} line covers \${l.days} days and costs \${l.amount_cents} cents; over the period's \${period} days it is \${expected}. Divide by the period's own length\`);
    });
  }
}

export async function check_exclusive_day(ctx) {
  const {seed, change} = world(ctx);
  const {start, end} = await seed('sub_1', 't-acme', 16, 15);
  const [old, next] = lines(await change());
  assert.equal(old.days, 16, \`the starter line covers \${old.days} days of [\${start}, today): 16 days. The switch day belongs to the new plan\`);
  assert.equal(next.days, 15, \`the scale line covers \${next.days} days of [today, \${end}), expected 15\`);
  assert.equal(old.days + next.days, 31, \`the lines count \${old.days + next.days} days in a 31-day period\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"math"
	"net/http"

	"billing/dates"
	"billing/store"

	"leetbuild/harness"
)

var apiBg = context.Background()

type changeAnswer struct {
	EffectiveAt string \`json:"effective_at"\`
	Lines       []line \`json:"lines"\`
	TotalCents  int64  \`json:"total_cents"\`
	InvoiceID   string \`json:"invoice_id"\`
}

// seed writes a starter-plan subscription whose period started before days ago and ends after days from today.
func seed(subscriptionID, tenant string, before, after int) (string, string) {
	today := dates.Today()
	start, end := dates.AddDays(today, -before), dates.AddDays(today, after)
	store.PutSubscription(apiBg, subscriptionID, tenant, "starter", start, end)
	return start, end
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func change(c *harness.HTTP, subscriptionID, plan, effective, policy string, header ...string) *harness.Response {
	body := map[string]string{"subscription_id": subscriptionID, "plan": plan, "effective_date": effective, "proration_policy": policy}
	return c.Post("/v1/subscriptions", body, header...)
}

func owner(c *harness.HTTP, subscriptionID, plan, effective, policy string) *harness.Response {
	return change(c, subscriptionID, plan, effective, policy, "X-Tenant-Id", "t-acme")
}

func answer(ctx *harness.Ctx, r *harness.Response) changeAnswer {
	ctx.Equal(r.Status, 200, "a plan change from starter to scale (%s)", r.Text())
	var out changeAnswer
	r.Decode(&out)
	ctx.Assert(len(out.Lines) == 2, "the answer must carry two lines (old plan, new plan), got %s", r.Text())
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	seed("sub_1", "t-acme", 16, 15)
	out := answer(ctx, owner(api(ctx), "sub_1", "scale", "now", "actual_days"))
	ctx.Assert(out.Lines[0].Plan == "starter" && out.Lines[1].Plan == "scale", "the lines are %+v, expected the starter line then the scale line", out.Lines)
	ctx.Equal(out.TotalCents, out.Lines[0].AmountCents+out.Lines[1].AmountCents, "total_cents must be the sum of the lines; total_cents")
	invoice := store.FindInvoice(apiBg, out.InvoiceID)
	ctx.Assert(invoice != nil && invoice.AmountCents == out.TotalCents, "the change must open the period's invoice for the total, the store holds %+v", invoice)
}

func CheckTenant(ctx *harness.Ctx) {
	seed("sub_1", "t-acme", 16, 15)
	seed("sub_2", "t-other", 16, 15)
	c := api(ctx)
	anonymous := change(c, "sub_1", "scale", "now", "actual_days")
	ctx.Equal(anonymous.Status, 401, "a plan change without X-Tenant-Id")
	foreign := owner(c, "sub_2", "scale", "now", "actual_days")
	ctx.Equal(foreign.Status, 404, "t-acme changing t-other's subscription")
	ctx.Equal(len(store.InvoicesOf(apiBg, "sub_2")), 0, "a foreign tenant's change must open no invoice on sub_2; invoices")
	own := owner(c, "sub_1", "scale", "now", "actual_days")
	ctx.Equal(own.Status, 200, "the owner's change (%s)", own.Text())
}

func CheckEffectiveDate(ctx *harness.Ctx) {
	_, end := seed("sub_1", "t-acme", 16, 15)
	c := api(ctx)
	r := owner(c, "sub_1", "scale", dates.AddDays(dates.Today(), 3), "actual_days")
	ctx.Equal(r.Status, 400, "effective_date three days from now (neither now nor the period end)")
	r = owner(c, "sub_1", "scale", "now", "thirty_day_month")
	ctx.Equal(r.Status, 400, "proration_policy thirty_day_month")
	r = owner(c, "sub_1", "enterprise", "now", "actual_days")
	ctx.Equal(r.Status, 400, "a plan with no price")
	ctx.Equal(len(store.InvoicesOf(apiBg, "sub_1")), 0, "a rejected change must open no invoice; invoices")
	out := answer(ctx, owner(c, "sub_1", "scale", end, "actual_days"))
	ctx.Equal(out.EffectiveAt, end, "a change at the period end; effective_at")
}

func CheckActualDays(ctx *harness.Ctx) {
	c := api(ctx)
	for i, span := range [][2]int{{16, 15}, {10, 18}} {
		subscriptionID := fmt.Sprintf("sub_%d", i+1)
		seed(subscriptionID, "t-acme", span[0], span[1])
		period := span[0] + span[1]
		out := answer(ctx, owner(c, subscriptionID, "scale", "now", "actual_days"))
		for j, price := range []float64{1900, 9900} {
			l := out.Lines[j]
			expected := int64(math.Round(price * float64(l.Days) / float64(period)))
			ctx.Assert(l.AmountCents == expected, "in a %d-day period the %s line covers %d days and costs %d cents; over the period's %d days it is %d. Divide by the period's own length", period, l.Plan, l.Days, l.AmountCents, period, expected)
		}
	}
}

func CheckExclusiveDay(ctx *harness.Ctx) {
	start, end := seed("sub_1", "t-acme", 16, 15)
	out := answer(ctx, owner(api(ctx), "sub_1", "scale", "now", "actual_days"))
	ctx.Assert(out.Lines[0].Days == 16, "the starter line covers %d days of [%s, today): 16 days. The switch day belongs to the new plan", out.Lines[0].Days, start)
	ctx.Assert(out.Lines[1].Days == 15, "the scale line covers %d days of [today, %s), expected 15", out.Lines[1].Days, end)
	ctx.Equal(out.Lines[0].Days+out.Lines[1].Days, 31, "the lines' days in a 31-day period")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <string>
#include <utility>

#include "billing/dates.h"
#include "billing/store.h"

namespace {

// A starter-plan subscription whose period started before days ago and ends after days from today.
std::pair<std::string, std::string> seed(const std::string& subscription_id, const std::string& tenant, long before, long after) {
  const std::string today = dates::today();
  const std::string start = dates::addDays(today, -before);
  const std::string stop = dates::addDays(today, after);
  store::putSubscription(subscription_id, tenant, "starter", start, stop);
  return {start, stop};
}

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string changeBody(const std::string& subscription_id, const std::string& plan, const std::string& effective, const std::string& policy) {
  return nlohmann::json{{"subscription_id", subscription_id}, {"plan", plan}, {"effective_date", effective}, {"proration_policy", policy}}.dump();
}

harness::Response owner(harness::HTTP& c, const std::string& subscription_id, const std::string& plan, const std::string& effective,
                        const std::string& policy) {
  return c.Post("/v1/subscriptions", changeBody(subscription_id, plan, effective, policy), "Content-Type", "application/json", "X-Tenant-Id", "t-acme");
}

nlohmann::json answer(harness::Ctx& ctx, const harness::Response& r) {
  ctx.Equal(r.Status, 200, "a plan change from starter to scale (%s)", r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object() && body.contains("lines") && body["lines"].is_array() && body["lines"].size() == 2,
             "the answer must carry two lines (old plan, new plan), got %s", r.Text());
  return body;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  seed("sub_1", "t-acme", 16, 15);
  auto c = api(ctx);
  const auto body = answer(ctx, owner(c, "sub_1", "scale", "now", "actual_days"));
  const auto& lines = body["lines"];
  ctx.Assert(lines[0].value("plan", "") == "starter" && lines[1].value("plan", "") == "scale", "the lines are %s, expected the starter line then the scale line", lines.dump());
  ctx.Equal(body.value("total_cents", 0LL), lines[0].value("amount_cents", 0LL) + lines[1].value("amount_cents", 0LL), "total_cents must be the sum of the lines; total_cents");
  const auto invoice = store::findInvoice(body.value("invoice_id", ""));
  ctx.Assert(invoice && invoice->amount_cents == body.value("total_cents", 0LL), "the change must open the period's invoice for the total (%s)", body.dump());
}

void CheckTenant(harness::Ctx& ctx) {
  seed("sub_1", "t-acme", 16, 15);
  seed("sub_2", "t-other", 16, 15);
  auto c = api(ctx);
  const auto anonymous = c.Post("/v1/subscriptions", changeBody("sub_1", "scale", "now", "actual_days"), "Content-Type", "application/json");
  ctx.Equal(anonymous.Status, 401, "a plan change without X-Tenant-Id");
  const auto foreign = owner(c, "sub_2", "scale", "now", "actual_days");
  ctx.Equal(foreign.Status, 404, "t-acme changing t-other's subscription");
  ctx.Equal(store::invoicesOf("sub_2").size(), 0, "a foreign tenant's change must open no invoice on sub_2; invoices");
  const auto own = owner(c, "sub_1", "scale", "now", "actual_days");
  ctx.Equal(own.Status, 200, "the owner's change (%s)", own.Text());
}

void CheckEffectiveDate(harness::Ctx& ctx) {
  const auto period = seed("sub_1", "t-acme", 16, 15);
  auto c = api(ctx);
  auto r = owner(c, "sub_1", "scale", dates::addDays(dates::today(), 3), "actual_days");
  ctx.Equal(r.Status, 400, "effective_date three days from now (neither now nor the period end)");
  r = owner(c, "sub_1", "scale", "now", "thirty_day_month");
  ctx.Equal(r.Status, 400, "proration_policy thirty_day_month");
  r = owner(c, "sub_1", "enterprise", "now", "actual_days");
  ctx.Equal(r.Status, 400, "a plan with no price");
  ctx.Equal(store::invoicesOf("sub_1").size(), 0, "a rejected change must open no invoice; invoices");
  const auto body = answer(ctx, owner(c, "sub_1", "scale", period.second, "actual_days"));
  ctx.Equal(body.value("effective_at", ""), period.second, "a change at the period end; effective_at");
}

void CheckActualDays(harness::Ctx& ctx) {
  auto c = api(ctx);
  const long spans[2][2] = {{16, 15}, {10, 18}};
  for (int i = 0; i < 2; i++) {
    const std::string subscription_id = "sub_" + std::to_string(i + 1);
    seed(subscription_id, "t-acme", spans[i][0], spans[i][1]);
    const long period = spans[i][0] + spans[i][1];
    const auto body = answer(ctx, owner(c, subscription_id, "scale", "now", "actual_days"));
    const double prices[2] = {1900, 9900};
    for (int j = 0; j < 2; j++) {
      const auto& l = body["lines"][j];
      const long days = l.value("days", 0L);
      const long long expected = std::llround(prices[j] * days / period);
      ctx.Assert(l.value("amount_cents", 0LL) == expected,
                 "in a %d-day period the %s line covers %d days and costs %d cents; over the period's %d days it is %d. Divide by the period's own length",
                 period, l.value("plan", ""), days, l.value("amount_cents", 0LL), period, expected);
    }
  }
}

void CheckExclusiveDay(harness::Ctx& ctx) {
  const auto period = seed("sub_1", "t-acme", 16, 15);
  auto c = api(ctx);
  const auto body = answer(ctx, owner(c, "sub_1", "scale", "now", "actual_days"));
  const long old_days = body["lines"][0].value("days", 0L);
  const long new_days = body["lines"][1].value("days", 0L);
  ctx.Assert(old_days == 16, "the starter line covers %d days of [%s, today): 16 days. The switch day belongs to the new plan", old_days, period.first);
  ctx.Assert(new_days == 15, "the scale line covers %d days of [today, %s), expected 15", new_days, period.second);
  ctx.Equal(old_days + new_days, 31L, "the lines' days in a 31-day period");
}
`,
  },
  hints: [
    'Change a plan in the middle of a 31-day period: the two lines count 32 days between them and each is priced as if the period had 30. A request with no `X-Tenant-Id` gets a schedule too.',
    "The divisor is the constant `MONTH_DAYS`, not the period, and the old plan's days end with `+ 1`, so the switch day lands on both lines. Nothing reads the tenant header or checks the plan, the policy or the date before pricing.",
    'Read `X-Tenant-Id` (401) and compare it with `subscription["tenant"]` (404); answer 400 for a plan with no price, a policy outside `PRORATION_POLICIES` or a date other than `now`/`period_end`; divide by `days_between(period_start, period_end)`; drop the `+ 1`.',
  ],
  debrief: `Every unchecked input ends up multiplied by a price, which is why the guards run before the arithmetic: a tenant nobody checked, a policy with no formula behind it and a date the period cannot place all turn into money. The divisor comes from the period's own bounds, and half-open intervals make the two lines add up to the period by construction, so the switch day belongs to exactly one plan. Billing platforms go further: they record the plan version behind each line, round once per invoice in the currency's minor unit rather than per line, and turn a downgrade into a credit on the next invoice instead of a smaller charge on this one.`,
};
