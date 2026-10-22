import type {Problem} from '@/lib/types';

import {entityUpsertStep} from './steps/1-endpoint';
import {adjacencyCacheStep} from './steps/2-state';
import {resolutionClientStep} from './steps/3-dependency';
import {graphEventsStep} from './steps/4-events';
import {neighborReadStep} from './steps/5-read';

/**
 * Knowledge graph on the AI-era track: the course is not "store two tables and join them", it is the
 * review you owe a model-generated graph layer before it corrupts a tenant's entity resolution.
 * Deliberate merges behind an explicit policy → a versioned adjacency cache that cannot race → a
 * resolution client that parks on a timeout instead of splitting → entity-keyed events with an
 * outbox and an idempotent replay → a neighbour endpoint whose traversal has hard stops.
 */
export const knowledgeGraphProblem: Problem = {
  id: 'knowledge-graph',
  title: 'Knowledge Graph',
  tagline: 'Entities and edges that merge deliberately, cache safely and never traverse unbounded.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Knowledge Graph

A knowledge graph is the piece of an AI platform that remembers what the platform knows about
entities — people, organisations, documents — and how they relate. The visible part is a lookup: an
entity comes back with its neighbours. The parts that decide whether the platform is safe are the
merge policy, the cache invalidation, the failure policy of resolution, the event ordering, and the
bounds on traversal.

## The real system

Production graphs receive entity upserts from many tenants and must never let the request body choose
whether two entities become one. They cache adjacency lists per tenant and invalidate them in a way
that cannot race with a concurrent read. They resolve candidate pairs over gRPC under a deadline, and
they treat a timeout as a reason to ask a human — not as evidence that two entities differ, because
that mistake silently splits the graph every hour the resolver is slow. They publish change events
keyed by entity so an entity's history stays ordered, after the graph transaction commits, with an
outbox for the produce the broker rejected. And they bound traversal: a depth cap, a node budget and
an ownership check, because a hub entity and a known id are all an attacker needs.

## What you build here

One service, **graph-api**, with five pieces:

1. \`POST /v1/entities\`: authenticated tenant, validated type/name/aliases, an
   \`Idempotency-Key\` so a retried batch cannot double-write edges, a **server-side** merge policy,
   and a cross-type alias collision answered \`409\` with both candidates named.
2. A **Redis** adjacency cache keyed by \`(tenant, entity)\` with a 5-minute TTL, invalidated by a
   version counter rather than a delete, so a read raced against a write is consistent with at most
   one operation.
3. A **gRPC** resolution client with a 1-second deadline: \`DEADLINE_EXCEEDED\` parks the pair in a
   review queue, a rejection is terminal, and only a score at or above the threshold merges without
   review.
4. A **Kafka** \`graph.changed\` path keyed by entity id, carrying old and new labels and the policy
   version, published after the commit, backed by an outbox, and consumed idempotently before the
   offset is committed.
5. \`GET /v1/entities/{id}/neighbors\`: depth bounded at 2, a 500-edge cap with a truncation marker,
   and a \`404\` for an entity that belongs to another tenant.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Entity-resolution scoring models, graph storage engines and query languages, bulk import pipelines,
per-tenant schema extensions, graph analytics, and the UI that lets an operator settle a review-queue
pair. The five pieces above are the ones that decide whether the graph is correct, isolated and
shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'entity · edge APIs', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'graph-api', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'Graph store', sub: 'entities · edges', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Adjacency cache', sub: 'adj:(tenant,entity)', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'graph.changed', sub: 'key = entity', x: 44, y: 84},
      {id: 'resolver', kind: 'grpc', label: 'Entity resolver', sub: 'Resolve / Score', x: 66, y: 12},
      {id: 'review', kind: 'service', label: 'Review queue', sub: 'parked pairs', x: 66, y: 38},
      {id: 'consumer', kind: 'service', label: 'Graph consumer', sub: 'merge · reindex', x: 66, y: 62},
      {id: 'outbox', kind: 'db', label: 'Outbox', sub: 'rejected events', x: 66, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'upsert · traverse'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'adjacency'},
      {from: 'api', to: 'resolver', kind: 'grpc', label: 'Resolve / Score'},
      {from: 'resolver', to: 'review', kind: 'plain', label: 'timeout · below threshold'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce graph.changed'},
      {from: 'api', to: 'outbox', kind: 'plain', label: 'on reject'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'apply merge'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'bump version'},
    ],
  },
  steps: [entityUpsertStep, adjacencyCacheStep, resolutionClientStep, graphEventsStep, neighborReadStep],
};
