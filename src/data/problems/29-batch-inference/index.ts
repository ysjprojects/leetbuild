import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Batch inference: the course is not "run a job over a file", it is the debugging you owe a batch
 * pipeline before it burns a million model calls and then lies about it. An idempotent, capped
 * submit whose manifest is durable before any shard starts → Redis claims with an atomic lease, a
 * heartbeat and a reaper so a dead worker's shard is retried → a per-shard model call bounded by a
 * deadline, two UNAVAILABLE retries and a contained failure → batch-keyed shard events published
 * only after the output is flushed, with an outbox and an idempotent fold → a read endpoint that
 * derives progress from the live shard set and never calls a partial batch a success.
 */
export const batchInferenceProblem: Problem = {
  id: 'batch-inference',
  title: 'Batch Inference Service',
  tagline:
    'A million-record batch: idempotent submit, leased shards, contained failures, a status endpoint that counts live shards.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Batch Inference Service

Batch inference is how most model work actually runs: a tenant hands over a manifest of a million
records, a fleet of workers runs the model over shards of it, and someone polls a status endpoint
for the result. The interesting parts are not the model call. They are whether the job started
twice, whether a worker that died took its shard with it, whether one poisoned record can fail the
whole batch, and whether the status endpoint reports the real state while shards are still running.

## The real system

OpenAI's Batch API is the documented shape of this service. A batch is created from an uploaded JSONL
file of at most 50,000 requests and 200 MB, with a fixed 24-hour completion window. The batch object
moves through \`validating\`, \`in_progress\`, \`finalizing\` and then \`completed\`, \`failed\`, \`expired\` or
\`cancelled\`, and carries \`request_counts\` with \`total\`, \`completed\` and \`failed\`. Successful outputs
land in one file (\`output_file_id\`) and failed requests in a separate error file (\`error_file_id\`),
so a partial batch is reported as partial rather than as a success. Internally the same mechanics
apply: an idempotent submit, a validated input before any work starts, shards claimed under a lease
so a crashed worker's work is retried, per-record failures contained to their record, and progress
derived from what the workers have actually finished.

## What you build here

One service, **batchd**, and its workers, with five pieces:

1. \`POST /v1/batches\`: authenticated tenant, a manifest of at most **one million** records, an
   \`Idempotency-Key\` so a replay returns the same job, and a start that happens only after the
   manifest is durably readable.
2. A **Redis** shard queue: each shard is claimed with an atomic \`SET … NX EX\` lease, renewed by a
   heartbeat that only its owner can extend, reclaimed by a reaper when the lease expires, and
   counted only after the shard completes.
3. A **gRPC** model client: a **5-second** deadline per call, at most **two retries** on
   \`UNAVAILABLE\`, a failure contained to its own shard, and a batch report that carries the failed
   count.
4. A **Kafka** completion path: one \`batch.shard\` event per finished shard keyed by the **batch
   id**, published only after the output object is flushed, carrying the shard id, counts and an
   output checksum, with an outbox row when the produce is rejected, and a coordinator that folds
   the shard into the manifest before it commits its offset.
5. \`GET /v1/batches/{id}\`: progress computed from the live shard set, with completed, failed and
   pending counts and a manifest of output objects — success only when every shard is terminal, and
   a foreign batch id is a \`404\`.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and it
looks right. Your job in every step is to debug it against the failure modes, find the subtle one, fix
it, optimize what is wasteful, and prove the fix with checks that fail on the starter and pass on
your version.

## Left out on purpose

Provider account management, model selection per record, tokenizers, cost accounting, autoscaling the
worker fleet, multi-region job placement, storage lifecycle rules, and dashboarding. The five pieces
above are the ones that decide whether a batch is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · poll', x: 8, y: 50},
      {id: 'batchd', kind: 'http', label: 'Batch Service', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'batch · outbox', sub: 'manifest · leases', x: 26, y: 12},
      {id: 'redis', kind: 'redis', label: 'work set', sub: 'claims · counters', x: 46, y: 12},
      {id: 'worker', kind: 'service', label: 'Worker pool', sub: 'shard leases', x: 46, y: 50},
      {id: 'model', kind: 'grpc', label: 'Model server', sub: 'Generate', x: 68, y: 12},
      {id: 'store', kind: 'external', label: 'Output store', sub: 'objects · checksums', x: 68, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'batch.shard', sub: 'key = batch', x: 46, y: 86},
      {id: 'coordinator', kind: 'service', label: 'Coordinator', sub: 'fold · progress', x: 68, y: 86},
    ],
    edges: [
      {from: 'client', to: 'batchd', kind: 'http', label: 'submit · poll'},
      {from: 'batchd', to: 'db', kind: 'plain', label: 'manifest · outbox'},
      {from: 'batchd', to: 'redis', kind: 'redis', label: 'enqueue shards'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'CLAIM · heartbeat'},
      {from: 'worker', to: 'model', kind: 'grpc', label: 'Generate'},
      {from: 'worker', to: 'store', kind: 'plain', label: 'PUT output'},
      {from: 'worker', to: 'kafka', kind: 'kafka', label: 'produce batch.shard'},
      {from: 'kafka', to: 'coordinator', kind: 'kafka', label: 'consume'},
      {from: 'coordinator', to: 'db', kind: 'plain', label: 'fold manifest'},
      {from: 'batchd', to: 'store', kind: 'plain', label: 'signed URL'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
