import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Product search on the AI-era track: the course is not "call an index from an endpoint", it is the
 * review you owe a model-generated search service before it answers a tenant's catalog queries.
 * A bounded query DSL with an allowlisted filter surface → one Redis cache whose key covers every
 * input that changes results → a gRPC fan-out that cuts slow shards at a deadline and is honest
 * about partial answers → tenant-keyed telemetry that carries a query hash and updates counters
 * before the offset commit → a product read that refuses to serve a price the catalog has moved past.
 */
export const productSearchProblem: Problem = {
  id: 'product-search',
  title: 'Product Search',
  tagline: 'Catalog search with bounded queries, scoped caches and honest partial results.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Product Search

A catalog search service is the piece of a storefront that turns a shopper's text and filters into a
ranked page of products, and it is also the piece that decides whether one tenant can ever read
another tenant's data. The visible part is a list of titles; the parts that decide whether the
service is safe are the query grammar, the cache key, the shard fan-out, the telemetry contract, and
the freshness rule on a price.

## The real system

Production search receives a text query, a set of structured filters, a page, and a tenant, and it
never lets the caller name the engine's internal fields. Filters are checked against a per-tenant
allowlist, so a crafted filter string cannot address a field the tenant may not see. Results are
cached, but only under a key that covers every input which can change the answer — the tenant, the
normalized query, the filter set, the page, and the catalog index version — with a TTL, because a
price change must appear without a deploy. One search fans out to many shards over gRPC under a
deadline; slow shards are cut, the merge dedupes products that appear on several shards, and an
answer that lost a shard says so instead of pretending to be complete. Every search emits one event
keyed by tenant, carrying a query hash rather than the shopper's text, and the consumer updates
counters before it commits the offset. And the product read refuses to serve a document whose index
version has fallen more than five minutes behind the catalog snapshot.

## What you build here

One service, **searchd**, with five pieces:

1. \`GET /v1/search\`: a text query capped at 256 bytes, filter fields checked against a per-tenant
   allowlist that answers \`400\` with the allowed set, and a page size capped at 100 — with the
   engine query assembled from validated values so a filter can never name a field the tenant
   cannot see.
2. A **Redis** query cache keyed by \`(tenant, normalized query, filter hash, page, index version)\`
   with a 60-second TTL, and a catalog update that bumps the index version so new results appear
   inside one TTL.
3. A **gRPC** shard client: a 350 ms deadline, a fan-out that answers when every shard replies or a
   majority does, dedupe by product id, a \`partial\` flag when a shard missed, and retries that stop
   when the deadline budget is gone.
4. A **Kafka** telemetry path: one \`search.event\` keyed by tenant carrying the query hash, the
   result count and the latency, never the raw query, with an idempotent producer and a consumer
   that updates the counters before it commits the offset.
5. \`GET /v1/products/{id}\`: the catalog document with its own price version, a refusal when the
   index version trails the current snapshot by more than five minutes, and \`404\` for a product id
   that is not in the caller's catalog.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the demo,
and it sounds confident. Your job in every step is the job you will have on a real search feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

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
