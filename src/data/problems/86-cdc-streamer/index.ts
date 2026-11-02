import type {Problem} from '@/lib/types';

import {subscriptionEndpointStep} from './steps/1-endpoint';
import {lsnCursorStep} from './steps/2-state';
import {slotReadStep} from './steps/3-dependency';
import {changeEventsStep} from './steps/4-events';
import {lagReadStep} from './steps/5-read';

/**
 * CDC streamer: the course is not "tail the WAL", it is the debugging you owe a replication
 * service before it drops a tenant's changes. An authorized, idempotent subscription → a durable
 * LSN cursor that only moves after the sink confirms → a slot reader whose failed batches are
 * retried from their first LSN instead of skipped → change events keyed by table and primary key
 * so one row stays ordered → a lag read an operator can page on.
 */
export const cdcStreamerProblem: Problem = {
  id: 'cdc-streamer',
  title: 'CDC Streamer',
  tagline: 'A WAL tailer with a durable LSN cursor, same-batch retries and per-row Kafka keys.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# CDC Streamer

A change data capture streamer reads a database's write-ahead log and delivers every committed
change to the sinks that care about it: a warehouse, a search index, a cache. The visible part is a
subscription endpoint and a lag number. The parts that decide whether the platform can be trusted
are the authorization of a subscription, the durability of the confirmed position in the log, the
retry rule for a failed batch, the message key that keeps one row's history in order, and the lag
an operator can act on.

## The real system

Debezium's PostgreSQL connector holds a logical replication slot, records the WAL position of every
event it emits, and on restart resumes from the LSN stored in its Kafka offsets topic rather than
from the server's head. When that recorded position is no longer available on the server, the
\`snapshot.mode=when_needed\` setting takes a fresh snapshot instead of silently continuing from
wherever the log now starts. The slot retains WAL segments until the consumer confirms them, which is
why a stalled or lost slot is a page and not a metric: the distance between the confirmed LSN and the
slot's restart LSN is the data about to be lost.

Under pressure the tempting move is to skip. A batch fails, the tailer jumps past it to keep the lag
chart flat, the cursor moves, and the tenant's changes are gone with no error anyone sees. A failed
batch is instead retried from its first LSN with the same batch id until it succeeds or the
subscription halts, and back-pressure lands on the slow sink rather than on dropped work.
Exactly-once delivery to a non-transactional sink is not available; at-least-once plus an idempotent,
ordered apply is what ships.

Ordering is a keying decision. Keying a change topic by table scatters one row's changes across
partitions; keying by (table, primary key) puts every change of one row in one partition in commit
order. The payload carries digests, not raw column values, because a retained topic that copies
column contents turns every PII fix into a data-removal project.

## What you build here

One service, **cdcd**, with five pieces:

1. \`POST /v1/subscriptions\`: an authenticated tenant, a table on that tenant's approved list
   (**403** otherwise), a filter parsed to structured predicates over non-sensitive columns, a sink
   reference, and an \`Idempotency-Key\` so a replay returns the existing subscription.
2. A **Redis** LSN cursor per (subscription, table): written without expiry, advanced only after the
   downstream confirmation, monotonic, and the resume point of a restart.
3. A **gRPC** slot reader: a five-second deadline per read, a failed batch retried from its first LSN
   with the same batch id until it succeeds or the subscription halts, a lost slot surfaced as a
   page-worthy state, and back-pressure at the sink.
4. A **Kafka** change path: \`cdc.change\` keyed by (table, primary key), before and after digests
   plus the LSN in the payload, an idempotent producer, and an outbox row when the broker rejects the
   produce.
5. \`GET /v1/subscriptions/{id}/lag\`: the confirmed LSN, the source head LSN, lag in changes and in
   seconds from LSN arithmetic, whether the slot is still active, a critical state beyond the
   retention window, and **404** for a subscription that belongs to someone else.

## The debugging habit

Every starter in this course compiles and serves the happy path. Your job in each step is to debug
it against the failure modes, fix it, and prove the fix with checks that fail on the starter and
pass on your version.

## Left out on purpose

Slot creation and WAL configuration, schema change handling, sink-specific upsert dialects,
multi-region slots, snapshot and backfill orchestration, throughput tuning, and the sink connectors
themselves. The five pieces above decide whether the stream is correct, ordered and operable.`,
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
