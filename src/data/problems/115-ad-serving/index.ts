import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Ad serving: the course is not "return an ad from an endpoint", it is the debugging you owe a
 * serving path before it spends an advertiser's budget and one user's patience. Limits before
 * ranking → one atomic Redis reservation per serve → one exchange call under 150 ms with a marked
 * house ad → render beacons deduplicated, counted, then produced keyed by campaign with an outbox →
 * a delivery read scoped to its advertiser that bills what rendered and projects the shortfall.
 */
export const adServingProblem: Problem = {
  id: 'ad-serving',
  title: 'Ad Serving',
  tagline:
    'Frequency caps, a Lua pacing reservation, an exchange with a house ad, render beacons and a delivery report.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Ad Serving

An ad server decides which campaign fills a slot, how often one user may see it, how much of a
budget a serve may take, and what the advertiser is told about delivery. The ad on the page is the
visible part; the money depends on the limits checked before ranking, a reservation two serves
cannot both win, a fallback for a slow exchange, and impressions counted when the ad rendered.

## The real system

Google Ad Manager paces a line item with its "Deliver impressions" setting: **Evenly** spreads
delivery from start to end date and may run up to 5% over the goal as a guard against
under-delivery, **Frontloaded** starts as much as 40% ahead and tapers, and the hourly goals behind
both are recomputed from impressions booked, impressions served and time remaining. Frequency caps
per line item limit how often one user sees it. This course builds the serving side of that: the
counters a pacing system reads, and the report that compares them with the goal.

## What you build here

One service, **adserved**, on a provided campaign store (\`ads.store\`): campaigns are Redis hashes
\`campaign:{id}\` (\`advertiser_id\`, \`version\`, \`state\`, \`bid_micros\`, \`freq_cap\`,
\`freq_window_s\`, \`paced_budget_micros\`, \`goal_impressions\`, \`start_ts\`, \`end_ts\`), read with
\`campaigns_for\` and \`get_campaign\`; \`frequency\` and \`spent\` read the serve counters,
\`count_render\`/\`rendered\` the render counter, \`insert_outbox\` queues an event, \`HOUSE_AD\` is the
fallback creative.

1. \`POST /v1/ads/serve\` \`{"placement", "user_hash", "format"}\`: 400 for a malformed request, then
   state, budget and frequency cap before the highest bid; the answer names \`campaign_version\`.
2. \`reserve(campaign, user_hash, price_micros)\`: one Lua script over \`freq:{id}:{user}\` and
   \`pace:{id}\`, the cap key expiring at the frequency window.
3. \`select_ad(placement, user_hash)\`: one \`Exchange.SelectAd\` (gRPC, \`exchange:9000\`) under
   150 ms; a deadline or an outage serves \`HOUSE_AD\` marked \`kind: "house"\`.
4. \`record_impression(beacon)\`: the render beacon claimed once in \`beacon:{id}\`, counted in
   \`render:{id}\`, then produced to \`ads.impression\` keyed by campaign, with an outbox.
5. \`GET /v1/campaigns/{id}/delivery\` with \`X-Advertiser-Id\`: rendered impressions and spend, and
   the shortfall projected from the pace so far.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Auction mechanics and bid shading, creative review, viewability measurement, identity graphs,
private marketplaces, invoicing, campaign authoring and multi-region serving.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Page', sub: 'serve · beacon', x: 8, y: 50},
      {id: 'advertiser', kind: 'client', label: 'Advertiser console', sub: 'delivery read', x: 8, y: 16},
      {id: 'server', kind: 'http', label: 'Ad Server', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'campaign store', sub: 'campaign:{id} hashes', x: 44, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'freq · pace · render · beacon', x: 44, y: 46},
      {id: 'kafka', kind: 'kafka', label: 'ads.impression', sub: 'key = campaign', x: 44, y: 88},
      {id: 'exchange', kind: 'grpc', label: 'Ad exchange', sub: 'SelectAd · 150 ms', x: 68, y: 10},
      {id: 'house', kind: 'external', label: 'House ad', sub: 'fallback · price 0', x: 68, y: 38},
      {id: 'counter', kind: 'service', label: 'Billing consumers', sub: 'per-campaign order', x: 68, y: 88},
    ],
    edges: [
      {from: 'client', to: 'server', kind: 'http', label: 'serve · render beacon'},
      {from: 'advertiser', to: 'server', kind: 'http', label: 'GET delivery'},
      {from: 'server', to: 'db', kind: 'plain', label: 'campaigns · versions'},
      {from: 'server', to: 'redis', kind: 'redis', label: 'reserve · count render'},
      {from: 'server', to: 'exchange', kind: 'grpc', label: 'SelectAd'},
      {from: 'server', to: 'house', kind: 'plain', label: 'deadline · unavailable'},
      {from: 'server', to: 'kafka', kind: 'kafka', label: 'produce ads.impression'},
      {from: 'kafka', to: 'counter', kind: 'kafka', label: 'consume'},
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
