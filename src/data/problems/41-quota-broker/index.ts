import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-client';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Quota broker on the AI-era track: the course is not "count GPUs in a database", it is the review
 * you owe a model-generated capacity broker before it hands out scarce accelerators. Recorded,
 * authorized reservations → one atomic Redis take per (team, window) with an expiring key and a
 * real release → a deadline-bounded capacity confirmation that denies when it is unsure → team-keyed
 * quota events carrying amounts instead of identities, with an outbox → a read that reports the same
 * numbers the reserve path enforces.
 */
export const quotaBrokerProblem: Problem = {
  id: 'quota-broker',
  title: 'Quota Broker',
  tagline: 'Reserve scarce AI capacity per team atomically, deny when unsure and never over-issue.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Quota Broker

A quota broker is the piece of an AI platform that hands out scarce accelerator time: it decides
whether a team may hold four GPUs in a window, records that decision so it can be released or
consumed, refuses to answer when the capacity service is unsure, publishes the events that rebuild
the ledger, and reports a number a scheduler can act on. The visible part is a reservation id; the
parts that decide whether the platform is safe are the atomic take, the deny-when-uncertain policy,
the per-team ordering of its events, and a read that agrees with the enforcement.

## The real system

Production brokers receive reserve, release and consume traffic from many teams at once, and every
field a caller sends is a claim: the team in the path, the window string, the resource class, the
amount. They take capacity atomically, so two concurrent requests for the last unit cannot both
succeed, and they key everything — the ledger hash, the reservation record, the event partition — by
the (team, window) pair, because that pair is the unit the pool is divided into. A reservation is a
record, not just a decision: it is returned with an id, it can be released back to the pool
immediately, and it expires with its window when it is never consumed. Before granting, the broker
confirms with the capacity service under a short deadline and treats an unanswered confirmation as a
denial rather than as room, because a local counter and the pool are different authorities. Its
events are keyed by team so each team’s ledger stays readable in order, they carry amounts and ids
rather than identities because the topic outlives every request, and a refused produce is parked in
an outbox instead of being dropped. Finally, the read path reports the same numbers the write path
enforces: a scheduler that reads \`available\` and asks for it must be granted it.

## What you build here

One service, the quota broker, with five pieces:

1. \`POST /v1/quotas/{team}/reserve\`: authenticated team, validated window, a whitelisted resource
   class, a bounded amount, and a reservation id that is recorded before the response — because a
   reservation that is never written is capacity handed out twice.
2. A **Redis** ledger: one hash per \`(team, window)\` where the take, the release and the expiry
   setup happen in one Lua \`EVAL\`, with the TTL set on the first write and a release that refunds
   the window the reservation recorded.
3. A **gRPC** capacity client: a 250 ms deadline per attempt, at most two attempts, retries only on
   \`UNAVAILABLE\`/\`DEADLINE_EXCEEDED\`, a 409 for \`RESOURCE_EXHAUSTED\` that is never retried, a
   503 \`TRY_AGAIN\` with no ledger write when the answer is uncertain, and the confirmed
   \`source_version\` recorded with the reservation.
4. A **Kafka** \`quota.event\` path: keyed by team, carrying the kind, window, resource class, amount
   and reservation id and never the requester, produced with \`acks=all\` and awaited, with an outbox
   row when the broker rejects it.
5. \`GET /v1/quotas/{team}\`: quota, reserved, consumed and available read from the same ledger the
   reserve path writes, tenant-scoped, with the window required and validated.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Per-team limit administration, preemption between priorities, pool inventory management, billing,
multi-region failover, fairness scheduling and what happens to the pool when a reservation is
consumed. The five pieces above are the ones that decide whether the broker is correct, isolated and
shippable.`,
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
