import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Comments service: the course is not "write a CRUD endpoint", it is the debugging you owe a
 * comment service before real threads scroll through it. Validated, idempotent replies → Redis
 * counters committed atomically with the write → a moderation and notification fan-out with a
 * deadline and one token per comment → comment events keyed by thread, published after the commit,
 * without bodies → a keyset-paginated read that yields every comment exactly once while the thread
 * keeps moving.
 */
export const commentsServiceProblem: Problem = {
  id: 'comments-service',
  title: 'Comments Service',
  tagline: 'Threaded comments with idempotent replies, atomic counters and cursor pagination.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Comments Service

A comments service looks like the easiest CRUD in the platform. What decides correctness is
elsewhere: replies proven to belong to their thread, retries that produce one comment, counters
committed with the comment, fan-out calls that survive a timeout, and pagination that holds while
others keep writing.

## The real system

Disqus, which hosts comment threads for millions of sites, paginates its public API with cursors:
\`posts/list\` returns a \`cursor\` object with an opaque \`next\` token and a \`hasNext\` flag, and
most endpoints give no \`total\` at all, because a count is a different question from a position.
That is the read side of this course; the write side adds idempotency keys, an enforced reply tree,
escaped storage, counters updated atomically with the comment, and a moderation timeout that becomes
an asynchronous review flag rather than a failed post.

## What you build here

One service, **commentsd**, with five pieces:

1. \`POST /v1/comments\`: authenticated tenant, a validated thread and parent (same-thread only,
   else \`422\`), a body capped at 16 KiB, an \`Idempotency-Key\` whose replay returns the original
   comment, and escaped storage with rendering derived from a safe subset.
2. **Redis** counters and a hot-thread cache: \`thread:{tenant}:{thread}:count\` committed atomically
   next to the comment write, per-parent reply counters, tenant-scoped hot-thread keys with a TTL,
   and a recount from the durable store that has to match the counter.
3. The **gRPC** fan-out: moderation and author notification under a 500 ms deadline, each carrying
   the comment id as its idempotency token, a moderation timeout flagged for asynchronous review
   instead of blocking the API, and a notification failure that cannot cancel moderation.
4. The **Kafka** event path: \`comment.event\` keyed by thread id, published after the commit,
   carrying comment id, parent id and edit revision, and no body.
5. \`GET /v1/threads/{id}/comments\`: cursor pagination on \`(created_at, id)\`, top-level comments
   with their reply counts, tombstones for deleted comments, and a page that is stable while new
   comments arrive.

## The debugging habit

Every starter compiles, serves the happy path and hides flaws. Debug it against the failure modes,
fix it, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Attachments, mentions, edit history, search indexing, spam scoring, tenant webhooks and the review
queue UI.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'web · mobile', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Comments API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'comment store', sub: 'comments · outbox', x: 46, y: 14},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'counters · hot threads', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'comment.event', sub: 'key = thread', x: 46, y: 86},
      {id: 'moderation', kind: 'grpc', label: 'Moderation', sub: 'CheckComment', x: 70, y: 16},
      {id: 'notifier', kind: 'grpc', label: 'Notifier', sub: 'NotifyAuthor', x: 70, y: 40},
      {id: 'review', kind: 'service', label: 'Review queue', sub: 'async moderation', x: 70, y: 64},
      {id: 'consumer', kind: 'service', label: 'Read model', sub: 'group read-models', x: 70, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'insert · page'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'counters · hot threads'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce comment.event'},
      {from: 'api', to: 'moderation', kind: 'grpc', label: 'CheckComment'},
      {from: 'api', to: 'notifier', kind: 'grpc', label: 'NotifyAuthor'},
      {from: 'api', to: 'review', kind: 'plain', label: 'flag for review'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'recount'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
