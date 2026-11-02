import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Geo replicator: the course is not "copy rows to another region", it is the debugging you owe a
 * replication controller before it is allowed to move a tenant's data. A replication that names an
 * immutable, approved conflict policy → durable per-shard offsets that never rewind → idempotent
 * applies with a deadline, bounded retries and a halting schema mismatch → applied events keyed by
 * shard with the confirmed offsets and the rejected counts → a lag read that samples digests and
 * shows the divergent shards instead of hiding them.
 */
export const replicatorProblem: Problem = {
  id: 'replicator',
  title: 'Geo Replicator',
  tagline: 'Replicate shards across regions with durable offsets and a digest proof that the replica agrees.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Geo Replicator

A geo replicator keeps a shard's writes visible in another region. The parts that decide whether
the data is correct are the conflict policy, the per-shard offsets, the apply contract and the
divergence check.

## The real system

Debezium, the open-source change-data-capture platform, treats the position in the source's change
log as the one thing a restart must not lose: inside Kafka Connect it writes each connector's
offsets to a compacted \`offset.storage.topic\`, and a restarted connector resumes from the recorded
position instead of re-snapshotting the table. That is the invariant this course debugs. A
replicator also starts from a plan: the region pair is approved and the conflict policy is chosen
before the first change moves. Every apply attempt carries the change id so the target can dedupe a
call that timed out after it was applied, progress is one event per applied batch keyed by shard,
and the lag read is a proof, not a report: it samples keys in both regions and names the shards
that disagree.

## What you build here

One service, **replicatord**, with five pieces:

1. \`POST /v1/replications\`: authenticated operator, an approved ordered region pair, a bounded
   shard set, and a conflict policy from the documented set, frozen for the replication's life
   (\`PATCH\` answers \`409\`). Last-write-wins is refused above \`SKEW_BOUND_MS\` of clock skew.
2. A **Redis** offset store: \`offset:{replication}:{shard}\` holds the applied offset as a number,
   with **no TTL**, written by a forward-only compare-and-set after the target confirms, so a
   restart resumes where the shard stopped.
3. A **gRPC** apply client: a **3 s** deadline per attempt, at most **3** attempts, the change id on
   every attempt, and a schema mismatch that halts the shard with a named diff instead of retrying.
4. A **Kafka** progress path: one \`replication.applied\` event per confirmed batch, keyed by shard,
   carrying offset, applied and rejected counts, with an outbox row when the broker rejects it.
5. \`GET /v1/replications/{id}/lag\`: per-shard offsets and lag in changes, a digest sample across
   both regions that names the divergent shards, and a \`404\` for a foreign replication.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. Debug it against the failure modes, fix it, optimize what is wasteful, and prove the
fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Region provisioning, TLS and credentials between regions, backfill and snapshot bootstrapping,
schema registry management, operator UIs, cost of cross-region traffic, and compaction of the
source region's change log.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Operator', sub: 'create · lag', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'Replicator API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'store', kind: 'db', label: 'Postgres', sub: 'replications · outbox', x: 46, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'offsets · digests', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'replication.applied', sub: 'key = shard', x: 46, y: 88},
      {id: 'target', kind: 'grpc', label: 'Target region', sub: 'Apply / Digest', x: 70, y: 26},
      {id: 'source', kind: 'external', label: 'Source region', sub: 'change log · clock', x: 70, y: 64},
      {id: 'consumer', kind: 'service', label: 'Lag consumer', sub: 'group replication-lag', x: 90, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'store', kind: 'plain', label: 'replications · outbox'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'offsets · digests'},
      {from: 'api', to: 'target', kind: 'grpc', label: 'Apply'},
      {from: 'api', to: 'source', kind: 'plain', label: 'change log · skew'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce replication.applied'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'lag counters'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
