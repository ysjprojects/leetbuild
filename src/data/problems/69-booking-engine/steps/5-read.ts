import type {Step} from '@/lib/types';

export const bookingReadStep: Step = {
  id: 'read',
  title: 'GET /v1/resources/{id}/availability: timezones that do not lie',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the availability
route, reads a set of slots and returns them. Guests will book from it, so every slot it reports must
be a slot the booking path will actually accept. Review it like the service owner, fix it, and prove
the fix with the checks below.

Implement \`GET /v1/resources/{resource_id}/availability?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=…\`.

- The response names the timezone it resolved — \`{"timezone": "…", "slots": [...]}\` — and each slot
  is rendered in that zone. A caller that has to guess which zone it received will eventually book
  the wrong hour.
- The resource has a home timezone, and the caller may ask for another one: a valid IANA zone
  overrides it, and an unknown zone is **400** with \`{"error": "unknown_timezone"}\` — never silently
  treated as UTC.
- The range is capped at **90 days**: a longer \`from\`/\`to\` span is **400** with
  \`{"error": "range_too_long"}\` before any slot work is done.
- Free slots are computed **at request time** from the same slot map the booking path writes
  (\`resource:{resource_id}:slots\`) — the same \`HGETALL\` view the hold script updates. A nightly
  materialization is a cache with a commit lag, and this endpoint cannot serve it: a slot taken a
  second ago must be gone from the next read.
- A slot field is free only when the map has no entry for it, or its entry is not live:
  \`booked:{booking_id}\` is a confirmed booking, and a hold id is live while \`hold:{id}\` still
  exists. Both are excluded, so availability never advertises a slot the booking path would refuse.

**Failure mode the checks target.** The draft reads a nightly \`availability:{resource}:{day}\` set that
is stale by construction, returns slots that are already held inside the payment window, accepts any
timezone string from the caller without answering which zone it used, and lets one request ask for a
range of years.`,
  sequence: {
    participants: ['Client', 'Booking API', 'Redis hold map'],
    messages: [
      {from: 'Client', to: 'Booking API', label: 'GET /v1/resources/{id}/availability · from · to · tz', kind: 'sync'},
      {from: 'Booking API', to: 'Booking API', label: 'resolve timezone · cap the range at 90 days', kind: 'sync'},
      {from: 'Booking API', to: 'Redis hold map', label: 'HGETALL resource:{id}:slots', kind: 'sync'},
      {from: 'Redis hold map', to: 'Booking API', label: 'slot → hold id / booked:{booking_id}', kind: 'reply'},
      {from: 'Booking API', to: 'Booking API', label: 'drop live holds and confirmed bookings', kind: 'sync'},
      {from: 'Client', to: 'Booking API', label: 'next read sees the slot a second after it was taken', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/resources/{id}/availability',
      detail: 'Register the availability route on `GET /v1/resources/{id}/availability`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/resources\//]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/resources\//]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/resources\//]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"resources"\s*\/\s*Segment\s*\/\s*"availability"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(R"\(\/v1\/resources\//]},
      },
    },
    {
      id: 'range-cap',
      title: 'Rejects a range over 90 days with 400',
      detail:
        'A `from`/`to` span of `90` days or more is **400** with `range_too_long`, before any slot work. The draft enumerates every day it is asked for.',
      match: {
        python: {all: [/MAX_AVAILABILITY_DAYS/, /range_too_long/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_AVAILABILITY_DAYS/, /range_too_long/, /code\(\s*400\s*\)/]},
        go: {all: [/maxAvailabilityDays/, /range_too_long/, /StatusBadRequest/]},
        scala: {all: [/MaxAvailabilityDays/, /range_too_long/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxAvailabilityDays/, /range_too_long/, /\b400\b/]},
      },
    },
    {
      id: 'live-hold-map',
      title: 'Reads the same slot map the booking path writes',
      detail:
        'Free slots come from `HGETALL` of `resource:{id}:slots` at request time, so a hold taken a second ago is already gone from the next read. The draft reads a nightly materialization.',
      match: {
        python: {all: [/hgetall/, /slots_key\(/], none: [/materializ/i]},
        typescript: {all: [/hgetall/, /slotsKey\(/], none: [/materializ/i]},
        go: {all: [/HGetAll/, /slotsKey\(/], none: [/materializ/i]},
        scala: {all: [/hgetAll/, /slotsKey\(/], none: [/materializ/i]},
        cpp: {all: [/hgetall/, /slotsKey\(/], none: [/materializ/i]},
      },
    },
    {
      id: 'held-excluded',
      title: 'Excludes live holds and confirmed bookings',
      detail:
        'A slot is free only when the map has no entry, or its entry is neither `booked:` nor a hold id whose `hold:{id}` key still exists. The draft returns everything the materialization recorded.',
      match: {
        python: {all: [/def is_free\(/, /booked:/, /hold:/]},
        typescript: {all: [/function isFree\(/, /booked:/, /hold:/]},
        go: {all: [/func isFree\(/, /booked:/, /hold:/]},
        scala: {all: [/def isFree\(/, /booked:/, /hold:/]},
        cpp: {all: [/isFree\(/, /booked:/, /hold:/]},
      },
    },
    {
      id: 'timezone-echo',
      title: 'Names the resolved timezone and rejects an unknown one',
      detail:
        'The response carries the `timezone` it resolved, a caller-supplied zone overrides the resource default only when it is valid, and an unknown zone is **400** with `unknown_timezone`. The draft echoes nothing and silently treats every input as UTC.',
      match: {
        python: {all: [/timezone/, /unknown_timezone/, /status_code\s*=\s*400/]},
        typescript: {all: [/timezone/, /unknown_timezone/, /code\(\s*400\s*\)/]},
        scala: {all: [/timezone/, /unknown_timezone/, /StatusCodes\.BadRequest/]},
        go: {all: [/timezone/, /unknown_timezone/, /StatusBadRequest/]},
        cpp: {all: [/timezone/, /unknown_timezone/, /\b400\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from datetime import date, timedelta

import redis as redis_lib
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis_lib.Redis()


@app.get("/v1/resources/{resource_id}/availability")
def availability(
    resource_id: str,
    date_from: date = Query(alias="from"),
    date_to: date = Query(alias="to"),
    tz: str = Query(default="UTC"),
) -> JSONResponse:
    # TODO: this draft reads a nightly materialization instead of the hold map the booking path
    # writes, returns slots that are already held, has no cap on the range, and never says which
    # timezone it resolved. Read the live slot map, drop live holds, cap the range and echo the zone.
    slots: list[str] = []
    day = date_from
    while day <= date_to:
        materialized = r.hgetall(f"availability:{resource_id}:{day.isoformat()}")
        slots.extend(materialized.keys())
        day += timedelta(days=1)
    return JSONResponse({"resource_id": resource_id, "slots": slots}, status_code=200)
`,
      solution: `from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import redis as redis_lib
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis_lib.Redis()

MAX_AVAILABILITY_DAYS = 90
SLOT_MINUTES = 30
OPEN_HOUR = 8
CLOSE_HOUR = 20
RESOURCE_TIMEZONE = "Europe/Berlin"


def slots_key(resource_id: str) -> str:
    return f"resource:{resource_id}:slots"


def is_free(value: str) -> bool:
    """A slot is free only when no live hold owns it and no confirmed booking has converted it."""
    if value.startswith("booked:"):
        return False
    return not r.exists(f"hold:{value}")


def candidate_fields(day: date, zone: ZoneInfo) -> list[str]:
    """The resource's bookable slots for one day, as epoch-minute field names in the resolved zone."""
    opening = datetime(day.year, day.month, day.day, OPEN_HOUR, tzinfo=zone)
    fields = []
    for offset in range(0, (CLOSE_HOUR - OPEN_HOUR) * 60, SLOT_MINUTES):
        moment = opening + timedelta(minutes=offset)
        fields.append(str(int(moment.timestamp()) // 60))
    return fields


@app.get("/v1/resources/{resource_id}/availability")
def availability(
    resource_id: str,
    date_from: date = Query(alias="from"),
    date_to: date = Query(alias="to"),
    tz: str | None = Query(default=None),
) -> JSONResponse:
    if (date_to - date_from).days >= MAX_AVAILABILITY_DAYS:
        raise HTTPException(status_code=400, detail="range_too_long")
    timezone = tz if tz else RESOURCE_TIMEZONE
    try:
        zone = ZoneInfo(timezone)
    except ZoneInfoNotFoundError:
        raise HTTPException(status_code=400, detail="unknown_timezone")

    # The same map the hold script writes: a stale copy would advertise a slot we would then refuse.
    held = r.hgetall(slots_key(resource_id))
    slots: list[str] = []
    day = date_from
    while day <= date_to:
        for field in candidate_fields(day, zone):
            value = held.get(field)
            if value is None or is_free(value):
                slots.append(field)
        day += timedelta(days=1)
    return JSONResponse({"resource_id": resource_id, "timezone": timezone, "slots": slots}, status_code=200)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
export const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/resources/:resourceId/availability', async (request, reply) => {
  // TODO: this draft reads a nightly materialization instead of the hold map the booking path
  // writes, returns slots that are already held, has no cap on the range, and never says which
  // timezone it resolved. Read the live slot map, drop live holds, cap the range and echo the zone.
  const {resourceId} = request.params as {resourceId: string};
  const query = request.query as {from: string; to: string};
  const day = new Date(query.from);
  const end = new Date(query.to);
  const slots: string[] = [];
  while (day <= end) {
    const materialized = await redis.hgetall(\`availability:\${resourceId}:\${day.toISOString().slice(0, 10)}\`);
    slots.push(...Object.keys(materialized));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return reply.code(200).send({resource_id: resourceId, slots});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
export const redis = new Redis({host: 'redis', port: 6379});

const MAX_AVAILABILITY_DAYS = 90;
const SLOT_MINUTES = 30;
const OPEN_HOUR = 8;
const CLOSE_HOUR = 20;
const RESOURCE_TIMEZONE = 'Europe/Berlin';
const DAY_MS = 24 * 60 * 60 * 1000;

export function slotsKey(resourceId: string): string {
  return \`resource:\${resourceId}:slots\`;
}

/** A slot is free only when no live hold owns it and no confirmed booking has converted it. */
export async function isFree(value: string): Promise<boolean> {
  if (value.startsWith('booked:')) return false;
  return (await redis.exists('hold:' + value)) === 0;
}

/** The resource's bookable slots for one service day, as epoch-minute field names. */
function candidateFields(dayStartMs: number): string[] {
  const fields: string[] = [];
  for (let offset = 0; offset < (CLOSE_HOUR - OPEN_HOUR) * 60; offset += SLOT_MINUTES) {
    fields.push(String(Math.floor((dayStartMs + offset * 60_000) / 60_000)));
  }
  return fields;
}

function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: timezone});
    return true;
  } catch {
    return false;
  }
}

app.get('/v1/resources/:resourceId/availability', async (request, reply) => {
  const {resourceId} = request.params as {resourceId: string};
  const query = request.query as {from?: string; to?: string; tz?: string};
  const from = new Date(query.from ?? '');
  const to = new Date(query.to ?? '');
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()))
    return reply.code(400).send({error: 'invalid_range'});
  if ((to.getTime() - from.getTime()) / DAY_MS >= MAX_AVAILABILITY_DAYS)
    return reply.code(400).send({error: 'range_too_long'});
  const timezone = query.tz === undefined || query.tz === '' ? RESOURCE_TIMEZONE : query.tz;
  if (!isKnownTimezone(timezone)) return reply.code(400).send({error: 'unknown_timezone'});

  // The same map the hold script writes: a stale copy would advertise a slot we would then refuse.
  const held = await redis.hgetall(slotsKey(resourceId));
  const slots: string[] = [];
  for (let dayStart = from.getTime(); dayStart <= to.getTime(); dayStart += DAY_MS) {
    for (const field of candidateFields(dayStart)) {
      const value = held[field];
      if (value === undefined || (await isFree(value))) slots.push(field);
    }
  }
  return reply.code(200).send({resource_id: resourceId, timezone, slots});
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
)

func availability(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft reads a nightly materialization instead of the hold map the booking path
	// writes, returns slots that are already held, has no cap on the range, and never says which
	// timezone it resolved. Read the live slot map, drop live holds, cap the range and echo the zone.
	resourceID := r.PathValue("resourceID")
	day := r.URL.Query().Get("from")
	materialized, err := rdb.HGetAll(r.Context(), "availability:"+resourceID+":"+day).Result()
	if err != nil {
		http.Error(rw, "unavailable", http.StatusServiceUnavailable)
		return
	}
	slots := make([]string, 0, len(materialized))
	for field := range materialized {
		slots = append(slots, field)
	}
	rw.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(rw).Encode(map[string]any{"resource_id": resourceID, "slots": slots})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/resources/{resourceID}/availability", availability)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	maxAvailabilityDays = 90
	slotMinutes         = 30
	openHour            = 8
	closeHour           = 20
	resourceTimezone    = "Europe/Berlin"
)

func slotsKey(resourceID string) string {
	return "resource:" + resourceID + ":slots"
}

// isFree reports whether a slot entry is bookable: no confirmed booking, and no live hold.
func isFree(ctx context.Context, value string) bool {
	if strings.HasPrefix(value, "booked:") {
		return false
	}
	held, err := rdb.Exists(ctx, "hold:"+value).Result()
	if err != nil {
		return false
	}
	return held == 0
}

// candidateFields lists the resource's bookable slots for one service day, in epoch minutes.
func candidateFields(dayStart time.Time) []string {
	opening := time.Date(dayStart.Year(), dayStart.Month(), dayStart.Day(), openHour, 0, 0, 0, dayStart.Location())
	fields := make([]string, 0, (closeHour-openHour)*60/slotMinutes)
	for offset := 0; offset < (closeHour-openHour)*60; offset += slotMinutes {
		moment := opening.Add(time.Duration(offset) * time.Minute)
		fields = append(fields, strconv.FormatInt(moment.Unix()/60, 10))
	}
	return fields
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func availability(rw http.ResponseWriter, r *http.Request) {
	resourceID := r.PathValue("resourceID")
	query := r.URL.Query()
	from, err := time.Parse(time.DateOnly, query.Get("from"))
	if err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_range"})
		return
	}
	to, err := time.Parse(time.DateOnly, query.Get("to"))
	if err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_range"})
		return
	}
	if to.Sub(from) >= time.Duration(maxAvailabilityDays)*24*time.Hour {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "range_too_long"})
		return
	}
	timezone := query.Get("tz")
	if timezone == "" {
		timezone = resourceTimezone
	}
	zone, err := time.LoadLocation(timezone)
	if err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown_timezone"})
		return
	}

	// The same map the hold script writes: a stale copy would advertise a slot we would then refuse.
	held, err := rdb.HGetAll(r.Context(), slotsKey(resourceID)).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	slots := []string{}
	for day := from; !day.After(to); day = day.AddDate(0, 0, 1) {
		localDay := day.In(zone)
		for _, field := range candidateFields(localDay) {
			value, present := held[field]
			if !present || isFree(r.Context(), value) {
				slots = append(slots, field)
			}
		}
	}
	writeJSON(rw, http.StatusOK, map[string]any{"resource_id": resourceID, "timezone": timezone, "slots": slots})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/resources/{resourceID}/availability", availability)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object AvailabilityApi {
  implicit val system: ActorSystem = ActorSystem("booking")
  val jedis = new JedisPooled("redis", 6379)

  val route: Route =
    path("v1" / "resources" / Segment / "availability") { resourceId =>
      get {
        parameter("from", "to", "tz".?) { (from, to, requestedZone) =>
          // TODO: this draft reads a nightly materialization instead of the hold map the booking
          // path writes, returns slots that are already held, has no cap on the range, and never
          // says which timezone it resolved. Read the live slot map, drop live holds, cap the range
          // and echo the zone.
          val days = Iterator.iterate(java.time.LocalDate.parse(from))(_.plusDays(1)).takeWhile(!_.isAfter(java.time.LocalDate.parse(to)))
          val slots = days.flatMap { day =>
            jedis.hgetAll(s"availability:$resourceId:$day").keySet().asScala
          }.toSeq
          complete(StatusCodes.OK, slots.mkString("[", ",", "]"))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.time.{Instant, LocalDate, ZoneId, ZoneOffset, ZonedDateTime}

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

object AvailabilityApi {
  implicit val system: ActorSystem = ActorSystem("booking")
  val jedis = new JedisPooled("redis", 6379)

  val MaxAvailabilityDays = 90
  val SlotMinutes = 30
  val OpenHour = 8
  val CloseHour = 20
  val ResourceTimezone = "Europe/Berlin"

  def slotsKey(resourceId: String): String = s"resource:$resourceId:slots"

  /** A slot is free only when no live hold owns it and no confirmed booking has converted it. */
  def isFree(value: String): Boolean =
    if (value.startsWith("booked:")) false else !jedis.exists("hold:" + value)

  /** The resource's bookable slots for one day, as epoch-minute field names. */
  def candidateFields(day: ZonedDateTime): Seq[String] =
    (0 until (CloseHour - OpenHour) * 60 by SlotMinutes).map { offset =>
      val moment = day.withHour(OpenHour).withMinute(0).plusMinutes(offset.toLong)
      (moment.toEpochSecond / 60).toString
    }

  val route: Route =
    path("v1" / "resources" / Segment / "availability") { resourceId =>
      get {
        parameter("from", "to", "tz".?) { (from, to, requestedZone) =>
          val fromDay = LocalDate.parse(from)
          val toDay = LocalDate.parse(to)
          if (java.time.temporal.ChronoUnit.DAYS.between(fromDay, toDay) >= MaxAvailabilityDays) {
            complete(StatusCodes.BadRequest, """{"error":"range_too_long"}""")
          } else {
            val timezone = requestedZone.filter(_.nonEmpty).getOrElse(ResourceTimezone)
            val zone = try Some(ZoneId.of(timezone)) catch { case _: Exception => None }
            zone match {
              case None => complete(StatusCodes.BadRequest, """{"error":"unknown_timezone"}""")
              case Some(resolved) =>
                // The same map the hold script writes: a stale copy would advertise a slot we
                // would then refuse.
                val held = jedis.hgetAll(slotsKey(resourceId)).asScala.toMap
                val slots = Iterator
                  .iterate(fromDay)(_.plusDays(1))
                  .takeWhile(!_.isAfter(toDay))
                  .flatMap { day =>
                    candidateFields(day.atStartOfDay(resolved)).filter { field =>
                      held.get(field).forall(isFree)
                    }
                  }
                  .toSeq
                val body = slots.map(field => "\\"" + field + "\\"").mkString(
                  "{\\"resource_id\\":\\"" + resourceId + "\\",\\"timezone\\":\\"" + timezone + "\\",\\"slots\\":[",
                  ",",
                  "]}"
                )
                complete(StatusCodes.OK, body)
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
#include <sw/redis++/redis++.h>

#include <string>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/resources/([^/]+)/availability)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft reads a nightly materialization instead of the hold map the booking path
    // writes, returns slots that are already held, has no cap on the range, and never says which
    // timezone it resolved. Read the live slot map, drop live holds, cap the range and echo the zone.
    const std::string resourceId = req.matches[1];
    const std::string day = req.get_param_value("from");
    std::unordered_map<std::string, std::string> materialized;
    redis.hgetall("availability:" + resourceId + ":" + day, std::inserter(materialized, materialized.end()));
    json slots = json::array();
    for (const auto& entry : materialized) slots.push_back(entry.first);
    res.status = 200;
    res.set_content(json{{"resource_id", resourceId}, {"slots", slots}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <ctime>
#include <iterator>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr long long kMaxAvailabilityDays = 90;
constexpr int kSlotMinutes = 30;
constexpr int kOpenHour = 8;
constexpr int kCloseHour = 20;
constexpr const char* kResourceTimezone = "Europe/Berlin";

std::string slotsKey(const std::string& resourceId) { return "resource:" + resourceId + ":slots"; }

// A slot is free only when no live hold owns it and no confirmed booking has converted it.
bool isFree(const std::string& value) {
  if (value.rfind("booked:", 0) == 0) return false;
  return !redis.exists("hold:" + value);
}

// The resource's bookable slots for one service day, as epoch-minute field names.
std::vector<std::string> candidateFields(const std::tm& day) {
  std::vector<std::string> fields;
  std::tm opening = day;
  opening.tm_hour = kOpenHour;
  opening.tm_min = 0;
  const std::time_t openingSeconds = timegm(&opening);
  for (int offset = 0; offset < (kCloseHour - kOpenHour) * 60; offset += kSlotMinutes) {
    fields.push_back(std::to_string((openingSeconds + offset * 60) / 60));
  }
  return fields;
}

bool knownTimezone(const std::string& timezone) {
  return timezone == "UTC" || timezone == "Europe/Berlin" || timezone == "America/New_York";
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/resources/([^/]+)/availability)", [](const httplib::Request& req, httplib::Response& res) {
    const std::string resourceId = req.matches[1];
    const std::string from = req.get_param_value("from");
    const std::string to = req.get_param_value("to");
    if (from.empty() || to.empty()) {
      res.status = 400;
      res.set_content("{\\"error\\":\\"invalid_range\\"}", "application/json");
      return;
    }
    const long long spanDays = daysBetween(from, to);
    if (spanDays >= kMaxAvailabilityDays) {
      res.status = 400;
      res.set_content("{\\"error\\":\\"range_too_long\\"}", "application/json");
      return;
    }
    const std::string requested = req.has_param("tz") ? req.get_param_value("tz") : "";
    const std::string timezone = requested.empty() ? kResourceTimezone : requested;
    if (!knownTimezone(timezone)) {
      res.status = 400;
      res.set_content("{\\"error\\":\\"unknown_timezone\\"}", "application/json");
      return;
    }

    // The same map the hold script writes: a stale copy would advertise a slot we would then refuse.
    std::unordered_map<std::string, std::string> held;
    redis.hgetall(slotsKey(resourceId), std::inserter(held, held.end()));

    json slots = json::array();
    for (long long dayIndex = 0; dayIndex <= spanDays; ++dayIndex) {
      for (const auto& field : candidateFields(addDays(from, dayIndex))) {
        const auto entry = held.find(field);
        if (entry == held.end() || isFree(entry->second)) slots.push_back(field);
      }
    }
    res.status = 200;
    res.set_content(
        json{{"resource_id", resourceId}, {"timezone", timezone}, {"slots", slots}}.dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Availability is a read of the same field the booking path writes — `resource:{id}:slots`. If it comes from anywhere else, the endpoint is guessing about the last few seconds, which is exactly when the guest is looking.',
    'A slot entry is not enough to erase a slot: `booked:{booking_id}` means a confirmed booking, and a hold id means "held while `hold:{id}` still exists". Both are unavailable; a stale entry whose hold already expired is not.',
    'Validate the caller’s zone once and answer with the zone you used. A default you never echo is a default the caller cannot verify — and silence about a typo like `Europe/Berline` books the wrong hour.',
  ],
  debrief: `The interviewer is testing whether the read path agrees with the write path. Three defects are
checked: a materialization that lags the holds (so the endpoint advertises slots the booking path
refuses), a filter that forgets live holds and confirmed bookings, and a missing timezone contract —
the response has to name the zone it resolved, and an unknown zone has to be an error rather than a
silent UTC. The 90-day cap is the cheap one: without it, one request enumerates years of slots. Real
systems add cursor pagination for large windows, a per-resource availability cache invalidated by the
hold map, opening hours and holidays per resource, and a booking-path check that re-validates the
slot at take time because availability is only advisory.`,
};
