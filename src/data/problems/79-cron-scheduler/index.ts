import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Cron scheduler on the AI-era track: the course is not "call a function on a timer", it is the
 * review you owe a model-generated scheduler before it owns a shared job fleet. A bounded time spec
 * whose timezone resolves → one Redis lease per fire window so exactly one instance fires it → a
 * gRPC trigger with a deadline behind a misfire policy that will not storm the target → schedule
 * events keyed by schedule id with an outbox → a history read that shows pauses as misfires.
 */
export const cronSchedulerProblem: Problem = {
  id: 'cron-scheduler',
  title: 'Cron Scheduler',
  tagline: 'One instance of a scheduled job runs, not one per node, and misfires are explicit.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Cron Scheduler

A cron scheduler is the piece of a platform that decides **when** work happens and **how many
times** it happens. The visible part is a job running on time; the parts that decide whether the
platform survives are the time spec it accepts, the lease that makes one window fire once across
the whole fleet, the misfire policy that turns a pause into a policy decision instead of a burst,
and the event history that makes a pause visible afterwards.

## The real system

Production schedulers receive time specs from many tenants, resolve a timezone rather than trusting
a string, and refuse a cadence the queue cannot absorb. They run as several instances, so a window
is claimed with one atomic operation and exactly one instance fires it — during a rolling deploy
two instances are the normal case, not the exception. They hand control to the target job over gRPC
under a deadline, and when the scheduler was down they consult the schedule's **misfire policy**:
skip, fire once now, or catch up at a rate the target can absorb. Above all they never treat every
missed window as owed work, because a ten-minute pause on a minutely job is 200 executions and that
is how a scheduler takes down the database it feeds. Every attempt, skip and misfire is published
keyed by schedule id so one schedule's history stays ordered, and a read returns that history with
the expectations, not just the successes.

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

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Cron parsing beyond the five-field form, distributed clock synchronisation details, the target job's
own execution semantics, per-tenant schedule quotas, cost attribution, alerting and on-call routing,
and the UI for authoring schedules. The five pieces above are the ones that decide whether the
scheduler is correct, isolated and shippable.`,
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
