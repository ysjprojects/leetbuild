import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Workflow engine on the AI-era track: the course is not "run a list of steps", it is the review you
 * owe a model-generated orchestrator before it ships a customer's money. An immutable pinned
 * definition → a compare-and-swap checkpoint in Redis → a gRPC effect guarded by a ledger so a
 * replay cannot send the welcome email twice → run-keyed step events with an outbox → a read
 * endpoint that says where the run is, what it is waiting on and why.
 */
export const workflowEngineProblem: Problem = {
  id: 'workflow-engine',
  title: 'Workflow Engine',
  tagline: 'Multi-step workflows with durable state, exactly-once effects and visible progress.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Workflow Engine

A workflow engine turns one declared graph of steps into many long-running runs. It records where
each run is, moves it forward exactly once per step, executes the side effects of those steps
exactly once, and can answer "where is this run, and why is it not moving" without replaying the
whole history. The visible part is a status endpoint; the parts that decide whether an engine can
be trusted with a customer's order are the pinned definition, the atomic checkpoint, the effect
ledger, the event key, and the read model built over all of them.

## The real system

Production engines never execute a definition that is still being edited: a run starts against one
immutable version and keeps it for life, so a deploy halfway through cannot change what the run was
supposed to do. Long runs are driven by workers that may crash, be replaced, or be duplicated by a
scheduler that lost a heartbeat, so every advance is a compare-and-swap against the checkpoint the
worker believes it is advancing from — a duplicate worker must lose the race and do nothing, not
advance a second time. Step outputs are large and change often, so the checkpoint holds the step
name, a reference to the stored output and the time, never the payload: Redis is the coordination
layer, not the filing cabinet.

The steps themselves call other systems — send the welcome email, charge the card, reserve the
stock — and those calls are the dangerous part, because the caller cannot tell a lost response from
a lost request. So each step carries a deterministic effect id, the ledger records the effect's
outcome before the step is marked done, and a replay computes the same id and skips the effect
instead of repeating it. A deadline that expires is reconciled against that ledger rather than
blindly retried. Every transition also lands on a Kafka topic keyed by the run id, so one run's
history stays in order on one partition and an auditor can read the sequence without joining
anything; the payload stays out of the event, and an outbox row keeps the history complete across a
broker outage. Finally, the read endpoint answers the only questions an operator actually asks:
which step, since when, what is it waiting on, what failed — and who holds the lease when the run
has stopped moving.

## What you build here

One service, **workflowd**, with five pieces:

1. \`POST /v1/workflows\` and \`POST /v1/runs\`: a published definition version is immutable and
   acyclic, and a run pins its version, its input document and a maximum step count at start.
   Oversized input is \`413\`, a cyclic definition is refused at publish time, and no run ever
   floats to a later version.
2. A **Redis** checkpoint per run: advanced by one Lua compare-and-swap that writes only when the
   stored step is still the one the worker advanced from, holding a reference to the step output
   instead of the output, with a TTL that the advance refreshes.
3. A **gRPC** effect client: a deterministic effect id per step, the ledger read before the call
   and written before the step is marked done, so a crash between the two replays safely and a
   timeout is reconciled rather than resent.
4. A **Kafka** \`workflow.step\` event per transition, keyed by run id, carrying step names, effect
   ids and outcomes and never step payloads, with an outbox row written before the produce.
5. \`GET /v1/runs/{id}\`: the current step, the checkpoint time, the effects still pending and the
   last error, scoped to the calling tenant, naming the lease holder and its age for a stalled run.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real workflow
feature: read the draft against the failure modes, name the subtle one, fix it, and prove the fix
with checks that fail on the draft and pass on your version.

## Left out on purpose

Definition authoring UIs, cron and event triggers, parallel branches and joins, compensation and
saga rollback, human-approval steps, per-tenant quotas, backfills of running runs and the worker's
own deployment. The five pieces above are the ones that decide whether a run is durable, whether a
side effect happens once, and whether an operator can see what the engine is doing.`,
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
