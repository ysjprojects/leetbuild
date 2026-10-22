import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Inventory service on the AI-era track: the course is not "store a number and subtract", it is the
 * review you owe a model-generated reservation path before a flash sale finds the flaw. A validated,
 * idempotent reservation → one atomic Redis decrement with a floor at zero → a warehouse
 * confirmation with a deadline that keeps a hold on timeout → sku-keyed stock events with an outbox
 * → a stock read the storefront can trust.
 */
export const inventoryServiceProblem: Problem = {
  id: 'inventory-service',
  title: 'Inventory Service',
  tagline: 'Reserve stock without overselling, with holds that release cleanly.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Inventory Service

An inventory service is the piece of a commerce platform that decides whether a unit of stock is
still yours to sell, how long a reservation holds it, and what happens when the warehouse does not
answer. The visible part is "add to cart"; the parts that decide whether the platform oversells are
the validation funnel, the atomic counter, the confirmation policy, the ledger stream, and the stock
number the storefront believes.

## The real system

Production inventory receives reservation requests from every storefront and queue at once, and the
last unit of a hot sku is contended by thousands of buyers in the same second. A read, a comparison
and a write in three steps is an oversell waiting for load: both writers read 1, both compare 1 >=
1, both write 0, and the same unit is sold twice. Real services make the check and the decrement one
operation, keep a floor at zero inside the store, and let the loser fail cleanly with a conflict
rather than silently going negative. A reservation is a *hold*: it expires, it is mirrored with a
TTL, and a warehouse that never answers must not destroy the sale the customer already made — a
timeout keeps the reservation pending and retries with the same id, while a terminal rejection
releases the hold exactly once. Stock movement is an append-only ledger: events are keyed by sku so
one sku's history stays ordered, deltas and reservation ids travel together, the hold is cleared
before the release is published, and a broker outage drops the event into an outbox instead of
losing it. And the stock endpoint reads the same counter the reservation path decrements, reports
reserved and on-hand with explicit staleness, and never leaks another tenant's sku.

## What you build here

One service, **inventoryd**, with five pieces:

1. \`POST /v1/reservations\`: a sku, a quantity from **1** to **1000**, and an \`Idempotency-Key\`,
   rejecting unknown skus and quantities over the per-order cap before any decrement, so a negative
   quantity cannot quietly increase stock and a replayed key returns the original reservation.
2. A **Redis** counter decremented by one Lua script that refuses when the result would be negative,
   with the reservation's TTL mirrored on a hold key — the check and the write are one atomic unit,
   so two flash-sale buyers against the last unit yield exactly one success.
3. A **gRPC** warehouse client: \`ConfirmReservation\` under a 2-second deadline, a timeout that
   leaves the reservation *pending* and retries once with the same reservation id, and a terminal
   rejection that releases the Redis hold exactly once.
4. A **Kafka** \`inventory.event\` stream keyed by **sku**, carrying quantity deltas and reservation
   ids, publishing reserve/confirm/release in order with an outbox for the broker outages — so a
   sku's movement stream is ordered and the ledger is rebuildable.
5. \`GET /v1/skus/{id}/stock\`: \`available\`, \`reserved\` and \`on-hand\` computed through the same
   counter the reservation path decrements, with staleness reported when the warehouse sync is
   behind, and **404** for a sku the caller's tenant does not own.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real inventory
platform: read the draft against the failure modes, name the subtle one, fix it, and prove the fix
with checks that fail on the draft and pass on your version.

## Left out on purpose

Warehouse robotics and bin locations, multi-node allocation of the same sku, purchase orders and
backorders, tax and pricing, cart and checkout orchestration, physical reconciliation jobs, and
per-region replication. The five pieces above are the ones that decide whether the service oversells,
double-releases or loses a sale.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Storefront', sub: 'reserve · stock', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'Inventory API', sub: 'HTTPS :8443', x: 24, y: 50},
      {id: 'db', kind: 'db', label: 'reservations · outbox', sub: 'Postgres', x: 46, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'stock · holds', x: 46, y: 50},
      {id: 'warehouse', kind: 'grpc', label: 'Warehouse', sub: 'ConfirmReservation', x: 46, y: 90},
      {id: 'sync', kind: 'service', label: 'Warehouse sync', sub: 'on-hand feed', x: 68, y: 10},
      {id: 'kafka', kind: 'kafka', label: 'inventory.event', sub: 'key = sku', x: 68, y: 50},
      {id: 'ledger', kind: 'service', label: 'Ledger consumer', sub: 'group · per-sku', x: 88, y: 50},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'reservation · outbox'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'DECR · hold'},
      {from: 'api', to: 'warehouse', kind: 'grpc', label: 'ConfirmReservation'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce inventory.event'},
      {from: 'kafka', to: 'ledger', kind: 'kafka', label: 'consume'},
      {from: 'sync', to: 'redis', kind: 'redis', label: 'on-hand sync'},
      {from: 'ledger', to: 'db', kind: 'plain', label: 'append ledger'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
