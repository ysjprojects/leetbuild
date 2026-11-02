import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Fine-tune orchestrator: the course is not "submit a fine-tune job", it is the debugging you owe a
 * training pipeline before it spends a week of GPUs and promotes an unvalidated artifact. A
 * reproducible, idempotent job submission → one atomic Redis reservation per job released exactly
 * once → a trainer watched over gRPC whose missed heartbeats checkpoint before they restart →
 * job-keyed events that carry hashes rather than recipes → a read path that reports a run as
 * trained but not promotable when its eval gate failed.
 */
export const fineTuneOrchestratorProblem: Problem = {
  id: 'fine-tune-orchestrator',
  title: 'Fine-tune Orchestrator',
  tagline: 'Fine-tune jobs with Redis budget reservations and an eval gate before promotion.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Fine-tune Orchestrator

A fine-tune orchestrator turns "train this base model on this dataset" into a long-running job: it
decides whether the recipe is reproducible, whether the team can afford it, what happens when the
trainer goes quiet, and whether the artifact is allowed near production.

## The real system

Production orchestrators are state machines. The Kubeflow Training Operator's
\`PyTorchJob\` carries a \`runPolicy.backoffLimit\` (retries before the job is marked failed) and a
replica \`restartPolicy: ExitCode\`, where exit codes 1 to 127 are permanent and not restarted while
128 to 255 are retryable: the failure policy is data on the job, not a loop in a client. A
submission is validated against a registry of hashed model and dataset versions. The compute budget
is reserved from the team pool in one atomic Redis script at submission, and the release returns
only the unused remainder, once. A missed trainer heartbeat asks for a checkpoint before anything
restarts. Every transition publishes a job-keyed event carrying hashes and checkpoint ids rather than
the hyperparameter block, produced after the job record commits. The read path reports a run whose
eval did not pass as trained but not promotable.

## What you build here

One service, **finetuned**, in five pieces:

1. \`POST /v1/finetune/jobs\`: registered base model and dataset versions, hyperparameters
   restricted to the base model's supported set and hashed into a \`config_hash\`, a positive
   compute budget, and an \`Idempotency-Key\`.
2. A **Redis** queue: \`submit\` reserves from \`pool:{team}\` in one atomic script before queuing,
   \`start\` refuses a job whose reservation is gone, \`complete\` returns \`reserved - spent\`
   once, and \`cancel\` frees the whole reservation.
3. A **gRPC** trainer client: a 60-second heartbeat deadline, a checkpoint before any restart, a
   restart that names its checkpoint, an explicit failure when the trainer cannot checkpoint, and a
   stop after repeated failures.
4. A **Kafka** event path: \`finetune.job\` keyed by job id, a payload of \`config_hash\`,
   \`dataset_version\`, \`checkpoint_ids\` and \`status\`, an idempotent \`acks=all\` producer, a
   produce after commit.
5. \`GET /v1/finetune/jobs/{id}\`: team-scoped, with the eval gate, a \`promotable\` flag that needs
   exit code zero and a passing eval, a reconciled budget and the checkpoint lineage.

## The debugging habit

Every starter compiles, serves the happy path and looks right. In every step you debug it against
the failure modes, fix it, and prove the fix with checks that fail on the starter and pass on yours.

## Left out on purpose

Registry write paths, dataset hashing, checkpoint storage, GPU scheduling, hyperparameter search,
multi-region training, the eval service's golden sets, and cost accounting.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · read', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Fine-tune API', sub: 'POST jobs', x: 30, y: 26},
      {id: 'readapi', kind: 'http', label: 'Job read API', sub: 'GET jobs/{id}', x: 30, y: 74},
      {id: 'registry', kind: 'db', label: 'Registry', sub: 'model · dataset versions', x: 54, y: 8},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'queue · reservations', x: 54, y: 50},
      {id: 'trainer', kind: 'grpc', label: 'Trainer', sub: 'Train · Heartbeat', x: 54, y: 92},
      {id: 'kafka', kind: 'kafka', label: 'finetune.job', sub: 'key = job id', x: 78, y: 50},
      {id: 'checkpoints', kind: 'db', label: 'Checkpoint store', sub: 'lineage', x: 78, y: 14},
      {id: 'eval', kind: 'service', label: 'Eval gate', sub: 'golden set', x: 78, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'submit'},
      {from: 'client', to: 'readapi', kind: 'http', label: 'read'},
      {from: 'api', to: 'registry', kind: 'plain', label: 'resolve versions'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'reserve · enqueue'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce finetune.job'},
      {from: 'redis', to: 'trainer', kind: 'grpc', label: 'start · heartbeat'},
      {from: 'trainer', to: 'checkpoints', kind: 'grpc', label: 'checkpoint'},
      {from: 'readapi', to: 'redis', kind: 'redis', label: 'spent · reservations'},
      {from: 'readapi', to: 'checkpoints', kind: 'plain', label: 'lineage'},
      {from: 'readapi', to: 'eval', kind: 'plain', label: 'eval gate'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
