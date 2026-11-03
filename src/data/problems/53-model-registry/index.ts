import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Model registry: the debugging a registry needs before a serving pool trusts it with traffic.
 * Registration that checks lineage and the eval binding and replays on a retry → an atomic Redis
 * stage-and-pointer swap → a gRPC serving probe that gates promotion on the loaded digest →
 * model-keyed events committed before they are produced, with an outbox → a version read that
 * attaches the eval record and sees a promotion within seconds.
 */
export const modelRegistryProblem: Problem = {
  id: 'model-registry',
  title: 'Model Registry',
  tagline:
    'Model versions with checked lineage and a serving pointer that moves only after the pool proves its digest.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Model Registry

A model registry remembers which artifact a model version is, where it came from, which eval record
opened its promotion gate, and which pools serve it now. The version number is the visible part; the
lineage check, the shared pointer, the probe gate and the event history decide whether the platform
is safe.

## The real system

MLflow's Model Registry mints the version number itself and links each version to the run that
produced it. Its aliases are mutable named references: \`champion\` can point at version 1 today and
version 2 tomorrow, and consumers load \`models:/fraud@champion\`. That is the shape of the
\`active:{pool}\` pointer here: one reference per pool, moved in one step, read by every replica.

## What you build here

One service, **registryd**, on two provided modules: \`registry.store\` (Redis: \`artifact:{digest}\`,
\`run:{run_id}\`, \`eval:{eval_id}\`, \`model:{name}\` with its owner and visibility, versions
\`model:{name}:v{n}\` with a \`stage\`, recorded registrations, the \`model:{name}:history\` list and the
\`outbox\`) and \`registry.pointer\` (step 2's \`promote\`, \`rollback\` and \`resolve_active\`, provided to
steps 3 and 5).

1. \`POST /v1/models\`: body \`{name, artifact_digest, training_run_id, eval_id}\`, tenant from
   \`X-Tenant-Id\`; the artifact resolves, the run trained this model, the eval scored this model and
   digest; the store mints the version; \`Idempotency-Key\` replays a retry.
2. **Redis** stages \`staged\`, \`promoted\`, \`rolled_back\` and the pointer \`active:{pool}\` =
   \`"{name}:{n}"\`, swapped with the stage in one Lua script; a rolled-back version needs a new eval
   record to serve again.
3. **gRPC** \`Serving.Probe(pool, model, version, expected_digest)\` → \`loaded_digest\`: a 10 s deadline,
   one retry on \`UNAVAILABLE\`, and the pointer moves only when the digests match.
4. **Kafka** \`model.event\`: the change committed to the history first, then an ids-only event keyed by
   model name from an idempotent \`acks=all\` producer, and an outbox row from the delivery report.
5. \`GET /v1/models/{name}/versions/{v}\`: the version, its pools and \`eval_record\` with score and
   threshold, **404** for another tenant's private model, a 5 s cache keyed on the pools.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Artifact storage and garbage collection, training orchestration, eval set authoring, model signing,
canary traffic splits, multi-region replication and the promotion UI.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'CLI · CI · serving', x: 8, y: 50},
      {id: 'registry', kind: 'http', label: 'registryd', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'registry.store', sub: 'versions · lineage · history · outbox', x: 46, y: 10},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'stage · active:{pool}', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'model.event', sub: 'key = model', x: 46, y: 90},
      {id: 'serving', kind: 'grpc', label: 'Serving pool', sub: 'Probe · 10 s', x: 70, y: 10},
      {id: 'eval', kind: 'service', label: 'Eval store', sub: 'score · threshold', x: 70, y: 50},
      {id: 'consumer', kind: 'service', label: 'Event consumer', sub: 'serving decisions', x: 70, y: 90},
    ],
    edges: [
      {from: 'client', to: 'registry', kind: 'http', label: 'HTTPS'},
      {from: 'registry', to: 'db', kind: 'plain', label: 'register_version · record_change'},
      {from: 'registry', to: 'redis', kind: 'redis', label: 'EVAL promote · rollback'},
      {from: 'registry', to: 'serving', kind: 'grpc', label: 'Probe(pool, digest)'},
      {from: 'registry', to: 'eval', kind: 'plain', label: 'eval_record'},
      {from: 'registry', to: 'kafka', kind: 'kafka', label: 'produce after commit'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'GET active:{pool}'},
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
