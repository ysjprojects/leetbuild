import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Feature flags: the course is not "add a boolean to config", it is the debugging you owe a flag
 * service before it decides what every user sees. Validated, idempotent flag creation against a
 * schema registry → one atomic Redis versioned snapshot swapped whole, with per-flag deterministic
 * bucketing → a kill switch propagated over gRPC with a bounded staleness that a stale snapshot can
 * never overwrite → flag-keyed events carrying rule digests and an outbox, published after the
 * snapshot commits → an explain endpoint that must agree with the served evaluation bit-for-bit
 * without revealing another user's history.
 */
export const featureFlagsProblem: Problem = {
  id: 'feature-flags',
  title: 'Feature Flags',
  tagline:
    'A flag service with a schema registry, one atomic snapshot, a kill switch that outruns stale caches, and an explain endpoint that matches what was served.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Feature Flags

A feature-flag service decides which users see which behavior, without a deploy. The visible part is
a boolean in a response; the parts that keep the platform safe are the validation funnel at
creation, the snapshot every evaluation reads, the kill switch, the event stream that keeps a flag's
history ordered, and the explanation endpoint that must agree with what was served.

## The real system

LaunchDarkly's percentage rollouts hash the context key and context kind into 100,000 buckets and
assign bucket ranges to variations in order, so raising a rollout from 50% to 70% adds buckets
50,001 to 70,000 without moving anyone already in. Different flags bucket contexts independently
even when their rules are identical; two flags that must target the same people have to share a
segment. This course asks the same of \`bucket(flag key, user id, salt)\`: each flag splits users on
its own, and an unchanged version never re-buckets a user. The rest follows from treating a flag as
a rule set with a schema, read on every request.

## What you build here

One service, **flagd**, with five pieces:

1. \`POST /v1/flags\`: a key, a type, an explicit default and rules validated against the schema
   registry; an unknown attribute or operator is \`422\`, and an \`Idempotency-Key\` makes a replayed
   create return the original version.
2. A **Redis** cache holding one versioned snapshot object swapped atomically, with bucketing by
   \`hash(flag key, user id, salt)\` so each flag splits users independently.
3. A **gRPC** kill-switch path: an emergency disable reaches every evaluator within a 1-second
   deadline, normal changes may lag up to 5 seconds, pushes are deduped by version, and an older
   snapshot cannot overwrite a newer kill memo.
4. A **Kafka** stream \`flag.event\` keyed by flag key, carrying version, rule digest and actor but no
   user ids, published after the snapshot commits, with an outbox row when the broker rejects.
5. \`GET /v1/flags/{key}/evaluations\`: the explain view for one user, naming the matched rule, the
   bucket and the exact snapshot version, agreeing with the served evaluation.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the happy path, and
looks right. In every step you debug the starter against the failure modes the task names, fix it,
and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Flag authoring UIs, per-environment promotion workflows, SDK packaging, targeting by arbitrary
expressions, experiment statistics, and billing.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client / SDK', sub: 'evaluate · explain', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Flag API', sub: 'HTTPS :8443', x: 26, y: 22},
      {id: 'schema', kind: 'service', label: 'Schema Registry', sub: 'attributes · operators', x: 44, y: 8},
      {id: 'store', kind: 'db', label: 'Flag Store', sub: 'versions · outbox', x: 44, y: 40},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'snapshot · buckets', x: 44, y: 72},
      {id: 'engine', kind: 'service', label: 'Evaluation Engine', sub: 'rules · hash', x: 64, y: 40},
      {id: 'flagsvc', kind: 'grpc', label: 'Flag Service', sub: 'kill switch · gRPC', x: 64, y: 12},
      {id: 'kafka', kind: 'kafka', label: 'flag.event', sub: 'key = flag', x: 82, y: 12},
      {id: 'consumer', kind: 'service', label: 'Event consumer', sub: 'projections', x: 82, y: 40},
      {id: 'audit', kind: 'db', label: 'Evaluation audit', sub: 'decision log', x: 82, y: 66},
      {id: 'read', kind: 'http', label: 'Explain API', sub: 'GET evaluations', x: 64, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/flags'},
      {from: 'api', to: 'schema', kind: 'plain', label: 'validate rules'},
      {from: 'api', to: 'store', kind: 'plain', label: 'versions · outbox'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'snapshot swap'},
      {from: 'engine', to: 'redis', kind: 'redis', label: 'read snapshot'},
      {from: 'flagsvc', to: 'engine', kind: 'grpc', label: 'kill switch'},
      {from: 'engine', to: 'kafka', kind: 'kafka', label: 'publish flag.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'store', kind: 'plain', label: 'projections'},
      {from: 'engine', to: 'audit', kind: 'plain', label: 'decision log'},
      {from: 'client', to: 'read', kind: 'http', label: 'GET evaluations'},
      {from: 'read', to: 'engine', kind: 'plain', label: 'explain'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
