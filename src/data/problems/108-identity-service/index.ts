import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Identity service: the course is not "store a user row", it is the debugging you owe a signup path
 * before it hands out accounts. Canonical handles and an idempotent signup → one atomic Redis claim
 * per handle → a verification round trip that only a confirmed token completes → user-keyed
 * lifecycle events with no contact data, produced after the commit → a profile read that decides
 * per caller what it discloses and what a cache may keep.
 */
export const identityServiceProblem: Problem = {
  id: 'identity-service',
  title: 'Identity Service',
  tagline: 'Canonical handles, Redis claims, gRPC verification, user-keyed events and a per-caller profile read.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Identity Service

An identity service decides who a person is to the rest of a platform: whether two signups are one
human, whether an address really belongs to the account that claims it, and what other services
and other users may learn about them.

## The real system

Keycloak, the open source identity provider, stores every username and email lowercased, so
\`Ada@Example.com\` and \`ada@example.com\` are one account. Some rules belong to the mailbox
provider instead: Gmail ignores dots in the local part, so \`a.da@gmail.com\` and \`ada@gmail.com\`
reach one inbox, while other domains make no such promise. Around that canonical form sit an
atomic uniqueness claim, a verification round trip, lifecycle events and a read that projects
differently for the owner, the public and support staff.

## What you build here

One service, **identityd**, with five pieces that share one accounts store (\`identityd.accounts\`,
provided: \`account:{id}\` hashes, signup records, the verification retry queue, the suppression
list, the audit trail) and one claim store (\`claim_handles\` / \`release_handles\` / \`owner_of\`,
built in step 2 and provided to the other steps as \`identityd.handles\`):

1. \`POST /v1/users\` \`{email, phone, name}\`: canonical email and E.164 phone, an
   \`Idempotency-Key\` that answers a retry with the first result, one neutral 409.
2. A **Redis** claim per handle, \`handle:{kind}:{value}\` → user id: one \`SET NX\`, a
   compare-and-delete release, no expiry.
3. **gRPC** \`Verification\`: \`SendVerification\` under a 3-second deadline, an outage queued, a hard
   bounce suppressed, and \`verified\` only from a \`ConfirmVerification\` that says \`confirmed\`.
4. A **Kafka** \`identity.event\` stream keyed by user id, \`{type, user_id, reason}\`, produced after
   \`accounts.transition\` commits, by an idempotent producer with \`acks=all\`.
5. \`GET /v1/users/{id}\`: the whole account for its owner, \`PUBLIC_FIELDS\` for everyone else,
   support reads only with a reason and an audit record, cache headers that keep contact data out
   of shared caches.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Passwords and passkeys, sessions and tokens, social login, account deletion and data export,
carrier phone verification, and multi-region replication of the accounts store. The five pieces
above decide whether identities are unique, proven and disclosed to the right callers.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'signup · profile', x: 6, y: 44},
      {id: 'api', kind: 'http', label: 'identityd', sub: 'HTTPS :8443', x: 26, y: 44},
      {id: 'redis', kind: 'redis', label: 'Redis claims', sub: 'handle:{kind}:{value} → user', x: 50, y: 10},
      {id: 'db', kind: 'db', label: 'accounts store', sub: 'account:{id} · audit · retries', x: 50, y: 44},
      {id: 'provider', kind: 'grpc', label: 'Verification provider', sub: 'Send · Confirm · 3 s', x: 76, y: 10},
      {id: 'retry', kind: 'service', label: 'Retry queue', sub: 'verify:retry', x: 76, y: 44},
      {id: 'kafka', kind: 'kafka', label: 'identity.event', sub: 'key = user id', x: 50, y: 80},
      {id: 'consumer', kind: 'service', label: 'Platform consumers', sub: 'mailer · risk · search', x: 76, y: 80},
      {id: 'support', kind: 'external', label: 'Support console', sub: 'X-Support-Reason', x: 6, y: 80},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'POST /v1/users · GET /v1/users/{id}'},
      {from: 'support', to: 'api', kind: 'http', label: 'audited read'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'claim_handles · SET NX'},
      {from: 'api', to: 'db', kind: 'plain', label: 'create · transition · record_audit'},
      {from: 'api', to: 'provider', kind: 'grpc', label: 'SendVerification · ConfirmVerification'},
      {from: 'api', to: 'retry', kind: 'plain', label: 'queue on outage'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after the commit'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
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
