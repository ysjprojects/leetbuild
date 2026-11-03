import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Cron scheduler: the course is not "call a function on a timer", it is the debugging you owe a
 * scheduler before it owns a shared job fleet. A bounded time spec whose timezone resolves → one
 * Redis lease per fire window so exactly one instance fires it → a gRPC trigger with a deadline
 * behind a misfire policy that will not storm the target → schedule events keyed by schedule id with
 * an outbox → a history read that shows pauses as misfires.
 */
export const cronSchedulerProblem: Problem = {
  id: 'cron-scheduler',
  title: 'Cron Scheduler',
  tagline: 'One Redis lease per fire window, and a misfire policy that decides what a scheduler pause owes.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Cron Scheduler

A cron scheduler decides **when** work happens and **how many times** it happens, across a fleet
that pauses, restarts and races.

## The real system

Quartz, the scheduler behind many Java platforms, keeps its triggers in a shared database and lets
several instances run as a cluster (\`org.quartz.jobStore.isClustered\`): whichever node acquires a
trigger row under the database lock fires it, and the others see it as taken. It also treats a
missed fire as a first-class case: a trigger that passes its next fire time by more than
\`misfireThreshold\` (60 seconds by default) is handled according to the misfire instruction on the
trigger, and \`maxMisfiresToHandleAtATime\` bounds how many misfires one pass recovers so a long
pause does not turn into one enormous transaction.

## What you build here

One service, **cronsched**, with five pieces:

1. \`POST /v1/schedules\`: a cron expression that fires no more often than once a minute, a timezone
   from the IANA set the service can actually resolve, a validated job reference and a **required**
   misfire policy.
2. A **Redis** lease per \`(schedule, fire window)\`: acquired in one atomic \`SET ... NX EX\` round
   trip, expiring shortly after the window it guards, with the outcome of every window recorded so a
   crashed fire is not retried forever.
3. A **gRPC** trigger with a 3-second deadline, where the misfire policy decides between skip,
   fire-once-now and a rate-limited catch-up, and every decision is recorded with its reason.
4. A **Kafka** \`schedule.fired\` topic keyed by schedule id: one event per attempt and outcome,
   including skipped and missed windows, an idempotent producer with \`acks=all\`, and an outbox row
   when the broker rejects the produce.
5. \`GET /v1/schedules/{id}/history\`: fires, skips and misfires for the last 30 days, built from the
   windows the cron should have fired, with a stall flag derived from that same expectation math.

## The debugging habit

Every starter compiles and serves the happy path. Debug it against the failure modes, fix it, and
prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Cron parsing beyond the five-field form, clock synchronisation, the target job's own semantics,
schedule quotas, alerting, and the authoring UI.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'schedules · history', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Scheduler API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'clock', kind: 'service', label: 'Clock', sub: 'fire windows · NTP', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'leases · outcomes', x: 44, y: 50},
      {id: 'db', kind: 'db', label: 'schedule store', sub: 'specs · outbox', x: 44, y: 88},
      {id: 'job', kind: 'grpc', label: 'Job service', sub: 'Trigger · 3 s deadline', x: 68, y: 12},
      {id: 'kafka', kind: 'kafka', label: 'schedule.fired', sub: 'key = schedule', x: 68, y: 50},
      {id: 'consumer', kind: 'service', label: 'Ledger consumer', sub: 'group run-ledger', x: 88, y: 50},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'specs · outbox'},
      {from: 'api', to: 'clock', kind: 'plain', label: 'fire windows'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'SET NX lease'},
      {from: 'api', to: 'job', kind: 'grpc', label: 'Trigger / CatchUp'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce schedule.fired'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'append run rows'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
