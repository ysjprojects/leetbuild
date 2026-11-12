import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Comments service: the course is not "write a CRUD endpoint", it is the debugging you owe a
 * comment service before real threads scroll through it. Idempotent, size-capped replies that stay
 * in their thread, rendered from escaped text → the comment and its counters in one Lua script →
 * moderation first under a deadline, one request id per comment → thread-keyed events after the
 * commit, without text → a cursor page that holds while the thread keeps moving.
 */
export const commentsServiceProblem: Problem = {
  id: 'comments-service',
  title: 'Comments Service',
  tagline: 'Threaded comments with idempotent replies, Lua-committed counters, moderation deadlines and cursor pages.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Comments Service

A comment thread looks like the easiest CRUD in a platform. It is also where a retry becomes a
duplicate reply, a counter drifts away from the comments it counts, a slow moderation call holds a
post open, and a page walk serves one comment twice while other people keep writing.

## The real system

Discourse, the open-source forum, keeps every post twice: \`raw\`, what the author typed, and
\`cooked\`, the sanitized HTML rendered once when the post is saved, so a read never runs the
renderer. This course keeps the same pair (\`text\` and \`html\`) and builds around it what a busy
thread leans on: idempotent writes, counters committed with the comment, moderation under a
deadline, ordered events and cursor pagination.

## What you build here

One service, **commentsd**, on one comment store (\`comments.store\`, provided). Redis stands in for
the database: a comment is one JSON document under \`comment:{tenant}:{id}\`, indexed in
\`thread:{tenant}:{thread}:comments\` by a store-wide sequence (ids \`c-1\`, \`c-2\`, …).

1. \`POST /v1/comments\` with \`X-Tenant-Id\` and \`Idempotency-Key\`: a retry answers the first
   comment, the text is capped at 16 KiB, a parent is in the same thread or the reply is 422, and
   \`html\` is rendered from escaped text.
2. **Redis** counters committed with the comment in one Lua script (\`commit_comment\`):
   \`thread:{tenant}:{thread}:count\`, the \`…:replies\` hash, the tenant's expiring
   \`hot:{tenant}\` list, and \`recount_thread\`. Later steps import them as \`comments.threads\`.
3. A **gRPC** fan-out (\`fanout\`): \`Moderation.CheckComment\` first, then
   \`Notifier.NotifyAuthor\` for an allowed comment, each under 500 ms with the comment id as
   \`request_id\`; a moderation timeout becomes \`pending_review\` on \`review:queue\`, a failed
   notification a \`notify:retry\` entry.
4. **Kafka** \`comment.event\`, keyed by thread id and produced after the commit by an idempotent
   producer: \`{type, tenant, comment_id, thread_id, parent_id, revision}\`, no text.
5. \`GET /v1/threads/{thread_id}/comments\`: newest first, 20 a page, an opaque \`next_cursor\`
   that resumes after the last comment's sequence, tombstones for deleted comments, and counts read
   from the counters.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Attachments, mentions, edit history, search indexing, spam scoring, tenant webhooks and the review
queue's interface.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'web · mobile', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'commentsd', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'comment store', sub: 'comment:{tenant}:{id} · index', x: 46, y: 14},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'count · replies · hot:{tenant}', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'comment.event', sub: 'key = thread id', x: 46, y: 86},
      {id: 'moderation', kind: 'grpc', label: 'Moderation', sub: 'CheckComment · 500 ms', x: 70, y: 16},
      {id: 'notifier', kind: 'grpc', label: 'Notifier', sub: 'NotifyAuthor · 500 ms', x: 70, y: 40},
      {id: 'review', kind: 'service', label: 'Review queue', sub: 'pending_review', x: 70, y: 64},
      {id: 'consumer', kind: 'service', label: 'Read model', sub: 'group read-models', x: 70, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'insert · get · page'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVAL commit_comment'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after the commit'},
      {from: 'api', to: 'moderation', kind: 'grpc', label: 'CheckComment'},
      {from: 'api', to: 'notifier', kind: 'grpc', label: 'NotifyAuthor'},
      {from: 'api', to: 'review', kind: 'plain', label: 'timeout → review'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
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
