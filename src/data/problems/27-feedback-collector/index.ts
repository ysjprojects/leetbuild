import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {clientStep} from './steps/3-client';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Feedback collector: a rating that must point at a request the tenant was served → one ballot per
 * (tenant, request, user) taken in one Redis command with a 30-day expiry → a gRPC attribution
 * lookup under a 200 ms deadline that answers `unattributed` instead of guessing → tenant-keyed
 * events with a comment fingerprint and an outbox → a satisfaction read over a recent window with a
 * sample floor and a 60-second cache. Every step's starter runs and hides flaws the learner debugs.
 */
export const feedbackCollectorProblem: Problem = {
  id: 'feedback-collector',
  title: 'Feedback Collector',
  tagline: 'A thumbs-up that lands on the request it rates and the model version that served it.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Feedback Collector

A feedback collector turns a thumbs-up into a number a model team can act on. The number is only
worth something if each rating points at the request it rates, counts once, names the model that
answered, reaches the quality pipeline without the comment text, and is read back over a window
that reflects the current model.

## The real system

Langfuse stores user feedback as scores, and each score references exactly one trace, observation,
session or dataset run; a score config can fix its data type and allowed range, so a rating cannot
float free of the request it rates. The collector in this course has the same spine: the request id
is the join key, the ballot is taken once per user, and the serving model is looked up, not
assumed.

## What you build here

One service, **feedbackd**, on one provided module, \`feedback.store\` (Redis): \`served:{tenant}:{request_id}\`
written by the gateway, feedback rows \`feedback:{id}\`, the outbox list \`outbox:feedback.recorded\`,
and the quality consumer's counters \`quality:{model}\` and \`quality:{model}:{hour}\`
(\`samples\`, \`positive\`).

1. \`POST /v1/feedback\` (\`api\`): \`X-Tenant-Id\`, \`X-User-Id\`, body \`{request_id, rating, comment}\`;
   the request must be one \`is_served\` knows, \`rating\` is required and in \`-1/0/1\`, the comment is
   at most 2 KiB of UTF-8 and stays out of the logs; \`201 {feedback_id, request_id, rating}\`.
2. \`claim(tenant, request_id, user_id)\` (\`state\`): the ballot
   \`ballot:{tenant}:{request_id}:{user_id}\`, taken with one \`SET … NX EX\` that expires after 30 days.
3. \`attribute(tenant, request_id)\` (\`client\`): \`Attribution.GetAttribution\` under a 200 ms deadline;
   a failure answers \`unattributed\` and is not cached; a success is cached per tenant and request.
4. \`publish_recorded(row)\` (\`events\`): \`feedback.recorded\` keyed by tenant, \`acks=all\`, a
   \`comment_fingerprint\` (SHA-256) in place of the comment, and an outbox row from the delivery
   report when the broker refuses.
5. \`GET /v1/models/{version}/satisfaction?window=\` (\`read\`): a window from \`1h\`, \`24h\`, \`7d\`
   summed over the hour buckets, a 50-sample floor, and a 60-second cache per version and window.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path and looks
right. In each step you debug it against the failure modes the task names, fix it, and prove the fix
with checks that fail on the starter and pass on your version.

## Left out on purpose

The feedback widget, abuse scoring beyond the ballot, per-tenant retention, moderator tooling, the
outbox relay, the quality consumer itself and comment analysis.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'rate · read', x: 8, y: 50},
      {id: 'collector', kind: 'http', label: 'feedbackd', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'served · ballot · feedback · quality · outbox', x: 50, y: 20},
      {id: 'attribution', kind: 'grpc', label: 'Attribution', sub: 'GetAttribution · 200 ms', x: 50, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'feedback.recorded', sub: 'key = tenant', x: 50, y: 82},
      {id: 'consumer', kind: 'service', label: 'Quality consumer', sub: 'HINCRBY quality:{model}:{hour}', x: 76, y: 82},
    ],
    edges: [
      {from: 'client', to: 'collector', kind: 'http', label: 'HTTPS'},
      {from: 'collector', to: 'redis', kind: 'redis', label: 'is_served · SET NX EX · rows · read buckets'},
      {from: 'collector', to: 'attribution', kind: 'grpc', label: 'GetAttribution'},
      {from: 'collector', to: 'kafka', kind: 'kafka', label: 'produce · outbox on refusal'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'quality counters'},
    ],
  },
  steps: [endpointStep, stateStep, clientStep, eventsStep, readStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
