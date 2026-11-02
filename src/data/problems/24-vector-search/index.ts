import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Vector search: the course is not "call a nearest-neighbor library", it is the debugging a
 * search service owes its tenants before it serves one more query. A server-resolved tenant, cap
 * and index version → a cache keyed by all three with a short TTL → a scatter-gather across
 * shards under a deadline with a quorum and bounded retries → search events that carry a
 * fingerprint instead of the query → a neighbors read that reports the version that actually
 * produced the results.
 */
export const vectorSearchProblem: Problem = {
  id: 'vector-search',
  title: 'Vector Search Service',
  tagline: 'Tenant-filtered nearest-neighbor search with a scoped cache, shard quorum and labeled results.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Vector Search Service

A vector search service answers one question, which stored vectors are closest to this one inside
this tenant's corpus, and all of the difficulty is in the qualifiers. The visible part is a ranked
list of ids. The parts that decide whether the service is safe are the tenant that gets scoped onto
the query, the cap that stops one caller from asking for the whole index, the fan-out that must
answer from a quorum of shards inside a deadline, the events that describe a search without
retaining it, and the provenance stamped on every result.

## The real system

Pinecone stores records inside namespaces within an index, and every upsert and query targets
exactly one namespace; its documented multitenancy pattern is one namespace per tenant, so a query
cannot cross tenants because the namespace is part of the request the server resolves, not a filter
the caller may omit. An index also fixes the vector dimension at creation, which is why a
wrong-width query is rejected before it touches storage. The service you debug here applies the
same shape to a self-hosted design: tenant and index version resolved on the server, a cache key
that carries both, a scatter-gather over gRPC shards with a per-shard deadline and a quorum, search
events keyed by tenant that carry a fingerprint rather than the query, and a neighbors read labeled
with the version that produced its results.

## What you build here

One service, **searchd**, with five pieces:

1. \`POST /v1/search\`: the authenticated tenant filter, a query vector checked against the active
   index's dimension, \`k\` capped at 100, and a server-resolved index version; the caller picks
   none of the three.
2. A **Redis** result cache: keyed by \`(tenant, index version, query digest, k)\`, written with a
   60-second TTL, expired rather than invalidated by hand, and not shared across tenants.
3. A **gRPC** shard client: a 400 ms deadline per shard, bounded retries inside a small retry
   budget, a quorum of shard replies before answering, and an explicit partial answer instead of a
   silently incomplete list.
4. A **Kafka** \`search.query\` topic: one event per search keyed by tenant, an idempotent producer
   with \`acks=all\`, latency, \`k\`, index version and a query fingerprint but no query text, an
   outbox row when the broker rejects the produce, and a consumer that updates counters before it
   commits the offset.
5. \`GET /v1/documents/{id}/neighbors\`: always tenant-filtered, capped at 20 neighbors, **404** for
   a document that belongs to another tenant, and labeled with the index version the results were
   actually read from.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path,
and it looks right. Your job in every step is the job you will have on a real feature: debug it
against the failure modes, name the subtle one, fix it, optimize what is wasteful, and prove the
fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Vector index internals (HNSW parameters, quantization, recall tuning), embedding generation, ingest
pipelines, shard rebalancing, a query language for filters beyond the tenant, reranking models, and
the console an operator would use to watch recall and latency. The five pieces above are the ones
that decide whether the service is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'search · neighbors', x: 8, y: 50},
      {id: 'search', kind: 'http', label: 'Search API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'index', kind: 'db', label: 'Index versions', sub: 'active · 768 dims', x: 44, y: 12},
      {id: 'cache', kind: 'redis', label: 'Result cache', sub: 'search:{tenant}:…', x: 44, y: 50},
      {id: 'shards', kind: 'grpc', label: 'Index shards', sub: 'Search · 400 ms', x: 44, y: 86},
      {id: 'kafka', kind: 'kafka', label: 'search.query', sub: 'key = tenant', x: 68, y: 32},
      {id: 'consumer', kind: 'service', label: 'Analytics consumer', sub: 'group search-analytics', x: 68, y: 82},
    ],
    edges: [
      {from: 'client', to: 'search', kind: 'http', label: 'HTTPS'},
      {from: 'search', to: 'index', kind: 'plain', label: 'active version · dims'},
      {from: 'search', to: 'cache', kind: 'redis', label: 'GET / SET ex 60'},
      {from: 'search', to: 'shards', kind: 'grpc', label: 'Search · scatter'},
      {from: 'search', to: 'kafka', kind: 'kafka', label: 'produce search.query'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'cache', kind: 'redis', label: 'HINCRBY fingerprint stats'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
