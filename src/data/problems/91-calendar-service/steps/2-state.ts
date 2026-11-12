import type {Step} from '@/lib/types';

export const stateStep: Step = {
  id: 'state',
  title: 'A generation-stamped expansion cache in Redis',
  concept: 'redis',
  guides: ['keys-and-expiry'],
  file: 'state',
  focus: ['api', 'redis'],
  task: `## Task

**Starting point.** The starter is the expansion cache every read goes through.
\`cached_expansion(calendar_id, start, end)\` reads \`gen:{calendar}\`, answers the slice
\`exp:{calendar}:{generation}\` when it is there, and otherwise expands every event with \`expand\`, lays
\`exceptions:{calendar}\` over the result with \`apply_exceptions\` and caches it.
\`bump_generation(calendar_id)\` is the \`INCR\` every write calls, and \`record_exception(calendar_id,
occurrence_id, value)\` bumps the generation and then writes the exception. It serves the demo and
hides four flaws.

**Failure mode the checks target.** A week view and the next week of one calendar, a slice nobody
reads again, a reader landing between the two commands of a change, and an instance that was moved
or cancelled.

- A slice is \`exp:{calendar}:{generation}:{start}:{end}\`: each window has its own, and one bump
  retires them all.
- Every slice expires after \`EXPANSION_TTL_S = 300\` seconds.
- \`record_exception\` writes the exception first and bumps second, so a reader that sees the new
  generation also sees the exception.
- \`"cancelled"\` drops the occurrence; \`"moved:{ISO start}"\` lists it once, under the same occurrence
  id, at its new start with its length kept.`,
  sequence: {
    participants: ['Calendar API', 'Redis'],
    messages: [
      {from: 'Calendar API', to: 'Redis', label: 'GET gen:{cal}', kind: 'sync'},
      {from: 'Calendar API', to: 'Redis', label: 'GET exp:{cal}:{gen}:{start}:{end}', kind: 'sync'},
      {from: 'Redis', to: 'Calendar API', label: 'slice · or miss', kind: 'reply'},
      {from: 'Calendar API', to: 'Redis', label: 'miss: events · exceptions:{cal}', kind: 'sync'},
      {from: 'Calendar API', to: 'Calendar API', label: 'expand · drop cancelled · move in place', kind: 'sync'},
      {from: 'Calendar API', to: 'Redis', label: 'SET slice EX 300', kind: 'async'},
      {from: 'Calendar API', to: 'Redis', label: 'change: HSET exceptions, then INCR gen', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'range-key',
      title: 'Caches one slice per window',
      detail:
        'The week of 2 March and the week of 9 March of one calendar answer their own occurrences. The starter keys the slice by calendar and generation only, so the second week is answered with the first.',
      match: {
        python: {all: [/slice_key\(\s*[\w.]+\s*,\s*[\w.()]+\s*,\s*\w+\s*,\s*\w+\s*\)/]},
        typescript: {all: [/sliceKey\(\s*[\w.]+\s*,\s*[\w.()\s]+\s*,\s*\w+\s*,\s*\w+\s*\)/]},
        go: {all: [/sliceKey\(\s*\w+\s*,\s*\w+\s*,\s*\w+\s*,\s*\w+\s*\)/]},
        scala: {all: [/sliceKey\(\s*\w+\s*,\s*[\w()]+\s*,\s*\w+\s*,\s*\w+\s*\)/]},
        cpp: {all: [/sliceKey\(\s*\w+\s*,\s*[\w()]+\s*,\s*\w+\s*,\s*\w+\s*\)/]},
      },
    },
    {
      id: 'ttl',
      title: 'Expires every slice after 300 seconds',
      detail:
        'A cached slice carries a TTL of at most 300 s and is gone 301 s later. The starter writes slices that never expire, so every retired generation stays in memory.',
      match: {
        python: {all: [/\bex\s*=\s*(EXPANSION_TTL_S|300)\b|setex\(/]},
        typescript: {all: [/['"]EX['"]\s*,\s*(EXPANSION_TTL_S|300)\b/]},
        go: {all: [/rdb\.Set\([^\n]*,\s*(expansionTTL|300\s*\*\s*time\.Second)\s*\)/]},
        scala: {all: [/setex\([^\n]*(ExpansionTtlS|300)/]},
        cpp: {all: [/\.set\([^\n]*(kExpansionTtl|std::chrono::seconds[({]\s*300)/]},
      },
    },
    {
      id: 'write-then-bump',
      title: 'Writes the exception before bumping the generation',
      detail:
        'At the instant `gen:{calendar}` moves, the exception is already in `exceptions:{calendar}`. The starter bumps first, so a reader in between expands the old calendar and caches it under the new generation for the whole TTL.',
      match: {
        python: {order: [/def record_exception\(/, /store\.put_exception\(/, /bump_generation\(/]},
        typescript: {order: [/function recordException\(/, /store\.putException\(/, /bumpGeneration\(/]},
        go: {order: [/func recordException\(/, /store\.PutException\(/, /bumpGeneration\(/]},
        scala: {order: [/def recordException\(/, /Store\.putException\(/, /bumpGeneration\(/]},
        cpp: {order: [/void recordException\(/, /store::PutException\(/, /bumpGeneration\(/]},
      },
    },
    {
      id: 'exceptions',
      title: 'Drops cancelled instances and moves moved ones in place',
      detail:
        'A cancelled occurrence is not listed; a moved one is listed once, at its new start and end, under its occurrence id. The starter ignores cancellations and lists a moved instance twice: at its old time and at its new one.',
      match: {
        python: {all: [/==\s*["']cancelled["']/], none: [/\.append\(\s*moved\s*\)/]},
        typescript: {all: [/===\s*['"]cancelled['"]/], none: [/\.push\(\s*moved\s*\)/]},
        go: {all: [/==\s*"cancelled"/], none: [/append\(\s*applied\s*,\s*moved\s*\)/]},
        scala: {all: [/==\s*"cancelled"/], none: [/\+=\s*moved\b/]},
        cpp: {all: [/==\s*"cancelled"/], none: [/push_back\(\s*moved\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

from calendard.rrule import expand, format_instant, parse_instant
from calendard.store import store

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def generation_key(calendar_id: str) -> str:
    return f"gen:{calendar_id}"


def slice_key(calendar_id: str, generation: int) -> str:
    return f"exp:{calendar_id}:{generation}"


def current_generation(calendar_id: str) -> int:
    return int(r.get(generation_key(calendar_id)) or 0)


def bump_generation(calendar_id: str) -> int:
    """A change to the calendar: every slice cached under the old generation stops being read."""
    return r.incr(generation_key(calendar_id))


def apply_exceptions(occurrences: list[dict], exceptions: dict[str, str]) -> list[dict]:
    """Lay the calendar's instance exceptions over its expansion."""
    applied = []
    for occurrence in occurrences:
        applied.append(occurrence)
        value = exceptions.get(occurrence["occurrence_id"], "")
        if value.startswith("moved:"):
            start = parse_instant(value[len("moved:"):])
            length = parse_instant(occurrence["end"]) - parse_instant(occurrence["start"])
            moved = {**occurrence, "start": format_instant(start), "end": format_instant(start + length)}
            applied.append(moved)
    return applied


def cached_expansion(calendar_id: str, start: int, end: int) -> list[dict]:
    """The calendar's occurrences overlapping [start, end), exceptions applied, earliest first."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    key = slice_key(calendar_id, current_generation(calendar_id))
    hit = r.get(key)
    if hit is not None:
        return json.loads(hit)
    occurrences = [o for event in store.list_events(calendar_id) for o in expand(event, start, end)]
    occurrences = apply_exceptions(occurrences, store.get_exceptions(calendar_id))
    occurrences.sort(key=lambda o: (o["start"], o["occurrence_id"]))
    r.set(key, json.dumps(occurrences))
    return occurrences


def record_exception(calendar_id: str, occurrence_id: str, value: str) -> None:
    """Cancel ("cancelled") or move ("moved:{ISO start}") one occurrence."""
    bump_generation(calendar_id)
    store.put_exception(calendar_id, occurrence_id, value)
`,
      solution: `import json

import redis

from calendard.rrule import expand, format_instant, parse_instant
from calendard.store import store

EXPANSION_TTL_S = 300

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def generation_key(calendar_id: str) -> str:
    return f"gen:{calendar_id}"


def slice_key(calendar_id: str, generation: int, start: int, end: int) -> str:
    """One slice per window and generation: a bump retires every window at once."""
    return f"exp:{calendar_id}:{generation}:{start}:{end}"


def current_generation(calendar_id: str) -> int:
    return int(r.get(generation_key(calendar_id)) or 0)


def bump_generation(calendar_id: str) -> int:
    """A change to the calendar: every slice cached under the old generation stops being read."""
    return r.incr(generation_key(calendar_id))


def apply_exceptions(occurrences: list[dict], exceptions: dict[str, str]) -> list[dict]:
    """A cancelled occurrence is dropped; a moved one is the same occurrence at its new start, listed once."""
    applied = []
    for occurrence in occurrences:
        value = exceptions.get(occurrence["occurrence_id"], "")
        if value == "cancelled":
            continue
        if value.startswith("moved:"):
            start = parse_instant(value[len("moved:"):])
            length = parse_instant(occurrence["end"]) - parse_instant(occurrence["start"])
            occurrence = {**occurrence, "start": format_instant(start), "end": format_instant(start + length)}
        applied.append(occurrence)
    return applied


def cached_expansion(calendar_id: str, start: int, end: int) -> list[dict]:
    """The calendar's occurrences overlapping [start, end), exceptions applied, earliest first."""
    # The generation is read before the events: a change that lands during the expansion bumps it,
    # so what this call caches is filed under a generation no reader asks for any more.
    key = slice_key(calendar_id, current_generation(calendar_id), start, end)
    hit = r.get(key)
    if hit is not None:
        return json.loads(hit)
    occurrences = [o for event in store.list_events(calendar_id) for o in expand(event, start, end)]
    occurrences = apply_exceptions(occurrences, store.get_exceptions(calendar_id))
    occurrences.sort(key=lambda o: (o["start"], o["occurrence_id"]))
    r.set(key, json.dumps(occurrences), ex=EXPANSION_TTL_S)
    return occurrences


def record_exception(calendar_id: str, occurrence_id: str, value: str) -> None:
    """Cancel ("cancelled") or move ("moved:{ISO start}") one occurrence."""
    # Write, then bump: a reader that sees the new generation also sees the exception.
    store.put_exception(calendar_id, occurrence_id, value)
    bump_generation(calendar_id)
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {type Occurrence, expand, formatInstant, parseInstant} from 'calendard/rrule';
import {store} from 'calendard/store';

const redis = new Redis({host: 'redis', port: 6379});

export const generationKey = (calendarId: string): string => \`gen:\${calendarId}\`;

export const sliceKey = (calendarId: string, generation: number): string => \`exp:\${calendarId}:\${generation}\`;

export async function currentGeneration(calendarId: string): Promise<number> {
  return Number((await redis.get(generationKey(calendarId))) ?? 0);
}

/** A change to the calendar: every slice cached under the old generation stops being read. */
export async function bumpGeneration(calendarId: string): Promise<number> {
  return redis.incr(generationKey(calendarId));
}

/** Lay the calendar's instance exceptions over its expansion. */
export function applyExceptions(occurrences: Occurrence[], exceptions: Record<string, string>): Occurrence[] {
  const applied: Occurrence[] = [];
  for (const occurrence of occurrences) {
    applied.push(occurrence);
    const value = exceptions[occurrence.occurrence_id] ?? '';
    if (value.startsWith('moved:')) {
      const start = parseInstant(value.slice('moved:'.length))!;
      const length = parseInstant(occurrence.end)! - parseInstant(occurrence.start)!;
      const moved = {...occurrence, start: formatInstant(start), end: formatInstant(start + length)};
      applied.push(moved);
    }
  }
  return applied;
}

/** The calendar's occurrences overlapping [start, end), exceptions applied, earliest first. */
export async function cachedExpansion(calendarId: string, start: number, end: number): Promise<Occurrence[]> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const key = sliceKey(calendarId, await currentGeneration(calendarId));
  const hit = await redis.get(key);
  if (hit !== null) return JSON.parse(hit);
  const expanded = (await store.listEvents(calendarId)).flatMap(event => expand(event, start, end));
  const occurrences = applyExceptions(expanded, await store.getExceptions(calendarId));
  occurrences.sort((a, b) => (a.start + a.occurrence_id < b.start + b.occurrence_id ? -1 : 1));
  await redis.set(key, JSON.stringify(occurrences));
  return occurrences;
}

/** Cancel ("cancelled") or move ("moved:{ISO start}") one occurrence. */
export async function recordException(calendarId: string, occurrenceId: string, value: string): Promise<void> {
  await bumpGeneration(calendarId);
  await store.putException(calendarId, occurrenceId, value);
}
`,
      solution: `import Redis from 'ioredis';

import {type Occurrence, expand, formatInstant, parseInstant} from 'calendard/rrule';
import {store} from 'calendard/store';

export const EXPANSION_TTL_S = 300;

const redis = new Redis({host: 'redis', port: 6379});

export const generationKey = (calendarId: string): string => \`gen:\${calendarId}\`;

/** One slice per window and generation: a bump retires every window at once. */
export const sliceKey = (calendarId: string, generation: number, start: number, end: number): string =>
  \`exp:\${calendarId}:\${generation}:\${start}:\${end}\`;

export async function currentGeneration(calendarId: string): Promise<number> {
  return Number((await redis.get(generationKey(calendarId))) ?? 0);
}

/** A change to the calendar: every slice cached under the old generation stops being read. */
export async function bumpGeneration(calendarId: string): Promise<number> {
  return redis.incr(generationKey(calendarId));
}

/** A cancelled occurrence is dropped; a moved one is the same occurrence at its new start, listed once. */
export function applyExceptions(occurrences: Occurrence[], exceptions: Record<string, string>): Occurrence[] {
  const applied: Occurrence[] = [];
  for (const occurrence of occurrences) {
    const value = exceptions[occurrence.occurrence_id] ?? '';
    if (value === 'cancelled') continue;
    if (value.startsWith('moved:')) {
      const start = parseInstant(value.slice('moved:'.length))!;
      const length = parseInstant(occurrence.end)! - parseInstant(occurrence.start)!;
      applied.push({...occurrence, start: formatInstant(start), end: formatInstant(start + length)});
    } else {
      applied.push(occurrence);
    }
  }
  return applied;
}

/** The calendar's occurrences overlapping [start, end), exceptions applied, earliest first. */
export async function cachedExpansion(calendarId: string, start: number, end: number): Promise<Occurrence[]> {
  // The generation is read before the events: a change that lands during the expansion bumps it,
  // so what this call caches is filed under a generation no reader asks for any more.
  const key = sliceKey(calendarId, await currentGeneration(calendarId), start, end);
  const hit = await redis.get(key);
  if (hit !== null) return JSON.parse(hit);
  const expanded = (await store.listEvents(calendarId)).flatMap(event => expand(event, start, end));
  const occurrences = applyExceptions(expanded, await store.getExceptions(calendarId));
  occurrences.sort((a, b) => (a.start + a.occurrence_id < b.start + b.occurrence_id ? -1 : 1));
  await redis.set(key, JSON.stringify(occurrences), 'EX', EXPANSION_TTL_S);
  return occurrences;
}

/** Cancel ("cancelled") or move ("moved:{ISO start}") one occurrence. */
export async function recordException(calendarId: string, occurrenceId: string, value: string): Promise<void> {
  // Write, then bump: a reader that sees the new generation also sees the exception.
  await store.putException(calendarId, occurrenceId, value);
  await bumpGeneration(calendarId);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"

	"calendard/rrule"
	"calendard/store"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func generationKey(calendarID string) string { return "gen:" + calendarID }

func sliceKey(calendarID string, generation int64) string {
	return "exp:" + calendarID + ":" + strconv.FormatInt(generation, 10)
}

func currentGeneration(ctx context.Context, calendarID string) (int64, error) {
	generation, err := rdb.Get(ctx, generationKey(calendarID)).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return generation, err
}

// bumpGeneration is a change to the calendar: every slice cached under the old generation stops being read.
func bumpGeneration(ctx context.Context, calendarID string) (int64, error) {
	return rdb.Incr(ctx, generationKey(calendarID)).Result()
}

// applyExceptions lays the calendar's instance exceptions over its expansion.
func applyExceptions(occurrences []rrule.Occurrence, exceptions map[string]string) []rrule.Occurrence {
	applied := []rrule.Occurrence{}
	for _, o := range occurrences {
		applied = append(applied, o)
		value := exceptions[o.OccurrenceID]
		if strings.HasPrefix(value, "moved:") {
			start, _ := rrule.ParseInstant(strings.TrimPrefix(value, "moved:"))
			from, _ := rrule.ParseInstant(o.Start)
			to, _ := rrule.ParseInstant(o.End)
			moved := o
			moved.Start, moved.End = rrule.FormatInstant(start), rrule.FormatInstant(start+to-from)
			applied = append(applied, moved)
		}
	}
	return applied
}

// cachedExpansion is the calendar's occurrences overlapping [start, end), exceptions applied, earliest first.
func cachedExpansion(ctx context.Context, calendarID string, start, end int64) ([]rrule.Occurrence, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	generation, err := currentGeneration(ctx, calendarID)
	if err != nil {
		return nil, err
	}
	key := sliceKey(calendarID, generation)
	hit, err := rdb.Get(ctx, key).Result()
	if err == nil {
		var cached []rrule.Occurrence
		if err := json.Unmarshal([]byte(hit), &cached); err != nil {
			return nil, err
		}
		return cached, nil
	}
	if err != redis.Nil {
		return nil, err
	}
	events, err := store.ListEvents(ctx, calendarID)
	if err != nil {
		return nil, err
	}
	expanded := []rrule.Occurrence{}
	for _, e := range events {
		expanded = append(expanded, rrule.Expand(e, start, end)...)
	}
	exceptions, err := store.GetExceptions(ctx, calendarID)
	if err != nil {
		return nil, err
	}
	occurrences := applyExceptions(expanded, exceptions)
	sort.Slice(occurrences, func(i, j int) bool {
		return occurrences[i].Start+occurrences[i].OccurrenceID < occurrences[j].Start+occurrences[j].OccurrenceID
	})
	value, _ := json.Marshal(occurrences)
	if err := rdb.Set(ctx, key, value, 0).Err(); err != nil {
		return nil, err
	}
	return occurrences, nil
}

// recordException cancels ("cancelled") or moves ("moved:{ISO start}") one occurrence.
func recordException(ctx context.Context, calendarID, occurrenceID, value string) error {
	if _, err := bumpGeneration(ctx, calendarID); err != nil {
		return err
	}
	return store.PutException(ctx, calendarID, occurrenceID, value)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"calendard/rrule"
	"calendard/store"
)

const expansionTTL = 300 * time.Second

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func generationKey(calendarID string) string { return "gen:" + calendarID }

// sliceKey names one slice per window and generation: a bump retires every window at once.
func sliceKey(calendarID string, generation, start, end int64) string {
	return "exp:" + calendarID + ":" + strconv.FormatInt(generation, 10) + ":" + strconv.FormatInt(start, 10) + ":" + strconv.FormatInt(end, 10)
}

func currentGeneration(ctx context.Context, calendarID string) (int64, error) {
	generation, err := rdb.Get(ctx, generationKey(calendarID)).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return generation, err
}

// bumpGeneration is a change to the calendar: every slice cached under the old generation stops being read.
func bumpGeneration(ctx context.Context, calendarID string) (int64, error) {
	return rdb.Incr(ctx, generationKey(calendarID)).Result()
}

// applyExceptions drops a cancelled occurrence and lists a moved one once, at its new start.
func applyExceptions(occurrences []rrule.Occurrence, exceptions map[string]string) []rrule.Occurrence {
	applied := []rrule.Occurrence{}
	for _, o := range occurrences {
		value := exceptions[o.OccurrenceID]
		if value == "cancelled" {
			continue
		}
		if strings.HasPrefix(value, "moved:") {
			start, _ := rrule.ParseInstant(strings.TrimPrefix(value, "moved:"))
			from, _ := rrule.ParseInstant(o.Start)
			to, _ := rrule.ParseInstant(o.End)
			o.Start, o.End = rrule.FormatInstant(start), rrule.FormatInstant(start+to-from)
		}
		applied = append(applied, o)
	}
	return applied
}

// cachedExpansion is the calendar's occurrences overlapping [start, end), exceptions applied, earliest first.
func cachedExpansion(ctx context.Context, calendarID string, start, end int64) ([]rrule.Occurrence, error) {
	// The generation is read before the events: a change that lands during the expansion bumps it,
	// so what this call caches is filed under a generation no reader asks for any more.
	generation, err := currentGeneration(ctx, calendarID)
	if err != nil {
		return nil, err
	}
	key := sliceKey(calendarID, generation, start, end)
	hit, err := rdb.Get(ctx, key).Result()
	if err == nil {
		var cached []rrule.Occurrence
		if err := json.Unmarshal([]byte(hit), &cached); err != nil {
			return nil, err
		}
		return cached, nil
	}
	if err != redis.Nil {
		return nil, err
	}
	events, err := store.ListEvents(ctx, calendarID)
	if err != nil {
		return nil, err
	}
	expanded := []rrule.Occurrence{}
	for _, e := range events {
		expanded = append(expanded, rrule.Expand(e, start, end)...)
	}
	exceptions, err := store.GetExceptions(ctx, calendarID)
	if err != nil {
		return nil, err
	}
	occurrences := applyExceptions(expanded, exceptions)
	sort.Slice(occurrences, func(i, j int) bool {
		return occurrences[i].Start+occurrences[i].OccurrenceID < occurrences[j].Start+occurrences[j].OccurrenceID
	})
	value, _ := json.Marshal(occurrences)
	if err := rdb.Set(ctx, key, value, expansionTTL).Err(); err != nil {
		return nil, err
	}
	return occurrences, nil
}

// recordException cancels ("cancelled") or moves ("moved:{ISO start}") one occurrence.
func recordException(ctx context.Context, calendarID, occurrenceID, value string) error {
	// Write, then bump: a reader that sees the new generation also sees the exception.
	if err := store.PutException(ctx, calendarID, occurrenceID, value); err != nil {
		return err
	}
	_, err := bumpGeneration(ctx, calendarID)
	return err
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import calendard.{Occurrence, Rrule, Store}

object ExpansionCache {
  private val jedis = new JedisPooled("redis", 6379)

  def generationKey(calendarId: String): String = s"gen:$calendarId"

  def sliceKey(calendarId: String, generation: Long): String = s"exp:$calendarId:$generation"

  def currentGeneration(calendarId: String): Long = Option(jedis.get(generationKey(calendarId))).map(_.toLong).getOrElse(0L)

  /** A change to the calendar: every slice cached under the old generation stops being read. */
  def bumpGeneration(calendarId: String): Long = jedis.incr(generationKey(calendarId))

  /** Lay the calendar's instance exceptions over its expansion. */
  def applyExceptions(occurrences: Seq[Occurrence], exceptions: Map[String, String]): Seq[Occurrence] = {
    val applied = Seq.newBuilder[Occurrence]
    for (occurrence <- occurrences) {
      applied += occurrence
      val value = exceptions.getOrElse(occurrence.occurrence_id, "")
      if (value.startsWith("moved:")) {
        val start = Rrule.parseInstant(value.stripPrefix("moved:")).getOrElse(0L)
        val length = Rrule.parseInstant(occurrence.end).getOrElse(0L) - Rrule.parseInstant(occurrence.start).getOrElse(0L)
        val moved = occurrence.copy(start = Rrule.formatInstant(start), end = Rrule.formatInstant(start + length))
        applied += moved
      }
    }
    applied.result()
  }

  /** The calendar's occurrences overlapping [start, end), exceptions applied, earliest first. */
  def cachedExpansion(calendarId: String, start: Long, end: Long): Seq[Occurrence] = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val key = sliceKey(calendarId, currentGeneration(calendarId))
    Option(jedis.get(key)) match {
      case Some(hit) => hit.parseJson.convertTo[Seq[Occurrence]]
      case None =>
        val expanded = Store.listEvents(calendarId).flatMap(event => Rrule.expand(event, start, end))
        val occurrences = applyExceptions(expanded, Store.getExceptions(calendarId)).sortBy(o => (o.start, o.occurrence_id))
        jedis.set(key, occurrences.toJson.compactPrint)
        occurrences
    }
  }

  /** Cancel ("cancelled") or move ("moved:{ISO start}") one occurrence. */
  def recordException(calendarId: String, occurrenceId: String, value: String): Unit = {
    bumpGeneration(calendarId)
    Store.putException(calendarId, occurrenceId, value)
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import spray.json._
import spray.json.DefaultJsonProtocol._

import calendard.{Occurrence, Rrule, Store}

object ExpansionCache {
  val ExpansionTtlS = 300L

  private val jedis = new JedisPooled("redis", 6379)

  def generationKey(calendarId: String): String = s"gen:$calendarId"

  /** One slice per window and generation: a bump retires every window at once. */
  def sliceKey(calendarId: String, generation: Long, start: Long, end: Long): String = s"exp:$calendarId:$generation:$start:$end"

  def currentGeneration(calendarId: String): Long = Option(jedis.get(generationKey(calendarId))).map(_.toLong).getOrElse(0L)

  /** A change to the calendar: every slice cached under the old generation stops being read. */
  def bumpGeneration(calendarId: String): Long = jedis.incr(generationKey(calendarId))

  /** A cancelled occurrence is dropped; a moved one is the same occurrence at its new start, listed once. */
  def applyExceptions(occurrences: Seq[Occurrence], exceptions: Map[String, String]): Seq[Occurrence] =
    occurrences.flatMap { occurrence =>
      val value = exceptions.getOrElse(occurrence.occurrence_id, "")
      if (value == "cancelled") None
      else if (value.startsWith("moved:")) {
        val start = Rrule.parseInstant(value.stripPrefix("moved:")).getOrElse(0L)
        val length = Rrule.parseInstant(occurrence.end).getOrElse(0L) - Rrule.parseInstant(occurrence.start).getOrElse(0L)
        Some(occurrence.copy(start = Rrule.formatInstant(start), end = Rrule.formatInstant(start + length)))
      } else Some(occurrence)
    }

  /** The calendar's occurrences overlapping [start, end), exceptions applied, earliest first. */
  def cachedExpansion(calendarId: String, start: Long, end: Long): Seq[Occurrence] = {
    // The generation is read before the events: a change that lands during the expansion bumps it,
    // so what this call caches is filed under a generation no reader asks for any more.
    val key = sliceKey(calendarId, currentGeneration(calendarId), start, end)
    Option(jedis.get(key)) match {
      case Some(hit) => hit.parseJson.convertTo[Seq[Occurrence]]
      case None =>
        val expanded = Store.listEvents(calendarId).flatMap(event => Rrule.expand(event, start, end))
        val occurrences = applyExceptions(expanded, Store.getExceptions(calendarId)).sortBy(o => (o.start, o.occurrence_id))
        jedis.setex(key, ExpansionTtlS, occurrences.toJson.compactPrint)
        occurrences
    }
  }

  /** Cancel ("cancelled") or move ("moved:{ISO start}") one occurrence. */
  def recordException(calendarId: String, occurrenceId: String, value: String): Unit = {
    // Write, then bump: a reader that sees the new generation also sees the exception.
    Store.putException(calendarId, occurrenceId, value)
    bumpGeneration(calendarId)
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <map>
#include <string>
#include <vector>

#include "calendard/rrule.h"
#include "calendard/store.h"

static sw::redis::Redis& cacheRedis() {
  static sw::redis::Redis redis("tcp://redis:6379");
  return redis;
}

std::string generationKey(const std::string& calendar_id) { return "gen:" + calendar_id; }

std::string sliceKey(const std::string& calendar_id, long long generation) {
  return "exp:" + calendar_id + ":" + std::to_string(generation);
}

long long currentGeneration(const std::string& calendar_id) {
  const auto value = cacheRedis().get(generationKey(calendar_id));
  return value ? std::stoll(*value) : 0;
}

// A change to the calendar: every slice cached under the old generation stops being read.
long long bumpGeneration(const std::string& calendar_id) { return cacheRedis().incr(generationKey(calendar_id)); }

// Lay the calendar's instance exceptions over its expansion.
std::vector<calendard::Occurrence> applyExceptions(const std::vector<calendard::Occurrence>& occurrences,
                                                   const std::map<std::string, std::string>& exceptions) {
  std::vector<calendard::Occurrence> applied;
  for (const auto& occurrence : occurrences) {
    applied.push_back(occurrence);
    const auto it = exceptions.find(occurrence.occurrence_id);
    const std::string value = it == exceptions.end() ? "" : it->second;
    if (value.rfind("moved:", 0) == 0) {
      const int64_t start = calendard::rrule::ParseInstant(value.substr(6)).value_or(0);
      const int64_t length = calendard::rrule::ParseInstant(occurrence.end).value_or(0) -
                             calendard::rrule::ParseInstant(occurrence.start).value_or(0);
      calendard::Occurrence moved = occurrence;
      moved.start = calendard::rrule::FormatInstant(start);
      moved.end = calendard::rrule::FormatInstant(start + length);
      applied.push_back(moved);
    }
  }
  return applied;
}

// The calendar's occurrences overlapping [start, end), exceptions applied, earliest first.
std::vector<calendard::Occurrence> cachedExpansion(const std::string& calendar_id, int64_t start, int64_t end) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string key = sliceKey(calendar_id, currentGeneration(calendar_id));
  if (const auto hit = cacheRedis().get(key)) return nlohmann::json::parse(*hit).get<std::vector<calendard::Occurrence>>();
  std::vector<calendard::Occurrence> expanded;
  for (const auto& event : calendard::store::ListEvents(calendar_id)) {
    for (const auto& o : calendard::rrule::Expand(event, start, end)) expanded.push_back(o);
  }
  auto occurrences = applyExceptions(expanded, calendard::store::GetExceptions(calendar_id));
  std::sort(occurrences.begin(), occurrences.end(), [](const calendard::Occurrence& a, const calendard::Occurrence& b) {
    return a.start + a.occurrence_id < b.start + b.occurrence_id;
  });
  cacheRedis().set(key, nlohmann::json(occurrences).dump());
  return occurrences;
}

// Cancel ("cancelled") or move ("moved:{ISO start}") one occurrence.
void recordException(const std::string& calendar_id, const std::string& occurrence_id, const std::string& value) {
  bumpGeneration(calendar_id);
  calendard::store::PutException(calendar_id, occurrence_id, value);
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <map>
#include <string>
#include <vector>

#include "calendard/rrule.h"
#include "calendard/store.h"

constexpr std::chrono::seconds kExpansionTtl{300};

static sw::redis::Redis& cacheRedis() {
  static sw::redis::Redis redis("tcp://redis:6379");
  return redis;
}

std::string generationKey(const std::string& calendar_id) { return "gen:" + calendar_id; }

// One slice per window and generation: a bump retires every window at once.
std::string sliceKey(const std::string& calendar_id, long long generation, int64_t start, int64_t end) {
  return "exp:" + calendar_id + ":" + std::to_string(generation) + ":" + std::to_string(start) + ":" + std::to_string(end);
}

long long currentGeneration(const std::string& calendar_id) {
  const auto value = cacheRedis().get(generationKey(calendar_id));
  return value ? std::stoll(*value) : 0;
}

// A change to the calendar: every slice cached under the old generation stops being read.
long long bumpGeneration(const std::string& calendar_id) { return cacheRedis().incr(generationKey(calendar_id)); }

// A cancelled occurrence is dropped; a moved one is the same occurrence at its new start, listed once.
std::vector<calendard::Occurrence> applyExceptions(const std::vector<calendard::Occurrence>& occurrences,
                                                   const std::map<std::string, std::string>& exceptions) {
  std::vector<calendard::Occurrence> applied;
  for (calendard::Occurrence occurrence : occurrences) {
    const auto it = exceptions.find(occurrence.occurrence_id);
    const std::string value = it == exceptions.end() ? "" : it->second;
    if (value == "cancelled") continue;
    if (value.rfind("moved:", 0) == 0) {
      const int64_t start = calendard::rrule::ParseInstant(value.substr(6)).value_or(0);
      const int64_t length = calendard::rrule::ParseInstant(occurrence.end).value_or(0) -
                             calendard::rrule::ParseInstant(occurrence.start).value_or(0);
      occurrence.start = calendard::rrule::FormatInstant(start);
      occurrence.end = calendard::rrule::FormatInstant(start + length);
    }
    applied.push_back(occurrence);
  }
  return applied;
}

// The calendar's occurrences overlapping [start, end), exceptions applied, earliest first.
std::vector<calendard::Occurrence> cachedExpansion(const std::string& calendar_id, int64_t start, int64_t end) {
  // The generation is read before the events: a change that lands during the expansion bumps it,
  // so what this call caches is filed under a generation no reader asks for any more.
  const std::string key = sliceKey(calendar_id, currentGeneration(calendar_id), start, end);
  if (const auto hit = cacheRedis().get(key)) return nlohmann::json::parse(*hit).get<std::vector<calendard::Occurrence>>();
  std::vector<calendard::Occurrence> expanded;
  for (const auto& event : calendard::store::ListEvents(calendar_id)) {
    for (const auto& o : calendard::rrule::Expand(event, start, end)) expanded.push_back(o);
  }
  auto occurrences = applyExceptions(expanded, calendard::store::GetExceptions(calendar_id));
  std::sort(occurrences.begin(), occurrences.end(), [](const calendard::Occurrence& a, const calendard::Occurrence& b) {
    return a.start + a.occurrence_id < b.start + b.occurrence_id;
  });
  cacheRedis().set(key, nlohmann::json(occurrences).dump(), kExpansionTtl);
  return occurrences;
}

// Cancel ("cancelled") or move ("moved:{ISO start}") one occurrence.
void recordException(const std::string& calendar_id, const std::string& occurrence_id, const std::string& value) {
  // Write, then bump: a reader that sees the new generation also sees the exception.
  calendard::store::PutException(calendar_id, occurrence_id, value);
  bumpGeneration(calendar_id);
}
`,
    },
  },
  harness: {
    python: `from calendard.rrule import parse_instant
from calendard.store import store

WEEK_1 = (parse_instant("2026-03-02T00:00:00Z"), parse_instant("2026-03-09T00:00:00Z"))
WEEK_2 = (parse_instant("2026-03-09T00:00:00Z"), parse_instant("2026-03-16T00:00:00Z"))
# A 30-minute daily standup, ten times from Monday 2 March 2026.
EVENT = {
    "event_id": "e-1",
    "calendar_id": "c1",
    "tenant": "t1",
    "title": "Standup",
    "rrule": "FREQ=DAILY;COUNT=10",
    "dtstart": "2026-03-02T09:00:00Z",
    "dtend": "2026-03-02T09:30:00Z",
    "revision": 1,
    "attendees": ["ana@example.com"],
}


def _world(ctx):
    store.put_calendar("c1", "public", ["t1"])
    store.put_event(dict(EVENT))
    return ctx.load("state")


def _occurrence(day):
    return f"e-1:{parse_instant(f'2026-03-{day:02d}T09:00:00Z')}"


def _starts(occurrences):
    return [o["start"] for o in occurrences]


def check_range_key(ctx):
    m = _world(ctx)
    week_1 = m.cached_expansion("c1", *WEEK_1)
    assert len(week_1) == 7, f"the week of 2 March answered {len(week_1)} standups, expected 7: {_starts(week_1)}"
    week_2 = m.cached_expansion("c1", *WEEK_2)
    expected = ["2026-03-09T09:00:00Z", "2026-03-10T09:00:00Z", "2026-03-11T09:00:00Z"]
    assert _starts(week_2) == expected, f"the week of 9 March answered {_starts(week_2)}, expected {expected}: the slice cached for one window was served for another"
    again = m.cached_expansion("c1", *WEEK_1)
    assert _starts(again) == _starts(week_1), f"the week of 2 March, read again, answered {_starts(again)}"


def check_ttl(ctx):
    m = _world(ctx)
    m.cached_expansion("c1", *WEEK_1)
    keys = ctx.redis.keys("exp:*")
    assert keys, "cached_expansion cached nothing under exp:*"
    for key in keys:
        ttl = ctx.redis.ttl(key)
        assert 0 < ttl <= 300, f"{key} has TTL {ttl}: a slice must expire within 300 s, or every retired generation stays in memory"
    ctx.clock.advance(301)
    assert ctx.redis.keys("exp:*") == [], f"301 s later Redis still holds {ctx.redis.keys('exp:*')}"


def check_write_then_bump(ctx):
    m = _world(ctx)
    m.cached_expansion("c1", *WEEK_1)  # the week is cached
    cancelled = _occurrence(4)
    # The state of the world at the instant the generation moves: what a reader landing right then would expand.
    probe = ctx.redis_after("gen:c1", lambda: ctx.redis.hget("exceptions:c1", cancelled))
    m.record_exception("c1", cancelled, "cancelled")
    assert probe.fired, "record_exception never bumped gen:c1: the cached week stays the week before the change"
    assert probe.result == "cancelled", "when gen:c1 moved the exception was not written yet: a reader in between expands the old calendar and caches it under the new generation for the whole TTL. Write the exception, then bump"
    ids = [o["occurrence_id"] for o in m.cached_expansion("c1", *WEEK_1)]
    assert cancelled not in ids, "after record_exception the cancelled 4 March standup is still in the week"


def check_exceptions(ctx):
    m = _world(ctx)
    store.put_exception("c1", _occurrence(3), "cancelled")
    store.put_exception("c1", _occurrence(5), "moved:2026-03-05T14:00:00Z")
    week = m.cached_expansion("c1", *WEEK_1)
    ids = [o["occurrence_id"] for o in week]
    assert _occurrence(3) not in ids, f"the cancelled 3 March standup is still listed: {_starts(week)}"
    assert ids.count(_occurrence(5)) == 1, f"the moved 5 March standup is listed {ids.count(_occurrence(5))} times: {_starts(week)}. A moved instance replaces the original"
    moved = next(o for o in week if o["occurrence_id"] == _occurrence(5))
    assert moved["start"] == "2026-03-05T14:00:00Z" and moved["end"] == "2026-03-05T14:30:00Z", f"the moved standup is {moved}, expected 14:00 to 14:30 on 5 March"
    assert len(week) == 6, f"the week answered {len(week)} standups, expected 6 (7 minus the cancelled one): {_starts(week)}"
`,
    typescript: `import {parseInstant} from 'calendard/rrule';
import {store} from 'calendard/store';

const WEEK_1: [number, number] = [parseInstant('2026-03-02T00:00:00Z')!, parseInstant('2026-03-09T00:00:00Z')!];
const WEEK_2: [number, number] = [parseInstant('2026-03-09T00:00:00Z')!, parseInstant('2026-03-16T00:00:00Z')!];
// A 30-minute daily standup, ten times from Monday 2 March 2026.
const EVENT = {
  event_id: 'e-1',
  calendar_id: 'c1',
  tenant: 't1',
  title: 'Standup',
  rrule: 'FREQ=DAILY;COUNT=10',
  dtstart: '2026-03-02T09:00:00Z',
  dtend: '2026-03-02T09:30:00Z',
  revision: 1,
  attendees: ['ana@example.com'],
};

async function world(ctx) {
  await store.putCalendar('c1', 'public', ['t1']);
  await store.putEvent({...EVENT});
  return ctx.load('state');
}

const occurrence = (day: number): string => 'e-1:' + Date.UTC(2026, 2, day, 9) / 1000;
const starts = (occurrences): string[] => occurrences.map(o => o.start);

export async function check_range_key(ctx) {
  const m = await world(ctx);
  const week1 = await m.cachedExpansion('c1', ...WEEK_1);
  assert.equal(week1.length, 7, \`the week of 2 March answered \${week1.length} standups, expected 7: \${JSON.stringify(starts(week1))}\`);
  const week2 = await m.cachedExpansion('c1', ...WEEK_2);
  const expected = ['2026-03-09T09:00:00Z', '2026-03-10T09:00:00Z', '2026-03-11T09:00:00Z'];
  assert.deepEqual(starts(week2), expected, \`the week of 9 March answered \${JSON.stringify(starts(week2))}, expected \${JSON.stringify(expected)}: the slice cached for one window was served for another\`);
  const again = await m.cachedExpansion('c1', ...WEEK_1);
  assert.deepEqual(starts(again), starts(week1), \`the week of 2 March, read again, answered \${JSON.stringify(starts(again))}\`);
}

export async function check_ttl(ctx) {
  const m = await world(ctx);
  await m.cachedExpansion('c1', ...WEEK_1);
  const keys = ctx.redis.keys('exp:*');
  assert(keys.length > 0, 'cachedExpansion cached nothing under exp:*');
  for (const key of keys) {
    const ttl = ctx.redis.ttl(key);
    assert(ttl > 0 && ttl <= 300, \`\${key} has TTL \${ttl}: a slice must expire within 300 s, or every retired generation stays in memory\`);
  }
  ctx.clock.advance(301);
  assert.deepEqual(ctx.redis.keys('exp:*'), [], \`301 s later Redis still holds \${JSON.stringify(ctx.redis.keys('exp:*'))}\`);
}

export async function check_write_then_bump(ctx) {
  const m = await world(ctx);
  await m.cachedExpansion('c1', ...WEEK_1); // the week is cached
  const cancelled = occurrence(4);
  // The state of the world at the instant the generation moves: what a reader landing right then would expand.
  const probe = ctx.redisAfter('gen:c1', () => ctx.redis.hget('exceptions:c1', cancelled));
  await m.recordException('c1', cancelled, 'cancelled');
  assert(probe.fired, 'recordException never bumped gen:c1: the cached week stays the week before the change');
  assert.equal(probe.result, 'cancelled', 'when gen:c1 moved the exception was not written yet: a reader in between expands the old calendar and caches it under the new generation for the whole TTL. Write the exception, then bump');
  const ids = (await m.cachedExpansion('c1', ...WEEK_1)).map(o => o.occurrence_id);
  assert(!ids.includes(cancelled), 'after recordException the cancelled 4 March standup is still in the week');
}

export async function check_exceptions(ctx) {
  const m = await world(ctx);
  await store.putException('c1', occurrence(3), 'cancelled');
  await store.putException('c1', occurrence(5), 'moved:2026-03-05T14:00:00Z');
  const week = await m.cachedExpansion('c1', ...WEEK_1);
  const ids = week.map(o => o.occurrence_id);
  assert(!ids.includes(occurrence(3)), \`the cancelled 3 March standup is still listed: \${JSON.stringify(starts(week))}\`);
  const copies = ids.filter(id => id === occurrence(5)).length;
  assert.equal(copies, 1, \`the moved 5 March standup is listed \${copies} times: \${JSON.stringify(starts(week))}. A moved instance replaces the original\`);
  const moved = week.find(o => o.occurrence_id === occurrence(5));
  assert(moved.start === '2026-03-05T14:00:00Z' && moved.end === '2026-03-05T14:30:00Z', \`the moved standup is \${JSON.stringify(moved)}, expected 14:00 to 14:30 on 5 March\`);
  assert.equal(week.length, 6, \`the week answered \${week.length} standups, expected 6 (7 minus the cancelled one): \${JSON.stringify(starts(week))}\`);
}
`,
    go: `package main

import (
	"context"
	"strconv"

	"leetbuild/harness"

	"calendard/rrule"
	"calendard/store"
)

func stAt(text string) int64 {
	instant, _ := rrule.ParseInstant(text)
	return instant
}

var (
	stWeek1 = [2]int64{stAt("2026-03-02T00:00:00Z"), stAt("2026-03-09T00:00:00Z")}
	stWeek2 = [2]int64{stAt("2026-03-09T00:00:00Z"), stAt("2026-03-16T00:00:00Z")}
)

// stWorld is a public calendar with a 30-minute daily standup, ten times from Monday 2 March 2026.
func stWorld(ctx *harness.Ctx) {
	ctx.NoError(store.PutCalendar(context.Background(), "c1", "public", "t1"), "seeding the calendar")
	e := store.Event{
		EventID: "e-1", CalendarID: "c1", Tenant: "t1", Title: "Standup", Rrule: "FREQ=DAILY;COUNT=10",
		Dtstart: "2026-03-02T09:00:00Z", Dtend: "2026-03-02T09:30:00Z", Revision: 1, Attendees: []string{"ana@example.com"},
	}
	ctx.NoError(store.PutEvent(context.Background(), &e), "seeding the event")
}

func stOccurrence(day int) string {
	return "e-1:" + strconv.FormatInt(stAt("2026-03-0"+strconv.Itoa(day)+"T09:00:00Z"), 10)
}

func stRead(ctx *harness.Ctx, window [2]int64) []rrule.Occurrence {
	occurrences, err := cachedExpansion(context.Background(), "c1", window[0], window[1])
	ctx.NoError(err, "cachedExpansion")
	return occurrences
}

func stStarts(occurrences []rrule.Occurrence) []string {
	starts := []string{}
	for _, o := range occurrences {
		starts = append(starts, o.Start)
	}
	return starts
}

func stIDs(occurrences []rrule.Occurrence) []string {
	ids := []string{}
	for _, o := range occurrences {
		ids = append(ids, o.OccurrenceID)
	}
	return ids
}

func CheckRangeKey(ctx *harness.Ctx) {
	stWorld(ctx)
	week1 := stRead(ctx, stWeek1)
	ctx.Equal(len(week1), 7, "the week of 2 March must answer 7 standups (%v); the count", stStarts(week1))
	week2 := stRead(ctx, stWeek2)
	ctx.Equal(stStarts(week2), []string{"2026-03-09T09:00:00Z", "2026-03-10T09:00:00Z", "2026-03-11T09:00:00Z"}, "the week of 9 March (a slice cached for one window must not be served for another)")
	ctx.Equal(stStarts(stRead(ctx, stWeek1)), stStarts(week1), "the week of 2 March, read again")
}

func CheckTtl(ctx *harness.Ctx) {
	stWorld(ctx)
	stRead(ctx, stWeek1)
	keys := ctx.Redis.Keys("exp:*")
	ctx.Assert(len(keys) > 0, "cachedExpansion cached nothing under exp:*")
	for _, key := range keys {
		ttl := ctx.Redis.TTL(key)
		ctx.Assert(ttl > 0 && ttl <= 300, "%s has TTL %d: a slice must expire within 300 s, or every retired generation stays in memory", key, ttl)
	}
	ctx.Clock.Advance(301)
	ctx.Equal(ctx.Redis.Keys("exp:*"), []string{}, "the slices 301 s later")
}

func CheckWriteThenBump(ctx *harness.Ctx) {
	stWorld(ctx)
	stRead(ctx, stWeek1) // the week is cached
	cancelled := stOccurrence(4)
	// The state of the world at the instant the generation moves: what a reader landing right then would expand.
	probe := ctx.Redis.After("gen:c1", func() any {
		value, _ := ctx.Redis.HGet("exceptions:c1", cancelled)
		return value
	})
	ctx.NoError(recordException(context.Background(), "c1", cancelled, "cancelled"), "recordException")
	ctx.Assert(probe.Fired, "recordException never bumped gen:c1: the cached week stays the week before the change")
	ctx.Equal(probe.Result, "cancelled", "when gen:c1 moved the exception was not written yet: a reader in between expands the old calendar and caches it under the new generation for the whole TTL. Write the exception, then bump; the exception at the bump")
	for _, id := range stIDs(stRead(ctx, stWeek1)) {
		ctx.Assert(id != cancelled, "after recordException the cancelled 4 March standup is still in the week")
	}
}

func CheckExceptions(ctx *harness.Ctx) {
	stWorld(ctx)
	ctx.NoError(store.PutException(context.Background(), "c1", stOccurrence(3), "cancelled"), "seeding an exception")
	ctx.NoError(store.PutException(context.Background(), "c1", stOccurrence(5), "moved:2026-03-05T14:00:00Z"), "seeding an exception")
	week := stRead(ctx, stWeek1)
	copies := 0
	for _, o := range week {
		ctx.Assert(o.OccurrenceID != stOccurrence(3), "the cancelled 3 March standup is still listed: %v", stStarts(week))
		if o.OccurrenceID == stOccurrence(5) {
			copies++
			ctx.Assert(o.Start == "2026-03-05T14:00:00Z" && o.End == "2026-03-05T14:30:00Z", "the moved standup is %v, expected 14:00 to 14:30 on 5 March", o)
		}
	}
	ctx.Equal(copies, 1, "the moved 5 March standup must be listed once, in place of the original (%v); the copies", stStarts(week))
	ctx.Equal(len(week), 6, "the week must answer 6 standups, 7 minus the cancelled one (%v); the count", stStarts(week))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <vector>

namespace {

int64_t stAt(const std::string& text) { return calendard::rrule::ParseInstant(text).value_or(0); }

const int64_t kWeek1Start = stAt("2026-03-02T00:00:00Z");
const int64_t kWeek1End = stAt("2026-03-09T00:00:00Z");
const int64_t kWeek2End = stAt("2026-03-16T00:00:00Z");

// A public calendar with a 30-minute daily standup, ten times from Monday 2 March 2026.
void stWorld() {
  calendard::store::PutCalendar("c1", "public", {"t1"});
  calendard::store::PutEvent({"e-1", "c1", "t1", "Standup", "FREQ=DAILY;COUNT=10", "2026-03-02T09:00:00Z", "2026-03-02T09:30:00Z", 1,
                              {"ana@example.com"}});
}

std::string stOccurrence(int day) { return "e-1:" + std::to_string(stAt("2026-03-0" + std::to_string(day) + "T09:00:00Z")); }

std::vector<std::string> stStarts(const std::vector<calendard::Occurrence>& occurrences) {
  std::vector<std::string> starts;
  for (const auto& o : occurrences) starts.push_back(o.start);
  return starts;
}

}  // namespace

void CheckRangeKey(harness::Ctx& ctx) {
  stWorld();
  const auto week1 = cachedExpansion("c1", kWeek1Start, kWeek1End);
  ctx.Equal(week1.size(), 7, "the week of 2 March must answer 7 standups (%v); the count", stStarts(week1));
  const auto week2 = cachedExpansion("c1", kWeek1End, kWeek2End);
  ctx.Equal(stStarts(week2), {"2026-03-09T09:00:00Z", "2026-03-10T09:00:00Z", "2026-03-11T09:00:00Z"},
            "the week of 9 March (a slice cached for one window must not be served for another)");
  ctx.Equal(stStarts(cachedExpansion("c1", kWeek1Start, kWeek1End)), stStarts(week1), "the week of 2 March, read again");
}

void CheckTtl(harness::Ctx& ctx) {
  stWorld();
  cachedExpansion("c1", kWeek1Start, kWeek1End);
  const auto keys = ctx.Redis.Keys("exp:*");
  ctx.Assert(!keys.empty(), "cachedExpansion cached nothing under exp:*");
  for (const auto& key : keys) {
    const long long ttl = ctx.Redis.TTL(key);
    ctx.Assert(ttl > 0 && ttl <= 300, "%s has TTL %d: a slice must expire within 300 s, or every retired generation stays in memory", key, ttl);
  }
  ctx.Clock.Advance(301);
  ctx.Equal(ctx.Redis.Keys("exp:*"), std::vector<std::string>{}, "the slices 301 s later");
}

void CheckWriteThenBump(harness::Ctx& ctx) {
  stWorld();
  cachedExpansion("c1", kWeek1Start, kWeek1End);  // the week is cached
  const std::string cancelled = stOccurrence(4);
  // The state of the world at the instant the generation moves: what a reader landing right then would expand.
  bool fired = false;
  std::string atBump;
  ctx.Redis.After("gen:c1", [&] {
    fired = true;
    atBump = ctx.Redis.HGet("exceptions:c1", cancelled).value_or("");
  });
  recordException("c1", cancelled, "cancelled");
  ctx.Assert(fired, "recordException never bumped gen:c1: the cached week stays the week before the change");
  ctx.Equal(atBump, "cancelled",
            "when gen:c1 moved the exception was not written yet: a reader in between expands the old calendar and caches it "
            "under the new generation for the whole TTL. Write the exception, then bump; the exception at the bump");
  for (const auto& o : cachedExpansion("c1", kWeek1Start, kWeek1End)) {
    ctx.Assert(o.occurrence_id != cancelled, "after recordException the cancelled 4 March standup is still in the week");
  }
}

void CheckExceptions(harness::Ctx& ctx) {
  stWorld();
  calendard::store::PutException("c1", stOccurrence(3), "cancelled");
  calendard::store::PutException("c1", stOccurrence(5), "moved:2026-03-05T14:00:00Z");
  const auto week = cachedExpansion("c1", kWeek1Start, kWeek1End);
  int copies = 0;
  for (const auto& o : week) {
    ctx.Assert(o.occurrence_id != stOccurrence(3), "the cancelled 3 March standup is still listed: %v", stStarts(week));
    if (o.occurrence_id == stOccurrence(5)) {
      copies++;
      ctx.Assert(o.start == "2026-03-05T14:00:00Z" && o.end == "2026-03-05T14:30:00Z",
                 "the moved standup runs %s to %s, expected 14:00 to 14:30 on 5 March", o.start, o.end);
    }
  }
  ctx.Equal(copies, 1, "the moved 5 March standup must be listed once, in place of the original (%v); the copies", stStarts(week));
  ctx.Equal(week.size(), 6, "the week must answer 6 standups, 7 minus the cancelled one (%v); the count", stStarts(week));
}
`,
  },
  hints: [
    'The week of 9 March shows the standups of 2 March, a cancelled standup stays on the screen after the cancel, a moved one appears at both times, and Redis memory only ever grows.',
    'The slice key names the calendar and the generation but not the window; a `SET` without `EX` lives forever; bumping before writing lets a reader cache the old calendar under the new generation; the overlay appends a copy.',
    'Key slices `exp:{calendar}:{generation}:{start}:{end}`, write them with `EX` 300, call `store.put_exception` before `bump_generation`, and in `apply_exceptions` skip `"cancelled"` and replace a moved occurrence instead of appending it.',
  ],
  debrief: `A generation retires slices without deleting them: one \`INCR\` makes every slice of the old generation unreachable, whatever windows readers asked for, and the TTL reclaims the memory later. That only holds if the change is visible before the bump, because a reader between a bump and its write files stale data under the live generation. Bumping after the write means the worst a racing reader can do is cache stale data under a generation nobody reads. The moved instance keeps its occurrence id, as an exception keeps its original start, so clients see one instance that moved. Production calendars cache per event rather than per calendar, so one edit does not retire every slice, and bound the instances they ever materialize.`,
};
