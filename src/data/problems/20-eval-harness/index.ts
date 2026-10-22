import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Eval harness on the AI-era track: the course is not "compare two strings", it is the review you
 * owe a model-generated scoring pipeline before a release rides on its numbers. Validated,
 * idempotent runs → one atomic Redis progress script with per-sample dedupe → a deadline-bounded
 * judge call with a deterministic fallback and a breaker → run-keyed sample events with an outbox
 * and counters before the offset commit → a read gate that only opens on a complete, current
 * record.
 */
export const evalHarnessProblem: Problem = {
  id: 'eval-harness',
  title: 'Eval Harness',
  tagline: 'Score model outputs against golden labels, sample by sample, before anything ships.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Eval Harness

An eval harness is the piece of an AI platform that answers one question before a model version
ships: does it score at least as well as the last one on the samples we trust. The visible part is
a number on a dashboard; the parts that decide whether anyone can believe that number are the
validation funnel, the atomic progress counters, the deadline-bounded judge call, the per-sample
event, and the gate that reads the finished record.

## The real system

Production eval harnesses start a run only for a dataset the service owns, with a sample budget
someone can afford, and they answer a retried start with the run they already created. They score
sample by sample on workers, so progress arrives concurrently: the counters move inside one atomic
step, and a redelivered sample is recognized by its own key instead of being scored twice. Each
sample goes to a judge model under a deadline, with a bounded number of attempts on the statuses
that deserve one, a deterministic fallback when the judge is down, and a breaker so a sick judge is
not hammered. Every scored sample is published keyed by run so one run's results stay ordered, with
no sample text in a topic that is retained and replicated, and an outbox row when the broker
rejects the produce. The consumer folds the sample into the counters before it commits the offset.
And nothing ships on a report that was cached before the last batch, or that was gated by whatever
threshold the caller put in the query string.

## What you build here

One service, **evald**, with five pieces:

1. \`POST /v1/evals/runs\`: authenticated tenant, a dataset that exists, a 1..5000 sample budget,
   a non-empty model version, and an \`Idempotency-Key\` so a retry resumes the original run.
2. A **Redis** progress ledger: \`scored\`, \`passed\` and \`failed\` counters per run, a per-sample
   dedupe key, and a TTL tied to the run — all moved inside one atomic script.
3. A **gRPC** judge client: an 800 ms deadline per attempt, at most three attempts, retries only on
   \`UNAVAILABLE\`, a deterministic string metric as the fallback, a breaker after five failures for
   30 seconds, and no retry of a malformed sample.
4. A **Kafka** result path: one \`eval.sample\` event per sample keyed by run id, an idempotent
   producer with \`acks=all\`, ids and scores instead of sample text, an outbox row when the broker
   rejects the produce, and a consumer that folds the sample into the counters before it commits.
5. \`GET /v1/evals/runs/{id}\`: tenant-scoped, a 200-sample floor, a release threshold from server
   config, and a cache that changes the moment the scored count does.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Golden-set curation and labeling, judge prompt engineering, statistical significance testing,
per-slice and per-language breakdowns, dataset versioning, cost accounting for judge calls, and the
dashboard. The five pieces above are the ones that decide whether the numbers are correct, current
and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Eval CLI', sub: 'start · report', x: 8, y: 50},
      {id: 'harness', kind: 'http', label: 'Eval Harness', sub: 'HTTPS :8443', x: 27, y: 50},
      {id: 'db', kind: 'db', label: 'datasets · runs', sub: 'registry · outbox', x: 48, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'counters · dedupe', x: 48, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'eval.sample', sub: 'key = run', x: 48, y: 90},
      {id: 'judge', kind: 'grpc', label: 'Judge model', sub: 'Score', x: 70, y: 10},
      {id: 'fallback', kind: 'external', label: 'String metric', sub: 'exact match', x: 70, y: 36},
      {id: 'worker', kind: 'service', label: 'Eval worker', sub: 'score · fold', x: 70, y: 66},
    ],
    edges: [
      {from: 'client', to: 'harness', kind: 'http', label: 'HTTPS'},
      {from: 'harness', to: 'db', kind: 'plain', label: 'datasets · runs · outbox'},
      {from: 'harness', to: 'redis', kind: 'redis', label: 'counters · dedupe'},
      {from: 'harness', to: 'judge', kind: 'grpc', label: 'Score'},
      {from: 'harness', to: 'fallback', kind: 'grpc', label: 'on UNAVAILABLE'},
      {from: 'harness', to: 'kafka', kind: 'kafka', label: 'produce eval.sample'},
      {from: 'kafka', to: 'worker', kind: 'kafka', label: 'consume'},
      {from: 'worker', to: 'judge', kind: 'grpc', label: 'Score sample'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'EVAL fold'},
      {from: 'worker', to: 'db', kind: 'plain', label: 'outbox drain'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
