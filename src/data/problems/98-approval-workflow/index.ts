import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Approval workflow: the course is not "record a yes in a database", it is the debugging you owe an
 * approval service before it signs off on spend. A submit that resolves approvers from the pinned
 * policy instead of the caller → one Redis compare-and-swap per decision, with no TTL on a chain
 * that waits weeks → an eligibility gate over gRPC that denies when it cannot verify →
 * request-keyed approval events published after the state commit → a trail that reports every
 * step, its own state, skips and delegations.
 */
export const approvalWorkflowProblem: Problem = {
  id: 'approval-workflow',
  title: 'Approval Workflow',
  tagline: 'Approver chains pinned from policy, Redis compare-and-swap decisions, a gRPC eligibility gate.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Approval Workflow

An approval workflow is the piece of a company's tooling that decides who has to say yes before a
request may proceed, in what order, and what the record of those decisions is worth afterwards. The
visible part is a status going from *pending* to *approved*. The parts that decide whether the
workflow is safe are the chain it resolves, the atomicity of each step, the gate in front of the
decision, and the trail that survives.

## The real system

Temporal's documented approval pattern runs an approval as a durable workflow that blocks on a
Signal (\`workflow.wait_condition\` with a timeout in Python, \`Workflow.await\` in Java) until an
approver submits a decision carrying their identity, the outcome and a comment, and a multi-level
chain iterates through its approval levels waiting for one Signal per level. That is the same
shape as this course, with the durability outsourced to the workflow engine; here you build the
pieces by hand.

## What you build here

One service, **approvals**, with five pieces:

1. \`POST /v1/requests\`: authenticated tenant and requester, a validated chain id, a \`why\` field
   capped at 4 KiB, approvers resolved from the pinned chain policy, self-approval rejected at
   resolution time, and an \`Idempotency-Key\` so a retry returns the original request instead of
   creating a second chain.
2. A **Redis** state machine: one hash per request with \`step_index\`, \`current_approver\` and one
   \`decision:{i}\` per decided step, advanced by one Lua \`EVAL\` that compares the caller's step
   index, refuses anybody who is not the current approver, treats a repeated decision as a no-op and
   never puts a TTL on an open chain.
3. A **gRPC** eligibility gate: a 1-second deadline per attempt, bounded retries, and a terminal
   denial on every path that is not a verified yes (timeout, transport error, departed approver,
   delegation to somebody else, or \`eligible == false\`).
4. A **Kafka** event path: one \`approval.event\` per step change keyed by the request id, payloads
   of ids and enums only, an idempotent producer with \`acks=all\`, an outbox when the broker rejects
   the produce, and a producer call that happens after the state commit.
5. \`GET /v1/requests/{id}\`: the pinned chain with every step's own state, the skipped steps with
   their reasons, the delegations, and a 404 for a request that belongs to another tenant.

## The debugging habit

Every starter compiles and serves the happy path. Debug it, fix it, and prove the fix.

## Left out on purpose

Directory and identity management, notification delivery, chain authoring UIs, amount and budget
policies, escalation timers, mobile approvals, and the audit export format. The five pieces above
are the ones that decide whether an approval is authorized, atomic, verifiable and traceable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'submit · trail', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Approval API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'policy', kind: 'db', label: 'chain policies', sub: 'versions · outbox', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'state · trail', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'approval.event', sub: 'key = request id', x: 44, y: 86},
      {id: 'eligibility', kind: 'grpc', label: 'Eligibility', sub: 'CheckEligibility', x: 66, y: 12},
      {id: 'hr', kind: 'external', label: 'HR directory', sub: 'active · delegations', x: 86, y: 12},
      {id: 'consumer', kind: 'service', label: 'Trail consumer', sub: 'group trail', x: 66, y: 86},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'submit · decide'},
      {from: 'api', to: 'policy', kind: 'plain', label: 'chains · outbox'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'state · CAS'},
      {from: 'api', to: 'eligibility', kind: 'grpc', label: 'CheckEligibility 1 s'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce approval.event'},
      {from: 'policy', to: 'redis', kind: 'plain', label: 'pinned chain'},
      {from: 'eligibility', to: 'hr', kind: 'plain', label: 'active · delegations'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'redis', kind: 'redis', label: 'trail'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
