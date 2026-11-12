import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {pushEndpointStep} from './steps/1-endpoint';
import {applyStateStep} from './steps/2-state';
import {mergeClientStep} from './steps/3-dependency';
import {changeEventsStep} from './steps/4-events';
import {pullReadStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Sync engine: the course is not "upload a file to a server", it is the debugging you owe a sync
 * layer before it eats a day of a user's work. A push that applies each change only against the
 * revision the device edited → one Lua apply that compares the base and takes a server-wide revision
 * → three-way merges over gRPC that keep both edits when they fail → document-keyed change events
 * after the apply, with an outbox → a pull whose cursor covers exactly the page it returned.
 */
export const syncEngineProblem: Problem = {
  id: 'sync-engine',
  title: 'Sync Engine',
  tagline:
    'Base revisions per document, a Lua apply, gRPC three-way merges, document-keyed events and a resumable pull cursor.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Sync Engine

A sync engine lets a laptop, a phone and a web tab edit the same documents, offline included, and
still converge. Whether a user loses work comes down to which revision a device edited, whether the
server applies the change only against that revision, what happens when two edits of one document
meet, and whether a device paging through what it missed sees every change once.

## The real system

Dropbox's HTTP API shows both halves. On the push side, \`files/upload\` in \`update\` mode carries
the \`rev\` the client last saw and overwrites only while it still matches the file's current
\`rev\`; otherwise the write is a conflict. Every file's metadata carries a \`content_hash\` the
client checks the bytes against. On the pull side, \`files/list_folder/continue\` takes the opaque
\`cursor\` of the last page and answers the next one with a new cursor and \`has_more\`, so a client
that was away for a month pages through what it missed instead of relisting everything.

## What you build here

One service, **syncd**, with five pieces that share one document store (\`docsync.store\`, provided)
and one apply (\`apply_change\`, built in step 2 and provided to the other steps as
\`docsync.revisions\`):

1. \`POST /v1/sync/push\` with \`X-Device-Id\` and
   \`{"changes": [{"doc_id", "base_revision", "content_hash", "body"}]}\` (at most 500): each change
   is applied only against the revision it edited, and the answer is
   \`{"applied": [{"doc_id", "revision"}], "conflicts": [{"doc_id", "base_revision", "current_revision"}]}\`.
2. A **Redis** apply: one Lua script on \`doc:{id}\` that compares the base, takes the next revision
   from \`rev:seq\`, keeps the revision under \`doc:{id}:r{n}\` and scores the document in the
   \`changes\` log; a body the head already has is \`unchanged\`.
3. A **gRPC** \`Merger.ThreeWayMerge\` for a conflicted change: a 2-second deadline, two attempts on
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, and a failed merge that keeps the device's edit beside the
   head (\`store.mark_conflicted\`).
4. A **Kafka** \`sync.change\` event per applied change, keyed by document id, carrying the revision
   and the content hash, produced after the apply by an idempotent producer, with an \`outbox\` row
   when the broker does not take it.
5. \`GET /v1/sync/pull?cursor={revision}&limit={n}\`: the documents changed after the cursor in
   revision order, at most 1000, with the \`cursor\` to resume from and \`has_more\`.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it syncs the demo devices, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Blob storage and chunked uploads, end-to-end encryption, sharing and permissions, CRDT operation
logs, tombstones for deleted documents, and the conflict-resolution UI.`,
  diagram: {
    nodes: [
      {id: 'device', kind: 'client', label: 'Device', sub: 'push · pull', x: 8, y: 50},
      {id: 'sync', kind: 'http', label: 'syncd', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'doc:{id} · rev:seq · changes', x: 48, y: 22},
      {id: 'merger', kind: 'grpc', label: 'Merger', sub: 'ThreeWayMerge · 2 s', x: 70, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'sync.change', sub: 'key = doc id', x: 48, y: 82},
      {id: 'audit', kind: 'service', label: 'Audit consumer', sub: 'group audit', x: 72, y: 82},
    ],
    edges: [
      {from: 'device', to: 'sync', kind: 'http', label: 'push · pull'},
      {from: 'sync', to: 'redis', kind: 'redis', label: 'apply · changes log · outbox'},
      {from: 'sync', to: 'merger', kind: 'grpc', label: 'base · local · remote'},
      {from: 'sync', to: 'kafka', kind: 'kafka', label: 'produce after apply'},
      {from: 'kafka', to: 'audit', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [pushEndpointStep, applyStateStep, mergeClientStep, changeEventsStep, pullReadStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
