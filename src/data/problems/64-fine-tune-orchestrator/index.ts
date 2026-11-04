import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Fine-tune orchestrator: the debugging a training pipeline owes before it spends a week of GPUs and
 * promotes an unvalidated artifact. A registry-pinned, idempotent submission → GPU-hour reservations
 * in one Lua script per transition → a trainer supervisor that checkpoints before it restarts and
 * gives up after three missed heartbeats → job-keyed events produced after the commit → a read path
 * that keeps trained and promotable apart. The trainer is a deterministic stand-in the harness serves.
 */
export const fineTuneOrchestratorProblem: Problem = {
  id: 'fine-tune-orchestrator',
  title: 'Fine-tune Orchestrator',
  tagline: 'Fine-tune jobs with GPU-hour reservations in Lua and a supervisor that checkpoints before it restarts.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Fine-tune Orchestrator

A fine-tune orchestrator turns "train this base model on this dataset" into a long-running job. It
decides whether the recipe can be reproduced, whether the team can afford it, what happens when the
trainer goes quiet, and whether the result may be promoted.

## The real system

The Kubeflow Training Operator keeps failure policy on the job itself: a \`PyTorchJob\` carries
\`runPolicy.backoffLimit\`, and with \`restartPolicy: ExitCode\` a replica that exits with a code below
128 counts as a permanent failure and is not restarted, while higher codes are retried. An
orchestrator above it adds what this course builds: a registry lookup that pins the dataset by content
hash, a GPU-hour budget reserved per team before a job queues, a checkpoint before any restart,
job-keyed events, and a read path that keeps "trained" and "promotable" apart.

## What you build here

One service, **finetuned**, with one contract, the \`finetune\` support package: \`config\` (the trainer
at \`trainer:9000\`, the topic \`finetune.job\`, the Redis keys), \`registry\` (base models with the
hyperparameters they support, dataset versions with a SHA-256 and a status), \`recipe.config_hash\`, the
job store \`jobs\` (\`get\`, \`put\`, \`by_id\`, \`transition\`), \`evals\` and \`outbox\`.

1. \`POST /v1/finetune/jobs\` (\`api\`): \`X-Team-Id\`, \`Idempotency-Key\`, a body of \`base_model\`,
   \`dataset_version\`, \`hyperparameters\` and \`compute_budget\` (GPU-hours); it answers the stored job
   with its \`dataset_sha256\` and \`config_hash\`.
2. **Redis budget** (\`budget\`): the pool \`ft:pool:{team}\`, the hash \`ft:reservation:{job_id}\`
   (\`reserved\`, \`spent\`, \`state\`) and the list \`ft:queue:{team}\`; \`submit\`, \`start\`, \`complete\`
   and \`cancel\` are one Lua script each.
3. **Trainer supervisor** (\`supervisor\`, gRPC \`finetuned.Trainer\`: \`Heartbeat\`,
   \`RequestCheckpoint\`, \`Restart\`): watches one run to its end and answers
   \`{status, reason, restarts, checkpoint_ids}\`.
4. **Kafka** (\`events\`): \`record_transition\` commits a status through \`jobs.transition\`, then
   produces \`{job_id, team, status, config_hash, dataset_version, checkpoint_ids}\` to \`finetune.job\`
   keyed by job id; a refused produce goes to the outbox.
5. \`GET /v1/finetune/jobs/{job_id}\` (\`read\`): team-scoped, with \`trained\`, the eval, \`promotable\`,
   the budget \`{reserved, spent, remaining}\` and the checkpoint lineage.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path and looks right. The task
says where the flaws live; the checks say what must change. Reproduce the failure a check describes
before you change a line, then make the smallest fix that holds.

## Left out on purpose

Registry write paths, dataset hashing, checkpoint storage, GPU scheduling, hyperparameter search, the
eval service's golden sets and cost accounting.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · read', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Fine-tune API', sub: 'POST jobs', x: 28, y: 22},
      {id: 'readapi', kind: 'http', label: 'Job read API', sub: 'GET jobs/{id}', x: 28, y: 80},
      {id: 'registry', kind: 'service', label: 'Registry', sub: 'models · dataset versions', x: 50, y: 6},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'jobs · pool · reservations · evals', x: 50, y: 50},
      {id: 'supervisor', kind: 'service', label: 'Supervisor', sub: 'heartbeat · checkpoint', x: 50, y: 92},
      {id: 'trainer', kind: 'grpc', label: 'Trainer', sub: 'trainer:9000', x: 74, y: 92},
      {id: 'kafka', kind: 'kafka', label: 'finetune.job', sub: 'key = job id', x: 74, y: 50},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'submit'},
      {from: 'client', to: 'readapi', kind: 'http', label: 'read'},
      {from: 'api', to: 'registry', kind: 'plain', label: 'resolve versions'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'job · reserve'},
      {from: 'supervisor', to: 'trainer', kind: 'grpc', label: 'Heartbeat · RequestCheckpoint · Restart'},
      {from: 'redis', to: 'kafka', kind: 'kafka', label: 'transition, then produce'},
      {from: 'readapi', to: 'redis', kind: 'redis', label: 'job · reservation · eval'},
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
