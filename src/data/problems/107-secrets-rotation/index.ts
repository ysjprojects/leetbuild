import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Secrets rotation on the AI-era track: the course is not "store a string in a vault", it is the
 * review you owe a model-generated rotation path before it takes a deployment down. A write-once
 * create endpoint with a rotation interval → one atomic Redis pointer swap with a bounded overlap
 * → a gRPC gate that makes every consumer prove it can read the new version → a keyed,
 * material-free lifecycle log published after the swap → a metadata-only read that no flag can
 * widen.
 */
export const secretsRotationProblem: Problem = {
  id: 'secrets-rotation',
  title: 'Secrets Rotation',
  tagline: 'Secrets that rotate with an overlap window and are revoked exactly once.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Secrets Rotation

A secrets rotation service is the piece of a platform that decides how a new version of a secret is
created, when it becomes current, how the fleet moves from the old version to the new one, and when
the old one may be destroyed. The visible part is a version id in a response; the parts that decide
whether the platform survives rotation day are the write-once boundary, the overlap window, the
verification gate in front of retirement, the ordering of the lifecycle log, and a read path that
cannot grow a material flag by accident.

## The real system

Production secret stores write material once and never read it back through the API: callers get
version ids and fingerprints, and anything that needs the bytes asks the vault with its own
credentials. Rotation is a sequence, not an update — activate, announce, verify, retire, revoke —
and every step of that sequence exists because the previous one is not instantaneous. While a fleet
redeploys, two versions are legitimately alive: the new one for the consumers that moved, the old
one for the consumers that have not. Retirement is gated on proof, not on hope: every registered
consumer must demonstrate that it can read the new version before the old one is destroyed. The
lifecycle is published as ordered events keyed by the secret, carrying ids and fingerprints rather
than material, because the topic is retained and replicated far longer than the version lives. And
the read path that operators use to see all of this is metadata-only under every flag, for every
role.

## What you build here

One service, **secretd**, with five pieces:

1. \`POST /v1/secrets\`: validated name, a material cap, a rotation interval with health derived
   from it, and a response that carries a version id and a fingerprint — never the material, in no
   response and in no log line.
2. A **Redis** active-version pointer: one atomic \`EVAL\` that moves \`secret:{name}:active\` to the
   new version while the previous one stays valid under \`secret:{name}:overlap\` for a bounded
   overlap of at least one deploy cycle. The pointer never expires; revocation is an explicit step
   in \`secret:{name}:revoked\`.
3. A **gRPC** verification gate: one \`CanReadVersion\` call per registered consumer with a 2-second
   deadline, a report per consumer, and a retirement that only proceeds when every consumer has
   verified — an unresponsive consumer blocks retirement and raises an alert instead of being
   counted as agreement.
4. A **Kafka** lifecycle path: \`created\`, \`activated\`, \`retired\` and \`revoked\` events on
   \`secret.event\`, keyed by secret name so each secret's history stays ordered, carrying ids and
   fingerprints, published after the pointer swap.
5. \`GET /v1/secrets/{name}/versions\`: a metadata-only read — version ids, fingerprints, activation
   windows and consumer acceptance — behind the \`secrets\` scope, with a closed query allowlist so
   no flag can ever surface material.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real rotation
path: read the draft against the failure modes, name the subtle one, fix it, and prove the fix with
checks that fail on the draft and pass on your version. The mock scenario in this course is the
incident that produced it: a rotation that retired the old version before consumers verified, and an
audit line that carried the new material in plaintext.

## Left out on purpose

Key wrapping and HSMs, envelope encryption of the material at rest, per-region replication and
failover, audit export to a SIEM, secret import from other vaults, dynamic database credentials, and
operator UIs. The five pieces above are the ones that decide whether a rotation is correct, ordered
and safe to run on a Tuesday.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Secret consumers', sub: 'fetch · decrypt', x: 6, y: 22},
      {id: 'ops', kind: 'client', label: 'Ops console', sub: 'rotate · revoke · read', x: 6, y: 72},
      {id: 'api', kind: 'http', label: 'Secrets API', sub: 'HTTPS :8443', x: 26, y: 46},
      {id: 'vault', kind: 'external', label: 'Vault', sub: 'material at rest · write once', x: 50, y: 6},
      {id: 'db', kind: 'db', label: 'secret store', sub: 'versions · fingerprints', x: 50, y: 36},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'active · overlap', x: 50, y: 66},
      {id: 'audit', kind: 'db', label: 'audit log', sub: 'ids only · no material', x: 50, y: 90},
      {id: 'worker', kind: 'service', label: 'Rotation worker', sub: 'schedule · verify · retire', x: 74, y: 22},
      {id: 'consumer', kind: 'grpc', label: 'Registered consumers', sub: 'CanReadVersion · 2 s', x: 74, y: 52},
      {id: 'kafka', kind: 'kafka', label: 'secret.event', sub: 'key = secret name', x: 74, y: 82},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'fetch version'},
      {from: 'ops', to: 'api', kind: 'http', label: 'create · rotate · read'},
      {from: 'client', to: 'vault', kind: 'plain', label: 'decrypt with the version it holds'},
      {from: 'api', to: 'vault', kind: 'plain', label: 'write material once'},
      {from: 'api', to: 'db', kind: 'plain', label: 'version metadata'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'active pointer · overlap'},
      {from: 'api', to: 'audit', kind: 'plain', label: 'audit line (ids only)'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'lifecycle events'},
      {from: 'worker', to: 'api', kind: 'http', label: 'activate · retire'},
      {from: 'worker', to: 'consumer', kind: 'grpc', label: 'CanReadVersion'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'swap · revoke'},
      {from: 'worker', to: 'kafka', kind: 'kafka', label: 'produce secret.event'},
      {from: 'kafka', to: 'audit', kind: 'kafka', label: 'consume in order'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
