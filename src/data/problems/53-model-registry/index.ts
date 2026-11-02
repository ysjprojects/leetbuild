import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Model registry: the debugging a registry needs before a serving pool trusts it with traffic.
 * Verified, idempotent registration with real lineage → an atomic Redis stage-and-pointer swap →
 * a gRPC serving probe that gates promotion on a matching digest → model-keyed events published
 * after the commit with an outbox → a version read that always attaches the eval record.
 */
export const modelRegistryProblem: Problem = {
  id: 'model-registry',
  title: 'Model Registry',
  tagline:
    'Model versions with verified lineage and a serving pointer that moves only after the pool proves its digest.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Model Registry

A model registry remembers which artifact a model version is, where it came from, which eval
record opened its promotion gate, and which pools serve it now. The version number is the visible
part; the lineage check, the shared pointer, the probe gate and the event history are what decide
whether the platform is safe.

## The real system

MLflow's Model Registry mints the version number itself and records the source run that produced
it, so lineage is attached by the registry rather than claimed by the caller. Its stage transitions
(Staging, Production) are deprecated in favour of aliases: a pointer such as \`champion\` is
reassigned from version 1 to version 2 in one call, and consumers resolve
\`models:/name@champion\`. That is the shape of the \`active:{pool}\` pointer here. On the serving
side, KServe tracks the last revision that reached 100% of traffic, routes only
\`canaryTrafficPercent\` to a new revision, and pins traffic back to the previous good revision on
rollback.

## What you build here

One service, **registryd**, with five pieces:

1. \`POST /v1/models\`: authenticated tenant, an artifact digest that must resolve, a training run
   and an eval record that must exist and bind to the exact digest, a registry-minted version, and
   an \`Idempotency-Key\` so a retry returns the original version.
2. A **Redis** state store: stages \`staged\`, \`canary\`, \`promoted\`, \`rolled_back\` and an
   \`active:{pool}\` pointer swapped in one Lua \`EVAL\`, no process-local pointer cache, and a
   re-promotion after a rollback gated on a new eval record.
3. A **gRPC** serving probe: a 10-second deadline, at most two attempts, promotion only when the
   digest the pool loaded matches the registered one, and a visible reason when a timeout or a
   mismatch keeps traffic on the previous version.
4. A **Kafka** \`model.event\` path: events keyed by model name, an idempotent producer with
   \`acks=all\`, ids instead of report bodies, a publish after the registry commit, and an outbox
   on rejection.
5. \`GET /v1/models/{name}/versions/{v}\`: the version, its lineage, its pools and the eval record,
   present even when the score failed; **404** for a foreign tenant's private model; a cache keyed
   on the active pointer with a short TTL.

## The debugging habit

Every starter is working code with flaws: it compiles and serves the happy path. In each step you
debug it, fix it, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Artifact storage and garbage collection, training-run orchestration, eval set authoring, model
signing and attestation, multi-region replication, quota accounting, and the promotion UI.`,
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
