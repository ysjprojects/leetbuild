import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Job queue on the AI-era track: the course is not "put a job in a list and run it", it is the
 * review you owe a model-generated queue before it owns a tenant's side effects. A registry-checked
 * submission with a real dedupe key → one atomic Redis claim under a visibility timeout whose
 * return is idempotent → a worker call that retries only what is retryable and buries poison pills
 * with their history → job-keyed events with the completion published after the effect commits and
 * an outbox under pressure → a status read reconciled against the queue's own sets.
 */
export const jobQueueProblem: Problem = {
  id: 'job-queue',
  title: 'Job Queue',
  tagline: 'Background jobs that run at least once, dedupe side effects and bury poison pills.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Job Queue

A job queue is the piece of a platform that accepts work now and runs it later — once per enqueue, on
workers that crash, against dependencies that fail, with a history somebody can be paged about. The
visible part is an id and a state string; the parts that decide whether the platform is safe are the
admission funnel, the atomic handoff between the queue and the worker, the failure policy around each
attempt, and the event history that makes a job's life auditable.

## The real system

Production queues receive submissions from many tenants, accept only the job types their registry
knows, validate the payload against that type's own schema, and honour a dedupe key the caller
supplies — because the caller's retry is not the queue's duplicate, and a second execution of the
same side effect is a second charge, a second email or a second webhook. They hand work to workers
through a structure that cannot lose a job: the move out of the queue and the mark that says "in
flight" are one atomic step, and a claim that expires returns the job to the queue exactly once, so a
slow worker and a fresh claimant can never hold it at the same time. Workers retry only the error
classes that are worth retrying, with backoff, and a job that has spent its attempts is dead-lettered
with the history of every attempt instead of looping forever. Every transition is published as an
event keyed by the job id, so one job's history stays ordered while other jobs' events interleave
across partitions, and a broker outage is absorbed by an outbox instead of dropped. Finally, the
status read a support engineer sees is reconciled against the queue's own sets: a job stranded in a
crashed worker's claim reads as stalled with the age of that claim, never as queued forever.

## What you build here

One service, **jobqd**, with five pieces:

1. \`POST /v1/jobs\`: a job type from the registry, a payload validated against that type's schema,
   and a dedupe key that suppresses duplicates inside a documented window, answering with the
   original job id.
2. A **Redis** queue: claimed in one atomic step into an in-flight structure under a visibility
   timeout, with a return path that is itself atomic and idempotent, so no crash and no slow worker
   can double-run a job or evaporate it.
3. A **gRPC** worker client: retries only the retryable error classes with exponential backoff, an
   attempt count that survives a worker restart, and a dead-letter move after five attempts that
   carries every attempt's error.
4. A **Kafka** event path: one \`job.event\` per transition keyed by job id, the completion published
   only after the side effect commits, and an outbox row when the broker rejects the produce.
5. \`GET /v1/jobs/{id}\`: state, attempt history, next retry time and any dead-letter reason, with a
   stranded job surfaced as stalled with its claim age and another tenant's job answered \`404\`.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real queue: read
the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks that
fail on the draft and pass on your version.

## Left out on purpose

Job type authoring UIs, per-tenant rate limits, worker autoscaling, cron scheduling, priority bands,
job cancellation, payload encryption at rest, and retention policies for the event log. The five
pieces above are the ones that decide whether the queue is correct, crash-safe and shippable.`,
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
