import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Shipment tracking on the AI-era track: the course is not "call a carrier API", it is the review
 * you owe a model-generated tracking service before it publishes a delivery promise. One live
 * shipment per order with idempotent creates → a forward-only Redis timeline applied atomically →
 * carrier polls with a deadline, recorded failures and schedule-based retries → shipment-keyed
 * timeline events that carry cities, never addresses, and follow the state commit → a read that
 * derives delivered from the scans and keeps the operations fields out of the customer view.
 */
export const shipmentTrackingProblem: Problem = {
  id: 'shipment-tracking',
  title: 'Shipment Tracking',
  tagline: 'Shipment timelines that only move forward and reconcile with carriers.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Shipment Tracking

Shipment tracking is the piece of a commerce platform that turns carrier scans into the one answer a
customer actually reads: where is my parcel, and when will it arrive. The visible part is a status
line and an estimated delivery; the parts that decide whether the promise is trustworthy are the
creation rules, the state machine, the carrier integration and the event stream behind the timeline.

## The real system

A production tracking service accepts a create from the order pipeline and must never let one order
hold two live labels, because the carrier bills for both. It talks to several carrier partners whose
codes are registered, not invented, and whose scans arrive late, out of order and concurrently. It
applies those scans to a status that only moves forward, so a delayed in-transit scan cannot
"un-deliver" a parcel that is already on the porch, and it treats delivered and returned as the end
of the line. It polls carriers under a deadline and records a failed poll as a failed poll, never as
good news, so a stalled feed becomes visible instead of healthy. It publishes one timeline event per
status change, keyed by shipment so a shipment's history stays ordered, and it keeps the event
coarse — states, cities and carrier references — because the topic is retained and replicated and
the recipient's address belongs nowhere near it. And it never reports delivered for a shipment whose
only scan is a label: the scans are the truth, the stored status is a cache.

## What you build here

One service, **shipments**, with five pieces:

1. \`POST /v1/shipments\`: an authenticated tenant, an \`Idempotency-Key\`, a validated service
   level, a carrier checked against the partner registry (**422** when unknown), **one active
   shipment per order** (**409** with the existing shipment id), and a cancelled shipment replaced
   under a **new** id that names its predecessor in \`replacement_of\`.
2. A **Redis** status timeline: \`label\` → \`in_transit\` → \`out_for_delivery\` → \`delivered\`
   (and \`returned\`), applied by one atomic Lua script so concurrent carrier scans resolve to the
   furthest valid state, with terminal states immutable and every dropped edge recorded.
3. A **gRPC** carrier client: a 4-second deadline per poll, a failed poll recorded with its error
   and its staleness instead of an invented status, and the next attempt handed to the scheduler
   with a growing backoff rather than retried in the request.
4. A **Kafka** timeline: one \`shipment.event\` per status change keyed by **shipment id**, carrying
   the state, the scan **city** and a carrier reference, published **after** the state store commits,
   and never carrying a recipient address.
5. \`GET /v1/shipments/{id}\`: tenant-scoped with **404** for anything that is not the caller's, a
   customer view whose status is derived from the scans and whose timeline stops at city
   granularity, and an operations view — \`X-Ops-Token\` — that adds poll health, the reconciliation
   flag and the carrier's error payload.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Carrier account provisioning, label rendering and voiding, rate shopping, customs documentation,
proof-of-delivery images, notification pipelines, returns authorisation workflows, and the last-mile
routing that legitimately needs an address. The five pieces above are the ones that decide whether
the timeline a customer sees is true, ordered and safe to put in front of them.`,
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
