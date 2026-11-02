import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Inventory service: the course is not "store a number and subtract", it is the debugging you owe
 * a reservation path before a flash sale finds the flaw. A validated, idempotent reservation → one
 * atomic Redis decrement with a floor at zero → a warehouse confirmation with a deadline that keeps
 * a hold on timeout → sku-keyed stock events with an outbox → a stock read the storefront can trust.
 */
export const inventoryServiceProblem: Problem = {
  id: 'inventory-service',
  title: 'Inventory Service',
  tagline: 'Reserve stock with one atomic decrement and holds that expire on time.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Inventory Service

An inventory service is the piece of a commerce platform that decides whether a unit of stock is
still yours to sell, how long a reservation holds it, and what happens when the warehouse does not
answer. The visible part is "add to cart"; the parts that decide whether the platform oversells are
the validation funnel, the atomic counter, the confirmation policy, the ledger stream, and the stock
number the storefront believes.

## The real system

Shopify's Admin API exposes the oversell problem directly: \`inventorySetQuantities\` takes a
\`changeFromQuantity\` (the \`compareQuantity\` it replaces) so a write only lands if the current
available quantity still equals the value the caller read, and a concurrent change comes back as a
user error the caller retries with the fresh number. That compare-and-swap is the same shape as
this course's Lua script: the check and the write are one operation, and the loser fails cleanly
with a conflict instead of silently going negative. The rest of a production inventory path
follows from it. A reservation is a *hold* that expires, mirrored with a TTL. A warehouse that does
not answer must not destroy the sale the customer already made: a timeout keeps the reservation
pending and retries with the same id, while a terminal rejection releases the hold exactly once.
Stock movement is an append-only ledger keyed by sku, so one sku's history stays ordered, with an
outbox for broker outages. And the stock endpoint reads the same counter the reservation path
decrements, reports reserved and on-hand with explicit staleness, and keeps one tenant's sku out of
another tenant's response.

## What you build here

One service, **inventoryd**, with five pieces:

1. \`POST /v1/reservations\`: a sku, a quantity from **1** to **1000**, and an \`Idempotency-Key\`,
   rejecting unknown skus and quantities over the per-order cap before any decrement, so a negative
   quantity cannot quietly increase stock and a replayed key returns the original reservation.
2. A **Redis** counter decremented by one Lua script that refuses when the result would be negative,
   with the reservation's TTL mirrored on a hold key: the check and the write are one atomic unit,
   so two flash-sale buyers against the last unit yield exactly one success.
3. A **gRPC** warehouse client: \`ConfirmReservation\` under a 2-second deadline, a timeout that
   leaves the reservation *pending* and retries once with the same reservation id, and a terminal
   rejection that releases the Redis hold exactly once.
4. A **Kafka** \`inventory.event\` stream keyed by **sku**, carrying quantity deltas and reservation
   ids, publishing reserve/confirm/release in order with an outbox for the broker outages, so a
   sku's movement stream is ordered and the ledger is rebuildable.
5. \`GET /v1/skus/{id}/stock\`: \`available\`, \`reserved\` and \`on-hand\` computed through the same
   counter the reservation path decrements, with staleness reported when the warehouse sync is
   behind, and **404** for a sku the caller's tenant does not own.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. Your job in every step is the job you will have on a real inventory platform: debug
it against the failure modes, find the subtle one, fix it, optimize what is wasteful, and prove the
fix with checks that fail on the starter and pass on your version.

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
