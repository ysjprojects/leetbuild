import type {Problem} from '@/lib/types';

import {checkpointEndpointStep} from './steps/1-endpoint';
import {uploadStateStep} from './steps/2-state';
import {storageClientStep} from './steps/3-client';
import {checkpointEventsStep} from './steps/4-events';
import {readCheckpointStep} from './steps/5-read';

/**
 * Checkpoint store on the AI-era track: the course is not "write a chunk to a bucket", it is the
 * review you owe a model-generated checkpoint path before a training run resumes from it. Chunked,
 * resumable writes whose replays are idempotent → an atomic Redis commit marker written only for a
 * complete chunk set → object-store calls that verify before acknowledging → run-keyed checkpoint
 * events with an outbox → a read endpoint that serves only committed, verified checkpoints.
 */
export const checkpointStoreProblem: Problem = {
  id: 'checkpoint-store',
  title: 'Checkpoint Store',
  tagline: 'Checkpoints that are cheap to write, safe to read and correct after crashes.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Checkpoint Store

A checkpoint store is the piece of a training platform that decides whether a crashed job resumes
from its weights or from garbage, and the only thing that makes that decision is what the store
proves before it says yes. The visible part is a chunk upload; the parts that decide whether the
system is safe are the chunk ordering rule, the commit marker, the acknowledgment contract with the
object store, and the read that a resumed run trusts.

## The real system

Production checkpoint paths stream weights in fixed-size chunks under an upload id, so a run that
loses its connection re-sends one chunk instead of a hundred gigabytes. They accept a chunk only at
its expected position, treat a redelivered chunk as a no-op, and never let a chunk written out of
order reorder the weights. Upload state lives in Redis with a TTL, because an abandoned upload that
never expires pins memory and blocks the reuse of its id. A commit marker — one key, written by one
atomic script, after the complete chunk set has arrived — is the only state a reader checks, so a
reader can never observe half a checkpoint as a checkpoint. Chunks go to an object store over gRPC
under a deadline, and a chunk is acknowledged only once the store confirms its checksum: an
acknowledgment that runs ahead of verification is a promise the platform cannot keep. Events are
keyed by training run, so a run's checkpoints stay ordered, and the commit event leaves the service
only after the marker is durable. The read endpoint returns the latest *committed* checkpoint of
the caller's run, refuses to serve one whose verification has not passed, and hands out a URL that
expires.

## What you build here

One service, the checkpoint store, with five pieces:

1. \`POST /v1/checkpoints\`: a chunk of at most **8 MiB** under an upload id, accepted only at its
   expected index, stored at its index so a replay **overwrites** rather than appends, digested with
   sha256, and never completing an upload on a caller-declared byte count.
2. A **Redis** upload state: the received chunk indexes as a set, an \`EXPIRE\` on first write so
   abandoned uploads expire, and one atomic \`EVAL\` that writes the commit marker only when the
   stored set covers every expected chunk.
3. A **gRPC** object-store client: a **30-second** deadline on every call, the chunk acknowledged
   only after the store confirms its checksum, at most three attempts, only
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\` retried, and a \`PERMISSION_DENIED\` that stops the upload
   with a visible reason.
4. A **Kafka** event path: one \`checkpoint.event\` per chunk accept, commit and verification keyed
   by **training run**, carrying step number, chunk counts and digests, published after the commit
   marker is durable, durable through an outbox when the broker rejects the produce.
5. \`GET /v1/runs/{id}/checkpoints/latest\`: the latest committed checkpoint of the caller's run, its
   step number, verification status and last verified chunk, a signed URL that expires in
   **15 minutes**, and a **404** for an uncommitted, missing or foreign run.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Model architecture and optimizer state formats, multi-region replication of the object store,
lifecycle policies for old checkpoints, resumable download of a chunk range to the trainer, cost
accounting per storage class, and garbage collection of superseded checkpoints. The five pieces
above are the ones that decide whether a checkpoint is written cheaply, read safely and correct
after a crash.`,
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
