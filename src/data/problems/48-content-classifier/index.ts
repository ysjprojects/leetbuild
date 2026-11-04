import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

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
billing categories, retrieval filters. The visible part is a list of label strings; what decides
whether the platform is safe is the binding between those strings and a tenant's taxonomy, the cache
around it, the failure policy of the model call, the event that reports what happened, and the
version record that makes yesterday's decision explainable today.

## The real system

Google's Cloud Natural Language API classifies text with \`documents:classifyText\` into a fixed
category set, and the caller pins that set with
\`classificationModelOptions.v2Model.contentCategoriesVersion\`: \`V1\` is the legacy categories of
the 2017 launch, \`V2\` the categories updated in 2022. The label set is versioned, and an answer only
means something against the version that produced it. A platform that routes on labels needs the
same discipline one level down, because a language model asked for a category will sometimes invent
a plausible one.

## What you build here

One service, **classifierd**, on one contract: the \`classifier\` support package (\`config\` for the
model address, topic and keys; \`taxonomies\`, the store of immutable taxonomy versions per tenant;
\`outbox\`), one proto (\`content_classifier.proto\`, \`Model.Classify\`), and two step functions
provided to the other steps as built: \`inference.classify\` (step 3, used by step 1) and
\`counters.bump_counter\` (step 2, used by step 4's consumer).

1. \`POST /v1/classify\` with \`X-Tenant-Id\` and \`{taxonomy_id, taxonomy_version?, mime_type,
   text}\`: \`text/*\` only, trimmed text up to 64 KiB, the tenant's taxonomy version or \`404\`, and
   labels bound to that version (invented ones go to \`review\` and \`unknown_labels\`).
2. **Redis**: taxonomy versions cached under \`taxonomy:{tenant}:{taxonomy_id}:{version}\` for ten
   minutes as one \`SET\`, and label counters in \`counters:{tenant}:{hour}\` that expire with their hour.
3. **gRPC** \`Model.Classify\`: a 700 ms deadline, at most three attempts, a refusal that ends them, and
   a keyword fallback marked \`fallback\` and counted in \`metrics:classifier_fallback_total\`.
4. **Kafka** \`classify.result\`: one event per classification keyed by tenant, with a text hash in
   place of the text, from an idempotent producer with an outbox; a consumer in
   \`classifier-metrics\` that counts before it commits.
5. \`GET /v1/taxonomies/{taxonomy_id}\`: a tenant's version with its changelog; edits publish new
   versions, and \`classifications:{tenant}\` records name the version they used.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Taxonomy authoring UIs, confidence calibration, per-label precision reporting, active learning,
regional model routing, and billing.`,
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
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
