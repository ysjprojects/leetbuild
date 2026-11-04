import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Inventory service: the debugging a reservation path needs before a flash sale finds the flaw. A
 * validated, idempotent reservation → one Lua transition on the stock counter and the hold map →
 * a warehouse confirmation with a deadline that keeps the hold when it gets no answer → sku-keyed
 * movement events with an outbox → a stock read from the live counter and the live holds. The
 * warehouse is a stand-in the harness serves over gRPC.
 */
export const inventoryServiceProblem: Problem = {
  id: 'inventory-service',
  title: 'Inventory Service',
  tagline: 'Stock reservations that hold up under a flash sale and a slow warehouse.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Inventory Service

An inventory service decides whether a unit of stock is still yours to sell. "Add to cart" is the
visible part; whether the platform oversells is decided by the validation in front of the counter,
the atomicity of the counter, what happens when the warehouse is slow, the movement stream a ledger
rebuilds from, and the number the storefront shows.

## The real system

Shopify's Admin API sets inventory with \`inventorySetQuantities\`, which takes a
\`changeFromQuantity\` per item: the write lands only if the stored quantity still equals the value
the caller read, and otherwise fails with \`CHANGE_FROM_QUANTITY_STALE\`, so the caller reads again
instead of overwriting a concurrent change. Step 2's Lua script is the same compare and write, done
inside Redis.

## What you build here

One service, **inventoryd**, on one \`inventory\` support package every step imports:
\`inventory.catalog\` (\`owner(sku)\` and \`synced_at(sku)\` from \`sku:{sku}\`), \`inventory.stock\`
(\`stock:{sku}\` available units, \`holds:{sku}\` reservation id → quantity, \`hold:{id}\` alive for
\`RESERVATION_TTL_S = 900\`; \`reserve\`, \`release\` and \`confirm\`, the transitions step 2 builds) and
\`inventory.store\` (\`reservation:{id}\`, \`idem:{tenant}:{key}\`, the \`outbox\` list, \`new_id\`).

1. \`POST /v1/reservations\` with \`X-Tenant-Id\`, \`Idempotency-Key\` and \`{sku, quantity}\`: a quantity
   from 1 to 1000, a sku the tenant sells, a replayed key answered with the first reservation; 201
   with the reservation, 409 when the units are not there.
2. The **Redis** transitions: \`reserve\` as one Lua script that gives expired holds back, then checks
   and decrements; a hold key with the reservation's TTL; a \`release\` that credits a reservation once.
3. The **gRPC** warehouse: \`ConfirmReservation\` at \`warehouse:9000\` under a 2-second deadline, at
   most two attempts with the same reservation id, \`pending\` with the hold kept when it never
   answers, the hold released on \`FAILED_PRECONDITION\`.
4. The **Kafka** \`inventory.event\` stream keyed by sku, each event
   \`{sku, reservation_id, reason, quantity, delta}\`, from an idempotent producer with \`acks=all\`,
   with an outbox row when the delivery report fails or does not come.
5. \`GET /v1/skus/{sku}/stock\`: \`available\`, \`reserved\` and \`on_hand\` from the live counter and the
   hold map, \`stale\` when the warehouse sync is over 60 s old, 404 for another tenant's sku.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Warehouse robotics and bin locations, allocation across warehouses, purchase orders and backorders,
pricing, cart and checkout orchestration, a sweeper that returns expired holds without waiting for
the next reserve, and the warehouse sync itself.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Storefront', sub: 'reserve · stock', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'inventoryd', sub: 'HTTPS :8443', x: 24, y: 50},
      {id: 'db', kind: 'db', label: 'reservation store', sub: 'reservation:{id} · outbox', x: 46, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'stock:{sku} · holds:{sku} · hold:{id}', x: 46, y: 50},
      {id: 'warehouse', kind: 'grpc', label: 'Warehouse', sub: 'ConfirmReservation · 2 s', x: 46, y: 90},
      {id: 'sync', kind: 'service', label: 'Warehouse sync', sub: 'stock:{sku} · synced_at', x: 68, y: 10},
      {id: 'kafka', kind: 'kafka', label: 'inventory.event', sub: 'key = sku', x: 68, y: 50},
      {id: 'ledger', kind: 'service', label: 'Ledger consumer', sub: 'folds deltas per sku', x: 88, y: 50},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'reservation · outbox'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'reserve · release · confirm'},
      {from: 'api', to: 'warehouse', kind: 'grpc', label: 'ConfirmReservation'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce inventory.event'},
      {from: 'kafka', to: 'ledger', kind: 'kafka', label: 'consume'},
      {from: 'sync', to: 'redis', kind: 'redis', label: 'on-hand sync'},
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
