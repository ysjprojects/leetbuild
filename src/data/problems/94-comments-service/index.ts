import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Comments service on the AI-era track: the course is not "write a CRUD endpoint", it is the review
 * you owe a model-generated comment service before real threads scroll through it. Validated,
 * idempotent replies → Redis counters committed atomically with the write → a moderation and
 * notification fan-out with a deadline, one token per attempt and no cross-cancellation → comment
 * events keyed by thread, published after the commit, never carrying bodies → a keyset-paginated
 * read that yields every comment exactly once while the thread keeps moving.
 */
export const commentsServiceProblem: Problem = {
  id: 'comments-service',
  title: 'Comments Service',
  tagline: 'Threaded comments with stable pagination and moderation that never duplicates.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Comments Service

A comments service looks like the easiest CRUD in the platform: insert a row, list the rows. The
parts that decide whether it is correct are none of those. A reply has to be proven to belong to the
thread it claims, a retried request has to produce one comment rather than two, the counters a UI
trusts have to be committed with the comment instead of "shortly after", the moderation and author
notification calls have to survive a timeout without duplicating a ping or blocking the post, and
pagination has to keep its promise while other people keep writing.

## The real system

Production comment services accept writes from a validated endpoint, and every write carries an
idempotency key because clients, queues and proxies all retry. The reply tree is enforced, not
assumed: a parent from another thread is a client bug that the service refuses, not a comment it
grafts. Bodies are stored escaped and rendered from a safe subset, because between the write and the
read there is always another client. Per-thread counters live where the read path can afford to look
— a cache — but they are updated in the same atomic step as the comment, otherwise a crash between
the two leaves the UI showing fewer comments than exist. Moderation and notification leave the
process over gRPC under a deadline, each attempt carrying the comment id as its idempotency token, so
a retry pings an author once and a moderation timeout becomes an asynchronous review flag rather than
a failed post. Read models are fed by events keyed by thread, so one thread's stream stays ordered,
and published only after the comment is durable. The read path paginates by cursor, never by offset,
because "skip the first 20" means something different after 20 more people comment.

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
   instead of blocking the API, and a notification failure that can never cancel moderation.
4. The **Kafka** event path: \`comment.event\` keyed by thread id, published after the commit,
   carrying comment id, parent id and edit revision, and never the body.
5. \`GET /v1/threads/{id}/comments\`: cursor pagination on \`(created_at, id)\`, top-level comments
   with their reply counts, tombstones for deleted comments, and a page that is stable while new
   comments arrive.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Attachment uploads, mentions and notification digests, per-comment edit history, search indexing,
spam scoring models, webhooks to tenant systems, and the admin UI for the review queue. The five
pieces above are the ones that decide whether the service is correct, isolated and shippable.`,
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
