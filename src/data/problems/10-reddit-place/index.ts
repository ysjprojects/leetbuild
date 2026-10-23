import {REDDIT} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {learn} from './learn';
import {protoFiles, protoModules} from './proto';
import {boardEndpointStep} from './steps/1-board-endpoint';
import {cooldownStep} from './steps/2-cooldown';
import {placementEventsStep} from './steps/3-placement-events';
import {tileStreamStep} from './steps/4-tile-stream';
import {leaderboardStep} from './steps/5-leaderboard';
import {supportModules, supportModulesTs} from './support';

/**
 * r/place, after Reddit's own write-up of the 2017 experiment: the board as one Redis string served
 * through a one-second CDN cache → the five-minute cooldown as an atomic SET NX EX (the race Reddit
 * shipped with, closed) → placements on a Kafka topic keyed by pixel → a gRPC server stream fanning
 * tiles out to clients with cancellation and a lag cap → a consumer keeping a leaderboard and a
 * per-pixel history in Redis.
 */
export const redditPlaceProblem: Problem = {
  id: 'reddit-place',
  title: 'r/place',
  tagline:
    'The shared pixel canvas: a board in Redis, a cooldown per user, placements through Kafka, a live tile stream over gRPC, a leaderboard.',
  difficulty: 'medium',
  concepts: ['http', 'redis', 'kafka', 'grpc'],
  minutes: 75,
  company: REDDIT,
  sources: [
    {
      title: 'How We Built r/Place',
      url: 'https://www.redditinc.com/blog/how-we-built-rplace',
      by: 'Brian Simpson, Matt Lee, Daniel Ellis',
      date: '2017-04-13',
      takes:
        'The board as one Redis blob read whole and cached for a second at the CDN, pixels written in place at offset x + width·y, a five-minute cooldown per user whose unlocked check-then-write let ~15 000 tiles through, and real-time fan-out of every placement to ~80 000 connected clients.',
    },
  ],
  statement: `# r/place

A million pixels, one colour each, and a rule: any logged-in user may paint one pixel every five
minutes. Everyone sees the same board, live. For 72 hours in April 2017 that was enough to make
flags, logos, a Mona Lisa and several wars — and about 200 placements per second at the peak.

## The real system

Reddit's production stack: the board in Redis fronted by Fastly, tile details and cooldown
timestamps in Cassandra, a websocket service with 24 instances pushing every placement to every
browser, OAuth for the mobile apps, bots and scrapers hammering the one endpoint the CDN could not
cache, and a RabbitMQ that buckled under the message rate until the team lengthened the cooldown to
shed load.

## From the source

*How We Built r/Place* walks through the backend decisions. The board started as a Cassandra row of a
million columns (30 s to read) and moved to a Redis bitfield of a million 4-bit colours, read whole in
under 100 ms and written one pixel at a time at a computed offset — no locking, no read-modify-write.
Requests for the board went through the CDN with a one-second expiry and \`stale-while-revalidate\`,
so the origin saw at most one request per edge node per second. Clients opened the real-time feed
*first*, then fetched the board, then replayed what had arrived in between. Drawing a tile was
check-the-timestamp, write-the-tile, write-the-timestamp — and, the authors admit, nothing locked those
three steps, so parallel requests let about 15 000 tiles through the cooldown.

This course rebuilds that backend with the pieces the post describes and fixes the one it regrets: the
board blob and its cache headers, the cooldown as one atomic Redis command, the fan-out decoupled
through a log, a streaming RPC per client, and the "who placed this pixel?" query the post calls its
most popular — served from Redis instead of a wide-table read.

## What you build here

One service, **place**, over Redis and Kafka (a 100 × 100 board, one byte per pixel, so it fits the
runtime; the shape is the real one):

1. \`GET /board\` as one \`application/octet-stream\` blob with \`Cache-Control: max-age=1\` and an \`ETag\`,
   and \`POST /place\` with its **400**s.
2. The **cooldown** as \`SET cooldown:{user} NX EX 300\` deciding in one round trip, \`SETRANGE\` painting
   one byte, **429** with \`Retry-After\` from the TTL.
3. A **Kafka** producer emitting one \`placements\` event per painted tile, keyed by pixel, without
   slowing the request or undoing the tile when the broker is down.
4. A **gRPC server stream**, \`StreamTiles\`, fanning placements out to every connected client, cleaned
   up on cancel, dropping readers that fall more than 1000 tiles behind.
5. A consumer in group \`leaderboard\` keeping a **sorted set** of tiles per user and a **capped list**
   of the last 10 placements per pixel, read by \`GET /top\` and \`GET /history?x=&y=\`.

## Left out on purpose

Authentication and the OAuth header injection for the apps, the browser (canvas, zoom, the
animation-frame batching), the 4-bit packing of two pixels per byte, Cassandra as the durable copy,
multi-region, and moderation. The five pieces above are the backend of every shared live canvas,
whiteboard or map.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'browser · bots', x: 9, y: 50},
      {id: 'api', kind: 'http', label: 'place-api', sub: 'GET /board · POST /place', x: 31, y: 30},
      {id: 'stream', kind: 'grpc', label: 'tile-stream', sub: 'StreamTiles :9000', x: 31, y: 70},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'board · cooldown:{user} · place:leaders', x: 55, y: 30},
      {id: 'kafka', kind: 'kafka', label: 'placements', sub: 'key = x:y', x: 55, y: 70},
      {id: 'worker', kind: 'service', label: 'leaderboard', sub: 'consumer group', x: 79, y: 70},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'client', to: 'stream', kind: 'grpc', label: 'StreamTiles'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'GET · SET NX EX · SETRANGE'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce'},
      {from: 'kafka', to: 'stream', kind: 'kafka', label: 'consume (own group)'},
      {from: 'kafka', to: 'worker', kind: 'kafka', label: 'consume'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'ZINCRBY · LPUSH · LTRIM'},
    ],
  },
  steps: [boardEndpointStep, cooldownStep, placementEventsStep, tileStreamStep, leaderboardStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles},
  },
  learn,
};
