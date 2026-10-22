import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Distillation pipeline on the AI-era track: the course is not "call a teacher model", it is the
 * review you owe a model-generated pipeline before its output becomes a student's training set.
 * A budgeted, idempotent job → an atomic Redis budget plus counters → teacher calls with a deadline,
 * bounded retries and refusals that are recorded → dataset-keyed sample events behind a dedupe
 * filter with an outbox → an acceptance report that reconciles its own counters and distrusts a
 * rate that looks too good.
 */
export const distillationPipelineProblem: Problem = {
  id: 'distillation-pipeline',
  title: 'Distillation Pipeline',
  tagline: 'Generate teacher outputs, filter them, and prove a student can learn from the survivors.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Distillation Pipeline

Distillation is how a small, cheap student model inherits the behaviour of a large, expensive
teacher: you generate teacher outputs over a corpus, filter them, and train the student on what
survives. The visible artefact is a student checkpoint; the parts that decide whether it is worth
anything are the job budget, the filter, and the report that proves what the student actually saw.

## The real system

Production pipelines start a distillation job with a hard sample budget, because teacher tokens are
the cost centre and an unbounded job is an unbounded bill. They hold the job's remaining budget in
Redis and move the budget and the progress counters in one atomic step, so a worker crash cannot
leave a sample paid for but uncounted. They call the teacher under a per-attempt deadline, retry only
the failures that are worth retrying, and treat a refusal or an empty completion as a data point
rather than an error to hammer. They publish the survivors to a topic keyed by dataset, so the
training consumer sees one dataset in one order, and they keep the prompt text out of both the topic
and the logs. Finally, they report what happened: counts that reconcile, rejection reasons by name,
and a warning — never a certificate — when the acceptance rate looks too good to be true.

## What you build here

One service, **distilld**, with five pieces:

1. \`POST /v1/distill/jobs\`: an approved teacher from a server-side catalog, a dataset id, a sample
   cap between 100 and 10 000, and an \`Idempotency-Key\` so a replayed request resumes the same job
   instead of starting a second one. Every rejection happens before any sampling.
2. A **Redis** job state: a per-job token budget, the sampled/accepted/rejected counters and the
   rejection reasons, all moved by one Lua script that checks the dedupe set before it spends, so a
   cached hit costs nothing and a crash cannot orphan a sample.
3. A **gRPC** teacher client: a four-second deadline per attempt, retries only on \`UNAVAILABLE\` and
   at most twice, a refusal or an empty completion recorded as rejected, a hung call cut off and
   marked timed out, and no retry that would push the budget negative.
4. A **Kafka** sample path: accepted samples published to \`distill.sample\` keyed by dataset, with
   the teacher version and the dedupe hash in the payload, a duplicate never reaching the topic, and
   an outbox row when the broker rejects the produce.
5. \`GET /v1/distill/jobs/{id}\`: sampled/accepted/rejected counts read from the live counters, the
   rejection reasons, an explicit reconciliation of the three counts, and a flag — not a clean bill
   of health — when the acceptance rate is above 95 percent.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Teacher hosting and quantization, near-duplicate detection beyond an exact hash, sample quality
scoring and curriculum ordering, the trainer itself, checkpoint evaluation, and cost accounting.
The five pieces above are the ones that decide whether the data the student learns from is
trustworthy, bounded and reproducible.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Distill client', sub: 'start · poll', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Distill API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'jobs · outbox', sub: 'status · replay', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'budget · counters', x: 44, y: 62},
      {id: 'teacher', kind: 'grpc', label: 'Teacher model', sub: 'Generate', x: 66, y: 12},
      {id: 'kafka', kind: 'kafka', label: 'distill.sample', sub: 'key = dataset', x: 44, y: 88},
      {id: 'trainer', kind: 'service', label: 'Trainer', sub: 'consume · group student', x: 66, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'db', kind: 'plain', label: 'jobs · outbox'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'budget · counters'},
      {from: 'api', to: 'teacher', kind: 'grpc', label: 'Generate'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce distill.sample'},
      {from: 'kafka', to: 'trainer', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
