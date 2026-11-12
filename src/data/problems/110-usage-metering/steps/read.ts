import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/accounts/{account}/usage: the number that ties out',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'api', 'redis', 'store'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/accounts/{account}/usage\`: it reads the string
\`batch:usage:{account}\` that a nightly job writes and answers \`{account, units}\` to any caller. It
serves the demo and hides four flaws.

**Failure mode the checks target.** The nightly number is up to a day old and disagrees with the
window billing will close. An account past its cap reads as fine because the cap and the overage flag
are missing, and nothing ties the number to the last billing close. Any caller can read any account.

- Read the current window: \`ledger.current_window()\` and \`ledger.read_window(account, window)\`
  (\`metering.ledger\`, provided), and answer its \`window\` and \`units\`.
- Answer the window's \`cap\` and \`overage\` (a boolean).
- Answer \`close_id\` from \`ledger.last_close(account)\`, or \`null\` when nothing has closed.
- \`X-Account-Id\` names the caller: missing is **401**; another account than the path's is **403**.`,
  sequence: {
    participants: ['Customer', 'usaged', 'Redis'],
    messages: [
      {from: 'Customer', to: 'usaged', label: 'GET /v1/accounts/acct_1/usage · X-Account-Id', kind: 'sync'},
      {from: 'usaged', to: 'usaged', label: 'missing → 401 · other account → 403', kind: 'sync'},
      {from: 'usaged', to: 'Redis', label: 'read_window(acct_1, current) · last_close(acct_1)', kind: 'sync'},
      {from: 'usaged', to: 'Customer', label: '200 {window, units, cap, overage, close_id}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/accounts/{account}/usage',
      detail:
        'Register the usage read on `GET /v1/accounts/{account}/usage`; the account reading itself gets **200** naming the account.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/accounts\/\{account\}\/usage["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/accounts\/:account\/usage['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/accounts\/\{account\}\/usage"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"accounts"\s*\/\s*Segment\s*\/\s*"usage"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/accounts\//]},
      },
    },
    {
      id: 'window',
      title: 'Reads the current window',
      detail:
        'The units come from `read_window`/`readWindow` on the current window, the hash the count writes and billing closes, and the answer names that window. The starter reads the nightly `batch:usage:{account}`.',
      match: {
        python: {all: [/ledger\.current_window\(/, /ledger\.read_window\(/], none: [/batch:usage/]},
        typescript: {all: [/currentWindow\(/, /readWindow\(/], none: [/batch:usage/]},
        go: {all: [/ledger\.CurrentWindow\(/, /ledger\.ReadWindow\(/], none: [/batch:usage/]},
        scala: {all: [/Ledger\.currentWindow\(/, /Ledger\.readWindow\(/], none: [/batch:usage/]},
        cpp: {all: [/ledger::currentWindow\(/, /ledger::readWindow\(/], none: [/batch:usage/]},
      },
    },
    {
      id: 'overage',
      title: 'Reports the cap and the overage flag',
      detail:
        "The answer carries the window's `cap` and `overage`, so an account past its plan cannot read as fine. The starter answers neither.",
      match: {
        python: {all: [/["']overage["']\s*:\s*totals\[["']overage["']\]/, /["']cap["']\s*:\s*totals\[["']cap["']\]/]},
        typescript: {all: [/overage:\s*totals\.overage/, /cap:\s*totals\.cap/]},
        go: {all: [/"overage":\s*totals\.Overage/, /"cap":\s*totals\.Cap/]},
        scala: {all: [/"overage"\s*->\s*JsBoolean\(totals\.overage\)/, /"cap"\s*->\s*JsNumber\(totals\.cap\)/]},
        cpp: {all: [/\{"overage",\s*totals\.overage\}/, /\{"cap",\s*totals\.cap\}/]},
      },
    },
    {
      id: 'close-id',
      title: 'Names the last close that tied out',
      detail:
        'The answer carries `close_id` from `last_close`/`lastClose` (null before the first close), so the number can be tied to the billing close that confirmed it. The starter answers none.',
      match: {
        python: {all: [/ledger\.last_close\(/, /["']close_id["']\s*:/]},
        typescript: {all: [/lastClose\(/, /close_id:/]},
        go: {all: [/ledger\.LastClose\(/, /"close_id":/]},
        scala: {all: [/Ledger\.lastClose\(/, /"close_id"\s*->/]},
        cpp: {all: [/ledger::lastClose\(/, /"close_id"/]},
      },
    },
    {
      id: 'authz',
      title: 'Serves an account to itself only',
      detail:
        'A missing `X-Account-Id` is **401** and one that names another account than the path is **403**. The starter serves whatever account the path names to whoever asks.',
      match: {
        python: {all: [/x-account-id/i, /\b401\b/, /\b403\b/]},
        typescript: {all: [/x-account-id/i, /\b401\b/, /\b403\b/]},
        go: {all: [/X-Account-Id/i, /StatusUnauthorized|\b401\b/, /StatusForbidden|\b403\b/]},
        scala: {all: [/X-Account-Id/i, /Unauthorized/, /Forbidden/]},
        cpp: {all: [/X-Account-Id/i, /\b401\b/, /\b403\b/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI, Request

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/accounts/{account}/usage")
def get_usage(account: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    units = int(r.get(f"batch:usage:{account}") or 0)
    return {"account": account, "units": units}
`,
      solution: `from fastapi import FastAPI, HTTPException, Request

from metering import ledger  # current_window, read_window, last_close

app = FastAPI()


@app.get("/v1/accounts/{account}/usage")
def get_usage(account: str, request: Request) -> dict:
    caller = request.headers.get("x-account-id", "")
    if not caller:
        raise HTTPException(status_code=401, detail="missing X-Account-Id")
    if caller != account:
        raise HTTPException(status_code=403, detail="an account reads only its own usage")
    # The window the count writes and billing closes, not a nightly copy of it.
    window = ledger.current_window()
    totals = ledger.read_window(account, window)
    close = ledger.last_close(account)
    return {
        "account": account,
        "window": window,
        "units": totals["units"],
        "cap": totals["cap"],
        "overage": totals["overage"],
        "close_id": close["close_id"] if close else None,
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/accounts/:account/usage', async request => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {account} = request.params as {account: string};
  const units = Number((await redis.get(\`batch:usage:\${account}\`)) ?? 0);
  return {account, units};
});
`,
      solution: `import Fastify from 'fastify';

import {currentWindow, lastClose, readWindow} from 'metering/ledger';

export const app = Fastify();

app.get('/v1/accounts/:account/usage', async (request, reply) => {
  const {account} = request.params as {account: string};
  const caller = request.headers['x-account-id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'missing X-Account-Id'});
  if (caller !== account) return reply.code(403).send({error: 'an account reads only its own usage'});
  // The window the count writes and billing closes, not a nightly copy of it.
  const window = currentWindow();
  const totals = await readWindow(account, window);
  const close = await lastClose(account);
  return {account, window, units: totals.units, cap: totals.cap, overage: totals.overage, close_id: close?.close_id ?? null};
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readUsage(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	account := r.PathValue("account")
	units, _ := rdb.Get(r.Context(), "batch:usage:"+account).Int64()
	writeJSON(rw, http.StatusOK, map[string]any{"account": account, "units": units})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/accounts/{account}/usage", readUsage)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"

	"metering/ledger" // ledger.CurrentWindow, ReadWindow, LastClose
)

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func readUsage(rw http.ResponseWriter, r *http.Request) {
	account := r.PathValue("account")
	caller := r.Header.Get("X-Account-Id")
	if caller == "" {
		http.Error(rw, "missing X-Account-Id", http.StatusUnauthorized)
		return
	}
	if caller != account {
		http.Error(rw, "an account reads only its own usage", http.StatusForbidden)
		return
	}
	// The window the count writes and billing closes, not a nightly copy of it.
	window := ledger.CurrentWindow()
	totals := ledger.ReadWindow(r.Context(), account, window)
	var closeID any
	if close := ledger.LastClose(r.Context(), account); close != nil {
		closeID = close.CloseID
	}
	writeJSON(rw, http.StatusOK, map[string]any{"account": account, "window": window, "units": totals.Units, "cap": totals.Cap, "overage": totals.Overage, "close_id": closeID})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/accounts/{account}/usage", readUsage)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

object Read {
  val jedis = new JedisPooled("redis", 6379)

  val route: Route =
    path("v1" / "accounts" / Segment / "usage") { account =>
      get {
        // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
        val units = Option(jedis.get(s"batch:usage:$account")).map(_.toLong).getOrElse(0L)
        val body = JsObject("account" -> JsString(account), "units" -> JsNumber(units))
        complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
      }
    }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import spray.json._

import metering.Ledger // Ledger.currentWindow, readWindow, lastClose

object Read {
  val route: Route =
    path("v1" / "accounts" / Segment / "usage") { account =>
      get {
        optionalHeaderValueByName("X-Account-Id") {
          case None | Some("") => complete(StatusCodes.Unauthorized -> "missing X-Account-Id")
          case Some(caller) if caller != account => complete(StatusCodes.Forbidden -> "an account reads only its own usage")
          case Some(_) =>
            // The window the count writes and billing closes, not a nightly copy of it.
            val window = Ledger.currentWindow()
            val totals = Ledger.readWindow(account, window)
            val body = JsObject(
              "account" -> JsString(account),
              "window" -> JsNumber(window),
              "units" -> JsNumber(totals.units),
              "cap" -> JsNumber(totals.cap),
              "overage" -> JsBoolean(totals.overage),
              "close_id" -> Ledger.lastClose(account).map(close => JsString(close.closeId)).getOrElse(JsNull))
            complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
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

#include <string>

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

void read_usage(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string account = req.matches[1];
  const auto batch = redis.get("batch:usage:" + account);
  const long long units = batch ? std::stoll(*batch) : 0;
  res.set_content(json{{"account", account}, {"units", units}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/accounts/([\\w-]+)/usage)", read_usage); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <string>

#include "metering/ledger.h"  // ledger::currentWindow, readWindow, lastClose

using json = nlohmann::json;

void read_usage(const httplib::Request& req, httplib::Response& res) {
  const std::string account = req.matches[1];
  const std::string caller = req.get_header_value("X-Account-Id");
  if (caller.empty()) {
    res.status = 401;
    res.set_content("missing X-Account-Id", "text/plain");
    return;
  }
  if (caller != account) {
    res.status = 403;
    res.set_content("an account reads only its own usage", "text/plain");
    return;
  }
  // The window the count writes and billing closes, not a nightly copy of it.
  const long long window = ledger::currentWindow();
  const ledger::Totals totals = ledger::readWindow(account, window);
  const auto close = ledger::lastClose(account);
  const json body = {{"account", account},       {"window", window},
                     {"units", totals.units},    {"cap", totals.cap},
                     {"overage", totals.overage}, {"close_id", close ? json(close->close_id) : json(nullptr)}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/accounts/([\\w-]+)/usage)", read_usage); }
`,
    },
  },
  harness: {
    python: `from metering import ledger
from metering.usage import apply_usage

PATH = "/v1/accounts/acct_1/usage"
ME = {"X-Account-Id": "acct_1"}


def _api(ctx):
    return ctx.client(ctx.load("read").app)


async def check_route(ctx):
    async with _api(ctx) as c:
        r = await c.get(PATH, headers=ME)
    assert r.status_code == 200, f"GET {PATH} answered {r.status_code}: {r.text}"
    assert r.json().get("account") == "acct_1", f"the read must name the account, got {r.json()}"


async def check_window(ctx):
    ctx.redis.set("batch:usage:acct_1", "40")  # last night's export
    ledger.record_usage({"request_id": "req_1", "account": "acct_1", "route": "/v1/generate", "units": 1200, "gateway": "gw-eu-1"})
    w = ledger.current_window()
    async with _api(ctx) as c:
        body = (await c.get(PATH, headers=ME)).json()
    assert body.get("units") == 1200, f"the window holds 1200 units and the read answered {body.get('units')}: read the current window, not the nightly batch"
    assert body.get("window") == w, f"the read must name the window it read ({w}), got {body.get('window')}"


async def check_overage(ctx):
    ledger.set_plan_cap("acct_1", 1000)
    apply_usage("acct_1", "req_1", "/v1/generate", 1200, "gw-eu-1")
    async with _api(ctx) as c:
        body = (await c.get(PATH, headers=ME)).json()
    assert body.get("cap") == 1000 and body.get("overage") is True, f"an account at 1200 units of a 1000-unit plan must read cap 1000 and overage true, got {body}"


async def check_close_id(ctx):
    w = ledger.current_window()
    async with _api(ctx) as c:
        before = (await c.get(PATH, headers=ME)).json()
        assert "close_id" in before and before["close_id"] is None, f"before any close the read must answer close_id null, got {before}"
        ledger.mark_closed("acct_1", w - 1, f"close:acct_1:{w - 1}", 900)
        after = (await c.get(PATH, headers=ME)).json()
    assert after.get("close_id") == f"close:acct_1:{w - 1}", f"after the last hour closed the read must name close:acct_1:{w - 1}, got {after}"


async def check_authz(ctx):
    ledger.record_usage({"request_id": "req_1", "account": "acct_1", "route": "/v1/generate", "units": 1200, "gateway": "gw-eu-1"})
    async with _api(ctx) as c:
        anonymous = await c.get(PATH)
        other = await c.get(PATH, headers={"X-Account-Id": "acct_2"})
        mine = await c.get(PATH, headers=ME)
    assert anonymous.status_code == 401, f"a read without X-Account-Id answered {anonymous.status_code}, expected 401"
    assert other.status_code == 403, f"acct_2 reading acct_1's usage answered {other.status_code}, expected 403"
    assert "1200" not in other.text, f"the 403 leaked acct_1's usage: {other.text}"
    assert mine.status_code == 200, f"acct_1 reading its own usage answered {mine.status_code}, expected 200"
`,
    typescript: `const PATH = '/v1/accounts/acct_1/usage';
const ME = {'X-Account-Id': 'acct_1'};

function api(ctx) {
  const m = ctx.load('read');
  return {c: ctx.client(m.app), ledger: ctx.load('/support/metering/ledger.ts'), usage: ctx.load('/support/metering/usage.ts')};
}

const REPORT = {request_id: 'req_1', account: 'acct_1', route: '/v1/generate', units: 1200, gateway: 'gw-eu-1'};

export async function check_route(ctx) {
  const {c} = api(ctx);
  const r = await c.get(PATH, {headers: ME});
  assert.equal(r.status, 200, \`GET \${PATH} answered \${r.status}: \${r.text}\`);
  assert.equal(r.json().account, 'acct_1', \`the read must name the account, got \${r.text}\`);
}

export async function check_window(ctx) {
  const {c, ledger} = api(ctx);
  ctx.redis.set('batch:usage:acct_1', '40'); // last night's export
  await ledger.recordUsage(REPORT);
  const w = ledger.currentWindow();
  const body = (await c.get(PATH, {headers: ME})).json();
  assert.equal(body.units, 1200, \`the window holds 1200 units and the read answered \${body.units}: read the current window, not the nightly batch\`);
  assert.equal(body.window, w, \`the read must name the window it read (\${w}), got \${body.window}\`);
}

export async function check_overage(ctx) {
  const {c, ledger, usage} = api(ctx);
  await ledger.setPlanCap('acct_1', 1000);
  await usage.applyUsage('acct_1', 'req_1', '/v1/generate', 1200, 'gw-eu-1');
  const body = (await c.get(PATH, {headers: ME})).json();
  assert(body.cap === 1000 && body.overage === true, \`an account at 1200 units of a 1000-unit plan must read cap 1000 and overage true, got \${JSON.stringify(body)}\`);
}

export async function check_close_id(ctx) {
  const {c, ledger} = api(ctx);
  const w = ledger.currentWindow();
  const before = (await c.get(PATH, {headers: ME})).json();
  assert('close_id' in before && before.close_id === null, \`before any close the read must answer close_id null, got \${JSON.stringify(before)}\`);
  await ledger.markClosed('acct_1', w - 1, \`close:acct_1:\${w - 1}\`, 900);
  const after = (await c.get(PATH, {headers: ME})).json();
  assert.equal(after.close_id, \`close:acct_1:\${w - 1}\`, \`after the last hour closed the read must name close:acct_1:\${w - 1}, got \${JSON.stringify(after)}\`);
}

export async function check_authz(ctx) {
  const {c, ledger} = api(ctx);
  await ledger.recordUsage(REPORT);
  const anonymous = await c.get(PATH);
  const other = await c.get(PATH, {headers: {'X-Account-Id': 'acct_2'}});
  const mine = await c.get(PATH, {headers: ME});
  assert.equal(anonymous.status, 401, \`a read without X-Account-Id answered \${anonymous.status}, expected 401\`);
  assert.equal(other.status, 403, \`acct_2 reading acct_1's usage answered \${other.status}, expected 403\`);
  assert(!other.text.includes('1200'), \`the 403 leaked acct_1's usage: \${other.text}\`);
  assert.equal(mine.status, 200, \`acct_1 reading its own usage answered \${mine.status}, expected 200\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"metering/ledger"
	"metering/usage"

	"leetbuild/harness"
)

const path = "/v1/accounts/acct_1/usage"

var readBg = context.Background()

func api(ctx *harness.Ctx) *harness.HTTP {
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

func seed() {
	ledger.RecordUsage(readBg, ledger.Record{RequestID: "req_1", Account: "acct_1", Route: "/v1/generate", Units: 1200, Gateway: "gw-eu-1"})
}

func read(ctx *harness.Ctx, c *harness.HTTP) map[string]any {
	r := c.Get(path, "X-Account-Id", "acct_1")
	ctx.Equal(r.Status, 200, "GET %s (%s)", path, r.Text())
	body, _ := r.JSON().(map[string]any)
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	ctx.Equal(read(ctx, api(ctx))["account"], "acct_1", "the read must name the account")
}

func CheckWindow(ctx *harness.Ctx) {
	ctx.Redis.Set("batch:usage:acct_1", "40") // last night's export
	seed()
	w := ledger.CurrentWindow()
	body := read(ctx, api(ctx))
	ctx.Assert(body["units"] == float64(1200), "the window holds 1200 units and the read answered %v: read the current window, not the nightly batch", body["units"])
	ctx.Assert(body["window"] == float64(w), "the read must name the window it read (%d), got %v", w, body["window"])
}

func CheckOverage(ctx *harness.Ctx) {
	ledger.SetPlanCap(readBg, "acct_1", 1000)
	_, err := usage.ApplyUsage(readBg, "acct_1", "req_1", "/v1/generate", 1200, "gw-eu-1")
	ctx.NoError(err, "seeding the window failed")
	body := read(ctx, api(ctx))
	ctx.Assert(body["cap"] == float64(1000) && body["overage"] == true, "an account at 1200 units of a 1000-unit plan must read cap 1000 and overage true, got %v", body)
}

func CheckCloseId(ctx *harness.Ctx) {
	c := api(ctx)
	w := ledger.CurrentWindow()
	before := read(ctx, c)
	value, present := before["close_id"]
	ctx.Assert(present && value == nil, "before any close the read must answer close_id null, got %v", before)
	want := fmt.Sprintf("close:acct_1:%d", w-1)
	ledger.MarkClosed(readBg, "acct_1", w-1, want, 900)
	ctx.Equal(read(ctx, c)["close_id"], want, "after the last hour closed, the read's close_id")
}

func CheckAuthz(ctx *harness.Ctx) {
	seed()
	c := api(ctx)
	anonymous := c.Get(path)
	other := c.Get(path, "X-Account-Id", "acct_2")
	mine := c.Get(path, "X-Account-Id", "acct_1")
	ctx.Equal(anonymous.Status, 401, "a read without X-Account-Id")
	ctx.Equal(other.Status, 403, "acct_2 reading acct_1's usage")
	ctx.Assert(!strings.Contains(other.Text(), "1200"), "the 403 leaked acct_1's usage: %s", other.Text())
	ctx.Equal(mine.Status, 200, "acct_1 reading its own usage")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <string>

#include "metering/ledger.h"
#include "metering/usage.h"

using json = nlohmann::json;

namespace {

const std::string kPath = "/v1/accounts/acct_1/usage";

harness::HTTP api(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  return ctx.HTTP(*svr);
}

void seed() {
  ledger::Record record;
  record.request_id = "req_1";
  record.account = "acct_1";
  record.route = "/v1/generate";
  record.units = 1200;
  record.gateway = "gw-eu-1";
  ledger::recordUsage(record);
}

json read(harness::Ctx& ctx, harness::HTTP& c) {
  const auto r = c.Get(kPath, "X-Account-Id", "acct_1");
  ctx.Equal(r.Status, 200, "GET %s (%s)", kPath, r.Text());
  try {
    return json::parse(r.Text());
  } catch (const std::exception&) {
    ctx.Fatalf("the read's body is not JSON: %s", r.Text());
  }
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = api(ctx);
  ctx.Equal(read(ctx, c).value("account", ""), "acct_1", "the read must name the account");
}

void CheckWindow(harness::Ctx& ctx) {
  ctx.Redis.Set("batch:usage:acct_1", "40");  // last night's export
  seed();
  const long long w = ledger::currentWindow();
  auto c = api(ctx);
  const json body = read(ctx, c);
  ctx.Assert(body.value("units", 0LL) == 1200, "the window holds 1200 units and the read answered %s: read the current window, not the nightly batch", body.dump());
  ctx.Assert(body.value("window", 0LL) == w, "the read must name the window it read (%d), got %s", w, body.dump());
}

void CheckOverage(harness::Ctx& ctx) {
  ledger::setPlanCap("acct_1", 1000);
  usage::applyUsage("acct_1", "req_1", "/v1/generate", 1200, "gw-eu-1");
  auto c = api(ctx);
  const json body = read(ctx, c);
  ctx.Assert(body.value("cap", 0LL) == 1000 && body.contains("overage") && body["overage"] == true, "an account at 1200 units of a 1000-unit plan must read cap 1000 and overage true, got %s", body.dump());
}

void CheckCloseId(harness::Ctx& ctx) {
  auto c = api(ctx);
  const long long w = ledger::currentWindow();
  const json before = read(ctx, c);
  ctx.Assert(before.contains("close_id") && before["close_id"].is_null(), "before any close the read must answer close_id null, got %s", before.dump());
  const std::string want = "close:acct_1:" + std::to_string(w - 1);
  ledger::markClosed("acct_1", w - 1, want, 900);
  const json after = read(ctx, c);
  ctx.Equal(after.contains("close_id") && after["close_id"].is_string() ? after["close_id"].get<std::string>() : std::string(), want, "after the last hour closed, the read's close_id");
}

void CheckAuthz(harness::Ctx& ctx) {
  seed();
  auto c = api(ctx);
  const auto anonymous = c.Get(kPath);
  const auto other = c.Get(kPath, "X-Account-Id", "acct_2");
  const auto mine = c.Get(kPath, "X-Account-Id", "acct_1");
  ctx.Equal(anonymous.Status, 401, "a read without X-Account-Id");
  ctx.Equal(other.Status, 403, "acct_2 reading acct_1's usage");
  ctx.Assert(other.Text().find("1200") == std::string::npos, "the 403 leaked acct_1's usage: %s", other.Text());
  ctx.Equal(mine.Status, 200, "acct_1 reading its own usage");
}
`,
  },
  hints: [
    "Report usage and read it back at once: the read still shows last night's number. Push the account past its cap: the read looks the same. Ask for acct_1's usage with acct_2's header: it answers.",
    'The handler reads `batch:usage:{account}`, a copy the nightly job writes, not the window hash the count updates; it answers two fields, and it never looks at `X-Account-Id`.',
    'Check `X-Account-Id` first (missing 401, other account 403), then answer `read_window(account, current_window())` as window, units, cap and overage, plus `last_close(account)["close_id"]` or null.',
  ],
  debrief: `The read is useful only if it agrees with what billing will close, so it reads the same window hash the count writes instead of a copy with its own schedule. Cap and overage turn the number into an answer a customer can act on, and the close id is what lets support tie a disputed invoice line to the close that produced it. The caller check is plain authorization: the path names a resource and the header names who asks, and they must match. Production systems take the caller from a verified token rather than a header a gateway sets, and serve a range of windows with each window's close status so a customer can reconcile a whole month.`,
};
