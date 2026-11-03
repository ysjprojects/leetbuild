import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Recommendation ranking: the course is not "call a model and show a list", it is the debugging
 * you owe a ranking service before real users see its output. Validated, identity-scoped candidate
 * intake → a tenant-keyed feature cache with one refresh per miss → a deadline-bounded gRPC rank
 * with a popularity fallback that is marked as degraded → impression events keyed by user with
 * ids instead of features and an outbox behind them → a surface config read that every reader
 * resolves so a rollout is one switch.
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

A recommendation ranker answers "what should this person see next". The visible part is an ordered
list; correctness lives in the intake boundary, the feature cache, the failure policy around the
model, the exposure stream and the shared config read.

## The real system

Rankers resolve the requester from the authenticated identity and bound the candidate list. Features
come from an online store keyed by entity with an expiry: Feast's Redis online store keeps every
feature view for one entity in a single hash and sets \`key_ttl_seconds\` as a Redis \`EXPIRE\` on it,
so stale entity data is evicted automatically. A miss triggers one shared refresh, with the previous
value kept for when the feature service is down. Ranking runs over gRPC under a deadline and degrades
to a popularity order marked as degraded, because an unmarked list corrupts offline comparison.
Impressions go to Kafka keyed by user, carrying ids, positions and the model version rather than
feature vectors, with an outbox behind the produce. Every reader resolves the surface's active
version through one config read, so a rollback is one switch.

## What you build here

One service, **recsvc**, with five pieces:

1. \`POST /v1/recommendations\`: authenticated tenant and user, a validated surface and at most 500
   candidate ids, resolving the user from \`X-User-Id\` instead of the body, and returning at most 30
   ranked items stamped with the ranking model version.
2. A **Redis** feature cache keyed by \`(tenant, user)\` with a 300-second TTL, an atomic
   single-flight lock so one miss causes one feature refresh, and a stale copy that survives a
   failed refresh.
3. A **gRPC** ranking client: a 500 ms deadline, retries only on \`UNAVAILABLE\`, and a fallback to
   the popularity order tagged as degraded instead of an empty list.
4. A **Kafka** impression path: one \`recsys.impression\` event per response keyed by user id,
   an idempotent producer with \`acks=all\`, item ids and positions instead of feature vectors, and an
   outbox row when the broker rejects the produce.
5. \`GET /v1/surfaces/{surface}/config\`: the active \`model_version\` and fallback policy, served
   from a short-lived cache, 404 for a version that was never promoted, so a rollback lands in
   seconds.

## The debugging habit

Every starter compiles, serves the happy path and hides flaws. Debug it against the failure modes,
fix it, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Candidate retrieval and ANN indexes, feature engineering, model training, ranking quality metrics,
experimentation assignment, impression retention policies and dashboards.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'recommend · impressions', x: 8, y: 50},
      {id: 'recsvc', kind: 'http', label: 'Recommendation API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'catalog · outbox', sub: 'surfaces · versions', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'features · config', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'recsys.impression', sub: 'key = user', x: 44, y: 86},
      {id: 'ranker', kind: 'grpc', label: 'Ranking model', sub: 'Rank / Score', x: 66, y: 12},
      {id: 'popularity', kind: 'external', label: 'Popularity fallback', sub: 'precomputed order', x: 66, y: 38},
      {id: 'features', kind: 'service', label: 'Feature service', sub: 'per (tenant, user)', x: 66, y: 62},
      {id: 'consumer', kind: 'service', label: 'Impression consumer', sub: 'group analytics', x: 66, y: 88},
    ],
    edges: [
      {from: 'client', to: 'recsvc', kind: 'http', label: 'POST /v1/recommendations'},
      {from: 'recsvc', to: 'db', kind: 'plain', label: 'surfaces · versions'},
      {from: 'recsvc', to: 'redis', kind: 'redis', label: 'features · config'},
      {from: 'recsvc', to: 'features', kind: 'plain', label: 'on miss · single-flight'},
      {from: 'recsvc', to: 'ranker', kind: 'grpc', label: 'Rank · 500 ms'},
      {from: 'recsvc', to: 'popularity', kind: 'grpc', label: 'on DEADLINE_EXCEEDED'},
      {from: 'recsvc', to: 'kafka', kind: 'kafka', label: 'produce recsys.impression'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'grouped impressions'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
