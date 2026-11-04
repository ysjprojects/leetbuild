import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';
import {supportModulesCpp, supportModulesGo, supportModulesPy, supportModulesScala, supportModulesTs} from './support';

/**
 * Cron scheduler: the debugging a scheduler fleet needs before it owns other teams' jobs. A schedule
 * evaluated on its owners' wall clock → one Redis lease per minute window → job triggers after a
 * pause, bounded by a deadline and the misfire policy → run events keyed by schedule with an outbox →
 * a history built from the windows the cron expected. The job service is a stand-in the harness
 * serves over gRPC.
 */
export const cronSchedulerProblem: Problem = {
  id: 'cron-scheduler',
  title: 'Cron Scheduler',
  tagline: 'A scheduler fleet that fires each minute window once and shows the windows nobody ran.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Cron Scheduler

A cron scheduler promises that a job runs at certain minutes, once each, on a clock its owners chose.
Small things break that promise: two instances whose tickers land in the same minute, a pause that
leaves a pile of missed windows, a zone nobody checked, and a history that can only show what
happened.

## The real system

A Kubernetes CronJob reads its schedule in the local time zone of kube-controller-manager unless
\`.spec.timeZone\` names one (stable since v1.27). After an outage the controller counts the schedules
it missed since the last one; with more than 100 it starts nothing and logs
\`too many missed start times\`, and \`.spec.startingDeadlineSeconds\` decides how late a start may
still be. Quartz makes the same decision per trigger, with misfire instructions and a
\`misfireThreshold\`.

## What you build here

One service, **cronsched**, on one \`cronsched\` support package every step imports:
\`cronsched/cron\` (epoch seconds, ISO-8601 on the wire, one-minute fire windows with \`window_of\`, six
zones with their daylight rules, \`parse\`, \`next_fire\`, \`fires_between\`, \`shortest_gap_s\`,
\`MIN_INTERVAL_S = 300\`, \`MISFIRE_POLICIES\`) and \`cronsched/store\` (the hash \`schedule:{id}\`, the run
ledger \`runs:{id}\` of window → \`outcome:reason\` written by \`record_run\`, \`lease_key\`, the outbox,
\`new_id\`).

1. \`POST /v1/schedules\` \`{cron, timezone, job_ref, misfire_policy}\`: a zone the table knows, a
   cadence of five minutes or more, a named policy, and \`next_fire\` on the schedule's wall clock.
2. \`fire_window(schedule_id, tick, owner, trigger)\`: \`SET lease:{id}:{window} owner NX EX 300\` per
   minute window, then \`fired\` or \`error:trigger_failed\` in the ledger.
3. \`run_missed(schedule, windows, owner)\`: \`JobRunner.Trigger\` at \`jobs:9000\` with a 3 s deadline,
   one attempt per window, and the misfire policy: \`skip\`, \`fire_once_now\`, or \`catch_up\` at most 5
   per pass.
4. \`publish_run(schedule, window, outcome, reason)\`: \`schedule.fired\` keyed by schedule id, every
   outcome, an idempotent producer with \`acks=all\`, the outbox when no delivery report arrives in 2 s.
5. \`GET /v1/schedules/{id}/history\`: the last 7 days built from the windows the cron expected,
   misfires included, and a stall flag counted in windows.

The ticker that calls steps 2 to 4 every minute is not part of the course; the checks call them
directly.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Cron syntax beyond the five numeric fields (names, \`L\`, \`W\`, \`#\`), a tz database, the ticker loop,
fencing tokens for a paused lease holder, schedule edits and quotas, and the job service's own
semantics.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'schedules · history', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'cronsched', sub: 'HTTPS :8443 · ticker', x: 28, y: 50},
      {id: 'clock', kind: 'service', label: 'Zone table', sub: 'fire windows · next_fire', x: 28, y: 12},
      {
        id: 'redis',
        kind: 'redis',
        label: 'Redis',
        sub: 'schedule:{id} · lease:{id}:{window} · runs:{id} · outbox',
        x: 52,
        y: 20,
      },
      {id: 'job', kind: 'grpc', label: 'Job service', sub: 'JobRunner.Trigger · 3 s', x: 52, y: 80},
      {id: 'kafka', kind: 'kafka', label: 'schedule.fired', sub: 'key = schedule id', x: 74, y: 50},
      {id: 'consumer', kind: 'service', label: 'Ledger consumer', sub: 'group run-ledger', x: 93, y: 50},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'clock', kind: 'plain', label: 'parse · fires_between'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'SET NX EX · HSET runs'},
      {from: 'api', to: 'job', kind: 'grpc', label: 'Trigger(window)'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce every outcome'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
  support: {
    python: {...protoModules, ...supportModulesPy},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
