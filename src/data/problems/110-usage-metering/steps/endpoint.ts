import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/usage: a request counted once',
  concept: 'http',
  guides: ['request-boundaries', 'idempotent-requests'],
  file: 'api',
  focus: ['client', 'api', 'store'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/usage\` with body
\`{"request_id": "req_8f21", "account": "acct_1", "route": "/v1/generate", "units": 1200}\` from a
gateway that names itself in \`X-Gateway-Id\`. It writes the report through \`ledger.record_usage\`
(\`metering.ledger\`, provided) and answers \`{request_id, counted: true, units}\`. It serves the
demo and hides four flaws.

**Failure mode the checks target.** A gateway that times out re-sends the same report and the
starter counts it again, so an hour of retries reads as double the traffic. A negative or absurd
\`units\` lands in the window unchecked, and a report with no gateway, or a record stored without one,
cannot be reconciled against the gateway's logs.

- Count each \`(account, request_id)\` once: look it up with \`ledger.find_record\` before
  \`record_usage\`. A retry answers **200** with \`counted: false\` and the units counted the first time.
- \`request_id\`, \`account\` and \`route\` are non-empty and \`units\` is an integer from 0 to
  \`MAX_UNITS_PER_REQUEST\` (1,000,000); anything else is **400** and counts nothing.
- A missing or empty \`X-Gateway-Id\` is **400** with \`missing X-Gateway-Id\`.
- The record carries the gateway, and the response echoes it.`,
  sequence: {
    participants: ['Gateway', 'usaged', 'Usage ledger'],
    messages: [
      {from: 'Gateway', to: 'usaged', label: 'POST /v1/usage · X-Gateway-Id · request_id', kind: 'sync'},
      {from: 'usaged', to: 'usaged', label: 'gateway · strings · 0 ≤ units ≤ MAX → else 400', kind: 'sync'},
      {from: 'usaged', to: 'Usage ledger', label: 'find_record(account, request_id)', kind: 'sync'},
      {from: 'Usage ledger', to: 'usaged', label: 'counted before / none', kind: 'reply'},
      {from: 'usaged', to: 'Usage ledger', label: 'record_usage{…, gateway}', kind: 'sync'},
      {from: 'usaged', to: 'Gateway', label: '200 {counted, units, gateway}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/usage',
      detail:
        'Register the metering route on `POST /v1/usage`; a new report answers `counted: true` and lands in the window.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/usage["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/usage['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/usage"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"usage"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/usage"/]},
      },
    },
    {
      id: 'dedupe',
      title: 'Counts a request id once',
      detail:
        'The handler looks `(account, request_id)` up with `find_record`/`findRecord` before it records anything, and a retry answers the stored units with `counted: false`. The starter records every report it receives.',
      match: {
        python: {order: [/ledger\.find_record\(/, /ledger\.record_usage\(/]},
        typescript: {order: [/findRecord\(\s*body/, /recordUsage\(/]},
        go: {order: [/ledger\.FindRecord\(/, /ledger\.RecordUsage\(/]},
        scala: {order: [/Ledger\.findRecord\(/, /Ledger\.recordUsage\(/]},
        cpp: {order: [/ledger::findRecord\(/, /ledger::recordUsage\(/]},
      },
    },
    {
      id: 'validate',
      title: 'Bounds units and requires the ids',
      detail:
        'A report with an empty `request_id`, `account` or `route`, or `units` outside 0..`MAX_UNITS_PER_REQUEST` (Go `maxUnitsPerRequest`, Scala `MaxUnitsPerRequest`, C++ `kMaxUnitsPerRequest`), is **400** and counts nothing. The starter accepts any value.',
      match: {
        python: {all: [/MAX_UNITS_PER_REQUEST\s*=/, /[<>]=?\s*MAX_UNITS_PER_REQUEST\b/]},
        typescript: {all: [/MAX_UNITS_PER_REQUEST\s*=/, /[<>]=?\s*MAX_UNITS_PER_REQUEST\b/]},
        go: {all: [/maxUnitsPerRequest\s*=/, /[<>]=?\s*maxUnitsPerRequest\b/]},
        scala: {all: [/MaxUnitsPerRequest\s*=/, /[<>]=?\s*MaxUnitsPerRequest\b/]},
        cpp: {all: [/kMaxUnitsPerRequest\s*=/, /[<>]=?\s*kMaxUnitsPerRequest\b/]},
      },
    },
    {
      id: 'gateway-required',
      title: 'Requires the reporting gateway',
      detail:
        'A report without `X-Gateway-Id` (or with an empty one) is **400** with `missing X-Gateway-Id`, and nothing is counted. The starter reads the header for its log line only.',
      match: {
        python: {all: [/missing X-Gateway-Id/, /\b400\b/]},
        typescript: {all: [/missing X-Gateway-Id/, /\b400\b/]},
        go: {all: [/missing X-Gateway-Id/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/missing X-Gateway-Id/, /BadRequest/]},
        cpp: {all: [/missing X-Gateway-Id/, /\b400\b/]},
      },
    },
    {
      id: 'record-gateway',
      title: 'Stores the record with its gateway',
      detail:
        'The record handed to `record_usage`/`recordUsage` carries the gateway, and the response echoes it, so a spike can be joined to the gateway that reported it. The starter stores the record without it.',
      match: {
        python: {all: [/["']gateway["']\s*:\s*gateway\b/]},
        typescript: {all: [/recordUsage\(\{[^}]*\bgateway\b/]},
        go: {all: [/Gateway:\s*gateway\b/]},
        scala: {all: [/Ledger\.Record\([^)]*gateway\s*=\s*gateway\b/]},
        cpp: {all: [/record\.gateway\s*=\s*gateway\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Request
from pydantic import BaseModel

from metering import ledger  # find_record, record_usage

app = FastAPI()
log = logging.getLogger("usaged")


class UsageReport(BaseModel):
    request_id: str
    account: str
    route: str
    units: int


@app.post("/v1/usage")
def report_usage(body: UsageReport, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    gateway = request.headers.get("x-gateway-id")
    record = {"request_id": body.request_id, "account": body.account, "route": body.route, "units": body.units}
    ledger.record_usage(record)
    log.info("usage account=%s gateway=%s units=%d", body.account, gateway, body.units)
    return {"request_id": body.request_id, "counted": True, "units": body.units}
`,
      solution: `import logging

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel

from metering import ledger  # find_record, record_usage

app = FastAPI()
log = logging.getLogger("usaged")

MAX_UNITS_PER_REQUEST = 1_000_000


class UsageReport(BaseModel):
    request_id: str
    account: str
    route: str
    units: int


@app.post("/v1/usage")
def report_usage(body: UsageReport, request: Request) -> dict:
    gateway = request.headers.get("x-gateway-id", "")
    if not gateway:
        raise HTTPException(status_code=400, detail="missing X-Gateway-Id")
    if not body.request_id or not body.account or not body.route:
        raise HTTPException(status_code=400, detail="request_id, account and route are required")
    if not 0 <= body.units <= MAX_UNITS_PER_REQUEST:
        raise HTTPException(status_code=400, detail=f"units must be between 0 and {MAX_UNITS_PER_REQUEST}")
    stored = ledger.find_record(body.account, body.request_id)
    if stored is not None:
        # A retry of a counted request: answer what was counted, count nothing.
        return {"request_id": body.request_id, "counted": False, "units": stored["units"], "gateway": stored["gateway"]}
    record = {"request_id": body.request_id, "account": body.account, "route": body.route, "units": body.units, "gateway": gateway}
    ledger.record_usage(record)
    log.info("usage account=%s gateway=%s units=%d", body.account, gateway, body.units)
    return {"request_id": body.request_id, "counted": True, "units": body.units, "gateway": gateway}
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';

import {findRecord, recordUsage} from 'metering/ledger';

export const app = Fastify();

interface UsageReport {
  request_id: string;
  account: string;
  route: string;
  units: number;
}

app.post('/v1/usage', async request => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const body = request.body as UsageReport;
  const gateway = request.headers['x-gateway-id'];
  await recordUsage({request_id: body.request_id, account: body.account, route: body.route, units: body.units});
  request.log.info({account: body.account, gateway, units: body.units}, 'usage');
  return {request_id: body.request_id, counted: true, units: body.units};
});
`,
      solution: `import Fastify from 'fastify';

import {findRecord, recordUsage} from 'metering/ledger';

export const app = Fastify();

export const MAX_UNITS_PER_REQUEST = 1_000_000;

interface UsageReport {
  request_id: string;
  account: string;
  route: string;
  units: number;
}

app.post('/v1/usage', async (request, reply) => {
  const body = request.body as UsageReport;
  const gateway = request.headers['x-gateway-id'];
  if (typeof gateway !== 'string' || gateway === '') return reply.code(400).send({error: 'missing X-Gateway-Id'});
  if (!body.request_id || !body.account || !body.route) return reply.code(400).send({error: 'request_id, account and route are required'});
  if (!Number.isInteger(body.units) || body.units < 0 || body.units > MAX_UNITS_PER_REQUEST) {
    return reply.code(400).send({error: \`units must be between 0 and \${MAX_UNITS_PER_REQUEST}\`});
  }
  const stored = await findRecord(body.account, body.request_id);
  // A retry of a counted request: answer what was counted, count nothing.
  if (stored !== null) return {request_id: body.request_id, counted: false, units: stored.units, gateway: stored.gateway};
  await recordUsage({request_id: body.request_id, account: body.account, route: body.route, units: body.units, gateway});
  request.log.info({account: body.account, gateway, units: body.units}, 'usage');
  return {request_id: body.request_id, counted: true, units: body.units, gateway};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"metering/ledger" // ledger.FindRecord, RecordUsage, Record
)

type usageReport struct {
	RequestID string \`json:"request_id"\`
	Account   string \`json:"account"\`
	Route     string \`json:"route"\`
	Units     int64  \`json:"units"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func reportUsage(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	var body usageReport
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body must be a usage report", http.StatusBadRequest)
		return
	}
	gateway := r.Header.Get("X-Gateway-Id")
	record := ledger.Record{RequestID: body.RequestID, Account: body.Account, Route: body.Route, Units: body.Units}
	if _, err := ledger.RecordUsage(r.Context(), record); err != nil {
		http.Error(rw, err.Error(), http.StatusServiceUnavailable)
		return
	}
	log.Printf("usage account=%s gateway=%s units=%d", body.Account, gateway, body.Units)
	writeJSON(rw, http.StatusOK, map[string]any{"request_id": body.RequestID, "counted": true, "units": body.Units})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/usage", reportUsage)
}
`,
      solution: `package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"

	"metering/ledger" // ledger.FindRecord, RecordUsage, Record
)

const maxUnitsPerRequest = 1_000_000

type usageReport struct {
	RequestID string \`json:"request_id"\`
	Account   string \`json:"account"\`
	Route     string \`json:"route"\`
	Units     int64  \`json:"units"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func reportUsage(rw http.ResponseWriter, r *http.Request) {
	var body usageReport
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "the body must be a usage report", http.StatusBadRequest)
		return
	}
	gateway := r.Header.Get("X-Gateway-Id")
	if gateway == "" {
		http.Error(rw, "missing X-Gateway-Id", http.StatusBadRequest)
		return
	}
	if body.RequestID == "" || body.Account == "" || body.Route == "" {
		http.Error(rw, "request_id, account and route are required", http.StatusBadRequest)
		return
	}
	if body.Units < 0 || body.Units > maxUnitsPerRequest {
		http.Error(rw, fmt.Sprintf("units must be between 0 and %d", maxUnitsPerRequest), http.StatusBadRequest)
		return
	}
	if stored := ledger.FindRecord(r.Context(), body.Account, body.RequestID); stored != nil {
		// A retry of a counted request: answer what was counted, count nothing.
		writeJSON(rw, http.StatusOK, map[string]any{"request_id": body.RequestID, "counted": false, "units": stored.Units, "gateway": stored.Gateway})
		return
	}
	record := ledger.Record{RequestID: body.RequestID, Account: body.Account, Route: body.Route, Units: body.Units, Gateway: gateway}
	if _, err := ledger.RecordUsage(r.Context(), record); err != nil {
		http.Error(rw, err.Error(), http.StatusServiceUnavailable)
		return
	}
	log.Printf("usage account=%s gateway=%s units=%d", body.Account, gateway, body.Units)
	writeJSON(rw, http.StatusOK, map[string]any{"request_id": body.RequestID, "counted": true, "units": body.Units, "gateway": gateway})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/usage", reportUsage)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import metering.Ledger // Ledger.findRecord, recordUsage, Record

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(body: Map[String, JsValue], name: String): String = body.get(name).collect { case JsString(s) => s }.getOrElse("")
  private def number(body: Map[String, JsValue], name: String): Long = body.get(name).collect { case JsNumber(n) => n.toLong }.getOrElse(0L)

  val route: Route =
    path("v1" / "usage") {
      post {
        optionalHeaderValueByName("X-Gateway-Id") { gateway =>
          entity(as[String]) { raw =>
            // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
            val body = raw.parseJson.asJsObject.fields
            val (requestId, account, units) = (text(body, "request_id"), text(body, "account"), number(body, "units"))
            Ledger.recordUsage(Ledger.Record(requestId, account, text(body, "route"), units))
            println(s"usage account=$account gateway=\${gateway.getOrElse("")} units=$units")
            complete(json(StatusCodes.OK, JsObject("request_id" -> JsString(requestId), "counted" -> JsTrue, "units" -> JsNumber(units))))
          }
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import metering.Ledger // Ledger.findRecord, recordUsage, Record

object Api {
  val MaxUnitsPerRequest = 1000000L

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def text(body: Map[String, JsValue], name: String): String = body.get(name).collect { case JsString(s) => s }.getOrElse("")
  private def number(body: Map[String, JsValue], name: String): Long = body.get(name).collect { case JsNumber(n) => n.toLong }.getOrElse(0L)

  private def answer(requestId: String, counted: Boolean, units: Long, gateway: String): HttpResponse =
    json(StatusCodes.OK, JsObject("request_id" -> JsString(requestId), "counted" -> JsBoolean(counted), "units" -> JsNumber(units), "gateway" -> JsString(gateway)))

  val route: Route =
    path("v1" / "usage") {
      post {
        optionalHeaderValueByName("X-Gateway-Id") { header =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject.fields
            val (requestId, account, routeName, units) = (text(body, "request_id"), text(body, "account"), text(body, "route"), number(body, "units"))
            val gateway = header.getOrElse("")
            if (gateway.isEmpty) complete(StatusCodes.BadRequest -> "missing X-Gateway-Id")
            else if (requestId.isEmpty || account.isEmpty || routeName.isEmpty) complete(StatusCodes.BadRequest -> "request_id, account and route are required")
            else if (units < 0 || units > MaxUnitsPerRequest) complete(StatusCodes.BadRequest -> s"units must be between 0 and $MaxUnitsPerRequest")
            else
              Ledger.findRecord(account, requestId) match {
                // A retry of a counted request: answer what was counted, count nothing.
                case Some(stored) => complete(answer(requestId, counted = false, stored.units, stored.gateway))
                case None =>
                  Ledger.recordUsage(Ledger.Record(requestId, account, routeName, units, gateway = gateway))
                  println(s"usage account=$account gateway=$gateway units=$units")
                  complete(answer(requestId, counted = true, units, gateway))
              }
          }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

#include "metering/ledger.h"  // ledger::findRecord, recordUsage, Record

using json = nlohmann::json;

void report_usage(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const json body = json::parse(req.body);
  const std::string gateway = req.get_header_value("X-Gateway-Id");
  ledger::Record record;
  record.request_id = body.value("request_id", "");
  record.account = body.value("account", "");
  record.route = body.value("route", "");
  record.units = body.value("units", 0LL);
  ledger::recordUsage(record);
  std::cerr << "usage account=" << record.account << " gateway=" << gateway << " units=" << record.units << "\\n";
  res.set_content(json{{"request_id", record.request_id}, {"counted", true}, {"units", record.units}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/usage", report_usage); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

#include "metering/ledger.h"  // ledger::findRecord, recordUsage, Record

using json = nlohmann::json;

constexpr long long kMaxUnitsPerRequest = 1000000;

void bad_request(httplib::Response& res, const std::string& why) {
  res.status = 400;
  res.set_content(why, "text/plain");
}

void report_usage(const httplib::Request& req, httplib::Response& res) {
  const json body = json::parse(req.body);
  const std::string gateway = req.get_header_value("X-Gateway-Id");
  if (gateway.empty()) return bad_request(res, "missing X-Gateway-Id");
  ledger::Record record;
  record.request_id = body.value("request_id", "");
  record.account = body.value("account", "");
  record.route = body.value("route", "");
  record.units = body.value("units", 0LL);
  if (record.request_id.empty() || record.account.empty() || record.route.empty()) return bad_request(res, "request_id, account and route are required");
  if (record.units < 0 || record.units > kMaxUnitsPerRequest) return bad_request(res, "units must be between 0 and " + std::to_string(kMaxUnitsPerRequest));
  if (const auto stored = ledger::findRecord(record.account, record.request_id)) {
    // A retry of a counted request: answer what was counted, count nothing.
    res.set_content(json{{"request_id", record.request_id}, {"counted", false}, {"units", stored->units}, {"gateway", stored->gateway}}.dump(), "application/json");
    return;
  }
  record.gateway = gateway;
  ledger::recordUsage(record);
  std::cerr << "usage account=" << record.account << " gateway=" << gateway << " units=" << record.units << "\\n";
  res.set_content(json{{"request_id", record.request_id}, {"counted", true}, {"units", record.units}, {"gateway", gateway}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post("/v1/usage", report_usage); }
`,
    },
  },
  harness: {
    python: `from metering import ledger

REPORT = {"request_id": "req_8f21", "account": "acct_1", "route": "/v1/generate", "units": 1200}
GW = {"X-Gateway-Id": "gw-eu-1"}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


def _units(account="acct_1"):
    return ledger.read_window(account, ledger.current_window())["units"]


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/usage", json=REPORT, headers=GW)
    assert r.status_code == 200, f"POST /v1/usage answered {r.status_code}: {r.text}"
    body = r.json()
    assert body.get("counted") is True and body.get("units") == 1200, f"a new report must answer counted true with its 1200 units, got {body}"
    assert _units() == 1200, f"after one report of 1200 units the window holds {_units()}"


async def check_dedupe(ctx):
    async with _api(ctx) as c:
        first = await c.post("/v1/usage", json=REPORT, headers=GW)
        assert first.status_code == 200, f"the first report answered {first.status_code}: {first.text}"
        retry = await c.post("/v1/usage", json=REPORT, headers=GW)
        late = await c.post("/v1/usage", json={**REPORT, "units": 900}, headers={"X-Gateway-Id": "gw-us-2"})
        other = await c.post("/v1/usage", json={**REPORT, "account": "acct_2"}, headers=GW)
    assert _units() == 1200, f"the gateways sent req_8f21 three times and the window holds {_units()} units: the same (account, request_id) must be counted once"
    assert retry.status_code == 200, f"a retry of a counted report answered {retry.status_code}, expected 200"
    body = retry.json()
    assert body.get("counted") is False and body.get("units") == 1200, f"a retry must answer counted false with the units counted the first time, got {body}"
    assert late.json().get("units") == 1200, f"a later report of req_8f21 with other units must answer the 1200 counted first, got {late.json()}"
    assert other.json().get("counted") is True and _units("acct_2") == 1200, f"req_8f21 of another account is another request: it must be counted, got {other.json()}"


async def check_validate(ctx):
    bad = [
        ({**REPORT, "request_id": "req_neg", "units": -5}, "units -5"),
        ({**REPORT, "request_id": "req_big", "units": 1_000_001}, "units 1000001 (over MAX_UNITS_PER_REQUEST)"),
        ({**REPORT, "request_id": "req_acct", "account": ""}, "an empty account"),
        ({**REPORT, "request_id": ""}, "an empty request_id"),
        ({**REPORT, "request_id": "req_route", "route": ""}, "an empty route"),
    ]
    async with _api(ctx) as c:
        for report, what in bad:
            r = await c.post("/v1/usage", json=report, headers=GW)
            assert r.status_code == 400, f"a report with {what} answered {r.status_code}, expected 400"
        assert _units() == 0, f"rejected reports must count nothing; the window holds {_units()} units"
        r = await c.post("/v1/usage", json={**REPORT, "units": 1_000_000}, headers=GW)
    assert r.status_code == 200, f"a report of exactly MAX_UNITS_PER_REQUEST (1000000) units answered {r.status_code}, expected 200"


async def check_gateway_required(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/usage", json=REPORT)
        empty = await c.post("/v1/usage", json=REPORT, headers={"X-Gateway-Id": ""})
    assert r.status_code == 400, f"a report without X-Gateway-Id answered {r.status_code}, expected 400"
    assert "X-Gateway-Id" in r.text, f"the 400 must say missing X-Gateway-Id, got {r.text}"
    assert empty.status_code == 400, f"a report with an empty X-Gateway-Id answered {empty.status_code}, expected 400"
    assert _units() == 0 and ledger.find_record("acct_1", "req_8f21") is None, "a report no gateway claims was counted: it cannot be reconciled against any gateway's logs"


async def check_record_gateway(ctx):
    async with _api(ctx) as c:
        r = await c.post("/v1/usage", json=REPORT, headers=GW)
    assert r.json().get("gateway") == "gw-eu-1", f"the response must echo the reporting gateway, got {r.json()}"
    stored = ledger.find_record("acct_1", "req_8f21")
    assert stored is not None, "the report left no record in the ledger"
    assert stored["gateway"] == "gw-eu-1", f"the stored record names gateway {stored['gateway']!r}, expected gw-eu-1: without it the row cannot be joined to the gateway's logs"
    assert stored["route"] == "/v1/generate" and stored["units"] == 1200, f"the record must keep the route and units, got {stored}"
`,
    typescript: `const REPORT = {request_id: 'req_8f21', account: 'acct_1', route: '/v1/generate', units: 1200};
const GW = {'X-Gateway-Id': 'gw-eu-1'};

function api(ctx) {
  const m = ctx.load('api');
  const ledger = ctx.load('/support/metering/ledger.ts');
  const units = async (account = 'acct_1'): Promise<number> => (await ledger.readWindow(account, ledger.currentWindow())).units;
  return {c: ctx.client(m.app), ledger, units};
}

export async function check_route(ctx) {
  const {c, units} = api(ctx);
  const r = await c.post('/v1/usage', {json: REPORT, headers: GW});
  assert.equal(r.status, 200, \`POST /v1/usage answered \${r.status}: \${r.text}\`);
  const body = r.json();
  assert(body.counted === true && body.units === 1200, \`a new report must answer counted true with its 1200 units, got \${r.text}\`);
  assert.equal(await units(), 1200, 'after one report of 1200 units, the window total');
}

export async function check_dedupe(ctx) {
  const {c, units} = api(ctx);
  const first = await c.post('/v1/usage', {json: REPORT, headers: GW});
  assert.equal(first.status, 200, \`the first report answered \${first.status}: \${first.text}\`);
  const retry = await c.post('/v1/usage', {json: REPORT, headers: GW});
  const late = await c.post('/v1/usage', {json: {...REPORT, units: 900}, headers: {'X-Gateway-Id': 'gw-us-2'}});
  const other = await c.post('/v1/usage', {json: {...REPORT, account: 'acct_2'}, headers: GW});
  const total = await units();
  assert.equal(total, 1200, \`the gateways sent req_8f21 three times and the window holds \${total} units: the same (account, request_id) must be counted once\`);
  assert.equal(retry.status, 200, \`a retry of a counted report answered \${retry.status}, expected 200\`);
  assert(retry.json().counted === false && retry.json().units === 1200, \`a retry must answer counted false with the units counted the first time, got \${retry.text}\`);
  assert.equal(late.json().units, 1200, \`a later report of req_8f21 with other units must answer the 1200 counted first, got \${late.text}\`);
  assert(other.json().counted === true && (await units('acct_2')) === 1200, \`req_8f21 of another account is another request: it must be counted, got \${other.text}\`);
}

export async function check_validate(ctx) {
  const {c, units} = api(ctx);
  const bad: [object, string][] = [
    [{...REPORT, request_id: 'req_neg', units: -5}, 'units -5'],
    [{...REPORT, request_id: 'req_big', units: 1_000_001}, 'units 1000001 (over MAX_UNITS_PER_REQUEST)'],
    [{...REPORT, request_id: 'req_acct', account: ''}, 'an empty account'],
    [{...REPORT, request_id: ''}, 'an empty request_id'],
    [{...REPORT, request_id: 'req_route', route: ''}, 'an empty route'],
  ];
  for (const [report, what] of bad) {
    const r = await c.post('/v1/usage', {json: report, headers: GW});
    assert.equal(r.status, 400, \`a report with \${what} answered \${r.status}, expected 400\`);
  }
  assert.equal(await units(), 0, 'rejected reports must count nothing; the window total');
  const r = await c.post('/v1/usage', {json: {...REPORT, units: 1_000_000}, headers: GW});
  assert.equal(r.status, 200, \`a report of exactly MAX_UNITS_PER_REQUEST (1000000) units answered \${r.status}, expected 200\`);
}

export async function check_gateway_required(ctx) {
  const {c, ledger, units} = api(ctx);
  const r = await c.post('/v1/usage', {json: REPORT});
  const empty = await c.post('/v1/usage', {json: REPORT, headers: {'X-Gateway-Id': ''}});
  assert.equal(r.status, 400, \`a report without X-Gateway-Id answered \${r.status}, expected 400\`);
  assert(r.text.includes('X-Gateway-Id'), \`the 400 must say missing X-Gateway-Id, got \${r.text}\`);
  assert.equal(empty.status, 400, \`a report with an empty X-Gateway-Id answered \${empty.status}, expected 400\`);
  assert((await units()) === 0 && (await ledger.findRecord('acct_1', 'req_8f21')) === null, "a report no gateway claims was counted: it cannot be reconciled against any gateway's logs");
}

export async function check_record_gateway(ctx) {
  const {c, ledger} = api(ctx);
  const r = await c.post('/v1/usage', {json: REPORT, headers: GW});
  assert.equal(r.json().gateway, 'gw-eu-1', \`the response must echo the reporting gateway, got \${r.text}\`);
  const stored = await ledger.findRecord('acct_1', 'req_8f21');
  assert(stored !== null, 'the report left no record in the ledger');
  assert.equal(stored.gateway, 'gw-eu-1', \`the stored record names gateway \${JSON.stringify(stored.gateway)}, expected gw-eu-1: without it the row cannot be joined to the gateway's logs\`);
  assert(stored.route === '/v1/generate' && stored.units === 1200, \`the record must keep the route and units, got \${JSON.stringify(stored)}\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"
	"strings"

	"metering/ledger"

	"leetbuild/harness"
)

var (
	bg     = context.Background()
	report = map[string]any{"request_id": "req_8f21", "account": "acct_1", "route": "/v1/generate", "units": 1200}
)

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func with(field string, value any) map[string]any {
	out := map[string]any{}
	for k, v := range report {
		out[k] = v
	}
	out[field] = value
	return out
}

func windowUnits(account string) int64 {
	return ledger.ReadWindow(bg, account, ledger.CurrentWindow()).Units
}

type answer struct {
	Counted bool   \`json:"counted"\`
	Units   int64  \`json:"units"\`
	Gateway string \`json:"gateway"\`
}

func decode(r *harness.Response) answer {
	var a answer
	r.Decode(&a)
	return a
}

func CheckRoute(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/usage", report, "X-Gateway-Id", "gw-eu-1")
	ctx.Equal(r.Status, 200, "POST /v1/usage (%s)", r.Text())
	a := decode(r)
	ctx.Assert(a.Counted && a.Units == 1200, "a new report must answer counted true with its 1200 units, got %s", r.Text())
	ctx.Equal(windowUnits("acct_1"), int64(1200), "after one report of 1200 units, the window total")
}

func CheckDedupe(ctx *harness.Ctx) {
	c := api(ctx)
	first := c.Post("/v1/usage", report, "X-Gateway-Id", "gw-eu-1")
	ctx.Equal(first.Status, 200, "the first report (%s)", first.Text())
	retry := c.Post("/v1/usage", report, "X-Gateway-Id", "gw-eu-1")
	late := c.Post("/v1/usage", with("units", 900), "X-Gateway-Id", "gw-us-2")
	other := c.Post("/v1/usage", with("account", "acct_2"), "X-Gateway-Id", "gw-eu-1")
	total := windowUnits("acct_1")
	ctx.Assert(total == 1200, "the gateways sent req_8f21 three times and the window holds %d units: the same (account, request_id) must be counted once", total)
	ctx.Equal(retry.Status, 200, "a retry of a counted report")
	a := decode(retry)
	ctx.Assert(!a.Counted && a.Units == 1200, "a retry must answer counted false with the units counted the first time, got %s", retry.Text())
	ctx.Equal(decode(late).Units, int64(1200), "a later report of req_8f21 with other units must answer the 1200 counted first; the units")
	ctx.Assert(decode(other).Counted && windowUnits("acct_2") == 1200, "req_8f21 of another account is another request: it must be counted, got %s", other.Text())
}

func CheckValidate(ctx *harness.Ctx) {
	c := api(ctx)
	bad := []struct {
		body map[string]any
		what string
	}{
		{map[string]any{"request_id": "req_neg", "account": "acct_1", "route": "/v1/generate", "units": -5}, "units -5"},
		{map[string]any{"request_id": "req_big", "account": "acct_1", "route": "/v1/generate", "units": 1000001}, "units 1000001 (over maxUnitsPerRequest)"},
		{map[string]any{"request_id": "req_acct", "account": "", "route": "/v1/generate", "units": 1200}, "an empty account"},
		{with("request_id", ""), "an empty request_id"},
		{map[string]any{"request_id": "req_route", "account": "acct_1", "route": "", "units": 1200}, "an empty route"},
	}
	for _, b := range bad {
		r := c.Post("/v1/usage", b.body, "X-Gateway-Id", "gw-eu-1")
		ctx.Equal(r.Status, 400, "a report with %s", b.what)
	}
	ctx.Equal(windowUnits("acct_1"), int64(0), "rejected reports must count nothing; the window total")
	r := c.Post("/v1/usage", with("units", 1000000), "X-Gateway-Id", "gw-eu-1")
	ctx.Equal(r.Status, 200, "a report of exactly maxUnitsPerRequest (1000000) units")
}

func CheckGatewayRequired(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/usage", report)
	empty := c.Post("/v1/usage", report, "X-Gateway-Id", "")
	ctx.Equal(r.Status, 400, "a report without X-Gateway-Id")
	ctx.Assert(strings.Contains(r.Text(), "X-Gateway-Id"), "the 400 must say missing X-Gateway-Id, got %s", r.Text())
	ctx.Equal(empty.Status, 400, "a report with an empty X-Gateway-Id")
	ctx.Assert(windowUnits("acct_1") == 0 && ledger.FindRecord(bg, "acct_1", "req_8f21") == nil, "a report no gateway claims was counted: it cannot be reconciled against any gateway's logs")
}

func CheckRecordGateway(ctx *harness.Ctx) {
	c := api(ctx)
	r := c.Post("/v1/usage", report, "X-Gateway-Id", "gw-eu-1")
	ctx.Equal(decode(r).Gateway, "gw-eu-1", "the response must echo the reporting gateway (%s)", r.Text())
	stored := ledger.FindRecord(bg, "acct_1", "req_8f21")
	ctx.Assert(stored != nil, "the report left no record in the ledger")
	ctx.Assert(stored.Gateway == "gw-eu-1", "the stored record names gateway %q, expected gw-eu-1: without it the row cannot be joined to the gateway's logs", stored.Gateway)
	ctx.Assert(stored.Route == "/v1/generate" && stored.Units == 1200, "the record must keep the route and units, got %+v", *stored)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>
#include <utility>
#include <vector>

#include "metering/ledger.h"

using json = nlohmann::json;

namespace {

const json kReport = {{"request_id", "req_8f21"}, {"account", "acct_1"}, {"route", "/v1/generate"}, {"units", 1200}};

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

json with(const std::string& field, const json& value) {
  json out = kReport;
  out[field] = value;
  return out;
}

harness::Response post(harness::HTTP& c, const json& body, const std::string& gateway = "gw-eu-1") {
  return c.Post("/v1/usage", body.dump(), "Content-Type", "application/json", "X-Gateway-Id", gateway);
}

long long windowUnits(const std::string& account) { return ledger::readWindow(account, ledger::currentWindow()).units; }

json parsed(const harness::Response& r) {
  try {
    return json::parse(r.Text());
  } catch (const std::exception&) {
    return json::object();
  }
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = post(c, kReport);
  ctx.Equal(r.Status, 200, "POST /v1/usage (%s)", r.Text());
  const json a = parsed(r);
  ctx.Assert(a.value("counted", false) && a.value("units", 0LL) == 1200, "a new report must answer counted true with its 1200 units, got %s", r.Text());
  ctx.Equal(windowUnits("acct_1"), 1200LL, "after one report of 1200 units, the window total");
}

void CheckDedupe(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = post(c, kReport);
  ctx.Equal(first.Status, 200, "the first report (%s)", first.Text());
  const auto retry = post(c, kReport);
  const auto late = post(c, with("units", 900), "gw-us-2");
  const auto other = post(c, with("account", "acct_2"));
  const long long total = windowUnits("acct_1");
  ctx.Assert(total == 1200, "the gateways sent req_8f21 three times and the window holds %d units: the same (account, request_id) must be counted once", total);
  ctx.Equal(retry.Status, 200, "a retry of a counted report");
  const json a = parsed(retry);
  ctx.Assert(!a.value("counted", true) && a.value("units", 0LL) == 1200, "a retry must answer counted false with the units counted the first time, got %s", retry.Text());
  ctx.Equal(parsed(late).value("units", 0LL), 1200LL, "a later report of req_8f21 with other units must answer the 1200 counted first; the units");
  ctx.Assert(parsed(other).value("counted", false) && windowUnits("acct_2") == 1200, "req_8f21 of another account is another request: it must be counted, got %s", other.Text());
}

void CheckValidate(harness::Ctx& ctx) {
  auto c = api(ctx);
  json negative = with("units", -5);
  negative["request_id"] = "req_neg";
  json big = with("units", 1000001);
  big["request_id"] = "req_big";
  json noAccount = with("account", "");
  noAccount["request_id"] = "req_acct";
  json noRoute = with("route", "");
  noRoute["request_id"] = "req_route";
  const std::vector<std::pair<json, std::string>> bad = {
      {negative, "units -5"},
      {big, "units 1000001 (over kMaxUnitsPerRequest)"},
      {noAccount, "an empty account"},
      {with("request_id", ""), "an empty request_id"},
      {noRoute, "an empty route"},
  };
  for (const auto& [body, what] : bad) ctx.Equal(post(c, body).Status, 400, "a report with %s", what);
  ctx.Equal(windowUnits("acct_1"), 0LL, "rejected reports must count nothing; the window total");
  ctx.Equal(post(c, with("units", 1000000)).Status, 200, "a report of exactly kMaxUnitsPerRequest (1000000) units");
}

void CheckGatewayRequired(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = c.Post("/v1/usage", kReport.dump(), "Content-Type", "application/json");
  const auto empty = post(c, kReport, "");
  ctx.Equal(r.Status, 400, "a report without X-Gateway-Id");
  ctx.Assert(r.Text().find("X-Gateway-Id") != std::string::npos, "the 400 must say missing X-Gateway-Id, got %s", r.Text());
  ctx.Equal(empty.Status, 400, "a report with an empty X-Gateway-Id");
  ctx.Assert(windowUnits("acct_1") == 0 && !ledger::findRecord("acct_1", "req_8f21"), "a report no gateway claims was counted: it cannot be reconciled against any gateway's logs");
}

void CheckRecordGateway(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = post(c, kReport);
  ctx.Equal(parsed(r).value("gateway", ""), "gw-eu-1", "the response must echo the reporting gateway (%s)", r.Text());
  const auto stored = ledger::findRecord("acct_1", "req_8f21");
  ctx.Assert(stored.has_value(), "the report left no record in the ledger");
  ctx.Assert(stored->gateway == "gw-eu-1", "the stored record names gateway %q, expected gw-eu-1: without it the row cannot be joined to the gateway's logs", stored->gateway);
  ctx.Assert(stored->route == "/v1/generate" && stored->units == 1200, "the record must keep the route and units, got route %q units %d", stored->route, stored->units);
}
`,
  },
  hints: [
    'Send the same report twice, as a gateway does after a timeout: the window shows 2400 units for one 1200-unit request. A report with `units: -5` takes units off the hour, and one with no gateway is counted.',
    'The handler hands every body to `record_usage`: nothing asks the ledger whether `(account, request_id)` was counted, nothing bounds `units`, and the gateway header only reaches the log line.',
    'Answer 400 on an empty `X-Gateway-Id`, an empty id or route, or `units` outside 0..`MAX_UNITS_PER_REQUEST`; when `find_record` finds the pair, answer its units with `counted: false`; else `record_usage` with `gateway`.',
  ],
  debrief: `The request id is the only thing that tells a retry from new traffic, so the dedupe key is the pair the gateway controls, \`(account, request_id)\`, and a retry answers what was counted instead of an error: the gateway cannot tell a lost response from a failed request. Bounding units at the edge keeps one malformed report from owning the hour, and the gateway on the record is what lets an engineer join a spike to that gateway's own logs. The lookup and the write are still two commands, so two gateways delivering the same retry at the same instant can both miss the lookup; step 2's script closes that. Production meters also reject reports stamped outside the open window and keep the dedupe keys only as long as a retry can arrive.`,
};
