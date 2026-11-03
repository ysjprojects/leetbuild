import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/quotas/{team}: a read that matches the enforcement',
  concept: 'http',
  file: 'read',
  focus: ['client', 'broker', 'redis'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/quotas/{team}?window=…\`: it \`HGETALL\`s
\`quota:aggregate:{team}\`, a rollup a nightly job writes, and answers \`{team, window, quota,
reserved, consumed, available}\` with \`available = quota - reserved\`, for whatever team the path
names. It serves the demo and hides four flaws.

**Failure mode the checks target.** A scheduler reads \`available: 5\`, asks for five, and gets a
409: the rollup misses everything reserved since last night, it sums every window, and the formula
ignores what running jobs consumed. Any caller can read any team's numbers, and a read without a
window answers anyway.

- The caller's team is the \`X-Team-Id\` header: missing is **401**, a path team that differs is
  **403**.
- \`window\` is required and matches \`WINDOW_RE\` (\`YYYY-MM-DDTHH:MMZ\`), else **400**.
- Read \`reserved\` and \`consumed\` from \`window_key(team, window)\` (\`quota:{team}:{window}\`, provided
  in \`quota.ledger\`), the hash the reserve script writes; \`quota\` is \`limit_of(team)\`.
- \`available = quota - reserved - consumed\`, floored at 0: the units a reserve made now would be
  granted.`,
  sequence: {
    participants: ['Scheduler', 'Quota Broker', 'Redis'],
    messages: [
      {
        from: 'Scheduler',
        to: 'Quota Broker',
        label: 'GET /v1/quotas/research?window=2026-11-02T14:00Z · X-Team-Id',
        kind: 'sync',
      },
      {from: 'Quota Broker', to: 'Quota Broker', label: '401 no team · 403 another team · 400 window', kind: 'sync'},
      {
        from: 'Quota Broker',
        to: 'Redis',
        label: 'HGETALL quota:research:2026-11-02T14:00Z · HGET quota:limits research',
        kind: 'sync',
      },
      {from: 'Redis', to: 'Quota Broker', label: 'reserved 3 · consumed 2 · limit 8', kind: 'reply'},
      {
        from: 'Quota Broker',
        to: 'Scheduler',
        label: '200 {quota 8, reserved 3, consumed 2, available 3}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Registers GET /v1/quotas/{team}',
      detail: 'A read of the caller’s own team with a window answers 200 with the team.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/quotas\/\{team\}["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/quotas\/:team['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/quotas\/\{team\}"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"quotas"\s*\/\s*Segment\s*\)/]},
        cpp: {all: [/svr\.Get\([^\n]*\/v1\/quotas\//]},
      },
    },
    {
      id: 'team-scope',
      title: 'Scopes the read to the X-Team-Id caller',
      detail:
        'A read without `X-Team-Id` is **401** and one of another team is **403**; the starter answers any caller with any team’s numbers.',
      match: {
        python: {all: [/x-team-id/i, /\b401\b/, /\b403\b/]},
        typescript: {all: [/x-team-id/i, /code\(\s*401\s*\)/, /code\(\s*403\s*\)/]},
        go: {all: [/X-Team-Id/i, /StatusUnauthorized|\b401\b/, /StatusForbidden|\b403\b/]},
        scala: {all: [/X-Team-Id/i, /Unauthorized/, /Forbidden/]},
        cpp: {all: [/X-Team-Id/i, /\b401\b/, /\b403\b/]},
      },
    },
    {
      id: 'window-validated',
      title: 'Requires a valid window',
      detail:
        'A read without `window`, or with one that does not match `WINDOW_RE`, is **400**: capacity is per window, so there is no answer without one. The starter answers anyway.',
      match: {
        python: {all: [/WINDOW_RE/, /\b400\b/]},
        typescript: {all: [/WINDOW_RE/, /code\(\s*400\s*\)/]},
        go: {all: [/windowPattern/, /StatusBadRequest|\b400\b/]},
        scala: {all: [/WindowPattern/, /BadRequest/]},
        cpp: {all: [/kWindowRe/, /\b400\b/]},
      },
    },
    {
      id: 'same-ledger',
      title: 'Reads the ledger the reserve path writes',
      detail:
        'The numbers come from `quota:{team}:{window}`: units reserved since the nightly rollup show up at once, and another window shows its own. The starter reads `quota:aggregate:{team}`.',
      match: {
        python: {all: [/window_key\(\s*team\s*,\s*window\s*\)|quota:\{team\}:\{window\}/], none: [/quota:aggregate/]},
        typescript: {
          all: [/windowKey\(\s*team\s*,\s*window\s*\)|quota:\$\{team\}:\$\{window\}/],
          none: [/quota:aggregate/],
        },
        go: {all: [/ledger\.WindowKey\(\s*team\s*,\s*window\s*\)/], none: [/quota:aggregate/]},
        scala: {all: [/Ledger\.windowKey\(\s*team\s*,\s*window\s*\)/], none: [/quota:aggregate/]},
        cpp: {all: [/ledger::windowKey\(\s*team\s*,\s*window\s*\)/], none: [/quota:aggregate/]},
      },
    },
    {
      id: 'available-formula',
      title: 'Reports what a reserve would be granted',
      detail:
        '`available` is `quota - reserved - consumed`, floored at 0: a reserve of exactly that many units is granted, and an overdrawn window reports 0, not a negative. The starter subtracts only `reserved`.',
      match: {
        python: {all: [/reserved\s*-\s*consumed/, /\bmax\(/]},
        typescript: {all: [/reserved\s*-\s*consumed/, /Math\.max\(/]},
        go: {all: [/reserved\s*-\s*consumed/, /available\s*<\s*0/]},
        scala: {all: [/reserved\s*-\s*consumed/, /math\.max\(|\.max\(/]},
        cpp: {all: [/reserved\s*-\s*consumed/, /std::max/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, Request

from quota.ledger import limit_of, window_key  # provided

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/quotas/{team}")
def read_quota(team: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    totals = r.hgetall(f"quota:aggregate:{team}")  # the nightly rollup
    quota = int(totals.get("limit") or limit_of(team))
    reserved = int(totals.get("reserved") or 0)
    consumed = int(totals.get("consumed") or 0)
    return {
        "team": team,
        "window": request.query_params.get("window"),
        "quota": quota,
        "reserved": reserved,
        "consumed": consumed,
        "available": quota - reserved,
    }
`,
      solution: `import re

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from quota.ledger import limit_of, window_key  # provided

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$")


@app.get("/v1/quotas/{team}")
def read_quota(team: str, request: Request) -> JSONResponse:
    caller = request.headers.get("x-team-id", "")
    if not caller:
        return JSONResponse({"error": "missing X-Team-Id"}, status_code=401)
    if caller != team:
        return JSONResponse({"error": "another team's quota"}, status_code=403)
    window = request.query_params.get("window", "")
    if not WINDOW_RE.match(window):
        return JSONResponse({"error": "window is required as YYYY-MM-DDTHH:MMZ"}, status_code=400)
    # The hash the reserve script writes, so the read and the enforcement cannot disagree.
    fields = r.hgetall(window_key(team, window))
    quota = limit_of(team)
    reserved = int(fields.get("reserved") or 0)
    consumed = int(fields.get("consumed") or 0)
    available = max(0, quota - reserved - consumed)
    return JSONResponse(
        {"team": team, "window": window, "quota": quota, "reserved": reserved, "consumed": consumed, "available": available}
    )
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {limitOf, windowKey} from 'quota/ledger';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/quotas/:team', async request => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {team} = request.params as {team: string};
  const {window} = request.query as {window?: string};
  const totals = await redis.hgetall(\`quota:aggregate:\${team}\`); // the nightly rollup
  const quota = totals.limit ? Number(totals.limit) : await limitOf(team);
  const reserved = Number(totals.reserved ?? 0);
  const consumed = Number(totals.consumed ?? 0);
  return {team, window: window ?? null, quota, reserved, consumed, available: quota - reserved};
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {limitOf, windowKey} from 'quota/ledger';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const WINDOW_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$/;

app.get('/v1/quotas/:team', async (request, reply) => {
  const {team} = request.params as {team: string};
  const caller = request.headers['x-team-id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'missing X-Team-Id'});
  if (caller !== team) return reply.code(403).send({error: "another team's quota"});
  const {window} = request.query as {window?: string};
  if (typeof window !== 'string' || !WINDOW_RE.test(window)) {
    return reply.code(400).send({error: 'window is required as YYYY-MM-DDTHH:MMZ'});
  }
  // The hash the reserve script writes, so the read and the enforcement cannot disagree.
  const fields = await redis.hgetall(windowKey(team, window));
  const quota = await limitOf(team);
  const reserved = Number(fields.reserved ?? 0);
  const consumed = Number(fields.consumed ?? 0);
  const available = Math.max(0, quota - reserved - consumed);
  return {team, window, quota, reserved, consumed, available};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/redis/go-redis/v9"

	"quota/ledger" // ledger.LimitOf, WindowKey
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func number(fields map[string]string, name string) int64 {
	n, _ := strconv.ParseInt(fields[name], 10, 64)
	return n
}

func readQuota(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	team := r.PathValue("team")
	totals, err := rdb.HGetAll(r.Context(), "quota:aggregate:"+team).Result() // the nightly rollup
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	quota := number(totals, "limit")
	if quota == 0 {
		quota = ledger.LimitOf(r.Context(), team)
	}
	reserved := number(totals, "reserved")
	consumed := number(totals, "consumed")
	writeJSON(rw, http.StatusOK, map[string]any{
		"team": team, "window": r.URL.Query().Get("window"), "quota": quota,
		"reserved": reserved, "consumed": consumed, "available": quota - reserved,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/quotas/{team}", readQuota)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strconv"

	"github.com/redis/go-redis/v9"

	"quota/ledger" // ledger.LimitOf, WindowKey
)

var windowPattern = regexp.MustCompile(\`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$\`)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func number(fields map[string]string, name string) int64 {
	n, _ := strconv.ParseInt(fields[name], 10, 64)
	return n
}

func readQuota(rw http.ResponseWriter, r *http.Request) {
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
	window := r.URL.Query().Get("window")
	if !windowPattern.MatchString(window) {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "window is required as YYYY-MM-DDTHH:MMZ"})
		return
	}
	// The hash the reserve script writes, so the read and the enforcement cannot disagree.
	fields, err := rdb.HGetAll(r.Context(), ledger.WindowKey(team, window)).Result()
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	quota := ledger.LimitOf(r.Context(), team)
	reserved := number(fields, "reserved")
	consumed := number(fields, "consumed")
	available := quota - reserved - consumed
	if available < 0 {
		available = 0
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"team": team, "window": window, "quota": quota,
		"reserved": reserved, "consumed": consumed, "available": available,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/quotas/{team}", readQuota)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import quota.Ledger // Ledger.limitOf, windowKey

object Read {
  val jedis = new JedisPooled("redis", 6379)

  val route: Route =
    path("v1" / "quotas" / Segment) { team =>
      get {
        parameter("window".optional) { window =>
          // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
          val totals = jedis.hgetAll(s"quota:aggregate:$team").asScala // the nightly rollup
          val quota = totals.get("limit").map(_.toLong).getOrElse(Ledger.limitOf(team))
          val reserved = totals.get("reserved").map(_.toLong).getOrElse(0L)
          val consumed = totals.get("consumed").map(_.toLong).getOrElse(0L)
          val body = JsObject(
            "team" -> JsString(team),
            "window" -> window.map(JsString(_)).getOrElse(JsNull),
            "quota" -> JsNumber(quota),
            "reserved" -> JsNumber(reserved),
            "consumed" -> JsNumber(consumed),
            "available" -> JsNumber(quota - reserved)
          )
          complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
        }
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCode, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import quota.Ledger // Ledger.limitOf, windowKey

object Read {
  val jedis = new JedisPooled("redis", 6379)

  val WindowPattern = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$".r

  private def json(status: StatusCode, body: JsObject): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint))

  private def error(status: StatusCode, message: String): HttpResponse = json(status, JsObject("error" -> JsString(message)))

  val route: Route =
    path("v1" / "quotas" / Segment) { team =>
      get {
        optionalHeaderValueByName("X-Team-Id") { caller =>
          parameter("window".optional) { windowParam =>
            val window = windowParam.getOrElse("")
            if (caller.forall(_.isEmpty)) complete(error(StatusCodes.Unauthorized, "missing X-Team-Id"))
            else if (!caller.contains(team)) complete(error(StatusCodes.Forbidden, "another team's quota"))
            else if (WindowPattern.findFirstIn(window).isEmpty) complete(error(StatusCodes.BadRequest, "window is required as YYYY-MM-DDTHH:MMZ"))
            else {
              // The hash the reserve script writes, so the read and the enforcement cannot disagree.
              val fields = jedis.hgetAll(Ledger.windowKey(team, window)).asScala
              val quota = Ledger.limitOf(team)
              val reserved = fields.get("reserved").map(_.toLong).getOrElse(0L)
              val consumed = fields.get("consumed").map(_.toLong).getOrElse(0L)
              val available = math.max(0L, quota - reserved - consumed)
              complete(
                json(
                  StatusCodes.OK,
                  JsObject(
                    "team" -> JsString(team),
                    "window" -> JsString(window),
                    "quota" -> JsNumber(quota),
                    "reserved" -> JsNumber(reserved),
                    "consumed" -> JsNumber(consumed),
                    "available" -> JsNumber(available)
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
#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <unordered_map>

#include "quota/ledger.h"  // ledger::limitOf, windowKey

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

long long number(const std::unordered_map<std::string, std::string>& fields, const std::string& name) {
  const auto it = fields.find(name);
  return it == fields.end() || it->second.empty() ? 0 : std::stoll(it->second);
}

void read_quota(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string team = req.matches[1];
  std::unordered_map<std::string, std::string> totals;
  redis.hgetall("quota:aggregate:" + team, std::inserter(totals, totals.begin()));  // the nightly rollup
  const long long quota = totals.count("limit") ? number(totals, "limit") : ledger::limitOf(team);
  const long long reserved = number(totals, "reserved");
  const long long consumed = number(totals, "consumed");
  res.set_content(json{{"team", team},
                       {"window", req.get_param_value("window")},
                       {"quota", quota},
                       {"reserved", reserved},
                       {"consumed", consumed},
                       {"available", quota - reserved}}
                      .dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/quotas/([\\w-]+))", read_quota); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <iterator>
#include <regex>
#include <string>
#include <unordered_map>

#include "quota/ledger.h"  // ledger::limitOf, windowKey

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

const std::regex kWindowRe("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}Z$");

long long number(const std::unordered_map<std::string, std::string>& fields, const std::string& name) {
  const auto it = fields.find(name);
  return it == fields.end() || it->second.empty() ? 0 : std::stoll(it->second);
}

void fail(httplib::Response& res, int status, const std::string& message) {
  res.status = status;
  res.set_content(json{{"error", message}}.dump(), "application/json");
}

void read_quota(const httplib::Request& req, httplib::Response& res) {
  const std::string team = req.matches[1];
  const std::string caller = req.get_header_value("X-Team-Id");
  if (caller.empty()) return fail(res, 401, "missing X-Team-Id");
  if (caller != team) return fail(res, 403, "another team's quota");
  const std::string window = req.get_param_value("window");
  if (!std::regex_match(window, kWindowRe)) return fail(res, 400, "window is required as YYYY-MM-DDTHH:MMZ");
  // The hash the reserve script writes, so the read and the enforcement cannot disagree.
  std::unordered_map<std::string, std::string> fields;
  redis.hgetall(ledger::windowKey(team, window), std::inserter(fields, fields.begin()));
  const long long quota = ledger::limitOf(team);
  const long long reserved = number(fields, "reserved");
  const long long consumed = number(fields, "consumed");
  const long long available = std::max(0LL, quota - reserved - consumed);
  res.set_content(json{{"team", team},
                       {"window", window},
                       {"quota", quota},
                       {"reserved", reserved},
                       {"consumed", consumed},
                       {"available", available}}
                      .dump(),
                  "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/quotas/([\\w-]+))", read_quota); }
`,
    },
  },
  harness: {
    python: `from quota import ledger

W = "2026-11-02T14:00Z"
W2 = "2026-11-02T15:00Z"


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def _read(c, team="research", caller="research", window=W):
    headers = {} if caller is None else {"X-Team-Id": caller}
    params = {} if window is None else {"window": window}
    return await c.get(f"/v1/quotas/{team}", headers=headers, params=params)


def _rollup(ctx, limit, reserved, consumed):
    """What the nightly job last wrote."""
    ctx.redis.hset("quota:aggregate:research", mapping={"limit": limit, "reserved": reserved, "consumed": consumed})


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await _read(c)
    assert r.status_code == 200, f"GET /v1/quotas/research?window={W} answered {r.status_code}: {r.text}"
    assert r.json().get("team") == "research", f"the read answered {r.json()}, expected team research"


async def check_team_scope(ctx):
    async with _api(ctx) as c:
        anonymous = await _read(c, caller=None)
        assert anonymous.status_code == 401, f"a read without X-Team-Id answered {anonymous.status_code}, expected 401"
        foreign = await _read(c, team="vision", caller="research")
        assert foreign.status_code == 403, f"team research reading /v1/quotas/vision answered {foreign.status_code} {foreign.text}, expected 403: another team's usage is not research's to read"
        own = await _read(c)
    assert own.status_code == 200, f"research reading its own quota answered {own.status_code}: {own.text}"


async def check_window_validated(ctx):
    async with _api(ctx) as c:
        missing = await _read(c, window=None)
        assert missing.status_code == 400, f"a read without a window answered {missing.status_code} {missing.text}, expected 400: capacity is per window"
        for window in ("tomorrow", "2026-11-02"):
            r = await _read(c, window=window)
            assert r.status_code == 400, f"a read for window {window!r} answered {r.status_code}, expected 400"
        r = await _read(c)
    assert r.status_code == 200, f"a read for window {W} answered {r.status_code}: {r.text}"


async def check_same_ledger(ctx):
    _rollup(ctx, 8, 0, 0)
    assert ledger.reserve("research", W, "gpu-a100", 3), "the ledger refused 3 units"
    async with _api(ctx) as c:
        now = (await _read(c)).json()
        other = (await _read(c, window=W2)).json()
    assert now.get("reserved") == 3, f"after 3 units were reserved at 14:00 the read reports reserved {now.get('reserved')} ({now}): it must read quota:research:{W}, the hash the reserve script writes, not last night's rollup"
    assert other.get("reserved") == 0 and other.get("available") == 8, f"the 15:00 window reports {other}, expected nothing reserved and 8 available: capacity is per window"


async def check_available_formula(ctx):
    assert ledger.reserve("research", W, "gpu-a100", 3), "the ledger refused 3 units"
    running = ledger.reserve("research", W, "gpu-a100", 2)
    assert running and ledger.consume("research", running), "the ledger refused to reserve and consume 2 units"
    _rollup(ctx, 8, 3, 2)  # the rollup is current: only the formula is under test
    async with _api(ctx) as c:
        body = (await _read(c)).json()
        assert body.get("available") == 3, f"with 8 units, 3 reserved and 2 consumed the read reports available {body.get('available')} ({body}), expected 3: a running job's units are not free"
        granted = ledger.reserve("research", W, "gpu-a100", body["available"])
        assert granted, "a reserve of the reported available units was refused"
        ledger.release("research", granted)
        ctx.redis.hset("quota:limits", "research", 4)  # the team's limit was cut below what it holds
        _rollup(ctx, 4, 3, 2)
        cut = (await _read(c)).json()
    assert cut.get("available") == 0, f"with the limit cut to 4 while 5 units are held the read reports available {cut.get('available')}, expected 0: available is floored at 0"
`,
    typescript: `const W = '2026-11-02T14:00Z';
const W2 = '2026-11-02T15:00Z';

function api(ctx) {
  return {c: ctx.client(ctx.load('read').app), ledger: ctx.load('/support/quota/ledger.ts')};
}

function read(c, team = 'research', caller: string | null = 'research', window: string | null = W) {
  const headers = caller === null ? {} : {'X-Team-Id': caller};
  const query = window === null ? '' : \`?window=\${encodeURIComponent(window)}\`;
  return c.get(\`/v1/quotas/\${team}\${query}\`, {headers});
}

/** What the nightly job last wrote. */
const rollup = (ctx, limit: number, reserved: number, consumed: number): void => {
  ctx.redis.hset('quota:aggregate:research', 'limit', limit, 'reserved', reserved, 'consumed', consumed);
};

export async function check_route(ctx) {
  const {c} = api(ctx);
  const r = await read(c);
  assert.equal(r.status, 200, \`GET /v1/quotas/research?window=\${W} answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().team, 'research', \`the read answered \${r.text}, expected team research\`);
}

export async function check_team_scope(ctx) {
  const {c} = api(ctx);
  const anonymous = await read(c, 'research', null);
  assert.equal(anonymous.status, 401, \`a read without X-Team-Id answered \${anonymous.status}, expected 401\`);
  const foreign = await read(c, 'vision', 'research');
  assert.equal(foreign.status, 403, \`team research reading /v1/quotas/vision answered \${foreign.status} \${foreign.text}, expected 403: another team's usage is not research's to read\`);
  const own = await read(c);
  assert.equal(own.status, 200, \`research reading its own quota answered \${own.status}: \${own.text}\`);
}

export async function check_window_validated(ctx) {
  const {c} = api(ctx);
  const missing = await read(c, 'research', 'research', null);
  assert.equal(missing.status, 400, \`a read without a window answered \${missing.status} \${missing.text}, expected 400: capacity is per window\`);
  for (const window of ['tomorrow', '2026-11-02']) {
    const r = await read(c, 'research', 'research', window);
    assert.equal(r.status, 400, \`a read for window "\${window}" answered \${r.status}, expected 400\`);
  }
  const r = await read(c);
  assert.equal(r.status, 200, \`a read for window \${W} answered \${r.status}: \${r.text}\`);
}

export async function check_same_ledger(ctx) {
  const {c, ledger} = api(ctx);
  rollup(ctx, 8, 0, 0);
  assert(await ledger.reserve('research', W, 'gpu-a100', 3), 'the ledger refused 3 units');
  const now = (await read(c)).json();
  const other = (await read(c, 'research', 'research', W2)).json();
  assert.equal(now.reserved, 3, \`after 3 units were reserved at 14:00 the read reports reserved \${now.reserved} (\${JSON.stringify(now)}): it must read quota:research:\${W}, the hash the reserve script writes, not last night's rollup\`);
  assert(other.reserved === 0 && other.available === 8, \`the 15:00 window reports \${JSON.stringify(other)}, expected nothing reserved and 8 available: capacity is per window\`);
}

export async function check_available_formula(ctx) {
  const {c, ledger} = api(ctx);
  assert(await ledger.reserve('research', W, 'gpu-a100', 3), 'the ledger refused 3 units');
  const running = await ledger.reserve('research', W, 'gpu-a100', 2);
  assert(running && (await ledger.consume('research', running)), 'the ledger refused to reserve and consume 2 units');
  rollup(ctx, 8, 3, 2); // the rollup is current: only the formula is under test
  const body = (await read(c)).json();
  assert.equal(body.available, 3, \`with 8 units, 3 reserved and 2 consumed the read reports available \${body.available} (\${JSON.stringify(body)}), expected 3: a running job's units are not free\`);
  const granted = await ledger.reserve('research', W, 'gpu-a100', body.available);
  assert(granted, 'a reserve of the reported available units was refused');
  await ledger.release('research', granted);
  ctx.redis.hset('quota:limits', 'research', 4); // the team's limit was cut below what it holds
  rollup(ctx, 4, 3, 2);
  const cut = (await read(c)).json();
  assert.equal(cut.available, 0, \`with the limit cut to 4 while 5 units are held the read reports available \${cut.available}, expected 0: available is floored at 0\`);
}
`,
    go: `package main

import (
	"context"
	"net/http"

	"quota/ledger"

	"leetbuild/harness"
)

const (
	readW  = "2026-11-02T14:00Z"
	readW2 = "2026-11-02T15:00Z"
)

var readBg = context.Background()

type quotaView struct {
	Team      string \`json:"team"\`
	Quota     int64  \`json:"quota"\`
	Reserved  int64  \`json:"reserved"\`
	Consumed  int64  \`json:"consumed"\`
	Available int64  \`json:"available"\`
}

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func readAs(c *harness.HTTP, team, caller, window string) *harness.Response {
	path := "/v1/quotas/" + team
	if window != "" {
		path += "?window=" + window
	}
	if caller == "" {
		return c.Get(path)
	}
	return c.Get(path, "X-Team-Id", caller)
}

func view(r *harness.Response) quotaView {
	var v quotaView
	r.Decode(&v)
	return v
}

// rollup is what the nightly job last wrote.
func rollup(ctx *harness.Ctx, limit, reserved, consumed int) {
	ctx.Redis.Do("HSET", "quota:aggregate:research", "limit", limit, "reserved", reserved, "consumed", consumed)
}

func CheckRoute(ctx *harness.Ctx) {
	r := readAs(api(ctx), "research", "research", readW)
	ctx.Equal(r.Status, 200, "GET /v1/quotas/research?window=%s (%s); the status", readW, r.Text())
	ctx.Equal(view(r).Team, "research", "the read's team (%s)", r.Text())
}

func CheckTeamScope(ctx *harness.Ctx) {
	c := api(ctx)
	ctx.Equal(readAs(c, "research", "", readW).Status, 401, "a read without X-Team-Id; the status")
	foreign := readAs(c, "vision", "research", readW)
	ctx.Equal(foreign.Status, 403, "team research reading /v1/quotas/vision (another team's usage is not research's to read, %s); the status", foreign.Text())
	own := readAs(c, "research", "research", readW)
	ctx.Equal(own.Status, 200, "research reading its own quota (%s); the status", own.Text())
}

func CheckWindowValidated(ctx *harness.Ctx) {
	c := api(ctx)
	missing := readAs(c, "research", "research", "")
	ctx.Equal(missing.Status, 400, "a read without a window (capacity is per window, %s); the status", missing.Text())
	for _, window := range []string{"tomorrow", "2026-11-02"} {
		ctx.Equal(readAs(c, "research", "research", window).Status, 400, "a read for window %q; the status", window)
	}
	r := readAs(c, "research", "research", readW)
	ctx.Equal(r.Status, 200, "a read for window %s (%s); the status", readW, r.Text())
}

func CheckSameLedger(ctx *harness.Ctx) {
	rollup(ctx, 8, 0, 0)
	id, err := ledger.Reserve(readBg, "research", readW, "gpu-a100", 3, "")
	ctx.Assert(err == nil && id != "", "the ledger refused 3 units: %v", err)
	c := api(ctx)
	now := readAs(c, "research", "research", readW)
	other := readAs(c, "research", "research", readW2)
	ctx.Equal(view(now).Reserved, int64(3), "after 3 units were reserved at 14:00 the read must report them (read quota:research:%s, the hash the reserve script writes, not last night's rollup: %s); reserved", readW, now.Text())
	ctx.Assert(view(other).Reserved == 0 && view(other).Available == 8, "the 15:00 window reports %s, expected nothing reserved and 8 available: capacity is per window", other.Text())
}

func CheckAvailableFormula(ctx *harness.Ctx) {
	id, err := ledger.Reserve(readBg, "research", readW, "gpu-a100", 3, "")
	ctx.Assert(err == nil && id != "", "the ledger refused 3 units: %v", err)
	running, _ := ledger.Reserve(readBg, "research", readW, "gpu-a100", 2, "")
	consumed, _ := ledger.Consume(readBg, "research", running)
	ctx.Assert(running != "" && consumed, "the ledger refused to reserve and consume 2 units")
	rollup(ctx, 8, 3, 2) // the rollup is current: only the formula is under test
	c := api(ctx)
	body := readAs(c, "research", "research", readW)
	ctx.Equal(view(body).Available, int64(3), "with 8 units, 3 reserved and 2 consumed (a running job's units are not free, %s); available", body.Text())
	granted, _ := ledger.Reserve(readBg, "research", readW, "gpu-a100", view(body).Available, "")
	ctx.Assert(granted != "", "a reserve of the reported available units was refused")
	ledger.Release(readBg, "research", granted)
	ctx.Redis.Do("HSET", "quota:limits", "research", 4) // the team's limit was cut below what it holds
	rollup(ctx, 4, 3, 2)
	cut := readAs(c, "research", "research", readW)
	ctx.Equal(view(cut).Available, int64(0), "with the limit cut to 4 while 5 units are held, available is floored at 0 (%s); available", cut.Text())
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

namespace {

const std::string kW = "2026-11-02T14:00Z";
const std::string kW2 = "2026-11-02T15:00Z";

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

harness::Response readAs(harness::HTTP& c, const std::string& team, const std::string& caller, const std::string& window) {
  const std::string path = "/v1/quotas/" + team + (window.empty() ? "" : "?window=" + window);
  if (caller.empty()) return c.Get(path);
  return c.Get(path, "X-Team-Id", caller);
}

long long field(const harness::Response& r, const std::string& name) {
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  return body.is_object() && body.contains(name) && body[name].is_number() ? body[name].get<long long>() : -999;
}

// What the nightly job last wrote.
void rollup(harness::Ctx& ctx, int limit, int reserved, int consumed) {
  ctx.Redis.Do("HSET", "quota:aggregate:research", "limit", limit, "reserved", reserved, "consumed", consumed);
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto r = readAs(c, "research", "research", kW);
  ctx.Equal(r.Status, 200, "GET /v1/quotas/research?window=%s (%s); the status", kW, r.Text());
  const auto body = nlohmann::json::parse(r.Text(), nullptr, false);
  ctx.Equal(body.is_object() ? body.value("team", "") : "", "research", "the read's team (%s)", r.Text());
}

void CheckTeamScope(harness::Ctx& ctx) {
  auto c = api(ctx);
  ctx.Equal(readAs(c, "research", "", kW).Status, 401, "a read without X-Team-Id; the status");
  const auto foreign = readAs(c, "vision", "research", kW);
  ctx.Equal(foreign.Status, 403, "team research reading /v1/quotas/vision (another team's usage is not research's to read, %s); the status", foreign.Text());
  const auto own = readAs(c, "research", "research", kW);
  ctx.Equal(own.Status, 200, "research reading its own quota (%s); the status", own.Text());
}

void CheckWindowValidated(harness::Ctx& ctx) {
  auto c = api(ctx);
  const auto missing = readAs(c, "research", "research", "");
  ctx.Equal(missing.Status, 400, "a read without a window (capacity is per window, %s); the status", missing.Text());
  for (const std::string window : {"tomorrow", "2026-11-02"}) {
    ctx.Equal(readAs(c, "research", "research", window).Status, 400, "a read for window %q; the status", window);
  }
  const auto r = readAs(c, "research", "research", kW);
  ctx.Equal(r.Status, 200, "a read for window %s (%s); the status", kW, r.Text());
}

void CheckSameLedger(harness::Ctx& ctx) {
  rollup(ctx, 8, 0, 0);
  ctx.Assert(ledger::reserve("research", kW, "gpu-a100", 3).has_value(), "the ledger refused 3 units");
  auto c = api(ctx);
  const auto now = readAs(c, "research", "research", kW);
  const auto other = readAs(c, "research", "research", kW2);
  ctx.Equal(field(now, "reserved"), 3, "after 3 units were reserved at 14:00 the read must report them (read quota:research:%s, the hash the reserve script writes, not last night's rollup: %s); reserved", kW, now.Text());
  ctx.Assert(field(other, "reserved") == 0 && field(other, "available") == 8, "the 15:00 window reports %s, expected nothing reserved and 8 available: capacity is per window", other.Text());
}

void CheckAvailableFormula(harness::Ctx& ctx) {
  ctx.Assert(ledger::reserve("research", kW, "gpu-a100", 3).has_value(), "the ledger refused 3 units");
  const auto running = ledger::reserve("research", kW, "gpu-a100", 2);
  ctx.Assert(running && ledger::consume("research", *running), "the ledger refused to reserve and consume 2 units");
  rollup(ctx, 8, 3, 2);  // the rollup is current: only the formula is under test
  auto c = api(ctx);
  const auto body = readAs(c, "research", "research", kW);
  ctx.Equal(field(body, "available"), 3, "with 8 units, 3 reserved and 2 consumed (a running job's units are not free, %s); available", body.Text());
  const auto granted = ledger::reserve("research", kW, "gpu-a100", field(body, "available"));
  ctx.Assert(granted.has_value(), "a reserve of the reported available units was refused");
  ledger::release("research", *granted);
  ctx.Redis.Do("HSET", "quota:limits", "research", 4);  // the team's limit was cut below what it holds
  rollup(ctx, 4, 3, 2);
  const auto cut = readAs(c, "research", "research", kW);
  ctx.Equal(field(cut, "available"), 0, "with the limit cut to 4 while 5 units are held, available is floored at 0 (%s); available", cut.Text());
}
`,
  },
  hints: [
    'Reserve 3 units, then read the window: `reserved` still says what it said last night. Consume 2 more and the read reports 5 available while a reserve of 5 is refused. Any team’s numbers come back to any caller.',
    'The handler reads a rollup that sums every window and only refreshes overnight, and its formula leaves out `consumed`. It never reads `X-Team-Id` or requires the window it echoes back.',
    'Check `X-Team-Id` (401, 403) and `WINDOW_RE` on the required `window` (400); `hgetall(window_key(team, window))`, `quota = limit_of(team)`, `available = max(0, quota - reserved - consumed)`.',
  ],
  debrief: `A read is only useful when it predicts the next write, so it has to read the same hash with the same formula the reserve script enforces; the nightly rollup is fine for a capacity report and wrong for a scheduler deciding what to ask for. The floor at 0 matters when a limit is cut below what a team already holds: a negative number invites a client to do arithmetic the broker will not honor. Team scoping and the required window come from the same rule as the reserve route: capacity belongs to a team and a window. Production brokers return the numbers with a version or timestamp so a client can tell a stale read, and let a scheduler reserve with a conditional amount instead of reading first.`,
};
