import type {Step} from '@/lib/types';

export const changePlanStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/subscriptions: plan changes with an effective date',
  concept: 'http',
  file: 'api',
  focus: ['client', 'billing', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and returns an invoice schedule. It compiles, it serves the demo, and it hides three
production flaws. Review it like the billing owner, fix it, and prove the fix with the checks below.

Implement the plan change on \`POST /v1/subscriptions\` with body
\`{"subscription_id": "…", "plan": "…", "effective_date": "now", "proration_policy": "actual_days"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**, and a
  subscription that belongs to another tenant is **404**, never someone else's schedule.
- \`plan\` must exist in the plan catalogue (**400** otherwise).
- \`proration_policy\` must be one the platform implements — today only \`actual_days\` (**400**
  otherwise). A caller may not pick a policy that has no arithmetic behind it.
- \`effective_date\` is either the literal \`now\` or the subscription's next period boundary (an
  ISO-8601 date, \`next_period_start\`). Any other date is **400**: the platform prorates over a
  period it can identify, never over a guess.
- Proration runs over the **actual** days of the period: \`period_days = (period_end - period_start).days\`
  and a line's amount is \`round(price_cents * days / period_days)\`. A thirty-day month is not a
  month: it over-bills February's slice and under-bills a 31-day one.
- The switch day is charged **exactly once**: the old plan's line covers \`[period_start, change_at)\`
  and the new plan's line covers \`[change_at, period_end)\`, so \`old_days + new_days == period_days\`.
  Charging the old plan for the full period *and* the new plan from the change day on bills that day
  twice.
- The response states the resulting invoice schedule:
  \`{"subscription_id", "effective_at", "proration_policy", "invoice_schedule": [{"period_start", "period_end", "lines": [{"plan", "days", "amount_cents"}]}], "total_cents"}\`.
- Log the change with tenant, subscription and plan — never card or processor data.

**Failure mode the checks target.** Every one of these bugs survives a demo: the demo changes plans
on the first of the month (so a fixed 30-day divisor looks right), it charges one plan (so the
double-billed day is invisible), and it sends a well-formed request from its own tenant (so an
endpoint that denies nothing looks permissive rather than unsafe).`,
  sequence: {
    participants: ['Client', 'Billing Service', 'billing db'],
    messages: [
      {
        from: 'Client',
        to: 'Billing Service',
        label: 'POST /v1/subscriptions · X-Tenant-Id · plan · effective_date',
        kind: 'sync',
      },
      {
        from: 'Billing Service',
        to: 'Billing Service',
        label: 'validate tenant · plan · policy · effective date',
        kind: 'sync',
      },
      {from: 'Billing Service', to: 'billing db', label: 'load subscription period · plan prices', kind: 'sync'},
      {from: 'billing db', to: 'Billing Service', label: 'current · next period bounds', kind: 'reply'},
      {
        from: 'Billing Service',
        to: 'Billing Service',
        label: 'prorate over period_days, old_days + new_days == period_days',
        kind: 'sync',
      },
      {from: 'Billing Service', to: 'billing db', label: 'store the plan change · invoice schedule', kind: 'async'},
      {from: 'Billing Service', to: 'Client', label: '200 {invoice_schedule, total_cents}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/subscriptions',
      detail: 'Register the plan-change route on `POST /v1/subscriptions`.',
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
        'A missing `X-Tenant-Id` is **401** and a subscription that belongs to another tenant is **404**. The draft denies nothing: it reads the subscription straight from the body, so any caller can preview — or force — any tenant’s schedule.',
      match: {
        python: {all: [/X-Tenant-Id/, /status_code\s*=\s*401/, /status_code\s*=\s*404/]},
        typescript: {all: [/x-tenant-id/, /code\(\s*401\s*\)/, /code\(\s*404\s*\)/]},
        go: {all: [/X-Tenant-Id/, /StatusUnauthorized/, /StatusNotFound/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.Unauthorized/, /StatusCodes\.NotFound/]},
        cpp: {all: [/X-Tenant-Id/, /res\.status\s*=\s*401/, /res\.status\s*=\s*404/]},
      },
    },
    {
      id: 'effective-date',
      title: 'Rejects an unsupported effective date or proration policy',
      detail:
        '`effective_date` must be `now` or the next period boundary, and `proration_policy` must be one the platform implements — both **400** otherwise. The draft accepts any string and prorates it anyway, so an uncomputable change reaches an invoice.',
      match: {
        python: {all: [/EFFECTIVE_NOW/, /next_period_start/, /PRORATION_POLICIES/, /status_code\s*=\s*400/]},
        typescript: {all: [/EFFECTIVE_NOW/, /nextPeriodStart/, /PRORATION_POLICIES/, /code\(\s*400\s*\)/]},
        go: {all: [/effectiveNow/, /nextPeriodStart/, /prorationPolicies/, /StatusBadRequest/]},
        scala: {all: [/EffectiveNow/, /nextPeriodStart/, /ProrationPolicies/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kEffectiveNow/, /nextPeriodStart/, /kProrationPolicies/, /\b400\b/]},
      },
    },
    {
      id: 'actual-days',
      title: 'Prorates over the actual days of the period',
      detail:
        'The divisor is the period’s real length, computed from its two bounds (`period_days = (period_end - period_start).days`), never a constant thirty-day month. The draft divides by `MONTH_DAYS = 30`, so a 31-day period is under-billed and February is over-billed.',
      match: {
        python: {
          all: [/period_days\s*=\s*\(\s*period_end\s*-\s*period_start\s*\)\.days/],
          none: [/MONTH_DAYS\s*=\s*30/],
        },
        typescript: {
          all: [/periodDays\s*=\s*daysBetween\(\s*periodStart\s*,\s*periodEnd\s*\)/],
          none: [/MONTH_DAYS\s*=\s*30/],
        },
        go: {all: [/periodDays\s*:=\s*daysBetween\(periodStart,\s*periodEnd\)/], none: [/monthDays\s*=\s*30/]},
        scala: {
          all: [/periodDays\s*=\s*ChronoUnit\.DAYS\.between\(periodStart,\s*periodEnd\)/],
          none: [/MonthDays\s*=\s*30/],
        },
        cpp: {all: [/periodDays\s*=\s*daysBetween\(periodStart,\s*periodEnd\)/], none: [/kMonthDays\s*=\s*30/]},
      },
    },
    {
      id: 'exclusive-day',
      title: 'Charges the switch day exactly once',
      detail:
        'The old plan covers `[period_start, change_at)` and the new plan `[change_at, period_end)`, with `old_days + new_days == period_days` held as an invariant. The draft bills the old plan for the whole period *and* the new plan from the change day on, charging that day twice.',
      match: {
        python: {all: [/old_days\s*\+\s*new_days\s*!=\s*period_days/, /\bchange_at\b/]},
        typescript: {all: [/oldDays\s*\+\s*newDays\s*!==\s*periodDays/, /\bchangeAt\b/]},
        go: {all: [/oldDays\+newDays\s*!=\s*periodDays/, /\bchangeAt\b/]},
        scala: {all: [/oldDays\s*\+\s*newDays\s*==\s*periodDays/, /\bchangeAt\b/]},
        cpp: {all: [/oldDays\s*\+\s*newDays\s*!=\s*periodDays/, /\bchangeAt\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
from datetime import date

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("billing")

MONTH_DAYS = 30
PLANS = {"starter-monthly": 1900, "scale-monthly": 9900}


class PlanChange(BaseModel):
    subscription_id: str
    plan: str
    effective_date: str
    proration_policy: str = "actual_days"


class SubscriptionStore:
    def load(self, subscription_id: str) -> dict:
        """The subscription row: tenant, plan, current/next period bounds."""
        raise NotImplementedError


store = SubscriptionStore()


def change_day(value: str) -> int:
    if value == "now":
        return date.today().day
    return date.fromisoformat(value).day


@app.post("/v1/subscriptions")
def change_plan(body: PlanChange) -> dict:
    # TODO: a model-generated draft. It prorates over a thirty-day month, charges the old plan for
    # the whole period and the new plan from the change day on, so the switch day is billed twice,
    # and it denies nothing: no tenant check, no plan check, no effective-date or policy check.
    subscription = store.load(body.subscription_id)
    day = change_day(body.effective_date)
    old_cents = PLANS[subscription["plan"]]
    new_cents = round(PLANS[body.plan] * (MONTH_DAYS - day) / MONTH_DAYS)
    logger.info("plan change subscription=%s plan=%s", body.subscription_id, body.plan)
    return {
        "subscription_id": body.subscription_id,
        "effective_at": body.effective_date,
        "proration_policy": body.proration_policy,
        "invoice_schedule": [
            {
                "period_start": subscription["current_period_start"].isoformat(),
                "period_end": subscription["current_period_end"].isoformat(),
                "lines": [
                    {"plan": subscription["plan"], "days": MONTH_DAYS, "amount_cents": old_cents},
                    {"plan": body.plan, "days": MONTH_DAYS - day, "amount_cents": new_cents},
                ],
            }
        ],
        "total_cents": old_cents + new_cents,
    }
`,
      solution: `import logging
from datetime import date

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("billing")

EFFECTIVE_NOW = "now"
PRORATION_POLICIES = {"actual_days"}
PLANS = {"starter-monthly": 1900, "scale-monthly": 9900}


class PlanChange(BaseModel):
    subscription_id: str
    plan: str
    effective_date: str
    proration_policy: str = "actual_days"


class SubscriptionStore:
    def load(self, subscription_id: str) -> dict | None:
        """The subscription row: tenant, plan, current/next period bounds."""
        raise NotImplementedError


store = SubscriptionStore()


def days_between(start: date, end: date) -> int:
    return (end - start).days


def prorated_cents(price_cents: int, days: int, period_days: int) -> int:
    """A line costs the plan price over the days that plan actually covered."""
    return round(price_cents * days / period_days)


def schedule_for(subscription: dict, plan: str, change_at: date) -> dict:
    if change_at >= subscription["next_period_start"]:
        period_start, period_end = subscription["next_period_start"], subscription["next_period_end"]
    else:
        period_start, period_end = subscription["current_period_start"], subscription["current_period_end"]
    period_days = (period_end - period_start).days
    old_days = days_between(period_start, change_at)
    new_days = days_between(change_at, period_end)
    if old_days + new_days != period_days:
        raise ValueError("a plan change must charge every day of the period exactly once")
    return {
        "period_start": period_start.isoformat(),
        "period_end": period_end.isoformat(),
        "lines": [
            {
                "plan": subscription["plan"],
                "days": old_days,
                "amount_cents": prorated_cents(PLANS[subscription["plan"]], old_days, period_days),
            },
            {
                "plan": plan,
                "days": new_days,
                "amount_cents": prorated_cents(PLANS[plan], new_days, period_days),
            },
        ],
    }


@app.post("/v1/subscriptions")
def change_plan(
    body: PlanChange,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> dict:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if body.plan not in PLANS:
        raise HTTPException(status_code=400, detail="unknown plan")
    if body.proration_policy not in PRORATION_POLICIES:
        raise HTTPException(status_code=400, detail="unsupported proration policy")
    subscription = store.load(body.subscription_id)
    if subscription is None or subscription["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="unknown subscription")
    next_period_start = subscription["next_period_start"]
    if body.effective_date == EFFECTIVE_NOW:
        change_at = date.today()
    elif body.effective_date == next_period_start.isoformat():
        change_at = next_period_start
    else:
        raise HTTPException(status_code=400, detail="effective date must be now or the next period boundary")
    schedule = schedule_for(subscription, body.plan, change_at)
    total_cents = sum(line["amount_cents"] for line in schedule["lines"])
    logger.info("plan change tenant=%s subscription=%s plan=%s", tenant, body.subscription_id, body.plan)
    return {
        "subscription_id": body.subscription_id,
        "effective_at": change_at.isoformat(),
        "proration_policy": body.proration_policy,
        "invoice_schedule": [schedule],
        "total_cents": total_cents,
    }
`,
    },
    typescript: {
      starter: `/** POST /v1/subscriptions: a model-generated draft of the plan-change handler. */
import Fastify from 'fastify';

export const app = Fastify();

const MONTH_DAYS = 30;
const PLANS: Record<string, number> = {'starter-monthly': 1900, 'scale-monthly': 9900};

interface PlanChange {
  subscription_id: string;
  plan: string;
  effective_date: string;
  proration_policy?: string;
}

export interface Subscription {
  id: string;
  tenant: string;
  plan: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  nextPeriodStart: string;
  nextPeriodEnd: string;
}

export const store = {
  async load(subscriptionId: string): Promise<Subscription | null> {
    void subscriptionId;
    return null;
  },
};

function changeDay(value: string): number {
  return value === 'now' ? new Date().getUTCDate() : Number(value.slice(8, 10));
}

app.post('/v1/subscriptions', async (request, reply) => {
  // TODO: a model-generated draft. It prorates over a thirty-day month, charges the old plan for
  // the whole period and the new plan from the change day on, so the switch day is billed twice,
  // and it denies nothing: no tenant check, no plan check, no effective-date or policy check.
  const body = request.body as PlanChange;
  const subscription = (await store.load(body.subscription_id)) as Subscription;
  const day = changeDay(body.effective_date);
  const oldCents = PLANS[subscription.plan];
  const newCents = Math.round((PLANS[body.plan] * (MONTH_DAYS - day)) / MONTH_DAYS);
  request.log.info({subscription_id: body.subscription_id, plan: body.plan}, 'plan change');
  return reply.code(200).send({
    subscription_id: body.subscription_id,
    effective_at: body.effective_date,
    proration_policy: body.proration_policy ?? 'actual_days',
    invoice_schedule: [
      {
        period_start: subscription.currentPeriodStart,
        period_end: subscription.currentPeriodEnd,
        lines: [
          {plan: subscription.plan, days: MONTH_DAYS, amount_cents: oldCents},
          {plan: body.plan, days: MONTH_DAYS - day, amount_cents: newCents},
        ],
      },
    ],
    total_cents: oldCents + newCents,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/subscriptions: plan changes prorated over the actual days of the period. */
import Fastify from 'fastify';

export const app = Fastify();

export const EFFECTIVE_NOW = 'now';
export const PRORATION_POLICIES: Record<string, true> = {actual_days: true};
export const PLANS: Record<string, number> = {'starter-monthly': 1900, 'scale-monthly': 9900};

const DAY_MS = 24 * 60 * 60 * 1000;

interface PlanChange {
  subscription_id: string;
  plan: string;
  effective_date: string;
  proration_policy?: string;
}

export interface Subscription {
  id: string;
  tenant: string;
  plan: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  nextPeriodStart: string;
  nextPeriodEnd: string;
}

export const store = {
  async load(subscriptionId: string): Promise<Subscription | null> {
    void subscriptionId;
    return null;
  },
};

interface InvoiceLine {
  plan: string;
  days: number;
  amount_cents: number;
}

interface InvoicePeriod {
  period_start: string;
  period_end: string;
  lines: InvoiceLine[];
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}

function proratedCents(priceCents: number, days: number, periodDays: number): number {
  return Math.round((priceCents * days) / periodDays);
}

function scheduleFor(subscription: Subscription, plan: string, changeAt: Date): InvoicePeriod {
  const goesToNextPeriod = changeAt.getTime() >= Date.parse(subscription.nextPeriodStart);
  const periodStart = new Date(goesToNextPeriod ? subscription.nextPeriodStart : subscription.currentPeriodStart);
  const periodEnd = new Date(goesToNextPeriod ? subscription.nextPeriodEnd : subscription.currentPeriodEnd);
  const periodDays = daysBetween(periodStart, periodEnd);
  const oldDays = daysBetween(periodStart, changeAt);
  const newDays = daysBetween(changeAt, periodEnd);
  if (oldDays + newDays !== periodDays)
    throw new Error('a plan change must charge every day of the period exactly once');
  return {
    period_start: periodStart.toISOString().slice(0, 10),
    period_end: periodEnd.toISOString().slice(0, 10),
    lines: [
      {
        plan: subscription.plan,
        days: oldDays,
        amount_cents: proratedCents(PLANS[subscription.plan], oldDays, periodDays),
      },
      {plan, days: newDays, amount_cents: proratedCents(PLANS[plan], newDays, periodDays)},
    ],
  };
}

app.post('/v1/subscriptions', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as Partial<PlanChange> | null;
  if (body === null || typeof body !== 'object' || typeof body.subscription_id !== 'string')
    return reply.code(400).send({error: 'subscription_id is required'});
  if (typeof body.plan !== 'string' || PLANS[body.plan] === undefined)
    return reply.code(400).send({error: 'unknown plan'});
  const policy = body.proration_policy ?? 'actual_days';
  if (PRORATION_POLICIES[policy] !== true) return reply.code(400).send({error: 'unsupported proration policy'});
  const subscription = await store.load(body.subscription_id);
  if (subscription === null || subscription.tenant !== tenant)
    return reply.code(404).send({error: 'unknown subscription'});
  const nextPeriodStart = new Date(subscription.nextPeriodStart);
  let changeAt: Date;
  if (body.effective_date === EFFECTIVE_NOW) changeAt = new Date();
  else if (body.effective_date === nextPeriodStart.toISOString().slice(0, 10)) changeAt = nextPeriodStart;
  else return reply.code(400).send({error: 'effective date must be now or the next period boundary'});
  const schedule = scheduleFor(subscription, body.plan, changeAt);
  const totalCents = schedule.lines.reduce((sum, line) => sum + line.amount_cents, 0);
  request.log.info({tenant, subscription_id: body.subscription_id, plan: body.plan}, 'plan change');
  return reply.code(200).send({
    subscription_id: body.subscription_id,
    effective_at: changeAt.toISOString().slice(0, 10),
    proration_policy: policy,
    invoice_schedule: [schedule],
    total_cents: totalCents,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"math"
	"net/http"
	"time"
)

const monthDays = 30

var plans = map[string]int{"starter-monthly": 1900, "scale-monthly": 9900}

// PlanChange is the plan-change request body.
type PlanChange struct {
	SubscriptionID  string \`json:"subscription_id"\`
	Plan            string \`json:"plan"\`
	EffectiveDate   string \`json:"effective_date"\`
	ProrationPolicy string \`json:"proration_policy"\`
}

// Subscription is the billing row the store returns.
type Subscription struct {
	Tenant             string
	Plan               string
	CurrentPeriodStart time.Time
	CurrentPeriodEnd   time.Time
	NextPeriodStart    time.Time
	NextPeriodEnd      time.Time
}

type SubscriptionStore struct{}

func (s *SubscriptionStore) Load(subscriptionID string) (*Subscription, error) { return nil, nil }

var store = &SubscriptionStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func changeDay(value string) int {
	if value == "now" {
		return time.Now().UTC().Day()
	}
	parsed, err := time.Parse("2006-01-02", value)
	if err != nil {
		return 1
	}
	return parsed.Day()
}

func changePlan(rw http.ResponseWriter, r *http.Request) {
	// TODO: a model-generated draft. It prorates over a thirty-day month, charges the old plan for
	// the whole period and the new plan from the change day on, so the switch day is billed twice,
	// and it denies nothing: no tenant check, no plan check, no effective-date or policy check.
	var body PlanChange
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	subscription, _ := store.Load(body.SubscriptionID)
	day := changeDay(body.EffectiveDate)
	oldCents := plans[subscription.Plan]
	newCents := int(math.Round(float64(plans[body.Plan]) * float64(monthDays-day) / float64(monthDays)))
	log.Printf("plan change subscription=%s plan=%s", body.SubscriptionID, body.Plan)
	writeJSON(rw, http.StatusOK, map[string]any{
		"subscription_id":  body.SubscriptionID,
		"effective_at":     body.EffectiveDate,
		"proration_policy": body.ProrationPolicy,
		"invoice_schedule": []any{map[string]any{
			"period_start": subscription.CurrentPeriodStart.Format("2006-01-02"),
			"period_end":   subscription.CurrentPeriodEnd.Format("2006-01-02"),
			"lines": []any{
				map[string]any{"plan": subscription.Plan, "days": monthDays, "amount_cents": oldCents},
				map[string]any{"plan": body.Plan, "days": monthDays - day, "amount_cents": newCents},
			},
		}},
		"total_cents": oldCents + newCents,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/subscriptions", changePlan)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"
	"time"
)

const effectiveNow = "now"

var prorationPolicies = map[string]bool{"actual_days": true}

var plans = map[string]int{"starter-monthly": 1900, "scale-monthly": 9900}

// PlanChange is the plan-change request body.
type PlanChange struct {
	SubscriptionID  string \`json:"subscription_id"\`
	Plan            string \`json:"plan"\`
	EffectiveDate   string \`json:"effective_date"\`
	ProrationPolicy string \`json:"proration_policy"\`
}

// Subscription is the billing row the store returns.
type Subscription struct {
	Tenant             string
	Plan               string
	CurrentPeriodStart time.Time
	CurrentPeriodEnd   time.Time
	NextPeriodStart    time.Time
	NextPeriodEnd      time.Time
}

type SubscriptionStore struct{}

func (s *SubscriptionStore) Load(subscriptionID string) (*Subscription, error) { return nil, nil }

var store = &SubscriptionStore{}

type invoiceLine struct {
	Plan        string \`json:"plan"\`
	Days        int    \`json:"days"\`
	AmountCents int    \`json:"amount_cents"\`
}

type invoicePeriod struct {
	PeriodStart string        \`json:"period_start"\`
	PeriodEnd   string        \`json:"period_end"\`
	Lines       []invoiceLine \`json:"lines"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func daysBetween(from, to time.Time) int {
	return int(to.Sub(from).Hours() / 24)
}

func proratedCents(priceCents, days, periodDays int) int {
	return int(math.Round(float64(priceCents*days) / float64(periodDays)))
}

func scheduleFor(subscription *Subscription, plan string, changeAt time.Time) (invoicePeriod, error) {
	periodStart, periodEnd := subscription.CurrentPeriodStart, subscription.CurrentPeriodEnd
	if !changeAt.Before(subscription.NextPeriodStart) {
		periodStart, periodEnd = subscription.NextPeriodStart, subscription.NextPeriodEnd
	}
	periodDays := daysBetween(periodStart, periodEnd)
	oldDays := daysBetween(periodStart, changeAt)
	newDays := daysBetween(changeAt, periodEnd)
	if oldDays+newDays != periodDays {
		return invoicePeriod{}, errors.New("a plan change must charge every day of the period exactly once")
	}
	return invoicePeriod{
		PeriodStart: periodStart.Format("2006-01-02"),
		PeriodEnd:   periodEnd.Format("2006-01-02"),
		Lines: []invoiceLine{
			{Plan: subscription.Plan, Days: oldDays, AmountCents: proratedCents(plans[subscription.Plan], oldDays, periodDays)},
			{Plan: plan, Days: newDays, AmountCents: proratedCents(plans[plan], newDays, periodDays)},
		},
	}, nil
}

func changePlan(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body PlanChange
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if _, ok := plans[body.Plan]; !ok {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown plan"})
		return
	}
	policy := body.ProrationPolicy
	if policy == "" {
		policy = "actual_days"
	}
	if !prorationPolicies[policy] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unsupported proration policy"})
		return
	}
	subscription, err := store.Load(body.SubscriptionID)
	if err != nil || subscription == nil || subscription.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown subscription"})
		return
	}
	nextPeriodStart := subscription.NextPeriodStart
	var changeAt time.Time
	if body.EffectiveDate == effectiveNow {
		changeAt = time.Now().UTC()
	} else if body.EffectiveDate == nextPeriodStart.Format("2006-01-02") {
		changeAt = nextPeriodStart
	} else {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "effective date must be now or the next period boundary"})
		return
	}
	schedule, err := scheduleFor(subscription, body.Plan, changeAt)
	if err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	totalCents := 0
	for _, line := range schedule.Lines {
		totalCents += line.AmountCents
	}
	log.Printf("plan change tenant=%s subscription=%s plan=%s", tenant, body.SubscriptionID, body.Plan)
	writeJSON(rw, http.StatusOK, map[string]any{
		"subscription_id":  body.SubscriptionID,
		"effective_at":     changeAt.Format("2006-01-02"),
		"proration_policy": policy,
		"invoice_schedule": []invoicePeriod{schedule},
		"total_cents":      totalCents,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/subscriptions", changePlan)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.time.LocalDate

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class PlanChange(subscription_id: String, plan: String, effective_date: String, proration_policy: String)
final case class Line(plan: String, days: Int, amount_cents: Long)
final case class Schedule(period_start: String, period_end: String, lines: List[Line])

object SubscriptionApi {
  implicit val system: ActorSystem = ActorSystem("billing")
  implicit val changeFormat: RootJsonFormat[PlanChange] = jsonFormat4(PlanChange)
  implicit val lineFormat: RootJsonFormat[Line] = jsonFormat3(Line)
  implicit val scheduleFormat: RootJsonFormat[Schedule] = jsonFormat3(Schedule)

  val MonthDays = 30
  val Plans = Map("starter-monthly" -> 1900L, "scale-monthly" -> 9900L)

  val store = SubscriptionStore.open()

  def changeDay(value: String): Int =
    if (value == "now") LocalDate.now.getDayOfMonth else LocalDate.parse(value).getDayOfMonth

  val route: Route =
    path("v1" / "subscriptions") {
      post {
        entity(as[PlanChange]) { body =>
          // TODO: a model-generated draft. It prorates over a thirty-day month, charges the old plan
          // for the whole period and the new plan from the change day on, so the switch day is billed
          // twice, and it denies nothing: no tenant check, no plan check, no effective-date or
          // policy check.
          val subscription = store.load(body.subscription_id)
          val day = changeDay(body.effective_date)
          val oldCents = Plans(subscription.plan)
          val newCents = math.round(Plans(body.plan) * (MonthDays - day).toDouble / MonthDays)
          complete(
            StatusCodes.OK,
            Schedule(
              subscription.current_period_start.toString,
              subscription.current_period_end.toString,
              List(Line(subscription.plan, MonthDays, oldCents), Line(body.plan, MonthDays - day, newCents))
            )
          )
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.time.{LocalDate, ZoneOffset}
import java.time.temporal.ChronoUnit

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class PlanChange(subscription_id: String, plan: String, effective_date: String, proration_policy: String)
final case class Line(plan: String, days: Int, amount_cents: Long)
final case class Schedule(period_start: String, period_end: String, lines: List[Line])

object SubscriptionApi {
  implicit val system: ActorSystem = ActorSystem("billing")
  implicit val changeFormat: RootJsonFormat[PlanChange] = jsonFormat4(PlanChange)
  implicit val lineFormat: RootJsonFormat[Line] = jsonFormat3(Line)
  implicit val scheduleFormat: RootJsonFormat[Schedule] = jsonFormat3(Schedule)

  val EffectiveNow = "now"
  val ProrationPolicies = Set("actual_days")
  val Plans = Map("starter-monthly" -> 1900L, "scale-monthly" -> 9900L)

  val store = SubscriptionStore.open()

  def proratedCents(priceCents: Long, days: Int, periodDays: Int): Long =
    math.round(priceCents.toDouble * days / periodDays)

  def scheduleFor(subscription: Subscription, plan: String, changeAt: LocalDate): Schedule = {
    val goesToNextPeriod = !changeAt.isBefore(subscription.next_period_start)
    val (periodStart, periodEnd) =
      if (goesToNextPeriod) (subscription.next_period_start, subscription.next_period_end)
      else (subscription.current_period_start, subscription.current_period_end)
    val periodDays = ChronoUnit.DAYS.between(periodStart, periodEnd).toInt
    val oldDays = ChronoUnit.DAYS.between(periodStart, changeAt).toInt
    val newDays = ChronoUnit.DAYS.between(changeAt, periodEnd).toInt
    require(oldDays + newDays == periodDays, "a plan change must charge every day of the period exactly once")
    Schedule(
      periodStart.toString,
      periodEnd.toString,
      List(
        Line(subscription.plan, oldDays, proratedCents(Plans(subscription.plan), oldDays, periodDays)),
        Line(plan, newDays, proratedCents(Plans(plan), newDays, periodDays))
      )
    )
  }

  val route: Route =
    path("v1" / "subscriptions") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[PlanChange]) { body =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else if (!Plans.contains(body.plan)) {
              complete(StatusCodes.BadRequest, """{"error":"unknown plan"}""")
            } else if (!ProrationPolicies.contains(body.proration_policy)) {
              complete(StatusCodes.BadRequest, """{"error":"unsupported proration policy"}""")
            } else if (store.load(body.subscription_id).tenant != tenantOpt.get) {
              complete(StatusCodes.NotFound, """{"error":"unknown subscription"}""")
            } else {
              val subscription = store.load(body.subscription_id)
              val nextPeriodStart = subscription.next_period_start
              val changeAt: LocalDate =
                if (body.effective_date == EffectiveNow) LocalDate.now(ZoneOffset.UTC)
                else if (body.effective_date == nextPeriodStart.toString) nextPeriodStart
                else null
              if (changeAt == null) {
                complete(StatusCodes.BadRequest, """{"error":"effective date must be now or the next period boundary"}""")
              } else {
                complete(StatusCodes.OK, scheduleFor(subscription, body.plan, changeAt))
              }
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

#include <cmath>
#include <iostream>
#include <map>
#include <string>

using json = nlohmann::json;

constexpr int kMonthDays = 30;
const std::map<std::string, long> kPlans = {{"starter-monthly", 1900}, {"scale-monthly", 9900}};

struct Subscription {
  std::string tenant;
  std::string plan;
  std::string current_period_start;
  std::string current_period_end;
  std::string next_period_start;
  std::string next_period_end;
};

struct SubscriptionStore {
  std::optional<Subscription> load(const std::string& subscriptionId);
};

SubscriptionStore store;

int changeDay(const std::string& value);

int main() {
  httplib::Server svr;

  svr.Post("/v1/subscriptions", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: a model-generated draft. It prorates over a thirty-day month, charges the old plan for
    // the whole period and the new plan from the change day on, so the switch day is billed twice,
    // and it denies nothing: no tenant check, no plan check, no effective-date or policy check.
    const json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto subscription = store.load(body.value("subscription_id", std::string()));
    const int day = changeDay(body.value("effective_date", std::string()));
    const long oldCents = kPlans.at(subscription->plan);
    const long newCents =
        std::lround(static_cast<double>(kPlans.at(body.value("plan", std::string()))) * (kMonthDays - day) / kMonthDays);
    std::cout << "plan change subscription=" << body.value("subscription_id", std::string()) << "\\n";
    res.status = 200;
    res.set_content(
        json{{"subscription_id", body.value("subscription_id", std::string())},
             {"effective_at", body.value("effective_date", std::string())},
             {"proration_policy", body.value("proration_policy", std::string("actual_days"))},
             {"invoice_schedule",
              json::array({json{{"period_start", subscription->current_period_start},
                                {"period_end", subscription->current_period_end},
                                {"lines", json::array({json{{"plan", subscription->plan},
                                                            {"days", kMonthDays},
                                                            {"amount_cents", oldCents}},
                                                       json{{"plan", body.value("plan", std::string())},
                                                            {"days", kMonthDays - day},
                                                            {"amount_cents", newCents}}})}}})},
             {"total_cents", oldCents + newCents}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cmath>
#include <iostream>
#include <map>
#include <optional>
#include <set>
#include <stdexcept>
#include <string>

using json = nlohmann::json;
using days = std::chrono::sys_days;

const std::string kEffectiveNow = "now";
const std::set<std::string> kProrationPolicies = {"actual_days"};
const std::map<std::string, long> kPlans = {{"starter-monthly", 1900}, {"scale-monthly", 9900}};

struct Subscription {
  std::string tenant;
  std::string plan;
  std::string current_period_start;
  std::string current_period_end;
  std::string next_period_start;
  std::string next_period_end;
};

struct SubscriptionStore {
  std::optional<Subscription> load(const std::string& subscriptionId);
};

SubscriptionStore store;

days parseDate(const std::string& iso);

long daysBetween(const days& from, const days& to) { return (to - from).count(); }

long proratedCents(long priceCents, long days, long periodDays) {
  return std::lround(static_cast<double>(priceCents * days) / static_cast<double>(periodDays));
}

json scheduleFor(const Subscription& subscription, const std::string& plan, const days& changeAt) {
  const days nextPeriodStart = parseDate(subscription.next_period_start);
  const bool goesToNextPeriod = changeAt >= nextPeriodStart;
  const days periodStart = goesToNextPeriod ? nextPeriodStart : parseDate(subscription.current_period_start);
  const days periodEnd = goesToNextPeriod ? parseDate(subscription.next_period_end)
                                          : parseDate(subscription.current_period_end);
  const long periodDays = daysBetween(periodStart, periodEnd);
  const long oldDays = daysBetween(periodStart, changeAt);
  const long newDays = daysBetween(changeAt, periodEnd);
  if (oldDays + newDays != periodDays) {
    throw std::logic_error("a plan change must charge every day of the period exactly once");
  }
  return json{{"period_start", subscription.current_period_start},
              {"period_end", subscription.current_period_end},
              {"lines", json::array({json{{"plan", subscription.plan},
                                          {"days", oldDays},
                                          {"amount_cents", proratedCents(kPlans.at(subscription.plan), oldDays, periodDays)}},
                                     json{{"plan", plan},
                                          {"days", newDays},
                                          {"amount_cents", proratedCents(kPlans.at(plan), newDays, periodDays)}}})}};
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/subscriptions", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto plan = body.value("plan", std::string());
    if (kPlans.count(plan) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unknown plan"})", "application/json");
      return;
    }
    const auto policy = body.value("proration_policy", std::string("actual_days"));
    if (kProrationPolicies.count(policy) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"unsupported proration policy"})", "application/json");
      return;
    }
    const auto subscription = store.load(body.value("subscription_id", std::string()));
    if (!subscription || subscription->tenant != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"unknown subscription"})", "application/json");
      return;
    }
    const auto nextPeriodStart = subscription->next_period_start;
    const auto effectiveDate = body.value("effective_date", std::string());
    std::optional<days> changeAt;
    if (effectiveDate == kEffectiveNow) {
      changeAt = std::chrono::floor<days>(std::chrono::system_clock::now());
    } else if (effectiveDate == nextPeriodStart) {
      changeAt = parseDate(nextPeriodStart);
    }
    if (!changeAt) {
      res.status = 400;
      res.set_content(R"({"error":"effective date must be now or the next period boundary"})", "application/json");
      return;
    }
    const auto schedule = scheduleFor(*subscription, plan, *changeAt);
    long totalCents = 0;
    for (const auto& line : schedule.at("lines")) totalCents += line.at("amount_cents").get<long>();
    std::cout << "plan change tenant=" << tenant << " subscription=" << subscription->tenant
              << " plan=" << plan << "\\n";
    res.status = 200;
    res.set_content(json{{"subscription_id", body.value("subscription_id", std::string())},
                         {"effective_at", nextPeriodStart},
                         {"proration_policy", policy},
                         {"invoice_schedule", json::array({schedule})},
                         {"total_cents", totalCents}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Write the guard clauses first, in cost order: tenant (401), plan in the catalogue (400), proration policy the platform implements (400), subscription that belongs to this tenant (404), then the effective date (400 when it is neither `now` nor the next boundary). Every one of them returns before any arithmetic.',
    'The period length is data, not a constant: `period_days = (period_end - period_start).days` and a line costs `round(price_cents * days / period_days)`. A thirty-day month over-bills a February slice and under-bills a 31-day one, and nothing about the demo looks wrong until a real month is billed.',
    'Model the change as a half-open split of the period: the old plan covers `[period_start, change_at)` and the new plan `[change_at, period_end)`. Then `old_days + new_days == period_days` holds by construction, and the switch day belongs to exactly one line. Assert it, so a future edit cannot silently reintroduce the double charge.',
  ],
  debrief: `The interviewer is testing whether you can review generated billing arithmetic. Four defects are being checked: authentication and tenancy at the boundary (a schedule is another tenant's data), validation of the effective date and the proration policy (a change the platform cannot compute must be refused, not approximated), the divisor (the actual days of the period, never 30), and the exclusive split of the period (the switch day is charged once, by one plan). The second one is what candidates miss: an endpoint that denies nothing looks friendlier than it is, because every unvalidated input ends up multiplied by a price. Real billing systems add a rounding policy per currency, credit notes instead of negative lines, an idempotency key on the change request itself, an audit record of the plan version used for each line, and a scheduled job that recomputes and compares rather than trusting the handler's arithmetic.`,
};
