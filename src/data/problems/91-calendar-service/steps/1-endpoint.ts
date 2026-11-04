import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/events: a rule that ends, instants with an offset',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/events\` with body \`{"calendar_id", "title", "rrule",
"dtstart", "dtend", "attendees"}\`: it reads the tenant from \`X-Tenant-Id\` (**401** when missing),
splits the rule with \`rule_parts\`, reads \`dtstart\` and \`dtend\` with \`parse_instant\` (**422**
\`invalid_instant\`), stores the event at revision 1 with \`store.put_event\` and the rule as
\`format_rule\` writes it, calls step 2's \`bump_generation\` and answers **201** with the event. It
serves the demo and hides four flaws.

**Failure mode the checks target.** A rule that never ends, a rule part the expander would quietly
ignore, a wall-clock time without an offset, and a meeting that ends before it starts.

Rules, in this order, before anything is stored:

- Every part's key is in \`SUPPORTED_PARTS\` with a non-empty value, and \`FREQ\` is in \`FREQUENCIES\`
  (DAILY, WEEKLY): otherwise **422** \`unsupported_rrule_part\`. An empty rule is one occurrence.
- The rule ends: it has \`UNTIL\` or a \`COUNT\` from 1 to \`MAX_COUNT\` (5000), and an \`INTERVAL\` is a
  positive integer: otherwise **422** \`rule_not_terminating\`.
- \`dtstart\`, \`dtend\` and \`UNTIL\` carry \`Z\` or an offset: otherwise **422** \`invalid_instant\`.
  Stored instants are UTC.
- \`dtend\` is after \`dtstart\`: otherwise **422** \`invalid_range\`.`,
  sequence: {
    participants: ['Calendar client', 'Calendar API', 'Redis'],
    messages: [
      {from: 'Calendar client', to: 'Calendar API', label: 'POST /v1/events · X-Tenant-Id', kind: 'sync'},
      {
        from: 'Calendar API',
        to: 'Calendar API',
        label: 'parts known · rule ends · offsets · dtend > dtstart',
        kind: 'sync',
      },
      {from: 'Calendar API', to: 'Redis', label: 'put_event · INCR gen:{cal}', kind: 'async'},
      {from: 'Calendar API', to: 'Calendar client', label: '201 event · 422 with the reason', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/events',
      detail:
        'A weekly rule with a count answers 201 with the event at revision 1, stored in `event:{id}`, indexed under the calendar, and `gen:{calendar}` bumped.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/events["']/, /bump_generation\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/events['"]/, /bumpGeneration\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/events"/, /bumpGeneration\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"events"\s*\)/, /\bpost\s*\{/, /bumpGeneration\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/events"/, /bumpGeneration\(/]},
      },
    },
    {
      id: 'unknown-parts',
      title: 'Refuses rule parts the expander does not know',
      detail:
        '`BYSECOND=30`, `BYDAY=MO,WE`, `FREQ=SECONDLY` and a part without a value are **422** `unsupported_rrule_part`, and nothing is stored. The starter stores the rule with the unknown parts trimmed, so the meeting repeats on days nobody chose.',
      match: {
        python: {all: [/unsupported_rrule_part/, /not in SUPPORTED_PARTS/, /not in FREQUENCIES/]},
        typescript: {all: [/unsupported_rrule_part/, /SUPPORTED_PARTS\.includes\(/, /FREQUENCIES/]},
        go: {all: [/unsupported_rrule_part/, /rrule\.SupportedParts/, /rrule\.Frequencies/]},
        scala: {all: [/unsupported_rrule_part/, /SupportedParts\.contains/, /Frequencies\.contains/]},
        cpp: {all: [/unsupported_rrule_part/, /kSupportedParts/, /kFrequencies/]},
      },
    },
    {
      id: 'rule-terminates',
      title: 'Refuses a rule that never ends',
      detail:
        'A rule without `UNTIL` or `COUNT`, a `COUNT` of 0 or 6000 and `INTERVAL=0` are **422** `rule_not_terminating`, and nothing is stored; `COUNT=5000` and an `UNTIL` are accepted. The starter stores `FREQ=DAILY`, which every unbounded reader of the rule walks forever.',
      match: {
        python: {all: [/rule_not_terminating/, /MAX_COUNT/]},
        typescript: {all: [/rule_not_terminating/, /MAX_COUNT/]},
        go: {all: [/rule_not_terminating/, /rrule\.MaxCount/]},
        scala: {all: [/rule_not_terminating/, /Rrule\.MaxCount/]},
        cpp: {all: [/rule_not_terminating/, /kMaxCount/]},
      },
    },
    {
      id: 'tz-aware',
      title: 'Refuses instants without an offset',
      detail:
        'A `dtstart`, `dtend` or `UNTIL` without `Z` or an offset is **422** `invalid_instant`; `10:00+01:00` is stored as `09:00Z`. The starter appends `Z` to a time without an offset, which moves a Berlin meeting by an hour for every attendee.',
      match: {
        python: {all: [/parse_instant\(\s*parts\[["']UNTIL["']\]\s*\)/], none: [/\+\s*["']Z["']/]},
        typescript: {all: [/parseInstant\(\s*parts\.UNTIL\s*\)/], none: [/\+\s*['"]Z['"]/]},
        go: {all: [/rrule\.ParseInstant\(\s*parts\["UNTIL"\]\s*\)/], none: [/\+\s*"Z"/]},
        scala: {all: [/parts\.get\("UNTIL"\)[^\n]*parseInstant/], none: [/\+\s*"Z"/]},
        cpp: {all: [/ParseInstant\(\s*parts\.at\("UNTIL"\)\s*\)/], none: [/\+\s*"Z"/]},
      },
    },
    {
      id: 'range-order',
      title: 'Refuses an event that ends before it starts',
      detail:
        'A `dtend` equal to or before `dtstart` is **422** `invalid_range`, and nothing is stored. The starter stores it, and every occurrence the expander derives has a negative length.',
      match: {
        python: {all: [/invalid_range/, /\bend\s*<=\s*start\b|\bstart\s*>=\s*end\b/]},
        typescript: {all: [/invalid_range/, /\bend\s*<=\s*start\b|\bstart\s*>=\s*end\b/]},
        go: {all: [/invalid_range/, /\bend\s*<=\s*start\b|\bstart\s*>=\s*end\b/]},
        scala: {all: [/invalid_range/, /\bend\s*<=\s*start\b|\bstart\s*>=\s*end\b/]},
        cpp: {all: [/invalid_range/, /\*?end\s*<=\s*\*?start\b|\*?start\s*>=\s*\*?end\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from calendard.rrule import format_instant, format_rule, parse_instant, rule_parts
from calendard.store import new_id, store
from state import bump_generation  # step 2: retires the calendar's cached slices

app = FastAPI()
log = logging.getLogger("calendar")


class EventRequest(BaseModel):
    calendar_id: str
    title: str
    rrule: str = ""
    dtstart: str
    dtend: str
    attendees: list[str] = []


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status)


def assume_utc(text: str) -> str:
    """An instant written without an offset is read as UTC."""
    if text.endswith("Z") or text[-6:-5] in ("+", "-"):
        return text
    return text + "Z"


@app.post("/v1/events")
def create_event(body: EventRequest, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("X-Tenant-Id")
    if not tenant:
        return _error(401, "missing_tenant")
    parts = rule_parts(body.rrule)
    start = parse_instant(assume_utc(body.dtstart))
    end = parse_instant(assume_utc(body.dtend))
    if start is None or end is None:
        return _error(422, "invalid_instant")
    event = {
        "event_id": new_id(),
        "calendar_id": body.calendar_id,
        "tenant": tenant,
        "title": body.title,
        "rrule": format_rule(parts),
        "dtstart": format_instant(start),
        "dtend": format_instant(end),
        "revision": 1,
        "attendees": body.attendees,
    }
    store.put_event(event)
    bump_generation(body.calendar_id)
    log.info("event=%s calendar=%s tenant=%s", event["event_id"], body.calendar_id, tenant)
    return JSONResponse(event, status_code=201)
`,
      solution: `import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from calendard.rrule import FREQUENCIES, MAX_COUNT, SUPPORTED_PARTS, format_instant, format_rule, parse_instant, rule_parts
from calendard.store import new_id, store
from state import bump_generation  # step 2: retires the calendar's cached slices

app = FastAPI()
log = logging.getLogger("calendar")


class EventRequest(BaseModel):
    calendar_id: str
    title: str
    rrule: str = ""
    dtstart: str
    dtend: str
    attendees: list[str] = []


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status)


def rule_error(parts: dict[str, str]) -> str | None:
    """Why the rule cannot be stored, or None. Refused, never trimmed: the stored rule is the rule the user wrote."""
    for key, value in parts.items():
        if key not in SUPPORTED_PARTS or value == "":
            return "unsupported_rrule_part"
    if not parts:
        return None  # one occurrence
    if parts.get("FREQ") not in FREQUENCIES:
        return "unsupported_rrule_part"
    # The expander walks the rule until it ends: it must end, and each step must move forward.
    interval = parts.get("INTERVAL", "1")
    if not interval.isdigit() or int(interval) < 1:
        return "rule_not_terminating"
    count = parts.get("COUNT")
    if count is None and "UNTIL" not in parts:
        return "rule_not_terminating"
    if count is not None and (not count.isdigit() or not 1 <= int(count) <= MAX_COUNT):
        return "rule_not_terminating"
    return None


@app.post("/v1/events")
def create_event(body: EventRequest, request: Request) -> JSONResponse:
    tenant = request.headers.get("X-Tenant-Id")
    if not tenant:
        return _error(401, "missing_tenant")
    parts = rule_parts(body.rrule)
    problem = rule_error(parts)
    if problem is not None:
        return _error(422, problem)
    # An instant without an offset names no instant: refuse it rather than guess a zone.
    start = parse_instant(body.dtstart)
    end = parse_instant(body.dtend)
    if start is None or end is None or ("UNTIL" in parts and parse_instant(parts["UNTIL"]) is None):
        return _error(422, "invalid_instant")
    if end <= start:
        return _error(422, "invalid_range")
    event = {
        "event_id": new_id(),
        "calendar_id": body.calendar_id,
        "tenant": tenant,
        "title": body.title,
        "rrule": format_rule(parts),
        "dtstart": format_instant(start),
        "dtend": format_instant(end),
        "revision": 1,
        "attendees": body.attendees,
    }
    store.put_event(event)
    bump_generation(body.calendar_id)
    log.info("event=%s calendar=%s tenant=%s", event["event_id"], body.calendar_id, tenant)
    return JSONResponse(event, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {formatInstant, formatRule, parseInstant, ruleParts} from 'calendard/rrule';
import {type Event, newId, store} from 'calendard/store';
import {bumpGeneration} from './state'; // step 2: retires the calendar's cached slices

export const app = Fastify();

interface EventBody {
  calendar_id: string;
  title: string;
  rrule?: string;
  dtstart: string;
  dtend: string;
  attendees?: string[];
}

/** An instant written without an offset is read as UTC. */
function assumeUtc(text: string): string {
  if (/(Z|[+-]\\d{2}:\\d{2})$/.test(text)) return text;
  return text + 'Z';
}

app.post('/v1/events', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing_tenant'});
  const body = request.body as EventBody;
  const parts = ruleParts(body.rrule ?? '');
  const start = parseInstant(assumeUtc(body.dtstart));
  const end = parseInstant(assumeUtc(body.dtend));
  if (start === null || end === null) return reply.code(422).send({error: 'invalid_instant'});
  const event: Event = {
    event_id: newId(),
    calendar_id: body.calendar_id,
    tenant,
    title: body.title,
    rrule: formatRule(parts),
    dtstart: formatInstant(start),
    dtend: formatInstant(end),
    revision: 1,
    attendees: body.attendees ?? [],
  };
  await store.putEvent(event);
  await bumpGeneration(body.calendar_id);
  app.log.info({event: event.event_id, calendar: body.calendar_id, tenant}, 'event created');
  return reply.code(201).send(event);
});
`,
      solution: `import Fastify from 'fastify';

import {FREQUENCIES, MAX_COUNT, SUPPORTED_PARTS, formatInstant, formatRule, parseInstant, ruleParts} from 'calendard/rrule';
import {type Event, newId, store} from 'calendard/store';
import {bumpGeneration} from './state'; // step 2: retires the calendar's cached slices

export const app = Fastify();

interface EventBody {
  calendar_id: string;
  title: string;
  rrule?: string;
  dtstart: string;
  dtend: string;
  attendees?: string[];
}

/** Why the rule cannot be stored, or null. Refused, never trimmed: the stored rule is the rule the user wrote. */
function ruleError(parts: Record<string, string>): string | null {
  for (const [key, value] of Object.entries(parts)) {
    if (!SUPPORTED_PARTS.includes(key) || value === '') return 'unsupported_rrule_part';
  }
  if (Object.keys(parts).length === 0) return null; // one occurrence
  if (!(parts.FREQ in FREQUENCIES)) return 'unsupported_rrule_part';
  // The expander walks the rule until it ends: it must end, and each step must move forward.
  const interval = parts.INTERVAL ?? '1';
  if (!/^\\d+$/.test(interval) || Number(interval) < 1) return 'rule_not_terminating';
  const count = parts.COUNT;
  if (count === undefined && parts.UNTIL === undefined) return 'rule_not_terminating';
  if (count !== undefined && (!/^\\d+$/.test(count) || Number(count) < 1 || Number(count) > MAX_COUNT)) return 'rule_not_terminating';
  return null;
}

app.post('/v1/events', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing_tenant'});
  const body = request.body as EventBody;
  const parts = ruleParts(body.rrule ?? '');
  const problem = ruleError(parts);
  if (problem !== null) return reply.code(422).send({error: problem});
  // An instant without an offset names no instant: refuse it rather than guess a zone.
  const start = parseInstant(body.dtstart);
  const end = parseInstant(body.dtend);
  if (start === null || end === null || (parts.UNTIL !== undefined && parseInstant(parts.UNTIL) === null)) {
    return reply.code(422).send({error: 'invalid_instant'});
  }
  if (end <= start) return reply.code(422).send({error: 'invalid_range'});
  const event: Event = {
    event_id: newId(),
    calendar_id: body.calendar_id,
    tenant,
    title: body.title,
    rrule: formatRule(parts),
    dtstart: formatInstant(start),
    dtend: formatInstant(end),
    revision: 1,
    attendees: body.attendees ?? [],
  };
  await store.putEvent(event);
  await bumpGeneration(body.calendar_id);
  app.log.info({event: event.event_id, calendar: body.calendar_id, tenant}, 'event created');
  return reply.code(201).send(event);
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"calendard/rrule"
	"calendard/store"
)

// Built in step 2 (state.go): retires the calendar's cached slices.
var bumpGeneration = func(ctx context.Context, calendarID string) (int64, error) {
	panic("not implemented")
}

type EventRequest struct {
	CalendarID string   \`json:"calendar_id"\`
	Title      string   \`json:"title"\`
	Rrule      string   \`json:"rrule"\`
	Dtstart    string   \`json:"dtstart"\`
	Dtend      string   \`json:"dtend"\`
	Attendees  []string \`json:"attendees"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

// assumeUTC reads an instant written without an offset as UTC.
func assumeUTC(text string) string {
	if strings.HasSuffix(text, "Z") || (len(text) > 6 && strings.ContainsAny(text[len(text)-6:len(text)-5], "+-")) {
		return text
	}
	return text + "Z"
}

func createEvent(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing_tenant"})
		return
	}
	var body EventRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	parts := rrule.RuleParts(body.Rrule)
	start, okStart := rrule.ParseInstant(assumeUTC(body.Dtstart))
	end, okEnd := rrule.ParseInstant(assumeUTC(body.Dtend))
	if !okStart || !okEnd {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "invalid_instant"})
		return
	}
	event := &store.Event{
		EventID: store.NewID(), CalendarID: body.CalendarID, Tenant: tenant, Title: body.Title, Rrule: rrule.FormatRule(parts),
		Dtstart: rrule.FormatInstant(start), Dtend: rrule.FormatInstant(end), Revision: 1, Attendees: append([]string{}, body.Attendees...),
	}
	if err := store.PutEvent(r.Context(), event); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	if _, err := bumpGeneration(r.Context(), body.CalendarID); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	log.Printf("event=%s calendar=%s tenant=%s", event.EventID, body.CalendarID, tenant)
	writeJSON(rw, http.StatusCreated, event)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/events", createEvent)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"calendard/rrule"
	"calendard/store"
)

// Built in step 2 (state.go): retires the calendar's cached slices.
var bumpGeneration = func(ctx context.Context, calendarID string) (int64, error) {
	panic("not implemented")
}

type EventRequest struct {
	CalendarID string   \`json:"calendar_id"\`
	Title      string   \`json:"title"\`
	Rrule      string   \`json:"rrule"\`
	Dtstart    string   \`json:"dtstart"\`
	Dtend      string   \`json:"dtend"\`
	Attendees  []string \`json:"attendees"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

// positive reads a positive integer; 0 for anything else.
func positive(text string) int {
	n, err := strconv.Atoi(text)
	if err != nil || n < 1 {
		return 0
	}
	return n
}

// ruleError says why the rule cannot be stored, or "". Refused, never trimmed: the stored rule is the
// rule the user wrote.
func ruleError(parts map[string]string) string {
	for key, value := range parts {
		known := false
		for _, supported := range rrule.SupportedParts {
			known = known || key == supported
		}
		if !known || value == "" {
			return "unsupported_rrule_part"
		}
	}
	if len(parts) == 0 {
		return "" // one occurrence
	}
	if _, ok := rrule.Frequencies[parts["FREQ"]]; !ok {
		return "unsupported_rrule_part"
	}
	// The expander walks the rule until it ends: it must end, and each step must move forward.
	if interval, ok := parts["INTERVAL"]; ok && positive(interval) == 0 {
		return "rule_not_terminating"
	}
	count, hasCount := parts["COUNT"]
	_, hasUntil := parts["UNTIL"]
	if !hasCount && !hasUntil {
		return "rule_not_terminating"
	}
	if hasCount && (positive(count) == 0 || positive(count) > rrule.MaxCount) {
		return "rule_not_terminating"
	}
	return ""
}

func createEvent(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing_tenant"})
		return
	}
	var body EventRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_json"})
		return
	}
	parts := rrule.RuleParts(body.Rrule)
	if problem := ruleError(parts); problem != "" {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": problem})
		return
	}
	// An instant without an offset names no instant: refuse it rather than guess a zone.
	start, okStart := rrule.ParseInstant(body.Dtstart)
	end, okEnd := rrule.ParseInstant(body.Dtend)
	okUntil := true
	if _, has := parts["UNTIL"]; has {
		_, okUntil = rrule.ParseInstant(parts["UNTIL"])
	}
	if !okStart || !okEnd || !okUntil {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "invalid_instant"})
		return
	}
	if end <= start {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": "invalid_range"})
		return
	}
	event := &store.Event{
		EventID: store.NewID(), CalendarID: body.CalendarID, Tenant: tenant, Title: body.Title, Rrule: rrule.FormatRule(parts),
		Dtstart: rrule.FormatInstant(start), Dtend: rrule.FormatInstant(end), Revision: 1, Attendees: append([]string{}, body.Attendees...),
	}
	if err := store.PutEvent(r.Context(), event); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	if _, err := bumpGeneration(r.Context(), body.CalendarID); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	log.Printf("event=%s calendar=%s tenant=%s", event.EventID, body.CalendarID, tenant)
	writeJSON(rw, http.StatusCreated, event)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/events", createEvent)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import calendard.{Event, Rrule, Store}

final case class EventRequest(
    calendar_id: String,
    title: String,
    rrule: Option[String],
    dtstart: String,
    dtend: String,
    attendees: Option[Seq[String]]
)

object CalendarApi {
  implicit val system: ActorSystem = ActorSystem("calendar")
  implicit val requestFormat: RootJsonFormat[EventRequest] = jsonFormat6(EventRequest)

  private def error(status: StatusCode, code: String): Route =
    complete(status, HttpEntity(ContentTypes.\`application/json\`, s"""{"error":"$code"}"""))

  /** An instant written without an offset is read as UTC. */
  def assumeUtc(text: String): String =
    if (text.endsWith("Z") || text.matches(".*[+-]\\\\d{2}:\\\\d{2}$")) text else text + "Z"

  val route: Route =
    path("v1" / "events") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[EventRequest]) { body =>
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            val tenant = tenantOpt.getOrElse("")
            if (tenant.isEmpty) error(StatusCodes.Unauthorized, "missing_tenant")
            else {
              val parts = Rrule.ruleParts(body.rrule.getOrElse(""))
              (Rrule.parseInstant(assumeUtc(body.dtstart)), Rrule.parseInstant(assumeUtc(body.dtend))) match {
                case (Some(start), Some(end)) =>
                  val event = Event(
                    Store.newId(),
                    body.calendar_id,
                    tenant,
                    body.title,
                    Rrule.formatRule(parts),
                    Rrule.formatInstant(start),
                    Rrule.formatInstant(end),
                    1L,
                    body.attendees.getOrElse(Seq.empty)
                  )
                  Store.putEvent(event)
                  ExpansionCache.bumpGeneration(body.calendar_id) // step 2
                  system.log.info(s"event=\${event.event_id} calendar=\${body.calendar_id} tenant=$tenant")
                  complete(StatusCodes.Created, event)
                case _ => error(StatusCodes.UnprocessableEntity, "invalid_instant")
              }
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import calendard.{Event, Rrule, Store}

final case class EventRequest(
    calendar_id: String,
    title: String,
    rrule: Option[String],
    dtstart: String,
    dtend: String,
    attendees: Option[Seq[String]]
)

object CalendarApi {
  implicit val system: ActorSystem = ActorSystem("calendar")
  implicit val requestFormat: RootJsonFormat[EventRequest] = jsonFormat6(EventRequest)

  private def error(status: StatusCode, code: String): Route =
    complete(status, HttpEntity(ContentTypes.\`application/json\`, s"""{"error":"$code"}"""))

  private def positive(text: String): Long = text.toLongOption.filter(_ >= 1).getOrElse(0L)

  /** Why the rule cannot be stored, or None. Refused, never trimmed: the stored rule is the rule the user wrote. */
  def ruleError(parts: Map[String, String]): Option[String] =
    if (parts.exists { case (key, value) => !Rrule.SupportedParts.contains(key) || value.isEmpty }) Some("unsupported_rrule_part")
    else if (parts.isEmpty) None // one occurrence
    else if (!Rrule.Frequencies.contains(parts.getOrElse("FREQ", ""))) Some("unsupported_rrule_part")
    // The expander walks the rule until it ends: it must end, and each step must move forward.
    else if (parts.get("INTERVAL").exists(positive(_) == 0)) Some("rule_not_terminating")
    else if (!parts.contains("COUNT") && !parts.contains("UNTIL")) Some("rule_not_terminating")
    else if (parts.get("COUNT").exists(c => positive(c) == 0 || positive(c) > Rrule.MaxCount)) Some("rule_not_terminating")
    else None

  val route: Route =
    path("v1" / "events") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[EventRequest]) { body =>
            val tenant = tenantOpt.getOrElse("")
            if (tenant.isEmpty) error(StatusCodes.Unauthorized, "missing_tenant")
            else {
              val parts = Rrule.ruleParts(body.rrule.getOrElse(""))
              // An instant without an offset names no instant: refuse it rather than guess a zone.
              val untilKnown = parts.get("UNTIL").forall(until => Rrule.parseInstant(until).isDefined)
              ruleError(parts) match {
                case Some(problem) => error(StatusCodes.UnprocessableEntity, problem)
                case None =>
                  (Rrule.parseInstant(body.dtstart), Rrule.parseInstant(body.dtend)) match {
                    case (Some(start), Some(end)) if untilKnown =>
                      if (end <= start) error(StatusCodes.UnprocessableEntity, "invalid_range")
                      else {
                        val event = Event(
                          Store.newId(),
                          body.calendar_id,
                          tenant,
                          body.title,
                          Rrule.formatRule(parts),
                          Rrule.formatInstant(start),
                          Rrule.formatInstant(end),
                          1L,
                          body.attendees.getOrElse(Seq.empty)
                        )
                        Store.putEvent(event)
                        ExpansionCache.bumpGeneration(body.calendar_id) // step 2
                        system.log.info(s"event=\${event.event_id} calendar=\${body.calendar_id} tenant=$tenant")
                        complete(StatusCodes.Created, event)
                      }
                    case _ => error(StatusCodes.UnprocessableEntity, "invalid_instant")
                  }
              }
            }
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

#include <iostream>
#include <string>
#include <vector>

#include "calendard/rrule.h"
#include "calendard/store.h"

using json = nlohmann::json;

// Built in step 2 (state.cpp): retires the calendar's cached slices.
long long bumpGeneration(const std::string& calendar_id);

static void fail(httplib::Response& res, int status, const std::string& code) {
  res.status = status;
  res.set_content(json{{"error", code}}.dump(), "application/json");
}

// An instant written without an offset is read as UTC.
static std::string assumeUtc(const std::string& text) {
  if (!text.empty() && text.back() == 'Z') return text;
  if (text.size() > 6 && (text[text.size() - 6] == '+' || text[text.size() - 6] == '-')) return text;
  return text + "Z";
}

void createEvent(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "missing_tenant");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return fail(res, 400, "invalid_json");
  const std::string calendar_id = body.value("calendar_id", "");
  const auto parts = calendard::rrule::RuleParts(body.value("rrule", ""));
  const auto start = calendard::rrule::ParseInstant(assumeUtc(body.value("dtstart", "")));
  const auto end = calendard::rrule::ParseInstant(assumeUtc(body.value("dtend", "")));
  if (!start || !end) return fail(res, 422, "invalid_instant");
  const calendard::Event event{calendard::NewId(),
                               calendar_id,
                               tenant,
                               body.value("title", ""),
                               calendard::rrule::FormatRule(parts),
                               calendard::rrule::FormatInstant(*start),
                               calendard::rrule::FormatInstant(*end),
                               1,
                               body.value("attendees", std::vector<std::string>{})};
  calendard::store::PutEvent(event);
  bumpGeneration(calendar_id);
  std::clog << "event=" << event.event_id << " calendar=" << calendar_id << " tenant=" << tenant << "\\n";
  res.status = 201;
  res.set_content(json(event).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/events", createEvent);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <iostream>
#include <map>
#include <string>
#include <vector>

#include "calendard/rrule.h"
#include "calendard/store.h"

using json = nlohmann::json;

// Built in step 2 (state.cpp): retires the calendar's cached slices.
long long bumpGeneration(const std::string& calendar_id);

static void fail(httplib::Response& res, int status, const std::string& code) {
  res.status = status;
  res.set_content(json{{"error", code}}.dump(), "application/json");
}

// A positive integer; 0 for anything else.
static long long positive(const std::string& text) {
  if (text.empty() || text.size() > 9 || !std::all_of(text.begin(), text.end(), [](char c) { return c >= '0' && c <= '9'; })) return 0;
  return std::stoll(text);
}

// Why the rule cannot be stored, or "". Refused, never trimmed: the stored rule is the rule the user wrote.
static std::string ruleError(const std::map<std::string, std::string>& parts) {
  const auto& supported = calendard::rrule::kSupportedParts;
  for (const auto& [key, value] : parts) {
    if (std::find(supported.begin(), supported.end(), key) == supported.end() || value.empty()) return "unsupported_rrule_part";
  }
  if (parts.empty()) return "";  // one occurrence
  if (!parts.count("FREQ") || !calendard::rrule::kFrequencies.count(parts.at("FREQ"))) return "unsupported_rrule_part";
  // The expander walks the rule until it ends: it must end, and each step must move forward.
  if (parts.count("INTERVAL") && positive(parts.at("INTERVAL")) == 0) return "rule_not_terminating";
  if (!parts.count("COUNT") && !parts.count("UNTIL")) return "rule_not_terminating";
  if (parts.count("COUNT")) {
    const long long count = positive(parts.at("COUNT"));
    if (count == 0 || count > calendard::rrule::kMaxCount) return "rule_not_terminating";
  }
  return "";
}

void createEvent(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "missing_tenant");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return fail(res, 400, "invalid_json");
  const std::string calendar_id = body.value("calendar_id", "");
  const auto parts = calendard::rrule::RuleParts(body.value("rrule", ""));
  const std::string problem = ruleError(parts);
  if (!problem.empty()) return fail(res, 422, problem);
  // An instant without an offset names no instant: refuse it rather than guess a zone.
  const auto start = calendard::rrule::ParseInstant(body.value("dtstart", ""));
  const auto end = calendard::rrule::ParseInstant(body.value("dtend", ""));
  const bool until_ok = !parts.count("UNTIL") || calendard::rrule::ParseInstant(parts.at("UNTIL")).has_value();
  if (!start || !end || !until_ok) return fail(res, 422, "invalid_instant");
  if (*end <= *start) return fail(res, 422, "invalid_range");
  const calendard::Event event{calendard::NewId(),
                               calendar_id,
                               tenant,
                               body.value("title", ""),
                               calendard::rrule::FormatRule(parts),
                               calendard::rrule::FormatInstant(*start),
                               calendard::rrule::FormatInstant(*end),
                               1,
                               body.value("attendees", std::vector<std::string>{})};
  calendard::store::PutEvent(event);
  bumpGeneration(calendar_id);
  std::clog << "event=" << event.event_id << " calendar=" << calendar_id << " tenant=" << tenant << "\\n";
  res.status = 201;
  res.set_content(json(event).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/events", createEvent);
}
`,
    },
  },
  harness: {
    python: `H = {"X-Tenant-Id": "t1"}
# A weekly 30-minute standup, four times from Monday 2 March 2026.
BODY = {
    "calendar_id": "c1",
    "title": "Standup",
    "rrule": "FREQ=WEEKLY;COUNT=4",
    "dtstart": "2026-03-02T09:00:00Z",
    "dtend": "2026-03-02T09:30:00Z",
    "attendees": ["ana@example.com", "bo@example.com"],
}


async def _post(ctx, m, **changes):
    async with ctx.client(m.app) as c:
        return await c.post("/v1/events", json={**BODY, **changes}, headers=H)


def _error(r):
    try:
        return r.json().get("error")
    except ValueError:
        return None


def _nothing_stored(ctx, what):
    keys = ctx.redis.keys("event:*")
    assert keys == [], f"{what} was stored anyway: Redis holds {keys}"


async def _refused(ctx, m, status, code, what, **changes):
    r = await _post(ctx, m, **changes)
    assert r.status_code == status and _error(r) == code, f"{what} answered {r.status_code} {r.text}, expected {status} {code}"
    _nothing_stored(ctx, what)


async def check_route(ctx):
    m = ctx.load("api")
    r = await _post(ctx, m)
    assert r.status_code == 201, f"POST /v1/events for a weekly rule with COUNT=4 answered {r.status_code}: {r.text}"
    event = r.json()
    assert event.get("event_id") and event.get("revision") == 1, f"the answer must carry event_id and revision 1: {event}"
    stored = ctx.redis.hgetall(f"event:{event['event_id']}")
    assert stored.get("rrule") == "FREQ=WEEKLY;COUNT=4" and stored.get("calendar_id") == "c1", f"event:{event['event_id']} holds {stored}"
    assert ctx.redis.sismember("calendar:c1:events", event["event_id"]), "the event is not indexed in calendar:c1:events"
    assert ctx.redis.get("gen:c1") == "1", f"gen:c1 is {ctx.redis.get('gen:c1')!r} after the create: bump_generation retires the calendar's cached weeks"


async def check_unknown_parts(ctx):
    m = ctx.load("api")
    for rule in ("FREQ=WEEKLY;COUNT=4;BYSECOND=30", "FREQ=WEEKLY;COUNT=4;BYDAY=MO,WE", "FREQ=SECONDLY;COUNT=10", "FREQ=WEEKLY;COUNT"):
        await _refused(ctx, m, 422, "unsupported_rrule_part", f"the rule {rule!r}", rrule=rule)
    r = await _post(ctx, m, rrule="")
    assert r.status_code == 201, f"an empty rule (one occurrence) answered {r.status_code}: {r.text}"


async def check_rule_terminates(ctx):
    m = ctx.load("api")
    for rule in ("FREQ=DAILY", "FREQ=DAILY;COUNT=6000", "FREQ=DAILY;COUNT=0", "FREQ=DAILY;INTERVAL=0;UNTIL=2026-06-01T00:00:00Z"):
        await _refused(ctx, m, 422, "rule_not_terminating", f"the rule {rule!r}", rrule=rule)
    for rule in ("FREQ=DAILY;UNTIL=2026-06-01T00:00:00Z", "FREQ=DAILY;INTERVAL=2;COUNT=5000"):
        r = await _post(ctx, m, rrule=rule)
        assert r.status_code == 201, f"the rule {rule!r} ends and answered {r.status_code}: {r.text}"


async def check_tz_aware(ctx):
    m = ctx.load("api")
    await _refused(ctx, m, 422, "invalid_instant", "a dtstart without an offset", dtstart="2026-03-02T09:00:00")
    await _refused(ctx, m, 422, "invalid_instant", "a dtend without an offset", dtend="2026-03-02T09:30:00")
    await _refused(ctx, m, 422, "invalid_instant", "an UNTIL without an offset", rrule="FREQ=DAILY;UNTIL=2026-06-01T00:00:00")
    r = await _post(ctx, m, dtstart="2026-03-02T10:00:00+01:00", dtend="2026-03-02T10:30:00+01:00")
    assert r.status_code == 201, f"instants with a +01:00 offset answered {r.status_code}: {r.text}"
    stored = ctx.redis.hgetall(f"event:{r.json()['event_id']}")
    assert stored.get("dtstart") == "2026-03-02T09:00:00Z", f"10:00+01:00 was stored as {stored.get('dtstart')!r}, expected 2026-03-02T09:00:00Z"


async def check_range_order(ctx):
    m = ctx.load("api")
    await _refused(ctx, m, 422, "invalid_range", "an event that ends when it starts", dtend=BODY["dtstart"])
    await _refused(ctx, m, 422, "invalid_range", "an event that ends before it starts", dtend="2026-03-02T08:00:00Z")
`,
    typescript: `const H = {'X-Tenant-Id': 't1'};
// A weekly 30-minute standup, four times from Monday 2 March 2026.
const BODY = {
  calendar_id: 'c1',
  title: 'Standup',
  rrule: 'FREQ=WEEKLY;COUNT=4',
  dtstart: '2026-03-02T09:00:00Z',
  dtend: '2026-03-02T09:30:00Z',
  attendees: ['ana@example.com', 'bo@example.com'],
};

const post = (ctx, m, changes: Record<string, unknown> = {}) =>
  ctx.client(m.app).post('/v1/events', {json: {...BODY, ...changes}, headers: H});

const errorOf = (r): string | undefined => {
  try {
    return r.json().error;
  } catch {
    return undefined;
  }
};

async function refused(ctx, m, status: number, code: string, what: string, changes: Record<string, unknown>) {
  const r = await post(ctx, m, changes);
  assert(r.status === status && errorOf(r) === code, \`\${what} answered \${r.status} \${r.text}, expected \${status} \${code}\`);
  const keys = ctx.redis.keys('event:*');
  assert.deepEqual(keys, [], \`\${what} was stored anyway: Redis holds \${JSON.stringify(keys)}\`);
}

export async function check_route(ctx) {
  const m = ctx.load('api');
  const r = await post(ctx, m);
  assert.equal(r.status, 201, \`POST /v1/events for a weekly rule with COUNT=4 answered \${r.status}: \${r.text}\`);
  const event = r.json();
  assert(event.event_id && event.revision === 1, \`the answer must carry event_id and revision 1: \${r.text}\`);
  const stored = ctx.redis.hgetall(\`event:\${event.event_id}\`);
  assert(stored.rrule === 'FREQ=WEEKLY;COUNT=4' && stored.calendar_id === 'c1', \`event:\${event.event_id} holds \${JSON.stringify(stored)}\`);
  assert(ctx.redis.smembers('calendar:c1:events').includes(event.event_id), 'the event is not indexed in calendar:c1:events');
  assert.equal(ctx.redis.get('gen:c1'), '1', \`gen:c1 is \${JSON.stringify(ctx.redis.get('gen:c1'))} after the create: bumpGeneration retires the calendar's cached weeks\`);
}

export async function check_unknown_parts(ctx) {
  const m = ctx.load('api');
  for (const rule of ['FREQ=WEEKLY;COUNT=4;BYSECOND=30', 'FREQ=WEEKLY;COUNT=4;BYDAY=MO,WE', 'FREQ=SECONDLY;COUNT=10', 'FREQ=WEEKLY;COUNT']) {
    await refused(ctx, m, 422, 'unsupported_rrule_part', \`the rule \${JSON.stringify(rule)}\`, {rrule: rule});
  }
  const r = await post(ctx, m, {rrule: ''});
  assert.equal(r.status, 201, \`an empty rule (one occurrence) answered \${r.status}: \${r.text}\`);
}

export async function check_rule_terminates(ctx) {
  const m = ctx.load('api');
  for (const rule of ['FREQ=DAILY', 'FREQ=DAILY;COUNT=6000', 'FREQ=DAILY;COUNT=0', 'FREQ=DAILY;INTERVAL=0;UNTIL=2026-06-01T00:00:00Z']) {
    await refused(ctx, m, 422, 'rule_not_terminating', \`the rule \${JSON.stringify(rule)}\`, {rrule: rule});
  }
  for (const rule of ['FREQ=DAILY;UNTIL=2026-06-01T00:00:00Z', 'FREQ=DAILY;INTERVAL=2;COUNT=5000']) {
    const r = await post(ctx, m, {rrule: rule});
    assert.equal(r.status, 201, \`the rule \${JSON.stringify(rule)} ends and answered \${r.status}: \${r.text}\`);
  }
}

export async function check_tz_aware(ctx) {
  const m = ctx.load('api');
  await refused(ctx, m, 422, 'invalid_instant', 'a dtstart without an offset', {dtstart: '2026-03-02T09:00:00'});
  await refused(ctx, m, 422, 'invalid_instant', 'a dtend without an offset', {dtend: '2026-03-02T09:30:00'});
  await refused(ctx, m, 422, 'invalid_instant', 'an UNTIL without an offset', {rrule: 'FREQ=DAILY;UNTIL=2026-06-01T00:00:00'});
  const r = await post(ctx, m, {dtstart: '2026-03-02T10:00:00+01:00', dtend: '2026-03-02T10:30:00+01:00'});
  assert.equal(r.status, 201, \`instants with a +01:00 offset answered \${r.status}: \${r.text}\`);
  const stored = ctx.redis.hgetall(\`event:\${r.json().event_id}\`);
  assert.equal(stored.dtstart, '2026-03-02T09:00:00Z', \`10:00+01:00 was stored as \${JSON.stringify(stored.dtstart)}, expected 2026-03-02T09:00:00Z\`);
}

export async function check_range_order(ctx) {
  const m = ctx.load('api');
  await refused(ctx, m, 422, 'invalid_range', 'an event that ends when it starts', {dtend: BODY.dtstart});
  await refused(ctx, m, 422, 'invalid_range', 'an event that ends before it starts', {dtend: '2026-03-02T08:00:00Z'});
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"leetbuild/harness"
)

// apiClient serves the learner's route over step 2's bumpGeneration, which the harness stands in for.
func apiClient(ctx *harness.Ctx) *harness.HTTP {
	bumpGeneration = func(_ context.Context, calendarID string) (int64, error) {
		generation, _ := ctx.Redis.Do("INCR", "gen:"+calendarID).(int64)
		return generation, nil
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

// apiPost sends a weekly 30-minute standup, four times from Monday 2 March 2026, with changes applied.
func apiPost(c *harness.HTTP, changes map[string]any) *harness.Response {
	body := map[string]any{
		"calendar_id": "c1", "title": "Standup", "rrule": "FREQ=WEEKLY;COUNT=4",
		"dtstart": "2026-03-02T09:00:00Z", "dtend": "2026-03-02T09:30:00Z", "attendees": []string{"ana@example.com", "bo@example.com"},
	}
	for k, v := range changes {
		body[k] = v
	}
	return c.Post("/v1/events", body, "X-Tenant-Id", "t1")
}

func apiBody(r *harness.Response) map[string]any {
	var body map[string]any
	if err := json.Unmarshal(r.Body, &body); err != nil {
		return map[string]any{}
	}
	return body
}

func apiRefused(ctx *harness.Ctx, c *harness.HTTP, status int, code, what string, changes map[string]any) {
	r := apiPost(c, changes)
	ctx.Assert(r.Status == status && apiBody(r)["error"] == code, "%s answered %d %s, expected %d %s", what, r.Status, r.Text(), status, code)
	keys := ctx.Redis.Keys("event:*")
	ctx.Assert(len(keys) == 0, "%s was stored anyway: Redis holds %q", what, keys)
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, nil)
	ctx.Equal(r.Status, 201, "POST /v1/events for a weekly rule with COUNT=4 (%s)", r.Text())
	event := apiBody(r)
	eventID, _ := event["event_id"].(string)
	ctx.Assert(eventID != "" && event["revision"] == float64(1), "the answer must carry event_id and revision 1: %s", r.Text())
	stored := ctx.Redis.HGetAll("event:" + eventID)
	ctx.Assert(stored["rrule"] == "FREQ=WEEKLY;COUNT=4" && stored["calendar_id"] == "c1", "event:%s holds %v", eventID, stored)
	ctx.Assert(ctx.Redis.SIsMember("calendar:c1:events", eventID), "the event is not indexed in calendar:c1:events")
	generation, _ := ctx.Redis.Get("gen:c1")
	ctx.Equal(generation, "1", "gen:c1 after the create (bumpGeneration retires the calendar's cached weeks)")
}

func CheckUnknownParts(ctx *harness.Ctx) {
	c := apiClient(ctx)
	for _, rule := range []string{"FREQ=WEEKLY;COUNT=4;BYSECOND=30", "FREQ=WEEKLY;COUNT=4;BYDAY=MO,WE", "FREQ=SECONDLY;COUNT=10", "FREQ=WEEKLY;COUNT"} {
		apiRefused(ctx, c, 422, "unsupported_rrule_part", "the rule "+rule, map[string]any{"rrule": rule})
	}
	r := apiPost(c, map[string]any{"rrule": ""})
	ctx.Equal(r.Status, 201, "an empty rule, one occurrence (%s)", r.Text())
}

func CheckRuleTerminates(ctx *harness.Ctx) {
	c := apiClient(ctx)
	for _, rule := range []string{"FREQ=DAILY", "FREQ=DAILY;COUNT=6000", "FREQ=DAILY;COUNT=0", "FREQ=DAILY;INTERVAL=0;UNTIL=2026-06-01T00:00:00Z"} {
		apiRefused(ctx, c, 422, "rule_not_terminating", "the rule "+rule, map[string]any{"rrule": rule})
	}
	for _, rule := range []string{"FREQ=DAILY;UNTIL=2026-06-01T00:00:00Z", "FREQ=DAILY;INTERVAL=2;COUNT=5000"} {
		r := apiPost(c, map[string]any{"rrule": rule})
		ctx.Equal(r.Status, 201, "the rule %s ends (%s)", rule, r.Text())
	}
}

func CheckTzAware(ctx *harness.Ctx) {
	c := apiClient(ctx)
	apiRefused(ctx, c, 422, "invalid_instant", "a dtstart without an offset", map[string]any{"dtstart": "2026-03-02T09:00:00"})
	apiRefused(ctx, c, 422, "invalid_instant", "a dtend without an offset", map[string]any{"dtend": "2026-03-02T09:30:00"})
	apiRefused(ctx, c, 422, "invalid_instant", "an UNTIL without an offset", map[string]any{"rrule": "FREQ=DAILY;UNTIL=2026-06-01T00:00:00"})
	r := apiPost(c, map[string]any{"dtstart": "2026-03-02T10:00:00+01:00", "dtend": "2026-03-02T10:30:00+01:00"})
	ctx.Equal(r.Status, 201, "instants with a +01:00 offset (%s)", r.Text())
	eventID, _ := apiBody(r)["event_id"].(string)
	ctx.Equal(ctx.Redis.HGetAll("event:" + eventID)["dtstart"], "2026-03-02T09:00:00Z", "the stored dtstart of 10:00+01:00")
}

func CheckRangeOrder(ctx *harness.Ctx) {
	c := apiClient(ctx)
	apiRefused(ctx, c, 422, "invalid_range", "an event that ends when it starts", map[string]any{"dtend": "2026-03-02T09:00:00Z"})
	apiRefused(ctx, c, 422, "invalid_range", "an event that ends before it starts", map[string]any{"dtend": "2026-03-02T08:00:00Z"})
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "state.cpp"

namespace {

harness::HTTP apiClient(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

// A weekly 30-minute standup, four times from Monday 2 March 2026, with one field changed.
harness::Response apiPost(harness::HTTP& c, const std::string& field = "", const std::string& value = "") {
  nlohmann::json body = {{"calendar_id", "c1"},
                         {"title", "Standup"},
                         {"rrule", "FREQ=WEEKLY;COUNT=4"},
                         {"dtstart", "2026-03-02T09:00:00Z"},
                         {"dtend", "2026-03-02T09:30:00Z"},
                         {"attendees", {"ana@example.com", "bo@example.com"}}};
  if (!field.empty()) body[field] = value;
  return c.Post("/v1/events", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", "t1");
}

nlohmann::json apiBody(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : nlohmann::json::object();
}

void apiRefused(harness::Ctx& ctx, harness::HTTP& c, int status, const std::string& code, const std::string& what,
                const std::string& field, const std::string& value) {
  const auto r = apiPost(c, field, value);
  ctx.Assert(r.Status == status && apiBody(r).value("error", "") == code, "%s answered %d %s, expected %d %s", what, r.Status,
             r.Text(), status, code);
  const auto keys = ctx.Redis.Keys("event:*");
  ctx.Assert(keys.empty(), "%s was stored anyway: Redis holds %q", what, keys);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const auto r = apiPost(c);
  ctx.Equal(r.Status, 201, "POST /v1/events for a weekly rule with COUNT=4 (%s)", r.Text());
  const auto event = apiBody(r);
  const std::string event_id = event.value("event_id", "");
  ctx.Assert(!event_id.empty() && event.value("revision", 0) == 1, "the answer must carry event_id and revision 1: %s", r.Text());
  auto stored = ctx.Redis.HGetAll("event:" + event_id);
  ctx.Assert(stored["rrule"] == "FREQ=WEEKLY;COUNT=4" && stored["calendar_id"] == "c1", "event:%s holds %v", event_id, stored);
  ctx.Assert(ctx.Redis.SIsMember("calendar:c1:events", event_id), "the event is not indexed in calendar:c1:events");
  ctx.Equal(ctx.Redis.Get("gen:c1").value_or(""), "1", "gen:c1 after the create (bumpGeneration retires the calendar's cached weeks)");
}

void CheckUnknownParts(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  for (const std::string rule : {"FREQ=WEEKLY;COUNT=4;BYSECOND=30", "FREQ=WEEKLY;COUNT=4;BYDAY=MO,WE", "FREQ=SECONDLY;COUNT=10", "FREQ=WEEKLY;COUNT"}) {
    apiRefused(ctx, c, 422, "unsupported_rrule_part", "the rule " + rule, "rrule", rule);
  }
  const auto r = apiPost(c, "rrule", "");
  ctx.Equal(r.Status, 201, "an empty rule, one occurrence (%s)", r.Text());
}

void CheckRuleTerminates(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  for (const std::string rule : {"FREQ=DAILY", "FREQ=DAILY;COUNT=6000", "FREQ=DAILY;COUNT=0", "FREQ=DAILY;INTERVAL=0;UNTIL=2026-06-01T00:00:00Z"}) {
    apiRefused(ctx, c, 422, "rule_not_terminating", "the rule " + rule, "rrule", rule);
  }
  for (const std::string rule : {"FREQ=DAILY;UNTIL=2026-06-01T00:00:00Z", "FREQ=DAILY;INTERVAL=2;COUNT=5000"}) {
    const auto r = apiPost(c, "rrule", rule);
    ctx.Equal(r.Status, 201, "the rule %s ends (%s)", rule, r.Text());
  }
}

void CheckTzAware(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  apiRefused(ctx, c, 422, "invalid_instant", "a dtstart without an offset", "dtstart", "2026-03-02T09:00:00");
  apiRefused(ctx, c, 422, "invalid_instant", "a dtend without an offset", "dtend", "2026-03-02T09:30:00");
  apiRefused(ctx, c, 422, "invalid_instant", "an UNTIL without an offset", "rrule", "FREQ=DAILY;UNTIL=2026-06-01T00:00:00");
  nlohmann::json body = {{"calendar_id", "c1"},
                         {"title", "Standup"},
                         {"rrule", "FREQ=WEEKLY;COUNT=4"},
                         {"dtstart", "2026-03-02T10:00:00+01:00"},
                         {"dtend", "2026-03-02T10:30:00+01:00"}};
  const auto r = c.Post("/v1/events", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", "t1");
  ctx.Equal(r.Status, 201, "instants with a +01:00 offset (%s)", r.Text());
  auto stored = ctx.Redis.HGetAll("event:" + apiBody(r).value("event_id", ""));
  ctx.Equal(stored["dtstart"], "2026-03-02T09:00:00Z", "the stored dtstart of 10:00+01:00");
}

void CheckRangeOrder(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  apiRefused(ctx, c, 422, "invalid_range", "an event that ends when it starts", "dtend", "2026-03-02T09:00:00Z");
  apiRefused(ctx, c, 422, "invalid_range", "an event that ends before it starts", "dtend", "2026-03-02T08:00:00Z");
}
`,
  },
  hints: [
    'A daily rule with no end makes every reminder sweep slower, `BYDAY=MO,WE` lands every day, a 10:00 Berlin standup shows at 11:00, and one meeting ends half an hour before it starts.',
    '`format_rule` writes only the parts it knows, so the trim hides what should be a refusal; nothing compares `COUNT`, `UNTIL` or `INTERVAL` with an end; `assume_utc` invents an offset; nothing compares `dtend` with `dtstart`.',
    'Before `put_event`: a key outside `SUPPORTED_PARTS`, an empty value or an unknown `FREQ` is `unsupported_rrule_part`; require `UNTIL` or `COUNT` 1..5000 and `INTERVAL` ≥ 1; parse every instant with `parse_instant` alone; then `dtend > dtstart`.',
  ],
  debrief: `A rule is a program every reader of the calendar runs, so the create is where it is proven to halt: it has an end, the count is bounded, and each step moves forward. Refusing an unknown part instead of trimming it keeps the stored rule equal to the rule the user wrote; a calendar that drops \`BYDAY\` shows the meeting on the wrong days and tells nobody. An instant without an offset is not an instant, and guessing UTC moves the meeting by the writer's offset for every attendee at once. Production calendars accept the whole RFC 5545 grammar and store the zone name beside each instant, so a rule keeps its wall-clock time across daylight-saving changes.`,
};
