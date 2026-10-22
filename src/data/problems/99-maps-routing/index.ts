import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Maps routing on the AI-era track: the course is not "call a routing engine from an endpoint", it
 * is the review you owe a model-generated navigation path before drivers follow it. Validated,
 * coverage-checked route requests → one cell- and epoch-keyed Redis entry per route → a
 * deadline-bounded engine call with an honest straight-line fallback → region-keyed route events
 * with an outbox and no user positions → a provenance-bearing, tenant-scoped route read.
 */
export const mapsRoutingProblem: Problem = {
  id: 'maps-routing',
  title: 'Maps Routing',
  tagline: 'Routes that cache by geography, degrade honestly and never trust coordinates.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Maps Routing

A maps routing service is the piece of a navigation platform that turns an origin, a destination and
a handful of waypoints into a route a driver can follow, and hands that route back later when the
same trip is reopened or shared. The visible part is a polyline on a map; the parts that decide
whether the service is safe are the validation funnel in front of the solver, the cache key that
decides what "the same route" even means, the failure policy for the day the engine goes quiet, and
the provenance of every route the read path returns.

## The real system

Production routing services serve many tenants — ride-hailing fleets, delivery apps, consumer
navigation — and they treat every field a client sends as a claim: a coordinate that must be finite
and on the planet, a waypoint list the solver can actually chew through in time, and an
origin-destination pair that must fall inside the coverage the tenant pays for. They cache by
rounded coordinate cells under a traffic epoch, because two drivers starting forty metres apart
want the same route, and a route computed in the morning jam must never be served after it. They
call the solver under a deadline, and when the solver cannot answer they return the best honest
estimate they can produce — clearly marked as an estimate — instead of quietly replaying an old
route as current. They publish route telemetry keyed by map region and carrying coarse cells, not
exact endpoints, because the first and last hundred metres of a trip are where someone lives. And
the read path returns provenance — which epoch, which engine version, whether the geometry was
degraded — because a route without its age is a route nobody can trust.

## What you build here

One service, **mapsd**, with five pieces:

1. \`POST /v1/routes\`: an authenticated tenant, an origin, a destination and up to 25 waypoints,
   every coordinate finite and within range, the pair checked against the tenant's map coverage,
   and a \`422\` before a poisoned request ever reaches the solver.
2. A **Redis** route cache: keys built from rounded coordinate cells, the travel mode and a traffic
   epoch that bumps every five minutes and appears in the response, so an entry is never confused
   with a fresher traffic state.
3. A **gRPC** engine client: a 1.5-second deadline per call, a no-route answer treated as terminal,
   and a timeout answered with a straight-line estimate clearly marked as degraded.
4. A **Kafka** route-event path: \`route.computed\` keyed by map region and carrying latency,
   distance, epoch and a coordinate-cell hash instead of exact endpoints, with an outbox row when
   the produce is rejected.
5. \`GET /v1/routes/{id}\`: tenant-scoped, the geometry with the epoch it was actually computed
   under, the engine version and the degraded marker if any, never restamped with the current epoch
   and never a substitute for a fresh computation.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Map tile updates, turn-by-turn instruction phrasing, live traffic ingestion and ETA prediction,
lane-level geometry, multi-leg itinerary planning, per-tenant billing for computed routes, and the
map rendering client. The five pieces above are the ones that decide whether routing is correct,
isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'navigation · share', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Maps API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'coverage', kind: 'db', label: 'Coverage store', sub: 'tenant polygons', x: 46, y: 10},
      {id: 'redis', kind: 'redis', label: 'Route cache', sub: 'cell · epoch', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'route.computed', sub: 'key = region', x: 46, y: 90},
      {id: 'engine', kind: 'grpc', label: 'Routing engine', sub: 'ComputeRoute · 1.5 s', x: 70, y: 10},
      {id: 'fallback', kind: 'external', label: 'Straight-line estimate', sub: 'marked degraded', x: 70, y: 38},
      {id: 'store', kind: 'db', label: 'Route store', sub: 'geometry · epoch · outbox', x: 70, y: 66},
      {id: 'consumer', kind: 'service', label: 'Telemetry consumer', sub: 'region rollups', x: 70, y: 92},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'coverage', kind: 'plain', label: 'coverage check'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'cells · epoch'},
      {from: 'api', to: 'engine', kind: 'grpc', label: 'ComputeRoute'},
      {from: 'api', to: 'fallback', kind: 'plain', label: 'on timeout'},
      {from: 'api', to: 'store', kind: 'plain', label: 'geometry · outbox'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce route.computed'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
