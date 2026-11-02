import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

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

Shipment tracking turns carrier scans into the one answer a customer reads: where is my parcel, and
when will it arrive. The creation rules, the state machine, the carrier integration and the event
stream decide whether that answer holds.

## The real system

EasyPost's tracking API is a documented version of this service. \`POST /trackers\` with a
\`tracking_code\` and \`carrier\` creates a Tracker, and a second POST with the same pair returns
the original tracker rather than a duplicate, the idempotent create this course demands of
\`POST /v1/shipments\`. EasyPost then polls the carrier on a cadence that depends on the tracker's
status (about daily before first movement, faster once the parcel moves) and pushes each change as
a \`tracker.updated\` webhook event, the scheduler-driven poll and per-change event of steps 3 and
4. Any service in this shape meets the same problems: late, out-of-order and concurrent scans, a
failed poll that looks like silence unless recorded, and a topic that outlives the request.

## What you build here

One service, **shipments**, with five pieces:

1. \`POST /v1/shipments\`: an authenticated tenant, an \`Idempotency-Key\`, a carrier checked
   against the partner registry (**422** when unknown), one active shipment per order (**409** with
   the existing id), and a cancelled shipment replaced under a new id in \`replacement_of\`.
2. A **Redis** status timeline: \`label\` → \`in_transit\` → \`out_for_delivery\` → \`delivered\`
   (and \`returned\`), applied by one atomic Lua script so concurrent scans resolve to the furthest
   valid state, with terminal states immutable and dropped edges recorded.
3. A **gRPC** carrier client: a 4-second deadline per poll, a failed poll recorded with its error
   and staleness instead of an invented status, and the retry handed to the scheduler with backoff.
4. A **Kafka** timeline: one \`shipment.event\` per status change keyed by shipment id, carrying
   state, scan city and a carrier reference, published after the state store commits, with no
   recipient address.
5. \`GET /v1/shipments/{id}\`: tenant-scoped with **404** for anything not the caller's, a customer
   view derived from the scans at city granularity, and an operations view behind \`X-Ops-Token\`
   with poll health, the reconciliation flag and the carrier's error payload.

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
      {id: 'registry', kind: 'db', label: 'Partner registry', sub: 'carriers · service levels', x: 46, y: 6},
      {id: 'db', kind: 'db', label: 'shipments', sub: 'scans · status', x: 46, y: 46},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'shipment:{id} status', x: 46, y: 88},
      {id: 'carrier', kind: 'grpc', label: 'Carrier gateway', sub: 'PollStatus · 4 s', x: 70, y: 6},
      {id: 'kafka', kind: 'kafka', label: 'shipment.event', sub: 'key = shipment', x: 70, y: 36},
      {id: 'scheduler', kind: 'service', label: 'Poll scheduler', sub: 'backoff · stale', x: 70, y: 66},
      {id: 'projection', kind: 'service', label: 'Timeline projector', sub: 'group shipments', x: 91, y: 46},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'ops', to: 'api', kind: 'http', label: 'X-Ops-Token'},
      {from: 'api', to: 'registry', kind: 'plain', label: 'carrier · service level'},
      {from: 'api', to: 'db', kind: 'plain', label: 'shipment · scans'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'status {id}'},
      {from: 'api', to: 'carrier', kind: 'grpc', label: 'PollStatus · 4 s'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce shipment.event'},
      {from: 'api', to: 'scheduler', kind: 'plain', label: 'schedule backoff poll'},
      {from: 'scheduler', to: 'carrier', kind: 'grpc', label: 'poll on backoff'},
      {from: 'kafka', to: 'projection', kind: 'kafka', label: 'consume'},
      {from: 'projection', to: 'db', kind: 'plain', label: 'timeline rows'},
      {from: 'projection', to: 'redis', kind: 'redis', label: 'project status'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
