import {DOORDASH} from '@/data/companies';
import type {Problem} from '@/lib/types';

import {skuIntakeStep} from './steps/1-sku-intake';
import {extractAttributesStep} from './steps/2-extract-attributes';
import {extractionCacheStep} from './steps/3-extraction-cache';
import {reviewEndpointStep} from './steps/4-review-endpoint';
import {publishEnrichedStep} from './steps/5-publish-enriched';

/**
 * DoorDash's LLM-built product knowledge graph, cut down to the service that enriches one SKU on
 * the AI-era track: merchant upserts consumed and content-hashed before the offset commit → an
 * extraction call that retrieves candidate brands from the taxonomy before the model, asks for a
 * schema, validates the answer against the taxonomy and sends low-confidence SKUs to review → a
 * Redis layer with a cache keyed by taxonomy version and content hash, an atomic per-merchant daily
 * budget and review-claim leases → a review endpoint whose corrections become versioned labels →
 * `sku.enriched` events through an idempotent producer and an outbox, applied to the catalog and the
 * search index before the commit, with human attributes never overwritten by the model.
 */
export const catalogEnrichmentProblem: Problem = {
  id: 'catalog-enrichment',
  title: 'Catalog Enrichment',
  tagline:
    "DoorDash's product knowledge graph: extract SKU attributes with a model constrained by the taxonomy, gate on confidence, route to human review, and feed the corrections back — reviewed like production.",
  difficulty: 'hard',
  concepts: ['kafka', 'grpc', 'redis', 'http'],
  track: 'ai',
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
        'The labelling loop: a few human "golden" annotations, many model-generated "silver" ones produced with retrieval, and a fine-tuned generalised extraction model trained on both — which is why every reviewer decision in this course is stored as a versioned labelled example rather than a one-off catalog edit.',
    },
  ],
  statement: `# Catalog Enrichment

A grocery merchant onboards with forty thousand SKUs. Half of the titles look like
"DOVE SLK GLW BW 500ML", a third have no brand field, and the organic ones are organic only if you
read the packaging. Shoppers will search for "organic oat milk 1 l" tomorrow. The enrichment
service is what turns that feed into attributes a search index, a ranker and a substitution model
can use — and it is the service where a model that confidently invents a brand does real damage.

## The real system

DoorDash's **retail catalog** is a centralised dataset for every product sold by its non-restaurant
merchants: each SKU is a list of attributes — brand, size, unit of measure, dietary tags, category.
Raw merchant data arrives in every format and quality, so the catalog team standardises and enriches
it. Historically that was manual work by contract operators, slow and expensive enough that a second
person had to audit the first. The replacement is a pipeline of LLM-powered extractors: a brand
pipeline that passes SKUs the in-house classifier cannot tag confidently to a model and then checks
the extracted brand against similar brands retrieved from the knowledge graph; an organic tagger
that goes from exact string matching to model reasoning over titles and packaging text; and a
generalised attribute extractor bootstrapped from a small set of human "golden" annotations,
expanded with retrieval-augmented model annotations and fine-tuned from both. The attributes feed
personalised ranking, search retrieval and substitutions — so a wrong attribute surfaces as a wrong
item in a cart.

## From the source

*Building DoorDash's product knowledge graph with large language models* describes the catalog,
the attribute-extraction problem as token classification ("Dove Silk Glow Body Wash 500 ml" →
brand, size, unit), and the cold-start problem that LLMs solved. It gives this course its three
mechanisms: **retrieval before the model** (the brand pipeline retrieves similar brands and example
item names from the knowledge graph, and the generalised extractor retrieves the nearest golden
annotations by embedding similarity because relevant examples reduce hallucination), **confidence
as a routing signal** (only SKUs the classifier cannot tag confidently go to the model, and new
brands enter the taxonomy through a duplicate check rather than directly), and **labels as the
product** (model annotations that would have taken months to collect by hand were generated in a
week and used to fine-tune the next model). *How DoorDash leverages LLMs for better search
retrieval* adds the shape of the model call: ask for structured output mapped onto taxonomy
categories, hand the model a curated candidate list retrieved by approximate nearest neighbour
(100 taxonomy concepts per query in that post) so it can only choose concepts that exist, post-process
anything outside the controlled vocabulary, and audit every batch by hand. *Unleashing the power of
large language models at DoorDash* confirms the golden → silver → fine-tune loop. The numbers in
this course that are not in the posts — 20 candidate brands per SKU, the 0.85 confidence threshold,
the 5-second deadline, the 50 000-per-merchant daily budget, the 15-minute review lease — are
operating choices made here, in the spirit of the posts.

## What you build here

One service, **catalogd**, with five pieces:

1. A **Kafka** intake: consume \`sku.upserted\` (key = merchant) in group \`catalog-enrichment\`,
   validate each record (title ≤ 4 KiB, description ≤ 16 KiB, at most 8 image refs, malformed
   records to \`sku.upserted.dlq\`), skip SKUs whose content hash has not changed, enqueue an
   extraction job on \`sku.extract\` keyed by merchant, and commit the offset only after the enqueue.
2. A **gRPC** extraction call: retrieve the 20 nearest brand names from the taxonomy *before* the
   model, ask \`Extractor.Extract\` for structured output against a schema under a 5-second
   deadline with one retry on \`UNAVAILABLE\`, validate brand, unit and category against the
   taxonomy, and send anything unresolved or below confidence 0.85 to the review queue.
3. A **Redis** layer: an extraction cache keyed by \`extract:{taxonomy_version}:{content_hash}\`
   with a 7-day TTL, a per-merchant daily budget of 50 000 extractions reserved by one atomic Lua
   \`EVAL\` before the model call, and review-claim leases taken with \`SET NX EX 900\`.
4. \`POST /v1/skus/{sku_id}/review\`: a reviewer accepts or corrects the proposed attributes;
   **403** unless the caller holds a reviewer role, **409** unless the caller holds the SKU's lease,
   \`Idempotency-Key\` required, and every decision stored as a versioned labelled example for the
   next model.
5. A **Kafka** publish path: one \`sku.enriched\` event per attribute version (source \`model\` or
   \`human\`) through an idempotent producer with \`acks=all\` and an outbox on failure; a consumer
   in group \`catalog-index\` that updates the catalog and the search index before it commits, and
   never lets a model result overwrite a human correction.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident — exactly like the model it calls. Your job in every step is the job
you will have on a real AI feature: read the draft against the failure modes, name the subtle one,
fix it, and prove the fix with checks that fail on the draft and pass on your version.

## Left out on purpose

The embedding model and the ANN index behind the taxonomy, the fine-tuning job that consumes the
labels, image OCR and multimodal extraction, entity resolution across merchants, the duplicate-brand
check that admits new brands to the taxonomy, and the ranking and substitution models downstream.
The five pieces above are the ones that decide whether a model-enriched catalog can be trusted by
the systems that read it.`,
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
