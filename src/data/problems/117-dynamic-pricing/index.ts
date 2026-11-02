import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Dynamic pricing: the debugging you owe a pricing service before it moves money. A guarded
 * publish endpoint at the trust boundary → one atomic Redis headroom reservation per sku window →
 * a demand-model call with a 700 ms deadline that falls back to the last approved price →
 * sku-keyed price.changed events with an outbox, published only after the store commits → a
 * storefront read that shows published prices, with experiment candidates behind an operator scope.
 */
export const dynamicPricingProblem: Problem = {
  id: 'dynamic-pricing',
  title: 'Dynamic Pricing',
  tagline:
    'Prices that move inside a per-window budget, with a floor, a ceiling and an audit event behind each change.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Dynamic Pricing

A dynamic pricing service lets a model move money. The model suggests a price; the platform decides
whether it may be published, how far a price may travel inside a window, what the storefront
charges while the model is broken, and how anyone later reconstructs why a number changed.

## The real system

Amazon's Automate Pricing tool is this service as a product: a seller attaches a rule to a SKU,
sets a minimum price and an optional maximum price per SKU, and the rule reprices inside those
limits while a 30-day history records each change. Any platform that takes proposals from a demand
model, a competitor feed or a category manager needs the same bounds. A floor and ceiling stop a
bug from selling at zero; a per-window change limit stops a burst of proposals from compounding,
and the headroom it allows is shared state, so the accounting has to be atomic and the window has
to expire. The model has a deadline, and when it misses it the service must not present its last
suggestion as a fresh computation. Every published change is an event keyed by the sku, carrying
both prices, the headroom consumed and the reason, written after the price is durable and kept in
an outbox when the broker is down.

## What you build here

One service, **priced**, with five pieces:

1. \`POST /v1/prices\`: a validated proposal (an existing sku, a target price, a reason), rejected
   with the computed bound past the per-window limit and with the floor or ceiling outside them.
2. A **Redis** guard: one hash per sku per hour window, read, checked and incremented inside one
   Lua \`EVAL\` that sets the expiry on first write, so concurrent updates share the same headroom.
3. A **gRPC** demand client: a 700 ms deadline per call, a terminal constraint rejection, and a
   timeout path that republishes the last approved price with a stale marker.
4. A **Kafka** audit chain: one \`price.changed\` event per publish, keyed by sku, produced after
   the price store commits, with an outbox row when the broker rejects it.
5. \`GET /v1/prices/{sku}\`: the price the storefront charges, with its source, timestamp and
   guardrail state, and experiment candidates visible only to operators holding a preview scope.

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
      {id: 'api', kind: 'http', label: 'Pricing API', sub: 'HTTPS :8443', x: 28, y: 52},
      {id: 'redis', kind: 'redis', label: 'Redis guard', sub: 'guard:{sku}:{window}', x: 50, y: 16},
      {id: 'db', kind: 'db', label: 'Price store', sub: 'prices · audit · outbox', x: 50, y: 52},
      {id: 'demand', kind: 'grpc', label: 'Demand model', sub: 'Estimate · 700 ms', x: 50, y: 88},
      {id: 'kafka', kind: 'kafka', label: 'price.changed', sub: 'key = sku', x: 72, y: 28},
      {id: 'relay', kind: 'service', label: 'Outbox relay', sub: 'republish on recovery', x: 72, y: 76},
    ],
    edges: [
      {from: 'storefront', to: 'api', kind: 'http', label: 'GET /v1/prices/{sku}'},
      {from: 'operator', to: 'api', kind: 'http', label: 'X-Operator-Scope: preview'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVAL reserve headroom'},
      {from: 'api', to: 'db', kind: 'plain', label: 'publish · audit'},
      {from: 'api', to: 'demand', kind: 'grpc', label: 'Estimate (700 ms)'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce price.changed'},
      {from: 'db', to: 'relay', kind: 'plain', label: 'undelivered rows'},
      {from: 'relay', to: 'kafka', kind: 'kafka', label: 'republish'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
