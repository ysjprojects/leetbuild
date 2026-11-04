import type {Problem} from '@/lib/types';

import {protoFiles, protoModules} from './proto';
import {endpointStep} from './steps/1-endpoint';
import {stateStep} from './steps/2-state';
import {dependencyStep} from './steps/3-dependency';
import {eventsStep} from './steps/4-events';
import {readStep} from './steps/5-read';
import {supportModulesCpp, supportModulesGo, supportModulesPy, supportModulesScala, supportModulesTs} from './support';

/**
 * Calendar service: recurrence rules that provably end → a generation-stamped Redis expansion cache
 * with instance exceptions applied → attendee notifications with one token per change and a kind
 * per attendee → a calendar-keyed change stream published after the commit with an outbox → a range
 * read that refuses unknown and private calendars and bounds its window. The notifier is a stand-in
 * the harness serves over gRPC.
 */
export const calendarServiceProblem: Problem = {
  id: 'calendar-service',
  title: 'Calendar Service',
  tagline:
    'Recurring events stored once and expanded on read, over a Redis cache that one INCR retires when the calendar changes.',
  difficulty: 'hard',
  concepts: ['http', 'redis', 'grpc', 'kafka'],
  minutes: 70,
  statement: `# Calendar Service

A calendar stores a weekly standup once and derives its occurrences each time someone opens a week.
Whether that derivation ends, whether the cached week is the week that exists, whether forty
attendees get one notice per change and whether sync clients see the change in order are all decided
below the week view.

## The real system

The Google Calendar API stores a recurring event once, with an RRULE in its \`recurrence\` field.
\`events.list\` with \`singleEvents=true\` returns its instances one by one, and a moved or cancelled
instance is an exception that keeps its \`originalStartTime\`: the key that names the instance within
its series even after it moved. Google's own guide warns that editing instances one at a time
clutters the calendar and sends attendees a change notification for each edit.

## What you build here

One service, **calendard**, on one \`calendard\` support package every step imports:
\`calendard/rrule\` (instants as epoch seconds, ISO-8601 with an offset on the wire; the rule parts
\`FREQ\` (DAILY, WEEKLY), \`INTERVAL\`, \`COUNT\`, \`UNTIL\`; \`MAX_COUNT = 5000\`, \`MAX_RANGE_DAYS = 90\`;
\`expand(event, start, end)\` with occurrence ids \`{event_id}:{epoch start}\`) and \`calendard/store\`
(calendars, members, events, exceptions and the outbox in Redis, \`new_id\`).

1. \`POST /v1/events\`: a rule that ends, parts the expander knows, instants with an offset, \`dtend\`
   after \`dtstart\`; \`store.put_event\`, then step 2's \`bump_generation\`, then **201** with the event.
2. The **Redis** expansion cache: \`gen:{calendar}\` counts changes; \`cached_expansion(calendar, start,
   end)\` serves \`exp:{calendar}:{generation}:{start}:{end}\` for 300 s with the exceptions of
   \`exceptions:{calendar}\` applied; \`record_exception\` writes before it bumps.
3. The **gRPC** notifier: \`notify_change(before, after)\` calls \`Notifier.NotifyAttendees\` with a 3 s
   deadline and one token per event, revision and kind: \`update\` to kept attendees, \`create\` to
   added ones, \`cancel\` to removed ones.
4. The **Kafka** \`calendar.event\` stream: \`publish_change(event, kind)\` commits the event, then
   produces \`{event_id, calendar_id, revision, kind}\` keyed by calendar id, waits at most 2 s for the
   ack and writes an outbox row otherwise.
5. \`GET /v1/calendars/{id}/events?from=&to=\`: **404** for an unknown calendar, **403** for a private
   one the tenant is not a member of, a window of at most 90 days, occurrences from
   \`cached_expansion\`, \`Cache-Control: private\` on private calendars.

## The debugging habit

Every starter in this course is working code with flaws: it compiles, it serves the happy path, and
it looks right. In every step, debug it against the failure modes the task names, fix it, and prove
the fix with checks that fail on the starter and pass on your version.

## Left out on purpose

Daylight-saving rules (occurrences repeat at the same UTC time), \`BYDAY\` and the rest of RFC 5545,
the routes that edit events and exceptions (steps 2 to 4 provide the functions they call), free/busy,
ICS import and export, and reminders.`,
  diagram: {
    nodes: [
      {id: 'client', kind: 'client', label: 'Calendar client', sub: 'create · week view', x: 8, y: 50},
      {id: 'api', kind: 'http', label: 'calendard', sub: 'HTTPS :8443', x: 28, y: 50},
      {
        id: 'redis',
        kind: 'redis',
        label: 'Redis',
        sub: 'event:{id} · gen:{cal} · exp:{cal}:{gen}:{start}:{end} · exceptions · outbox',
        x: 52,
        y: 16,
      },
      {id: 'notifier', kind: 'grpc', label: 'Notifier', sub: 'NotifyAttendees · 3 s', x: 52, y: 84},
      {id: 'kafka', kind: 'kafka', label: 'calendar.event', sub: 'key = calendar id', x: 74, y: 50},
      {id: 'sync', kind: 'service', label: 'Sync consumer', sub: 'per-calendar order', x: 93, y: 50},
    ],
    edges: [
      {from: 'client', to: 'api', kind: 'http', label: 'HTTPS'},
      {from: 'api', to: 'redis', kind: 'redis', label: 'put_event · INCR gen · cached slices'},
      {from: 'api', to: 'notifier', kind: 'grpc', label: 'NotifyAttendees(token, kind)'},
      {from: 'api', to: 'kafka', kind: 'kafka', label: 'produce after commit'},
      {from: 'kafka', to: 'sync', kind: 'kafka', label: 'consume'},
    ],
  },
  steps: [endpointStep, stateStep, dependencyStep, eventsStep, readStep],
  support: {
    python: {...protoModules, ...supportModulesPy},
    typescript: {...protoFiles, ...supportModulesTs},
    go: {...protoFiles, ...supportModulesGo},
    cpp: {...protoFiles, ...supportModulesCpp},
    scala: {...protoFiles, ...supportModulesScala},
  },
};
