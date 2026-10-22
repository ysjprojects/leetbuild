import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Geo replicator on the AI-era track: the course is not "copy rows to another region", it is the
 * review you owe a model-generated replication controller before it is allowed to move a tenant's
 * data. A replication that names an immutable, approved conflict policy → durable per-shard offsets
 * that never rewind → idempotent applies with a deadline, bounded retries and a halting schema
 * mismatch → applied events keyed by shard with the confirmed offsets and the rejected counts → a
 * lag read that samples digests and shows the divergent shards instead of hiding them.
 */
export const replicatorProblem: Problem = {
  id: 'replicator',
  title: 'Geo Replicator',
  tagline: 'Replicate across regions with a fixed conflict policy and provable convergence.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Geo Replicator

A geo replicator is the part of a platform that keeps a shard's writes visible in another region:
it decides how conflicting writes are ordered, which offset each shard has already applied, how a
change is re-applied when a call times out, how progress is published, and how anyone proves the two
regions actually agree. The visible part is a second region serving reads; the parts that decide
whether the data is correct are the conflict policy, the offsets, the apply contract and the
divergence check.

## The real system

Production replicators start from a plan, not from a caller's wish: the region pair must be
approved, and the conflict policy — source-wins, version vector, manual — is chosen before the
first change moves because it decides how every future conflict is ordered. Wall-clock ordering is
only sound while the two regions' clocks agree, so last-write-wins is gated by a measured skew
bound. Each shard keeps an applied offset that is durable and moves in one direction only: it
advances after the target confirms application, never regresses when a confirmation arrives out of
order, and survives an idle period, because an offset that expires replays months of history.
Changes cross the region boundary over gRPC under a deadline with a bounded number of attempts, and
every attempt carries the change id so the target can dedupe a call that timed out after it was
applied; a schema mismatch is not retried, it halts the shard with the diff that explains it.
Progress is published as one event per applied batch, keyed by shard so a shard's stream stays
ordered, carrying the offsets and change counts, with rejected changes counted rather than dropped.
And the lag read is a proof, not a report: per-shard offsets, lag in changes, and a divergence
sample that digests N keys in both regions and names the shards that disagree.

## What you build here

One service, **replicatord**, with five pieces:

1. \`POST /v1/replications\`: authenticated operator, an approved ordered region pair, a bounded
   shard set, and a conflict policy from the documented set that is frozen for the replication's
   life (\`PATCH\` answers \`409\` on a change). Last-write-wins is refused when the measured clock
   skew between the two regions exceeds \`SKEW_BOUND_MS\`.
2. A **Redis** offset store: \`offset:{replication}:{shard}\` holds the applied offset as a number,
   with **no TTL**, written by a compare-and-set that only moves forward, and advanced only after
   the target confirms — so a restart resumes exactly where the shard stopped.
3. A **gRPC** apply client: a **3 s** deadline per attempt, at most **3** attempts, the change id on
   every attempt so the target dedupes, and a schema mismatch that halts the shard with a named
   diff instead of retrying forever.
4. A **Kafka** progress path: one \`replication.applied\` event per confirmed batch, keyed by shard,
   carrying offset, applied and rejected counts, published **after** the confirmation, with an
   outbox row when the broker rejects the produce.
5. \`GET /v1/replications/{id}/lag\`: per-shard offsets and lag in changes, a divergence check that
   samples N keys and compares digests between the regions, the divergent shards named in the
   response, and a \`404\` for a replication the caller does not own.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real platform
team: read the draft against the failure modes, name the subtle one, fix it, and prove the fix with
checks that fail on the draft and pass on your version.

## Left out on purpose

Region provisioning, TLS and credentials between regions, backfill and snapshot bootstrapping,
schema registry management, operator UIs, cost of cross-region traffic, and the compaction of the
source region's change log. The five pieces above are the ones that decide whether the replica is
correct, convergent and safe to operate.`,
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
