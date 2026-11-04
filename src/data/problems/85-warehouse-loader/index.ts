import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Warehouse loader: the course is not "write rows into a warehouse", it is the debugging you owe a
 * loader before it claims a table is loaded. A manifest keyed by tenant and Idempotency-Key → a Redis
 * partition set whose completion one Lua script hands to exactly one commit → merge-keyed gRPC
 * writes under a deadline → table-keyed load events with an outbox → a report whose counts
 * reconcile against the warehouse.
 */
export const warehouseLoaderProblem: Problem = {
  id: 'warehouse-loader',
  title: 'Warehouse Loader',
  tagline:
    'Manifests, a Redis partition set, merge-keyed gRPC writes, table-keyed load events and a reconciled report.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Warehouse Loader

A warehouse loader turns one version of a source dataset into rows of a tenant's table, and a
finance team reads its report before closing the books. Every part of it answers one question: did
this manifest land once, completely, in the right table?

## The real system

Snowflake's \`COPY INTO <table>\` keeps load metadata for every staged file it loads: the file name,
ETag, rows parsed and any errors. A later \`COPY\` of the same file is skipped unless \`FORCE = TRUE\`,
so a retried load does not duplicate rows; the metadata expires after 64 days. Loaders built on the
same idea treat a manifest as the unit of work and key every write by it.

## What you build here

One service, **loaderd**, on one loads store (\`loader.store\`, provided: \`load:{id}\` hashes,
\`loadkey:{tenant}:{key}\`, \`load:{id}:rejects\`, \`freshness:{name}\`), one progress module
(\`commit_partition\` and \`is_complete\`, built in step 2 and provided to later steps as
\`loader.progress\`) and one gRPC \`Warehouse\` (\`WritePartition\`, \`CountRows\`):

1. \`POST /v1/loads\`: a manifest \`{source, target, mode, transform}\` for the tenant in
   \`X-Tenant-Id\`, a transform from \`TRANSFORMS\`, a target in \`wh_{tenant}\`, and an
   \`Idempotency-Key\` tied to the manifest's fingerprint.
2. A **Redis** partition set \`load:{id}:partitions\` and flag \`load:{id}:complete\`: one Lua script
   decides the completion, and both keys expire after 7 days.
3. **gRPC** partition writes: a 30-second deadline, \`merge_key\` \`{load_id}/{partition_id}\` so a
   retry replaces itself, and retries only for \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`.
4. A **Kafka** \`load.event\` stream keyed by target table: \`partition_committed\` with the rows
   written, \`load_completed\` from the commit that completed the load, an outbox (\`loader.outbox\`)
   for refused events, an idempotent producer.
5. \`GET /v1/loads/{id}\`: rows read, rows written as the warehouse counts them, rejected rows with
   reasons, the table's freshness, and a flagged delta.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

File formats and writers (Parquet, ORC), schema evolution, compaction and clustering, backfills,
orchestration and scheduling, catalog internals, and row-level security. The five pieces above
decide whether a load lands once, completely, in the right table, and whether its report can be
trusted.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Loader client', sub: 'manifest · report', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'Load API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'loads store', sub: 'load:{id} · loadkey · rejects', x: 48, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'partitions · complete', x: 48, y: 50},
      {id: 'warehouse', kind: 'grpc', label: 'Warehouse', sub: 'WritePartition · CountRows', x: 72, y: 12},
      {id: 'kafka', kind: 'kafka', label: 'load.event', sub: 'key = target table', x: 72, y: 58},
      {id: 'outbox', kind: 'service', label: 'Outbox relay', sub: 'republish on recovery', x: 90, y: 34},
      {id: 'reader', kind: 'service', label: 'Downstream reader', sub: 'dashboards · finance', x: 90, y: 78},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'create_load · find_key'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVAL commit'},
      {from: 'api', to: 'warehouse', kind: 'grpc', label: 'WritePartition · CountRows'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce load.event'},
      {from: 'api', to: 'outbox', kind: 'plain', label: 'on broker reject'},
      {from: 'outbox', to: 'kafka', kind: 'kafka', label: 'republish'},
      {from: 'reader', to: 'api', kind: 'http', label: 'GET /v1/loads/{id}'},
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
