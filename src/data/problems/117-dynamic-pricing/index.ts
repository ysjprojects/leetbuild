import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Dynamic pricing on the AI-era track: the course is not "serve a model's price suggestion", it is
 * the review you owe a generated pricing service before it moves money. A guarded publish endpoint
 * at the trust boundary → one atomic Redis headroom reservation per sku window → a demand-model
 * call with a 700 ms deadline that falls back to the last approved price → sku-keyed price.changed
 * events with an outbox, published only after the store commits → a storefront read that shows
 * published prices, with experiment candidates behind an operator scope.
 */
export const dynamicPricingProblem: Problem = {
  id: 'dynamic-pricing',
  title: 'Dynamic Pricing',
  tagline: 'Prices that move within guardrails, never publish stale model output and explain themselves.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Dynamic Pricing

A dynamic pricing service is the piece of a marketplace that lets a model move money. The model
suggests a price; the platform decides whether that suggestion may be published, how far the price
may travel inside a window, what the storefront charges while the model is broken, and how anyone
later reconstructs why a number changed. The visible part is a number on a product page. The parts
that decide whether the platform is safe are the guardrail evaluation, the atomic headroom
accounting, the fallback when the model goes silent, and the audit chain behind every publish.

## The real system

Production pricing services receive price updates from several places at once: a demand model, a
competitor feed, a category manager's override, a promotions calendar. Every one of them is a
proposal, not a fact. The service enforces a recipe around each proposal — an absolute floor and
ceiling so a bug can never sell at zero or at a thousand times cost, and a per-window change limit
so a burst of proposals cannot compound into a 400 percent move. The headroom that limits allow is
shared state, so the accounting has to be atomic and the window has to expire on schedule; ten
updates that each look small against yesterday's price are ten updates that must not all pass.
Model output is untrusted in a second way: the model has a deadline, and when it misses it the
service must not present its last suggestion as a fresh computation. Finally, every published
change is an auditable event keyed by the thing whose price moved, carrying both prices, the
headroom it consumed and the reason — written after the price is durable, and never lost when the
broker is down.

## What you build here

One service, **priced**, with five pieces:

1. \`POST /v1/prices\`: a validated proposal — a sku that exists, a target price, a reason — that
   is rejected with the computed bound when it would move the price past the per-window limit, and
   with the floor or ceiling when it lands outside them. An unknown sku is \`404\`, never a new row.
2. A **Redis** guard: one hash per sku per hour window, read, checked and incremented inside a
   single Lua \`EVAL\` that sets the window's expiry on first write, so concurrent updates share the
   same headroom and the published price stays traceable to the update that consumed it.
3. A **gRPC** demand client: a 700 ms deadline per call, a constraint rejection that is terminal,
   and a timeout path that republishes the last approved price with a stale marker instead of
   serving the model's last suggestion as if it were computed now.
4. A **Kafka** audit chain: one \`price.changed\` event per publish, keyed by sku so a sku's history
   stays ordered, produced only after the price store commits, carrying old and new price, the
   headroom consumed, the source and the reason, with an outbox row when the broker rejects it.
5. \`GET /v1/prices/{sku}\`: the price the storefront charges, with its source, timestamp and
   guardrail state, and experiment candidates visible only to operators holding a preview scope.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Demand forecasting itself, elasticity estimation, catalog and merchandising systems, competitor
feed ingestion, tax and currency conversion, promotions calendars, the storefront's own price cache,
and the analyst UI. The five pieces above are the ones that decide whether a pricing platform is
correct, honest about its sources and shippable.`,
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
