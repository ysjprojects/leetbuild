import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/schedules/{id}/history: the windows that never ran',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/schedules/{id}/history\`: it reads the tenant from
\`X-Tenant-Id\` (**401** when missing), loads the schedule with \`store.get\` (**404** when absent), turns
every row of \`store.runs\` into \`{"window", "outcome", "reason"}\` and answers
\`{"schedule_id", "timezone", "rows", "stalled"}\`, \`stalled\` being more than \`STALL_S = 180\` seconds
since the newest row. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** Another tenant's schedule id, a pause that left no rows at all,
a ledger with months of rows, and a daily report that fired this morning.

- A schedule of another tenant is **404**, the same as one that does not exist.
- The rows cover the last **7 days** (\`HISTORY_DAYS\`): windows \`t\` with \`now - 7 days <= t < now\`.
- Rows come from what the cron expected, \`fires_between(spec, timezone, since, now)\`, plus any
  recorded window in range: an expected window with no ledger row is
  \`{"outcome": "misfire", "reason": "no_record"}\`. Oldest first.
- \`stalled\` is true when the newest \`STALL_WINDOWS = 3\` expected windows all have no row: silence
  measured in the schedule's own windows, not in seconds.`,
  sequence: {
    participants: ['Client', 'Scheduler API', 'Redis'],
    messages: [
      {from: 'Client', to: 'Scheduler API', label: 'GET /v1/schedules/{id}/history · X-Tenant-Id', kind: 'sync'},
      {from: 'Scheduler API', to: 'Redis', label: 'HGETALL schedule:{id}', kind: 'sync'},
      {from: 'Redis', to: 'Scheduler API', label: 'schedule · another tenant → 404', kind: 'reply'},
      {
        from: 'Scheduler API',
        to: 'Scheduler API',
        label: 'fires_between(spec, timezone, now - 7 d, now)',
        kind: 'sync',
      },
      {from: 'Scheduler API', to: 'Redis', label: 'HGETALL runs:{id}', kind: 'sync'},
      {
        from: 'Scheduler API',
        to: 'Client',
        label: '{rows: fired · error · skipped · misfire, stalled from the last 3 windows}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/schedules/{id}/history',
      detail:
        'A schedule of the caller answers 200 with its id, a `rows` list and a `stalled` flag; no `X-Tenant-Id` is 401.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/schedules\/\{schedule_id\}\/history["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/schedules\/:id\/history['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/schedules\/\{id\}\/history"/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/schedules\//]},
      },
    },
    {
      id: 'tenant-404',
      title: "Answers 404 for another tenant's schedule",
      detail:
        "Tenant t1 asking for t2's schedule gets the same 404 answer as for an id that does not exist. The starter loads the schedule by id alone.",
      match: {
        python: {all: [/\[["']tenant["']\]\s*!=\s*tenant|tenant\s*!=\s*\w+\[["']tenant["']\]/]},
        typescript: {all: [/\.tenant\s*!==?\s*tenant|tenant\s*!==?\s*\w+\.tenant/]},
        go: {all: [/\.Tenant\s*!=\s*tenant|tenant\s*!=\s*\w+\.Tenant/]},
        cpp: {all: [/(\.|->)tenant\s*!=\s*tenant|tenant\s*!=\s*\w+(\.|->)tenant/]},
      },
    },
    {
      id: 'misfires',
      title: 'Shows expected windows with no row as misfires',
      detail:
        'An hourly schedule with two windows missing from the ledger shows them as `misfire`/`no_record` among the fired and skipped rows, and a recorded window off the cron is listed too; a daily Asia/Tokyo schedule with no rows shows its 09:00 Tokyo windows. The starter lists ledger rows only.',
      match: {
        python: {all: [/fires_between\(/, /["']misfire["']/]},
        typescript: {all: [/firesBetween\(/, /['"]misfire['"]/]},
        go: {all: [/cron\.FiresBetween\(/, /"misfire"/]},
        cpp: {all: [/cron::FiresBetween\(/, /"misfire"/]},
      },
    },
    {
      id: 'history-window',
      title: 'Bounds the history to the last 7 days',
      detail:
        'At the top of an hour, the window exactly 7 days ago is listed and the one starting now is not; ledger rows from 8 and 10 days ago are left out; the rows are exactly the windows of the last 7 days. The starter returns the whole ledger.',
      match: {
        python: {all: [/HISTORY_DAYS/]},
        typescript: {all: [/HISTORY_DAYS/]},
        go: {all: [/historyDays/]},
        cpp: {all: [/kHistoryDays/]},
      },
    },
    {
      id: 'stall-flag',
      title: "Measures a stall in the schedule's own windows",
      detail:
        'A daily schedule that fired this morning is not stalled; a quarter-hourly one whose last three windows have no row is, one missing only its last two (after an older gap of three) is not, and one whose last three windows hold error rows is not. The starter flags anything quiet for 180 s.',
      match: {
        python: {all: [/STALL_WINDOWS/], none: [/STALL_S\b/]},
        typescript: {all: [/STALL_WINDOWS/], none: [/STALL_S\b/]},
        go: {all: [/stallWindows/], none: [/stallS\b/]},
        cpp: {all: [/kStallWindows/], none: [/kStallS\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from cronsched.cron import format_instant
from cronsched.store import store

STALL_S = 180

app = FastAPI()


@app.get("/v1/schedules/{schedule_id}/history")
def schedule_history(schedule_id: str, request: Request) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id")
    if not tenant:
        return JSONResponse({"error": "missing_tenant"}, status_code=401)
    schedule = store.get(schedule_id)
    if schedule is None:
        return JSONResponse({"error": "not_found"}, status_code=404)
    runs = store.runs(schedule_id)
    rows = [{"window": format_instant(run["window"]), "outcome": run["outcome"], "reason": run["reason"]} for run in runs]
    now = int(time.time())
    stalled = bool(runs) and now - runs[-1]["window"] > STALL_S
    return JSONResponse({"schedule_id": schedule_id, "timezone": schedule["timezone"], "rows": rows, "stalled": stalled})
`,
      solution: `import time

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from cronsched.cron import fires_between, format_instant, parse
from cronsched.store import store

HISTORY_DAYS = 7
STALL_WINDOWS = 3

app = FastAPI()


@app.get("/v1/schedules/{schedule_id}/history")
def schedule_history(schedule_id: str, request: Request) -> JSONResponse:
    tenant = request.headers.get("x-tenant-id")
    if not tenant:
        return JSONResponse({"error": "missing_tenant"}, status_code=401)
    schedule = store.get(schedule_id)
    # Another tenant's schedule answers like a missing one: the id alone reveals nothing.
    if schedule is None or schedule["tenant"] != tenant:
        return JSONResponse({"error": "not_found"}, status_code=404)
    now = int(time.time())
    since = now - HISTORY_DAYS * 86400
    spec = parse(schedule["cron"])
    # What the cron owed is the baseline: a window nobody ran has no ledger row to list.
    expected = fires_between(spec, schedule["timezone"], since, now) if spec else []
    recorded = {run["window"]: run for run in store.runs(schedule_id) if since <= run["window"] < now}
    rows = []
    for window in sorted(set(expected) | set(recorded)):
        run = recorded.get(window, {"outcome": "misfire", "reason": "no_record"})
        rows.append({"window": format_instant(window), "outcome": run["outcome"], "reason": run["reason"]})
    recent = expected[-STALL_WINDOWS:]
    stalled = len(recent) == STALL_WINDOWS and all(window not in recorded for window in recent)
    return JSONResponse({"schedule_id": schedule_id, "timezone": schedule["timezone"], "rows": rows, "stalled": stalled})
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {formatInstant} from 'cronsched/cron';
import {store} from 'cronsched/store';

export const STALL_S = 180;

export const app = Fastify();

app.get('/v1/schedules/:id/history', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing_tenant'});
  const {id} = request.params as {id: string};
  const schedule = await store.get(id);
  if (schedule === null) return reply.code(404).send({error: 'not_found'});
  const runs = await store.runs(id);
  const rows = runs.map(run => ({window: formatInstant(run.window), outcome: run.outcome, reason: run.reason}));
  const now = Math.floor(Date.now() / 1000);
  const stalled = runs.length > 0 && now - runs[runs.length - 1].window > STALL_S;
  return reply.code(200).send({schedule_id: id, timezone: schedule.timezone, rows, stalled});
});
`,
      solution: `import Fastify from 'fastify';

import {firesBetween, formatInstant, parse} from 'cronsched/cron';
import {type Run, store} from 'cronsched/store';

export const HISTORY_DAYS = 7;
export const STALL_WINDOWS = 3;

export const app = Fastify();

app.get('/v1/schedules/:id/history', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing_tenant'});
  const {id} = request.params as {id: string};
  const schedule = await store.get(id);
  // Another tenant's schedule answers like a missing one: the id alone reveals nothing.
  if (schedule === null || schedule.tenant !== tenant) return reply.code(404).send({error: 'not_found'});
  const now = Math.floor(Date.now() / 1000);
  const since = now - HISTORY_DAYS * 86400;
  const spec = parse(schedule.cron);
  // What the cron owed is the baseline: a window nobody ran has no ledger row to list.
  const expected = spec === null ? [] : firesBetween(spec, schedule.timezone, since, now);
  const recorded = new Map<number, Run>();
  for (const run of await store.runs(id)) if (since <= run.window && run.window < now) recorded.set(run.window, run);
  const windows = [...new Set([...expected, ...recorded.keys()])].sort((a, b) => a - b);
  const rows = windows.map(window => {
    const run = recorded.get(window);
    return {window: formatInstant(window), outcome: run?.outcome ?? 'misfire', reason: run?.reason ?? 'no_record'};
  });
  const recent = expected.slice(-STALL_WINDOWS);
  const stalled = recent.length === STALL_WINDOWS && recent.every(window => !recorded.has(window));
  return reply.code(200).send({schedule_id: id, timezone: schedule.timezone, rows, stalled});
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"cronsched/cron"
	"cronsched/store"
)

const stallS = 180

type historyRow struct {
	Window  string \`json:"window"\`
	Outcome string \`json:"outcome"\`
	Reason  string \`json:"reason"\`
}

type historyResponse struct {
	ScheduleID string       \`json:"schedule_id"\`
	Timezone   string       \`json:"timezone"\`
	Rows       []historyRow \`json:"rows"\`
	Stalled    bool         \`json:"stalled"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func scheduleHistory(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing_tenant"})
		return
	}
	id := r.PathValue("id")
	s, err := store.Get(r.Context(), id)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	if s == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not_found"})
		return
	}
	runs, err := store.Runs(r.Context(), id)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	rows := []historyRow{}
	for _, run := range runs {
		rows = append(rows, historyRow{cron.FormatInstant(run.Window), run.Outcome, run.Reason})
	}
	now := time.Now().Unix()
	stalled := len(runs) > 0 && now-runs[len(runs)-1].Window > stallS
	writeJSON(rw, http.StatusOK, historyResponse{ScheduleID: id, Timezone: s.Timezone, Rows: rows, Stalled: stalled})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/schedules/{id}/history", scheduleHistory)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"sort"
	"time"

	"cronsched/cron"
	"cronsched/store"
)

const (
	historyDays  = 7
	stallWindows = 3
)

type historyRow struct {
	Window  string \`json:"window"\`
	Outcome string \`json:"outcome"\`
	Reason  string \`json:"reason"\`
}

type historyResponse struct {
	ScheduleID string       \`json:"schedule_id"\`
	Timezone   string       \`json:"timezone"\`
	Rows       []historyRow \`json:"rows"\`
	Stalled    bool         \`json:"stalled"\`
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func scheduleHistory(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing_tenant"})
		return
	}
	id := r.PathValue("id")
	s, err := store.Get(r.Context(), id)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	// Another tenant's schedule answers like a missing one: the id alone reveals nothing.
	if s == nil || s.Tenant != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "not_found"})
		return
	}
	runs, err := store.Runs(r.Context(), id)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "try_again"})
		return
	}
	now := time.Now().Unix()
	since := now - historyDays*86400
	// What the cron owed is the baseline: a window nobody ran has no ledger row to list.
	var expected []int64
	if spec, ok := cron.Parse(s.Cron); ok {
		expected = cron.FiresBetween(spec, s.Timezone, since, now)
	}
	recorded := map[int64]store.Run{}
	for _, run := range runs {
		if since <= run.Window && run.Window < now {
			recorded[run.Window] = run
		}
	}
	windows := append([]int64(nil), expected...)
	for w := range recorded {
		if !containsWindow(expected, w) {
			windows = append(windows, w)
		}
	}
	sort.Slice(windows, func(i, j int) bool { return windows[i] < windows[j] })
	rows := []historyRow{}
	for _, w := range windows {
		row := historyRow{cron.FormatInstant(w), "misfire", "no_record"}
		if run, ok := recorded[w]; ok {
			row.Outcome, row.Reason = run.Outcome, run.Reason
		}
		rows = append(rows, row)
	}
	stalled := len(expected) >= stallWindows
	for _, w := range expected[max(0, len(expected)-stallWindows):] {
		if _, ok := recorded[w]; ok {
			stalled = false
		}
	}
	writeJSON(rw, http.StatusOK, historyResponse{ScheduleID: id, Timezone: s.Timezone, Rows: rows, Stalled: stalled})
}

func containsWindow(windows []int64, w int64) bool {
	for _, x := range windows {
		if x == w {
			return true
		}
	}
	return false
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/schedules/{id}/history", scheduleHistory)
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstdint>
#include <string>

#include "cronsched/cron.h"
#include "cronsched/store.h"

using json = nlohmann::json;

constexpr int64_t kStallS = 180;

static void fail(httplib::Response& res, int status, const std::string& code) {
  res.status = status;
  res.set_content(json{{"error", code}}.dump(), "application/json");
}

void scheduleHistory(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "missing_tenant");
  const std::string id = req.matches[1];
  const auto schedule = cronsched::store::Get(id);
  if (!schedule) return fail(res, 404, "not_found");
  const auto runs = cronsched::store::Runs(id);
  json rows = json::array();
  for (const auto& run : runs) {
    rows.push_back({{"window", cronsched::cron::FormatInstant(run.window)}, {"outcome", run.outcome}, {"reason", run.reason}});
  }
  const int64_t now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const bool stalled = !runs.empty() && now - runs.back().window > kStallS;
  res.status = 200;
  res.set_content(json{{"schedule_id", id}, {"timezone", schedule->timezone}, {"rows", rows}, {"stalled", stalled}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/schedules/([^/]+)/history)", scheduleHistory);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <vector>

#include "cronsched/cron.h"
#include "cronsched/store.h"

using json = nlohmann::json;

constexpr int64_t kHistoryDays = 7;
constexpr size_t kStallWindows = 3;

static void fail(httplib::Response& res, int status, const std::string& code) {
  res.status = status;
  res.set_content(json{{"error", code}}.dump(), "application/json");
}

void scheduleHistory(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return fail(res, 401, "missing_tenant");
  const std::string id = req.matches[1];
  const auto schedule = cronsched::store::Get(id);
  // Another tenant's schedule answers like a missing one: the id alone reveals nothing.
  if (!schedule || schedule->tenant != tenant) return fail(res, 404, "not_found");
  const int64_t now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const int64_t since = now - kHistoryDays * 86400;
  // What the cron owed is the baseline: a window nobody ran has no ledger row to list.
  std::vector<int64_t> expected;
  if (const auto spec = cronsched::cron::Parse(schedule->cron)) expected = cronsched::cron::FiresBetween(*spec, schedule->timezone, since, now);
  std::map<int64_t, cronsched::Run> recorded;
  for (const auto& run : cronsched::store::Runs(id)) {
    if (since <= run.window && run.window < now) recorded[run.window] = run;
  }
  std::set<int64_t> windows(expected.begin(), expected.end());
  for (const auto& [window, run] : recorded) windows.insert(window);
  json rows = json::array();
  for (const int64_t window : windows) {
    const auto it = recorded.find(window);
    rows.push_back({{"window", cronsched::cron::FormatInstant(window)},
                    {"outcome", it == recorded.end() ? "misfire" : it->second.outcome},
                    {"reason", it == recorded.end() ? "no_record" : it->second.reason}});
  }
  bool stalled = expected.size() >= kStallWindows;
  for (size_t i = expected.size() - std::min(expected.size(), kStallWindows); i < expected.size(); i++) {
    if (recorded.count(expected[i]) > 0) stalled = false;
  }
  res.status = 200;
  res.set_content(json{{"schedule_id", id}, {"timezone", schedule->timezone}, {"rows", rows}, {"stalled", stalled}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) {
  svr.Get(R"(/v1/schedules/([^/]+)/history)", scheduleHistory);
}
`,
    },
  },
  harness: {
    python: `import time

from cronsched.cron import fires_between, format_instant, parse
from cronsched.store import store

DAY = 86400


def _schedule(schedule_id, cron, timezone="UTC", tenant="t1"):
    store.put({"id": schedule_id, "tenant": tenant, "cron": cron, "timezone": timezone, "job_ref": "billing.invoice", "misfire_policy": "skip", "next_fire": ""})


def _expected(cron, timezone="UTC"):
    now = int(time.time())
    return fires_between(parse(cron), timezone, now - 7 * DAY, now)


async def _get(ctx, schedule_id, headers=None):
    m = ctx.load("read")
    async with ctx.client(m.app) as c:
        return await c.get(f"/v1/schedules/{schedule_id}/history", headers={"X-Tenant-Id": "t1"} if headers is None else headers)


def _rows(r):
    body = r.json()
    assert isinstance(body.get("rows"), list), f"the answer must carry a rows list: {r.text[:300]}"
    return [(row.get("window"), row.get("outcome"), row.get("reason")) for row in body["rows"]]


async def check_route(ctx):
    _schedule("s1", "0 * * * *")
    r = await _get(ctx, "s1")
    assert r.status_code == 200, f"GET /v1/schedules/s1/history answered {r.status_code}: {r.text[:300]}"
    body = r.json()
    assert body.get("schedule_id") == "s1" and isinstance(body.get("stalled"), bool), f"the answer must carry schedule_id s1 and a stalled flag: {r.text[:300]}"
    _rows(r)
    r = await _get(ctx, "s1", headers={})
    assert r.status_code == 401, f"a request without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_tenant_404(ctx):
    _schedule("s2", "0 * * * *", tenant="t2")
    missing = await _get(ctx, "nope")
    assert missing.status_code == 404, f"an unknown schedule answered {missing.status_code}, expected 404"
    r = await _get(ctx, "s2")
    assert r.status_code == 404, f"tenant t1 reading t2's schedule s2 answered {r.status_code}, expected 404: an id must not open another tenant's history"
    assert r.text.replace("s2", "{id}") == missing.text.replace("nope", "{id}"), f"t2's schedule answered {r.text[:200]} and an unknown id {missing.text[:200]}: a different answer tells t1 the id exists"


async def check_misfires(ctx):
    _schedule("s1", "0 * * * *")
    expected = _expected("0 * * * *")
    for w in expected:
        store.record_run("s1", w, "fired", "")
    store.record_run("s1", expected[-20], "skipped", "policy_skip")
    missing = [expected[-10], expected[-5]]
    for w in missing:
        ctx.redis.hdel("runs:s1", str(w))
    manual = expected[-30] + 1800  # a recorded window off the hourly cron, at :30
    store.record_run("s1", manual, "fired", "")
    rows = _rows(await _get(ctx, "s1"))
    assert len(rows) == len(expected) + 1, f"an hourly schedule's last 7 days list {len(rows)} rows, expected one per expected window plus the recorded :30 window, {len(expected) + 1}: two windows have no ledger row and must still appear"
    by_window = {w: (o, r) for w, o, r in rows}
    for w in missing:
        assert by_window.get(format_instant(w)) == ("misfire", "no_record"), f"window {format_instant(w)} has no ledger row and shows as {by_window.get(format_instant(w))}, expected misfire/no_record"
    assert by_window.get(format_instant(expected[-20])) == ("skipped", "policy_skip"), f"the skipped window shows as {by_window.get(format_instant(expected[-20]))}"
    assert by_window.get(format_instant(manual)) == ("fired", ""), f"the recorded window {format_instant(manual)}, off the cron but in range, shows as {by_window.get(format_instant(manual))}, expected its ledger row"
    assert [w for w, _, _ in rows] == [format_instant(w) for w in sorted(expected + [manual])], "the rows must be the expected and the recorded windows, oldest first"
    _schedule("s3", "0 9 * * *", timezone="Asia/Tokyo")
    tokyo = _expected("0 9 * * *", "Asia/Tokyo")
    rows = _rows(await _get(ctx, "s3"))
    assert rows == [(format_instant(w), "misfire", "no_record") for w in tokyo], f"a daily 09:00 Asia/Tokyo schedule with no ledger rows lists {rows}, expected a misfire at each 09:00 Tokyo (00:00Z): {[format_instant(w) for w in tokyo]}"


async def check_history_window(ctx):
    # Now is the top of an hour: the hourly fire now - 7 days is in the history, the one at now is not yet.
    ctx.clock.advance(3600 - int(time.time()) % 3600)
    now = int(time.time())
    _schedule("s1", "0 * * * *")
    expected = _expected("0 * * * *")
    assert expected[0] == now - 7 * DAY, "harness: the first expected window is not now - 7 days"
    for w in expected + [now]:
        store.record_run("s1", w, "fired", "")
    old = [expected[0] - 3 * DAY, expected[0] - DAY]  # 10 and 8 days ago
    for w in old:
        store.record_run("s1", w, "fired", "")
    rows = _rows(await _get(ctx, "s1"))
    listed = [w for w, _, _ in rows]
    assert not set(listed) & {format_instant(w) for w in old}, f"rows from 8 and 10 days ago are listed ({sorted(set(listed) & {format_instant(w) for w in old})}): the history covers the last 7 days"
    assert format_instant(now) not in listed, f"the window {format_instant(now)}, which starts now, is listed: the history covers now - 7 days <= window < now"
    assert format_instant(now - 7 * DAY) in listed, f"the window {format_instant(now - 7 * DAY)}, exactly 7 days ago, is missing: the history covers now - 7 days <= window < now"
    assert listed == [format_instant(w) for w in expected], f"the history lists {len(rows)} rows, expected the {len(expected)} windows of the last 7 days, oldest first"


async def check_stall_flag(ctx):
    now = int(time.time())
    hour = (time.gmtime(now).tm_hour - 2) % 24
    daily = f"0 {hour} * * *"  # fired about two hours ago
    _schedule("d1", daily)
    for w in _expected(daily):
        store.record_run("d1", w, "fired", "")
    r = await _get(ctx, "d1")
    assert r.json().get("stalled") is False, f"a daily schedule that fired at {hour:02d}:00 today answered stalled={r.json().get('stalled')!r}: two quiet hours are not a stall for a job that runs once a day"
    expected = _expected("*/15 * * * *")
    for schedule_id in ("q1", "q2", "q3"):
        _schedule(schedule_id, "*/15 * * * *")
    for w in expected[:-3]:
        store.record_run("q1", w, "fired", "")
    # q2 missed three windows a day ago and has run since, but not its last two.
    for w in expected[:-100] + expected[-97:-2]:
        store.record_run("q2", w, "fired", "")
    # q3 ran its last three windows, and they failed: an error is a row, not silence.
    for w in expected[:-3]:
        store.record_run("q3", w, "fired", "")
    for w in expected[-3:]:
        store.record_run("q3", w, "error", "trigger_failed")
    r = await _get(ctx, "q1")
    assert r.json().get("stalled") is True, f"a quarter-hourly schedule whose last 3 windows have no row answered stalled={r.json().get('stalled')!r}, expected true"
    r = await _get(ctx, "q2")
    assert r.json().get("stalled") is False, f"a quarter-hourly schedule missing only its last 2 windows (and 3 windows a day ago) answered stalled={r.json().get('stalled')!r}, expected false: the stall is the newest 3 windows"
    r = await _get(ctx, "q3")
    assert r.json().get("stalled") is False, f"a quarter-hourly schedule whose last 3 windows each have an error row answered stalled={r.json().get('stalled')!r}, expected false: a stall is windows with no row at all"
`,
    typescript: `import {firesBetween, formatInstant, parse} from 'cronsched/cron';
import {store} from 'cronsched/store';

const DAY = 86400;

const put = (id: string, cron: string, timezone = 'UTC', tenant = 't1') =>
  store.put({id, tenant, cron, timezone, job_ref: 'billing.invoice', misfire_policy: 'skip', next_fire: ''});

const expectedWindows = (cron: string, timezone = 'UTC'): number[] => {
  const now = Math.floor(Date.now() / 1000);
  return firesBetween(parse(cron), timezone, now - 7 * DAY, now);
};

const read = ctx => ctx.client(ctx.load('read').app);

const get = (c, id: string, headers: Record<string, string> = {'X-Tenant-Id': 't1'}) => c.get(\`/v1/schedules/\${id}/history\`, {headers});

const rowsOf = (r): string[][] => {
  const body = r.json();
  assert(Array.isArray(body.rows), \`the answer must carry a rows list: \${r.text.slice(0, 300)}\`);
  return body.rows.map(row => [row.window, row.outcome, row.reason]);
};

export async function check_route(ctx) {
  await put('s1', '0 * * * *');
  const c = read(ctx);
  let r = await get(c, 's1');
  assert.equal(r.status, 200, \`GET /v1/schedules/s1/history answered \${r.status}: \${r.text.slice(0, 300)}\`);
  assert(r.json().schedule_id === 's1' && typeof r.json().stalled === 'boolean', \`the answer must carry schedule_id s1 and a stalled flag: \${r.text.slice(0, 300)}\`);
  rowsOf(r);
  r = await get(c, 's1', {});
  assert.equal(r.status, 401, \`a request without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_tenant_404(ctx) {
  await put('s2', '0 * * * *', 'UTC', 't2');
  const c = read(ctx);
  const missing = await get(c, 'nope');
  assert.equal(missing.status, 404, \`an unknown schedule answered \${missing.status}, expected 404\`);
  const r = await get(c, 's2');
  assert.equal(r.status, 404, \`tenant t1 reading t2's schedule s2 answered \${r.status}, expected 404: an id must not open another tenant's history\`);
  assert.equal(r.text.replaceAll('s2', '{id}'), missing.text.replaceAll('nope', '{id}'), \`t2's schedule answered \${r.text.slice(0, 200)} and an unknown id \${missing.text.slice(0, 200)}: a different answer tells t1 the id exists\`);
}

export async function check_misfires(ctx) {
  await put('s1', '0 * * * *');
  const expected = expectedWindows('0 * * * *');
  for (const w of expected) await store.recordRun('s1', w, 'fired', '');
  const skipped = expected[expected.length - 20];
  await store.recordRun('s1', skipped, 'skipped', 'policy_skip');
  const missing = [expected[expected.length - 10], expected[expected.length - 5]];
  for (const w of missing) ctx.redis.hdel('runs:s1', String(w));
  const manual = expected[expected.length - 30] + 1800; // a recorded window off the hourly cron, at :30
  await store.recordRun('s1', manual, 'fired', '');
  const c = read(ctx);
  let rows = rowsOf(await get(c, 's1'));
  assert.equal(rows.length, expected.length + 1, \`an hourly schedule's last 7 days list \${rows.length} rows, expected one per expected window plus the recorded :30 window, \${expected.length + 1}: two windows have no ledger row and must still appear\`);
  const byWindow = new Map(rows.map(([w, o, r]) => [w, \`\${o}/\${r}\`]));
  for (const w of missing) {
    assert.equal(byWindow.get(formatInstant(w)), 'misfire/no_record', \`window \${formatInstant(w)} has no ledger row and shows as \${byWindow.get(formatInstant(w))}, expected misfire/no_record\`);
  }
  assert.equal(byWindow.get(formatInstant(skipped)), 'skipped/policy_skip', \`the skipped window shows as \${byWindow.get(formatInstant(skipped))}\`);
  assert.equal(byWindow.get(formatInstant(manual)), 'fired/', \`the recorded window \${formatInstant(manual)}, off the cron but in range, shows as \${byWindow.get(formatInstant(manual))}, expected its ledger row\`);
  const listed = [...expected, manual].sort((a, b) => a - b).map(formatInstant);
  assert.deepEqual(rows.map(([w]) => w), listed, 'the rows must be the expected and the recorded windows, oldest first');
  await put('s3', '0 9 * * *', 'Asia/Tokyo');
  const tokyo = expectedWindows('0 9 * * *', 'Asia/Tokyo');
  rows = rowsOf(await get(c, 's3'));
  assert.deepEqual(rows, tokyo.map(w => [formatInstant(w), 'misfire', 'no_record']), \`a daily 09:00 Asia/Tokyo schedule with no ledger rows lists \${JSON.stringify(rows)}, expected a misfire at each 09:00 Tokyo (00:00Z): \${JSON.stringify(tokyo.map(formatInstant))}\`);
}

export async function check_history_window(ctx) {
  // Now is the top of an hour: the hourly fire now - 7 days is in the history, the one at now is not yet.
  ctx.clock.advance(3600 - (Math.floor(Date.now() / 1000) % 3600));
  const now = Math.floor(Date.now() / 1000);
  await put('s1', '0 * * * *');
  const expected = expectedWindows('0 * * * *');
  assert.equal(expected[0], now - 7 * DAY, 'harness: the first expected window is not now - 7 days');
  for (const w of [...expected, now]) await store.recordRun('s1', w, 'fired', '');
  const old = [expected[0] - 3 * DAY, expected[0] - DAY]; // 10 and 8 days ago
  for (const w of old) await store.recordRun('s1', w, 'fired', '');
  const rows = rowsOf(await get(read(ctx), 's1'));
  const listed = rows.map(([w]) => w);
  const leaked = listed.filter(w => old.map(formatInstant).includes(w));
  assert.deepEqual(leaked, [], \`rows from 8 and 10 days ago are listed (\${JSON.stringify(leaked)}): the history covers the last 7 days\`);
  assert(!listed.includes(formatInstant(now)), \`the window \${formatInstant(now)}, which starts now, is listed: the history covers now - 7 days <= window < now\`);
  assert(listed.includes(formatInstant(now - 7 * DAY)), \`the window \${formatInstant(now - 7 * DAY)}, exactly 7 days ago, is missing: the history covers now - 7 days <= window < now\`);
  assert.deepEqual(listed, expected.map(formatInstant), \`the history lists \${rows.length} rows, expected the \${expected.length} windows of the last 7 days, oldest first\`);
}

export async function check_stall_flag(ctx) {
  const c = read(ctx);
  const hour = (new Date(Date.now()).getUTCHours() + 22) % 24;
  const daily = \`0 \${hour} * * *\`; // fired about two hours ago
  await put('d1', daily);
  for (const w of expectedWindows(daily)) await store.recordRun('d1', w, 'fired', '');
  let r = await get(c, 'd1');
  assert.equal(r.json().stalled, false, \`a daily schedule that fired at \${String(hour).padStart(2, '0')}:00 today answered stalled=\${JSON.stringify(r.json().stalled)}: two quiet hours are not a stall for a job that runs once a day\`);
  const expected = expectedWindows('*/15 * * * *');
  for (const id of ['q1', 'q2', 'q3']) await put(id, '*/15 * * * *');
  for (const w of expected.slice(0, -3)) await store.recordRun('q1', w, 'fired', '');
  // q2 missed three windows a day ago and has run since, but not its last two.
  for (const w of [...expected.slice(0, -100), ...expected.slice(-97, -2)]) await store.recordRun('q2', w, 'fired', '');
  // q3 ran its last three windows, and they failed: an error is a row, not silence.
  for (const w of expected.slice(0, -3)) await store.recordRun('q3', w, 'fired', '');
  for (const w of expected.slice(-3)) await store.recordRun('q3', w, 'error', 'trigger_failed');
  r = await get(c, 'q1');
  assert.equal(r.json().stalled, true, \`a quarter-hourly schedule whose last 3 windows have no row answered stalled=\${JSON.stringify(r.json().stalled)}, expected true\`);
  r = await get(c, 'q2');
  assert.equal(r.json().stalled, false, \`a quarter-hourly schedule missing only its last 2 windows (and 3 windows a day ago) answered stalled=\${JSON.stringify(r.json().stalled)}, expected false: the stall is the newest 3 windows\`);
  r = await get(c, 'q3');
  assert.equal(r.json().stalled, false, \`a quarter-hourly schedule whose last 3 windows each have an error row answered stalled=\${JSON.stringify(r.json().stalled)}, expected false: a stall is windows with no row at all\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"leetbuild/harness"

	"cronsched/cron"
	"cronsched/store"
)

const kHReadDay int64 = 86400

func hReadPut(ctx *harness.Ctx, id, expr, timezone, tenant string) {
	s := &store.Schedule{ID: id, Tenant: tenant, Cron: expr, Timezone: timezone, JobRef: "billing.invoice", MisfirePolicy: "skip"}
	ctx.NoError(store.Put(context.Background(), s), "storing the schedule")
}

func hReadRecord(ctx *harness.Ctx, id string, window int64, outcome, reason string) {
	ctx.NoError(store.RecordRun(context.Background(), id, window, outcome, reason), "writing the ledger")
}

func hReadExpected(expr, timezone string) []int64 {
	now := time.Now().Unix()
	spec, _ := cron.Parse(expr)
	return cron.FiresBetween(spec, timezone, now-7*kHReadDay, now)
}

func hReadClient(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

type HReadHistoryBody struct {
	ScheduleID string \`json:"schedule_id"\`
	Rows       []struct {
		Window  string \`json:"window"\`
		Outcome string \`json:"outcome"\`
		Reason  string \`json:"reason"\`
	} \`json:"rows"\`
	Stalled *bool \`json:"stalled"\`
}

func hReadGet(ctx *harness.Ctx, c *harness.HTTP, id string) HReadHistoryBody {
	r := c.Get("/v1/schedules/"+id+"/history", "X-Tenant-Id", "t1")
	ctx.Equal(r.Status, 200, "GET /v1/schedules/%s/history", id)
	var body HReadHistoryBody
	ctx.NoError(json.Unmarshal(r.Body, &body), "the answer must be JSON with schedule_id, rows and stalled")
	ctx.Assert(body.Rows != nil && body.Stalled != nil, "the answer must carry a rows list and a stalled flag")
	return body
}

func hReadRows(body HReadHistoryBody) []string {
	out := []string{}
	for _, row := range body.Rows {
		out = append(out, row.Window+" "+row.Outcome+"/"+row.Reason)
	}
	return out
}

func CheckRoute(ctx *harness.Ctx) {
	hReadPut(ctx, "s1", "0 * * * *", "UTC", "t1")
	c := hReadClient(ctx)
	body := hReadGet(ctx, c, "s1")
	ctx.Equal(body.ScheduleID, "s1", "the answer's schedule_id")
	r := c.Get("/v1/schedules/s1/history")
	ctx.Equal(r.Status, 401, "a request without X-Tenant-Id")
}

func CheckTenant404(ctx *harness.Ctx) {
	hReadPut(ctx, "s2", "0 * * * *", "UTC", "t2")
	c := hReadClient(ctx)
	missing := c.Get("/v1/schedules/nope/history", "X-Tenant-Id", "t1")
	ctx.Equal(missing.Status, 404, "an unknown schedule")
	r := c.Get("/v1/schedules/s2/history", "X-Tenant-Id", "t1")
	ctx.Assert(r.Status == 404, "tenant t1 reading t2's schedule s2 answered %d, expected 404: an id must not open another tenant's history", r.Status)
	foreign, unknown := strings.ReplaceAll(string(r.Body), "s2", "{id}"), strings.ReplaceAll(string(missing.Body), "nope", "{id}")
	ctx.Assert(foreign == unknown, "t2's schedule answered %s and an unknown id %s: a different answer tells t1 the id exists", string(r.Body), string(missing.Body))
}

func CheckMisfires(ctx *harness.Ctx) {
	hReadPut(ctx, "s1", "0 * * * *", "UTC", "t1")
	expected := hReadExpected("0 * * * *", "UTC")
	for _, w := range expected {
		hReadRecord(ctx, "s1", w, "fired", "")
	}
	skipped := expected[len(expected)-20]
	hReadRecord(ctx, "s1", skipped, "skipped", "policy_skip")
	missing := []int64{expected[len(expected)-10], expected[len(expected)-5]}
	for _, w := range missing {
		ctx.Redis.Do("HDEL", "runs:s1", strconv.FormatInt(w, 10))
	}
	manual := expected[len(expected)-30] + 1800 // a recorded window off the hourly cron, at :30
	hReadRecord(ctx, "s1", manual, "fired", "")
	c := hReadClient(ctx)
	rows := hReadRows(hReadGet(ctx, c, "s1"))
	ctx.Assert(len(rows) == len(expected)+1, "an hourly schedule's last 7 days list %d rows, expected one per expected window plus the recorded :30 window, %d: two windows have no ledger row and must still appear", len(rows), len(expected)+1)
	want := []string{}
	for _, w := range expected {
		row := cron.FormatInstant(w) + " fired/"
		if w == skipped {
			row = cron.FormatInstant(w) + " skipped/policy_skip"
		}
		if w == missing[0] || w == missing[1] {
			row = cron.FormatInstant(w) + " misfire/no_record"
		}
		want = append(want, row)
		if w+1800 == manual {
			want = append(want, cron.FormatInstant(manual)+" fired/")
		}
	}
	ctx.Equal(rows, want, "the rows (every expected window and the recorded :30 window, off the cron but in range, oldest first; the two without a ledger row as misfire/no_record)")
	hReadPut(ctx, "s3", "0 9 * * *", "Asia/Tokyo", "t1")
	tokyo := []string{}
	for _, w := range hReadExpected("0 9 * * *", "Asia/Tokyo") {
		tokyo = append(tokyo, cron.FormatInstant(w)+" misfire/no_record")
	}
	ctx.Equal(hReadRows(hReadGet(ctx, c, "s3")), tokyo, "a daily 09:00 Asia/Tokyo schedule with no ledger rows must list a misfire at each 09:00 Tokyo (00:00Z); the rows")
}

func CheckHistoryWindow(ctx *harness.Ctx) {
	// Now is the top of an hour: the hourly fire now - 7 days is in the history, the one at now is not yet.
	ctx.Clock.Advance(float64(3600 - time.Now().Unix()%3600))
	now := time.Now().Unix()
	hReadPut(ctx, "s1", "0 * * * *", "UTC", "t1")
	expected := hReadExpected("0 * * * *", "UTC")
	ctx.Equal(expected[0], now-7*kHReadDay, "harness: the first expected window (now - 7 days)")
	for _, w := range append(append([]int64(nil), expected...), now) {
		hReadRecord(ctx, "s1", w, "fired", "")
	}
	old := []int64{expected[0] - 3*kHReadDay, expected[0] - kHReadDay} // 10 and 8 days ago
	for _, w := range old {
		hReadRecord(ctx, "s1", w, "fired", "")
	}
	listed := []string{}
	for _, row := range hReadGet(ctx, hReadClient(ctx), "s1").Rows {
		listed = append(listed, row.Window)
	}
	has := func(w int64) bool {
		for _, l := range listed {
			if l == cron.FormatInstant(w) {
				return true
			}
		}
		return false
	}
	for _, w := range old {
		ctx.Assert(!has(w), "the row for %s, older than 7 days, is listed: the history covers the last 7 days", cron.FormatInstant(w))
	}
	ctx.Assert(!has(now), "the window %s, which starts now, is listed: the history covers now - 7 days <= window < now", cron.FormatInstant(now))
	ctx.Assert(has(now-7*kHReadDay), "the window %s, exactly 7 days ago, is missing: the history covers now - 7 days <= window < now", cron.FormatInstant(now-7*kHReadDay))
	want := []string{}
	for _, w := range expected {
		want = append(want, cron.FormatInstant(w))
	}
	ctx.Equal(listed, want, "the history's rows (the windows of the last 7 days, oldest first)")
}

func CheckStallFlag(ctx *harness.Ctx) {
	c := hReadClient(ctx)
	hour := (time.Now().UTC().Hour() + 22) % 24
	daily := fmt.Sprintf("0 %d * * *", hour) // fired about two hours ago
	hReadPut(ctx, "d1", daily, "UTC", "t1")
	for _, w := range hReadExpected(daily, "UTC") {
		hReadRecord(ctx, "d1", w, "fired", "")
	}
	stalled := *hReadGet(ctx, c, "d1").Stalled
	ctx.Assert(!stalled, "a daily schedule that fired at %02d:00 today answered stalled=true: two quiet hours are not a stall for a job that runs once a day", hour)
	expected := hReadExpected("*/15 * * * *", "UTC")
	n := len(expected)
	for _, id := range []string{"q1", "q2", "q3"} {
		hReadPut(ctx, id, "*/15 * * * *", "UTC", "t1")
	}
	for _, w := range expected[:n-3] {
		hReadRecord(ctx, "q1", w, "fired", "")
	}
	// q2 missed three windows a day ago and has run since, but not its last two.
	for i, w := range expected[:n-2] {
		if i < n-100 || i >= n-97 {
			hReadRecord(ctx, "q2", w, "fired", "")
		}
	}
	// q3 ran its last three windows, and they failed: an error is a row, not silence.
	for i, w := range expected {
		if i < n-3 {
			hReadRecord(ctx, "q3", w, "fired", "")
		} else {
			hReadRecord(ctx, "q3", w, "error", "trigger_failed")
		}
	}
	ctx.Assert(*hReadGet(ctx, c, "q1").Stalled, "a quarter-hourly schedule whose last 3 windows have no row answered stalled=false, expected true")
	ctx.Assert(!*hReadGet(ctx, c, "q2").Stalled, "a quarter-hourly schedule missing only its last 2 windows (and 3 windows a day ago) answered stalled=true, expected false: the stall is the newest 3 windows")
	ctx.Assert(!*hReadGet(ctx, c, "q3").Stalled, "a quarter-hourly schedule whose last 3 windows each have an error row answered stalled=true, expected false: a stall is windows with no row at all")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include "cronsched/cron.h"
#include "cronsched/store.h"

namespace {

constexpr int64_t kHReadDay = 86400;

int64_t hReadClockNow() {
  return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

void hReadPut(const std::string& id, const std::string& expr, const std::string& timezone = "UTC", const std::string& tenant = "t1") {
  cronsched::store::Put(cronsched::Schedule{id, tenant, expr, timezone, "billing.invoice", "skip", ""});
}

std::vector<int64_t> hReadExpected(const std::string& expr, const std::string& timezone = "UTC") {
  const int64_t now = hReadClockNow();
  return cronsched::cron::FiresBetween(*cronsched::cron::Parse(expr), timezone, now - 7 * kHReadDay, now);
}

harness::HTTP hReadClient(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

nlohmann::json hReadGet(harness::Ctx& ctx, harness::HTTP& c, const std::string& id) {
  const auto r = c.Get("/v1/schedules/" + id + "/history", "X-Tenant-Id", "t1");
  ctx.Equal(r.Status, 200, "GET /v1/schedules/%s/history", id);
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object() && body.contains("rows") && body["rows"].is_array() && body.contains("stalled") && body["stalled"].is_boolean(),
             "the answer must carry a rows list and a stalled flag: %s", r.Text().substr(0, 300));
  return body;
}

std::vector<std::string> hReadRows(const nlohmann::json& body) {
  std::vector<std::string> out;
  for (const auto& row : body["rows"]) {
    out.push_back(row.value("window", "") + " " + row.value("outcome", "") + "/" + row.value("reason", ""));
  }
  return out;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  hReadPut("s1", "0 * * * *");
  auto c = hReadClient(ctx);
  const auto body = hReadGet(ctx, c, "s1");
  ctx.Equal(body.value("schedule_id", ""), "s1", "the answer's schedule_id");
  const auto r = c.Get("/v1/schedules/s1/history");
  ctx.Equal(r.Status, 401, "a request without X-Tenant-Id");
}

void CheckTenant404(harness::Ctx& ctx) {
  hReadPut("s2", "0 * * * *", "UTC", "t2");
  auto c = hReadClient(ctx);
  const auto missing = c.Get("/v1/schedules/nope/history", "X-Tenant-Id", "t1");
  ctx.Equal(missing.Status, 404, "an unknown schedule");
  const auto r = c.Get("/v1/schedules/s2/history", "X-Tenant-Id", "t1");
  ctx.Assert(r.Status == 404, "tenant t1 reading t2's schedule s2 answered %d, expected 404: an id must not open another tenant's history", r.Status);
  // The two answers, each with its own id masked, must be the same.
  std::string foreign = r.Text();
  for (size_t at = foreign.find("s2"); at != std::string::npos; at = foreign.find("s2", at)) foreign.replace(at, 2, "{id}");
  std::string unknown = missing.Text();
  for (size_t at = unknown.find("nope"); at != std::string::npos; at = unknown.find("nope", at)) unknown.replace(at, 4, "{id}");
  ctx.Assert(foreign == unknown, "t2's schedule answered %s and an unknown id %s: a different answer tells t1 the id exists", r.Text(), missing.Text());
}

void CheckMisfires(harness::Ctx& ctx) {
  hReadPut("s1", "0 * * * *");
  const auto expected = hReadExpected("0 * * * *");
  for (const int64_t w : expected) cronsched::store::RecordRun("s1", w, "fired", "");
  const int64_t skipped = expected[expected.size() - 20];
  cronsched::store::RecordRun("s1", skipped, "skipped", "policy_skip");
  const std::vector<int64_t> missing = {expected[expected.size() - 10], expected[expected.size() - 5]};
  for (const int64_t w : missing) ctx.Redis.Do("HDEL", "runs:s1", std::to_string(w));
  const int64_t manual = expected[expected.size() - 30] + 1800;  // a recorded window off the hourly cron, at :30
  cronsched::store::RecordRun("s1", manual, "fired", "");
  auto c = hReadClient(ctx);
  const auto rows = hReadRows(hReadGet(ctx, c, "s1"));
  ctx.Assert(rows.size() == expected.size() + 1,
             "an hourly schedule's last 7 days list %d rows, expected one per expected window plus the recorded :30 window, %d: two windows "
             "have no ledger row and must still appear",
             rows.size(), expected.size() + 1);
  std::vector<std::string> want;
  for (const int64_t w : expected) {
    std::string outcome = "fired/";
    if (w == skipped) outcome = "skipped/policy_skip";
    if (w == missing[0] || w == missing[1]) outcome = "misfire/no_record";
    want.push_back(cronsched::cron::FormatInstant(w) + " " + outcome);
    if (w + 1800 == manual) want.push_back(cronsched::cron::FormatInstant(manual) + " fired/");
  }
  ctx.Equal(rows, want,
            "the rows (every expected window and the recorded :30 window, off the cron but in range, oldest first; the two without a "
            "ledger row as misfire/no_record)");
  hReadPut("s3", "0 9 * * *", "Asia/Tokyo");
  std::vector<std::string> tokyo;
  for (const int64_t w : hReadExpected("0 9 * * *", "Asia/Tokyo")) tokyo.push_back(cronsched::cron::FormatInstant(w) + " misfire/no_record");
  ctx.Equal(hReadRows(hReadGet(ctx, c, "s3")), tokyo,
            "a daily 09:00 Asia/Tokyo schedule with no ledger rows must list a misfire at each 09:00 Tokyo (00:00Z); the rows");
}

void CheckHistoryWindow(harness::Ctx& ctx) {
  // Now is the top of an hour: the hourly fire now - 7 days is in the history, the one at now is not yet.
  ctx.Clock.Advance(static_cast<double>(3600 - hReadClockNow() % 3600));
  const int64_t now = hReadClockNow();
  hReadPut("s1", "0 * * * *");
  const auto expected = hReadExpected("0 * * * *");
  ctx.Equal(expected[0], now - 7 * kHReadDay, "harness: the first expected window (now - 7 days)");
  for (const int64_t w : expected) cronsched::store::RecordRun("s1", w, "fired", "");
  cronsched::store::RecordRun("s1", now, "fired", "");
  const std::vector<int64_t> old = {expected[0] - 3 * kHReadDay, expected[0] - kHReadDay};  // 10 and 8 days ago
  for (const int64_t w : old) cronsched::store::RecordRun("s1", w, "fired", "");
  auto c = hReadClient(ctx);
  const auto body = hReadGet(ctx, c, "s1");
  std::vector<std::string> listed;
  for (const auto& row : body["rows"]) listed.push_back(row.value("window", ""));
  for (const int64_t w : old) {
    ctx.Assert(std::find(listed.begin(), listed.end(), cronsched::cron::FormatInstant(w)) == listed.end(),
               "the row for %s, older than 7 days, is listed: the history covers the last 7 days", cronsched::cron::FormatInstant(w));
  }
  ctx.Assert(std::find(listed.begin(), listed.end(), cronsched::cron::FormatInstant(now)) == listed.end(),
             "the window %s, which starts now, is listed: the history covers now - 7 days <= window < now", cronsched::cron::FormatInstant(now));
  ctx.Assert(std::find(listed.begin(), listed.end(), cronsched::cron::FormatInstant(now - 7 * kHReadDay)) != listed.end(),
             "the window %s, exactly 7 days ago, is missing: the history covers now - 7 days <= window < now",
             cronsched::cron::FormatInstant(now - 7 * kHReadDay));
  std::vector<std::string> want;
  for (const int64_t w : expected) want.push_back(cronsched::cron::FormatInstant(w));
  ctx.Equal(listed, want, "the history's rows (the windows of the last 7 days, oldest first)");
}

void CheckStallFlag(harness::Ctx& ctx) {
  auto c = hReadClient(ctx);
  const int hour = static_cast<int>(((hReadClockNow() % kHReadDay) / 3600 + 22) % 24);
  const std::string daily = "0 " + std::to_string(hour) + " * * *";  // fired about two hours ago
  hReadPut("d1", daily);
  for (const int64_t w : hReadExpected(daily)) cronsched::store::RecordRun("d1", w, "fired", "");
  ctx.Assert(!hReadGet(ctx, c, "d1")["stalled"].get<bool>(),
             "a daily schedule that fired at %d:00 today answered stalled=true: two quiet hours are not a stall for a job that runs once a day", hour);
  const auto expected = hReadExpected("*/15 * * * *");
  const size_t n = expected.size();
  for (const std::string id : {"q1", "q2", "q3"}) hReadPut(id, "*/15 * * * *");
  for (size_t i = 0; i + 3 < n; i++) cronsched::store::RecordRun("q1", expected[i], "fired", "");
  // q2 missed three windows a day ago and has run since, but not its last two.
  for (size_t i = 0; i + 2 < n; i++) {
    if (i + 100 >= n && i + 97 < n) continue;
    cronsched::store::RecordRun("q2", expected[i], "fired", "");
  }
  // q3 ran its last three windows, and they failed: an error is a row, not silence.
  for (size_t i = 0; i < n; i++) {
    if (i + 3 < n) {
      cronsched::store::RecordRun("q3", expected[i], "fired", "");
    } else {
      cronsched::store::RecordRun("q3", expected[i], "error", "trigger_failed");
    }
  }
  ctx.Assert(hReadGet(ctx, c, "q1")["stalled"].get<bool>(), "a quarter-hourly schedule whose last 3 windows have no row answered stalled=false, expected true");
  ctx.Assert(!hReadGet(ctx, c, "q2")["stalled"].get<bool>(),
             "a quarter-hourly schedule missing only its last 2 windows (and 3 windows a day ago) answered stalled=true, expected false: the "
             "stall is the newest 3 windows");
  ctx.Assert(!hReadGet(ctx, c, "q3")["stalled"].get<bool>(),
             "a quarter-hourly schedule whose last 3 windows each have an error row answered stalled=true, expected false: a stall is windows "
             "with no row at all");
}
`,
  },
  hints: [
    'On-call opens the history of a report that has not run since Friday and sees an empty list; another tenant reads it by guessing the id; the daily backup shows as stalled every afternoon.',
    'The ledger only has rows for windows somebody attempted, so a pause leaves nothing to list; and 180 seconds of quiet means a stall only for a job that fires every minute.',
    'Answer 404 when `schedule["tenant"] != tenant`; take `since = now - HISTORY_DAYS * 86400`, list `fires_between(spec, timezone, since, now)` merged with the ledger rows in range, `misfire`/`no_record` where none; stalled when the last `STALL_WINDOWS` expected windows have no row.',
  ],
  debrief: `A history built from the ledger can only show what happened, and the question an operator brings to it is what did not. Computing the windows the cron owed, with the same expression evaluation the scheduler uses, turns absence into a row; the misfire rows and the stall flag are the same arithmetic read two ways. Measuring a stall in windows instead of seconds is what keeps the flag meaningful for a schedule that runs once a minute and one that runs once a day. The 7-day bound keeps the read proportional to the question, and the tenant check keeps an id from being a key to someone else's operations. Production schedulers also alert on the stall flag rather than waiting for someone to read it, and page through longer histories instead of widening the window.`,
};
