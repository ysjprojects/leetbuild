import type {Problem} from '@/lib/types';

import {reserveStockStep} from './steps/1-reserve-stock';
import {checkoutEndpointStep} from './steps/2-checkout-endpoint';
import {orderIntakeStep} from './steps/3-order-intake';
import {fulfilmentStep} from './steps/4-fulfilment';
import {releaseExpiredStep} from './steps/5-release-expired';

/**
 * Flash-sale inventory: a product drop where demand exceeds stock by orders of magnitude. Atomic
 * reservations in Redis (Lua) → a checkout API that says no fast (400/429/409/202) → durable order
 * intake through Kafka with a blocking, bounded ack → a fulfilment consumer allocating over gRPC
 * with deadlines and backoff, committing after the outcome → a sweeper releasing expired holds.
 */
export const flashSaleProblem: Problem = {
  id: 'flash-sale',
  title: 'Flash-Sale Inventory',
  tagline:
    'A product drop: atomic holds in Redis, a checkout that says no fast, orders through Kafka, a warehouse over gRPC.',
  difficulty: 'hard',
  concepts: ['redis', 'http', 'kafka', 'grpc'],
  minutes: 80,
  statement: `# Flash-Sale Inventory

Five hundred pairs of a limited sneaker go on sale at noon. Two hundred thousand people — and a great
many scripts — press *Buy* within the first ten seconds. Every unit must be sold exactly once, the
answer must come back in milliseconds, and nobody may be told "yours" for a pair that does not exist.

## The real system

A virtual waiting room and bot scoring in front of the storefront, a distributed inventory service
sharded by SKU and region, payment authorisation with a capture step, warehouse allocation across
several fulfilment centres, and a reconciliation pipeline that catches and compensates the oversell
that every high-throughput counter eventually produces.

## What you build here

One product, one warehouse, one Redis, one Kafka topic:

1. **Atomic reservations** in Redis: a Lua script that checks stock, decrements it, records a hold with
   an expiry, and never runs a client-side read-modify-write.
2. \`POST /checkout\`: validation, a per-user attempt limit (**429** with \`Retry-After\`), **409** when the
   drop is sold out, **202** when the order is reserved and durably enqueued.
3. **Durable order intake**: a Kafka producer keyed by SKU with \`acks=all\` that blocks until the record
   is acknowledged — or fails loudly so the API releases the hold.
4. **Fulfilment**: a consumer group calling the warehouse's \`Allocate\` over gRPC with a deadline and
   exponential backoff, releasing the hold when there is no physical stock, committing only afterwards.
5. **A sweeper** that gives expired holds back to stock atomically, once, and never for an order that
   was fulfilled.

## Left out on purpose

Payment (an order is "reserved", never "paid"), the waiting room, bot scoring beyond a counter, multiple
warehouses and regions, and post-drop reconciliation. What remains is the part every inventory system
shares: an atomic counter, an honest API, a durable queue, an idempotent consumer and an expiry queue —
and the exact places where each one can lie to the others.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Shopper', sub: 'POST /checkout', x: 9, y: 50},
      {id: 'checkout', kind: 'http', label: 'checkout', sub: 'HTTPS :8443', x: 30, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'stock:{sku} · hold:{id} · holds', x: 52, y: 16},
      {id: 'kafka', kind: 'kafka', label: 'orders', sub: 'key = sku · acks=all', x: 52, y: 84},
      {id: 'fulfilment', kind: 'service', label: 'fulfilment', sub: 'consumer group', x: 74, y: 84},
      {id: 'warehouse', kind: 'grpc', label: 'Warehouse', sub: 'Allocate(order, sku, qty)', x: 91, y: 84},
      {id: 'sweeper', kind: 'service', label: 'hold sweeper', sub: 'every 1 s · LIMIT 100', x: 76, y: 16},
    ],
    edges: [
      {from: 'client', to: 'checkout', kind: 'http', label: 'HTTPS'},
      {from: 'checkout', to: 'redis', kind: 'redis', label: 'INCR attempts · EVALSHA reserve'},
      {from: 'checkout', to: 'kafka', kind: 'kafka', label: 'produce · wait for ack'},
      {from: 'kafka', to: 'fulfilment', kind: 'kafka', label: 'consume'},
      {from: 'fulfilment', to: 'warehouse', kind: 'grpc', label: 'Allocate · 5 s'},
      {from: 'fulfilment', to: 'redis', kind: 'redis', label: 'confirm / release'},
      {from: 'sweeper', to: 'redis', kind: 'redis', label: 'ZRANGEBYSCORE · EVALSHA release'},
    ],
  },
  steps: [reserveStockStep, checkoutEndpointStep, orderIntakeStep, fulfilmentStep, releaseExpiredStep],
};
