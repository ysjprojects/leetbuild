import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Fine-tune orchestrator on the AI-era track: the course is not "submit a fine-tune job", it is the
 * review you owe a model-generated training pipeline before it spends a week of GPUs and promotes an
 * unvalidated artifact. A reproducible, idempotent job submission → one atomic Redis reservation per
 * job released exactly once → a trainer watched over gRPC whose missed heartbeats checkpoint before
 * they restart → job-keyed events that carry hashes rather than recipes → a read path that reports a
 * run as trained but not promotable when its eval gate failed.
 */
export const fineTuneOrchestratorProblem: Problem = {
  id: 'fine-tune-orchestrator',
  title: 'Fine-tune Orchestrator',
  tagline: 'Fine-tuning jobs with reproducible configs, budget gates and rollback-safe promotion.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Fine-tune Orchestrator

A fine-tune orchestrator is the piece of an AI platform that turns "train this base model on this
dataset" into a long-running job: it decides whether the recipe is reproducible, whether the team can
afford it, which worker may advance it, what happens when the trainer goes quiet for a minute, and
whether the finished artifact is allowed anywhere near production. The visible part is a job id; the
parts that decide whether the platform is safe are the validation funnel, the reservation, the
failure policy and the promotion gate.

## The real system

Production orchestrators are budgeted state machines, not shell scripts with a timer. A submission is
validated against the registry — a base model version and a dataset version, both hashed — and its
hyperparameters must be a subset of what the base model's recipe defines, because "the same config" is
only meaningful if the knobs are the same. The job's compute budget is reserved from the team pool in
one atomic Redis script at submission, so ten submissions cannot all start and oversubscribe the
cluster, and the release on completion returns only the unused remainder and is idempotent against a
redelivered callback. The trainer is driven over gRPC under a 60-second heartbeat deadline; a missed
heartbeat asks for a checkpoint before anything restarts, a trainer that cannot checkpoint is failed
explicitly rather than restarted blind, and repeated failures stop the job instead of looping. Every
transition publishes a job-keyed event that carries the config hash, the dataset version and the
checkpoint ids — never the hyperparameter block, never a sample of the loss log — and the job record is
committed before the event is produced. The read path returns status, spent budget, checkpoint lineage
and the eval gate result, refuses to serve another team's job, and reports a run whose eval did not
pass as trained but not promotable.

## What you build here

One service, **finetuned**, with five pieces:

1. \`POST /v1/finetune/jobs\`: an authenticated team, a base model version and a dataset version that
   must both exist in the registry, a hyperparameter block that must be a subset of the base model's
   supported set and is canonicalised into a \`config_hash\`, a positive compute budget, and an
   \`Idempotency-Key\` so a retry returns the original job.
2. A **Redis** queue with reservations: \`submit\` takes the budget out of \`pool:{team}\` in one
   atomic script before it queues the job, \`start\` refuses a job whose reservation is gone,
   \`complete\` returns only \`reserved - spent\` and only once, and \`cancel\` frees the whole
   reservation.
3. A **gRPC** trainer client: a 60-second heartbeat deadline, a checkpoint request before any restart,
   a restart that names the checkpoint it resumed from, an explicit failure when the trainer cannot
   checkpoint, and a stop after repeated heartbeat failures.
4. A **Kafka** event path: \`finetune.job\` keyed by job id, a payload of \`config_hash\`,
   \`dataset_version\`, \`checkpoint_ids\` and \`status\`, an idempotent \`acks=all\` producer, and a
   produce that happens after the job record commits.
5. \`GET /v1/finetune/jobs/{id}\`: team-scoped, with the eval gate, a \`promotable\` flag that needs
   both exit code zero and a passing eval, a reconciled budget and the checkpoint lineage.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Registry write paths, dataset hashing pipelines, checkpoint storage and retention, GPU scheduling and
placement, hyperparameter search, multi-region training, the eval service's own golden sets, and cost
accounting. The five pieces above are the ones that decide whether a fine-tune is reproducible,
isolated and safe to promote.`,
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
