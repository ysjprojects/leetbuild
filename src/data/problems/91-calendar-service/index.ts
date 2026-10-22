import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Calendar service on the AI-era track: the course is not "store an event", it is the review you
 * owe a model-generated calendar before it re-invites four hundred people. Recurrence rules that
 * provably terminate → generation-stamped Redis caches where an exception can never be read
 * against a stale expansion → gRPC notifications that carry their change kind and one idempotency
 * token per change → a calendar-keyed change stream published after the commit → a read endpoint
 * that bounds the window it expands and returns each overridden instance exactly once.
 */
export const calendarServiceProblem: Problem = {
  id: 'calendar-service',
  title: 'Calendar Service',
  tagline: 'Recurring events that expand correctly, notify once and never loop forever.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  track: 'ai',
  minutes: 70,
  statement: `# Calendar Service

A calendar service is the piece of a productivity platform that decides whether an event exists once
or ten thousand times, whether four hundred attendees are invited once or twice, and whether one
tenant's rule can still be expanding when the on-call shift changes. The visible part is a row in a
week view; the parts that decide whether the service is safe are the recurrence contract, the cache
overlay, the notification semantics, the change stream, and the range read.

## The real system

Production calendars store an event once and derive its occurrences, either on read or through an
expansion worker. The recurrence rule is a program, so it is validated before it is stored: a rule
that can generate occurrences forever without an end or a count is refused, because expansion would
never return. Time is the other half of that contract — an occurrence is a moment in a timezone, so
a naive local string cannot be the representation that survives a DST boundary or a tenant that
travels.

Expansion is expensive, so it is cached per calendar, per range and per generation, and instance
exceptions (a moved or cancelled occurrence) are overlaid on top of it. The overlay and the
expansion must change together: a reader that sees a cancellation against a stale slice ships an
occurrence that no longer exists.

Notifications are a side effect with a budget, so every call declares what changed and carries an
idempotency token: a timezone-only correction is not a new invitation, and a retry reuses the token
instead of minting one. Downstream sync is a stream, not a scatter: change events are keyed so a
calendar's stream stays ordered, they carry ids and revisions rather than attendees and bodies, and
they are published only after the event store has committed.

## What you build here

One service, **calendard**, with five pieces:

1. \`POST /v1/events\`: an authenticated create that validates the RRULE for termination and the
   datetimes for timezone offsets, refuses unknown rule parts instead of dropping them, and stores
   the event with a revision.
2. A **Redis** expansion and exception cache: expansion slices cached per
   \`(calendar, range, generation)\`, exceptions overlaid atomically under a generation bump so no
   read can mix generations, and every key expired with the event's changes.
3. A **gRPC** notification client: a 3-second deadline per call, a declared change kind, one
   idempotency token per change so a retry never duplicates an invite, and cancels that pair only
   with delivered creates.
4. A **Kafka** \`calendar.event\` stream: keyed by calendar id for per-calendar order, carrying
   event id, revision and kind only — never attendee addresses or event bodies — and published
   after the store commits.
5. \`GET /v1/calendars/{id}/events\`: a range read capped at 90 days, expanded server-side with a
   per-occurrence revision id, returning each overridden instance once, and refusing private
   calendars to non-members.

## The review habit

Every starter on this track is a plausible model-generated draft. It compiles, it serves the demo,
and it sounds confident. Your job in every step is the job you will have on a real feature: read the
draft against the failure modes, name the subtle one, fix it, and prove the fix with checks that
fail on the draft and pass on your version.

## Left out on purpose

UI rendering, free/busy aggregation across tenants, resource rooms and equipment, ICS import and
export, push notification transport, reminder scheduling, and calendar sharing permissions beyond
the membership check. The five pieces above are the ones that decide whether the calendar is
correct, isolated and shippable.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Calendar client', sub: 'invites · RSVP · ranges', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'Calendar API', sub: 'HTTPS :8443', x: 26, y: 44},
      {id: 'expander', kind: 'service', label: 'Expansion worker', sub: 'RRULE → instances', x: 26, y: 84},
      {id: 'store', kind: 'db', label: 'Postgres', sub: 'events · overrides · revisions', x: 44, y: 8},
      {id: 'redis', kind: 'redis', label: 'Redis', sub: 'expansion · exceptions · generation', x: 44, y: 44},
      {id: 'kafka', kind: 'kafka', label: 'calendar.event', sub: 'key = calendar', x: 44, y: 88},
      {id: 'notifier', kind: 'grpc', label: 'Notifier', sub: 'NotifyAttendees', x: 66, y: 20},
      {id: 'attendee', kind: 'external', label: 'Attendee mailer', sub: 'one invite per change', x: 66, y: 52},
      {id: 'sync', kind: 'service', label: 'Sync consumer', sub: 'group per calendar', x: 66, y: 88},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'store', kind: 'plain', label: 'events · overrides'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'expansion · exceptions'},
      {from: 'api', to: 'notifier', kind: 'grpc', label: 'NotifyAttendees'},
      {from: 'notifier', to: 'attendee', kind: 'grpc', label: 'one mail per change'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce calendar.event'},
      {from: 'kafka', to: 'sync', kind: 'kafka', label: 'consume'},
      {from: 'sync', to: 'store', kind: 'plain', label: 'apply change'},
      {from: 'expander', to: 'store', kind: 'plain', label: 'read rrules'},
      {from: 'expander', to: 'redis', kind: 'redis', label: 'memoised ranges'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
};
