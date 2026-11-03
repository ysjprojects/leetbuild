import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Warehouse loader: the course is not "write rows into a warehouse", it is the debugging you owe a
 * loader before it claims a table is loaded. A manifest that is the unit of work → gap-less Redis
 * progress committed atomically with the completion flag → idempotent merges over gRPC under a
 * deadline → table-keyed load events with an outbox → a report whose counts reconcile against the
 * warehouse.
 */
export const warehouseLoaderProblem: Problem = {
  id: 'warehouse-loader',
  title: 'Warehouse Loader',
  tagline: 'Load a manifest into the warehouse once, commit partitions atomically, and report counts that reconcile.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Warehouse Loader

A warehouse loader turns a source dataset version into committed partitions of a tenant's table. A
finance team reads its report before closing the books.

## The real system

Snowflake's \`COPY INTO <table>\` keeps **load metadata** per table: for every staged file it records the
file name, ETag, row counts and any load errors, and a later \`COPY\` of the same file is skipped
unless \`FORCE = TRUE\` is set, so a retried load of an already-loaded file does not duplicate its rows.
That metadata expires after 64 days, which is why re-loading old files is a deliberate choice rather
than an accident.

Loaders built on the same idea treat a manifest as the unit of work: one manifest, one load, however
many times the client retries or the scheduler fires.

## What you build here

One service, **loaderd**, with five pieces:

1. \`POST /v1/loads\`: authenticated tenant, a validated manifest (source version, target table,
   mode \`append\`/\`merge\`/\`replace\`, a transform from the registry), an \`Idempotency-Key\`
   keyed by the manifest, and a target that must live in the tenant's own schema.
2. A **Redis** progress store: committed partitions in a set, the completion flag written by one
   atomic script together with the final partition, and a reader that never reports a partial load as
   done.
3. A **gRPC** warehouse client: a 30-second deadline per write, bounded retries only for the
   retryable statuses, and merge semantics keyed by \`(manifest id, partition id)\` so a retried
   partition replaces itself instead of duplicating rows.
4. A **Kafka** \`load.event\` stream: partition-committed and load-completed events keyed by target
   table, carrying manifest ids, partition ids and written row counts, with an outbox row on
   rejection and completion published only after the final partition commits.
5. \`GET /v1/loads/{id}\`: source rows read, rows written (from the warehouse, not the plan), rows
   rejected with reasons, and table-scoped freshness — with an unexplained read-write delta flagged
   instead of hidden.

## The debugging habit

Every starter compiles and loads the happy path. Debug it against the failure modes, fix it, and
prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

File formats and writers (Parquet, ORC), schema evolution and column type reconciliation, compaction
and clustering, historical backfills, cluster autoscaling, orchestration and scheduling, data catalog
internals, and row-level security policy authoring. The five pieces above are the ones that decide
whether a load is correct and isolated and whether its report can be trusted.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Loader client', sub: 'manifest · report', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'Load API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'loads · manifests', sub: 'tenant schemas', x: 48, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'partitions · complete', x: 48, y: 50},
      {id: 'warehouse', kind: 'grpc', label: 'Warehouse', sub: 'Merge / Replace', x: 72, y: 12},
      {id: 'kafka', kind: 'kafka', label: 'load.event', sub: 'key = target table', x: 72, y: 58},
      {id: 'outbox', kind: 'service', label: 'Outbox relay', sub: 'republish on recovery', x: 90, y: 34},
      {id: 'reader', kind: 'service', label: 'Downstream reader', sub: 'dashboards · finance', x: 90, y: 78},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'manifest · loads'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'SADD · SCARD'},
      {from: 'api', to: 'warehouse', kind: 'grpc', label: 'Merge / Replace'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce load.event'},
      {from: 'api', to: 'outbox', kind: 'plain', label: 'on broker reject'},
      {from: 'outbox', to: 'kafka', kind: 'kafka', label: 'republish'},
      {from: 'reader', to: 'api', kind: 'http', label: 'GET /v1/loads/{id}'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
