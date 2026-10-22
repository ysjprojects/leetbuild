import type {Problem} from '@/lib/types';

import {geoPresenceStep} from './steps/1-geo-presence';

/**
 * One mechanism, drilled: a GEO set answers "who is near", a TTL key per driver answers "who is
 * still here", and the query joins the two — over-fetch, one MGET, filter, cut to k.
 */
export const redisGeoPresenceProblem: Problem = {
  id: 'redis-geo-presence',
  title: 'Nearest with presence: GEO plus heartbeats',
  tagline:
    'A GEO set remembers positions forever; a 30 s presence key per driver says who is still there. Join the two in two round trips, over-fetching so k survives the filter.',
  difficulty: 'hard',
  concepts: ['redis'],
  minutes: 35,
  statement: `# Nearest with presence: GEO plus heartbeats

A GEO set is a sorted set whose scores are geohashes: \`GEOADD\` places a member, \`GEOSEARCH\` returns the
members within a radius, sorted by distance, with the distance computed server-side. What it cannot
tell you is whether the member is still there. A driver whose app died ten minutes ago sits in the set
at its last position, and a radius query returns it as cheerfully as a live one. Presence is a
separate fact with a separate shape: one \`seen:{driver_id}\` key per driver with a 30 s TTL, refreshed
by every heartbeat, gone on its own when the heartbeats stop.

This is how ride dispatch, food delivery, "friends nearby" and fleet dashboards all answer "who is
close *and* here": the heartbeat writes both facts in one pipeline, the query asks the GEO set for
more candidates than it needs (\`COUNT 4k\`), checks their presence keys in a single \`MGET\`, drops the
silent ones and keeps the first \`k\`. A sweeper reclaims the GEO members whose presence has expired so
the set does not grow without bound.

The module is four functions over the key \`drivers\` and the keys \`seen:{driver_id}\`:
\`heartbeat(driver_id, lat, lon)\`, \`nearest(lat, lon, radius_km, k) → [(driver_id, distance_km)]\`,
\`remove(driver_id)\` and \`sweep(limit) → int\`.

## What you build here

1. The four functions, with the exact commands the step lists: a heartbeat that is one pipeline, a
   \`nearest\` that is at most two round trips and never returns a driver whose heartbeat is older than
   30 s, a \`remove\` that deletes both facts, and a \`sweep\` that removes only stale members and reports
   how many.

## Left out on purpose

Sharding the GEO set by city, ETA instead of straight-line distance, driver status (on a trip, off
duty), and the stream of position updates itself. Those are other drills; this one is the join
between a spatial index and a liveness signal.`,
  diagram: {
    nodes: [
      {id: 'drivers', kind: 'client', label: 'driver apps', sub: 'heartbeat every few seconds', x: 10, y: 50},
      {id: 'dispatch', kind: 'service', label: 'dispatch', sub: 'nearest · remove · sweep', x: 45, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'drivers (GEO) · seen:{driver_id} EX 30', x: 80, y: 50},
    ],
    edges: [
      {from: 'drivers', to: 'dispatch', kind: 'plain', label: 'heartbeat(id, lat, lon)'},
      {from: 'dispatch', to: 'redis', kind: 'redis', label: 'GEOADD + SET EX · GEOSEARCH → MGET'},
    ],
  },
  steps: [geoPresenceStep],
};
