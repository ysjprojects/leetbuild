import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-client';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Quota broker: the debugging owed to a capacity broker before it hands out scarce accelerators.
 * Recorded, authorized reservations, then one atomic Redis take per (team, window) with an expiring
 * key and a real release, then a deadline-bounded capacity confirmation that denies when unsure,
 * then team-keyed quota events carrying amounts instead of identities with an outbox, then a read
 * that reports the numbers the reserve path enforces.
 */
export const quotaBrokerProblem: Problem = {
  id: 'quota-broker',
  title: 'Quota Broker',
  tagline:
    'Reserve GPU capacity per team with one atomic ledger take, a deny-on-timeout capacity check and a read that matches it.',
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

One service, the quota broker, with five pieces:

1. \`POST /v1/quotas/{team}/reserve\`: authenticated team, validated window, a whitelisted
   resource class, a bounded amount, and a reservation id recorded before the response.
2. A **Redis** ledger: one hash per \`(team, window)\` where take, release and expiry happen in
   Lua \`EVAL\` scripts, with the TTL set on the first write and a release that refunds the window
   the reservation recorded.
3. A **gRPC** capacity client: a 250 ms deadline per attempt, at most two attempts, retries only
   on \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, a 409 for \`RESOURCE_EXHAUSTED\` without a retry, a
   503 \`TRY_AGAIN\` with no ledger write when the answer is uncertain, and the confirmed
   \`source_version\` recorded with the reservation.
4. A **Kafka** \`quota.event\` path: keyed by team, carrying kind, window, resource class, amount
   and reservation id and not the requester, produced with \`acks=all\` and awaited, with an outbox
   row when the broker rejects it.
5. \`GET /v1/quotas/{team}\`: quota, reserved, consumed and available read from the ledger the
   reserve path writes, tenant-scoped, with the window required and validated.

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
      {id: 'db', kind: 'db', label: 'window store · outbox', sub: 'limits · replays', x: 46, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'quota:{team}:{window}', x: 46, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'quota.event', sub: 'key = team', x: 46, y: 88},
      {id: 'capacity', kind: 'grpc', label: 'Capacity service', sub: 'Confirm · 250 ms', x: 70, y: 22},
      {id: 'pool', kind: 'external', label: 'Resource pool', sub: 'GPUs · windows', x: 70, y: 54},
      {id: 'consumer', kind: 'service', label: 'Ledger consumer', sub: 'rebuild · counters', x: 70, y: 86},
    ],
    edges: [
      {from: 'client', to: 'broker', kind: 'http', label: 'HTTPS'},
      {from: 'broker', to: 'redis', kind: 'redis', label: 'take · release · read'},
      {from: 'broker', to: 'db', kind: 'plain', label: 'limits · outbox'},
      {from: 'broker', to: 'capacity', kind: 'grpc', label: 'Confirm(capacity)'},
      {from: 'capacity', to: 'pool', kind: 'plain', label: 'reserve GPUs'},
      {from: 'broker', to: 'kafka', kind: 'kafka', label: 'produce quota.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'rebuild ledger'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
