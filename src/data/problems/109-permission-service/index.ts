import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Permission service: the debugging an authorization layer needs before it guards anything. A
 * grant that cannot exceed its assigner → a version-bumped cache a revocation cannot survive → a
 * policy-engine call that denies when it cannot verify → subject-keyed events with an outbox that
 * can rebuild the cache → a read that explains every permission instead of returning a blob.
 */
export const permissionServiceProblem: Problem = {
  id: 'permission-service',
  title: 'Permission Service',
  tagline: 'Grants bounded by what the assigner holds, and a permission cache a revocation can reach.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Permission Service

A permission service answers one question for every other service, *may this subject do this
thing, here?*, and two more that decide whether the answer can be trusted: *who granted it, and
from what?* The boolean is the visible part; the grant check, the cache invalidation, the failure
policy at the policy engine and the event stream are what make it safe.

## The real system

The freshness problem two of these steps turn on is what Google's Zanzibar paper calls the "new
enemy problem": a cached check answering from before a revocation. SpiceDB, the open-source
Zanzibar implementation, exposes the fix in its v1 API: \`CheckPermission\` and every write return a
**ZedToken**, an opaque datastore revision, and a caller sends
\`Consistency { at_least_as_fresh: ZedToken }\` to force a check onto data no older than that
revision, or \`minimize_latency\` to accept whatever is cached. Storing the token beside the protected
resource gives read-after-write consistency without bypassing the cache, which is the role
\`grant_version\` plays here. The rest follows the same discipline: a subject hands out only what it
holds, from a catalog that is the only source of valid roles and scopes; the policy engine is called
under a deadline and the service denies when it cannot verify; one subject-keyed event per grant
change commits with the grant; and the read path names the grants behind every permission.

## What you build here

One service, **permz**, with five pieces:

1. \`POST /v1/roles/assignments\`: catalog validation (**422**), an **escalation guard** that refuses
   any grant exceeding the assigner's holdings (**403**), and an \`Idempotency-Key\`.
2. A **Redis** effective-permission cache per \`(subject, scope)\`, stamped with \`grant_version\`
   and invalidated by **bumping that counter**, misses collapsed behind a lock.
3. A **gRPC** policy-engine client: 400 ms deadline, two attempts, retries only on
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, \`503\` on timeout, terminal \`403\` on rejection, cached
   allows used only while their version matches.
4. A **Kafka** \`permission.event\` stream keyed by **subject**, carrying the grant version, written
   to the **outbox** in the grant's transaction, published after commit, and replayable into the
   version counter.
5. \`GET /v1/users/{id}/permissions\`: each permission with its **derivation**, from the
   version-stamped cache, matched by the live check, **403** for a foreign subject.

## The debugging habit

Every starter compiles, serves the happy path, and looks right. Debug it against the failure modes,
fix it, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Identity and sessions, group nesting, policy authoring, SCIM/SSO provisioning, the audit log store,
key management for signed grants, and per-region replication.`,
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
