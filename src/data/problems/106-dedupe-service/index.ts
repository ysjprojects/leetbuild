import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Deduplication: the course is not "call a similarity API", it is the debugging you owe a dedupe
 * layer before it merges a tenant's records. A tenant-scoped check, one atomic Redis
 * insert-and-check per key set, a similarity call with a deadline that degrades to exact-only,
 * dataset-keyed events carrying key hashes with an outbox, and a cluster read that refuses to bridge
 * weak pairs without review and returns evidence for every link.
 */
export const dedupeServiceProblem: Problem = {
  id: 'dedupe-service',
  title: 'Deduplication',
  tagline: 'Tenant-scoped exact and fuzzy duplicate checks with evidence behind every merge.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Deduplication

Deduplication is the piece of an AI platform that decides whether a record a caller is about to
create already exists and, when it might, whether the records should be merged. The visible part
is a boolean in a response; the parts that decide whether the platform is safe are the comparison
scope, the atomicity of the key sets, the failure policy of the similarity service, the events the
service publishes, and the evidence behind every merge.

## The real system

Zingg, the open source entity-resolution engine, shows what the read side of this service owes its
operators: every cluster it emits carries a \`Z_MINSCORE\`, the score of the weakest pair in the
cluster, and its documentation tells you to gate automation on it. Clusters whose weakest link clears
the floor flow into a golden record; clusters with a low \`Z_MINSCORE\` go to a human review queue,
because A matching B and B matching C does not mean A matches C. The same documentation calls out
that a transitively joined cluster can carry a minimum score of zero. Step 5 here is that rule as a
handler: a weak pair cannot bridge two clusters on its own, and the evidence per pair is part of the
response.

The service side is the same shape in any multi-tenant dedupe layer. A check takes the candidate's
exact keys (an email hash, a content hash) and optional fuzzy text, looks them up inside the caller's
tenant only, and reports whether a match exists. Exact keys live in per-tenant sets where
insert-and-check is one atomic operation, so two concurrent submissions of the same record agree on
one winner. Fuzzy matching calls a similarity service under a deadline, and a timeout degrades to
exact-only matching, marked as such. Check and merge events go out keyed by dataset so one dataset's
stream stays ordered, carrying hashed keys and outcomes rather than record contents.

## What you build here

One service, **dedupd**, with five pieces:

1. \`POST /v1/dedupe/check\`: an authenticated tenant, validated key types and hashed values, and a
   comparison scoped to the caller's tenant. A check must not reveal whether another tenant holds
   the same record, nor name another tenant's record id.
2. A **Redis** exact-key index: per-tenant sets where one atomic Lua script inserts a key and returns
   whether it already existed, so concurrent duplicate submissions agree on one winner. Namespaces
   are disjoint per tenant and the sets are rebuildable from the durable record store.
3. A **gRPC** similarity client: a 200 ms deadline per attempt, no retry inside the request path, and
   a failure that degrades to exact-only comparison marked as such, so a degraded result does not
   silently claim thoroughness.
4. A **Kafka** dedupe path: one \`dedupe.event\` per check or merge keyed by dataset id, carrying key
   hashes and outcomes rather than record contents or raw keys, with an outbox row when the broker
   rejects the produce.
5. \`GET /v1/clusters/{id}\`: the member records, the per-pair merge evidence and the merge history,
   where a weak pair cannot bridge clusters without review and a foreign cluster is **404**.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. Your job in every step is the job you will have on a real dedupe feature: debug it
against the failure modes, name the subtle one, fix it, optimize what is wasteful, and prove the fix
with checks that fail on the starter and pass on your version.

## Left out on purpose

Key extraction and normalization per record type, the similarity model itself, merge conflict
resolution for field values, GDPR erasure propagation, per-tenant quotas, and a review UI. The five
pieces above are the ones that decide whether dedupe is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'check · cluster read', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Dedupe API', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'exact key sets', x: 48, y: 22},
      {id: 'store', kind: 'db', label: 'record store', sub: 'records · evidence', x: 48, y: 62},
      {id: 'similarity', kind: 'grpc', label: 'Similarity service', sub: 'Resolve · 200 ms', x: 70, y: 22},
      {id: 'review', kind: 'external', label: 'Review queue', sub: 'weak pairs', x: 70, y: 62},
      {id: 'kafka', kind: 'kafka', label: 'dedupe.event', sub: 'key = dataset', x: 48, y: 88},
      {id: 'consumer', kind: 'service', label: 'Event consumer', sub: 'group dedupe', x: 70, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'insert-and-check'},
      {from: 'api', to: 'store', kind: 'plain', label: 'records · clusters'},
      {from: 'api', to: 'similarity', kind: 'grpc', label: 'Resolve'},
      {from: 'api', to: 'review', kind: 'plain', label: 'weak pair'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce dedupe.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'store', kind: 'plain', label: 'cluster updates'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
