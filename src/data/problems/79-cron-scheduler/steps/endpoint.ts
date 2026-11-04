import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/schedules: a schedule that fires where its owners live',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/schedules\` with body
\`{"cron", "timezone", "job_ref", "misfire_policy"}\`: it reads the tenant from \`X-Tenant-Id\` (**401**
when missing), parses the expression with \`parse\` (**400** \`invalid_cron\`), requires a \`job_ref\`,
computes \`next_fire\`, stores the schedule with \`store.put\` and answers **201** with it. It serves the
demo and hides 4 flaws.

**Failure mode the checks target.** A zone nobody can resolve, a health check that fires every
minute, a schedule that never said what a missed window owes, and a 09:00 report created by a team in
Berlin.

- \`timezone\` must be a zone \`cronsched/cron\` knows (\`zone_known\`), else **400** \`unknown_timezone\`.
- An expression whose shortest gap between fires (\`shortest_gap_s\`) is under \`MIN_INTERVAL_S\` (five
  minutes) is **400** \`too_frequent\`.
- \`misfire_policy\` is required and one of \`MISFIRE_POLICIES\` (\`skip\`, \`fire_once_now\`, \`catch_up\`),
  else **400** \`invalid_misfire_policy\`.
- \`next_fire\` is the next fire on the schedule's own wall clock: \`next_fire(spec, timezone, now)\`.
- A rejected request stores nothing.`,
  sequence: {
    participants: ['Client', 'Scheduler API', 'Redis'],
    messages: [
      {from: 'Client', to: 'Scheduler API', label: 'POST /v1/schedules · X-Tenant-Id', kind: 'sync'},
      {
        from: 'Scheduler API',
        to: 'Scheduler API',
        label: 'parse · shortest gap ≥ 300 s · zone known · policy named',
        kind: 'sync',
      },
      {from: 'Scheduler API', to: 'Scheduler API', label: 'next_fire(spec, timezone, now)', kind: 'sync'},
      {from: 'Scheduler API', to: 'Redis', label: 'HSET schedule:{id}', kind: 'sync'},
      {
        from: 'Scheduler API',
        to: 'Client',
        label: '201 {id, …, next_fire} · 400 with the rule it broke',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/schedules',
      detail:
        'A valid schedule answers 201 with its `id` and is stored under `schedule:{id}` with the tenant; a request without `X-Tenant-Id` is 401.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/schedules["']/, /store\.put\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/schedules['"]/, /store\.put\(/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/schedules"/, /store\.Put\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"schedules"\s*\)/, /\bpost\s*\{/, /Store\.put\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/schedules"/, /store::Put\(/]},
      },
    },
    {
      id: 'timezone',
      title: 'Rejects a zone the scheduler cannot resolve',
      detail:
        '`Mars/Olympus` is **400** `unknown_timezone` and nothing is stored; `Asia/Kolkata` is accepted and echoed. The starter stores any string.',
      match: {
        python: {all: [/unknown_timezone/, /zone_known\(/]},
        typescript: {all: [/unknown_timezone/, /zoneKnown\(/]},
        go: {all: [/unknown_timezone/, /cron\.Known\(/]},
        scala: {all: [/unknown_timezone/, /Cron\.zoneKnown\(/]},
        cpp: {all: [/unknown_timezone/, /cron::Known\(/]},
      },
    },
    {
      id: 'frequency',
      title: 'Rejects a cadence under five minutes',
      detail:
        '`* * * * *`, `*/2 * * * *` and `0,1 9 * * *` are **400** `too_frequent`; `*/5 * * * *` is accepted. The starter accepts any expression that parses.',
      match: {
        python: {all: [/too_frequent/, /shortest_gap_s\(/, /MIN_INTERVAL_S/]},
        typescript: {all: [/too_frequent/, /shortestGapS\(/, /MIN_INTERVAL_S/]},
        go: {all: [/too_frequent/, /cron\.ShortestGapS\(/, /cron\.MinIntervalS/]},
        scala: {all: [/too_frequent/, /Cron\.shortestGapS\(/, /Cron\.MinIntervalS/]},
        cpp: {all: [/too_frequent/, /cron::ShortestGapS\(/, /cron::kMinIntervalS/]},
      },
    },
    {
      id: 'misfire-policy',
      title: 'Requires a known misfire policy',
      detail:
        'A missing policy and `retry_forever` are **400** `invalid_misfire_policy`; each of `skip`, `fire_once_now`, `catch_up` is stored as given. The starter defaults a missing policy to `catch_up`.',
      match: {
        python: {all: [/invalid_misfire_policy/, /MISFIRE_POLICIES/], none: [/misfire_policy:\s*str\s*=\s*["']/]},
        typescript: {all: [/invalid_misfire_policy/, /MISFIRE_POLICIES/], none: [/misfire_policy\s*\?\?\s*['"]/]},
        go: {
          all: [/invalid_misfire_policy/, /cron\.MisfirePolicies/],
          none: [/MisfirePolicy\s*=\s*"(skip|fire_once_now|catch_up)"/],
        },
        scala: {
          all: [/invalid_misfire_policy/, /Cron\.MisfirePolicies/],
          none: [/misfire_policy\.getOrElse\(\s*"(skip|fire_once_now|catch_up)"/],
        },
        cpp: {
          all: [/invalid_misfire_policy/, /cron::kMisfirePolicies/],
          none: [/value\(\s*"misfire_policy"\s*,\s*"(skip|fire_once_now|catch_up)"/],
        },
      },
    },
    {
      id: 'next-fire',
      title: "Computes next_fire on the schedule's wall clock",
      detail:
        '`0 9 * * *` in Europe/Berlin, Asia/Kolkata and America/New_York answers the next 09:00 of that zone, in the response and in the store. The starter evaluates every expression in UTC.',
      match: {
        python: {all: [/next_fire\(\s*spec\s*,/], none: [/next_fire\(\s*spec\s*,\s*["']UTC["']/]},
        typescript: {all: [/nextFire\(\s*spec\s*,/], none: [/nextFire\(\s*spec\s*,\s*['"]UTC['"]/]},
        go: {all: [/cron\.NextFire\(\s*spec\s*,/], none: [/cron\.NextFire\(\s*spec\s*,\s*"UTC"/]},
        scala: {all: [/Cron\.nextFire\(\s*spec\s*,/], none: [/Cron\.nextFire\(\s*spec\s*,\s*"UTC"/]},
        cpp: {all: [/cron::NextFire\(\s*\*spec\s*,/], none: [/cron::NextFire\(\s*\*spec\s*,\s*"UTC"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from cronsched.cron import format_instant, next_fire, parse
from cronsched.store import new_id, store

app = FastAPI()
log = logging.getLogger("cronsched")


class ScheduleRequest(BaseModel):
    cron: str = ""
    timezone: str = "UTC"
    job_ref: str = ""
    misfire_policy: str = "catch_up"


@app.post("/v1/schedules")
def create_schedule(body: ScheduleRequest, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id")
    if not tenant:
        return JSONResponse({"error": "missing_tenant"}, status_code=401)
    spec = parse(body.cron)
    if spec is None:
        return JSONResponse({"error": "invalid_cron"}, status_code=400)
    if not body.job_ref:
        return JSONResponse({"error": "invalid_job_ref"}, status_code=400)
    fire = next_fire(spec, "UTC", int(time.time()))
    if fire is None:
        return JSONResponse({"error": "invalid_cron"}, status_code=400)
    schedule = {
        "id": new_id(),
        "tenant": tenant,
        "cron": body.cron,
        "timezone": body.timezone,
        "job_ref": body.job_ref,
        "misfire_policy": body.misfire_policy,
        "next_fire": format_instant(fire),
    }
    store.put(schedule)
    log.info("schedule=%s tenant=%s cron=%r", schedule["id"], tenant, body.cron)
    return JSONResponse(schedule, status_code=201)
`,
      solution: `import logging
import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from cronsched.cron import MIN_INTERVAL_S, MISFIRE_POLICIES, format_instant, next_fire, parse, shortest_gap_s, zone_known
from cronsched.store import new_id, store

app = FastAPI()
log = logging.getLogger("cronsched")


class ScheduleRequest(BaseModel):
    cron: str = ""
    timezone: str = "UTC"
    job_ref: str = ""
    misfire_policy: str | None = None


@app.post("/v1/schedules")
def create_schedule(body: ScheduleRequest, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id")
    if not tenant:
        return JSONResponse({"error": "missing_tenant"}, status_code=401)
    spec = parse(body.cron)
    if spec is None:
        return JSONResponse({"error": "invalid_cron"}, status_code=400)
    # A cadence is a load the job service carries for as long as the schedule lives.
    if shortest_gap_s(spec) < MIN_INTERVAL_S:
        return JSONResponse({"error": "too_frequent"}, status_code=400)
    if not zone_known(body.timezone):
        return JSONResponse({"error": "unknown_timezone"}, status_code=400)
    if not body.job_ref:
        return JSONResponse({"error": "invalid_job_ref"}, status_code=400)
    # What a missed window owes depends on the job: only its owner can say, so there is no default.
    if body.misfire_policy not in MISFIRE_POLICIES:
        return JSONResponse({"error": "invalid_misfire_policy"}, status_code=400)
    fire = next_fire(spec, body.timezone, int(time.time()))
    if fire is None:
        return JSONResponse({"error": "invalid_cron"}, status_code=400)
    schedule = {
        "id": new_id(),
        "tenant": tenant,
        "cron": body.cron,
        "timezone": body.timezone,
        "job_ref": body.job_ref,
        "misfire_policy": body.misfire_policy,
        "next_fire": format_instant(fire),
    }
    store.put(schedule)
    log.info("schedule=%s tenant=%s cron=%r", schedule["id"], tenant, body.cron)
    return JSONResponse(schedule, status_code=201)
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {formatInstant, nextFire, parse} from 'cronsched/cron';
import {type Schedule, newId, store} from 'cronsched/store';

export const app = Fastify();

interface ScheduleBody {
  cron?: string;
  timezone?: string;
  job_ref?: string;
  misfire_policy?: string;
}

app.post('/v1/schedules', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing_tenant'});
  const body = (request.body ?? {}) as ScheduleBody;
  const spec = parse(body.cron ?? '');
  if (spec === null) return reply.code(400).send({error: 'invalid_cron'});
  if (!body.job_ref) return reply.code(400).send({error: 'invalid_job_ref'});
  const fire = nextFire(spec, 'UTC', Math.floor(Date.now() / 1000));
  if (fire === null) return reply.code(400).send({error: 'invalid_cron'});
  const schedule: Schedule = {
    id: newId(),
    tenant,
    cron: body.cron ?? '',
    timezone: body.timezone ?? 'UTC',
    job_ref: body.job_ref,
    misfire_policy: body.misfire_policy ?? 'catch_up',
    next_fire: formatInstant(fire),
  };
  await store.put(schedule);
  app.log.info({schedule: schedule.id, tenant, cron: schedule.cron}, 'schedule created');
  return reply.code(201).send(schedule);
});
`,
      solution: `import Fastify from 'fastify';

import {MIN_INTERVAL_S, MISFIRE_POLICIES, formatInstant, nextFire, parse, shortestGapS, zoneKnown} from 'cronsched/cron';
import {type Schedule, newId, store} from 'cronsched/store';

export const app = Fastify();

interface ScheduleBody {
  cron?: string;
  timezone?: string;
  job_ref?: string;
  misfire_policy?: string;
}

app.post('/v1/schedules', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing_tenant'});
  const body = (request.body ?? {}) as ScheduleBody;
  const spec = parse(body.cron ?? '');
  if (spec === null) return reply.code(400).send({error: 'invalid_cron'});
  // A cadence is a load the job service carries for as long as the schedule lives.
  if (shortestGapS(spec) < MIN_INTERVAL_S) return reply.code(400).send({error: 'too_frequent'});
  const timezone = body.timezone ?? 'UTC';
  if (!zoneKnown(timezone)) return reply.code(400).send({error: 'unknown_timezone'});
  if (!body.job_ref) return reply.code(400).send({error: 'invalid_job_ref'});
  // What a missed window owes depends on the job: only its owner can say, so there is no default.
  const policy = body.misfire_policy;
  if (policy === undefined || !MISFIRE_POLICIES.includes(policy)) return reply.code(400).send({error: 'invalid_misfire_policy'});
  const fire = nextFire(spec, timezone, Math.floor(Date.now() / 1000));
  if (fire === null) return reply.code(400).send({error: 'invalid_cron'});
  const schedule: Schedule = {
    id: newId(),
    tenant,
    cron: body.cron ?? '',
    timezone,
    job_ref: body.job_ref,
    misfire_policy: policy,
    next_fire: formatInstant(fire),
  };
  await store.put(schedule);
  app.log.info({schedule: schedule.id, tenant, cron: schedule.cron}, 'schedule created');
  return reply.code(201).send(schedule);
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"cronsched/cron"
	"cronsched/store"
)

type ScheduleRequest struct {
	Cron          string \`json:"cron"\`
	Timezone      string \`json:"timezone"\`
	JobRef        string \`json:"job_ref"\`
	MisfirePolicy string \`json:"misfire_policy"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func fail(rw http.ResponseWriter, status int, code string) {
	writeJSON(rw, status, map[string]string{"error": code})
}

func createSchedule(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		fail(rw, http.StatusUnauthorized, "missing_tenant")
		return
	}
	var body ScheduleRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(rw, http.StatusBadRequest, "invalid_json")
		return
	}
	spec, ok := cron.Parse(body.Cron)
	if !ok {
		fail(rw, http.StatusBadRequest, "invalid_cron")
		return
	}
	if body.JobRef == "" {
		fail(rw, http.StatusBadRequest, "invalid_job_ref")
		return
	}
	if body.Timezone == "" {
		body.Timezone = "UTC"
	}
	if body.MisfirePolicy == "" {
		body.MisfirePolicy = "catch_up"
	}
	fire, ok := cron.NextFire(spec, "UTC", time.Now().Unix())
	if !ok {
		fail(rw, http.StatusBadRequest, "invalid_cron")
		return
	}
	s := &store.Schedule{
		ID: store.NewID(), Tenant: tenant, Cron: body.Cron, Timezone: body.Timezone, JobRef: body.JobRef,
		MisfirePolicy: body.MisfirePolicy, NextFire: cron.FormatInstant(fire),
	}
	if err := store.Put(r.Context(), s); err != nil {
		fail(rw, http.StatusServiceUnavailable, "try_again")
		return
	}
	log.Printf("schedule=%s tenant=%s cron=%q", s.ID, tenant, body.Cron)
	writeJSON(rw, http.StatusCreated, s)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/schedules", createSchedule)
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"cronsched/cron"
	"cronsched/store"
)

type ScheduleRequest struct {
	Cron          string \`json:"cron"\`
	Timezone      string \`json:"timezone"\`
	JobRef        string \`json:"job_ref"\`
	MisfirePolicy string \`json:"misfire_policy"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func fail(rw http.ResponseWriter, status int, code string) {
	writeJSON(rw, status, map[string]string{"error": code})
}

func createSchedule(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		fail(rw, http.StatusUnauthorized, "missing_tenant")
		return
	}
	var body ScheduleRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		fail(rw, http.StatusBadRequest, "invalid_json")
		return
	}
	spec, ok := cron.Parse(body.Cron)
	if !ok {
		fail(rw, http.StatusBadRequest, "invalid_cron")
		return
	}
	// A cadence is a load the job service carries for as long as the schedule lives.
	if cron.ShortestGapS(spec) < cron.MinIntervalS {
		fail(rw, http.StatusBadRequest, "too_frequent")
		return
	}
	if body.Timezone == "" {
		body.Timezone = "UTC"
	}
	if !cron.Known(body.Timezone) {
		fail(rw, http.StatusBadRequest, "unknown_timezone")
		return
	}
	if body.JobRef == "" {
		fail(rw, http.StatusBadRequest, "invalid_job_ref")
		return
	}
	// What a missed window owes depends on the job: only its owner can say, so there is no default.
	if !cron.MisfirePolicies[body.MisfirePolicy] {
		fail(rw, http.StatusBadRequest, "invalid_misfire_policy")
		return
	}
	fire, ok := cron.NextFire(spec, body.Timezone, time.Now().Unix())
	if !ok {
		fail(rw, http.StatusBadRequest, "invalid_cron")
		return
	}
	s := &store.Schedule{
		ID: store.NewID(), Tenant: tenant, Cron: body.Cron, Timezone: body.Timezone, JobRef: body.JobRef,
		MisfirePolicy: body.MisfirePolicy, NextFire: cron.FormatInstant(fire),
	}
	if err := store.Put(r.Context(), s); err != nil {
		fail(rw, http.StatusServiceUnavailable, "try_again")
		return
	}
	log.Printf("schedule=%s tenant=%s cron=%q", s.ID, tenant, body.Cron)
	writeJSON(rw, http.StatusCreated, s)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/schedules", createSchedule)
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

import cronsched.{Cron, Schedule, Store}

final case class ScheduleRequest(cron: Option[String], timezone: Option[String], job_ref: Option[String], misfire_policy: Option[String])

object ScheduleApi {
  implicit val system: ActorSystem = ActorSystem("cronsched")
  implicit val requestFormat: RootJsonFormat[ScheduleRequest] = jsonFormat4(ScheduleRequest)

  private def error(status: StatusCode, code: String): Route =
    complete(status, HttpEntity(ContentTypes.\`application/json\`, s"""{"error":"$code"}"""))

  val route: Route =
    path("v1" / "schedules") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[ScheduleRequest]) { body =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            val tenant = tenantOpt.getOrElse("")
            val jobRef = body.job_ref.getOrElse("")
            if (tenant.isEmpty) error(StatusCodes.Unauthorized, "missing_tenant")
            else
              Cron.parse(body.cron.getOrElse("")) match {
                case None => error(StatusCodes.BadRequest, "invalid_cron")
                case Some(_) if jobRef.isEmpty => error(StatusCodes.BadRequest, "invalid_job_ref")
                case Some(spec) =>
                  Cron.nextFire(spec, "UTC", Instant.now().getEpochSecond) match {
                    case None => error(StatusCodes.BadRequest, "invalid_cron")
                    case Some(fire) =>
                      val schedule = Schedule(
                        Store.newId(),
                        tenant,
                        body.cron.getOrElse(""),
                        body.timezone.getOrElse("UTC"),
                        jobRef,
                        body.misfire_policy.getOrElse("catch_up"),
                        Cron.formatInstant(fire)
                      )
                      Store.put(schedule)
                      system.log.info(s"schedule=\${schedule.id} tenant=$tenant cron=\${schedule.cron}")
                      complete(StatusCodes.Created, schedule)
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
      solution: `import java.time.Instant

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

import cronsched.{Cron, Schedule, Store}

final case class ScheduleRequest(cron: Option[String], timezone: Option[String], job_ref: Option[String], misfire_policy: Option[String])

object ScheduleApi {
  implicit val system: ActorSystem = ActorSystem("cronsched")
  implicit val requestFormat: RootJsonFormat[ScheduleRequest] = jsonFormat4(ScheduleRequest)

  private def error(status: StatusCode, code: String): Route =
    complete(status, HttpEntity(ContentTypes.\`application/json\`, s"""{"error":"$code"}"""))

  val route: Route =
    path("v1" / "schedules") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[ScheduleRequest]) { body =>
            val tenant = tenantOpt.getOrElse("")
            val timezone = body.timezone.getOrElse("UTC")
            val jobRef = body.job_ref.getOrElse("")
            val policy = body.misfire_policy.getOrElse("")
            if (tenant.isEmpty) error(StatusCodes.Unauthorized, "missing_tenant")
            else
              Cron.parse(body.cron.getOrElse("")) match {
                case None => error(StatusCodes.BadRequest, "invalid_cron")
                // A cadence is a load the job service carries for as long as the schedule lives.
                case Some(spec) if Cron.shortestGapS(spec) < Cron.MinIntervalS => error(StatusCodes.BadRequest, "too_frequent")
                case Some(_) if !Cron.zoneKnown(timezone) => error(StatusCodes.BadRequest, "unknown_timezone")
                case Some(_) if jobRef.isEmpty => error(StatusCodes.BadRequest, "invalid_job_ref")
                // What a missed window owes depends on the job: only its owner can say, so there is no default.
                case Some(_) if !Cron.MisfirePolicies.contains(policy) => error(StatusCodes.BadRequest, "invalid_misfire_policy")
                case Some(spec) =>
                  Cron.nextFire(spec, timezone, Instant.now().getEpochSecond) match {
                    case None => error(StatusCodes.BadRequest, "invalid_cron")
                    case Some(fire) =>
                      val schedule =
                        Schedule(Store.newId(), tenant, body.cron.getOrElse(""), timezone, jobRef, policy, Cron.formatInstant(fire))
                      Store.put(schedule)
                      system.log.info(s"schedule=\${schedule.id} tenant=$tenant cron=\${schedule.cron}")
                      complete(StatusCodes.Created, schedule)
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
#include <iostream>
#include <string>

#include "cronsched/cron.h"
#include "cronsched/store.h"

using json = nlohmann::json;

static void fail(httplib::Response& res, int status, const std::string& code) {
  res.status = status;
  res.set_content(json{{"error", code}}.dump(), "application/json");
}

void createSchedule(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "missing_tenant");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return fail(res, 400, "invalid_json");
  const std::string cron_text = body.value("cron", "");
  const std::string timezone = body.value("timezone", "UTC");
  const std::string job_ref = body.value("job_ref", "");
  const std::string policy = body.value("misfire_policy", "catch_up");
  const auto spec = cronsched::cron::Parse(cron_text);
  if (!spec) return fail(res, 400, "invalid_cron");
  if (job_ref.empty()) return fail(res, 400, "invalid_job_ref");
  const int64_t now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const auto fire = cronsched::cron::NextFire(*spec, "UTC", now);
  if (!fire) return fail(res, 400, "invalid_cron");
  const cronsched::Schedule s{cronsched::NewId(), tenant, cron_text, timezone, job_ref, policy, cronsched::cron::FormatInstant(*fire)};
  cronsched::store::Put(s);
  std::clog << "schedule=" << s.id << " tenant=" << tenant << " cron=" << cron_text << "\\n";
  res.status = 201;
  res.set_content(json(s).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/schedules", createSchedule);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <iostream>
#include <string>

#include "cronsched/cron.h"
#include "cronsched/store.h"

using json = nlohmann::json;

static void fail(httplib::Response& res, int status, const std::string& code) {
  res.status = status;
  res.set_content(json{{"error", code}}.dump(), "application/json");
}

void createSchedule(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "missing_tenant");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return fail(res, 400, "invalid_json");
  const std::string cron_text = body.value("cron", "");
  const std::string timezone = body.value("timezone", "UTC");
  const std::string job_ref = body.value("job_ref", "");
  const std::string policy = body.value("misfire_policy", "");
  const auto spec = cronsched::cron::Parse(cron_text);
  if (!spec) return fail(res, 400, "invalid_cron");
  // A cadence is a load the job service carries for as long as the schedule lives.
  if (cronsched::cron::ShortestGapS(*spec) < cronsched::cron::kMinIntervalS) return fail(res, 400, "too_frequent");
  if (!cronsched::cron::Known(timezone)) return fail(res, 400, "unknown_timezone");
  if (job_ref.empty()) return fail(res, 400, "invalid_job_ref");
  // What a missed window owes depends on the job: only its owner can say, so there is no default.
  if (cronsched::cron::kMisfirePolicies.count(policy) == 0) return fail(res, 400, "invalid_misfire_policy");
  const int64_t now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const auto fire = cronsched::cron::NextFire(*spec, timezone, now);
  if (!fire) return fail(res, 400, "invalid_cron");
  const cronsched::Schedule s{cronsched::NewId(), tenant, cron_text, timezone, job_ref, policy, cronsched::cron::FormatInstant(*fire)};
  cronsched::store::Put(s);
  std::clog << "schedule=" << s.id << " tenant=" << tenant << " cron=" << cron_text << "\\n";
  res.status = 201;
  res.set_content(json(s).dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/schedules", createSchedule);
}
`,
    },
  },
  harness: {
    python: `import time

from cronsched.cron import format_instant, next_fire, parse
from cronsched.store import store

H = {"X-Tenant-Id": "t1"}
ZONES = ("Europe/Berlin", "Asia/Kolkata", "America/New_York")


def _body(**overrides):
    body = {"cron": "*/15 * * * *", "timezone": "Europe/Berlin", "job_ref": "billing.invoice", "misfire_policy": "skip"}
    body.update(overrides)
    return body


async def _post(ctx, body, headers=H):
    m = ctx.load("api")
    async with ctx.client(m.app) as c:
        return await c.post("/v1/schedules", json=body, headers=headers)


def _error(r):
    try:
        return r.json().get("error")
    except ValueError:
        return None


def _nothing_stored(ctx, what):
    keys = sorted(ctx.redis.keys("schedule:*"))
    assert keys == [], f"{what} must store nothing, Redis holds {keys}"


async def check_route(ctx):
    r = await _post(ctx, _body())
    assert r.status_code == 201, f"POST /v1/schedules with a valid body answered {r.status_code}: {r.text}"
    schedule = r.json()
    assert schedule.get("id"), f"the answer must carry the schedule's id: {schedule}"
    stored = store.get(schedule["id"])
    assert stored is not None, f"nothing is stored under schedule:{schedule['id']}"
    assert stored.get("tenant") == "t1" and stored.get("cron") == "*/15 * * * *" and stored.get("job_ref") == "billing.invoice", f"the stored schedule is {stored}, expected tenant t1 with the request's cron and job_ref"
    r = await _post(ctx, _body(), headers={})
    assert r.status_code == 401, f"a request without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_timezone(ctx):
    r = await _post(ctx, _body(timezone="Mars/Olympus"))
    assert r.status_code == 400 and _error(r) == "unknown_timezone", f"timezone Mars/Olympus answered {r.status_code} {r.text}, expected 400 unknown_timezone: a zone the scheduler cannot resolve fires on some other clock"
    _nothing_stored(ctx, "a schedule in an unknown zone")
    r = await _post(ctx, _body(timezone="Asia/Kolkata"))
    assert r.status_code == 201 and r.json().get("timezone") == "Asia/Kolkata", f"timezone Asia/Kolkata answered {r.status_code} {r.text}, expected 201 with the zone echoed"


async def check_frequency(ctx):
    for expr in ("* * * * *", "*/2 * * * *", "0,1 9 * * *"):
        r = await _post(ctx, _body(cron=expr))
        assert r.status_code == 400 and _error(r) == "too_frequent", f"cron {expr!r} answered {r.status_code} {r.text}, expected 400 too_frequent: its fires are less than five minutes apart"
    _nothing_stored(ctx, "a schedule that fires too often")
    r = await _post(ctx, _body(cron="*/5 * * * *"))
    assert r.status_code == 201, f"cron '*/5 * * * *' (every five minutes) answered {r.status_code} {r.text}, expected 201"


async def check_misfire_policy(ctx):
    body = _body()
    del body["misfire_policy"]
    r = await _post(ctx, body)
    assert r.status_code == 400 and _error(r) == "invalid_misfire_policy", f"a schedule without misfire_policy answered {r.status_code} {r.text}, expected 400 invalid_misfire_policy: a default decides for the job's owner what a pause costs"
    r = await _post(ctx, _body(misfire_policy="retry_forever"))
    assert r.status_code == 400 and _error(r) == "invalid_misfire_policy", f"misfire_policy retry_forever answered {r.status_code} {r.text}, expected 400 invalid_misfire_policy"
    _nothing_stored(ctx, "a schedule without a known misfire policy")
    for policy in ("skip", "fire_once_now", "catch_up"):
        r = await _post(ctx, _body(misfire_policy=policy))
        assert r.status_code == 201, f"misfire_policy {policy} answered {r.status_code} {r.text}, expected 201"
        stored = store.get(r.json()["id"]) or {}
        assert stored.get("misfire_policy") == policy, f"the stored schedule's misfire_policy is {stored.get('misfire_policy')!r}, expected {policy}"


async def check_next_fire(ctx):
    now = int(time.time())
    spec = parse("0 9 * * *")
    for zone in ZONES:
        r = await _post(ctx, _body(cron="0 9 * * *", timezone=zone))
        assert r.status_code == 201, f"cron '0 9 * * *' in {zone} answered {r.status_code} {r.text}"
        expected = format_instant(next_fire(spec, zone, now))
        got = r.json().get("next_fire")
        on_utc = " (that is 09:00 UTC: the expression ran on the server's clock)" if got == format_instant(next_fire(spec, "UTC", now)) else ""
        assert got == expected, f"cron '0 9 * * *' in {zone} answered next_fire {got}, expected {expected}, the next 09:00 on the {zone} wall clock{on_utc}"
        stored = store.get(r.json()["id"]) or {}
        assert stored.get("next_fire") == expected, f"the stored next_fire is {stored.get('next_fire')!r}, expected {expected}"
`,
    typescript: `import {formatInstant, nextFire, parse} from 'cronsched/cron';
import {store} from 'cronsched/store';

const H = {'X-Tenant-Id': 't1'};
const ZONES = ['Europe/Berlin', 'Asia/Kolkata', 'America/New_York'];

const body = (overrides: Record<string, string> = {}): Record<string, string> => ({
  cron: '*/15 * * * *',
  timezone: 'Europe/Berlin',
  job_ref: 'billing.invoice',
  misfire_policy: 'skip',
  ...overrides,
});

const api = ctx => ctx.client(ctx.load('api').app);

const errorOf = (r): string | undefined => {
  try {
    return r.json().error;
  } catch {
    return undefined;
  }
};

const nothingStored = (ctx, what: string) => {
  const keys = ctx.redis.keys('schedule:*');
  assert.equal(keys.length, 0, \`\${what} must store nothing, Redis holds \${JSON.stringify(keys.sort())}\`);
};

export async function check_route(ctx) {
  const c = api(ctx);
  let r = await c.post('/v1/schedules', {json: body(), headers: H});
  assert.equal(r.status, 201, \`POST /v1/schedules with a valid body answered \${r.status}: \${r.text}\`);
  const schedule = r.json();
  assert(schedule.id, \`the answer must carry the schedule's id: \${r.text}\`);
  const stored = await store.get(schedule.id);
  assert(stored !== null, \`nothing is stored under schedule:\${schedule.id}\`);
  assert(stored.tenant === 't1' && stored.cron === '*/15 * * * *' && stored.job_ref === 'billing.invoice', \`the stored schedule is \${JSON.stringify(stored)}, expected tenant t1 with the request's cron and job_ref\`);
  r = await c.post('/v1/schedules', {json: body()});
  assert.equal(r.status, 401, \`a request without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_timezone(ctx) {
  const c = api(ctx);
  let r = await c.post('/v1/schedules', {json: body({timezone: 'Mars/Olympus'}), headers: H});
  assert(r.status === 400 && errorOf(r) === 'unknown_timezone', \`timezone Mars/Olympus answered \${r.status} \${r.text}, expected 400 unknown_timezone: a zone the scheduler cannot resolve fires on some other clock\`);
  nothingStored(ctx, 'a schedule in an unknown zone');
  r = await c.post('/v1/schedules', {json: body({timezone: 'Asia/Kolkata'}), headers: H});
  assert(r.status === 201 && r.json().timezone === 'Asia/Kolkata', \`timezone Asia/Kolkata answered \${r.status} \${r.text}, expected 201 with the zone echoed\`);
}

export async function check_frequency(ctx) {
  const c = api(ctx);
  for (const expr of ['* * * * *', '*/2 * * * *', '0,1 9 * * *']) {
    const r = await c.post('/v1/schedules', {json: body({cron: expr}), headers: H});
    assert(r.status === 400 && errorOf(r) === 'too_frequent', \`cron '\${expr}' answered \${r.status} \${r.text}, expected 400 too_frequent: its fires are less than five minutes apart\`);
  }
  nothingStored(ctx, 'a schedule that fires too often');
  const r = await c.post('/v1/schedules', {json: body({cron: '*/5 * * * *'}), headers: H});
  assert.equal(r.status, 201, \`cron '*/5 * * * *' (every five minutes) answered \${r.status} \${r.text}, expected 201\`);
}

export async function check_misfire_policy(ctx) {
  const c = api(ctx);
  const {misfire_policy: _dropped, ...withoutPolicy} = body();
  let r = await c.post('/v1/schedules', {json: withoutPolicy, headers: H});
  assert(r.status === 400 && errorOf(r) === 'invalid_misfire_policy', \`a schedule without misfire_policy answered \${r.status} \${r.text}, expected 400 invalid_misfire_policy: a default decides for the job's owner what a pause costs\`);
  r = await c.post('/v1/schedules', {json: body({misfire_policy: 'retry_forever'}), headers: H});
  assert(r.status === 400 && errorOf(r) === 'invalid_misfire_policy', \`misfire_policy retry_forever answered \${r.status} \${r.text}, expected 400 invalid_misfire_policy\`);
  nothingStored(ctx, 'a schedule without a known misfire policy');
  for (const policy of ['skip', 'fire_once_now', 'catch_up']) {
    r = await c.post('/v1/schedules', {json: body({misfire_policy: policy}), headers: H});
    assert.equal(r.status, 201, \`misfire_policy \${policy} answered \${r.status} \${r.text}, expected 201\`);
    const stored = await store.get(r.json().id);
    assert.equal(stored?.misfire_policy, policy, \`the stored schedule's misfire_policy is \${JSON.stringify(stored?.misfire_policy)}, expected \${policy}\`);
  }
}

export async function check_next_fire(ctx) {
  const c = api(ctx);
  const now = Math.floor(Date.now() / 1000);
  const spec = parse('0 9 * * *');
  for (const zone of ZONES) {
    const r = await c.post('/v1/schedules', {json: body({cron: '0 9 * * *', timezone: zone}), headers: H});
    assert.equal(r.status, 201, \`cron '0 9 * * *' in \${zone} answered \${r.status} \${r.text}\`);
    const expected = formatInstant(nextFire(spec, zone, now));
    const got = r.json().next_fire;
    const onUtc = got === formatInstant(nextFire(spec, 'UTC', now)) ? " (that is 09:00 UTC: the expression ran on the server's clock)" : '';
    assert.equal(got, expected, \`cron '0 9 * * *' in \${zone} answered next_fire \${got}, expected \${expected}, the next 09:00 on the \${zone} wall clock\${onUtc}\`);
    const stored = await store.get(r.json().id);
    assert.equal(stored?.next_fire, expected, \`the stored next_fire is \${JSON.stringify(stored?.next_fire)}, expected \${expected}\`);
  }
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"leetbuild/harness"

	"cronsched/cron"
	"cronsched/store"
)

var apiZones = []string{"Europe/Berlin", "Asia/Kolkata", "America/New_York"}

func apiBody(overrides ...string) map[string]string {
	body := map[string]string{"cron": "*/15 * * * *", "timezone": "Europe/Berlin", "job_ref": "billing.invoice", "misfire_policy": "skip"}
	for i := 0; i+1 < len(overrides); i += 2 {
		body[overrides[i]] = overrides[i+1]
	}
	return body
}

func apiClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func apiPost(c *harness.HTTP, body any, header ...string) *harness.Response {
	if len(header) == 0 {
		header = []string{"X-Tenant-Id", "t1"}
	}
	return c.Post("/v1/schedules", body, header...)
}

// apiField is a string field of the JSON body ("" when absent).
func apiField(r *harness.Response, field string) string {
	var body map[string]any
	if err := json.Unmarshal(r.Body, &body); err != nil {
		return ""
	}
	s, _ := body[field].(string)
	return s
}

func apiStored(ctx *harness.Ctx, r *harness.Response) store.Schedule {
	s, err := store.Get(context.Background(), apiField(r, "id"))
	ctx.NoError(err, "reading the stored schedule")
	if s == nil {
		return store.Schedule{}
	}
	return *s
}

func apiNothingStored(ctx *harness.Ctx, what string) {
	keys := ctx.Redis.Keys("schedule:*")
	ctx.Assert(len(keys) == 0, "%s must store nothing, Redis holds %q", what, keys)
}

func CheckRoute(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiBody())
	ctx.Equal(r.Status, 201, "POST /v1/schedules with a valid body (%s)", r.Text())
	ctx.Assert(apiField(r, "id") != "", "the answer must carry the schedule's id: %s", r.Text())
	stored := apiStored(ctx, r)
	ctx.Assert(stored.Tenant == "t1" && stored.Cron == "*/15 * * * *" && stored.JobRef == "billing.invoice", "the stored schedule is %+v, expected tenant t1 with the request's cron and job_ref", stored)
	r = apiPost(c, apiBody(), "Content-Type", "application/json")
	ctx.Equal(r.Status, 401, "a request without X-Tenant-Id")
}

func CheckTimezone(ctx *harness.Ctx) {
	c := apiClient(ctx)
	r := apiPost(c, apiBody("timezone", "Mars/Olympus"))
	ctx.Assert(r.Status == 400 && apiField(r, "error") == "unknown_timezone", "timezone Mars/Olympus answered %d %s, expected 400 unknown_timezone: a zone the scheduler cannot resolve fires on some other clock", r.Status, r.Text())
	apiNothingStored(ctx, "a schedule in an unknown zone")
	r = apiPost(c, apiBody("timezone", "Asia/Kolkata"))
	ctx.Assert(r.Status == 201 && apiField(r, "timezone") == "Asia/Kolkata", "timezone Asia/Kolkata answered %d %s, expected 201 with the zone echoed", r.Status, r.Text())
}

func CheckFrequency(ctx *harness.Ctx) {
	c := apiClient(ctx)
	for _, expr := range []string{"* * * * *", "*/2 * * * *", "0,1 9 * * *"} {
		r := apiPost(c, apiBody("cron", expr))
		ctx.Assert(r.Status == 400 && apiField(r, "error") == "too_frequent", "cron %q answered %d %s, expected 400 too_frequent: its fires are less than five minutes apart", expr, r.Status, r.Text())
	}
	apiNothingStored(ctx, "a schedule that fires too often")
	r := apiPost(c, apiBody("cron", "*/5 * * * *"))
	ctx.Equal(r.Status, 201, "cron '*/5 * * * *' (every five minutes) (%s)", r.Text())
}

func CheckMisfirePolicy(ctx *harness.Ctx) {
	c := apiClient(ctx)
	body := apiBody()
	delete(body, "misfire_policy")
	r := apiPost(c, body)
	ctx.Assert(r.Status == 400 && apiField(r, "error") == "invalid_misfire_policy", "a schedule without misfire_policy answered %d %s, expected 400 invalid_misfire_policy: a default decides for the job's owner what a pause costs", r.Status, r.Text())
	r = apiPost(c, apiBody("misfire_policy", "retry_forever"))
	ctx.Assert(r.Status == 400 && apiField(r, "error") == "invalid_misfire_policy", "misfire_policy retry_forever answered %d %s, expected 400 invalid_misfire_policy", r.Status, r.Text())
	apiNothingStored(ctx, "a schedule without a known misfire policy")
	for _, policy := range []string{"skip", "fire_once_now", "catch_up"} {
		r = apiPost(c, apiBody("misfire_policy", policy))
		ctx.Equal(r.Status, 201, "misfire_policy %s (%s)", policy, r.Text())
		ctx.Equal(apiStored(ctx, r).MisfirePolicy, policy, "the stored schedule's misfire_policy")
	}
}

func CheckNextFire(ctx *harness.Ctx) {
	c := apiClient(ctx)
	now := time.Now().Unix()
	spec, _ := cron.Parse("0 9 * * *")
	utcFire, _ := cron.NextFire(spec, "UTC", now)
	for _, zone := range apiZones {
		r := apiPost(c, apiBody("cron", "0 9 * * *", "timezone", zone))
		ctx.Equal(r.Status, 201, "cron '0 9 * * *' in %s (%s)", zone, r.Text())
		fire, _ := cron.NextFire(spec, zone, now)
		expected := cron.FormatInstant(fire)
		got := apiField(r, "next_fire")
		onUTC := ""
		if got == cron.FormatInstant(utcFire) {
			onUTC = " (that is 09:00 UTC: the expression ran on the server's clock)"
		}
		ctx.Assert(got == expected, "cron '0 9 * * *' in %s answered next_fire %s, expected %s, the next 09:00 on the %s wall clock%s", zone, got, expected, zone, onUTC)
		ctx.Equal(apiStored(ctx, r).NextFire, expected, "the stored next_fire")
	}
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <chrono>
#include <string>
#include <vector>

#include "cronsched/cron.h"
#include "cronsched/store.h"

namespace {

const std::vector<std::string> kApiZones = {"Europe/Berlin", "Asia/Kolkata", "America/New_York"};

nlohmann::json apiBody() {
  return nlohmann::json{{"cron", "*/15 * * * *"}, {"timezone", "Europe/Berlin"}, {"job_ref", "billing.invoice"}, {"misfire_policy", "skip"}};
}

harness::HTTP apiClient(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response apiPost(harness::HTTP& c, const nlohmann::json& body, const std::string& tenant = "t1") {
  if (tenant.empty()) return c.Post("/v1/schedules", body.dump(), "Content-Type", "application/json");
  return c.Post("/v1/schedules", body.dump(), "Content-Type", "application/json", "X-Tenant-Id", tenant);
}

std::string apiField(const harness::Response& r, const std::string& field) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() && body.contains(field) && body[field].is_string() ? body[field].get<std::string>() : "";
}

cronsched::Schedule apiStored(const harness::Response& r) {
  return cronsched::store::Get(apiField(r, "id")).value_or(cronsched::Schedule{});
}

void apiNothingStored(harness::Ctx& ctx, const std::string& what) {
  const auto keys = ctx.Redis.Keys("schedule:*");
  ctx.Assert(keys.empty(), "%s must store nothing, Redis holds %q", what, keys);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  auto r = apiPost(c, apiBody());
  ctx.Equal(r.Status, 201, "POST /v1/schedules with a valid body (%s)", r.Text());
  ctx.Assert(!apiField(r, "id").empty(), "the answer must carry the schedule's id: %s", r.Text());
  const auto stored = apiStored(r);
  ctx.Assert(stored.tenant == "t1" && stored.cron == "*/15 * * * *" && stored.job_ref == "billing.invoice",
             "the stored schedule is tenant=%s cron=%s job_ref=%s, expected tenant t1 with the request's cron and job_ref", stored.tenant,
             stored.cron, stored.job_ref);
  r = apiPost(c, apiBody(), "");
  ctx.Equal(r.Status, 401, "a request without X-Tenant-Id");
}

void CheckTimezone(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  auto body = apiBody();
  body["timezone"] = "Mars/Olympus";
  auto r = apiPost(c, body);
  ctx.Assert(r.Status == 400 && apiField(r, "error") == "unknown_timezone",
             "timezone Mars/Olympus answered %d %s, expected 400 unknown_timezone: a zone the scheduler cannot resolve fires on some other clock",
             r.Status, r.Text());
  apiNothingStored(ctx, "a schedule in an unknown zone");
  body["timezone"] = "Asia/Kolkata";
  r = apiPost(c, body);
  ctx.Assert(r.Status == 201 && apiField(r, "timezone") == "Asia/Kolkata",
             "timezone Asia/Kolkata answered %d %s, expected 201 with the zone echoed", r.Status, r.Text());
}

void CheckFrequency(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  auto body = apiBody();
  for (const std::string expr : {"* * * * *", "*/2 * * * *", "0,1 9 * * *"}) {
    body["cron"] = expr;
    const auto r = apiPost(c, body);
    ctx.Assert(r.Status == 400 && apiField(r, "error") == "too_frequent",
               "cron '%s' answered %d %s, expected 400 too_frequent: its fires are less than five minutes apart", expr, r.Status, r.Text());
  }
  apiNothingStored(ctx, "a schedule that fires too often");
  body["cron"] = "*/5 * * * *";
  const auto r = apiPost(c, body);
  ctx.Equal(r.Status, 201, "cron '*/5 * * * *' (every five minutes) (%s)", r.Text());
}

void CheckMisfirePolicy(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  auto body = apiBody();
  body.erase("misfire_policy");
  auto r = apiPost(c, body);
  ctx.Assert(r.Status == 400 && apiField(r, "error") == "invalid_misfire_policy",
             "a schedule without misfire_policy answered %d %s, expected 400 invalid_misfire_policy: a default decides for the job's owner what a pause costs",
             r.Status, r.Text());
  body["misfire_policy"] = "retry_forever";
  r = apiPost(c, body);
  ctx.Assert(r.Status == 400 && apiField(r, "error") == "invalid_misfire_policy",
             "misfire_policy retry_forever answered %d %s, expected 400 invalid_misfire_policy", r.Status, r.Text());
  apiNothingStored(ctx, "a schedule without a known misfire policy");
  for (const std::string policy : {"skip", "fire_once_now", "catch_up"}) {
    body["misfire_policy"] = policy;
    r = apiPost(c, body);
    ctx.Equal(r.Status, 201, "misfire_policy %s (%s)", policy, r.Text());
    ctx.Equal(apiStored(r).misfire_policy, policy, "the stored schedule's misfire_policy");
  }
}

void CheckNextFire(harness::Ctx& ctx) {
  auto c = apiClient(ctx);
  const int64_t now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const auto spec = *cronsched::cron::Parse("0 9 * * *");
  const std::string utc_fire = cronsched::cron::FormatInstant(*cronsched::cron::NextFire(spec, "UTC", now));
  auto body = apiBody();
  body["cron"] = "0 9 * * *";
  for (const auto& zone : kApiZones) {
    body["timezone"] = zone;
    const auto r = apiPost(c, body);
    ctx.Equal(r.Status, 201, "cron '0 9 * * *' in %s (%s)", zone, r.Text());
    const std::string expected = cronsched::cron::FormatInstant(*cronsched::cron::NextFire(spec, zone, now));
    const std::string got = apiField(r, "next_fire");
    const std::string on_utc = got == utc_fire ? " (that is 09:00 UTC: the expression ran on the server's clock)" : "";
    ctx.Assert(got == expected, "cron '0 9 * * *' in %s answered next_fire %s, expected %s, the next 09:00 on the %s wall clock%s", zone, got,
               expected, zone, on_utc);
    ctx.Equal(apiStored(r).next_fire, expected, "the stored next_fire");
  }
}
`,
  },
  hints: [
    "A team in Berlin gets its 09:00 report at 10:00 all winter; another tenant's `* * * * *` health check becomes most of the job queue; a zone with a typo fires on a clock nobody chose.",
    'The starter evaluates every expression on the UTC clock and stores whatever zone and policy arrive. A missing policy quietly becomes `catch_up`, so the first scheduler pause replays every window it missed.',
    'Before storing: `shortest_gap_s(spec) < MIN_INTERVAL_S` → 400 `too_frequent`; `zone_known(timezone)` or 400 `unknown_timezone`; a policy in `MISFIRE_POLICIES` or 400 `invalid_misfire_policy`, no default; then `next_fire(spec, timezone, now)`.',
  ],
  debrief: `Every rule runs at creation because a schedule is a promise that runs unattended: an invalid one does not fail once, it fails at every fire for as long as it exists, and nobody is watching when it does. The zone is part of what the schedule means, not display metadata: 09:00 is 09:00 where the owners live, so the next fire comes from that wall clock and moves with its daylight shifts. The misfire policy has no default for the same reason a zone does not fall back to UTC: only the job's owner knows whether a missed run is owed. Production schedulers also resolve the job reference against a registry, cap schedules per tenant, and answer the next few fire times so a typo is visible before it runs.`,
};
