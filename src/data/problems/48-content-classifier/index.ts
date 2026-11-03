import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Content classifier: the course is not "call a model and return its labels", it
 * is the debugging you owe a classifier before downstream routing trusts it. Labels
 * bound to a tenant's taxonomy version → a tenant-scoped Redis cache with windowed counters → a
 * gRPC model call with a deadline, a terminal refusal and a rules fallback that never invents
 * evidence → tenant-keyed events carrying a digest instead of the document → immutable versioned
 * taxonomy reads that keep old classifications explainable.
 */
export const contentClassifierProblem: Problem = {
  id: 'content-classifier',
  title: 'Content Classifier',
  tagline: 'Labels bound to a versioned taxonomy, with a keyword fallback that carries its provenance.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Content Classifier

A content classifier turns a document into labels other systems act on: routing, moderation queues,
billing categories, retrieval filters. The visible part is a list of label strings; the parts that
decide whether the platform is safe are the binding between those strings and a tenant's taxonomy,
the cache around it, the failure policy of the model call, the event that reports what happened,
and the version record that makes yesterday's decision explainable today.

## The real system

Google's Cloud Natural Language API exposes \`documents:classifyText\`, which returns categories from
a fixed taxonomy with a confidence per category, and the caller pins that taxonomy with
\`classificationModelOptions.v2Model.contentCategoriesVersion\` (\`V1\` or \`V2\`): the label set is
versioned, and a response only means something against the version that produced it. A platform
that routes on labels needs the same discipline one level down, because a language model asked for
a category that does not exist will invent a plausible one.

## What you build here

One service, **classifierd**, with five pieces:

1. \`POST /v1/classify\`: authenticated tenant, \`Content-Type: text/*\` only, text capped at 64 KiB
   and rejected when empty after normalization, labels bound to the tenant's taxonomy version
   (invented labels route to review), a taxonomy the tenant does not own answering \`404\`.
2. A **Redis** layer: taxonomy definitions cached per \`(tenant, taxonomy_id, version)\` for ten
   minutes as a full replacement, and per-tenant counters in hourly keys that expire with their
   window.
3. A **gRPC** model client: a 700 ms deadline, at most three attempts, a terminal refusal, a
   deterministic keyword fallback with provenance, and a fallback counter so an outage is visible.
4. A **Kafka** path: one \`classify.result\` event per classification keyed by tenant, carrying the
   request id, taxonomy version, labels, provenance and a text hash in place of the text, with an
   idempotent producer and a consumer that updates counters before it commits.
5. \`GET /v1/taxonomies/{id}\`: an immutable version with its changelog, scoped to the tenant, and a
   classification record that names the exact version it used.

## The debugging habit

Every starter in this course compiles, serves the happy path, and looks right. In each step you
debug it against the failure modes, fix it, optimize what is wasteful, and prove the fix with checks
that fail on the starter and pass on your version.

## Left out on purpose

Taxonomy authoring UIs, confidence calibration, per-label precision reporting, active learning,
zero-shot fallback, regional model routing, and billing.`,
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
