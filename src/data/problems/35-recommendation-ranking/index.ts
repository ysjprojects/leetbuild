import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Recommendation ranking: the course is not "call a model and show a list", it is the debugging
 * you owe a ranking service before real users see its output. An endpoint that ranks for the
 * authenticated user and bounds what goes in and out → a tenant-keyed feature cache with one
 * refresh per miss and a stale copy → a deadline-bounded gRPC rank that degrades to a marked
 * popularity order → user-keyed impression events with positions and an outbox → a surface config
 * read a rollback reaches within seconds.
 */
export const recommendationRankingProblem: Problem = {
  id: 'recommendation-ranking',
  title: 'Recommendation Ranking',
  tagline:
    'Rank candidates per user behind a feature cache, with a popularity fallback the impression stream can tell apart.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Recommendation Ranking

A recommendation ranker answers "what should this person see next" on a surface such as a home feed.
The ordered list is the visible part. Whether it belongs to the right person,
survives a slow model and can be attributed afterwards is decided around it: the request boundary,
the feature cache, the model call's failure policy, the impression stream and the surface config.

## The real system

Feast, the open-source feature store, keeps every feature view of one entity in a single Redis hash
and, with \`key_ttl_seconds\`, sets a Redis \`EXPIRE\` on that hash after each write, so an entity's
online features are evicted together once they are old. Around a store like that sits the shape
this course builds: an expiring feature cache with one refresh per miss, a deadline-bound model call
that degrades to a marked popularity order, impressions keyed by user, and a surface config a
rollback can switch.

## What you build here

One service, **recsvc**, sharing one contract: the gRPC services in \`ranking.proto\` (\`Ranker.Rank\`,
\`FeatureService.UserFeatures\`), the provided \`recs.store\` (\`popularity:{surface}\`, the surface
configs \`surface:{surface}\` with their promotion record, the \`outbox\` list) and the ranked list
\`{items: [{id, score}], model_version, fallback}\` that \`rank\` returns.

1. \`POST /v1/recommendations\` with \`X-Tenant-Id\`, \`X-User-Id\` and \`{surface, candidate_ids}\`: at
   most 500 candidates into \`rank\` (step 3), the top 30 out with their positions, the model version
   and the fallback flag.
2. \`load_features(tenant, user_id)\`: a **Redis** cache \`features:{tenant}:{user_id}\` with a
   300-second TTL, one refresh per miss under a lock, and a stale copy for feature-service outages.
3. \`rank(tenant, user_id, surface, candidate_ids)\`: the **gRPC** \`Ranker.Rank\` call under a 500 ms
   deadline, retrying only \`UNAVAILABLE\`, falling back to the popularity order stamped
   \`popularity-v1\` and marked \`fallback\`.
4. \`publish_impression(tenant, user_id, surface, ranked)\`: one **Kafka** \`recsys.impression\` record
   per served list, keyed by user, with ids, positions, the version and the flag, from an idempotent
   \`acks=all\` producer, with an outbox row when the broker does not acknowledge.
5. \`GET /v1/surfaces/{surface}/config\`: the surface's active version and fallback policy, cached for
   at most 5 seconds, 404 for a version that was never promoted.

## The debugging habit

Every starter compiles, serves the happy path and hides flaws. Debug it against the failure modes the
task names, fix it, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Candidate retrieval and ANN indexes, feature engineering, model training, ranking quality metrics,
experiment assignment and the outbox relay itself.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'feed · surfaces', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Recommendation API', sub: 'recsvc', x: 26, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'features · popularity · surfaces · outbox', x: 48, y: 16},
      {id: 'features', kind: 'grpc', label: 'Feature service', sub: 'UserFeatures', x: 72, y: 12},
      {id: 'ranker', kind: 'grpc', label: 'Ranker', sub: 'Rank · 500 ms', x: 72, y: 44},
      {id: 'kafka', kind: 'kafka', label: 'recsys.impression', sub: 'key = user_id', x: 48, y: 84},
      {id: 'analytics', kind: 'service', label: 'Offline evaluation', sub: 'by model_version', x: 72, y: 84},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'recommendations · surface config'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'features · popularity · config'},
      {from: 'api', to: 'features', kind: 'grpc', label: 'UserFeatures on a miss'},
      {from: 'api', to: 'ranker', kind: 'grpc', label: 'Rank · deadline 500 ms'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'impression · key user_id'},
      {from: 'kafka', to: 'analytics', kind: 'kafka', label: 'consume'},
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
