import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Job queue: the course is not "put a job in a list and run it", it is the debugging you owe a queue
 * before it owns a tenant's side effects. A registry-checked submission with a dedupe key reserved
 * in one command → a claim, return and ack each one Lua script under a visibility timeout → a worker
 * call that retries only what time can fix and counts attempts before the call → job-keyed events
 * published after the ack, with an outbox fed by the delivery report → a status read reconciled
 * against jobs:inflight.
 */
export const jobQueueProblem: Problem = {
  id: 'job-queue',
  title: 'Job Queue',
  tagline:
    'Background jobs claimed by one Lua script under a visibility timeout, retried only when the error says time can help.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Job Queue

A job queue accepts work now and runs it later, on workers that crash, against dependencies that
fail, with a history somebody gets paged about. Whether it is safe comes down to two questions: is
every job in exactly one place at every instant, and does every failure end in a retry that can
succeed or a dead letter someone can read?

## The real system

Amazon SQS gives every received message a visibility timeout, 30 seconds by default and at most 12
hours, during which other consumers cannot see it; a consumer that needs longer calls
\`ChangeMessageVisibility\`, and a message not deleted in time is delivered again. A redrive policy
names a dead-letter queue and a \`maxReceiveCount\`, after which SQS moves the message there instead.
This course builds the same lease and the same bound on Redis.

## What you build here

One service, **jobqd**, on two provided modules: \`jobs.store\` (the registry \`JOB_TYPES\` with
\`validate_payload\`, the job hash \`job:{id}\`, \`begin_attempt\`, \`record_attempt\`,
\`attempt_history\`, \`outbox_add\`) and \`jobs.queue\` (the queue as step 2 builds it, plus
\`retry_later\` and \`bury\`). A job id waits on the list \`jobs:queue\`, is claimed into the sorted
set \`jobs:inflight\` scored by its deadline or retry time, and is buried on \`jobs:dead\`.

1. \`POST /v1/jobs\` with \`{type, payload}\`, \`X-Tenant-Id\` and \`Dedupe-Key\`: 400 for an unknown
   type, 422 naming the rejected path, the key reserved with \`SET NX EX\` for 24 hours.
2. \`claim\`, \`ack\` and \`return_expired\` on **Redis**, each one Lua script under a 60 s visibility
   timeout.
3. \`run_attempt\` over **gRPC** \`JobRunner.Execute\`: a 30 s deadline, retries for the retryable
   statuses only, 1 s backoff doubling, five attempts counted before the call.
4. **Kafka** \`job.event\` keyed by job id, \`completed\` only after the ack, refused records to
   \`jobs:outbox\`.
5. \`GET /v1/jobs/{id}\`: the record reconciled with \`jobs:inflight\` (\`stalled\`, \`retry_overdue\`),
   another tenant's job answered 404.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path and
looks right. In every step you debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Job type authoring, per-tenant rate limits, worker autoscaling, cron schedules, priorities, job
cancellation, heartbeats that extend a claim, and the relay that drains the outbox.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'enqueue · status', x: 6, y: 50},
      {id: 'api', kind: 'http', label: 'Job API', sub: 'POST · GET /v1/jobs', x: 24, y: 50},
      {id: 'registry', kind: 'db', label: 'Job registry', sub: 'JOB_TYPES · schemas', x: 24, y: 14},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'jobs:queue · jobs:inflight · job:{id}', x: 46, y: 50},
      {id: 'worker', kind: 'service', label: 'Worker', sub: 'claim · run_attempt · complete', x: 64, y: 24},
      {id: 'effect', kind: 'grpc', label: 'JobRunner', sub: 'Execute · the side effect', x: 86, y: 10},
      {id: 'dlq', kind: 'db', label: 'Dead letter', sub: 'jobs:dead · dead_reason', x: 64, y: 80},
      {id: 'kafka', kind: 'kafka', label: 'job.event', sub: 'key = job id', x: 86, y: 44},
      {id: 'consumer', kind: 'service', label: 'History consumer', sub: 'run history', x: 86, y: 80},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'registry', kind: 'plain', label: 'type · schema'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'SET NX EX · create_job · read'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'claim · ack · retry_later'},
      {from: 'worker', to: 'effect', kind: 'grpc', label: 'Execute · 30 s deadline'},
      {from: 'worker', to: 'dlq', kind: 'plain', label: 'bury'},
      {from: 'worker', to: 'kafka', kind: 'kafka', label: 'produce job.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
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
