import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Product catalog: the course is not "CRUD a product", it is the debugging you owe a publishing
 * path before a shopper sees it. A draft version distinct from the published one → one atomic
 * Redis pointer swap → media and pricing validated under a deadline before anything is published →
 * product-keyed catalog events emitted after the snapshot commits → a storefront read that serves
 * the published version with cache headers naming it.
 */
export const productCatalogProblem: Problem = {
  id: 'product-catalog',
  title: 'Product Catalog',
  tagline: 'Draft versions, a Redis pointer swap, gRPC validation, product-keyed events and CDN headers.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Product Catalog

A product catalog is the piece of a commerce platform that decides what a shopper can see. Every
part of it exists to answer one question: what is the *published* product, right now? A draft that
is half applied, a price from one version next to a title from another, or a product that went live
without its main image are the same bug in different clothes: a publish that was not atomic.

## The real system

Saleor, the open-source commerce platform, keeps a product's publication state per channel in a
\`ProductChannelListing\` with \`isPublished\`, \`publishedAt\` and \`visibleInListings\`, so the
same product can be live in one storefront and hidden in another. Behind it sits the shape this
course builds: a draft that is edited, a published version that is not, one atomic switch between
them, validation before the switch, an event after it, and a storefront read whose cache headers
name the version.

## What you build here

One service, **catalogd**, with five pieces that share one versions store (\`catalog.store\`,
provided) and one published pointer (\`publish_snapshot\` / \`read_published\`, built in step 2 and
provided to the later steps as \`catalog.snapshot\`):

1. \`POST /v1/products\`, \`PATCH /v1/products/{id}\`, \`POST /v1/products/{id}/publish\`: every edit
   writes a draft version, a publish with a required field unset is 422 naming it, and an
   \`Idempotency-Key\` keeps a retried publish from minting a second version.
2. A **Redis** published pointer: the whole version under its own key, one pointer per product,
   moved by a Lua compare-and-set; a read resolves the pointer once.
3. **gRPC** validation before the swap: every rendition under a 5-second deadline, and a pricing
   status that tells a rejection (terminal for this draft) from a deadline (retryable).
4. A **Kafka** \`catalog.event\` stream keyed by product id, carrying version ids and changed field
   names, produced after the snapshot committed by an idempotent producer with \`acks=all\`.
5. \`GET /v1/products/{id}\`: the published version with \`Cache-Control: public, max-age=30\`, an
   \`ETag\` of the version and \`X-Catalog-Version\`; the draft only through \`?scope=draft\`, private.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Search and faceting, taxonomy and categories, per-market pricing rules, inventory and availability,
asset upload pipelines, localization, merchandising approvals, and CDN purge APIs. The five pieces
above are the ones that decide whether a storefront ever shows a product that was only half
published.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Storefront · Admin', sub: 'read · publish', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'catalogd', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'versions store', sub: 'draft · published rows', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'catalog:{id}:published → v{n}', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'catalog.event', sub: 'key = product id', x: 44, y: 86},
      {id: 'media', kind: 'grpc', label: 'Media service', sub: 'ValidateRendition · 5 s', x: 66, y: 12},
      {id: 'pricing', kind: 'grpc', label: 'Pricing service', sub: 'ValidatePricing · 5 s', x: 66, y: 38},
      {id: 'consumer', kind: 'service', label: 'Storefront sync', sub: 'group catalog-sync', x: 66, y: 62},
      {id: 'cdn', kind: 'external', label: 'CDN', sub: 'public, max-age=30 · ETag "v"', x: 66, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'client', to: 'cdn', kind: 'http', label: 'cache hit'},
      {from: 'api', to: 'db', kind: 'plain', label: 'write_draft · promote'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'publish_snapshot · read_published'},
      {from: 'api', to: 'media', kind: 'grpc', label: 'ValidateRendition'},
      {from: 'api', to: 'pricing', kind: 'grpc', label: 'ValidatePricing'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after the swap'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'cdn', kind: 'plain', label: 'purge · warm'},
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
