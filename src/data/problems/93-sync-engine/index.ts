import type {Problem} from '@/lib/types';

import {pushEndpointStep} from './steps/1-endpoint';
import {cursorStateStep} from './steps/2-state';
import {mergeClientStep} from './steps/3-dependency';
import {changeEventsStep} from './steps/4-events';
import {pullReadStep} from './steps/5-read';

/**
 * Sync engine on the AI-era track: the course is not "upload a file to a server", it is the review
 * you owe a model-generated sync layer before it eats a day of a user's work. A push validated
 * against a base revision the server actually issued → per-device cursors that advance with the
 * batch they represent under a monotonic watermark → three-way merges over gRPC that surface
 * conflicts instead of picking a winner → document-keyed change events with an outbox → a pull
 * endpoint whose watermark covers exactly the entries it returned.
 */
export const syncEngineProblem: Problem = {
  id: 'sync-engine',
  title: 'Sync Engine',
  tagline: 'Bidirectional sync that detects conflicts honestly and resumes from a watermark.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Sync Engine

A sync engine is the piece of a product that lets a laptop, a phone and a web tab edit the same
documents — including offline — and still converge. The visible part is a document that looks up to
date; the parts that decide whether a user loses work are the base revision a change is applied
against, the cursor that records what a device already received, the merge policy for two edits of
one document, and the durability of the stream every device reads from.

## The real system

Production sync layers are optimistic: a client sends its base revision plus the changes it made,
and the server accepts those changes only if the base is a revision it issued. A device that has
been offline for a month is normal traffic, not an error — its base is stale, and the honest
answers are a per-document conflict or a merge, never a silent overwrite. Each device carries a
cursor that the server advances atomically with the batch it represents, so a crash cannot leave a
device that will never be sent its own lost changes, and a server watermark that only ever moves
forward lets a device tell "there is nothing new" from "you stopped mid-stream". Two edits of one
document are merged three-way — base, local, remote — over a bounded gRPC call with a deadline, and
a merge that cannot be performed is a conflict that retains both revisions instead of a winner
picked by upload time. Every applied change publishes a \`sync.change\` event keyed by document id
so a document's revision stream stays ordered, after the apply has committed, with an outbox row
when the broker rejects the produce. A device that has been idle for a week asks for what it missed:
deltas after its cursor, capped, with the watermark that covers exactly the entries returned.

## What you build here

One service, **syncd**, with five pieces:

1. \`POST /v1/sync/push\`: a device id, a base revision the server issued, and a bounded change list
   where every change names its document and a content hash (400 on a malformed hash, 413 when the
   list exceeds its cap). A stale base revision yields per-document conflicts, not blind applies.
2. A **Redis** cursor store: one cursor per device that never expires and advances only after the
   batch it represents is applied, plus a server watermark that is monotonic under concurrent
   advances.
3. A **gRPC** three-way merge client: a 2-second deadline, at most two attempts, retries only on
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, a rejection that is terminal, and a failure that marks the
   document conflicted with both revisions retained.
4. A **Kafka** change stream: one \`sync.change\` event per applied or conflicted document, keyed by
   document id, carrying the revision and the content hash, published only after the apply commits,
   with an outbox row when the produce is rejected.
5. \`GET /v1/sync/pull\`: changes after the device's cursor, capped at 1000 entries, cursor-based
   rather than offset-based, answering with a watermark that covers exactly the entries returned so
   a device that hits the cap resumes instead of skipping.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it syncs the demo
document, and it sounds confident. Your job in every step is the job you will have on a real sync
feature: read the draft against the failure modes a returning laptop produces, name the subtle one,
fix it, and prove the fix with checks that fail on the draft and pass on your version.

## Left out on purpose

File blob storage, end-to-end encryption, sharing and permission models, per-field document
schemas, CRDT operation logs, mobile battery-aware scheduling, and the conflict-resolution UI. The
five pieces above are the ones that decide whether a user's edits survive a weekend offline.`,
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
