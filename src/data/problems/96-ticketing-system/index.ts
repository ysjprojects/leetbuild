import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Ticketing system: the course is not "write a CRUD endpoint for tickets", it is the debugging you
 * owe a support backend before agents trust it. Guarded state transitions → an assignment lease and
 * atomic unread counters in Redis → an idempotent CRM sync over gRPC → a ticket-keyed event timeline
 * that never carries note bodies → a read whose visibility rules actually apply.
 */
export const ticketingSystemProblem: Problem = {
  id: 'ticketing-system',
  title: 'Ticketing System',
  tagline: 'A support ticket backend: a transition table in front of the state, a Redis lease in front of the agent.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Ticketing System

A ticketing system turns a customer's message into a tracked unit of work: who owns it, what state
it is in, what has been said, and which of that the requester may see.

## The real system

Zendesk moves a ticket through New, Open, Pending, On-hold, Solved and Closed. Solved is the last
state an agent sets by hand: an automation closes a solved ticket after a configured number of days
(four by default), and a closed ticket cannot be reopened by the requester; a reply becomes a
follow-up ticket that references the original. That is a transition table with a time window on one
edge, the shape the first step asks for. Around it a support backend owns assignment (one agent per
ticket, with a path back to the queue), a CRM sync that must not duplicate an agent's reply on
retry, an ordered per-ticket event stream, and visibility rules that keep internal notes with the
agents.

## What you build here

One service, **ticketd**, with five pieces:

1. \`POST /v1/tickets\`: intake and guarded transitions. An update moves along the allowed-transition
   table (\`409\` with the allowed set otherwise), a requester touches only their own ticket (\`403\`),
   and a reopen is allowed only inside the window.
2. A **Redis** assignment layer: \`SET NX EX\` leases so one agent owns a ticket at a time, a release
   that returns the ticket to the queue, and unread counters updated atomically with the append.
3. A **gRPC** CRM client: a 3-second deadline, the note id as the idempotency key, quarantine on a
   schema rejection, and a CRM failure that does not block the ticket UI.
4. A **Kafka** event path: \`ticket.event\` keyed by ticket id, carrying actor roles and transitions
   but no note bodies, published only after the ticket store commits.
5. \`GET /v1/tickets/{id}\`: a timeline that hides internal notes from requesters, includes them for
   agents, and paginates by cursor.

## The debugging habit

Every starter compiles and serves the happy path. Debug it against the failure modes, fix it, and
prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Agent scheduling and shifts, SLA clocks and escalations, email ingestion, attachments and virus
scanning, knowledge-base suggestions, billing, and the CRM's own schema. The five pieces above are
the ones that decide whether the ticketing system is correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'requester', kind: 'client', label: 'Requester', sub: 'web · mobile', x: 6, y: 22},
      {id: 'agent', kind: 'client', label: 'Agent', sub: 'support console', x: 6, y: 74},
      {id: 'api', kind: 'http', label: 'Ticket API', sub: 'HTTPS :8443', x: 30, y: 48},
      {id: 'store', kind: 'db', label: 'Ticket store', sub: 'tickets · notes', x: 54, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'leases · unread', x: 54, y: 48},
      {id: 'kafka', kind: 'kafka', label: 'ticket.event', sub: 'key = ticket', x: 54, y: 88},
      {id: 'crm', kind: 'grpc', label: 'CRM', sub: 'SyncNote', x: 80, y: 12},
      {id: 'worker', kind: 'service', label: 'Event worker', sub: 'sync · counters', x: 80, y: 62},
    ],
    edges: [
      {from: 'requester', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'agent', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'store', kind: 'plain', label: 'read · write'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'lease · unread'},
      {from: 'api', to: 'crm', kind: 'grpc', label: 'SyncNote'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce ticket.event'},
      {from: 'kafka', to: 'worker', kind: 'kafka', label: 'consume'},
      {from: 'worker', to: 'crm', kind: 'grpc', label: 'SyncNote'},
      {from: 'worker', to: 'redis', kind: 'redis', label: 'HINCRBY unread'},
      {from: 'worker', to: 'store', kind: 'plain', label: 'notes · audit'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
