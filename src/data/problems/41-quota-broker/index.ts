import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-client';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Quota broker: the debugging owed to a capacity broker before it hands out scarce accelerators.
 * A recorded, team-scoped grant → one Lua take and one Lua refund per reservation on a per-window
 * Redis hash → a deadline-bounded capacity confirmation that denies when unsure → team-keyed quota
 * events with amounts, not identities, and an outbox → a read that reports what the reserve script
 * enforces.
 */
export const quotaBrokerProblem: Problem = {
  id: 'quota-broker',
  title: 'Quota Broker',
  tagline:
    'Per-team GPU reservations: a Lua ledger in Redis, a capacity check that denies when unsure, team-keyed events.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Quota Broker

A quota broker is the piece of an AI platform that hands out scarce accelerator time: it decides
whether a team may hold four GPUs in a window, records that decision so it can be released or
consumed, refuses when the capacity service does not answer, publishes the events that rebuild the
ledger, and reports a number a scheduler can act on.

## The real system

Kubernetes does this for one cluster with the \`ResourceQuota\` admission plugin: a namespace
carries a hard limit such as \`requests.nvidia.com/gpu: 4\`, the API server sums the requests of
every non-terminal pod in that namespace, and a pod that would push the sum past the limit is
rejected at admission with \`403 Forbidden\` and a message naming the constraint. A broker for a
pool shared across clusters pulls the pieces apart: the ledger lives in Redis, the pool answers
over gRPC, and the events feed a Kafka topic that rebuilds the ledger.

## What you build here

One service, the quota broker, sharing one Redis ledger (\`quota.ledger\`, provided; step 2 builds
its \`reserve\` and \`release\`) and one outbox (\`quota.outbox\`, provided):

- \`quota:limits\`: hash team → units per window (8 when unset), read through \`limit_of(team)\`.
- \`quota:{team}:{window}\` (\`window_key\`): hash \`limit\`, \`reserved\`, \`consumed\`.
- \`reservation:{team}:{reservation_id}\`: hash \`window\`, \`resource_class\`, \`amount\`,
  \`source_version\`.
- \`reserve(team, window, resource_class, amount, source_version)\` returns the reservation id or
  nothing; \`release\` and \`consume(team, reservation_id)\` report whether the reservation existed.

1. \`POST /v1/quotas/{team}/reserve\` with \`{window, resource_class, amount}\`: the \`X-Team-Id\`
   caller, a validated window, class and amount, one \`reserve\` call, **201** with the reservation.
2. The **Redis** ledger: the comparison and the take in one Lua script, the refund in another, both
   keys expiring after a day.
3. A **gRPC** \`Capacity.Confirm\` before the take: 250 ms per attempt, two attempts on
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, \`RESOURCE_EXHAUSTED\` final, no confirmation no grant, the
   reply's \`source_version\` recorded.
4. A **Kafka** \`quota.event\` record per reserve, release or consume: keyed by team,
   \`{kind, reservation_id, team, window, resource_class, amount}\`, idempotent with \`acks=all\`, the
   outbox list \`outbox:quota\` when the broker does not confirm within 2 s.
5. \`GET /v1/quotas/{team}?window=…\`: the caller's own window, \`available = limit - reserved -
   consumed\` from the hash the reserve script writes.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In each step you debug it against the failure modes, fix it, and prove the fix with
checks that fail on the starter and pass on your version.

## Left out on purpose

Per-team limit administration, preemption between priorities, pool inventory, billing, multi-region
failover, fairness scheduling and what happens to the pool when a reservation is consumed.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'reserve · release · read', x: 8, y: 50},
      {id: 'broker', kind: 'http', label: 'Quota Broker', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'relay', kind: 'service', label: 'Outbox relay', sub: 'outbox:quota → quota.event', x: 46, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'quota:{team}:{window} · reservations', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'quota.event', sub: 'key = team', x: 46, y: 88},
      {id: 'capacity', kind: 'grpc', label: 'Capacity service', sub: 'Confirm · 250 ms', x: 70, y: 22},
      {id: 'pool', kind: 'external', label: 'Resource pool', sub: 'GPUs · windows', x: 70, y: 54},
      {id: 'consumer', kind: 'service', label: 'Ledger consumer', sub: 'rebuild · counters', x: 70, y: 86},
    ],
    edges: [
      {from: 'client', to: 'broker', kind: 'http', label: 'HTTPS'},
      {from: 'broker', to: 'redis', kind: 'redis', label: 'EVAL reserve · release · read'},
      {from: 'redis', to: 'relay', kind: 'plain', label: 'outbox:quota'},
      {from: 'relay', to: 'kafka', kind: 'kafka', label: 'replay'},
      {from: 'broker', to: 'capacity', kind: 'grpc', label: 'Confirm(capacity)'},
      {from: 'capacity', to: 'pool', kind: 'plain', label: 'reserve GPUs'},
      {from: 'broker', to: 'kafka', kind: 'kafka', label: 'produce quota.event'},
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
