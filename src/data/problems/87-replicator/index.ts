import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Geo replicator: the course is not "copy rows to another region", it is the debugging you owe a
 * replication controller before it moves a tenant's data. An approved region pair with a frozen
 * conflict policy → per-shard offsets that are durable and only move forward → an apply client with
 * a deadline, bounded retries, one change id per change and a halt on schema mismatch → one
 * `replication.applied` event per confirmed batch, keyed by shard, with an outbox → a lag read that
 * reports every shard and names the ones whose rows disagree.
 */
export const replicatorProblem: Problem = {
  id: 'replicator',
  title: 'Geo Replicator',
  tagline: 'Shard offsets in Redis, change ids on gRPC applies, shard-keyed events and a digest check across regions.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Geo Replicator

A geo replicator copies a shard's changes from a source region to a target region. Whether the
target ends up holding the right rows is decided by four things: which policy resolves a conflict,
where each shard resumes after a restart, whether a retried apply is recognised as the same change,
and whether anyone compares the two regions afterwards.

## The real system

Debezium, the open-source change-data-capture platform, treats the position in the source's change
log as the one thing a restart must not lose: running on Kafka Connect, it stores each connector's
offsets in the \`offset.storage.topic\`, a compacted topic, and a restarted connector resumes from the
recorded position instead of snapshotting the tables again. After a crash it resumes from the last
flushed offset, so consumers see a few changes twice and must dedupe them. This course builds the
same contract for one replicator: durable per-shard offsets, applies that are safe to repeat, and
progress events a lag consumer can trust.

## What you build here

One service, **replicatord**, with five pieces. Every step imports the \`replication\` package
(provided): \`store\` (replications as \`replication:{id}\` hashes, and \`insert_outbox\`), \`regions\`
(\`clock_skew_ms\`, \`source_head_offset\`, \`sample_keys\`, \`key_digest\`) and \`offsets\`
(\`offset_key\`, \`advance_offset\`, \`resume_offset\`: step 2's functions, provided to the later steps).

1. \`POST /v1/replications\` \`{source_region, target_region, shards, conflict_policy}\` and
   \`PATCH /v1/replications/{id}\`: an approved ordered region pair, a required policy from the
   documented set, last-write-wins refused above \`SKEW_BOUND_MS\`, and a policy frozen once set.
2. A **Redis** offset per shard, \`offset:{replication}:{shard}\`: no TTL, moved forward by a Lua
   compare-and-set that compares numbers.
3. A **gRPC** \`TargetRegion.ApplyChange\` client: a 3 s deadline, at most 3 attempts on retryable
   codes, the change id on every attempt, \`SchemaMismatch\` on \`FAILED_PRECONDITION\`, and the offset
   advanced only after the target confirmed.
4. A **Kafka** \`replication.applied\` event per confirmed batch, keyed \`{replication}:{shard}\`, with
   \`offset\`, \`applied\` and \`rejected\`, from an idempotent \`acks=all\` producer, and an outbox row when
   the delivery fails.
5. \`GET /v1/replications/{id}/lag\`: per-shard offset, head and lag, a digest sample of each shard in
   both regions, and the divergent shards named; another operator's replication is \`404\`.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Region provisioning, credentials between regions, snapshot bootstrapping, schema migration itself,
the outbox relay, and the cost of cross-region traffic.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Operator', sub: 'create · lag', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'replicatord', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'store', kind: 'db', label: 'replications store', sub: 'replication:{id} · outbox', x: 46, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'offset:{replication}:{shard}', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'replication.applied', sub: 'key = {replication}:{shard}', x: 46, y: 88},
      {id: 'target', kind: 'grpc', label: 'Target region', sub: 'ApplyChange · 3 s', x: 70, y: 26},
      {id: 'source', kind: 'external', label: 'Source region', sub: 'head offsets · digests · skew', x: 70, y: 64},
      {id: 'consumer', kind: 'service', label: 'Lag consumer', sub: 'group replication-lag', x: 90, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'store', kind: 'plain', label: 'create · get · insert_outbox'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'advance_offset · resume_offset'},
      {from: 'api', to: 'target', kind: 'grpc', label: 'ApplyChange(change_id)'},
      {from: 'api', to: 'source', kind: 'plain', label: 'skew · head · digests'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after the offset moved'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
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
