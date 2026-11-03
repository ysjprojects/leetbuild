import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Fleet tracking: a position pipeline debugged before it drives a dispatch map. A batch endpoint
 * that admits a position (tenant, shape, clock skew, atomic batch) → one Lua compare-and-set per
 * vehicle (timestamp, then sequence) → a geofence check on a deadline, retried under the position's
 * key → a position event keyed by vehicle, produced after the write with acks=all → a fleet
 * snapshot read in one transaction, with a freshness flag, a cap and pages.
 */
export const fleetTrackingProblem: Problem = {
  id: 'fleet-tracking',
  title: 'Fleet Tracking',
  tagline: 'Vehicle positions under out-of-order packets, replays, a slow geofence service and a 5 000-vehicle map.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Fleet Tracking

A fleet platform ingests positions from thousands of vehicles over a cell network, keeps the latest
position per vehicle, asks a dispatch service whether a position crosses a geofence, publishes a
position stream for downstream consumers, and serves the snapshot a dispatcher's map draws. Packets
arrive late, out of order and replayed after a reconnect, and a device's clock cannot be trusted.

## The real system

Traccar, the open-source GPS tracking server, decodes every device protocol into one \`Position\`,
queues processing per device so one position finishes before the next, and in its post-processing
step updates the device's current position so that an older historical position does not replace a
newer current one. Its optional BroadcastService exchanges position updates between instances over
Redis. Fleetd keeps that shape and makes the rules explicit.

## What you build here

One service, **fleetd**, five pieces, one contract:

1. \`POST /v1/vehicles/positions\`: \`X-Tenant-Id\` or 401; every update of the batch validated before
   any write, so a bad update rejects the whole batch with 400; a device timestamp more than
   five minutes from the server clock is rejected; the response counts \`accepted\` and \`duplicate\`
   from what the state reported.
2. The latest position per vehicle in the **Redis** hash \`vehicle:{id}:latest\` (\`ts\`, \`seq\`, \`lat\`,
   \`lon\`), written by one Lua script: a position wins when its timestamp is newer, or equal with a
   higher sequence; the script answers 1 applied or 0 ignored.
3. A **gRPC** geofence check per applied position with a 2 s deadline; a failed call is queued and
   retried under the key \`geofence:{vehicle_id}:{sequence}\`, and a queued check older than a
   position dispatch has already seen is dropped.
4. A **Kafka** event on \`fleet.position\` keyed by vehicle id, carrying the vehicle id, timestamp,
   sequence and coordinates, nothing about the driver, produced with \`acks=all\` after the state
   write and only for applied positions.
5. \`GET /v1/fleets/{id}/positions\`: the fleet's members from \`fleet:{tenant}:{fleet_id}\`, their
   records read in one \`MULTI\`/\`EXEC\`, each flagged \`stale\` past 60 s, at most 5 000 vehicles,
   paged by \`limit\` and \`cursor\`.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Device provisioning, per-device clock calibration, map tiles, route optimisation, driver scheduling,
billing and the mobile SDK. The five pieces above decide whether the map is right.`,
  diagram: {
    nodes: [
      {id: 'device', kind: 'client', label: 'Vehicle device', sub: 'GPS · cellular', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'fleetd', sub: 'POST positions · GET snapshot', x: 32, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'vehicle:{id}:latest · fleet:{tenant}:{id}', x: 58, y: 18},
      {id: 'dispatch', kind: 'grpc', label: 'Dispatch', sub: 'CheckGeofence · 2 s', x: 58, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'fleet.position', sub: 'key = vehicle id', x: 58, y: 82},
      {id: 'map', kind: 'service', label: 'Consumers', sub: 'ETA · history', x: 84, y: 82},
      {id: 'dispatcher', kind: 'client', label: 'Dispatcher', sub: 'fleet map', x: 8, y: 12},
    ],
    edges: [
      {from: 'device', to: 'api', kind: 'http', label: 'POST batch'},
      {from: 'dispatcher', to: 'api', kind: 'http', label: 'GET snapshot'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVAL · MULTI/EXEC'},
      {from: 'api', to: 'dispatch', kind: 'grpc', label: 'CheckGeofence'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after write'},
      {from: 'kafka', to: 'map', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
  support: {
    python: protoModules,
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
