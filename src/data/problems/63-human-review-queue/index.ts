import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Human review queue: the course is not "add a review button to the model output", it is the
 * debugging you owe a queue that decides which model outputs reach a person and when. Tenant-scoped,
 * deduped escalations with a server-side priority → Redis leases and an SLA clock that starts at the
 * enqueue → an auto-resolve that needs an enforcement grant under a deadline → item-keyed decision
 * events with the reviewer pseudonymized and failed deliveries parked → a queue read an operator can
 * staff from.
 */
export const humanReviewQueueProblem: Problem = {
  id: 'human-review-queue',
  title: 'Human Review Queue',
  tagline:
    'Escalated model output, reviewer leases on Redis, an enforcement grant over gRPC and decision events on Kafka.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Human Review Queue

A human review queue takes the output a model is not trusted to ship, such as a low-confidence
completion, a guardrail block or a user report, and routes it to a person with a deadline. Whether
the platform is safe depends on the dedupe at the door, the lease that returns an abandoned item,
the clock that decides an SLA breach, the narrow class the queue may clear without a person, and
the trail a decision leaves behind.

## The real system

Amazon Augmented AI (A2I) is a documented example. A flow definition says which conditions start a
human loop and which work team receives it, and its \`HumanLoopConfig\` carries two clocks:
\`TaskAvailabilityLifetimeInSeconds\`, how long a task stays available for review, and
\`TaskTimeLimitInSeconds\`, how long one worker may hold it (an hour by default). The output lands in
an S3 location the customer owns, not inside the queue.

## What you build here

One service, **reviewd**, on one review store (\`review.store\`, provided): items are Redis hashes
\`review:item:{id}\`, each tenant has a queue list per priority \`review:queue:{tenant}:{p}\`, and
the store creates items, claims sources, records outcomes and decisions, hands out reviewer
pseudonyms and parks undelivered events.

1. \`POST /v1/review/items\`: a tenant from \`X-Tenant-Id\`, a priority derived from the source type,
   one item per source (\`claim_source\`), and a \`payload_ref\` instead of the content.
2. A **Redis** take: \`take_next\` pops the next item atomically and leases it
   (\`review:lease:{id}\` with a TTL); \`reclaim_expired\` returns abandoned items, a breached one
   first and marked. The SLA clock starts at the enqueue.
3. A **gRPC** auto-resolve: \`Enforcement.AutoResolve\` for the safe categories only, under a
   one-second deadline; no grant means the item goes to a person.
4. **Kafka** \`review.event\`: keyed by item id, a reviewer pseudonym instead of the reviewer, produced
   after the decision commits, parked in \`review:outbox\` when delivery fails, idempotent with
   \`acks=all\`.
5. \`GET /v1/review/queues/{tenant}/{priority}\`: depth, oldest age and SLA breaches from the queue
   itself, for the caller's own tenant only.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Reviewer staffing and skills routing, the console UI, the model scoring behind the confidence,
policy authoring, multi-region replication and payload retention.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Source · Reviewer', sub: 'escalate · take · decide', x: 8, y: 50},
      {id: 'queue', kind: 'http', label: 'reviewd', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'items', kind: 'db', label: 'Review store', sub: 'review:item:{id}', x: 44, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'queues · leases', x: 44, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'review.event', sub: 'key = item id', x: 44, y: 86},
      {id: 'enforcement', kind: 'grpc', label: 'Enforcement', sub: 'AutoResolve · 1 s', x: 66, y: 12},
      {id: 'guardrail', kind: 'external', label: 'Guardrail', sub: 'block → escalation', x: 66, y: 38},
      {id: 'console', kind: 'client', label: 'Operator', sub: 'depth · age · breaches', x: 66, y: 62},
      {id: 'consumer', kind: 'service', label: 'Audit consumer', sub: 'decision history', x: 66, y: 88},
    ],
    edges: [
      {from: 'client', to: 'queue', kind: 'http', label: 'POST /v1/review/items'},
      {from: 'guardrail', to: 'queue', kind: 'http', label: 'block → escalate'},
      {from: 'queue', to: 'items', kind: 'plain', label: 'create · decide'},
      {from: 'queue', to: 'redis', kind: 'redis', label: 'take_next · lease'},
      {from: 'queue', to: 'enforcement', kind: 'grpc', label: 'AutoResolve'},
      {from: 'queue', to: 'kafka', kind: 'kafka', label: 'produce after commit'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'console', to: 'queue', kind: 'http', label: 'GET /v1/review/queues/…'},
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
