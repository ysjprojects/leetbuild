import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Deduplication: the course is not "call a similarity API", it is the debugging you owe a dedupe
 * layer before it merges a tenant's records. An exact-key check inside the caller's tenant → one
 * Lua claim per key in a per-tenant index → a fuzzy pass under a 200 ms deadline that says when it
 * did not run → dataset-keyed events carrying digests, with an outbox → a cluster read that links
 * members over strong pairs only and answers its evidence.
 */
export const dedupeServiceProblem: Problem = {
  id: 'dedupe-service',
  title: 'Deduplication',
  tagline: 'Per-tenant key indexes in Redis and duplicate clusters that show the evidence for every merge.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Deduplication

Deduplication decides whether a record a caller is about to create already exists and, when two
records might be one customer, whether to merge them. The visible part is a boolean in a response;
the rest is isolation between tenants, a race between two creates, and evidence for every merge.

## The real system

Zingg, the open source entity-resolution engine, puts a \`Z_MINSCORE\` on every cluster it emits:
the score of the weakest pair in the cluster. Its documentation tells you to gate automation on it,
auto-merging clusters whose weakest link is strong and sending the rest to a human review queue,
because A matching B and B matching C does not make A match C. Step 5 is that rule as a handler.

## What you build here

One service, **dedupd**, on one Redis and four provided modules in the \`dedupe\` package:
\`records\` (the durable record store: \`record:{id}\` with the tenant, dataset, contents and key
digests), \`exact\` (the per-tenant key index as step 2 builds it), \`outbox\` (the list a relay
publishes) and \`clusters\` (scored pairs and merge history).

1. \`POST /v1/dedupe/check\` with \`{"keys": [{"type", "value"}]}\`: the \`X-Tenant-Id\` tenant,
   key types and SHA-256 digests validated, every key looked up with \`exact.lookup\`; it answers
   \`{"duplicate", "match": {"record_id", "key_type"}}\`.
2. A **Redis** index \`t:{tenant}:exact:{key_type}\` (digest → record id): \`claim\` is one Lua script
   answering \`winner\` or \`existing\` with the holder, and \`rebuild\` restores it from \`records\`.
3. A **gRPC** fuzzy pass, \`Similarity.Resolve\` under a 200 ms deadline, one attempt, answering
   \`{"match", "exact_only"}\` with a 0.9 score floor.
4. A **Kafka** \`dedupe.event\` per claim, keyed by dataset id, carrying the outcome and the key
   digests, from an idempotent producer with \`acks=all\`; a failed delivery leaves an outbox row.
5. \`GET /v1/clusters/{id}\`: members linked by pairs scoring at least 0.85, the \`evidence\`, the
   weak pairs under \`review\` and the \`history\`; another tenant's cluster is **404**.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Key extraction and normalization per record type, the similarity model itself, merge conflict
resolution for field values, erasure propagation, per-tenant quotas and a review UI. The five
pieces above decide whether a check is isolated, a create is counted once, and a merge can be
explained.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'check · cluster read', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Dedupe API', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'exact key sets', x: 48, y: 22},
      {id: 'store', kind: 'db', label: 'record store', sub: 'records · evidence', x: 48, y: 62},
      {id: 'similarity', kind: 'grpc', label: 'Similarity service', sub: 'Resolve · 200 ms', x: 70, y: 22},
      {id: 'review', kind: 'external', label: 'Review queue', sub: 'weak pairs', x: 70, y: 62},
      {id: 'kafka', kind: 'kafka', label: 'dedupe.event', sub: 'key = dataset', x: 48, y: 88},
      {id: 'consumer', kind: 'service', label: 'Event consumer', sub: 'group dedupe', x: 70, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'insert-and-check'},
      {from: 'api', to: 'store', kind: 'plain', label: 'records · clusters'},
      {from: 'api', to: 'similarity', kind: 'grpc', label: 'Resolve'},
      {from: 'api', to: 'review', kind: 'plain', label: 'weak pair'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce dedupe.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'store', kind: 'plain', label: 'cluster updates'},
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
