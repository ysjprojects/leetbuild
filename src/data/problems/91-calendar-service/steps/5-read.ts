import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/calendars/{id}/events: a bounded window over a calendar you may read',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/calendars/{id}/events?from=&to=\` (ISO-8601
instants): it fills a missing \`from\` with now and a missing \`to\` with a year later
(\`DEFAULT_WINDOW_DAYS\`), refuses \`to <= from\` with **400** \`invalid_window\`, reads the occurrences
through step 2's \`cached_expansion\` and answers \`{"calendar_id", "occurrences"}\` with
\`Cache-Control: public, max-age=60\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A client asking for a decade, a typo in a calendar id, a private
calendar read by someone outside it, and a shared cache between the service and its clients.

Rules, in this order:

- An unknown calendar (\`store.get_calendar\`) is **404** \`calendar_not_found\`, before anything is
  expanded or cached.
- A \`private\` calendar is **403** \`not_a_member\` unless \`store.is_member(calendar, X-Tenant-Id)\`.
- \`from\` and \`to\` are required, \`to\` is after \`from\`, and they are at most \`MAX_RANGE_DAYS\` (90)
  apart: otherwise **400** \`invalid_window\`.
- A private calendar answers \`Cache-Control: private, max-age=60\`; a public one keeps
  \`public, max-age=60\`.`,
  sequence: {
    participants: ['Calendar client', 'Calendar API', 'Redis'],
    messages: [
      {
        from: 'Calendar client',
        to: 'Calendar API',
        label: 'GET /v1/calendars/{id}/events?from&to · X-Tenant-Id',
        kind: 'sync',
      },
      {from: 'Calendar API', to: 'Redis', label: 'calendar:{id} · calendar:{id}:members', kind: 'sync'},
      {from: 'Calendar API', to: 'Calendar API', label: '404 · 403 · window ≤ 90 days', kind: 'sync'},
      {from: 'Calendar API', to: 'Redis', label: 'cached_expansion(calendar, from, to)', kind: 'sync'},
      {
        from: 'Calendar API',
        to: 'Calendar client',
        label: '200 occurrences · Cache-Control private|public',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/calendars/{id}/events',
      detail:
        'A week of a public calendar answers 200 with the seven daily standups of that week, each with its occurrence id.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/calendars\/\{calendar_id\}\/events["']/, /cached_expansion\(/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/calendars\/:calendarId\/events['"]/, /cachedExpansion\(/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/calendars\/\{id\}\/events"/, /cachedExpansion\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"calendars"\s*\/\s*Segment\s*\/\s*"events"\s*\)/, /cachedExpansion\(/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/calendars\/\(\[\^\/\]\+\)\/events\)"/, /cachedExpansion\(/]},
      },
    },
    {
      id: 'range-cap',
      title: 'Refuses a missing bound or a window over 90 days with 400',
      detail:
        'A 120-day window, a missing `to` and a missing `from` are **400** `invalid_window`; exactly 90 days is served. The starter fills a missing bound with a year and expands any window it is given.',
      match: {
        python: {all: [/MAX_RANGE_DAYS/], none: [/DEFAULT_WINDOW_DAYS/]},
        typescript: {all: [/MAX_RANGE_DAYS/], none: [/DEFAULT_WINDOW_DAYS/]},
        go: {all: [/rrule\.MaxRangeDays/], none: [/defaultWindowDays/]},
        scala: {all: [/Rrule\.MaxRangeDays/], none: [/DefaultWindowDays/]},
        cpp: {all: [/kMaxRangeDays/], none: [/kDefaultWindowDays/]},
      },
    },
    {
      id: 'unknown-calendar',
      title: 'Answers 404 for a calendar that does not exist',
      detail:
        'An unknown calendar id is **404** `calendar_not_found`, and no slice is cached for it. The starter answers 200 with an empty week, so a typo looks like a free calendar and costs an expansion.',
      match: {
        python: {all: [/calendar_not_found/, /store\.get_calendar\(/]},
        typescript: {all: [/calendar_not_found/, /store\.getCalendar\(/]},
        go: {all: [/calendar_not_found/, /store\.GetCalendar\(/]},
        scala: {all: [/calendar_not_found/, /Store\.getCalendar\(/]},
        cpp: {all: [/calendar_not_found/, /store::GetCalendar\(/]},
      },
    },
    {
      id: 'private-calendars',
      title: 'Refuses a private calendar to a tenant outside it with 403',
      detail:
        'A `private` calendar is **403** `not_a_member` for a tenant that is not a member and for a request with no tenant, and served to a member. The starter serves it to anyone who knows the id.',
      match: {
        python: {all: [/not_a_member/, /store\.is_member\(/]},
        typescript: {all: [/not_a_member/, /store\.isMember\(/]},
        go: {all: [/not_a_member/, /store\.IsMember\(/]},
        scala: {all: [/not_a_member/, /Store\.isMember\(/]},
        cpp: {all: [/not_a_member/, /store::IsMember\(/]},
      },
    },
    {
      id: 'cache-control',
      title: 'Keeps a private calendar out of shared caches',
      detail:
        'A member reading a private calendar gets `Cache-Control: private, max-age=60`; a public calendar keeps `public`. The starter marks every answer `public`, so a proxy can hand one member’s private week to the next caller without asking the service.',
      match: {
        python: {all: [/["']private, max-age=60["']/]},
        typescript: {all: [/['"]private, max-age=60['"]/]},
        go: {all: [/"private, max-age=60"/]},
        scala: {all: [/"private, max-age=60"/]},
        cpp: {all: [/"private, max-age=60"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from calendard.rrule import parse_instant
from state import cached_expansion  # step 2: the occurrences of a window, exceptions applied

DEFAULT_WINDOW_DAYS = 365

app = FastAPI()


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status)


@app.get("/v1/calendars/{calendar_id}/events")
def list_events(calendar_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    start = parse_instant(request.query_params.get("from")) or int(time.time())
    end = parse_instant(request.query_params.get("to")) or start + DEFAULT_WINDOW_DAYS * 86400
    if end <= start:
        return _error(400, "invalid_window")
    occurrences = cached_expansion(calendar_id, start, end)
    return JSONResponse(
        {"calendar_id": calendar_id, "occurrences": occurrences},
        headers={"Cache-Control": "public, max-age=60"},
    )
`,
      solution: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from calendard.rrule import MAX_RANGE_DAYS, parse_instant
from calendard.store import store
from state import cached_expansion  # step 2: the occurrences of a window, exceptions applied

app = FastAPI()


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse({"error": code}, status_code=status)


@app.get("/v1/calendars/{calendar_id}/events")
def list_events(calendar_id: str, request: Request) -> JSONResponse:
    # The cheap refusals first: an unknown calendar and a stranger cost no expansion and leave no slice.
    calendar = store.get_calendar(calendar_id)
    if calendar is None:
        return _error(404, "calendar_not_found")
    private = calendar["visibility"] == "private"
    if private and not store.is_member(calendar_id, request.headers.get("X-Tenant-Id", "")):
        return _error(403, "not_a_member")
    start = parse_instant(request.query_params.get("from"))
    end = parse_instant(request.query_params.get("to"))
    if start is None or end is None or end <= start or end - start > MAX_RANGE_DAYS * 86400:
        return _error(400, "invalid_window")
    occurrences = cached_expansion(calendar_id, start, end)
    # A shared cache that stores a private answer serves it without asking who is reading.
    cache_control = "private, max-age=60" if private else "public, max-age=60"
    return JSONResponse(
        {"calendar_id": calendar_id, "occurrences": occurrences},
        headers={"Cache-Control": cache_control},
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {parseInstant} from 'calendard/rrule';
import {cachedExpansion} from './state'; // step 2: the occurrences of a window, exceptions applied

export const DEFAULT_WINDOW_DAYS = 365;

export const app = Fastify();

app.get('/v1/calendars/:calendarId/events', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {calendarId} = request.params as {calendarId: string};
  const query = request.query as {from?: string; to?: string};
  const start = parseInstant(query.from) ?? Math.floor(Date.now() / 1000);
  const end = parseInstant(query.to) ?? start + DEFAULT_WINDOW_DAYS * 86400;
  if (end <= start) return reply.code(400).send({error: 'invalid_window'});
  const occurrences = await cachedExpansion(calendarId, start, end);
  return reply.header('Cache-Control', 'public, max-age=60').send({calendar_id: calendarId, occurrences});
});
`,
      solution: `import Fastify from 'fastify';

import {MAX_RANGE_DAYS, parseInstant} from 'calendard/rrule';
import {store} from 'calendard/store';
import {cachedExpansion} from './state'; // step 2: the occurrences of a window, exceptions applied

export const app = Fastify();

app.get('/v1/calendars/:calendarId/events', async (request, reply) => {
  const {calendarId} = request.params as {calendarId: string};
  const query = request.query as {from?: string; to?: string};
  // The cheap refusals first: an unknown calendar and a stranger cost no expansion and leave no slice.
  const calendar = await store.getCalendar(calendarId);
  if (calendar === null) return reply.code(404).send({error: 'calendar_not_found'});
  const isPrivate = calendar.visibility === 'private';
  const tenant = request.headers['x-tenant-id'];
  if (isPrivate && !(typeof tenant === 'string' && (await store.isMember(calendarId, tenant)))) {
    return reply.code(403).send({error: 'not_a_member'});
  }
  const start = parseInstant(query.from);
  const end = parseInstant(query.to);
  if (start === null || end === null || end <= start || end - start > MAX_RANGE_DAYS * 86400) {
    return reply.code(400).send({error: 'invalid_window'});
  }
  const occurrences = await cachedExpansion(calendarId, start, end);
  // A shared cache that stores a private answer serves it without asking who is reading.
  const cacheControl = isPrivate ? 'private, max-age=60' : 'public, max-age=60';
  return reply.header('Cache-Control', cacheControl).send({calendar_id: calendarId, occurrences});
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"calendard/rrule"
)

const defaultWindowDays = 365

// Built in step 2 (state.go): the occurrences of a window, exceptions applied.
var cachedExpansion = func(ctx context.Context, calendarID string, start, end int64) ([]rrule.Occurrence, error) {
	panic("not implemented")
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func listEvents(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	calendarID := r.PathValue("id")
	start, ok := rrule.ParseInstant(r.URL.Query().Get("from"))
	if !ok {
		start = time.Now().Unix()
	}
	end, ok := rrule.ParseInstant(r.URL.Query().Get("to"))
	if !ok {
		end = start + defaultWindowDays*86400
	}
	if end <= start {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_window"})
		return
	}
	occurrences, err := cachedExpansion(r.Context(), calendarID, start, end)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	rw.Header().Set("Cache-Control", "public, max-age=60")
	writeJSON(rw, http.StatusOK, map[string]any{"calendar_id": calendarID, "occurrences": occurrences})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/calendars/{id}/events", listEvents)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"calendard/rrule"
	"calendard/store"
)

// Built in step 2 (state.go): the occurrences of a window, exceptions applied.
var cachedExpansion = func(ctx context.Context, calendarID string, start, end int64) ([]rrule.Occurrence, error) {
	panic("not implemented")
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func listEvents(rw http.ResponseWriter, r *http.Request) {
	calendarID := r.PathValue("id")
	// The cheap refusals first: an unknown calendar and a stranger cost no expansion and leave no slice.
	calendar, err := store.GetCalendar(r.Context(), calendarID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	if calendar == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "calendar_not_found"})
		return
	}
	private := calendar.Visibility == "private"
	if private {
		member, err := store.IsMember(r.Context(), calendarID, r.Header.Get("X-Tenant-Id"))
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
			return
		}
		if !member {
			writeJSON(rw, http.StatusForbidden, map[string]string{"error": "not_a_member"})
			return
		}
	}
	start, okStart := rrule.ParseInstant(r.URL.Query().Get("from"))
	end, okEnd := rrule.ParseInstant(r.URL.Query().Get("to"))
	if !okStart || !okEnd || end <= start || end-start > rrule.MaxRangeDays*86400 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid_window"})
		return
	}
	occurrences, err := cachedExpansion(r.Context(), calendarID, start, end)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	// A shared cache that stores a private answer serves it without asking who is reading.
	if private {
		rw.Header().Set("Cache-Control", "private, max-age=60")
	} else {
		rw.Header().Set("Cache-Control", "public, max-age=60")
	}
	writeJSON(rw, http.StatusOK, map[string]any{"calendar_id": calendarID, "occurrences": occurrences})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/calendars/{id}/events", listEvents)
}
`,
    },
    scala: {
      starter: `import java.time.Instant

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

import calendard.Rrule

object RangeRead {
  implicit val system: ActorSystem = ActorSystem("calendar-read")

  val DefaultWindowDays = 365L

  private def error(status: StatusCode, code: String): Route =
    complete(status, HttpEntity(ContentTypes.\`application/json\`, s"""{"error":"$code"}"""))

  val route: Route =
    path("v1" / "calendars" / Segment / "events") { calendarId =>
      get {
        parameters("from".optional, "to".optional) { (from, to) =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val start = from.flatMap(Rrule.parseInstant).getOrElse(Instant.now().getEpochSecond)
          val end = to.flatMap(Rrule.parseInstant).getOrElse(start + DefaultWindowDays * 86400)
          if (end <= start) error(StatusCodes.BadRequest, "invalid_window")
          else {
            val occurrences = ExpansionCache.cachedExpansion(calendarId, start, end) // step 2
            respondWithHeader(RawHeader("Cache-Control", "public, max-age=60")) {
              complete(JsObject("calendar_id" -> JsString(calendarId), "occurrences" -> occurrences.toJson))
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
import org.apache.pekko.http.scaladsl.model.headers.RawHeader
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._
import spray.json.DefaultJsonProtocol._

import calendard.{Rrule, Store}

object RangeRead {
  implicit val system: ActorSystem = ActorSystem("calendar-read")

  private def error(status: StatusCode, code: String): Route =
    complete(status, HttpEntity(ContentTypes.\`application/json\`, s"""{"error":"$code"}"""))

  val route: Route =
    path("v1" / "calendars" / Segment / "events") { calendarId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          parameters("from".optional, "to".optional) { (from, to) =>
            // The cheap refusals first: an unknown calendar and a stranger cost no expansion and leave no slice.
            Store.getCalendar(calendarId) match {
              case None => error(StatusCodes.NotFound, "calendar_not_found")
              case Some(calendar) =>
                val isPrivate = calendar.visibility == "private"
                if (isPrivate && !Store.isMember(calendarId, tenantOpt.getOrElse(""))) error(StatusCodes.Forbidden, "not_a_member")
                else
                  (from.flatMap(Rrule.parseInstant), to.flatMap(Rrule.parseInstant)) match {
                    case (Some(start), Some(end)) if end > start && end - start <= Rrule.MaxRangeDays * 86400L =>
                      val occurrences = ExpansionCache.cachedExpansion(calendarId, start, end) // step 2
                      // A shared cache that stores a private answer serves it without asking who is reading.
                      val cacheControl = if (isPrivate) "private, max-age=60" else "public, max-age=60"
                      respondWithHeader(RawHeader("Cache-Control", cacheControl)) {
                        complete(JsObject("calendar_id" -> JsString(calendarId), "occurrences" -> occurrences.toJson))
                      }
                    case _ => error(StatusCodes.BadRequest, "invalid_window")
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

#include <chrono>
#include <cstdint>
#include <string>
#include <vector>

#include "calendard/rrule.h"

using json = nlohmann::json;

constexpr int64_t kDefaultWindowDays = 365;

// Built in step 2 (state.cpp): the occurrences of a window, exceptions applied.
std::vector<calendard::Occurrence> cachedExpansion(const std::string& calendar_id, int64_t start, int64_t end);

static void fail(httplib::Response& res, int status, const std::string& code) {
  res.status = status;
  res.set_content(json{{"error", code}}.dump(), "application/json");
}

void listEvents(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string calendar_id = req.matches[1].str();
  const int64_t now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const int64_t start = calendard::rrule::ParseInstant(req.get_param_value("from")).value_or(now);
  const int64_t end = calendard::rrule::ParseInstant(req.get_param_value("to")).value_or(start + kDefaultWindowDays * 86400);
  if (end <= start) return fail(res, 400, "invalid_window");
  const auto occurrences = cachedExpansion(calendar_id, start, end);
  res.status = 200;
  res.set_header("Cache-Control", "public, max-age=60");
  res.set_content(json{{"calendar_id", calendar_id}, {"occurrences", occurrences}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/calendars/([^/]+)/events)", listEvents);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <cstdint>
#include <string>
#include <vector>

#include "calendard/rrule.h"
#include "calendard/store.h"

using json = nlohmann::json;

// Built in step 2 (state.cpp): the occurrences of a window, exceptions applied.
std::vector<calendard::Occurrence> cachedExpansion(const std::string& calendar_id, int64_t start, int64_t end);

static void fail(httplib::Response& res, int status, const std::string& code) {
  res.status = status;
  res.set_content(json{{"error", code}}.dump(), "application/json");
}

void listEvents(const httplib::Request& req, httplib::Response& res) {
  const std::string calendar_id = req.matches[1].str();
  // The cheap refusals first: an unknown calendar and a stranger cost no expansion and leave no slice.
  const auto calendar = calendard::store::GetCalendar(calendar_id);
  if (!calendar) return fail(res, 404, "calendar_not_found");
  const bool is_private = calendar->visibility == "private";
  if (is_private && !calendard::store::IsMember(calendar_id, req.get_header_value("X-Tenant-Id"))) return fail(res, 403, "not_a_member");
  const auto start = calendard::rrule::ParseInstant(req.get_param_value("from"));
  const auto end = calendard::rrule::ParseInstant(req.get_param_value("to"));
  if (!start || !end || *end <= *start || *end - *start > static_cast<int64_t>(calendard::rrule::kMaxRangeDays) * 86400) {
    return fail(res, 400, "invalid_window");
  }
  const auto occurrences = cachedExpansion(calendar_id, *start, *end);
  res.status = 200;
  // A shared cache that stores a private answer serves it without asking who is reading.
  res.set_header("Cache-Control", is_private ? "private, max-age=60" : "public, max-age=60");
  res.set_content(json{{"calendar_id", calendar_id}, {"occurrences", occurrences}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/calendars/([^/]+)/events)", listEvents);
}
`,
    },
  },
  harness: {
    python: `from calendard.rrule import parse_instant
from calendard.store import store

WEEK = "from=2026-03-02T00:00:00Z&to=2026-03-09T00:00:00Z"
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
    """c1 is public, c2 private; t1 is a member of both."""
    store.put_calendar("c1", "public", ["t1"])
    store.put_calendar("c2", "private", ["t1"])
    store.put_event(dict(EVENT))
    store.put_event({**EVENT, "event_id": "e-2", "calendar_id": "c2", "title": "Offsite planning"})
    return ctx.load("read")


async def _get(ctx, m, path, tenant="t1"):
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    async with ctx.client(m.app) as c:
        return await c.get(path, headers=headers)


def _error(r):
    try:
        return r.json().get("error")
    except ValueError:
        return None


async def check_route(ctx):
    m = _world(ctx)
    r = await _get(ctx, m, f"/v1/calendars/c1/events?{WEEK}")
    assert r.status_code == 200, f"GET a week of the public calendar c1 answered {r.status_code}: {r.text}"
    occurrences = r.json().get("occurrences", [])
    assert len(occurrences) == 7, f"the week answered {len(occurrences)} occurrences, expected the 7 daily standups"
    first = occurrences[0]
    assert first.get("occurrence_id") == f"e-1:{parse_instant('2026-03-02T09:00:00Z')}" and first.get("start") == "2026-03-02T09:00:00Z", f"the first occurrence is {first}"


async def check_range_cap(ctx):
    m = _world(ctx)
    for query, what in (
        ("from=2026-03-02T00:00:00Z&to=2026-06-30T00:00:00Z", "a 120-day window"),
        ("from=2026-03-02T00:00:00Z", "a window without to"),
        ("to=2026-03-09T00:00:00Z", "a window without from"),
    ):
        r = await _get(ctx, m, f"/v1/calendars/c1/events?{query}")
        assert r.status_code == 400 and _error(r) == "invalid_window", f"{what} answered {r.status_code} {r.text[:200]}, expected 400 invalid_window: a read bounds what one request may expand"
    r = await _get(ctx, m, "/v1/calendars/c1/events?from=2026-03-02T00:00:00Z&to=2026-05-31T00:00:00Z")
    assert r.status_code == 200, f"a window of exactly 90 days answered {r.status_code}: {r.text[:200]}"


async def check_unknown_calendar(ctx):
    m = _world(ctx)
    r = await _get(ctx, m, f"/v1/calendars/nope/events?{WEEK}")
    assert r.status_code == 404 and _error(r) == "calendar_not_found", f"an unknown calendar answered {r.status_code} {r.text}, expected 404 calendar_not_found: an empty week is a different answer"
    assert ctx.redis.keys("exp:nope*") == [], f"an unknown calendar left {ctx.redis.keys('exp:nope*')} in the cache"


async def check_private_calendars(ctx):
    m = _world(ctx)
    for tenant, what in (("t2", "a tenant outside the calendar"), ("", "a request without X-Tenant-Id")):
        r = await _get(ctx, m, f"/v1/calendars/c2/events?{WEEK}", tenant=tenant)
        assert r.status_code == 403 and _error(r) == "not_a_member", f"{what} reading the private calendar c2 answered {r.status_code} {r.text[:200]}, expected 403 not_a_member"
    r = await _get(ctx, m, f"/v1/calendars/c2/events?{WEEK}", tenant="t1")
    assert r.status_code == 200 and len(r.json().get("occurrences", [])) == 7, f"the member t1 reading c2 answered {r.status_code} {r.text[:200]}"


async def check_cache_control(ctx):
    m = _world(ctx)
    r = await _get(ctx, m, f"/v1/calendars/c2/events?{WEEK}", tenant="t1")
    assert r.status_code == 200, f"the member t1 reading the private calendar c2 answered {r.status_code}: {r.text[:200]}"
    cache_control = r.headers.get("cache-control", "")
    assert "private" in cache_control and "public" not in cache_control, f"the private calendar answered Cache-Control {cache_control!r}: a shared cache may store it and hand it to the next caller without asking the service"
    r = await _get(ctx, m, f"/v1/calendars/c1/events?{WEEK}")
    assert "public" in r.headers.get("cache-control", ""), f"the public calendar answered Cache-Control {r.headers.get('cache-control')!r}, expected public, max-age=60"
`,
    typescript: `import {store} from 'calendard/store';

const WEEK = 'from=2026-03-02T00:00:00Z&to=2026-03-09T00:00:00Z';
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

/** c1 is public, c2 private; t1 is a member of both. */
async function world(ctx) {
  await store.putCalendar('c1', 'public', ['t1']);
  await store.putCalendar('c2', 'private', ['t1']);
  await store.putEvent({...EVENT});
  await store.putEvent({...EVENT, event_id: 'e-2', calendar_id: 'c2', title: 'Offsite planning'});
  return ctx.load('read');
}

const get = (ctx, m, path: string, tenant = 't1') => ctx.client(m.app).get(path, {headers: tenant === '' ? {} : {'X-Tenant-Id': tenant}});

const errorOf = (r): string | undefined => {
  try {
    return r.json().error;
  } catch {
    return undefined;
  }
};

export async function check_route(ctx) {
  const m = await world(ctx);
  const r = await get(ctx, m, \`/v1/calendars/c1/events?\${WEEK}\`);
  assert.equal(r.status, 200, \`GET a week of the public calendar c1 answered \${r.status}: \${r.text}\`);
  const occurrences = r.json().occurrences ?? [];
  assert.equal(occurrences.length, 7, \`the week answered \${occurrences.length} occurrences, expected the 7 daily standups\`);
  const first = occurrences[0];
  assert(first.occurrence_id === 'e-1:' + Date.UTC(2026, 2, 2, 9) / 1000 && first.start === '2026-03-02T09:00:00Z', \`the first occurrence is \${JSON.stringify(first)}\`);
}

export async function check_range_cap(ctx) {
  const m = await world(ctx);
  for (const [query, what] of [
    ['from=2026-03-02T00:00:00Z&to=2026-06-30T00:00:00Z', 'a 120-day window'],
    ['from=2026-03-02T00:00:00Z', 'a window without to'],
    ['to=2026-03-09T00:00:00Z', 'a window without from'],
  ]) {
    const r = await get(ctx, m, \`/v1/calendars/c1/events?\${query}\`);
    assert(r.status === 400 && errorOf(r) === 'invalid_window', \`\${what} answered \${r.status} \${r.text.slice(0, 200)}, expected 400 invalid_window: a read bounds what one request may expand\`);
  }
  const r = await get(ctx, m, '/v1/calendars/c1/events?from=2026-03-02T00:00:00Z&to=2026-05-31T00:00:00Z');
  assert.equal(r.status, 200, \`a window of exactly 90 days answered \${r.status}: \${r.text.slice(0, 200)}\`);
}

export async function check_unknown_calendar(ctx) {
  const m = await world(ctx);
  const r = await get(ctx, m, \`/v1/calendars/nope/events?\${WEEK}\`);
  assert(r.status === 404 && errorOf(r) === 'calendar_not_found', \`an unknown calendar answered \${r.status} \${r.text}, expected 404 calendar_not_found: an empty week is a different answer\`);
  assert.deepEqual(ctx.redis.keys('exp:nope*'), [], \`an unknown calendar left \${JSON.stringify(ctx.redis.keys('exp:nope*'))} in the cache\`);
}

export async function check_private_calendars(ctx) {
  const m = await world(ctx);
  for (const [tenant, what] of [
    ['t2', 'a tenant outside the calendar'],
    ['', 'a request without X-Tenant-Id'],
  ]) {
    const r = await get(ctx, m, \`/v1/calendars/c2/events?\${WEEK}\`, tenant);
    assert(r.status === 403 && errorOf(r) === 'not_a_member', \`\${what} reading the private calendar c2 answered \${r.status} \${r.text.slice(0, 200)}, expected 403 not_a_member\`);
  }
  const r = await get(ctx, m, \`/v1/calendars/c2/events?\${WEEK}\`, 't1');
  assert(r.status === 200 && (r.json().occurrences ?? []).length === 7, \`the member t1 reading c2 answered \${r.status} \${r.text.slice(0, 200)}\`);
}

export async function check_cache_control(ctx) {
  const m = await world(ctx);
  let r = await get(ctx, m, \`/v1/calendars/c2/events?\${WEEK}\`, 't1');
  assert.equal(r.status, 200, \`the member t1 reading the private calendar c2 answered \${r.status}: \${r.text.slice(0, 200)}\`);
  const cacheControl = String(r.headers['cache-control'] ?? '');
  assert(cacheControl.includes('private') && !cacheControl.includes('public'), \`the private calendar answered Cache-Control \${JSON.stringify(cacheControl)}: a shared cache may store it and hand it to the next caller without asking the service\`);
  r = await get(ctx, m, \`/v1/calendars/c1/events?\${WEEK}\`);
  assert(String(r.headers['cache-control'] ?? '').includes('public'), \`the public calendar answered Cache-Control \${JSON.stringify(r.headers['cache-control'])}, expected public, max-age=60\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"leetbuild/harness"

	"calendard/rrule"
	"calendard/store"
)

const rdWeek = "from=2026-03-02T00:00:00Z&to=2026-03-09T00:00:00Z"

// rdClient seeds c1 (public) and c2 (private), t1 a member of both, each with a 30-minute daily
// standup ten times from Monday 2 March 2026, and serves the learner's route over step 2's cache,
// which the harness stands in for: every event expanded, sorted, the slice written for 300 s.
func rdClient(ctx *harness.Ctx) *harness.HTTP {
	bg := context.Background()
	ctx.NoError(store.PutCalendar(bg, "c1", "public", "t1"), "seeding c1")
	ctx.NoError(store.PutCalendar(bg, "c2", "private", "t1"), "seeding c2")
	for _, e := range []store.Event{
		{EventID: "e-1", CalendarID: "c1", Tenant: "t1", Title: "Standup", Rrule: "FREQ=DAILY;COUNT=10", Dtstart: "2026-03-02T09:00:00Z", Dtend: "2026-03-02T09:30:00Z", Revision: 1, Attendees: []string{"ana@example.com"}},
		{EventID: "e-2", CalendarID: "c2", Tenant: "t1", Title: "Offsite planning", Rrule: "FREQ=DAILY;COUNT=10", Dtstart: "2026-03-02T09:00:00Z", Dtend: "2026-03-02T09:30:00Z", Revision: 1, Attendees: []string{"ana@example.com"}},
	} {
		event := e
		ctx.NoError(store.PutEvent(bg, &event), "seeding an event")
	}
	cachedExpansion = func(c context.Context, calendarID string, start, end int64) ([]rrule.Occurrence, error) {
		events, err := store.ListEvents(c, calendarID)
		if err != nil {
			return nil, err
		}
		occurrences := []rrule.Occurrence{}
		for _, e := range events {
			occurrences = append(occurrences, rrule.Expand(e, start, end)...)
		}
		sort.Slice(occurrences, func(i, j int) bool { return occurrences[i].Start < occurrences[j].Start })
		value, _ := json.Marshal(occurrences)
		ctx.Redis.Set("exp:"+calendarID+":0:"+strconv.FormatInt(start, 10)+":"+strconv.FormatInt(end, 10), string(value), "EX", 300)
		return occurrences, nil
	}
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func rdGet(c *harness.HTTP, path, tenant string) *harness.Response {
	if tenant == "" {
		return c.Get(path)
	}
	return c.Get(path, "X-Tenant-Id", tenant)
}

type rdBody struct {
	Error       string             \`json:"error"\`
	Occurrences []rrule.Occurrence \`json:"occurrences"\`
}

func rdDecode(r *harness.Response) rdBody {
	var body rdBody
	_ = json.Unmarshal(r.Body, &body)
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	c := rdClient(ctx)
	r := rdGet(c, "/v1/calendars/c1/events?"+rdWeek, "t1")
	ctx.Equal(r.Status, 200, "GET a week of the public calendar c1 (%s)", r.Text())
	occurrences := rdDecode(r).Occurrences
	ctx.Equal(len(occurrences), 7, "the week must answer the 7 daily standups; the occurrences")
	first, _ := rrule.ParseInstant("2026-03-02T09:00:00Z")
	ctx.Assert(occurrences[0].OccurrenceID == "e-1:"+strconv.FormatInt(first, 10) && occurrences[0].Start == "2026-03-02T09:00:00Z", "the first occurrence is %v", occurrences[0])
}

func CheckRangeCap(ctx *harness.Ctx) {
	c := rdClient(ctx)
	for _, tc := range [][2]string{
		{"from=2026-03-02T00:00:00Z&to=2026-06-30T00:00:00Z", "a 120-day window"},
		{"from=2026-03-02T00:00:00Z", "a window without to"},
		{"to=2026-03-09T00:00:00Z", "a window without from"},
	} {
		r := rdGet(c, "/v1/calendars/c1/events?"+tc[0], "t1")
		ctx.Assert(r.Status == 400 && rdDecode(r).Error == "invalid_window", "%s answered %d, expected 400 invalid_window: a read bounds what one request may expand", tc[1], r.Status)
	}
	r := rdGet(c, "/v1/calendars/c1/events?from=2026-03-02T00:00:00Z&to=2026-05-31T00:00:00Z", "t1")
	ctx.Equal(r.Status, 200, "a window of exactly 90 days")
}

func CheckUnknownCalendar(ctx *harness.Ctx) {
	c := rdClient(ctx)
	r := rdGet(c, "/v1/calendars/nope/events?"+rdWeek, "t1")
	ctx.Assert(r.Status == 404 && rdDecode(r).Error == "calendar_not_found", "an unknown calendar answered %d %s, expected 404 calendar_not_found: an empty week is a different answer", r.Status, r.Text())
	ctx.Equal(ctx.Redis.Keys("exp:nope*"), []string{}, "the slices an unknown calendar left in the cache")
}

func CheckPrivateCalendars(ctx *harness.Ctx) {
	c := rdClient(ctx)
	for _, tc := range [][2]string{{"t2", "a tenant outside the calendar"}, {"", "a request without X-Tenant-Id"}} {
		r := rdGet(c, "/v1/calendars/c2/events?"+rdWeek, tc[0])
		ctx.Assert(r.Status == 403 && rdDecode(r).Error == "not_a_member", "%s reading the private calendar c2 answered %d, expected 403 not_a_member", tc[1], r.Status)
	}
	r := rdGet(c, "/v1/calendars/c2/events?"+rdWeek, "t1")
	ctx.Assert(r.Status == 200 && len(rdDecode(r).Occurrences) == 7, "the member t1 reading c2 answered %d %s", r.Status, r.Text())
}

func CheckCacheControl(ctx *harness.Ctx) {
	c := rdClient(ctx)
	r := rdGet(c, "/v1/calendars/c2/events?"+rdWeek, "t1")
	ctx.Equal(r.Status, 200, "the member t1 reading the private calendar c2 (%s)", r.Text())
	cacheControl := r.Header.Get("Cache-Control")
	ctx.Assert(strings.Contains(cacheControl, "private") && !strings.Contains(cacheControl, "public"), "the private calendar answered Cache-Control %q: a shared cache may store it and hand it to the next caller without asking the service", cacheControl)
	r = rdGet(c, "/v1/calendars/c1/events?"+rdWeek, "t1")
	ctx.Assert(strings.Contains(r.Header.Get("Cache-Control"), "public"), "the public calendar answered Cache-Control %q, expected public, max-age=60", r.Header.Get("Cache-Control"))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

#include "state.cpp"

namespace {

const std::string kRdWeek = "from=2026-03-02T00:00:00Z&to=2026-03-09T00:00:00Z";

// c1 is public, c2 private, t1 a member of both, each with a 30-minute daily standup ten times from
// Monday 2 March 2026; the route runs over step 2's cache.
harness::HTTP rdClient(harness::Ctx& ctx) {
  calendard::store::PutCalendar("c1", "public", {"t1"});
  calendard::store::PutCalendar("c2", "private", {"t1"});
  calendard::store::PutEvent({"e-1", "c1", "t1", "Standup", "FREQ=DAILY;COUNT=10", "2026-03-02T09:00:00Z", "2026-03-02T09:30:00Z", 1, {"ana@example.com"}});
  calendard::store::PutEvent({"e-2", "c2", "t1", "Offsite planning", "FREQ=DAILY;COUNT=10", "2026-03-02T09:00:00Z", "2026-03-02T09:30:00Z", 1, {"ana@example.com"}});
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response rdGet(harness::HTTP& c, const std::string& path, const std::string& tenant = "t1") {
  if (tenant.empty()) return c.Get(path);
  return c.Get(path, "X-Tenant-Id", tenant);
}

nlohmann::json rdBody(const harness::Response& r) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() ? body : nlohmann::json::object();
}

size_t rdCount(const harness::Response& r) {
  const auto body = rdBody(r);
  return body.contains("occurrences") && body["occurrences"].is_array() ? body["occurrences"].size() : 0;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = rdClient(ctx);
  const auto r = rdGet(c, "/v1/calendars/c1/events?" + kRdWeek);
  ctx.Equal(r.Status, 200, "GET a week of the public calendar c1 (%s)", r.Text());
  ctx.Equal(rdCount(r), 7, "the week must answer the 7 daily standups; the occurrences");
  const auto first = rdBody(r)["occurrences"][0];
  const std::string expected_id = "e-1:" + std::to_string(calendard::rrule::ParseInstant("2026-03-02T09:00:00Z").value_or(0));
  ctx.Assert(first.value("occurrence_id", "") == expected_id && first.value("start", "") == "2026-03-02T09:00:00Z", "the first occurrence is %s", first.dump());
}

void CheckRangeCap(harness::Ctx& ctx) {
  auto c = rdClient(ctx);
  const std::vector<std::pair<std::string, std::string>> cases = {
      {"from=2026-03-02T00:00:00Z&to=2026-06-30T00:00:00Z", "a 120-day window"},
      {"from=2026-03-02T00:00:00Z", "a window without to"},
      {"to=2026-03-09T00:00:00Z", "a window without from"},
  };
  for (const auto& [query, what] : cases) {
    const auto r = rdGet(c, "/v1/calendars/c1/events?" + query);
    ctx.Assert(r.Status == 400 && rdBody(r).value("error", "") == "invalid_window",
               "%s answered %d, expected 400 invalid_window: a read bounds what one request may expand", what, r.Status);
  }
  const auto r = rdGet(c, "/v1/calendars/c1/events?from=2026-03-02T00:00:00Z&to=2026-05-31T00:00:00Z");
  ctx.Equal(r.Status, 200, "a window of exactly 90 days");
}

void CheckUnknownCalendar(harness::Ctx& ctx) {
  auto c = rdClient(ctx);
  const auto r = rdGet(c, "/v1/calendars/nope/events?" + kRdWeek);
  ctx.Assert(r.Status == 404 && rdBody(r).value("error", "") == "calendar_not_found",
             "an unknown calendar answered %d %s, expected 404 calendar_not_found: an empty week is a different answer", r.Status, r.Text());
  ctx.Equal(ctx.Redis.Keys("exp:nope*"), std::vector<std::string>{}, "the slices an unknown calendar left in the cache");
}

void CheckPrivateCalendars(harness::Ctx& ctx) {
  auto c = rdClient(ctx);
  const std::vector<std::pair<std::string, std::string>> cases = {{"t2", "a tenant outside the calendar"}, {"", "a request without X-Tenant-Id"}};
  for (const auto& [tenant, what] : cases) {
    const auto r = rdGet(c, "/v1/calendars/c2/events?" + kRdWeek, tenant);
    ctx.Assert(r.Status == 403 && rdBody(r).value("error", "") == "not_a_member",
               "%s reading the private calendar c2 answered %d, expected 403 not_a_member", what, r.Status);
  }
  const auto r = rdGet(c, "/v1/calendars/c2/events?" + kRdWeek, "t1");
  ctx.Assert(r.Status == 200 && rdCount(r) == 7, "the member t1 reading c2 answered %d %s", r.Status, r.Text());
}

void CheckCacheControl(harness::Ctx& ctx) {
  auto c = rdClient(ctx);
  auto r = rdGet(c, "/v1/calendars/c2/events?" + kRdWeek, "t1");
  ctx.Equal(r.Status, 200, "the member t1 reading the private calendar c2 (%s)", r.Text());
  const std::string cache_control = r.HeaderValue("Cache-Control");
  ctx.Assert(cache_control.find("private") != std::string::npos && cache_control.find("public") == std::string::npos,
             "the private calendar answered Cache-Control %q: a shared cache may store it and hand it to the next caller without asking the service",
             cache_control);
  r = rdGet(c, "/v1/calendars/c1/events?" + kRdWeek);
  ctx.Assert(r.HeaderValue("Cache-Control").find("public") != std::string::npos, "the public calendar answered Cache-Control %q, expected public, max-age=60",
             r.HeaderValue("Cache-Control"));
}
`,
  },
  hints: [
    'A client asking for ten years waits a minute for a megabyte, a typo in a calendar id shows an empty week, someone outside a team reads its private calendar, and a proxy serves one member’s private week to the next caller.',
    'The starter never looks the calendar up, so nothing separates unknown from empty or private from public; it fills and stretches the window instead of refusing it; `public` lets every shared cache on the way keep the answer.',
    'Look the calendar up first: `None` is 404 `calendar_not_found`, `private` without `store.is_member` is 403 `not_a_member`; require `from` and `to`, `to > from`, at most 90 days apart; send `private, max-age=60` for a private calendar.',
  ],
  debrief: `The read refuses in order of cost: an unknown calendar and a stranger are answered before anything is expanded, so neither costs an expansion or leaves a slice behind. The window cap is the read side of step 1's termination rule, since a rule can end and still produce more occurrences than one request should carry. \`Cache-Control\` is part of the authorization: a \`public\` answer may be stored by any shared cache between the service and the client, and the next request through that cache never reaches the membership check. Production calendar APIs page their results and hand out sync tokens, so a client asks for what changed since its last read instead of re-reading windows.`,
};
