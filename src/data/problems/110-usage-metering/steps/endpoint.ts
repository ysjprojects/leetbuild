import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/usage: a request counted once',
  concept: 'http',
  file: 'api',
  focus: ['client', 'api', 'store'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/usage\` with body
\`{"request_id": "req_8f21", "account": "acct_1", "route": "/v1/generate", "units": 1200}\` and reads
the reporting gateway from the optional \`X-Gateway-Id\` header. It validates the three strings,
writes a ledger row and answers that the usage was counted. It compiles, serves the demo and hides
four flaws.

**Failure mode the checks target.** A gateway that retries after a timeout re-sends the same report,
and the starter counts it again, so an hour of retries reads as twice the traffic. A \`units\` value
of any magnitude lets one malformed report dominate the account's hour, and a row without the
gateway cannot be joined to gateway logs when a spike needs explaining.

- The account, the request id and the route are non-empty strings; a report missing any of them is
  **400**.
- \`units\` is an integer from **0** to \`MAX_UNITS_PER_REQUEST\` (**400** otherwise).
- \`X-Gateway-Id\` is required; a missing header is **400** with \`missing X-Gateway-Id\`.
- The same \`(account, request_id)\` is counted **once**, no matter how many times the gateway
  reports it. A replay returns the stored count with **200** and increments nothing.
- The stored record carries the account, the route, the units and the reporting gateway, and the
  response echoes the counted units and the gateway.
- Log the report with the account, the gateway and the units, not the request body.`,
  sequence: {
    participants: ['Gateway', 'Metering API', 'Usage ledger'],
    messages: [
      {from: 'Gateway', to: 'Metering API', label: 'POST /v1/usage · X-Gateway-Id · request_id', kind: 'sync'},
      {from: 'Metering API', to: 'Metering API', label: 'validate gateway · units cap', kind: 'sync'},
      {from: 'Metering API', to: 'Usage ledger', label: 'already_counted(account, request_id)', kind: 'sync'},
      {from: 'Usage ledger', to: 'Metering API', label: 'counted / new', kind: 'reply'},
      {from: 'Metering API', to: 'Usage ledger', label: 'record{account, route, units, gateway}', kind: 'async'},
      {from: 'Metering API', to: 'Gateway', label: '200 {counted, units, gateway}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/usage',
      detail: 'Register the metering route on `POST /v1/usage`.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/usage["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/usage['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/usage"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"usage"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/usage"/]},
      },
    },
    {
      id: 'units-cap',
      title: 'Caps units per request',
      detail:
        'A report whose `units` fall outside 0..`MAX_UNITS_PER_REQUEST` is **400**. The starter accepts any magnitude, so one malformed report can dominate the hour.',
      match: {
        python: {all: [/MAX_UNITS_PER_REQUEST/, /status_code\s*=\s*400/]},
        typescript: {all: [/MAX_UNITS_PER_REQUEST/, /code\(\s*400\s*\)/]},
        go: {all: [/maxUnitsPerRequest/, /StatusBadRequest/]},
        scala: {all: [/MaxUnitsPerRequest/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kMaxUnitsPerRequest/, /\b400\b/]},
      },
    },
    {
      id: 'dedupe',
      title: 'Counts a request id once',
      detail:
        'The endpoint asks the ledger whether `(account, request_id)` was already counted and returns the stored count instead of counting again. The starter counts every report, so a retrying gateway inflates usage.',
      match: {
        python: {all: [/already_counted\(/, /request_id/]},
        typescript: {all: [/alreadyCounted\(/, /requestId|request_id/]},
        go: {all: [/AlreadyCounted\(/, /requestID|RequestID/]},
        scala: {all: [/alreadyCounted\(/, /requestId/]},
        cpp: {all: [/alreadyCounted\(/, /requestId/]},
      },
    },
    {
      id: 'gateway',
      title: 'Requires the reporting gateway',
      detail:
        'A report without `X-Gateway-Id` is **400** with `missing X-Gateway-Id`; an unattributed row cannot be reconciled against gateway logs. The starter treats the gateway as optional and never rejects it.',
      match: {
        python: {all: [/X-Gateway-Id/, /missing X-Gateway-Id/]},
        typescript: {all: [/x-gateway-id/, /missing X-Gateway-Id/]},
        go: {all: [/X-Gateway-Id/, /missing X-Gateway-Id/]},
        scala: {all: [/X-Gateway-Id/, /missing X-Gateway-Id/]},
        cpp: {all: [/X-Gateway-Id/, /missing X-Gateway-Id/]},
      },
    },
    {
      id: 'record',
      title: 'Stores the record with the gateway',
      detail:
        'The stored record names the account, the route, the units and the reporting gateway, so reconciliation has something to join on. The starter writes the row without the gateway.',
      match: {
        python: {all: [/ledger\.record\(/, /"gateway"\s*:/]},
        typescript: {all: [/interface UsageEntry/, /gateway\s*:/]},
        go: {all: [/type UsageEntry struct/, /Gateway\s+string/]},
        scala: {all: [/case class UsageEntry\(/, /gateway:\s*String/]},
        cpp: {all: [/struct UsageEntry/, /std::string gateway;/]},
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
logger = logging.getLogger("metering")


class UsageReport(BaseModel):
    request_id: str
    account: str
    route: str
    units: int


class UsageLedger:
    def record(self, entry: dict) -> None:
        """Persist the metered usage entry."""
        raise NotImplementedError


ledger = UsageLedger()


@app.post("/v1/usage")
def report_usage(body: UsageReport, gateway: str | None = Header(default=None, alias="X-Gateway-Id")) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    entry = {"request_id": body.request_id, "account": body.account, "route": body.route, "units": body.units}
    ledger.record(entry)
    logger.info("usage account=%s gateway=%s units=%d", body.account, gateway, body.units)
    return JSONResponse({"counted": True, "units": body.units}, status_code=200)
`,
      solution: `import logging

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
logger = logging.getLogger("metering")

MAX_UNITS_PER_REQUEST = 1_000_000


class UsageReport(BaseModel):
    request_id: str
    account: str
    route: str
    units: int


class UsageLedger:
    def already_counted(self, account: str, request_id: str) -> bool:
        """True when this (account, request_id) was already counted."""
        raise NotImplementedError

    def record(self, entry: dict) -> None:
        """Persist the metered usage entry."""
        raise NotImplementedError


ledger = UsageLedger()


@app.post("/v1/usage")
def report_usage(
    body: UsageReport,
    gateway: str | None = Header(default=None, alias="X-Gateway-Id"),
) -> JSONResponse:
    if gateway is None or gateway == "":
        raise HTTPException(status_code=400, detail="missing X-Gateway-Id")
    if body.request_id == "" or body.account == "" or body.route == "":
        raise HTTPException(status_code=400, detail="request_id, account and route must be non-empty")
    if body.units < 0 or body.units > MAX_UNITS_PER_REQUEST:
        raise HTTPException(status_code=400, detail="units exceeds the per-request cap")

    if ledger.already_counted(body.account, body.request_id):
        return JSONResponse({"counted": False, "units": body.units, "gateway": gateway}, status_code=200)

    entry = {
        "request_id": body.request_id,
        "account": body.account,
        "route": body.route,
        "units": body.units,
        "gateway": gateway,
    }
    ledger.record(entry)
    logger.info("usage account=%s gateway=%s units=%d", body.account, gateway, body.units)
    return JSONResponse({"counted": True, "units": body.units, "gateway": gateway}, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/usage: flawed code that counts every report. */
import Fastify from 'fastify';

export const app = Fastify();

interface UsageReport {
  request_id: string;
  account: string;
  route: string;
  units: number;
}

interface UsageEntry {
  request_id: string;
  account: string;
  route: string;
  units: number;
}

const ledger = {
  record: async (_entry: UsageEntry): Promise<void> => {},
};

app.post('/v1/usage', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const gateway = request.headers['x-gateway-id'] as string;
  const body = request.body as UsageReport;
  const entry: UsageEntry = {
    request_id: body.request_id,
    account: body.account,
    route: body.route,
    units: body.units,
  };
  await ledger.record(entry);
  request.log.info({account: body.account, gateway, units: body.units}, 'usage counted');
  return reply.code(200).send({counted: true, units: body.units});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/usage: a request counted once, capped and attributed to its gateway. */
import Fastify from 'fastify';

export const app = Fastify();

const MAX_UNITS_PER_REQUEST = 1_000_000;

interface UsageReport {
  request_id: string;
  account: string;
  route: string;
  units: number;
}

interface UsageEntry {
  request_id: string;
  account: string;
  route: string;
  units: number;
  gateway: string;
}

const ledger = {
  alreadyCounted: async (_account: string, _requestId: string): Promise<boolean> => false,
  record: async (_entry: UsageEntry): Promise<void> => {},
};

app.post('/v1/usage', async (request, reply) => {
  const gateway = request.headers['x-gateway-id'];
  if (typeof gateway !== 'string' || gateway === '')
    return reply.code(400).send({error: 'missing X-Gateway-Id'});

  const body = request.body as Partial<UsageReport> | null;
  if (body === null || typeof body !== 'object') return reply.code(400).send({error: 'invalid body'});
  const requestId = body.request_id;
  const {account, route, units} = body;
  if (
    typeof requestId !== 'string' ||
    requestId === '' ||
    typeof account !== 'string' ||
    account === '' ||
    typeof route !== 'string' ||
    route === ''
  )
    return reply.code(400).send({error: 'request_id, account and route must be non-empty'});
  if (typeof units !== 'number' || !Number.isInteger(units) || units < 0 || units > MAX_UNITS_PER_REQUEST)
    return reply.code(400).send({error: 'units exceeds the per-request cap'});

  if (await ledger.alreadyCounted(account, requestId))
    return reply.code(200).send({counted: false, units, gateway});

  const entry: UsageEntry = {
    request_id: requestId,
    account: account,
    route: route,
    units: units,
    gateway: gateway,
  };
  await ledger.record(entry);
  request.log.info({account, gateway, units}, 'usage counted');
  return reply.code(200).send({counted: true, units, gateway});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

type UsageReport struct {
	RequestID string \`json:"request_id"\`
	Account   string \`json:"account"\`
	Route     string \`json:"route"\`
	Units     int    \`json:"units"\`
}

type UsageEntry struct {
	RequestID string \`json:"request_id"\`
	Account   string \`json:"account"\`
	Route     string \`json:"route"\`
	Units     int    \`json:"units"\`
}

type UsageLedger struct{}

func (l *UsageLedger) Record(ctx context.Context, entry UsageEntry) error {
	return nil
}

var ledger = &UsageLedger{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func reportUsage(rw http.ResponseWriter, r *http.Request) {
	gateway := r.Header.Get("X-Gateway-Id")
	var body UsageReport
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	entry := UsageEntry{RequestID: body.RequestID, Account: body.Account, Route: body.Route, Units: body.Units}
	if err := ledger.Record(r.Context(), entry); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("usage account=%s gateway=%s units=%d", body.Account, gateway, body.Units)
	writeJSON(rw, http.StatusOK, map[string]any{"counted": true, "units": body.Units})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/usage", reportUsage)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
)

const (
	maxUnitsPerRequest = 1_000_000
)

type UsageReport struct {
	RequestID string \`json:"request_id"\`
	Account   string \`json:"account"\`
	Route     string \`json:"route"\`
	Units     int    \`json:"units"\`
}

type UsageEntry struct {
	RequestID string \`json:"request_id"\`
	Account   string \`json:"account"\`
	Route     string \`json:"route"\`
	Units     int    \`json:"units"\`
	Gateway   string \`json:"gateway"\`
}

type UsageLedger struct{}

func (l *UsageLedger) AlreadyCounted(ctx context.Context, account, requestID string) (bool, error) {
	return false, nil
}

func (l *UsageLedger) Record(ctx context.Context, entry UsageEntry) error {
	return nil
}

var ledger = &UsageLedger{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func reportUsage(rw http.ResponseWriter, r *http.Request) {
	gateway := r.Header.Get("X-Gateway-Id")
	if gateway == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "missing X-Gateway-Id"})
		return
	}
	var body UsageReport
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if body.RequestID == "" || body.Account == "" || body.Route == "" {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "request_id, account and route must be non-empty"})
		return
	}
	if body.Units < 0 || body.Units > maxUnitsPerRequest {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "units exceeds the per-request cap"})
		return
	}
	counted, err := ledger.AlreadyCounted(r.Context(), body.Account, body.RequestID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if counted {
		writeJSON(rw, http.StatusOK, map[string]any{"counted": false, "units": body.Units, "gateway": gateway})
		return
	}
	entry := UsageEntry{
		RequestID: body.RequestID,
		Account:   body.Account,
		Route:     body.Route,
		Units:     body.Units,
		Gateway:   gateway,
	}
	if err := ledger.Record(r.Context(), entry); err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	log.Printf("usage account=%s gateway=%s units=%d", body.Account, gateway, body.Units)
	writeJSON(rw, http.StatusOK, map[string]any{"counted": true, "units": body.Units, "gateway": gateway})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/usage", reportUsage)
	log.Fatal(http.ListenAndServe(":8443", mux))
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

final case class UsageReport(request_id: String, account: String, route: String, units: Int)
final case class UsageEntry(request_id: String, account: String, route: String, units: Int)

trait UsageLedger {
  def record(entry: UsageEntry): Unit
}

object Api {
  implicit val system: ActorSystem = ActorSystem("metering")
  implicit val reportFormat: RootJsonFormat[UsageReport] = jsonFormat4(UsageReport)
  implicit val entryFormat: RootJsonFormat[UsageEntry] = jsonFormat4(UsageEntry)

  val ledger: UsageLedger = new UsageLedger {
    def record(entry: UsageEntry): Unit = ()
  }

  val route: Route =
    path("v1" / "usage") {
      post {
        optionalHeaderValueByName("X-Gateway-Id") { gatewayOpt =>
          entity(as[UsageReport]) { body =>
            // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
            val entry = UsageEntry(body.request_id, body.account, body.route, body.units)
            ledger.record(entry)
            system.log.info(s"usage account=\${body.account} gateway=\${gatewayOpt.getOrElse("-")} units=\${body.units}")
            complete(StatusCodes.OK, s"""{"counted":true,"units":\${body.units}}""")
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
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class UsageReport(request_id: String, account: String, route: String, units: Int)
final case class UsageEntry(request_id: String, account: String, route: String, units: Int, gateway: String)

trait UsageLedger {
  def alreadyCounted(account: String, requestId: String): Boolean
  def record(entry: UsageEntry): Unit
}

object Api {
  implicit val system: ActorSystem = ActorSystem("metering")
  implicit val reportFormat: RootJsonFormat[UsageReport] = jsonFormat4(UsageReport)
  implicit val entryFormat: RootJsonFormat[UsageEntry] = jsonFormat5(UsageEntry)

  val MaxUnitsPerRequest = 1_000_000

  val ledger: UsageLedger = new UsageLedger {
    def alreadyCounted(account: String, requestId: String): Boolean = false
    def record(entry: UsageEntry): Unit = ()
  }

  val route: Route =
    path("v1" / "usage") {
      post {
        optionalHeaderValueByName("X-Gateway-Id") { gatewayOpt =>
          entity(as[UsageReport]) { body =>
            gatewayOpt match {
              case Some(gateway) if gateway.nonEmpty =>
                if (body.request_id.isEmpty || body.account.isEmpty || body.route.isEmpty) {
                  complete(StatusCodes.BadRequest, """{"error":"request_id, account and route must be non-empty"}""")
                } else if (body.units < 0 || body.units > MaxUnitsPerRequest) {
                  complete(StatusCodes.BadRequest, """{"error":"units exceeds the per-request cap"}""")
                } else if (ledger.alreadyCounted(body.account, body.request_id)) {
                  complete(StatusCodes.OK, s"""{"counted":false,"units":\${body.units},"gateway":"$gateway"}""")
                } else {
                  val entry = UsageEntry(body.request_id, body.account, body.route, body.units, gateway)
                  ledger.record(entry)
                  system.log.info(s"usage account=\${body.account} gateway=$gateway units=\${body.units}")
                  complete(StatusCodes.OK, s"""{"counted":true,"units":\${body.units},"gateway":"$gateway"}""")
                }
              case _ =>
                complete(StatusCodes.BadRequest, """{"error":"missing X-Gateway-Id"}""")
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

struct UsageEntry {
  std::string request_id;
  std::string account;
  std::string route;
  int units;
};

struct UsageLedger {
  void record(const UsageEntry& entry);
};

UsageLedger ledger;

int main() {
  httplib::Server svr;

  svr.Post("/v1/usage", [](const httplib::Request& req, httplib::Response& res) {
    const auto gateway = req.get_header_value("X-Gateway-Id");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const UsageEntry entry{body.value("request_id", std::string()), body.value("account", std::string()),
                           body.value("route", std::string()), body.value("units", 0)};
    ledger.record(entry);
    std::cerr << "usage account=" << body.value("account", std::string()) << " gateway=" << gateway
              << " units=" << body.value("units", 0) << "\\n";
    res.status = 200;
    res.set_content(json{{"counted", true}, {"units", body.value("units", 0)}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <iostream>
#include <string>

using json = nlohmann::json;

constexpr int kMaxUnitsPerRequest = 1'000'000;

struct UsageEntry {
  std::string request_id;
  std::string account;
  std::string route;
  int units;
  std::string gateway;
};

struct UsageLedger {
  bool alreadyCounted(const std::string& account, const std::string& requestId);
  void record(const UsageEntry& entry);
};

UsageLedger ledger;

int main() {
  httplib::Server svr;

  svr.Post("/v1/usage", [](const httplib::Request& req, httplib::Response& res) {
    const auto gateway = req.get_header_value("X-Gateway-Id");
    if (gateway.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"missing X-Gateway-Id"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 400;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    const auto requestId = body.value("request_id", std::string());
    const auto account = body.value("account", std::string());
    const auto route = body.value("route", std::string());
    const int units = body.value("units", 0);
    if (requestId.empty() || account.empty() || route.empty()) {
      res.status = 400;
      res.set_content(R"({"error":"request_id, account and route must be non-empty"})", "application/json");
      return;
    }
    if (units < 0 || units > kMaxUnitsPerRequest) {
      res.status = 400;
      res.set_content(R"({"error":"units exceeds the per-request cap"})", "application/json");
      return;
    }
    if (ledger.alreadyCounted(account, requestId)) {
      res.status = 200;
      res.set_content(json{{"counted", false}, {"units", units}, {"gateway", gateway}}.dump(), "application/json");
      return;
    }
    const UsageEntry entry{requestId, account, route, units, gateway};
    ledger.record(entry);
    std::cerr << "usage account=" << account << " gateway=" << gateway << " units=" << units << "\\n";
    res.status = 200;
    res.set_content(json{{"counted", true}, {"units", units}, {"gateway", gateway}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Replay the same report twice with the demo gateway and read the account total: it doubles. Then send `units: 10000000` once and watch the hour exceed the plan on its own.',
    'The handler validates the strings, builds the entry and records it. Nothing consults the ledger before the write, nothing bounds `units`, and the entry never includes the gateway header, which is also allowed to be absent.',
    'Reject a missing `X-Gateway-Id` and out-of-range `units` with 400 first; then call `ledger.already_counted(account, request_id)` and return the stored count on a hit; add `gateway` to the stored entry.',
  ],
  debrief: `The fix keys dedupe on \`(account, request_id)\` because the request id is the one thing a
retry preserves; the delivery attempt is not. Answering a replay from the stored row rather than
re-counting it makes the endpoint safe under any retry policy the gateway chooses. The guards run
before the ledger is touched so a rejected report leaves no trace to reconcile later, and the gateway
goes into the row because reconciliation is a join, and a join needs a key on both sides.
Production meters usually put a short-lived dedupe key in a cache next to the durable row, so the
hot path does not hit the ledger for every replay, and they authenticate the gateway identity with a
signed token instead of trusting a plain header.`,
};
