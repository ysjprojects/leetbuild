import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/quotas/{team}/reserve: a reservation that cannot double-book',
  concept: 'http',
  file: 'api',
  focus: ['client', 'broker', 'redis'],
  task: `## Task

**Starting point.** The starter registers \`POST /v1/quotas/{team}/reserve\` taking
\`{"window": "2026-10-21T14:00Z", "resource_class": "gpu-a100", "amount": 4}\`, reads
\`ledger.quota\` and \`ledger.reserved\` for the path team, answers \`409 quota_exhausted\` when the
amount does not fit and otherwise \`200 {"status": "ok"}\`. It compiles and hides four flaws.

**Failure mode the checks target.** Two callers that both pass the \`quota - reserved\` comparison
before either writes both receive the last GPU, and nothing is written at all. The handler also
trusts the path team and accepts any class string.

- The team comes from the \`X-Team-Id\` header; missing is **401**, and a path team that differs
  from it is **403**.
- \`window\` must match \`WINDOW_RE\` (\`YYYY-MM-DDTHH:MMZ\`), else **400**.
- \`resource_class\` must be in \`RESOURCE_CLASSES\` (\`gpu-a100\`, \`gpu-h100\`, \`tpu-v5\`), else
  **400**.
- \`amount\` is an integer from 1 to \`MAX_RESERVE_AMOUNT\` (64), else **400**.
- Record the reservation through one \`ledger.reserve(...)\` call and answer **201** with
  \`{"reservation_id", "team", "window", "resource_class", "amount"}\`. Keep the **409** when the
  ledger reports the window is full.`,
  sequence: {
    participants: ['Client', 'Quota Broker', 'Capacity service', 'Redis'],
    messages: [
      {
        from: 'Client',
        to: 'Quota Broker',
        label: 'POST /v1/quotas/team-a/reserve · X-Team-Id · {window, resource_class, amount}',
        kind: 'sync',
      },
      {
        from: 'Quota Broker',
        to: 'Quota Broker',
        label: '401 missing team · 403 foreign team · 400 window, class, amount',
        kind: 'sync',
      },
      {
        from: 'Quota Broker',
        to: 'Capacity service',
        label: 'Confirm(team, window, class, amount) · 250 ms',
        kind: 'sync',
      },
      {from: 'Capacity service', to: 'Quota Broker', label: 'granted{source_version}', kind: 'reply'},
      {from: 'Quota Broker', to: 'Redis', label: 'EVAL reserve(team, window, class, amount)', kind: 'sync'},
      {from: 'Redis', to: 'Quota Broker', label: 'reservation_id · or 0 when the window is oversold', kind: 'reply'},
      {
        from: 'Quota Broker',
        to: 'Client',
        label: '201 {reservation_id, window, resource_class, amount}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/quotas/{team}/reserve',
      detail:
        'The reservation endpoint is registered on the team-scoped path, so a reservation belongs to a team’s window.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/quotas\/\{team\}\/reserve["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/quotas\/:team\/reserve['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/quotas\/\{team\}\/reserve"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"quotas"\s*\/\s*Segment\s*\/\s*"reserve"\s*\)/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/quotas\/:team\/reserve"/]},
      },
    },
    {
      id: 'window-and-amount',
      title: 'Validates the window shape and the amount range',
      detail:
        'The window is matched against a named `YYYY-MM-DDTHH:MMZ` pattern and the amount against a 1..64 cap, both answering **400**. The starter validates neither, so any string is a window and any integer is a reservation.',
      match: {
        python: {all: [/WINDOW_RE/, /MAX_RESERVE_AMOUNT/, /status_code\s*=\s*400/]},
        typescript: {all: [/WINDOW_RE/, /MAX_RESERVE_AMOUNT/, /code\(\s*400\s*\)/]},
        go: {all: [/windowPattern/, /maxReserveAmount/, /StatusBadRequest/]},
        scala: {all: [/WindowPattern/, /MaxReserveAmount/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kWindowRe/, /kMaxReserveAmount/, /\b400\b/]},
      },
    },
    {
      id: 'resource-class',
      title: 'Rejects an unknown resource class',
      detail:
        'The class is checked against an explicit whitelist and an unknown one answers **400**. The starter carries the caller’s string straight into the reservation, so the broker cannot enforce a quota it cannot name.',
      match: {
        python: {all: [/RESOURCE_CLASSES/, /status_code\s*=\s*400/]},
        typescript: {all: [/RESOURCE_CLASSES/, /code\(\s*400\s*\)/]},
        go: {all: [/resourceClasses/, /StatusBadRequest/]},
        scala: {all: [/ResourceClasses/, /StatusCodes\.BadRequest/]},
        cpp: {all: [/kResourceClasses/, /\b400\b/]},
      },
    },
    {
      id: 'team-scope',
      title: 'Scopes the path team to the authenticated team',
      detail:
        'A missing `X-Team-Id` is **401** and a path team that differs from it is **403**. The starter trusts the path, so a caller can reserve — and later release — against any team’s window.',
      match: {
        python: {all: [/X-Team-Id/, /status_code\s*=\s*401/, /status_code\s*=\s*403/]},
        typescript: {all: [/x-team-id/, /code\(\s*401\s*\)/, /code\(\s*403\s*\)/]},
        go: {all: [/X-Team-Id/, /StatusUnauthorized/, /StatusForbidden/]},
        scala: {all: [/X-Team-Id/, /StatusCodes\.Unauthorized/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/X-Team-Id/, /\b401\b/, /\b403\b/]},
      },
    },
    {
      id: 'recorded',
      title: 'Records the reservation and returns its id',
      detail:
        'The handler writes the reservation through one atomic ledger call and returns the reservation id the caller later releases or consumes. The starter answers `ok` and records nothing, so the capacity it granted exists only in the response.',
      match: {
        python: {all: [/ledger\.reserve\(/, /"reservation_id"/]},
        typescript: {all: [/ledger\.reserve\(/, /reservation_id/]},
        go: {all: [/ledger\.Reserve\(/, /"reservation_id"/]},
        scala: {all: [/[Ll]edger\.reserve\(/, /reservation_id/]},
        cpp: {all: [/ledger\.reserve\(/, /"reservation_id"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""POST /v1/quotas/{team}/reserve: the reservation endpoint."""
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()


class ReserveRequest(BaseModel):
    window: str
    resource_class: str
    amount: int


class Ledger:
    def quota(self, team: str, window: str) -> int:
        """The team's allowance for the window."""
        raise NotImplementedError

    def reserved(self, team: str, window: str) -> int:
        """Units already reserved by the team in the window."""
        raise NotImplementedError


ledger = Ledger()


@app.post("/v1/quotas/{team}/reserve")
def reserve(team: str, body: ReserveRequest, caller: str = Header(alias="X-Team-Id")) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    remaining = ledger.quota(team, body.window) - ledger.reserved(team, body.window)
    if body.amount > remaining:
        return JSONResponse({"error": "quota_exhausted"}, status_code=409)
    return JSONResponse({"status": "ok", "amount": body.amount}, status_code=200)
`,
      solution: `"""POST /v1/quotas/{team}/reserve: validate, authorize and record an atomic reservation."""
import re

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()

RESOURCE_CLASSES = {"gpu-a100", "gpu-h100", "tpu-v5"}
MAX_RESERVE_AMOUNT = 64
WINDOW_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$")


class ReserveRequest(BaseModel):
    window: str
    resource_class: str
    amount: int


class QuotaExhausted(Exception):
    """The window cannot cover the reservation."""


class Ledger:
    def reserve(self, team: str, window: str, resource_class: str, amount: int) -> str:
        """Atomically take amount units, returning the reservation id. Raises QuotaExhausted."""
        raise NotImplementedError

    def consume(self, team: str, reservation_id: str) -> None:
        """Consume a reservation by id; an id that was never recorded cannot be consumed."""
        raise NotImplementedError


ledger = Ledger()


@app.post("/v1/quotas/{team}/reserve")
def reserve(
    team: str,
    body: ReserveRequest,
    caller: str | None = Header(default=None, alias="X-Team-Id"),
) -> JSONResponse:
    if caller is None or caller == "":
        raise HTTPException(status_code=401, detail="missing X-Team-Id")
    if caller != team:
        raise HTTPException(status_code=403, detail="team mismatch")
    if not WINDOW_RE.match(body.window):
        raise HTTPException(status_code=400, detail="window must be YYYY-MM-DDTHH:MMZ")
    if body.resource_class not in RESOURCE_CLASSES:
        raise HTTPException(status_code=400, detail="unknown resource class")
    if not 1 <= body.amount <= MAX_RESERVE_AMOUNT:
        raise HTTPException(status_code=400, detail="amount must be 1..64")

    try:
        reservation_id = ledger.reserve(team, body.window, body.resource_class, body.amount)
    except QuotaExhausted:
        raise HTTPException(status_code=409, detail="quota_exhausted")
    return JSONResponse(
        {
            "reservation_id": reservation_id,
            "team": team,
            "window": body.window,
            "resource_class": body.resource_class,
            "amount": body.amount,
        },
        status_code=201,
    )
`,
    },
    typescript: {
      starter: `/** POST /v1/quotas/:team/reserve: the reservation endpoint. */
import Fastify from 'fastify';

export const app = Fastify();

interface ReserveBody {
  window: string;
  resource_class: string;
  amount: number;
}

class Ledger {
  async quota(team: string, window: string): Promise<number> {
    throw new Error('not implemented');
  }
  async reserved(team: string, window: string): Promise<number> {
    throw new Error('not implemented');
  }
}

const ledger = new Ledger();

app.post('/v1/quotas/:team/reserve', async (request, reply) => {
  const {team} = request.params as {team: string};
  const body = request.body as ReserveBody;
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const remaining = (await ledger.quota(team, body.window)) - (await ledger.reserved(team, body.window));
  if (body.amount > remaining) return reply.code(409).send({error: 'quota_exhausted'});
  return reply.code(200).send({status: 'ok', amount: body.amount});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** POST /v1/quotas/:team/reserve: validate, authorize and record an atomic reservation. */
import Fastify from 'fastify';

export const app = Fastify();

const RESOURCE_CLASSES: Record<string, true> = {'gpu-a100': true, 'gpu-h100': true, 'tpu-v5': true};
const MAX_RESERVE_AMOUNT = 64;
const WINDOW_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$/;

interface ReserveBody {
  window: string;
  resource_class: string;
  amount: number;
}

class QuotaExhausted extends Error {}

class Ledger {
  async reserve(team: string, window: string, resourceClass: string, amount: number): Promise<string> {
    throw new Error('not implemented');
  }
  async consume(team: string, reservationId: string): Promise<void> {
    throw new Error('not implemented');
  }
}

const ledger = new Ledger();

app.post('/v1/quotas/:team/reserve', async (request, reply) => {
  const {team} = request.params as {team: string};
  const caller = request.headers['x-team-id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'missing X-Team-Id'});
  if (caller !== team) return reply.code(403).send({error: 'team mismatch'});

  const body = request.body as ReserveBody;
  if (typeof body.window !== 'string' || !WINDOW_RE.test(body.window))
    return reply.code(400).send({error: 'window must be YYYY-MM-DDTHH:MMZ'});
  if (RESOURCE_CLASSES[body.resource_class] !== true)
    return reply.code(400).send({error: 'unknown resource class'});
  if (!Number.isInteger(body.amount) || body.amount < 1 || body.amount > MAX_RESERVE_AMOUNT)
    return reply.code(400).send({error: 'amount must be 1..64'});

  let reservation_id: string;
  try {
    reservation_id = await ledger.reserve(team, body.window, body.resource_class, body.amount);
  } catch (error) {
    if (!(error instanceof QuotaExhausted)) throw error;
    return reply.code(409).send({error: 'quota_exhausted'});
  }
  return reply.code(201).send({
    reservation_id,
    team,
    window: body.window,
    resource_class: body.resource_class,
    amount: body.amount,
  });
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

type reserveRequest struct {
	Window        string \`json:"window"\`
	ResourceClass string \`json:"resource_class"\`
	Amount        int    \`json:"amount"\`
}

type Ledger struct{}

func (l *Ledger) Quota(team, window string) int    { return 0 }
func (l *Ledger) Reserved(team, window string) int { return 0 }

var ledger = &Ledger{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func reserve(rw http.ResponseWriter, r *http.Request) {
	team := r.PathValue("team")
	var body reserveRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, 409, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	remaining := ledger.Quota(team, body.Window) - ledger.Reserved(team, body.Window)
	if body.Amount > remaining {
		writeJSON(rw, 409, map[string]string{"error": "quota_exhausted"})
		return
	}
	writeJSON(rw, 200, map[string]any{"status": "ok", "amount": body.Amount})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/quotas/{team}/reserve", reserve)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"regexp"
)

const maxReserveAmount = 64

var resourceClasses = map[string]bool{"gpu-a100": true, "gpu-h100": true, "tpu-v5": true}
var windowPattern = regexp.MustCompile("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$")

type reserveRequest struct {
	Window        string \`json:"window"\`
	ResourceClass string \`json:"resource_class"\`
	Amount        int    \`json:"amount"\`
}

// QuotaExhausted answers 409: the window cannot cover the reservation.
type QuotaExhausted struct{}

func (QuotaExhausted) Error() string { return "quota exhausted" }

type Ledger struct{}

// Reserve takes amount units atomically and returns the reservation id, or QuotaExhausted.
func (l *Ledger) Reserve(team, window, resourceClass string, amount int) (string, error) {
	return "", nil
}

// Consume requires a reservation id that was actually recorded.
func (l *Ledger) Consume(team, reservationID string) error { return nil }

var ledger = &Ledger{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func reserve(rw http.ResponseWriter, r *http.Request) {
	team := r.PathValue("team")
	caller := r.Header.Get("X-Team-Id")
	if caller == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Team-Id"})
		return
	}
	if caller != team {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "team mismatch"})
		return
	}
	var body reserveRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if !windowPattern.MatchString(body.Window) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "window must be YYYY-MM-DDTHH:MMZ"})
		return
	}
	if !resourceClasses[body.ResourceClass] {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown resource class"})
		return
	}
	if body.Amount < 1 || body.Amount > maxReserveAmount {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "amount must be 1..64"})
		return
	}
	reservationID, err := ledger.Reserve(team, body.Window, body.ResourceClass, body.Amount)
	if err != nil {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "quota_exhausted"})
		return
	}
	writeJSON(rw, http.StatusCreated, map[string]any{
		"reservation_id": reservationID,
		"team":           team,
		"window":         body.Window,
		"resource_class": body.ResourceClass,
		"amount":         body.Amount,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/quotas/{team}/reserve", reserve)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ReserveRequest(window: String, resource_class: String, amount: Int)

object Ledger {
  def quota(team: String, window: String): Int = 0
  def reserved(team: String, window: String): Int = 0
}

object Api {
  implicit val system: ActorSystem = ActorSystem("quota-broker")
  implicit val reserveFormat: RootJsonFormat[ReserveRequest] = jsonFormat3(ReserveRequest)

  val route: Route =
    path("v1" / "quotas" / Segment / "reserve") { team =>
      post {
        entity(as[ReserveRequest]) { body =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val remaining = Ledger.quota(team, body.window) - Ledger.reserved(team, body.window)
          if (body.amount > remaining) complete(StatusCodes.Conflict, """{"error":"quota_exhausted"}""")
          else complete(StatusCodes.OK, s"""{"status":"ok","amount":\${body.amount}}""")
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
import org.apache.pekko.http.scaladsl.model.StatusCodes
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class ReserveRequest(window: String, resource_class: String, amount: Int)
final case class Reservation(
    reservation_id: String,
    team: String,
    window: String,
    resource_class: String,
    amount: Int)

object ledger {
  /** Takes amount units atomically and returns the reservation id. */
  def reserve(team: String, window: String, resourceClass: String, amount: Int): String = "res-1"

  /** Consume requires a reservation id that was actually recorded. */
  def consume(team: String, reservationId: String): Unit = ()
}

object Api {
  implicit val system: ActorSystem = ActorSystem("quota-broker")
  implicit val reserveFormat: RootJsonFormat[ReserveRequest] = jsonFormat3(ReserveRequest)
  implicit val reservationFormat: RootJsonFormat[Reservation] = jsonFormat5(Reservation)

  val ResourceClasses = Set("gpu-a100", "gpu-h100", "tpu-v5")
  val MaxReserveAmount = 64
  val WindowPattern = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$".r

  val route: Route =
    path("v1" / "quotas" / Segment / "reserve") { team =>
      post {
        optionalHeaderValueByName("X-Team-Id") { callerOpt =>
          entity(as[ReserveRequest]) { body =>
            if (!callerOpt.exists(_.nonEmpty)) {
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Team-Id"}""")
            } else if (!callerOpt.contains(team)) {
              complete(StatusCodes.Forbidden, """{"error":"team mismatch"}""")
            } else if (WindowPattern.findFirstIn(body.window).isEmpty) {
              complete(StatusCodes.BadRequest, """{"error":"window must be YYYY-MM-DDTHH:MMZ"}""")
            } else if (!ResourceClasses.contains(body.resource_class)) {
              complete(StatusCodes.BadRequest, """{"error":"unknown resource class"}""")
            } else if (body.amount < 1 || body.amount > MaxReserveAmount) {
              complete(StatusCodes.BadRequest, """{"error":"amount must be 1..64"}""")
            } else {
              val reservation_id = ledger.reserve(team, body.window, body.resource_class, body.amount)
              complete(
                StatusCodes.Created,
                Reservation(reservation_id, team, body.window, body.resource_class, body.amount))
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

class Ledger {
 public:
  int quota(const std::string& team, const std::string& window) { return 0; }
  int reserved(const std::string& team, const std::string& window) { return 0; }
};

Ledger ledger;

int main() {
  httplib::Server svr;

  svr.Post("/v1/quotas/:team/reserve", [](const httplib::Request& req, httplib::Response& res) {
    const auto team = req.path_params.at("team");
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      res.status = 409;
      res.set_content(R"({"error":"invalid json"})", "application/json");
      return;
    }
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    const auto window = body.value("window", std::string());
    const int amount = body.value("amount", 0);
    const int remaining = ledger.quota(team, window) - ledger.reserved(team, window);
    if (amount > remaining) {
      res.status = 409;
      res.set_content(R"({"error":"quota_exhausted"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(json{{"status", "ok"}, {"amount", amount}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <regex>
#include <set>
#include <string>

using json = nlohmann::json;

const std::set<std::string> kResourceClasses = {"gpu-a100", "gpu-h100", "tpu-v5"};
constexpr int kMaxReserveAmount = 64;
const std::regex kWindowRe(R"(^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$)");

class Ledger {
 public:
  // Takes amount units atomically and returns the reservation id.
  std::string reserve(
      const std::string& team,
      const std::string& window,
      const std::string& resource_class,
      int amount) {
    return "res-1";
  }

  // Consume requires a reservation id that was actually recorded.
  void consume(const std::string& team, const std::string& reservation_id) {}
};

Ledger ledger;

void fail(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json{{"error", error}}.dump(), "application/json");
}

int main() {
  httplib::Server svr;

  svr.Post("/v1/quotas/:team/reserve", [](const httplib::Request& req, httplib::Response& res) {
    const auto team = req.path_params.at("team");
    const auto caller = req.get_header_value("X-Team-Id");
    if (caller.empty()) {
      fail(res, 401, "missing X-Team-Id");
      return;
    }
    if (caller != team) {
      fail(res, 403, "team mismatch");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) {
      fail(res, 400, "invalid json");
      return;
    }
    const auto window = body.value("window", std::string());
    if (!std::regex_match(window, kWindowRe)) {
      fail(res, 400, "window must be YYYY-MM-DDTHH:MMZ");
      return;
    }
    const auto resource_class = body.value("resource_class", std::string());
    if (kResourceClasses.count(resource_class) == 0) {
      fail(res, 400, "unknown resource class");
      return;
    }
    const int amount = body.value("amount", 0);
    if (amount < 1 || amount > kMaxReserveAmount) {
      fail(res, 400, "amount must be 1..64");
      return;
    }
    const auto reservation_id = ledger.reserve(team, window, resource_class, amount);
    res.status = 201;
    res.set_content(
        json{{"reservation_id", reservation_id},
             {"team", team},
             {"window", window},
             {"resource_class", resource_class},
             {"amount", amount}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Load test: two clients each ask for the last four GPUs in the same window at the same moment and both get `200 ok`. A later consume with no reservation id finds nothing to consume.',
    'The handler reads `quota` and `reserved` in two calls, compares, and answers. Nothing increments `reserved`, so every caller sees the same remaining value and the comparison always passes.',
    'Replace the comparison with one `ledger.reserve(team, window, resource_class, amount)` call and return its `reservation_id` with **201**. The other three checks are guards: `X-Team-Id` (401/403), `WINDOW_RE`, `RESOURCE_CLASSES`, `MAX_RESERVE_AMOUNT`.',
  ],
  debrief: `A reservation has to be a record, not a decision. The starter's check and its answer are two
operations with nothing written between them, so the second caller wins the race. The fix moves
the decision into the ledger: one call that reads, compares and records, so there is no state in
which capacity was granted but not held. The guards sit in front of that call, cheapest first,
because the path team and the body class are claims, and a broker that accepts them reserves one
team's GPUs for a resource it does not track. Production brokers load per-team limits from
configuration, give each reservation a maximum hold time so an abandoned grant returns to the
pool, and write an audit record for every grant and release.`,
};
