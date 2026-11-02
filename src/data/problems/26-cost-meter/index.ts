import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * AI cost meter: the course is not "count tokens", it is the debugging you owe a metering path
 * before finance bills anyone from it. Idempotent usage writes that land before the response →
 * one atomic Redis counter per (tenant, hour) that expires with its window → a pricing lookup
 * with a deadline and a versioned, freshness-bounded fallback → usage events keyed by tenant with
 * the idempotency key embedded and an outbox behind a rejected produce → a spend read
 * reconstructed from the same counters the limiter enforces.
 */
export const costMeterProblem: Problem = {
  id: 'cost-meter',
  title: 'AI Cost Meter',
  tagline: 'Meter tokens per tenant per hour in one atomic Redis counter, priced from a versioned rate table.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# AI Cost Meter

An AI cost meter turns tokens into money: it records what each tenant spent, prices it against the
model's published rates, and hands the number to the engineer deciding whether the next request fits
the budget and to finance reconciling the invoice months later. The visible part is a number on a
spend dashboard. The parts that decide whether anyone can trust it are the durability of the usage
write, the atomicity of the counter, the freshness of the rates, the ordering of the billing events,
and a read that agrees with the limit that was actually enforced.

## The real system

Stripe's Billing Meters take usage as meter events: each event names a customer and a value, and an
optional \`identifier\` makes it idempotent, with uniqueness enforced over a rolling window of at
least 24 hours so an accidental retry does not count twice. Every usage-based billing stack solves
the same list. A usage report is written durably before the response leaves, because a process that
crashes between the two has accepted tokens it will not charge for. Spend accumulates in one
window-keyed counter per tenant, updated atomically with the expiry of that window, because the
meter and the budget limiter must read the same number. Rates come from a pricing service under a
deadline, with a cached, versioned rate table as the fallback, and a pricing failure is not cached as
a rate. Usage events go out keyed by tenant so one ledger stays ordered, carry the idempotency key so
billing can dedupe a retry, and survive a broker outage through an outbox. The spend read
reconstructs the current window from those same counters, scoped to the authenticated tenant.

## What you build here

One service, **meterd**, with five pieces:

1. \`POST /v1/usage\`: authenticated tenant, a checked model name and token counts, an
   \`Idempotency-Key\` so a replay stores one row, and a write that is durable before the 202.
2. A **Redis** ledger: one hash per \`(tenant, hour bucket)\`, both token counters and the window
   expiry inside one atomic \`EVAL\`, a TTL set only when the window opens.
3. A **gRPC** pricing client: a 200 ms deadline per lookup, a cached rate table as the fallback,
   versioned and no older than one hour, an unknown model reported as uncosted, no failure cached.
4. A **Kafka** usage path: one \`billing.usage\` event per report keyed by tenant, the idempotency
   key embedded, an idempotent producer with \`acks=all\`, and an outbox row when the broker rejects
   the produce.
5. \`GET /v1/tenants/{t}/spend\`: tenant-scoped with a **403** for a foreign read, current-window
   spend and remaining budget from the limiter's own counters, integer micro-dollars per request,
   rounding once at statement level.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step you debug it against the failure modes, fix it, optimize what is
wasteful, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Provider-side reconciliation of reported usage, per-model tokenizers, currency conversion and tax,
invoice generation, payment collection, price-change approval workflows, spend forecasting, and the
finance dashboard.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Billing client', sub: 'report · read', x: 8, y: 50},
      {id: 'meter', kind: 'http', label: 'Cost Meter', sub: 'HTTPS :8443', x: 27, y: 50},
      {id: 'db', kind: 'db', label: 'usage · outbox', sub: 'rows · idempotency', x: 48, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'meter:{tenant}:{hour}', x: 48, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'billing.usage', sub: 'key = tenant', x: 48, y: 90},
      {id: 'pricing', kind: 'grpc', label: 'Pricing service', sub: 'GetPrice', x: 70, y: 12},
      {id: 'cache', kind: 'external', label: 'Rate table', sub: 'versioned · ≤ 1 h', x: 70, y: 36},
      {id: 'consumer', kind: 'service', label: 'Billing consumer', sub: 'ledger · dedupe', x: 70, y: 62},
      {id: 'limiter', kind: 'service', label: 'Budget limiter', sub: 'same window', x: 70, y: 88},
    ],
    edges: [
      {from: 'client', to: 'meter', kind: 'http', label: 'HTTPS'},
      {from: 'meter', to: 'db', kind: 'plain', label: 'usage · outbox'},
      {from: 'meter', to: 'redis', kind: 'redis', label: 'EVAL window counters'},
      {from: 'meter', to: 'pricing', kind: 'grpc', label: 'GetPrice'},
      {from: 'meter', to: 'cache', kind: 'plain', label: 'fallback table'},
      {from: 'meter', to: 'kafka', kind: 'kafka', label: 'produce billing.usage'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'ledger · dedupe'},
      {from: 'meter', to: 'limiter', kind: 'plain', label: 'spend · remaining'},
      {from: 'limiter', to: 'redis', kind: 'redis', label: 'same window key'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
