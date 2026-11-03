import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Log indexer: the debugging an ingestion pipeline needs before it loses a stack trace. Validated
 * records with a truncation marker → one atomic Redis buffer per index with back-pressure → gRPC
 * shard writes with a deadline, a stable batch id and terminal conflicts → `log.indexed` events keyed
 * by service, published after the shard commits, with an outbox and the shed/rejected counts → a
 * completeness read bucketed by hour, expected per tenant, 404 for another tenant's service.
 */
export const logIndexerProblem: Problem = {
  id: 'log-indexer',
  title: 'Log Indexer',
  tagline: 'Index logs with a truncation marker, buffer back-pressure, stable batch ids and hourly completeness.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Log Indexer

A log indexer decides which records are worth storing, how much of a record survives, how writes are
batched and retried, how consumers learn that a service's logs were indexed, and how anyone can tell
whether the pipeline lost data. The visible part is a search box.

## The real system

Grafana Loki's distributor answers the same questions. A push with a log line over \`max_line_size\`
is rejected with **400** and reason \`line_too_long\`, and the response names the stream and the
line's size in bytes; with \`max_line_size_truncate\` on, Loki stores the cut line instead and
\`max_line_size_truncate_identifier\` appends a marker string so a truncated line can be told from a
complete one later. A tenant over \`ingestion_rate_mb\` or a stream over \`per_stream_rate_limit\`
gets **429**, and the whole request is refused before anything is stored. Every rejection, rate limit
or validation failure, increments \`loki_discarded_samples_total\` with a \`reason\` label, so an
operator sees dropped data instead of inferring it.

## What you build here

One service, **logindex**, with five pieces:

1. \`POST /v1/logs\`: an authenticated tenant, a 1 MiB record cap, a service id resolved from the
   tenant's registry, a timestamp inside the accepted skew, a truncation marker when the message is
   cut at 16 KiB, and validation before anything is buffered.
2. A **Redis** buffer: one per index, batches of 1000, a byte cap that back-pressures the ingest path
   with \`429\` and \`Retry-After\`, and one atomic script moving count, bytes and offset together.
3. A **gRPC** shard client: a 3-second deadline per attempt, a bounded retry set of
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, one batch id reused across attempts, and a mapping conflict
   surfaced as terminal with the offending field.
4. A **Kafka** publisher: one \`log.indexed\` event per committed batch keyed by service, published
   after the shard commits, carrying the batch id, the indexed, shed and rejected counts and the index
   snapshot, with an outbox row when the broker rejects the produce.
5. \`GET /v1/services/{id}/completeness\`: hourly buckets, an expectation from the tenant's own
   service history, gaps flagged past a threshold, and \`404\` for a service outside the caller's
   registry.

## The debugging habit

Every starter compiles and indexes the happy path. Debug it, fix it, and prove the fix with checks
that fail on the starter and pass on your version.

## Left out on purpose

Retention tiering and cold storage, sampling policies and per-tenant quotas, shard placement, query
APIs, log parsing and field extraction, deduplication of identical lines, and the metrics pipeline
itself. The five pieces above decide whether the index is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'agent', kind: 'client', label: 'Log agent', sub: 'ship · retry', x: 8, y: 50},
      {id: 'dash', kind: 'client', label: 'Completeness UI', sub: 'hourly gaps', x: 8, y: 88},
      {id: 'api', kind: 'http', label: 'Ingest API', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'registry', kind: 'db', label: 'service registry', sub: 'tenant · services', x: 48, y: 8},
      {id: 'redis', kind: 'redis', label: 'Redis buffers', sub: 'buffer:{tenant}:{service}', x: 48, y: 40},
      {id: 'writer', kind: 'service', label: 'Buffered writer', sub: 'batch · 1000', x: 66, y: 60},
      {id: 'shard', kind: 'grpc', label: 'Index shard', sub: 'BulkWrite · 3 s', x: 86, y: 8},
      {id: 'ledger', kind: 'db', label: 'Index ledger', sub: 'hourly counts', x: 86, y: 46},
      {id: 'kafka', kind: 'kafka', label: 'log.indexed', sub: 'key = service', x: 86, y: 84},
    ],
    edges: [
      {from: 'agent', to: 'api', kind: 'http', label: 'POST /v1/logs'},
      {from: 'dash', to: 'api', kind: 'http', label: 'GET completeness'},
      {from: 'api', to: 'registry', kind: 'plain', label: 'service lookup'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'atomic append'},
      {from: 'redis', to: 'writer', kind: 'redis', label: 'drain batch'},
      {from: 'writer', to: 'shard', kind: 'grpc', label: 'BulkWrite'},
      {from: 'writer', to: 'ledger', kind: 'plain', label: 'indexed counts'},
      {from: 'writer', to: 'kafka', kind: 'kafka', label: 'produce log.indexed'},
      {from: 'api', to: 'ledger', kind: 'plain', label: 'read counts'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
