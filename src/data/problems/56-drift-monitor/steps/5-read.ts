import type {Step} from '@/lib/types';

export const monitorReportStep: Step = {
  id: 'read',
  title: 'GET /v1/monitors/{id}/report: significance, not just a number',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'monitor', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/monitors/{monitor_id}/report\` on the monitor and
sketch stores (\`drift.store\`, \`drift.sketch\`, provided): it loads the monitor with
\`store.get_monitor(monitor_id)\`, reads the current window's live sketch and the frozen baseline,
and answers \`{"monitor_id", "metric", "distance", "significant": true}\` with their PSI distance. It
serves the demo and hides four flaws.

**Failure mode the checks target.** Any caller who guesses a monitor id reads another tenant's
drift; a reader cannot tell 50 samples from 50 000, or which window and baseline a number describes;
a distance of 0.6 on 50 samples is reported like a real shift; and \`significant\` is true whatever
the distance.

- The tenant comes from \`X-Tenant-Id\` (**401** without it), and the monitor is resolved with
  \`store.monitor_for(tenant, monitor_id)\`: a foreign or unknown id is **404**.
- The report carries \`sample_count\` and \`baseline_sample_count\` (the two sketches' totals),
  \`window_start\`, \`window_end\` and \`baseline\`.
- Below \`MIN_SAMPLES\` = 200 on either side, \`state\` is \`"insufficient_data"\`.
- \`threshold_crossed\` is \`sufficient and distance >= threshold\`; \`state\` is \`"drifting"\` when it
  holds and \`"ok"\` otherwise.`,
  sequence: {
    participants: ['Client', 'Drift Monitor', 'monitor store', 'Redis'],
    messages: [
      {from: 'Client', to: 'Drift Monitor', label: 'GET /v1/monitors/m-1/report · X-Tenant-Id: t1', kind: 'sync'},
      {from: 'Drift Monitor', to: 'monitor store', label: 'monitor_for(t1, m-1)', kind: 'sync'},
      {from: 'monitor store', to: 'Drift Monitor', label: 'monitor · none → 404', kind: 'reply'},
      {from: 'Drift Monitor', to: 'Redis', label: 'HGETALL sketch:live:t1:m-1:{window} · GET baseline', kind: 'sync'},
      {
        from: 'Drift Monitor',
        to: 'Client',
        label: '200 {state, distance, sample_count, baseline_sample_count, threshold_crossed}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/monitors/{id}/report',
      detail: 'Register `GET /v1/monitors/{monitor_id}/report`: it answers the PSI distance of the current window.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/monitors\/\{monitor_id\}\/report["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/monitors\/:monitorId\/report['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/monitors\/\{id\}\/report"/]},
        cpp: {all: [/svr\.Get\(\s*R?"\(?\/v1\/monitors\//]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Resolves the monitor inside the tenant',
      detail:
        'A missing `X-Tenant-Id` is **401** and the monitor is looked up with `monitor_for`/`monitorFor(tenant, id)`, so another tenant’s monitor is **404**, the same answer as an unknown id; a lookup by id alone (`get_monitor`) serves anyone’s drift.',
      match: {
        python: {all: [/store\.monitor_for\(\s*tenant/, /\b401\b/], none: [/store\.get_monitor\(/]},
        typescript: {all: [/monitorFor\(\s*tenant/, /\b401\b/], none: [/getMonitor\(/]},
        go: {all: [/store\.MonitorFor\(/, /StatusUnauthorized|\b401\b/], none: [/store\.GetMonitor\(/]},
        cpp: {all: [/store::monitorFor\(\s*tenant/, /\b401\b/], none: [/store::getMonitor\(/]},
      },
    },
    {
      id: 'sample-counts',
      title: 'Reports the sample counts, the window and the baseline',
      detail:
        'The report carries `sample_count`, `baseline_sample_count`, `window_start`, `window_end` and `baseline` next to the distance, the window being the monitor’s own `window_s`.',
      match: {
        python: {all: [/["']sample_count["']/, /["']baseline_sample_count["']/, /["']window_end["']/]},
        typescript: {all: [/sample_count:/, /baseline_sample_count:/, /window_end:/]},
        go: {all: [/"sample_count"/, /"baseline_sample_count"/, /"window_end"/]},
        cpp: {all: [/"sample_count"/, /"baseline_sample_count"/, /"window_end"/]},
      },
    },
    {
      id: 'insufficient-data',
      title: 'Calls out insufficient data below the sample floor',
      detail:
        'Fewer than `MIN_SAMPLES` = 200 samples on either side, the live window or the baseline, is `state: "insufficient_data"`, never a crossing; exactly 200 is enough.',
      match: {
        python: {all: [/MIN_SAMPLES\s*=\s*200\b/, /insufficient_data/]},
        typescript: {all: [/MIN_SAMPLES\s*=\s*200\b/, /insufficient_data/]},
        go: {all: [/minSamples\s*=\s*200\b/, /insufficient_data/]},
        cpp: {all: [/kMinSamples\s*=\s*200\b/, /insufficient_data/]},
      },
    },
    {
      id: 'threshold-crossed',
      title: 'Reports a crossing only for a sufficient, over-threshold window',
      detail:
        '`threshold_crossed` is computed from the sample floor and `distance >= threshold`, a distance equal to the threshold included, and `state` says `drifting` or `ok`; the starter answers `significant: true` for any distance.',
      match: {
        python: {
          all: [/["']threshold_crossed["']/, /distance\s*>=\s*monitor\[["']threshold["']\]/],
          none: [/["']significant["']/],
        },
        typescript: {all: [/threshold_crossed:/, /distance\s*>=\s*monitor\.threshold/], none: [/significant:/]},
        go: {all: [/"threshold_crossed"/, /distance\s*>=\s*monitor\.Threshold/], none: [/"significant"/]},
        cpp: {all: [/"threshold_crossed"/, /distance\s*>=\s*monitor(->|\.)threshold/], none: [/"significant"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, HTTPException, Request

from drift import sketch, store  # store.get_monitor, monitor_for; sketch.window_start, read_live, read_baseline, psi

app = FastAPI()


@app.get("/v1/monitors/{monitor_id}/report")
def monitor_report(monitor_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    monitor = store.get_monitor(monitor_id)
    if monitor is None:
        raise HTTPException(status_code=404, detail="no such monitor")
    window = sketch.window_start(int(time.time()), monitor["window_s"])
    live = sketch.read_live(monitor["tenant"], monitor_id, window)
    baseline = sketch.read_baseline(monitor["tenant"], monitor["baseline"])
    return {"monitor_id": monitor_id, "metric": monitor["metric"], "distance": sketch.psi(live, baseline), "significant": True}
`,
      solution: `import time

from fastapi import FastAPI, HTTPException, Request

from drift import sketch, store  # store.get_monitor, monitor_for; sketch.window_start, read_live, read_baseline, psi

app = FastAPI()

MIN_SAMPLES = 200


@app.get("/v1/monitors/{monitor_id}/report")
def monitor_report(monitor_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    monitor = store.monitor_for(tenant, monitor_id)
    if monitor is None:
        raise HTTPException(status_code=404, detail="no such monitor")  # another tenant's monitor does not exist for this caller
    window = sketch.window_start(int(time.time()), monitor["window_s"])
    live = sketch.read_live(tenant, monitor_id, window)
    baseline = sketch.read_baseline(tenant, monitor["baseline"])
    sample_count = sum(live.values())
    baseline_sample_count = sum(baseline.values())
    distance = sketch.psi(live, baseline)
    sufficient = sample_count >= MIN_SAMPLES and baseline_sample_count >= MIN_SAMPLES
    crossed = sufficient and distance >= monitor["threshold"]
    return {
        "monitor_id": monitor_id,
        "metric": monitor["metric"],
        "state": "drifting" if crossed else "ok" if sufficient else "insufficient_data",
        "distance": distance,
        "threshold": monitor["threshold"],
        "threshold_crossed": crossed,
        "sample_count": sample_count,
        "baseline_sample_count": baseline_sample_count,
        "window_start": window,
        "window_end": window + monitor["window_s"],
        "baseline": monitor["baseline"],
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {psi, readBaseline, readLive, windowStart} from 'drift/sketch';
import {getMonitor, monitorFor} from 'drift/store';

export const app = Fastify();

app.get('/v1/monitors/:monitorId/report', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {monitorId} = request.params as {monitorId: string};
  const monitor = await getMonitor(monitorId);
  if (monitor === null) return reply.code(404).send({error: 'no such monitor'});
  const window = windowStart(Math.floor(Date.now() / 1000), monitor.window_s);
  const live = await readLive(monitor.tenant, monitorId, window);
  const baseline = await readBaseline(monitor.tenant, monitor.baseline);
  return {monitor_id: monitorId, metric: monitor.metric, distance: psi(live, baseline), significant: true};
});
`,
      solution: `import Fastify from 'fastify';

import {type Sketch, psi, readBaseline, readLive, windowStart} from 'drift/sketch';
import {getMonitor, monitorFor} from 'drift/store';

export const app = Fastify();

const MIN_SAMPLES = 200;

const total = (sketch: Sketch): number => Object.values(sketch).reduce((n, count) => n + count, 0);

app.get('/v1/monitors/:monitorId/report', async (request, reply) => {
  const {monitorId} = request.params as {monitorId: string};
  const tenant = String(request.headers['x-tenant-id'] ?? '');
  if (tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const monitor = await monitorFor(tenant, monitorId);
  // Another tenant's monitor does not exist for this caller.
  if (monitor === null) return reply.code(404).send({error: 'no such monitor'});
  const window = windowStart(Math.floor(Date.now() / 1000), monitor.window_s);
  const live = await readLive(tenant, monitorId, window);
  const baseline = await readBaseline(tenant, monitor.baseline);
  const sampleCount = total(live);
  const baselineSampleCount = total(baseline);
  const distance = psi(live, baseline);
  const sufficient = sampleCount >= MIN_SAMPLES && baselineSampleCount >= MIN_SAMPLES;
  const crossed = sufficient && distance >= monitor.threshold;
  return {
    monitor_id: monitorId,
    metric: monitor.metric,
    state: crossed ? 'drifting' : sufficient ? 'ok' : 'insufficient_data',
    distance,
    threshold: monitor.threshold,
    threshold_crossed: crossed,
    sample_count: sampleCount,
    baseline_sample_count: baselineSampleCount,
    window_start: window,
    window_end: window + monitor.window_s,
    baseline: monitor.baseline,
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"drift/sketch" // sketch.WindowStart, ReadLive, ReadBaseline, Total, PSI
	"drift/store"  // store.GetMonitor, MonitorFor
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func monitorReport(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	monitorID := r.PathValue("id")
	monitor := store.GetMonitor(r.Context(), monitorID)
	if monitor == nil {
		http.Error(rw, "no such monitor", http.StatusNotFound)
		return
	}
	window := sketch.WindowStart(time.Now().Unix(), monitor.WindowS)
	live := sketch.ReadLive(r.Context(), monitor.Tenant, monitorID, window)
	baseline := sketch.ReadBaseline(r.Context(), monitor.Tenant, monitor.Baseline)
	writeJSON(rw, http.StatusOK, map[string]any{"monitor_id": monitorID, "metric": monitor.Metric, "distance": sketch.PSI(live, baseline), "significant": true})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/monitors/{id}/report", monitorReport)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"drift/sketch" // sketch.WindowStart, ReadLive, ReadBaseline, Total, PSI
	"drift/store"  // store.GetMonitor, MonitorFor
)

const minSamples = 200

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func monitorReport(rw http.ResponseWriter, r *http.Request) {
	monitorID := r.PathValue("id")
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	monitor := store.MonitorFor(r.Context(), tenant, monitorID)
	if monitor == nil {
		http.Error(rw, "no such monitor", http.StatusNotFound) // another tenant's monitor does not exist for this caller
		return
	}
	window := sketch.WindowStart(time.Now().Unix(), monitor.WindowS)
	live := sketch.ReadLive(r.Context(), tenant, monitorID, window)
	baseline := sketch.ReadBaseline(r.Context(), tenant, monitor.Baseline)
	sampleCount, baselineSampleCount := sketch.Total(live), sketch.Total(baseline)
	distance := sketch.PSI(live, baseline)
	sufficient := sampleCount >= minSamples && baselineSampleCount >= minSamples
	crossed := sufficient && distance >= monitor.Threshold
	state := "insufficient_data"
	if crossed {
		state = "drifting"
	} else if sufficient {
		state = "ok"
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"monitor_id":            monitorID,
		"metric":                monitor.Metric,
		"state":                 state,
		"distance":              distance,
		"threshold":             monitor.Threshold,
		"threshold_crossed":     crossed,
		"sample_count":          sampleCount,
		"baseline_sample_count": baselineSampleCount,
		"window_start":          window,
		"window_end":            window + monitor.WindowS,
		"baseline":              monitor.Baseline,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/monitors/{id}/report", monitorReport)
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>

#include "drift/sketch.h"  // sketch::windowStart, readLive, readBaseline, total, psi
#include "drift/store.h"   // store::getMonitor, monitorFor

using json = nlohmann::json;

void monitor_report(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string monitor_id = req.matches[1];
  const auto monitor = store::getMonitor(monitor_id);
  if (!monitor) {
    res.status = 404;
    res.set_content("no such monitor", "text/plain");
    return;
  }
  const long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long window = sketch::windowStart(now, monitor->window_s);
  const sketch::Sketch live = sketch::readLive(monitor->tenant, monitor_id, window);
  const sketch::Sketch baseline = sketch::readBaseline(monitor->tenant, monitor->baseline);
  const json body = {{"monitor_id", monitor_id}, {"metric", monitor->metric}, {"distance", sketch::psi(live, baseline)}, {"significant", true}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/monitors/([\\w-]+)/report)", monitor_report); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>

#include "drift/sketch.h"  // sketch::windowStart, readLive, readBaseline, total, psi
#include "drift/store.h"   // store::getMonitor, monitorFor

using json = nlohmann::json;

constexpr long kMinSamples = 200;

void monitor_report(const httplib::Request& req, httplib::Response& res) {
  const std::string monitor_id = req.matches[1];
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const auto monitor = store::monitorFor(tenant, monitor_id);
  if (!monitor) {
    res.status = 404;  // another tenant's monitor does not exist for this caller
    res.set_content("no such monitor", "text/plain");
    return;
  }
  const long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long window = sketch::windowStart(now, monitor->window_s);
  const sketch::Sketch live = sketch::readLive(tenant, monitor_id, window);
  const sketch::Sketch baseline = sketch::readBaseline(tenant, monitor->baseline);
  const long sample_count = sketch::total(live);
  const long baseline_sample_count = sketch::total(baseline);
  const double distance = sketch::psi(live, baseline);
  const bool sufficient = sample_count >= kMinSamples && baseline_sample_count >= kMinSamples;
  const bool crossed = sufficient && distance >= monitor->threshold;
  const json body = {{"monitor_id", monitor_id},
                     {"metric", monitor->metric},
                     {"state", crossed ? "drifting" : sufficient ? "ok" : "insufficient_data"},
                     {"distance", distance},
                     {"threshold", monitor->threshold},
                     {"threshold_crossed", crossed},
                     {"sample_count", sample_count},
                     {"baseline_sample_count", baseline_sample_count},
                     {"window_start", window},
                     {"window_end", window + monitor->window_s},
                     {"baseline", monitor->baseline}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/monitors/([\\w-]+)/report)", monitor_report); }
`,
    },
  },
  harness: {
    python: `from drift import sketch, store

REF = "baseline:v3:2026-10-01"
BASELINE = {1: 2500, 2: 2500}
DRIFTING = {1: 160, 2: 480}
STEADY = {1: 330, 2: 310}
THIN = {1: 10, 2: 40}


def _seed(live, tenant="t1", window_s=300, threshold=0.2, ref=REF, baseline=BASELINE):
    """A monitor of tenant with its baseline frozen and live merged into the current window."""
    monitor = store.create_monitor({"tenant": tenant, "model_version": "v3", "metric": "input_distribution", "window_s": window_s, "baseline": ref, "threshold": threshold})
    sketch.freeze_baseline(tenant, ref, baseline)
    sketch.merge_batch(tenant, monitor["monitor_id"], window_s, live)
    return monitor["monitor_id"]


async def _report(ctx, monitor_id, tenant="t1"):
    m = ctx.load("read")
    headers = {"X-Tenant-Id": tenant} if tenant else {}
    async with ctx.client(m.app) as c:
        return await c.get(f"/v1/monitors/{monitor_id}/report", headers=headers)


async def check_route(ctx):
    monitor_id = _seed(DRIFTING)
    r = await _report(ctx, monitor_id)
    assert r.status_code == 200, f"GET /v1/monitors/{monitor_id}/report answered {r.status_code}: {r.text}"
    want = sketch.psi(DRIFTING, BASELINE)
    distance = r.json().get("distance")
    assert isinstance(distance, (int, float)) and abs(distance - want) < 1e-6, f"the report's distance is {distance!r}, expected the PSI of the window against the baseline, {want:.6f}"


async def check_tenant_scope(ctx):
    monitor_id = _seed(DRIFTING)
    foreign = await _report(ctx, monitor_id, tenant="t2")
    assert foreign.status_code == 404, f"tenant t2 asking for t1's monitor {monitor_id} got {foreign.status_code} {foreign.text}, expected 404: another tenant's drift leaked"
    anonymous = await _report(ctx, monitor_id, tenant="")
    assert anonymous.status_code == 401, f"a report without X-Tenant-Id answered {anonymous.status_code}, expected 401"
    own = await _report(ctx, monitor_id)
    assert own.status_code == 200, f"t1 asking for its own monitor got {own.status_code}: {own.text}"
    missing = await _report(ctx, "m-404")
    assert missing.status_code == 404, f"t1 asking for the unknown monitor m-404 got {missing.status_code} {missing.text}, expected 404, the same answer as another tenant's monitor"


async def check_sample_counts(ctx):
    monitor_id = _seed(DRIFTING)
    window = sketch.window_start(int(ctx.clock.time()), 300)
    body = (await _report(ctx, monitor_id)).json()
    want = {"sample_count": 640, "baseline_sample_count": 5000, "window_start": window, "window_end": window + 300, "baseline": REF}
    seen = {name: body.get(name) for name in want}
    assert seen == want, f"the report carries {seen}, expected {want}: a distance without its counts, window and baseline cannot be judged"
    hourly = _seed(STEADY, window_s=3600)
    hour = sketch.window_start(int(ctx.clock.time()), 3600)
    body = (await _report(ctx, hourly)).json()
    want = {"sample_count": 640, "baseline_sample_count": 5000, "window_start": hour, "window_end": hour + 3600, "baseline": REF}
    seen = {name: body.get(name) for name in want}
    assert seen == want, f"a monitor with window_s 3600 reported {seen}, expected {want}: the window is the monitor's own"


async def check_insufficient_data(ctx):
    monitor_id = _seed(THIN)
    body = (await _report(ctx, monitor_id)).json()
    assert body.get("state") == "insufficient_data", f"a window of 50 samples (MIN_SAMPLES is 200) reported state {body.get('state')!r}: {body}"
    assert body.get("threshold_crossed") is False, f"a window of 50 samples reported threshold_crossed {body.get('threshold_crossed')!r}, expected False whatever its distance"
    body = (await _report(ctx, _seed({1: 50, 2: 149}))).json()
    assert body.get("state") == "insufficient_data" and body.get("threshold_crossed") is False, f"a window of 199 samples (one below MIN_SAMPLES) reported {body}, expected state insufficient_data"
    body = (await _report(ctx, _seed({1: 50, 2: 150}))).json()
    assert body.get("state") == "drifting" and body.get("threshold_crossed") is True, f"a window of exactly 200 samples (MIN_SAMPLES) at distance {body.get('distance')} over a 0.2 threshold reported {body}, expected state drifting: the floor itself is enough"
    thin = {1: 99, 2: 100}
    body = (await _report(ctx, _seed(DRIFTING, ref="baseline:v3:2026-09-01", baseline=thin))).json()
    assert body.get("state") == "insufficient_data" and body.get("threshold_crossed") is False, f"640 live samples against a baseline of 199 reported {body}, expected state insufficient_data: the floor applies to both sides"


async def check_threshold_crossed(ctx):
    drifting = (await _report(ctx, _seed(DRIFTING))).json()
    assert drifting.get("threshold_crossed") is True and drifting.get("state") == "drifting", f"640 samples at distance {sketch.psi(DRIFTING, BASELINE):.3f} over a 0.2 threshold reported {drifting}, expected threshold_crossed True and state drifting"
    steady = (await _report(ctx, _seed(STEADY))).json()
    assert steady.get("threshold_crossed") is False and steady.get("state") == "ok", f"640 samples at distance {sketch.psi(STEADY, BASELINE):.4f} under the 0.2 threshold reported {steady}, expected threshold_crossed False and state ok"
    exact = sketch.psi(DRIFTING, BASELINE)
    at = (await _report(ctx, _seed(DRIFTING, threshold=exact))).json()
    assert at.get("threshold_crossed") is True and at.get("state") == "drifting", f"a distance equal to the threshold ({exact}) reported {at}, expected threshold_crossed True and state drifting: the threshold itself is a crossing (distance >= threshold)"
`,
    typescript: `const REF = 'baseline:v3:2026-10-01';
const BASELINE = {1: 2500, 2: 2500};
const DRIFTING = {1: 160, 2: 480};
const STEADY = {1: 330, 2: 310};
const THIN = {1: 10, 2: 40};

/** A monitor of tenant with its baseline frozen and live merged into the current window. */
async function seed(ctx, live, {tenant = 't1', windowS = 300, threshold = 0.2, ref = REF, baseline = BASELINE} = {}): Promise<string> {
  const store = ctx.load('/support/drift/store.ts');
  const sketch = ctx.load('/support/drift/sketch.ts');
  const monitor = await store.createMonitor({tenant, model_version: 'v3', metric: 'input_distribution', window_s: windowS, baseline: ref, threshold});
  await sketch.freezeBaseline(tenant, ref, baseline);
  await sketch.mergeBatch(tenant, monitor.monitor_id, windowS, live);
  return monitor.monitor_id;
}

function report(ctx, monitorId: string, tenant = 't1') {
  const c = ctx.client(ctx.load('read').app);
  return c.get(\`/v1/monitors/\${monitorId}/report\`, {headers: tenant === '' ? {} : {'X-Tenant-Id': tenant}});
}

export async function check_route(ctx) {
  const monitorId = await seed(ctx, DRIFTING);
  const r = await report(ctx, monitorId);
  assert.equal(r.status, 200, \`GET /v1/monitors/\${monitorId}/report answered \${r.status}: \${r.text}\`);
  const want = ctx.load('/support/drift/sketch.ts').psi(DRIFTING, BASELINE);
  const distance = r.json().distance;
  assert(typeof distance === 'number' && Math.abs(distance - want) < 1e-6, \`the report's distance is \${JSON.stringify(distance)}, expected the PSI of the window against the baseline, \${want.toFixed(6)}\`);
}

export async function check_tenant_scope(ctx) {
  const monitorId = await seed(ctx, DRIFTING);
  const foreign = await report(ctx, monitorId, 't2');
  assert.equal(foreign.status, 404, \`tenant t2 asking for t1's monitor \${monitorId} got \${foreign.status} \${foreign.text}, expected 404: another tenant's drift leaked\`);
  const anonymous = await report(ctx, monitorId, '');
  assert.equal(anonymous.status, 401, \`a report without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  const own = await report(ctx, monitorId);
  assert.equal(own.status, 200, \`t1 asking for its own monitor got \${own.status}: \${own.text}\`);
  const missing = await report(ctx, 'm-404');
  assert.equal(missing.status, 404, \`t1 asking for the unknown monitor m-404 got \${missing.status} \${missing.text}, expected 404, the same answer as another tenant's monitor\`);
}

export async function check_sample_counts(ctx) {
  const monitorId = await seed(ctx, DRIFTING);
  const now = Math.floor(ctx.clock.now() / 1000);
  const window = now - (now % 300);
  const body = (await report(ctx, monitorId)).json();
  const want = {sample_count: 640, baseline_sample_count: 5000, window_start: window, window_end: window + 300, baseline: REF};
  const seen = Object.fromEntries(Object.keys(want).map(name => [name, body[name]]));
  assert.deepStrictEqual(seen, want, \`the report carries \${JSON.stringify(seen)}, expected \${JSON.stringify(want)}: a distance without its counts, window and baseline cannot be judged\`);
  const hourly = await seed(ctx, STEADY, {windowS: 3600});
  const hour = now - (now % 3600);
  const hourBody = (await report(ctx, hourly)).json();
  const wantHour = {sample_count: 640, baseline_sample_count: 5000, window_start: hour, window_end: hour + 3600, baseline: REF};
  const seenHour = Object.fromEntries(Object.keys(wantHour).map(name => [name, hourBody[name]]));
  assert.deepStrictEqual(seenHour, wantHour, \`a monitor with window_s 3600 reported \${JSON.stringify(seenHour)}, expected \${JSON.stringify(wantHour)}: the window is the monitor's own\`);
}

export async function check_insufficient_data(ctx) {
  const monitorId = await seed(ctx, THIN);
  const body = (await report(ctx, monitorId)).json();
  assert.equal(body.state, 'insufficient_data', \`a window of 50 samples (MIN_SAMPLES is 200) reported state \${JSON.stringify(body.state)}: \${JSON.stringify(body)}\`);
  assert.equal(body.threshold_crossed, false, \`a window of 50 samples reported threshold_crossed \${JSON.stringify(body.threshold_crossed)}, expected false whatever its distance\`);
  const below = (await report(ctx, await seed(ctx, {1: 50, 2: 149}))).json();
  assert(below.state === 'insufficient_data' && below.threshold_crossed === false, \`a window of 199 samples (one below MIN_SAMPLES) reported \${JSON.stringify(below)}, expected state insufficient_data\`);
  const floor = (await report(ctx, await seed(ctx, {1: 50, 2: 150}))).json();
  assert(floor.state === 'drifting' && floor.threshold_crossed === true, \`a window of exactly 200 samples (MIN_SAMPLES) over a 0.2 threshold reported \${JSON.stringify(floor)}, expected state drifting: the floor itself is enough\`);
  const thinBaseline = (await report(ctx, await seed(ctx, DRIFTING, {ref: 'baseline:v3:2026-09-01', baseline: {1: 99, 2: 100}}))).json();
  assert(thinBaseline.state === 'insufficient_data' && thinBaseline.threshold_crossed === false, \`640 live samples against a baseline of 199 reported \${JSON.stringify(thinBaseline)}, expected state insufficient_data: the floor applies to both sides\`);
}

export async function check_threshold_crossed(ctx) {
  const drifting = (await report(ctx, await seed(ctx, DRIFTING))).json();
  assert(drifting.threshold_crossed === true && drifting.state === 'drifting', \`640 samples over a 0.2 threshold reported \${JSON.stringify(drifting)}, expected threshold_crossed true and state drifting\`);
  const steady = (await report(ctx, await seed(ctx, STEADY))).json();
  assert(steady.threshold_crossed === false && steady.state === 'ok', \`640 samples under the 0.2 threshold reported \${JSON.stringify(steady)}, expected threshold_crossed false and state ok\`);
  const exact = ctx.load('/support/drift/sketch.ts').psi(DRIFTING, BASELINE);
  const at = (await report(ctx, await seed(ctx, DRIFTING, {threshold: exact}))).json();
  assert(at.threshold_crossed === true && at.state === 'drifting', \`a distance equal to the threshold (\${exact}) reported \${JSON.stringify(at)}, expected threshold_crossed true and state drifting: the threshold itself is a crossing (distance >= threshold)\`);
}
`,
    go: `package main

import (
	"context"
	"math"
	"net/http"

	"drift/sketch"
	"drift/store"

	"leetbuild/harness"
)

const hRef = "baseline:v3:2026-10-01"

var (
	hBg       = context.Background()
	hBaseline = map[int]int64{1: 2500, 2: 2500}
	hDrifting = map[int]int64{1: 160, 2: 480}
	hSteady   = map[int]int64{1: 330, 2: 310}
	hThin     = map[int]int64{1: 10, 2: 40}
)

// hSeedWith is a monitor of t1 with its baseline frozen and live merged into the current window.
func hSeedWith(ctx *harness.Ctx, live map[int]int64, windowS int64, threshold float64, ref string, baseline map[int]int64) string {
	m := store.CreateMonitor(hBg, store.Monitor{Tenant: "t1", ModelVersion: "v3", Metric: "input_distribution", WindowS: windowS, Baseline: ref, Threshold: threshold})
	sketch.FreezeBaseline(hBg, "t1", ref, baseline)
	_, err := sketch.MergeBatch(hBg, "t1", m.MonitorID, windowS, live)
	ctx.NoError(err, "seeding the live sketch failed")
	return m.MonitorID
}

// hSeed is a monitor of t1 (window_s 300, threshold 0.2) on the default baseline.
func hSeed(ctx *harness.Ctx, live map[int]int64) string {
	return hSeedWith(ctx, live, 300, 0.2, hRef, hBaseline)
}

func hReport(ctx *harness.Ctx, monitorID, tenant string) *harness.Response {
	mux := http.NewServeMux()
	register(mux)
	c := ctx.HTTP(mux)
	if tenant == "" {
		return c.Get("/v1/monitors/" + monitorID + "/report")
	}
	return c.Get("/v1/monitors/"+monitorID+"/report", "X-Tenant-Id", tenant)
}

func hBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	m, _ := r.JSON().(map[string]any)
	ctx.Assert(m != nil, "the report is not a JSON object: %d %s", r.Status, r.Text())
	return m
}

func hPicked(b map[string]any, want map[string]any) map[string]any {
	seen := map[string]any{}
	for name := range want {
		seen[name] = b[name]
	}
	return seen
}

func CheckRoute(ctx *harness.Ctx) {
	monitorID := hSeed(ctx, hDrifting)
	r := hReport(ctx, monitorID, "t1")
	ctx.Equal(r.Status, 200, "GET /v1/monitors/%s/report (%s)", monitorID, r.Text())
	want := sketch.PSI(hDrifting, hBaseline)
	distance, ok := hBody(ctx, r)["distance"].(float64)
	ctx.Assert(ok && math.Abs(distance-want) < 1e-6, "the report's distance is %v, expected the PSI of the window against the baseline, %.6f", hBody(ctx, r)["distance"], want)
}

func CheckTenantScope(ctx *harness.Ctx) {
	monitorID := hSeed(ctx, hDrifting)
	foreign := hReport(ctx, monitorID, "t2")
	ctx.Equal(foreign.Status, 404, "tenant t2 asking for t1's monitor %s must get 404, not another tenant's drift (%s)", monitorID, foreign.Text())
	ctx.Equal(hReport(ctx, monitorID, "").Status, 401, "a report without X-Tenant-Id")
	own := hReport(ctx, monitorID, "t1")
	ctx.Equal(own.Status, 200, "t1 asking for its own monitor (%s)", own.Text())
	missing := hReport(ctx, "m-404", "t1")
	ctx.Equal(missing.Status, 404, "t1 asking for the unknown monitor m-404 must get 404, the same answer as another tenant's monitor (%s)", missing.Text())
}

func CheckSampleCounts(ctx *harness.Ctx) {
	monitorID := hSeed(ctx, hDrifting)
	window := sketch.WindowStart(ctx.Clock.Now()/1000, 300)
	want := map[string]any{"sample_count": 640, "baseline_sample_count": 5000, "window_start": window, "window_end": window + 300, "baseline": hRef}
	ctx.Equal(hPicked(hBody(ctx, hReport(ctx, monitorID, "t1")), want), want, "the report must carry the counts, the window and the baseline, or its distance cannot be judged")
	hourly := hSeedWith(ctx, hSteady, 3600, 0.2, hRef, hBaseline)
	hour := sketch.WindowStart(ctx.Clock.Now()/1000, 3600)
	want = map[string]any{"sample_count": 640, "baseline_sample_count": 5000, "window_start": hour, "window_end": hour + 3600, "baseline": hRef}
	ctx.Equal(hPicked(hBody(ctx, hReport(ctx, hourly, "t1")), want), want, "a monitor with window_s 3600: the window is the monitor's own")
}

func CheckInsufficientData(ctx *harness.Ctx) {
	b := hBody(ctx, hReport(ctx, hSeed(ctx, hThin), "t1"))
	ctx.Equal(b["state"], "insufficient_data", "a window of 50 samples (minSamples is 200), its state (%v)", b)
	ctx.Equal(b["threshold_crossed"], false, "a window of 50 samples must not report a crossing whatever its distance; threshold_crossed")
	below := hBody(ctx, hReport(ctx, hSeed(ctx, map[int]int64{1: 50, 2: 149}), "t1"))
	ctx.Assert(below["state"] == "insufficient_data" && below["threshold_crossed"] == false, "a window of 199 samples (one below minSamples) reported %v, expected state insufficient_data", below)
	floor := hBody(ctx, hReport(ctx, hSeed(ctx, map[int]int64{1: 50, 2: 150}), "t1"))
	ctx.Assert(floor["state"] == "drifting" && floor["threshold_crossed"] == true, "a window of exactly 200 samples (minSamples) over a 0.2 threshold reported %v, expected state drifting: the floor itself is enough", floor)
	thinBaseline := hBody(ctx, hReport(ctx, hSeedWith(ctx, hDrifting, 300, 0.2, "baseline:v3:2026-09-01", map[int]int64{1: 99, 2: 100}), "t1"))
	ctx.Assert(thinBaseline["state"] == "insufficient_data" && thinBaseline["threshold_crossed"] == false, "640 live samples against a baseline of 199 reported %v, expected state insufficient_data: the floor applies to both sides", thinBaseline)
}

func CheckThresholdCrossed(ctx *harness.Ctx) {
	d := hBody(ctx, hReport(ctx, hSeed(ctx, hDrifting), "t1"))
	ctx.Assert(d["threshold_crossed"] == true && d["state"] == "drifting", "640 samples over a 0.2 threshold reported %v, expected threshold_crossed true and state drifting", d)
	s := hBody(ctx, hReport(ctx, hSeed(ctx, hSteady), "t1"))
	ctx.Assert(s["threshold_crossed"] == false && s["state"] == "ok", "640 samples under the 0.2 threshold reported %v, expected threshold_crossed false and state ok", s)
	exact := sketch.PSI(hDrifting, hBaseline)
	at := hBody(ctx, hReport(ctx, hSeedWith(ctx, hDrifting, 300, exact, hRef, hBaseline), "t1"))
	ctx.Assert(at["threshold_crossed"] == true && at["state"] == "drifting", "a distance equal to the threshold (%v) reported %v, expected threshold_crossed true and state drifting: the threshold itself is a crossing (distance >= threshold)", exact, at)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <string>

#include "drift/sketch.h"
#include "drift/store.h"

using json = nlohmann::json;

namespace {

const std::string hRef = "baseline:v3:2026-10-01";
const sketch::Sketch hBaseline = {{1, 2500}, {2, 2500}};
const sketch::Sketch hDrifting = {{1, 160}, {2, 480}};
const sketch::Sketch hSteady = {{1, 330}, {2, 310}};
const sketch::Sketch hThin = {{1, 10}, {2, 40}};

// A monitor of t1 with its baseline frozen and live merged into the current window.
std::string hSeed(const sketch::Sketch& live, long window_s = 300, double threshold = 0.2, const std::string& ref = hRef, const sketch::Sketch& baseline = hBaseline) {
  const store::Monitor m = store::createMonitor(store::Monitor{"", "t1", "v3", "input_distribution", window_s, ref, threshold});
  sketch::freezeBaseline("t1", ref, baseline);
  sketch::mergeBatch("t1", m.monitor_id, window_s, live);
  return m.monitor_id;
}

harness::Response hReport(harness::Ctx& ctx, const std::string& monitor_id, const std::string& tenant = "t1") {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  auto c = ctx.HTTP(*svr);
  if (tenant.empty()) return c.Get("/v1/monitors/" + monitor_id + "/report");
  return c.Get("/v1/monitors/" + monitor_id + "/report", "X-Tenant-Id", tenant);
}

json hBodyOf(harness::Ctx& ctx, const harness::Response& r) {
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the report is not a JSON object: %d %s", r.Status, r.Text());
  return body;
}

json hPicked(const json& body, const json& want) {
  json seen = json::object();
  for (const auto& [name, value] : want.items()) seen[name] = body.contains(name) ? body[name] : json();
  return seen;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  const std::string monitor_id = hSeed(hDrifting);
  const auto r = hReport(ctx, monitor_id);
  ctx.Equal(r.Status, 200, "GET /v1/monitors/%s/report (%s)", monitor_id, r.Text());
  const double want = sketch::psi(hDrifting, hBaseline);
  const json body = hBodyOf(ctx, r);
  ctx.Assert(body.contains("distance") && body["distance"].is_number() && std::abs(body["distance"].get<double>() - want) < 1e-6,
             "the report's distance is %s, expected the PSI of the window against the baseline, %.6f", body.value("distance", json()).dump(), want);
}

void CheckTenantScope(harness::Ctx& ctx) {
  const std::string monitor_id = hSeed(hDrifting);
  const auto foreign = hReport(ctx, monitor_id, "t2");
  ctx.Equal(foreign.Status, 404, "tenant t2 asking for t1's monitor %s must get 404, not another tenant's drift (%s)", monitor_id, foreign.Text());
  ctx.Equal(hReport(ctx, monitor_id, "").Status, 401, "a report without X-Tenant-Id");
  const auto own = hReport(ctx, monitor_id);
  ctx.Equal(own.Status, 200, "t1 asking for its own monitor (%s)", own.Text());
  const auto missing = hReport(ctx, "m-404");
  ctx.Equal(missing.Status, 404, "t1 asking for the unknown monitor m-404 must get 404, the same answer as another tenant's monitor (%s)", missing.Text());
}

void CheckSampleCounts(harness::Ctx& ctx) {
  const std::string monitor_id = hSeed(hDrifting);
  const long window = sketch::windowStart(static_cast<long>(ctx.Clock.Now() / 1000), 300);
  json want = {{"sample_count", 640}, {"baseline_sample_count", 5000}, {"window_start", window}, {"window_end", window + 300}, {"baseline", hRef}};
  ctx.Equal(hPicked(hBodyOf(ctx, hReport(ctx, monitor_id)), want), want, "the report must carry the counts, the window and the baseline, or its distance cannot be judged");
  const std::string hourly = hSeed(hSteady, 3600);
  const long hour = sketch::windowStart(static_cast<long>(ctx.Clock.Now() / 1000), 3600);
  want = {{"sample_count", 640}, {"baseline_sample_count", 5000}, {"window_start", hour}, {"window_end", hour + 3600}, {"baseline", hRef}};
  ctx.Equal(hPicked(hBodyOf(ctx, hReport(ctx, hourly)), want), want, "a monitor with window_s 3600: the window is the monitor's own");
}

void CheckInsufficientData(harness::Ctx& ctx) {
  const json body = hBodyOf(ctx, hReport(ctx, hSeed(hThin)));
  ctx.Equal(body.value("state", ""), "insufficient_data", "a window of 50 samples (kMinSamples is 200), its state (%s)", body.dump());
  ctx.Assert(body.contains("threshold_crossed") && body["threshold_crossed"] == false, "a window of 50 samples must not report a crossing whatever its distance, got %s", body.dump());
  const json below = hBodyOf(ctx, hReport(ctx, hSeed({{1, 50}, {2, 149}})));
  ctx.Assert(below.value("state", "") == "insufficient_data" && below.contains("threshold_crossed") && below["threshold_crossed"] == false, "a window of 199 samples (one below kMinSamples) reported %s, expected state insufficient_data", below.dump());
  const json onFloor = hBodyOf(ctx, hReport(ctx, hSeed({{1, 50}, {2, 150}})));
  ctx.Assert(onFloor.value("state", "") == "drifting" && onFloor.value("threshold_crossed", false), "a window of exactly 200 samples (kMinSamples) over a 0.2 threshold reported %s, expected state drifting: the floor itself is enough", onFloor.dump());
  const json thinBaseline = hBodyOf(ctx, hReport(ctx, hSeed(hDrifting, 300, 0.2, "baseline:v3:2026-09-01", {{1, 99}, {2, 100}})));
  ctx.Assert(thinBaseline.value("state", "") == "insufficient_data" && thinBaseline.contains("threshold_crossed") && thinBaseline["threshold_crossed"] == false, "640 live samples against a baseline of 199 reported %s, expected state insufficient_data: the floor applies to both sides", thinBaseline.dump());
}

void CheckThresholdCrossed(harness::Ctx& ctx) {
  const json drifting = hBodyOf(ctx, hReport(ctx, hSeed(hDrifting)));
  ctx.Assert(drifting.value("threshold_crossed", false) && drifting.value("state", "") == "drifting", "640 samples over a 0.2 threshold reported %s, expected threshold_crossed true and state drifting", drifting.dump());
  const json steady = hBodyOf(ctx, hReport(ctx, hSeed(hSteady)));
  ctx.Assert(steady.contains("threshold_crossed") && steady["threshold_crossed"] == false && steady.value("state", "") == "ok", "640 samples under the 0.2 threshold reported %s, expected threshold_crossed false and state ok", steady.dump());
  const double exact = sketch::psi(hDrifting, hBaseline);
  const json at = hBodyOf(ctx, hReport(ctx, hSeed(hDrifting, 300, exact)));
  ctx.Assert(at.value("threshold_crossed", false) && at.value("state", "") == "drifting", "a distance equal to the threshold (%v) reported %s, expected threshold_crossed true and state drifting: the threshold itself is a crossing (distance >= threshold)", exact, at.dump());
}
`,
  },
  hints: [
    'Ask for a monitor id with another tenant’s header: its drift comes back. Ask for a window holding 50 samples: the report says `significant: true` and gives no counts to doubt it with.',
    'The handler resolves the monitor by id alone, so whoever names it reads it. The body is the distance and a constant: no counts, no window, no baseline, and no comparison with the threshold or a sample floor.',
    'Answer 401 without `X-Tenant-Id`, resolve with `store.monitor_for(tenant, monitor_id)` (404 when absent), return both totals with `window_start`, `window_end` and `baseline`, and derive `state` and `threshold_crossed` from `MIN_SAMPLES` and `distance >= threshold`.',
  ],
  debrief: `Scoping the lookup by tenant makes a foreign monitor indistinguishable from a missing one, which is why the answer is 404 rather than 403: a 403 would confirm the id exists. The counts, the window and the baseline are what make a distance an argument instead of an assertion; a reader can check that 640 samples against 5 000 is enough and that the window is the one they meant. The sample floor turns "no evidence" into its own state, so a thin window can never page or turn a dashboard red. Production monitors also report a confidence interval or a p-value from a test suited to the feature type, and keep each closed window's report so a crossing can be audited after its sketch expired.`,
};
