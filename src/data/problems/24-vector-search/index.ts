import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Vector search: the course is not "call a nearest-neighbour library", it is the debugging a search
 * service owes its tenants. The tenant, width, k and index version decided by the server → a result
 * cache keyed by all of them with a TTL → a shard scatter-gather with deadlines, bounded retries and
 * a quorum → tenant-keyed search events carrying a digest instead of the vector → a neighbours read
 * that stays inside the tenant and the embedding version its document came from.
 */
export const vectorSearchProblem: Problem = {
  id: 'vector-search',
  title: 'Vector Search Service',
  tagline: 'Tenant namespaces, a version-keyed result cache, shard quorum and query digests on events.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Vector Search Service

A vector search service answers one question: which stored vectors are closest to this one, inside
this tenant's corpus, in the index version that is live. Every qualifier in that sentence is a place
where a working service leaks data or answers from the wrong embeddings.

## The real system

Pinecone isolates tenants with namespaces: every upsert and query targets exactly one namespace of
an index, and its multitenancy guide puts each tenant in its own namespace, so a query can only
reach the records of the namespace it names. An index also fixes its vector dimension at creation,
and a query of another width is rejected.

## What you build here

One service, **searchd**, over one corpus (\`search.corpus\`, provided): \`active_index()\` (the live
version and its \`dims\`), \`nearest(tenant, version, query, k)\` over the tenant's namespace
\`index:{version}:{tenant}\`, \`document(tenant, id)\` and the cross-tenant \`document_by_id(id)\`. One
digest names a query outside the request: \`search.fingerprint.query_digest(query)\`.

1. \`POST /v1/search\` \`{query, k}\` answers \`{hits: [{id, score}], k, index_version}\`. The tenant is
   the \`X-Tenant-Id\` header, the query has the active index's width, \`k\` is 1 to 100, and the
   version is the active one.
2. A **Redis** result cache, \`cached_search(tenant, query, k)\`: the key
   \`search:{tenant}:{version}:{digest}:{k}\`, written with a 60-second TTL.
3. A **gRPC** scatter-gather, \`search_shards(tenant, version, query, k)\`, over three \`Shard\`
   servers: a 400 ms deadline per call, a second attempt only after \`UNAVAILABLE\`, a quorum of two
   (else \`QuorumLost\`, a 503), the global top \`k\`, and \`partial\` when a shard is missing.
4. A **Kafka** \`search.query\` stream keyed by tenant: \`{request_id, tenant, index_version, k,
   latency_ms, query_digest}\` from an idempotent producer with \`acks=all\`, an \`outbox:search.query\`
   row when the broker rejects one, and a \`search-analytics\` consumer that updates
   \`searchstats:{tenant}:{index_version}\` before it commits.
5. \`GET /v1/documents/{id}/neighbors?k=\` (\`k\` 1 to 20): the tenant's document or **404**, its
   neighbours from the index version it was embedded for, without itself, labelled with that version.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Approximate index internals (HNSW parameters, quantization, recall tuning), embedding generation,
ingest pipelines, shard rebalancing, metadata filters beyond the tenant, reranking, and the operator
console. The five pieces above decide whether a search stays inside its tenant and its version.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'search · neighbors', x: 8, y: 50},
      {id: 'search', kind: 'http', label: 'searchd', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'corpus', kind: 'redis', label: 'Corpus', sub: 'index:active · index:{v}:{tenant}', x: 46, y: 12},
      {id: 'cache', kind: 'redis', label: 'Result cache', sub: 'search:{tenant}:{v}:{digest}:{k}', x: 46, y: 38},
      {id: 'shards', kind: 'grpc', label: 'Index shards ×3', sub: 'Shard.Search · 400 ms', x: 46, y: 64},
      {id: 'kafka', kind: 'kafka', label: 'search.query', sub: 'key = tenant', x: 46, y: 88},
      {id: 'consumer', kind: 'service', label: 'Analytics consumer', sub: 'group search-analytics', x: 70, y: 88},
    ],
    edges: [
      {from: 'client', to: 'search', kind: 'http', label: 'HTTPS'},
      {from: 'search', to: 'corpus', kind: 'redis', label: 'active_index · nearest · document'},
      {from: 'search', to: 'cache', kind: 'redis', label: 'GET / SET EX 60'},
      {from: 'search', to: 'shards', kind: 'grpc', label: 'Search · scatter'},
      {from: 'search', to: 'kafka', kind: 'kafka', label: 'produce · outbox on rejection'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'cache', kind: 'redis', label: 'HINCRBY searchstats'},
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
