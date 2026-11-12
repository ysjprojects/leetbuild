import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModules, supportModulesCpp, supportModulesGo, supportModulesScala, supportModulesTs} from './support';

/**
 * Ticketing system: the course is not "CRUD a ticket", it is the debugging you owe a support backend
 * before agents trust it. A transition table and an owner check in front of every state change → a
 * Redis lease so one agent owns a ticket → CRM sync through an outbox with a deadline and one key per
 * note → ticket-keyed events produced after the store commits → a timeline read that keeps internal
 * notes with the agents and pages by keyset.
 */
export const ticketingSystemProblem: Problem = {
  id: 'ticketing-system',
  title: 'Ticketing System',
  tagline: 'Support tickets with a transition table, Redis assignment leases, a CRM outbox and a private timeline.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Ticketing System

A ticketing system turns a customer's message into a tracked unit of work: who owns it, what state
it is in, what has been said, and which of that the customer may see.

## The real system

Zendesk moves a ticket through New, Open, Pending, Solved and Closed. A default automation, "Close
ticket 4 days after status is set to solved" (configurable from one hour to 28 days), gives the
customer a window to answer a solved ticket in place; once closed, a reply opens a follow-up ticket
instead. That is a transition table with a time window on one edge, where this course starts.
Around it sit assignment, a CRM that must not record a reply twice, an ordered event stream per
ticket, and internal notes that stay with the agents.

## What you build here

One service, **ticketd**, on one ticket store (\`tickets.store\`, provided): tickets and their notes in
Redis hashes, a per-ticket note index by \`seq\`, \`transition(id, from, to)\` as a compare-and-set on
the state, and a \`crm:outbox\` that \`commit_note\` fills in the same script as the note.

1. \`POST /v1/tickets\` and \`PATCH /v1/tickets/{id}\`: \`X-Actor-Id\` and \`X-Actor-Role\`, the
   \`ALLOWED_TRANSITIONS\` table, a requester scoped to their own tickets, a 7-day reopen window.
2. **Redis** assignment: \`lease:{ticket}\` taken with \`SET NX EX 120\`, released only by its holder
   back onto \`assign:queue\`, and \`unread:{requester}\` counters moved with \`HINCRBY\`.
3. **gRPC** \`Crm.SyncNote\`: notes committed with their outbox entry, drained with a 3-second
   deadline, the note id as the idempotency key, three attempts on transient codes, quarantine on a
   schema rejection.
4. **Kafka** \`ticket.event\`: one record per committed transition, keyed by ticket id, carrying the
   actor, the role and \`from\`/\`to\` but no customer text, from an idempotent \`acks=all\` producer.
5. \`GET /v1/tickets/{id}\`: the timeline newest first, internal notes for agents only, a requester
   limited to their own ticket, keyset pages by \`next_cursor\`.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Agent scheduling and shifts, SLA clocks and escalations, email ingestion, attachments, macros and
knowledge-base suggestions, and the CRM's own schema. The five pieces above decide whether a ticket
is owned by one agent, recorded once and seen only by the people allowed to see it.`,
  diagram: {
    nodes: [
      {id: 'requester', kind: 'client', label: 'Requester', sub: 'web · mobile', x: 6, y: 22},
      {id: 'agent', kind: 'client', label: 'Agent', sub: 'support console', x: 6, y: 74},
      {id: 'api', kind: 'http', label: 'ticketd', sub: 'HTTPS :8443', x: 30, y: 48},
      {id: 'store', kind: 'db', label: 'Ticket store', sub: 'tickets · notes · crm:outbox', x: 54, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'lease:{ticket} · unread:{requester}', x: 54, y: 48},
      {id: 'kafka', kind: 'kafka', label: 'ticket.event', sub: 'key = ticket id', x: 54, y: 86},
      {id: 'crm', kind: 'grpc', label: 'CRM', sub: 'SyncNote · 3 s', x: 80, y: 30},
      {id: 'worker', kind: 'service', label: 'Outbox drain', sub: 'drain_outbox', x: 80, y: 62},
    ],
    edges: [
      {from: 'requester', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'agent', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'store', kind: 'plain', label: 'transition · commit_note · page'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'SET NX EX · HINCRBY'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after the commit'},
      {from: 'worker', to: 'store', kind: 'plain', label: 'pending_syncs · mark_synced'},
      {from: 'worker', to: 'crm', kind: 'grpc', label: 'SyncNote'},
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
