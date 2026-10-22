import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Ad serving on the AI-era track: the course is not "return an ad from an endpoint", it is the
 * review you owe a model-generated serving path before it spends an advertiser's budget and one
 * user's patience. Eligibility before relevance → one atomic Redis decision per serve → an exchange
 * call with a deadline and a house fallback → render-confirmed impressions keyed by campaign with
 * an outbox → a delivery read that reconciles against the same counters.
 */
export const adServingProblem: Problem = {
  id: 'ad-serving',
  title: 'Ad Serving',
  tagline: 'Serve ads within frequency caps and budget pacing, and count impressions once.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Ad Serving

An ad server is the piece of an ad platform that decides which campaign fills a slot, how often one
user may see it, how much of a budget may be spent by this hour, and what an advertiser is told
about the delivery they paid for. The visible part is an ad in a page; the parts that decide whether
the platform is trustworthy are the eligibility filter, the atomic pacing decision, the failure
policy for the exchange, and the counting rule.

## The real system

Production ad servers answer tens of thousands of serves a second, and every one of them has to
respect limits before it considers relevance. Frequency caps keep one user from seeing the same
creative on every page; pacing keeps a campaign's budget spread across its flight instead of spent
by lunchtime; exhausted campaigns stop serving instead of spending money nobody approved. The bids
come from an exchange over a hard deadline, and when the exchange does not answer the slot is filled
by house inventory that is counted separately from paid impressions. Impressions are counted when
the ad is **rendered**, and the events that report them are keyed so one campaign's stream stays
ordered, deduplicated by beacon, and written to an outbox when the broker rejects them. And the
delivery report an advertiser reads is reconciled against the same counters the serve path writes,
because the one number that must never disagree with reality is the one on the invoice.

## What you build here

One service, **adserved**, with five pieces:

1. \`POST /v1/ads/serve\`: validated placement, user context hash and page context, limits (state,
   pacing budget, per-user frequency cap) enforced **before** ranking, and a response that names the
   campaign version it served.
2. A **Redis** reservation: per-user frequency counters and per-campaign pacing budgets decided and
   written by one atomic Lua script, with the cap key expiring at the campaign's frequency window.
3. A **gRPC** exchange client: one call per serve under a 150 ms deadline, a house ad marked as a
   fallback when the deadline passes, and fallback impressions counted apart from paid ones.
4. A **Kafka** impression path: one \`ads.impression\` event per rendered beacon, keyed by campaign
   id, carrying the beacon id and its dedupe key, with the pacing counter committed before the
   produce and an outbox row when the broker rejects it.
5. \`GET /v1/campaigns/{id}/delivery\`: paced spend, render-counted impressions, cap-exhausted
   time and an under-delivery projection, scoped to the calling advertiser.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real ad
platform: read the draft against the failure modes, name the subtle one, fix it, and prove the fix
with checks that fail on the draft and pass on your version.

## Left out on purpose

Auction mechanics and bid shading, creative review and brand safety, viewability measurement,
identity graphs and cross-device matching, deals and private marketplaces, billing and invoicing,
campaign authoring UIs, and multi-region serving. The five pieces above are the ones that decide
whether the ad server is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Page', sub: 'serve · beacon', x: 8, y: 50},
      {id: 'advertiser', kind: 'client', label: 'Advertiser console', sub: 'delivery read', x: 8, y: 16},
      {id: 'server', kind: 'http', label: 'Ad Server', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'campaign store', sub: 'versions · scheduling', x: 44, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'freq caps · pacing', x: 44, y: 46},
      {id: 'kafka', kind: 'kafka', label: 'ads.impression', sub: 'key = campaign', x: 44, y: 88},
      {id: 'exchange', kind: 'grpc', label: 'Ad exchange', sub: 'SelectAd · 150 ms', x: 68, y: 10},
      {id: 'house', kind: 'external', label: 'House ads', sub: 'fallback · price 0', x: 68, y: 38},
      {id: 'counter', kind: 'service', label: 'Impression counter', sub: 'counted at render', x: 68, y: 70},
    ],
    edges: [
      {from: 'client', to: 'server', kind: 'http', label: 'serve · render beacon'},
      {from: 'advertiser', to: 'server', kind: 'http', label: 'GET delivery'},
      {from: 'server', to: 'db', kind: 'plain', label: 'campaigns · versions'},
      {from: 'server', to: 'redis', kind: 'redis', label: 'freq cap · pacing'},
      {from: 'server', to: 'exchange', kind: 'grpc', label: 'SelectAd'},
      {from: 'server', to: 'house', kind: 'grpc', label: 'no bid · timeout'},
      {from: 'server', to: 'kafka', kind: 'kafka', label: 'produce ads.impression'},
      {from: 'kafka', to: 'counter', kind: 'kafka', label: 'consume'},
      {from: 'counter', to: 'redis', kind: 'redis', label: 'INCR render counters'},
      {from: 'counter', to: 'db', kind: 'plain', label: 'reconciled delivery'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
