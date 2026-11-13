import type {Step} from '@/lib/types';

export const bookingReadStep: Step = {
  id: 'read',
  title: 'GET /v1/resources/{id}/availability: timezones that do not lie',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/resources/{id}/availability?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=…\`:
it parses the two dates (**400** \`invalid_range\` when they do not parse or \`to\` precedes \`from\`),
reads the nightly materialization \`availability:{id}:{day}\` for each day and answers
\`{"resource_id", "slots"}\`, each slot an ISO-8601 instant. It serves the demo and hides four flaws.

**Failure mode the checks target.** A slot held a second ago, a hold that expired an hour ago, a
guest in Tokyo asking for Tuesday, and a request for two years of slots.

- The span is at most **90 days** (\`MAX_HORIZON_DAYS\`): longer is **400** \`range_too_long\`, before
  any slot work.
- The zone is \`tz\` when given, else \`RESOURCE_TIMEZONE\`; a zone \`booking/tz\` does not know is
  **400** \`unknown_timezone\`. A day's candidate slots are \`day_fields(zone, …)\`: open hours in that
  zone, so the same date is a different set of instants in Tokyo and in Berlin.
- Free slots come from \`HGETALL resource:{id}:slots\` at request time. A candidate is free when the map
  has no entry for it, or its entry is a hold id whose \`hold:{id}\` key is gone; \`booked:…\` and live
  holds are excluded.
- The response names the zone it used: \`{"resource_id", "timezone", "slots"}\`.`,
  sequence: {
    participants: ['Client', 'Booking API', 'Redis hold map'],
    messages: [
      {from: 'Client', to: 'Booking API', label: 'GET /v1/resources/{id}/availability · from · to · tz', kind: 'sync'},
      {from: 'Booking API', to: 'Booking API', label: 'cap at 90 days · resolve the zone · day_fields', kind: 'sync'},
      {
        from: 'Booking API',
        to: 'Redis hold map',
        label: 'HGETALL resource:{id}:slots · EXISTS hold:{id}',
        kind: 'sync',
      },
      {from: 'Redis hold map', to: 'Booking API', label: 'slot → hold id / booked:{booking_id}', kind: 'reply'},
      {from: 'Booking API', to: 'Client', label: '{timezone, slots} without booked and live-held slots', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/resources/{id}/availability',
      detail: 'A one-day request answers 200 with the resource id and a list of slots.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/resources\/\{resource_id\}\/availability["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/resources\/:resourceId\/availability['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/resources\/\{id\}\/availability"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"resources"\s*\/\s*Segment\s*\/\s*"availability"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/resources\//]},
      },
    },
    {
      id: 'range-cap',
      title: 'Rejects a span over 90 days with 400',
      detail:
        'A `to` more than 90 days after `from` is **400** `range_too_long` and touches no slot; 90 days is served. The starter enumerates whatever it is asked.',
      match: {
        python: {all: [/range_too_long/, /days_between\([^\n]*>\s*(MAX_HORIZON_DAYS|90)\b/]},
        typescript: {all: [/range_too_long/, /daysBetween\([^\n]*>\s*(MAX_HORIZON_DAYS|90)\b/]},
        go: {all: [/range_too_long/, /DaysBetween\([^\n]*>\s*(slots\.MaxHorizonDays|90)\b/]},
        scala: {all: [/range_too_long/, /daysBetween\([^\n]*>\s*(Slots\.MaxHorizonDays|90)\b/]},
        cpp: {all: [/range_too_long/, /DaysBetween\([^\n]*>\s*(booking::slots::kMaxHorizonDays|90)\b/]},
      },
    },
    {
      id: 'live-hold-map',
      title: 'Reads the same slot map the booking path writes',
      detail:
        'A slot written to `resource:{id}:slots` is gone from the very next read, whatever a materialization says. The starter reads `availability:{id}:{day}`.',
      match: {
        python: {all: [/hgetall\(\s*slots_key\(/], none: [/availability:/]},
        typescript: {all: [/hgetall\(\s*slotsKey\(/], none: [/availability:/]},
        go: {all: [/HGetAll\([^\n]*slots\.Key\(/], none: [/availability:/]},
        scala: {all: [/hgetAll\(\s*Slots\.key\(/], none: [/availability:/]},
        cpp: {all: [/hgetall\(\s*booking::slots::Key\(/], none: [/availability:/]},
      },
    },
    {
      id: 'held-excluded',
      title: 'Excludes confirmed bookings and live holds, frees expired ones',
      detail:
        'A `booked:` entry and a hold whose `hold:{id}` key exists are left out; an entry whose hold key expired is free. The starter filters nothing.',
      match: {
        python: {all: [/booked:/, /\.exists\(\s*hold_key\(/]},
        typescript: {all: [/booked:/, /\.exists\(\s*holdKey\(/]},
        go: {all: [/booked:/, /\.Exists\([^\n]*slots\.HoldKey\(/]},
        scala: {all: [/booked:/, /\.exists\(\s*Slots\.holdKey\(/]},
        cpp: {all: [/booked:/, /\.exists\(\s*booking::slots::HoldKey\(/]},
      },
    },
    {
      id: 'timezone-echo',
      title: 'Resolves the zone, names it, rejects an unknown one',
      detail:
        'Without `tz` the day is Berlin’s and the response says so; `tz=Asia/Tokyo` moves the day’s slots nine hours and is echoed; an unknown zone, `constructor` included, is **400** `unknown_timezone`. The starter uses UTC and names nothing.',
      match: {
        python: {all: [/["']timezone["']\s*:/, /unknown_timezone/, /zone_known\(/, /day_fields\(/]},
        typescript: {all: [/timezone:/, /unknown_timezone/, /zoneKnown\(/, /dayFields\(/]},
        go: {all: [/"timezone"/, /unknown_timezone/, /tz\.Known\(/, /slots\.DayFields\(/]},
        scala: {all: [/"timezone"/, /unknown_timezone/, /Tz\.known\(/, /Slots\s*\.dayFields\(/]},
        cpp: {all: [/"timezone"/, /unknown_timezone/, /tz::Known\(/, /slots::DayFields\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from datetime import date, timedelta

import redis
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

from booking.slots import MAX_HORIZON_DAYS, day_fields, hold_key, slots_key
from booking.tz import RESOURCE_TIMEZONE, days_between, format_instant, parse_date, zone_known

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/resources/{resource_id}/availability")
def availability(
    resource_id: str,
    date_from: str = Query(alias="from"),
    date_to: str = Query(alias="to"),
    tz: str | None = Query(default=None),
) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    start = parse_date(date_from)
    end = parse_date(date_to)
    if start is None or end is None or days_between(start, end) < 0:
        return JSONResponse({"error": "invalid_range"}, status_code=400)
    slots: list[str] = []
    day = date(*start)
    while day <= date(*end):
        # The nightly materialization: every free slot of the day, as the job saw it.
        materialized = r.hgetall(f"availability:{resource_id}:{day.isoformat()}")
        slots.extend(format_instant(int(field) * 60) for field in sorted(materialized, key=int))
        day += timedelta(days=1)
    return JSONResponse({"resource_id": resource_id, "slots": slots}, status_code=200)
`,
      solution: `from datetime import date, timedelta

import redis
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

from booking.slots import MAX_HORIZON_DAYS, day_fields, hold_key, slots_key
from booking.tz import RESOURCE_TIMEZONE, days_between, format_instant, parse_date, zone_known

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


def is_free(value: str) -> bool:
    """A slot's entry blocks it while it is a confirmed booking or a hold whose key still lives."""
    if value.startswith("booked:"):
        return False
    return not r.exists(hold_key(value))


@app.get("/v1/resources/{resource_id}/availability")
def availability(
    resource_id: str,
    date_from: str = Query(alias="from"),
    date_to: str = Query(alias="to"),
    tz: str | None = Query(default=None),
) -> JSONResponse:
    start = parse_date(date_from)
    end = parse_date(date_to)
    if start is None or end is None or days_between(start, end) < 0:
        return JSONResponse({"error": "invalid_range"}, status_code=400)
    if days_between(start, end) > MAX_HORIZON_DAYS:
        return JSONResponse({"error": "range_too_long"}, status_code=400)
    zone = tz or RESOURCE_TIMEZONE
    if not zone_known(zone):
        return JSONResponse({"error": "unknown_timezone"}, status_code=400)

    # The same map the hold script writes: a copy would advertise a slot the booking path then refuses.
    held = r.hgetall(slots_key(resource_id))
    slots: list[str] = []
    day = date(*start)
    while day <= date(*end):
        for field in day_fields(zone, day.year, day.month, day.day):
            value = held.get(field)
            if value is None or is_free(value):
                slots.append(format_instant(int(field) * 60))
        day += timedelta(days=1)
    return JSONResponse({"resource_id": resource_id, "timezone": zone, "slots": slots}, status_code=200)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {MAX_HORIZON_DAYS, dayFields, holdKey, slotsKey} from 'booking/slots';
import {RESOURCE_TIMEZONE, daysBetween, formatInstant, parseDate, zoneKnown} from 'booking/tz';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

const isoDay = (date: [number, number, number]): string => new Date(Date.UTC(date[0], date[1] - 1, date[2])).toISOString().slice(0, 10);

app.get('/v1/resources/:resourceId/availability', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {resourceId} = request.params as {resourceId: string};
  const query = request.query as {from: string; to: string; tz?: string};
  const start = parseDate(query.from);
  const end = parseDate(query.to);
  if (start === null || end === null || daysBetween(start, end) < 0) return reply.code(400).send({error: 'invalid_range'});
  const slots: string[] = [];
  for (let offset = 0; offset <= daysBetween(start, end); offset += 1) {
    const day = new Date(Date.UTC(start[0], start[1] - 1, start[2] + offset));
    // The nightly materialization: every free slot of the day, as the job saw it.
    const materialized = await redis.hgetall(\`availability:\${resourceId}:\${isoDay([day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()])}\`);
    for (const field of Object.keys(materialized).sort((a, b) => Number(a) - Number(b))) slots.push(formatInstant(Number(field) * 60));
  }
  return reply.code(200).send({resource_id: resourceId, slots});
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {MAX_HORIZON_DAYS, dayFields, holdKey, slotsKey} from 'booking/slots';
import {RESOURCE_TIMEZONE, daysBetween, formatInstant, parseDate, zoneKnown} from 'booking/tz';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

/** A slot's entry blocks it while it is a confirmed booking or a hold whose key still lives. */
async function isFree(value: string): Promise<boolean> {
  if (value.startsWith('booked:')) return false;
  return (await redis.exists(holdKey(value))) === 0;
}

app.get('/v1/resources/:resourceId/availability', async (request, reply) => {
  const {resourceId} = request.params as {resourceId: string};
  const query = request.query as {from: string; to: string; tz?: string};
  const start = parseDate(query.from);
  const end = parseDate(query.to);
  if (start === null || end === null || daysBetween(start, end) < 0) return reply.code(400).send({error: 'invalid_range'});
  if (daysBetween(start, end) > MAX_HORIZON_DAYS) return reply.code(400).send({error: 'range_too_long'});
  const zone = query.tz ?? RESOURCE_TIMEZONE;
  if (!zoneKnown(zone)) return reply.code(400).send({error: 'unknown_timezone'});

  // The same map the hold script writes: a copy would advertise a slot the booking path then refuses.
  const held = await redis.hgetall(slotsKey(resourceId));
  const slots: string[] = [];
  for (let offset = 0; offset <= daysBetween(start, end); offset += 1) {
    const day = new Date(Date.UTC(start[0], start[1] - 1, start[2] + offset));
    for (const field of dayFields(zone, day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate())) {
      const value = held[field];
      if (value === undefined || (await isFree(value))) slots.push(formatInstant(Number(field) * 60));
    }
  }
  return reply.code(200).send({resource_id: resourceId, timezone: zone, slots});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"booking/slots"
	"booking/tz"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func respond(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func availability(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	resourceID := r.PathValue("id")
	start, okStart := tz.ParseDate(r.URL.Query().Get("from"))
	end, okEnd := tz.ParseDate(r.URL.Query().Get("to"))
	if !okStart || !okEnd || tz.DaysBetween(start, end) < 0 {
		respond(rw, http.StatusBadRequest, map[string]string{"error": "invalid_range"})
		return
	}
	slotList := []string{}
	for offset := 0; offset <= tz.DaysBetween(start, end); offset++ {
		day := time.Date(start.Year, time.Month(start.Month), start.Day+offset, 0, 0, 0, 0, time.UTC)
		// The nightly materialization: every free slot of the day, as the job saw it.
		materialized, err := rdb.HGetAll(r.Context(), "availability:"+resourceID+":"+day.Format("2006-01-02")).Result()
		if err != nil {
			respond(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
			return
		}
		fields := make([]string, 0, len(materialized))
		for f := range materialized {
			fields = append(fields, f)
		}
		sort.Slice(fields, func(i, j int) bool { a, _ := strconv.Atoi(fields[i]); b, _ := strconv.Atoi(fields[j]); return a < b })
		for _, f := range fields {
			minute, _ := strconv.ParseInt(f, 10, 64)
			slotList = append(slotList, tz.FormatInstant(minute*60))
		}
	}
	respond(rw, http.StatusOK, map[string]any{"resource_id": resourceID, "slots": slotList})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/resources/{id}/availability", availability)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"booking/slots"
	"booking/tz"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func respond(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

// isFree: a slot's entry blocks it while it is a confirmed booking or a hold whose key still lives.
func isFree(r *http.Request, value string) (bool, error) {
	if strings.HasPrefix(value, "booked:") {
		return false, nil
	}
	live, err := rdb.Exists(r.Context(), slots.HoldKey(value)).Result()
	return live == 0, err
}

func availability(rw http.ResponseWriter, r *http.Request) {
	resourceID := r.PathValue("id")
	start, okStart := tz.ParseDate(r.URL.Query().Get("from"))
	end, okEnd := tz.ParseDate(r.URL.Query().Get("to"))
	if !okStart || !okEnd || tz.DaysBetween(start, end) < 0 {
		respond(rw, http.StatusBadRequest, map[string]string{"error": "invalid_range"})
		return
	}
	if tz.DaysBetween(start, end) > slots.MaxHorizonDays {
		respond(rw, http.StatusBadRequest, map[string]string{"error": "range_too_long"})
		return
	}
	zone := r.URL.Query().Get("tz")
	if zone == "" {
		zone = tz.ResourceTimezone
	}
	if !tz.Known(zone) {
		respond(rw, http.StatusBadRequest, map[string]string{"error": "unknown_timezone"})
		return
	}

	// The same map the hold script writes: a copy would advertise a slot the booking path then refuses.
	held, err := rdb.HGetAll(r.Context(), slots.Key(resourceID)).Result()
	if err != nil {
		respond(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	slotList := []string{}
	for offset := 0; offset <= tz.DaysBetween(start, end); offset++ {
		day := time.Date(start.Year, time.Month(start.Month), start.Day+offset, 0, 0, 0, 0, time.UTC)
		for _, field := range slots.DayFields(zone, day.Year(), int(day.Month()), day.Day()) {
			value, taken := held[field]
			free := !taken
			if taken {
				if free, err = isFree(r, value); err != nil {
					respond(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
					return
				}
			}
			if free {
				minute, _ := strconv.ParseInt(field, 10, 64)
				slotList = append(slotList, tz.FormatInstant(minute*60))
			}
		}
	}
	respond(rw, http.StatusOK, map[string]any{"resource_id": resourceID, "timezone": zone, "slots": slotList})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/resources/{id}/availability", availability)
}
`,
    },
    scala: {
      starter: `import scala.jdk.CollectionConverters._

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import booking.{Slots, Tz}

object AvailabilityApi {
  implicit val system: ActorSystem = ActorSystem("booking")
  val jedis = new JedisPooled("redis", 6379)

  private def error(status: StatusCode, code: String): Route =
    complete(status, HttpEntity(ContentTypes.\`application/json\`, s"""{"error":"$code"}"""))

  val route: Route =
    path("v1" / "resources" / Segment / "availability") { resourceId =>
      get {
        parameters("from", "to", "tz".optional) { (from, to, tz) =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          (Tz.parseDate(from), Tz.parseDate(to)) match {
            case (Some(start), Some(end)) if Tz.daysBetween(start, end) >= 0 =>
              val slots = (0 to Tz.daysBetween(start, end)).flatMap { offset =>
                val day = start.plusDays(offset.toLong)
                // The nightly materialization: every free slot of the day, as the job saw it.
                val materialized = jedis.hgetAll(s"availability:$resourceId:$day").asScala.keys.toSeq.sortBy(_.toLong)
                materialized.map(field => Tz.formatInstant(field.toLong * 60))
              }
              val body = JsObject("resource_id" -> JsString(resourceId), "slots" -> JsArray(slots.map(JsString(_)).toVector))
              complete(HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))
            case _ => error(StatusCodes.BadRequest, "invalid_range")
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import scala.jdk.CollectionConverters._

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import booking.{Slots, Tz}

object AvailabilityApi {
  implicit val system: ActorSystem = ActorSystem("booking")
  val jedis = new JedisPooled("redis", 6379)

  private def error(status: StatusCode, code: String): Route =
    complete(status, HttpEntity(ContentTypes.\`application/json\`, s"""{"error":"$code"}"""))

  /** A slot's entry blocks it while it is a confirmed booking or a hold whose key still lives. */
  private def isFree(value: String): Boolean =
    !value.startsWith("booked:") && !jedis.exists(Slots.holdKey(value))

  val route: Route =
    path("v1" / "resources" / Segment / "availability") { resourceId =>
      get {
        parameters("from", "to", "tz".optional) { (from, to, tz) =>
          (Tz.parseDate(from), Tz.parseDate(to)) match {
            case (Some(start), Some(end)) if Tz.daysBetween(start, end) >= 0 =>
              val zone = tz.getOrElse(Tz.ResourceTimezone)
              if (Tz.daysBetween(start, end) > Slots.MaxHorizonDays) error(StatusCodes.BadRequest, "range_too_long")
              else if (!Tz.known(zone)) error(StatusCodes.BadRequest, "unknown_timezone")
              else {
                // The same map the hold script writes: a copy would advertise a slot the booking path then refuses.
                val held = jedis.hgetAll(Slots.key(resourceId)).asScala
                val slots = (0 to Tz.daysBetween(start, end)).flatMap { offset =>
                  val day = start.plusDays(offset.toLong)
                  Slots
                    .dayFields(zone, day.getYear, day.getMonthValue, day.getDayOfMonth)
                    .filter(field => held.get(field).forall(isFree))
                    .map(field => Tz.formatInstant(field.toLong * 60))
                }
                val body = JsObject(
                  "resource_id" -> JsString(resourceId),
                  "timezone" -> JsString(zone),
                  "slots" -> JsArray(slots.map(JsString(_)).toVector)
                )
                complete(HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))
              }
            case _ => error(StatusCodes.BadRequest, "invalid_range")
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

#include <algorithm>
#include <string>
#include <unordered_map>
#include <vector>

#include "booking/slots.h"
#include "booking/tz.h"

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

static void fail(httplib::Response& res, int status, const std::string& code) {
  res.status = status;
  res.set_content(json{{"error", code}}.dump(), "application/json");
}

void availability(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string resource_id = req.matches[1].str();
  const auto start = booking::tz::ParseDate(req.get_param_value("from"));
  const auto end = booking::tz::ParseDate(req.get_param_value("to"));
  if (!start || !end || booking::tz::DaysBetween(*start, *end) < 0) return fail(res, 400, "invalid_range");
  std::vector<std::string> slots;
  for (int offset = 0; offset <= booking::tz::DaysBetween(*start, *end); offset++) {
    const auto day = booking::tz::CivilFromDays(booking::tz::DaysFromCivil(start->year, start->month, start->day) + offset);
    char text[11];
    std::snprintf(text, sizeof text, "%04d-%02d-%02d", day.year, day.month, day.day);
    // The nightly materialization: every free slot of the day, as the job saw it.
    std::unordered_map<std::string, std::string> materialized = redis.hgetall("availability:" + resource_id + ":" + text);
    std::vector<long long> fields;
    for (const auto& [field, _] : materialized) fields.push_back(std::stoll(field));
    std::sort(fields.begin(), fields.end());
    for (const long long field : fields) slots.push_back(booking::tz::FormatInstant(field * 60));
  }
  res.set_content(json{{"resource_id", resource_id}, {"slots", slots}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/resources/([^/]+)/availability)", availability);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <unordered_map>
#include <vector>

#include "booking/slots.h"
#include "booking/tz.h"

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

static void fail(httplib::Response& res, int status, const std::string& code) {
  res.status = status;
  res.set_content(json{{"error", code}}.dump(), "application/json");
}

// A slot's entry blocks it while it is a confirmed booking or a hold whose key still lives.
static bool isFree(const std::string& value) {
  if (value.rfind("booked:", 0) == 0) return false;
  return redis.exists(booking::slots::HoldKey(value)) == 0;
}

void availability(const httplib::Request& req, httplib::Response& res) {
  const std::string resource_id = req.matches[1].str();
  const auto start = booking::tz::ParseDate(req.get_param_value("from"));
  const auto end = booking::tz::ParseDate(req.get_param_value("to"));
  if (!start || !end || booking::tz::DaysBetween(*start, *end) < 0) return fail(res, 400, "invalid_range");
  if (booking::tz::DaysBetween(*start, *end) > booking::slots::kMaxHorizonDays) return fail(res, 400, "range_too_long");
  const std::string zone = req.has_param("tz") ? req.get_param_value("tz") : booking::tz::kResourceTimezone;
  if (!booking::tz::Known(zone)) return fail(res, 400, "unknown_timezone");

  // The same map the hold script writes: a copy would advertise a slot the booking path then refuses.
  std::unordered_map<std::string, std::string> held = redis.hgetall(booking::slots::Key(resource_id));
  std::vector<std::string> slots;
  for (int offset = 0; offset <= booking::tz::DaysBetween(*start, *end); offset++) {
    const auto day = booking::tz::CivilFromDays(booking::tz::DaysFromCivil(start->year, start->month, start->day) + offset);
    for (const auto& field : booking::slots::DayFields(zone, day.year, day.month, day.day)) {
      const auto it = held.find(field);
      if (it == held.end() || isFree(it->second)) slots.push_back(booking::tz::FormatInstant(std::stoll(field) * 60));
    }
  }
  res.set_content(json{{"resource_id", resource_id}, {"timezone", zone}, {"slots", slots}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/resources/([^/]+)/availability)", availability);
}
`,
    },
  },
  harness: {
    python: `from booking.slots import day_fields, hold_key, slots_key
from booking.tz import format_instant

DAY = "2026-03-10"
BERLIN = day_fields("Europe/Berlin", 2026, 3, 10)  # 08:00 to 19:30 CET: 07:00Z to 18:30Z
TOKYO = day_fields("Asia/Tokyo", 2026, 3, 10)  # 08:00 to 19:30 JST: the day before, 23:00Z, to 10:30Z


def _instants(fields):
    return [format_instant(int(f) * 60) for f in fields]


async def _get(ctx, m, **query):
    query.setdefault("from", DAY)
    query.setdefault("to", DAY)
    async with ctx.client(m.app) as c:
        return await c.get("/v1/resources/r1/availability", params=query)


def _slots(r):
    body = r.json()
    assert isinstance(body.get("slots"), list), f"the answer must carry a slots list: {body}"
    return body["slots"]


async def check_route(ctx):
    m = ctx.load("read")
    r = await _get(ctx, m)
    assert r.status_code == 200, f"GET /v1/resources/r1/availability answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("resource_id") == "r1", f"the answer must echo the resource id: {body}"
    _slots(r)


async def check_range_cap(ctx):
    m = ctx.load("read")
    probe = ctx.redis_after(slots_key("r1"), lambda: None)
    r = await _get(ctx, m, to="2026-06-09")  # 91 days
    assert r.status_code == 400 and r.json().get("error") == "range_too_long", f"a 91-day span answered {r.status_code} {r.text}, expected 400 range_too_long"
    assert not probe.fired, "a 91-day span was refused only after reading resource:r1:slots: refuse it before any slot work"
    r = await _get(ctx, m, to="2026-06-08")  # 90 days
    assert r.status_code == 200, f"a 90-day span answered {r.status_code}: {r.text}"
    assert len(_slots(r)) == 91 * len(BERLIN), f"a 90-day span of free days lists {len(_slots(r))} slots, expected {91 * len(BERLIN)}"
    r = await _get(ctx, m, to="2026-03-09")
    assert r.status_code == 400, f"a span ending before it starts answered {r.status_code}, expected 400"


async def check_live_hold_map(ctx):
    m = ctx.load("read")
    for f in BERLIN:
        ctx.redis.hset("availability:r1:" + DAY, f, "free")  # last night's materialization: everything free
    ctx.redis.hset(slots_key("r1"), BERLIN[2], "booked:b-9")  # booked a second ago
    r = await _get(ctx, m)
    assert r.status_code == 200, f"GET answered {r.status_code}: {r.text}"
    slots = _slots(r)
    assert _instants([BERLIN[2]])[0] not in slots, f"the slot booked a second ago ({_instants([BERLIN[2]])[0]}) is still advertised: read resource:r1:slots at request time, not a materialization"
    assert slots == _instants(BERLIN[:2] + BERLIN[3:]), f"a day with one booked slot lists {len(slots)} slots, expected the other {len(BERLIN) - 1} of the Berlin day"
    ctx.redis.hset(slots_key("r1"), BERLIN[5], "h-now")
    ctx.redis.set(hold_key("h-now"), "held", ex=900)
    assert _instants([BERLIN[5]])[0] not in _slots(await _get(ctx, m)), "a slot held since the previous read must be gone from the next one"


async def check_held_excluded(ctx):
    m = ctx.load("read")
    ctx.redis.hset(slots_key("r1"), BERLIN[0], "booked:b-1")
    ctx.redis.hset(slots_key("r1"), BERLIN[1], "h-live")
    ctx.redis.set(hold_key("h-live"), "held", ex=900)
    ctx.redis.hset(slots_key("r1"), BERLIN[2], "h-dead")  # its checkout was abandoned an hour ago
    r = await _get(ctx, m)
    assert r.status_code == 200, f"GET answered {r.status_code}: {r.text}"
    slots = _slots(r)
    booked, live, dead = _instants(BERLIN[:3])
    assert booked not in slots, f"a confirmed booking's slot ({booked}) is advertised as free"
    assert live not in slots, f"a slot held inside the payment window ({live}) is advertised as free"
    assert dead in slots, f"a slot whose hold expired ({dead}) is not advertised: an entry whose hold:{{id}} key is gone is free again"
    assert len(slots) == len(BERLIN) - 2, f"the day lists {len(slots)} slots, expected {len(BERLIN) - 2}"


async def check_timezone_echo(ctx):
    m = ctx.load("read")
    r = await _get(ctx, m)
    assert r.status_code == 200, f"GET answered {r.status_code}: {r.text}"
    assert r.json().get("timezone") == "Europe/Berlin", f"without tz the answer must name the resource's zone Europe/Berlin, got {r.json().get('timezone')!r}"
    assert _slots(r) == _instants(BERLIN), f"the Berlin day must run 07:00Z to 18:30Z (08:00 to 19:30 CET), got {_slots(r)[:1]} … {_slots(r)[-1:]} ({len(_slots(r))} slots)"
    ctx.redis.hset(slots_key("r1"), TOKYO[0], "booked:b-2")  # 08:00 in Tokyo: 23:00Z the day before
    r = await _get(ctx, m, tz="Asia/Tokyo")
    assert r.status_code == 200, f"tz=Asia/Tokyo answered {r.status_code}: {r.text}"
    assert r.json().get("timezone") == "Asia/Tokyo", f"the answer must name the zone it resolved, got {r.json().get('timezone')!r}"
    assert _slots(r) == _instants(TOKYO[1:]), f"Tokyo's day starts at 23:00Z the day before and its 08:00 slot is booked, got {_slots(r)[:1]} … {_slots(r)[-1:]} ({len(_slots(r))} slots)"
    r = await _get(ctx, m, tz="Mars/Olympus")
    assert r.status_code == 400 and r.json().get("error") == "unknown_timezone", f"an unknown zone answered {r.status_code} {r.text}, expected 400 unknown_timezone"
    r = await _get(ctx, m, tz="constructor")
    assert r.status_code == 400 and r.json().get("error") == "unknown_timezone", f"tz=constructor answered {r.status_code} {r.text}, expected 400 unknown_timezone: only the zones booking/tz lists are known"
`,
    typescript: `import {dayFields, holdKey, slotsKey} from 'booking/slots';
import {formatInstant} from 'booking/tz';

const DAY = '2026-03-10';
const BERLIN = dayFields('Europe/Berlin', 2026, 3, 10); // 08:00 to 19:30 CET: 07:00Z to 18:30Z
const TOKYO = dayFields('Asia/Tokyo', 2026, 3, 10); // 08:00 to 19:30 JST: the day before, 23:00Z, to 10:30Z

const instants = (fields: string[]): string[] => fields.map(f => formatInstant(Number(f) * 60));

const read = ctx => ctx.client(ctx.load('read').app);

const get = (c, query: Record<string, string> = {}) => c.get('/v1/resources/r1/availability', {query: {from: DAY, to: DAY, ...query}});

const slotsOf = (r): string[] => {
  const body = r.json();
  assert(Array.isArray(body.slots), \`the answer must carry a slots list: \${r.text}\`);
  return body.slots;
};

export async function check_route(ctx) {
  const c = read(ctx);
  const r = await get(c);
  assert.equal(r.status, 200, \`GET /v1/resources/r1/availability answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().resource_id, 'r1', \`the answer must echo the resource id: \${r.text}\`);
  slotsOf(r);
}

export async function check_range_cap(ctx) {
  const c = read(ctx);
  const probe = ctx.redisAfter(slotsKey('r1'), () => undefined);
  let r = await get(c, {to: '2026-06-09'}); // 91 days
  assert(r.status === 400 && r.json().error === 'range_too_long', \`a 91-day span answered \${r.status} \${r.text}, expected 400 range_too_long\`);
  assert(!probe.fired, 'a 91-day span was refused only after reading resource:r1:slots: refuse it before any slot work');
  r = await get(c, {to: '2026-06-08'}); // 90 days
  assert.equal(r.status, 200, \`a 90-day span answered \${r.status}: \${r.text}\`);
  assert.equal(slotsOf(r).length, 91 * BERLIN.length, \`a 90-day span of free days lists \${slotsOf(r).length} slots, expected \${91 * BERLIN.length}\`);
  r = await get(c, {to: '2026-03-09'});
  assert.equal(r.status, 400, \`a span ending before it starts answered \${r.status}, expected 400\`);
}

export async function check_live_hold_map(ctx) {
  const c = read(ctx);
  for (const f of BERLIN) ctx.redis.hset(\`availability:r1:\${DAY}\`, f, 'free'); // last night's materialization: everything free
  ctx.redis.hset(slotsKey('r1'), BERLIN[2], 'booked:b-9'); // booked a second ago
  let r = await get(c);
  assert.equal(r.status, 200, \`GET answered \${r.status}: \${r.text}\`);
  const slots = slotsOf(r);
  const [booked] = instants([BERLIN[2]]);
  assert(!slots.includes(booked), \`the slot booked a second ago (\${booked}) is still advertised: read resource:r1:slots at request time, not a materialization\`);
  assert.deepEqual(slots, instants([...BERLIN.slice(0, 2), ...BERLIN.slice(3)]), \`a day with one booked slot lists \${slots.length} slots, expected the other \${BERLIN.length - 1} of the Berlin day\`);
  ctx.redis.hset(slotsKey('r1'), BERLIN[5], 'h-now');
  ctx.redis.set(holdKey('h-now'), 'held', 'EX', 900);
  r = await get(c);
  assert(!slotsOf(r).includes(instants([BERLIN[5]])[0]), 'a slot held since the previous read must be gone from the next one');
}

export async function check_held_excluded(ctx) {
  const c = read(ctx);
  ctx.redis.hset(slotsKey('r1'), BERLIN[0], 'booked:b-1');
  ctx.redis.hset(slotsKey('r1'), BERLIN[1], 'h-live');
  ctx.redis.set(holdKey('h-live'), 'held', 'EX', 900);
  ctx.redis.hset(slotsKey('r1'), BERLIN[2], 'h-dead'); // its checkout was abandoned an hour ago
  const r = await get(c);
  assert.equal(r.status, 200, \`GET answered \${r.status}: \${r.text}\`);
  const slots = slotsOf(r);
  const [booked, live, dead] = instants(BERLIN.slice(0, 3));
  assert(!slots.includes(booked), \`a confirmed booking's slot (\${booked}) is advertised as free\`);
  assert(!slots.includes(live), \`a slot held inside the payment window (\${live}) is advertised as free\`);
  assert(slots.includes(dead), \`a slot whose hold expired (\${dead}) is not advertised: an entry whose hold:{id} key is gone is free again\`);
  assert.equal(slots.length, BERLIN.length - 2, \`the day lists \${slots.length} slots, expected \${BERLIN.length - 2}\`);
}

export async function check_timezone_echo(ctx) {
  const c = read(ctx);
  let r = await get(c);
  assert.equal(r.status, 200, \`GET answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().timezone, 'Europe/Berlin', \`without tz the answer must name the resource's zone Europe/Berlin, got \${JSON.stringify(r.json().timezone)}\`);
  assert.deepEqual(slotsOf(r), instants(BERLIN), \`the Berlin day must run 07:00Z to 18:30Z (08:00 to 19:30 CET), got \${slotsOf(r)[0]} … \${slotsOf(r).at(-1)} (\${slotsOf(r).length} slots)\`);
  ctx.redis.hset(slotsKey('r1'), TOKYO[0], 'booked:b-2'); // 08:00 in Tokyo: 23:00Z the day before
  r = await get(c, {tz: 'Asia/Tokyo'});
  assert.equal(r.status, 200, \`tz=Asia/Tokyo answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().timezone, 'Asia/Tokyo', \`the answer must name the zone it resolved, got \${JSON.stringify(r.json().timezone)}\`);
  assert.deepEqual(slotsOf(r), instants(TOKYO.slice(1)), \`Tokyo's day starts at 23:00Z the day before and its 08:00 slot is booked, got \${slotsOf(r)[0]} … \${slotsOf(r).at(-1)} (\${slotsOf(r).length} slots)\`);
  r = await get(c, {tz: 'Mars/Olympus'});
  assert(r.status === 400 && r.json().error === 'unknown_timezone', \`an unknown zone answered \${r.status} \${r.text}, expected 400 unknown_timezone\`);
  r = await get(c, {tz: 'constructor'});
  assert(r.status === 400 && r.json().error === 'unknown_timezone', \`tz=constructor answered \${r.status} \${r.text}, expected 400 unknown_timezone: only the zones booking/tz lists are known\`);
}
`,
    go: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"leetbuild/harness"

	"booking/slots"
	"booking/tz"
)

const readDay = "2026-03-10"

var (
	readBerlin = slots.DayFields("Europe/Berlin", 2026, 3, 10) // 08:00 to 19:30 CET: 07:00Z to 18:30Z
	readTokyo  = slots.DayFields("Asia/Tokyo", 2026, 3, 10)    // 08:00 to 19:30 JST: the day before, 23:00Z, to 10:30Z
)

func readInstants(fields []string) []string {
	out := []string{}
	for _, f := range fields {
		minute, _ := strconv.ParseInt(f, 10, 64)
		out = append(out, tz.FormatInstant(minute*60))
	}
	return out
}

func readClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readGet(c *harness.HTTP, query string) *harness.Response {
	return c.Get("/v1/resources/r1/availability?from=" + readDay + "&to=" + readDay + query)
}

type readBody struct {
	ResourceID string   \`json:"resource_id"\`
	Timezone   string   \`json:"timezone"\`
	Slots      []string \`json:"slots"\`
	Error      string   \`json:"error"\`
}

func readDecode(ctx *harness.Ctx, r *harness.Response) readBody {
	var body readBody
	ctx.NoError(json.Unmarshal(r.Body, &body), "the answer must be JSON with resource_id, timezone and a slots list")
	return body
}

func readSlots(ctx *harness.Ctx, r *harness.Response) []string {
	body := readDecode(ctx, r)
	ctx.Assert(body.Slots != nil, "the answer must carry a slots list: %s", r.Text())
	return body.Slots
}

func readHas(slots []string, instant string) bool {
	for _, s := range slots {
		if s == instant {
			return true
		}
	}
	return false
}

func CheckRoute(ctx *harness.Ctx) {
	c := readClient(ctx)
	r := readGet(c, "")
	ctx.Equal(r.Status, 200, "GET /v1/resources/r1/availability (%s)", r.Text())
	ctx.Equal(readDecode(ctx, r).ResourceID, "r1", "the answer must echo the resource id")
	readSlots(ctx, r)
}

func CheckRangeCap(ctx *harness.Ctx) {
	c := readClient(ctx)
	probe := ctx.Redis.After(slots.Key("r1"), func() any { return nil })
	r := c.Get("/v1/resources/r1/availability?from=" + readDay + "&to=2026-06-09") // 91 days
	ctx.Assert(r.Status == 400 && readDecode(ctx, r).Error == "range_too_long", "a 91-day span answered %d %s, expected 400 range_too_long", r.Status, r.Text())
	ctx.Assert(!probe.Fired, "a 91-day span was refused only after reading resource:r1:slots: refuse it before any slot work")
	r = c.Get("/v1/resources/r1/availability?from=" + readDay + "&to=2026-06-08") // 90 days
	ctx.Equal(r.Status, 200, "a 90-day span (%s)", r.Text())
	ctx.Equal(len(readSlots(ctx, r)), 91*len(readBerlin), "a 90-day span of free days; its slots")
	r = c.Get("/v1/resources/r1/availability?from=" + readDay + "&to=2026-03-09")
	ctx.Equal(r.Status, 400, "a span ending before it starts")
}

func CheckLiveHoldMap(ctx *harness.Ctx) {
	c := readClient(ctx)
	for _, f := range readBerlin {
		ctx.Redis.Do("HSET", "availability:r1:"+readDay, f, "free") // last night's materialization: everything free
	}
	ctx.Redis.Do("HSET", slots.Key("r1"), readBerlin[2], "booked:b-9") // booked a second ago
	r := readGet(c, "")
	ctx.Equal(r.Status, 200, "GET (%s)", r.Text())
	got := readSlots(ctx, r)
	booked := readInstants(readBerlin[2:3])[0]
	ctx.Assert(!readHas(got, booked), "the slot booked a second ago (%s) is still advertised: read resource:r1:slots at request time, not a materialization", booked)
	ctx.Equal(got, readInstants(append(append([]string{}, readBerlin[:2]...), readBerlin[3:]...)), "a day with one booked slot must list the other %d slots of the Berlin day", len(readBerlin)-1)
	ctx.Redis.Do("HSET", slots.Key("r1"), readBerlin[5], "h-now")
	ctx.Redis.Set(slots.HoldKey("h-now"), "held", "EX", 900)
	ctx.Assert(!readHas(readSlots(ctx, readGet(c, "")), readInstants(readBerlin[5:6])[0]), "a slot held since the previous read must be gone from the next one")
}

func CheckHeldExcluded(ctx *harness.Ctx) {
	c := readClient(ctx)
	ctx.Redis.Do("HSET", slots.Key("r1"), readBerlin[0], "booked:b-1")
	ctx.Redis.Do("HSET", slots.Key("r1"), readBerlin[1], "h-live")
	ctx.Redis.Set(slots.HoldKey("h-live"), "held", "EX", 900)
	ctx.Redis.Do("HSET", slots.Key("r1"), readBerlin[2], "h-dead") // its checkout was abandoned an hour ago
	r := readGet(c, "")
	ctx.Equal(r.Status, 200, "GET (%s)", r.Text())
	got := readSlots(ctx, r)
	first := readInstants(readBerlin[:3])
	ctx.Assert(!readHas(got, first[0]), "a confirmed booking's slot (%s) is advertised as free", first[0])
	ctx.Assert(!readHas(got, first[1]), "a slot held inside the payment window (%s) is advertised as free", first[1])
	ctx.Assert(readHas(got, first[2]), "a slot whose hold expired (%s) is not advertised: an entry whose hold:{id} key is gone is free again", first[2])
	ctx.Equal(len(got), len(readBerlin)-2, "the day's slots")
}

func CheckTimezoneEcho(ctx *harness.Ctx) {
	c := readClient(ctx)
	r := readGet(c, "")
	ctx.Equal(r.Status, 200, "GET (%s)", r.Text())
	ctx.Equal(readDecode(ctx, r).Timezone, "Europe/Berlin", "without tz the answer must name the resource's zone")
	ctx.Equal(readSlots(ctx, r), readInstants(readBerlin), "the Berlin day must run 07:00Z to 18:30Z (08:00 to 19:30 CET)")
	ctx.Redis.Do("HSET", slots.Key("r1"), readTokyo[0], "booked:b-2") // 08:00 in Tokyo: 23:00Z the day before
	r = readGet(c, "&tz=Asia/Tokyo")
	ctx.Equal(r.Status, 200, "tz=Asia/Tokyo (%s)", r.Text())
	ctx.Equal(readDecode(ctx, r).Timezone, "Asia/Tokyo", "the answer must name the zone it resolved")
	ctx.Equal(readSlots(ctx, r), readInstants(readTokyo[1:]), "Tokyo's day starts at 23:00Z the day before and its 08:00 slot is booked")
	r = readGet(c, "&tz=Mars/Olympus")
	ctx.Assert(r.Status == 400 && readDecode(ctx, r).Error == "unknown_timezone", "an unknown zone answered %d %s, expected 400 unknown_timezone", r.Status, r.Text())
	r = readGet(c, "&tz=constructor")
	ctx.Assert(r.Status == 400 && readDecode(ctx, r).Error == "unknown_timezone", "tz=constructor answered %d %s, expected 400 unknown_timezone: only the zones booking/tz lists are known", r.Status, r.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <algorithm>
#include <string>
#include <vector>

namespace {

const std::string kReadDay = "2026-03-10";
const std::vector<std::string> kReadBerlin = booking::slots::DayFields("Europe/Berlin", 2026, 3, 10);  // 07:00Z to 18:30Z
const std::vector<std::string> kReadTokyo = booking::slots::DayFields("Asia/Tokyo", 2026, 3, 10);  // the day before, 23:00Z, to 10:30Z

std::vector<std::string> readInstants(const std::vector<std::string>& fields) {
  std::vector<std::string> out;
  for (const auto& f : fields) out.push_back(booking::tz::FormatInstant(std::stoll(f) * 60));
  return out;
}

harness::HTTP readClient(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response readGet(harness::HTTP& c, const std::string& query = "") {
  return c.Get("/v1/resources/r1/availability?from=" + kReadDay + "&to=" + kReadDay + query);
}

nlohmann::json readBody(harness::Ctx& ctx, const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the answer must be JSON with resource_id, timezone and a slots list, got %s", r.Text());
  return body;
}

std::string readField(const nlohmann::json& body, const std::string& field) {
  return body.contains(field) && body[field].is_string() ? body[field].get<std::string>() : "";
}

std::vector<std::string> readSlots(harness::Ctx& ctx, const harness::Response& r) {
  const auto body = readBody(ctx, r);
  ctx.Assert(body.contains("slots") && body["slots"].is_array(), "the answer must carry a slots list: %s", r.Text());
  return body["slots"].get<std::vector<std::string>>();
}

bool readHas(const std::vector<std::string>& slots, const std::string& instant) {
  return std::find(slots.begin(), slots.end(), instant) != slots.end();
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readClient(ctx);
  const auto r = readGet(c);
  ctx.Equal(r.Status, 200, "GET /v1/resources/r1/availability (%s)", r.Text());
  ctx.Equal(readField(readBody(ctx, r), "resource_id"), "r1", "the answer must echo the resource id");
  readSlots(ctx, r);
}

void CheckRangeCap(harness::Ctx& ctx) {
  auto c = readClient(ctx);
  bool touched = false;
  ctx.Redis.After(booking::slots::Key("r1"), [&] { touched = true; });
  auto r = c.Get("/v1/resources/r1/availability?from=" + kReadDay + "&to=2026-06-09");  // 91 days
  ctx.Assert(r.Status == 400 && readField(readBody(ctx, r), "error") == "range_too_long",
             "a 91-day span answered %d %s, expected 400 range_too_long", r.Status, r.Text());
  ctx.Assert(!touched, "a 91-day span was refused only after reading resource:r1:slots: refuse it before any slot work");
  r = c.Get("/v1/resources/r1/availability?from=" + kReadDay + "&to=2026-06-08");  // 90 days
  ctx.Equal(r.Status, 200, "a 90-day span (%s)", r.Text());
  ctx.Equal(readSlots(ctx, r).size(), 91 * kReadBerlin.size(), "a 90-day span of free days; its slots");
  r = c.Get("/v1/resources/r1/availability?from=" + kReadDay + "&to=2026-03-09");
  ctx.Equal(r.Status, 400, "a span ending before it starts");
}

void CheckLiveHoldMap(harness::Ctx& ctx) {
  auto c = readClient(ctx);
  for (const auto& f : kReadBerlin) ctx.Redis.Do("HSET", "availability:r1:" + kReadDay, f, "free");  // last night's materialization
  ctx.Redis.Do("HSET", booking::slots::Key("r1"), kReadBerlin[2], "booked:b-9");  // booked a second ago
  auto r = readGet(c);
  ctx.Equal(r.Status, 200, "GET (%s)", r.Text());
  const auto got = readSlots(ctx, r);
  const std::string booked = readInstants({kReadBerlin[2]})[0];
  ctx.Assert(!readHas(got, booked),
             "the slot booked a second ago (%s) is still advertised: read resource:r1:slots at request time, not a materialization", booked);
  std::vector<std::string> rest(kReadBerlin.begin(), kReadBerlin.begin() + 2);
  rest.insert(rest.end(), kReadBerlin.begin() + 3, kReadBerlin.end());
  ctx.Equal(got, readInstants(rest), "a day with one booked slot must list the other %d slots of the Berlin day", kReadBerlin.size() - 1);
  ctx.Redis.Do("HSET", booking::slots::Key("r1"), kReadBerlin[5], "h-now");
  ctx.Redis.Do("SET", booking::slots::HoldKey("h-now"), "held", "EX", 900);
  ctx.Assert(!readHas(readSlots(ctx, readGet(c)), readInstants({kReadBerlin[5]})[0]),
             "a slot held since the previous read must be gone from the next one");
}

void CheckHeldExcluded(harness::Ctx& ctx) {
  auto c = readClient(ctx);
  ctx.Redis.Do("HSET", booking::slots::Key("r1"), kReadBerlin[0], "booked:b-1");
  ctx.Redis.Do("HSET", booking::slots::Key("r1"), kReadBerlin[1], "h-live");
  ctx.Redis.Do("SET", booking::slots::HoldKey("h-live"), "held", "EX", 900);
  ctx.Redis.Do("HSET", booking::slots::Key("r1"), kReadBerlin[2], "h-dead");  // its checkout was abandoned an hour ago
  const auto r = readGet(c);
  ctx.Equal(r.Status, 200, "GET (%s)", r.Text());
  const auto got = readSlots(ctx, r);
  const auto first = readInstants({kReadBerlin[0], kReadBerlin[1], kReadBerlin[2]});
  ctx.Assert(!readHas(got, first[0]), "a confirmed booking's slot (%s) is advertised as free", first[0]);
  ctx.Assert(!readHas(got, first[1]), "a slot held inside the payment window (%s) is advertised as free", first[1]);
  ctx.Assert(readHas(got, first[2]), "a slot whose hold expired (%s) is not advertised: an entry whose hold:{id} key is gone is free again", first[2]);
  ctx.Equal(got.size(), kReadBerlin.size() - 2, "the day's slots");
}

void CheckTimezoneEcho(harness::Ctx& ctx) {
  auto c = readClient(ctx);
  auto r = readGet(c);
  ctx.Equal(r.Status, 200, "GET (%s)", r.Text());
  ctx.Equal(readField(readBody(ctx, r), "timezone"), "Europe/Berlin", "without tz the answer must name the resource's zone");
  ctx.Equal(readSlots(ctx, r), readInstants(kReadBerlin), "the Berlin day must run 07:00Z to 18:30Z (08:00 to 19:30 CET)");
  ctx.Redis.Do("HSET", booking::slots::Key("r1"), kReadTokyo[0], "booked:b-2");  // 08:00 in Tokyo: 23:00Z the day before
  r = readGet(c, "&tz=Asia/Tokyo");
  ctx.Equal(r.Status, 200, "tz=Asia/Tokyo (%s)", r.Text());
  ctx.Equal(readField(readBody(ctx, r), "timezone"), "Asia/Tokyo", "the answer must name the zone it resolved");
  ctx.Equal(readSlots(ctx, r), readInstants(std::vector<std::string>(kReadTokyo.begin() + 1, kReadTokyo.end())),
            "Tokyo's day starts at 23:00Z the day before and its 08:00 slot is booked");
  r = readGet(c, "&tz=Mars/Olympus");
  ctx.Assert(r.Status == 400 && readField(readBody(ctx, r), "error") == "unknown_timezone",
             "an unknown zone answered %d %s, expected 400 unknown_timezone", r.Status, r.Text());
  r = readGet(c, "&tz=constructor");
  ctx.Assert(r.Status == 400 && readField(readBody(ctx, r), "error") == "unknown_timezone",
             "tz=constructor answered %d %s, expected 400 unknown_timezone: only the zones booking/tz lists are known", r.Status,
             r.Text());
}
`,
  },
  hints: [
    'A guest picks a slot the page showed as free and gets 409 slot_taken; a guest in Tokyo books "Tuesday 9:00" and gets Tuesday 9:00 Berlin time.',
    'The materialization is a copy with a commit lag, and a hold id in the map says nothing by itself: only `hold:{id}` says whether the hold is still alive. The day boundary moves with the zone.',
    'Cap `days_between` at 90, resolve `tz` with `zone_known`, read `HGETALL resource:{id}:slots`, keep a candidate from `day_fields(zone, …)` unless it is `booked:` or its hold key exists, and echo `timezone`.',
  ],
  debrief: `The read is served from the write path's own map because any copy is a promise the booking path did not make, and the one thing a guest cannot forgive is a slot that was free until they chose it. The liveness rule (an entry counts while its hold key exists) is the same rule the take script applies, so the two paths cannot disagree about a slot. Naming the zone is cheap and removes the one ambiguity a client cannot detect on its own. Production systems cache the computed day per resource and invalidate it from the hold script, add opening hours and holidays per resource, page long windows, and keep a per-resource version in the map so a read can tell a client how fresh it is.`,
};
