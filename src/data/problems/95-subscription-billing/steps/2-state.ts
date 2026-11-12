import type {Step} from '@/lib/types';

export const billingCursorStep: Step = {
  id: 'state',
  title: 'Redis run markers: one charge per subscription period',
  concept: 'redis',
  file: 'state',
  focus: ['billing', 'redis', 'processor'],
  task: `## Task

**Starting point.** The starter is the billing run for one invoice, \`run_billing(invoice_id)\`: it
loads the invoice (\`billing.store\`), reads the run marker \`billing:run:{subscription_id}:{period_start}\`,
answers \`charged\` when one exists, otherwise charges through \`processor.charge_invoice\` (step 3,
provided as \`billing.processor\`) and writes \`done\` with a 30-day expiry. It returns
\`{invoice_id, state, reference, reason}\` and hides four flaws.

**Failure mode the checks target.** Two runners for one period both charge; a retry cannot say which
charge billed the period; a run that crashed after the processor charged is taken for a finished one,
or a crashed run that charged nothing is never billed; and a retry after the marker expired charges
again.

- **Claim** the marker with one \`SET … NX\` (value \`claimed\`) **before** the charge; the runner that
  loses the claim does not charge.
- After a charge, **confirm** the marker as \`charged:{reference}\`; a later run answers that
  reference without a call.
- A marker still \`claimed\` belongs to a run in flight or one that crashed: ask
  \`processor.lookup_invoice\`, adopt and confirm the reference it reports, else answer \`in_flight\`.
  Never charge on someone else's claim.
- The marker has **no expiry**: it outlives the period it guards.`,
  sequence: {
    participants: ['Billing run', 'Redis', 'Payment processor'],
    messages: [
      {from: 'Billing run', to: 'Redis', label: 'SET billing:run:{sub}:{period} claimed NX', kind: 'sync'},
      {from: 'Redis', to: 'Billing run', label: 'OK → ours · nil → someone else’s', kind: 'reply'},
      {from: 'Billing run', to: 'Payment processor', label: 'charge_invoice (ours only)', kind: 'sync'},
      {from: 'Billing run', to: 'Redis', label: 'SET marker charged:{reference} · no expiry', kind: 'sync'},
      {
        from: 'Billing run',
        to: 'Payment processor',
        label: 'lookup_invoice when the marker is still claimed',
        kind: 'sync',
      },
      {from: 'Payment processor', to: 'Billing run', label: 'reference → confirm · nothing → in_flight', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'claim',
      title: 'Claims the period atomically before charging',
      detail:
        'Two runners race for one period: exactly one claims the marker with `SET … NX` and charges, the other answers without a `Charge`. The starter reads the marker, charges, then writes it, so both runners charge.',
      match: {
        python: {all: [/nx\s*=\s*True/], order: [/nx\s*=\s*True/, /processor\.charge_invoice\(/]},
        typescript: {all: [/['"]NX['"]/], order: [/['"]NX['"]/, /chargeInvoice\(/]},
        go: {all: [/\.SetNX\(/], order: [/\.SetNX\(/, /processor\.ChargeInvoice\(/]},
        scala: {all: [/\.nx\(\)/], order: [/\.nx\(\)/, /Processor\.chargeInvoice\(/]},
        cpp: {all: [/UpdateType::NOT_EXIST/], order: [/UpdateType::NOT_EXIST/, /processor::chargeInvoice\(/]},
      },
    },
    {
      id: 'confirm-reference',
      title: 'Confirms the marker with the charge reference',
      detail:
        'After a charge the marker holds `charged:{reference}`, and a second run answers that reference without calling the processor. The starter writes `done`, so a retry answers a charge it cannot name.',
      match: {
        python: {all: [/["']charged:/], none: [/["']done["']/]},
        typescript: {all: [/['"`]charged:/], none: [/['"]done['"]/]},
        go: {all: [/"charged:"/], none: [/"done"/]},
        scala: {all: [/"charged:/], none: [/"done"/]},
        cpp: {all: [/"charged:"/], none: [/"done"/]},
      },
    },
    {
      id: 'reconcile-claim',
      title: 'Reconciles a claim nobody confirmed',
      detail:
        'A marker still `claimed` is reconciled with `lookup_invoice`/`lookupInvoice`: a charge the processor holds is adopted and confirmed, no charge answers `in_flight`, and neither path calls `Charge`. The starter treats any marker as a finished run.',
      match: {
        python: {all: [/processor\.lookup_invoice\(/, /in_flight/]},
        typescript: {all: [/lookupInvoice\(/, /in_flight/]},
        go: {all: [/processor\.LookupInvoice\(/, /in_flight/]},
        scala: {all: [/Processor\.lookupInvoice\(/, /in_flight/]},
        cpp: {all: [/processor::lookupInvoice\(/, /in_flight/]},
      },
    },
    {
      id: 'marker-persists',
      title: 'The marker outlives the period it guards',
      detail:
        'The marker carries no expiry, so a retry weeks later still finds the period charged. The starter writes it with a 30-day TTL (`MONTH_TTL_S`), and the retry after that charges the closed period again.',
      match: {
        python: {all: [/marker_key\(/], none: [/MONTH_TTL_S/, /\bex\s*=/]},
        typescript: {all: [/markerKey\(/], none: [/MONTH_TTL_S/, /['"]EX['"]/]},
        go: {all: [/markerKey\(/], none: [/monthTTL/]},
        scala: {all: [/markerKey\(/], none: [/MonthTtlSeconds/, /\.ex\(/]},
        cpp: {all: [/markerKey\(/], none: [/kMonthTtl/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis

from billing import processor, store  # processor.charge_invoice, lookup_invoice; store.find_invoice

r = redis.Redis(host="redis", port=6379, decode_responses=True)

MONTH_TTL_S = 30 * 24 * 3600


def marker_key(subscription_id: str, period_start: str) -> str:
    return f"billing:run:{subscription_id}:{period_start}"


def run_billing(invoice_id: str) -> dict:
    """Charge the invoice's period once; answers {invoice_id, state, reference, reason}."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    invoice = store.find_invoice(invoice_id)
    key = marker_key(invoice["subscription_id"], invoice["period_start"])
    if r.get(key) is not None:
        return {"invoice_id": invoice_id, "state": "charged", "reference": "", "reason": ""}
    outcome = processor.charge_invoice(invoice)
    if outcome["state"] == "charged":
        r.set(key, "done", ex=MONTH_TTL_S)
    return {"invoice_id": invoice_id, **outcome}
`,
      solution: `import redis

from billing import processor, store  # processor.charge_invoice, lookup_invoice; store.find_invoice

r = redis.Redis(host="redis", port=6379, decode_responses=True)

CLAIMED = "claimed"


def marker_key(subscription_id: str, period_start: str) -> str:
    return f"billing:run:{subscription_id}:{period_start}"


def run_billing(invoice_id: str) -> dict:
    """Charge the invoice's period once; answers {invoice_id, state, reference, reason}."""
    invoice = store.find_invoice(invoice_id)
    key = marker_key(invoice["subscription_id"], invoice["period_start"])
    # One atomic claim, no expiry: exactly one runner per period gets past this line.
    if r.set(key, CLAIMED, nx=True):
        outcome = processor.charge_invoice(invoice)
        if outcome["state"] == "charged":
            r.set(key, f"charged:{outcome['reference']}")
        return {"invoice_id": invoice_id, **outcome}
    marker = r.get(key) or ""
    if marker.startswith("charged:"):
        return {"invoice_id": invoice_id, "state": "charged", "reference": marker.split(":", 1)[1], "reason": ""}
    # Claimed and never confirmed: a run in flight, or one that crashed. The processor knows which.
    found = processor.lookup_invoice(invoice_id)
    if found is not None and found["state"] == "charged":
        r.set(key, f"charged:{found['reference']}")
        return {"invoice_id": invoice_id, "state": "charged", "reference": found["reference"], "reason": ""}
    return {"invoice_id": invoice_id, "state": "in_flight", "reference": "", "reason": ""}
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {chargeInvoice, lookupInvoice} from 'billing/processor';
import {type Invoice, findInvoice} from 'billing/store';

const redis = new Redis({host: 'redis', port: 6379});

export const MONTH_TTL_S = 30 * 24 * 3600;

export const markerKey = (subscriptionId: string, periodStart: string): string => \`billing:run:\${subscriptionId}:\${periodStart}\`;

/** Charge the invoice's period once; answers {invoice_id, state, reference, reason}. */
export async function runBilling(invoiceId: string) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const invoice = (await findInvoice(invoiceId)) as Invoice;
  const key = markerKey(invoice.subscription_id, invoice.period_start);
  if ((await redis.get(key)) !== null) return {invoice_id: invoiceId, state: 'charged', reference: '', reason: ''};
  const outcome = await chargeInvoice(invoice);
  if (outcome.state === 'charged') await redis.set(key, 'done', 'EX', MONTH_TTL_S);
  return {invoice_id: invoiceId, ...outcome};
}
`,
      solution: `import Redis from 'ioredis';

import {chargeInvoice, lookupInvoice} from 'billing/processor';
import {type Invoice, findInvoice} from 'billing/store';

const redis = new Redis({host: 'redis', port: 6379});

export const CLAIMED = 'claimed';

export const markerKey = (subscriptionId: string, periodStart: string): string => \`billing:run:\${subscriptionId}:\${periodStart}\`;

/** Charge the invoice's period once; answers {invoice_id, state, reference, reason}. */
export async function runBilling(invoiceId: string) {
  const invoice = (await findInvoice(invoiceId)) as Invoice;
  const key = markerKey(invoice.subscription_id, invoice.period_start);
  // One atomic claim, no expiry: exactly one runner per period gets past this line.
  if ((await redis.set(key, CLAIMED, 'NX')) === 'OK') {
    const outcome = await chargeInvoice(invoice);
    if (outcome.state === 'charged') await redis.set(key, \`charged:\${outcome.reference}\`);
    return {invoice_id: invoiceId, ...outcome};
  }
  const marker = (await redis.get(key)) ?? '';
  if (marker.startsWith('charged:')) return {invoice_id: invoiceId, state: 'charged', reference: marker.slice('charged:'.length), reason: ''};
  // Claimed and never confirmed: a run in flight, or one that crashed. The processor knows which.
  const found = await lookupInvoice(invoiceId);
  if (found !== null && found.state === 'charged') {
    await redis.set(key, \`charged:\${found.reference}\`);
    return {invoice_id: invoiceId, state: 'charged', reference: found.reference, reason: ''};
  }
  return {invoice_id: invoiceId, state: 'in_flight', reference: '', reason: ''};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"github.com/redis/go-redis/v9"

	"billing/processor" // processor.ChargeInvoice, LookupInvoice
	"billing/store"     // store.FindInvoice, store.Outcome
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const monthTTL = 30 * 24 * time.Hour

func markerKey(subscriptionID, periodStart string) string {
	return "billing:run:" + subscriptionID + ":" + periodStart
}

// runBilling charges the invoice's period once and answers what came of it.
func runBilling(ctx context.Context, invoiceID string) (store.Outcome, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	invoice := store.FindInvoice(ctx, invoiceID)
	key := markerKey(invoice.SubscriptionID, invoice.PeriodStart)
	if _, err := rdb.Get(ctx, key).Result(); err == nil {
		return store.Outcome{State: "charged"}, nil
	} else if err != redis.Nil {
		return store.Outcome{}, err
	}
	outcome := processor.ChargeInvoice(ctx, invoice)
	if outcome.State == "charged" {
		if err := rdb.Set(ctx, key, "done", monthTTL).Err(); err != nil {
			return outcome, err
		}
	}
	return outcome, nil
}
`,
      solution: `package main

import (
	"context"
	"strings"

	"github.com/redis/go-redis/v9"

	"billing/processor" // processor.ChargeInvoice, LookupInvoice
	"billing/store"     // store.FindInvoice, store.Outcome
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const claimed = "claimed"

func markerKey(subscriptionID, periodStart string) string {
	return "billing:run:" + subscriptionID + ":" + periodStart
}

// runBilling charges the invoice's period once and answers what came of it.
func runBilling(ctx context.Context, invoiceID string) (store.Outcome, error) {
	invoice := store.FindInvoice(ctx, invoiceID)
	key := markerKey(invoice.SubscriptionID, invoice.PeriodStart)
	// One atomic claim, no expiry: exactly one runner per period gets past this line.
	ours, err := rdb.SetNX(ctx, key, claimed, 0).Result()
	if err != nil {
		return store.Outcome{}, err
	}
	if ours {
		outcome := processor.ChargeInvoice(ctx, invoice)
		if outcome.State == "charged" {
			if err := rdb.Set(ctx, key, "charged:"+outcome.Reference, 0).Err(); err != nil {
				return outcome, err
			}
		}
		return outcome, nil
	}
	marker, err := rdb.Get(ctx, key).Result()
	if err != nil && err != redis.Nil {
		return store.Outcome{}, err
	}
	if strings.HasPrefix(marker, "charged:") {
		return store.Outcome{State: "charged", Reference: strings.TrimPrefix(marker, "charged:")}, nil
	}
	// Claimed and never confirmed: a run in flight, or one that crashed. The processor knows which.
	if found := processor.LookupInvoice(ctx, invoiceID); found != nil && found.State == "charged" {
		if err := rdb.Set(ctx, key, "charged:"+found.Reference, 0).Err(); err != nil {
			return store.Outcome{}, err
		}
		return store.Outcome{State: "charged", Reference: found.Reference}, nil
	}
	return store.Outcome{State: "in_flight"}, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import billing.{Processor, Store} // Processor.chargeInvoice, lookupInvoice; Store.findInvoice, Store.Outcome

object State {
  val jedis = new JedisPooled("redis", 6379)

  val MonthTtlSeconds: Long = 30L * 24 * 3600

  def markerKey(subscriptionId: String, periodStart: String): String = s"billing:run:$subscriptionId:$periodStart"

  /** Charge the invoice's period once and answer what came of it. */
  def runBilling(invoiceId: String): Store.Outcome = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val invoice = Store.findInvoice(invoiceId).get
    val key = markerKey(invoice.subscriptionId, invoice.periodStart)
    if (jedis.get(key) != null) Store.Outcome("charged", "", "")
    else {
      val outcome = Processor.chargeInvoice(invoice)
      if (outcome.state == "charged") jedis.set(key, "done", SetParams.setParams().ex(MonthTtlSeconds))
      outcome
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams

import billing.{Processor, Store} // Processor.chargeInvoice, lookupInvoice; Store.findInvoice, Store.Outcome

object State {
  val jedis = new JedisPooled("redis", 6379)

  val Claimed = "claimed"

  def markerKey(subscriptionId: String, periodStart: String): String = s"billing:run:$subscriptionId:$periodStart"

  /** Charge the invoice's period once and answer what came of it. */
  def runBilling(invoiceId: String): Store.Outcome = {
    val invoice = Store.findInvoice(invoiceId).get
    val key = markerKey(invoice.subscriptionId, invoice.periodStart)
    // One atomic claim, no expiry: exactly one runner per period gets past this line.
    if (jedis.set(key, Claimed, SetParams.setParams().nx()) == "OK") {
      val outcome = Processor.chargeInvoice(invoice)
      if (outcome.state == "charged") jedis.set(key, s"charged:\${outcome.reference}")
      outcome
    } else {
      val marker = Option(jedis.get(key)).getOrElse("")
      if (marker.startsWith("charged:")) Store.Outcome("charged", marker.stripPrefix("charged:"), "")
      else
        // Claimed and never confirmed: a run in flight, or one that crashed. The processor knows which.
        Processor.lookupInvoice(invoiceId).filter(_.state == "charged") match {
          case Some(found) =>
            jedis.set(key, s"charged:\${found.reference}")
            Store.Outcome("charged", found.reference, "")
          case None => Store.Outcome("in_flight", "", "")
        }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

#include "billing/processor.h"  // processor::chargeInvoice, lookupInvoice
#include "billing/store.h"      // store::findInvoice, store::Outcome

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::hours kMonthTtl{30 * 24};

std::string markerKey(const std::string& subscription_id, const std::string& period_start) {
  return "billing:run:" + subscription_id + ":" + period_start;
}

// Charge the invoice's period once and answer what came of it.
store::Outcome runBilling(const std::string& invoice_id) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const store::Invoice invoice = *store::findInvoice(invoice_id);
  const std::string key = markerKey(invoice.subscription_id, invoice.period_start);
  if (redis.get(key)) return store::Outcome{"charged", "", ""};
  const store::Outcome outcome = processor::chargeInvoice(invoice);
  if (outcome.state == "charged") redis.set(key, "done", kMonthTtl);
  return outcome;
}
`,
      solution: `#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

#include "billing/processor.h"  // processor::chargeInvoice, lookupInvoice
#include "billing/store.h"      // store::findInvoice, store::Outcome

sw::redis::Redis redis("tcp://redis:6379");

const std::string kClaimed = "claimed";
const std::string kCharged = "charged:";

std::string markerKey(const std::string& subscription_id, const std::string& period_start) {
  return "billing:run:" + subscription_id + ":" + period_start;
}

// Charge the invoice's period once and answer what came of it.
store::Outcome runBilling(const std::string& invoice_id) {
  const store::Invoice invoice = *store::findInvoice(invoice_id);
  const std::string key = markerKey(invoice.subscription_id, invoice.period_start);
  // One atomic claim, no expiry: exactly one runner per period gets past this line.
  if (redis.set(key, kClaimed, std::chrono::milliseconds(0), sw::redis::UpdateType::NOT_EXIST)) {
    const store::Outcome outcome = processor::chargeInvoice(invoice);
    if (outcome.state == "charged") redis.set(key, kCharged + outcome.reference);
    return outcome;
  }
  const std::string marker = redis.get(key).value_or("");
  if (marker.rfind(kCharged, 0) == 0) return store::Outcome{"charged", marker.substr(kCharged.size()), ""};
  // Claimed and never confirmed: a run in flight, or one that crashed. The processor knows which.
  const auto found = processor::lookupInvoice(invoice_id);
  if (found && found->state == "charged") {
    redis.set(key, kCharged + found->reference);
    return store::Outcome{"charged", found->reference, ""};
  }
  return store::Outcome{"in_flight", "", ""};
}
`,
    },
  },
  harness: {
    python: `import grpc

import subscription_billing_pb2 as pb
import subscription_billing_pb2_grpc
from billing import store

KEY = "billing:run:sub_1:2026-03-01"


class Processor(subscription_billing_pb2_grpc.ProcessorServicer):
    """A processor that keeps what it charged per invoice and answers a repeated idempotency key with the first charge."""

    def __init__(self):
        self.charged = {}  # invoice_id -> (reference, total_cents)
        self.keys = {}
        self.charges = 0

    def Charge(self, request, context):
        if request.idempotency_key not in self.keys:
            self.charges += 1
            reference = f"ch_{self.charges}"
            _, total = self.charged.get(request.invoice_id, ("", 0))
            self.charged[request.invoice_id] = (reference, total + request.amount_cents)
            self.keys[request.idempotency_key] = reference
        return pb.ChargeResult(status="succeeded", reference=self.keys[request.idempotency_key])

    def GetInvoice(self, request, context):
        if request.invoice_id not in self.charged:
            context.abort(grpc.StatusCode.NOT_FOUND, f"no charge for {request.invoice_id}")
        reference, total = self.charged[request.invoice_id]
        return pb.ProcessorInvoice(invoice_id=request.invoice_id, state="charged", reference=reference, total_cents=total)


def _world(ctx):
    processor = Processor()
    ctx.grpc.serve(subscription_billing_pb2_grpc.add_ProcessorServicer_to_server, processor)
    store.put_subscription("sub_1", "t-acme", "scale", "2026-03-01", "2026-04-01")
    invoice = store.open_invoice("sub_1", "2026-03-01", "2026-04-01", 9900)
    return ctx.load("state"), processor, invoice["invoice_id"]


def _charges(ctx):
    return len(ctx.grpc.calls_to("Charge"))


def check_claim(ctx):
    m, processor, invoice_id = _world(ctx)
    # A second runner for the same period lands right after this run's first marker command.
    rival = ctx.redis_after(KEY, lambda: m.run_billing(invoice_id))
    first = m.run_billing(invoice_id)
    assert rival.fired, f"run_billing never touched the run marker {KEY}"
    if rival.error is not None:
        raise rival.error
    assert _charges(ctx) == 1, f"two runners for one period made {_charges(ctx)} Charge calls: claim the marker with SET NX before charging, and do not charge on a claim you lost"
    states = sorted([first["state"], rival.result["state"]])
    assert "charged" in states, f"neither runner reports the charge: {first}, {rival.result}"


def check_confirm_reference(ctx):
    m, processor, invoice_id = _world(ctx)
    first = m.run_billing(invoice_id)
    assert first["state"] == "charged" and first["reference"] == "ch_1", f"the first run answered {first}, expected the processor's reference ch_1"
    marker = ctx.redis.get(KEY)
    assert marker == "charged:ch_1", f"after the charge the marker holds {marker!r}, expected 'charged:ch_1': the marker must name the charge that billed the period"
    again = m.run_billing(invoice_id)
    assert again["state"] == "charged" and again["reference"] == "ch_1", f"a second run answered {again}, expected the recorded reference ch_1"
    assert _charges(ctx) == 1, f"the second run called Charge again ({_charges(ctx)} calls)"


def check_reconcile_claim(ctx):
    m, processor, invoice_id = _world(ctx)
    # A run claimed the period, the processor charged, and the run crashed before confirming.
    ctx.redis.set(KEY, "claimed")
    processor.charged[invoice_id] = ("ch_crashed", 9900)
    outcome = m.run_billing(invoice_id)
    assert outcome["state"] == "charged" and outcome["reference"] == "ch_crashed", f"a claim left by a crashed run answered {outcome}: the processor holds ch_crashed for the invoice, ask lookup_invoice and adopt it"
    assert ctx.redis.get(KEY) == "charged:ch_crashed", f"the adopted charge must confirm the marker, it holds {ctx.redis.get(KEY)!r}"
    assert _charges(ctx) == 0, "reconciling a claim must not call Charge"
    # A run claimed the period and is still waiting on the processor, which holds nothing yet.
    other = store.open_invoice("sub_1", "2026-04-01", "2026-05-01", 9900)
    ctx.redis.set("billing:run:sub_1:2026-04-01", "claimed")
    outcome = m.run_billing(other["invoice_id"])
    assert outcome["state"] == "in_flight", f"a claim the processor knows nothing about answered {outcome}, expected in_flight: another run owns the period"
    assert _charges(ctx) == 0, "a runner must not charge on another run's claim"


def check_marker_persists(ctx):
    m, processor, invoice_id = _world(ctx)
    m.run_billing(invoice_id)
    ttl = ctx.redis.ttl(KEY)
    assert ttl == -1, f"the run marker expires in {ttl} s: a retry after that charges the period again. It must not expire"
    ctx.clock.advance(40 * 24 * 3600)
    again = m.run_billing(invoice_id)
    assert _charges(ctx) == 1, f"a retry 40 days later called Charge again and answered {again}"
`,
    typescript: `const KEY = 'billing:run:sub_1:2026-03-01';

/** A processor that keeps what it charged per invoice and answers a repeated idempotency key with the first charge. */
async function world(ctx) {
  const pkg = ctx.proto('subscription_billing.proto');
  const charged = new Map<string, {reference: string; total: number}>();
  const keys = new Map<string, string>();
  let charges = 0;
  ctx.grpc.serve(pkg.subbilling.Processor.service, {
    Charge(call, callback) {
      const {invoice_id, amount_cents, idempotency_key} = call.request;
      if (!keys.has(idempotency_key)) {
        charges += 1;
        const reference = \`ch_\${charges}\`;
        charged.set(invoice_id, {reference, total: (charged.get(invoice_id)?.total ?? 0) + Number(amount_cents)});
        keys.set(idempotency_key, reference);
      }
      callback(null, {status: 'succeeded', reference: keys.get(idempotency_key), decline_code: ''});
    },
    GetInvoice(call, callback) {
      const found = charged.get(call.request.invoice_id);
      if (found === undefined) return callback({code: ctx.grpc.status.NOT_FOUND, details: \`no charge for \${call.request.invoice_id}\`});
      callback(null, {invoice_id: call.request.invoice_id, state: 'charged', reference: found.reference, total_cents: found.total});
    },
  });
  const store = ctx.load('/support/billing/store.ts');
  await store.putSubscription('sub_1', 't-acme', 'scale', '2026-03-01', '2026-04-01');
  const invoice = await store.openInvoice('sub_1', '2026-03-01', '2026-04-01', 9900);
  return {m: ctx.load('state'), store, charged, invoiceId: invoice.invoice_id};
}

const charges = ctx => ctx.grpc.callsTo('Charge').length;

export async function check_claim(ctx) {
  const {m, invoiceId} = await world(ctx);
  // A second runner for the same period lands right after this run's first marker command.
  const rival = ctx.redisAfter(KEY, () => m.runBilling(invoiceId));
  const first = await m.runBilling(invoiceId);
  assert(rival.fired, \`runBilling never touched the run marker \${KEY}\`);
  const second = await rival.result;
  assert.equal(charges(ctx), 1, \`two runners for one period made \${charges(ctx)} Charge calls: claim the marker with SET NX before charging, and do not charge on a claim you lost\`);
  assert(first.state === 'charged' || second.state === 'charged', \`neither runner reports the charge: \${JSON.stringify(first)}, \${JSON.stringify(second)}\`);
}

export async function check_confirm_reference(ctx) {
  const {m, invoiceId} = await world(ctx);
  const first = await m.runBilling(invoiceId);
  assert(first.state === 'charged' && first.reference === 'ch_1', \`the first run answered \${JSON.stringify(first)}, expected the processor's reference ch_1\`);
  const marker = ctx.redis.get(KEY);
  assert.equal(marker, 'charged:ch_1', \`after the charge the marker holds \${JSON.stringify(marker)}, expected 'charged:ch_1': the marker must name the charge that billed the period\`);
  const again = await m.runBilling(invoiceId);
  assert(again.state === 'charged' && again.reference === 'ch_1', \`a second run answered \${JSON.stringify(again)}, expected the recorded reference ch_1\`);
  assert.equal(charges(ctx), 1, \`the second run called Charge again (\${charges(ctx)} calls)\`);
}

export async function check_reconcile_claim(ctx) {
  const {m, store, charged, invoiceId} = await world(ctx);
  // A run claimed the period, the processor charged, and the run crashed before confirming.
  ctx.redis.set(KEY, 'claimed');
  charged.set(invoiceId, {reference: 'ch_crashed', total: 9900});
  let outcome = await m.runBilling(invoiceId);
  assert(outcome.state === 'charged' && outcome.reference === 'ch_crashed', \`a claim left by a crashed run answered \${JSON.stringify(outcome)}: the processor holds ch_crashed for the invoice, ask lookupInvoice and adopt it\`);
  assert.equal(ctx.redis.get(KEY), 'charged:ch_crashed', 'the adopted charge must confirm the marker');
  assert.equal(charges(ctx), 0, 'reconciling a claim must not call Charge');
  // A run claimed the period and is still waiting on the processor, which holds nothing yet.
  const other = await store.openInvoice('sub_1', '2026-04-01', '2026-05-01', 9900);
  ctx.redis.set('billing:run:sub_1:2026-04-01', 'claimed');
  outcome = await m.runBilling(other.invoice_id);
  assert.equal(outcome.state, 'in_flight', \`a claim the processor knows nothing about answered \${JSON.stringify(outcome)}, expected in_flight: another run owns the period\`);
  assert.equal(charges(ctx), 0, "a runner must not charge on another run's claim");
}

export async function check_marker_persists(ctx) {
  const {m, invoiceId} = await world(ctx);
  await m.runBilling(invoiceId);
  const ttl = ctx.redis.ttl(KEY);
  assert.equal(ttl, -1, \`the run marker expires in \${ttl} s: a retry after that charges the period again. It must not expire\`);
  ctx.clock.advance(40 * 24 * 3600);
  const again = await m.runBilling(invoiceId);
  assert.equal(charges(ctx), 1, \`a retry 40 days later called Charge again and answered \${JSON.stringify(again)}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "billing/gen/subscription_billing"
	"billing/store"

	"leetbuild/harness"
)

const stateKey = "billing:run:sub_1:2026-03-01"

var stateBg = context.Background()

type charge struct {
	reference string
	total     int64
}

// stateProcessor keeps what it charged per invoice and answers a repeated idempotency key with the first charge.
type stateProcessor struct {
	pb.UnimplementedProcessorServer
	charged map[string]charge
	keys    map[string]string
	charges int
}

func (p *stateProcessor) Charge(_ context.Context, req *pb.ChargeRequest) (*pb.ChargeResult, error) {
	if _, seen := p.keys[req.GetIdempotencyKey()]; !seen {
		p.charges++
		reference := fmt.Sprintf("ch_%d", p.charges)
		p.charged[req.GetInvoiceId()] = charge{reference, p.charged[req.GetInvoiceId()].total + req.GetAmountCents()}
		p.keys[req.GetIdempotencyKey()] = reference
	}
	return &pb.ChargeResult{Status: "succeeded", Reference: p.keys[req.GetIdempotencyKey()]}, nil
}

func (p *stateProcessor) GetInvoice(_ context.Context, req *pb.GetInvoiceRequest) (*pb.ProcessorInvoice, error) {
	found, ok := p.charged[req.GetInvoiceId()]
	if !ok {
		return nil, status.Errorf(codes.NotFound, "no charge for %s", req.GetInvoiceId())
	}
	return &pb.ProcessorInvoice{InvoiceId: req.GetInvoiceId(), State: "charged", Reference: found.reference, TotalCents: found.total}, nil
}

func stateWorld(ctx *harness.Ctx) (*stateProcessor, string) {
	p := &stateProcessor{charged: map[string]charge{}, keys: map[string]string{}}
	pb.RegisterProcessorServer(ctx.GRPC.Server(""), p)
	store.PutSubscription(stateBg, "sub_1", "t-acme", "scale", "2026-03-01", "2026-04-01")
	return p, store.OpenInvoice(stateBg, "sub_1", "2026-03-01", "2026-04-01", 9900).InvoiceID
}

func run(ctx *harness.Ctx, invoiceID string) store.Outcome {
	outcome, err := runBilling(stateBg, invoiceID)
	ctx.NoError(err, "runBilling(%s)", invoiceID)
	return outcome
}

func stateCharges(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("Charge", "")) }

func CheckClaim(ctx *harness.Ctx) {
	_, invoiceID := stateWorld(ctx)
	// A second runner for the same period lands right after this run's first marker command.
	rival := ctx.Redis.After(stateKey, func() any {
		outcome, _ := runBilling(stateBg, invoiceID)
		return outcome
	})
	first := run(ctx, invoiceID)
	ctx.Assert(rival.Fired, "runBilling never touched the run marker %s", stateKey)
	ctx.Equal(stateCharges(ctx), 1, "two runners for one period must make one Charge call (claim the marker with SET NX before charging, and do not charge on a claim you lost); Charge calls")
	second, _ := rival.Result.(store.Outcome)
	ctx.Assert(first.State == "charged" || second.State == "charged", "neither runner reports the charge: %+v, %+v", first, second)
}

func CheckConfirmReference(ctx *harness.Ctx) {
	_, invoiceID := stateWorld(ctx)
	first := run(ctx, invoiceID)
	ctx.Assert(first.State == "charged" && first.Reference == "ch_1", "the first run answered %+v, expected the processor's reference ch_1", first)
	marker, _ := ctx.Redis.Get(stateKey)
	ctx.Equal(marker, "charged:ch_1", "after the charge the marker must name the charge that billed the period; the marker")
	again := run(ctx, invoiceID)
	ctx.Assert(again.State == "charged" && again.Reference == "ch_1", "a second run answered %+v, expected the recorded reference ch_1", again)
	ctx.Equal(stateCharges(ctx), 1, "the second run must not call Charge again; Charge calls")
}

func CheckReconcileClaim(ctx *harness.Ctx) {
	p, invoiceID := stateWorld(ctx)
	// A run claimed the period, the processor charged, and the run crashed before confirming.
	ctx.Redis.Set(stateKey, "claimed")
	p.charged[invoiceID] = charge{"ch_crashed", 9900}
	outcome := run(ctx, invoiceID)
	ctx.Assert(outcome.State == "charged" && outcome.Reference == "ch_crashed", "a claim left by a crashed run answered %+v: the processor holds ch_crashed for the invoice, ask LookupInvoice and adopt it", outcome)
	marker, _ := ctx.Redis.Get(stateKey)
	ctx.Equal(marker, "charged:ch_crashed", "the adopted charge must confirm the marker; the marker")
	ctx.Equal(stateCharges(ctx), 0, "reconciling a claim must not call Charge; Charge calls")
	// A run claimed the period and is still waiting on the processor, which holds nothing yet.
	other := store.OpenInvoice(stateBg, "sub_1", "2026-04-01", "2026-05-01", 9900)
	ctx.Redis.Set("billing:run:sub_1:2026-04-01", "claimed")
	outcome = run(ctx, other.InvoiceID)
	ctx.Equal(outcome.State, "in_flight", "a claim the processor knows nothing about belongs to another run; the state")
	ctx.Equal(stateCharges(ctx), 0, "a runner must not charge on another run's claim; Charge calls")
}

func CheckMarkerPersists(ctx *harness.Ctx) {
	_, invoiceID := stateWorld(ctx)
	run(ctx, invoiceID)
	ttl := ctx.Redis.TTL(stateKey)
	ctx.Assert(ttl == -1, "the run marker expires in %d s: a retry after that charges the period again. It must not expire", ttl)
	ctx.Clock.Advance(40 * 24 * 3600)
	again := run(ctx, invoiceID)
	ctx.Assert(stateCharges(ctx) == 1, "a retry 40 days later called Charge again and answered %+v", again)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <memory>
#include <optional>
#include <string>

#include "billing/store.h"
#include "subscription_billing.grpc.pb.h"

namespace {

const std::string kKey = "billing:run:sub_1:2026-03-01";

struct Landed {
  std::string reference;
  long long total = 0;
};

// A processor that keeps what it charged per invoice and answers a repeated idempotency key with the first charge.
class ProcessorPeer final : public subbilling::Processor::Service {
 public:
  std::map<std::string, Landed> charged;
  std::map<std::string, std::string> keys;
  int charges = 0;

  grpc::Status Charge(grpc::ServerContext*, const subbilling::ChargeRequest* req, subbilling::ChargeResult* out) override {
    if (!keys.count(req->idempotency_key())) {
      charges++;
      const std::string reference = "ch_" + std::to_string(charges);
      charged[req->invoice_id()] = {reference, charged[req->invoice_id()].total + req->amount_cents()};
      keys[req->idempotency_key()] = reference;
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

ProcessorPeer& world(harness::Ctx& ctx, std::string& invoice_id) {
  static ProcessorPeer* peer = nullptr;
  delete peer;
  peer = new ProcessorPeer;
  ctx.GRPC.Server("")->RegisterService(peer);
  store::putSubscription("sub_1", "t-acme", "scale", "2026-03-01", "2026-04-01");
  invoice_id = store::openInvoice("sub_1", "2026-03-01", "2026-04-01", 9900).invoice_id;
  return *peer;
}

size_t charges(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("Charge").size(); }

std::string show(const store::Outcome& o) { return o.state + " " + o.reference + " " + o.reason; }

}  // namespace

void CheckClaim(harness::Ctx& ctx) {
  std::string invoice_id;
  world(ctx, invoice_id);
  // Another runner claims the period right after this run's first marker command, if it still can.
  bool fired = false;
  bool rival_claimed = false;
  ctx.Redis.After(kKey, [&] {
    fired = true;
    rival_claimed = ctx.Redis.Set(kKey, "claimed", "NX");
  });
  const store::Outcome first = runBilling(invoice_id);
  ctx.Assert(fired, "runBilling never touched the run marker %s", kKey);
  ctx.Assert(!rival_claimed || charges(ctx) == 0,
             "another runner claimed the period right after runBilling's first marker command, and runBilling charged anyway (%d Charge calls): claim the marker with SET NX before charging, and do not charge on a claim you lost",
             charges(ctx));
  ctx.Equal(charges(ctx), 1, "the runner that holds the claim must charge once; Charge calls");
  ctx.Equal(first.state, "charged", "the runner that holds the claim; its state");
}

void CheckConfirmReference(harness::Ctx& ctx) {
  std::string invoice_id;
  world(ctx, invoice_id);
  const store::Outcome first = runBilling(invoice_id);
  ctx.Assert(first.state == "charged" && first.reference == "ch_1", "the first run answered %s, expected the processor's reference ch_1", show(first));
  ctx.Equal(ctx.Redis.Get(kKey).value_or(""), "charged:ch_1", "after the charge the marker must name the charge that billed the period; the marker");
  const store::Outcome again = runBilling(invoice_id);
  ctx.Assert(again.state == "charged" && again.reference == "ch_1", "a second run answered %s, expected the recorded reference ch_1", show(again));
  ctx.Equal(charges(ctx), 1, "the second run must not call Charge again; Charge calls");
}

void CheckReconcileClaim(harness::Ctx& ctx) {
  std::string invoice_id;
  ProcessorPeer& peer = world(ctx, invoice_id);
  // A run claimed the period, the processor charged, and the run crashed before confirming.
  ctx.Redis.Set(kKey, "claimed");
  peer.charged[invoice_id] = {"ch_crashed", 9900};
  store::Outcome outcome = runBilling(invoice_id);
  ctx.Assert(outcome.state == "charged" && outcome.reference == "ch_crashed",
             "a claim left by a crashed run answered %s: the processor holds ch_crashed for the invoice, ask lookupInvoice and adopt it", show(outcome));
  ctx.Equal(ctx.Redis.Get(kKey).value_or(""), "charged:ch_crashed", "the adopted charge must confirm the marker; the marker");
  ctx.Equal(charges(ctx), 0, "reconciling a claim must not call Charge; Charge calls");
  // A run claimed the period and is still waiting on the processor, which holds nothing yet.
  const store::Invoice other = store::openInvoice("sub_1", "2026-04-01", "2026-05-01", 9900);
  ctx.Redis.Set("billing:run:sub_1:2026-04-01", "claimed");
  outcome = runBilling(other.invoice_id);
  ctx.Equal(outcome.state, "in_flight", "a claim the processor knows nothing about belongs to another run; the state");
  ctx.Equal(charges(ctx), 0, "a runner must not charge on another run's claim; Charge calls");
}

void CheckMarkerPersists(harness::Ctx& ctx) {
  std::string invoice_id;
  world(ctx, invoice_id);
  runBilling(invoice_id);
  const long long ttl = ctx.Redis.TTL(kKey);
  ctx.Assert(ttl == -1, "the run marker expires in %d s: a retry after that charges the period again. It must not expire", ttl);
  ctx.Clock.Advance(40 * 24 * 3600);
  const store::Outcome again = runBilling(invoice_id);
  ctx.Assert(charges(ctx) == 1, "a retry 40 days later called Charge again and answered %s", show(again));
}
`,
  },
  hints: [
    'Start two billing runs for the same invoice at once: the customer is charged twice. A retry of a charged period answers `charged` with no reference, and one 40 days later charges again.',
    'The run reads the marker, charges, and only then writes it, so a second runner between the read and the write sees nothing. The marker says `done`, not which charge, and it expires after 30 days.',
    'Claim with `SET key claimed NX` (no expiry) before `charge_invoice`; confirm with `charged:{reference}`; on a lost claim, answer a `charged:` marker as is, else ask `lookup_invoice`, adopt and confirm its reference, or answer `in_flight`.',
  ],
  debrief: `The fix is an ordering: claim, charge, confirm. The claim is one atomic \`SET NX\`, so exactly one runner per period proceeds and a lost race spends nothing. The confirmation stores the reference, which turns a claim without one into a recognisable unknown outcome that the next run reconciles with the processor instead of guessing. The marker has no expiry because a TTL quietly turns "charged once" into "charged once a month". Billing systems add a lease to the claim, so a crashed run's period is retried after a timeout instead of waiting for reconciliation, and a nightly job that compares markers with the processor's settlement report.`,
};
