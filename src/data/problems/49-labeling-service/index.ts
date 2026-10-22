import type {Problem} from '@/lib/types';

import {taskEndpointStep} from './steps/1-endpoint';
import {assignmentStateStep} from './steps/2-state';
import {prelabelClientStep} from './steps/3-client';
import {labelEventsStep} from './steps/4-events';
import {progressReadStep} from './steps/5-read';

/**
 * Labeling service on the AI-era track: the course is not "accept a label over HTTP", it is the
 * review you owe a model-generated labeling queue before a human's hour is spent in it. Validated,
 * idempotent task creation pinned to a spec version → a Redis pool with 15-minute leases that
 * return abandoned work → a gRPC pre-label call with a 2-second deadline that degrades to an
 * unlabeled item instead of a frozen queue → task-keyed `label.submitted` events written after the
 * label persists, with an outbox → a progress read that reports agreement without showing one
 * annotator another annotator's labels.
 */
export const labelingServiceProblem: Problem = {
  id: 'labeling-service',
  title: 'Labeling Service',
  tagline: 'Human labeling queues with leases, idle-time pre-labels and agreement-safe progress.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Labeling Service

A labeling service is the piece of an AI platform that turns raw items into human judgment, and the
only thing that decides whether it works is what happens to work nobody finished. The visible part
is a form with a next item in it; the parts that decide whether the queue is healthy are the pinned
label spec, the lease that returns abandoned items, the failure policy around the pre-label model,
the event that makes agreement math possible, and the progress view that must not let annotators
copy each other.

## The real system

Production labeling queues create a task from an item batch under a frozen spec version, so every
annotator on that task answers the same question with the same options; an item whose content is
already in the task under that spec is not queued twice, because a duplicate is a second payment for
the same answer. Items are handed out with a lease, not a flag: an annotator who closes the tab
returns their item to the pool when the lease expires, and a claim is one atomic operation so two
annotators never open the same item. Before an item reaches a human, a cheaper model pre-labels it
under a short deadline; when that model is unavailable the item still shows up, marked unlabeled, so
the queue keeps moving instead of stopping. Every submitted label becomes an event keyed by task —
per-task ordering is what makes agreement computable — and the event is written after the label
persists, with an outbox when the broker refuses it. And the progress endpoint reports completion and
agreement statistics without ever handing one annotator the labels another annotator has already
given.

## What you build here

One service, **labeld**, with five pieces:

1. \`POST /v1/tasks\`: an authenticated tenant, a bounded item batch, a required \`spec_version\`
   the task is pinned to, a reviewer count from 1 to 5, content-hash deduplication within the batch
   and against the spec, an \`Idempotency-Key\` so a retried create reuses the task, and a response
   that reports how many items were accepted and how many were duplicates.
2. A **Redis** assignment pool: \`claim\` takes one item with a 900-second lease in one atomic
   script, \`renew\` extends only the holder's lease, and \`reclaim\` returns every expired lease to
   the pool so the pool depth always matches the item records.
3. A **gRPC** pre-label client: a 2-second deadline per call, at most two attempts, retries only
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, and a failure that marks the item unlabeled with the reason
   recorded instead of blocking the assignment that is waiting for it.
4. A **Kafka** label path: one \`label.submitted\` event per submission keyed by **task id**,
   carrying the label values, the spec version and the time spent, an idempotent producer, an outbox
   row when the broker rejects the produce, and a consumer that folds labels into agreement counters
   idempotently before it commits the offset.
5. \`GET /v1/tasks/{id}/progress\`: completion and per-label agreement for one task, a caller's own
   labels visible and a peer's labels hidden until they submit, annotators flagged by quality review
   excluded from the agreement math, and metrics that rebuild from the events alone.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Annotator onboarding and identity, pay and productivity accounting, item imports from arbitrary
sources, label taxonomy governance, gold-standard seeding and onboarding rounds, reviewer escalation
workflows, per-language pre-label models, and storage of the raw item payloads themselves. The five
pieces above are the ones that decide whether the queue is correct, fair and shippable.`,
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
