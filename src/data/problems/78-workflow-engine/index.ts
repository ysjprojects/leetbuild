import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Workflow engine: one service, workflowd, that runs a signup workflow's steps once each. Immutable
 * versions a run pins at start → a Redis checkpoint moved by one compare-and-swap → a gRPC side
 * effect guarded by an effect ledger → run-keyed workflow.step events through an outbox → a read
 * that says where the run is and what it waits on.
 */
export const workflowEngineProblem: Problem = {
  id: 'workflow-engine',
  title: 'Workflow Engine',
  tagline: 'Pinned workflow versions, a Redis checkpoint swap and an effect ledger for long-running runs.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Workflow Engine

A workflow engine turns one declared graph of steps into many long-running runs. It records where
each run is, moves it forward once per step, runs each side effect once, and can say where a run is
and why it is not moving without replaying its history.

## The real system

Temporal lets a workflow declare a Pinned versioning behavior: an execution finishes on the worker
build it started on while new executions go to the current build, and moving a pinned execution is
an explicit operator command (\`temporal workflow update-options\`), not a side effect of a deploy.
Its namespace retention period applies to closed executions only, so a run waiting on a slow step
keeps its state. The same concerns shape this course: advancing a run is a compare-and-swap that a
duplicate worker loses, a side effect carries an id that is the same on every attempt, and every
transition reaches the audit log in order per run.

## What you build here

One service, **workflowd**, built on the provided \`workflow\` package: \`definitions\` (one Redis
hash per published version, \`has_cycle\`), \`runs\` (\`run:{id}\`, created with its checkpoint),
\`blobs\`, \`checkpoint\` (\`advance\`, \`read\`), \`ledger\` (\`effect:{run_id}:{step}\`) and
\`outbox\`.

1. \`POST /v1/workflows\` and \`POST /v1/runs\`: a published version is acyclic and never changes;
   a run pins the version it asked for, with a bounded input and step budget.
2. A **Redis** checkpoint \`run:{id}:checkpoint\`, moved by one Lua compare-and-swap that keeps the
   output's blob reference and the finished steps, and expires only once the run finished.
3. A **gRPC** \`Mailer.SendWelcome\` call guarded by the ledger: the effect id
   \`{run_id}:{step}\`, the record written before the checkpoint moves, a deadline reconciled
   through \`GetDelivery\` instead of resent.
4. A **Kafka** \`workflow.step\` event per transition, keyed by run id, ids and names only, kept in
   the outbox until the broker acknowledges it.
5. \`GET /v1/runs/{id}\`: tenant-scoped; pinned steps, checkpoint, pending effects and a status of
   \`running\`, \`stalled\` or \`succeeded\`.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path, and looks right. In
each step you debug it against the failure modes the task names, fix it, and prove the fix with
checks that fail on the starter and pass on your version.

## Left out on purpose

Definition authoring, cron and event triggers, parallel branches and joins, compensation, human
approval steps, worker leases and heartbeats, the outbox relay and the audit consumer itself.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'publish · start · inspect', x: 8, y: 50},
      {id: 'engine', kind: 'http', label: 'workflowd', sub: 'HTTP API', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'definitions · runs · checkpoints', x: 50, y: 22},
      {id: 'ledger', kind: 'redis', label: 'Ledger · outbox', sub: 'effect ids · unsent events', x: 50, y: 78},
      {id: 'worker', kind: 'service', label: 'Worker', sub: 'runs one step', x: 70, y: 50},
      {id: 'mailer', kind: 'grpc', label: 'Mailer', sub: 'SendWelcome · GetDelivery', x: 90, y: 24},
      {id: 'kafka', kind: 'kafka', label: 'workflow.step', sub: 'key = run id', x: 90, y: 76},
    ],
    edges: [
      {from: 'client', to: 'engine', kind: 'http', label: 'HTTP'},
      {from: 'engine', to: 'redis', kind: 'redis', label: 'publish · start · read'},
      {from: 'engine', to: 'ledger', kind: 'redis', label: 'pending effects'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'CAS advance'},
      {from: 'worker', to: 'ledger', kind: 'redis', label: 'record · outbox row'},
      {from: 'worker', to: 'mailer', kind: 'grpc', label: 'effect_id per step'},
      {from: 'worker', to: 'kafka', kind: 'kafka', label: 'produce workflow.step'},
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
