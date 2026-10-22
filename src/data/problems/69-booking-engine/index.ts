import type {Problem} from '@/lib/types';

import {bookingEndpointStep} from './steps/1-endpoint';
import {bookingStateStep} from './steps/2-state';
import {bookingClientStep} from './steps/3-dependency';
import {bookingEventsStep} from './steps/4-events';
import {bookingReadStep} from './steps/5-read';

/**
 * Booking engine on the AI-era track: the course is not "create a booking row", it is the review you
 * owe a model-generated booking path before two people are sold the same hour. A validated range
 * that is real and future → one atomic Redis hold with a payment-window TTL → a calendar sync that
 * confirms idempotently under a deadline → resource-keyed booking events published after the commit
 * with an outbox → an availability read that resolves timezones honestly against the same hold map.
 */
export const bookingEngineProblem: Problem = {
  id: 'booking-engine',
  title: 'Booking Engine',
  tagline: 'Time-slot bookings that cannot double-book and survive confirmation retries.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Booking Engine

A booking engine is the piece of a product that turns "is this hour free?" into a promise two people
act on. The visible part is a confirmation screen; the parts that decide whether the promise holds are
the validation funnel in front of the hold, the atomicity of the hold itself, what happens when the
confirmation dependency is slow, how the schedule reaches systems you do not own, and whether the
availability read tells the truth about the last second.

## The real system

Production booking systems receive ranges from clients whose clocks disagree with the server, so they
reject a range that is not a range and a range that cannot be honoured before any state is touched,
and they key the request so a retry after a timeout returns the first booking instead of taking a
second one. A slot hold is one atomic transition over a slot map — check and write in the same
script, never a read in the handler and a write afterwards — with a TTL that covers exactly the
payment window, so an abandoned checkout frees its slots and a confirmed booking can never expire
back into the free set. Confirmation talks to somebody else's calendar under a deadline, sends an
idempotency key so a retried sync updates one event, distinguishes a retryable failure from a
verdict, and treats a timeout as unknown rather than absent: it reconciles before it cancels. The
schedule reaches downstream calendars as events keyed by the resource, committed before they are
published, carrying the range and the hold, with an outbox row when the broker rejects the produce.
And the availability read is served from the same map the booking path writes, capped in range,
resolved in a timezone it names in the response.

## What you build here

One service, **bookd**, with five pieces:

1. \`POST /v1/bookings\`: authenticated tenant, a range that must be strictly positive, in the future
   and inside the tenant's **90-day** horizon, and an \`Idempotency-Key\` keyed by
   \`(tenant, resource, range)\` so a replay returns the first booking.
2. A **Redis** hold map: the slot map \`resource:{id}:slots\` written by one Lua script that checks
   every slot and inserts the hold together, a **900-second** hold TTL for the payment window, a
   guarded release for the sweeper, and a confirm that converts the hold to a booking.
3. A **gRPC** calendar client: a **3000 ms** deadline per attempt, the booking's idempotency key on
   every call so retries update one event, at most **3** attempts, retries only on
   \`DEADLINE_EXCEEDED\`/\`UNAVAILABLE\`, a permanent rejection that releases the hold, and an unknown
   state that reconciles before anything is cancelled.
4. A **Kafka** \`booking.event\` path keyed by resource id, carrying the hold and the range, published
   after the booking is committed, with an idempotent producer and \`acks=all\`, an awaited ack and an
   outbox row when the produce fails.
5. \`GET /v1/resources/{id}/availability\`: free slots for a range capped at **90 days**, built from
   the live slot map — live holds and confirmed bookings excluded — and a response that names the
   timezone it resolved.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the happy
path, and it sounds confident. Your job in every step is the job you will have on a real feature:
read the draft against the failure modes, name the subtle one, fix it, and prove the fix with checks
that fail on the draft and pass on your version.

## Left out on purpose

Payment processing and deposits, recurring bookings and their expansion, resource catalogues and
pricing, staff scheduling, notifications and reminders, multi-region replication of the slot map,
and the calendaring UI itself. The five pieces above are the ones that decide whether a booking
engine keeps its promises.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'book · availability', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Booking API', sub: 'HTTPS :8443', x: 26, y: 50},
      {id: 'db', kind: 'db', label: 'bookings · outbox', sub: 'rows · unsent events', x: 48, y: 12},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'slot map · hold TTL', x: 48, y: 50},
      {id: 'kafka', kind: 'kafka', label: 'booking.event', sub: 'key = resource id', x: 48, y: 88},
      {id: 'calendar', kind: 'grpc', label: 'Calendar service', sub: 'Sync · 3000 ms', x: 74, y: 12},
      {id: 'consumer', kind: 'service', label: 'Schedule consumer', sub: 'group booking-schedule', x: 74, y: 62},
      {id: 'relay', kind: 'service', label: 'Outbox relay', sub: 'republish unsent', x: 74, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'hold · availability'},
      {from: 'api', to: 'db', kind: 'plain', label: 'booking · outbox'},
      {from: 'api', to: 'calendar', kind: 'grpc', label: 'Sync(idempotency_key)'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce booking.event'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
      {from: 'consumer', to: 'db', kind: 'plain', label: 'schedule view'},
      {from: 'db', to: 'relay', kind: 'plain', label: 'unsent rows'},
      {from: 'relay', to: 'kafka', kind: 'kafka', label: 'republish'},
    ],
  },
  steps: [bookingEndpointStep, bookingStateStep, bookingClientStep, bookingEventsStep, bookingReadStep],
};
