import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Realtime bidding on the AI-era track: the course is not "call a model and return a price", it is
 * the review you owe a model-generated bidder before it spends real money on auctions it cannot
 * finish. A validated endpoint that shares one auction budget → an atomic Redis claim released on
 * every loss → tiered feature deadlines that skip what does not fit → auction-keyed events carrying
 * the loss reason with an outbox → a stats read that reports timeouts and degradation honestly.
 */
export const realtimeBiddingProblem: Problem = {
  id: 'realtime-bidding',
  title: 'Realtime Bidding',
  tagline: "Bid within the auction's deadline, degrade in tiers and lose gracefully.",
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Realtime Bidding

A realtime bidder answers an auction inside the few tens of milliseconds the exchange allows — often
100 ms, sometimes 50 — with a price, a creative and a promise to pay. The visible part is one number in
a response. The parts that decide whether the bidder makes money are the budget every stage shares, the
spend claimed and released around each auction, the tiers that degrade rather than overrun, the event
stream that says why an auction was lost, and a read path honest enough to show that it was.

## The real system

Production bidders answer thousands of auctions a second from an exchange that will not wait. They
validate the request before spending anything on it, and they start one deadline from the auction's
total budget so that a slow feature service shortens the remaining stages instead of pushing the
answer past the close. They reserve spend atomically, because two bids in the same millisecond must
not both pass the last unit of a daily cap, and they release that claim when the auction is lost —
otherwise a bidder that wins one auction in ten burns its whole cap paying for nine. They fetch
features in tiers with their own slices, skip a model score the remaining budget cannot fit, and place
a conservative, explicitly degraded bid rather than a late one. They publish one event per bid, win or
loss, keyed by auction so a consumer sees that auction's history in order, with the loss reason
attached and an outbox for a broker that rejects the produce. And they report their own latency: a
dashboard that shows a 94% win rate while the bidder answers nothing in time is worse than no
dashboard at all.

## What you build here

One service, **biddingd**, with five pieces:

1. \`POST /v1/bids\`: an authenticated bidder, validated \`floor_cents\` and \`timeout_ms\`, one
   deadline started at the top of the handler and handed to every downstream call, and a marked
   no-bid when the auction's budget cannot cover another stage.
2. A **Redis** spend cap: per bidder per day, claimed with a single Lua \`EVAL\` that compares usage
   plus cost against the cap, released through a second script that clamps at zero when an auction is
   lost, with the window's expiry set on the first write.
3. A **gRPC** feature client with tiered deadlines — identity at 30 ms, contextual at 50 ms, each
   clamped to what is left — a model score skipped when the remaining budget cannot fit it, a
   conservative degraded bid, and no retry inside a slice.
4. A **Kafka** \`bid.event\` path: one event per bid, win or loss, keyed by auction id, carrying the
   result and a loss reason, produced \`acks=all\` with idempotent retries, committed after the spend
   claim and preserved in an outbox when the broker rejects it.
5. \`GET /v1/bidders/{id}/stats\`: win rate against every auction seen, bid rate, timeout rate,
   degradation share, and spend versus cap — readable only by the bidder it belongs to.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the demo,
and it sounds confident. Your job in every step is the job you will have on a real bidding team: read
the draft against the failure modes of the exchange, name the subtle one, fix it, and prove the fix
with checks that fail on the draft and pass on your version.

## Left out on purpose

Exchange protocol details (OpenRTB payload shapes, seat ids, deal terms), creative rendering and
auditing, exchange-side pacing and budget smoothing, bidding-model training and calibration,
multi-region failover, a full reconciliation service, and the ad-server integration behind a win.
The five pieces above are the ones that decide whether the bidder is correct, affordable and
diagnosable.`,
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
