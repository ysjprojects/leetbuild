import type {Problem} from '@/lib/types';

import {checkpointEndpointStep} from './steps/1-endpoint';
import {uploadStateStep} from './steps/2-state';
import {storageClientStep} from './steps/3-client';
import {checkpointEventsStep} from './steps/4-events';
import {readCheckpointStep} from './steps/5-read';

/**
 * Checkpoint store: chunked, resumable writes whose replays are idempotent, an atomic Redis commit
 * marker written only for a complete chunk set, object-store calls that verify before
 * acknowledging, run-keyed checkpoint events with an outbox, and a read endpoint that serves only
 * committed, verified checkpoints.
 */
export const checkpointStoreProblem: Problem = {
  id: 'checkpoint-store',
  title: 'Checkpoint Store',
  tagline: 'Chunked weight uploads behind a commit marker a resumed training run can trust.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Checkpoint Store

A checkpoint store decides whether a crashed training job resumes from its weights or from garbage.
The visible part is a chunk upload; the parts that make it safe are the chunk ordering rule, the
commit marker, the acknowledgment contract with the object store, and the read a resumed run
trusts.

## The real system

Amazon S3 multipart upload is the shape most checkpoint paths copy. A client opens an upload id,
sends parts under consecutive part numbers, and can attach a per-part SHA-256 checksum that S3
verifies before storing the part; a part re-sent under the same number replaces the earlier one.
The object does not exist for readers until \`CompleteMultipartUpload\` lists every part, and a
bucket lifecycle rule aborts uploads that were never completed. Training frameworks layer a
manifest, a step number and a verification record on top, and hand out pre-signed download URLs
that expire.

## What you build here

Five pieces of one service:

1. \`POST /v1/checkpoints\`: a chunk of at most **8 MiB** under an upload id, accepted only at its
   expected index, stored at its index so a replay **overwrites**, digested with sha256, and
   complete only when the stored chunk set says so.
2. A **Redis** upload state: received indexes as a set with an \`EXPIRE\` on first write, and one
   atomic \`EVAL\` that writes the commit marker only for a complete set.
3. A **gRPC** object-store client: a **30-second** deadline per call, acknowledgment only after the
   store confirms the checksum, at most three attempts and only \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`
   retried, and a \`PERMISSION_DENIED\` that stops the upload with a visible reason.
4. A **Kafka** event path: one \`checkpoint.event\` per accept, commit and verification, keyed by
   **training run**, carrying step number, chunk count and digest, published after the marker is
   durable, written to an outbox when the broker rejects the produce.
5. \`GET /v1/runs/{id}/checkpoints/latest\`: the latest committed checkpoint of the caller's run,
   its step, verification status and last verified chunk, a signed URL that expires in
   **15 minutes**, and a **404** for an uncommitted, missing or foreign run.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path, and looks right. Your
job in every step is to debug it against the failure modes, fix it, optimize what is wasteful, and
prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Optimizer state formats, multi-region replication, lifecycle policies for old checkpoints, resumable
download of a chunk range, cost accounting per storage class, and garbage collection of superseded
checkpoints.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Training job', sub: 'chunk · resume', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Checkpoint API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'state · marker', x: 46, y: 12},
      {id: 'db', kind: 'db', label: 'run · checkpoint', sub: 'steps · manifests', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'checkpoint.event', sub: 'key = run', x: 46, y: 86},
      {id: 'store', kind: 'grpc', label: 'Object store', sub: 'Write / Verify · 30 s', x: 70, y: 20},
      {id: 'verifier', kind: 'service', label: 'Verifier', sub: 'background pass', x: 70, y: 50},
      {id: 'consumer', kind: 'service', label: 'Event consumer', sub: 'group runs', x: 70, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'state · marker'},
      {from: 'api', to: 'db', kind: 'plain', label: 'run · checkpoint rows'},
      {from: 'api', to: 'store', kind: 'grpc', label: 'WriteChunk / VerifyChunk'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce checkpoint.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'step rows'},
      {from: 'store', to: 'verifier', kind: 'grpc', label: 'chunk read back'},
      {from: 'verifier', to: 'db', kind: 'plain', label: 'verification status'},
    ],
  },
  steps: [checkpointEndpointStep, uploadStateStep, storageClientStep, checkpointEventsStep, readCheckpointStep],
};
