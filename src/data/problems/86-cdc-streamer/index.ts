import type {Problem} from '@/lib/types';

import {subscriptionEndpointStep} from './steps/1-endpoint';
import {lsnCursorStep} from './steps/2-state';
import {slotReadStep} from './steps/3-dependency';
import {changeEventsStep} from './steps/4-events';
import {lagReadStep} from './steps/5-read';

/**
 * CDC streamer on the AI-era track: the course is not "tail the WAL", it is the review you owe a
 * model-generated replication service before it drops a tenant's changes. An authorized,
 * idempotent subscription → a durable LSN cursor that only moves after the sink confirms → a slot
 * reader whose failed batches are retried from their first LSN instead of skipped → change events
 * keyed by table and primary key so one row stays ordered → a lag read an operator can page on.
 */
export const cdcStreamerProblem: Problem = {
  id: 'cdc-streamer',
  title: 'CDC Streamer',
  tagline: 'Change data capture that never skips a change and keeps per-row order.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# CDC Streamer

A change data capture streamer reads a database's write-ahead log and delivers every committed
change to the sinks that care about it — a warehouse, a search index, a cache. The visible part is a
subscription endpoint and a lag number; the parts that decide whether the platform can be trusted
are the authorization of a subscription, the durability of the confirmed position in the log, the
retry rule that never lets a batch disappear, the message key that keeps one row's history in order,
and the lag an operator can actually act on.

## The real system

Production CDC pipelines hold a logical replication slot against the source database, read the log
in batches under a deadline, and track a confirmed log sequence number (LSN) per (subscription,
table). A confirmed LSN is a promise: everything up to it has been durably applied downstream, so a
restart resumes exactly there — it re-delivers nothing below it and drops nothing above it. The slot
retains log segments until the consumer confirms, which is why a stalled or lost slot is a page and
not a metric: the database will discard the segments the stream still needs, and the distance
between the confirmed LSN and the slot's restart LSN is the data about to be lost.

Under pressure the tempting move is to skip. A batch fails, the tailer jumps past it to keep the lag
chart flat, the cursor moves, and the tenant's changes are gone with no error anyone ever sees. Real
pipelines do the opposite: a failed batch is retried from its first LSN with the same batch id until
it succeeds or the subscription halts loudly, and back-pressure is applied at the sink — the slow
consumer — instead of being absorbed by dropping work. Exactly-once delivery to a non-transactional
sink is impossible; at-least-once plus an idempotent, ordered apply is what is actually shipped.

Ordering is a keying decision. Keying a change topic by table scatters the changes of a single row
across partitions, so consumers replay one row's history out of order; keying by (table, primary
key) puts every change of one row in one partition, in commit order, and lets a consumer apply them
sequentially. The payload itself carries digests, not raw column values: a stream that copies
column contents into a replicated, retained topic turns every PII fix into a data-removal project.

## What you build here

One service, **cdcd**, with five pieces:

1. \`POST /v1/subscriptions\`: an authenticated tenant, a table on that tenant's approved list
   (**403** otherwise), a filter parsed to structured predicates over non-sensitive columns, a sink
   reference, and an \`Idempotency-Key\` so a replay returns the existing subscription instead of
   creating a second stream.
2. A **Redis** LSN cursor per (subscription, table): written without expiry, advanced only after the
   downstream confirmation, monotonic, and used as the resume point of a restart.
3. A **gRPC** slot reader: a five-second deadline per read, a failed batch retried from its first LSN
   with the same batch id until it succeeds or the subscription halts, a lost slot surfaced as a
   page-worthy state, and back-pressure at the sink instead of skipped batches.
4. A **Kafka** change path: \`cdc.change\` keyed by (table, primary key), before and after digests
   plus the LSN in the payload, an idempotent producer, and an outbox row when the broker rejects the
   produce.
5. \`GET /v1/subscriptions/{id}/lag\`: the confirmed LSN, the source head LSN, lag in changes and in
   seconds derived from LSN arithmetic, whether the slot is still active, a critical state beyond the
   retention window, and **404** for a subscription that belongs to someone else.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real data
platform: read the draft against the failure modes, name the subtle one, fix it, and prove the fix
with checks that fail on the draft and pass on your version.

## Left out on purpose

Slot creation and WAL configuration, schema change handling, sink-specific upsert dialects,
multi-region slots, snapshot/backfill orchestration, throughput tuning, and the sink connectors
themselves. The five pieces above are the ones that decide whether the stream is correct, ordered
and operable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Tenant app', sub: 'subscribe · read lag', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'CDC API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'pg', kind: 'db', label: 'Source DB', sub: 'logical slot · WAL', x: 44, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'subscriptions · LSN cursor', x: 44, y: 50},
      {id: 'replicator', kind: 'service', label: 'Replicator', sub: 'ReadSlot · batcher', x: 64, y: 40},
      {id: 'kafka', kind: 'kafka', label: 'cdc.change', sub: 'key = table · pk', x: 64, y: 78},
      {id: 'outbox', kind: 'db', label: 'outbox', sub: 'rejected produce', x: 46, y: 88},
      {id: 'sink', kind: 'external', label: 'Sink', sub: 'warehouse · search', x: 88, y: 50},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'subscriptions · cursor'},
      {from: 'api', to: 'pg', kind: 'plain', label: 'approved tables'},
      {from: 'replicator', to: 'pg', kind: 'grpc', label: 'ReadSlot · 5 s deadline'},
      {from: 'replicator', to: 'redis', kind: 'redis', label: 'confirm LSN'},
      {from: 'replicator', to: 'kafka', kind: 'kafka', label: 'produce cdc.change'},
      {from: 'replicator', to: 'outbox', kind: 'plain', label: 'rejected produce'},
      {from: 'kafka', to: 'sink', kind: 'kafka', label: 'consume'},
      {from: 'sink', to: 'replicator', kind: 'plain', label: 'apply ack · back-pressure'},
    ],
  },
  steps: [subscriptionEndpointStep, lsnCursorStep, slotReadStep, changeEventsStep, lagReadStep],
};
