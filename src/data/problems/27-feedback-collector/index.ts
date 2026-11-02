import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {clientStep} from './steps/3-client';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Feedback collector: a validated write against a served request id, an atomic Redis ballot with a
 * 30-day TTL, a gRPC attribution lookup with a deadline and an unattributed fallback, tenant-keyed
 * events carrying a fingerprint and an outbox, and a satisfaction read with a sample floor and an
 * expiring cache.
 */
export const feedbackCollectorProblem: Problem = {
  id: 'feedback-collector',
  title: 'Feedback Collector',
  tagline: 'Attach user ratings to served request ids and publish them as tenant-ordered, attributed events.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Feedback Collector

A feedback collector attaches a user's rating to the exact request it refers to, allows one vote per
user and request, resolves which model served that request, publishes an ordered signal for downstream
consumers, and reports the result without flattering it. The visible part is a thumbs-up; the parts
that decide whether the signal can be trusted are the request-id check, the atomic ballot, the
attribution lookup, the event payload and the sample floor on the read side.

## The real system

Langfuse models user feedback as a score object that references exactly one trace, observation,
session or dataset run, typed as numeric, categorical or boolean and optionally bound to a score
config that fixes the allowed range, so a rating cannot float free of the request it rates. Any
collector that feeds a model dashboard has the same shape: the request id is the join key, the ballot
is reserved once per (tenant, user, request), and the serving model is resolved by lookup rather than
guessed.

## What you build here

One service, **feedbackd**, with five pieces:

1. \`POST /v1/feedback\`: a tenant header, a request id that must belong to a served request,
   \`rating\` required and in \`-1/0/1\`, a comment capped at 2 KiB and kept out of the logs.
2. A **Redis** ballot: one write per (tenant, user, request), reserved with a single Lua \`EVAL\` that
   sets the key if absent with a 30-day expiry and answers \`1\` or \`0\`.
3. A **gRPC** attribution client: a 200 ms deadline, an \`unattributed\` fallback instead of the
   active model, a short success-only cache, and a backfill that updates attribution without touching
   the rating.
4. A **Kafka** feedback path: \`feedback.recorded\` keyed by tenant, \`acks=all\`, a
   \`comment_fingerprint\` instead of the comment, and an outbox row when the broker rejects the
   produce.
5. \`GET /v1/models/{version}/satisfaction\`: a window from the documented set, a 50-sample floor, an
   aggregate over the recent window only, and a score cached with a 60-second TTL.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path and looks
right. In each step you debug it against the failure modes named in the task, fix it, and prove the fix
with checks that fail on the starter and pass on your version.

## Left out on purpose

Feedback UI, spam and abuse scoring beyond the ballot, per-tenant retention policy, moderator tooling,
comment translation, and the ranking of comments beside a score.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · read', x: 8, y: 50},
      {id: 'collector', kind: 'http', label: 'Feedback Collector', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'feedback · outbox', sub: 'records · attribution', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'dedupe · counters', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'feedback.recorded', sub: 'key = tenant', x: 44, y: 86},
      {id: 'attribution', kind: 'grpc', label: 'Attribution', sub: 'GetAttribution 200 ms', x: 66, y: 12},
      {id: 'registry', kind: 'db', label: 'Model registry', sub: 'versions · routes', x: 84, y: 12},
      {id: 'consumer', kind: 'service', label: 'Quality consumer', sub: 'group quality', x: 66, y: 86},
    ],
    edges: [
      {from: 'client', to: 'collector', kind: 'http', label: 'HTTPS'},
      {from: 'collector', to: 'db', kind: 'plain', label: 'feedback · outbox'},
      {from: 'collector', to: 'redis', kind: 'redis', label: 'reserve · counters'},
      {from: 'collector', to: 'attribution', kind: 'grpc', label: 'GetAttribution'},
      {from: 'attribution', to: 'registry', kind: 'plain', label: 'version · route'},
      {from: 'collector', to: 'kafka', kind: 'kafka', label: 'produce feedback.recorded'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY quality'},
    ],
  },
  steps: [endpointStep, stateStep, clientStep, eventsStep, readStep],
};
