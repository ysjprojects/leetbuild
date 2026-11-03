import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {taskEndpointStep} from './steps/1-endpoint';
import {assignmentStateStep} from './steps/2-state';
import {prelabelClientStep} from './steps/3-client';
import {labelEventsStep} from './steps/4-events';
import {progressReadStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Labeling service: the course is not "accept a label over HTTP", it is the debugging you owe a
 * labeling queue before a human's hour is spent in it. Idempotent, deduplicated task creation pinned
 * to a spec version → a Redis pool with 15-minute leases that return abandoned work → a pre-label
 * call with a 2-second deadline that degrades to an unlabeled item → task-keyed `label.submitted`
 * events produced after the label persists, with an outbox → a progress read that reports agreement
 * without showing one annotator another's labels.
 */
export const labelingServiceProblem: Problem = {
  id: 'labeling-service',
  title: 'Labeling Service',
  tagline: 'Spec-pinned tasks, Redis leases on labeling items and agreement over task-keyed label events.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Labeling Service

A labeling service turns raw items into human judgment, and what decides whether it works is what
happens to work nobody finished. The visible part is a form with the next item in it; the parts that
keep the queue healthy are the pinned label spec, the lease that returns abandoned items, the
failure policy around the pre-label model, the event every downstream consumer reads, and a
progress view that does not let annotators copy each other.

## The real system

Label Studio Enterprise places a **task reservation** the moment an annotator opens a task: other
annotators cannot take it until the annotator submits or skips it or the reservation time expires
(1440 minutes by default, also the maximum), and the reservation counts the project's overlap, so
with an overlap of 2 two annotators can hold one task. Its documentation advises a reservation a
little longer than a task should take: the lease of step 2 is the same mechanism with 15 minutes.

## What you build here

One service, **labeld**, on one task store (\`labeling.store\`, provided in every language): the
task hash \`task:{id}\` (tenant, spec_version, overlap, total_items), its items and the pool
\`pool:{id}\` they wait in, the content hashes per spec, the recorded answer of a create, the labels
\`labels:{id}\`, the \`outbox\` and the \`flagged:{id}\` annotators.

1. \`POST /v1/tasks\`: a tenant, a bounded batch pinned to a required \`spec_version\`, content-hash
   deduplication under the spec, and an \`Idempotency-Key\` whose recorded answer a retry gets back.
2. A **Redis** pool: \`claim\` hands out the next item with a 900-second lease in one Lua script,
   \`renew\` extends the holder's lease only, and an expired lease returns the item to the pool.
3. A **gRPC** pre-label call (\`Prelabel.Predict\`): a 2-second deadline, at most two attempts on
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, and an unlabeled item when the model fails.
4. A **Kafka** \`label.submitted\` event per label, keyed by task id, produced by an idempotent
   \`acks=all\` producer after the label is saved, with an outbox row when no acknowledgement comes.
5. \`GET /v1/tasks/{id}/progress\`: completion and agreement for the tenant's task, the caller's own
   labels only, and flagged annotators out of the math.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Annotator onboarding and identity, pay accounting, item imports, label taxonomy governance,
gold-standard seeding, reviewer escalation, per-language pre-label models, and storage of the raw
item payloads.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Annotator', sub: 'claim · label · progress', x: 8, y: 50},
      {id: 'service', kind: 'http', label: 'labeld', sub: 'HTTP :8080', x: 26, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'tasks · pool · leases · labels', x: 46, y: 14},
      {id: 'model', kind: 'grpc', label: 'Pre-label model', sub: 'Predict · 2 s deadline', x: 68, y: 16},
      {id: 'kafka', kind: 'kafka', label: 'label.submitted', sub: 'key = task_id', x: 46, y: 86},
      {id: 'outbox', kind: 'db', label: 'outbox', sub: 'events the broker did not take', x: 68, y: 86},
      {id: 'quality', kind: 'service', label: 'Quality review', sub: 'flagged annotators', x: 68, y: 50},
    ],
    edges: [
      {from: 'client', to: 'service', kind: 'http', label: 'HTTP'},
      {from: 'service', to: 'redis', kind: 'redis', label: 'create · claim · renew · labels'},
      {from: 'service', to: 'model', kind: 'grpc', label: 'Predict(item, spec)'},
      {from: 'service', to: 'kafka', kind: 'kafka', label: 'produce label.submitted'},
      {from: 'service', to: 'outbox', kind: 'plain', label: 'no ack → row'},
      {from: 'quality', to: 'redis', kind: 'redis', label: 'SADD flagged'},
    ],
  },
  steps: [taskEndpointStep, assignmentStateStep, prelabelClientStep, labelEventsStep, progressReadStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
