import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Product search: the course is not "call an index from an endpoint", it is the debugging you owe
 * a search service before it answers a tenant's catalog queries. A bounded query DSL with an
 * allowlisted filter surface, one Redis cache whose key covers every input that changes results, a
 * gRPC fan-out that cuts slow shards at a deadline and marks partial answers, tenant-keyed telemetry
 * that carries a query hash and updates counters before the offset commit, and a product read that
 * refuses to serve a price the catalog has moved past.
 */
export const productSearchProblem: Problem = {
  id: 'product-search',
  title: 'Product Search',
  tagline:
    'Catalog search: a filter allowlist, a cache key that covers every input, a fan-out that admits a missing shard.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Product Search

A catalog search service is the piece of a storefront that turns a shopper's text and filters into a
ranked page of products, and it is also the piece that decides whether one tenant can ever read
another tenant's data. The visible part is a list of titles; the parts that decide whether the
service is safe are the query grammar, the cache key, the shard fan-out, the telemetry contract, and
the freshness rule on a price.

## The real system

Elasticsearch is the engine most storefront search services sit in front of. Its search API accepts
a request-level \`timeout\`; when a shard misses it, the response still comes back, but with
\`timed_out: true\` and a \`_shards\` block that counts how many shards failed or were skipped, and the
\`allow_partial_search_results\` parameter decides whether a request with failed shards returns that
partial page or an error. The service you build here owes its callers the same contract: a page that
lost a shard says so. The service in front of the engine owns the rest. It checks filters against a
per-tenant allowlist so a crafted filter string cannot address a field the tenant may not see, and it
assembles the engine query itself. It caches results under a key that covers every input that can
change the answer (the tenant, the normalized query, the filter set, the page, the catalog index
version) with a TTL, because a price change must appear without a deploy. It fans out to shards over
gRPC under one deadline, dedupes products that appear on several shards, and emits one event per
search keyed by tenant with a query hash rather than the shopper's text. And the product read refuses
to serve a document whose index version has fallen more than five minutes behind the catalog
snapshot.

## What you build here

One service, **searchd**, with five pieces:

1. \`GET /v1/search\`: a text query capped at 256 bytes, filter fields checked against a per-tenant
   allowlist that answers \`400\` with the allowed set, a page size capped at 100, and an engine query
   assembled from validated values so a filter cannot name a field the tenant cannot see.
2. A **Redis** query cache keyed by \`(tenant, normalized query, filter hash, page, index version)\`
   with a 60-second TTL, and a catalog update that bumps the index version so new results appear
   inside one TTL.
3. A **gRPC** shard client: a 350 ms deadline, a fan-out that answers when every shard replies or a
   majority does, dedupe by product id, a \`partial\` flag when a shard missed, and retries that stop
   when the deadline budget is gone.
4. A **Kafka** telemetry path: one \`search.event\` keyed by tenant carrying the query hash, the
   result count and the latency, with the raw query kept out, an idempotent producer and a consumer
   that updates the counters before it commits the offset.
5. \`GET /v1/products/{id}\`: the catalog document with its own price version, a refusal when the
   index version trails the current snapshot by more than five minutes, and \`404\` for a product id
   that is not in the caller's catalog.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. Your job in every step is the job you will have on a real search feature: debug it
against the failure modes, name the subtle one, fix it, optimize what is wasteful, and prove the fix
with checks that fail on the starter and pass on your version.

## Left out on purpose

Ranking and relevance tuning, analyzers and tokenizers, index build pipelines, faceting, per-tenant
document boost, shard rebalancing, suggestion/autocomplete, and query-language versioning. The five
pieces above are the ones that decide whether the search service is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'search · product read', x: 8, y: 50},
      {id: 'search', kind: 'http', label: 'Search API', sub: 'HTTPS :8443', x: 26, y: 28},
      {id: 'read', kind: 'http', label: 'Product read', sub: 'HTTPS :8443', x: 26, y: 74},
      {id: 'engine', kind: 'service', label: 'Query engine', sub: 'allowlisted filters · tenant scope', x: 50, y: 6},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'query cache · counters', x: 50, y: 32},
      {id: 'shard-a', kind: 'grpc', label: 'Shard A', sub: 'Search(q, filters, page)', x: 50, y: 58},
      {id: 'shard-b', kind: 'grpc', label: 'Shard B', sub: 'Search(q, filters, page)', x: 50, y: 82},
      {id: 'catalog', kind: 'db', label: 'Catalog', sub: 'documents · index version', x: 74, y: 12},
      {id: 'kafka', kind: 'kafka', label: 'search.event', sub: 'key = tenant', x: 74, y: 48},
      {id: 'consumer', kind: 'service', label: 'Telemetry consumer', sub: 'group search-telemetry', x: 74, y: 82},
    ],
    edges: [
      {from: 'client', to: 'search', kind: 'http', label: 'HTTPS'},
      {from: 'client', to: 'read', kind: 'http', label: 'HTTPS'},
      {from: 'search', to: 'engine', kind: 'plain', label: 'validated query'},
      {from: 'search', to: 'redis', kind: 'redis', label: 'GET / SETEX query cache'},
      {from: 'search', to: 'shard-a', kind: 'grpc', label: 'Search'},
      {from: 'search', to: 'shard-b', kind: 'grpc', label: 'Search'},
      {from: 'shard-a', to: 'catalog', kind: 'plain', label: 'read index'},
      {from: 'shard-b', to: 'catalog', kind: 'plain', label: 'read index'},
      {from: 'search', to: 'kafka', kind: 'kafka', label: 'produce search.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'INCR counters'},
      {from: 'read', to: 'redis', kind: 'redis', label: 'document cache'},
      {from: 'read', to: 'catalog', kind: 'plain', label: 'snapshot + version'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
