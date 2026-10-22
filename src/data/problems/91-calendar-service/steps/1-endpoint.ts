import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/events: recurrence that terminates',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the create route,
parses the rule into the parts it recognizes, logs the create and answers 200 with the body it
received. It compiles, it serves the demo with a weekly standup rule, and it hides four production
flaws. Review it like the service owner, fix it, and prove the fix with the checks below.

Implement \`POST /v1/events\` with body
\`{"calendar_id": "cal_7", "title": "Standup", "rrule": "FREQ=WEEKLY;BYDAY=MO;COUNT=6", "dtstart": "2026-03-02T09:00:00-08:00", "dtend": "2026-03-02T09:15:00-08:00", "timezone": "America/Los_Angeles"}\`.

- The rule is parsed as \`KEY=VALUE\` parts separated by \`;\`, at most \`MAX_RRULE_LENGTH\` (512)
  characters. Every part's key must be in \`SUPPORTED_RRULE_PARTS\` (\`FREQ\`, \`INTERVAL\`, \`COUNT\`,
  \`UNTIL\`, \`BYDAY\`, \`BYMONTHDAY\`, \`BYMONTH\`, \`WKST\`) and carry a non-empty value; a part with no
  \`=\`, an empty value, or a key outside that set is **422** with the \`UNSUPPORTED_RRULE_PART\`
  error code — the rule is refused, never trimmed to the parts the service happens to know.
- Termination is required. \`FREQ\` must be present and must not be one of \`UNBOUNDED_FREQUENCIES\`
  (\`SECONDLY\`, \`MINUTELY\`, \`HOURLY\`), and the rule must carry an end: \`UNTIL\`, or a \`COUNT\`
  between **1** and \`MAX_COUNT\` (5000). Any rule that can expand forever is **422** before the
  store is touched.
- Every datetime carries its timezone. \`dtstart\`, \`dtend\` and any \`UNTIL\` must be ISO-8601 with
  an explicit offset (a trailing \`Z\` or \`+HH:MM\`); a naive local wall-clock string is **422**
  with the \`MISSING_TZ\` error code. \`timezone\` is required as well and must name a zone the
  runtime actually knows, not just a non-empty string.
- \`calendar_id\` and \`title\` are required non-empty strings, \`title\` at most \`MAX_TITLE_LENGTH\`
  (200) characters; a malformed body is **400**. A missing tenant is **401**.
- A valid rule is stored with the \`revision\` the store assigns (1 on create) and the response is
  **201** \`{"event_id", "revision", "calendar_id"}\` — the identity the store created, never the
  request body echoed back.
- Log the create with tenant, calendar id and revision — not the title and not the rule text.

**Failure mode the checks target.** One unvalidated rule is an unbounded expansion:
\`FREQ=SECONDLY\` with no \`UNTIL\` and no \`COUNT\` is a legal iCalendar rule, so the draft stores it
and hands the expander something that never returns — the create request finishes in milliseconds,
the worker it poisoned never does. The silently dropped parts are the quieter half: \`BYSECOND=30\`
or \`BYWEEKNO=12\` disappearing from the stored rule means the event the user wrote is not the event
the service expands, and nobody notices until a meeting lands on the wrong day. Naked local
datetimes fail the same way across a DST boundary, and answering with the request body hides that no
\`event_id\` and no \`revision\` were ever assigned — the token every later step invalidates on.`,
  sequence: {
    participants: ['Calendar client', 'Calendar API', 'Postgres'],
    messages: [
      {
        from: 'Calendar client',
        to: 'Calendar API',
        label: 'POST /v1/events · X-Tenant-Id · rrule · dtstart · timezone',
        kind: 'sync',
      },
      {from: 'Calendar API', to: 'Calendar API', label: 'parse parts · reject UNSUPPORTED_RRULE_PART', kind: 'sync'},
      {from: 'Calendar API', to: 'Calendar API', label: 'require UNTIL/COUNT · bounded FREQ', kind: 'sync'},
      {from: 'Calendar API', to: 'Calendar API', label: 'require offset on dtstart · dtend · UNTIL', kind: 'sync'},
      {from: 'Calendar API', to: 'Postgres', label: 'INSERT event · revision 1', kind: 'sync'},
      {from: 'Postgres', to: 'Calendar API', label: '{event_id, revision}', kind: 'reply'},
      {from: 'Calendar API', to: 'Calendar client', label: '201 {event_id, revision, calendar_id}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/events',
      detail: 'Register the create route on `POST /v1/events`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/events["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/events['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/events"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"events"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/events"/]},
      },
    },
    {
      id: 'rrule-terminates',
      title: 'Refuses rules that cannot terminate with 422',
      detail:
        '`FREQ=SECONDLY`, `MINUTELY` and `HOURLY` (`UNBOUNDED_FREQUENCIES`) are refused, and so is any rule with neither an `UNTIL` nor a `COUNT` within `MAX_COUNT` — **422** before the store sees the event. The draft accepts `FREQ=SECONDLY` with no end, so one create request hands the expander a rule that never returns.',
      match: {
        python: {all: [/UNBOUNDED_FREQUENCIES/, /MAX_COUNT/, /"UNTIL" not in parts/, /status_code\s*=\s*422/]},
        typescript: {all: [/UNBOUNDED_FREQUENCIES/, /MAX_COUNT/, /parts\.UNTIL === undefined/, /code\(\s*422\s*\)/]},
        go: {all: [/unboundedFrequencies/, /maxCount/, /parts\["UNTIL"\]/, /StatusUnprocessableEntity/]},
        scala: {
          all: [/UnboundedFrequencies/, /MaxCount/, /parts\.contains\("UNTIL"\)/, /StatusCodes\.UnprocessableEntity/],
        },
        cpp: {all: [/kUnboundedFrequencies/, /kMaxCount/, /parts\.count\("UNTIL"\)/, /res\.status\s*=\s*422/]},
      },
    },
    {
      id: 'tz-aware',
      title: 'Requires an explicit timezone on every datetime',
      detail:
        '`dtstart`, `dtend` and the rule’s `UNTIL` each have to carry an explicit offset or `Z` (`TZ_SUFFIX_RE`), and `timezone` has to name a zone the runtime knows; a naive local string is **422** `MISSING_TZ`. The draft passes the datetimes through as naked wall-clock strings, so the stored event has no instant at all.',
      match: {
        python: {
          all: [
            /MISSING_TZ/,
            /TZ_SUFFIX_RE/,
            /tzinfo is None/,
            /status_code\s*=\s*422/,
            /require_aware\(parts\["UNTIL"\]/,
          ],
        },
        typescript: {
          all: [/MISSING_TZ/, /TZ_SUFFIX_RE/, /code\(\s*422\s*\)/, /awareMs\(/, /parts\.UNTIL !== undefined/],
        },
        go: {all: [/missingTZ/, /tzSuffixRe/, /time\.LoadLocation\(/, /awareOffset\(/, /StatusUnprocessableEntity/]},
        scala: {
          all: [/MissingTz/, /TzSuffixRe/, /knownZone\(/, /aware\(body\.dtstart\)/, /StatusCodes\.UnprocessableEntity/],
        },
        cpp: {all: [/kMissingTz/, /kTzSuffixRe/, /knownZone\(/, /tzAware\(/, /res\.status\s*=\s*422/]},
      },
    },
    {
      id: 'unknown-parts',
      title: 'Rejects unknown RRULE parts instead of dropping them',
      detail:
        'The key of every part is checked against `SUPPORTED_RRULE_PARTS`; anything outside it — including a part with no `=` or an empty value — is **422** `UNSUPPORTED_RRULE_PART`, and the parts that pass are the parts that get stored. The draft keeps only the four parts it recognizes and drops the rest, so the stored rule is not the rule the user wrote.',
      match: {
        python: {
          all: [/SUPPORTED_RRULE_PARTS/, /UNSUPPORTED_RRULE_PART/, /parts\[key\] = value/, /status_code\s*=\s*422/],
        },
        typescript: {
          all: [/SUPPORTED_RRULE_PARTS/, /UNSUPPORTED_RRULE_PART/, /parts\[key\] = value/, /code\(\s*422\s*\)/],
        },
        go: {all: [/supportedRruleParts/, /unsupportedRRulePart/, /parts\[key\] = value/, /StatusUnprocessableEntity/]},
        scala: {
          all: [
            /SupportedRruleParts/,
            /UnsupportedRrulePart/,
            /parts\(key\) = value/,
            /StatusCodes\.UnprocessableEntity/,
          ],
        },
        cpp: {all: [/kSupportedRruleParts/, /kUnsupportedRrulePart/, /parts\[key\] = value/, /res\.status\s*=\s*422/]},
      },
    },
    {
      id: 'revision-echo',
      title: 'Answers with the event id and revision the store assigned',
      detail:
        'A valid create is **201** and the response carries `event_id`, `revision` and `calendar_id` read back from the stored event (`store.create_event`), so the later steps have a revision to invalidate. The draft answers **200** with the request body: no id, no revision, nothing downstream can key on.',
      match: {
        python: {
          all: [
            /stored = store\.create_event\(/,
            /"event_id": stored\["event_id"\]/,
            /"revision": stored\["revision"\]/,
            /status_code\s*=\s*201/,
          ],
          none: [/return JSONResponse\(\s*body\.model_dump\(\)/],
        },
        typescript: {
          all: [
            /stored = await store\.createEvent\(/,
            /event_id: stored\.event_id/,
            /revision: stored\.revision/,
            /code\(\s*201\s*\)/,
          ],
          none: [/code\(\s*200\s*\)\.send\(\s*body\s*\)/],
        },
        go: {
          all: [
            /store\.CreateEvent\(/,
            /"event_id":\s+stored\.EventID/,
            /"revision":\s+stored\.Revision/,
            /http\.StatusCreated/,
          ],
          none: [/writeJSON\(\s*rw\s*,\s*http\.StatusOK\s*,\s*body\s*\)/],
        },
        scala: {
          all: [/store\.createEvent\(/, /stored\.event_id/, /stored\.revision/, /StatusCodes\.Created/],
          none: [/complete\(\s*StatusCodes\.OK\s*,\s*body\s*\)/],
        },
        cpp: {
          all: [
            /store\.create_event\(/,
            /"event_id", stored\.event_id/,
            /"revision", stored\.revision/,
            /res\.status\s*=\s*201/,
          ],
          none: [/set_content\(\s*body\.dump\(\)/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("calendar")


class EventRequest(BaseModel):
    calendar_id: str
    title: str
    rrule: str
    dtstart: str
    dtend: str
    timezone: str


class EventStore:
    def create_event(self, calendar_id: str, event: dict) -> dict:
        """Insert the event with revision 1 and return {event_id, revision}."""
        raise NotImplementedError


store = EventStore()


@app.post("/v1/events")
def create_event(body: EventRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft accepts FREQ=SECONDLY with no UNTIL and no COUNT, keeps only the RRULE parts
    # it recognizes instead of rejecting the rest, passes dtstart/dtend/timezone through as naked
    # local strings, and echoes the request body instead of creating the event. Review all four.
    recognized = {"FREQ", "INTERVAL", "COUNT", "UNTIL"}
    chunks = [chunk.split("=", 1) for chunk in body.rrule.split(";") if "=" in chunk]
    rule = ";".join(f"{key}={value}" for key, value in chunks if key in recognized)
    logger.info("event created tenant=%s calendar=%s rrule=%s", tenant, body.calendar_id, rule)
    return JSONResponse(body.model_dump(), status_code=200)
`,
      solution: `import logging
import re
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("calendar")

SUPPORTED_RRULE_PARTS = {"FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "WKST"}
UNBOUNDED_FREQUENCIES = {"SECONDLY", "MINUTELY", "HOURLY"}
MAX_RRULE_LENGTH = 512
MAX_TITLE_LENGTH = 200
MAX_COUNT = 5000
MISSING_TZ = "MISSING_TZ"
UNSUPPORTED_RRULE_PART = "UNSUPPORTED_RRULE_PART"
RULE_NOT_TERMINATING = "RULE_NOT_TERMINATING"
TZ_SUFFIX_RE = re.compile(r"(Z|[+-]\\d{2}:?\\d{2})$")


class EventRequest(BaseModel):
    calendar_id: str
    title: str
    rrule: str
    dtstart: str
    dtend: str
    timezone: str


class EventStore:
    def create_event(self, calendar_id: str, event: dict) -> dict:
        """Insert the event with revision 1 and return {event_id, revision}."""
        raise NotImplementedError


store = EventStore()


def require_aware(value: str, field: str) -> datetime:
    if TZ_SUFFIX_RE.search(value) is None:
        raise HTTPException(status_code=422, detail=f"{MISSING_TZ}:{field}")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"{MISSING_TZ}:{field}") from None
    if parsed.tzinfo is None:
        raise HTTPException(status_code=422, detail=f"{MISSING_TZ}:{field}")
    return parsed


def parse_rrule(raw: str) -> dict[str, str]:
    if len(raw) > MAX_RRULE_LENGTH:
        raise HTTPException(status_code=422, detail="RRULE_TOO_LONG")
    parts: dict[str, str] = {}
    for chunk in raw.split(";"):
        key, sep, value = chunk.partition("=")
        if sep == "" or key not in SUPPORTED_RRULE_PARTS or value == "":
            raise HTTPException(status_code=422, detail=f"{UNSUPPORTED_RRULE_PART}:{key}")
        parts[key] = value
    freq = parts.get("FREQ")
    if freq is None or freq in UNBOUNDED_FREQUENCIES:
        raise HTTPException(status_code=422, detail=RULE_NOT_TERMINATING)
    count = parts.get("COUNT")
    if count is not None and (not count.isdigit() or not 1 <= int(count) <= MAX_COUNT):
        raise HTTPException(status_code=422, detail="COUNT must be 1..MAX_COUNT")
    if "UNTIL" not in parts and count is None:
        raise HTTPException(status_code=422, detail=RULE_NOT_TERMINATING)
    if "UNTIL" in parts:
        require_aware(parts["UNTIL"], "UNTIL")
    return parts


@app.post("/v1/events")
def create_event(body: EventRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    if body.calendar_id == "":
        raise HTTPException(status_code=400, detail="calendar_id is required")
    if body.title == "" or len(body.title) > MAX_TITLE_LENGTH:
        raise HTTPException(status_code=400, detail="title must be 1..MAX_TITLE_LENGTH characters")
    try:
        ZoneInfo(body.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        raise HTTPException(status_code=422, detail=f"{MISSING_TZ}:timezone") from None
    parts = parse_rrule(body.rrule)
    start = require_aware(body.dtstart, "dtstart")
    end = require_aware(body.dtend, "dtend")
    record = {
        "calendar_id": body.calendar_id,
        "title": body.title,
        "rrule": ";".join(f"{key}={value}" for key, value in parts.items()),
        "dtstart": start.isoformat(),
        "dtend": end.isoformat(),
        "timezone": body.timezone,
    }
    stored = store.create_event(body.calendar_id, record)
    logger.info("event created tenant=%s calendar=%s revision=%d", tenant, body.calendar_id, stored["revision"])
    return JSONResponse(
        {"event_id": stored["event_id"], "revision": stored["revision"], "calendar_id": body.calendar_id},
        status_code=201,
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/events: a generated draft that answers with whatever the caller sent. */
import Fastify from 'fastify';

export const app = Fastify();

interface EventBody {
  calendar_id: string;
  title: string;
  rrule: string;
  dtstart: string;
  dtend: string;
  timezone: string;
}

const RECOGNIZED_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL']);

app.post('/v1/events', async (request, reply) => {
  // TODO: this draft accepts FREQ=SECONDLY with no UNTIL and no COUNT, keeps only the RRULE parts
  // it recognizes instead of rejecting the rest, passes dtstart/dtend/timezone through as naked
  // local strings, and echoes the request body instead of creating the event. Review all four.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as EventBody;
  const kept: string[] = [];
  for (const chunk of body.rrule.split(';')) {
    const eq = chunk.indexOf('=');
    if (eq !== -1 && RECOGNIZED_PARTS.has(chunk.slice(0, eq))) kept.push(chunk);
  }
  request.log.info({tenant, calendar: body.calendar_id, rrule: kept.join(';')}, 'event created');
  return reply.code(200).send(body);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/events: a create whose rule terminates and whose datetimes carry a zone. */
import Fastify from 'fastify';

export const app = Fastify();

const SUPPORTED_RRULE_PARTS: Record<string, true> = {
  FREQ: true,
  INTERVAL: true,
  COUNT: true,
  UNTIL: true,
  BYDAY: true,
  BYMONTHDAY: true,
  BYMONTH: true,
  WKST: true,
};
const UNBOUNDED_FREQUENCIES: Record<string, true> = {SECONDLY: true, MINUTELY: true, HOURLY: true};
const MAX_RRULE_LENGTH = 512;
const MAX_TITLE_LENGTH = 200;
const MAX_COUNT = 5000;
const MISSING_TZ = 'MISSING_TZ';
const UNSUPPORTED_RRULE_PART = 'UNSUPPORTED_RRULE_PART';
const RULE_NOT_TERMINATING = 'RULE_NOT_TERMINATING';
const TZ_SUFFIX_RE = /(Z|[+-]\\d{2}:?\\d{2})$/;

interface EventBody {
  calendar_id: string;
  title: string;
  rrule: string;
  dtstart: string;
  dtend: string;
  timezone: string;
}

interface EventStore {
  createEvent(calendarId: string, record: EventBody): Promise<{event_id: string; revision: number}>;
}

const store: EventStore = {
  async createEvent() {
    throw new Error('wired to Postgres in the service');
  },
};

type RuleResult = {ok: true; parts: Record<string, string>} | {ok: false; error: string};

function parseRrule(raw: string): RuleResult {
  if (raw.length > MAX_RRULE_LENGTH) return {ok: false, error: 'RRULE_TOO_LONG'};
  const parts: Record<string, string> = {};
  for (const chunk of raw.split(';')) {
    const eq = chunk.indexOf('=');
    const key = eq === -1 ? chunk : chunk.slice(0, eq);
    const value = eq === -1 ? '' : chunk.slice(eq + 1);
    if (eq === -1 || SUPPORTED_RRULE_PARTS[key] !== true || value === '')
      return {ok: false, error: \`\${UNSUPPORTED_RRULE_PART}:\${key}\`};
    parts[key] = value;
  }
  const freq = parts.FREQ;
  if (freq === undefined || UNBOUNDED_FREQUENCIES[freq] === true) return {ok: false, error: RULE_NOT_TERMINATING};
  if (parts.UNTIL === undefined && parts.COUNT === undefined) return {ok: false, error: RULE_NOT_TERMINATING};
  const count = parts.COUNT;
  if (count !== undefined && (!/^[0-9]+$/.test(count) || Number(count) < 1 || Number(count) > MAX_COUNT))
    return {ok: false, error: \`COUNT must be 1..\${MAX_COUNT}\`};
  if (parts.UNTIL !== undefined && !TZ_SUFFIX_RE.test(parts.UNTIL))
    return {ok: false, error: \`\${MISSING_TZ}:UNTIL\`};
  return {ok: true, parts};
}

function awareMs(value: string): number | null {
  if (!TZ_SUFFIX_RE.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

function knownZone(zone: string): boolean {
  if (TZ_SUFFIX_RE.test(zone)) return true;
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: zone});
    return true;
  } catch {
    return false;
  }
}

app.post('/v1/events', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const body = request.body as Partial<EventBody> | null;
  if (body === null || typeof body !== 'object') return reply.code(400).send({error: 'invalid json'});
  if (typeof body.calendar_id !== 'string' || body.calendar_id === '')
    return reply.code(400).send({error: 'calendar_id is required'});
  if (typeof body.title !== 'string' || body.title === '' || body.title.length > MAX_TITLE_LENGTH)
    return reply.code(400).send({error: 'title must be 1..MAX_TITLE_LENGTH characters'});
  if (typeof body.timezone !== 'string' || !knownZone(body.timezone))
    return reply.code(422).send({error: \`\${MISSING_TZ}:timezone\`});
  if (typeof body.dtstart !== 'string' || typeof body.dtend !== 'string')
    return reply.code(400).send({error: 'dtstart and dtend are required'});
  const startMs = awareMs(body.dtstart);
  if (startMs === null) return reply.code(422).send({error: \`\${MISSING_TZ}:dtstart\`});
  const endMs = awareMs(body.dtend);
  if (endMs === null) return reply.code(422).send({error: \`\${MISSING_TZ}:dtend\`});
  if (endMs <= startMs) return reply.code(422).send({error: 'dtend must be after dtstart'});
  const rule = typeof body.rrule === 'string' ? parseRrule(body.rrule) : null;
  if (rule === null || !rule.ok)
    return reply.code(422).send({error: rule === null ? 'rrule is required' : rule.error});

  const record: EventBody = {
    calendar_id: body.calendar_id,
    title: body.title,
    rrule: Object.entries(rule.parts)
      .map(([key, value]) => \`\${key}=\${value}\`)
      .join(';'),
    dtstart: body.dtstart,
    dtend: body.dtend,
    timezone: body.timezone,
  };
  const stored = await store.createEvent(body.calendar_id, record);
  request.log.info({tenant, calendar: body.calendar_id, revision: stored.revision}, 'event created');
  return reply.code(201).send({
    event_id: stored.event_id,
    revision: stored.revision,
    calendar_id: body.calendar_id,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strings"
)

type EventRequest struct {
	CalendarID string \`json:"calendar_id"\`
	Title      string \`json:"title"\`
	RRule      string \`json:"rrule"\`
	DtStart    string \`json:"dtstart"\`
	DtEnd      string \`json:"dtend"\`
	Timezone   string \`json:"timezone"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createEvent(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body EventRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft accepts FREQ=SECONDLY with no UNTIL and no COUNT, keeps only the RRULE parts
	// it recognizes instead of rejecting the rest, passes dtstart/dtend/timezone through as naked
	// local strings, and echoes the request body instead of creating the event. Review all four.
	recognized := map[string]bool{"FREQ": true, "INTERVAL": true, "COUNT": true, "UNTIL": true}
	kept := make([]string, 0, 4)
	for _, chunk := range strings.Split(body.RRule, ";") {
		key, _, found := strings.Cut(chunk, "=")
		if found && recognized[key] {
			kept = append(kept, chunk)
		}
	}
	log.Printf("event created tenant=%s calendar=%s rrule=%s", tenant, body.CalendarID, strings.Join(kept, ";"))
	writeJSON(rw, http.StatusOK, body)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/events", createEvent)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	maxRruleLength       = 512
	maxTitleLength       = 200
	maxCount             = 5000
	missingTZ            = "MISSING_TZ"
	unsupportedRRulePart = "UNSUPPORTED_RRULE_PART"
	ruleNotTerminating   = "RULE_NOT_TERMINATING"
)

var (
	supportedRruleParts = map[string]bool{
		"FREQ": true, "INTERVAL": true, "COUNT": true, "UNTIL": true,
		"BYDAY": true, "BYMONTHDAY": true, "BYMONTH": true, "WKST": true,
	}
	unboundedFrequencies = map[string]bool{"SECONDLY": true, "MINUTELY": true, "HOURLY": true}
	tzSuffixRe           = regexp.MustCompile(\`(Z|[+-]\\d{2}:?\\d{2})$\`)
)

type EventRequest struct {
	CalendarID string \`json:"calendar_id"\`
	Title      string \`json:"title"\`
	RRule      string \`json:"rrule"\`
	DtStart    string \`json:"dtstart"\`
	DtEnd      string \`json:"dtend"\`
	Timezone   string \`json:"timezone"\`
}

type StoredEvent struct {
	EventID  string \`json:"event_id"\`
	Revision int    \`json:"revision"\`
}

type EventStore struct{}

func (s *EventStore) CreateEvent(ctx context.Context, calendarID string, record map[string]any) (StoredEvent, error) {
	return StoredEvent{}, nil
}

var store = &EventStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func awareOffset(value string) bool {
	if !tzSuffixRe.MatchString(value) {
		return false
	}
	_, err := time.Parse(time.RFC3339, value)
	return err == nil
}

func parseRrule(raw string) (map[string]string, string) {
	if len(raw) > maxRruleLength {
		return nil, "RRULE_TOO_LONG"
	}
	parts := map[string]string{}
	for _, chunk := range strings.Split(raw, ";") {
		key, value, found := strings.Cut(chunk, "=")
		if !found || !supportedRruleParts[key] || value == "" {
			return nil, unsupportedRRulePart + ":" + key
		}
		parts[key] = value
	}
	freq, ok := parts["FREQ"]
	if !ok || unboundedFrequencies[freq] {
		return nil, ruleNotTerminating
	}
	until, hasUntil := parts["UNTIL"]
	count, hasCount := parts["COUNT"]
	if !hasUntil && !hasCount {
		return nil, ruleNotTerminating
	}
	if hasCount {
		n, err := strconv.Atoi(count)
		if err != nil || n < 1 || n > maxCount {
			return nil, "COUNT must be 1..maxCount"
		}
	}
	if hasUntil && !tzSuffixRe.MatchString(until) {
		return nil, missingTZ + ":UNTIL"
	}
	return parts, ""
}

func normalizeRrule(parts map[string]string) string {
	chunks := make([]string, 0, len(parts))
	for key, value := range parts {
		chunks = append(chunks, key+"="+value)
	}
	sort.Strings(chunks)
	return strings.Join(chunks, ";")
}

func createEventHandler(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body EventRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.CalendarID == "" || body.Title == "" || len(body.Title) > maxTitleLength {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid calendar_id or title"})
		return
	}
	if _, err := time.LoadLocation(body.Timezone); err != nil && !awareOffset(body.Timezone) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": missingTZ + ":timezone"})
		return
	}
	if !awareOffset(body.DtStart) || !awareOffset(body.DtEnd) {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": missingTZ + ":dtstart or dtend"})
		return
	}
	parts, problem := parseRrule(body.RRule)
	if problem != "" {
		writeJSON(rw, http.StatusUnprocessableEntity, map[string]string{"error": problem})
		return
	}
	stored, _ := store.CreateEvent(r.Context(), body.CalendarID, map[string]any{
		"calendar_id": body.CalendarID,
		"title":       body.Title,
		"rrule":       normalizeRrule(parts),
		"dtstart":     body.DtStart,
		"dtend":       body.DtEnd,
		"timezone":    body.Timezone,
	})
	log.Printf("event created tenant=%s calendar=%s revision=%d", tenant, body.CalendarID, stored.Revision)
	writeJSON(rw, http.StatusCreated, map[string]any{
		"event_id":    stored.EventID,
		"revision":    stored.Revision,
		"calendar_id": body.CalendarID,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/events", createEventHandler)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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

final case class EventRequest(
    calendar_id: String,
    title: String,
    rrule: String,
    dtstart: String,
    dtend: String,
    timezone: String,
)

class EventStore {
  def createEvent(calendarId: String, record: EventRequest): StoredEvent =
    throw new UnsupportedOperationException("wired to Postgres in the service")
}

final case class StoredEvent(event_id: String, revision: Int)

object EventApi {
  implicit val system: ActorSystem = ActorSystem("calendar")
  implicit val requestFormat: RootJsonFormat[EventRequest] = jsonFormat6(EventRequest)

  val RecognizedParts = Set("FREQ", "INTERVAL", "COUNT", "UNTIL")
  val store = new EventStore

  val route: Route =
    path("v1" / "events") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[EventRequest]) { body =>
            // TODO: this draft accepts FREQ=SECONDLY with no UNTIL and no COUNT, keeps only the
            // RRULE parts it recognizes instead of rejecting the rest, passes dtstart/dtend/
            // timezone through as naked local strings, and echoes the request body instead of
            // creating the event. Review all four.
            val kept = body.rrule.split(";").filter(chunk => RecognizedParts.contains(chunk.takeWhile(_ != '=')))
            system.log.info(s"event created tenant=$tenant calendar=\${body.calendar_id}")
            complete(StatusCodes.OK, body)
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.time.{OffsetDateTime, ZoneId}
import java.time.format.DateTimeParseException

import scala.collection.mutable

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class EventRequest(
    calendar_id: String,
    title: String,
    rrule: String,
    dtstart: String,
    dtend: String,
    timezone: String,
)
final case class StoredEvent(event_id: String, revision: Int)
final case class CreatedEvent(event_id: String, revision: Int, calendar_id: String)

class EventStore {
  def createEvent(calendarId: String, record: EventRequest): StoredEvent =
    throw new UnsupportedOperationException("wired to Postgres in the service")
}

object EventApi {
  implicit val system: ActorSystem = ActorSystem("calendar")
  implicit val requestFormat: RootJsonFormat[EventRequest] = jsonFormat6(EventRequest)
  implicit val createdFormat: RootJsonFormat[CreatedEvent] = jsonFormat3(CreatedEvent)

  val SupportedRruleParts = Set("FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "WKST")
  val UnboundedFrequencies = Set("SECONDLY", "MINUTELY", "HOURLY")
  val MaxRruleLength = 512
  val MaxTitleLength = 200
  val MaxCount = 5000
  val MissingTz = "MISSING_TZ"
  val UnsupportedRrulePart = "UNSUPPORTED_RRULE_PART"
  val RuleNotTerminating = "RULE_NOT_TERMINATING"
  val TzSuffixRe = "(Z|[+-][0-9]{2}:?[0-9]{2})$".r

  val store = new EventStore

  def knownZone(zone: String): Boolean =
    TzSuffixRe.findFirstIn(zone).isDefined || ZoneId.getAvailableZoneIds.contains(zone)

  def aware(value: String): Option[OffsetDateTime] =
    TzSuffixRe.findFirstIn(value).flatMap { _ =>
      try Some(OffsetDateTime.parse(value))
      catch { case _: DateTimeParseException => None }
    }

  def parseRrule(raw: String): Either[String, Map[String, String]] = {
    if (raw.length > MaxRruleLength) return Left("RRULE_TOO_LONG")
    val parts = mutable.Map.empty[String, String]
    for (chunk <- raw.split(";")) {
      val eq = chunk.indexOf('=')
      val key = if (eq < 0) chunk else chunk.substring(0, eq)
      val value = if (eq < 0) "" else chunk.substring(eq + 1)
      if (eq < 0 || !SupportedRruleParts.contains(key) || value.isEmpty)
        return Left(s"$UnsupportedRrulePart:$key")
      parts(key) = value
    }
    val freq = parts.getOrElse("FREQ", "")
    if (freq.isEmpty || UnboundedFrequencies.contains(freq)) return Left(RuleNotTerminating)
    if (!parts.contains("UNTIL") && !parts.contains("COUNT")) return Left(RuleNotTerminating)
    val countOk = parts.get("COUNT") match {
      case None => true
      case Some(count) => count.toIntOption.exists(n => n >= 1 && n <= MaxCount)
    }
    if (!countOk) return Left(s"COUNT must be 1..$MaxCount")
    val untilOk = parts.get("UNTIL") match {
      case None => true
      case Some(until) => aware(until).isDefined
    }
    if (!untilOk) return Left(s"$MissingTz:UNTIL")
    Right(parts.toMap)
  }

  def normalizeRrule(parts: Map[String, String]): String =
    parts.toSeq.sortBy(_._1).map { case (key, value) => s"$key=$value" }.mkString(";")

  val route: Route =
    path("v1" / "events") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[EventRequest]) { body =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else if (body.calendar_id.isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"calendar_id is required"}""")
            } else if (body.title.isEmpty || body.title.length > MaxTitleLength) {
              complete(StatusCodes.BadRequest, """{"error":"title must be 1..MaxTitleLength characters"}""")
            } else if (!knownZone(body.timezone)) {
              complete(StatusCodes.UnprocessableEntity, s"""{"error":"$MissingTz:timezone"}""")
            } else if (aware(body.dtstart).isEmpty) {
              complete(StatusCodes.UnprocessableEntity, s"""{"error":"$MissingTz:dtstart"}""")
            } else if (aware(body.dtend).isEmpty) {
              complete(StatusCodes.UnprocessableEntity, s"""{"error":"$MissingTz:dtend"}""")
            } else {
              parseRrule(body.rrule) match {
                case Left(problem) =>
                  complete(StatusCodes.UnprocessableEntity, s"""{"error":"$problem"}""")
                case Right(parts) =>
                  val record =
                    EventRequest(body.calendar_id, body.title, normalizeRrule(parts), body.dtstart, body.dtend, body.timezone)
                  val stored = store.createEvent(body.calendar_id, record)
                  system.log.info(
                    s"event created tenant=\${tenantOpt.get} calendar=\${body.calendar_id} revision=\${stored.revision}",
                  )
                  complete(StatusCodes.Created, CreatedEvent(stored.event_id, stored.revision, body.calendar_id))
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
#include <set>
#include <string>

using json = nlohmann::json;

int main() {
  httplib::Server svr;

  svr.Post("/v1/events", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft accepts FREQ=SECONDLY with no UNTIL and no COUNT, keeps only the RRULE parts
    // it recognizes instead of rejecting the rest, passes dtstart/dtend/timezone through as naked
    // local strings, and echoes the request body instead of creating the event. Review all four.
    const std::set<std::string> recognized = {"FREQ", "INTERVAL", "COUNT", "UNTIL"};
    const auto raw = body.value("rrule", std::string());
    std::string kept;
    std::size_t start = 0;
    while (start <= raw.size()) {
      const auto end = raw.find(';', start);
      const auto chunk = raw.substr(start, end == std::string::npos ? std::string::npos : end - start);
      const auto key = chunk.substr(0, chunk.find('='));
      if (recognized.count(key) > 0) kept += (kept.empty() ? "" : ";") + chunk;
      if (end == std::string::npos) break;
      start = end + 1;
    }
    std::clog << "event created tenant=" << tenant << " calendar=" << body.value("calendar_id", std::string())
              << " rrule=" << kept << "\\n";
    res.status = 200;
    res.set_content(body.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <map>
#include <optional>
#include <regex>
#include <set>
#include <string>

using json = nlohmann::json;

const std::set<std::string> kSupportedRruleParts = {
    "FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "WKST"};
const std::set<std::string> kUnboundedFrequencies = {"SECONDLY", "MINUTELY", "HOURLY"};
constexpr std::size_t kMaxRruleLength = 512;
constexpr std::size_t kMaxTitleLength = 200;
constexpr long kMaxCount = 5000;
const std::string kMissingTz = "MISSING_TZ";
const std::string kUnsupportedRrulePart = "UNSUPPORTED_RRULE_PART";
const std::string kRuleNotTerminating = "RULE_NOT_TERMINATING";
const std::regex kTzSuffixRe(R"((Z|[+-]\\d{2}:?\\d{2})$)", std::regex::ECMAScript);

struct StoredEvent {
  std::string event_id;
  int revision = 0;
};

struct EventRecord {
  std::string calendar_id;
  std::string title;
  std::string rrule;
  std::string dtstart;
  std::string dtend;
  std::string timezone;
};

struct EventStore {
  StoredEvent create_event(const std::string& calendarId, const EventRecord& record);
};

EventStore store;

bool tzAware(const std::string& value) { return std::regex_search(value, kTzSuffixRe); }

bool knownZone(const std::string& zone) {
  if (tzAware(zone)) return true;
  try {
    std::chrono::locate_zone(zone);
    return true;
  } catch (const std::exception&) {
    return false;
  }
}

std::optional<std::map<std::string, std::string>> parseRrule(const std::string& raw, std::string& problem) {
  if (raw.size() > kMaxRruleLength) {
    problem = "RRULE_TOO_LONG";
    return std::nullopt;
  }
  std::map<std::string, std::string> parts;
  std::size_t start = 0;
  while (start <= raw.size()) {
    const auto end = raw.find(';', start);
    const auto chunk = raw.substr(start, end);
    const auto eq = chunk.find('=');
    const auto key = eq == std::string::npos ? chunk : chunk.substr(0, eq);
    const auto value = eq == std::string::npos ? std::string() : chunk.substr(eq + 1);
    if (eq == std::string::npos || kSupportedRruleParts.count(key) == 0 || value.empty()) {
      problem = kUnsupportedRrulePart + ":" + key;
      return std::nullopt;
    }
    parts[key] = value;
    if (end == std::string::npos) break;
    start = end + 1;
  }
  const auto freq = parts.find("FREQ");
  if (freq == parts.end() || kUnboundedFrequencies.count(freq->second) > 0) {
    problem = kRuleNotTerminating;
    return std::nullopt;
  }
  if (parts.count("UNTIL") == 0 && parts.count("COUNT") == 0) {
    problem = kRuleNotTerminating;
    return std::nullopt;
  }
  if (parts.count("COUNT") > 0) {
    const auto& count = parts["COUNT"];
    char* stop = nullptr;
    const long parsed = std::strtol(count.c_str(), &stop, 10);
    if (stop != count.c_str() + count.size() || parsed < 1 || parsed > kMaxCount) {
      problem = "COUNT must be 1..kMaxCount";
      return std::nullopt;
    }
  }
  if (parts.count("UNTIL") > 0 && !tzAware(parts["UNTIL"])) {
    problem = kMissingTz + ":UNTIL";
    return std::nullopt;
  }
  return parts;
}

std::string normalizeRrule(const std::map<std::string, std::string>& parts) {
  std::string joined;
  for (const auto& [key, value] : parts) joined += (joined.empty() ? "" : ";") + key + "=" + value;
  return joined;
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/events", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto calendarId = body.value("calendar_id", std::string());
    const auto title = body.value("title", std::string());
    if (calendarId.empty() || title.empty() || title.size() > kMaxTitleLength) {
      res.status = 400;
      res.set_content(R"({"error":"invalid calendar_id or title"})", "application/json");
      return;
    }
    const auto timezone = body.value("timezone", std::string());
    if (!knownZone(timezone)) {
      res.status = 422;
      res.set_content(json{{"error", kMissingTz + ":timezone"}}.dump(), "application/json");
      return;
    }
    const auto dtStart = body.value("dtstart", std::string());
    const auto dtEnd = body.value("dtend", std::string());
    if (!tzAware(dtStart) || !tzAware(dtEnd)) {
      res.status = 422;
      res.set_content(json{{"error", kMissingTz + ":dtstart or dtend"}}.dump(), "application/json");
      return;
    }
    std::string problem;
    const auto parts = parseRrule(body.value("rrule", std::string()), problem);
    if (!parts) {
      res.status = 422;
      res.set_content(json{{"error", problem}}.dump(), "application/json");
      return;
    }
    const EventRecord record{calendarId, title, normalizeRrule(*parts), dtStart, dtEnd, timezone};
    const auto stored = store.create_event(calendarId, record);
    std::clog << "event created tenant=" << tenant << " calendar=" << calendarId
              << " revision=" << stored.revision << "\\n";
    res.status = 201;
    res.set_content(json{{"event_id", stored.event_id}, {"revision", stored.revision}, {"calendar_id", calendarId}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Parse, do not filter. Walk the rule chunk by chunk and refuse any `KEY=VALUE` whose key is not in `SUPPORTED_RRULE_PARTS` (or that has no `=`, or an empty value) with **422** `UNSUPPORTED_RRULE_PART`. A whitelist makes "supported parts" a contract a future part joins deliberately, instead of a filter that quietly rewrites the user’s rule.',
    'Termination has two halves. The frequency must be one that can end at all — `FREQ` not in `UNBOUNDED_FREQUENCIES` — and the rule must carry an end: `UNTIL`, or a `COUNT` between 1 and `MAX_COUNT`. `FREQ=WEEKLY` alone is as infinite as `FREQ=SECONDLY`, and the cap is what stops `COUNT=1000000` from pinning an expander.',
    'Timezones are part of the parse, not a display concern: `dtstart`, `dtend` and `UNTIL` each have to carry an explicit offset or `Z`, and a bare wall-clock string is **422** `MISSING_TZ`. Answer with what the store assigned — `event_id` and `revision` — never with the request body; the revision is the token the later steps invalidate on.',
  ],
  debrief: `The interviewer is testing the create path of a calendar, which is where one rule can cost the fleet: a validated rule is a promise that expansion terminates, and every part you silently drop is a promise the service breaks later. Four defects are being checked. Termination is two conditions, not one — a frequency that can end and an explicit end — with a \`COUNT\` cap so that "bounded" is still a budget the expander can pay. The part whitelist is the second: unknown parts are a **422**, never a filter, because the rule the user wrote has to be the rule that expands; a dropped \`BYSECOND\` moves a meeting and nobody finds out for a week. Timezones are the third: \`dtstart\`, \`dtend\` and \`UNTIL\` are instants, so a naive local string cannot survive a DST boundary and is refused rather than stored. The fourth is the quiet one the draft's echo hides: the response has to carry the \`event_id\` and \`revision\` the store assigned, because that revision is what the cache, the notifier and the change stream invalidate against. Real services go further with a full RFC 5545 grammar, an expansion horizon for open-ended rules, and the original rule text kept beside the normalized one.`,
};
