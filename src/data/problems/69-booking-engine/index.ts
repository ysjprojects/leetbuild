import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {bookingEndpointStep} from './steps/1-endpoint';
import {bookingStateStep} from './steps/2-state';
import {bookingClientStep} from './steps/3-dependency';
import {bookingEventsStep} from './steps/4-events';
import {bookingReadStep} from './steps/5-read';
import {supportModulesCpp, supportModulesGo, supportModulesPy, supportModulesScala, supportModulesTs} from './support';

/**
 * Booking engine: the debugging a booking path needs before two people are sold the same hour. A
 * validated range that is real and future → one atomic Redis hold with a payment-window TTL → a
 * calendar sync that confirms idempotently under a deadline → resource-keyed booking events
 * published after the commit with an outbox → an availability read that resolves timezones against
 * the same hold map. The calendar is a stand-in the harness serves over gRPC.
 */
export const bookingEngineProblem: Problem = {
  id: 'booking-engine',
  title: 'Booking Engine',
  tagline:
    'Time-slot bookings: one atomic hold per range, a calendar sync that retries without duplicating, an availability read from the live map.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Booking Engine

A booking engine turns "is this hour free?" into a promise two people act on. The confirmation
screen is the visible part; whether the promise holds is decided by the validation in front of the
hold, the atomicity of the hold, what happens when the calendar is slow, how the schedule reaches
systems you do not own, and whether the availability read is right about the last second.

## The real system

Cal.com's API v2 has \`POST /v2/slots/reservations\`: it makes a slot unavailable to everyone else
for a reservation window (5 minutes by default, a custom \`reservationDuration\` for authenticated
callers) and answers a \`reservationUid\` and a \`reservationUntil\` instant: the hold of step 2 with
its TTL in the response. Around it sit per-event-type slot lengths, buffers between bookings,
calendar connections that sync both ways, seats on one slot, and reschedule flows.

## What you build here

One service, **bookd**, on one \`booking\` support package every step imports: \`booking/tz\`
(instants as epoch seconds, ISO-8601 on the wire, six zones with their daylight rules),
\`booking/slots\` (30-minute slots named by their epoch minute, \`resource:{id}:slots\`, \`hold:{id}\`,
\`HOLD_TTL_S = 900\`, \`MAX_HORIZON_DAYS = 90\`, open hours 08:00 to 20:00 in the resolved zone) and
\`booking/store\` (bookings and the outbox in Redis, \`new_id\`).

1. \`POST /v1/bookings\`: tenant from \`X-Tenant-Id\`, a range that is strictly positive, in the future
   and inside 90 days, and the \`Idempotency-Key\` header as the booking's key: a replay returns the
   first booking with 200.
2. The **Redis** hold map: \`take_hold\` as one Lua script that checks every slot and writes them
   together, \`SET hold:{id} held EX 900\` for the payment window, a map that never expires, a
   guarded \`release_hold\`, and a \`confirm_hold\` that rewrites the slots to \`booked:{booking_id}\`.
3. The **gRPC** calendar sync: a 3000 ms deadline per attempt, the booking's idempotency key on every
   call, at most 3 attempts and only on \`DEADLINE_EXCEEDED\`/\`UNAVAILABLE\`, a permanent rejection that
   releases the hold, and a timeout that is reconciled with \`GetEvent\` before anything is cancelled.
4. The **Kafka** \`booking.event\` path: keyed by resource id, carrying the hold id and the range,
   committed to the store before it is produced, an idempotent producer with \`acks=all\`, an awaited
   ack and an outbox row when the broker does not answer.
5. \`GET /v1/resources/{id}/availability\`: free slots over at most 90 days, from the live map with
   confirmed bookings and live holds excluded, in a zone the response names.

## Left out on purpose

Payment processing, recurring bookings, resource catalogues and pricing, staff scheduling,
notifications, multi-region replication of the slot map, and the calendaring UI itself.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Client', sub: 'book · availability', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'bookd', sub: 'HTTPS :8443', x: 28, y: 50},
      {
        id: 'redis',
        kind: 'redis',
        label: 'Redis',
        sub: 'resource:{id}:slots · hold:{id} · booking:{id} · outbox',
        x: 52,
        y: 20,
      },
      {id: 'calendar', kind: 'grpc', label: 'Calendar', sub: 'Sync · GetEvent · 3000 ms', x: 52, y: 80},
      {id: 'kafka', kind: 'kafka', label: 'booking.event', sub: 'key = resource id', x: 74, y: 50},
      {id: 'consumer', kind: 'service', label: 'Schedule consumer', sub: 'group booking-schedule', x: 93, y: 50},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'EVALSHA · HGETALL · booking · outbox'},
      {from: 'api', to: 'calendar', kind: 'grpc', label: 'Sync(idempotency_key)'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after commit'},
      {from: 'kafka', to: 'consumer', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [bookingEndpointStep, bookingStateStep, bookingClientStep, bookingEventsStep, bookingReadStep],
  support: {
    python: {...protoModules, ...supportModulesPy},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
