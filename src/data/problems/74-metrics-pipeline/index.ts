import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Metrics pipeline: the course is not "accept a datapoint", it is the debugging you owe an ingest
 * path before a dashboard trusts it. A batch validated whole before it is acknowledged → one atomic,
 * deduplicated Redis merge into 10-second windows → closed windows flushed to their shard writers
 * under a deadline, partial results kept → rollup events keyed by series, produced after the shard
 * accepted, with an outbox → a series query bounded in range, page size and resolution, scoped to
 * the caller's tenant.
 */
export const metricsPipelineProblem: Problem = {
  id: 'metrics-pipeline',
  title: 'Metrics Pipeline',
  tagline: 'Label budgets at the door, atomic window merges, shard flushes and bounded series queries.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Metrics Pipeline

A metrics pipeline turns the datapoints a fleet of services emits into the counters a dashboard
reads. Every stage can count wrong without crashing: a batch merged halfway, a redelivery counted
twice, a shard that timed out and took its windows with it, a query that scans a week.

## The real system

Grafana Mimir, the Prometheus-compatible store behind Grafana Cloud Metrics, enforces per-tenant
limits at the distributor before anything is written. One of them, \`out_of_order_time_window\`,
bounds how old a sample may be and still be ingested; anything older is refused instead of
rewriting a block that queriers already serve. This course keeps the same shape at smaller numbers.

## What you build here

One service, **metricsd**, for tenants named by \`X-Tenant-Id\`. Provided: \`metrics.model\` (series
ids, 10-second windows, window ids, the shard map, each tenant's label allowlist), \`metrics.windows\`
(the window store), \`metrics.flush\` (the shard client) and \`metrics.outbox\`.

1. \`POST /v1/metrics\` with \`{"batch_id", "samples": [{"metric", "labels", "timestamp", "value"}]}\`:
   at most **500** samples, labels from the tenant's allowlist and at most **8**, timestamps within
   **3600 s** of now, the whole batch validated before \`merge_batch\` runs.
2. \`merge_batch(tenant, batch_id, samples)\`: one Lua script claims \`batch:{tenant}:{batch_id}\` and
   adds each sample to the hash \`win:{tenant}:{series}:{start}\` (\`count\`, \`sum\`), expiring a day
   after the window closes, indexed in \`idx:{tenant}:{metric}\`.
3. \`flush_windows(windows)\`: \`MetricsWriter.WriteWindows\` to each window's shard with a **2 s**
   deadline and window ids; retries go to the failed shards only; the result says what is accepted
   and what is pending.
4. \`publish_rollups(windows)\`: \`metrics.rolled\` events for the windows the shards accepted, keyed
   \`{tenant}/{series}\`, from an idempotent producer, with an outbox row when delivery fails.
5. \`GET /v1/series?metric=…&from=…&to=…&cursor=…\`: at most **6 hours**, **50** series per page,
   one point per **60 s**, the caller's tenant only.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path and looks right. In
every step you debug it against the failure modes, fix it, and prove the fix with checks that fail on
the starter and pass on your version.

## Left out on purpose

Storage engines and compaction, alert evaluation, collector agents, PromQL, multi-region replication
and the relay that drains the outbox.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Metrics client', sub: 'batches · dashboards', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'metricsd', sub: 'POST /v1/metrics', x: 30, y: 24},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'win:{tenant}:{series}:{start}', x: 56, y: 12},
      {id: 'shards', kind: 'grpc', label: 'Shard writers', sub: 'WriteWindows · 2 s', x: 80, y: 36},
      {id: 'kafka', kind: 'kafka', label: 'metrics.rolled', sub: 'key = tenant/series', x: 80, y: 76},
      {id: 'query', kind: 'http', label: 'Series API', sub: 'GET /v1/series', x: 30, y: 78},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/metrics'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'merge_batch (one Lua script)'},
      {from: 'redis', to: 'shards', kind: 'grpc', label: 'flush closed windows'},
      {from: 'shards', to: 'kafka', kind: 'kafka', label: 'publish accepted rollups'},
      {from: 'client', to: 'query', kind: 'http', label: 'GET /v1/series'},
      {from: 'query', to: 'redis', kind: 'redis', label: 'read_windows'},
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
