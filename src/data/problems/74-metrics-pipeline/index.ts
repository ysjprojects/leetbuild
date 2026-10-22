import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Metrics pipeline on the AI-era track: the course is not "accept a datapoint from an endpoint", it
 * is the review you owe a model-generated ingest path before a dashboard trusts it. Validated
 * batches with cardinality guards and honest acks → one atomic, deduped Redis window merge →
 * per-shard gRPC flushes with a deadline and resumable partials → series-keyed rollup events with an
 * outbox → a series query bounded in time, cardinality, resolution and tenant.
 */
export const metricsPipelineProblem: Problem = {
  id: 'metrics-pipeline',
  title: 'Metrics Pipeline',
  tagline: 'Ingest metrics at scale with cardinality guards, honest acks and bounded queries.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Metrics Pipeline

A metrics pipeline is the piece of an observability platform that takes the firehose of datapoints a
fleet of services emits, turns it into the counters a dashboard reads, and keeps the bill finite
while it does. The visible part is a number on a chart; the parts that decide whether the platform is
trustworthy are the validation funnel in front of ingest, the atomicity of a batch merge, the honesty
of an acknowledgment, and the bounds on every query the read path answers.

## The real system

Production ingest paths receive batches from thousands of tenants at once, and they treat every field
as a claim: a metric name the tenant may write, a label set inside the tenant's cardinality budget,
and a timestamp close enough to now to be believed. A batch is merged into Redis window keys in one
atomic step, so a crash leaves a window either whole or untouched — never half-counted — and the
window expires exactly at its boundary so a stale counter cannot outlive its minute. Those windows are
flushed to shard writers over gRPC under a deadline, and each shard answers for the windows it owns, so
a retry re-sends only what failed and an accepted window is never counted twice. Flushes publish
\`metrics.rolled\` events keyed by series so a series rollup stream stays ordered, with an outbox row
when the broker is down. And the read path never lets a caller ask for more than the platform can
honestly serve: bounded time ranges, bounded series counts, a stated downsampling policy, and a tenant
boundary on every key.

## What you build here

One service, **metricsd**, with five pieces:

1. \`POST /v1/metrics\`: an authenticated tenant, batches of at most **500** samples, a metric name and a
   label set filtered through the tenant's allowlist and cardinality budget, a timestamp within the
   accepted skew, and a **422** that names the offending label. Every sample is validated before the
   batch is acknowledged, so nothing is silently dropped.
2. A **Redis** aggregation layer: per-series window keys merged by one atomic Lua \`EVAL\` that adds all
   deltas together or none, a TTL set at write time so the key expires exactly at the window boundary,
   and a batch-id key set with \`SET NX\` so a redelivered batch is applied once.
3. A **gRPC** shard-writer client: a 2-second deadline per shard, a response that reports which shards
   accepted which windows, retries that touch only the failed shards, a partial flush that is visible
   and resumable, and windows identified by id so an accepted window is never re-sent.
4. A **Kafka** rollup path: \`metrics.rolled\` events keyed by series for per-series ordering, published
   only after the shard confirms, carrying window boundaries and counts, with an outbox row when the
   broker rejects the produce.
5. \`GET /v1/series\`: a time range capped at **7 days**, at most **50** series, points at no more than one
   per **10 seconds** with the downsampling method named, cursor paging, and a **404** for a series
   that belongs to another tenant.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real ingest path:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Metric storage backends (TSDB compaction, retention tiers), alert evaluation, the collector agents
themselves, dashboard query languages (PromQL), multi-region replication, per-tenant billing, and
schema-on-read label discovery. The five pieces above are the ones that decide whether the pipeline is
correct, isolated and shippable.`,
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
