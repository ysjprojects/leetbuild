import type {Problem} from '@/lib/types';

import {dependencyStep} from './steps/dependency';
import {endpointStep} from './steps/endpoint';
import {eventsStep} from './steps/events';
import {readStep} from './steps/read';
import {stateStep} from './steps/state';

/**
 * Ticketing system on the AI-era track: the course is not "write a CRUD endpoint for tickets", it
 * is the review you owe a model-generated support backend before agents trust it. Guarded state
 * transitions → an assignment lease and atomic unread counters in Redis → an idempotent CRM sync
 * over gRPC → a ticket-keyed event timeline that never carries note bodies → a read whose
 * visibility rules actually apply.
 */
export const ticketingSystemProblem: Problem = {
  id: 'ticketing-system',
  title: 'Ticketing System',
  tagline: 'Support tickets with guarded transitions, scoped notes and no duplicate CRM writes.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Ticketing System

A ticketing system is the piece of a support platform that turns a customer's message into a
tracked unit of work: who owns it, what state it is in, what has been said, and which of that the
requester may see. The visible part is a ticket page; the parts that decide whether the platform is
safe are the state machine, the assignment lease, the CRM sync, the event timeline, and the
visibility rules on every read.

## The real system

Production ticket systems move tickets through validated states — open, pending, resolved, closed —
with an allowed-transition table, so a customer cannot jump a ticket straight to closed and a
support flow cannot skip a step. Agents take tickets through a lease, so one agent owns a ticket at
a time and a released lease returns the ticket to the queue instead of stranding it. Notes sync to
the CRM under the note id as an idempotency key, so a retry updates one record instead of
duplicating an agent's reply. Every state, assignment and note event publishes to a topic keyed by
ticket so a ticket's timeline stays ordered, carrying actor roles and transitions and never note
bodies. And a read applies visibility: internal notes are for agents, requesters see the public
thread, and pagination is cursor-stable so a busy ticket does not shift pages under a reader.

## What you build here

One service, **ticketd**, with five pieces:

1. \`POST /v1/tickets\`: requester-authenticated intake and guarded transitions. Creating a ticket
   opens it; an update may only move it along the allowed-transition table, a non-agent may only
   touch their own ticket, and a requester may only reopen a ticket closed within the window. An
   illegal transition is \`409\` with the allowed set; a non-agent edit is \`403\`.
2. A **Redis** assignment layer: \`SET NX EX\` leases so one agent owns a ticket at a time, a lease
   release that returns the ticket to the queue, and unread counters per requester updated in the
   same atomic unit as the message append.
3. A **gRPC** CRM client: notes sync with a 3-second deadline and the note id as the idempotency
   key, so a retry updates one CRM record; a schema rejection quarantines the note with a reason
   instead of retrying forever; and a CRM failure never blocks the ticket UI.
4. A **Kafka** event path: \`ticket.event\` keyed by ticket id so a ticket's timeline stays ordered,
   carrying actor roles and state transitions and never note bodies or requester identities beyond
   ids, published only after the ticket store commits.
5. \`GET /v1/tickets/{id}\`: a timeline that hides internal notes from requesters, includes them for
   agents, and paginates by cursor so a busy ticket does not shift pages.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real support
platform: read the draft against the failure modes, name the subtle one, fix it, and prove the fix
with checks that fail on the draft and pass on your version.

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
