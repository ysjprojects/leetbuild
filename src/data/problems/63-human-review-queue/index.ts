import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Human review queue on the AI-era track: the course is not "add a review button to the model
 * output", it is the review you owe a queue that decides which model outputs reach a human, how
 * long a reviewer may hold an item, when the queue may clear an item by itself, and what the
 * lifecycle leaves behind. Validated, deduped escalations → Redis leases and monotonic SLA clocks
 * → a narrow, granted auto-resolve over gRPC with a deadline → source-keyed lifecycle events with
 * the reviewer anonymized → a queue read that reconciles depth with the item store.
 */
export const humanReviewQueueProblem: Problem = {
  id: 'human-review-queue',
  title: 'Human Review Queue',
  tagline: 'Route low-confidence model output to humans with SLA-aware leases and clean handoffs.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Human Review Queue

A human review queue is the piece of an AI platform that takes the output the model is not trusted to
ship — a low-confidence completion, a guardrail block, a user report — and routes it to a person
with a deadline. The visible part is a task in a reviewer's console; the parts that decide whether
the platform is safe are the dedupe at the door, the lease that returns a stranded item, the clock
that decides when an item has breached its SLA, the narrow class the queue may clear without a human,
and the event trail a reviewer's decision leaves behind months later.

## The real system

Production review queues receive escalations from many sources and many tenants. They do not trust a
caller's priority: priority is derived from the platform's rules — a guardrail block outranks a user
report, a safety category outranks a style complaint. They dedupe by \`(source type, source id)\` so
the same blocked completion is reviewed once, not five times because five workers noticed it. They
store a reference to the payload in a retention-managed store instead of copying model output and user
text into the queue row. They assign each item with a lease so a reviewer who crashes or abandons a
tab cannot strand work forever, and they compute the SLA deadline from a monotonic clock, not from a
wall clock that drifts minutes per day between regions. When an item breaches its SLA it re-enters
the queue at the front, visibly marked as breached, not silently reordered. A reviewer's resolution
may clear only a limited class — spam duplicates and known-safe false positives — by calling the
enforcement service over gRPC with a one-second deadline; a timeout escalates to a human, it never
resolves. Every lifecycle change publishes a \`review.event\` keyed by source id so one item's events
stay ordered, carrying priority, SLA state and outcome category, and never the reviewer's name or the
payload text. Finally the operator read returns depth per priority, the age of the oldest item, the
breach count and the assignment distribution — and only for the caller's tenant.

## What you build here

One service, **reviewd**, with five pieces:

1. \`POST /v1/review/items\`: authenticated tenant, a validated source \`(type, id)\`, a priority
   derived server-side from the platform's rules, a payload reference instead of content, and a
   unique constraint on \`(source type, source id)\` so a duplicate escalation enqueues once.
2. A **Redis** queue: items assigned with a lease under a per-priority SLA clock, a lease expiry that
   returns the item to the queue, and a breach marker so an item that missed its SLA is visible as
   breached when it comes back.
3. A **gRPC** enforcement client: a one-second deadline, an auto-resolve only for the safe class and
   only with a recorded grant, a timeout that escalates to a human, and a policy rejection that is
   terminal — never retried.
4. A **Kafka** \`review.event\` path: one event per lifecycle change keyed by source id, an idempotent
   producer with \`acks=all\`, the reviewer referenced by an opaque id for audit only, no payload text,
   and publish-after-commit so an event cannot describe a state the item store never reached.
5. \`GET /v1/review/queues/{p}\`: depth per priority reconciled with the item store, the age of the
   oldest item always reported, the SLA breach count and the assignment state distribution — **403**
   for another tenant's queue.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Reviewer staffing and shift scheduling, the reviewer console UI, model scoring that produces the
confidence in the first place, per-category policy authoring, multi-region queue replication, and the
payload store's retention implementation. The five pieces above are the ones that decide whether the
queue is correct, fair to reviewers and safe to operate.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Reviewer / source', sub: 'escalate · resolve', x: 8, y: 50},
      {id: 'queue', kind: 'http', label: 'Review Queue', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'items', kind: 'db', label: 'Item store', sub: 'items · leases', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'leases · SLA clocks', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'review.event', sub: 'key = source id', x: 44, y: 86},
      {id: 'enforcement', kind: 'grpc', label: 'Enforcement', sub: 'AutoResolve', x: 66, y: 12},
      {id: 'guardrail', kind: 'external', label: 'Guardrail', sub: 'block → escalation', x: 66, y: 38},
      {id: 'console', kind: 'client', label: 'Operator', sub: 'queue depth · age', x: 66, y: 62},
      {id: 'consumer', kind: 'service', label: 'Event consumer', sub: 'audit projection', x: 66, y: 88},
    ],
    edges: [
      {from: 'client', to: 'queue', kind: 'http', label: 'POST /v1/review/items'},
      {from: 'guardrail', to: 'queue', kind: 'http', label: 'block → escalate'},
      {from: 'queue', to: 'items', kind: 'plain', label: 'item · lease'},
      {from: 'queue', to: 'redis', kind: 'redis', label: 'lease · SLA clock'},
      {from: 'queue', to: 'enforcement', kind: 'grpc', label: 'AutoResolve'},
      {from: 'queue', to: 'kafka', kind: 'kafka', label: 'produce review.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'items', kind: 'plain', label: 'audit projection'},
      {from: 'console', to: 'queue', kind: 'http', label: 'GET /v1/review/queues/{p}'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
