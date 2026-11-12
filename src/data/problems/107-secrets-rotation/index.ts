import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Secrets rotation: the course is not "store a string in a vault", it is the debugging you owe a
 * rotation path before it takes a deployment down. A create endpoint that answers a fingerprint
 * and a bounded rotation interval → one atomic Redis pointer swap with an overlap window → a gRPC
 * gate that asks every registered consumer before the old version retires → name-keyed lifecycle
 * events produced after the swap → a metadata-only versions read behind a scope.
 */
export const secretsRotationProblem: Problem = {
  id: 'secrets-rotation',
  title: 'Secrets Rotation',
  tagline: 'Secret versions behind one Redis pointer, the old one kept valid until every consumer verifies the new.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Secrets Rotation

A secrets rotation service decides when a new version of a secret becomes current and when the old
one may stop working. A rotation that is wrong does not fail loudly: a fleet halfway through a
redeploy starts failing to decrypt, or the old credential stays valid for a year.

## The real system

AWS Secrets Manager tracks rotation with staging labels on versions: \`AWSPENDING\` on the new
version while the rotation function runs its \`createSecret\`, \`setSecret\`, \`testSecret\` and
\`finishSecret\` steps, \`AWSCURRENT\` on the version clients read, \`AWSPREVIOUS\` on the one before
it. \`UpdateSecretVersionStage\` moves a label, and each label sits on one version at a time. This
course builds the same shape: versions written once, one active pointer with the previous version
still valid for a while, a test against every consumer before the old version goes, and a read
path that never returns the material.

## What you build here

One service, **secretd**, on one version store (\`secretd.vault\`, provided: versions with their
material, registered consumers, acceptances, alerts) and one active pointer (\`activate\`,
\`valid_versions\`, \`revoke\`, built in step 2 and provided to later steps as \`secretd.rotation\`):

1. \`POST /v1/secrets\` with \`{name, material, rotation_seconds}\` and \`X-Operator-Id\`: a 201 with
   the version id and the SHA-256 fingerprint, never the material, and an audit line of ids.
2. A **Redis** pointer: \`secret:{name}:active\` without a TTL, moved by one Lua script that keeps
   the previous version under \`secret:{name}:overlap\` for 900 seconds; revocations in
   \`secret:{name}:revoked\`.
3. A **gRPC** gate: \`SecretConsumer.CanReadVersion\` once per registered consumer (at
   \`{consumer}:9000\`) under a 2-second deadline; an old version retires only when every consumer
   verified, otherwise the rotation pages and stops.
4. A **Kafka** \`secret.event\` stream keyed by secret name, carrying ids and the fingerprint,
   produced after the swap by an idempotent producer with \`acks=all\`.
5. \`GET /v1/secrets/{name}/versions\`: metadata behind the \`secrets\` scope, a closed query
   allowlist, each version's health against its own interval, and consumer acceptance for every
   operator.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Key wrapping and HSMs, envelope encryption at rest, per-region replication, dynamic database
credentials, the rotation function that mints new material, and operator UIs. The five pieces above
decide whether a rotation keeps every consumer working while it happens.`,
  diagram: {
    nodes: [
      {id: 'ops', kind: 'client', label: 'Ops console', sub: 'create · read', x: 6, y: 30},
      {id: 'worker', kind: 'client', label: 'Rotation worker', sub: 'activate · retire', x: 6, y: 72},
      {id: 'api', kind: 'http', label: 'secretd', sub: 'HTTPS :8443', x: 28, y: 50},
      {id: 'vault', kind: 'db', label: 'secretd.vault', sub: 'versions · material · acceptances', x: 52, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'active · overlap · revoked', x: 52, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'secret.event', sub: 'key = secret name', x: 52, y: 88},
      {id: 'consumer', kind: 'grpc', label: 'Registered consumers', sub: 'CanReadVersion · 2 s', x: 78, y: 30},
      {id: 'audit', kind: 'service', label: 'Audit consumer', sub: 'lifecycle in order', x: 78, y: 80},
    ],
    edges: [
      {from: 'ops', to: 'api', kind: 'http', label: 'POST · GET versions'},
      {from: 'worker', to: 'api', kind: 'http', label: 'rotate · retire'},
      {from: 'api', to: 'vault', kind: 'plain', label: 'create_version · record_*'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'activate · valid_versions · revoke'},
      {from: 'api', to: 'consumer', kind: 'grpc', label: 'CanReadVersion'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after the swap'},
      {from: 'kafka', to: 'audit', kind: 'kafka', label: 'consume'},
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
