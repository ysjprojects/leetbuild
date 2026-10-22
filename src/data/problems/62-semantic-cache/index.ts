import type {Problem} from '@/lib/types';

import {lookupEndpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Semantic cache on the AI-era track: the course is not "put a vector in Redis", it is the review
 * you owe a model-generated answer cache before it serves one tenant's answer to another tenant's
 * question. A lookup whose similarity floor the caller cannot lower → entries written atomically
 * into a per-tenant, per-version index → a model call on miss with a deadline and a cacheability
 * policy → text-free result events with an outbox → stats that report age, not just a hit rate.
 */
export const semanticCacheProblem: Problem = {
  id: 'semantic-cache',
  title: 'Semantic Cache',
  tagline: 'Answer cache by meaning, not bytes, with tenant and version safety.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Semantic Cache

A semantic cache answers a new question from an old one that \`meant\` the same thing: the caller
sends an embedding, the cache searches its nearest neighbours, and above some similarity it returns
the stored answer instead of paying a model call. It is the cheapest large win in an AI platform and
the easiest one to get wrong, because every failure mode it has looks like a hit.

## The real system

A production semantic cache is a trust boundary, not a lookup table. The similarity floor is the
service's, never the caller's, because a threshold of zero turns the nearest neighbour — however
unrelated — into an answer. Entries are scoped to a tenant and a model version, because "similar"
across tenants is a data leak and "similar" across versions is a behaviour change nobody reviewed.
Writes are atomic, because an embedding with no answer behind it is a hit that returns nothing.
Misses call the model under a deadline and cache the answer only when the serving policy says the
answer is self-contained, deterministic and allowed to be reused; a refusal is terminal and never
becomes a cached answer for the next question. Every hit and miss publishes a result event keyed by
tenant, carrying the entry digest, the similarity and the policy version, and never the query or the
answer text — a cache is not a licence to copy user content into a retained topic. And the stats
endpoint reports age, because a 99% hit rate over answers that are all a week old is a health
warning, not a success.

## What you build here

One service, **semcached**, with five pieces:

1. \`POST /v1/semantic-cache/lookup\`: an authenticated tenant, a query embedding, a caller-supplied
   threshold that the service floors, and a response that reports the similarity and the entry's age
   on a hit — and no hit at all when the entry has expired.
2. A **Redis** vector store: one index per \`(tenant, model version)\`, entries written atomically
   with their embedding and answer under a single script, expired entries unreadable, and no lookup
   that can see another tenant's vectors.
3. A **gRPC** model client: a 4-second deadline per call, a single attempt, and a write-back that
   only caches responses the serving policy marks cacheable — never refusals, never tool-dependent
   answers.
4. A **Kafka** result stream: one \`semantic-cache.result\` event per lookup keyed by tenant with the
   entry digest, similarity and policy version, an idempotent producer with \`acks=all\`, an outbox
   row when the broker rejects the produce, and no query or answer text anywhere in the payload.
5. \`GET /v1/semantic-cache/{tenant}/stats\`: per tenant and model version, a hit rate that separates
   automated near-duplicate traffic, an average similarity over hits, and the share of hits older
   than an hour — and **403** for anyone asking about another tenant.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Embedding generation and model hosting, vector index tuning (HNSW parameters, shard sizing),
invalidation webhooks, negative caching, cross-region replication, billing, and the analytics UI.
The five pieces above are the ones that decide whether the cache is correct, tenant-isolated and
shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'lookup · stats', x: 8, y: 50},
      {id: 'cache', kind: 'http', label: 'Semantic Cache', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'policy', kind: 'service', label: 'Serving policy', sub: 'floor · cacheable', x: 44, y: 12},
      {id: 'db', kind: 'db', label: 'cache store', sub: 'entries · outbox', x: 44, y: 36},
      {id: 'redis', kind: 'redis', label: 'Redis vector index', sub: 'per (tenant, version)', x: 44, y: 62},
      {id: 'kafka', kind: 'kafka', label: 'semantic-cache.result', sub: 'key = tenant', x: 44, y: 88},
      {id: 'llm', kind: 'grpc', label: 'Model service', sub: 'Answer / Stream', x: 66, y: 22},
      {id: 'stats', kind: 'service', label: 'Stats consumer', sub: 'hit rate · age', x: 70, y: 74},
    ],
    edges: [
      {from: 'client', to: 'cache', kind: 'http', label: 'HTTPS'},
      {from: 'cache', to: 'policy', kind: 'plain', label: 'floor · cacheable'},
      {from: 'cache', to: 'db', kind: 'plain', label: 'entries · outbox'},
      {from: 'cache', to: 'redis', kind: 'redis', label: 'KNN per (tenant, version)'},
      {from: 'cache', to: 'llm', kind: 'grpc', label: 'Answer on miss · 4 s'},
      {from: 'cache', to: 'kafka', kind: 'kafka', label: 'produce result'},
      {from: 'kafka', to: 'stats', kind: 'kafka', label: 'consume'},
      {from: 'stats', to: 'redis', kind: 'redis', label: 'HINCRBY counters'},
      {from: 'db', to: 'redis', kind: 'plain', label: 'rebuild index'},
    ],
  },
  steps: [lookupEndpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
