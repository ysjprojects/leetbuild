import type {Problem} from '@/lib/types';

import {taskEndpointStep} from './steps/1-endpoint';
import {assignmentStateStep} from './steps/2-state';
import {prelabelClientStep} from './steps/3-client';
import {labelEventsStep} from './steps/4-events';
import {progressReadStep} from './steps/5-read';

/**
 * Labeling service: the course is not "accept a label over HTTP", it is the debugging you owe a
 * labeling queue before a human's hour is spent in it. Validated, idempotent task creation pinned
 * to a spec version → a Redis pool with 15-minute leases that return abandoned work → a gRPC
 * pre-label call with a 2-second deadline that degrades to an unlabeled item instead of a frozen
 * queue → task-keyed `label.submitted` events written after the label persists, with an outbox →
 * a progress read that reports agreement without showing one annotator another annotator's labels.
 */
export const labelingServiceProblem: Problem = {
  id: 'labeling-service',
  title: 'Labeling Service',
  tagline: 'Spec-pinned tasks, Redis leases on labeling items and agreement math over task-keyed events.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Labeling Service

A labeling service turns raw items into human judgment, and what decides whether it works is what
happens to work nobody finished. The visible part is a form with a next item in it; the parts that
keep the queue healthy are the pinned label spec, the lease that returns abandoned items, the
failure policy around the pre-label model, the event that makes agreement math possible, and the
progress view that must not let annotators copy each other.

## The real system

Label Studio Enterprise hands out tasks with a **task reservation**: placed the moment an annotator
opens a task, it blocks other annotators until the annotator submits, skips, or the reservation
time (configurable, up to 1440 minutes) expires. The reservation honours the project's
annotations-per-task overlap, and an "enforce strict overlap" setting stops a third annotator from
piling on after a reservation lapses. Its documentation describes both failure modes this course
debugs: too long a reservation leaves tasks locked by annotators who cherry-pick easy items; too
short a one lets a task collect more annotations than the overlap asked for. Agreement columns are
hidden from annotators in its data manager, the visibility rule step 5 enforces.

## What you build here

One service, **labeld**, with five pieces:

1. \`POST /v1/tasks\`: an authenticated tenant, a bounded item batch, a required \`spec_version\`
   the task is pinned to, content-hash deduplication, and an \`Idempotency-Key\` so a retried
   create reuses the task.
2. A **Redis** assignment pool: \`claim\` takes one item with a 900-second lease in one atomic
   script, \`renew\` extends only the holder's lease, \`reclaim\` returns expired leases to the pool.
3. A **gRPC** pre-label client: a 2-second deadline per call, at most two attempts, retries only
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, and a failure that marks the item unlabeled.
4. A **Kafka** label path: one \`label.submitted\` event per submission keyed by **task id**, an
   outbox row when the broker rejects the produce, and a consumer that folds labels into agreement
   counters idempotently before it commits the offset.
5. \`GET /v1/tasks/{id}/progress\`: completion and per-label agreement, a peer's labels hidden until
   they submit, flagged annotators excluded from the math, and metrics rebuilt from the events alone.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path, and
looks right. In every step you debug it against the failure modes, fix it, and prove the fix with
checks that fail on the starter and pass on your version.

## Left out on purpose

Annotator onboarding and identity, pay accounting, item imports, label taxonomy governance,
gold-standard seeding, reviewer escalation workflows, per-language pre-label models, and storage of
the raw item payloads.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Annotator', sub: 'next item · submit · progress', x: 8, y: 50},
      {id: 'service', kind: 'http', label: 'Labeling Service', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'pool · leases · agreement', x: 46, y: 12},
      {id: 'db', kind: 'db', label: 'tasks · outbox', sub: 'specs · item hashes', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'label.submitted', sub: 'key = task_id', x: 46, y: 86},
      {id: 'model', kind: 'grpc', label: 'Pre-label model', sub: 'Predict · 2 s deadline', x: 68, y: 16},
      {id: 'quality', kind: 'service', label: 'Quality review', sub: 'flagged annotators', x: 68, y: 50},
      {id: 'consumer', kind: 'service', label: 'Agreement consumer', sub: 'group agreement', x: 68, y: 86},
    ],
    edges: [
      {from: 'client', to: 'service', kind: 'http', label: 'HTTPS'},
      {from: 'service', to: 'db', kind: 'plain', label: 'tasks · outbox'},
      {from: 'service', to: 'redis', kind: 'redis', label: 'claim · renew · counters'},
      {from: 'service', to: 'model', kind: 'grpc', label: 'Predict(item, spec)'},
      {from: 'service', to: 'kafka', kind: 'kafka', label: 'produce label.submitted'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'HINCRBY agreement'},
      {from: 'quality', to: 'redis', kind: 'redis', label: 'flag annotators'},
    ],
  },
  steps: [taskEndpointStep, assignmentStateStep, prelabelClientStep, labelEventsStep, progressReadStep],
};
