import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Feature flags on the AI-era track: the course is not "add a boolean to config", it is the review
 * you owe a model-generated flag service before it decides what every user sees. Validated,
 * idempotent flag creation against a schema registry → one atomic Redis versioned snapshot swapped
 * whole, with per-flag deterministic bucketing → a kill switch propagated over gRPC with a bounded
 * staleness that a stale snapshot can never overwrite → flag-keyed events carrying rule digests and
 * an outbox, published after the snapshot commits → an explain endpoint that must agree with the
 * served evaluation bit-for-bit without revealing another user's history.
 */
export const featureFlagsProblem: Problem = {
  id: 'feature-flags',
  title: 'Feature Flags',
  tagline: 'Flags that evaluate deterministically, roll out safely and cannot be flipped by drift.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Feature Flags

A feature-flag service is the piece of a platform that decides which users see which behavior,
without a deploy. The visible part is a boolean in a response; the parts that decide whether the
platform is safe are the validation funnel at creation, the atomic versioned snapshot every
evaluation reads, the kill switch that must land everywhere in bounded time, the event stream that
keeps a flag's history ordered, and the explanation endpoint that must never contradict what was
served.

## The real system

Production flag services are read on every request in every service, so correctness is measured in
flips and staleness, not in throughput. A flag is a rule set with a schema: a key, a value type, an
explicit default, and rules whose attributes and operators must exist in a registry, or a rule is
dead — it looks configured and silently never matches. Evaluations read one versioned snapshot
swapped atomically, so a reader never sees half a rule set mid-update, and per-user bucketing uses a
deterministic hash of the flag key, the user id and a salt, so a user lands in the same bucket for
the same flag on every instance. A kill switch carries an effective-immediately marker and propagates
over gRPC with a deadline, and a stale snapshot may never overwrite a newer kill memo. Events are
keyed by flag key so a flag's history stays ordered, carry a version, a rule digest and an actor but
never a user id from a test evaluation, and are published only after the snapshot commits. The
explain endpoint returns which rule matched, the bucket value and the version that produced the
decision for one user, and it must not recompute with a fresh salt — the explanation has to agree
with the served value bit-for-bit.

## What you build here

One service, **flagd**, with five pieces:

1. \`POST /v1/flags\`: a key, a value type, an explicit default and rules validated against the
   schema registry — an unknown attribute or operator is \`422\`, a missing default is rejected, and
   an \`Idempotency-Key\` makes a replayed create return the original flag version.
2. A **Redis** evaluation cache holding a single versioned snapshot object swapped atomically; every
   evaluation reads one full version, and bucketing is \`hash(flag key, user id, salt)\` so each flag
   splits users independently and an unchanged version never re-buckets a user.
3. A **gRPC** kill-switch path: an emergency disable propagates to every evaluator within a 1-second
   deadline and is effective immediately, while normal changes may lag up to 5 seconds; pushes are
   deduped by version and an older snapshot can never overwrite a newer kill memo.
4. A **Kafka** event stream \`flag.event\` keyed by flag key, carrying version, rule digest and actor,
   no user ids, an outbox row when the broker rejects the produce, and publish only after the
   snapshot commit.
5. \`GET /v1/flags/{key}/evaluations\`: the explain view for one user — which rule matched, the bucket
   value, and the exact snapshot version — agreeing with the served evaluation and exposing only the
   caller's own user.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Flag authoring UIs, per-environment promotion workflows, SDK packaging, targeting by arbitrary
expressions, experiment statistics, and billing. The five pieces above are the ones that decide
whether the flag service is correct, isolated and shippable.`,
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
