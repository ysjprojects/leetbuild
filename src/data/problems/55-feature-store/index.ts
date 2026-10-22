import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-client';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Feature store on the AI-era track: the course is not "cache some numbers in Redis", it is the
 * review you owe a feature platform before a model is trained on what it serves. An immutable,
 * reference-checked definition → versioned online values with an as-of read → a backfill with bounded
 * concurrency and honest failures → per-feature lineage events published after the partition commits →
 * a stats read where null rate, a pinned baseline and staleness are all visible.
 */
export const featureStoreProblem: Problem = {
  id: 'feature-store',
  title: 'Feature Store',
  tagline: 'Training and serving read the same features, computed once and versioned.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Feature Store

A feature store is the piece of an AI platform that makes training and serving read the same numbers:
one definition per (name, version), one computed value per entity, one lineage event, one stats read.
The visible part is a number in a response; the parts that decide whether the platform is trustworthy
are the definition contract, the point-in-time read, the honesty of the backfill, the order of the
lineage log, and whether drift is actually visible.

## The real system

Production feature platforms are shared by two very different consumers. Training asks questions about
the past — "what was this entity's 7-day average as of the cutoff?" — while serving asks about now. If
the store can only answer "latest", training reads information from after its own cutoff and the model
scores well offline and badly in production. That is why every value carries the event timestamp it was
computed from, every read accepts an \`as_of\`, and every key includes the feature version: a version
bump must serve new keys without erasing the ones a backfill still has to reproduce. Definitions
themselves are immutable and resolved at registration time, so a dangling computation reference fails
loudly at the registry instead of quietly during a training run. Backfills are clients of a shared
warehouse, so they bound their concurrency, put a deadline on every partition, report a timed-out
partition as missing rather than zero-filling it, and stop once on a permission rejection. Lineage
events are keyed by feature name because Kafka orders within a partition, are published only after the
partition commits, and carry the row counts that were actually written. And the stats endpoint reports
the distribution, the null rate, freshness and a drift flag measured against a declared baseline,
because a dashboard that only reports means cannot fail.

## What you build here

One service, **featured**, with five pieces:

1. \`POST /v1/features/definitions\`: an immutable definition per (name, version), a \`dtype\`
   whitelist, a \`computation_ref\` that must resolve (**409** on a re-registration, **422** on a
   dangling reference), and a required, explicit \`freshness_slo\`.
2. An **online store** in Redis: values under \`feature:{name}:{version}:{entity}\`, a TTL derived from
   the definition's \`freshness_slo\`, and an **as-of read** that returns the value with its
   \`event_ts\` and \`age_s\` and refuses anything newer than the requested time.
3. A **backfill** over gRPC: one \`Scan\` per partition as of the training cutoff, a 60-second deadline
   per call, at most 4 partitions in flight, a timed-out partition reported missing, and a permission
   rejection that stops the job once.
4. A **Kafka** lineage path: \`feature.event\` keyed by feature name, \`acks=all\`, version and
   partition ranges and executed row counts, published after the partition commits, with an outbox row
   when the broker rejects the produce.
5. \`GET /v1/features/{name}/versions/{v}/stats\`: distribution summaries, the **null rate**, a
   **pinned baseline** version, a **three-sigma** drift flag, and \`freshness_s\`/\`stale\`.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Warehouse-specific SQL, feature authoring UIs, streaming materialization, embedding stores, model
registry integration, per-tenant quotas, lineage graphing across features, and backfill scheduling and
retries. The five pieces above are the ones that decide whether the store is correct, honest and
shippable.`,
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
