import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Permission service on the AI-era track: the course is not "store some roles in a table", it is the
 * review you owe a model-generated authorization layer before it guards anything. A grant that cannot
 * exceed its assigner → a version-bumped cache a revocation cannot survive → a policy-engine call that
 * denies when it cannot verify → subject-keyed events with an outbox that can rebuild the cache → a
 * read that explains every permission instead of returning a blob.
 */
export const permissionServiceProblem: Problem = {
  id: 'permission-service',
  title: 'Permission Service',
  tagline: 'Grants that cannot escalate, revoke immediately and explain themselves.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Permission Service

A permission service answers one question for every other service in the platform — *may this subject
do this thing, here?* — and two more that decide whether anyone can trust the answer: *who granted it,
and from what?* The visible part is a boolean; the parts that decide whether the platform is safe are
the grant check, the cache invalidation, the failure policy at the policy engine, and the event stream
that makes a revocation replayable.

## The real system

Production authorization services never let an admin be the unit of trust. They let a subject hand out
**only what it already holds**, at a scope no wider than where it holds it, from a **catalog** that is
the only source of valid roles and scopes — so a wildcard is a validation error, not a super-grant. They
cache effective permissions per \`(subject, scope)\` because every request asks, and they invalidate that
cache with a **version counter** rather than a delete, because a read racing the delete repopulates the
stale set and a revoked contractor keeps access until TTL. They consult a policy engine under a
**deadline** and **deny when they cannot verify**: an outage must not become broad access, and a policy
rejection is terminal while a transport failure is not. And they publish **one event per grant change,
keyed by subject**, so a subject's history stays ordered, with the row written in the same transaction
as the grant and relayed after the commit — which is also how the cache version is rebuilt. Finally,
the read path explains itself: every permission comes with the roles and grants that produce it, the
list is the same computation the live check uses, and a caller cannot read a stranger's permissions.

## What you build here

One service, **permz**, with five pieces:

1. \`POST /v1/roles/assignments\`: an authenticated assigner, a role and scope validated against the
   role catalog, an **escalation guard** that refuses any grant exceeding the assigner's own holdings
   (**403** naming the missing permission, **422** for a role or scope outside the catalog), and an
   \`Idempotency-Key\` so a replayed assignment grants once.
2. A **Redis** effective-permission cache keyed by \`(subject, scope)\`, stamped with the global
   \`grant_version\`, and invalidated by **bumping that counter** on every assignment change — a read
   holding an old entry recomputes instead of serving it, and concurrent misses collapse behind a
   lock.
3. A **gRPC** policy-engine client: a 400 ms deadline, at most two attempts, retries only on
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, a **deny** on timeout with a retriable \`503\`, a **terminal**
   \`403\` on a rejection, and cached allows used only while their version still matches.
4. A **Kafka** \`permission.event\` stream: one event per grant change keyed by **subject**, carrying
   the role ids, scopes and the grant version, written to the **outbox** in the same transaction as the
   grant and published **after** the commit, plus a consumer that can rebuild the version counter by
   replaying the stream.
5. \`GET /v1/users/{id}/permissions\`: each permission returned with its **derivation** (the roles and
   grants that produce it), from the version-stamped cache, matched **bit-for-bit** by the live check
   endpoint — and a foreign subject's permissions are **403** without the audit permission.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Identity and session management, group nesting and transitive membership, policy authoring and
simulation, SCIM/SSO provisioning, the audit log store, key management for signed grants, and
per-region replication. The five pieces above are the ones that decide whether the service is correct,
isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'console · SDK', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Permission Service', sub: 'HTTPS :8444', x: 26, y: 50},
      {id: 'catalog', kind: 'service', label: 'Role catalog', sub: 'role → permissions', x: 46, y: 8},
      {id: 'store', kind: 'db', label: 'Grant store', sub: 'grants · scopes', x: 46, y: 30},
      {id: 'outbox', kind: 'db', label: 'Outbox', sub: 'written in the txn', x: 46, y: 52},
      {id: 'kafka', kind: 'kafka', label: 'permission.event', sub: 'key = subject', x: 46, y: 76},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'effective · grant_version', x: 68, y: 20},
      {id: 'engine', kind: 'grpc', label: 'Policy engine', sub: 'Check · 400 ms', x: 68, y: 50},
      {id: 'projector', kind: 'service', label: 'Event projector', sub: 'rebuild grant_version', x: 68, y: 78},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'catalog', kind: 'plain', label: 'role · scope kinds'},
      {from: 'api', to: 'store', kind: 'plain', label: 'holdings · assignment'},
      {from: 'api', to: 'outbox', kind: 'plain', label: 'row in the same txn'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'effective · version'},
      {from: 'api', to: 'engine', kind: 'grpc', label: 'Check · deadline'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce permission.event'},
      {from: 'outbox', to: 'kafka', kind: 'kafka', label: 'relay after commit'},
      {from: 'kafka', to: 'projector', kind: 'kafka', label: 'consume · key = subject'},
      {from: 'projector', to: 'redis', kind: 'redis', label: 'rebuild grant_version'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
