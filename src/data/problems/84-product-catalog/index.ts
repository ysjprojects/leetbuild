import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Product catalog on the AI-era track: the course is not "CRUD a product", it is the review you owe
 * a model-generated publishing path before a shopper sees it. A draft version distinct from the
 * published one → one atomic Redis pointer swap → media and pricing validated under a deadline
 * before anything is published → product-keyed catalog events emitted after the snapshot commits →
 * a storefront read that serves the published version with cache headers naming it.
 */
export const productCatalogProblem: Problem = {
  id: 'product-catalog',
  title: 'Product Catalog',
  tagline: 'Published products that are versioned, atomically swapped and never half-visible.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Product Catalog

A product catalog is the piece of a commerce platform that decides what a shopper can see. Every
part of it exists to answer one question: what is the *published* product, right now, for this
channel? A draft that is half applied, a price from one version next to a title from another, or a
product that went live without its main image are all the same bug wearing different clothes — a
publish that was not atomic.

## The real system

Production catalogs separate the draft from the published version, because merchandising edits
continuously while storefronts must never read a half-written row. An update creates or moves a
draft; publishing promotes that draft to an immutable published version, guarded by an
\`Idempotency-Key\` so a client retry cannot mint a second version. Required fields are validated
before the publish, and the rejection names the field that is missing. Publishing is a pointer
swap: the snapshot for the new version is written first, and readers resolve exactly one pointer per
request, so no reader ever assembles a product out of two versions. Media renditions and the
pricing table are validated over gRPC with a deadline, and any failure holds the whole version
back rather than publishing a page with holes in it. Every publish, hold and rollback emits a
\`catalog.event\` keyed by product id — ordered per product, carrying version ids and the names of
the fields that changed, never the field values from a draft — and the snapshot commits before the
event is acknowledged. The storefront read serves the published version with cache headers that
name it, so a CDN can never serve a version the catalog has already replaced, and a rollback
becomes visible within the max-age.

## What you build here

One service, **catalogd**, with five pieces:

1. \`POST /v1/products\`: an update always creates a draft version, publishing moves it forward with
   an \`Idempotency-Key\`, a publish with a missing required field is \`422\` naming it, and the
   published version is immutable once it is live.
2. A **Redis** published pointer: the published snapshot is a single object whose pointer is swapped
   by one atomic write, readers resolve one pointer per request, and a failed publish leaves the
   previous pointer untouched.
3. A **gRPC** validation step: renditions and the pricing table are validated with a 5-second
   deadline, a missing rendition blocks the publish, and a rejection is terminal until the draft
   changes.
4. A **Kafka** \`catalog.event\` stream: publish, hold and rollback events keyed by product id, with
   version ids and the names of the changed fields, and the snapshot commit before the ack.
5. \`GET /v1/products/{id}\`: the published version for the caller's channel with cache headers that
   carry the version, and drafts only through a separate preview scope.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Search and faceting, taxonomy and categories, per-market pricing rules, inventory and availability,
asset upload pipelines, localization, merchandising workflows and approvals, and CDN purge APIs. The
five pieces above are the ones that decide whether a storefront ever shows a product that was only
half published.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Storefront · Admin', sub: 'read · publish', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Catalog API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'products · versions', sub: 'draft · published', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'published pointer', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'catalog.event', sub: 'key = product', x: 44, y: 86},
      {id: 'media', kind: 'grpc', label: 'Media service', sub: 'renditions', x: 66, y: 12},
      {id: 'pricing', kind: 'grpc', label: 'Pricing service', sub: 'tax · price table', x: 66, y: 38},
      {id: 'consumer', kind: 'service', label: 'Storefront sync', sub: 'group catalog-sync', x: 66, y: 62},
      {id: 'cdn', kind: 'external', label: 'CDN', sub: 'max-age per version', x: 66, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'client', to: 'cdn', kind: 'http', label: 'cache hit'},
      {from: 'api', to: 'db', kind: 'plain', label: 'draft · versions'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'swap pointer'},
      {from: 'api', to: 'media', kind: 'grpc', label: 'ValidateRenditions'},
      {from: 'api', to: 'pricing', kind: 'grpc', label: 'ValidatePricing'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce catalog.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'cdn', kind: 'plain', label: 'purge · warm'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
