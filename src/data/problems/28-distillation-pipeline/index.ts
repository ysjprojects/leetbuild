import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Distillation pipeline: the debugging a pipeline owes before its output becomes a student's
 * training set. A budgeted, idempotent job → a Redis budget reservation in one Lua script → teacher
 * calls with a deadline, bounded retries and refusals that are recorded → dataset-keyed sample events
 * behind a shared dedupe index with an outbox → an acceptance report that reconciles its counters and
 * flags a rate that looks too good. The teacher is a deterministic stand-in the harness serves over gRPC.
 */
export const distillationPipelineProblem: Problem = {
  id: 'distillation-pipeline',
  title: 'Distillation Pipeline',
  tagline:
    'Teacher samples under a token budget: a Redis reservation, a dedupe index, a dataset-keyed topic, a report that adds up.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Distillation Pipeline

Distillation is how a small, cheap student model inherits the behaviour of a large, expensive
teacher: generate teacher outputs over a corpus, filter them, train the student on what survives.
The artefact is a student checkpoint; what decides its worth is the job budget, the filter, and the
report that proves what the student saw.

## The real system

NVIDIA's NeMo Curator runs the filter at corpus scale: its exact-duplicate workflow hashes each
document's text (MD5) and writes only the ids of the documents to remove, not their content; a fuzzy
pass (MinHash) catches near duplicates. A pipeline that feeds a student from a teacher puts that filter
in front of training and adds what this course builds around it: a per-job token budget every worker
can see, a teacher call with a deadline and a retry policy that knows a refusal from an outage, and a
report whose counts are checked against each other before anyone trusts the rate.

## What you build here

One service, **distilld**, with five pieces sharing one contract, the \`distill\` support package
(\`config\`: the teacher address, the topic, the key layout, the cost of a call):

1. \`POST /v1/distill/jobs\`: a catalog teacher, a dataset id, a cap of 100..10 000, an
   \`Idempotency-Key\`; the job is stored under \`(tenant, key)\` so a replay resumes it.
2. **Redis job state**: \`distill:budget:{job}\`, the seen set of prompt hashes, the progress hash
   (\`sampled\`, \`accepted\`, \`rejected\`, \`duplicate\`, \`updated_at\`), the reasons hash. \`reserve\` is one
   Lua script: a seen hash is a \`duplicate\` and costs nothing, an unaffordable call is \`budget\`,
   otherwise it draws \`TOKENS_PER_CALL\` and counts \`sampled\`. \`record\` adds \`accepted\` or \`rejected\`
   with a reason. Invariant: \`sampled == accepted + rejected\` once every reservation is recorded.
3. **Teacher client** (gRPC, a stand-in the checks serve): reserve, then up to three attempts under a
   four-second deadline, retrying \`UNAVAILABLE\` only; refusals, empty completions and deadlines are
   recorded as rejected with a reason, once per sample.
4. **Kafka**: accepted samples on \`distill.sample\` keyed by dataset, ids only, behind the shared dedupe
   index, with an outbox row written from the delivery report when the broker refuses.
5. \`GET /v1/distill/jobs/{id}\`: live counters with \`updated_at\`, the reasons, 409 when the counts do
   not reconcile, a flag above a 95 percent acceptance rate.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path and looks right. The task
says where the flaws live; the checks say what must change.

## Left out on purpose

Teacher hosting, near-duplicate detection beyond an exact hash, sample quality scoring, the trainer,
checkpoint evaluation, the outbox relay and cost accounting. The five pieces above decide whether the
training data is bounded, deduplicated and accounted for.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Distill client', sub: 'start · poll', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'distilld', sub: 'API + worker', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'jobs · budget · seen · progress · outbox', x: 50, y: 20},
      {id: 'teacher', kind: 'grpc', label: 'Teacher', sub: 'Generate · 4 s', x: 50, y: 80},
      {id: 'kafka', kind: 'kafka', label: 'distill.sample', sub: 'key = dataset_id', x: 72, y: 50},
      {id: 'trainer', kind: 'service', label: 'Trainer', sub: 'consumer group student', x: 92, y: 50},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST / GET jobs'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVALSHA reserve · record · HGETALL'},
      {from: 'api', to: 'teacher', kind: 'grpc', label: 'Generate'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce (ids only)'},
      {from: 'kafka', to: 'trainer', kind: 'kafka', label: 'consume'},
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
