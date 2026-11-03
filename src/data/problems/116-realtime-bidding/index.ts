import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Realtime bidding: the course is not "call a model and return a price", it is
 * the debugging you owe a bidder before it spends real money on auctions it cannot
 * finish. A validated endpoint that shares one auction budget → an atomic Redis claim released on
 * every loss → tiered feature deadlines that skip what does not fit → auction-keyed events carrying
 * the loss reason with an outbox → a stats read that reports timeouts and degradation.
 */
export const realtimeBiddingProblem: Problem = {
  id: 'realtime-bidding',
  title: 'Realtime Bidding',
  tagline: 'One deadline per auction, a spend claim released on every loss, and a stats read that counts timeouts.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Realtime Bidding

A realtime bidder answers an auction inside the few tens of milliseconds the exchange allows, often
100 ms, with a price, a creative and a promise to pay. Whether it makes money depends on the budget
every stage shares, the spend claimed and released around each auction, tiers that degrade rather than
overrun, an event stream that says why an auction was lost, and a read path that shows the timeouts.

## The real system

Prebid Server, the open source header-bidding server, reads the auction's deadline from the OpenRTB
\`tmax\` field and derives the timeout it hands to every bidder adapter from it; the Java build clamps
that per-bidder timeout between \`auction.biddertmax.min\` and \`auction.biddertmax.max\`. This course
has the same shape: one deadline, validated before anything is spent on it and handed down so a slow
feature service shortens the remaining stages. A bidder that spends real money adds an atomic spend
reservation, so two bids in the same millisecond cannot both pass the last unit of a daily cap.

## What you build here

One service, **biddingd**, with five pieces:

1. \`POST /v1/bids\`: an authenticated bidder, validated \`floor_cents\` and \`timeout_ms\`, one
   deadline handed to every downstream call, and a marked no-bid when the budget cannot cover a stage.
2. A **Redis** spend cap per bidder per day, claimed with one Lua \`EVAL\`, released by a second
   script that clamps at zero when an auction is lost, with expiry set on the first write.
3. A **gRPC** feature client with tiered deadlines (identity 30 ms, contextual 50 ms, clamped to what
   is left), a model score skipped when it cannot fit, a degraded bid, and no retry inside a slice.
4. A **Kafka** \`bid.event\` path: one event per bid keyed by auction id with result and loss reason,
   \`acks=all\` with idempotent retries, and an outbox when the broker rejects it.
5. \`GET /v1/bidders/{id}/stats\`: win rate against every auction seen, bid, timeout and degradation
   rates, and spend versus cap, readable only by its bidder.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the demo and looks right. Debug it
against the exchange's failure modes, fix it, and prove the fix with checks that fail on the starter.

## Left out on purpose

OpenRTB payload shapes, creative rendering, exchange-side pacing, model training, multi-region
failover, reconciliation, and the ad-server integration behind a win.`,
  diagram: {
    nodes: [
      {id: 'exchange', kind: 'client', label: 'Ad exchange', sub: 'bid request · 100 ms', x: 6, y: 46},
      {id: 'bidding', kind: 'http', label: 'Bidding service', sub: 'HTTPS :8443', x: 24, y: 46},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'spend caps · counters', x: 42, y: 20},
      {id: 'features', kind: 'grpc', label: 'Feature service', sub: 'identity · contextual', x: 42, y: 46},
      {id: 'model', kind: 'service', label: 'Model scorer', sub: 'score · skipped when late', x: 42, y: 72},
      {id: 'creatives', kind: 'external', label: 'Creative cache', sub: 'pre-rendered markup', x: 42, y: 92},
      {id: 'kafka', kind: 'kafka', label: 'bid.event', sub: 'key = auction id', x: 64, y: 20},
      {id: 'outbox', kind: 'db', label: 'outbox', sub: 'rejected produces', x: 64, y: 46},
      {id: 'consumer', kind: 'service', label: 'Stats consumer', sub: 'wins · timeouts', x: 64, y: 72},
    ],
    edges: [
      {from: 'exchange', to: 'bidding', kind: 'http', label: 'POST /v1/bids'},
      {from: 'bidding', to: 'redis', kind: 'redis', label: 'claim · release'},
      {from: 'bidding', to: 'features', kind: 'grpc', label: 'tiered deadlines'},
      {from: 'bidding', to: 'model', kind: 'plain', label: 'score when it fits'},
      {from: 'bidding', to: 'creatives', kind: 'plain', label: 'pick creative'},
      {from: 'bidding', to: 'kafka', kind: 'kafka', label: 'produce bid.event'},
      {from: 'bidding', to: 'outbox', kind: 'plain', label: 'on rejection'},
      {from: 'outbox', to: 'kafka', kind: 'plain', label: 'republish'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume in auction order'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY counters'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
