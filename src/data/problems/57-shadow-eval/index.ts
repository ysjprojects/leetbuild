import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {shadowEndpointStep} from './steps/1-endpoint';
import {shadowStateStep} from './steps/2-state';
import {shadowClientStep} from './steps/3-client';
import {shadowEventsStep} from './steps/4-events';
import {shadowReadStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Shadow evaluation: the course is not "send a copy of the request to another model", it is the
 * debugging a shadow runner needs before it runs beside live traffic. A config that writes only
 * into its own namespace → a kill switch read on every request and a Lua-reserved budget of its
 * own → a candidate call under a deadline, once, behind a breaker → config-keyed comparison events
 * with no user content → a report that stays inconclusive until the samples justify a verdict.
 */
export const shadowEvalProblem: Problem = {
  id: 'shadow-eval',
  title: 'Shadow Evaluation',
  tagline: 'A candidate model beside production: share caps, a Redis budget, a 300 ms deadline and a 500-pair report.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Shadow Evaluation

Shadow evaluation runs a candidate model version on a slice of real traffic while production keeps
answering every user. The user never sees the candidate; what decides whether the shadow is safe is
everything around that copy: what it may write, what it may spend, what it may cost the production
request, what it may keep, and what its report may claim.

## The real system

Istio mirrors traffic at the mesh: a \`VirtualService\` names a \`mirror\` destination and a
\`mirrorPercentage\`, the proxy sends that fraction of requests to the mirror with \`-shadow\`
appended to the Host header, and the mirrored requests are fire and forget, their responses
discarded. That gives a copy of the request and a share. Comparing two model versions needs what
the mesh does not do, which is what this course builds.

## What you build here

One service, the **shadow runner**, on one store (\`shadow.store\`, provided: configs and their kill
switch, idempotency namespaces, outcome counters, the paired-delta aggregate, the outbox, and the
prompt fingerprint):

1. \`POST /v1/shadow/configs\` with \`X-Tenant-Id\` and an optional \`Idempotency-Key\`:
   \`{candidate_version, share, metrics}\`, a share of 1 to 20 percent, metrics from latency, cost
   and quality, the key recorded in the shadow's own namespace.
2. \`admit(config_id)\` in **Redis**: the kill switch \`shadow:{id}:enabled\` read on every request,
   then one Lua reservation on the shadow's own budget \`shadow:{id}:budget\`.
3. \`complete(config_id, prompt)\` over **gRPC** \`Model.Complete\`: production answers; the candidate
   gets one call under a 300 ms deadline, failures are counted, five in a row open a 30 s breaker.
4. \`publish_sample(config_id, pair)\` to **Kafka** \`shadow.sample\`, keyed by config id: versions,
   scores, the delta and the prompt's fingerprint, with an outbox row when the broker refuses.
5. \`GET /v1/shadow/configs/{id}/report\`: count, mean delta, 95 percent interval and window from
   \`shadow:{id}:pairs\`, \`inconclusive\` below 500 pairs, 404 for another tenant's config.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path and looks right. In
each step you debug it against the failure modes the task names, fix it, and prove the fix with
checks that fail on the starter and pass on your version.

## Left out on purpose

Sampling the share per request, ramp-up schedules, metric definitions and the evaluator that scores
a pair, power analysis beyond a fixed threshold, multi-region mirroring, and the outbox relay.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'config · report', x: 8, y: 50},
      {id: 'shadow', kind: 'http', label: 'Shadow runner', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'shadow:{id}:* · outbox', x: 50, y: 14},
      {id: 'prodmodel', kind: 'grpc', label: 'Production model', sub: 'Model.Complete', x: 74, y: 30},
      {id: 'candidate', kind: 'grpc', label: 'Candidate model', sub: 'Complete · 300 ms', x: 74, y: 56},
      {id: 'kafka', kind: 'kafka', label: 'shadow.sample', sub: 'key = config id', x: 50, y: 86},
      {id: 'consumer', kind: 'service', label: 'Comparison consumer', sub: 'shadow:{id}:pairs', x: 74, y: 86},
    ],
    edges: [
      {from: 'client', to: 'shadow', kind: 'http', label: 'HTTPS'},
      {from: 'shadow', to: 'redis', kind: 'redis', label: 'config · switch · budget'},
      {from: 'shadow', to: 'prodmodel', kind: 'grpc', label: 'Complete'},
      {from: 'shadow', to: 'candidate', kind: 'grpc', label: 'shadow · once'},
      {from: 'shadow', to: 'kafka', kind: 'kafka', label: 'produce sample'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'paired deltas'},
    ],
  },
  steps: [shadowEndpointStep, shadowStateStep, shadowClientStep, shadowEventsStep, shadowReadStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
