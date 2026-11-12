import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Approval workflow: the course is not "record a yes in a database", it is the debugging you owe an
 * approval service before it signs off on spend. A submit that pins the approvers from the policy
 * instead of the caller → one Redis compare-and-swap per decision, with no TTL on a chain that waits
 * weeks → an eligibility gate over gRPC that denies when it cannot verify → request-keyed approval
 * events produced after the commit, with an outbox → a tenant-scoped read of the pinned chain from
 * one consistent snapshot.
 */
export const approvalWorkflowProblem: Problem = {
  id: 'approval-workflow',
  title: 'Approval Workflow',
  tagline: 'Approver chains pinned from policy and advanced by one Redis compare-and-swap per decision.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Approval Workflow

An approval workflow decides who has to say yes before a request may proceed, in what order, and
what the record of those decisions is worth afterwards. The visible part is a status moving from
*pending* to *approved*. Whether anyone can trust it depends on who resolved the chain, whether each
decision is atomic, what checked the approver, and whether the trail can be rewritten later.

## The real system

Jira Service Management adds approval steps to a workflow status, and its administrators choose
whether customers pick the approvers on the portal or the approvers come from a predefined list the
customer never sees; a step can also require more than one approval before the request moves on.
This course takes the second option and pins the list when the request is submitted.

## What you build here

One service, **approvals**, on four provided modules (\`approvals.policy\`, \`store\`, \`chain\`,
\`outbox\`; the same names and keys in every language):

- \`policy:{chain_id}\` hash \`{version, approvers}\`: \`policy.resolve_approvers(chain_id)\`.
- \`request:{id}\` hash and \`idem:{tenant}:{key}\`: \`store.put(request, key)\`,
  \`store.get(tenant, key)\`, \`store.load(id)\`.
- \`approval:{id}:state\` hash \`{step_index, step_count, status, current_approver, approver:{i},
  decision:{i}, actor:{i}}\`, no TTL: \`chain.start_chain\` and
  \`chain.advance(request_id, step_index, actor, decision)\` → \`{advanced, step_index, status, reason}\`.
- the \`outbox\` list of \`{topic, key, payload}\`: \`outbox.insert\`.

1. \`POST /v1/requests\`: approvers resolved and pinned from the policy, self-approval refused, \`why\`
   capped at 4096 bytes, \`Idempotency-Key\` replays.
2. The **Redis** state machine behind \`chain.advance\`: one Lua compare-and-swap per decision.
3. A **gRPC** gate, \`Eligibility.CheckEligibility\` → \`{active, eligible, delegated_to}\`: \`decide\`
   verifies under a 1-second deadline, denies on anything but a yes, then advances.
4. A **Kafka** \`approval.event\` per committed decision, keyed by request id, carrying
   \`{request_id, step, actor, decision, status}\`, with an outbox: \`record_decision\`.
5. \`GET /v1/requests/{id}\`: the pinned chain, every step's own state, one consistent read, scoped to
   the tenant and kept out of shared caches.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Directory and identity management, notifications, chain authoring, parallel and quorum steps,
amount thresholds, escalation timers, the trail consumer itself, and audit export. The five pieces
above decide whether an approval is authorized, atomic, verified and traceable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · decide · trail', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Approval API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'policy', kind: 'db', label: 'policy · requests', sub: 'pinned at submit', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'approval:{id}:state', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'approval.event', sub: 'key = request id', x: 44, y: 86},
      {id: 'eligibility', kind: 'grpc', label: 'Eligibility', sub: 'CheckEligibility · 1 s', x: 66, y: 12},
      {id: 'hr', kind: 'external', label: 'HR directory', sub: 'active · delegations', x: 86, y: 12},
      {id: 'consumer', kind: 'service', label: 'Trail consumer', sub: 'group trail', x: 66, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'submit · decide · read'},
      {from: 'api', to: 'policy', kind: 'plain', label: 'resolve_approvers · put · load'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVAL advance · HGETALL'},
      {from: 'api', to: 'eligibility', kind: 'grpc', label: 'CheckEligibility before advance'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after the commit'},
      {from: 'eligibility', to: 'hr', kind: 'plain', label: 'active · delegated_to'},
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
