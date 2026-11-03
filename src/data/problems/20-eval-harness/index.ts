import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Eval harness: the debugging a scoring pipeline owes before a release rides on its numbers. An
 * idempotent run start against a registered golden set → per-sample progress folded in one Lua script
 * → judge calls with a deadline, bounded retries, a breaker and a string-metric fallback → run-keyed
 * sample events with an outbox → a release gate that reads live counters behind a sample floor. The
 * judge is a deterministic stand-in the harness serves over gRPC.
 */
export const evalHarnessProblem: Problem = {
  id: 'eval-harness',
  title: 'Eval Harness',
  tagline: 'Golden-set runs scored by a judge model, each sample counted once in Redis, before a release gate opens.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Eval Harness

An eval harness answers one question before a model version ships: does it score well enough on the
samples we trust. The visible part is a pass rate on a dashboard; what decides whether anyone can
believe it is how runs start, how samples are counted, what happens when the judge is down, and the
gate that reads the result.

## The real system

The open source \`openai/evals\` framework registers each eval as \`<eval_name>.<split>.<version>\` and
asks authors to bump the version whenever the eval changes, so scores under one name stay comparable.
Its basic templates (\`Match\`, \`Includes\`, \`FuzzyMatch\`) compare a completion with an \`ideal\` label;
model-graded evals hand the sample to a judge model instead. This course wraps that loop in a hosted
service, where retries, restarts and outages are the normal case.

## What you build here

One service, **evald**, sharing one contract: the \`evals\` support package (\`config\`: the judge
address, the topic, \`PASS_SCORE\`, the key layout; \`runs\`, \`datasets\`, \`metrics\`, \`samples\`,
\`outbox\`). A worker scores each golden sample with step 3, folds it into the run with step 2 and
publishes it with step 4.

1. \`POST /v1/evals/runs\`: an authenticated tenant, a registered golden set, a budget of 1..5000 and an
   \`Idempotency-Key\`; the run is stored under \`(tenant, key)\` so a retry resumes it.
2. **Redis progress**: \`evals:progress:{run}\` (\`scored\`, \`passed\`, \`failed\`, \`fallback\`, \`updated_at\`)
   and \`evals:seen:{run}\`, the sample ids already counted. \`record_sample\` is one Lua script.
3. **Judge client** (gRPC, a stand-in the checks serve): an 800 ms deadline per attempt, three attempts
   on \`UNAVAILABLE\` or \`DEADLINE_EXCEEDED\`, a breaker, and \`exact_match\` as the marked fallback.
4. **Kafka**: one \`eval.sample\` event per sample keyed by run id, ids and score only, idempotent with
   \`acks=all\`, an outbox row when the broker does not acknowledge.
5. \`GET /v1/evals/runs/{id}\`: the tenant's run, \`pending\` below 200 scored samples, \`passed\` or
   \`failed\` against the server's threshold, \`unreliable\` when fallbacks dominate, read live.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path and looks right. The task
says where the flaws live; the checks say what must change.

## Left out on purpose

Golden-set curation and labeling, judge prompt design, significance testing, per-slice breakdowns,
cost accounting for judge calls, the outbox relay and the dashboard. The five pieces above decide
whether the number is counted once, current, and trustworthy enough to ship on.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Eval CLI', sub: 'start · report', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'evald', sub: 'API + worker', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'runs · progress · seen · outbox', x: 50, y: 20},
      {id: 'judge', kind: 'grpc', label: 'Judge', sub: 'Score · 800 ms', x: 50, y: 80},
      {id: 'kafka', kind: 'kafka', label: 'eval.sample', sub: 'key = run_id', x: 72, y: 50},
      {id: 'warehouse', kind: 'service', label: 'Results warehouse', sub: 'consumer group', x: 92, y: 50},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST / GET runs'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVALSHA record · HGETALL'},
      {from: 'api', to: 'judge', kind: 'grpc', label: 'Score'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce (ids + score)'},
      {from: 'kafka', to: 'warehouse', kind: 'kafka', label: 'consume'},
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
