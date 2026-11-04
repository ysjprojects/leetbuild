/**
 * Hand-written support modules every step of the cron scheduler imports but no step builds: the
 * `cronsched` package. `cron` is time as the scheduler counts it (epoch seconds, ISO-8601 on the wire,
 * fire windows of one minute, the zone table with its daylight rules, five-field cron expressions
 * evaluated in a zone, and the schedule rules: the shortest cadence and the misfire policies);
 * `store` is the schedule store, the run ledger, the lease key and the outbox, in Redis. The five
 * languages compute the same instants from the same inputs, so a fire window or a next fire time is
 * the same whichever runtime a check runs in.
 */
import {scalaPath} from '../scala-support';

export const supportModulesPy: Record<string, string> = {
  'cronsched/__init__.py': '',
  'cronsched/cron.py': `"""
Time as the scheduler counts it. Instants are epoch seconds, ISO-8601 on the wire (format_instant);
a fire window is the minute an instant falls in (window_of). A cron expression is the five-field form
(minute hour day-of-month month day-of-week, Sunday = 0) evaluated in the schedule's zone. The
runtime has no tz database, so ZONES (offsets and daylight rules) is the one source of truth, the same
in every language.
"""
from datetime import date, datetime, timedelta, timezone

WINDOW_S = 60
MIN_INTERVAL_S = 300  # the shortest cadence the scheduler accepts: five minutes
MISFIRE_POLICIES = ("skip", "fire_once_now", "catch_up")
NEXT_FIRE_DAYS = 1500  # how far next_fire looks ahead: past the next February 29

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

_BOUNDS = ((0, 59), (0, 23), (1, 31), (1, 12), (0, 6))


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


def format_instant(instant: int) -> str:
    return datetime.fromtimestamp(instant, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def window_of(instant: int) -> int:
    """The fire window an instant falls in: the start of its minute."""
    return int(instant) // WINDOW_S * WINDOW_S


class Spec:
    """A parsed expression: the values each field allows, and whether each day field was \`*\`."""

    def __init__(self, minutes, hours, days, months, weekdays, any_day: bool, any_weekday: bool) -> None:
        self.minutes = minutes
        self.hours = hours
        self.days = days
        self.months = months
        self.weekdays = weekdays
        self.any_day = any_day
        self.any_weekday = any_weekday


def _field(text: str, low: int, high: int) -> list[int] | None:
    values: set[int] = set()
    for item in text.split(","):
        base, slash, step_text = item.partition("/")
        step = 1
        if slash:
            if not step_text.isdigit() or int(step_text) == 0:
                return None
            step = int(step_text)
        if base == "*":
            first, last = low, high
        elif "-" in base:
            a, _, b = base.partition("-")
            if not (a.isdigit() and b.isdigit()):
                return None
            first, last = int(a), int(b)
        elif base.isdigit():
            first = int(base)
            last = high if slash else first
        else:
            return None
        if first < low or last > high or first > last:
            return None
        values.update(range(first, last + 1, step))
    return sorted(values)


def parse(expr: str) -> Spec | None:
    """The five-field expression, or None when it is not one (a sixth, seconds field included)."""
    fields = expr.split() if isinstance(expr, str) else []
    if len(fields) != 5:
        return None
    parsed = [_field(text, low, high) for text, (low, high) in zip(fields, _BOUNDS)]
    if any(values is None for values in parsed):
        return None
    return Spec(*parsed, fields[2].startswith("*"), fields[4].startswith("*"))


def _local_day(zone: str, instant: int) -> int:
    """The zone's calendar day at \`instant\`, as days since 1970-01-01."""
    return (int(instant) + utc_offset_minutes(zone, int(instant)) * 60) // 86400


def _day_fires(spec: Spec, zone: str, day_number: int) -> list[int]:
    """The fire instants of one calendar day of the zone (day-of-month OR day-of-week when both are set)."""
    d = date(1970, 1, 1) + timedelta(days=day_number)
    if d.month not in spec.months:
        return []
    dom = d.day in spec.days
    dow = (d.weekday() + 1) % 7 in spec.weekdays
    if not ((dom and dow) if spec.any_day or spec.any_weekday else (dom or dow)):
        return []
    return sorted(local_time(zone, d.year, d.month, d.day, h, m) for h in spec.hours for m in spec.minutes)


def fires_between(spec: Spec, zone: str, since: int, until: int) -> list[int]:
    """Every fire instant t with since <= t < until, oldest first."""
    fires: set[int] = set()
    for day in range(_local_day(zone, since) - 1, _local_day(zone, until) + 2):
        fires.update(t for t in _day_fires(spec, zone, day) if since <= t < until)
    return sorted(fires)


def next_fire(spec: Spec, zone: str, after: int) -> int | None:
    """The first fire instant strictly after \`after\`, or None when the expression never fires."""
    first = _local_day(zone, after) - 1
    for day in range(first, first + NEXT_FIRE_DAYS):
        later = [t for t in _day_fires(spec, zone, day) if t > after]
        if later:
            return later[0]
    return None


def shortest_gap_s(spec: Spec) -> int:
    """The shortest time between two fires of the expression, in seconds."""
    marks = sorted({h * 60 + m for h in spec.hours for m in spec.minutes})
    gaps = [b - a for a, b in zip(marks, marks[1:])]
    gaps.append(marks[0] + 1440 - marks[-1])
    return min(gaps) * 60
`,
  'cronsched/store.py': `"""
The schedule store, the run ledger and the outbox, in Redis. A schedule is the hash schedule:{id}
(every field a string: id, tenant, cron, timezone, job_ref, misfire_policy, next_fire); the ledger
runs:{schedule_id} maps a fire window (epoch seconds) to "outcome:reason", the outcome being fired,
error or skipped; lease:{schedule_id}:{window} is the key a fire window is claimed under; the outbox
is the list outbox of JSON rows {"topic", "key", "payload"} a relay publishes later.
"""
import json
import uuid

import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def new_id() -> str:
    return str(uuid.uuid4())


def lease_key(schedule_id: str, window: int) -> str:
    return f"lease:{schedule_id}:{window}"


class ScheduleStore:
    def put(self, schedule: dict) -> None:
        r.hset(f"schedule:{schedule['id']}", mapping={field: str(value) for field, value in schedule.items()})

    def get(self, schedule_id: str) -> dict | None:
        """The schedule, or None."""
        return r.hgetall(f"schedule:{schedule_id}") or None

    def record_run(self, schedule_id: str, window: int, outcome: str, reason: str) -> None:
        """Write what happened to one fire window; a later write for the same window replaces it."""
        r.hset(f"runs:{schedule_id}", str(window), f"{outcome}:{reason}")

    def runs(self, schedule_id: str) -> list[dict]:
        """Every recorded window, oldest first: {"window", "outcome", "reason"}."""
        rows = []
        for window, value in r.hgetall(f"runs:{schedule_id}").items():
            outcome, _, reason = value.partition(":")
            rows.append({"window": int(window), "outcome": outcome, "reason": reason})
        return sorted(rows, key=lambda row: row["window"])


class Outbox:
    def insert(self, topic: str, key: str, payload: dict) -> None:
        r.rpush("outbox", json.dumps({"topic": topic, "key": key, "payload": payload}))

    def rows(self) -> list[dict]:
        return [json.loads(row) for row in r.lrange("outbox", 0, -1)]


store = ScheduleStore()
outbox = Outbox()
`,
};

export const supportModulesTs: Record<string, string> = {
  'cronsched/cron.ts': `/**
 * Time as the scheduler counts it. Instants are epoch seconds, ISO-8601 on the wire (formatInstant);
 * a fire window is the minute an instant falls in (windowOf). A cron expression is the five-field form
 * (minute hour day-of-month month day-of-week, Sunday = 0) evaluated in the schedule's zone. The
 * runtime has no tz database, so ZONES (offsets and daylight rules) is the one source of truth, the
 * same in every language.
 */
export const WINDOW_S = 60;
/** The shortest cadence the scheduler accepts: five minutes. */
export const MIN_INTERVAL_S = 300;
export const MISFIRE_POLICIES: readonly string[] = ['skip', 'fire_once_now', 'catch_up'];
/** How far nextFire looks ahead: past the next February 29. */
export const NEXT_FIRE_DAYS = 1500;

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

const BOUNDS: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

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

export const formatInstant = (instant: number): string =>
  new Date(instant * 1000).toISOString().replace(/\\.\\d{3}Z$/, 'Z');

/** The fire window an instant falls in: the start of its minute. */
export const windowOf = (instant: number): number => Math.floor(instant / WINDOW_S) * WINDOW_S;

/** A parsed expression: the values each field allows, and whether each day field was \`*\`. */
export interface Spec {
  minutes: number[];
  hours: number[];
  days: number[];
  months: number[];
  weekdays: number[];
  anyDay: boolean;
  anyWeekday: boolean;
}

const digits = (text: string): number | null => (/^[0-9]+$/.test(text) ? Number(text) : null);

const field = (text: string, low: number, high: number): number[] | null => {
  const values = new Set<number>();
  for (const item of text.split(',')) {
    const slash = item.indexOf('/');
    const base = slash < 0 ? item : item.slice(0, slash);
    let step = 1;
    if (slash >= 0) {
      const parsed = digits(item.slice(slash + 1));
      if (parsed === null || parsed === 0) return null;
      step = parsed;
    }
    let first: number | null;
    let last: number | null;
    if (base === '*') {
      [first, last] = [low, high];
    } else if (base.includes('-')) {
      const dash = base.indexOf('-');
      [first, last] = [digits(base.slice(0, dash)), digits(base.slice(dash + 1))];
    } else {
      first = digits(base);
      last = slash >= 0 ? high : first;
    }
    if (first === null || last === null || first < low || last > high || first > last) return null;
    for (let v = first; v <= last; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
};

/** The five-field expression, or null when it is not one (a sixth, seconds field included). */
export const parse = (expr: string): Spec | null => {
  const fields = typeof expr === 'string' ? expr.trim().split(/\\s+/).filter(f => f !== '') : [];
  if (fields.length !== 5) return null;
  const parsed = fields.map((text, i) => field(text, BOUNDS[i][0], BOUNDS[i][1]));
  if (parsed.some(values => values === null)) return null;
  const [minutes, hours, days, months, weekdays] = parsed as number[][];
  return {minutes, hours, days, months, weekdays, anyDay: fields[2].startsWith('*'), anyWeekday: fields[4].startsWith('*')};
};

/** The zone's calendar day at \`instant\`, as days since 1970-01-01. */
const localDay = (zone: string, instant: number): number => Math.floor((instant + utcOffsetMinutes(zone, instant) * 60) / 86400);

/** The fire instants of one calendar day of the zone (day-of-month OR day-of-week when both are set). */
const dayFires = (spec: Spec, zone: string, dayNumber: number): number[] => {
  const d = new Date(dayNumber * 86_400_000);
  const [year, month, day, weekday] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCDay()];
  if (!spec.months.includes(month)) return [];
  const dom = spec.days.includes(day);
  const dow = spec.weekdays.includes(weekday);
  if (!(spec.anyDay || spec.anyWeekday ? dom && dow : dom || dow)) return [];
  const fires: number[] = [];
  for (const h of spec.hours) for (const m of spec.minutes) fires.push(localTime(zone, year, month, day, h, m));
  return fires.sort((a, b) => a - b);
};

/** Every fire instant t with since <= t < until, oldest first. */
export const firesBetween = (spec: Spec, zone: string, since: number, until: number): number[] => {
  const fires = new Set<number>();
  for (let day = localDay(zone, since) - 1; day <= localDay(zone, until) + 1; day += 1) {
    for (const t of dayFires(spec, zone, day)) if (since <= t && t < until) fires.add(t);
  }
  return [...fires].sort((a, b) => a - b);
};

/** The first fire instant strictly after \`after\`, or null when the expression never fires. */
export const nextFire = (spec: Spec, zone: string, after: number): number | null => {
  const first = localDay(zone, after) - 1;
  for (let day = first; day < first + NEXT_FIRE_DAYS; day += 1) {
    const later = dayFires(spec, zone, day).filter(t => t > after);
    if (later.length > 0) return later[0];
  }
  return null;
};

/** The shortest time between two fires of the expression, in seconds. */
export const shortestGapS = (spec: Spec): number => {
  const marks = [...new Set(spec.hours.flatMap(h => spec.minutes.map(m => h * 60 + m)))].sort((a, b) => a - b);
  const gaps = marks.slice(1).map((mark, i) => mark - marks[i]);
  gaps.push(marks[0] + 1440 - marks[marks.length - 1]);
  return Math.min(...gaps) * 60;
};
`,
  'cronsched/store.ts': `/**
 * The schedule store, the run ledger and the outbox, in Redis. A schedule is the hash schedule:{id}
 * (every field a string); the ledger runs:{scheduleId} maps a fire window (epoch seconds) to
 * "outcome:reason", the outcome being fired, error or skipped; lease:{scheduleId}:{window} is the key a
 * fire window is claimed under; the outbox is the list outbox of JSON rows {"topic", "key", "payload"}
 * a relay publishes later.
 */
import {randomUUID} from 'node:crypto';

import Redis from 'ioredis';

export interface Schedule {
  id: string;
  tenant: string;
  cron: string;
  timezone: string;
  job_ref: string;
  /** skip, fire_once_now or catch_up. */
  misfire_policy: string;
  /** ISO-8601 instant. */
  next_fire: string;
}

/** One recorded fire window: fired, error or skipped, and why. */
export interface Run {
  window: number;
  outcome: string;
  reason: string;
}

const redis = new Redis({host: 'redis', port: 6379});

export const newId = (): string => randomUUID();

export const leaseKey = (scheduleId: string, window: number): string => \`lease:\${scheduleId}:\${window}\`;

export const store = {
  async put(schedule: Schedule): Promise<void> {
    await redis.hset(\`schedule:\${schedule.id}\`, {...schedule});
  },
  /** The schedule, or null. */
  async get(scheduleId: string): Promise<Schedule | null> {
    const fields = await redis.hgetall(\`schedule:\${scheduleId}\`);
    return Object.keys(fields).length === 0 ? null : (fields as unknown as Schedule);
  },
  /** Write what happened to one fire window; a later write for the same window replaces it. */
  async recordRun(scheduleId: string, window: number, outcome: string, reason: string): Promise<void> {
    await redis.hset(\`runs:\${scheduleId}\`, String(window), \`\${outcome}:\${reason}\`);
  },
  /** Every recorded window, oldest first. */
  async runs(scheduleId: string): Promise<Run[]> {
    const fields = await redis.hgetall(\`runs:\${scheduleId}\`);
    return Object.entries(fields)
      .map(([window, value]) => {
        const colon = value.indexOf(':');
        return {window: Number(window), outcome: value.slice(0, colon), reason: value.slice(colon + 1)};
      })
      .sort((a, b) => a.window - b.window);
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
  'cronsched/cron/cron.go': `// Package cron is time as the scheduler counts it. Instants are epoch seconds, ISO-8601 on the wire
// (FormatInstant); a fire window is the minute an instant falls in (WindowOf). A cron expression is the
// five-field form (minute hour day-of-month month day-of-week, Sunday = 0) evaluated in the schedule's
// zone. The runtime has no tz database, so Zones (offsets and daylight rules) is the one source of
// truth, the same in every language.
package cron

import (
	"sort"
	"strings"
	"time"
)

const (
	WindowS      = 60
	MinIntervalS = 300  // the shortest cadence the scheduler accepts: five minutes
	NextFireDays = 1500 // how far NextFire looks ahead: past the next February 29
)

// MisfirePolicies is the set of policies a schedule may name.
var MisfirePolicies = map[string]bool{"skip": true, "fire_once_now": true, "catch_up": true}

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

var bounds = [5][2]int{{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 6}}

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

func FormatInstant(instant int64) string {
	return time.Unix(instant, 0).UTC().Format("2006-01-02T15:04:05Z")
}

// WindowOf is the fire window an instant falls in: the start of its minute.
func WindowOf(instant int64) int64 { return instant / WindowS * WindowS }

// Spec is a parsed expression: the values each field allows, and whether each day field was "*".
type Spec struct {
	Minutes, Hours, Days, Months, Weekdays []int
	AnyDay, AnyWeekday                     bool
}

func digits(text string) (int, bool) {
	if text == "" {
		return 0, false
	}
	n := 0
	for _, c := range text {
		if c < '0' || c > '9' {
			return 0, false
		}
		n = n*10 + int(c-'0')
	}
	return n, true
}

func field(text string, low, high int) ([]int, bool) {
	seen := map[int]bool{}
	for _, item := range strings.Split(text, ",") {
		base, step := item, 1
		slash := strings.Index(item, "/")
		if slash >= 0 {
			base = item[:slash]
			n, ok := digits(item[slash+1:])
			if !ok || n == 0 {
				return nil, false
			}
			step = n
		}
		var first, last int
		okFirst, okLast := true, true
		if base == "*" {
			first, last = low, high
		} else if dash := strings.Index(base, "-"); dash >= 0 {
			first, okFirst = digits(base[:dash])
			last, okLast = digits(base[dash+1:])
		} else {
			first, okFirst = digits(base)
			last = first
			if slash >= 0 {
				last = high
			}
		}
		if !okFirst || !okLast || first < low || last > high || first > last {
			return nil, false
		}
		for v := first; v <= last; v += step {
			seen[v] = true
		}
	}
	values := make([]int, 0, len(seen))
	for v := range seen {
		values = append(values, v)
	}
	sort.Ints(values)
	return values, true
}

// Parse reads a five-field expression; false when it is not one (a sixth, seconds field included).
func Parse(expr string) (*Spec, bool) {
	fields := strings.Fields(expr)
	if len(fields) != 5 {
		return nil, false
	}
	var parsed [5][]int
	for i, text := range fields {
		values, ok := field(text, bounds[i][0], bounds[i][1])
		if !ok {
			return nil, false
		}
		parsed[i] = values
	}
	return &Spec{
		Minutes: parsed[0], Hours: parsed[1], Days: parsed[2], Months: parsed[3], Weekdays: parsed[4],
		AnyDay: strings.HasPrefix(fields[2], "*"), AnyWeekday: strings.HasPrefix(fields[4], "*"),
	}, true
}

func has(values []int, v int) bool {
	for _, x := range values {
		if x == v {
			return true
		}
	}
	return false
}

// localDay is the zone's calendar day at instant, as days since 1970-01-01.
func localDay(zone string, instant int64) int64 {
	local := instant + int64(OffsetMinutes(zone, instant))*60
	if local < 0 {
		return (local - 86399) / 86400
	}
	return local / 86400
}

// dayFires is the fire instants of one calendar day of the zone (day-of-month OR day-of-week when both are set).
func dayFires(spec *Spec, zone string, dayNumber int64) []int64 {
	d := time.Unix(dayNumber*86400, 0).UTC()
	if !has(spec.Months, int(d.Month())) {
		return nil
	}
	dom := has(spec.Days, d.Day())
	dow := has(spec.Weekdays, int(d.Weekday()))
	match := dom || dow
	if spec.AnyDay || spec.AnyWeekday {
		match = dom && dow
	}
	if !match {
		return nil
	}
	var fires []int64
	for _, h := range spec.Hours {
		for _, m := range spec.Minutes {
			fires = append(fires, LocalTime(zone, d.Year(), int(d.Month()), d.Day(), h, m))
		}
	}
	sort.Slice(fires, func(i, j int) bool { return fires[i] < fires[j] })
	return fires
}

// FiresBetween is every fire instant t with since <= t < until, oldest first.
func FiresBetween(spec *Spec, zone string, since, until int64) []int64 {
	seen := map[int64]bool{}
	fires := []int64{}
	for day := localDay(zone, since) - 1; day <= localDay(zone, until)+1; day++ {
		for _, t := range dayFires(spec, zone, day) {
			if since <= t && t < until && !seen[t] {
				seen[t] = true
				fires = append(fires, t)
			}
		}
	}
	sort.Slice(fires, func(i, j int) bool { return fires[i] < fires[j] })
	return fires
}

// NextFire is the first fire instant strictly after after; false when the expression never fires.
func NextFire(spec *Spec, zone string, after int64) (int64, bool) {
	first := localDay(zone, after) - 1
	for day := first; day < first+NextFireDays; day++ {
		for _, t := range dayFires(spec, zone, day) {
			if t > after {
				return t, true
			}
		}
	}
	return 0, false
}

// ShortestGapS is the shortest time between two fires of the expression, in seconds.
func ShortestGapS(spec *Spec) int64 {
	seen := map[int]bool{}
	var marks []int
	for _, h := range spec.Hours {
		for _, m := range spec.Minutes {
			if !seen[h*60+m] {
				seen[h*60+m] = true
				marks = append(marks, h*60+m)
			}
		}
	}
	sort.Ints(marks)
	shortest := marks[0] + 1440 - marks[len(marks)-1]
	for i := 1; i < len(marks); i++ {
		if marks[i]-marks[i-1] < shortest {
			shortest = marks[i] - marks[i-1]
		}
	}
	return int64(shortest) * 60
}
`,
  'cronsched/store/store.go': `// Package store is the schedule store, the run ledger and the outbox, in Redis. A schedule is the
// hash schedule:{id} (every field a string); the ledger runs:{schedule_id} maps a fire window (epoch
// seconds) to "outcome:reason", the outcome being fired, error or skipped; lease:{schedule_id}:{window}
// is the key a fire window is claimed under; the outbox is the list outbox of JSON rows
// {"topic", "key", "payload"} a relay publishes later.
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

// Schedule is one schedule as the store holds it; MisfirePolicy is skip, fire_once_now or catch_up,
// NextFire an ISO-8601 instant.
type Schedule struct {
	ID            string \`json:"id"\`
	Tenant        string \`json:"tenant"\`
	Cron          string \`json:"cron"\`
	Timezone      string \`json:"timezone"\`
	JobRef        string \`json:"job_ref"\`
	MisfirePolicy string \`json:"misfire_policy"\`
	NextFire      string \`json:"next_fire"\`
}

// Run is one recorded fire window: fired, error or skipped, and why.
type Run struct {
	Window  int64  \`json:"window"\`
	Outcome string \`json:"outcome"\`
	Reason  string \`json:"reason"\`
}

func NewID() string { return uuid.NewString() }

func LeaseKey(scheduleID string, window int64) string {
	return "lease:" + scheduleID + ":" + strconv.FormatInt(window, 10)
}

func Put(ctx context.Context, s *Schedule) error {
	return rdb.HSet(ctx, "schedule:"+s.ID, map[string]any{
		"id": s.ID, "tenant": s.Tenant, "cron": s.Cron, "timezone": s.Timezone, "job_ref": s.JobRef,
		"misfire_policy": s.MisfirePolicy, "next_fire": s.NextFire,
	}).Err()
}

// Get is the schedule, or nil.
func Get(ctx context.Context, scheduleID string) (*Schedule, error) {
	f, err := rdb.HGetAll(ctx, "schedule:"+scheduleID).Result()
	if err != nil || len(f) == 0 {
		return nil, err
	}
	return &Schedule{
		ID: f["id"], Tenant: f["tenant"], Cron: f["cron"], Timezone: f["timezone"], JobRef: f["job_ref"],
		MisfirePolicy: f["misfire_policy"], NextFire: f["next_fire"],
	}, nil
}

// RecordRun writes what happened to one fire window; a later write for the same window replaces it.
func RecordRun(ctx context.Context, scheduleID string, window int64, outcome, reason string) error {
	return rdb.HSet(ctx, "runs:"+scheduleID, strconv.FormatInt(window, 10), outcome+":"+reason).Err()
}

// Runs is every recorded window, oldest first.
func Runs(ctx context.Context, scheduleID string) ([]Run, error) {
	f, err := rdb.HGetAll(ctx, "runs:"+scheduleID).Result()
	if err != nil {
		return nil, err
	}
	runs := make([]Run, 0, len(f))
	for window, value := range f {
		w, _ := strconv.ParseInt(window, 10, 64)
		outcome, reason := value, ""
		if colon := strings.Index(value, ":"); colon >= 0 {
			outcome, reason = value[:colon], value[colon+1:]
		}
		runs = append(runs, Run{Window: w, Outcome: outcome, Reason: reason})
	}
	sort.Slice(runs, func(i, j int) bool { return runs[i].Window < runs[j].Window })
	return runs, nil
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
  'cronsched/cron.h': `// Time as the scheduler counts it. Instants are epoch seconds, ISO-8601 on the wire (FormatInstant);
// a fire window is the minute an instant falls in (WindowOf). A cron expression is the five-field form
// (minute hour day-of-month month day-of-week, Sunday = 0) evaluated in the schedule's zone. The
// runtime has no tz database, so kZones (offsets and daylight rules) is the one source of truth, the
// same in every language.
#pragma once

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <map>
#include <optional>
#include <set>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

namespace cronsched::cron {

constexpr int64_t kWindowS = 60;
constexpr int64_t kMinIntervalS = 300;  // the shortest cadence the scheduler accepts: five minutes
constexpr int kNextFireDays = 1500;     // how far NextFire looks ahead: past the next February 29
inline const std::set<std::string> kMisfirePolicies = {"skip", "fire_once_now", "catch_up"};

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

inline bool Known(const std::string& name) { return kZones.find(name) != kZones.end(); }

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

inline int64_t FloorDiv(int64_t a, int64_t b) { return a >= 0 ? a / b : (a - b + 1) / b; }

// The epoch second of a UTC wall time.
inline int64_t UTC(int year, int month, int day, int hour = 0, int minute = 0) {
  return DaysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60;
}

// The weekday of a day count since 1970-01-01, Sunday = 0.
inline int WeekdayOf(int64_t days) { return static_cast<int>(((days % 7) + 11) % 7); }

// The day of month of the n-th Sunday (n = -1: the last).
inline int Sunday(int year, int month, int n) {
  if (n < 0) {
    const int next_year = month == 12 ? year + 1 : year;
    const int next_month = month == 12 ? 1 : month + 1;
    const int last = static_cast<int>(DaysFromCivil(next_year, next_month, 1) - DaysFromCivil(year, month, 1));
    return last - WeekdayOf(DaysFromCivil(year, month, last));
  }
  const int first = 1 + (7 - WeekdayOf(DaysFromCivil(year, month, 1))) % 7;
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
  const auto [start, stop] = Daylight(z, CivilFromDays(FloorDiv(instant, 86400)).year);
  return start <= instant && instant < stop ? z.dst : z.std;
}

// The instant at which the zone's wall clock reads year-month-day hour:minute.
inline int64_t LocalTime(const std::string& zone, int year, int month, int day, int hour = 0, int minute = 0) {
  const int64_t wall = UTC(year, month, day, hour, minute);
  const int64_t guess = wall - static_cast<int64_t>(OffsetMinutes(zone, wall)) * 60;
  return wall - static_cast<int64_t>(OffsetMinutes(zone, guess)) * 60;
}

inline std::string FormatInstant(int64_t instant) {
  const Date date = CivilFromDays(FloorDiv(instant, 86400));
  const int64_t rest = instant - DaysFromCivil(date.year, date.month, date.day) * 86400;
  char out[32];
  std::snprintf(out, sizeof out, "%04d-%02d-%02dT%02d:%02d:%02dZ", date.year, date.month, date.day,
                static_cast<int>(rest / 3600), static_cast<int>(rest % 3600 / 60), static_cast<int>(rest % 60));
  return out;
}

// The fire window an instant falls in: the start of its minute.
inline int64_t WindowOf(int64_t instant) { return FloorDiv(instant, kWindowS) * kWindowS; }

// A parsed expression: the values each field allows, and whether each day field was "*".
struct Spec {
  std::vector<int> minutes, hours, days, months, weekdays;
  bool any_day = false;
  bool any_weekday = false;
};

inline std::optional<int> Digits(const std::string& text) {
  if (text.empty() || text.size() > 6) return std::nullopt;
  int n = 0;
  for (const char c : text) {
    if (c < '0' || c > '9') return std::nullopt;
    n = n * 10 + (c - '0');
  }
  return n;
}

inline std::optional<std::vector<int>> Field(const std::string& text, int low, int high) {
  std::set<int> values;
  std::stringstream items(text);
  std::string item;
  if (text.empty() || text.back() == ',') return std::nullopt;
  while (std::getline(items, item, ',')) {
    const size_t slash = item.find('/');
    const std::string base = slash == std::string::npos ? item : item.substr(0, slash);
    int step = 1;
    if (slash != std::string::npos) {
      const auto n = Digits(item.substr(slash + 1));
      if (!n || *n == 0) return std::nullopt;
      step = *n;
    }
    std::optional<int> first, last;
    if (base == "*") {
      first = low;
      last = high;
    } else if (const size_t dash = base.find('-'); dash != std::string::npos) {
      first = Digits(base.substr(0, dash));
      last = Digits(base.substr(dash + 1));
    } else {
      first = Digits(base);
      last = slash == std::string::npos ? first : std::optional<int>(high);
    }
    if (!first || !last || *first < low || *last > high || *first > *last) return std::nullopt;
    for (int v = *first; v <= *last; v += step) values.insert(v);
  }
  return std::vector<int>(values.begin(), values.end());
}

// The five-field expression, or nothing when it is not one (a sixth, seconds field included).
inline std::optional<Spec> Parse(const std::string& expr) {
  std::istringstream in(expr);
  std::vector<std::string> fields;
  for (std::string f; in >> f;) fields.push_back(f);
  if (fields.size() != 5) return std::nullopt;
  const int bounds[5][2] = {{0, 59}, {0, 23}, {1, 31}, {1, 12}, {0, 6}};
  std::vector<std::vector<int>> parsed;
  for (size_t i = 0; i < 5; i++) {
    auto values = Field(fields[i], bounds[i][0], bounds[i][1]);
    if (!values) return std::nullopt;
    parsed.push_back(*values);
  }
  Spec spec{parsed[0], parsed[1], parsed[2], parsed[3], parsed[4], fields[2][0] == '*', fields[4][0] == '*'};
  return spec;
}

inline bool Has(const std::vector<int>& values, int v) { return std::find(values.begin(), values.end(), v) != values.end(); }

// The zone's calendar day at instant, as days since 1970-01-01.
inline int64_t LocalDay(const std::string& zone, int64_t instant) {
  return FloorDiv(instant + static_cast<int64_t>(OffsetMinutes(zone, instant)) * 60, 86400);
}

// The fire instants of one calendar day of the zone (day-of-month OR day-of-week when both are set).
inline std::vector<int64_t> DayFires(const Spec& spec, const std::string& zone, int64_t day_number) {
  const Date d = CivilFromDays(day_number);
  if (!Has(spec.months, d.month)) return {};
  const bool dom = Has(spec.days, d.day);
  const bool dow = Has(spec.weekdays, WeekdayOf(day_number));
  if (!(spec.any_day || spec.any_weekday ? dom && dow : dom || dow)) return {};
  std::vector<int64_t> fires;
  for (const int h : spec.hours) {
    for (const int m : spec.minutes) fires.push_back(LocalTime(zone, d.year, d.month, d.day, h, m));
  }
  std::sort(fires.begin(), fires.end());
  return fires;
}

// Every fire instant t with since <= t < until, oldest first.
inline std::vector<int64_t> FiresBetween(const Spec& spec, const std::string& zone, int64_t since, int64_t until) {
  std::set<int64_t> fires;
  for (int64_t day = LocalDay(zone, since) - 1; day <= LocalDay(zone, until) + 1; day++) {
    for (const int64_t t : DayFires(spec, zone, day)) {
      if (since <= t && t < until) fires.insert(t);
    }
  }
  return std::vector<int64_t>(fires.begin(), fires.end());
}

// The first fire instant strictly after after, or nothing when the expression never fires.
inline std::optional<int64_t> NextFire(const Spec& spec, const std::string& zone, int64_t after) {
  const int64_t first = LocalDay(zone, after) - 1;
  for (int64_t day = first; day < first + kNextFireDays; day++) {
    for (const int64_t t : DayFires(spec, zone, day)) {
      if (t > after) return t;
    }
  }
  return std::nullopt;
}

// The shortest time between two fires of the expression, in seconds.
inline int64_t ShortestGapS(const Spec& spec) {
  std::set<int> marks;
  for (const int h : spec.hours) {
    for (const int m : spec.minutes) marks.insert(h * 60 + m);
  }
  int shortest = *marks.begin() + 1440 - *marks.rbegin();
  int previous = -1;
  for (const int mark : marks) {
    if (previous >= 0) shortest = std::min(shortest, mark - previous);
    previous = mark;
  }
  return static_cast<int64_t>(shortest) * 60;
}

}  // namespace cronsched::cron
`,
  'cronsched/store.h': `// The schedule store, the run ledger and the outbox, in Redis. A schedule is the hash schedule:{id}
// (every field a string); the ledger runs:{schedule_id} maps a fire window (epoch seconds) to
// "outcome:reason", the outcome being fired, error or skipped; lease:{schedule_id}:{window} is the key
// a fire window is claimed under; the outbox is the list outbox of JSON rows {"topic", "key", "payload"}
// a relay publishes later.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>
#include <uuid/uuid.h>

#include <algorithm>
#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

namespace cronsched {

// One schedule as the store holds it; misfire_policy is skip, fire_once_now or catch_up, next_fire an
// ISO-8601 instant.
struct Schedule {
  std::string id;
  std::string tenant;
  std::string cron;
  std::string timezone;
  std::string job_ref;
  std::string misfire_policy;
  std::string next_fire;
};

inline void to_json(nlohmann::json& j, const Schedule& s) {
  j = nlohmann::json{{"id", s.id},           {"tenant", s.tenant},
                     {"cron", s.cron},       {"timezone", s.timezone},
                     {"job_ref", s.job_ref}, {"misfire_policy", s.misfire_policy},
                     {"next_fire", s.next_fire}};
}

// One recorded fire window: fired, error or skipped, and why.
struct Run {
  int64_t window;
  std::string outcome;
  std::string reason;
};

inline std::string NewId() {
  uuid_t id;
  uuid_generate(id);
  char text[37];
  uuid_unparse_lower(id, text);
  return text;
}

inline std::string LeaseKey(const std::string& schedule_id, int64_t window) {
  return "lease:" + schedule_id + ":" + std::to_string(window);
}

namespace store {

inline sw::redis::Redis& client() {
  static sw::redis::Redis redis("tcp://redis:6379");
  return redis;
}

inline void Put(const Schedule& s) {
  client().hset("schedule:" + s.id, {std::pair<std::string, std::string>{"id", s.id},
                                     {"tenant", s.tenant},
                                     {"cron", s.cron},
                                     {"timezone", s.timezone},
                                     {"job_ref", s.job_ref},
                                     {"misfire_policy", s.misfire_policy},
                                     {"next_fire", s.next_fire}});
}

// The schedule, if the store has it.
inline std::optional<Schedule> Get(const std::string& schedule_id) {
  std::unordered_map<std::string, std::string> f;
  client().hgetall("schedule:" + schedule_id, std::inserter(f, f.begin()));
  if (f.empty()) return std::nullopt;
  return Schedule{f["id"], f["tenant"], f["cron"], f["timezone"], f["job_ref"], f["misfire_policy"], f["next_fire"]};
}

// Write what happened to one fire window; a later write for the same window replaces it.
inline void RecordRun(const std::string& schedule_id, int64_t window, const std::string& outcome, const std::string& reason) {
  client().hset("runs:" + schedule_id, std::to_string(window), outcome + ":" + reason);
}

// Every recorded window, oldest first.
inline std::vector<Run> Runs(const std::string& schedule_id) {
  std::unordered_map<std::string, std::string> f;
  client().hgetall("runs:" + schedule_id, std::inserter(f, f.begin()));
  std::vector<Run> runs;
  for (const auto& [window, value] : f) {
    const size_t colon = value.find(':');
    runs.push_back(Run{std::stoll(window), value.substr(0, colon), colon == std::string::npos ? "" : value.substr(colon + 1)});
  }
  std::sort(runs.begin(), runs.end(), [](const Run& a, const Run& b) { return a.window < b.window; });
  return runs;
}

}  // namespace store

namespace outbox {

// Queue a record for the relay to publish later.
inline void Insert(const std::string& topic, const std::string& key, const nlohmann::json& payload) {
  store::client().rpush("outbox", nlohmann::json{{"topic", topic}, {"key", key}, {"payload", payload}}.dump());
}

// Everything queued, oldest first.
inline std::vector<nlohmann::json> Rows() {
  std::vector<std::string> raw;
  store::client().lrange("outbox", 0, -1, std::back_inserter(raw));
  std::vector<nlohmann::json> rows;
  for (const std::string& row : raw) rows.push_back(nlohmann::json::parse(row));
  return rows;
}

}  // namespace outbox

}  // namespace cronsched
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('cronsched', 'Cron')]: `package cronsched

import java.time.{Instant, LocalDate, LocalDateTime, ZoneId, ZoneOffset}
import java.time.format.DateTimeFormatter

/**
 * Time as the scheduler counts it. Instants are epoch seconds, ISO-8601 on the wire (formatInstant);
 * a fire window is the minute an instant falls in (windowOf). A cron expression is the five-field form
 * (minute hour day-of-month month day-of-week, Sunday = 0) evaluated in the schedule's zone. The JVM
 * has a tz database, so the offsets come from java.time for exactly the zones the other runtimes
 * compute from their rule tables.
 */
object Cron {
  val WindowS = 60L
  val MinIntervalS = 300L // the shortest cadence the scheduler accepts: five minutes
  val MisfirePolicies: Set[String] = Set("skip", "fire_once_now", "catch_up")
  val NextFireDays = 1500 // how far nextFire looks ahead: past the next February 29

  val Zones: Set[String] = Set("UTC", "Europe/London", "Europe/Berlin", "America/New_York", "Asia/Kolkata", "Asia/Tokyo")

  private val Bounds = Seq((0, 59), (0, 23), (1, 31), (1, 12), (0, 6))

  def zoneKnown(name: String): Boolean = Zones.contains(name)

  def formatInstant(instant: Long): String =
    DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").format(Instant.ofEpochSecond(instant).atOffset(ZoneOffset.UTC))

  /** The fire window an instant falls in: the start of its minute. */
  def windowOf(instant: Long): Long = Math.floorDiv(instant, WindowS) * WindowS

  /** A parsed expression: the values each field allows, and whether each day field was \`*\`. */
  final case class Spec(
      minutes: Seq[Int],
      hours: Seq[Int],
      days: Set[Int],
      months: Set[Int],
      weekdays: Set[Int],
      anyDay: Boolean,
      anyWeekday: Boolean
  )

  private def digits(text: String): Option[Int] =
    if (text.nonEmpty && text.length <= 6 && text.forall(_.isDigit)) Some(text.toInt) else None

  private def field(text: String, low: Int, high: Int): Option[Seq[Int]] = {
    val items = text.split(",", -1).toSeq.map { item =>
      val slash = item.indexOf('/')
      val base = if (slash < 0) item else item.substring(0, slash)
      val step = if (slash < 0) Some(1) else digits(item.substring(slash + 1)).filter(_ > 0)
      val range: Option[(Int, Int)] =
        if (base == "*") Some((low, high))
        else if (base.contains('-')) {
          val dash = base.indexOf('-')
          for (a <- digits(base.substring(0, dash)); b <- digits(base.substring(dash + 1))) yield (a, b)
        } else digits(base).map(a => (a, if (slash < 0) a else high))
      for {
        s <- step
        (first, last) <- range
        if first >= low && last <= high && first <= last
      } yield (first to last by s).toSeq
    }
    if (items.forall(_.isDefined)) Some(items.flatten.flatten.distinct.sorted) else None
  }

  /** The five-field expression, or None when it is not one (a sixth, seconds field included). */
  def parse(expr: String): Option[Spec] = {
    val fields = Option(expr).map(_.trim).filter(_.nonEmpty).map(_.split("\\\\s+").toSeq).getOrElse(Seq.empty)
    if (fields.length != 5) None
    else {
      val parsed = fields.zip(Bounds).map { case (text, (low, high)) => field(text, low, high) }
      if (parsed.exists(_.isEmpty)) None
      else {
        val values = parsed.map(_.get)
        Some(
          Spec(values(0), values(1), values(2).toSet, values(3).toSet, values(4).toSet, fields(2).startsWith("*"), fields(4).startsWith("*"))
        )
      }
    }
  }

  private def localDay(zone: String, instant: Long): LocalDate = Instant.ofEpochSecond(instant).atZone(ZoneId.of(zone)).toLocalDate

  /** The fire instants of one calendar day of the zone (day-of-month OR day-of-week when both are set). */
  private def dayFires(spec: Spec, zone: String, day: LocalDate): Seq[Long] = {
    val dom = spec.days.contains(day.getDayOfMonth)
    val dow = spec.weekdays.contains(day.getDayOfWeek.getValue % 7)
    val matches = if (spec.anyDay || spec.anyWeekday) dom && dow else dom || dow
    if (!spec.months.contains(day.getMonthValue) || !matches) Seq.empty
    else
      (for (h <- spec.hours; m <- spec.minutes)
        yield LocalDateTime.of(day.getYear, day.getMonthValue, day.getDayOfMonth, h, m).atZone(ZoneId.of(zone)).toEpochSecond).sorted
  }

  /** Every fire instant t with since <= t < until, oldest first. */
  def firesBetween(spec: Spec, zone: String, since: Long, until: Long): Seq[Long] = {
    val first = localDay(zone, since).minusDays(1)
    val last = localDay(zone, until).plusDays(1)
    Iterator
      .iterate(first)(_.plusDays(1))
      .takeWhile(!_.isAfter(last))
      .flatMap(day => dayFires(spec, zone, day))
      .filter(t => since <= t && t < until)
      .toSeq
      .distinct
      .sorted
  }

  /** The first fire instant strictly after \`after\`, or None when the expression never fires. */
  def nextFire(spec: Spec, zone: String, after: Long): Option[Long] = {
    val first = localDay(zone, after).minusDays(1)
    Iterator.iterate(first)(_.plusDays(1)).take(NextFireDays).flatMap(day => dayFires(spec, zone, day)).find(_ > after)
  }

  /** The shortest time between two fires of the expression, in seconds. */
  def shortestGapS(spec: Spec): Long = {
    val marks = (for (h <- spec.hours; m <- spec.minutes) yield h * 60 + m).distinct.sorted
    val gaps = marks.zip(marks.drop(1)).map { case (a, b) => b - a } :+ (marks.head + 1440 - marks.last)
    gaps.min * 60L
  }
}
`,
  [scalaPath('cronsched', 'Store')]: `package cronsched

import java.util.UUID

import scala.jdk.CollectionConverters._

import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

/** One schedule as the store holds it; misfire_policy is skip, fire_once_now or catch_up, next_fire an ISO-8601 instant. */
final case class Schedule(
    id: String,
    tenant: String,
    cron: String,
    timezone: String,
    job_ref: String,
    misfire_policy: String,
    next_fire: String
)

object Schedule {
  implicit val format: RootJsonFormat[Schedule] = jsonFormat7(Schedule.apply)
}

/** One recorded fire window: fired, error or skipped, and why. */
final case class Run(window: Long, outcome: String, reason: String)

/**
 * The schedule store, the run ledger and the outbox, in Redis. A schedule is the hash schedule:{id}
 * (every field a string); the ledger runs:{schedule_id} maps a fire window (epoch seconds) to
 * "outcome:reason", the outcome being fired, error or skipped; lease:{schedule_id}:{window} is the key
 * a fire window is claimed under; the outbox is the list outbox of JSON rows {"topic", "key", "payload"}
 * a relay publishes later.
 */
object Store {
  val jedis = new JedisPooled("redis", 6379)

  def newId(): String = UUID.randomUUID().toString

  def leaseKey(scheduleId: String, window: Long): String = s"lease:$scheduleId:$window"

  def put(s: Schedule): Unit = {
    val fields = Map(
      "id" -> s.id,
      "tenant" -> s.tenant,
      "cron" -> s.cron,
      "timezone" -> s.timezone,
      "job_ref" -> s.job_ref,
      "misfire_policy" -> s.misfire_policy,
      "next_fire" -> s.next_fire
    )
    jedis.hset(s"schedule:\${s.id}", fields.asJava)
  }

  /** The schedule, if the store has it. */
  def get(scheduleId: String): Option[Schedule] = {
    val f = jedis.hgetAll(s"schedule:$scheduleId").asScala
    if (f.isEmpty) None
    else {
      def v(name: String): String = f.getOrElse(name, "")
      Some(Schedule(v("id"), v("tenant"), v("cron"), v("timezone"), v("job_ref"), v("misfire_policy"), v("next_fire")))
    }
  }

  /** Write what happened to one fire window; a later write for the same window replaces it. */
  def recordRun(scheduleId: String, window: Long, outcome: String, reason: String): Unit =
    jedis.hset(s"runs:$scheduleId", window.toString, s"$outcome:$reason")

  /** Every recorded window, oldest first. */
  def runs(scheduleId: String): Seq[Run] =
    jedis
      .hgetAll(s"runs:$scheduleId")
      .asScala
      .toSeq
      .map { case (window, value) =>
        val colon = value.indexOf(':')
        if (colon < 0) Run(window.toLong, value, "") else Run(window.toLong, value.substring(0, colon), value.substring(colon + 1))
      }
      .sortBy(_.window)

  /** Queue a record for the relay to publish later. */
  def insertOutbox(topic: String, key: String, payload: JsValue): Unit =
    jedis.rpush("outbox", JsObject("topic" -> JsString(topic), "key" -> JsString(key), "payload" -> payload).compactPrint)

  /** Everything queued, oldest first. */
  def outboxRows(): Seq[JsValue] = jedis.lrange("outbox", 0, -1).asScala.toSeq.map(_.parseJson)
}
`,
};
