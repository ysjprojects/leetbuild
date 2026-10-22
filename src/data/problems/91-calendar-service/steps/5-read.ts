import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/calendars/{id}/events: ranges that bound expansion',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'expander', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the range route,
reads the window, expands each event's rule and answers with the instances. It compiles, it serves
the week view in the demo, and it hides four production flaws. Review it like the service owner,
fix it, and prove the fix with the checks below.

Implement \`GET /v1/calendars/{id}/events?from=<iso>&to=<iso>\`.

- The caller is the \`X-Tenant-Id\` header. A calendar that does not exist is **404**; a calendar
  whose \`visibility\` is \`private\` is **403** for a caller who is not a member. Both checks come
  before any cache or expansion work, so a request that cannot be authorized never pays for
  instances.
- \`from\` and \`to\` are ISO-8601 instants and both are required (**400** when missing), \`to\` must be
  strictly after \`from\` (**400** when inverted), and the window may span at most **90 days**
  (\`MAX_RANGE_DAYS\`) — a wider range is **400**, never a silent clamp. The cap is the request's
  budget: the expander pays for every occurrence in the window and an infinite rule has no upper
  bound of its own.
- Expansion happens server-side. The raw expansion is memoised under
  \`(calendar, window, generation)\` — the calendar's \`generation\` stamps the key, so a slice built
  before an override bump is never read again — and every occurrence carries
  \`occurrence_id = "<event_id>:<start_iso>"\` plus the \`revision\` it was expanded from, so a client
  can dedupe instances across refreshes.
- Instance overrides from the store are keyed by that same \`occurrence_id\`. Overlay them after the
  expansion: an occurrence covered by an override is skipped by the expansion and emitted **once**,
  in its place, with the override's own \`revision\`. An overridden instance must never appear beside
  its original.
- Respond with \`{"calendar_id": …, "events": [{"occurrence_id", "event_id", "start", "revision"}, …]}\`,
  ordered by \`start\`.

**Failure mode the checks target.** The silent clamp is the quiet one: defaulting to a year and
truncating a wider request both look like resilience, but they turn a caller's bug into a year of
expansion work and hand back a window nobody asked for. Around it: instances without an occurrence
id cannot be deduped client-side, an override listed beside its original double-books the slot the
user is looking at, and a private calendar whose membership is never checked leaks its events to any
authenticated caller.`,
  sequence: {
    participants: ['Calendar client', 'Calendar API', 'Expansion worker', 'Redis'],
    messages: [
      {from: 'Calendar client', to: 'Calendar API', label: 'GET /v1/calendars/cal_7/events?from=…&to=…', kind: 'sync'},
      {
        from: 'Calendar API',
        to: 'Calendar API',
        label: '404 unknown · 403 non-member · 400 window > 90 days',
        kind: 'sync',
      },
      {from: 'Calendar API', to: 'Redis', label: 'GET expansion:cal_7:2026-03-01/2026-05-30:gen7', kind: 'sync'},
      {from: 'Redis', to: 'Calendar API', label: 'slice / miss', kind: 'reply'},
      {from: 'Calendar API', to: 'Expansion worker', label: 'expand(rrule, window) · only on a miss', kind: 'sync'},
      {from: 'Expansion worker', to: 'Calendar API', label: 'instances · occurrence_id · revision', kind: 'reply'},
      {from: 'Calendar API', to: 'Redis', label: 'SET slice · generation-stamped', kind: 'async'},
      {
        from: 'Calendar API',
        to: 'Calendar client',
        label: '200 {events} · each override once, in place',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/calendars/{id}/events',
      detail: 'Register the range read on `GET /v1/calendars/{id}/events`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/calendars\/\{id\}\/events["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/calendars\/:id\/events['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/calendars\/\{id\}\/events"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"calendars"\s*\/\s*Segment\s*\/\s*"events"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/calendars\/[^"]*\/events/]},
      },
    },
    {
      id: 'range-cap',
      title: 'Rejects a window over 90 days with 400',
      detail:
        'Both bounds are required, `to` must be after `from`, and the window may span at most **90 days** (`MAX_RANGE_DAYS`); every violation answers **400** before the expansion runs. The draft defaults to a year, swaps inverted bounds and clamps anything wider instead of failing the request.',
      match: {
        python: {all: [/MAX_RANGE_DAYS/, /timedelta\(\s*days\s*=\s*MAX_RANGE_DAYS\s*\)/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_RANGE_DAYS/, /MAX_RANGE_MS/, /code\(\s*400\s*\)/]},
        go: {all: [/maxRangeDays/, /maxRange\b/, /http\.StatusBadRequest/]},
        scala: {all: [/MaxRangeDays/, /MaxRange\b/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxRangeDays/, /kMaxRangeSeconds/, /\b400\b/]},
      },
    },
    {
      id: 'occurrence-ids',
      title: 'Expands server-side with a per-occurrence id and revision',
      detail:
        'The read path expands the rules itself and memoises the slice under `(calendar, window, generation)`; every occurrence carries `occurrence_id` (`event_id:start`) plus the `revision` it was expanded from, so a client can dedupe across refreshes. The draft returns the raw RRULE and no per-occurrence id.',
      match: {
        python: {
          all: [
            /f"\{event_id\}:\{start_iso\}"/,
            /"revision": event\["revision"\]/,
            /cache\.get_slice\(/,
            /cache\.put_slice\(/,
          ],
        },
        typescript: {
          all: [
            /\$\{event\.id\}:\$\{startIso\}/,
            /revision: event\.revision/,
            /cache\.getSlice\(/,
            /cache\.putSlice\(/,
          ],
        },
        go: {
          all: [
            /event\.ID \+ ":" \+ startISO/,
            /Revision:\s+event\.Revision/,
            /cache\.GetSlice\(/,
            /cache\.PutSlice\(/,
          ],
        },
        scala: {
          all: [/s"\$eventId:\$startIso"/, /startIso, event\.revision/, /cache\.getSlice\(/, /cache\.putSlice\(/],
        },
        cpp: {
          all: [
            /event\.id \+ ":" \+ startIso/,
            /startIso, event\.revision\}/,
            /cache\.getSlice\(/,
            /cache\.putSlice\(/,
          ],
        },
      },
    },
    {
      id: 'instance-once',
      title: 'Emits an overridden instance once, in place',
      detail:
        'An occurrence the override table already covers is skipped by the expansion — keyed by `occurrence_id`, the same key the store uses — and the override is appended instead, with its own revision. The draft lists the original and the override side by side, so the slot is booked twice.',
      match: {
        python: {
          all: [/overrides\.get\(/, /overrides\.items\(\)/, /override\["revision"\]/],
          order: [/cache\.get_slice\(/, /overrides\.get\(/],
        },
        typescript: {
          all: [/overrides\.has\(/, /for \(const \[oid, override\] of overrides\)/, /override\.revision/],
          order: [/cache\.getSlice\(/, /overrides\.has\(/],
        },
        go: {
          all: [/overrides\[instance\.OccurrenceID\]/, /for oid, override := range overrides/, /override\.Revision/],
          order: [/cache\.GetSlice\(/, /overrides\[instance\.OccurrenceID\]/],
        },
        scala: {
          all: [/filterNot\(/, /overrides\.contains\(/, /exception\.revision/],
          order: [/cache\.getSlice\(/, /filterNot\(/],
        },
        cpp: {
          all: [/overrides\.count\(/, /for \(const auto& \[oid, override\] : overrides\)/, /override\.revision/],
          order: [/cache\.getSlice\(/, /overrides\.count\(/],
        },
      },
    },
    {
      id: 'private-calendars',
      title: 'Refuses non-members on private calendars with 403',
      detail:
        'An unknown calendar is **404** and a `private` calendar is **403** for a caller whose tenant is not a member — both before any expansion or cache work. The draft serves private calendars to every caller that gets past the 404.',
      match: {
        python: {
          all: [/PRIVATE/, /store\.is_member\(/, /status_code\s*=\s*403/, /status_code\s*=\s*404/],
          order: [/store\.is_member\(/, /cache\.get_slice\(/],
        },
        typescript: {
          all: [/PRIVATE/, /store\.isMember\(/, /code\(\s*403\s*\)/, /code\(\s*404\s*\)/],
          order: [/store\.isMember\(/, /cache\.getSlice\(/],
        },
        go: {
          all: [/privateVisibility/, /store\.IsMember\(/, /http\.StatusForbidden/, /http\.StatusNotFound/],
          order: [/store\.IsMember\(/, /cache\.GetSlice\(/],
        },
        scala: {
          all: [/PrivateVisibility/, /store\.isMember\(/, /StatusCodes\.Forbidden/, /StatusCodes\.NotFound/],
          order: [/store\.isMember\(/, /cache\.getSlice\(/],
        },
        cpp: {
          all: [/kPrivateVisibility/, /store\.isMember\(/, /\b403\b/, /\b404\b/],
          order: [/store\.isMember\(/, /cache\.getSlice\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
from datetime import datetime, timedelta

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("calendar")

DEFAULT_WINDOW_DAYS = 365


class CalendarStore:
    def get_calendar(self, calendar_id: str) -> dict | None:
        """The calendar row: id, visibility, generation."""
        raise NotImplementedError

    def is_member(self, calendar_id: str, tenant: str) -> bool:
        """True when the tenant may read this calendar's events."""
        raise NotImplementedError

    def list_events(self, calendar_id: str) -> list[dict]:
        """The calendar's events: id, revision, rrule."""
        raise NotImplementedError

    def list_overrides(self, calendar_id: str) -> list[dict]:
        """Instance exceptions: occurrence_id, event_id, start, revision."""
        raise NotImplementedError


class ExpansionCache:
    def get_slice(self, calendar_id: str, window: str, generation: int) -> list[dict] | None:
        """The expansion cached for (calendar, window, generation), if any."""
        raise NotImplementedError

    def put_slice(self, calendar_id: str, window: str, generation: int, instances: list[dict]) -> None:
        """Cache a raw expansion under the calendar's current generation."""
        raise NotImplementedError


store = CalendarStore()
cache = ExpansionCache()


def expand(event: dict, start: datetime, end: datetime) -> list[str]:
    """Start timestamps of the event's RRULE instances inside [start, end)."""
    raise NotImplementedError


def parse_window(from_raw: str | None, to_raw: str | None) -> tuple[datetime, datetime]:
    start = datetime.fromisoformat(from_raw) if from_raw else datetime.now()
    end = datetime.fromisoformat(to_raw) if to_raw else start + timedelta(days=DEFAULT_WINDOW_DAYS)
    if end <= start:
        start, end = end, start
    if end - start > timedelta(days=DEFAULT_WINDOW_DAYS):
        end = start + timedelta(days=DEFAULT_WINDOW_DAYS)
    return start, end


@app.get("/v1/calendars/{id}/events")
def read_events(
    id: str,
    from_: str | None = Query(default=None, alias="from"),
    to_: str | None = Query(default=None, alias="to"),
) -> JSONResponse:
    # TODO: this draft expands a year when the range is missing and silently clamps a wider one,
    # returns the raw RRULE with no per-occurrence id, lists overrides beside the instances they
    # replace, and never asks whether the caller may read this calendar. Review all four.
    calendar = store.get_calendar(id)
    if calendar is None:
        raise HTTPException(status_code=404, detail="unknown calendar")
    start, end = parse_window(from_, to_)
    events = []
    for event in store.list_events(id):
        for start_iso in expand(event, start, end):
            events.append({"event_id": event["id"], "rrule": event["rrule"], "start": start_iso})
    for override in store.list_overrides(id):
        events.append(override)
    logger.info("read calendar=%s events=%d", id, len(events))
    return JSONResponse({"calendar_id": id, "events": events}, status_code=200)
`,
      solution: `import logging
from datetime import datetime, timedelta

from fastapi import FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("calendar")

MAX_RANGE_DAYS = 90
PRIVATE = "private"


class CalendarStore:
    def get_calendar(self, calendar_id: str) -> dict | None:
        """The calendar row: id, visibility, generation."""
        raise NotImplementedError

    def is_member(self, calendar_id: str, tenant: str) -> bool:
        """True when the tenant may read this calendar's events."""
        raise NotImplementedError

    def list_events(self, calendar_id: str) -> list[dict]:
        """The calendar's events: id, revision, rrule."""
        raise NotImplementedError

    def list_overrides(self, calendar_id: str) -> dict[str, dict]:
        """Instance exceptions keyed by occurrence id: event_id, start, revision."""
        raise NotImplementedError


class ExpansionCache:
    def get_slice(self, calendar_id: str, window: str, generation: int) -> list[dict] | None:
        """The expansion cached for (calendar, window, generation), if any."""
        raise NotImplementedError

    def put_slice(self, calendar_id: str, window: str, generation: int, instances: list[dict]) -> None:
        """Cache a raw expansion under the calendar's current generation."""
        raise NotImplementedError


store = CalendarStore()
cache = ExpansionCache()


def expand(event: dict, start: datetime, end: datetime) -> list[str]:
    """Start timestamps of the event's RRULE instances inside [start, end)."""
    raise NotImplementedError


def parse_window(from_raw: str | None, to_raw: str | None) -> tuple[datetime, datetime]:
    if from_raw is None or to_raw is None:
        raise HTTPException(status_code=400, detail="from and to are required")
    try:
        start = datetime.fromisoformat(from_raw)
        end = datetime.fromisoformat(to_raw)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="from and to must be ISO-8601") from exc
    if end <= start:
        raise HTTPException(status_code=400, detail="to must be after from")
    if end - start > timedelta(days=MAX_RANGE_DAYS):
        raise HTTPException(status_code=400, detail="range exceeds 90 days")
    return start, end


@app.get("/v1/calendars/{id}/events")
def read_events(
    id: str,
    from_: str | None = Query(default=None, alias="from"),
    to_: str | None = Query(default=None, alias="to"),
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    calendar = store.get_calendar(id)
    if calendar is None:
        raise HTTPException(status_code=404, detail="unknown calendar")
    if calendar["visibility"] == PRIVATE and not store.is_member(id, tenant or ""):
        raise HTTPException(status_code=403, detail="not a member of this calendar")
    start, end = parse_window(from_, to_)

    generation = calendar["generation"]
    window = f"{start.isoformat()}/{end.isoformat()}"
    expansion = cache.get_slice(id, window, generation)
    if expansion is None:
        expansion = []
        for event in store.list_events(id):
            event_id = event["id"]
            for start_iso in expand(event, start, end):
                expansion.append(
                    {
                        "occurrence_id": f"{event_id}:{start_iso}",
                        "event_id": event_id,
                        "start": start_iso,
                        "revision": event["revision"],
                    }
                )
        cache.put_slice(id, window, generation, expansion)

    overrides = store.list_overrides(id)
    events = []
    for instance in expansion:
        if overrides.get(instance["occurrence_id"]) is not None:
            continue  # emitted once, in place, by the overlay below
        events.append(instance)
    for oid, override in overrides.items():
        override_start = datetime.fromisoformat(override["start"])
        if not start <= override_start < end:
            continue
        events.append(
            {
                "occurrence_id": oid,
                "event_id": override["event_id"],
                "start": override["start"],
                "revision": override["revision"],
            }
        )
    events.sort(key=lambda item: item["start"])
    logger.info("read calendar=%s generation=%s events=%d", id, generation, len(events))
    return JSONResponse({"calendar_id": id, "events": events}, status_code=200)
`,
    },
    typescript: {
      starter: `/** GET /v1/calendars/:id/events: a model-generated draft that expands a year by default. */
import Fastify from 'fastify';

export const app = Fastify();

const DEFAULT_WINDOW_DAYS = 365;
const DEFAULT_WINDOW_MS = DEFAULT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

interface CalendarRow {
  id: string;
  visibility: string;
  generation: number;
}

interface EventRow {
  id: string;
  revision: number;
  rrule: string;
}

interface OverrideRow {
  event_id: string;
  start: string;
  revision: number;
}

interface InstanceRow {
  occurrence_id: string;
  event_id: string;
  start: string;
  revision: number;
}

interface CalendarStore {
  getCalendar(id: string): Promise<CalendarRow | null>;
  isMember(calendarId: string, tenant: string): Promise<boolean>;
  listEvents(calendarId: string): Promise<EventRow[]>;
  listOverrides(calendarId: string): Promise<Map<string, OverrideRow>>;
}

interface ExpansionCache {
  getSlice(calendarId: string, window: string, generation: number): Promise<InstanceRow[] | null>;
  putSlice(calendarId: string, window: string, generation: number, instances: InstanceRow[]): Promise<void>;
}

declare const store: CalendarStore;
declare const cache: ExpansionCache;
declare function expand(event: EventRow, fromMs: number, toMs: number): string[];

app.get('/v1/calendars/:id/events', async (request, reply) => {
  // TODO: this draft expands a year when the range is missing and silently clamps a wider one,
  // returns the raw RRULE with no per-occurrence id, lists overrides beside the instances they
  // replace, and never asks whether the caller may read this calendar. Review all four.
  const calendar = await store.getCalendar(request.params.id);
  if (calendar === null) return reply.code(404).send({error: 'unknown calendar'});

  const query = request.query as {from?: string; to?: string};
  const requestedFrom = query.from === undefined ? Date.now() : Date.parse(query.from);
  const requestedTo = query.to === undefined ? requestedFrom + DEFAULT_WINDOW_MS : Date.parse(query.to);
  const fromMs = Math.min(requestedFrom, requestedTo);
  const toMs = Math.min(Math.max(requestedFrom, requestedTo), fromMs + DEFAULT_WINDOW_MS);

  const rows: Array<Partial<InstanceRow> & {rrule?: string}> = [];
  for (const event of await store.listEvents(calendar.id)) {
    for (const startIso of expand(event, fromMs, toMs))
      rows.push({event_id: event.id, rrule: event.rrule, start: startIso});
  }
  for (const [oid, override] of await store.listOverrides(calendar.id)) {
    rows.push({occurrence_id: oid, event_id: override.event_id, start: override.start});
  }
  request.log.info({calendar: calendar.id, events: rows.length}, 'read');
  return reply.code(200).send({calendar_id: calendar.id, events: rows});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/calendars/:id/events: bounded windows, expanded server-side, overrides in place. */
import Fastify from 'fastify';

export const app = Fastify();

const MAX_RANGE_DAYS = 90;
const MAX_RANGE_MS = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;
const PRIVATE = 'private';

interface CalendarRow {
  id: string;
  visibility: string;
  generation: number;
}

interface EventRow {
  id: string;
  revision: number;
  rrule: string;
}

interface OverrideRow {
  event_id: string;
  start: string;
  revision: number;
}

interface InstanceRow {
  occurrence_id: string;
  event_id: string;
  start: string;
  revision: number;
}

interface CalendarStore {
  getCalendar(id: string): Promise<CalendarRow | null>;
  isMember(calendarId: string, tenant: string): Promise<boolean>;
  listEvents(calendarId: string): Promise<EventRow[]>;
  listOverrides(calendarId: string): Promise<Map<string, OverrideRow>>;
}

interface ExpansionCache {
  getSlice(calendarId: string, window: string, generation: number): Promise<InstanceRow[] | null>;
  putSlice(calendarId: string, window: string, generation: number, instances: InstanceRow[]): Promise<void>;
}

declare const store: CalendarStore;
declare const cache: ExpansionCache;
declare function expand(event: EventRow, fromMs: number, toMs: number): string[];

app.get('/v1/calendars/:id/events', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  const calendar = await store.getCalendar(request.params.id);
  if (calendar === null) return reply.code(404).send({error: 'unknown calendar'});
  const member = typeof tenant === 'string' && (await store.isMember(calendar.id, tenant));
  if (calendar.visibility === PRIVATE && !member)
    return reply.code(403).send({error: 'not a member of this calendar'});

  const query = request.query as {from?: string; to?: string};
  const fromMs = query.from === undefined ? Number.NaN : Date.parse(query.from);
  const toMs = query.to === undefined ? Number.NaN : Date.parse(query.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs))
    return reply.code(400).send({error: 'from and to are required'});
  if (toMs <= fromMs) return reply.code(400).send({error: 'to must be after from'});
  if (toMs - fromMs > MAX_RANGE_MS) return reply.code(400).send({error: 'range exceeds 90 days'});

  const window = \`\${query.from}/\${query.to}\`;
  let expansion = await cache.getSlice(calendar.id, window, calendar.generation);
  if (expansion === null) {
    expansion = [];
    for (const event of await store.listEvents(calendar.id)) {
      for (const startIso of expand(event, fromMs, toMs)) {
        expansion.push({
          occurrence_id: \`\${event.id}:\${startIso}\`,
          event_id: event.id,
          start: startIso,
          revision: event.revision,
        });
      }
    }
    await cache.putSlice(calendar.id, window, calendar.generation, expansion);
  }

  const overrides = await store.listOverrides(calendar.id);
  const events: InstanceRow[] = [];
  for (const instance of expansion) {
    if (overrides.has(instance.occurrence_id)) continue; // emitted once, in place, by the overlay below
    events.push(instance);
  }
  for (const [oid, override] of overrides) {
    const overrideMs = Date.parse(override.start);
    if (overrideMs < fromMs || overrideMs >= toMs) continue;
    events.push({
      occurrence_id: oid,
      event_id: override.event_id,
      start: override.start,
      revision: override.revision,
    });
  }
  events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  request.log.info({calendar: calendar.id, generation: calendar.generation, events: events.length}, 'read');
  return reply.code(200).send({calendar_id: calendar.id, events});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

const (
	defaultWindowDays = 365
	defaultWindow     = time.Duration(defaultWindowDays) * 24 * time.Hour
)

type Calendar struct {
	ID         string \`json:"id"\`
	Visibility string \`json:"visibility"\`
	Generation int    \`json:"generation"\`
}

type Event struct {
	ID       string \`json:"id"\`
	Revision int    \`json:"revision"\`
	RRule    string \`json:"rrule"\`
}

type Override struct {
	EventID  string \`json:"event_id"\`
	Start    string \`json:"start"\`
	Revision int    \`json:"revision"\`
}

type Instance struct {
	OccurrenceID string \`json:"occurrence_id"\`
	EventID      string \`json:"event_id"\`
	Start        string \`json:"start"\`
	Revision     int    \`json:"revision"\`
}

type CalendarStore struct{}

func (s *CalendarStore) GetCalendar(ctx context.Context, id string) (*Calendar, error) { return nil, nil }
func (s *CalendarStore) IsMember(ctx context.Context, id, tenant string) (bool, error) { return false, nil }
func (s *CalendarStore) ListEvents(ctx context.Context, id string) ([]Event, error)    { return nil, nil }

func (s *CalendarStore) ListOverrides(ctx context.Context, id string) (map[string]Override, error) {
	return nil, nil
}

type ExpansionCache struct{}

func (c *ExpansionCache) GetSlice(ctx context.Context, id, window string, generation int) ([]Instance, error) {
	return nil, nil
}

func (c *ExpansionCache) PutSlice(ctx context.Context, id, window string, generation int, instances []Instance) error {
	return nil
}

var (
	store = &CalendarStore{}
	cache = &ExpansionCache{}
)

// expand returns the start instants (RFC 3339) of the event's RRULE instances inside the window.
func expand(event Event, from, to time.Time) []string {
	panic("expansion lives in the expansion worker")
}

func readEvents(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft expands a year when the range is missing and silently clamps a wider one,
	// returns the raw RRULE with no per-occurrence id, lists overrides beside the instances they
	// replace, and never asks whether the caller may read this calendar. Review all four.
	id := r.PathValue("id")
	calendar, err := store.GetCalendar(r.Context(), id)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if calendar == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown calendar"})
		return
	}

	from := time.Now().UTC()
	if parsed, err := time.Parse(time.RFC3339, r.URL.Query().Get("from")); err == nil {
		from = parsed
	}
	to := from.Add(defaultWindow)
	if parsed, err := time.Parse(time.RFC3339, r.URL.Query().Get("to")); err == nil {
		to = parsed
	}
	if !to.After(from) {
		from, to = to, from
	}
	if to.Sub(from) > defaultWindow {
		to = from.Add(defaultWindow)
	}

	rows := []map[string]any{}
	events, err := store.ListEvents(r.Context(), id)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	for _, event := range events {
		for _, startISO := range expand(event, from, to) {
			rows = append(rows, map[string]any{"event_id": event.ID, "rrule": event.RRule, "start": startISO})
		}
	}
	overrides, err := store.ListOverrides(r.Context(), id)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	for oid, override := range overrides {
		rows = append(rows, map[string]any{"occurrence_id": oid, "event_id": override.EventID, "start": override.Start})
	}
	log.Printf("read calendar=%s events=%d", id, len(rows))
	writeJSON(rw, http.StatusOK, map[string]any{"calendar_id": id, "events": rows})
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/calendars/{id}/events", readEvents)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sort"
	"time"
)

const (
	maxRangeDays      = 90
	maxRange          = time.Duration(maxRangeDays) * 24 * time.Hour
	privateVisibility = "private"
)

type Calendar struct {
	ID         string \`json:"id"\`
	Visibility string \`json:"visibility"\`
	Generation int    \`json:"generation"\`
}

type Event struct {
	ID       string \`json:"id"\`
	Revision int    \`json:"revision"\`
	RRule    string \`json:"rrule"\`
}

type Override struct {
	EventID  string \`json:"event_id"\`
	Start    string \`json:"start"\`
	Revision int    \`json:"revision"\`
}

type Instance struct {
	OccurrenceID string \`json:"occurrence_id"\`
	EventID      string \`json:"event_id"\`
	Start        string \`json:"start"\`
	Revision     int    \`json:"revision"\`
}

type CalendarStore struct{}

func (s *CalendarStore) GetCalendar(ctx context.Context, id string) (*Calendar, error) { return nil, nil }
func (s *CalendarStore) IsMember(ctx context.Context, id, tenant string) (bool, error) { return false, nil }
func (s *CalendarStore) ListEvents(ctx context.Context, id string) ([]Event, error)    { return nil, nil }

// ListOverrides returns the instance exceptions keyed by occurrence id.
func (s *CalendarStore) ListOverrides(ctx context.Context, id string) (map[string]Override, error) {
	return nil, nil
}

type ExpansionCache struct{}

func (c *ExpansionCache) GetSlice(ctx context.Context, id, window string, generation int) ([]Instance, error) {
	return nil, nil
}

func (c *ExpansionCache) PutSlice(ctx context.Context, id, window string, generation int, instances []Instance) error {
	return nil
}

var (
	store = &CalendarStore{}
	cache = &ExpansionCache{}
)

// expand returns the start instants (RFC 3339) of the event's RRULE instances inside the window.
func expand(event Event, from, to time.Time) []string {
	panic("expansion lives in the expansion worker")
}

// parseWindow returns the request's window, or the reason it is not served.
func parseWindow(fromRaw, toRaw string) (time.Time, time.Time, string) {
	if fromRaw == "" || toRaw == "" {
		return time.Time{}, time.Time{}, "from and to are required"
	}
	from, err := time.Parse(time.RFC3339, fromRaw)
	if err != nil {
		return time.Time{}, time.Time{}, "from must be RFC 3339"
	}
	to, err := time.Parse(time.RFC3339, toRaw)
	if err != nil {
		return time.Time{}, time.Time{}, "to must be RFC 3339"
	}
	if !to.After(from) {
		return time.Time{}, time.Time{}, "to must be after from"
	}
	if to.Sub(from) > maxRange {
		return time.Time{}, time.Time{}, "range exceeds 90 days"
	}
	return from, to, ""
}

func readEvents(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	id := r.PathValue("id")
	calendar, err := store.GetCalendar(r.Context(), id)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if calendar == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "unknown calendar"})
		return
	}
	if calendar.Visibility == privateVisibility {
		member, err := store.IsMember(r.Context(), id, tenant)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		if !member {
			writeJSON(rw, http.StatusForbidden, map[string]string{"error": "not a member of this calendar"})
			return
		}
	}

	fromRaw, toRaw := r.URL.Query().Get("from"), r.URL.Query().Get("to")
	from, to, invalid := parseWindow(fromRaw, toRaw)
	if invalid != "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": invalid})
		return
	}

	window := fromRaw + "/" + toRaw
	expansion, err := cache.GetSlice(r.Context(), id, window, calendar.Generation)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if expansion == nil {
		events, err := store.ListEvents(r.Context(), id)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		for _, event := range events {
			for _, startISO := range expand(event, from, to) {
				expansion = append(expansion, Instance{
					OccurrenceID: event.ID + ":" + startISO,
					EventID:      event.ID,
					Start:        startISO,
					Revision:     event.Revision,
				})
			}
		}
		if err := cache.PutSlice(r.Context(), id, window, calendar.Generation, expansion); err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
	}

	overrides, err := store.ListOverrides(r.Context(), id)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	out := make([]Instance, 0, len(expansion))
	for _, instance := range expansion {
		if _, ok := overrides[instance.OccurrenceID]; ok {
			continue // emitted once, in place, by the overlay below
		}
		out = append(out, instance)
	}
	for oid, override := range overrides {
		start, err := time.Parse(time.RFC3339, override.Start)
		if err != nil || start.Before(from) || !start.Before(to) {
			continue
		}
		out = append(out, Instance{
			OccurrenceID: oid,
			EventID:      override.EventID,
			Start:        override.Start,
			Revision:     override.Revision,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	log.Printf("read calendar=%s generation=%d events=%d", id, calendar.Generation, len(out))
	writeJSON(rw, http.StatusOK, map[string]any{"calendar_id": id, "events": out})
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/calendars/{id}/events", readEvents)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import java.time.Instant

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Calendar(id: String, visibility: String, generation: Int)
final case class Event(id: String, revision: Int, rrule: String)
final case class Override(event_id: String, start: String, revision: Int)
final case class Row(event_id: String, start: String, rrule: String)

class CalendarStore {
  def getCalendar(id: String): Option[Calendar] = None
  def isMember(id: String, tenant: String): Boolean = false
  def listEvents(id: String): List[Event] = Nil
  def listOverrides(id: String): Map[String, Override] = Map.empty
}

class ExpansionCache {
  def getSlice(id: String, window: String, generation: Int): Option[List[Row]] = None
  def putSlice(id: String, window: String, generation: Int, rows: List[Row]): Unit = ()
}

object Expander {
  /** Start instants (ISO-8601) of the event's RRULE instances inside the window. */
  def expand(event: Event, fromMs: Long, toMs: Long): List[String] =
    throw new UnsupportedOperationException("expansion lives in the expansion worker")
}

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("calendar")
  implicit val rowFormat: RootJsonFormat[Row] = jsonFormat3(Row)

  val DefaultWindowDays = 365
  val DefaultWindow = DefaultWindowDays.toLong * 24 * 60 * 60 * 1000

  val store = new CalendarStore
  val cache = new ExpansionCache

  def parseWindow(fromRaw: Option[String], toRaw: Option[String]): (Long, Long) = {
    val start = fromRaw.map(Instant.parse(_).toEpochMilli).getOrElse(System.currentTimeMillis())
    val asked = toRaw.map(Instant.parse(_).toEpochMilli).getOrElse(start + DefaultWindow)
    val end = if (asked <= start) start + DefaultWindow else asked
    (start, math.min(end, start + DefaultWindow))
  }

  def readEvents(id: String, fromRaw: Option[String], toRaw: Option[String]): (StatusCode, String) = {
    // TODO: this draft expands a year when the range is missing and silently clamps a wider one,
    // returns the raw RRULE with no per-occurrence id, lists overrides beside the instances they
    // replace, and never asks whether the caller may read this calendar. Review all four.
    store.getCalendar(id) match {
      case None => (StatusCodes.NotFound, """{"error":"unknown calendar"}""")
      case Some(_) =>
        val (fromMs, toMs) = parseWindow(fromRaw, toRaw)
        val rows = scala.collection.mutable.ArrayBuffer.empty[Row]
        store.listEvents(id).foreach { event =>
          Expander.expand(event, fromMs, toMs).foreach { startIso =>
            rows += Row(event.id, startIso, event.rrule)
          }
        }
        store.listOverrides(id).foreach { case (_, exception) =>
          rows += Row(exception.event_id, exception.start, "")
        }
        system.log.info(s"read calendar=$id events=\${rows.size}")
        (StatusCodes.OK, s"""{"calendar_id":"$id","events":\${rows.toJson.compactPrint}}""")
    }
  }

  val route: Route =
    path("v1" / "calendars" / Segment / "events") { id =>
      get {
        parameters("from".?, "to".?) { (fromOpt, toOpt) =>
          val (status, body) = readEvents(id, fromOpt, toOpt)
          complete(status, HttpEntity(ContentTypes.\`application/json\`, body))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.time.Instant

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Calendar(id: String, visibility: String, generation: Int)
final case class Event(id: String, revision: Int, rrule: String)
final case class Override(event_id: String, start: String, revision: Int)
final case class Instance(occurrence_id: String, event_id: String, start: String, revision: Int)

class CalendarStore {
  def getCalendar(id: String): Option[Calendar] = None
  def isMember(id: String, tenant: String): Boolean = false
  def listEvents(id: String): List[Event] = Nil
  def listOverrides(id: String): Map[String, Override] = Map.empty
}

class ExpansionCache {
  def getSlice(id: String, window: String, generation: Int): Option[List[Instance]] = None
  def putSlice(id: String, window: String, generation: Int, instances: List[Instance]): Unit = ()
}

object Expander {
  /** Start instants (ISO-8601) of the event's RRULE instances inside the window. */
  def expand(event: Event, fromMs: Long, toMs: Long): List[String] =
    throw new UnsupportedOperationException("expansion lives in the expansion worker")
}

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("calendar")
  implicit val instanceFormat: RootJsonFormat[Instance] = jsonFormat4(Instance)

  val MaxRangeDays = 90
  val MaxRange = MaxRangeDays.toLong * 24 * 60 * 60 * 1000
  val PrivateVisibility = "private"

  val store = new CalendarStore
  val cache = new ExpansionCache

  def parseWindow(fromRaw: Option[String], toRaw: Option[String]): Either[String, (Long, Long)] = {
    (fromRaw, toRaw) match {
      case (Some(from), Some(to)) =>
        try {
          val fromMs = Instant.parse(from).toEpochMilli
          val toMs = Instant.parse(to).toEpochMilli
          if (toMs <= fromMs) Left("to must be after from")
          else if (toMs - fromMs > MaxRange) Left("range exceeds 90 days")
          else Right((fromMs, toMs))
        } catch {
          case _: Exception => Left("from and to must be ISO-8601")
        }
      case _ => Left("from and to are required")
    }
  }

  def withinWindow(startIso: String, fromMs: Long, toMs: Long): Boolean = {
    val at = Instant.parse(startIso).toEpochMilli
    at >= fromMs && at < toMs
  }

  def readEvents(id: String, tenant: String, fromRaw: Option[String], toRaw: Option[String]): (StatusCode, String) = {
    store.getCalendar(id) match {
      case None => (StatusCodes.NotFound, """{"error":"unknown calendar"}""")
      case Some(calendar) =>
        if (calendar.visibility == PrivateVisibility && !store.isMember(id, tenant)) {
          (StatusCodes.Forbidden, """{"error":"not a member of this calendar"}""")
        } else parseWindow(fromRaw, toRaw) match {
          case Left(reason) => (StatusCodes.BadRequest, s"""{"error":"$reason"}""")
          case Right((fromMs, toMs)) =>
            val generation = calendar.generation
            val window = fromRaw.get + "/" + toRaw.get
            val expansion = cache.getSlice(id, window, generation).getOrElse {
              val built = scala.collection.mutable.ArrayBuffer.empty[Instance]
              store.listEvents(id).foreach { event =>
                val eventId = event.id
                Expander.expand(event, fromMs, toMs).foreach { startIso =>
                  built += Instance(s"$eventId:$startIso", eventId, startIso, event.revision)
                }
              }
              cache.putSlice(id, window, generation, built.toList)
              built.toList
            }
            val overrides = store.listOverrides(id)
            val kept = expansion.filterNot(instance => overrides.contains(instance.occurrence_id))
            val overlaid = overrides.collect {
              case (oid, exception) if withinWindow(exception.start, fromMs, toMs) =>
                Instance(oid, exception.event_id, exception.start, exception.revision)
            }
            val events = (kept ++ overlaid).sortBy(_.start)
            system.log.info(s"read calendar=$id generation=$generation events=\${events.size}")
            (StatusCodes.OK, s"""{"calendar_id":"$id","events":\${events.toJson.compactPrint}}""")
        }
    }
  }

  val route: Route =
    path("v1" / "calendars" / Segment / "events") { id =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          parameters("from".?, "to".?) { (fromOpt, toOpt) =>
            val (status, body) = readEvents(id, tenantOpt.getOrElse(""), fromOpt, toOpt)
            complete(status, HttpEntity(ContentTypes.\`application/json\`, body))
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <ctime>
#include <iostream>
#include <map>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kDefaultWindowDays = 365;
constexpr long long kDefaultWindowSeconds = static_cast<long long>(kDefaultWindowDays) * 24 * 3600;

struct Calendar {
  std::string id;
  std::string visibility;
  int generation = 0;
};

struct Event {
  std::string id;
  int revision = 0;
  std::string rrule;
};

struct Instance {
  std::string occurrence_id;
  std::string event_id;
  std::string start;
  int revision = 0;
};

struct Override {
  std::string event_id;
  std::string start;
  int revision = 0;
};

struct CalendarStore {
  std::optional<Calendar> getCalendar(const std::string& id);
  bool isMember(const std::string& calendarId, const std::string& tenant);
  std::vector<Event> listEvents(const std::string& calendarId);
  std::map<std::string, Override> listOverrides(const std::string& calendarId);
};

struct ExpansionCache {
  std::optional<std::vector<Instance>> getSlice(const std::string& calendarId, const std::string& window, int generation);
  void putSlice(const std::string& calendarId, const std::string& window, int generation,
                const std::vector<Instance>& instances);
};

CalendarStore store;
ExpansionCache cache;

// Seconds since the epoch for an ISO-8601 instant; 0 when the string does not parse.
long long epochSeconds(const std::string& iso);

// Start instants (ISO-8601) of the event's RRULE instances inside the window.
std::vector<std::string> expand(const Event& event, long long fromSeconds, long long toSeconds);

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/calendars/([^/]+)/events)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft expands a year when the range is missing and silently clamps a wider one,
    // returns the raw RRULE with no per-occurrence id, lists overrides beside the instances they
    // replace, and never asks whether the caller may read this calendar. Review all four.
    const std::string id = req.matches[1];
    const auto calendar = store.getCalendar(id);
    if (!calendar) {
      res.status = 404;
      res.set_content(R"({"error":"unknown calendar"})", "application/json");
      return;
    }

    const auto fromRaw = req.get_param_value("from");
    const auto toRaw = req.get_param_value("to");
    long long fromSeconds = fromRaw.empty() ? static_cast<long long>(std::time(nullptr)) : epochSeconds(fromRaw);
    long long toSeconds = toRaw.empty() ? fromSeconds + kDefaultWindowSeconds : epochSeconds(toRaw);
    if (toSeconds <= fromSeconds) std::swap(fromSeconds, toSeconds);
    if (toSeconds - fromSeconds > kDefaultWindowSeconds) toSeconds = fromSeconds + kDefaultWindowSeconds;

    json events = json::array();
    for (const auto& event : store.listEvents(id)) {
      for (const auto& startIso : expand(event, fromSeconds, toSeconds)) {
        events.push_back({{"event_id", event.id}, {"rrule", event.rrule}, {"start", startIso}});
      }
    }
    for (const auto& [oid, override] : store.listOverrides(id)) {
      events.push_back({{"occurrence_id", oid}, {"event_id", override.event_id}, {"start", override.start}});
    }
    std::cerr << "read calendar=" << id << " events=" << events.size() << "\\n";
    res.status = 200;
    res.set_content(json{{"calendar_id", id}, {"events", events}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <map>
#include <optional>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kMaxRangeDays = 90;
constexpr long long kMaxRangeSeconds = static_cast<long long>(kMaxRangeDays) * 24 * 3600;
const std::string kPrivateVisibility = "private";

struct Calendar {
  std::string id;
  std::string visibility;
  int generation = 0;
};

struct Event {
  std::string id;
  int revision = 0;
  std::string rrule;
};

struct Instance {
  std::string occurrence_id;
  std::string event_id;
  std::string start;
  int revision = 0;
};

struct Override {
  std::string event_id;
  std::string start;
  int revision = 0;
};

struct CalendarStore {
  std::optional<Calendar> getCalendar(const std::string& id);
  bool isMember(const std::string& calendarId, const std::string& tenant);
  std::vector<Event> listEvents(const std::string& calendarId);
  std::map<std::string, Override> listOverrides(const std::string& calendarId);
};

struct ExpansionCache {
  std::optional<std::vector<Instance>> getSlice(const std::string& calendarId, const std::string& window, int generation);
  void putSlice(const std::string& calendarId, const std::string& window, int generation,
                const std::vector<Instance>& instances);
};

CalendarStore store;
ExpansionCache cache;

// Seconds since the epoch for an ISO-8601 instant; 0 when the string does not parse.
long long epochSeconds(const std::string& iso);

// Start instants (ISO-8601) of the event's RRULE instances inside the window.
std::vector<std::string> expand(const Event& event, long long fromSeconds, long long toSeconds);

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/calendars/([^/]+)/events)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string id = req.matches[1];
    const auto calendar = store.getCalendar(id);
    if (!calendar) {
      res.status = 404;
      res.set_content(R"({"error":"unknown calendar"})", "application/json");
      return;
    }
    const std::string tenant = req.get_header_value("X-Tenant-Id");
    if (calendar->visibility == kPrivateVisibility && !store.isMember(id, tenant)) {
      res.status = 403;
      res.set_content(R"({"error":"not a member of this calendar"})", "application/json");
      return;
    }

    const auto fromRaw = req.get_param_value("from");
    const auto toRaw = req.get_param_value("to");
    const long long fromSeconds = epochSeconds(fromRaw);
    const long long toSeconds = epochSeconds(toRaw);
    if (fromRaw.empty() || toRaw.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"from and to are required"})", "application/json");
      return;
    }
    if (toSeconds <= fromSeconds) {
      res.status = 400;
      res.set_content(R"({"error":"to must be after from"})", "application/json");
      return;
    }
    if (toSeconds - fromSeconds > kMaxRangeSeconds) {
      res.status = 400;
      res.set_content(R"({"error":"range exceeds 90 days"})", "application/json");
      return;
    }

    const std::string window = fromRaw + "/" + toRaw;
    auto expansion = cache.getSlice(id, window, calendar->generation);
    if (!expansion) {
      std::vector<Instance> built;
      for (const auto& event : store.listEvents(id)) {
        for (const auto& startIso : expand(event, fromSeconds, toSeconds)) {
          built.push_back(Instance{event.id + ":" + startIso, event.id, startIso, event.revision});
        }
      }
      cache.putSlice(id, window, calendar->generation, built);
      expansion = built;
    }

    const auto overrides = store.listOverrides(id);
    std::vector<Instance> events;
    for (const auto& instance : *expansion) {
      if (overrides.count(instance.occurrence_id) > 0) continue;  // emitted once, in place, below
      events.push_back(instance);
    }
    for (const auto& [oid, override] : overrides) {
      const long long at = epochSeconds(override.start);
      if (at < fromSeconds || at >= toSeconds) continue;
      events.push_back(Instance{oid, override.event_id, override.start, override.revision});
    }
    std::sort(events.begin(), events.end(), [](const Instance& a, const Instance& b) { return a.start < b.start; });

    json body;
    body["calendar_id"] = id;
    body["events"] = json::array();
    for (const auto& instance : events) {
      body["events"].push_back({{"occurrence_id", instance.occurrence_id},
                                {"event_id", instance.event_id},
                                {"start", instance.start},
                                {"revision", instance.revision}});
    }
    std::cerr << "read calendar=" << id << " generation=" << calendar->generation << " events=" << events.size()
              << "\\n";
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Order the guards before the work: calendar (404) → membership (403) → window (400), and only then the cache and the expander. Every rejection here is free, while every expansion is paid for in occurrences — a request that cannot be authorized or bounded must never reach it.',
    'The occurrence id is the dedupe key, and it must be built from the expanded start, not from the event\'s DTSTART: `"<event_id>:<start_iso>"`. The store keys its overrides by that same string, so the table can filter the expansion and supply the replacement.',
    "Apply the overrides in place, after the expansion: skip any instance whose occurrence id is in the table and append the override once with its own revision — never both. The cached slice stays the raw expansion, stamped with the calendar's `generation`, so an override bump replaces the slice instead of being overlaid on a stale one.",
  ],
  debrief: `The interviewer is asking about the read path, which is also the most expensive path in a calendar service. The draft looks calm because the demo asks for one week from a public calendar. Four contracts are being checked: the window cap (a range is a budget, and the draft's "default to a year and clamp the rest" spends it silently on an infinite rule), server-side expansion with stable occurrence ids (a client cannot dedupe what the server never names, so every refresh re-books the same slot), the overlay (an override listed beside its original shows the meeting twice), and membership (a private calendar is not a URL secret; the 404 alone is not an authorization check). Real calendars go further: per-calendar expansion budgets, ETag/If-None-Match on the range so an unchanged week is a 304, windows that page the expansion, and a background worker that precomputes popular ranges so the read path usually answers straight from the cache.`,
};
