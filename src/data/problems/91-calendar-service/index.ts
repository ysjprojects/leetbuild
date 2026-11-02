import type {Problem} from '@/lib/types';

import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';

/**
 * Calendar service: recurrence rules that provably terminate → generation-stamped Redis caches
 * where an exception is read against the expansion it modifies → gRPC notifications that carry
 * their change kind and one idempotency token per change → a calendar-keyed change stream
 * published after the commit → a read endpoint that bounds the window it expands and returns each
 * overridden instance exactly once.
 */
export const calendarServiceProblem: Problem = {
  id: 'calendar-service',
  title: 'Calendar Service',
  tagline: 'Recurrence rules with an end, a generation-stamped expansion cache, and one invite per change.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Calendar Service

A calendar service decides whether an event exists once or ten thousand times, whether four hundred
attendees are invited once or twice, and whether one tenant's rule is still expanding when the
on-call shift changes. The visible part is a row in a week view; the parts that decide whether the
service is safe are the recurrence contract, the cache overlay, the notification semantics, the
change stream, and the range read.

## The real system

CalDAV servers such as Nextcloud (built on sabre/dav) store a recurring event once as a VEVENT with
an RRULE and derive its occurrences on read: a \`calendar-query\` REPORT with a \`time-range\` filter
and the \`CALDAV:expand\` element returns the instances inside the window, with RECURRENCE-ID
overrides applied in place of the occurrences they replace. Expansion is not cheap, so the rule is
validated before it is stored: a frequency with no \`UNTIL\` and no \`COUNT\` is a program that does
not halt, and an occurrence is an instant in a timezone, so a naive local string does not survive a
DST boundary.

Expansion is cached per calendar, range and generation, with instance exceptions overlaid on it;
the two must change together or a reader ships an occurrence that no longer exists. Notifications
carry a change kind and an idempotency token, so a timezone-only correction is not a new invitation
and a retry reuses the token. Downstream sync is a stream keyed per calendar, carrying ids and
revisions rather than attendees and bodies, published only after the store has committed.

## What you build here

One service, **calendard**, with five pieces:

1. \`POST /v1/events\`: an authenticated create that validates the RRULE for termination and the
   datetimes for timezone offsets, refuses unknown rule parts, and stores the event with a revision.
2. A **Redis** expansion and exception cache: slices cached per \`(calendar, range, generation)\`,
   exceptions overlaid atomically under a generation bump, every key expired.
3. A **gRPC** notification client: a 3-second deadline per call, a declared change kind, one
   idempotency token per change, and cancels that pair only with delivered creates.
4. A **Kafka** \`calendar.event\` stream: keyed by calendar id, carrying event id, revision and kind
   only, published after the store commits.
5. \`GET /v1/calendars/{id}/events\`: a range read capped at 90 days, expanded server-side with a
   per-occurrence id and revision, each overridden instance once, private calendars refused to
   non-members.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, serves the demo, and looks
right. Debug it against the failure modes the task names, fix it, optimize what is wasteful, and
prove the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

UI rendering, free/busy aggregation, resource rooms, ICS import and export, push transport,
reminder scheduling, and sharing permissions beyond the membership check.`,
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
