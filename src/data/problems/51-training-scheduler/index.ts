import type {Problem} from '@/lib/types';

import {trainingEndpointStep} from './steps/1-endpoint';
import {trainingStateStep} from './steps/2-state';
import {trainingDependencyStep} from './steps/3-dependency';
import {trainingEventsStep} from './steps/4-events';
import {trainingReadStep} from './steps/5-read';

/**
 * Training scheduler: the course is not "accept a training job", it is the debugging you owe a
 * scheduler before it owns a shared GPU fleet. Admitted and clamped submissions whose retries
 * replay instead of double-starting → one Redis queue position per run behind a start lease →
 * preemption that waits for a checkpoint id → run-keyed lifecycle events with an outbox → a status
 * endpoint reconciled against the cluster.
 */
export const trainingSchedulerProblem: Problem = {
  id: 'training-scheduler',
  title: 'Training Scheduler',
  tagline:
    'Queue training runs on shared GPUs with a leased start, a checkpoint before every preemption and one event per transition.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Training Scheduler

A training scheduler turns "train this recipe on this dataset" into work that runs once on a GPU the
cluster can spare. The visible part is a run id and a queue position; what decides whether the
platform is safe is the admission funnel, the leased handoff between queue and worker, the
preemption that checkpoints before it kills, and the event history.

## The real system

Slurm, the scheduler behind most HPC and many GPU training clusters, makes preemption a policy with
a clock. A job selected for preemption is sent SIGTERM at once and given \`GraceTime\` seconds to
run before the SIGKILL sequence; what happens to it afterwards is a configured \`PreemptMode\`:
cancelled, requeued, or suspended and resumed later. That is the shape of this course's preemption
step: a bounded warning the job can use to checkpoint, then a defined end state rather than a bare
kill. The rest of the scheduler follows the same discipline: admission only for known recipe and
dataset versions, a clamped priority, one queue position per run, a start that is a lease so a
crash between dequeue and process start returns the run, and every transition published keyed by
run id.

## What you build here

One service, **trainsched**, with five pieces:

1. \`POST /v1/training/runs\`: authenticated tenant, validated dataset and recipe versions, a
   priority **clamped** into the supported bands, and an \`Idempotency-Key\` so a retry returns the
   original run.
2. A **Redis** queue: one position per run derived from the band and the enqueue time, a scripted
   move that cannot leave a duplicate, and a start lease with a TTL so a worker that dies during
   startup returns the run with its band intact.
3. A **gRPC** preemption call: a grace deadline, termination only after a checkpoint id is received,
   and a job that reports no checkpoint support left running while the new work queues behind it.
4. A **Kafka** lifecycle topic: one \`training.run\` event per transition, keyed by run id, with
   \`started\` published only after the worker confirms, and an outbox row when the broker rejects
   the produce.
5. \`GET /v1/training/runs/{id}\`: queue position, lease state, nodes and last checkpoint reconciled
   against the cluster's view, orphaned runs surfaced as failed with a reason, and another tenant's
   run invisible.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path and
looks right. In every step you debug it against the failure modes, fix it, and prove the fix with
checks that fail on the starter and pass on your version.

## Left out on purpose

Dataset versioning, recipe authoring, the cluster's bin-packing and autoscaling, per-tenant GPU
quotas, cost accounting, the checkpoint format, and the worker image build.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · status', x: 8, y: 50},
      {id: 'scheduler', kind: 'http', label: 'Training Scheduler', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'store', kind: 'db', label: 'run store · outbox', sub: 'runs · checkpoints', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'queue · leases', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'training.run', sub: 'key = run id', x: 44, y: 86},
      {id: 'worker', kind: 'grpc', label: 'Training worker', sub: 'StartRun / Preempt', x: 68, y: 12},
      {id: 'cluster', kind: 'external', label: 'Cluster state', sub: 'nodes · assignments', x: 68, y: 50},
      {id: 'consumer', kind: 'service', label: 'Lifecycle consumer', sub: 'group run-history', x: 68, y: 86},
    ],
    edges: [
      {from: 'client', to: 'scheduler', kind: 'http', label: 'HTTPS'},
      {from: 'scheduler', to: 'store', kind: 'plain', label: 'runs · outbox'},
      {from: 'scheduler', to: 'redis', kind: 'redis', label: 'queue · leases'},
      {from: 'scheduler', to: 'worker', kind: 'grpc', label: 'StartRun / Preempt'},
      {from: 'worker', to: 'cluster', kind: 'plain', label: 'register · heartbeat'},
      {from: 'scheduler', to: 'cluster', kind: 'plain', label: 'reconcile'},
      {from: 'scheduler', to: 'kafka', kind: 'kafka', label: 'produce training.run'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'store', kind: 'plain', label: 'run history'},
    ],
  },
  steps: [trainingEndpointStep, trainingStateStep, trainingDependencyStep, trainingEventsStep, trainingReadStep],
};
