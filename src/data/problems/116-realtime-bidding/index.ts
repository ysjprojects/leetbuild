import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Realtime bidding: the debugging a bidder owes the exchange before it spends money on auctions it
 * cannot finish. The exchange's budget started once and checked before answering → a daily spend cap
 * claimed in one Lua script and released once on a loss → feature tiers with their own slices and a
 * floor bid when they fail → auction-keyed result events after the settle, with an outbox → a stats
 * read whose rates divide by every auction seen.
 */
export const realtimeBiddingProblem: Problem = {
  id: 'realtime-bidding',
  title: 'Realtime Bidding',
  tagline: 'The exchange sets the deadline: feature slices, a Lua spend cap, auction-keyed results.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Realtime Bidding

A realtime bidder answers an auction inside the budget the exchange sets, often 100 ms, with a price
it can afford. A bid that arrives after the close is discarded, and a bid the daily cap cannot cover
is money the bidder does not have. Every piece of this course is about one of those two limits.

## The real system

Prebid Server, the open source header-bidding server, reads the auction's deadline from the OpenRTB
\`tmax\` field and derives the timeout it hands each bidder from it; the Java build clamps that
timeout between \`auction.biddertmax.min\` and \`auction.biddertmax.max\` and keeps
\`auction.tmax-upstream-response-time\` back for its own answer. This course has the same shape: one
deadline from the request, slices of it for each dependency, and a margin kept for the reply.

## What you build here

One service, **biddingd**, on four provided modules (\`rtb\`): \`deadline\` (\`Deadline.start\`,
\`remaining_ms\`), \`spend\` (step 2's cap as the other steps call it), \`pricing\` (step 3's
\`quote_bid\`) and \`outbox\`.

1. \`POST /v1/bids\`, body \`{auction_id, floor_cents, timeout_ms, user_hash}\`, bidder in
   \`X-Bidder-Id\`: one \`Deadline\` from \`timeout_ms\`, the quote, a no-bid
   (\`{bid_cents: null, reason}\`) when too little is left or the cap refuses.
2. **Redis** spend cap: \`cap:{bidder}\`, the day's counter \`spend:{bidder}:{yyyymmdd}\` and one claim
   hash per auction, \`claim:{bidder}:{auction_id}\`. \`claim\` and \`settle\` are one Lua script each.
3. **gRPC** \`Features.Identity\` (30 ms), \`Features.Contextual\` (50 ms) and \`Scorer.Score\`, each
   slice clamped to what is left; a failed or skipped tier bids the floor, marked degraded.
4. **Kafka** \`bid.event\`: \`report_result\` settles the claim, then produces the win or loss keyed by
   auction id from an idempotent \`acks=all\` producer; an unacknowledged event goes to
   \`outbox:bid.event\`.
5. \`GET /v1/bidders/{id}/stats\`: today's counters from \`stats:{bidder}:{yyyymmdd}\` (written by the
   stats consumer), rates over every auction seen, and spend next to the cap, for its own bidder only.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

OpenRTB payload shapes, creatives, pacing the cap across the day, model training, the stats
consumer, the outbox relay, and reconciliation against the exchange's billing.`,
  diagram: {
    nodes: [
      {id: 'exchange', kind: 'client', label: 'Ad exchange', sub: 'bid request · result notice', x: 6, y: 40},
      {id: 'dashboard', kind: 'client', label: 'Bidder dashboard', sub: 'stats read', x: 6, y: 80},
      {id: 'api', kind: 'http', label: 'biddingd', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'cap · spend:{bidder}:{day} · claims · stats', x: 48, y: 14},
      {id: 'features', kind: 'grpc', label: 'Feature service', sub: 'Identity 30 ms · Contextual 50 ms', x: 48, y: 42},
      {id: 'scorer', kind: 'grpc', label: 'Model scorer', sub: 'Score · when 20 ms are left', x: 48, y: 64},
      {id: 'kafka', kind: 'kafka', label: 'bid.event', sub: 'key = auction id', x: 48, y: 88},
      {id: 'outbox', kind: 'db', label: 'outbox', sub: 'outbox:bid.event', x: 70, y: 70},
      {id: 'consumer', kind: 'service', label: 'Stats consumer', sub: 'stats:{bidder}:{day}', x: 70, y: 92},
    ],
    edges: [
      {from: 'exchange', to: 'api', kind: 'http', label: 'POST /v1/bids'},
      {from: 'dashboard', to: 'api', kind: 'http', label: 'GET /v1/bidders/{id}/stats'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'claim · settle · read'},
      {from: 'api', to: 'features', kind: 'grpc', label: 'tier slices'},
      {from: 'api', to: 'scorer', kind: 'grpc', label: 'score when it fits'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after settle'},
      {from: 'api', to: 'outbox', kind: 'plain', label: 'no ack'},
      {from: 'outbox', to: 'kafka', kind: 'plain', label: 'relay'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY stats'},
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
