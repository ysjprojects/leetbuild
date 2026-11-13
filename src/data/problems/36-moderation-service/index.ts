import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Moderation service: the course is not "call a classifier from an endpoint", it is the debugging
 * you owe a triage pipeline before it touches a real reporter. A report intake that checks
 * ownership and keeps one case per reporter → Lua claims on a Redis review queue with leases that
 * expire → a classifier client that only auto-acts on strong, corroborated evidence → content-keyed
 * action events without the reporter, an outbox and a consumer that persists before it commits →
 * a case file scoped to its tenant that shows the reporter to surveyors only. Every step works on
 * the provided `moderation` package (store and queue intake), in five languages.
 */
export const moderationServiceProblem: Problem = {
  id: 'moderation-service',
  title: 'Moderation Service',
  tagline: 'A report queue whose claims expire and whose case file hides the reporter.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Moderation Service

A moderation service turns a user's report into a decision someone can stand behind: whether the
content belongs to the reporting tenant, who is reviewing it, whether a model may act alone, and
who may see the reporter.

## The real system

Mastodon's admin reports API is the human side of this pipeline: a report carries a category and
the reporter's comment, a moderator calls \`POST /api/v1/admin/reports/:id/assign_to_self\` so two
moderators do not work the same report unknowingly, and a report can be unassigned, resolved or
reopened. Larger platforms put a classifier in front of that queue and treat it as advice under a
deadline: an automatic action takes very high confidence and a second signal, and anything weaker
waits for a person.

## What you build here

One service, **moderated**, on a provided case store (\`moderation.store\`, in Redis:
\`content:{id}\` owners, \`case:{id}\` cases, \`actions:{content_id}\`, \`outbox\`) and a provided
queue intake (\`moderation.queue.enqueue\`, on \`moderation:pending\` and \`moderation:counters\`):

1. \`POST /v1/reports\` \`{content_id, reason, detail}\` with \`X-Tenant-Id\` and \`X-Reporter-Id\`:
   content the tenant owns (**404** otherwise), a reason from \`ALLOWED_REASONS\` (**400**), a detail
   of at most **4096 bytes** (**413**), and one case per reporter and content.
2. The **Redis** claim side of the queue: \`claim(moderator, now)\`, \`renew(case_id, moderator,
   now)\` and \`requeue_expired(now)\`, each one Lua script over \`moderation:pending\`,
   \`moderation:leases\` (a deadline **600 s** after the claim), \`moderation:owners\` and
   \`moderation:counters\`.
3. A **gRPC** \`Classifier.Classify\` client, \`triage(case_id, content_id, text, signals)\`: a
   **400 ms** deadline, retries only on \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`, \`auto_remove\` only
   at **0.98** with a corroborating signal, everything else queued for people.
4. A **Kafka** \`moderation.action\` topic: \`publish_action(report_case, action)\` keyed by content id,
   idempotent with \`acks=all\`, no reporter identity or report text in the event, an outbox row when
   the delivery report refuses the record or does not come within **2 s**; \`consume_actions()\`
   persists with \`store.put_action\` before it commits.
5. \`GET /v1/moderation/items/{case_id}\`: the case file (status, actions, links) scoped to the
   case's tenant (**404** otherwise), \`reporter_id\` only for the \`surveyor\` role, the detail cut to
   280 characters and escaped.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Reporter account management, appeals, the review UI, per-jurisdiction policy packs, model training,
and long-term evidence retention.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Reporter', sub: 'POST /v1/reports', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'Moderation API', sub: 'HTTPS :8443', x: 24, y: 50},
      {id: 'db', kind: 'db', label: 'case store', sub: 'content · cases · actions · outbox', x: 46, y: 12},
      {id: 'redis', kind: 'redis', label: 'Review queue', sub: 'pending · leases · owners · counters', x: 46, y: 50},
      {id: 'console', kind: 'service', label: 'Moderator console', sub: 'claim · renew · case file', x: 46, y: 86},
      {id: 'classifier', kind: 'grpc', label: 'Classifier', sub: 'Classify · 400 ms', x: 70, y: 12},
      {id: 'kafka', kind: 'kafka', label: 'moderation.action', sub: 'key = content id', x: 70, y: 50},
      {id: 'consumer', kind: 'service', label: 'Moderation consumer', sub: 'put_action, then commit', x: 90, y: 50},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'find_case · insert_case · outbox'},
      {from: 'api', to: 'classifier', kind: 'grpc', label: 'Classify'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'enqueue weak evidence'},
      {from: 'console', to: 'redis', kind: 'redis', label: 'claim · renew · requeue'},
      {from: 'console', to: 'api', kind: 'http', label: 'GET case file'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'publish_action'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'persist action'},
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
