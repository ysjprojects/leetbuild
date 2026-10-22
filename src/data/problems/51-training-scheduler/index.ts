import type {Problem} from '@/lib/types';

import {trainingEndpointStep} from './steps/1-endpoint';
import {trainingStateStep} from './steps/2-state';
import {trainingDependencyStep} from './steps/3-dependency';
import {trainingEventsStep} from './steps/4-events';
import {trainingReadStep} from './steps/5-read';

/**
 * Training scheduler on the AI-era track: the course is not "accept a training job", it is the
 * review you owe a model-generated scheduler before it owns a shared GPU fleet. Admitted and
 * clamped submissions whose retries replay instead of double-starting → one Redis queue position
 * per run behind a start lease → preemption that waits for a checkpoint id → run-keyed lifecycle
 * events with an outbox → a status endpoint reconciled against the cluster.
 */
export const trainingSchedulerProblem: Problem = {
  id: 'training-scheduler',
  title: 'Training Scheduler',
  tagline: 'Enqueue training runs against shared capacity without starvation or double-start.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Training Scheduler

A training scheduler is the piece of an AI platform that turns "train this recipe on this dataset"
into work that runs **exactly once** on a GPU the cluster can actually spare. The visible part is a
run id and a queue position; the parts that decide whether the platform is safe are the admission
funnel, the leased handoff between the queue and the worker, the preemption that checkpoints before
it kills, and the event history that makes a run's life auditable.

## The real system

Production schedulers receive submissions from many tenants, admit a run only when the recipe and
dataset versions are ones the registry knows, and clamp the priority a caller claims so a typo
cannot jump every queue. They keep queue positions in one shared structure that a run occupies
exactly once, even when two schedulers boost the same run at the same moment. They hand a run to a
worker under a lease, so a crash between dequeue and process start returns the run instead of losing
it. When higher-priority work arrives they ask the running job to preempt over gRPC and refuse to
terminate the process until a checkpoint id comes back, because a killed run that never checkpointed
throws away hours of GPU time. And every transition is published keyed by run id, so a consumer can
reconstruct one run's history in order while runs interleave.

## What you build here

One service, **trainsched**, with five pieces:

1. \`POST /v1/training/runs\`: tenant from the authenticated header, validated dataset and recipe
   versions, a priority **clamped** into the supported bands, and an \`Idempotency-Key\` so a retry
   after a timeout returns the original run instead of starting a second one.
2. A **Redis** queue: one position per run derived from the priority band and the enqueue time,
   position updates that cannot leave a duplicate behind, and a start lease with a TTL so a worker
   that dies during startup returns the run with its original band intact.
3. A **gRPC** preemption call: a grace deadline, termination only after a checkpoint id is received,
   and a job that reports no checkpoint support left running while the new work queues behind it.
4. A **Kafka** lifecycle topic: one \`training.run\` event per transition, keyed by run id, carrying
   node counts and checkpoint ids, with \`started\` published only after the worker confirms, and an
   outbox row when the broker rejects the produce.
5. \`GET /v1/training/runs/{id}\`: reported queue position, lease state, node assignment and last
   checkpoint reconciled against the cluster's view, orphaned runs surfaced as failed with a
   reason, and another tenant's run invisible.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Dataset versioning internals, recipe authoring, the cluster's own bin-packing and node autoscaling,
per-tenant GPU quotas, cost accounting, the training framework's checkpoint format, and the worker
image build. The five pieces above are the ones that decide whether the scheduler is correct,
isolated and shippable.`,
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
