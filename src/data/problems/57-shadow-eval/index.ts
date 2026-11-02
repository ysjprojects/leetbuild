import type {Problem} from '@/lib/types';

import {shadowEndpointStep} from './steps/1-endpoint';
import {shadowStateStep} from './steps/2-state';
import {shadowClientStep} from './steps/3-client';
import {shadowEventsStep} from './steps/4-events';
import {shadowReadStep} from './steps/5-read';

/**
 * Shadow evaluation: the course is not "send a copy of the request to another model", it is the
 * debugging a shadow runner needs before it is trusted with live production traffic. An
 * observe-only config boundary, Redis state in its own namespace with one fleet-wide flag and its
 * own budget, a candidate call that cannot block the request thread, paired comparison events
 * keyed by config and free of user content, and a report that refuses to declare a winner before
 * the samples justify it.
 */
export const shadowEvalProblem: Problem = {
  id: 'shadow-eval',
  title: 'Shadow Evaluation',
  tagline:
    'Run a candidate model beside production on a slice of live traffic, with its own Redis budget and a report that waits for 500 pairs.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Shadow Evaluation

Shadow evaluation lets a candidate model version run beside production on real traffic without
changing a user-visible answer. The visible part is a percentage in a config; what decides whether
the system is safe is the side-effect boundary, the isolation of its state, the discipline of the
candidate call, and whether the report admits what it does not know.

## The real system

Istio's traffic mirroring is the mesh-level version: a \`VirtualService\` names a \`mirror\`
destination and a \`mirrorPercentage\`, the proxy sends that fraction of requests to the mirrored
service with \`-shadow\` appended to the Host header, and the mirrored requests are fire and forget,
their responses discarded. That gives you the request copy and the share; everything above the
proxy is what this course builds. A shadow runner for models keeps the candidate path
**observe-only**: it may read the request and write into its own namespace, and it may not mutate
production state or consume a key production still needs. Its Redis state is keyed by config id so
a shadow cannot draw on a tenant's production quota, and one enabled flag makes a disable take
effect everywhere on the next request. The candidate call runs beside the request, not inside it:
a short deadline, a hard concurrency cap, overloads dropped and counted, no retries. Each
comparison publishes one event keyed by config id with both versions, scores and a fingerprint,
without prompt or completions, and the report says inconclusive below the sample threshold.

## What you build here

One service, the shadow runner, with five pieces:

1. \`POST /v1/shadow/configs\`: authenticated tenant, candidate version, share of 1 to 20 percent,
   validated metrics, writes only into its own namespace, **409** for a production idempotency key.
2. A **Redis** state layer: config-scoped keys, one fleet-wide enabled flag read once per request,
   a shadow budget reserved atomically, separate from the tenant's production counters.
3. A **gRPC** candidate client: a 300 ms deadline, a hard per-instance concurrency cap, overloads
   dropped and counted, no retries, dispatched off the request path.
4. A **Kafka** comparison path: one \`shadow.sample\` event per paired evaluation keyed by config id,
   carrying versions, scores and a fingerprint, with an outbox row when the produce is rejected.
5. \`GET /v1/shadow/configs/{id}/report\`: paired deltas with sample counts, confidence intervals and
   the traffic window, **inconclusive** below 500 pairs, **404** for another tenant's config.

## The debugging habit

Every starter is working code with flaws: it compiles, serves the happy path and looks right. In
each step you debug it against the failure modes, fix it, and prove the fix with checks that fail
on the starter and pass on your version.

## Left out on purpose

Experiment scheduling and ramp-up, power analysis beyond a fixed threshold, metric definitions,
cost attribution between the two paths, multi-region mirroring, and long-term experiment storage.`,
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
