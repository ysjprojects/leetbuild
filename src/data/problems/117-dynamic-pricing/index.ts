import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Dynamic pricing: the debugging you owe a pricing service before it moves money. A guarded
 * price-change endpoint → one atomic Redis headroom reservation per sku and hour window → a
 * demand-model call with a 700 ms deadline that keeps the last approved price when the model is
 * down → sku-keyed price.changed events after the commit, with an outbox → a storefront read of the
 * published price, with experiment candidates behind an operator scope.
 */
export const dynamicPricingProblem: Problem = {
  id: 'dynamic-pricing',
  title: 'Dynamic Pricing',
  tagline:
    'A floor, a ceiling and an hourly move budget per sku, a demand model on a deadline, and an audit event per change.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Dynamic Pricing

A dynamic pricing service lets a model and a team of operators move money. Each proposal is a
price; the service decides whether it may be published, how far one sku may travel inside an hour,
what the storefront charges while the model is down, and how anyone later reconstructs why a number
changed.

## The real system

Amazon's Automate Pricing lets a seller attach SKUs to a pricing rule; it then adjusts each price
according to the rule and the minimum and maximum price the seller entered for that SKU. Any
platform that takes proposals from a demand model, a competitor feed or a category manager needs the
same bounds, plus two things a per-SKU minimum does not give: a budget for how far a price may move
in an hour, shared by every proposal for that sku, and an audit trail that says who moved it, why,
and how much of the budget the move spent.

## What you build here

One service, **priced**, on one price store (\`pricing.store\`, provided: \`price:{sku}\` holds the
published price, its \`source\`, \`reason\`, \`updated_at\` and \`stale\` flag; \`candidate:{sku}\` an
experiment's proposal) and one window guard (\`reserve\` / \`window_state\`, built in step 2 and
provided to later steps as \`pricing.guard\`):

1. \`POST /v1/prices\` with \`{sku, price_cents, reason}\`: 404 for an unknown sku, 422 outside
   the floor (50) and ceiling (500000), 409 with \`bound_cents\` past a 20 % move, 400 without a
   reason.
2. A **Redis** guard: \`guard:{sku}:{window}\` adds up \`moved_bp\` per hour window, read, checked and
   spent in one Lua script, expiring with its window.
3. A **gRPC** \`DemandModel/Estimate\` call under a 700 ms deadline: a refusal is final, an outage keeps
   the last approved price marked stale, an estimate moves the price only through the guard.
4. A **Kafka** \`price.changed\` event keyed by sku, produced after the commit by an idempotent
   producer, carrying both prices, the reason and the window spend; the \`outbox\` list keeps what
   the broker did not take.
5. \`GET /v1/prices/{sku}\`: the published price with its source, timestamp, stale flag and
   guardrail; operators with \`X-Operator-Scope: preview\` also see the candidate.

## The debugging habit

Every starter is working code with flaws: it compiles, it serves the happy path, and it looks
right. In every step you debug it against the failure modes, fix it, and prove the fix with checks
that fail on the starter and pass on your version.

## Left out on purpose

Demand forecasting, elasticity estimation, catalog and merchandising systems, competitor feed
ingestion, tax and currency conversion, promotions calendars, the storefront's own price cache, and
the analyst UI.`,
  diagram: {
    nodes: [
      {id: 'storefront', kind: 'client', label: 'Storefront', sub: 'GET /v1/prices/{sku}', x: 6, y: 28},
      {id: 'operator', kind: 'client', label: 'Operator console', sub: 'preview scope', x: 6, y: 78},
      {id: 'api', kind: 'http', label: 'Pricing API', sub: 'POST · GET /v1/prices', x: 28, y: 52},
      {id: 'redis', kind: 'redis', label: 'Redis guard', sub: 'guard:{sku}:{window}', x: 50, y: 16},
      {id: 'db', kind: 'db', label: 'Price store', sub: 'price:{sku} · candidate:{sku} · outbox', x: 50, y: 52},
      {id: 'demand', kind: 'grpc', label: 'Demand model', sub: 'Estimate · 700 ms', x: 50, y: 88},
      {id: 'kafka', kind: 'kafka', label: 'price.changed', sub: 'key = sku', x: 72, y: 28},
      {id: 'relay', kind: 'service', label: 'Outbox relay', sub: 'republish on recovery', x: 72, y: 76},
    ],
    edges: [
      {from: 'storefront', to: 'api', kind: 'http', label: 'GET /v1/prices/{sku}'},
      {from: 'operator', to: 'api', kind: 'http', label: 'X-Operator-Scope: preview'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVAL reserve headroom'},
      {from: 'api', to: 'db', kind: 'plain', label: 'publish · mark_stale · outbox'},
      {from: 'api', to: 'demand', kind: 'grpc', label: 'Estimate (700 ms)'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce price.changed'},
      {from: 'db', to: 'relay', kind: 'plain', label: 'undelivered rows'},
      {from: 'relay', to: 'kafka', kind: 'kafka', label: 'republish'},
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
