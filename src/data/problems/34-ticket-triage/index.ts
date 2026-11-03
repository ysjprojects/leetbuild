import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {triageEndpointStep} from './steps/1-endpoint';
import {triageStateStep} from './steps/2-state';
import {triageDependencyStep} from './steps/3-dependency';
import {triageEventsStep} from './steps/4-events';
import {triageReadStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Ticket triage: the debugging you owe a triage service before it routes a customer's tickets.
 * Server-side routing, a 32 KiB cap and an idempotency key → one Redis script for dedupe and
 * per-queue admission → a classifier call with a deadline, a status-aware retry, a ruleset
 * fallback and a breaker → a tenant-keyed `triage.decided` event with an outbox fed by the
 * delivery report and a consumer that records before it commits → a tenant-scoped queue summary
 * computed from open routing records.
 */
export const ticketTriageProblem: Problem = {
  id: 'ticket-triage',
  title: 'Ticket Triage',
  tagline:
    'A support-ticket router whose gRPC classifier falls back to a keyword ruleset, and a queue summary that shows how often.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  tag: 'ai-systems',
  minutes: 70,
  statement: `# Ticket Triage

Ticket triage reads an inbound support ticket and decides what it is about, how urgent it is, and
which queue owns it. Everything after it, from the agent who picks the ticket up to the dashboard
a manager staffs by, trusts that decision.

## The real system

Zendesk's intelligent triage classifies a new ticket from its subject and first public comment
into topic, sentiment and language, each with a confidence field beside it, and admins build
routing and prioritization workflows on those fields rather than on anything the requester typed.
This course builds the same shape around a classifier that can be slow, refuse or fail: the server
decides, a versioned keyword ruleset stands in and says why, and the summary shows how often it
had to.

## What you build here

One service, **triage-api**, and its routing consumer, sharing the provided \`triage\` package:
\`triage.rules\` (\`rule_decision(text)\`, ruleset v3: queue, priority, confidence 0.5) and
\`triage.store\`, the routing store in Redis (ticket ids, answers per \`Idempotency-Key\`, routing
records per tenant and queue, the queue registry, the outbox).

1. \`POST /v1/tickets/triage\` \`{text}\` with \`X-Tenant-Id\` and \`Idempotency-Key\`: the ruleset
   decides, the body's \`priority\` and \`queue\` are ignored, text over 32 KiB is 413, and a replayed
   key answers the recorded routing.
2. **Redis** admission: \`admit(tenant, queue, ticket_hash)\`, one Lua script over
   \`triage:dedupe:{tenant}:{hash}\` and \`admit:{tenant}:{queue}:{minute}\`: duplicate, full (with
   \`retry_after\`) or admitted, 30 tickets per queue per minute.
3. A **gRPC** classifier client: \`classify(tenant, text)\` under a 1 s deadline, three tries on
   retryable statuses only, the ruleset with a \`fallback_reason\` otherwise, and a 30 s breaker.
4. A **Kafka** routing path: \`publish_decision\` produces \`triage.decided\` keyed by tenant with
   ids and scores only, the outbox fed from the delivery report; \`run()\` records the routing,
   then commits.
5. \`GET /v1/queues/{id}/summary\`: depth, median wait and fallback share over the open records,
   404 for another tenant's queue.

## The debugging habit

Every starter compiles, serves the happy path and hides flaws. Debug it against the failure modes
the task names, fix it, and prove the fix with checks that fail on the starter and pass on your
version.

## Left out on purpose

Model training, ingestion channels, agent assignment and SLAs, attachment scanning, multi-language
classification and capacity planning.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Support inbox', sub: 'ticket webhook · agent UI', x: 8, y: 50},
      {id: 'triage', kind: 'http', label: 'triage-api', sub: 'HTTPS :8443', x: 28, y: 46},
      {id: 'db', kind: 'db', label: 'routing store', sub: 'idempotency · records · outbox', x: 50, y: 14},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'dedupe · admission', x: 50, y: 46},
      {id: 'kafka', kind: 'kafka', label: 'triage.decided', sub: 'key = tenant', x: 50, y: 82},
      {id: 'classifier', kind: 'grpc', label: 'Classifier', sub: 'Classify', x: 72, y: 14},
      {id: 'rules', kind: 'external', label: 'Ruleset v3', sub: 'triage.rules · keywords', x: 72, y: 40},
      {id: 'summary', kind: 'service', label: 'Queue summary', sub: 'depth · median · fallback', x: 72, y: 66},
      {id: 'consumer', kind: 'service', label: 'Routing consumer', sub: 'group routing', x: 72, y: 90},
    ],
    edges: [
      {from: 'client', to: 'triage', kind: 'http', label: 'HTTPS'},
      {from: 'triage', to: 'db', kind: 'plain', label: 'save_decision · outbox'},
      {from: 'triage', to: 'redis', kind: 'redis', label: 'dedupe · admission'},
      {from: 'triage', to: 'classifier', kind: 'grpc', label: 'Classify'},
      {from: 'triage', to: 'rules', kind: 'plain', label: 'rule_decision · fallback'},
      {from: 'triage', to: 'kafka', kind: 'kafka', label: 'produce triage.decided'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'record routing'},
      {from: 'client', to: 'summary', kind: 'http', label: 'GET summary'},
      {from: 'summary', to: 'db', kind: 'plain', label: 'open records · median · fallback'},
    ],
  },
  steps: [triageEndpointStep, triageStateStep, triageDependencyStep, triageEventsStep, triageReadStep],
  support: {
    python: {...protoModules, ...supportModules},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
