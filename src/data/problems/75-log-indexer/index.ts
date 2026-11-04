import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Log indexer: the debugging an ingestion pipeline needs before it loses a stack trace. Validated
 * records with a reported cut → one Redis buffer per index, admitted and drained by Lua scripts
 * under a byte cap → shard writes with a deadline, a bounded retry set and one batch id → service-
 * keyed `log.indexed` events after the shard commits, with an outbox → an hourly completeness read
 * against the service's own baseline.
 */
export const logIndexerProblem: Problem = {
  id: 'log-indexer',
  title: 'Log Indexer',
  tagline: 'Log records cut on byte boundaries, a capped Redis buffer, one batch id per shard write and hourly gaps.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Log Indexer

A log indexer decides which records are worth storing, how much of a record survives, how writes are
batched and retried, how consumers learn that a service's logs were indexed, and how anyone can tell
whether the pipeline lost data. The visible part is a search box.

## The real system

Grafana Loki's distributor answers the same questions. A line over \`max_line_size\` is rejected
with reason \`line_too_long\`, and the response names the stream and the line's size in bytes; with
\`max_line_size_truncate\` on, Loki stores the cut line instead, and
\`max_line_size_truncate_identifier\` appends a marker so a truncated line can be told from a
complete one. Every discarded line increments \`loki_discarded_samples_total\` with a \`reason\`
label, so an operator sees dropped data instead of inferring it.

## What you build here

One service, **logindex**, with five pieces. They share the tenant registry
(\`logindex.registry.is_registered\`) and the hourly ledger (\`logindex.ledger\`), both provided;
steps 2 and 3 build the buffer and the shard client the other steps import as \`logindex.buffer\`
and \`logindex.shard\`.

1. \`POST /v1/logs\`: a tenant, a registered service, a 1 MiB record cap, a level and a timestamp
   within 5 minutes, a message cut at 16 KiB of bytes and reported; the record goes to
   \`buffer.append_record\`.
2. A **Redis** buffer per index: \`buffer:{tenant}:{service}\` (a list of JSON records) beside
   \`buffer:{tenant}:{service}:meta\` (\`count\`, \`bytes\`, \`offset\`). \`append_record\` admits a record
   in one Lua script, or sheds it (returns 0) past 64 MiB; \`drain_batch\` takes at most 1000 in one.
3. A **gRPC** client of \`logshard.IndexShard/BulkWrite\`: \`bulk_write(index, records)\` with a
   3-second deadline, three attempts for \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\` only, one batch id for
   every attempt, and \`MappingConflict(field)\` for \`FAILED_PRECONDITION\`.
4. A **Kafka** \`log.indexed\` event per committed batch, keyed by service, carrying the shard's batch
   id and its indexed and rejected counts; a rejected produce goes to \`outbox:log.indexed\`.
5. \`GET /v1/services/{service}/completeness\`: the last 24 complete hours from
   \`ledger.hourly_counts\`, each against \`ledger.expected_per_hour\` (the service's own previous 7
   days), an hour more than half below it flagged as a gap, 404 outside the caller's registry.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Retention tiers, sampling, shard placement, query APIs, field extraction, deduplication of identical
lines and the ledger consumer itself. The five pieces above decide whether the index holds what the
agents sent and whether anyone can see when it does not.`,
  diagram: {
    nodes: [
      {id: 'agent', kind: 'client', label: 'Log agent', sub: 'ship · retry', x: 8, y: 50},
      {id: 'dash', kind: 'client', label: 'Completeness UI', sub: 'hourly gaps', x: 8, y: 88},
      {id: 'api', kind: 'http', label: 'logindex', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'registry', kind: 'db', label: 'service registry', sub: 'registry:{tenant}', x: 48, y: 8},
      {id: 'redis', kind: 'redis', label: 'Redis buffers', sub: 'buffer:{tenant}:{service}', x: 48, y: 40},
      {id: 'writer', kind: 'service', label: 'Buffered writer', sub: 'drain_batch · 1000', x: 66, y: 60},
      {id: 'shard', kind: 'grpc', label: 'Index shard', sub: 'BulkWrite · 3 s', x: 86, y: 8},
      {id: 'ledger', kind: 'db', label: 'Index ledger', sub: 'ledger:{tenant}:{service}', x: 86, y: 46},
      {id: 'kafka', kind: 'kafka', label: 'log.indexed', sub: 'key = service', x: 86, y: 84},
    ],
    edges: [
      {from: 'agent', to: 'api', kind: 'http', label: 'POST /v1/logs'},
      {from: 'dash', to: 'api', kind: 'http', label: 'GET completeness'},
      {from: 'api', to: 'registry', kind: 'plain', label: 'is_registered'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'append_record'},
      {from: 'redis', to: 'writer', kind: 'redis', label: 'drain_batch'},
      {from: 'writer', to: 'shard', kind: 'grpc', label: 'BulkWrite'},
      {from: 'writer', to: 'kafka', kind: 'kafka', label: 'log.indexed after the commit'},
      {from: 'kafka', to: 'ledger', kind: 'kafka', label: 'hourly counts'},
      {from: 'api', to: 'ledger', kind: 'plain', label: 'hourly_counts'},
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
