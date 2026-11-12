import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Maps routing: the course is not "call a routing engine from an endpoint", it is the debugging you
 * owe a navigation path before drivers follow it. Route requests refused before the solver → one
 * cell- and epoch-keyed Redis entry per trip → a deadline-bounded engine client whose fallback is
 * this trip's straight line, marked degraded → region-keyed route events with an outbox and no
 * coordinates → a tenant-scoped read that reports the epoch a route was solved under.
 */
export const mapsRoutingProblem: Problem = {
  id: 'maps-routing',
  title: 'Maps Routing',
  tagline:
    'Route requests refused before the solver, and routes cached and read back under the traffic epoch they were solved for.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Maps Routing

A maps routing service turns an origin, a destination and a few waypoints into a route a driver can
follow, and hands that route back when the trip is reopened or shared. The polyline is the visible
part. The hard parts are what reaches the solver, what makes two requests the same cache entry, what
to answer when the engine is down, and what a stored route admits about where it came from.

## The real system

OSRM, the open-source router behind many of these services, refuses what it cannot route with a
code instead of a guess: \`NoSegment\` when a coordinate cannot snap to a street, \`TooBig\` when a
request exceeds the server's size limits, \`NoRoute\` when no road connects the points. Its responses
can also carry a \`data_version\` naming the map extract they were computed from. The traffic epoch
plays that role here: every route carries the epoch it was solved under, from the cache key to the
read.

## What you build here

One service, **mapsd**, whose five pieces share the provided \`mapsd\` package: \`geo\` (\`Point\`; a
route with \`distance_m\`, \`duration_s\`, \`geometry\`, \`epoch\`, \`engine_version\` and \`degraded\`;
\`current_epoch()\`, floor(unix seconds / 300); \`haversine_m\`; \`trip_cell\`), \`coverage\`
(\`covers(tenant, point)\` over the \`coverage:{tenant}\` box) and \`routes\` (\`save_route\` and
\`load_route\` on the \`routes:{id}\` hash, \`add_outbox\` on the \`outbox:route.computed\` list). Steps 2
and 3 are provided to the others as \`mapsd.cache\` and \`mapsd.engine\`.

1. \`POST /v1/routes\` (\`X-Tenant-Id\`; \`origin\`, \`destination\`, up to 25 \`waypoints\`): 401, 422 and
   403 \`OUT_OF_COVERAGE\` before anything is solved, then 201 with the stored route's id.
2. A **Redis** route cache, \`cached_route(origin, destination, waypoints)\`: \`route:{epoch}:{cells}\`
   with a 600 s expiry, never holding a degraded estimate.
3. A **gRPC** engine client, \`compute_route(origin, destination, waypoints, epoch)\` over
   \`RoutingEngine.ComputeRoute\`: a 1.5 s deadline, three attempts, \`NOT_FOUND\` as \`NoRoute\`, and
   this trip's straight line marked \`degraded\` when the engine cannot answer.
4. A **Kafka** \`route.computed\` event, \`publish_route_computed(…)\`: keyed by region, the trip as a
   \`trip_cell\`, an outbox row when the broker refuses it.
5. \`GET /v1/routes/{id}\`: tenant-scoped, with the stored \`epoch\`, \`stale\` and \`degraded\`.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Map tile updates, turn-by-turn instructions, live traffic ingestion and ETA models, lane-level
geometry, multi-leg itineraries, the outbox relay, and the map client. The five pieces above decide
whether a route is valid, current, scoped to its tenant and clear about where it came from.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'navigation · share', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'mapsd', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'coverage', kind: 'db', label: 'Coverage', sub: 'coverage:{tenant}', x: 46, y: 10},
      {id: 'redis', kind: 'redis', label: 'Route cache', sub: 'route:{epoch}:{cells}', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'route.computed', sub: 'key = region', x: 46, y: 90},
      {id: 'engine', kind: 'grpc', label: 'Routing engine', sub: 'ComputeRoute · 1.5 s', x: 70, y: 10},
      {id: 'fallback', kind: 'external', label: 'Straight-line estimate', sub: 'marked degraded', x: 70, y: 38},
      {id: 'store', kind: 'db', label: 'Route store', sub: 'routes:{id} · outbox', x: 70, y: 66},
      {id: 'consumer', kind: 'service', label: 'Telemetry consumer', sub: 'region rollups', x: 70, y: 92},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'coverage', kind: 'plain', label: 'covers(tenant, point)'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'cached_route'},
      {from: 'api', to: 'engine', kind: 'grpc', label: 'compute_route'},
      {from: 'api', to: 'fallback', kind: 'plain', label: 'engine cannot answer'},
      {from: 'api', to: 'store', kind: 'plain', label: 'save_route · load_route · add_outbox'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'publish_route_computed'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
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
