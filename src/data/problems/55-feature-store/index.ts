import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-client';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Feature store: the course is not "cache some numbers in Redis", it is the debugging you owe a
 * feature platform before a model is trained on what it serves. An immutable, reference-checked
 * definition → versioned online values with an as-of read → a backfill with bounded concurrency
 * and honest failures → per-feature lineage events published after the partition commits → a
 * stats read where null rate, a pinned baseline and staleness are all visible.
 */
export const featureStoreProblem: Problem = {
  id: 'feature-store',
  title: 'Feature Store',
  tagline: 'Versioned feature definitions, an as-of Redis read, and a backfill that reports what it could not scan.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Feature Store

A feature store makes training and serving read the same numbers: one definition per (name, version),
one computed value per entity, one lineage event, one stats read. What decides whether the platform is
trustworthy is the definition contract, the point-in-time read, the honesty of the backfill, the order
of the lineage log, and whether drift is visible.

## The real system

Feast, the open source feature store, models feature values as time-series records with an event
timestamp and builds training sets with point-in-time correct joins: for every entity row it picks the
newest value whose event timestamp is at or before that row's timestamp, and a feature view's \`ttl\`
bounds how far back it looks. That is the question this course's online store answers with an
\`as_of\`: training asks about the past, serving asks about now, and a store that can only answer
"latest" leaks information from after the cutoff into the model. Definitions are immutable and resolved
at registration, so a dangling computation reference fails at the registry. A backfill is a client of
a shared warehouse, so it bounds concurrency and reports a timed-out partition as missing. Lineage
events are keyed by feature name because Kafka orders within a partition.

## What you build here

One service, **featured**, with five pieces:

1. \`POST /v1/features/definitions\`: an immutable definition per (name, version), a \`dtype\`
   whitelist, a \`computation_ref\` that must resolve (**409**, **422**), and a required \`freshness_slo\`.
2. An **online store** in Redis: \`feature:{name}:{version}:{entity}\`, a TTL from the definition's
   \`freshness_slo\`, and an **as-of read** that returns \`event_ts\` and \`age_s\`.
3. A **backfill** over gRPC: one \`Scan\` per partition as of the cutoff, a 60-second deadline, at most
   4 in flight, timed-out partitions reported missing, one abort on a permission rejection.
4. A **Kafka** lineage path: \`feature.event\` keyed by feature name, \`acks=all\`, executed row
   counts, published after the commit, with an outbox row when the produce fails.
5. \`GET /v1/features/{name}/versions/{v}/stats\`: distribution, **null rate**, a **pinned baseline**,
   a **three-sigma** drift flag, and \`freshness_s\`/\`stale\`.

## The debugging habit

Every starter compiles, serves the happy path and looks right. Each step says how many flaws it hides
and where to look; the checks say what must change. Debug the starter, fix it, and prove the fix with
checks that fail on the starter and pass on yours.

## Left out on purpose

Warehouse-specific SQL, feature authoring UIs, streaming materialization, embedding stores, model
registry integration, per-tenant quotas, lineage graphing across features, and backfill scheduling and
retries.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'training · serving', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Feature API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'registry', sub: 'definitions · outbox', x: 46, y: 10},
      {id: 'redis', kind: 'redis', label: 'Online store', sub: 'value + event_ts', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'feature.event', sub: 'key = feature name', x: 46, y: 90},
      {id: 'worker', kind: 'service', label: 'Backfill worker', sub: '≤ 4 partitions · 60 s', x: 70, y: 10},
      {id: 'offline', kind: 'grpc', label: 'Offline store', sub: 'Scan / partition', x: 70, y: 45},
      {id: 'monitor', kind: 'service', label: 'Drift monitor', sub: 'null rate · baseline', x: 70, y: 85},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'definitions · outbox'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'write · as-of read'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce feature.event'},
      {from: 'api', to: 'worker', kind: 'plain', label: 'start backfill'},
      {from: 'worker', to: 'offline', kind: 'grpc', label: 'Scan(feature, version, partition)'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'materialize values'},
      {from: 'worker', to: 'kafka', kind: 'kafka', label: 'produce feature.event'},
      {from: 'kafka', to: 'monitor', kind: 'kafka', label: 'consume'},
      {from: 'monitor', to: 'redis', kind: 'redis', label: 'read stats · baseline'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
