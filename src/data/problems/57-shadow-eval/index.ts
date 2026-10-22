import type {Problem} from '@/lib/types';

import {shadowEndpointStep} from './steps/1-endpoint';
import {shadowStateStep} from './steps/2-state';
import {shadowClientStep} from './steps/3-client';
import {shadowEventsStep} from './steps/4-events';
import {shadowReadStep} from './steps/5-read';

/**
 * Shadow evaluation on the AI-era track: the course is not "send a copy of the request to another
 * model", it is the review you owe a model-generated shadow runner before it is trusted with live
 * production traffic. An observe-only config boundary → Redis state in its own namespace with one
 * fleet-wide flag and its own budget → a candidate call that can never block the request thread →
 * paired comparison events keyed by config and free of user content → a report that refuses to
 * declare a winner before the samples justify it.
 */
export const shadowEvalProblem: Problem = {
  id: 'shadow-eval',
  title: 'Shadow Evaluation',
  tagline: 'Run a candidate version beside production on live traffic without letting it act.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Shadow Evaluation

Shadow evaluation is the piece of an AI platform that lets a candidate model version run beside
production on real traffic without changing a single user-visible answer. The visible part is a
percentage in a config; the parts that decide whether the system is safe are the side-effect
boundary, the isolation of its state, the discipline of the candidate call, and the honesty of the
report at the end.

## The real system

Production shadow runners take a config that names a candidate version, a small traffic share and
the metrics to compare, and they guarantee that the candidate path is **observe-only**: it may read
the request, it may write into its own namespace, and it may never mutate production state or consume
a key production still needs. Their Redis state is keyed by config id so a shadow can never draw on
a tenant's production quota, and the config's enabled flag lives in one place so a disable takes
effect everywhere on the very next request. The candidate call runs beside the request, not inside
it: a short deadline, a hard concurrency cap, overloads dropped and counted, and no retries — an
unhealthy candidate must cost production exactly zero. Every comparison publishes one event keyed by
config id, carrying both versions, the scores and a request fingerprint, and never the prompt or the
completions. And the report refuses to celebrate: below the sample threshold it says inconclusive,
because a positive delta on a dozen pairs is noise.

## What you build here

One service, the shadow runner, with five pieces:

1. \`POST /v1/shadow/configs\`: authenticated tenant, a candidate version, a traffic share of 1–20
   percent, a validated metric set, and a path that writes only into its own analytics namespace —
   a reused production idempotency key is rejected rather than answered.
2. A **Redis** state layer: config-scoped keys, one atomic fleet-wide enabled flag read once per
   request, and a shadow budget reserved atomically that a shadow can exhaust without touching a
   tenant's production counters.
3. A **gRPC** candidate client: a 300 ms deadline per call, a hard per-instance concurrency cap,
   overloads and timeouts dropped and counted, no queueing and no retries, so a stuck candidate
   never appears in production latency.
4. A **Kafka** comparison path: one \`shadow.sample\` event per paired evaluation keyed by config id,
   carrying both versions, scores and a request fingerprint — never prompt or response text — with
   an outbox row when the produce is rejected.
5. \`GET /v1/shadow/configs/{id}/report\`: paired score deltas with sample counts, confidence
   intervals and the exact traffic window, an **inconclusive** verdict below 500 paired samples, and
   a **404** for another tenant's config.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Experiment scheduling and automatic ramp-up, statistical power analysis beyond a fixed threshold,
metric definitions and normalization, cost attribution between candidate and production paths,
multi-region traffic mirroring, config authoring UIs, and long-term experiment storage. The five
pieces above are the ones that decide whether a shadow is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'config · report', x: 8, y: 50},
      {id: 'shadow', kind: 'http', label: 'Shadow Service', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'config store · outbox', sub: 'shadow_configs', x: 48, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'shadow:{cfg} · budget', x: 48, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'shadow.sample', sub: 'key = config', x: 48, y: 86},
      {id: 'candidate', kind: 'grpc', label: 'Candidate model', sub: 'Complete · 300 ms', x: 74, y: 40},
      {id: 'prodmodel', kind: 'grpc', label: 'Production model', sub: 'Complete', x: 74, y: 14},
      {id: 'consumer', kind: 'service', label: 'Comparison consumer', sub: 'group shadow-pairs', x: 74, y: 84},
    ],
    edges: [
      {from: 'client', to: 'shadow', kind: 'http', label: 'HTTPS'},
      {from: 'shadow', to: 'db', kind: 'plain', label: 'config · outbox'},
      {from: 'shadow', to: 'redis', kind: 'redis', label: 'flag · budget'},
      {from: 'shadow', to: 'prodmodel', kind: 'grpc', label: 'Complete'},
      {from: 'shadow', to: 'candidate', kind: 'grpc', label: 'shadow · observe'},
      {from: 'shadow', to: 'kafka', kind: 'kafka', label: 'produce shadow.sample'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'score deltas'},
    ],
  },
  steps: [shadowEndpointStep, shadowStateStep, shadowClientStep, shadowEventsStep, shadowReadStep],
};
