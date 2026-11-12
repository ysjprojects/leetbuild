import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Permission service: the debugging an authorization layer needs before it guards anything. A
 * grant that cannot exceed its assigner → a version-stamped cache a revocation reaches at every
 * scope → a policy-engine call that denies when it cannot verify → subject-keyed events relayed
 * from an outbox and folded back into the version → a read that explains every permission.
 */
export const permissionServiceProblem: Problem = {
  id: 'permission-service',
  title: 'Permission Service',
  tagline:
    'Role grants checked against the assigner, a version-stamped Redis cache, a policy engine over gRPC and an outbox relay.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Permission Service

A permission service answers one question for every other service, *may this subject do this
thing, here?*, and two more that decide whether the answer can be trusted: *who granted it, and is
the answer from before or after the last revocation?*

## The real system

Google's Zanzibar paper calls the freshness half the "new enemy problem": a cached check answering
from before a revocation. SpiceDB, the open-source Zanzibar implementation, returns a **ZedToken**
(a datastore revision) from \`CheckPermission\` and every write, and a caller sends
\`Consistency { at_least_as_fresh: token }\` to force a check onto data no older than that revision.
\`perm:grant_version\` plays that role here: every grant change moves it, and a cached answer counts
only at the version it was computed at.

## What you build here

One service, **permz**, on three provided modules: \`permz.catalog\` (roles, the scope kinds each
may be granted at, their permissions, and \`covers(held, target)\`: \`org\` covers everything, a team
its projects), \`permz.grants\` (the grant store in Redis: \`grant:{id}\`, \`grants:{subject}\`, the
assignment record, and the outbox written by \`commit_grant\` / \`commit_revoke\` in one Lua script),
and \`permz.cache\` (step 2's cache, for the later steps).

1. \`POST /v1/roles/assignments\` \`{subject, role, scope}\`: **422** outside the catalog, **403**
   naming the first permission the assigner does not hold at the scope, \`Idempotency-Key\` replays.
2. A **Redis** cache \`perm:{subject}:{scope}\`, stamped with \`perm:grant_version\`, which every grant
   change bumps after it commits.
3. \`authorize\` over **gRPC** \`PolicyEngine.Check\`: 400 ms deadline, two attempts on transport
   failures only, \`PolicyUnavailable\` (503) instead of an old allow, allows stamped with the version.
4. A **Kafka** relay of the outbox to \`permission.event\`, keyed by subject, marked sent on the
   delivery report, and a projector that only raises \`perm:grant_version\`.
5. \`GET /v1/users/{id}/permissions?scope=\`: each permission with \`granted_by\`, scopes by
   containment, **403** for a foreign caller without \`permissions:read_any\`, a version-stamped copy.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Identity and sessions, group nesting, policy authoring, SCIM and SSO provisioning, the audit log
store, grant expiry, and per-region replication.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'console · SDK', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Permission Service', sub: 'HTTPS :8444', x: 26, y: 50},
      {id: 'catalog', kind: 'service', label: 'Role catalog', sub: 'roles · scope kinds · covers', x: 46, y: 8},
      {id: 'store', kind: 'db', label: 'Grant store', sub: 'grant:{id} · grants:{subject}', x: 46, y: 30},
      {id: 'outbox', kind: 'db', label: 'Outbox', sub: 'same Lua script as the grant', x: 46, y: 52},
      {id: 'kafka', kind: 'kafka', label: 'permission.event', sub: 'key = subject', x: 46, y: 76},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'perm:{subject}:{scope} · grant_version', x: 68, y: 20},
      {id: 'engine', kind: 'grpc', label: 'Policy engine', sub: 'Check · 400 ms', x: 68, y: 50},
      {id: 'projector', kind: 'service', label: 'Event projector', sub: 'raise grant_version', x: 68, y: 78},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'catalog', kind: 'plain', label: 'role · scope kinds'},
      {from: 'api', to: 'store', kind: 'plain', label: 'effective · assignment'},
      {from: 'api', to: 'outbox', kind: 'plain', label: 'commit_grant · commit_revoke'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'cache · version'},
      {from: 'api', to: 'engine', kind: 'grpc', label: 'Check · deadline'},
      {from: 'outbox', to: 'kafka', kind: 'kafka', label: 'relay · mark sent on delivery'},
      {from: 'kafka', to: 'projector', kind: 'kafka', label: 'consume · any partition order'},
      {from: 'projector', to: 'redis', kind: 'redis', label: 'compare-and-set version'},
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
