import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Job queue: the course is not "put a job in a list and run it", it is the debugging you owe a queue
 * before it owns a tenant's side effects. A registry-checked submission with a real dedupe key → one
 * atomic Redis claim under a visibility timeout whose return is idempotent → a worker call that
 * retries only what is retryable and buries poison pills with their history → job-keyed events with
 * the completion published after the effect commits and an outbox under pressure → a status read
 * reconciled against the queue's own sets.
 */
export const jobQueueProblem: Problem = {
  id: 'job-queue',
  title: 'Job Queue',
  tagline: 'Background jobs claimed in one atomic step, retried by error class and buried with their attempt history.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Job Queue

A job queue accepts work now and runs it later: once per enqueue, on workers that crash, against
dependencies that fail, with a history somebody can be paged about. What decides whether the
platform is safe is the admission funnel, the atomic handoff between queue and worker, the failure
policy around each attempt, and the event history that makes a job's life auditable.

## The real system

Amazon SQS gives every received message a visibility timeout, 30 seconds by default and up to 12
hours, during which the message is in flight and hidden from other consumers; if the consumer does
not delete it before the timeout, it becomes visible again and is delivered to someone else, and a
consumer that needs longer calls \`ChangeMessageVisibility\` to extend the lease. A queue's redrive
policy names a dead-letter queue and a \`maxReceiveCount\`: once a message has been received that
many times without being deleted, SQS moves it there instead of delivering it again. A lease that
expires and a bounded receive count are the spine of this course. Around them a platform queue adds
a registry of job types, a caller-supplied dedupe key, retries only for the error classes worth
retrying, an event per transition keyed by job id, and a status read reconciled against the queue's
own sets.

## What you build here

One service, **jobqd**, with five pieces:

1. \`POST /v1/jobs\`: a job type from the registry, a payload validated against its schema, and a
   dedupe key that suppresses duplicates inside a window, answering with the original job id.
2. A **Redis** queue: claimed in one atomic step into an in-flight structure under a visibility
   timeout, with a return path that is itself atomic and idempotent.
3. A **gRPC** worker client: retries only the retryable error classes with backoff, an attempt
   count that survives a restart, and a dead-letter move that carries every attempt's error.
4. A **Kafka** event path: one \`job.event\` per transition keyed by job id, the completion published
   only after the side effect commits, and an outbox row when the broker rejects the produce.
5. \`GET /v1/jobs/{id}\`: state, attempt history, next retry time and dead-letter reason, with a
   stranded job surfaced as stalled and another tenant's job answered \`404\`.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path and
looks right. In every step you debug it against the failure modes, fix it, and prove the fix with
checks that fail on the starter and pass on your version.

## Left out on purpose

Job type authoring UIs, per-tenant rate limits, worker autoscaling, cron scheduling, priority bands,
job cancellation, and retention policies for the event log.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'enqueue · status', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'Job API', sub: 'HTTPS :8443', x: 24, y: 50},
      {id: 'registry', kind: 'db', label: 'Job registry', sub: 'types · schemas', x: 42, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'queue · in-flight', x: 42, y: 40},
      {id: 'store', kind: 'db', label: 'Job store · outbox', sub: 'attempts · state', x: 42, y: 72},
      {id: 'worker', kind: 'grpc', label: 'Worker pool', sub: 'Execute · claim · ack', x: 64, y: 28},
      {id: 'effect', kind: 'external', label: 'Side effect', sub: 'charge · email · webhook', x: 84, y: 8},
      {id: 'dlq', kind: 'db', label: 'Dead-letter', sub: 'attempt history', x: 84, y: 48},
      {id: 'kafka', kind: 'kafka', label: 'job.event', sub: 'key = job id', x: 64, y: 62},
      {id: 'consumer', kind: 'service', label: 'History consumer', sub: 'group job-history', x: 84, y: 84},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'registry', kind: 'plain', label: 'type · schema'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'enqueue · dedupe'},
      {from: 'api', to: 'store', kind: 'plain', label: 'job row'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'claim · ack · return'},
      {from: 'worker', to: 'effect', kind: 'http', label: 'side effect'},
      {from: 'worker', to: 'store', kind: 'plain', label: 'attempts · outbox'},
      {from: 'worker', to: 'dlq', kind: 'plain', label: 'after 5 attempts'},
      {from: 'worker', to: 'kafka', kind: 'kafka', label: 'produce job.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'store', kind: 'plain', label: 'run history'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
