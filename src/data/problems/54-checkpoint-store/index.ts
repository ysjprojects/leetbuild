import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {checkpointEndpointStep} from './steps/1-endpoint';
import {uploadStateStep} from './steps/2-state';
import {storageClientStep} from './steps/3-client';
import {checkpointEventsStep} from './steps/4-events';
import {readCheckpointStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Checkpoint store: the debugging a training run's resume path needs. Chunks staged at their own
 * index → one Lua commit that writes the record only for a complete chunk set and persists it →
 * object-store writes whose checksum is compared → run-keyed checkpoint events with an outbox → a
 * read that serves the caller's latest committed checkpoint behind a short-lived URL.
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
The upload is the visible part. What makes it safe is that every chunk sits at its own index, that a
commit record exists only for a complete chunk set, that the object store's checksum is compared,
and that the read a resumed run trusts serves nothing else.

## The real system

Orbax, the JAX checkpoint library, saves each step into a temporary directory and finalizes it
only when the save is complete. On storage without an atomic rename, such as object stores, its
\`CommitFileTemporaryPath\` marks completion with a \`commit_success\` file instead, so a reader never
mistakes a half-written step for a finished one. This course builds the same promise around a
commit record in Redis.

## What you build here

One service, **checkpointd**, on one upload store (\`checkpoint.store\`, provided: runs, uploads,
staged chunks, the outbox, signed URLs) and one commit (\`commit\` / \`latest_committed\`, built in
step 2 and provided to the later steps as \`checkpoint.commit\`):

1. \`POST /v1/checkpoints\` opens an upload \`{run_id, step, chunks}\`;
   \`PUT /v1/checkpoints/{upload_id}/chunks/{index}\` stages a chunk at its index
   (\`upload:{id}:chunks\`, \`upload:{id}:digests\`), 409 for a gap or a replay with other bytes.
2. A **Redis** commit: one Lua script writes \`checkpoint:{id}\` only when every chunk is staged,
   persists the upload and indexes it by step in \`run:{run_id}:checkpoints\`.
3. A **gRPC** object-store writer, \`store_chunk\`: \`PutObject\` under a 30 s deadline, the store's
   sha256 compared, three attempts for \`UNAVAILABLE\` or \`DEADLINE_EXCEEDED\`, \`UploadRejected\`
   for any other status.
4. A **Kafka** \`checkpoint.event\` keyed by run, produced after the commit by an idempotent
   producer, with the outbox as fallback.
5. \`GET /v1/runs/{run_id}/checkpoints/latest\`: the caller's latest committed checkpoint and a
   read URL that expires in **15 minutes**; another tenant's run is 404.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Optimizer state formats, sharded checkpoints written by many hosts at once, multi-region
replication, retention of old checkpoints, ranged reads of a chunk, and the copier that schedules
\`store_chunk\` for staged chunks.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Training job', sub: 'upload · resume', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'checkpointd', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'upload:{id} · checkpoint:{id}', x: 50, y: 14},
      {id: 'store', kind: 'grpc', label: 'Object store', sub: 'PutObject · 30 s', x: 50, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'checkpoint.event', sub: 'key = run id', x: 50, y: 86},
      {id: 'consumer', kind: 'service', label: 'Run tracker', sub: 'latest step per run', x: 74, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'put_chunk · COMMIT_LUA · latest_committed'},
      {from: 'api', to: 'store', kind: 'grpc', label: 'PutObject · sha256'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after the commit'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [checkpointEndpointStep, uploadStateStep, storageClientStep, checkpointEventsStep, readCheckpointStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
