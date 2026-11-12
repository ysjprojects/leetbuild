import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Shipment tracking: the debugging a tracking service needs before it publishes a delivery
 * promise. One live shipment per order with idempotent creates → a forward-only Redis timeline
 * applied atomically → carrier polls with a deadline, recorded failures and schedule-based retries →
 * shipment-keyed timeline events that carry cities, not addresses, and follow the state commit → a
 * read that derives delivered from the scans and keeps the operations fields out of the customer view.
 */
export const shipmentTrackingProblem: Problem = {
  id: 'shipment-tracking',
  title: 'Shipment Tracking',
  tagline: 'Forward-only shipment timelines reconciled against carrier scans.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Shipment Tracking

Shipment tracking turns carrier scans into the one answer a customer reads: where is my parcel. The
creation rules, the state machine, the carrier integration and the event stream decide whether that
answer holds.

## The real system

EasyPost's tracking API is a documented version of this service. \`POST /trackers\` with a
\`tracking_code\` and \`carrier\` creates a Tracker, and a second request from the same user with
the same code and carrier returns the original Tracker rather than a duplicate: the idempotent
create this course asks of \`POST /v1/shipments\`. Each change of a Tracker then reaches the
customer's systems as a \`tracker.updated\` webhook event. Any service in this shape meets the same
problems: late, out-of-order and concurrent scans, a failed poll that looks like silence unless it
is recorded, and a topic that outlives the request.

## What you build here

One service, **shipments**, on provided modules: \`shipments.store\` (Redis: \`shipment:{id}\`
hashes, \`order:{tenant}:{order_id}\`, \`idem:{tenant}:{key}\`, \`shipment:{id}:scans\` and
\`:rejects\`, \`shipment:{id}:poll\`, the \`poll:due\` schedule, the \`outbox:shipment.event\` list),
\`shipments.registry\` (\`lookup(carrier)\`) and \`shipments.timeline\` (\`apply_scan\`, the step 2
script, for the later steps).

1. \`POST /v1/shipments\`: tenant (**401**), \`Idempotency-Key\`, body (**400**), carrier in the
   registry (**422**), one live shipment per order (**409**), a new id after a cancellation.
2. \`apply_scan(shipment_id, status, scan_at, city)\`: one **Redis** Lua script, forward by rank,
   terminal states closed, dropped edges recorded.
3. \`poll_shipment(shipment_id, attempt)\`: **gRPC** \`CarrierGateway.PollStatus\`
   (\`proto/shipment_tracking.proto\`) under a 4-second deadline, failures recorded, retries
   scheduled with backoff.
4. \`record_scan(shipment_id, carrier, scan)\`: a **Kafka** \`shipment.event\` keyed by shipment,
   \`{shipment_id, status, scan_city, carrier_ref, occurred_at}\`, after the apply, parked on a
   failed delivery.
5. \`GET /v1/shipments/{id}\`: tenant-scoped, a customer view derived from the scans, an operations
   view behind \`X-Ops-Token\`.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path and looks right. You
debug it against the failure modes, fix it, and prove the fix with checks that fail on the starter
and pass on your version.

## Left out on purpose

Carrier account provisioning, label rendering and voiding, rate shopping, customs documentation,
proof-of-delivery images, notification pipelines, returns authorisation, and the last-mile routing
that legitimately needs an address.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Customer', sub: 'tracking page', x: 6, y: 30},
      {id: 'ops', kind: 'client', label: 'Operations console', sub: 'timeline · poll health', x: 6, y: 72},
      {id: 'api', kind: 'http', label: 'Shipment API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'registry', kind: 'db', label: 'Partner registry', sub: 'registry.lookup(carrier)', x: 46, y: 6},
      {id: 'db', kind: 'db', label: 'shipments store', sub: 'shipment · order · idem keys', x: 46, y: 46},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'apply script · scans · rejects', x: 46, y: 88},
      {id: 'carrier', kind: 'grpc', label: 'Carrier gateway', sub: 'PollStatus · 4 s', x: 70, y: 6},
      {id: 'kafka', kind: 'kafka', label: 'shipment.event', sub: 'key = shipment id', x: 70, y: 36},
      {id: 'scheduler', kind: 'service', label: 'Poll scheduler', sub: 'poll:due · backoff', x: 70, y: 66},
      {id: 'projection', kind: 'service', label: 'Timeline projector', sub: 'one partition per shipment', x: 91, y: 46},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'ops', to: 'api', kind: 'http', label: 'X-Ops-Token'},
      {from: 'api', to: 'registry', kind: 'plain', label: 'lookup → 422'},
      {from: 'api', to: 'db', kind: 'plain', label: 'get_by_key · active_for_order · save'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVAL apply_scan'},
      {from: 'api', to: 'carrier', kind: 'grpc', label: 'PollStatus · 4 s'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after the apply'},
      {from: 'api', to: 'scheduler', kind: 'plain', label: 'schedule_poll(now + backoff)'},
      {from: 'scheduler', to: 'api', kind: 'plain', label: 'poll_shipment when due'},
      {from: 'kafka', to: 'projection', kind: 'kafka', label: 'consume'},
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
