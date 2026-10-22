import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {clientStep} from './steps/3-client';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Feedback collector on the AI-era track: the course is not "store a thumbs-up", it is the review you
 * owe a model-generated feedback path before its numbers are trusted. A validated write against a real
 * request id → an atomic Redis ballot with a 30-day TTL → a gRPC attribution lookup with a deadline and
 * an honest fallback → tenant-keyed events carrying a fingerprint and an outbox → a satisfaction read
 * with an honesty floor and an expiring cache.
 */
export const feedbackCollectorProblem: Problem = {
  id: 'feedback-collector',
  title: 'Feedback Collector',
  tagline: 'Attach user ratings to exact request ids and turn them into ordered, attributable signal.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Feedback Collector

A feedback collector is the piece of an AI platform that attaches a user's rating to the exact request
it refers to, reserves the right to vote once, resolves which model served that request, publishes an
ordered signal for downstream consumers, and reports the result without flattering it. The visible part
is a thumbs-up; the parts that decide whether the signal can be trusted are the request-id check, the
atomic ballot, the attribution lookup, the event payload, and the honesty floor on the read side.

## The real system

Production collectors receive ratings from many tenants, and a rating is only meaningful when it points
at a request the tenant really served — otherwise a caller can invent ids and move a dashboard. They
reserve one vote per (tenant, user, request) atomically, because a double-click and a retrying client
both look like two ratings. They resolve the request id to the model, prompt and route that served it,
with a short deadline and an honest "unattributed" fallback, because attributing a slow lookup to
whatever model is active silently rewrites history after every rollout. They publish one event per
rating, keyed by tenant so a tenant's stream stays ordered, carrying a fingerprint rather than comment
text that would outlive the row in a retained topic, with an outbox when the broker rejects the write.
And they never publish a satisfaction score from too few samples, over all time, or from a cache that
forgot to expire.

## What you build here

One service, **feedbackd**, with five pieces:

1. \`POST /v1/feedback\`: authenticated tenant, a request id that must belong to a served request,
   \`rating\` required and in \`-1/0/1\`, and a comment capped at 2 KiB — the comment stays out of the logs.
2. A **Redis** ballot: one write per (tenant, user, request), reserved with a single Lua \`EVAL\` that
   sets the key if absent with a 30-day expiry, answering \`1\` or \`0\` so the endpoint stores exactly
   one row.
3. A **gRPC** attribution client: a 200 ms deadline, an \`unattributed\` fallback that never guesses the
   active model, a short success-only cache, and a backfill that moves attribution without touching the
   rating.
4. A **Kafka** feedback path: \`feedback.recorded\` keyed by tenant, an idempotent producer with
   \`acks=all\`, a \`comment_fingerprint\` instead of the comment, and an outbox row when the broker
   rejects the produce.
5. \`GET /v1/models/{version}/satisfaction\`: a window from the documented set, a 50-sample honesty floor,
   an aggregate over the recent window only, and a score cached with a 60-second TTL.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Feedback UI, spam and abuse scoring beyond the ballot, per-tenant retention policy, moderator tooling,
comment translation, and the ranking of comments beside a score. The five pieces above are the ones
that decide whether the signal is attributable, ordered and honest.`,
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
