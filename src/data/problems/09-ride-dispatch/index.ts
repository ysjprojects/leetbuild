import type {Problem} from '@/lib/types';

import {requestRideStep} from './steps/1-request-ride';
import {locationStreamStep} from './steps/2-location-stream';
import {nearestDriversStep} from './steps/3-nearest-drivers';
import {offerLockStep} from './steps/4-offer-lock';
import {tripEventsStep} from './steps/5-trip-events';
import {etaStep} from './steps/6-eta';

/**
 * Ride dispatch: an idempotent ride request API → driver positions streamed over gRPC into Redis
 * GEO with a presence TTL → nearest-driver search → one offer per driver as an NX lock with a
 * compare-and-delete → trip events through Kafka into a state-machine consumer → an ETA call with
 * a deadline that degrades to a straight-line estimate.
 */
export const rideDispatchProblem: Problem = {
  id: 'ride-dispatch',
  title: 'Ride Dispatch',
  tagline:
    'Match riders to nearby drivers: Redis GEO, an offer lock, trip events through Kafka, an ETA that degrades gracefully.',
  difficulty: 'hard',
  concepts: ['http', 'grpc', 'redis', 'kafka'],
  minutes: 90,
  statement: `# Ride Dispatch

A rider taps *Request*. Within a few seconds a driver two streets away sees the offer, accepts it, and
the rider watches the car approach. Thousands of drivers move every few seconds; every ride is a small
state machine that must never go backwards.

## The real system

Uber or Lyft dispatch: supply/demand forecasting, surge pricing, map-matching GPS noise onto roads,
per-city sharding, batched matching that optimises across many riders at once, fraud detection, payments,
and a routing engine with live traffic.

## What you build here

One service, **dispatch**, with six pieces:

1. An HTTPS API: \`POST /rides\` validates coordinates, requires an \`Idempotency-Key\` and dedupes it in Redis; \`GET /rides/{id}\` reports the status.
2. A **client-streaming gRPC** endpoint drivers push positions to, written into a Redis **GEO** set with a presence TTL.
3. **Nearest-driver search**: \`GEOSEARCH\` by radius, one \`MGET\` to drop drivers who went silent, a status filter, the top k.
4. An **offer lock**: \`SET NX EX\` gives a driver one open offer at a time; accept and decline use a compare-and-delete so a stale answer cannot steal a newer offer.
5. **Trip events** through Kafka keyed by ride id, consumed by a state-machine consumer group that skips illegal transitions and commits after it writes.
6. An **ETA** call to a routing service with a 500 ms deadline that falls back to a straight-line estimate — and says so — instead of failing or retrying.

## Left out on purpose

Surge pricing, forecasting, map-matching, multi-city sharding, batched global matching, payments and
fraud. None of them change the shape of the six pieces above: an idempotent write, a stream into a
spatial index, a lock with a lease, an ordered event log with a state machine behind it, and a dependency
you must not let take you down.`,
  diagram: {
    nodes: [
      {id: 'rider', kind: 'client', label: 'Rider app', sub: 'POST /rides · GET /rides/{id}', x: 9, y: 28},
      {id: 'driver', kind: 'client', label: 'Driver app', sub: 'position every 4 s', x: 9, y: 74},
      {id: 'api', kind: 'http', label: 'ride-api', sub: 'HTTPS :8443', x: 31, y: 28},
      {id: 'location', kind: 'grpc', label: 'location-svc', sub: 'UpdateLocations (client stream)', x: 31, y: 74},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'drivers:{city} GEO · offer:driver:{id}', x: 55, y: 74},
      {id: 'dispatcher', kind: 'service', label: 'dispatcher', sub: 'nearest · offer · accept', x: 55, y: 28},
      {id: 'kafka', kind: 'kafka', label: 'trip-events', sub: 'key = ride_id · group trip-state', x: 79, y: 28},
      {id: 'routing', kind: 'grpc', label: 'Routing', sub: 'Eta(origin, dest) · 500 ms', x: 79, y: 74},
    ],
    edges: [
      {from: 'rider', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'driver', to: 'location', kind: 'grpc', label: 'stream LocationUpdate'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'SET idem NX EX'},
      {from: 'api', to: 'dispatcher', kind: 'plain', label: 'start_matching'},
      {from: 'location', to: 'redis', kind: 'redis', label: 'GEOADD · SET seen EX 30'},
      {from: 'dispatcher', to: 'redis', kind: 'redis', label: 'GEOSEARCH · offer lock'},
      {from: 'dispatcher', to: 'kafka', kind: 'kafka', label: 'produce / consume'},
      {from: 'dispatcher', to: 'routing', kind: 'grpc', label: 'Eta'},
    ],
  },
  steps: [requestRideStep, locationStreamStep, nearestDriversStep, offerLockStep, tripEventsStep, etaStep],
};
