import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-client';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Model audit trail on the AI-era track: the course is not "write a row when the model answers", it
 * is the review you owe a model-generated audit service before an auditor trusts it. An
 * append-only HTTP endpoint that stores digests, never inputs → a per-tenant hash chain whose head
 * advances inside one Lua script → a gRPC receipt signer with a deadline and an unsigned queue → a
 * tenant-keyed `audit.appended` event with no decision payload and an outbox → a verify endpoint
 * that recomputes the chain and reports the first divergence.
 */
export const modelAuditProblem: Problem = {
  id: 'model-audit',
  title: 'Model Audit Trail',
  tagline: 'An append-only record of every decision, verifiable later without keeping the inputs.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Model Audit Trail

An audit trail is the piece of an AI platform that has to answer a question nobody can answer at the
time it is asked: what did the model decide, under which policy, and can we still prove that years
from now. The visible part is a row per decision; the parts that decide whether the trail is worth
anything are what it refuses to store, how the records are chained, whether a receipt still exists
when the signer was down, and whether the verify endpoint actually recomputes anything.

## The real system

Production audit trails are append-only by construction: there is no update route and no delete
route, because a record you can edit is not evidence. They store a digest of the inputs and of the
decision rather than the inputs themselves, so replay is impossible and the trail is not a second
copy of tenant content. Each tenant's records form a hash chain whose head advances with the append
in a single atomic step, so a crash cannot leave an entry the verifier cannot place, and positions
are dense and unique because they come from the head rather than from a count of rows. Every append
secures a signed receipt under a short deadline; when the signer cannot answer, the record is marked
unsigned and queued for signing instead of being silently committed as if it were verified. Chain
advances publish a content-free event keyed by tenant, carrying ids and digests only, and a rejected
produce leaves an outbox row so a mirror can always resync from the ledger. And the verify endpoint
walks the chain from a record to the head it names, recomputing every hash, reporting the first
divergence at its exact position, scoped to the tenant that owns the chain.

## What you build here

One service, **auditd**, with five pieces:

1. \`POST /v1/audit/decisions\`: authenticated tenant, a model version, a policy id, an input digest
   and a decision digest, server-set monotonic timestamps, and **no** update or delete route — an
   update attempt is answered **405** by design.
2. A **Redis** hash chain per tenant: one Lua \`EVAL\` appends the entry and advances the head
   together, positions are dense and unique, the head key has no TTL, and verification reports the
   first position whose recomputed hash disagrees.
3. A **gRPC** receipt signer: a 500 ms deadline per attempt, a bounded retry window, retries only on
   \`UNAVAILABLE\`, and on failure an \`unsigned\` record queued for signing rather than committed as
   verified.
4. A **Kafka** \`audit.appended\` event keyed by tenant, carrying the record id, the position and the
   digest only, published after the append is durable, with an outbox row when the broker rejects it.
5. \`GET /v1/audit/decisions/{id}/verify\`: walks the chain from the record to the head, recomputes
   every hash, answers with the chain length covered and the first divergence, and **404**s a foreign
   chain id.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Model registries and version catalogs, retention schedules and legal hold, key management and signing
key rotation, cross-region replication of the ledger, auditor-facing query tooling, and the policy
engine that produced the decision in the first place. The five pieces above are the ones that decide
whether the trail is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'append · verify', x: 8, y: 50},
      {id: 'auditd', kind: 'http', label: 'Audit Service', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'chain head · positions', x: 46, y: 12},
      {id: 'db', kind: 'db', label: 'ledger · outbox', sub: 'append-only records', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'audit.appended', sub: 'key = tenant', x: 46, y: 86},
      {id: 'signer', kind: 'grpc', label: 'Receipt signer', sub: 'Sign · 500 ms', x: 68, y: 16},
      {id: 'queue', kind: 'external', label: 'Unsigned queue', sub: 'retriable receipts', x: 68, y: 42},
      {id: 'mirror', kind: 'service', label: 'Mirror consumer', sub: 'resync from the ledger', x: 68, y: 86},
    ],
    edges: [
      {from: 'client', to: 'auditd', kind: 'http', label: 'HTTPS'},
      {from: 'auditd', to: 'redis', kind: 'redis', label: 'EVAL append · head'},
      {from: 'auditd', to: 'db', kind: 'plain', label: 'append record · outbox'},
      {from: 'auditd', to: 'signer', kind: 'grpc', label: 'Sign(receipt)'},
      {from: 'auditd', to: 'queue', kind: 'plain', label: 'on signing failure'},
      {from: 'auditd', to: 'kafka', kind: 'kafka', label: 'produce audit.appended'},
      {from: 'kafka', to: 'mirror', kind: 'kafka', label: 'consume'},
      {from: 'mirror', to: 'db', kind: 'plain', label: 'resync'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
