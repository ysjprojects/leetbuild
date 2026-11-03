import type {Problem} from '@/lib/types';

import {triageEndpointStep} from './steps/1-endpoint';
import {triageStateStep} from './steps/2-state';
import {triageDependencyStep} from './steps/3-dependency';
import {triageEventsStep} from './steps/4-events';
import {triageReadStep} from './steps/5-read';

/**
 * Ticket triage: the debugging you owe a triage service before it routes a customer's tickets.
 * Server-side routing and an idempotency key → an atomic Redis dedupe claim plus per-queue
 * admission → a classifier call with a deadline and a rule-based fallback → a tenant-keyed
 * `triage.decided` event with an outbox and a commit after the routing record → a queue summary
 * computed from routing records.
 */
export const ticketTriageProblem: Problem = {
  id: 'ticket-triage',
  title: 'Ticket Triage',
  tagline: 'Classify, prioritize and route inbound tickets while the server, not the caller, picks the queue.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Ticket Triage

Ticket triage reads an inbound ticket and decides what it is about, how urgent it is, and which
queue owns it.

## The real system

Zendesk's intelligent triage classifies a new ticket from its subject and first public comment
into topic, sentiment and language, each paired with a confidence field, and admins build routing
and prioritization workflows on those fields rather than on anything the requester typed into a
priority box. This course builds the same shape: the server decides where a ticket goes, triage is
idempotent, a keyword ruleset takes over when the classifier fails and records why, and the summary
aggregates routing records so a broken classifier shows as a fallback share, not extra demand.

## What you build here

One service, **triage-api**, with five pieces:

1. \`POST /v1/tickets/triage\`: authenticated tenant, ticket text capped at 32 KiB, and a routing
   decision (queue, priority and extracted fields) chosen server-side. \`priority\` and \`queue\`
   in the body are accepted and ignored, and an \`Idempotency-Key\` keyed by the ticket hash returns
   the stored routing on a replay.
2. A **Redis** state layer: one atomic script claims the dedupe key per \`(tenant, ticket hash)\` and
   increments a per-queue minute counter that carries an expiry, answering \`429\` with
   \`Retry-After\` when the queue's cap is reached.
3. A **gRPC** classifier client: a 1-second deadline, retries only on retryable statuses, a
   versioned keyword ruleset as fallback with the fallback reason recorded, and a failure memory
   measured in seconds so a recovered classifier is used again within a minute.
4. A **Kafka** routing path: \`triage.decided\` keyed by tenant, carrying the ticket id, queue,
   priority and confidence but not the ticket text, with an outbox row when the broker rejects the
   produce, and a consumer that records the routing before it commits its offset.
5. \`GET /v1/queues/{id}/summary\`: depth, median wait and fallback share computed from routing
   records, and a 404 for a queue that belongs to another tenant.

## The debugging habit

Every starter compiles, serves the happy path and hides flaws. Debug it against the failure modes,
fix it, and prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Model training, ingestion channels, agent assignment and SLAs, attachment scanning, multi-language
classification and capacity planning.`,
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
