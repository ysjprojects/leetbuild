/**
 * Hand-written support modules every step of the booking engine imports but no step builds: the
 * `booking` package. `tz` is time as the service counts it (epoch seconds, ISO-8601 on the wire, the
 * zones this deployment serves with their daylight-saving rules), `slots` the slot grid and the Redis
 * keys of the hold map, `store` the booking store and the outbox (Redis-backed) and `new_id`. The
 * five languages compute the same numbers from the same inputs, so a slot field name or a zone offset
 * is the same whichever runtime a check runs in.
 */
import {scalaPath} from '../scala-support';

export const supportModulesPy: Record<string, string> = {
  'booking/__init__.py': '',
  'booking/tz.py': `"""
Time as the booking engine counts it: instants are epoch seconds, ISO-8601 on the wire
(\`parse_instant\` / \`format_instant\`), and the zones this deployment serves are the table below with
their daylight-saving rules (the current rules, applied to every year). The runtime has no tz
database, so this table is the one source of truth, the same in every language.
"""
from datetime import date, datetime, timezone

RESOURCE_TIMEZONE = "Europe/Berlin"

# zone -> (standard offset in minutes, daylight offset in minutes, rule). Rule "eu": daylight from the
# last Sunday of March 01:00 UTC to the last Sunday of October 01:00 UTC; "us": from the second Sunday
# of March 02:00 local to the first Sunday of November 02:00 local; None: no daylight saving.
ZONES: dict[str, tuple[int, int, str | None]] = {
    "UTC": (0, 0, None),
    "Europe/London": (0, 60, "eu"),
    "Europe/Berlin": (60, 120, "eu"),
    "America/New_York": (-300, -240, "us"),
    "Asia/Kolkata": (330, 330, None),
    "Asia/Tokyo": (540, 540, None),
}


def zone_known(name: str) -> bool:
    return name in ZONES


def utc(year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> int:
    """The epoch second of a UTC wall time."""
    return int(datetime(year, month, day, hour, minute, tzinfo=timezone.utc).timestamp())


def _sunday(year: int, month: int, n: int) -> int:
    """The day of month of the n-th Sunday (n = -1: the last)."""
    if n < 0:
        last = (date(year + (month == 12), month % 12 + 1, 1) - date(year, month, 1)).days
        return last - (date(year, month, last).weekday() + 1) % 7
    first = 1 + (6 - date(year, month, 1).weekday()) % 7
    return first + 7 * (n - 1)


def _daylight(zone: str, year: int) -> tuple[int, int]:
    """The instants daylight time starts and ends in \`year\`, for a zone with a rule."""
    std, dst, rule = ZONES[zone]
    if rule == "eu":
        return utc(year, 3, _sunday(year, 3, -1), 1), utc(year, 10, _sunday(year, 10, -1), 1)
    return utc(year, 3, _sunday(year, 3, 2), 2) - std * 60, utc(year, 11, _sunday(year, 11, 1), 2) - dst * 60


def utc_offset_minutes(zone: str, instant: int) -> int:
    """How far the zone's wall clock is ahead of UTC at \`instant\`."""
    std, dst, rule = ZONES[zone]
    if rule is None:
        return std
    start, end = _daylight(zone, datetime.fromtimestamp(instant, timezone.utc).year)
    return dst if start <= instant < end else std


def local_time(zone: str, year: int, month: int, day: int, hour: int = 0, minute: int = 0) -> int:
    """The instant at which the zone's wall clock reads year-month-day hour:minute."""
    wall = utc(year, month, day, hour, minute)
    guess = wall - utc_offset_minutes(zone, wall) * 60
    return wall - utc_offset_minutes(zone, guess) * 60


def parse_instant(text: str) -> int | None:
    """An ISO-8601 instant with an offset (2026-03-10T09:00:00Z, +01:00) as an epoch second; None otherwise."""
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        return None
    return int(parsed.timestamp())


def format_instant(instant: int) -> str:
    return datetime.fromtimestamp(instant, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_date(text: str) -> tuple[int, int, int] | None:
    """A calendar date YYYY-MM-DD as (year, month, day); None otherwise."""
    try:
        parsed = date.fromisoformat(text)
    except (TypeError, ValueError):
        return None
    return parsed.year, parsed.month, parsed.day


def days_between(a: tuple[int, int, int], b: tuple[int, int, int]) -> int:
    """Calendar days from date a to date b (negative when b is earlier)."""
    return (date(*b) - date(*a)).days
`,
  'booking/slots.py': `"""
The slot grid and the hold map's keys. A resource's day is 30-minute slots from OPEN_HOUR to
CLOSE_HOUR in the resolved zone; a slot's field name in \`resource:{id}:slots\` is its start as an
epoch minute, so the booking path and the availability read name the same slot the same way.
"""
from .tz import local_time

SLOT_MINUTES = 30
HOLD_TTL_S = 900  # the payment window: an abandoned checkout frees its slots after 15 minutes
MAX_HORIZON_DAYS = 90
OPEN_HOUR = 8
CLOSE_HOUR = 20


def slots_key(resource_id: str) -> str:
    return f"resource:{resource_id}:slots"


def hold_key(hold_id: str) -> str:
    return f"hold:{hold_id}"


def slot_fields(start: int, end: int) -> list[str]:
    """The field of every slot the range [start, end) touches, in order."""
    first = start // 60 // SLOT_MINUTES * SLOT_MINUTES
    return [str(minute) for minute in range(first, end // 60, SLOT_MINUTES) if minute * 60 < end]


def day_fields(zone: str, year: int, month: int, day: int) -> list[str]:
    """The fields of the resource's bookable slots on one calendar day of the zone."""
    opening = local_time(zone, year, month, day, OPEN_HOUR) // 60
    return [str(opening + k * SLOT_MINUTES) for k in range((CLOSE_HOUR - OPEN_HOUR) * 60 // SLOT_MINUTES)]
`,
  'booking/store.py': `"""
The booking store and the outbox, in Redis: a booking is the hash \`booking:{booking_id}\` (every
field a string: booking_id, tenant, resource_id, start, end, hold_id, idempotency_key, state,
event_id), \`idem:{tenant}:{key}\` points a tenant's Idempotency-Key at its booking, and the outbox is
the list \`outbox\` of JSON rows {"topic", "key", "payload"} a relay publishes later.
"""
import json
import uuid

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def new_id() -> str:
    return str(uuid.uuid4())


class BookingStore:
    def get(self, booking_id: str) -> dict | None:
        """The booking, or None."""
        fields = r.hgetall(f"booking:{booking_id}")
        return fields or None

    def get_by_key(self, tenant: str, idempotency_key: str) -> dict | None:
        """The booking a tenant's Idempotency-Key was first used for, or None."""
        booking_id = r.get(f"idem:{tenant}:{idempotency_key}")
        return self.get(booking_id) if booking_id else None

    def put(self, booking: dict) -> None:
        """Commit the booking: write it and index it under its idempotency key."""
        row = {field: str(value) for field, value in booking.items()}
        row.setdefault("event_id", "")
        pipe = r.pipeline()
        pipe.hset(f"booking:{row['booking_id']}", mapping=row)
        pipe.set(f"idem:{row['tenant']}:{row['idempotency_key']}", row["booking_id"])
        pipe.execute()

    def set_state(self, booking_id: str, state: str, event_id: str | None = None) -> None:
        fields = {"state": state}
        if event_id is not None:
            fields["event_id"] = event_id
        r.hset(f"booking:{booking_id}", mapping=fields)


class Outbox:
    def insert(self, topic: str, key: str, payload: dict) -> None:
        r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))

    def rows(self) -> list[dict]:
        return [json.loads(row) for row in r.lrange("outbox", 0, -1)]


store = BookingStore()
outbox = Outbox()
`,
};

export const supportModulesTs: Record<string, string> = {
  'booking/tz.ts': `/**
 * Time as the booking engine counts it: instants are epoch seconds, ISO-8601 on the wire
 * (\`parseInstant\` / \`formatInstant\`), and the zones this deployment serves are the table below with
 * their daylight-saving rules (the current rules, applied to every year). The runtime has no tz
 * database, so this table is the one source of truth, the same in every language.
 */
export const RESOURCE_TIMEZONE = 'Europe/Berlin';

export type Rule = 'eu' | 'us' | null;

/**
 * zone → [standard offset in minutes, daylight offset in minutes, rule]. Rule "eu": daylight from the
 * last Sunday of March 01:00 UTC to the last Sunday of October 01:00 UTC; "us": from the second Sunday
 * of March 02:00 local to the first Sunday of November 02:00 local; null: no daylight saving.
 */
export const ZONES: Record<string, [number, number, Rule]> = {
  UTC: [0, 0, null],
  'Europe/London': [0, 60, 'eu'],
  'Europe/Berlin': [60, 120, 'eu'],
  'America/New_York': [-300, -240, 'us'],
  'Asia/Kolkata': [330, 330, null],
  'Asia/Tokyo': [540, 540, null],
};

export const zoneKnown = (name: string): boolean => Object.prototype.hasOwnProperty.call(ZONES, name);

/** The epoch second of a UTC wall time. */
export const utc = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  Math.floor(Date.UTC(year, month - 1, day, hour, minute) / 1000);

/** The day of month of the n-th Sunday (n = -1: the last). */
const sunday = (year: number, month: number, n: number): number => {
  if (n < 0) {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return last - new Date(Date.UTC(year, month - 1, last)).getUTCDay();
  }
  const first = 1 + ((7 - new Date(Date.UTC(year, month - 1, 1)).getUTCDay()) % 7);
  return first + 7 * (n - 1);
};

/** The instants daylight time starts and ends in \`year\`, for a zone with a rule. */
const daylight = (zone: string, year: number): [number, number] => {
  const [std, dst, rule] = ZONES[zone];
  if (rule === 'eu') return [utc(year, 3, sunday(year, 3, -1), 1), utc(year, 10, sunday(year, 10, -1), 1)];
  return [utc(year, 3, sunday(year, 3, 2), 2) - std * 60, utc(year, 11, sunday(year, 11, 1), 2) - dst * 60];
};

/** How far the zone's wall clock is ahead of UTC at \`instant\`. */
export const utcOffsetMinutes = (zone: string, instant: number): number => {
  const [std, dst, rule] = ZONES[zone];
  if (rule === null) return std;
  const [start, end] = daylight(zone, new Date(instant * 1000).getUTCFullYear());
  return start <= instant && instant < end ? dst : std;
};

/** The instant at which the zone's wall clock reads year-month-day hour:minute. */
export const localTime = (zone: string, year: number, month: number, day: number, hour = 0, minute = 0): number => {
  const wall = utc(year, month, day, hour, minute);
  const guess = wall - utcOffsetMinutes(zone, wall) * 60;
  return wall - utcOffsetMinutes(zone, guess) * 60;
};

/** An ISO-8601 instant with an offset (2026-03-10T09:00:00Z, +01:00) as an epoch second; null otherwise. */
export const parseInstant = (text: string): number | null => {
  if (typeof text !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:\\d{2})$/.test(text)) return null;
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
};

export const formatInstant = (instant: number): string => new Date(instant * 1000).toISOString().replace(/\\.\\d{3}Z$/, 'Z');

/** A calendar date YYYY-MM-DD as [year, month, day]; null otherwise. */
export const parseDate = (text: string): [number, number, number] | null => {
  const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(typeof text === 'string' ? text : '');
  if (m === null) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return [year, month, day];
};

/** Calendar days from date a to date b (negative when b is earlier). */
export const daysBetween = (a: [number, number, number], b: [number, number, number]): number =>
  Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86_400_000);
`,
  'booking/slots.ts': `/**
 * The slot grid and the hold map's keys. A resource's day is 30-minute slots from OPEN_HOUR to
 * CLOSE_HOUR in the resolved zone; a slot's field name in \`resource:{id}:slots\` is its start as an
 * epoch minute, so the booking path and the availability read name the same slot the same way.
 */
import {localTime} from 'booking/tz';

export const SLOT_MINUTES = 30;
/** The payment window: an abandoned checkout frees its slots after 15 minutes. */
export const HOLD_TTL_S = 900;
export const MAX_HORIZON_DAYS = 90;
export const OPEN_HOUR = 8;
export const CLOSE_HOUR = 20;

export const slotsKey = (resourceId: string): string => \`resource:\${resourceId}:slots\`;
export const holdKey = (holdId: string): string => \`hold:\${holdId}\`;

/** The field of every slot the range [start, end) touches, in order. */
export const slotFields = (start: number, end: number): string[] => {
  const fields: string[] = [];
  const first = Math.floor(Math.floor(start / 60) / SLOT_MINUTES) * SLOT_MINUTES;
  for (let minute = first; minute * 60 < end; minute += SLOT_MINUTES) fields.push(String(minute));
  return fields;
};

/** The fields of the resource's bookable slots on one calendar day of the zone. */
export const dayFields = (zone: string, year: number, month: number, day: number): string[] => {
  const opening = Math.floor(localTime(zone, year, month, day, OPEN_HOUR) / 60);
  const fields: string[] = [];
  for (let k = 0; k < ((CLOSE_HOUR - OPEN_HOUR) * 60) / SLOT_MINUTES; k += 1) fields.push(String(opening + k * SLOT_MINUTES));
  return fields;
};
`,
  'booking/store.ts': `/**
 * The booking store and the outbox, in Redis: a booking is the hash \`booking:{booking_id}\` (every
 * field a string), \`idem:{tenant}:{key}\` points a tenant's Idempotency-Key at its booking, and the
 * outbox is the list \`outbox\` of JSON rows {"topic", "key", "payload"} a relay publishes later.
 */
import {randomUUID} from 'node:crypto';

import Redis from 'ioredis';

export interface Booking {
  booking_id: string;
  tenant: string;
  resource_id: string;
  start: string;
  end: string;
  hold_id: string;
  idempotency_key: string;
  /** held, confirmed, rejected, cancelled or sync_unknown. */
  state: string;
  event_id: string;
}

const redis = new Redis({host: 'redis', port: 6379});

export const newId = (): string => randomUUID();

export const store = {
  /** The booking, or null. */
  async get(bookingId: string): Promise<Booking | null> {
    const fields = await redis.hgetall(\`booking:\${bookingId}\`);
    return Object.keys(fields).length === 0 ? null : (fields as unknown as Booking);
  },
  /** The booking a tenant's Idempotency-Key was first used for, or null. */
  async getByKey(tenant: string, idempotencyKey: string): Promise<Booking | null> {
    const bookingId = await redis.get(\`idem:\${tenant}:\${idempotencyKey}\`);
    return bookingId === null ? null : store.get(bookingId);
  },
  /** Commit the booking: write it and index it under its idempotency key; rejects when Redis refused either write. */
  async put(booking: Booking): Promise<void> {
    const replies = await redis
      .multi()
      .hset(\`booking:\${booking.booking_id}\`, {...booking, event_id: booking.event_id ?? ''})
      .set(\`idem:\${booking.tenant}:\${booking.idempotency_key}\`, booking.booking_id)
      .exec();
    const failed = replies?.find(([err]) => err !== null)?.[0];
    if (failed) throw failed;
  },
  async setState(bookingId: string, state: string, eventId?: string): Promise<void> {
    await redis.hset(\`booking:\${bookingId}\`, eventId === undefined ? {state} : {state, event_id: eventId});
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
  'booking/tz/tz.go': `// Package tz is time as the booking engine counts it: instants are epoch seconds, ISO-8601 on the
// wire (ParseInstant / FormatInstant), and the zones this deployment serves are the table below with
// their daylight-saving rules (the current rules, applied to every year). The runtime has no tz
// database, so this table is the one source of truth, the same in every language.
package tz

import "time"

const ResourceTimezone = "Europe/Berlin"

// Zone is a zone's standard and daylight offsets in minutes and its rule: "eu" (daylight from the
// last Sunday of March 01:00 UTC to the last Sunday of October 01:00 UTC), "us" (from the second
// Sunday of March 02:00 local to the first Sunday of November 02:00 local) or "" (none).
type Zone struct {
	Std, Dst int
	Rule     string
}

var Zones = map[string]Zone{
	"UTC":              {0, 0, ""},
	"Europe/London":    {0, 60, "eu"},
	"Europe/Berlin":    {60, 120, "eu"},
	"America/New_York": {-300, -240, "us"},
	"Asia/Kolkata":     {330, 330, ""},
	"Asia/Tokyo":       {540, 540, ""},
}

func Known(name string) bool {
	_, ok := Zones[name]
	return ok
}

// UTC is the epoch second of a UTC wall time.
func UTC(year, month, day, hour, minute int) int64 {
	return time.Date(year, time.Month(month), day, hour, minute, 0, 0, time.UTC).Unix()
}

// sunday is the day of month of the n-th Sunday (n = -1: the last).
func sunday(year, month, n int) int {
	if n < 0 {
		last := time.Date(year, time.Month(month)+1, 0, 0, 0, 0, 0, time.UTC)
		return last.Day() - int(last.Weekday())
	}
	first := 1 + (7-int(time.Date(year, time.Month(month), 1, 0, 0, 0, 0, time.UTC).Weekday()))%7
	return first + 7*(n-1)
}

// daylight is the instants daylight time starts and ends in year, for a zone with a rule.
func daylight(z Zone, year int) (int64, int64) {
	if z.Rule == "eu" {
		return UTC(year, 3, sunday(year, 3, -1), 1, 0), UTC(year, 10, sunday(year, 10, -1), 1, 0)
	}
	return UTC(year, 3, sunday(year, 3, 2), 2, 0) - int64(z.Std)*60, UTC(year, 11, sunday(year, 11, 1), 2, 0) - int64(z.Dst)*60
}

// OffsetMinutes is how far the zone's wall clock is ahead of UTC at instant.
func OffsetMinutes(zone string, instant int64) int {
	z := Zones[zone]
	if z.Rule == "" {
		return z.Std
	}
	start, end := daylight(z, time.Unix(instant, 0).UTC().Year())
	if start <= instant && instant < end {
		return z.Dst
	}
	return z.Std
}

// LocalTime is the instant at which the zone's wall clock reads year-month-day hour:minute.
func LocalTime(zone string, year, month, day, hour, minute int) int64 {
	wall := UTC(year, month, day, hour, minute)
	guess := wall - int64(OffsetMinutes(zone, wall))*60
	return wall - int64(OffsetMinutes(zone, guess))*60
}

// ParseInstant reads an ISO-8601 instant with an offset (2026-03-10T09:00:00Z, +01:00) as an epoch second.
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

// Date is a calendar date.
type Date struct{ Year, Month, Day int }

// ParseDate reads YYYY-MM-DD.
func ParseDate(text string) (Date, bool) {
	t, err := time.Parse("2006-01-02", text)
	if err != nil {
		return Date{}, false
	}
	return Date{t.Year(), int(t.Month()), t.Day()}, true
}

// DaysBetween counts calendar days from a to b (negative when b is earlier).
func DaysBetween(a, b Date) int {
	return int((UTC(b.Year, b.Month, b.Day, 0, 0) - UTC(a.Year, a.Month, a.Day, 0, 0)) / 86400)
}
`,
  'booking/slots/slots.go': `// Package slots is the slot grid and the hold map's keys. A resource's day is 30-minute slots from
// OpenHour to CloseHour in the resolved zone; a slot's field name in resource:{id}:slots is its start
// as an epoch minute, so the booking path and the availability read name the same slot the same way.
package slots

import (
	"strconv"

	"booking/tz"
)

const (
	SlotMinutes    = 30
	HoldTTLS       = 900 // the payment window: an abandoned checkout frees its slots after 15 minutes
	MaxHorizonDays = 90
	OpenHour       = 8
	CloseHour      = 20
)

func Key(resourceID string) string { return "resource:" + resourceID + ":slots" }

func HoldKey(holdID string) string { return "hold:" + holdID }

// Fields is the field of every slot the range [start, end) touches, in order.
func Fields(start, end int64) []string {
	var fields []string
	first := start / 60 / SlotMinutes * SlotMinutes
	for minute := first; minute*60 < end; minute += SlotMinutes {
		fields = append(fields, strconv.FormatInt(minute, 10))
	}
	return fields
}

// DayFields is the fields of the resource's bookable slots on one calendar day of the zone.
func DayFields(zone string, year, month, day int) []string {
	opening := tz.LocalTime(zone, year, month, day, OpenHour, 0) / 60
	var fields []string
	for k := 0; k < (CloseHour-OpenHour)*60/SlotMinutes; k++ {
		fields = append(fields, strconv.FormatInt(opening+int64(k*SlotMinutes), 10))
	}
	return fields
}
`,
  'booking/store/store.go': `// Package store is the booking store and the outbox, in Redis: a booking is the hash
// booking:{booking_id} (every field a string), idem:{tenant}:{key} points a tenant's Idempotency-Key
// at its booking, and the outbox is the list outbox of JSON rows {"topic", "key", "payload"} a relay
// publishes later.
package store

import (
	"context"
	"encoding/json"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Booking is one booking as the store holds it; State is held, confirmed, rejected, cancelled or sync_unknown.
type Booking struct {
	BookingID      string \`json:"booking_id"\`
	Tenant         string \`json:"tenant"\`
	ResourceID     string \`json:"resource_id"\`
	Start          string \`json:"start"\`
	End            string \`json:"end"\`
	HoldID         string \`json:"hold_id"\`
	IdempotencyKey string \`json:"idempotency_key"\`
	State          string \`json:"state"\`
	EventID        string \`json:"event_id"\`
}

func NewID() string { return uuid.NewString() }

// Hold is what takeHold (step 2) hands back for a range it holds.
type Hold struct {
	HoldID    string \`json:"hold_id"\`
	ExpiresIn int    \`json:"expires_in"\`
}

func fromFields(fields map[string]string) *Booking {
	return &Booking{
		BookingID:      fields["booking_id"],
		Tenant:         fields["tenant"],
		ResourceID:     fields["resource_id"],
		Start:          fields["start"],
		End:            fields["end"],
		HoldID:         fields["hold_id"],
		IdempotencyKey: fields["idempotency_key"],
		State:          fields["state"],
		EventID:        fields["event_id"],
	}
}

// Get is the booking, or nil.
func Get(ctx context.Context, bookingID string) (*Booking, error) {
	fields, err := rdb.HGetAll(ctx, "booking:"+bookingID).Result()
	if err != nil || len(fields) == 0 {
		return nil, err
	}
	return fromFields(fields), nil
}

// GetByKey is the booking a tenant's Idempotency-Key was first used for, or nil.
func GetByKey(ctx context.Context, tenant, idempotencyKey string) (*Booking, error) {
	bookingID, err := rdb.Get(ctx, "idem:"+tenant+":"+idempotencyKey).Result()
	if err == redis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return Get(ctx, bookingID)
}

// Put commits the booking: writes it and indexes it under its idempotency key.
func Put(ctx context.Context, b *Booking) error {
	pipe := rdb.TxPipeline()
	pipe.HSet(ctx, "booking:"+b.BookingID, map[string]any{
		"booking_id": b.BookingID, "tenant": b.Tenant, "resource_id": b.ResourceID, "start": b.Start, "end": b.End,
		"hold_id": b.HoldID, "idempotency_key": b.IdempotencyKey, "state": b.State, "event_id": b.EventID,
	})
	pipe.Set(ctx, "idem:"+b.Tenant+":"+b.IdempotencyKey, b.BookingID, 0)
	_, err := pipe.Exec(ctx)
	return err
}

// SetState records the booking's state, and its calendar event id when eventID is not "".
func SetState(ctx context.Context, bookingID, state, eventID string) error {
	fields := map[string]any{"state": state}
	if eventID != "" {
		fields["event_id"] = eventID
	}
	return rdb.HSet(ctx, "booking:"+bookingID, fields).Err()
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
  'booking/tz.h': `// Time as the booking engine counts it: instants are epoch seconds, ISO-8601 on the wire
// (ParseInstant / FormatInstant), and the zones this deployment serves are the table below with
// their daylight-saving rules (the current rules, applied to every year). The runtime has no tz
// database, so this table is the one source of truth, the same in every language.
#pragma once

#include <cstdint>
#include <cstdio>
#include <map>
#include <optional>
#include <string>

namespace booking::tz {

inline const std::string kResourceTimezone = "Europe/Berlin";

// A zone's standard and daylight offsets in minutes and its rule: "eu" (daylight from the last Sunday
// of March 01:00 UTC to the last Sunday of October 01:00 UTC), "us" (from the second Sunday of March
// 02:00 local to the first Sunday of November 02:00 local) or "" (none).
struct Zone {
  int std;
  int dst;
  std::string rule;
};

inline const std::map<std::string, Zone> kZones = {
    {"UTC", {0, 0, ""}},
    {"Europe/London", {0, 60, "eu"}},
    {"Europe/Berlin", {60, 120, "eu"}},
    {"America/New_York", {-300, -240, "us"}},
    {"Asia/Kolkata", {330, 330, ""}},
    {"Asia/Tokyo", {540, 540, ""}},
};

inline bool Known(const std::string& name) { return kZones.count(name) > 0; }

struct Date {
  int year;
  int month;
  int day;
};

// Days since 1970-01-01 of a civil date (Howard Hinnant's algorithm).
inline int64_t DaysFromCivil(int y, int m, int d) {
  y -= m <= 2;
  const int64_t era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + static_cast<int64_t>(doe) - 719468;
}

// The civil date of a day count since 1970-01-01.
inline Date CivilFromDays(int64_t z) {
  z += 719468;
  const int64_t era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const int64_t y = static_cast<int64_t>(yoe) + era * 400;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  const unsigned d = doy - (153 * mp + 2) / 5 + 1;
  const unsigned m = mp < 10 ? mp + 3 : mp - 9;
  return {static_cast<int>(y + (m <= 2)), static_cast<int>(m), static_cast<int>(d)};
}

// The epoch second of a UTC wall time.
inline int64_t UTC(int year, int month, int day, int hour = 0, int minute = 0) {
  return DaysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60;
}

// The weekday of a civil date, Sunday = 0.
inline int Weekday(int year, int month, int day) {
  const int64_t days = DaysFromCivil(year, month, day);
  return static_cast<int>(((days % 7) + 11) % 7);
}

// The day of month of the n-th Sunday (n = -1: the last).
inline int Sunday(int year, int month, int n) {
  if (n < 0) {
    const int next_year = month == 12 ? year + 1 : year;
    const int next_month = month == 12 ? 1 : month + 1;
    const int last = static_cast<int>(DaysFromCivil(next_year, next_month, 1) - DaysFromCivil(year, month, 1));
    return last - Weekday(year, month, last);
  }
  const int first = 1 + (7 - Weekday(year, month, 1)) % 7;
  return first + 7 * (n - 1);
}

// The instants daylight time starts and ends in year, for a zone with a rule.
inline std::pair<int64_t, int64_t> Daylight(const Zone& z, int year) {
  if (z.rule == "eu") return {UTC(year, 3, Sunday(year, 3, -1), 1), UTC(year, 10, Sunday(year, 10, -1), 1)};
  return {UTC(year, 3, Sunday(year, 3, 2), 2) - static_cast<int64_t>(z.std) * 60,
          UTC(year, 11, Sunday(year, 11, 1), 2) - static_cast<int64_t>(z.dst) * 60};
}

// How far the zone's wall clock is ahead of UTC at instant.
inline int OffsetMinutes(const std::string& zone, int64_t instant) {
  const Zone& z = kZones.at(zone);
  if (z.rule.empty()) return z.std;
  const int year = CivilFromDays(instant >= 0 ? instant / 86400 : (instant - 86399) / 86400).year;
  const auto [start, end] = Daylight(z, year);
  return start <= instant && instant < end ? z.dst : z.std;
}

// The instant at which the zone's wall clock reads year-month-day hour:minute.
inline int64_t LocalTime(const std::string& zone, int year, int month, int day, int hour = 0, int minute = 0) {
  const int64_t wall = UTC(year, month, day, hour, minute);
  const int64_t guess = wall - static_cast<int64_t>(OffsetMinutes(zone, wall)) * 60;
  return wall - static_cast<int64_t>(OffsetMinutes(zone, guess)) * 60;
}

// An ISO-8601 instant with an offset (2026-03-10T09:00:00Z, +01:00) as an epoch second.
inline std::optional<int64_t> ParseInstant(const std::string& text) {
  int y, mo, d, h, mi, s = 0;
  int n = 0;
  if (std::sscanf(text.c_str(), "%4d-%2d-%2dT%2d:%2d:%2d%n", &y, &mo, &d, &h, &mi, &s, &n) < 5 || n == 0) {
    return std::nullopt;
  }
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
  return UTC(y, mo, d, h, mi) + s - offset;
}

inline std::string FormatInstant(int64_t instant) {
  const Date date = CivilFromDays(instant >= 0 ? instant / 86400 : (instant - 86399) / 86400);
  const int64_t rest = instant - DaysFromCivil(date.year, date.month, date.day) * 86400;
  char out[32];
  std::snprintf(out, sizeof out, "%04d-%02d-%02dT%02d:%02d:%02dZ", date.year, date.month, date.day,
                static_cast<int>(rest / 3600), static_cast<int>(rest % 3600 / 60), static_cast<int>(rest % 60));
  return out;
}

// A calendar date YYYY-MM-DD.
inline std::optional<Date> ParseDate(const std::string& text) {
  int y, m, d;
  int n = 0;
  if (text.size() != 10 || std::sscanf(text.c_str(), "%4d-%2d-%2d%n", &y, &m, &d, &n) != 3 || n != 10) return std::nullopt;
  const Date probe = CivilFromDays(DaysFromCivil(y, m, d));
  if (probe.year != y || probe.month != m || probe.day != d) return std::nullopt;
  return Date{y, m, d};
}

// Calendar days from date a to date b (negative when b is earlier).
inline int DaysBetween(const Date& a, const Date& b) {
  return static_cast<int>(DaysFromCivil(b.year, b.month, b.day) - DaysFromCivil(a.year, a.month, a.day));
}

}  // namespace booking::tz
`,
  'booking/slots.h': `// The slot grid and the hold map's keys. A resource's day is 30-minute slots from kOpenHour to
// kCloseHour in the resolved zone; a slot's field name in resource:{id}:slots is its start as an
// epoch minute, so the booking path and the availability read name the same slot the same way.
#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "booking/tz.h"

namespace booking::slots {

constexpr int kSlotMinutes = 30;
constexpr int kHoldTtlS = 900;  // the payment window: an abandoned checkout frees its slots after 15 minutes
constexpr int kMaxHorizonDays = 90;
constexpr int kOpenHour = 8;
constexpr int kCloseHour = 20;

inline std::string Key(const std::string& resource_id) { return "resource:" + resource_id + ":slots"; }

inline std::string HoldKey(const std::string& hold_id) { return "hold:" + hold_id; }

// The field of every slot the range [start, end) touches, in order.
inline std::vector<std::string> Fields(int64_t start, int64_t end) {
  std::vector<std::string> fields;
  const int64_t first = start / 60 / kSlotMinutes * kSlotMinutes;
  for (int64_t minute = first; minute * 60 < end; minute += kSlotMinutes) fields.push_back(std::to_string(minute));
  return fields;
}

// The fields of the resource's bookable slots on one calendar day of the zone.
inline std::vector<std::string> DayFields(const std::string& zone, int year, int month, int day) {
  const int64_t opening = tz::LocalTime(zone, year, month, day, kOpenHour) / 60;
  std::vector<std::string> fields;
  for (int k = 0; k < (kCloseHour - kOpenHour) * 60 / kSlotMinutes; k++) {
    fields.push_back(std::to_string(opening + k * kSlotMinutes));
  }
  return fields;
}

}  // namespace booking::slots
`,
  'booking/store.h': `// The booking store and the outbox, in Redis: a booking is the hash booking:{booking_id} (every
// field a string), idem:{tenant}:{key} points a tenant's Idempotency-Key at its booking, and the
// outbox is the list outbox of JSON rows {"topic", "key", "payload"} a relay publishes later.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>
#include <uuid/uuid.h>

#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace booking {

// What take_hold (step 2) hands back for a range it holds.
struct Hold {
  std::string hold_id;
  int expires_in;
};

// One booking as the store holds it; state is held, confirmed, rejected, cancelled or sync_unknown.
struct Booking {
  std::string booking_id;
  std::string tenant;
  std::string resource_id;
  std::string start;
  std::string end;
  std::string hold_id;
  std::string idempotency_key;
  std::string state;
  std::string event_id;
};

inline void to_json(nlohmann::json& j, const Booking& b) {
  j = nlohmann::json{{"booking_id", b.booking_id},   {"tenant", b.tenant}, {"resource_id", b.resource_id},
                     {"start", b.start},             {"end", b.end},       {"hold_id", b.hold_id},
                     {"idempotency_key", b.idempotency_key}, {"state", b.state}, {"event_id", b.event_id}};
}

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

// The booking, if the store has it.
inline std::optional<Booking> Get(const std::string& booking_id) {
  std::unordered_map<std::string, std::string> fields = client().hgetall("booking:" + booking_id);
  if (fields.empty()) return std::nullopt;
  return Booking{fields["booking_id"], fields["tenant"],          fields["resource_id"],
                 fields["start"],      fields["end"],             fields["hold_id"],
                 fields["idempotency_key"], fields["state"],      fields["event_id"]};
}

// The booking a tenant's Idempotency-Key was first used for, if any.
inline std::optional<Booking> GetByKey(const std::string& tenant, const std::string& idempotency_key) {
  const auto booking_id = client().get("idem:" + tenant + ":" + idempotency_key);
  if (!booking_id) return std::nullopt;
  return Get(*booking_id);
}

// Commit the booking: write it and index it under its idempotency key; throws when Redis refused either write.
inline void Put(const Booking& b) {
  auto tx = client().transaction();
  auto replies = tx.hset("booking:" + b.booking_id, {std::pair<std::string, std::string>{"booking_id", b.booking_id},
                                                     {"tenant", b.tenant},
                                                     {"resource_id", b.resource_id},
                                                     {"start", b.start},
                                                     {"end", b.end},
                                                     {"hold_id", b.hold_id},
                                                     {"idempotency_key", b.idempotency_key},
                                                     {"state", b.state},
                                                     {"event_id", b.event_id}})
                     .set("idem:" + b.tenant + ":" + b.idempotency_key, b.booking_id)
                     .exec();
  for (std::size_t i = 0; i < replies.size(); ++i) replies.get(i);  // an error reply throws ReplyError
}

// Record the booking's state, and its calendar event id when event_id is not empty.
inline void SetState(const std::string& booking_id, const std::string& state, const std::string& event_id = "") {
  if (event_id.empty()) {
    client().hset("booking:" + booking_id, "state", state);
  } else {
    client().hset("booking:" + booking_id, "state", state, "event_id", event_id);
  }
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

}  // namespace booking
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('booking', 'Tz')]: `package booking

import java.time.{Instant, LocalDate, LocalDateTime, ZoneId, ZoneOffset}
import java.time.format.DateTimeParseException
import java.time.temporal.ChronoUnit

/**
 * Time as the booking engine counts it: instants are epoch seconds, ISO-8601 on the wire
 * (parseInstant / formatInstant), and the zones this deployment serves are the table below. The JVM
 * has a tz database, so the offsets come from java.time for exactly the zones the other runtimes
 * compute from their rule tables.
 */
object Tz {
  val ResourceTimezone = "Europe/Berlin"

  val Zones: Set[String] = Set("UTC", "Europe/London", "Europe/Berlin", "America/New_York", "Asia/Kolkata", "Asia/Tokyo")

  def known(name: String): Boolean = Zones.contains(name)

  /** The epoch second of a UTC wall time. */
  def utc(year: Int, month: Int, day: Int, hour: Int = 0, minute: Int = 0): Long =
    LocalDateTime.of(year, month, day, hour, minute).toEpochSecond(ZoneOffset.UTC)

  /** How far the zone's wall clock is ahead of UTC at \`instant\`. */
  def offsetMinutes(zone: String, instant: Long): Int =
    ZoneId.of(zone).getRules.getOffset(Instant.ofEpochSecond(instant)).getTotalSeconds / 60

  /** The instant at which the zone's wall clock reads year-month-day hour:minute. */
  def localTime(zone: String, year: Int, month: Int, day: Int, hour: Int = 0, minute: Int = 0): Long =
    LocalDateTime.of(year, month, day, hour, minute).atZone(ZoneId.of(zone)).toEpochSecond

  /** An ISO-8601 instant with an offset (2026-03-10T09:00:00Z, +01:00) as an epoch second. */
  def parseInstant(text: String): Option[Long] =
    try Some(java.time.OffsetDateTime.parse(text).toEpochSecond)
    catch { case _: DateTimeParseException => None }

  def formatInstant(instant: Long): String =
    java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").format(Instant.ofEpochSecond(instant).atOffset(ZoneOffset.UTC))

  /** A calendar date YYYY-MM-DD. */
  def parseDate(text: String): Option[LocalDate] =
    try Some(LocalDate.parse(text))
    catch { case _: DateTimeParseException => None }

  /** Calendar days from date a to date b (negative when b is earlier). */
  def daysBetween(a: LocalDate, b: LocalDate): Int = ChronoUnit.DAYS.between(a, b).toInt
}
`,
  [scalaPath('booking', 'Slots')]: `package booking

/**
 * The slot grid and the hold map's keys. A resource's day is 30-minute slots from OpenHour to
 * CloseHour in the resolved zone; a slot's field name in resource:{id}:slots is its start as an
 * epoch minute, so the booking path and the availability read name the same slot the same way.
 */
object Slots {
  val SlotMinutes = 30
  val HoldTtlS = 900 // the payment window: an abandoned checkout frees its slots after 15 minutes
  val MaxHorizonDays = 90
  val OpenHour = 8
  val CloseHour = 20

  def key(resourceId: String): String = s"resource:$resourceId:slots"

  def holdKey(holdId: String): String = s"hold:$holdId"

  /** The field of every slot the range [start, end) touches, in order. */
  def fields(start: Long, end: Long): Seq[String] = {
    val first = start / 60 / SlotMinutes * SlotMinutes
    Iterator.iterate(first)(_ + SlotMinutes).takeWhile(_ * 60 < end).map(_.toString).toSeq
  }

  /** The fields of the resource's bookable slots on one calendar day of the zone. */
  def dayFields(zone: String, year: Int, month: Int, day: Int): Seq[String] = {
    val opening = Tz.localTime(zone, year, month, day, OpenHour) / 60
    (0 until (CloseHour - OpenHour) * 60 / SlotMinutes).map(k => (opening + k * SlotMinutes).toString)
  }
}
`,
  [scalaPath('booking', 'Store')]: `package booking

import java.util.UUID

import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

/** One booking as the store holds it; state is held, confirmed, rejected, cancelled or sync_unknown. */
final case class Booking(
    booking_id: String,
    tenant: String,
    resource_id: String,
    start: String,
    end: String,
    hold_id: String,
    idempotency_key: String,
    state: String,
    event_id: String = ""
)

object Booking {
  implicit val format: RootJsonFormat[Booking] = jsonFormat9(Booking.apply)
}

/**
 * The booking store and the outbox, in Redis: a booking is the hash booking:{booking_id} (every
 * field a string), idem:{tenant}:{key} points a tenant's Idempotency-Key at its booking, and the
 * outbox is the list outbox of JSON rows {"topic", "key", "payload"} a relay publishes later.
 */
object Store {
  val jedis = new JedisPooled("redis", 6379)

  def newId(): String = UUID.randomUUID().toString

  /** The booking, if the store has it. */
  def get(bookingId: String): Option[Booking] = {
    val f = jedis.hgetAll(s"booking:$bookingId").asScala
    if (f.isEmpty) None
    else
      Some(
        Booking(
          f.getOrElse("booking_id", ""),
          f.getOrElse("tenant", ""),
          f.getOrElse("resource_id", ""),
          f.getOrElse("start", ""),
          f.getOrElse("end", ""),
          f.getOrElse("hold_id", ""),
          f.getOrElse("idempotency_key", ""),
          f.getOrElse("state", ""),
          f.getOrElse("event_id", "")
        )
      )
  }

  /** The booking a tenant's Idempotency-Key was first used for, if any. */
  def getByKey(tenant: String, idempotencyKey: String): Option[Booking] =
    Option(jedis.get(s"idem:$tenant:$idempotencyKey")).flatMap(get)

  /** Commit the booking: write it and index it under its idempotency key. */
  def put(b: Booking): Unit = {
    val fields = Map(
      "booking_id" -> b.booking_id,
      "tenant" -> b.tenant,
      "resource_id" -> b.resource_id,
      "start" -> b.start,
      "end" -> b.end,
      "hold_id" -> b.hold_id,
      "idempotency_key" -> b.idempotency_key,
      "state" -> b.state,
      "event_id" -> b.event_id
    )
    val tx = jedis.multi()
    tx.hset(s"booking:\${b.booking_id}", fields.asJava)
    tx.set(s"idem:\${b.tenant}:\${b.idempotency_key}", b.booking_id)
    tx.exec()
  }

  /** Record the booking's state, and its calendar event id when eventId is not empty. */
  def setState(bookingId: String, state: String, eventId: String = ""): Unit = {
    val fields = if (eventId.isEmpty) Map("state" -> state) else Map("state" -> state, "event_id" -> eventId)
    jedis.hset(s"booking:$bookingId", fields.asJava)
  }

  /** Queue a record for the relay to publish later. */
  def insertOutbox(topic: String, key: String, payload: JsValue): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)

  /** Everything queued, oldest first. */
  def outboxRows(): Seq[JsValue] = jedis.lrange("outbox", 0, -1).asScala.toSeq.map(_.parseJson)
}
`,
};
