import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * AI cost meter: the debugging a metering path owes before finance bills from it. One usage row per
 * (tenant, Idempotency-Key) → one hour-window hash per tenant moved by one Lua script, in integer
 * micro-dollars, expiring an hour after its window → a pricing call with a deadline and a fresh,
 * versioned rate table as the fallback → usage events keyed by tenant with the idempotency key inside
 * and an outbox behind the delivery report → a spend read from the window the budget limiter enforces.
 * The pricing service is a deterministic stand-in the harness serves over gRPC.
 */
export const costMeterProblem: Problem = {
  id: 'cost-meter',
  title: 'AI Cost Meter',
  tagline: 'Tokens to micro-dollars per tenant hour: a usage row per key, a window hash, a versioned rate table.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# AI Cost Meter

A cost meter turns model tokens into money: it records what each tenant used, prices it against the
model's published rates, and keeps the running spend that a budget limiter enforces and finance
invoices from. Each number it produces is read twice, once by a limiter deciding the next request
and once by an accountant months later, and both readings have to agree.

## The real system

Stripe's Billing Meters take usage as meter events, each naming a customer and a value, with an
optional \`identifier\` that Stripe keeps unique over a rolling period of at least 24 hours so an
accidental retry does not count twice. Its API's idempotency layer goes one step further and errors
when a key comes back with other parameters. A usage-based meter in front of a model gateway needs the
same discipline end to end: a retried report stored once, spend added atomically in one window, rates
that say which version priced them, and events a ledger can deduplicate.

## What you build here

One service, **meterd**, with five pieces sharing one contract, the \`meter\` support package
(\`config\`: the pricing address, the topic, the window, its key and the budget):

1. \`POST /v1/usage\`: a model and two token counts in 0..1 000 000, an \`Idempotency-Key\`; the row is
   stored under \`(tenant, key)\`, a replay answers it and a changed replay is 409.
2. **Redis window**: \`meter:{tenant}:{bucket}\`, one hash per tenant hour (\`input_tokens\`,
   \`output_tokens\`, \`cost_micros\`, \`events\`), moved by one Lua script in integer micro-dollars and
   expiring one hour after its window closes.
3. **Pricing client** (gRPC, a stand-in the checks serve): \`GetRates\` under a 200 ms deadline; the last
   good rate table, at most an hour old, as the fallback; a model the table lacks is uncosted.
4. **Kafka**: one \`billing.usage\` event per report keyed by tenant, carrying the idempotency key and
   the rate version and no completion text, from an idempotent \`acks=all\` producer, with an outbox row
   written from the delivery report.
5. \`GET /v1/tenants/{tenant}/spend\`: the caller's own tenant only, the current window read in one
   command, \`remaining_micros\` against \`BUDGET_MICROS\`, never below zero.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and it
looks right. In every step, debug it against the failure modes the task names, fix it, and prove the
fix with checks that fail on the starter and pass on your version.

## Left out on purpose

The budget limiter itself (another team's service reading the same window key), provider-side
reconciliation, per-model tokenizers, currency conversion and tax, invoices, and the outbox relay.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Gateway', sub: 'report · read', x: 8, y: 50},
      {id: 'meter', kind: 'http', label: 'meterd', sub: ':8443', x: 28, y: 50},
      {id: 'store', kind: 'redis', label: 'usage rows', sub: 'usage:{tenant}:{key}', x: 50, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis window', sub: 'meter:{tenant}:{bucket}', x: 50, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'billing.usage', sub: 'key = tenant_id', x: 50, y: 88},
      {id: 'pricing', kind: 'grpc', label: 'Pricing', sub: 'GetRates · 200 ms', x: 74, y: 20},
      {id: 'limiter', kind: 'service', label: 'Budget limiter', sub: 'same window key', x: 74, y: 50},
      {id: 'consumer', kind: 'service', label: 'Billing ledger', sub: 'dedupe on idempotency_key', x: 74, y: 88},
    ],
    edges: [
      {from: 'client', to: 'meter', kind: 'http', label: 'POST usage · GET spend'},
      {from: 'meter', to: 'store', kind: 'redis', label: 'get · put'},
      {from: 'meter', to: 'redis', kind: 'redis', label: 'EVAL record · HGETALL'},
      {from: 'meter', to: 'pricing', kind: 'grpc', label: 'GetRates'},
      {from: 'meter', to: 'kafka', kind: 'kafka', label: 'produce'},
      {from: 'limiter', to: 'redis', kind: 'redis', label: 'reads cost_micros'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
