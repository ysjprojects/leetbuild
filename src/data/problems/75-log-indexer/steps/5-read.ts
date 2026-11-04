import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/services/{service}/completeness: gaps you can see',
  concept: 'http',
  file: 'read',
  focus: ['dash', 'api', 'ledger'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/services/{service}/completeness\`: it answers 401
without \`X-Tenant-Id\`, sums \`ledger.hourly_counts(tenant, service, hours)\` over the 24 complete
hours before now, and answers \`{service, indexed, expected, complete}\` against a global
\`EXPECTED_PER_HOUR = 1000\`. It serves the demo and hides four flaws.

**Failure mode the checks target.** A day with a dead hour sums to a healthy total; one global
expectation makes a large service look fine at a tenth of its traffic and a small one look broken
all day; no hour is ever called a gap; and any tenant can read the pipeline of a service it does not
own.

- A \`service\` outside the caller's registry (\`registry.is_registered\`) is **404**.
- \`hours\` lists the 24 complete hours (\`HOUR_S = 3600\`, each by its start in epoch seconds),
  oldest first, each with its \`indexed\` count.
- Each hour's \`expected\` is \`ledger.expected_per_hour(tenant, service, hours[0])\`: this service's
  own mean over the 7 days before the window.
- An hour whose \`indexed\` is below \`expected × (1 − GAP_THRESHOLD)\`, \`GAP_THRESHOLD = 0.5\`, has
  \`gap: true\`; the body carries \`gaps\` (how many) and \`threshold\`.`,
  sequence: {
    participants: ['Completeness UI', 'logindex', 'service registry', 'Index ledger'],
    messages: [
      {
        from: 'Completeness UI',
        to: 'logindex',
        label: 'GET /v1/services/checkout/completeness · X-Tenant-Id',
        kind: 'sync',
      },
      {from: 'logindex', to: 'service registry', label: 'is_registered(tenant, service) → else 404', kind: 'sync'},
      {from: 'logindex', to: 'Index ledger', label: 'hourly_counts(tenant, service, 24 hours)', kind: 'sync'},
      {from: 'logindex', to: 'Index ledger', label: 'expected_per_hour(tenant, service, hours[0])', kind: 'sync'},
      {from: 'logindex', to: 'logindex', label: 'gap: indexed < expected × 0.5', kind: 'sync'},
      {from: 'logindex', to: 'Completeness UI', label: '200 {hours[24], gaps, threshold}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Answers GET /v1/services/{service}/completeness',
      detail:
        'Register the completeness route with the service id as a path parameter; a registered service is **200**.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/services\/\{service\}\/completeness["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/services\/:service\/completeness['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/services\/\{service\}\/completeness"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"services"\s*\/\s*Segment\s*\/\s*"completeness"\s*\)/]},
        cpp: {all: [/svr\.Get\([^;]*completeness/]},
      },
    },
    {
      id: 'foreign-404',
      title: "Answers 404 for a service outside the caller's registry",
      detail:
        "A service the caller's tenant did not register, another tenant's included, is **404**; the starter reports on any service id, which tells a tenant what another tenant runs and how much it logs.",
      match: {
        python: {all: [/registry\.is_registered\(/, /\b404\b/]},
        typescript: {all: [/isRegistered\(/, /code\(\s*404\s*\)/]},
        go: {all: [/registry\.IsRegistered\(/, /StatusNotFound/]},
        scala: {all: [/Registry\.isRegistered\(/, /StatusCodes\.NotFound/]},
        cpp: {all: [/registry::isRegistered\(/, /\b404\b/]},
      },
    },
    {
      id: 'hourly',
      title: 'Reports each of the 24 complete hours',
      detail:
        '`hours` lists the 24 hours before the current one, oldest first, each with its start and its `indexed` count; the starter answers one sum, in which a dead hour disappears.',
      match: {
        python: {all: [/"hours"/, /"hour"/], none: [/sum\(ledger\.hourly_counts/]},
        typescript: {all: [/hours:/, /hour,/], none: [/\.reduce\(/]},
        go: {all: [/"hours"/, /json:"hour"/], none: [/total \+=/]},
        scala: {all: [/"hours"/, /"hour"/], none: [/\.sum\b/]},
        cpp: {all: [/"hours"/, /"hour"/], none: [/total \+=/]},
      },
    },
    {
      id: 'expectation-per-tenant',
      title: "Compares each hour with the service's own baseline",
      detail:
        "`expected` comes from `expected_per_hour(tenant, service, …)`, the service's mean over the 7 days before the window; the starter's global `EXPECTED_PER_HOUR` makes every service's normal look like one tenant's.",
      match: {
        python: {all: [/ledger\.expected_per_hour\(tenant,\s*service/], none: [/EXPECTED_PER_HOUR/]},
        typescript: {all: [/expectedPerHour\(tenant,\s*service/], none: [/EXPECTED_PER_HOUR/]},
        go: {all: [/ledger\.ExpectedPerHour\(r\.Context\(\),\s*tenant,\s*service/], none: [/expectedPerHour\s*=/]},
        scala: {all: [/Ledger\.expectedPerHour\(tenant,\s*service/], none: [/ExpectedPerHour\s*=/]},
        cpp: {all: [/ledger::expectedPerHour\(tenant,\s*service/], none: [/kExpectedPerHour/]},
      },
    },
    {
      id: 'gap-threshold',
      title: 'Flags an hour more than half below its baseline',
      detail:
        'An hour below `expected × (1 − GAP_THRESHOLD)` has `gap: true`, and the body counts them in `gaps` next to `threshold`; the starter flags nothing, so a dead hour never shows on the page.',
      match: {
        python: {all: [/GAP_THRESHOLD\s*=\s*0\.5/, /"gap"/, /"gaps"/]},
        typescript: {all: [/GAP_THRESHOLD\s*=\s*0\.5/, /gap:/, /gaps:/]},
        go: {all: [/gapThreshold\s*=\s*0\.5/, /json:"gap"/, /"gaps"/]},
        scala: {all: [/GapThreshold\s*=\s*0\.5/, /"gap"/, /"gaps"/]},
        cpp: {all: [/kGapThreshold\s*=\s*0\.5/, /"gap"/, /"gaps"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

from fastapi import FastAPI, HTTPException, Request

from logindex import ledger  # ledger.hourly_counts(tenant, service, hours), ledger.expected_per_hour(tenant, service, before)
from logindex import registry  # registry.is_registered(tenant, service) -> bool

app = FastAPI()

HOUR_S = 3600
WINDOW_HOURS = 24
EXPECTED_PER_HOUR = 1000


@app.get("/v1/services/{service}/completeness")
def completeness(service: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    current = int(time.time()) // HOUR_S * HOUR_S
    hours = [current - HOUR_S * (WINDOW_HOURS - i) for i in range(WINDOW_HOURS)]
    indexed = sum(ledger.hourly_counts(tenant, service, hours))
    expected = EXPECTED_PER_HOUR * WINDOW_HOURS
    return {"service": service, "indexed": indexed, "expected": expected, "complete": indexed >= expected}
`,
      solution: `import time

from fastapi import FastAPI, HTTPException, Request

from logindex import ledger  # ledger.hourly_counts(tenant, service, hours), ledger.expected_per_hour(tenant, service, before)
from logindex import registry  # registry.is_registered(tenant, service) -> bool

app = FastAPI()

HOUR_S = 3600
WINDOW_HOURS = 24
GAP_THRESHOLD = 0.5


@app.get("/v1/services/{service}/completeness")
def completeness(service: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    # Another tenant's service is as absent as one that never existed.
    if not registry.is_registered(tenant, service):
        raise HTTPException(status_code=404, detail="no such service in the tenant's registry")
    current = int(time.time()) // HOUR_S * HOUR_S
    # The complete hours before the current one, oldest first: a partial hour would always look short.
    hours = [current - HOUR_S * (WINDOW_HOURS - i) for i in range(WINDOW_HOURS)]
    counts = ledger.hourly_counts(tenant, service, hours)
    expected = ledger.expected_per_hour(tenant, service, hours[0])
    buckets = [
        {"hour": hour, "indexed": count, "expected": expected, "gap": count < expected * (1 - GAP_THRESHOLD)}
        for hour, count in zip(hours, counts)
    ]
    return {"service": service, "hours": buckets, "gaps": sum(1 for b in buckets if b["gap"]), "threshold": GAP_THRESHOLD}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {expectedPerHour, hourlyCounts} from 'logindex/ledger'; // hourlyCounts(tenant, service, hours), expectedPerHour(tenant, service, before)
import {isRegistered} from 'logindex/registry'; // isRegistered(tenant, service) → boolean

export const app = Fastify();

const HOUR_S = 3600;
const WINDOW_HOURS = 24;
const EXPECTED_PER_HOUR = 1000;

app.get('/v1/services/:service/completeness', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {service} = request.params as {service: string};
  const current = Math.floor(Date.now() / 1000 / HOUR_S) * HOUR_S;
  const hours = Array.from({length: WINDOW_HOURS}, (_, i) => current - HOUR_S * (WINDOW_HOURS - i));
  const indexed = (await hourlyCounts(tenant, service, hours)).reduce((sum, n) => sum + n, 0);
  const expected = EXPECTED_PER_HOUR * WINDOW_HOURS;
  return {service, indexed, expected, complete: indexed >= expected};
});
`,
      solution: `import Fastify from 'fastify';

import {expectedPerHour, hourlyCounts} from 'logindex/ledger'; // hourlyCounts(tenant, service, hours), expectedPerHour(tenant, service, before)
import {isRegistered} from 'logindex/registry'; // isRegistered(tenant, service) → boolean

export const app = Fastify();

const HOUR_S = 3600;
const WINDOW_HOURS = 24;
export const GAP_THRESHOLD = 0.5;

app.get('/v1/services/:service/completeness', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const {service} = request.params as {service: string};
  // Another tenant's service is as absent as one that never existed.
  if (!(await isRegistered(tenant, service))) return reply.code(404).send({error: "no such service in the tenant's registry"});
  const current = Math.floor(Date.now() / 1000 / HOUR_S) * HOUR_S;
  // The complete hours before the current one, oldest first: a partial hour would always look short.
  const hours = Array.from({length: WINDOW_HOURS}, (_, i) => current - HOUR_S * (WINDOW_HOURS - i));
  const counts = await hourlyCounts(tenant, service, hours);
  const expected = await expectedPerHour(tenant, service, hours[0]);
  const buckets = hours.map((hour, i) => ({hour, indexed: counts[i], expected, gap: counts[i] < expected * (1 - GAP_THRESHOLD)}));
  return {service, hours: buckets, gaps: buckets.filter(b => b.gap).length, threshold: GAP_THRESHOLD};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"logindex/ledger" // ledger.HourlyCounts(ctx, tenant, service, hours), ledger.ExpectedPerHour(ctx, tenant, service, before)
	// registry.IsRegistered(ctx, tenant, service) (bool, error) is in "logindex/registry"
)

const (
	hourS           = 3600
	windowHours     = 24
	expectedPerHour = 1000
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func completeness(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	service := r.PathValue("service")
	current := time.Now().Unix() / hourS * hourS
	hours := make([]int64, windowHours)
	for i := range hours {
		hours[i] = current - hourS*int64(windowHours-i)
	}
	counts, err := ledger.HourlyCounts(r.Context(), tenant, service, hours)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	var total int64
	for _, n := range counts {
		total += n
	}
	expected := int64(expectedPerHour * windowHours)
	writeJSON(rw, http.StatusOK, map[string]any{"service": service, "indexed": total, "expected": expected, "complete": total >= expected})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/services/{service}/completeness", completeness)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"time"

	"logindex/ledger"   // ledger.HourlyCounts(ctx, tenant, service, hours), ledger.ExpectedPerHour(ctx, tenant, service, before)
	"logindex/registry" // registry.IsRegistered(ctx, tenant, service) (bool, error)
)

const (
	hourS        = 3600
	windowHours  = 24
	gapThreshold = 0.5
)

type bucket struct {
	Hour     int64 \`json:"hour"\`
	Indexed  int64 \`json:"indexed"\`
	Expected int64 \`json:"expected"\`
	Gap      bool  \`json:"gap"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func completeness(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "X-Tenant-Id is required"})
		return
	}
	service := r.PathValue("service")
	known, err := registry.IsRegistered(r.Context(), tenant, service)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	// Another tenant's service is as absent as one that never existed.
	if !known {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "no such service in the tenant's registry"})
		return
	}
	current := time.Now().Unix() / hourS * hourS
	// The complete hours before the current one, oldest first: a partial hour would always look short.
	hours := make([]int64, windowHours)
	for i := range hours {
		hours[i] = current - hourS*int64(windowHours-i)
	}
	counts, err := ledger.HourlyCounts(r.Context(), tenant, service, hours)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	expected, err := ledger.ExpectedPerHour(r.Context(), tenant, service, hours[0])
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	buckets := make([]bucket, len(hours))
	gaps := 0
	for i, hour := range hours {
		gap := float64(counts[i]) < float64(expected)*(1-gapThreshold)
		if gap {
			gaps++
		}
		buckets[i] = bucket{Hour: hour, Indexed: counts[i], Expected: expected, Gap: gap}
	}
	writeJSON(rw, http.StatusOK, map[string]any{"service": service, "hours": buckets, "gaps": gaps, "threshold": gapThreshold})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/services/{service}/completeness", completeness)
}
`,
    },
    scala: {
      starter: `import java.time.Instant

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import logindex.Ledger   // Ledger.hourlyCounts(tenant, service, hours), Ledger.expectedPerHour(tenant, service, before)
import logindex.Registry // Registry.isRegistered(tenant, service): Boolean

object Read {
  val HourS = 3600L
  val WindowHours = 24
  val ExpectedPerHour = 1000L

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  def completeness(tenant: String, service: String): HttpResponse = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val current = Instant.now().getEpochSecond / HourS * HourS
    val hours = (0 until WindowHours).map(i => current - HourS * (WindowHours - i))
    val indexed = Ledger.hourlyCounts(tenant, service, hours).sum
    val expected = ExpectedPerHour * WindowHours
    json(StatusCodes.OK, JsObject("service" -> JsString(service), "indexed" -> JsNumber(indexed), "expected" -> JsNumber(expected), "complete" -> JsBoolean(indexed >= expected)))
  }

  val route: Route = path("v1" / "services" / Segment / "completeness") { service =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required"))))
        case Some(tenant) => complete(completeness(tenant, service))
      }
    }
  }
}
`,
      solution: `import java.time.Instant

import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import logindex.Ledger   // Ledger.hourlyCounts(tenant, service, hours), Ledger.expectedPerHour(tenant, service, before)
import logindex.Registry // Registry.isRegistered(tenant, service): Boolean

object Read {
  val HourS = 3600L
  val WindowHours = 24
  val GapThreshold = 0.5

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  def completeness(tenant: String, service: String): HttpResponse =
    // Another tenant's service is as absent as one that never existed.
    if (!Registry.isRegistered(tenant, service)) json(StatusCodes.NotFound, JsObject("error" -> JsString("no such service in the tenant's registry")))
    else {
      val current = Instant.now().getEpochSecond / HourS * HourS
      // The complete hours before the current one, oldest first: a partial hour would always look short.
      val hours = (0 until WindowHours).map(i => current - HourS * (WindowHours - i))
      val counts = Ledger.hourlyCounts(tenant, service, hours)
      val expected = Ledger.expectedPerHour(tenant, service, hours.head)
      val buckets = hours.zip(counts).map { case (hour, count) =>
        JsObject("hour" -> JsNumber(hour), "indexed" -> JsNumber(count), "expected" -> JsNumber(expected), "gap" -> JsBoolean(count < expected * (1 - GapThreshold)))
      }
      val gaps = buckets.count(_.fields("gap") == JsTrue)
      json(StatusCodes.OK, JsObject("service" -> JsString(service), "hours" -> JsArray(buckets.toVector), "gaps" -> JsNumber(gaps), "threshold" -> JsNumber(GapThreshold)))
    }

  val route: Route = path("v1" / "services" / Segment / "completeness") { service =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(json(StatusCodes.Unauthorized, JsObject("error" -> JsString("X-Tenant-Id is required"))))
        case Some(tenant) => complete(completeness(tenant, service))
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>
#include <vector>

#include "logindex/ledger.h"    // ledger::hourlyCounts(tenant, service, hours), ledger::expectedPerHour(tenant, service, before)
#include "logindex/registry.h"  // registry::isRegistered(tenant, service) -> bool

using json = nlohmann::json;

constexpr long long kHourS = 3600;
constexpr int kWindowHours = 24;
constexpr long long kExpectedPerHour = 1000;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void completeness(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string service = req.matches[1];
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long long current = now / kHourS * kHourS;
  std::vector<long long> hours;
  for (int i = 0; i < kWindowHours; i++) hours.push_back(current - kHourS * (kWindowHours - i));
  long long total = 0;
  for (long long n : ledger::hourlyCounts(tenant, service, hours)) total += n;
  const long long expected = kExpectedPerHour * kWindowHours;
  reply(res, 200, {{"service", service}, {"indexed", total}, {"expected", expected}, {"complete", total >= expected}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/services/([\\w.-]+)/completeness)", completeness); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>
#include <vector>

#include "logindex/ledger.h"    // ledger::hourlyCounts(tenant, service, hours), ledger::expectedPerHour(tenant, service, before)
#include "logindex/registry.h"  // registry::isRegistered(tenant, service) -> bool

using json = nlohmann::json;

constexpr long long kHourS = 3600;
constexpr int kWindowHours = 24;
constexpr double kGapThreshold = 0.5;

void reply(httplib::Response& res, int status, const json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void completeness(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) return reply(res, 401, {{"error", "X-Tenant-Id is required"}});
  const std::string service = req.matches[1];
  // Another tenant's service is as absent as one that never existed.
  if (!registry::isRegistered(tenant, service)) return reply(res, 404, {{"error", "no such service in the tenant's registry"}});
  const long long now = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long long current = now / kHourS * kHourS;
  // The complete hours before the current one, oldest first: a partial hour would always look short.
  std::vector<long long> hours;
  for (int i = 0; i < kWindowHours; i++) hours.push_back(current - kHourS * (kWindowHours - i));
  const std::vector<long long> counts = ledger::hourlyCounts(tenant, service, hours);
  const long long expected = ledger::expectedPerHour(tenant, service, hours.front());
  json buckets = json::array();
  int gaps = 0;
  for (size_t i = 0; i < hours.size(); i++) {
    const bool gap = static_cast<double>(counts[i]) < static_cast<double>(expected) * (1 - kGapThreshold);
    gaps += gap;
    buckets.push_back({{"hour", hours[i]}, {"indexed", counts[i]}, {"expected", expected}, {"gap", gap}});
  }
  reply(res, 200, {{"service", service}, {"hours", buckets}, {"gaps", gaps}, {"threshold", kGapThreshold}});
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/services/([\\w.-]+)/completeness)", completeness); }
`,
    },
  },
  harness: {
    python: `import time

from logindex import ledger, registry

HOUR = 3600
# Window hours (by index) that differ from the baseline.
ACME = {5: 3000, 9: 6000, 20: 0}
GLOBEX = {3: 8}


def _window():
    current = int(time.time()) // HOUR * HOUR
    return [current - HOUR * (24 - i) for i in range(24)]


def _api(ctx):
    m = ctx.load("read")
    registry.add_service("acme", "checkout")
    registry.add_service("globex", "checkout")
    registry.add_service("globex", "search")
    hours = _window()
    for i in range(1, 169):
        ledger.record_indexed("acme", "checkout", hours[0] - HOUR * i, 10000)
        ledger.record_indexed("globex", "checkout", hours[0] - HOUR * i, 10)
    for i, hour in enumerate(hours):
        ledger.record_indexed("acme", "checkout", hour, ACME.get(i, 10000))
        ledger.record_indexed("globex", "checkout", hour, GLOBEX.get(i, 10))
    ledger.record_indexed("acme", "checkout", hours[-1] + HOUR, 40)  # the current hour, still filling
    return ctx.client(m.app), hours


async def _get(c, service, tenant="acme"):
    return await c.get(f"/v1/services/{service}/completeness", headers={"X-Tenant-Id": tenant} if tenant else {})


async def _report(c, service="checkout", tenant="acme"):
    r = await _get(c, service, tenant)
    assert r.status_code == 200, f"{tenant}'s completeness of {service} answered {r.status_code}: {r.text}"
    return r.json()


def _buckets(body):
    hours = body.get("hours")
    assert isinstance(hours, list) and len(hours) == 24, f"the report must list the 24 complete hours, got hours {hours!r} in {body}"
    return hours


async def check_route(ctx):
    c, _ = _api(ctx)
    async with c:
        body = await _report(c)
    assert body.get("service") == "checkout", f"the report must name the service, got {body}"


async def check_foreign_404(ctx):
    c, _ = _api(ctx)
    async with c:
        anonymous = await _get(c, "checkout", tenant=None)
        foreign = await _get(c, "search")
        unknown = await _get(c, "chekout")
        own = await _get(c, "checkout")
    assert anonymous.status_code == 401, f"a read without X-Tenant-Id answered {anonymous.status_code}, expected 401"
    assert foreign.status_code == 404, f"acme reading search, a service only globex registered, answered {foreign.status_code}: {foreign.text}. Another tenant's pipeline must be 404"
    assert unknown.status_code == 404, f"a service nobody registered answered {unknown.status_code}, expected 404"
    assert own.status_code == 200, f"acme reading its own checkout answered {own.status_code}: {own.text}"


async def check_hourly(ctx):
    c, hours = _api(ctx)
    async with c:
        buckets = _buckets(await _report(c))
    assert [b.get("hour") for b in buckets] == hours, f"the hours must be the 24 complete hours before now, oldest first, by their start in epoch seconds: expected {hours[0]} … {hours[-1]}, got {buckets[0].get('hour')} … {buckets[-1].get('hour')}"
    want = [ACME.get(i, 10000) for i in range(24)]
    assert [b.get("indexed") for b in buckets] == want, f"each hour must carry its indexed count from the ledger: expected {want}, got {[b.get('indexed') for b in buckets]}"


async def check_expectation_per_tenant(ctx):
    c, _ = _api(ctx)
    async with c:
        acme = _buckets(await _report(c))
        globex = _buckets(await _report(c, tenant="globex"))
    assert {b.get("expected") for b in acme} == {10000}, f"acme's checkout indexed 10000 an hour all week, its hours expect {sorted({b.get('expected') for b in acme})}: the baseline is the service's own history"
    assert {b.get("expected") for b in globex} == {10}, f"globex's checkout indexed 10 an hour all week, its hours expect {sorted({b.get('expected') for b in globex})}: one tenant's volume is not another's baseline"


async def check_gap_threshold(ctx):
    c, _ = _api(ctx)
    async with c:
        acme = await _report(c)
        globex = await _report(c, tenant="globex")
    flagged = [i for i, b in enumerate(_buckets(acme)) if b.get("gap") is True]
    assert flagged == [5, 20], f"against a baseline of 10000, the hours with 3000 and 0 are gaps and the one with 6000 is not; flagged hours {flagged}, expected [5, 20]"
    assert acme.get("gaps") == 2 and acme.get("threshold") == 0.5, f"the report must count its gaps (2) and carry the threshold (0.5), got gaps {acme.get('gaps')!r}, threshold {acme.get('threshold')!r}"
    quiet = [i for i, b in enumerate(_buckets(globex)) if b.get("gap") is not False]
    assert quiet == [] and globex.get("gaps") == 0, f"globex's checkout at 10 an hour (8 once) against its baseline of 10 has no gap, the report flags hours {quiet}"
`,
    typescript: `const HOUR = 3600;
const ACME: Record<number, number> = {5: 3000, 9: 6000, 20: 0};
const GLOBEX: Record<number, number> = {3: 8};

async function api(ctx) {
  const m = ctx.load('read');
  const registry = ctx.load('/support/logindex/registry.ts');
  const ledger = ctx.load('/support/logindex/ledger.ts');
  await registry.addService('acme', 'checkout');
  await registry.addService('globex', 'checkout');
  await registry.addService('globex', 'search');
  const current = Math.floor(ctx.clock.now() / 1000 / HOUR) * HOUR;
  const hours = Array.from({length: 24}, (_, i) => current - HOUR * (24 - i));
  for (let i = 1; i <= 168; i += 1) {
    await ledger.recordIndexed('acme', 'checkout', hours[0] - HOUR * i, 10000);
    await ledger.recordIndexed('globex', 'checkout', hours[0] - HOUR * i, 10);
  }
  for (let i = 0; i < 24; i += 1) {
    await ledger.recordIndexed('acme', 'checkout', hours[i], ACME[i] ?? 10000);
    await ledger.recordIndexed('globex', 'checkout', hours[i], GLOBEX[i] ?? 10);
  }
  await ledger.recordIndexed('acme', 'checkout', current, 40); // the current hour, still filling
  return {c: ctx.client(m.app), hours};
}

const get = (c, service: string, tenant: string | null = 'acme') =>
  c.get(\`/v1/services/\${service}/completeness\`, {headers: tenant === null ? {} : {'X-Tenant-Id': tenant}});

async function report(c, service = 'checkout', tenant = 'acme') {
  const r = await get(c, service, tenant);
  assert.equal(r.status, 200, \`\${tenant}'s completeness of \${service} answered \${r.status}: \${r.text}\`);
  return r.json();
}

function buckets(body) {
  assert(Array.isArray(body.hours) && body.hours.length === 24, \`the report must list the 24 complete hours, got \${JSON.stringify(body)}\`);
  return body.hours;
}

export async function check_route(ctx) {
  const {c} = await api(ctx);
  const body = await report(c);
  assert.equal(body.service, 'checkout', \`the report must name the service, got \${JSON.stringify(body)}\`);
}

export async function check_foreign_404(ctx) {
  const {c} = await api(ctx);
  const anonymous = await get(c, 'checkout', null);
  const foreign = await get(c, 'search');
  const unknown = await get(c, 'chekout');
  const own = await get(c, 'checkout');
  assert.equal(anonymous.status, 401, \`a read without X-Tenant-Id answered \${anonymous.status}, expected 401\`);
  assert.equal(foreign.status, 404, \`acme reading search, a service only globex registered, answered \${foreign.status}: \${foreign.text}. Another tenant's pipeline must be 404\`);
  assert.equal(unknown.status, 404, \`a service nobody registered answered \${unknown.status}, expected 404\`);
  assert.equal(own.status, 200, \`acme reading its own checkout answered \${own.status}: \${own.text}\`);
}

export async function check_hourly(ctx) {
  const {c, hours} = await api(ctx);
  const b = buckets(await report(c));
  assert.deepStrictEqual(b.map(x => x.hour), hours, \`the hours must be the 24 complete hours before now, oldest first, by their start in epoch seconds: expected \${hours[0]} … \${hours[23]}, got \${b[0].hour} … \${b[23].hour}\`);
  const want = Array.from({length: 24}, (_, i) => ACME[i] ?? 10000);
  assert.deepStrictEqual(b.map(x => x.indexed), want, \`each hour must carry its indexed count from the ledger: expected \${JSON.stringify(want)}, got \${JSON.stringify(b.map(x => x.indexed))}\`);
}

export async function check_expectation_per_tenant(ctx) {
  const {c} = await api(ctx);
  const acme = [...new Set(buckets(await report(c)).map(x => x.expected))];
  const globex = [...new Set(buckets(await report(c, 'checkout', 'globex')).map(x => x.expected))];
  assert.deepStrictEqual(acme, [10000], \`acme's checkout indexed 10000 an hour all week, its hours expect \${JSON.stringify(acme)}: the baseline is the service's own history\`);
  assert.deepStrictEqual(globex, [10], \`globex's checkout indexed 10 an hour all week, its hours expect \${JSON.stringify(globex)}: one tenant's volume is not another's baseline\`);
}

export async function check_gap_threshold(ctx) {
  const {c} = await api(ctx);
  const acme = await report(c);
  const globex = await report(c, 'checkout', 'globex');
  const flagged = buckets(acme).flatMap((x, i) => (x.gap === true ? [i] : []));
  assert.deepStrictEqual(flagged, [5, 20], \`against a baseline of 10000, the hours with 3000 and 0 are gaps and the one with 6000 is not; flagged hours \${JSON.stringify(flagged)}, expected [5, 20]\`);
  assert(acme.gaps === 2 && acme.threshold === 0.5, \`the report must count its gaps (2) and carry the threshold (0.5), got gaps \${acme.gaps}, threshold \${acme.threshold}\`);
  const quiet = buckets(globex).flatMap((x, i) => (x.gap !== false ? [i] : []));
  assert(quiet.length === 0 && globex.gaps === 0, \`globex's checkout at 10 an hour (8 once) against its baseline of 10 has no gap, the report flags hours \${JSON.stringify(quiet)}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"net/http"

	"logindex/ledger"
	"logindex/registry"

	"leetbuild/harness"
)

const readHour = 3600

var (
	readBg     = context.Background()
	readAcme   = map[int]int64{5: 3000, 9: 6000, 20: 0}
	readGlobex = map[int]int64{3: 8}
)

type readBucket struct {
	Hour     int64 \`json:"hour"\`
	Indexed  int64 \`json:"indexed"\`
	Expected int64 \`json:"expected"\`
	Gap      *bool \`json:"gap"\`
}

type readReport struct {
	Service   string       \`json:"service"\`
	Hours     []readBucket \`json:"hours"\`
	Gaps      *int         \`json:"gaps"\`
	Threshold *float64     \`json:"threshold"\`
}

func countOr(m map[int]int64, i int, fallback int64) int64 {
	if n, ok := m[i]; ok {
		return n
	}
	return fallback
}

func readAPI(ctx *harness.Ctx) (*harness.HTTP, []int64) {
	registry.AddService(readBg, "acme", "checkout")
	registry.AddService(readBg, "globex", "checkout")
	registry.AddService(readBg, "globex", "search")
	current := ctx.Clock.Now() / 1000 / readHour * readHour
	hours := make([]int64, 24)
	for i := range hours {
		hours[i] = current - readHour*int64(24-i)
	}
	for i := int64(1); i <= 168; i++ {
		ledger.RecordIndexed(readBg, "acme", "checkout", hours[0]-readHour*i, 10000)
		ledger.RecordIndexed(readBg, "globex", "checkout", hours[0]-readHour*i, 10)
	}
	for i, hour := range hours {
		ledger.RecordIndexed(readBg, "acme", "checkout", hour, countOr(readAcme, i, 10000))
		ledger.RecordIndexed(readBg, "globex", "checkout", hour, countOr(readGlobex, i, 10))
	}
	ledger.RecordIndexed(readBg, "acme", "checkout", current, 40) // the current hour, still filling
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux), hours
}

func getReport(c *harness.HTTP, service, tenant string) *harness.Response {
	if tenant == "" {
		return c.Get("/v1/services/" + service + "/completeness")
	}
	return c.Get("/v1/services/"+service+"/completeness", "X-Tenant-Id", tenant)
}

func mustReport(ctx *harness.Ctx, c *harness.HTTP, tenant string) readReport {
	r := getReport(c, "checkout", tenant)
	ctx.Equal(r.Status, 200, "%s's completeness of checkout (%s)", tenant, r.Text())
	var body readReport
	json.Unmarshal(r.Body, &body)
	ctx.Assert(len(body.Hours) == 24, "the report must list the 24 complete hours, got %s", r.Text())
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	c, _ := readAPI(ctx)
	r := getReport(c, "checkout", "acme")
	ctx.Equal(r.Status, 200, "acme's completeness of checkout (%s)", r.Text())
	var body readReport
	json.Unmarshal(r.Body, &body)
	ctx.Equal(body.Service, "checkout", "the report must name the service")
}

func CheckForeign404(ctx *harness.Ctx) {
	c, _ := readAPI(ctx)
	ctx.Equal(getReport(c, "checkout", "").Status, 401, "a read without X-Tenant-Id")
	foreign := getReport(c, "search", "acme")
	ctx.Equal(foreign.Status, 404, "acme reading search, a service only globex registered, must be 404 (%s); another tenant's pipeline", foreign.Text())
	ctx.Equal(getReport(c, "chekout", "acme").Status, 404, "a service nobody registered")
	ctx.Equal(getReport(c, "checkout", "acme").Status, 200, "acme reading its own checkout")
}

func CheckHourly(ctx *harness.Ctx) {
	c, hours := readAPI(ctx)
	body := mustReport(ctx, c, "acme")
	got := make([]int64, 24)
	indexed := make([]int64, 24)
	want := make([]int64, 24)
	for i, b := range body.Hours {
		got[i] = b.Hour
		indexed[i] = b.Indexed
		want[i] = countOr(readAcme, i, 10000)
	}
	ctx.Equal(got, hours, "the hours must be the 24 complete hours before now, oldest first, by their start in epoch seconds")
	ctx.Equal(indexed, want, "each hour must carry its indexed count from the ledger")
}

func CheckExpectationPerTenant(ctx *harness.Ctx) {
	c, _ := readAPI(ctx)
	for _, tc := range []struct {
		tenant string
		want   int64
	}{{"acme", 10000}, {"globex", 10}} {
		for _, b := range mustReport(ctx, c, tc.tenant).Hours {
			ctx.Equal(b.Expected, tc.want, "%s's checkout indexed %d an hour all week: the baseline is the service's own history; an hour's expected", tc.tenant, tc.want)
		}
	}
}

func CheckGapThreshold(ctx *harness.Ctx) {
	c, _ := readAPI(ctx)
	acme := mustReport(ctx, c, "acme")
	flagged := []int{}
	for i, b := range acme.Hours {
		if b.Gap != nil && *b.Gap {
			flagged = append(flagged, i)
		}
	}
	ctx.Equal(flagged, []int{5, 20}, "against a baseline of 10000, the hours with 3000 and 0 are gaps and the one with 6000 is not; the flagged hours")
	ctx.Assert(acme.Gaps != nil && *acme.Gaps == 2 && acme.Threshold != nil && *acme.Threshold == 0.5, "the report must count its gaps (2) and carry the threshold (0.5)")
	globex := mustReport(ctx, c, "globex")
	quiet := []int{}
	for i, b := range globex.Hours {
		if b.Gap == nil || *b.Gap {
			quiet = append(quiet, i)
		}
	}
	ctx.Assert(len(quiet) == 0 && globex.Gaps != nil && *globex.Gaps == 0, "globex's checkout at 10 an hour (8 once) against its baseline of 10 has no gap, the report flags hours %v", quiet)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <map>
#include <nlohmann/json.hpp>
#include <string>
#include <vector>

#include "logindex/ledger.h"
#include "logindex/registry.h"

using json = nlohmann::json;

namespace {

constexpr long long kHour = 3600;
const std::map<int, long long> kAcme = {{5, 3000}, {9, 6000}, {20, 0}};
const std::map<int, long long> kGlobex = {{3, 8}};

long long countOr(const std::map<int, long long>& m, int i, long long fallback) { return m.count(i) ? m.at(i) : fallback; }

std::vector<long long> window(harness::Ctx& ctx) {
  const long long current = ctx.Clock.Now() / 1000 / kHour * kHour;
  std::vector<long long> hours;
  for (int i = 0; i < 24; i++) hours.push_back(current - kHour * (24 - i));
  return hours;
}

harness::HTTP readAPI(harness::Ctx& ctx) {
  registry::addService("acme", "checkout");
  registry::addService("globex", "checkout");
  registry::addService("globex", "search");
  const auto hours = window(ctx);
  for (long long i = 1; i <= 168; i++) {
    ledger::recordIndexed("acme", "checkout", hours[0] - kHour * i, 10000);
    ledger::recordIndexed("globex", "checkout", hours[0] - kHour * i, 10);
  }
  for (int i = 0; i < 24; i++) {
    ledger::recordIndexed("acme", "checkout", hours[i], countOr(kAcme, i, 10000));
    ledger::recordIndexed("globex", "checkout", hours[i], countOr(kGlobex, i, 10));
  }
  ledger::recordIndexed("acme", "checkout", hours.back() + kHour, 40);  // the current hour, still filling
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response getReport(harness::HTTP& c, const std::string& service, const std::string& tenant) {
  if (tenant.empty()) return c.Get("/v1/services/" + service + "/completeness");
  return c.Get("/v1/services/" + service + "/completeness", "X-Tenant-Id", tenant);
}

json mustReport(harness::Ctx& ctx, harness::HTTP& c, const std::string& tenant) {
  const auto r = getReport(c, "checkout", tenant);
  ctx.Equal(r.Status, 200, "%s's completeness of checkout (%s)", tenant, r.Text());
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object() && body.contains("hours") && body["hours"].is_array() && body["hours"].size() == 24, "the report must list the 24 complete hours, got %s", r.Text());
  return body;
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  const auto r = getReport(c, "checkout", "acme");
  ctx.Equal(r.Status, 200, "acme's completeness of checkout (%s)", r.Text());
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Equal(body.is_object() ? body.value("service", "") : std::string(), "checkout", "the report must name the service");
}

void CheckForeign404(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  ctx.Equal(getReport(c, "checkout", "").Status, 401, "a read without X-Tenant-Id");
  const auto foreign = getReport(c, "search", "acme");
  ctx.Equal(foreign.Status, 404, "acme reading search, a service only globex registered, must be 404 (%s); another tenant's pipeline", foreign.Text());
  ctx.Equal(getReport(c, "chekout", "acme").Status, 404, "a service nobody registered");
  ctx.Equal(getReport(c, "checkout", "acme").Status, 200, "acme reading its own checkout");
}

void CheckHourly(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  const auto hours = window(ctx);
  const json body = mustReport(ctx, c, "acme");
  std::vector<long long> got, indexed, want;
  for (int i = 0; i < 24; i++) {
    got.push_back(body["hours"][i].value("hour", 0LL));
    indexed.push_back(body["hours"][i].value("indexed", -1LL));
    want.push_back(countOr(kAcme, i, 10000));
  }
  ctx.Equal(got, hours, "the hours must be the 24 complete hours before now, oldest first, by their start in epoch seconds");
  ctx.Equal(indexed, want, "each hour must carry its indexed count from the ledger");
}

void CheckExpectationPerTenant(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  for (const auto& [tenant, expected] : std::vector<std::pair<std::string, long long>>{{"acme", 10000}, {"globex", 10}}) {
    for (const auto& b : mustReport(ctx, c, tenant)["hours"]) {
      ctx.Equal(b.value("expected", -1LL), expected, "%s's checkout indexed %d an hour all week: the baseline is the service's own history; an hour's expected", tenant, expected);
    }
  }
}

void CheckGapThreshold(harness::Ctx& ctx) {
  auto c = readAPI(ctx);
  const json acme = mustReport(ctx, c, "acme");
  std::vector<int> flagged;
  for (int i = 0; i < 24; i++) {
    const json& b = acme["hours"][i];
    if (b.contains("gap") && b["gap"].is_boolean() && b["gap"].get<bool>()) flagged.push_back(i);
  }
  ctx.Equal(flagged, {5, 20}, "against a baseline of 10000, the hours with 3000 and 0 are gaps and the one with 6000 is not; the flagged hours");
  ctx.Assert(acme.value("gaps", -1) == 2 && acme.value("threshold", -1.0) == 0.5, "the report must count its gaps (2) and carry the threshold (0.5), got %s", acme.dump().substr(0, 200));
  const json globex = mustReport(ctx, c, "globex");
  std::vector<int> quiet;
  for (int i = 0; i < 24; i++) {
    const json& b = globex["hours"][i];
    if (!(b.contains("gap") && b["gap"].is_boolean() && !b["gap"].get<bool>())) quiet.push_back(i);
  }
  ctx.Assert(quiet.empty() && globex.value("gaps", -1) == 0, "globex's checkout at 10 an hour (8 once) against its baseline of 10 has no gap, the report flags hours %v", quiet);
}
`,
  },
  hints: [
    "Zero one hour of checkout's ledger: the report still reads close to complete. Ask for a service another tenant registered: it answers, with that tenant's volume. Nothing on the page ever says gap.",
    'The handler sums the 24 hours into one number and compares it with `EXPECTED_PER_HOUR × 24`, the same for every service of every tenant, and it never asks the registry whether the caller owns the service.',
    'Return 404 unless `registry.is_registered(tenant, service)`; build one bucket per hour from `hourly_counts` with `expected = expected_per_hour(tenant, service, hours[0])` and `gap = indexed < expected * (1 - GAP_THRESHOLD)`; return `hours`, `gaps` and `threshold`.',
  ],
  debrief: `Completeness is a comparison, so both sides have to belong to the service: its own hours against its own week, which is why the baseline is read for the tenant and the service and why a missing hour has to stay its own bucket instead of vanishing into a sum. The window stops at the last complete hour, because the current one is always short. The 404 for another tenant's service keeps the page from telling one tenant what another runs. A production report would weight the baseline by hour of day and day of week, since nightly traffic is not daytime traffic, and would page someone on the first gap rather than wait for the page to be opened.`,
};
