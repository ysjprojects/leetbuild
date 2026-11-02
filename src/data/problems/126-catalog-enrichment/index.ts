import {DOORDASH} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {skuIntakeStep} from './steps/1-sku-intake';
import {extractAttributesStep} from './steps/2-extract-attributes';
import {extractionCacheStep} from './steps/3-extraction-cache';
import {reviewEndpointStep} from './steps/4-review-endpoint';
import {publishEnrichedStep} from './steps/5-publish-enriched';

/**
 * DoorDash's LLM-built product knowledge graph, cut down to the service that enriches one SKU:
 * merchant upserts consumed and content-hashed before the offset commit → an extraction call that
 * retrieves candidate brands from the taxonomy before the model, asks for a schema, validates the
 * answer against the taxonomy and sends low-confidence SKUs to review → a Redis layer with a cache
 * keyed by taxonomy version and content hash, an atomic per-merchant daily budget and review-claim
 * leases → a review endpoint whose corrections become versioned labels → `sku.enriched` events
 * through an idempotent producer and an outbox, applied to the catalog and the search index before
 * the commit, with human attributes never overwritten by the model.
 */
export const catalogEnrichmentProblem: Problem = {
  id: 'catalog-enrichment',
  title: 'Catalog Enrichment',
  tagline:
    "DoorDash's product knowledge graph: extract SKU attributes with a model constrained by the taxonomy, gate on confidence, route to human review, and feed the corrections back.",
  difficulty: 'hard',
  concepts: ['kafka', 'grpc', 'redis', 'http'],
  tag: 'ai-systems',
  minutes: 75,
  company: DOORDASH,
  sources: [
    {
      title: "Building DoorDash's product knowledge graph with large language models",
      url: 'https://careersatdoordash.com/blog/building-doordashs-product-knowledge-graph-with-large-language-models/',
      by: 'Steven Xu, Sree Chaitanya Vadrevu',
      date: '2024-04-23',
      takes:
        'The system itself: a retail catalog where every SKU is a list of attributes extracted from raw merchant data of uneven quality; a brand taxonomy that is never complete, so brand extraction retrieves similar brands from the knowledge graph before deciding; organic tagging as a waterfall from string matching to model reasoning; generalised attribute extraction that retrieves the nearest golden annotations as in-context examples to cut hallucination; LLM-generated labels that train the next model; and the downstream consumers — ranking, search and substitutions — that make attribute quality matter.',
    },
    {
      title: 'How DoorDash leverages LLMs for better search retrieval',
      url: 'https://careersatdoordash.com/blog/how-doordash-leverages-llms-for-better-search-retrieval/',
      by: 'Eduardo Martinez',
      date: '2024-11-19',
      takes:
        'The constraint pattern this course builds the extraction call around: structured output mapped onto taxonomy categories instead of free text, a curated list of candidate labels retrieved by approximate nearest neighbour so the model can only pick concepts that exist in the knowledge graph, post-processing that rejects anything outside the controlled vocabulary, and manual audits of every processed batch.',
    },
    {
      title: 'Unleashing the power of large language models at DoorDash for a seamless shopping adventure',
      url: 'https://careersatdoordash.com/blog/unleashing-the-power-of-large-language-models-at-doordash-for-a-seamless-shopping-adventure/',
      by: 'Sudeep Das',
      date: '2024-10-29',
      takes:
        'The labelling loop: a few human "golden" annotations, many "silver" ones produced with retrieval, and a fine-tuned generalised extraction model trained on both — which is why every reviewer decision in this course is stored as a versioned labelled example rather than a one-off catalog edit.',
    },
  ],
  statement: `# Catalog Enrichment

A grocery merchant onboards with forty thousand SKUs. Half of the titles look like
"DOVE SLK GLW BW 500ML" and a third have no brand field. Shoppers will search for "organic oat
milk 1 l" tomorrow. The enrichment service turns that feed into attributes a search index, a ranker
and a substitution model can use, and it is where a model that invents a brand does real damage.

## The real system

DoorDash's **retail catalog** holds every product sold by its non-restaurant merchants as a list of
attributes: brand, size, unit of measure, dietary tags, category. Contract operators used to enrich
it by hand; now LLM extractors do. The brand pipeline sends SKUs the in-house classifier cannot tag
confidently to a model, then checks the extracted brand against similar brands retrieved from the
knowledge graph before admitting it; the generalised extractor starts from human "golden"
annotations and is fine-tuned on model annotations. The attributes feed ranking, search and
substitutions, so a wrong attribute is a wrong item in a cart.

## From the source

The knowledge-graph post gives this course its three mechanisms: **retrieval before the model**,
**confidence as a routing signal** and **labels as the product**. The search post adds the shape
of the call: structured output against a curated candidate list. The numbers here (20 candidate
brands, the 0.85 threshold, the 5-second deadline, the daily budget, the 15-minute lease) are
operating choices made for this course.

## What you build here

One service, **catalogd**, with five pieces:

1. A **Kafka** intake: consume \`sku.upserted\` in group \`catalog-enrichment\`, validate,
   dead-letter, skip unchanged content hashes, enqueue on \`sku.extract\` keyed by merchant, commit
   after the enqueue.
2. A **gRPC** extraction call: 20 candidate brands before the model, a schema, a 5-second deadline
   with one retry on \`UNAVAILABLE\`, validation against the taxonomy, review below confidence 0.85.
3. A **Redis** layer: a cache keyed by taxonomy version and content hash, an atomic daily budget per
   merchant, review leases with \`SET NX EX 900\`.
4. \`POST /v1/skus/{sku_id}/review\`: role, lease and \`Idempotency-Key\` enforced, every decision
   stored as a versioned label.
5. A **Kafka** publish path: \`sku.enriched\` through an idempotent producer with an outbox, applied
   to the catalog and the search index before the commit, human attributes kept over model ones.

## The debugging habit

Every starter compiles and serves the happy path. In each step you debug it against the failure
modes, fix it, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

The embedding model and ANN index behind the taxonomy, the fine-tuning job, image OCR, entity
resolution across merchants, the duplicate-brand check, and the ranking and substitution models.`,
  diagram: {
    nodes: [
      {id: 'feed', kind: 'client', label: 'Merchant feed', sub: 'SKU upserts', x: 6, y: 30},
      {id: 'reviewer', kind: 'client', label: 'Reviewer', sub: 'POST …/review', x: 6, y: 70},
      {id: 'upserted', kind: 'kafka', label: 'sku.upserted', sub: 'key = merchant', x: 24, y: 30},
      {id: 'catalogd', kind: 'http', label: 'catalogd', sub: 'HTTPS :8443', x: 42, y: 50},
      {id: 'taxonomy', kind: 'db', label: 'taxonomy · labels', sub: 'brands · outbox', x: 60, y: 10},
      {id: 'llm', kind: 'grpc', label: 'Extractor', sub: 'Extract · :50051', x: 60, y: 36},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'cache · budget · leases', x: 60, y: 62},
      {id: 'enriched', kind: 'kafka', label: 'sku.enriched', sub: 'key = merchant', x: 60, y: 88},
      {id: 'indexer', kind: 'service', label: 'Index consumer', sub: 'group catalog-index', x: 78, y: 88},
      {id: 'search', kind: 'db', label: 'catalog · search index', sub: 'attributes by version', x: 94, y: 88},
    ],
    edges: [
      {from: 'feed', to: 'upserted', kind: 'kafka', label: 'produce sku.upserted'},
      {from: 'upserted', to: 'catalogd', kind: 'kafka', label: 'consume · group catalog-enrichment'},
      {from: 'reviewer', to: 'catalogd', kind: 'http', label: 'HTTPS'},
      {from: 'catalogd', to: 'taxonomy', kind: 'plain', label: 'brands · labels · outbox'},
      {from: 'catalogd', to: 'llm', kind: 'grpc', label: 'Extract'},
      {from: 'catalogd', to: 'redis', kind: 'redis', label: 'EVAL · SET NX EX'},
      {from: 'catalogd', to: 'enriched', kind: 'kafka', label: 'produce sku.enriched'},
      {from: 'enriched', to: 'indexer', kind: 'kafka', label: 'consume'},
      {from: 'indexer', to: 'search', kind: 'plain', label: 'apply · upsert · then commit'},
    ],
  },
  steps: [skuIntakeStep, extractAttributesStep, extractionCacheStep, reviewEndpointStep, publishEnrichedStep],
};
