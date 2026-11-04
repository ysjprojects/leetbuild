/**
 * Hand-written support modules every step of the calendar service imports but no step builds: the
 * `calendard` package. `rrule` is recurrence as the service counts it (instants as epoch seconds,
 * ISO-8601 with an offset on the wire, the rule subset the expander walks, `expand`), `store` the
 * calendars, events, instance exceptions and the outbox in Redis, and `new_id`. The five languages
 * compute the same occurrences from the same event, so an occurrence id or a stored field is the same
 * whichever runtime a check runs in.
 */
import {scalaPath} from '../scala-support';

export const supportModulesPy: Record<string, string> = {
  'calendard/__init__.py': '',
  'calendard/rrule.py': `"""
Recurrence as calendard counts it. Instants are epoch seconds, ISO-8601 with Z or an offset on the
wire (\`parse_instant\` / \`format_instant\`): a datetime without one names no instant. A rule is the
RFC 5545 subset in SUPPORTED_PARTS written KEY=VALUE;KEY=VALUE (UNTIL is an ISO-8601 instant here),
and \`expand\` walks a stored event's rule into the occurrences that overlap a window. This deployment
keeps no tz database: occurrences repeat at the same UTC time.
"""
from datetime import datetime, timezone

SUPPORTED_PARTS = ("FREQ", "INTERVAL", "COUNT", "UNTIL")
# FREQ -> seconds between two occurrences at INTERVAL=1.
FREQUENCIES = {"DAILY": 86400, "WEEKLY": 7 * 86400}
MAX_COUNT = 5000
MAX_RANGE_DAYS = 90


def parse_instant(text) -> int | None:
    """An ISO-8601 instant with Z or an offset (2026-03-10T09:00:00Z, +01:00) as an epoch second; None otherwise."""
    if not isinstance(text, str):
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return int(parsed.timestamp())


def format_instant(instant: int) -> str:
    return datetime.fromtimestamp(instant, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def rule_parts(rule: str) -> dict[str, str]:
    """The parts of a rule as written: "FREQ=DAILY;COUNT=3" -> {"FREQ": "DAILY", "COUNT": "3"}. A chunk
    without "=" is a key with an empty value; an empty rule has no parts."""
    parts: dict[str, str] = {}
    for chunk in rule.split(";"):
        if chunk:
            key, _, value = chunk.partition("=")
            parts[key] = value
    return parts


def format_rule(parts: dict[str, str]) -> str:
    """The stored form of a rule: its parts in SUPPORTED_PARTS order. A part outside SUPPORTED_PARTS is not written."""
    return ";".join(f"{key}={parts[key]}" for key in SUPPORTED_PARTS if key in parts)


def expand(event: dict, window_start: int, window_end: int) -> list[dict]:
    """The occurrences of a stored event that overlap [window_start, window_end), earliest first: each
    {"occurrence_id": "{event_id}:{epoch start}", "event_id", "start", "end", "revision"}. An empty rule
    occurs once. The walk stops at COUNT, at UNTIL or at the window's end."""
    first = parse_instant(event["dtstart"])
    duration = parse_instant(event["dtend"]) - first
    parts = rule_parts(event["rrule"]) or {"FREQ": "DAILY", "COUNT": "1"}
    step = FREQUENCIES[parts["FREQ"]] * int(parts.get("INTERVAL", "1"))
    count = int(parts["COUNT"]) if "COUNT" in parts else None
    until = parse_instant(parts["UNTIL"]) if "UNTIL" in parts else None
    occurrences = []
    n = 0
    while count is None or n < count:
        start = first + n * step
        if start >= window_end or (until is not None and start > until):
            break
        if start + duration > window_start:
            occurrences.append({
                "occurrence_id": f"{event['event_id']}:{start}",
                "event_id": event["event_id"],
                "start": format_instant(start),
                "end": format_instant(start + duration),
                "revision": int(event["revision"]),
            })
        n += 1
    return occurrences
`,
  'calendard/store.py': `"""
The calendar store, in Redis. A calendar is the hash \`calendar:{id}\` (calendar_id, visibility
"public" or "private") with its members (tenant ids) in the set \`calendar:{id}:members\` and its
event ids in the set \`calendar:{id}:events\`. An event is the hash \`event:{event_id}\` (every field a
string: event_id, calendar_id, tenant, title, rrule, dtstart, dtend, revision, attendees
comma-joined); in code it is a dict with \`revision\` an int and \`attendees\` a list. A calendar's
instance exceptions are the hash \`exceptions:{calendar_id}\`: occurrence id -> "cancelled" or
"moved:{ISO start}". The outbox is the list \`outbox\` of JSON rows {"topic", "key", "payload"} a relay
publishes later.
"""
import json
import uuid

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def new_id() -> str:
    return str(uuid.uuid4())


def _event(fields: dict) -> dict:
    event = dict(fields)
    event["revision"] = int(fields.get("revision", "0"))
    event["attendees"] = [a for a in fields.get("attendees", "").split(",") if a]
    return event


class CalendarStore:
    def put_calendar(self, calendar_id: str, visibility: str, members: list[str] = ()) -> None:
        pipe = r.pipeline()
        pipe.hset(f"calendar:{calendar_id}", mapping={"calendar_id": calendar_id, "visibility": visibility})
        if members:
            pipe.sadd(f"calendar:{calendar_id}:members", *members)
        pipe.execute()

    def get_calendar(self, calendar_id: str) -> dict | None:
        """{"calendar_id", "visibility"}, or None for a calendar that does not exist."""
        return r.hgetall(f"calendar:{calendar_id}") or None

    def is_member(self, calendar_id: str, tenant: str) -> bool:
        return bool(r.sismember(f"calendar:{calendar_id}:members", tenant))

    def put_event(self, event: dict) -> None:
        """Commit the event: write its hash and index it under its calendar, in one transaction."""
        row = {field: str(value) for field, value in event.items() if field != "attendees"}
        row["attendees"] = ",".join(event.get("attendees", []))
        pipe = r.pipeline()
        pipe.hset(f"event:{event['event_id']}", mapping=row)
        pipe.sadd(f"calendar:{event['calendar_id']}:events", event["event_id"])
        pipe.execute()

    def get_event(self, event_id: str) -> dict | None:
        fields = r.hgetall(f"event:{event_id}")
        return _event(fields) if fields else None

    def list_events(self, calendar_id: str) -> list[dict]:
        """Every event of the calendar, by event id."""
        events = (self.get_event(event_id) for event_id in sorted(r.smembers(f"calendar:{calendar_id}:events")))
        return [event for event in events if event is not None]

    def get_exceptions(self, calendar_id: str) -> dict[str, str]:
        return r.hgetall(f"exceptions:{calendar_id}")

    def put_exception(self, calendar_id: str, occurrence_id: str, value: str) -> None:
        r.hset(f"exceptions:{calendar_id}", occurrence_id, value)


class Outbox:
    def insert(self, topic: str, key: str, payload: dict) -> None:
        r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))

    def rows(self) -> list[dict]:
        return [json.loads(row) for row in r.lrange("outbox", 0, -1)]


store = CalendarStore()
outbox = Outbox()
`,
};

export const supportModulesTs: Record<string, string> = {
  'calendard/rrule.ts': `/**
 * Recurrence as calendard counts it. Instants are epoch seconds, ISO-8601 with Z or an offset on the
 * wire (\`parseInstant\` / \`formatInstant\`): a datetime without one names no instant. A rule is the
 * RFC 5545 subset in SUPPORTED_PARTS written KEY=VALUE;KEY=VALUE (UNTIL is an ISO-8601 instant here),
 * and \`expand\` walks a stored event's rule into the occurrences that overlap a window. This
 * deployment keeps no tz database: occurrences repeat at the same UTC time.
 */
import type {Event} from 'calendard/store';

export const SUPPORTED_PARTS = ['FREQ', 'INTERVAL', 'COUNT', 'UNTIL'];
/** FREQ → seconds between two occurrences at INTERVAL=1. */
export const FREQUENCIES: Record<string, number> = {DAILY: 86400, WEEKLY: 7 * 86400};
export const MAX_COUNT = 5000;
export const MAX_RANGE_DAYS = 90;

export interface Occurrence {
  /** "{event_id}:{epoch start}". */
  occurrence_id: string;
  event_id: string;
  start: string;
  end: string;
  revision: number;
}

/** An ISO-8601 instant with Z or an offset (2026-03-10T09:00:00Z, +01:00) as an epoch second; null otherwise. */
export const parseInstant = (text: unknown): number | null => {
  if (typeof text !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$/.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
};

export const formatInstant = (instant: number): string => new Date(instant * 1000).toISOString().replace(/\\.\\d{3}Z$/, 'Z');

/**
 * The parts of a rule as written: "FREQ=DAILY;COUNT=3" → {FREQ: 'DAILY', COUNT: '3'}. A chunk without
 * "=" is a key with an empty value; an empty rule has no parts.
 */
export const ruleParts = (rule: string): Record<string, string> => {
  const parts: Record<string, string> = {};
  for (const chunk of rule.split(';')) {
    if (chunk === '') continue;
    const at = chunk.indexOf('=');
    if (at < 0) parts[chunk] = '';
    else parts[chunk.slice(0, at)] = chunk.slice(at + 1);
  }
  return parts;
};

/** The stored form of a rule: its parts in SUPPORTED_PARTS order. A part outside SUPPORTED_PARTS is not written. */
export const formatRule = (parts: Record<string, string>): string =>
  SUPPORTED_PARTS.filter(key => key in parts)
    .map(key => \`\${key}=\${parts[key]}\`)
    .join(';');

/**
 * The occurrences of a stored event that overlap [windowStart, windowEnd), earliest first. An empty
 * rule occurs once. The walk stops at COUNT, at UNTIL or at the window's end.
 */
export const expand = (event: Event, windowStart: number, windowEnd: number): Occurrence[] => {
  const first = parseInstant(event.dtstart)!;
  const duration = parseInstant(event.dtend)! - first;
  let parts = ruleParts(event.rrule);
  if (Object.keys(parts).length === 0) parts = {FREQ: 'DAILY', COUNT: '1'};
  const step = FREQUENCIES[parts.FREQ] * Number(parts.INTERVAL ?? '1');
  const count = parts.COUNT === undefined ? null : Number(parts.COUNT);
  const until = parts.UNTIL === undefined ? null : parseInstant(parts.UNTIL);
  const occurrences: Occurrence[] = [];
  for (let n = 0; count === null || n < count; n += 1) {
    const start = first + n * step;
    if (start >= windowEnd || (until !== null && start > until)) break;
    if (start + duration > windowStart) {
      occurrences.push({
        occurrence_id: \`\${event.event_id}:\${start}\`,
        event_id: event.event_id,
        start: formatInstant(start),
        end: formatInstant(start + duration),
        revision: Number(event.revision),
      });
    }
  }
  return occurrences;
};
`,
  'calendard/store.ts': `/**
 * The calendar store, in Redis. A calendar is the hash \`calendar:{id}\` (calendar_id, visibility
 * "public" or "private") with its members (tenant ids) in the set \`calendar:{id}:members\` and its
 * event ids in the set \`calendar:{id}:events\`. An event is the hash \`event:{event_id}\` (every field
 * a string, attendees comma-joined). A calendar's instance exceptions are the hash
 * \`exceptions:{calendar_id}\`: occurrence id → "cancelled" or "moved:{ISO start}". The outbox is the
 * list \`outbox\` of JSON rows {"topic", "key", "payload"} a relay publishes later.
 */
import {randomUUID} from 'node:crypto';

import Redis from 'ioredis';

export interface Event {
  event_id: string;
  calendar_id: string;
  tenant: string;
  title: string;
  rrule: string;
  dtstart: string;
  dtend: string;
  revision: number;
  attendees: string[];
}

export interface CalendarRow {
  calendar_id: string;
  /** "public" or "private". */
  visibility: string;
}

const redis = new Redis({host: 'redis', port: 6379});

export const newId = (): string => randomUUID();

const toEvent = (fields: Record<string, string>): Event => ({
  event_id: fields.event_id,
  calendar_id: fields.calendar_id,
  tenant: fields.tenant,
  title: fields.title,
  rrule: fields.rrule,
  dtstart: fields.dtstart,
  dtend: fields.dtend,
  revision: Number(fields.revision ?? '0'),
  attendees: (fields.attendees ?? '').split(',').filter(a => a !== ''),
});

export const store = {
  async putCalendar(calendarId: string, visibility: string, members: string[] = []): Promise<void> {
    const tx = redis.multi().hset(\`calendar:\${calendarId}\`, {calendar_id: calendarId, visibility});
    if (members.length > 0) tx.sadd(\`calendar:\${calendarId}:members\`, ...members);
    await tx.exec();
  },
  /** The calendar, or null for one that does not exist. */
  async getCalendar(calendarId: string): Promise<CalendarRow | null> {
    const fields = await redis.hgetall(\`calendar:\${calendarId}\`);
    return Object.keys(fields).length === 0 ? null : {calendar_id: fields.calendar_id, visibility: fields.visibility};
  },
  async isMember(calendarId: string, tenant: string): Promise<boolean> {
    return (await redis.sismember(\`calendar:\${calendarId}:members\`, tenant)) === 1;
  },
  /** Commit the event: write its hash and index it under its calendar, in one transaction. */
  async putEvent(event: Event): Promise<void> {
    await redis
      .multi()
      .hset(\`event:\${event.event_id}\`, {...event, revision: String(event.revision), attendees: event.attendees.join(',')})
      .sadd(\`calendar:\${event.calendar_id}:events\`, event.event_id)
      .exec();
  },
  async getEvent(eventId: string): Promise<Event | null> {
    const fields = await redis.hgetall(\`event:\${eventId}\`);
    return Object.keys(fields).length === 0 ? null : toEvent(fields);
  },
  /** Every event of the calendar, by event id. */
  async listEvents(calendarId: string): Promise<Event[]> {
    const ids = (await redis.smembers(\`calendar:\${calendarId}:events\`)).sort();
    const events: Event[] = [];
    for (const id of ids) {
      const event = await store.getEvent(id);
      if (event !== null) events.push(event);
    }
    return events;
  },
  async getExceptions(calendarId: string): Promise<Record<string, string>> {
    return redis.hgetall(\`exceptions:\${calendarId}\`);
  },
  async putException(calendarId: string, occurrenceId: string, value: string): Promise<void> {
    await redis.hset(\`exceptions:\${calendarId}\`, occurrenceId, value);
  },
};

export const outbox = {
  async insert(topic: string, key: string, payload: unknown): Promise<void> {
    await redis.rpush('outbox', JSON.stringify({topic, key, payload}));
  },
  async rows(): Promise<{topic: string; key: string; payload: unknown}[]> {
    return (await redis.lrange('outbox', 0, -1)).map(row => JSON.parse(row));
  },
};
`,
};

export const supportModulesGo: Record<string, string> = {
  'calendard/rrule/rrule.go': `// Package rrule is recurrence as calendard counts it. Instants are epoch seconds, ISO-8601 with Z or
// an offset on the wire (ParseInstant / FormatInstant): a datetime without one names no instant. A
// rule is the RFC 5545 subset in SupportedParts written KEY=VALUE;KEY=VALUE (UNTIL is an ISO-8601
// instant here), and Expand walks a stored event's rule into the occurrences that overlap a window.
// This deployment keeps no tz database: occurrences repeat at the same UTC time.
package rrule

import (
	"strconv"
	"strings"
	"time"

	"calendard/store"
)

var SupportedParts = []string{"FREQ", "INTERVAL", "COUNT", "UNTIL"}

// Frequencies maps FREQ to the seconds between two occurrences at INTERVAL=1.
var Frequencies = map[string]int64{"DAILY": 86400, "WEEKLY": 7 * 86400}

const (
	MaxCount     = 5000
	MaxRangeDays = 90
)

// Occurrence is one instance of an event; OccurrenceID is "{event_id}:{epoch start}".
type Occurrence struct {
	OccurrenceID string \`json:"occurrence_id"\`
	EventID      string \`json:"event_id"\`
	Start        string \`json:"start"\`
	End          string \`json:"end"\`
	Revision     int    \`json:"revision"\`
}

// ParseInstant reads an ISO-8601 instant with Z or an offset (2026-03-10T09:00:00Z, +01:00) as an epoch second.
func ParseInstant(text string) (int64, bool) {
	t, err := time.Parse(time.RFC3339, text)
	if err != nil {
		return 0, false
	}
	return t.Unix(), true
}

func FormatInstant(instant int64) string {
	return time.Unix(instant, 0).UTC().Format("2006-01-02T15:04:05Z")
}

// RuleParts is the parts of a rule as written: "FREQ=DAILY;COUNT=3" → {FREQ: DAILY, COUNT: 3}. A
// chunk without "=" is a key with an empty value; an empty rule has no parts.
func RuleParts(rule string) map[string]string {
	parts := map[string]string{}
	for _, chunk := range strings.Split(rule, ";") {
		if chunk == "" {
			continue
		}
		key, value, _ := strings.Cut(chunk, "=")
		parts[key] = value
	}
	return parts
}

// FormatRule is the stored form of a rule: its parts in SupportedParts order. A part outside
// SupportedParts is not written.
func FormatRule(parts map[string]string) string {
	var out []string
	for _, key := range SupportedParts {
		if value, ok := parts[key]; ok {
			out = append(out, key+"="+value)
		}
	}
	return strings.Join(out, ";")
}

// Expand is the occurrences of a stored event that overlap [windowStart, windowEnd), earliest first.
// An empty rule occurs once. The walk stops at COUNT, at UNTIL or at the window's end.
func Expand(e store.Event, windowStart, windowEnd int64) []Occurrence {
	first, _ := ParseInstant(e.Dtstart)
	last, _ := ParseInstant(e.Dtend)
	duration := last - first
	parts := RuleParts(e.Rrule)
	if len(parts) == 0 {
		parts = map[string]string{"FREQ": "DAILY", "COUNT": "1"}
	}
	interval := int64(1)
	if v, ok := parts["INTERVAL"]; ok {
		interval, _ = strconv.ParseInt(v, 10, 64)
	}
	step := Frequencies[parts["FREQ"]] * interval
	count := int64(-1)
	if v, ok := parts["COUNT"]; ok {
		count, _ = strconv.ParseInt(v, 10, 64)
	}
	until, hasUntil := int64(0), false
	if v, ok := parts["UNTIL"]; ok {
		until, hasUntil = ParseInstant(v)
	}
	occurrences := []Occurrence{}
	for n := int64(0); count < 0 || n < count; n++ {
		start := first + n*step
		if start >= windowEnd || (hasUntil && start > until) {
			break
		}
		if start+duration > windowStart {
			occurrences = append(occurrences, Occurrence{
				OccurrenceID: e.EventID + ":" + strconv.FormatInt(start, 10),
				EventID:      e.EventID,
				Start:        FormatInstant(start),
				End:          FormatInstant(start + duration),
				Revision:     e.Revision,
			})
		}
	}
	return occurrences
}
`,
  'calendard/store/store.go': `// Package store is the calendar store, in Redis. A calendar is the hash calendar:{id} (calendar_id,
// visibility "public" or "private") with its members (tenant ids) in the set calendar:{id}:members
// and its event ids in the set calendar:{id}:events. An event is the hash event:{event_id} (every
// field a string, attendees comma-joined). A calendar's instance exceptions are the hash
// exceptions:{calendar_id}: occurrence id → "cancelled" or "moved:{ISO start}". The outbox is the list
// outbox of JSON rows {"topic", "key", "payload"} a relay publishes later.
package store

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Event is one event as the store holds it.
type Event struct {
	EventID    string   \`json:"event_id"\`
	CalendarID string   \`json:"calendar_id"\`
	Tenant     string   \`json:"tenant"\`
	Title      string   \`json:"title"\`
	Rrule      string   \`json:"rrule"\`
	Dtstart    string   \`json:"dtstart"\`
	Dtend      string   \`json:"dtend"\`
	Revision   int      \`json:"revision"\`
	Attendees  []string \`json:"attendees"\`
}

// CalendarRow is a calendar; Visibility is "public" or "private".
type CalendarRow struct {
	CalendarID string \`json:"calendar_id"\`
	Visibility string \`json:"visibility"\`
}

func NewID() string { return uuid.NewString() }

func PutCalendar(ctx context.Context, calendarID, visibility string, members ...string) error {
	pipe := rdb.TxPipeline()
	pipe.HSet(ctx, "calendar:"+calendarID, map[string]any{"calendar_id": calendarID, "visibility": visibility})
	if len(members) > 0 {
		args := make([]any, len(members))
		for i, m := range members {
			args[i] = m
		}
		pipe.SAdd(ctx, "calendar:"+calendarID+":members", args...)
	}
	_, err := pipe.Exec(ctx)
	return err
}

// GetCalendar is the calendar, or nil for one that does not exist.
func GetCalendar(ctx context.Context, calendarID string) (*CalendarRow, error) {
	fields, err := rdb.HGetAll(ctx, "calendar:"+calendarID).Result()
	if err != nil || len(fields) == 0 {
		return nil, err
	}
	return &CalendarRow{CalendarID: fields["calendar_id"], Visibility: fields["visibility"]}, nil
}

func IsMember(ctx context.Context, calendarID, tenant string) (bool, error) {
	return rdb.SIsMember(ctx, "calendar:"+calendarID+":members", tenant).Result()
}

// PutEvent commits the event: writes its hash and indexes it under its calendar, in one transaction.
func PutEvent(ctx context.Context, e *Event) error {
	pipe := rdb.TxPipeline()
	pipe.HSet(ctx, "event:"+e.EventID, map[string]any{
		"event_id": e.EventID, "calendar_id": e.CalendarID, "tenant": e.Tenant, "title": e.Title, "rrule": e.Rrule,
		"dtstart": e.Dtstart, "dtend": e.Dtend, "revision": strconv.Itoa(e.Revision), "attendees": strings.Join(e.Attendees, ","),
	})
	pipe.SAdd(ctx, "calendar:"+e.CalendarID+":events", e.EventID)
	_, err := pipe.Exec(ctx)
	return err
}

// GetEvent is the event, or nil.
func GetEvent(ctx context.Context, eventID string) (*Event, error) {
	f, err := rdb.HGetAll(ctx, "event:"+eventID).Result()
	if err != nil || len(f) == 0 {
		return nil, err
	}
	revision, _ := strconv.Atoi(f["revision"])
	attendees := []string{}
	for _, a := range strings.Split(f["attendees"], ",") {
		if a != "" {
			attendees = append(attendees, a)
		}
	}
	return &Event{
		EventID: f["event_id"], CalendarID: f["calendar_id"], Tenant: f["tenant"], Title: f["title"], Rrule: f["rrule"],
		Dtstart: f["dtstart"], Dtend: f["dtend"], Revision: revision, Attendees: attendees,
	}, nil
}

// ListEvents is every event of the calendar, by event id.
func ListEvents(ctx context.Context, calendarID string) ([]Event, error) {
	ids, err := rdb.SMembers(ctx, "calendar:"+calendarID+":events").Result()
	if err != nil {
		return nil, err
	}
	sort.Strings(ids)
	events := []Event{}
	for _, id := range ids {
		e, err := GetEvent(ctx, id)
		if err != nil {
			return nil, err
		}
		if e != nil {
			events = append(events, *e)
		}
	}
	return events, nil
}

func GetExceptions(ctx context.Context, calendarID string) (map[string]string, error) {
	return rdb.HGetAll(ctx, "exceptions:"+calendarID).Result()
}

func PutException(ctx context.Context, calendarID, occurrenceID, value string) error {
	return rdb.HSet(ctx, "exceptions:"+calendarID, occurrenceID, value).Err()
}

// OutboxRow is one row of the outbox.
type OutboxRow struct {
	Topic   string          \`json:"topic"\`
	Key     string          \`json:"key"\`
	Payload json.RawMessage \`json:"payload"\`
}

// InsertOutbox queues a record for the relay to publish later.
func InsertOutbox(ctx context.Context, topic, key string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	row, _ := json.Marshal(OutboxRow{Topic: topic, Key: key, Payload: raw})
	return rdb.RPush(ctx, "outbox", row).Err()
}

// OutboxRows is everything queued, oldest first.
func OutboxRows(ctx context.Context) ([]OutboxRow, error) {
	raw, err := rdb.LRange(ctx, "outbox", 0, -1).Result()
	if err != nil {
		return nil, err
	}
	rows := make([]OutboxRow, 0, len(raw))
	for _, text := range raw {
		var row OutboxRow
		if err := json.Unmarshal([]byte(text), &row); err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	return rows, nil
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'calendard/store.h': `// The calendar store, in Redis. A calendar is the hash calendar:{id} (calendar_id, visibility
// "public" or "private") with its members (tenant ids) in the set calendar:{id}:members and its event
// ids in the set calendar:{id}:events. An event is the hash event:{event_id} (every field a string,
// attendees comma-joined). A calendar's instance exceptions are the hash exceptions:{calendar_id}:
// occurrence id -> "cancelled" or "moved:{ISO start}". The outbox is the list outbox of JSON rows
// {"topic", "key", "payload"} a relay publishes later.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>
#include <uuid/uuid.h>

#include <algorithm>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace calendard {

// One event as the store holds it.
struct Event {
  std::string event_id;
  std::string calendar_id;
  std::string tenant;
  std::string title;
  std::string rrule;
  std::string dtstart;
  std::string dtend;
  int64_t revision = 0;
  std::vector<std::string> attendees;
};

inline void to_json(nlohmann::json& j, const Event& e) {
  j = nlohmann::json{{"event_id", e.event_id}, {"calendar_id", e.calendar_id}, {"tenant", e.tenant},
                     {"title", e.title},       {"rrule", e.rrule},             {"dtstart", e.dtstart},
                     {"dtend", e.dtend},       {"revision", e.revision},       {"attendees", e.attendees}};
}

// A calendar; visibility is "public" or "private".
struct CalendarRow {
  std::string calendar_id;
  std::string visibility;
};

inline std::string NewId() {
  uuid_t id;
  uuid_generate(id);
  char text[37];
  uuid_unparse_lower(id, text);
  return text;
}

namespace store {

inline sw::redis::Redis& client() {
  static sw::redis::Redis redis("tcp://redis:6379");
  return redis;
}

inline void PutCalendar(const std::string& calendar_id, const std::string& visibility,
                        const std::vector<std::string>& members = {}) {
  auto tx = client().transaction();
  tx.hset("calendar:" + calendar_id, {std::pair<std::string, std::string>{"calendar_id", calendar_id}, {"visibility", visibility}});
  if (!members.empty()) tx.sadd("calendar:" + calendar_id + ":members", members.begin(), members.end());
  tx.exec();
}

// The calendar, if it exists.
inline std::optional<CalendarRow> GetCalendar(const std::string& calendar_id) {
  std::unordered_map<std::string, std::string> fields = client().hgetall("calendar:" + calendar_id);
  if (fields.empty()) return std::nullopt;
  return CalendarRow{fields["calendar_id"], fields["visibility"]};
}

inline bool IsMember(const std::string& calendar_id, const std::string& tenant) {
  return client().sismember("calendar:" + calendar_id + ":members", tenant);
}

// Commit the event: write its hash and index it under its calendar, in one transaction.
inline void PutEvent(const Event& e) {
  std::string attendees;
  for (const auto& a : e.attendees) attendees += (attendees.empty() ? "" : ",") + a;
  const std::vector<std::pair<std::string, std::string>> row = {
      {"event_id", e.event_id}, {"calendar_id", e.calendar_id}, {"tenant", e.tenant},
      {"title", e.title},       {"rrule", e.rrule},             {"dtstart", e.dtstart},
      {"dtend", e.dtend},       {"revision", std::to_string(e.revision)}, {"attendees", attendees}};
  auto tx = client().transaction();
  tx.hset("event:" + e.event_id, row.begin(), row.end());
  tx.sadd("calendar:" + e.calendar_id + ":events", e.event_id);
  tx.exec();
}

// The event, if the store has it.
inline std::optional<Event> GetEvent(const std::string& event_id) {
  std::unordered_map<std::string, std::string> f = client().hgetall("event:" + event_id);
  if (f.empty()) return std::nullopt;
  Event e{f["event_id"], f["calendar_id"], f["tenant"], f["title"], f["rrule"], f["dtstart"], f["dtend"],
          f["revision"].empty() ? 0 : std::stoll(f["revision"]), {}};
  const std::string& joined = f["attendees"];
  size_t from = 0;
  while (from < joined.size()) {
    const size_t comma = joined.find(',', from);
    const std::string a = joined.substr(from, comma == std::string::npos ? std::string::npos : comma - from);
    if (!a.empty()) e.attendees.push_back(a);
    if (comma == std::string::npos) break;
    from = comma + 1;
  }
  return e;
}

// Every event of the calendar, by event id.
inline std::vector<Event> ListEvents(const std::string& calendar_id) {
  std::vector<std::string> ids = client().smembers("calendar:" + calendar_id + ":events");
  std::sort(ids.begin(), ids.end());
  std::vector<Event> events;
  for (const auto& id : ids) {
    if (auto e = GetEvent(id)) events.push_back(*e);
  }
  return events;
}

inline std::map<std::string, std::string> GetExceptions(const std::string& calendar_id) {
  std::unordered_map<std::string, std::string> fields = client().hgetall("exceptions:" + calendar_id);
  return std::map<std::string, std::string>(fields.begin(), fields.end());
}

inline void PutException(const std::string& calendar_id, const std::string& occurrence_id, const std::string& value) {
  client().hset("exceptions:" + calendar_id, occurrence_id, value);
}

}  // namespace store

namespace outbox {

// Queue a record for the relay to publish later.
inline void Insert(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  store::client().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

// Everything queued, oldest first.
inline std::vector<nlohmann::json> Rows() {
  std::vector<nlohmann::json> rows;
  for (const std::string& row : store::client().lrange("outbox", 0, -1)) rows.push_back(nlohmann::json::parse(row));
  return rows;
}

}  // namespace outbox

}  // namespace calendard
`,
  'calendard/rrule.h': `// Recurrence as calendard counts it. Instants are epoch seconds, ISO-8601 with Z or an offset on the
// wire (ParseInstant / FormatInstant): a datetime without one names no instant. A rule is the
// RFC 5545 subset in kSupportedParts written KEY=VALUE;KEY=VALUE (UNTIL is an ISO-8601 instant here),
// and Expand walks a stored event's rule into the occurrences that overlap a window. This deployment
// keeps no tz database: occurrences repeat at the same UTC time.
#pragma once

#include <nlohmann/json.hpp>

#include <cstdint>
#include <cstdio>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "calendard/store.h"

namespace calendard {

// One instance of an event; occurrence_id is "{event_id}:{epoch start}".
struct Occurrence {
  std::string occurrence_id;
  std::string event_id;
  std::string start;
  std::string end;
  int64_t revision = 0;
};

inline void to_json(nlohmann::json& j, const Occurrence& o) {
  j = nlohmann::json{{"occurrence_id", o.occurrence_id}, {"event_id", o.event_id}, {"start", o.start}, {"end", o.end}, {"revision", o.revision}};
}

inline void from_json(const nlohmann::json& j, Occurrence& o) {
  o.occurrence_id = j.value("occurrence_id", "");
  o.event_id = j.value("event_id", "");
  o.start = j.value("start", "");
  o.end = j.value("end", "");
  o.revision = j.value("revision", static_cast<int64_t>(0));
}

namespace rrule {

inline const std::vector<std::string> kSupportedParts = {"FREQ", "INTERVAL", "COUNT", "UNTIL"};
// FREQ -> seconds between two occurrences at INTERVAL=1.
inline const std::map<std::string, int64_t> kFrequencies = {{"DAILY", 86400}, {"WEEKLY", 7 * 86400}};
constexpr int kMaxCount = 5000;
constexpr int kMaxRangeDays = 90;

// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
inline int64_t DaysFromCivil(int y, int m, int d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<int64_t>(doe) - 719468;
}

// An ISO-8601 instant with Z or an offset (2026-03-10T09:00:00Z, +01:00) as an epoch second.
inline std::optional<int64_t> ParseInstant(const std::string& text) {
  int y, mo, d, h, mi, s = 0;
  int n = 0;
  if (std::sscanf(text.c_str(), "%4d-%2d-%2dT%2d:%2d:%2d%n", &y, &mo, &d, &h, &mi, &s, &n) < 6 || n == 0) return std::nullopt;
  std::string rest = text.substr(static_cast<size_t>(n));
  if (!rest.empty() && rest[0] == '.') {
    size_t i = 1;
    while (i < rest.size() && rest[i] >= '0' && rest[i] <= '9') i++;
    rest = rest.substr(i);
  }
  int64_t offset = 0;
  if (rest == "Z") {
    offset = 0;
  } else if (rest.size() == 6 && (rest[0] == '+' || rest[0] == '-') && rest[3] == ':') {
    const int oh = std::stoi(rest.substr(1, 2));
    const int om = std::stoi(rest.substr(4, 2));
    offset = (oh * 60 + om) * (rest[0] == '-' ? -60 : 60);
  } else {
    return std::nullopt;
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s > 60) return std::nullopt;
  return DaysFromCivil(y, mo, d) * 86400 + h * 3600 + mi * 60 + s - offset;
}

inline std::string FormatInstant(int64_t instant) {
  int64_t z = (instant >= 0 ? instant / 86400 : (instant - 86399) / 86400);
  const int64_t rest = instant - z * 86400;
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  const unsigned day = doy - (153 * mp + 2) / 5 + 1;
  const unsigned month = mp < 10 ? mp + 3 : mp - 9;
  const int64_t year = static_cast<int64_t>(yoe) + era * 400 + (month <= 2);
  char out[32];
  std::snprintf(out, sizeof out, "%04d-%02u-%02uT%02d:%02d:%02dZ", static_cast<int>(year), month, day,
                static_cast<int>(rest / 3600), static_cast<int>(rest % 3600 / 60), static_cast<int>(rest % 60));
  return out;
}

// The parts of a rule as written: "FREQ=DAILY;COUNT=3" -> {FREQ: DAILY, COUNT: 3}. A chunk without "="
// is a key with an empty value; an empty rule has no parts.
inline std::map<std::string, std::string> RuleParts(const std::string& rule) {
  std::map<std::string, std::string> parts;
  size_t from = 0;
  while (from <= rule.size()) {
    const size_t semi = rule.find(';', from);
    const std::string chunk = rule.substr(from, semi == std::string::npos ? std::string::npos : semi - from);
    if (!chunk.empty()) {
      const size_t eq = chunk.find('=');
      if (eq == std::string::npos) parts[chunk] = "";
      else parts[chunk.substr(0, eq)] = chunk.substr(eq + 1);
    }
    if (semi == std::string::npos) break;
    from = semi + 1;
  }
  return parts;
}

// The stored form of a rule: its parts in kSupportedParts order. A part outside kSupportedParts is not written.
inline std::string FormatRule(const std::map<std::string, std::string>& parts) {
  std::string out;
  for (const auto& key : kSupportedParts) {
    const auto it = parts.find(key);
    if (it == parts.end()) continue;
    if (!out.empty()) out += ";";
    out += key + "=" + it->second;
  }
  return out;
}

// The occurrences of a stored event that overlap [window_start, window_end), earliest first. An empty
// rule occurs once. The walk stops at COUNT, at UNTIL or at the window's end.
inline std::vector<Occurrence> Expand(const Event& e, int64_t window_start, int64_t window_end) {
  const int64_t first = ParseInstant(e.dtstart).value_or(0);
  const int64_t duration = ParseInstant(e.dtend).value_or(0) - first;
  auto parts = RuleParts(e.rrule);
  if (parts.empty()) parts = {{"FREQ", "DAILY"}, {"COUNT", "1"}};
  const auto freq = kFrequencies.find(parts["FREQ"]);
  const int64_t interval = parts.count("INTERVAL") ? std::stoll(parts["INTERVAL"]) : 1;
  const int64_t step = (freq == kFrequencies.end() ? 0 : freq->second) * interval;
  const int64_t limit = parts.count("COUNT") ? std::stoll(parts["COUNT"]) : -1;
  const std::optional<int64_t> until = parts.count("UNTIL") ? ParseInstant(parts["UNTIL"]) : std::nullopt;
  std::vector<Occurrence> occurrences;
  for (int64_t n = 0; limit < 0 || n < limit; n++) {
    const int64_t start = first + n * step;
    if (start >= window_end || (until && start > *until)) break;
    if (start + duration > window_start) {
      occurrences.push_back({e.event_id + ":" + std::to_string(start), e.event_id, FormatInstant(start),
                             FormatInstant(start + duration), e.revision});
    }
  }
  return occurrences;
}

}  // namespace rrule

}  // namespace calendard
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('calendard', 'Rrule')]: `package calendard

import java.time.{Instant, OffsetDateTime, ZoneOffset}
import java.time.format.{DateTimeFormatter, DateTimeParseException}

import scala.collection.immutable.ListMap

import spray.json._
import spray.json.DefaultJsonProtocol._

/** One instance of an event; occurrence_id is "{event_id}:{epoch start}". */
final case class Occurrence(occurrence_id: String, event_id: String, start: String, end: String, revision: Long)

object Occurrence {
  implicit val format: RootJsonFormat[Occurrence] = jsonFormat5(Occurrence.apply)
}

/**
 * Recurrence as calendard counts it. Instants are epoch seconds, ISO-8601 with Z or an offset on the
 * wire (parseInstant / formatInstant): a datetime without one names no instant. A rule is the
 * RFC 5545 subset in SupportedParts written KEY=VALUE;KEY=VALUE (UNTIL is an ISO-8601 instant here),
 * and expand walks a stored event's rule into the occurrences that overlap a window. The other
 * runtimes keep no tz database: occurrences repeat at the same UTC time.
 */
object Rrule {
  val SupportedParts: Seq[String] = Seq("FREQ", "INTERVAL", "COUNT", "UNTIL")

  /** FREQ -> seconds between two occurrences at INTERVAL=1. */
  val Frequencies: Map[String, Long] = Map("DAILY" -> 86400L, "WEEKLY" -> 7 * 86400L)
  val MaxCount = 5000
  val MaxRangeDays = 90

  /** An ISO-8601 instant with Z or an offset (2026-03-10T09:00:00Z, +01:00) as an epoch second. */
  def parseInstant(text: String): Option[Long] =
    try Some(OffsetDateTime.parse(text).toEpochSecond)
    catch { case _: DateTimeParseException | _: NullPointerException => None }

  def formatInstant(instant: Long): String =
    DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").format(Instant.ofEpochSecond(instant).atOffset(ZoneOffset.UTC))

  /**
   * The parts of a rule as written: "FREQ=DAILY;COUNT=3" -> FREQ -> DAILY, COUNT -> 3. A chunk without
   * "=" is a key with an empty value; an empty rule has no parts.
   */
  def ruleParts(rule: String): ListMap[String, String] =
    ListMap(rule.split(";").toSeq.filter(_.nonEmpty).map { chunk =>
      val at = chunk.indexOf('=')
      if (at < 0) chunk -> "" else chunk.substring(0, at) -> chunk.substring(at + 1)
    }: _*)

  /** The stored form of a rule: its parts in SupportedParts order. A part outside SupportedParts is not written. */
  def formatRule(parts: Map[String, String]): String =
    SupportedParts.filter(parts.contains).map(key => s"$key=\${parts(key)}").mkString(";")

  /**
   * The occurrences of a stored event that overlap [windowStart, windowEnd), earliest first. An empty
   * rule occurs once. The walk stops at COUNT, at UNTIL or at the window's end.
   */
  def expand(event: Event, windowStart: Long, windowEnd: Long): Seq[Occurrence] = {
    val first = parseInstant(event.dtstart).getOrElse(0L)
    val duration = parseInstant(event.dtend).getOrElse(0L) - first
    val written = ruleParts(event.rrule)
    val parts: Map[String, String] = if (written.isEmpty) Map("FREQ" -> "DAILY", "COUNT" -> "1") else written
    val step = Frequencies.getOrElse(parts.getOrElse("FREQ", ""), 0L) * parts.get("INTERVAL").map(_.toLong).getOrElse(1L)
    val limit = parts.get("COUNT").map(_.toLong)
    val until = parts.get("UNTIL").flatMap(parseInstant)
    val out = Seq.newBuilder[Occurrence]
    var n = 0L
    var walking = true
    while (walking && limit.forall(n < _)) {
      val start = first + n * step
      if (start >= windowEnd || until.exists(start > _)) walking = false
      else {
        if (start + duration > windowStart)
          out += Occurrence(s"\${event.event_id}:$start", event.event_id, formatInstant(start), formatInstant(start + duration), event.revision)
        n += 1
      }
    }
    out.result()
  }
}
`,
  [scalaPath('calendard', 'Store')]: `package calendard

import java.util.UUID

import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

/** One event as the store holds it. */
final case class Event(
    event_id: String,
    calendar_id: String,
    tenant: String,
    title: String,
    rrule: String,
    dtstart: String,
    dtend: String,
    revision: Long,
    attendees: Seq[String]
)

object Event {
  implicit val format: RootJsonFormat[Event] = jsonFormat9(Event.apply)
}

/** A calendar; visibility is "public" or "private". */
final case class CalendarRow(calendar_id: String, visibility: String)

/**
 * The calendar store, in Redis. A calendar is the hash calendar:{id} (calendar_id, visibility "public"
 * or "private") with its members (tenant ids) in the set calendar:{id}:members and its event ids in the
 * set calendar:{id}:events. An event is the hash event:{event_id} (every field a string, attendees
 * comma-joined). A calendar's instance exceptions are the hash exceptions:{calendar_id}: occurrence id
 * -> "cancelled" or "moved:{ISO start}". The outbox is the list outbox of JSON rows {"topic", "key",
 * "payload"} a relay publishes later.
 */
object Store {
  val jedis = new JedisPooled("redis", 6379)

  def newId(): String = UUID.randomUUID().toString

  def putCalendar(calendarId: String, visibility: String, members: Seq[String] = Seq.empty): Unit = {
    val tx = jedis.multi()
    tx.hset(s"calendar:$calendarId", Map("calendar_id" -> calendarId, "visibility" -> visibility).asJava)
    if (members.nonEmpty) tx.sadd(s"calendar:$calendarId:members", members: _*)
    tx.exec()
  }

  /** The calendar, if it exists. */
  def getCalendar(calendarId: String): Option[CalendarRow] = {
    val f = jedis.hgetAll(s"calendar:$calendarId").asScala
    if (f.isEmpty) None else Some(CalendarRow(f.getOrElse("calendar_id", ""), f.getOrElse("visibility", "")))
  }

  def isMember(calendarId: String, tenant: String): Boolean = jedis.sismember(s"calendar:$calendarId:members", tenant)

  /** Commit the event: write its hash and index it under its calendar, in one transaction. */
  def putEvent(e: Event): Unit = {
    val row = Map(
      "event_id" -> e.event_id,
      "calendar_id" -> e.calendar_id,
      "tenant" -> e.tenant,
      "title" -> e.title,
      "rrule" -> e.rrule,
      "dtstart" -> e.dtstart,
      "dtend" -> e.dtend,
      "revision" -> e.revision.toString,
      "attendees" -> e.attendees.mkString(",")
    )
    val tx = jedis.multi()
    tx.hset(s"event:\${e.event_id}", row.asJava)
    tx.sadd(s"calendar:\${e.calendar_id}:events", e.event_id)
    tx.exec()
  }

  /** The event, if the store has it. */
  def getEvent(eventId: String): Option[Event] = {
    val f = jedis.hgetAll(s"event:$eventId").asScala
    if (f.isEmpty) None
    else
      Some(
        Event(
          f.getOrElse("event_id", ""),
          f.getOrElse("calendar_id", ""),
          f.getOrElse("tenant", ""),
          f.getOrElse("title", ""),
          f.getOrElse("rrule", ""),
          f.getOrElse("dtstart", ""),
          f.getOrElse("dtend", ""),
          f.get("revision").map(_.toLong).getOrElse(0L),
          f.getOrElse("attendees", "").split(",").toSeq.filter(_.nonEmpty)
        )
      )
  }

  /** Every event of the calendar, by event id. */
  def listEvents(calendarId: String): Seq[Event] =
    jedis.smembers(s"calendar:$calendarId:events").asScala.toSeq.sorted.flatMap(getEvent)

  def getExceptions(calendarId: String): Map[String, String] = jedis.hgetAll(s"exceptions:$calendarId").asScala.toMap

  def putException(calendarId: String, occurrenceId: String, value: String): Unit =
    jedis.hset(s"exceptions:$calendarId", occurrenceId, value)

  /** Queue a record for the relay to publish later. */
  def insertOutbox(topic: String, key: String, payload: JsValue): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)

  /** Everything queued, oldest first. */
  def outboxRows(): Seq[JsValue] = jedis.lrange("outbox", 0, -1).asScala.toSeq.map(_.parseJson)
}
`,
};
