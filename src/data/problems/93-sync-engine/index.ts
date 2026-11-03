import type {Problem} from '@/lib/types';

import {pushEndpointStep} from './steps/1-endpoint';
import {cursorStateStep} from './steps/2-state';
import {mergeClientStep} from './steps/3-dependency';
import {changeEventsStep} from './steps/4-events';
import {pullReadStep} from './steps/5-read';

/**
 * Sync engine: the course is not "upload a file to a server", it is the debugging you owe a sync
 * layer before it eats a day of a user's work. A push validated against a base revision the server
 * actually issued → per-device cursors that advance with the batch they represent under a monotonic
 * watermark → three-way merges over gRPC that surface conflicts instead of picking a winner →
 * document-keyed change events with an outbox → a pull endpoint whose watermark covers exactly the
 * entries it returned.
 */
export const syncEngineProblem: Problem = {
  id: 'sync-engine',
  title: 'Sync Engine',
  tagline: 'Bidirectional document sync with base revisions, per-device cursors and a resumable watermark.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Sync Engine

A sync engine lets a laptop, a phone and a web tab edit the same documents, including offline, and
still converge. Whether a user loses work depends on the base revision a change is applied against,
the cursor that records what a device already received, the merge policy for two edits of one
document, and the durability of the stream every device reads from.

## The real system

Dropbox's HTTP API shows the shape a pull side settles into: \`files/list_folder\` returns a page of
entries plus an opaque \`cursor\` and a \`has_more\` flag, and \`files/list_folder/continue\` resumes
from that cursor, so a client that was away for a month pages through what it missed instead of
relisting everything. The push side is optimistic in the same spirit: the server accepts changes
only against a base revision it issued, and a stale base is a per-document conflict, not an
overwrite.

## What you build here

One service, **syncd**, with five pieces:

1. \`POST /v1/sync/push\`: a device id, a base revision the server issued, and a bounded change list
   with a content hash per change (400 on a malformed hash, 413 over the cap). A stale base yields
   per-document conflicts, not blind applies.
2. A **Redis** cursor store: one cursor per device that never expires and advances only after its
   batch is applied, plus a server watermark that is monotonic under concurrent advances.
3. A **gRPC** three-way merge client: a 2-second deadline, at most two attempts on
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, terminal rejections, and a failure that marks the document
   conflicted with both revisions retained.
4. A **Kafka** \`sync.change\` event per applied or conflicted document, keyed by document id, with
   revision and content hash, published after the apply commits, with an outbox on rejection.
5. \`GET /v1/sync/pull\`: changes after the device's cursor, capped at 1000 entries, with a watermark
   covering exactly the entries returned so a device that hits the cap resumes instead of skipping.

## The debugging habit

Every starter is working code with flaws: it compiles, syncs the demo document and looks right.
Debug it against the failure modes a returning laptop produces, fix it, and prove the fix with checks
that fail on the starter.

## Left out on purpose

Blob storage, end-to-end encryption, sharing and permissions, CRDT operation logs, battery-aware
scheduling, and the conflict-resolution UI.`,
  diagram: {
    nodes: [
      {id: 'device', kind: 'client', label: 'Device', sub: 'push · pull', x: 8, y: 50},
      {id: 'sync', kind: 'http', label: 'Sync Engine', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'revisions', kind: 'db', label: 'revisions · outbox', sub: 'issued · applied', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'cursors · watermark', x: 44, y: 50},
      {id: 'merger', kind: 'grpc', label: 'Merge service', sub: 'ThreeWayMerge', x: 66, y: 30},
      {id: 'kafka', kind: 'kafka', label: 'sync.change', sub: 'key = document id', x: 44, y: 86},
      {id: 'audit', kind: 'service', label: 'Audit consumer', sub: 'group audit', x: 66, y: 86},
    ],
    edges: [
      {from: 'device', to: 'sync', kind: 'http', label: 'push · pull'},
      {from: 'sync', to: 'revisions', kind: 'plain', label: 'apply against base'},
      {from: 'sync', to: 'redis', kind: 'redis', label: 'cursor · watermark'},
      {from: 'sync', to: 'merger', kind: 'grpc', label: 'ThreeWayMerge · 2 s'},
      {from: 'merger', to: 'revisions', kind: 'plain', label: 'merge revisions'},
      {from: 'sync', to: 'kafka', kind: 'kafka', label: 'produce sync.change'},
      {from: 'kafka', to: 'audit', kind: 'kafka', label: 'consume'},
      {from: 'audit', to: 'revisions', kind: 'plain', label: 'audit appended'},
    ],
  },
  steps: [pushEndpointStep, cursorStateStep, mergeClientStep, changeEventsStep, pullReadStep],
};
