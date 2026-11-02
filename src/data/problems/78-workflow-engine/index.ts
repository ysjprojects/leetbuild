import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Workflow engine: an orchestrator that runs a customer's steps once each. An immutable pinned
 * definition, a compare-and-swap checkpoint in Redis, a gRPC effect guarded by a ledger so a replay
 * cannot send the welcome email twice, run-keyed step events with an outbox, and a read endpoint
 * that says where the run is and what it is waiting on.
 */
export const workflowEngineProblem: Problem = {
  id: 'workflow-engine',
  title: 'Workflow Engine',
  tagline: 'Pinned definitions, compare-and-swap checkpoints and an effect ledger for long-running runs.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Workflow Engine

A workflow engine turns one declared graph of steps into many long-running runs. It records where
each run is, moves it forward once per step, executes each side effect once, and can answer "where
is this run, and why is it not moving" without replaying the history.

## The real system

Temporal lets a workflow type be registered with a Pinned versioning behavior: a running execution
stays on the worker build it started on while new executions go to the current build, and moving a
pinned execution is an explicit operator command, not a side effect of a deploy. Engines of that
kind treat every state advance as a compare-and-swap against the state the worker believes it
holds, so a duplicate worker that lost a heartbeat loses the race and does nothing. Side effects
are the dangerous part, because the caller cannot tell a lost response from a lost request: each
step carries a deterministic effect id, the outcome is recorded before the step is marked done, and
a replay computes the same id and skips the call. Each transition also lands on a Kafka topic keyed
by run id, so one run's history stays in order on one partition.

## What you build here

One service, **workflowd**, with five pieces:

1. \`POST /v1/workflows\` and \`POST /v1/runs\`: a published version is immutable and acyclic; a
   run pins its version, its input document and a step cap at start.
2. A **Redis** checkpoint per run, advanced by one Lua compare-and-swap, holding a reference to the
   step output, with a TTL the advance refreshes.
3. A **gRPC** effect client: a deterministic effect id, the ledger read before the call and written
   before the step is marked done, a timeout reconciled rather than resent.
4. A **Kafka** \`workflow.step\` event per transition, keyed by run id, with no step payload and an
   outbox row written before the produce.
5. \`GET /v1/runs/{id}\`: current step, checkpoint time, pending effects and last error, scoped to
   the tenant, naming the lease holder for a stalled run.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path, and looks right. In
each step you debug it against the failure modes, fix it, and prove the fix with checks that fail
on the starter and pass on your version.

## Left out on purpose

Definition authoring UIs, cron and event triggers, parallel branches and joins, compensation and
saga rollback, human-approval steps, per-tenant quotas and the worker's own deployment.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'start · inspect', x: 8, y: 50},
      {id: 'engine', kind: 'http', label: 'Workflow Engine', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'db', kind: 'db', label: 'definitions · outbox', sub: 'immutable versions', x: 48, y: 10},
      {id: 'redis', kind: 'redis', label: 'Run checkpoint', sub: 'CAS advance · lease', x: 48, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'workflow.step', sub: 'key = run id', x: 48, y: 90},
      {id: 'worker', kind: 'service', label: 'Worker', sub: 'step runner', x: 68, y: 50},
      {id: 'effects', kind: 'grpc', label: 'Effect targets', sub: 'email · orders · billing', x: 88, y: 24},
      {id: 'ledger', kind: 'db', label: 'Effect ledger', sub: 'effect_id → outcome', x: 88, y: 58},
      {id: 'audit', kind: 'service', label: 'Audit consumer', sub: 'group history', x: 88, y: 88},
    ],
    edges: [
      {from: 'client', to: 'engine', kind: 'http', label: 'HTTPS'},
      {from: 'engine', to: 'db', kind: 'plain', label: 'versions · outbox'},
      {from: 'engine', to: 'redis', kind: 'redis', label: 'start · read state'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'CAS advance'},
      {from: 'worker', to: 'effects', kind: 'grpc', label: 'effect_id per step'},
      {from: 'worker', to: 'ledger', kind: 'plain', label: 'record before done'},
      {from: 'worker', to: 'db', kind: 'plain', label: 'outbox row'},
      {from: 'worker', to: 'kafka', kind: 'kafka', label: 'produce workflow.step'},
      {from: 'kafka', to: 'audit', kind: 'kafka', label: 'consume by run'},
      {from: 'audit', to: 'db', kind: 'plain', label: 'append history'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
