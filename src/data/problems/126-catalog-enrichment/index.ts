import {DOORDASH} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {skuIntakeStep} from './steps/1-sku-intake';
import {extractAttributesStep} from './steps/2-extract-attributes';
import {extractionCacheStep} from './steps/3-extraction-cache';
import {reviewEndpointStep} from './steps/4-review-endpoint';
import {publishEnrichedStep} from './steps/5-publish-enriched';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * DoorDash's LLM-built product knowledge graph, cut down to the service that enriches one SKU. One
 * contract runs through the five steps: the provided `enrich` package (`enrich.taxonomy` for the
 * brands, units and schema; `enrich.store` for every Redis key the steps share) → a Kafka intake that
 * content-hashes merchant upserts into `sku.extract` jobs → a gRPC extraction constrained by the
 * taxonomy that parks doubtful results for review → a Redis layer (content cache, atomic merchant
 * budget, review leases) → a review endpoint whose decisions become labels and human events →
 * `sku.enriched`, published idempotently with an outbox and indexed so a model run cannot undo a
 * reviewer.
 */
export const catalogEnrichmentProblem: Problem = {
  id: 'catalog-enrichment',
  title: 'Catalog Enrichment',
  tagline:
    "DoorDash's product knowledge graph: SKU attributes from a model that may only pick taxonomy brands, and reviewer corrections kept as labels that later model runs cannot overwrite.",
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
"DOVE SLK GLW BW 500ML" and a third have no brand field. The enrichment service turns that feed into
attributes a search index, a ranker and a substitution model can use, and it is where a model that
invents a brand does real damage.

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
brands, the 0.85 threshold, the 5-second deadline, 50 000 extractions per merchant per day, the
15-minute lease) are operating choices made for this course.

## What you build here

One service, **catalogd**, on a provided package, \`enrich\`: \`enrich.taxonomy\` (\`VERSION\`,
\`nearest_brands\`, \`ALLOWED_UNITS\`, \`has_category\`, \`ATTRIBUTE_SCHEMA\`) and \`enrich.store\`, the
Redis keys every step shares (content hashes, proposals, leases, labels, catalog and search rows,
the outbox).

1. **Kafka** intake: \`sku.upserted\` (group \`catalog-enrichment\`) becomes jobs
   \`{sku_id, merchant, content_hash, title, description, images}\` on \`sku.extract\`, keyed by
   merchant; malformed records go to \`sku.upserted.dlq\`.
2. **gRPC** \`Extractor.Extract\` with candidate brands and a schema: \`extract_attributes(job)\`
   returns \`{sku_id, merchant, attributes, confidence, taxonomy_version, source, status}\` and parks
   doubtful results with \`store.enqueue_review\`.
3. **Redis** in front of it, \`enrich(job)\`: a cache at \`extract:{taxonomy_version}:{content_hash}\`,
   a merchant's \`budget:{merchant}:{day}\` reserved by one Lua script, and \`claim_review\` on
   \`review:lease:{sku_id}\`.
4. \`POST /v1/skus/{sku_id}/review\`: the lease holder's decision becomes \`label:{sku_id}:v{n}\` and
   an event with \`source: "human"\`.
5. **Kafka** \`sku.enriched\` (\`{sku_id, merchant, attributes, attributes_version, taxonomy_version,
   source}\`): \`publish\` with an outbox, and an indexer that writes \`catalog:{id}\` and
   \`search:{id}\` unless the event is stale or a model event over a human one.

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
      {id: 'extract', kind: 'kafka', label: 'sku.extract', sub: 'jobs · key = merchant', x: 24, y: 8},
      {id: 'catalogd', kind: 'http', label: 'catalogd', sub: 'HTTP · consumers', x: 42, y: 50},
      {id: 'taxonomy', kind: 'db', label: 'enrich.taxonomy', sub: 'brands · units · schema', x: 60, y: 10},
      {id: 'llm', kind: 'grpc', label: 'Extractor', sub: 'Extract · :50051', x: 60, y: 36},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'cache · budget · leases · labels', x: 60, y: 62},
      {id: 'enriched', kind: 'kafka', label: 'sku.enriched', sub: 'key = merchant', x: 60, y: 88},
      {id: 'indexer', kind: 'service', label: 'Indexer', sub: 'group catalog-index', x: 78, y: 88},
      {id: 'search', kind: 'db', label: 'catalog · search', sub: 'catalog:{id} · search:{id}', x: 94, y: 88},
    ],
    edges: [
      {from: 'feed', to: 'upserted', kind: 'kafka', label: 'produce sku.upserted'},
      {from: 'upserted', to: 'catalogd', kind: 'kafka', label: 'consume · group catalog-enrichment'},
      {from: 'catalogd', to: 'extract', kind: 'kafka', label: 'job · then commit'},
      {from: 'reviewer', to: 'catalogd', kind: 'http', label: 'decision · Idempotency-Key'},
      {from: 'catalogd', to: 'taxonomy', kind: 'plain', label: 'nearest_brands · has_category'},
      {from: 'catalogd', to: 'llm', kind: 'grpc', label: 'Extract · 5 s'},
      {from: 'catalogd', to: 'redis', kind: 'redis', label: 'EVALSHA · SET NX EX · labels'},
      {from: 'catalogd', to: 'enriched', kind: 'kafka', label: 'publish · outbox on refusal'},
      {from: 'enriched', to: 'indexer', kind: 'kafka', label: 'consume'},
      {from: 'indexer', to: 'search', kind: 'plain', label: 'apply · index · then commit'},
    ],
  },
  steps: [skuIntakeStep, extractAttributesStep, extractionCacheStep, reviewEndpointStep, publishEnrichedStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
