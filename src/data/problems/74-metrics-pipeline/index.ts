import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Metrics pipeline: the course is not "accept a datapoint from an endpoint", it is the debugging
 * you owe an ingest path before a dashboard trusts it. Validated batches with cardinality guards
 * and acknowledgments that follow validation → one atomic, deduped Redis window merge → per-shard
 * gRPC flushes with a deadline and resumable partials → series-keyed rollup events with an outbox →
 * a series query bounded in time, cardinality, resolution and tenant.
 */
export const metricsPipelineProblem: Problem = {
  id: 'metrics-pipeline',
  title: 'Metrics Pipeline',
  tagline: 'Ingest metrics at scale: a cardinality budget at the door and bounded series queries at the dashboard.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Metrics Pipeline

A metrics pipeline takes the firehose of datapoints a fleet of services emits, turns it into the
counters a dashboard reads, and keeps the bill finite. What makes the platform trustworthy is the
validation funnel in front of ingest, the atomicity of a batch merge, and the bounds on every query
the read path answers.

## The real system

Grafana Mimir, the Prometheus-compatible store behind Grafana Cloud Metrics, treats every field of a
remote-write batch as a claim. Its per-tenant limits are the cardinality budget this course asks for:
\`max_global_series_per_user\` caps the active series a tenant may hold (150,000 by default in Grafana
Cloud) and \`out_of_order_time_window\` bounds how far behind now a sample may land (2 hours), so a
stale sample is refused rather than backfilled into a window that already rolled up. On the read
side, \`max_partial_query_length\` caps a query's time range (32 days) before the querier touches
storage. This course keeps the same shape at smaller numbers.

## What you build here

One service, **metricsd**, with five pieces:

1. \`POST /v1/metrics\`: batches of at most **500** samples, labels filtered through the tenant's
   allowlist and cardinality budget, a timestamp within the accepted skew, a **422** that names the
   offending label, and validation before the acknowledgment.
2. A **Redis** aggregation layer: window keys merged by one atomic Lua \`EVAL\`, a TTL set at write
   time so the key expires at the window boundary, and a batch-id key set with \`SET NX\` so a
   redelivered batch is applied once.
3. A **gRPC** shard-writer client: a 2-second deadline per shard, a response that reports which shards
   accepted which windows, retries that touch only the failed shards, and windows identified by id.
4. A **Kafka** rollup path: \`metrics.rolled\` events keyed by series, published only after the shard
   confirms, carrying window boundaries and counts, with an outbox row when the broker rejects the
   produce.
5. \`GET /v1/series\`: a range capped at **7 days**, at most **50** series, one point per **10 seconds**
   with the method named, cursor paging, and a **404** for another tenant's series.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path and looks right. In
every step you debug it against the failure modes, fix it, and prove the fix with checks that fail on
the starter and pass on your version.

## Left out on purpose

Storage backends (TSDB compaction, retention tiers), alert evaluation, collector agents, query
languages (PromQL), multi-region replication, per-tenant billing, and schema-on-read label
discovery.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Metrics Client', sub: 'batches · queries', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Metrics API', sub: 'HTTPS :8443', x: 30, y: 24},
      {id: 'redis', kind: 'redis', label: 'Window Store', sub: 'window keys', x: 56, y: 12},
      {id: 'shards', kind: 'grpc', label: 'Shard Writers', sub: 'MetricsWriter', x: 78, y: 40},
      {id: 'kafka', kind: 'kafka', label: 'metrics.rolled', sub: 'key = series', x: 78, y: 80},
      {id: 'query', kind: 'http', label: 'Series API', sub: 'HTTPS :8444', x: 30, y: 78},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/metrics'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'atomic window merge'},
      {from: 'api', to: 'shards', kind: 'grpc', label: 'flush windows'},
      {from: 'shards', to: 'kafka', kind: 'kafka', label: 'metrics.rolled'},
      {from: 'client', to: 'query', kind: 'http', label: 'GET /v1/series'},
      {from: 'query', to: 'redis', kind: 'redis', label: 'bounded reads'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
