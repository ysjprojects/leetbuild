import type {Step} from '@/lib/types';

export const endpointStep: Step = {
  id: 'endpoint',
  title: 'POST /v1/quotas/{team}/reserve: a grant that is recorded',
  concept: 'http',
  file: 'api',
  focus: ['client', 'broker', 'redis'],
  task: `## Task

**Starting point.** The starter registers \`POST /v1/quotas/{team}/reserve\` with a body
\`{"window": "2026-11-02T14:00Z", "resource_class": "gpu-a100", "amount": 4}\`. It compares the amount
with the team's limit (\`ledger.limit_of\`, provided in \`quota.ledger\`), answers **409**
\`quota_exhausted\` when the amount is larger and \`200 {"status": "ok"}\` otherwise. It serves the
demo and hides four flaws.

**Failure mode the checks target.** Every request under the limit gets an ok, so two jobs are
promised the same GPUs and nothing records either grant; any caller can reserve against another
team's window, with a window, a class or an amount the broker cannot enforce.

- The caller's team is the \`X-Team-Id\` header: missing is **401**, a path team that differs is
  **403**.
- \`window\` matches \`WINDOW_RE\` (\`YYYY-MM-DDTHH:MMZ\`) and \`amount\` is an integer from 1 to
  \`MAX_RESERVE_AMOUNT\` (64), else **400**.
- \`resource_class\` is one of \`RESOURCE_CLASSES\` (\`gpu-a100\`, \`gpu-h100\`, \`tpu-v5\`), else **400**.
- Take the units with one \`ledger.reserve(team, window, resource_class, amount)\` call: it returns
  the reservation id, or nothing when the window is full (**409** \`quota_exhausted\`). Answer
  **201** with \`{reservation_id, team, window, resource_class, amount}\`.`,
  sequence: {
    participants: ['Client', 'Quota Broker', 'Redis'],
    messages: [
      {
        from: 'Client',
        to: 'Quota Broker',
        label: 'POST /v1/quotas/research/reserve · X-Team-Id · {window, resource_class, amount}',
        kind: 'sync',
      },
      {
        from: 'Quota Broker',
        to: 'Quota Broker',
        label: '401 no team · 403 another team · 400 window, class, amount',
        kind: 'sync',
      },
      {
        from: 'Quota Broker',
        to: 'Redis',
        label: 'ledger.reserve: EVAL take from quota:research:{window}',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Quota Broker', label: 'reservation id · or nothing when the window is full', kind: 'reply'},
      {
        from: 'Quota Broker',
        to: 'Client',
        label: '201 {reservation_id, team, window, resource_class, amount} · 409 quota_exhausted',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers POST /v1/quotas/{team}/reserve',
      detail: 'A reserve within the team’s limit on the team-scoped path is answered with a 2xx.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/quotas\/\{team\}\/reserve["']/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/quotas\/:team\/reserve['"]/]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/quotas\/\{team\}\/reserve"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"quotas"\s*\/\s*Segment\s*\/\s*"reserve"\s*\)/]},
        cpp: {all: [/svr\.Post\([^\n]*\/v1\/quotas\/[^\n]*\/reserve/]},
      },
    },
    {
      id: 'team-scope',
      title: 'Scopes the path team to the X-Team-Id caller',
      detail:
        'A reserve without `X-Team-Id` is **401** and one whose path names another team is **403**, with nothing written; the starter trusts the path, so any caller can take another team’s units.',
      match: {
        python: {all: [/x-team-id/i, /\b401\b/, /\b403\b/]},
        typescript: {all: [/x-team-id/i, /code\(\s*401\s*\)/, /code\(\s*403\s*\)/]},
        go: {all: [/X-Team-Id/i, /StatusUnauthorized|\b401\b/, /StatusForbidden|\b403\b/]},
        scala: {all: [/X-Team-Id/i, /Unauthorized/, /Forbidden/]},
        cpp: {all: [/X-Team-Id/i, /\b401\b/, /\b403\b/]},
      },
    },
    {
      id: 'window-and-amount',
      title: 'Validates the window shape and the amount range',
      detail:
        'A window that does not match `WINDOW_RE` (`YYYY-MM-DDTHH:MMZ`) and an amount outside 1..`MAX_RESERVE_AMOUNT` are **400**; the starter takes any string as a window and lets an amount over the cap reach the quota comparison.',
      match: {
        python: {all: [/WINDOW_RE/, /MAX_RESERVE_AMOUNT/, /\b400\b/]},
        typescript: {all: [/WINDOW_RE/, /MAX_RESERVE_AMOUNT/, /code\(\s*400\s*\)/]},
        go: {all: [/windowPattern/, /maxReserveAmount/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/WindowPattern/, /MaxReserveAmount/, /BadRequest/]},
        cpp: {all: [/kWindowRe/, /kMaxReserveAmount/, /\b400\b/]},
      },
    },
    {
      id: 'resource-class',
      title: 'Rejects an unknown resource class',
      detail:
        'A class outside `RESOURCE_CLASSES` is **400**; the starter carries the caller’s string into the grant, so the broker hands out a class it has no pool for.',
      match: {
        python: {all: [/RESOURCE_CLASSES/, /\b400\b/]},
        typescript: {all: [/RESOURCE_CLASSES/, /code\(\s*400\s*\)/]},
        go: {all: [/resourceClasses/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/ResourceClasses/, /BadRequest/]},
        cpp: {all: [/kResourceClasses/, /\b400\b/]},
      },
    },
    {
      id: 'recorded',
      title: 'Records the grant and answers 201 with its id',
      detail:
        'The units are taken through one `ledger.reserve` call, the answer is **201** with the reservation id, and a reserve the window can no longer cover is **409**; the starter answers ok and writes nothing, so a second job is promised the same units.',
      match: {
        python: {all: [/ledger\.reserve\(/, /reservation_id/, /\b201\b/], none: [/["']status["']\s*:\s*["']ok["']/]},
        typescript: {all: [/\breserve\(/, /reservation_id/, /code\(\s*201\s*\)/], none: [/status:\s*['"]ok['"]/]},
        go: {all: [/ledger\.Reserve\(/, /"reservation_id"/, /StatusCreated|\b201\b/], none: [/"status":\s*"ok"/]},
        scala: {all: [/Ledger\.reserve\(/, /reservation_id/, /Created/], none: [/"status"\s*->\s*JsString\("ok"\)/]},
        cpp: {all: [/ledger::reserve\(/, /"reservation_id"/, /\b201\b/], none: [/\{"status",\s*"ok"\}/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from quota import ledger  # limit_of, reserve, release, consume

app = FastAPI()


class ReserveRequest(BaseModel):
    window: str
    resource_class: str
    amount: int


@app.post("/v1/quotas/{team}/reserve")
def reserve(team: str, body: ReserveRequest, request: Request) -> JSONResponse:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    if body.amount > ledger.limit_of(team):
        return JSONResponse({"error": "quota_exhausted"}, status_code=409)
    return JSONResponse({"status": "ok", "team": team, "amount": body.amount})
`,
      solution: `import re

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from quota import ledger  # limit_of, reserve, release, consume

app = FastAPI()

RESOURCE_CLASSES = {"gpu-a100", "gpu-h100", "tpu-v5"}
MAX_RESERVE_AMOUNT = 64
WINDOW_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$")


class ReserveRequest(BaseModel):
    window: str
    resource_class: str
    amount: int


@app.post("/v1/quotas/{team}/reserve")
def reserve(team: str, body: ReserveRequest, request: Request) -> JSONResponse:
    caller = request.headers.get("x-team-id", "")
    if not caller:
        return JSONResponse({"error": "missing X-Team-Id"}, status_code=401)
    if caller != team:
        return JSONResponse({"error": "another team's quota"}, status_code=403)
    if not WINDOW_RE.match(body.window):
        return JSONResponse({"error": "window must be YYYY-MM-DDTHH:MMZ"}, status_code=400)
    if body.resource_class not in RESOURCE_CLASSES:
        return JSONResponse({"error": "unknown resource class"}, status_code=400)
    if not 1 <= body.amount <= MAX_RESERVE_AMOUNT:
        return JSONResponse({"error": f"amount must be 1..{MAX_RESERVE_AMOUNT}"}, status_code=400)
    # One call compares and takes inside Redis: no second request can land between the two.
    reservation_id = ledger.reserve(team, body.window, body.resource_class, body.amount)
    if reservation_id is None:
        return JSONResponse({"error": "quota_exhausted"}, status_code=409)
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
      starter: `import Fastify from 'fastify';

import {limitOf, reserve} from 'quota/ledger';

export const app = Fastify();

interface ReserveBody {
  window: string;
  resource_class: string;
  amount: number;
}

app.post('/v1/quotas/:team/reserve', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {team} = request.params as {team: string};
  const body = request.body as ReserveBody;
  if (body.amount > (await limitOf(team))) return reply.code(409).send({error: 'quota_exhausted'});
  return {status: 'ok', team, amount: body.amount};
});
`,
      solution: `import Fastify from 'fastify';

import {limitOf, reserve} from 'quota/ledger';

export const app = Fastify();

export const RESOURCE_CLASSES = new Set(['gpu-a100', 'gpu-h100', 'tpu-v5']);
export const MAX_RESERVE_AMOUNT = 64;
export const WINDOW_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$/;

interface ReserveBody {
  window: string;
  resource_class: string;
  amount: number;
}

app.post('/v1/quotas/:team/reserve', async (request, reply) => {
  const {team} = request.params as {team: string};
  const caller = request.headers['x-team-id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'missing X-Team-Id'});
  if (caller !== team) return reply.code(403).send({error: "another team's quota"});
  const body = request.body as ReserveBody;
  if (typeof body.window !== 'string' || !WINDOW_RE.test(body.window)) {
    return reply.code(400).send({error: 'window must be YYYY-MM-DDTHH:MMZ'});
  }
  if (!RESOURCE_CLASSES.has(body.resource_class)) return reply.code(400).send({error: 'unknown resource class'});
  if (!Number.isInteger(body.amount) || body.amount < 1 || body.amount > MAX_RESERVE_AMOUNT) {
    return reply.code(400).send({error: \`amount must be 1..\${MAX_RESERVE_AMOUNT}\`});
  }
  // One call compares and takes inside Redis: no second request can land between the two.
  const reservationId = await reserve(team, body.window, body.resource_class, body.amount);
  if (reservationId === null) return reply.code(409).send({error: 'quota_exhausted'});
  return reply.code(201).send({
    reservation_id: reservationId,
    team,
    window: body.window,
    resource_class: body.resource_class,
    amount: body.amount,
  });
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"quota/ledger" // ledger.LimitOf, Reserve, Release, Consume
)

type reserveRequest struct {
	Window        string \`json:"window"\`
	ResourceClass string \`json:"resource_class"\`
	Amount        int64  \`json:"amount"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func reserve(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	team := r.PathValue("team")
	var body reserveRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if body.Amount > ledger.LimitOf(r.Context(), team) {
		writeJSON(rw, http.StatusConflict, map[string]string{"error": "quota_exhausted"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{"status": "ok", "team": team, "amount": body.Amount})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/quotas/{team}/reserve", reserve)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"regexp"

	"quota/ledger" // ledger.LimitOf, Reserve, Release, Consume
)

const maxReserveAmount = 64

var (
	windowPattern   = regexp.MustCompile(\`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$\`)
	resourceClasses = map[string]bool{"gpu-a100": true, "gpu-h100": true, "tpu-v5": true}
)

type reserveRequest struct {
	Window        string \`json:"window"\`
	ResourceClass string \`json:"resource_class"\`
	Amount        int64  \`json:"amount"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func reserve(rw http.ResponseWriter, r *http.Request) {
	team := r.PathValue("team")
	caller := r.Header.Get("X-Team-Id")
	if caller == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Team-Id"})
		return
	}
	if caller != team {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "another team's quota"})
		return
	}
	var body reserveRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
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
	// One call compares and takes inside Redis: no second request can land between the two.
	reservationID, err := ledger.Reserve(r.Context(), team, body.Window, body.ResourceClass, body.Amount, "")
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if reservationID == "" {
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

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/quotas/{team}/reserve", reserve)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import quota.Ledger // Ledger.limitOf, reserve, release, consume

object Api {
  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  val route: Route =
    path("v1" / "quotas" / Segment / "reserve") { team =>
      post {
        entity(as[String]) { raw =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val body = raw.parseJson.asJsObject.fields
          val amount = body.get("amount").collect { case JsNumber(n) => n.toLong }.getOrElse(0L)
          if (amount > Ledger.limitOf(team)) complete(json(StatusCodes.Conflict, JsObject("error" -> JsString("quota_exhausted"))))
          else complete(json(StatusCodes.OK, JsObject("status" -> JsString("ok"), "team" -> JsString(team), "amount" -> JsNumber(amount))))
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import quota.Ledger // Ledger.limitOf, reserve, release, consume

object Api {
  val ResourceClasses: Set[String] = Set("gpu-a100", "gpu-h100", "tpu-v5")
  val MaxReserveAmount = 64L
  val WindowPattern = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$".r

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  val route: Route =
    path("v1" / "quotas" / Segment / "reserve") { team =>
      post {
        optionalHeaderValueByName("X-Team-Id") { caller =>
          entity(as[String]) { raw =>
            val body = raw.parseJson.asJsObject.fields
            val window = body.get("window").collect { case JsString(s) => s }.getOrElse("")
            val resourceClass = body.get("resource_class").collect { case JsString(s) => s }.getOrElse("")
            val amount = body.get("amount").collect { case JsNumber(n) if n.isValidLong => n.toLong }.getOrElse(0L)
            if (caller.forall(_.isEmpty)) complete(error(StatusCodes.Unauthorized, "missing X-Team-Id"))
            else if (!caller.contains(team)) complete(error(StatusCodes.Forbidden, "another team's quota"))
            else if (WindowPattern.findFirstIn(window).isEmpty) complete(error(StatusCodes.BadRequest, "window must be YYYY-MM-DDTHH:MMZ"))
            else if (!ResourceClasses.contains(resourceClass)) complete(error(StatusCodes.BadRequest, "unknown resource class"))
            else if (amount < 1 || amount > MaxReserveAmount) complete(error(StatusCodes.BadRequest, s"amount must be 1..$MaxReserveAmount"))
            else
              // One call compares and takes inside Redis: no second request can land between the two.
              Ledger.reserve(team, window, resourceClass, amount) match {
                case None => complete(error(StatusCodes.Conflict, "quota_exhausted"))
                case Some(reservationId) =>
                  complete(
                    json(
                      StatusCodes.Created,
                      JsObject(
                        "reservation_id" -> JsString(reservationId),
                        "team" -> JsString(team),
                        "window" -> JsString(window),
                        "resource_class" -> JsString(resourceClass),
                        "amount" -> JsNumber(amount)
                      )
                    )
                  )
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

#include <string>

#include "quota/ledger.h"  // ledger::limitOf, reserve, release, consume

using json = nlohmann::json;

void reserve_units(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string team = req.matches[1];
  const json body = json::parse(req.body, nullptr, false);
  const long long amount = body.is_object() ? body.value("amount", 0LL) : 0LL;
  if (amount > ledger::limitOf(team)) {
    res.status = 409;
    res.set_content(json{{"error", "quota_exhausted"}}.dump(), "application/json");
    return;
  }
  res.set_content(json{{"status", "ok"}, {"team", team}, {"amount", amount}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post(R"(/v1/quotas/([\\w-]+)/reserve)", reserve_units); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <regex>
#include <set>
#include <string>

#include "quota/ledger.h"  // ledger::limitOf, reserve, release, consume

using json = nlohmann::json;

const std::set<std::string> kResourceClasses = {"gpu-a100", "gpu-h100", "tpu-v5"};
constexpr long long kMaxReserveAmount = 64;
const std::regex kWindowRe("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$");

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

void reserve_units(const httplib::Request& req, httplib::Response& res) {
  const std::string team = req.matches[1];
  const std::string caller = req.get_header_value("X-Team-Id");
  if (caller.empty()) return fail(res, 401, "missing X-Team-Id");
  if (caller != team) return fail(res, 403, "another team's quota");
  const json body = json::parse(req.body, nullptr, false);
  if (!body.is_object()) return fail(res, 400, "invalid JSON");
  const std::string window = body.contains("window") && body["window"].is_string() ? body["window"].get<std::string>() : "";
  const std::string resource_class =
      body.contains("resource_class") && body["resource_class"].is_string() ? body["resource_class"].get<std::string>() : "";
  const long long amount = body.contains("amount") && body["amount"].is_number_integer() ? body["amount"].get<long long>() : 0;
  if (!std::regex_match(window, kWindowRe)) return fail(res, 400, "window must be YYYY-MM-DDTHH:MMZ");
  if (!kResourceClasses.count(resource_class)) return fail(res, 400, "unknown resource class");
  if (amount < 1 || amount > kMaxReserveAmount) return fail(res, 400, "amount must be 1..64");
  // One call compares and takes inside Redis: no second request can land between the two.
  const auto reservation_id = ledger::reserve(team, window, resource_class, amount);
  if (!reservation_id) return fail(res, 409, "quota_exhausted");
  res.status = 201;
  res.set_content(json{{"reservation_id", *reservation_id},
                       {"team", team},
                       {"window", window},
                       {"resource_class", resource_class},
                       {"amount", amount}}
                      .dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Post(R"(/v1/quotas/([\\w-]+)/reserve)", reserve_units); }
`,
    },
  },
  harness: {
    python: `W = "2026-11-02T14:00Z"
BODY = {"window": W, "resource_class": "gpu-a100", "amount": 4}


def _api(ctx):
    return ctx.client(ctx.load("api").app)


async def _reserve(c, team="research", caller="research", **fields):
    headers = {} if caller is None else {"X-Team-Id": caller}
    return await c.post(f"/v1/quotas/{team}/reserve", json={**BODY, **fields}, headers=headers)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _reserve(c)
    assert r.status_code in (200, 201), f"POST /v1/quotas/research/reserve for 4 of research's 8 units answered {r.status_code}: {r.text}"


async def check_team_scope(ctx):
    async with _api(ctx) as c:
        anonymous = await _reserve(c, caller=None)
        assert anonymous.status_code == 401, f"a reserve without X-Team-Id answered {anonymous.status_code}, expected 401"
        foreign = await _reserve(c, team="vision", caller="research")
        assert foreign.status_code == 403, f"team research reserving on /v1/quotas/vision/reserve answered {foreign.status_code}, expected 403: the path names another team's quota"
        assert not ctx.redis.keys("quota:vision:*"), f"the forbidden reserve wrote vision's ledger: {ctx.redis.keys('quota:vision:*')}"
        own = await _reserve(c)
    assert own.status_code in (200, 201), f"research reserving on its own path answered {own.status_code}: {own.text}"


async def check_window_and_amount(ctx):
    async with _api(ctx) as c:
        for window in ("tomorrow", "2026-11-02 14:00", "2026-11-02T14:00:00Z"):
            r = await _reserve(c, window=window)
            assert r.status_code == 400, f"a reserve for window {window!r} answered {r.status_code}, expected 400: the window must match YYYY-MM-DDTHH:MMZ"
        for amount in (0, -3, 65):
            r = await _reserve(c, amount=amount)
            assert r.status_code == 400, f"a reserve of {amount} units answered {r.status_code}, expected 400: the amount is 1..64"
        assert not ctx.redis.keys("quota:*"), f"a rejected reserve wrote the ledger: {ctx.redis.keys('quota:*')}"
        r = await _reserve(c, amount=1)
    assert r.status_code in (200, 201), f"a valid reserve of 1 unit answered {r.status_code}: {r.text}"


async def check_resource_class(ctx):
    async with _api(ctx) as c:
        for resource_class in ("gpu-z9", "GPU-A100", ""):
            r = await _reserve(c, resource_class=resource_class)
            assert r.status_code == 400, f"a reserve of resource class {resource_class!r} answered {r.status_code}, expected 400: the broker has no pool for it"
        for resource_class in ("gpu-a100", "gpu-h100", "tpu-v5"):
            r = await _reserve(c, resource_class=resource_class, amount=1)
            assert r.status_code in (200, 201), f"a reserve of {resource_class} answered {r.status_code}: {r.text}"


async def check_recorded(ctx):
    async with _api(ctx) as c:
        first = await _reserve(c, amount=5)
        assert first.status_code == 201, f"a reserve of 5 of research's 8 units answered {first.status_code} {first.text}, expected 201 with the reservation"
        body = first.json()
        reservation_id = body.get("reservation_id")
        assert reservation_id, f"the 201 carries no reservation_id: {body}. A release or a consume needs it"
        expected = {"reservation_id": reservation_id, "team": "research", "window": W, "resource_class": "gpu-a100", "amount": 5}
        assert body == expected, f"the 201 body is {body}, expected {expected}"
        record = ctx.redis.hgetall(f"reservation:research:{reservation_id}")
        assert record.get("amount") == "5" and record.get("window") == W, f"reservation:research:{reservation_id} holds {record}: the grant must be recorded through ledger.reserve"
        assert ctx.redis.hget(f"quota:research:{W}", "reserved") == "5", f"quota:research:{W} holds {ctx.redis.hgetall(f'quota:research:{W}')}, expected reserved 5"
        second = await _reserve(c, amount=5)
        assert second.status_code == 409 and "quota_exhausted" in second.text, f"with 3 of research's 8 units left a reserve of 5 answered {second.status_code} {second.text}, expected 409 quota_exhausted: the same units went to two jobs"
        third = await _reserve(c, amount=3)
    assert third.status_code == 201, f"the last 3 units must still be granted, the reserve answered {third.status_code} {third.text}"
`,
    typescript: `const W = '2026-11-02T14:00Z';
const BODY = {window: W, resource_class: 'gpu-a100', amount: 4};

function reserve(c, fields: Record<string, unknown> = {}, team = 'research', caller: string | null = 'research') {
  const headers = caller === null ? {} : {'X-Team-Id': caller};
  return c.post(\`/v1/quotas/\${team}/reserve\`, {json: {...BODY, ...fields}, headers});
}

export async function check_route(ctx) {
  const c = ctx.client(ctx.load('api').app);
  const r = await reserve(c);
  assert(r.status === 200 || r.status === 201, \`POST /v1/quotas/research/reserve for 4 of research's 8 units answered \${r.status}: \${r.text}\`);
}

export async function check_team_scope(ctx) {
  const c = ctx.client(ctx.load('api').app);
  const anonymous = await reserve(c, {}, 'research', null);
  assert.equal(anonymous.status, 401, \`a reserve without X-Team-Id answered \${anonymous.status}, expected 401\`);
  const foreign = await reserve(c, {}, 'vision', 'research');
  assert.equal(foreign.status, 403, \`team research reserving on /v1/quotas/vision/reserve answered \${foreign.status}, expected 403: the path names another team's quota\`);
  assert.equal(ctx.redis.keys('quota:vision:*').length, 0, "the forbidden reserve wrote vision's ledger");
  const own = await reserve(c);
  assert(own.status === 200 || own.status === 201, \`research reserving on its own path answered \${own.status}: \${own.text}\`);
}

export async function check_window_and_amount(ctx) {
  const c = ctx.client(ctx.load('api').app);
  for (const window of ['tomorrow', '2026-11-02 14:00', '2026-11-02T14:00:00Z']) {
    const r = await reserve(c, {window});
    assert.equal(r.status, 400, \`a reserve for window "\${window}" answered \${r.status}, expected 400: the window must match YYYY-MM-DDTHH:MMZ\`);
  }
  for (const amount of [0, -3, 65]) {
    const r = await reserve(c, {amount});
    assert.equal(r.status, 400, \`a reserve of \${amount} units answered \${r.status}, expected 400: the amount is 1..64\`);
  }
  assert.equal(ctx.redis.keys('quota:*').length, 0, \`a rejected reserve wrote the ledger: \${JSON.stringify(ctx.redis.keys('quota:*'))}\`);
  const r = await reserve(c, {amount: 1});
  assert(r.status === 200 || r.status === 201, \`a valid reserve of 1 unit answered \${r.status}: \${r.text}\`);
}

export async function check_resource_class(ctx) {
  const c = ctx.client(ctx.load('api').app);
  for (const resourceClass of ['gpu-z9', 'GPU-A100', '']) {
    const r = await reserve(c, {resource_class: resourceClass});
    assert.equal(r.status, 400, \`a reserve of resource class "\${resourceClass}" answered \${r.status}, expected 400: the broker has no pool for it\`);
  }
  for (const resourceClass of ['gpu-a100', 'gpu-h100', 'tpu-v5']) {
    const r = await reserve(c, {resource_class: resourceClass, amount: 1});
    assert(r.status === 200 || r.status === 201, \`a reserve of \${resourceClass} answered \${r.status}: \${r.text}\`);
  }
}

export async function check_recorded(ctx) {
  const c = ctx.client(ctx.load('api').app);
  const first = await reserve(c, {amount: 5});
  assert.equal(first.status, 201, \`a reserve of 5 of research's 8 units answered \${first.status} \${first.text}, expected 201 with the reservation\`);
  const body = first.json();
  const reservationId = body.reservation_id;
  assert(reservationId, \`the 201 carries no reservation_id: \${first.text}. A release or a consume needs it\`);
  const expected = {reservation_id: reservationId, team: 'research', window: W, resource_class: 'gpu-a100', amount: 5};
  assert.deepStrictEqual(body, expected, \`the 201 body is \${first.text}, expected \${JSON.stringify(expected)}\`);
  const record = ctx.redis.hgetall(\`reservation:research:\${reservationId}\`);
  assert(record.amount === '5' && record.window === W, \`reservation:research:\${reservationId} holds \${JSON.stringify(record)}: the grant must be recorded through reserve\`);
  assert.equal(ctx.redis.hget(\`quota:research:\${W}\`, 'reserved'), '5', \`quota:research:\${W} holds \${JSON.stringify(ctx.redis.hgetall(\`quota:research:\${W}\`))}, expected reserved 5\`);
  const second = await reserve(c, {amount: 5});
  assert(second.status === 409 && second.text.includes('quota_exhausted'), \`with 3 of research's 8 units left a reserve of 5 answered \${second.status} \${second.text}, expected 409 quota_exhausted: the same units went to two jobs\`);
  const third = await reserve(c, {amount: 3});
  assert.equal(third.status, 201, \`the last 3 units must still be granted, the reserve answered \${third.status} \${third.text}\`);
}
`,
    go: `package main

import (
	"net/http"
	"strings"

	"leetbuild/harness"
)

const apiWindow = "2026-11-02T14:00Z"

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func body(fields map[string]any) map[string]any {
	out := map[string]any{"window": apiWindow, "resource_class": "gpu-a100", "amount": 4}
	for k, v := range fields {
		out[k] = v
	}
	return out
}

func reserveAs(c *harness.HTTP, team, caller string, fields map[string]any) *harness.Response {
	if caller == "" {
		return c.Post("/v1/quotas/"+team+"/reserve", body(fields))
	}
	return c.Post("/v1/quotas/"+team+"/reserve", body(fields), "X-Team-Id", caller)
}

func ok(r *harness.Response) bool { return r.Status == 200 || r.Status == 201 }

func CheckRoute(ctx *harness.Ctx) {
	r := reserveAs(api(ctx), "research", "research", nil)
	ctx.Assert(ok(r), "POST /v1/quotas/research/reserve for 4 of research's 8 units answered %d: %s", r.Status, r.Text())
}

func CheckTeamScope(ctx *harness.Ctx) {
	c := api(ctx)
	anonymous := reserveAs(c, "research", "", nil)
	ctx.Equal(anonymous.Status, 401, "a reserve without X-Team-Id; the status")
	foreign := reserveAs(c, "vision", "research", nil)
	ctx.Equal(foreign.Status, 403, "team research reserving on /v1/quotas/vision/reserve (the path names another team's quota); the status")
	ctx.Equal(len(ctx.Redis.Keys("quota:vision:*")), 0, "the forbidden reserve must not write vision's ledger; the keys")
	own := reserveAs(c, "research", "research", nil)
	ctx.Assert(ok(own), "research reserving on its own path answered %d: %s", own.Status, own.Text())
}

func CheckWindowAndAmount(ctx *harness.Ctx) {
	c := api(ctx)
	for _, window := range []string{"tomorrow", "2026-11-02 14:00", "2026-11-02T14:00:00Z"} {
		r := reserveAs(c, "research", "research", map[string]any{"window": window})
		ctx.Equal(r.Status, 400, "a reserve for window %q (the window must match YYYY-MM-DDTHH:MMZ); the status", window)
	}
	for _, amount := range []int{0, -3, 65} {
		r := reserveAs(c, "research", "research", map[string]any{"amount": amount})
		ctx.Equal(r.Status, 400, "a reserve of %d units (the amount is 1..64); the status", amount)
	}
	ctx.Equal(len(ctx.Redis.Keys("quota:*")), 0, "a rejected reserve must not write the ledger; the keys")
	r := reserveAs(c, "research", "research", map[string]any{"amount": 1})
	ctx.Assert(ok(r), "a valid reserve of 1 unit answered %d: %s", r.Status, r.Text())
}

func CheckResourceClass(ctx *harness.Ctx) {
	c := api(ctx)
	for _, class := range []string{"gpu-z9", "GPU-A100", ""} {
		r := reserveAs(c, "research", "research", map[string]any{"resource_class": class})
		ctx.Equal(r.Status, 400, "a reserve of resource class %q (the broker has no pool for it); the status", class)
	}
	for _, class := range []string{"gpu-a100", "gpu-h100", "tpu-v5"} {
		r := reserveAs(c, "research", "research", map[string]any{"resource_class": class, "amount": 1})
		ctx.Assert(ok(r), "a reserve of %s answered %d: %s", class, r.Status, r.Text())
	}
}

func CheckRecorded(ctx *harness.Ctx) {
	c := api(ctx)
	first := reserveAs(c, "research", "research", map[string]any{"amount": 5})
	ctx.Equal(first.Status, 201, "a reserve of 5 of research's 8 units must answer 201 with the reservation (%s); the status", first.Text())
	var got struct {
		ReservationID string \`json:"reservation_id"\`
		Team          string \`json:"team"\`
		Window        string \`json:"window"\`
		ResourceClass string \`json:"resource_class"\`
		Amount        int    \`json:"amount"\`
	}
	first.Decode(&got)
	ctx.Assert(got.ReservationID != "", "the 201 carries no reservation_id: %s. A release or a consume needs it", first.Text())
	ctx.Assert(got.Team == "research" && got.Window == apiWindow && got.ResourceClass == "gpu-a100" && got.Amount == 5, "the 201 body is %s, expected the team, window, resource_class and amount of the grant", first.Text())
	record := ctx.Redis.HGetAll("reservation:research:" + got.ReservationID)
	ctx.Assert(record["amount"] == "5" && record["window"] == apiWindow, "reservation:research:%s holds %v: the grant must be recorded through ledger.Reserve", got.ReservationID, record)
	reserved, _ := ctx.Redis.HGet("quota:research:"+apiWindow, "reserved")
	ctx.Equal(reserved, "5", "quota:research:%s reserved", apiWindow)
	second := reserveAs(c, "research", "research", map[string]any{"amount": 5})
	ctx.Assert(second.Status == 409 && strings.Contains(second.Text(), "quota_exhausted"), "with 3 of research's 8 units left a reserve of 5 answered %d %s, expected 409 quota_exhausted: the same units went to two jobs", second.Status, second.Text())
	third := reserveAs(c, "research", "research", map[string]any{"amount": 3})
	ctx.Equal(third.Status, 201, "the last 3 units must still be granted (%s); the status", third.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

namespace {

const std::string kW = "2026-11-02T14:00Z";

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

std::string body(nlohmann::json fields = nlohmann::json::object()) {
  nlohmann::json out = {{"window", kW}, {"resource_class", "gpu-a100"}, {"amount", 4}};
  for (const auto& [k, v] : fields.items()) out[k] = v;
  return out.dump();
}

harness::Response reserveAs(harness::HTTP& c, const std::string& team, const std::string& caller, nlohmann::json fields = nlohmann::json::object()) {
  if (caller.empty()) return c.Post("/v1/quotas/" + team + "/reserve", body(fields), "Content-Type", "application/json");
  return c.Post("/v1/quotas/" + team + "/reserve", body(fields), "Content-Type", "application/json", "X-Team-Id", caller);
}

bool ok(const harness::Response& r) { return r.Status == 200 || r.Status == 201; }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = reserveAs(c, "research", "research");
  ctx.Assert(ok(r), "POST /v1/quotas/research/reserve for 4 of research's 8 units answered %d: %s", r.Status, r.Text());
}

void CheckTeamScope(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto anonymous = reserveAs(c, "research", "");
  ctx.Equal(anonymous.Status, 401, "a reserve without X-Team-Id; the status");
  const auto foreign = reserveAs(c, "vision", "research");
  ctx.Equal(foreign.Status, 403, "team research reserving on /v1/quotas/vision/reserve (the path names another team's quota); the status");
  ctx.Equal(ctx.Redis.Keys("quota:vision:*").size(), 0, "the forbidden reserve must not write vision's ledger; the keys");
  const auto own = reserveAs(c, "research", "research");
  ctx.Assert(ok(own), "research reserving on its own path answered %d: %s", own.Status, own.Text());
}

void CheckWindowAndAmount(harness::Ctx& ctx) {
  auto c = api(ctx);
  for (const std::string window : {"tomorrow", "2026-11-02 14:00", "2026-11-02T14:00:00Z"}) {
    const auto r = reserveAs(c, "research", "research", {{"window", window}});
    ctx.Equal(r.Status, 400, "a reserve for window %q (the window must match YYYY-MM-DDTHH:MMZ); the status", window);
  }
  for (const int amount : {0, -3, 65}) {
    const auto r = reserveAs(c, "research", "research", {{"amount", amount}});
    ctx.Equal(r.Status, 400, "a reserve of %d units (the amount is 1..64); the status", amount);
  }
  ctx.Equal(ctx.Redis.Keys("quota:*").size(), 0, "a rejected reserve must not write the ledger; the keys");
  const auto r = reserveAs(c, "research", "research", {{"amount", 1}});
  ctx.Assert(ok(r), "a valid reserve of 1 unit answered %d: %s", r.Status, r.Text());
}

void CheckResourceClass(harness::Ctx& ctx) {
  auto c = api(ctx);
  for (const std::string resource_class : {"gpu-z9", "GPU-A100", ""}) {
    const auto r = reserveAs(c, "research", "research", {{"resource_class", resource_class}});
    ctx.Equal(r.Status, 400, "a reserve of resource class %q (the broker has no pool for it); the status", resource_class);
  }
  for (const std::string resource_class : {"gpu-a100", "gpu-h100", "tpu-v5"}) {
    const auto r = reserveAs(c, "research", "research", {{"resource_class", resource_class}, {"amount", 1}});
    ctx.Assert(ok(r), "a reserve of %s answered %d: %s", resource_class, r.Status, r.Text());
  }
}

void CheckRecorded(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto first = reserveAs(c, "research", "research", {{"amount", 5}});
  ctx.Equal(first.Status, 201, "a reserve of 5 of research's 8 units must answer 201 with the reservation (%s); the status", first.Text());
  const auto got = nlohmann::json::parse(first.Text(), nullptr, false);
  const std::string reservation_id = got.is_object() ? got.value("reservation_id", "") : "";
  ctx.Assert(!reservation_id.empty(), "the 201 carries no reservation_id: %s. A release or a consume needs it", first.Text());
  ctx.Assert(got.value("team", "") == "research" && got.value("window", "") == kW && got.value("resource_class", "") == "gpu-a100" &&
                 got.value("amount", 0) == 5,
             "the 201 body is %s, expected the team, window, resource_class and amount of the grant", first.Text());
  auto record = ctx.Redis.HGetAll("reservation:research:" + reservation_id);
  ctx.Assert(record["amount"] == "5" && record["window"] == kW, "reservation:research:%s holds amount %q window %q: the grant must be recorded through ledger::reserve",
             reservation_id, record["amount"], record["window"]);
  ctx.Equal(ctx.Redis.HGet("quota:research:" + kW, "reserved").value_or(""), "5", "quota:research:%s reserved", kW);
  const auto second = reserveAs(c, "research", "research", {{"amount", 5}});
  ctx.Assert(second.Status == 409 && second.Text().find("quota_exhausted") != std::string::npos,
             "with 3 of research's 8 units left a reserve of 5 answered %d %s, expected 409 quota_exhausted: the same units went to two jobs", second.Status, second.Text());
  const auto third = reserveAs(c, "research", "research", {{"amount", 3}});
  ctx.Equal(third.Status, 201, "the last 3 units must still be granted (%s); the status", third.Text());
}
`,
  },
  hints: [
    'Reserve 5 of research’s 8 units twice: both answers say ok and Redis holds no reservation. A request with no `X-Team-Id`, or naming another team in the path, gets the same ok.',
    'The handler compares the amount with the limit, not with what the window has left, and writes nothing, so every request is checked against an empty ledger. It never reads the header and validates no field.',
    'Read `X-Team-Id` first (401 missing, 403 mismatch), 400 on `WINDOW_RE`, `RESOURCE_CLASSES` and 1..`MAX_RESERVE_AMOUNT`, then call `ledger.reserve` once: nothing back is 409, an id is 201 with the reservation.',
  ],
  debrief: `A grant has to be a record, not an answer. \`ledger.reserve\` compares and takes in one Lua script, so no second request can land between the check and the write, and the id it returns is what a release or a consume names later. The team check comes before validation so a caller learns nothing about another team's windows from a 400, and the class whitelist is what lets the broker refuse a pool it does not run. Production brokers take the team from a verified token rather than a header any client can set, return the units left in the window with the grant, and accept an idempotency key so a retried reserve does not take twice.`,
};
