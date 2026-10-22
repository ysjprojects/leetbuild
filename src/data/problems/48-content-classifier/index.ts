import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Content classifier on the AI-era track: the course is not "call a model and return its labels", it
 * is the review you owe a model-generated classifier before downstream routing trusts it. Labels
 * bound to a tenant's taxonomy version → a tenant-scoped Redis cache with windowed counters → a
 * gRPC model call with a deadline, a terminal refusal and a rules fallback that never invents
 * evidence → tenant-keyed events carrying a digest instead of the document → immutable versioned
 * taxonomy reads that keep old classifications explainable.
 */
export const contentClassifierProblem: Problem = {
  id: 'content-classifier',
  title: 'Content Classifier',
  tagline: 'Taxonomy-bound classification with calibrated fallbacks and per-tenant metrics.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Content Classifier

A content classifier is the piece of an AI platform that turns a document into labels other systems
act on: routing, moderation queues, billing categories, retrieval filters. The visible part is a
list of label strings in a response; the parts that decide whether the platform is safe are the
binding between those strings and a tenant's taxonomy, the cache and counters around it, the failure
policy of the model call, the event that reports what happened, and the version record that makes
yesterday's decision explainable today.

## The real system

Production classifiers never return whatever the model produced. A model is a language model: asked
for a category that does not exist it will happily invent a plausible one, and a downstream router
that trusts the string will silently drop the document into a category nobody defined. So the labels
are bound to a versioned taxonomy the tenant owns, the model's output is intersected with it, and
anything invented goes to a review bucket with the unknowns recorded. Taxonomies are read through a
tenant-scoped cache with a TTL, because they are tenant data and they change; counters live in
windowed keys so a per-tenant view exists without an unbounded keyspace. The model call has a
deadline, retries only what is retryable, treats a refusal as an answer, and falls back to something
deterministic that carries its provenance and is counted separately. Each classification publishes
one event keyed by tenant, carrying a hash of the text rather than the text itself. And every result
names the taxonomy version it used, because immutability is the only thing that keeps an audit trail
honest.

## What you build here

One service, **classifierd**, with five pieces:

1. \`POST /v1/classify\`: authenticated tenant, \`Content-Type: text/*\` only, text capped at 64 KiB
   and rejected when empty after normalization, labels bound to the tenant's taxonomy version
   (invented labels route to review) and a taxonomy the tenant does not own answering \`404\`.
2. A **Redis** layer: taxonomy definitions cached per \`(tenant, taxonomy_id, version)\` for ten
   minutes, written as a full replacement rather than a field patch, and per-tenant counters in
   hourly keys that expire with their window.
3. A **gRPC** model client: a 700 ms deadline, at most three attempts, a terminal refusal, a
   deterministic keyword fallback with provenance, and a fallback counter so an outage is visible.
4. A **Kafka** path: one \`classify.result\` event per classification keyed by tenant, carrying the
   request id, taxonomy version, labels, provenance and a text hash — never the text — with an
   idempotent producer and a consumer that updates counters before it commits.
5. \`GET /v1/taxonomies/{id}\`: an immutable version with its changelog, scoped to the tenant, and a
   classification record that names the exact version it used.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Taxonomy authoring UIs, label suggestion from human review, multi-label confidence calibration,
per-label precision/recall reporting, active learning loops, embedding-based zero-shot fallback,
regional model routing, and billing for classification volume. The five pieces above are the ones
that decide whether the classifier is correct, isolated and explainable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'classify · taxonomies', x: 8, y: 50},
      {id: 'classifier', kind: 'http', label: 'Content Classifier', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'taxonomy', kind: 'db', label: 'taxonomy store', sub: 'versions · changelog', x: 44, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'taxonomy cache · counters', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'classify.result', sub: 'key = tenant', x: 44, y: 88},
      {id: 'model', kind: 'grpc', label: 'Model', sub: 'Classify', x: 66, y: 10},
      {id: 'rules', kind: 'external', label: 'Rules fallback', sub: 'keywords · deterministic', x: 66, y: 40},
      {id: 'consumer', kind: 'service', label: 'Metrics consumer', sub: 'group classifier-metrics', x: 66, y: 80},
    ],
    edges: [
      {from: 'client', to: 'classifier', kind: 'http', label: 'HTTPS'},
      {from: 'classifier', to: 'taxonomy', kind: 'plain', label: 'versions · changelog'},
      {from: 'classifier', to: 'redis', kind: 'redis', label: 'cache · counters'},
      {from: 'classifier', to: 'model', kind: 'grpc', label: 'Classify'},
      {from: 'classifier', to: 'rules', kind: 'plain', label: 'on failure'},
      {from: 'classifier', to: 'kafka', kind: 'kafka', label: 'produce classify.result'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY counters'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
