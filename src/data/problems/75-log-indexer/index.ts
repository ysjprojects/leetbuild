import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Log indexer on the AI-era track: the course is not "write logs to a queue", it is the review you
 * owe a model-generated ingestion pipeline before it silently loses a stack trace. Validated
 * records with an honest truncation marker → one atomic Redis buffer per index with real
 * back-pressure → gRPC shard writes with a deadline, a stable batch id and terminal conflicts →
 * `log.indexed` events keyed by service, published only after the shard commits, with an outbox and
 * the shed/rejected counts → a completeness read that buckets by hour, expects per tenant, and
 * refuses to answer for another tenant's service.
 */
export const logIndexerProblem: Problem = {
  id: 'log-indexer',
  title: 'Log Indexer',
  tagline: 'Index logs with retention, sampling and honest completeness markers.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Log Indexer

A log indexer is the piece of a platform that decides which records are even worth storing, how much
of a record survives, how writes are batched and retried, how consumers learn that a service's logs
were indexed, and how anyone can tell whether the pipeline lost data. The visible part is a search
box with results in it; the parts that decide whether the platform is trustworthy are the ingest
funnel, the buffer's back-pressure, the write retry contract, the event key, and the completeness
number nobody double-checks.

## The real system

Production indexers receive records from hundreds of services, and the first thing they do is refuse
work cheaply: a record over the size cap is rejected before it is parsed, a service id that is not in
the tenant's registry is rejected before it is buffered, and a log line longer than the retained
prefix is cut **and marked**, because a consumer that cannot tell a complete stack trace from a
mangled one will make the wrong call at 3 a.m. Writers fan records into per-index buffers and shed
load when a buffer is over its byte cap, because an index that is down must not become unbounded
memory in the ingest tier. A buffer's counters and offsets move in one atomic operation, so a crash
cannot leave the two disagreeing. Batch writes go to shards under a deadline, retry only the failures
worth retrying — under the *same* batch id, so a replayed attempt is a no-op rather than a duplicated
document — and treat a mapping conflict as terminal for the whole batch. Committed batches publish one
event keyed by service so a service's stream stays ordered, carrying batch ids, counts and the index
snapshot, with an outbox row when the broker rejects the produce. And the completeness read reports
indexed counts per hour against a tenanted expectation, so one tenant's quiet hour is not another
tenant's outage.

## What you build here

One service, **logindex**, with five pieces:

1. \`POST /v1/logs\`: an authenticated tenant, a structured body, a record cap of 1 MiB, a service id
   resolved from the tenant's registry, a timestamp inside the accepted skew, an explicit truncation
   marker when the message is cut at 16 KiB, and validation that runs before anything is buffered.
2. A **Redis** buffer state: one buffer per index, batches of 1000 records, a byte cap that
   back-pressures the ingest path with \`429\` and \`Retry-After\`, and a single atomic script that
   moves the record count and the offset together.
3. A **gRPC** shard client: a 3-second deadline per attempt, a bounded retry set of
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, one batch id minted per batch and reused across attempts, and
   a mapping conflict surfaced as terminal with the offending field.
4. A **Kafka** publisher: one \`log.indexed\` event per committed batch keyed by service, published
   only after the shard commits, carrying the batch id, the indexed count, the shed and rejected
   counts and the index snapshot, with an outbox row when the broker rejects the produce.
5. \`GET /v1/services/{id}/completeness\`: hourly buckets, an expectation computed from the tenant's
   own service history, gaps flagged past a threshold, and a \`404\` for a service that is not in the
   caller's registry.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it indexes the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI platform:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Retention tiering and cold storage, sampling policies and per-tenant quotas, index shard placement,
query and search APIs, log parsing and field extraction, deduplication of identical lines, and the
metrics pipeline itself. The five pieces above are the ones that decide whether the index is correct,
isolated and shippable.`,
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
