import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/schedules/{id}/history: pauses and misfires visible',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it returns a list of the
schedule's fires and a \`stalled: false\`, so the demo shows a history. It builds that history the
wrong way round. Review it like the on-call engineer who has to read it, fix it, and prove the fix
with the checks below.

Implement \`GET /v1/schedules/{schedule_id}/history\`.

- The tenant comes from \`X-Tenant-Id\`; a missing tenant is **401**. A schedule that does not exist
  **or belongs to another tenant** is **404** — never 403 and never an empty list, because both leak
  the existence of someone else's schedule.
- The response covers the last **30 days** (\`HISTORY_DAYS = 30\`): \`since = now - HISTORY_DAYS *
  86400\`.
- Rows are built from **expectation math**, not only from what fired. Walk the windows the cron
  should have fired in \`[since, now]\` (\`expected_windows(cron, since, now)\`) and emit one row per
  expected window: the recorded outcome when there is one, and otherwise a
  \`{"outcome": "misfire", "decision": "missed", "policy": <policy>, "reason": …}\` row. Every row
  carries the schedule's \`misfire_policy\`, including skipped rows — that is the field that tells
  the reader a pause was deliberate.
- Flag a **stalled** schedule: silence for more than \`STALL_WINDOWS = 3\` expected windows
  (\`silent\` seconds since the last run). Derive it from the same expectation math, so a schedule
  with a five-minute cron is not called stalled after three minutes of quiet.

**Failure mode the checks target.** The draft synthesizes history from successful fires only, so a
schedule whose fire path has been broken for a week returns an empty list and \`stalled: false\` —
the most dangerous shape a health read can take, because it looks exactly like a schedule that had
nothing to do. It also shows no policy on a skipped row and never checks who owns the schedule.`,
  sequence: {
    participants: ['Client', 'Scheduler API', 'schedule store'],
    messages: [
      {from: 'Client', to: 'Scheduler API', label: 'GET /v1/schedules/{id}/history · X-Tenant-Id', kind: 'sync'},
      {from: 'Scheduler API', to: 'schedule store', label: 'schedule(tenant, id)', kind: 'sync'},
      {from: 'schedule store', to: 'Scheduler API', label: 'schedule / none → 404', kind: 'reply'},
      {from: 'Scheduler API', to: 'Scheduler API', label: 'expected_windows(cron, since, now)', kind: 'sync'},
      {from: 'Scheduler API', to: 'schedule store', label: 'recorded_windows(id, since)', kind: 'sync'},
      {from: 'schedule store', to: 'Scheduler API', label: '{window: {outcome, decision, reason}}', kind: 'reply'},
      {
        from: 'Scheduler API',
        to: 'Client',
        label: '200 {rows: fired · skipped · misfire + policy, stalled, silent}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/schedules/{id}/history',
      detail: 'Register the history read on `GET /v1/schedules/{id}/history`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/schedules\/\{schedule_id\}\/history["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/schedules\/:id\/history['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/schedules\/\{id\}\/history"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"schedules"\s*\/\s*Segment\s*\/\s*"history"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\([^,]*\/v1\/schedules\//]},
      },
    },
    {
      id: 'misfires',
      title: 'Missing windows appear as misfires with the policy',
      detail:
        'Rows come from `expected_windows(cron, since, now)`: an expected window with no record is a `misfire` row carrying the schedule\u2019s `misfire_policy`. The draft lists only successful fires, so a broken schedule looks idle.',
      match: {
        python: {all: [/expected_windows\(/, /"misfire"/, /misfire_policy/]},
        typescript: {all: [/expectedWindows\(/, /'misfire'/, /misfire_policy/]},
        go: {all: [/ExpectedWindows\(/, /"misfire"/, /MisfirePolicy/]},
        scala: {all: [/expectedWindows\(/, /"misfire"/, /misfirePolicy/]},
        cpp: {all: [/expectedWindows\(/, /"misfire"/, /misfire_policy/]},
      },
    },
    {
      id: 'history-window',
      title: 'Covers the last 30 days',
      detail:
        'The read is bounded to `HISTORY_DAYS = 30`, with `since` computed from the current time; unbounded history reads grow without limit and hide the recent past in noise.',
      match: {
        python: {all: [/HISTORY_DAYS\s*=\s*30/, /since/]},
        typescript: {all: [/HISTORY_DAYS\s*=\s*30/, /since/]},
        go: {all: [/historyDays\s*=\s*30/, /since/]},
        scala: {all: [/HistoryDays\s*=\s*30/, /since/]},
        cpp: {all: [/kHistoryDays\s*=\s*30/, /since/]},
      },
    },
    {
      id: 'stall-flag',
      title: 'Stall flag comes from expectation math',
      detail:
        '`STALL_WINDOWS = 3` expected windows of silence set `stalled` from `silent` seconds since the last run, measured against the cron interval — not a hardcoded false. The draft always reports `stalled: false`.',
      match: {
        python: {all: [/STALL_WINDOWS\s*=\s*3/, /stalled/, /silent/]},
        typescript: {all: [/STALL_WINDOWS\s*=\s*3/, /stalled/, /silent/]},
        go: {all: [/stallWindows\s*=\s*3/, /stalled/, /silent/]},
        scala: {all: [/StallWindows\s*=\s*3/, /stalled/, /silent/]},
        cpp: {all: [/kStallWindows\s*=\s*3/, /stalled/, /silent/]},
      },
    },
    {
      id: 'ownership-404',
      title: 'Another tenant’s schedule is 404',
      detail:
        'The schedule is loaded by `(tenant, id)` and answered **404** when it is missing or owned by another tenant, so the read cannot be used to probe for someone else’s schedules. The draft looks the schedule up by id alone.',
      match: {
        python: {all: [/status_code\s*=\s*404/, /tenant/]},
        typescript: {all: [/code\(\s*404\s*\)/, /tenant/]},
        go: {all: [/StatusNotFound/, /tenant/]},
        scala: {all: [/StatusCodes\.NotFound/, /tenant/]},
        cpp: {all: [/status = 404/, /tenant/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("scheduler")


class HistoryStore:
    def schedule(self, schedule_id: str) -> dict | None:
        raise NotImplementedError

    def fired_windows(self, schedule_id: str) -> list[int]:
        """The windows this schedule successfully fired."""
        raise NotImplementedError


store = HistoryStore()


@app.get("/v1/schedules/{schedule_id}/history")
def history(
    schedule_id: str,
    tenant: str = Header(alias="X-Tenant-Id"),
) -> JSONResponse:
    # TODO: this draft synthesizes history from successful fires only, so a broken schedule looks
    # idle, shows no policy on a skipped row, and never checks that the schedule belongs to the
    # calling tenant. Review all three.
    rows = [
        {"window": window, "outcome": "fired"}
        for window in store.fired_windows(schedule_id)
    ]
    logger.info("history schedule=%s rows=%d", schedule_id, len(rows))
    return JSONResponse({"schedule_id": schedule_id, "rows": rows, "stalled": False})
`,
      solution: `import logging
import time

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("scheduler")

HISTORY_DAYS = 30
STALL_WINDOWS = 3
WINDOW_S = 60


class HistoryStore:
    def schedule(self, tenant: str, schedule_id: str) -> dict | None:
        """The schedule owned by tenant, or None when it does not exist or is not theirs."""
        raise NotImplementedError

    def recorded_windows(self, schedule_id: str, since: int) -> dict[int, dict]:
        """The outcomes already recorded, keyed by window."""
        raise NotImplementedError

    def last_run(self, schedule_id: str) -> int | None:
        raise NotImplementedError


store = HistoryStore()


def cron_interval_seconds(cron: str) -> int:
    """Seconds between two fires of a validated five-field cron; the minute field sets the step."""
    fields = cron.split()
    if len(fields) != 5:
        raise HTTPException(status_code=400, detail="cron must have five fields")
    step = fields[0]
    if step == "*":
        return WINDOW_S
    if step.startswith("*/"):
        return max(WINDOW_S, int(step[2:]) * WINDOW_S)
    return 3600


def expected_windows(cron: str, since: int, now: int) -> list[int]:
    """Every window the cron should have fired in [since, now]: expectation, not the log."""
    interval = cron_interval_seconds(cron)
    return list(range(since, now, interval))


def history_rows(schedule: dict, since: int, now: int) -> list[dict]:
    recorded = store.recorded_windows(schedule["id"], since)
    rows = []
    for window in expected_windows(schedule["cron"], since, now):
        record = recorded.get(window)
        if record is None:
            rows.append(
                {
                    "window": window,
                    "outcome": "misfire",
                    "decision": "missed",
                    "policy": schedule["misfire_policy"],
                    "reason": "no fire recorded for an expected window",
                }
            )
        else:
            rows.append(
                {
                    "window": window,
                    "outcome": record["outcome"],
                    "decision": record["decision"],
                    "policy": schedule["misfire_policy"],
                    "reason": record["reason"],
                }
            )
    return rows


@app.get("/v1/schedules/{schedule_id}/history")
def history(
    schedule_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    schedule = store.schedule(tenant, schedule_id)
    if schedule is None:
        raise HTTPException(status_code=404, detail="schedule not found")
    now = int(time.time())
    since = now - HISTORY_DAYS * 24 * 3600
    rows = history_rows(schedule, since, now)
    last_run = store.last_run(schedule_id) or since
    silent = now - last_run
    stalled = silent > STALL_WINDOWS * cron_interval_seconds(schedule["cron"])
    logger.info("history schedule=%s rows=%d stalled=%s", schedule_id, len(rows), stalled)
    return JSONResponse(
        {
            "schedule_id": schedule_id,
            "since": since,
            "rows": rows,
            "stalled": stalled,
            "silent": silent,
        }
    )
`,
    },
    typescript: {
      starter: `/** A model-generated draft that synthesizes history from successful fires. */
import Fastify from 'fastify';

export const app = Fastify();

interface HistoryStore {
  schedule(scheduleId: string): Promise<{cron: string; misfire_policy: string} | null>;
  firedWindows(scheduleId: string): Promise<number[]>;
}

const store = {} as HistoryStore;

app.get('/v1/schedules/:id/history', async (request, reply) => {
  // TODO: this draft synthesizes history from successful fires only, so a broken schedule looks
  // idle, shows no policy on a skipped row, and never checks that the schedule belongs to the
  // calling tenant. Review all three.
  const tenant = request.headers['x-tenant-id'] as string;
  const {id} = request.params as {id: string};
  const rows = (await store.firedWindows(id)).map(window => ({window, outcome: 'fired'}));
  request.log.info({tenant, schedule_id: id, rows: rows.length}, 'history');
  return reply.code(200).send({schedule_id: id, rows, stalled: false});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/schedules/:id/history: expectations, not just successes. */
import Fastify from 'fastify';

import {store} from './store';
import type {RecordedWindow, Schedule} from './store';

export const app = Fastify();

const HISTORY_DAYS = 30;
const STALL_WINDOWS = 3;
const WINDOW_S = 60;

/** Seconds between two fires of a validated five-field cron; the minute field sets the step. */
function cronIntervalSeconds(cron: string): number {
  const fields = cron.trim().split(/\\s+/);
  if (fields.length !== 5) throw new Error('cron must have five fields');
  const step = fields[0];
  if (step === '*') return WINDOW_S;
  if (step.startsWith('*/')) return Math.max(WINDOW_S, Number(step.slice(2)) * WINDOW_S);
  return 3600;
}

/** Every window the cron should have fired in [since, now]: expectation, not the log. */
function expectedWindows(cron: string, since: number, now: number): number[] {
  const interval = cronIntervalSeconds(cron);
  const windows: number[] = [];
  for (let window = since; window < now; window += interval) windows.push(window);
  return windows;
}

function row(schedule: Schedule, window: number, record: RecordedWindow | undefined) {
  if (record === undefined)
    return {
      window,
      outcome: 'misfire',
      decision: 'missed',
      policy: schedule.misfire_policy,
      reason: 'no fire recorded for an expected window',
    };
  return {
    window,
    outcome: record.outcome,
    decision: record.decision,
    policy: schedule.misfire_policy,
    reason: record.reason,
  };
}

app.get('/v1/schedules/:id/history', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {id} = request.params as {id: string};
  const schedule = await store.schedule(tenant, id);
  if (schedule === null) return reply.code(404).send({error: 'schedule not found'});

  const now = Math.floor(Date.now() / 1000);
  const since = now - HISTORY_DAYS * 24 * 3600;
  const recorded = await store.recordedWindows(id, since);
  const rows = expectedWindows(schedule.cron, since, now).map(window => row(schedule, window, recorded.get(window)));
  const lastRun = (await store.lastRun(id)) ?? since;
  const silent = now - lastRun;
  const stalled = silent > STALL_WINDOWS * cronIntervalSeconds(schedule.cron);
  request.log.info({schedule_id: id, rows: rows.length, stalled}, 'history');
  return reply.code(200).send({schedule_id: id, since, rows, stalled, silent});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func scheduleHistory(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft synthesizes history from successful fires only, so a broken schedule looks
	// idle, shows no policy on a skipped row, and never checks that the schedule belongs to the
	// calling tenant. Review all three.
	tenant := r.Header.Get("X-Tenant-Id")
	id := r.PathValue("id")
	rows := make([]map[string]any, 0)
	for _, window := range store.FiredWindows(r.Context(), id) {
		rows = append(rows, map[string]any{"window": window, "outcome": "fired"})
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"tenant":      tenant,
		"schedule_id": id,
		"rows":        rows,
		"stalled":     false,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/schedules/{id}/history", scheduleHistory)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	historyDays   = 30
	stallWindows  = 3
	windowSeconds = 60
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// cronIntervalSeconds is the gap between two fires of a validated five-field cron.
func cronIntervalSeconds(cron string) int {
	fields := strings.Fields(cron)
	if len(fields) != 5 {
		return windowSeconds
	}
	step := fields[0]
	if step == "*" {
		return windowSeconds
	}
	if strings.HasPrefix(step, "*/") {
		if n, err := strconv.Atoi(step[2:]); err == nil && n*windowSeconds > windowSeconds {
			return n * windowSeconds
		}
	}
	return 3600
}

// ExpectedWindows is every window the cron should have fired in [since, now].
func ExpectedWindows(cron string, since, now int64) []int64 {
	interval := int64(cronIntervalSeconds(cron))
	windows := make([]int64, 0)
	for window := since; window < now; window += interval {
		windows = append(windows, window)
	}
	return windows
}

func scheduleHistory(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	id := r.PathValue("id")
	schedule, err := store.Schedule(r.Context(), tenant, id)
	if err != nil || schedule == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "schedule not found"})
		return
	}
	now := time.Now().Unix()
	since := now - int64(historyDays)*24*3600
	recorded := store.RecordedWindows(r.Context(), id, since)
	rows := make([]map[string]any, 0)
	for _, window := range ExpectedWindows(schedule.Cron, since, now) {
		record, ok := recorded[window]
		if !ok {
			rows = append(rows, map[string]any{
				"window":   window,
				"outcome":  "misfire",
				"decision": "missed",
				"policy":   schedule.MisfirePolicy,
				"reason":   "no fire recorded for an expected window",
			})
			continue
		}
		rows = append(rows, map[string]any{
			"window":   window,
			"outcome":  record.Outcome,
			"decision": record.Decision,
			"policy":   schedule.MisfirePolicy,
			"reason":   record.Reason,
		})
	}
	lastRun := store.LastRun(r.Context(), id)
	if lastRun == 0 {
		lastRun = since
	}
	silent := now - lastRun
	stalled := silent > int64(stallWindows*cronIntervalSeconds(schedule.Cron))
	writeJSON(rw, http.StatusOK, map[string]any{
		"schedule_id": id,
		"since":       since,
		"rows":        rows,
		"stalled":     stalled,
		"silent":      silent,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/schedules/{id}/history", scheduleHistory)
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

object HistoryApi {
  implicit val system: ActorSystem = ActorSystem("cron-scheduler")

  val store = HistoryStore.open()

  val route: Route =
    path("v1" / "schedules" / Segment / "history") { scheduleId =>
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          // TODO: this draft synthesizes history from successful fires only, so a broken schedule
          // looks idle, shows no policy on a skipped row, and never checks that the schedule
          // belongs to the calling tenant. Review all three.
          val rows = store.firedWindows(scheduleId).map { window =>
            Map("window" -> window, "outcome" -> "fired")
          }
          system.log.info(s"history tenant=$tenant schedule=$scheduleId rows=" + rows.length)
          complete(StatusCodes.OK, s"""{"schedule_id":"$scheduleId","stalled":false}""")
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
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class HistoryResponse(schedule_id: String, since: Long, rows: Seq[Map[String, String]],
                                 stalled: Boolean, silent: Long)

object HistoryApi {
  implicit val system: ActorSystem = ActorSystem("cron-scheduler")
  implicit val responseFormat: RootJsonFormat[HistoryResponse] = jsonFormat5(HistoryResponse)

  val HistoryDays = 30
  val StallWindows = 3
  val WindowSeconds = 60

  val store = HistoryStore.open()

  /** Seconds between two fires of a validated five-field cron; the minute field sets the step. */
  def cronIntervalSeconds(cron: String): Int = {
    val fields = cron.trim.split("\\\\s+")
    if (fields.length != 5) WindowSeconds
    else if (fields(0) == "*") WindowSeconds
    else if (fields(0).startsWith("*/")) math.max(WindowSeconds, fields(0).drop(2).toIntOption.getOrElse(1) * WindowSeconds)
    else 3600
  }

  /** Every window the cron should have fired in [since, now]: expectation, not the log. */
  def expectedWindows(cron: String, since: Long, now: Long): List[Long] =
    (since until now by cronIntervalSeconds(cron)).toList

  def historyRows(schedule: Schedule, since: Long, now: Long): List[Map[String, String]] =
    expectedWindows(schedule.cron, since, now).map { window =>
      store.recordedWindows(schedule.id, since).get(window) match {
        case None =>
          Map(
            "window" -> window.toString,
            "outcome" -> "misfire",
            "decision" -> "missed",
            "policy" -> schedule.misfirePolicy,
            "reason" -> "no fire recorded for an expected window"
          )
        case Some(record) =>
          Map(
            "window" -> window.toString,
            "outcome" -> record.outcome,
            "decision" -> record.decision,
            "policy" -> schedule.misfirePolicy,
            "reason" -> record.reason
          )
      }
    }

  val route: Route =
    path("v1" / "schedules" / Segment / "history") { scheduleId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            val tenant = tenantOpt.get
            store.schedule(tenant, scheduleId) match {
              case None =>
                complete(StatusCodes.NotFound, """{"error":"schedule not found"}""")
              case Some(schedule) =>
                val now = System.currentTimeMillis() / 1000
                val since = now - HistoryDays * 24L * 3600L
                val rows = historyRows(schedule, since, now)
                val lastRun = store.lastRun(scheduleId).getOrElse(since)
                val silent = now - lastRun
                val stalled = silent > StallWindows * cronIntervalSeconds(schedule.cron)
                system.log.info(s"history tenant=$tenant schedule=$scheduleId rows=" + rows.length)
                complete(
                  StatusCodes.OK,
                  HistoryResponse(scheduleId, since, rows.map(_.view.mapValues(v => v).toMap), stalled, silent)
                )
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

#include <string>

using json = nlohmann::json;

struct HistoryStore {
  std::vector<long> firedWindows(const std::string& scheduleId);
};

HistoryStore store;

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/schedules/([^/]+)/history)", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft synthesizes history from successful fires only, so a broken schedule looks
    // idle, shows no policy on a skipped row, and never checks that the schedule belongs to the
    // calling tenant. Review all three.
    const auto tenant = req.get_header_value("X-Tenant-Id");
    const auto scheduleId = req.matches[1];
    json rows = json::array();
    for (const long window : store.firedWindows(scheduleId)) {
      rows.push_back(json{{"window", window}, {"outcome", "fired"}});
    }
    res.status = 200;
    res.set_content(json{{"tenant", tenant}, {"schedule_id", scheduleId}, {"rows", rows}, {"stalled", false}}.dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <ctime>
#include <map>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr int kHistoryDays = 30;
constexpr int kStallWindows = 3;
constexpr int kWindowSeconds = 60;

struct RecordedWindow {
  std::string outcome;
  std::string decision;
  std::string reason;
};

struct HistoryStore {
  std::optional<Schedule> schedule(const std::string& tenant, const std::string& scheduleId);
  std::map<long, RecordedWindow> recordedWindows(const std::string& scheduleId, long since);
  long lastRun(const std::string& scheduleId);
};

HistoryStore store;

/** Seconds between two fires of a validated five-field cron; the minute field sets the step. */
int cronIntervalSeconds(const std::string& cron) {
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
  if (fields.size() != 5) return kWindowSeconds;
  const std::string& step = fields[0];
  if (step == "*") return kWindowSeconds;
  if (step.rfind("*/", 0) == 0) {
    const int n = std::stoi(step.substr(2));
    return n * kWindowSeconds > kWindowSeconds ? n * kWindowSeconds : kWindowSeconds;
  }
  return 3600;
}

/** Every window the cron should have fired in [since, now]: expectation, not the log. */
std::vector<long> expectedWindows(const std::string& cron, long since, long now) {
  const long interval = cronIntervalSeconds(cron);
  std::vector<long> windows;
  for (long window = since; window < now; window += interval) windows.push_back(window);
  return windows;
}

json historyRow(const Schedule& schedule, long window, const RecordedWindow* record) {
  if (record == nullptr) {
    return json{{"window", window},
                {"outcome", "misfire"},
                {"decision", "missed"},
                {"policy", schedule.misfire_policy},
                {"reason", "no fire recorded for an expected window"}};
  }
  return json{{"window", window},
              {"outcome", record->outcome},
              {"decision", record->decision},
              {"policy", schedule.misfire_policy},
              {"reason", record->reason}};
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/schedules/([^/]+)/history)", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto scheduleId = req.matches[1];
    const auto schedule = store.schedule(tenant, scheduleId);
    if (!schedule.has_value()) {
      res.status = 404;
      res.set_content(R"({"error":"schedule not found"})", "application/json");
      return;
    }
    const long now = static_cast<long>(std::time(nullptr));
    const long since = now - kHistoryDays * 24L * 3600L;
    const auto recorded = store.recordedWindows(scheduleId, since);
    json rows = json::array();
    for (const long window : expectedWindows(schedule->cron, since, now)) {
      const auto it = recorded.find(window);
      rows.push_back(historyRow(*schedule, window, it == recorded.end() ? nullptr : &it->second));
    }
    long lastRun = store.lastRun(scheduleId);
    if (lastRun == 0) lastRun = since;
    const long silent = now - lastRun;
    const bool stalled = silent > kStallWindows * cronIntervalSeconds(schedule->cron);
    res.status = 200;
    res.set_content(json{{"schedule_id", scheduleId},
                         {"since", since},
                         {"rows", rows},
                         {"stalled", stalled},
                         {"silent", silent}}
                        .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Build the row list from the cron, not from the log: `expected_windows(cron, since, now)` gives every window that should have fired, and each one either has a record or becomes a `misfire`. That single change is what makes a broken schedule visibly broken instead of merely quiet.',
    'Carry the policy on every row. A `skipped` row with `policy` and `reason` is a decision the operator made; the same row without them is indistinguishable from data loss, which is why the history read and the fire path must agree on the same field.',
    'The stall flag is arithmetic: `silent = now - last_run` against `STALL_WINDOWS = 3` times the cron interval. Return it with `silent` so the reader can see the numbers behind the boolean, and look the schedule up by `(tenant, id)` so a 404 is also the answer for someone else\u2019s schedule.',
  ],
  debrief: `The interviewer is testing what a health read is allowed to say. The draft passes because the demo schedule fired a minute ago. Four defects are checked: history derived from successes instead of expectations, no policy on the rows, an unbounded window, and an ownership check that is missing. The first one is the dangerous one: an empty list with \`stalled: false\` is the same response for a schedule that has nothing to do and a schedule whose fire path has been dead for a week. Real history reads also paginate, aggregate per day for long ranges, and cross-check the ledger against the ledger consumer's offset so a lost event is distinguishable from a window that never fired.`,
};
