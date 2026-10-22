import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Fleet tracking on the AI-era track: the course is the review you owe a model-generated position
 * pipeline before it drives a dispatch map. Skew-bounded, replay-safe batch ingestion → one atomic
 * Redis compare-and-set per vehicle so out-of-order packets cannot roll state backward → a gRPC
 * geofence check with a deadline whose failures retry under the position sequence → vehicle-keyed
 * position events with no driver identity, published after the Redis write → a fleet snapshot read
 * from one instant with a freshness bound.
 */
export const fleetTrackingProblem: Problem = {
  id: 'fleet-tracking',
  title: 'Fleet Tracking',
  tagline: 'Vehicle positions that stay current under out-of-order arrivals and replays.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Fleet Tracking

A fleet-tracking platform ingests positions from thousands of vehicles, keeps the latest position per
vehicle, runs geofence and route-deviation checks, publishes a position event stream for downstream
consumers, and serves dispatch snapshots. The visible part is a map; the parts that decide whether the
platform is usable are the ordering guarantees on arrival, the atomic state update that survives
out-of-order packets, the retry semantics that never lose or duplicate an alert, a position event
contract that does not leak driver data, and a snapshot read that does not show yesterday's fleet.

## The real system

Production fleets receive positions over an unreliable cell network. Packets arrive out of order, in
bursts, and replayed after a device reconnects, and a device's clock is not something you can trust.
The platform accepts a position only inside a bounded skew, dedupes by a per-vehicle sequence, and
updates state with one atomic compare-by-timestamp script so a delayed packet can never overwrite a
fresh one. Geofence and route checks are called on a deadline; a failed check is retried under the
position's sequence as its idempotency key so an alert fires exactly once. Position events are keyed
by vehicle, carry a coarse heading and never the driver identity or exact home coordinates, and are
published only after the state write, so a consumer cannot observe an event the state does not have.
Dispatch snapshots are composed from one instant, with a freshness bound that flags stale vehicles,
capped and paginated, and always scoped to the caller's tenant.

## What you build here

One service, **fleetd**, with five pieces:

1. \`POST /v1/vehicles/positions\`: authenticated tenant, a validated batch of updates, a skew bound
   on device timestamps, a per-vehicle sequence high-water mark that makes replays idempotent, and a
   guarantee that a position never regresses a vehicle's latest state. Logs carry ids, never raw
   coordinates.
2. A **Redis** latest-position record: one atomic Lua \`EVAL\` that compares the incoming timestamp
   against the stored one and writes only if newer; equal timestamps resolve deterministically by
   sequence, and the stored record always matches the winner of the comparison.
3. A **gRPC** dispatch client: a 2-second deadline per geofence check, a failed check queued for
   retry under the position sequence as its idempotency key so an alert fires once, and a guarantee
   that dispatch never receives a stale position.
4. A **Kafka** position event: \`fleet.position\` keyed by vehicle id so a vehicle's track stays
   ordered, carrying timestamp, sequence and a coarse heading, never driver identity or exact home
   coordinates, and published after the Redis write.
5. \`GET /v1/fleets/{id}/positions\`: a snapshot from one instant, capped at 5 000 vehicles,
   paginated, every position within the freshness bound or flagged stale, and scoped to the tenant.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Device provisioning, per-device clock calibration, map tile rendering, route optimization, driver
scheduling, billing, and the mobile SDK. The five pieces above are the ones that decide whether the
tracking platform is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'device', kind: 'client', label: 'Vehicle Device', sub: 'GPS · cellular', x: 8, y: 50},
      {id: 'gateway', kind: 'http', label: 'Fleet Gateway', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'api', kind: 'service', label: 'Position API', sub: 'ingest · validate', x: 44, y: 50},
      {id: 'state', kind: 'redis', label: 'Redis', sub: 'latest per vehicle', x: 62, y: 22},
      {id: 'db', kind: 'db', label: 'Position Store', sub: 'history · index', x: 62, y: 78},
      {id: 'dispatch', kind: 'grpc', label: 'Dispatch', sub: 'geofence · route', x: 80, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'fleet.position', sub: 'key = vehicle', x: 80, y: 12},
      {id: 'tenant', kind: 'client', label: 'Dispatcher', sub: 'fleet · map', x: 8, y: 12},
      {id: 'read', kind: 'http', label: 'Snapshot API', sub: 'GET /v1/fleets', x: 80, y: 88},
    ],
    edges: [
      {from: 'device', to: 'gateway', kind: 'http', label: 'POST positions'},
      {from: 'gateway', to: 'api', kind: 'http', label: 'batch'},
      {from: 'api', to: 'state', kind: 'redis', label: 'compare-and-set'},
      {from: 'api', to: 'db', kind: 'plain', label: 'append history'},
      {from: 'api', to: 'dispatch', kind: 'grpc', label: 'geofence check'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'publish after write'},
      {from: 'tenant', to: 'read', kind: 'http', label: 'GET snapshot'},
      {from: 'read', to: 'state', kind: 'redis', label: 'scan latest'},
      {from: 'read', to: 'db', kind: 'plain', label: 'stale fallback'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
