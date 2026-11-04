import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {subscriptionEndpointStep} from './steps/1-endpoint';
import {lsnCursorStep} from './steps/2-state';
import {slotReadStep} from './steps/3-dependency';
import {changeEventsStep} from './steps/4-events';
import {lagReadStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * CDC streamer: the course is not "tail the WAL", it is the debugging you owe a replication
 * service before it drops a tenant's changes. A subscription limited to approved tables and
 * non-sensitive columns → a per-table Redis LSN cursor that only moves forward → slot reads under a
 * deadline that never confirm a batch the sink refused → row-keyed change events with digests,
 * true only once the broker acknowledged them → a lag read that pages on a lost slot.
 */
export const cdcStreamerProblem: Problem = {
  id: 'cdc-streamer',
  title: 'CDC Streamer',
  tagline: 'Approved tables, a per-table LSN cursor in Redis, slot reads that skip nothing, row-keyed change events.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# CDC Streamer

A change data capture streamer reads a database's write-ahead log through a logical replication
slot and delivers every committed row change to the systems that keep a copy: a warehouse, a search
index, a cache. The slot holds WAL on the database's disk until the streamer confirms it, so a
streamer that confirms too early loses changes, and one that stops confirming fills the disk.

## The real system

Debezium's PostgreSQL connector records the LSN of every event it emits in Kafka's offsets topic and
resumes from it after a restart. With \`snapshot.mode=when_needed\` it takes a fresh snapshot when it
finds no offsets, or when the LSN they hold is no longer available on the server, instead of
streaming from wherever the log now starts. PostgreSQL reports each slot in \`pg_replication_slots\`,
with \`restart_lsn\`, \`confirmed_flush_lsn\` and a \`wal_status\` that turns to \`lost\` once the slot
falls past \`max_slot_wal_keep_size\`.

## What you build here

One service, **cdcd**, over one subscription store (\`cdc.store\`, provided: subscriptions as
\`cdc:sub:{id}\` hashes, Idempotency-Key records, each tenant's approved tables, the sensitive
columns, \`digest\`) and one LSN cursor (\`confirm\` / \`load_cursor\`, built in step 2 and provided to
the later steps as \`cdc.cursor\`):

1. \`POST /v1/subscriptions\` \`{table, columns, sink}\` with \`X-Tenant-Id\` and \`Idempotency-Key\`:
   approved tables only (**403**), no sensitive column (**400**), one subscription per key.
2. A **Redis** cursor \`cdc:cursor:{subscription}:{table}\`: no expiry, moved forward only, by a Lua
   compare-and-set.
3. \`replicate_once(subscription_id, deliver)\`: **gRPC** \`Slots.ReadSlot\` from the cursor under a
   5-second deadline, then \`deliver(batch)\`, a confirmation only for what was delivered, and
   \`slot_lost\` on \`NOT_FOUND\`.
4. \`publish_batch(batch)\`, the \`deliver\` of step 3: **Kafka** \`cdc.change\` keyed \`table:pk\`, row
   digests instead of rows, an idempotent \`acks=all\` producer, true only once every delivery
   report says so.
5. \`GET /v1/subscriptions/{id}/lag\`: the owner's view of \`Slots.SlotStatus\` against the cursor,
   \`"critical"\` for an inactive or lost slot and past 512 MiB of lag.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Slot creation and WAL configuration, initial snapshots, schema changes, the sink connectors and
their upsert dialects, and failover of slots between regions.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Tenant app', sub: 'subscribe · read lag', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'cdcd', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'pg', kind: 'db', label: 'Source DB', sub: 'Slots · ReadSlot · SlotStatus', x: 46, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'cdc:sub · cdc:cursor:{sub}:{table}', x: 46, y: 50},
      {id: 'replicator', kind: 'service', label: 'Replicator', sub: 'replicate_once · deliver', x: 66, y: 32},
      {id: 'kafka', kind: 'kafka', label: 'cdc.change', sub: 'key = table:pk · digests', x: 66, y: 78},
      {id: 'sink', kind: 'external', label: 'Sink', sub: 'warehouse · search', x: 88, y: 78},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'subscriptions · cursor'},
      {from: 'api', to: 'pg', kind: 'grpc', label: 'SlotStatus · 5 s'},
      {from: 'replicator', to: 'pg', kind: 'grpc', label: 'ReadSlot · 5 s'},
      {from: 'replicator', to: 'redis', kind: 'redis', label: 'confirm after delivery'},
      {from: 'replicator', to: 'kafka', kind: 'kafka', label: 'publish_batch · acks=all'},
      {from: 'kafka', to: 'sink', kind: 'kafka', label: 'one row, one partition'},
    ],
  },
  steps: [subscriptionEndpointStep, lsnCursorStep, slotReadStep, changeEventsStep, lagReadStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
