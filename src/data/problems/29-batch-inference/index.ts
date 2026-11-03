import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Batch inference: the debugging a batch pipeline owes before it spends a million model calls and
 * then misreports them. An idempotent, capped submit sized from a sealed manifest → shard leases in
 * Redis scripts (claim, owner-only heartbeat, fenced completion, a reaper that requeues) → per-record
 * model calls with a deadline, bounded retries, contained poison records and a pinned model version →
 * batch-keyed shard events after the output object is written, an outbox, a coordinator that folds once
 * before it commits → a status read that counts the live shard set. The model server is a
 * deterministic stand-in the harness serves over gRPC.
 */
export const batchInferenceProblem: Problem = {
  id: 'batch-inference',
  title: 'Batch Inference Service',
  tagline:
    'A million-record batch: a sealed manifest, leased shards, a pinned model, a status read from the shard set.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Batch Inference Service

Batch inference is how most model work runs: a tenant uploads a manifest of records, workers run the
model over shards of it, and the tenant polls for a status. The model call is the easy part. The
hard parts are a batch submitted twice, a worker that dies holding a shard, a record the model cannot
parse, and a status that says "completed" while shards still run.

## The real system

OpenAI's Batch API is the documented shape of this service: a batch is created from an uploaded file
of requests with a 24-hour completion window, moves through \`validating\`, \`in_progress\` and
\`finalizing\` to \`completed\`, \`failed\`, \`expired\` or \`cancelled\`, and reports \`request_counts\`
(\`total\`, \`completed\`, \`failed\`). Successful outputs land in one file and failed requests in a
separate error file, so a batch with failed requests still reports exactly which ones failed.

## What you build here

One service, **batchd**, its workers and a coordinator, sharing one contract: the \`batch\` support
package (\`config\`: the model server's address, the topic, \`SHARD_SIZE\` = 1000, \`MAX_RECORDS\`,
\`LEASE_S\`, the key layout).

1. \`POST /v1/batches\` with \`{manifest_uri, model}\`: sized from the manifest's \`HEAD\` (only once it
   is sealed), at most one million records, stored under \`(tenant, Idempotency-Key)\`, its shards
   seeded on \`batch:pending:{id}\`.
2. **Shard leases** in Redis: \`claim\`, \`heartbeat\`, \`complete\` and \`reap\` over the pending list,
   the owners hash, the deadlines sorted set and the shard set (\`pending\`, \`running\`, \`done\`,
   \`failed\`), each one Lua script.
3. **Model calls** (gRPC, a stand-in the checks serve): a 5-second deadline per attempt, \`UNAVAILABLE\`
   retried at most twice, a failed record contained to its own line, the batch's model pinned on
   every request.
4. **Kafka**: one \`batch.shard\` event per shard, keyed by batch, after its output object is written,
   with an outbox row from the delivery report; a coordinator that folds each shard into
   \`batch:outputs:{id}\` and \`batch:totals:{id}\` once, then commits.
5. \`GET /v1/batches/{id}\`: the tenant's batch only, status and counts from the live shard set and the
   folded totals, \`completed\` only when every shard is done.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path and looks right. The task
says where the flaws live; the checks say what must change.

## Left out on purpose

Provider accounts, per-record model selection, tokenizers, cost accounting, the outbox relay, worker
autoscaling and output retention. The five pieces above decide whether a batch runs once, finishes,
and reports what it did.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · poll', x: 8, y: 50},
      {id: 'batchd', kind: 'http', label: 'batchd', sub: 'POST · GET batches', x: 27, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'jobs · pending · leases · shards', x: 46, y: 14},
      {id: 'worker', kind: 'service', label: 'Workers', sub: 'claim · run · publish', x: 46, y: 50},
      {id: 'model', kind: 'grpc', label: 'Model server', sub: 'Infer · 5 s', x: 70, y: 14},
      {id: 'store', kind: 'external', label: 'Object store', sub: 'manifests · outputs', x: 70, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'batch.shard', sub: 'key = batch_id', x: 46, y: 86},
      {id: 'coordinator', kind: 'service', label: 'Coordinator', sub: 'fold · commit', x: 70, y: 86},
    ],
    edges: [
      {from: 'client', to: 'batchd', kind: 'http', label: 'POST / GET batches'},
      {from: 'batchd', to: 'store', kind: 'plain', label: 'HEAD manifest'},
      {from: 'batchd', to: 'redis', kind: 'redis', label: 'job · seed shards · read'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'EVALSHA claim · heartbeat · complete'},
      {from: 'worker', to: 'model', kind: 'grpc', label: 'Infer'},
      {from: 'worker', to: 'store', kind: 'plain', label: 'PUT output'},
      {from: 'worker', to: 'kafka', kind: 'kafka', label: 'produce'},
      {from: 'kafka', to: 'coordinator', kind: 'kafka', label: 'consume'},
      {from: 'coordinator', to: 'redis', kind: 'redis', label: 'fold outputs · totals'},
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
