import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Model registry on the AI-era track: the course is not "store a model name in a database", it is
 * the review you owe a model-generated registry before a serving pool trusts it with traffic.
 * Verified, idempotent registration with real lineage → an atomic Redis stage-and-pointer swap →
 * a gRPC serving probe that gates promotion on a matching digest → model-keyed events published
 * after the commit with an outbox → a version read that always attaches the eval record.
 */
export const modelRegistryProblem: Problem = {
  id: 'model-registry',
  title: 'Model Registry',
  tagline: 'Model versions with lineage, immutable artifacts and promotion gates.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Model Registry

A model registry is the piece of an AI platform that remembers which artifact a model version
actually is, where it came from, which eval record opened its promotion gate, and which pools are
serving it right now. The visible part is a version number; the parts that decide whether the
platform is safe are the lineage it refuses to accept on faith, the atomic pointer that every
instance reads, the probe that gates traffic, and the event history a consumer acts on.

## The real system

Production registries treat every field a client sends as a claim. A version is not a label: it
names an artifact digest that must resolve, a training run that must exist, and an eval record that
must have been produced for *that* model against *that* digest. They mint the version themselves and
answer a replay with the version they already created, because a retried registration must not fork
a model's history. They move a version through staged, canary and promoted by swapping the version
state and the serving pool's active pointer in one atomic step, so a promotion cannot half-apply
against a rollback and every instance agrees within a second. They warm a pool over a deadline-led
probe and increase traffic only when the artifact the pool loaded matches the digest that was
registered — a timeout is a reason to stop, not a reason to hurry. They publish model events keyed
by model name, carrying ids rather than eval report bodies, and they publish only after the registry
write is durable. And they serve reads that always attach the eval record, including the failures,
scoped to the tenant that owns the model.

## What you build here

One service, **registryd**, with five pieces:

1. \`POST /v1/models\`: authenticated tenant, an artifact digest that must resolve, a training run
   and an eval record that must exist and bind to the exact digest, a registry-minted version, and
   an \`Idempotency-Key\` so a retry returns the original version.
2. A **Redis** state store: version stages (\`staged\`, \`canary\`, \`promoted\`, \`rolled_back\`) and
   an \`active:{pool}\` pointer swapped in one Lua \`EVAL\`, with no process-local pointer cache, and a
   re-promotion after a rollback gated on a new eval record.
3. A **gRPC** serving probe: a 10-second deadline, at most two attempts, promotion only when the
   pool reports the digest it loaded matches the registered digest, and a visible reason when a
   timeout or a mismatch keeps traffic on the previous version.
4. A **Kafka** \`model.event\` path: one event per register, stage, promote and rollback keyed by
   model name so a model's history stays ordered, an idempotent producer with \`acks=all\`, ids
   instead of report bodies, a publish that waits for the registry commit, and an outbox on
   rejection.
5. \`GET /v1/models/{name}/versions/{v}\`: the version, its lineage, its serving pools and the eval
   record that opened its gate, always present even when the score failed; a **404** for a foreign
   tenant's private model; and a cache keyed on the active pointer with a short TTL so a promotion
   is visible within seconds.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Artifact storage and garbage collection, training-run orchestration, eval set authoring, model
signing and supply-chain attestation, multi-region replication, quota and cost accounting, and the
promotion UI. The five pieces above are the ones that decide whether the registry is correct,
isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'CLI · CI · serving', x: 8, y: 50},
      {id: 'registry', kind: 'http', label: 'Model Registry', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'registry store', sub: 'versions · lineage · outbox', x: 46, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'stages · active pointers', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'model.event', sub: 'key = model', x: 46, y: 90},
      {id: 'serving', kind: 'grpc', label: 'Serving pool', sub: 'Probe · 10 s', x: 70, y: 10},
      {id: 'eval', kind: 'service', label: 'Eval store', sub: 'records · thresholds', x: 70, y: 50},
      {id: 'consumer', kind: 'service', label: 'Event consumer', sub: 'serving decisions', x: 70, y: 90},
    ],
    edges: [
      {from: 'client', to: 'registry', kind: 'http', label: 'HTTPS'},
      {from: 'registry', to: 'db', kind: 'plain', label: 'versions · outbox'},
      {from: 'registry', to: 'redis', kind: 'redis', label: 'stages · pointers'},
      {from: 'registry', to: 'serving', kind: 'grpc', label: 'Probe(pool, digest)'},
      {from: 'registry', to: 'eval', kind: 'plain', label: 'eval gate'},
      {from: 'registry', to: 'kafka', kind: 'kafka', label: 'produce model.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'read active:{pool}'},
      {from: 'eval', to: 'db', kind: 'plain', label: 'score · threshold'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
