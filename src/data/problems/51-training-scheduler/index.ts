import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {trainingEndpointStep} from './steps/1-endpoint';
import {trainingStateStep} from './steps/2-state';
import {trainingDependencyStep} from './steps/3-dependency';
import {trainingEventsStep} from './steps/4-events';
import {trainingReadStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Training scheduler: the course is not "accept a training job", it is the debugging you owe a
 * scheduler before it owns a shared GPU fleet. Clamped, known, idempotent submissions → one Redis
 * queue position per run and a leased start → preemption that checkpoints before it terminates →
 * run-keyed lifecycle events with an outbox → a status read that believes the cluster over the row.
 * The worker agent is a gRPC stand-in the harness serves; the cluster's view is a Redis hash.
 */
export const trainingSchedulerProblem: Problem = {
  id: 'training-scheduler',
  title: 'Training Scheduler',
  tagline: 'Training runs on shared GPUs: a Redis queue with leased starts, and preemption that checkpoints first.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Training Scheduler

A training scheduler turns "train this recipe on this dataset" into work that runs on GPUs the
cluster can spare, once, and resumes after an interruption instead of starting over. The visible
part is a run id and a queue position; what decides whether the fleet is safe to share is how a run
enters the queue, how it leaves it, and what happens when it has to make room.

## The real system

Slurm, the scheduler behind most HPC and many GPU training clusters, makes preemption a policy with
a clock. A job selected for preemption is sent SIGTERM at once and keeps running for the
\`GraceTime\` its partition or QOS sets before the SIGKILL sequence; what happens next is the configured
\`PreemptMode\`, and \`REQUEUE\` puts the job back in the queue. This course's preemption has the same
shape: a bounded window to write a checkpoint, then a terminate, then the run waits again.

## What you build here

One service, **trainsched**, over a provided \`trainsched\` package: \`runs\` (the run row
\`run:{run_id}\`, the Idempotency-Key bindings, \`new_run_id\`), \`queue\` (step 2's queue, for the
other steps), \`outbox\` and \`cluster\` (the cluster's view, \`cluster:assignments\`).

1. \`POST /v1/training/runs\` \`{dataset_version, recipe_version, priority}\`: a known recipe, a
   priority clamped into 0..8 and banded, one run per \`(tenant, Idempotency-Key)\`.
2. The **Redis** queue \`training:queue\`, scored \`band * BAND_SPAN_MS + enqueued_at_ms\`; claims,
   confirms and reaps are Lua scripts over the lease \`training:lease:{id}\` and its deadline in
   \`training:leases\`.
3. \`preempt(run_id)\` over **gRPC** (\`Worker.Checkpoint\` with a 30-second grace deadline, then
   \`Worker.Terminate\`), requeueing the run at its own position.
4. **Kafka** \`training.run\`: \`{run_id, transition, band, nodes, checkpoint_id}\` keyed by run id
   from an idempotent producer, \`started\` only after \`Worker.StartRun\` accepted, an outbox row when
   the broker does not acknowledge.
5. \`GET /v1/training/runs/{id}\`: tenant-scoped, the queue position from the head, a running run's
   nodes from the cluster, and a run the cluster lost reported failed.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Dataset versioning, recipe authoring, bin-packing runs onto nodes, per-tenant GPU quotas, cost
accounting, the checkpoint format, and the relay that drains the outbox.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · status', x: 8, y: 50},
      {id: 'scheduler', kind: 'http', label: 'Training Scheduler', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'store', kind: 'db', label: 'run store · outbox', sub: 'run:{id} · outbox list', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'queue · leases', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'training.run', sub: 'key = run id', x: 44, y: 86},
      {id: 'worker', kind: 'grpc', label: 'Worker agent', sub: 'StartRun · Checkpoint · Terminate', x: 68, y: 12},
      {id: 'cluster', kind: 'external', label: 'Cluster view', sub: 'cluster:assignments', x: 68, y: 50},
      {id: 'consumer', kind: 'service', label: 'Lifecycle consumer', sub: 'group run-history', x: 68, y: 86},
    ],
    edges: [
      {from: 'client', to: 'scheduler', kind: 'http', label: 'HTTPS'},
      {from: 'scheduler', to: 'store', kind: 'plain', label: 'runs · outbox'},
      {from: 'scheduler', to: 'redis', kind: 'redis', label: 'queue · leases'},
      {from: 'scheduler', to: 'worker', kind: 'grpc', label: 'StartRun · Checkpoint · Terminate'},
      {from: 'worker', to: 'cluster', kind: 'plain', label: 'register · heartbeat'},
      {from: 'scheduler', to: 'cluster', kind: 'plain', label: 'reconcile'},
      {from: 'scheduler', to: 'kafka', kind: 'kafka', label: 'produce training.run'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'store', kind: 'plain', label: 'run history'},
    ],
  },
  steps: [trainingEndpointStep, trainingStateStep, trainingDependencyStep, trainingEventsStep, trainingReadStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
