import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/schedules: time spec that is valid and bounded',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it registers the route, parses
the body and returns a created schedule, so the demo passes. The time spec it accepts is not a
contract. Review it like the owner of the scheduler, fix it, and prove the fix with the checks
below.

Implement \`POST /v1/schedules\` with body
\`{"cron": "*/5 * * * *", "timezone": "Europe/Berlin", "job_ref": "billing.invoice", "misfire_policy": "skip"}\`.

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- \`timezone\` must be an IANA name the service can actually resolve: check it against the known set
  \`IANA_TIMEZONES\` **and** construct the zone (\`ZoneInfo(name)\`,
  \`Intl.DateTimeFormat('en-US', {timeZone: name})\`, \`time.LoadLocation\`, \`ZoneId.of\`, or the
  lookup table). A name the service cannot resolve is **400** — never "keep the string and fall back
  to server time". A schedule that fires in the wrong zone fires at the wrong hour for a whole
  tenant, every day, silently.
- \`cron\` must be a five-field expression (minute granularity). An expression that fires more often
  than **once a minute** is **400**: \`MAX_FIRES_PER_MINUTE = 1\` with \`MIN_INTERVAL_SECONDS = 60\`.
  A six-field expression carries a seconds field — \`*/30 * * * * *\` is 120 fires a minute — and is
  what turns one job into the queue's whole load.
- \`job_ref\` is required and must match \`JOB_REF_PATTERN\` (\`^[a-z][a-z0-9_.-]{0,127}$\`);
  anything else is **400**. The reference is what the scheduler triggers, so an empty or free-form
  one is a schedule that can never resolve to a job.
- \`misfire_policy\` is required and must be one of \`MISFIRE_POLICIES\` = \`skip\`,
  \`fire_once_now\`, \`catch_up\`. A missing policy is **400**: "skip everything" has to be a choice
  the caller makes, not the default the service invents.
- Answer **201** with the stored schedule, including its generated \`id\`.

**Failure mode the checks target.** The draft resolves nothing: it stores whatever timezone string
the caller sent and quietly runs on server time; it accepts a seconds-level expression and turns a
one-second cadence into a queue flood; it lets \`job_ref\` be empty; and it defaults
\`misfire_policy\` to \`skip\`, so a caller who never thought about misfires loses every missed run
without ever seeing it. All four are invisible in a demo that sends one well-formed request.`,
  sequence: {
    participants: ['Client', 'Scheduler API', 'schedule store'],
    messages: [
      {from: 'Client', to: 'Scheduler API', label: 'POST /v1/schedules · X-Tenant-Id', kind: 'sync'},
      {
        from: 'Scheduler API',
        to: 'Scheduler API',
        label: 'validate tenant · timezone · cron cadence · job_ref · policy',
        kind: 'sync',
      },
      {from: 'Scheduler API', to: 'schedule store', label: 'put(schedule)', kind: 'sync'},
      {from: 'schedule store', to: 'Scheduler API', label: 'stored {id, next_run}', kind: 'reply'},
      {from: 'Scheduler API', to: 'Client', label: '201 {id, cron, timezone, job_ref, misfire_policy}', kind: 'reply'},
      {
        from: 'Scheduler API',
        to: 'Client',
        label: '400 unresolvable timezone · sub-minute cron · unknown policy',
        kind: 'async',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/schedules',
      detail: 'Register the schedule route on `POST /v1/schedules`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/schedules["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/schedules['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/schedules"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"schedules"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/schedules"/]},
      },
    },
    {
      id: 'timezone',
      title: 'Resolves the timezone against the IANA set',
      detail:
        '`timezone` is checked against `IANA_TIMEZONES` and then actually resolved (`ZoneInfo` / `Intl.DateTimeFormat` / `time.LoadLocation` / `ZoneId.of` / the lookup table); an unresolvable name is **400**. The draft keeps the caller string and falls back to server time.',
      match: {
        python: {all: [/IANA_TIMEZONES/, /ZoneInfo\(/, /status_code\s*=\s*400/]},
        typescript: {all: [/IANA_TIMEZONES/, /Intl\.DateTimeFormat\(\s*'en-US'/, /code\(\s*400\s*\)/]},
        go: {all: [/ianaTimezones/, /time\.LoadLocation\(/, /StatusBadRequest/]},
        scala: {all: [/IanaTimezones/, /ZoneId\.of\(/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kIanaTimezones/, /validTimezone\(/, /status = 400/]},
      },
    },
    {
      id: 'frequency',
      title: 'Refuses expressions that fire more often than once a minute',
      detail:
        'A seconds field, or any cadence closer than `MIN_INTERVAL_SECONDS = 60`, is **400** when `MAX_FIRES_PER_MINUTE = 1`. The draft lets a caller register a one-second schedule that floods the queue.',
      match: {
        python: {all: [/MAX_FIRES_PER_MINUTE/, /MIN_INTERVAL_SECONDS/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_FIRES_PER_MINUTE/, /MIN_INTERVAL_SECONDS/, /code\(\s*400\s*\)/]},
        go: {all: [/maxFiresPerMinute/, /minIntervalSeconds/, /StatusBadRequest/]},
        scala: {all: [/MaxFiresPerMinute/, /MinIntervalSeconds/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxFiresPerMinute/, /kMinIntervalSeconds/, /status = 400/]},
      },
    },
    {
      id: 'misfire-policy',
      title: 'Requires an explicit, known misfire policy',
      detail:
        '`misfire_policy` is required and checked against `MISFIRE_POLICIES` = `skip`, `fire_once_now`, `catch_up`; a missing or unknown one is **400**. The draft defaults it to `skip`, so missed windows are dropped by accident rather than by decision.',
      match: {
        python: {all: [/MISFIRE_POLICIES/, /"fire_once_now"/, /status_code\s*=\s*400/]},
        typescript: {all: [/MISFIRE_POLICIES/, /'fire_once_now'/, /code\(\s*400\s*\)/]},
        go: {all: [/misfirePolicies/, /"fire_once_now"/, /StatusBadRequest/]},
        scala: {all: [/MisfirePolicies/, /"fire_once_now"/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMisfirePolicies/, /"fire_once_now"/, /status = 400/]},
      },
    },
    {
      id: 'job-ref',
      title: 'Validates the job reference',
      detail:
        '`job_ref` is required and must match `JOB_REF_PATTERN` (`^[a-z][a-z0-9_.-]{0,127}$`); anything else is **400**. The draft stores whatever string arrives, so a schedule can name a job that cannot be resolved.',
      match: {
        python: {all: [/JOB_REF_PATTERN/, /job_ref/, /status_code\s*=\s*400/]},
        typescript: {all: [/JOB_REF_PATTERN/, /job_ref/, /code\(\s*400\s*\)/]},
        go: {all: [/jobRefPattern/, /JobRef/, /StatusBadRequest/]},
        scala: {all: [/JobRefPattern/, /job_ref/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kJobRefPattern/, /job_ref/, /status = 400/]},
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
logger = logging.getLogger("scheduler")


class ScheduleRequest(BaseModel):
    cron: str
    timezone: str = "UTC"
    job_ref: str = ""
    misfire_policy: str = ""


class ScheduleStore:
    def put(self, schedule: dict) -> dict:
        """Persist the schedule and return it with its generated id."""
        raise NotImplementedError


store = ScheduleStore()


@app.post("/v1/schedules")
def create_schedule(
    body: ScheduleRequest,
    tenant: str = Header(alias="X-Tenant-Id"),
) -> JSONResponse:
    # TODO: this draft keeps whatever timezone string the caller sent (and runs on server time
    # when it cannot resolve it), accepts a seconds-level cron, validates no job reference, and
    # defaults the misfire policy to skip. Review all four.
    schedule = {
        "id": "sched-1",
        "tenant": tenant,
        "cron": body.cron,
        "timezone": body.timezone,
        "job_ref": body.job_ref,
        "misfire_policy": body.misfire_policy,
    }
    logger.info("schedule created cron=%s timezone=%s", body.cron, body.timezone)
    return JSONResponse(store.put(schedule), status_code=201)
`,
      solution: `import logging
import re
import uuid

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

app = FastAPI()
logger = logging.getLogger("scheduler")

MAX_FIRES_PER_MINUTE = 1
MIN_INTERVAL_SECONDS = 60
MISFIRE_POLICIES = {"skip", "fire_once_now", "catch_up"}
IANA_TIMEZONES = {"UTC", "America/New_York", "Europe/Berlin", "Asia/Tokyo"}
JOB_REF_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]{0,127}$")


class ScheduleRequest(BaseModel):
    cron: str
    timezone: str = "UTC"
    job_ref: str = ""
    misfire_policy: str = ""


class ScheduleStore:
    def put(self, schedule: dict) -> dict:
        """Persist the schedule and return it with its generated id."""
        raise NotImplementedError


store = ScheduleStore()


def resolve_timezone(name: str) -> ZoneInfo:
    """The zone a schedule fires in; an unresolvable name is a 400, never server time."""
    if name not in IANA_TIMEZONES:
        raise HTTPException(status_code=400, detail="timezone must be an IANA name")
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        raise HTTPException(status_code=400, detail="timezone cannot be resolved")


def cron_min_interval_seconds(cron: str) -> int:
    """Seconds between the two closest fires of cron; a seconds field means sub-minute."""
    fields = cron.split()
    if len(fields) != 6:
        return 60
    seconds = fields[0]
    if seconds == "*":
        return 1
    if seconds.startswith("*/"):
        try:
            return int(seconds[2:])
        except ValueError:
            return 60
    return 60


@app.post("/v1/schedules")
def create_schedule(
    body: ScheduleRequest,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    resolve_timezone(body.timezone)
    interval = cron_min_interval_seconds(body.cron)
    if interval * MAX_FIRES_PER_MINUTE < MIN_INTERVAL_SECONDS:
        raise HTTPException(
            status_code=400,
            detail="expressions firing more often than once a minute are refused",
        )
    if not JOB_REF_PATTERN.match(body.job_ref):
        raise HTTPException(status_code=400, detail="job_ref must match ^[a-z][a-z0-9_.-]{0,127}$")
    if body.misfire_policy not in MISFIRE_POLICIES:
        raise HTTPException(
            status_code=400,
            detail="misfire_policy must be skip, fire_once_now or catch_up",
        )
    schedule = {
        "id": str(uuid.uuid4()),
        "tenant": tenant,
        "cron": body.cron,
        "timezone": body.timezone,
        "job_ref": body.job_ref,
        "misfire_policy": body.misfire_policy,
    }
    stored = store.put(schedule)
    logger.info(
        "schedule created id=%s job_ref=%s policy=%s",
        stored["id"],
        body.job_ref,
        body.misfire_policy,
    )
    return JSONResponse(stored, status_code=201)
`,
    },
    typescript: {
      starter: `/** POST /v1/schedules: a model-generated draft that stores the caller's time spec. */
import Fastify from 'fastify';

export const app = Fastify();

interface ScheduleBody {
  cron: string;
  timezone?: string;
  job_ref?: string;
  misfire_policy?: string;
}

app.post('/v1/schedules', async (request, reply) => {
  // TODO: this draft keeps whatever timezone string the caller sent (and runs on server time when
  // it cannot resolve it), accepts a seconds-level cron, validates no job reference, and defaults
  // the misfire policy to skip. Review all four.
  const tenant = request.headers['x-tenant-id'] as string;
  const body = request.body as ScheduleBody;
  const schedule = {
    id: 'sched-1',
    tenant,
    cron: body.cron,
    timezone: body.timezone ?? 'UTC',
    job_ref: body.job_ref ?? '',
    misfire_policy: body.misfire_policy ?? 'skip',
  };
  request.log.info({cron: body.cron, timezone: schedule.timezone}, 'schedule created');
  return reply.code(201).send(schedule);
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/schedules: an IANA-resolvable, minute-bounded time spec. */
import {randomUUID} from 'node:crypto';

import Fastify from 'fastify';

import {store} from './store';

export const app = Fastify();

const MAX_FIRES_PER_MINUTE = 1;
const MIN_INTERVAL_SECONDS = 60;
const MISFIRE_POLICIES: Record<string, true> = {'skip': true, 'fire_once_now': true, 'catch_up': true};
const IANA_TIMEZONES: Record<string, true> = {
  'UTC': true,
  'America/New_York': true,
  'Europe/Berlin': true,
  'Asia/Tokyo': true,
};
const JOB_REF_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/;

interface ScheduleBody {
  cron: string;
  timezone?: string;
  job_ref?: string;
  misfire_policy?: string;
}

function validTimezone(name: string): boolean {
  if (IANA_TIMEZONES[name] !== true) return false;
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: name});
    return true;
  } catch {
    return false;
  }
}

/** Seconds between the two closest fires of cron; a seconds field means sub-minute. */
function cronMinIntervalSeconds(cron: string): number {
  const fields = cron.trim().split(/s+/);
  if (fields.length !== 6) return 60;
  const seconds = fields[0];
  if (seconds === '*') return 1;
  if (seconds.startsWith('*/')) {
    const step = Number(seconds.slice(2));
    return Number.isFinite(step) ? step : 60;
  }
  return 60;
}

app.post('/v1/schedules', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});

  const body = request.body as Partial<ScheduleBody> | null;
  if (body === null || typeof body !== 'object' || typeof body.cron !== 'string')
    return reply.code(400).send({error: 'cron is required'});

  const timezone = body.timezone ?? 'UTC';
  if (!validTimezone(timezone)) return reply.code(400).send({error: 'timezone must be an IANA name'});

  if (cronMinIntervalSeconds(body.cron) * MAX_FIRES_PER_MINUTE < MIN_INTERVAL_SECONDS)
    return reply.code(400).send({error: 'expressions firing more often than once a minute are refused'});

  const jobRef = body.job_ref ?? '';
  if (!JOB_REF_PATTERN.test(jobRef))
    return reply.code(400).send({error: 'job_ref must match ^[a-z][a-z0-9_.-]{0,127}$'});

  const misfirePolicy = body.misfire_policy ?? '';
  if (MISFIRE_POLICIES[misfirePolicy] !== true)
    return reply.code(400).send({error: 'misfire_policy must be skip, fire_once_now or catch_up'});

  const schedule = {
    id: randomUUID(),
    tenant,
    cron: body.cron,
    timezone,
    job_ref: jobRef,
    misfire_policy: misfirePolicy,
  };
  await store.put(schedule);
  request.log.info({id: schedule.id, job_ref: jobRef, misfire_policy: misfirePolicy}, 'schedule created');
  return reply.code(201).send(schedule);
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

type ScheduleRequest struct {
	Cron          string \`json:"cron"\`
	Timezone      string \`json:"timezone"\`
	JobRef        string \`json:"job_ref"\`
	MisfirePolicy string \`json:"misfire_policy"\`
}

type ScheduleStore struct{}

func (s *ScheduleStore) Put(schedule map[string]any) map[string]any { return schedule }

var store = &ScheduleStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func createSchedule(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	var body ScheduleRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this draft keeps whatever timezone string the caller sent (and runs on server time
	// when it cannot resolve it), accepts a seconds-level cron, validates no job reference, and
	// defaults the misfire policy to skip. Review all four.
	timezone := body.Timezone
	if timezone == "" {
		timezone = "UTC"
	}
	policy := body.MisfirePolicy
	if policy == "" {
		policy = "skip"
	}
	schedule := map[string]any{
		"id":             "sched-1",
		"tenant":         tenant,
		"cron":           body.Cron,
		"timezone":       timezone,
		"job_ref":        body.JobRef,
		"misfire_policy": policy,
	}
	log.Printf("schedule created cron=%s timezone=%s", body.Cron, timezone)
	writeJSON(rw, http.StatusCreated, store.Put(schedule))
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/schedules", createSchedule)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

const (
	maxFiresPerMinute  = 1
	minIntervalSeconds = 60
)

var ianaTimezones = map[string]bool{
	"UTC": true, "America/New_York": true, "Europe/Berlin": true, "Asia/Tokyo": true,
}

var misfirePolicies = map[string]bool{"skip": true, "fire_once_now": true, "catch_up": true}

var jobRefPattern = regexp.MustCompile("^[a-z][a-z0-9_.-]{0,127}$")

type ScheduleRequest struct {
	Cron          string \`json:"cron"\`
	Timezone      string \`json:"timezone"\`
	JobRef        string \`json:"job_ref"\`
	MisfirePolicy string \`json:"misfire_policy"\`
}

type ScheduleStore struct{}

func (s *ScheduleStore) Put(schedule map[string]any) map[string]any { return schedule }

var store = &ScheduleStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// resolveTimezone returns the zone a schedule fires in; an unresolvable name is a 400, never
// server time.
func resolveTimezone(name string) (*time.Location, error) {
	if !ianaTimezones[name] {
		return nil, fmt.Errorf("timezone must be an IANA name")
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return nil, fmt.Errorf("timezone cannot be resolved: %w", err)
	}
	return loc, nil
}

// cronMinIntervalSeconds is the gap between the two closest fires; a seconds field is sub-minute.
func cronMinIntervalSeconds(cron string) int {
	fields := strings.Fields(cron)
	if len(fields) != 6 {
		return 60
	}
	seconds := fields[0]
	if seconds == "*" {
		return 1
	}
	if strings.HasPrefix(seconds, "*/") {
		var step int
		if _, err := fmt.Sscanf(seconds[2:], "%d", &step); err == nil && step > 0 {
			return step
		}
	}
	return 60
}

func createSchedule(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	var body ScheduleRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if _, err := resolveTimezone(body.Timezone); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if cronMinIntervalSeconds(body.Cron)*maxFiresPerMinute < minIntervalSeconds {
		writeJSON(rw, http.StatusBadRequest, map[string]string{
			"error": "expressions firing more often than once a minute are refused",
		})
		return
	}
	if !jobRefPattern.MatchString(body.JobRef) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{
			"error": "job_ref must match ^[a-z][a-z0-9_.-]{0,127}$",
		})
		return
	}
	if !misfirePolicies[body.MisfirePolicy] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{
			"error": "misfire_policy must be skip, fire_once_now or catch_up",
		})
		return
	}
	schedule := map[string]any{
		"id":             uuid.NewString(),
		"tenant":         tenant,
		"cron":           body.Cron,
		"timezone":       body.Timezone,
		"job_ref":        body.JobRef,
		"misfire_policy": body.MisfirePolicy,
	}
	stored := store.Put(schedule)
	log.Printf("schedule created id=%v job_ref=%s policy=%s", stored["id"], body.JobRef, body.MisfirePolicy)
	writeJSON(rw, http.StatusCreated, stored)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/schedules", createSchedule)
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

final case class ScheduleRequest(cron: String, timezone: String, job_ref: String, misfire_policy: String)

object ScheduleApi {
  implicit val system: ActorSystem = ActorSystem("cron-scheduler")
  implicit val requestFormat: RootJsonFormat[ScheduleRequest] = jsonFormat4(ScheduleRequest)

  val store = ScheduleStore.open()

  val route: Route =
    path("v1" / "schedules") {
      post {
        headerValueByName("X-Tenant-Id") { tenant =>
          entity(as[ScheduleRequest]) { body =>
            // TODO: this draft keeps whatever timezone string the caller sent (and runs on server
            // time when it cannot resolve it), accepts a seconds-level cron, validates no job
            // reference, and defaults the misfire policy to skip. Review all four.
            val timezone = if (body.timezone.isEmpty) "UTC" else body.timezone
            val policy = if (body.misfire_policy.isEmpty) "skip" else body.misfire_policy
            val schedule = Map(
              "id" -> "sched-1",
              "tenant" -> tenant,
              "cron" -> body.cron,
              "timezone" -> timezone,
              "job_ref" -> body.job_ref,
              "misfire_policy" -> policy
            )
            system.log.info(s"schedule created cron=$body.cron timezone=$timezone")
            complete(StatusCodes.Created, store.put(schedule))
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.time.{DateTimeException, ZoneId}
import java.util.UUID

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ScheduleRequest(cron: String, timezone: String, job_ref: String, misfire_policy: String)

object ScheduleApi {
  implicit val system: ActorSystem = ActorSystem("cron-scheduler")
  implicit val requestFormat: RootJsonFormat[ScheduleRequest] = jsonFormat4(ScheduleRequest)

  val MaxFiresPerMinute = 1
  val MinIntervalSeconds = 60
  val MisfirePolicies = Set("skip", "fire_once_now", "catch_up")
  val IanaTimezones = Set("UTC", "America/New_York", "Europe/Berlin", "Asia/Tokyo")
  val JobRefPattern = "^[a-z][a-z0-9_.-]{0,127}$".r

  val store = ScheduleStore.open()

  /** The zone a schedule fires in; an unresolvable name is a 400, never server time. */
  def resolveTimezone(name: String): Either[String, ZoneId] =
    if (!IanaTimezones.contains(name)) Left("timezone must be an IANA name")
    else
      try Right(ZoneId.of(name))
      catch { case _: DateTimeException => Left("timezone cannot be resolved") }

  /** Seconds between the two closest fires; a seconds field means sub-minute. */
  def cronMinIntervalSeconds(cron: String): Int = {
    val fields = cron.trim.split("\\s+")
    if (fields.length != 6) 60
    else if (fields(0) == "*") 1
    else if (fields(0).startsWith("*/")) fields(0).drop(2).toIntOption.getOrElse(60)
    else 60
  }

  val route: Route =
    path("v1" / "schedules") {
      post {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          entity(as[ScheduleRequest]) { body =>
            if (!tenantOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
            } else if (resolveTimezone(body.timezone).isLeft) {
              complete(StatusCodes.BadRequest, """{"error":"timezone must be an IANA name"}""")
            } else if (cronMinIntervalSeconds(body.cron) * MaxFiresPerMinute < MinIntervalSeconds) {
              complete(StatusCodes.BadRequest, """{"error":"expressions firing more often than once a minute are refused"}""")
            } else if (JobRefPattern.findFirstIn(body.job_ref).isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"job_ref must match ^[a-z][a-z0-9_.-]{0,127}$"}""")
            } else if (!MisfirePolicies.contains(body.misfire_policy)) {
              complete(StatusCodes.BadRequest, """{"error":"misfire_policy must be skip, fire_once_now or catch_up"}""")
            } else {
              val schedule = Map(
                "id" -> UUID.randomUUID().toString,
                "tenant" -> tenantOpt.get,
                "cron" -> body.cron,
                "timezone" -> body.timezone,
                "job_ref" -> body.job_ref,
                "misfire_policy" -> body.misfire_policy
              )
              system.log.info(s"schedule created id=\${schedule("id")} policy=\${body.misfire_policy}")
              complete(StatusCodes.Created, store.put(schedule))
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

using json = nlohmann::json;

struct ScheduleStore {
  json put(const json& schedule);
};

ScheduleStore store;

int main() {
  httplib::Server svr;

  svr.Post("/v1/schedules", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this draft keeps whatever timezone string the caller sent (and runs on server time
    // when it cannot resolve it), accepts a seconds-level cron, validates no job reference, and
    // defaults the misfire policy to skip. Review all four.
    const auto cron = body.value("cron", std::string());
    const auto timezone = body.value("timezone", std::string("UTC"));
    const json schedule = {
        {"id", "sched-1"},
        {"tenant", tenant},
        {"cron", cron},
        {"timezone", timezone},
        {"job_ref", body.value("job_ref", std::string())},
        {"misfire_policy", body.value("misfire_policy", std::string("skip"))},
    };
    std::cerr << "schedule created cron=" << cron << " timezone=" << timezone << "\\n";
    res.status = 201;
    res.set_content(store.put(schedule).dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <regex>
#include <set>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kMaxFiresPerMinute = 1;
constexpr int kMinIntervalSeconds = 60;
const std::set<std::string> kMisfirePolicies = {"skip", "fire_once_now", "catch_up"};
const std::set<std::string> kIanaTimezones = {"UTC", "America/New_York", "Europe/Berlin", "Asia/Tokyo"};
const std::regex kJobRefPattern("^[a-z][a-z0-9_.-]{0,127}$");
const std::regex kSecondsStepPattern("^\\\\*/([0-9]+)$");

struct ScheduleStore {
  json put(const json& schedule);
};

ScheduleStore store;

/** Whether the service can resolve this name; an unresolvable one is a 400, never server time. */
bool validTimezone(const std::string& name) {
  return kIanaTimezones.count(name) == 1;
}

/** Seconds between the two closest fires; a seconds field means sub-minute. */
int cronMinIntervalSeconds(const std::string& cron) {
  std::vector<std::string> fields;
  std::string field;
  for (const char c : cron) {
    if (c == ' ' || c == '\\t') {
      if (!field.empty()) fields.push_back(field);
      field.clear();
    } else {
      field.push_back(c);
    }
  }
  if (!field.empty()) fields.push_back(field);
  if (fields.size() != 6) return 60;
  const std::string& seconds = fields[0];
  if (seconds == "*") return 1;
  std::smatch match;
  if (std::regex_match(seconds, match, kSecondsStepPattern)) return std::stoi(match[1].str());
  return 60;
}

std::string uuidString();

int main() {
  httplib::Server svr;

  svr.Post("/v1/schedules", [](const httplib::Request& req, httplib::Response& res) {
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
    const auto timezone = body.value("timezone", std::string("UTC"));
    if (!validTimezone(timezone)) {
      res.status = 400;
      res.set_content(R"({"error":"timezone must be an IANA name"})", "application/json");
      return;
    }
    const auto cron = body.value("cron", std::string());
    if (cronMinIntervalSeconds(cron) * kMaxFiresPerMinute < kMinIntervalSeconds) {
      res.status = 400;
      res.set_content(R"({"error":"expressions firing more often than once a minute are refused"})", "application/json");
      return;
    }
    const auto jobRef = body.value("job_ref", std::string());
    if (!std::regex_match(jobRef, kJobRefPattern)) {
      res.status = 400;
      res.set_content(R"({"error":"job_ref must match ^[a-z][a-z0-9_.-]{0,127}$"})", "application/json");
      return;
    }
    const auto misfirePolicy = body.value("misfire_policy", std::string());
    if (kMisfirePolicies.count(misfirePolicy) == 0) {
      res.status = 400;
      res.set_content(R"({"error":"misfire_policy must be skip, fire_once_now or catch_up"})", "application/json");
      return;
    }
    const json schedule = {
        {"id", uuidString()},
        {"tenant", tenant},
        {"cron", cron},
        {"timezone", timezone},
        {"job_ref", jobRef},
        {"misfire_policy", misfirePolicy},
    };
    std::cerr << "schedule created id=" << schedule["id"] << " job_ref=" << jobRef << "\\n";
    res.status = 201;
    res.set_content(store.put(schedule).dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Validate in cheapest order and return before touching the store: tenant, timezone, cron cadence, job_ref, misfire_policy. Every one of those is a 400 the caller can fix; a schedule accepted with a broken time spec is an incident nobody sees until the wrong hour arrives.',
    'A cadence is a number, not a vibe: count the fields and treat a six-field expression as a seconds field. `*/30 * * * * *` is 120 fires a minute; `MIN_INTERVAL_SECONDS = 60` with `MAX_FIRES_PER_MINUTE = 1` is the bound that keeps one job from owning the queue.',
    'The misfire policy is the field a caller must never omit. Keep the allowlist as data (`MISFIRE_POLICIES`), reject anything outside it with a 400, and store the policy on the schedule so the fire path and the history read consult the same value.',
  ],
  debrief: `The interviewer is testing whether the endpoint treats the time spec as a contract. The draft reads fine because the demo sends one well-formed request with a timezone the server happens to be in and a cadence nobody measured. Four defects are checked: an unresolvable timezone that silently degrades to server time, an unbounded cadence that lets a caller schedule 120 fires a minute, a job reference that can never resolve, and a misfire policy defaulted instead of chosen. A real scheduler also stores the next fire time in UTC, caps the number of schedules per tenant, and echoes the computed next fire so the caller can confirm that the timezone it asked for is the one it got.`,
};
