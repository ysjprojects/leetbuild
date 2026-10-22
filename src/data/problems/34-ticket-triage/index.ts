import type {Problem} from '@/lib/types';

import {triageEndpointStep} from './steps/1-endpoint';
import {triageStateStep} from './steps/2-state';
import {triageDependencyStep} from './steps/3-dependency';
import {triageEventsStep} from './steps/4-events';
import {triageReadStep} from './steps/5-read';

/**
 * Ticket triage on the AI-era track: the course is not "call a classifier from an endpoint", it is
 * the review you owe a model-generated triage service before it routes a customer's tickets.
 * Server-side routing and an idempotency key → an atomic Redis dedupe claim plus per-queue
 * admission → a classifier call with a deadline and a rule-based fallback → a tenant-keyed
 * `triage.decided` event with an outbox and a commit after the routing record → a queue summary
 * computed from routing records.
 */
export const ticketTriageProblem: Problem = {
  id: 'ticket-triage',
  title: 'Ticket Triage',
  tagline: 'Classify, prioritize and route inbound tickets without letting the caller route itself.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Ticket Triage

Ticket triage is the piece of a support platform that reads an inbound ticket, decides what it is
about, how urgent it is, and which queue owns it. The visible part is a queue name in a response;
the parts that decide whether the platform is safe are the trust boundary, the dedupe claim, the
fallback when the classifier is down, the routing event downstream teams consume, and the summary a
manager reads during an outage.

## The real system

Production triage services receive tickets from many tenants, cap the text they will look at,
extract what they can cheaply, and classify the rest. They never let the caller pick a priority or a
queue: a customer who can self-assign \`critical\` will, and the human queue behind it fills with
noise. Triage is idempotent — the same webhook retried five times must produce one routing — and
admission is capped per queue per minute so a classifier spike cannot funnel every ticket into one
place. Classification runs over the network under a deadline, and when the classifier refuses or
times out, a deterministic keyword ruleset keeps routing with the fallback reason recorded, instead of
paralysing everything into a catch-all. Routing decisions are published keyed by ticket so each
tenant's stream stays ordered, the payload carries ids and scores rather than ticket text, and the
consumer records the routing before it commits its offset. Finally, the summary endpoint aggregates
routing records, not cached counters, so a broken classifier shows up as a fallback share instead of
looking like extra demand.

## What you build here

One service, **triage-api**, with five pieces:

1. \`POST /v1/tickets/triage\`: authenticated tenant, ticket text capped at 32 KiB, and a routing
   decision — queue, priority and extracted fields — chosen server-side. \`priority\` and \`queue\`
   in the body are accepted and ignored, and an \`Idempotency-Key\` keyed by the ticket hash returns
   the stored routing on a replay.
2. A **Redis** state layer: one atomic script claims the dedupe key per \`(tenant, ticket hash)\` and
   increments a per-queue minute counter that carries an expiry, answering \`429\` with
   \`Retry-After\` when the queue's cap is reached.
3. A **gRPC** classifier client: a 1-second deadline, retries only on retryable statuses, a
   versioned keyword ruleset as fallback with the fallback reason recorded, and a failure memory
   measured in seconds so a recovered classifier is used again within a minute.
4. A **Kafka** routing path: \`triage.decided\` keyed by tenant, carrying the ticket id, queue,
   priority and confidence — never the ticket text — with an outbox row when the broker rejects the
   produce, and a consumer that records the routing before it commits its offset.
5. \`GET /v1/queues/{id}/summary\`: depth, median wait and fallback share computed from routing
   records, and a 404 for a queue that belongs to another tenant.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real AI feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Model training, ticket ingestion channels, agent assignment and SLAs, transcript attachment
scanning, multi-language classification, queue capacity planning, and billing for triage minutes.
The five pieces above are the ones that decide whether triage is correct, isolated and observable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Support inbox', sub: 'ticket webhook · agent UI', x: 8, y: 50},
      {id: 'triage', kind: 'http', label: 'triage-api', sub: 'HTTPS :8443', x: 28, y: 46},
      {id: 'db', kind: 'db', label: 'routing · outbox', sub: 'records · idempotency', x: 50, y: 14},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'dedupe · admission', x: 50, y: 46},
      {id: 'kafka', kind: 'kafka', label: 'triage.decided', sub: 'key = tenant', x: 50, y: 82},
      {id: 'classifier', kind: 'grpc', label: 'Classifier', sub: 'Classify', x: 72, y: 14},
      {id: 'rules', kind: 'external', label: 'Rule engine', sub: 'ruleset v3 · keywords', x: 72, y: 40},
      {id: 'summary', kind: 'service', label: 'Queue summary', sub: 'depth · median · fallback', x: 72, y: 66},
      {id: 'consumer', kind: 'service', label: 'Routing consumer', sub: 'group routing', x: 72, y: 90},
    ],
    edges: [
      {from: 'client', to: 'triage', kind: 'http', label: 'HTTPS'},
      {from: 'triage', to: 'db', kind: 'plain', label: 'routing · outbox'},
      {from: 'triage', to: 'redis', kind: 'redis', label: 'dedupe · admission'},
      {from: 'triage', to: 'classifier', kind: 'grpc', label: 'Classify'},
      {from: 'triage', to: 'rules', kind: 'plain', label: 'on DEADLINE_EXCEEDED'},
      {from: 'triage', to: 'kafka', kind: 'kafka', label: 'produce triage.decided'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'record routing'},
      {from: 'client', to: 'summary', kind: 'http', label: 'GET summary'},
      {from: 'summary', to: 'db', kind: 'plain', label: 'counts · medians'},
    ],
  },
  steps: [triageEndpointStep, triageStateStep, triageDependencyStep, triageEventsStep, triageReadStep],
};
