import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Product search: the course is not "call an index from an endpoint", it is the debugging you owe a
 * search service before shoppers type into it. Caps and a filter allowlist in front of an engine
 * that filters on any stored field → a Redis query cache whose key names every input and the index
 * version → a gRPC shard fan-out that says when a page is partial → tenant-keyed telemetry without
 * the query text → a product page that serves the tenant's current public document.
 */
export const productSearchProblem: Problem = {
  id: 'product-search',
  title: 'Product Search',
  tagline:
    'A filter allowlist, a versioned query cache, a shard fan-out that admits a missing shard, and tenant-keyed telemetry.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Product Search

A storefront's search box is the widest door into a catalog: whatever a query string can name, a
shopper can read. The search service behind it decides what each tenant may ask, how long an answer
may come from a cache, what a page says when part of the index did not answer, and what leaves the
service as telemetry.

## The real system

Elasticsearch, which many storefront search services sit in front of, answers with partial results
when one or more shards fail, and says so: the response's \`_shards\` block counts the shards that
succeeded and failed, and \`timed_out\` reports a request that ran past its \`timeout\`. A caller
that drops those fields shows a short page as if it were complete. This course builds a service
that owes its own callers the same honesty.

## What you build here

One service, **searchd**, over one provided module, the tenant catalog index \`search.catalog\`
(Redis hashes \`catalog:{tenant}:product:{id}\`, the index version \`catalog:{tenant}:version\` bumped
by every \`put_product\`, and \`run_query(tenant, q, filters, page_size)\`, an engine that filters on
any stored field, including the internal \`cost_cents\`):

1. \`GET /v1/search\` with \`X-Tenant-Id\`, \`q\`, \`page_size\` and \`filters\` (a JSON object of
   strings): \`q\` up to 256 bytes, a page of at most 100, filter fields from an allowlist.
2. \`cached_search(tenant, q, filters, page_size)\`: a **Redis** cache in front of \`run_query\`,
   keyed \`search:{tenant}:{index version}:{digest}\` with a 60-second TTL.
3. \`fan_out(tenant, q, page_size)\`: **gRPC** \`Shard.Search\` on three shards with a 350 ms deadline,
   a merged page deduplicated by product id, \`partial\` and \`missed\` when a shard did not answer,
   and \`SearchUnavailable\` below a majority.
4. \`record_search(...)\`: one **Kafka** \`search.event\` per search, keyed by tenant, carrying a
   query digest instead of the query, from an idempotent producer; a lost event is counted.
5. \`GET /v1/products/{id}\`: the tenant's current public document, \`private\` cache headers and an
   \`ETag\` of its price version.

\`normalize_query\` and \`digest\` (FNV-1a) come with the catalog module; steps 2 and 4 share them.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Ranking and relevance tuning, analyzers, index builds, facets, autocomplete, and the consumer that
turns \`search.event\` into dashboards. The five pieces above decide whether search is bounded,
isolated, fresh and honest about what it did not find.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Storefront', sub: 'search · product page', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'searchd', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'cache', kind: 'redis', label: 'Query cache', sub: 'search:{tenant}:{version}:… · 60 s', x: 52, y: 12},
      {id: 'catalog', kind: 'db', label: 'Catalog index', sub: 'catalog:{tenant}:product:{id}', x: 52, y: 38},
      {id: 'shards', kind: 'grpc', label: 'Index shards ×3', sub: 'Shard.Search · 350 ms', x: 52, y: 64},
      {id: 'kafka', kind: 'kafka', label: 'search.event', sub: 'key = tenant', x: 52, y: 88},
      {id: 'analytics', kind: 'service', label: 'Search analytics', sub: 'zero-result rate', x: 76, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'cache', kind: 'redis', label: 'GET · SET EX 60'},
      {from: 'api', to: 'catalog', kind: 'redis', label: 'run_query · get_product'},
      {from: 'api', to: 'shards', kind: 'grpc', label: 'Search ×3'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce, acks=all'},
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
