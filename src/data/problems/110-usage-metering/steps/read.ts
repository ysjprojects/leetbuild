import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/accounts/{id}/usage: a number that ties out',
  concept: 'http',
  file: 'read',
  focus: ['api', 'coverage', 'redis', 'store'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/accounts/{account}/usage\`: it reads
\`batch:usage:{account}\` from Redis and answers \`{"account", "units"}\` to whoever asks. It
compiles, serves the demo and hides four flaws.

**Failure mode the checks target.** The batch key is written by a nightly job, so the number is up to
a day stale and disagrees with the counters the limiter is enforcing right now; the response drops
the overage flag and the close id, so an account past its cap reads "fine" and nothing ties the
number to billing; and the caller is not compared to the account, so any authenticated client can
read any account's usage.

- The read returns the **current window's** units, the same \`usage:{account}:{window}\` counters the
  limiter and billing see, not a number from a nightly batch.
- The response carries the **cap**, the **overage** flag and the **last reconciled close id**, so a
  customer or an on-call engineer can tell a plan that is over from a plan that is merely close, and
  can tie the number to the billing close that confirmed it.
- The caller must be the account: the authenticated \`X-Account-Id\` is required (**401** when missing)
  and a mismatch with the path's account is **403**.
- The \`period\` in the response is the window bucket the number was read from, so the reader knows
  when it resets.`,
  sequence: {
    participants: ['Caller', 'Usage read API', 'Redis counters'],
    messages: [
      {from: 'Caller', to: 'Usage read API', label: 'GET /v1/accounts/{account}/usage · X-Account-Id', kind: 'sync'},
      {from: 'Usage read API', to: 'Usage read API', label: 'authorize caller == account', kind: 'sync'},
      {
        from: 'Usage read API',
        to: 'Redis counters',
        label: 'HGET usage:{acct}:{hour} · GET close:{acct}:{hour}',
        kind: 'sync',
      },
      {from: 'Redis counters', to: 'Usage read API', label: '{units, cap, overage} · close_id', kind: 'reply'},
      {from: 'Usage read API', to: 'Caller', label: '200 {period, units, cap, overage, close_id}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/accounts/{account}/usage',
      detail: 'Register the usage read on `GET /v1/accounts/{account}/usage`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/accounts\/\{account\}\/usage["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/accounts\/:account\/usage['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/accounts\/\{account\}\/usage"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"accounts"\s*\/\s*Segment\s*\/\s*"usage"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(\s*"\/v1\/accounts\/:account\/usage"/]},
      },
    },
    {
      id: 'window',
      title: 'Reads the current window',
      detail:
        'The number comes from the current `usage:{account}:{window}` key — the same counter the limiter sees — not a nightly batch. The starter reads `batch:usage:{account}`, which lags up to a day.',
      match: {
        python: {all: [/def window_key\(/, /WINDOW_SECONDS/]},
        typescript: {all: [/windowKey\(/, /WINDOW_SECONDS/]},
        go: {all: [/(windowKey|WindowKey)\(/, /windowSeconds/]},
        scala: {all: [/windowKey\(/, /WindowSeconds/]},
        cpp: {all: [/windowKey\(/, /kWindowSeconds/]},
      },
    },
    {
      id: 'overage',
      title: 'Reports the cap and the overage flag',
      detail:
        'The response carries the cap and the `overage` flag read from the window, so a plan past its cap cannot read "fine". The starter hides overage entirely.',
      match: {
        python: {all: [/overage/]},
        typescript: {all: [/overage/]},
        go: {all: [/[Oo]verage/]},
        scala: {all: [/overage/]},
        cpp: {all: [/overage/]},
      },
    },
    {
      id: 'close-id',
      title: 'Returns the last reconciled close id',
      detail:
        'The response names the last reconciled close id for the period, so the number can be tied to the billing close that confirmed it. The starter returns none.',
      match: {
        python: {all: [/close_id/, /"close:/]},
        typescript: {all: [/close_id:/, /close:/]},
        go: {all: [/close_id/, /"close:"/]},
        scala: {all: [/(close_id|closeId)/, /close:/]},
        cpp: {all: [/(close_id|closeId)/, /"close:"/]},
      },
    },
    {
      id: 'authz',
      title: 'Rejects a foreign account with 403',
      detail:
        'The authenticated `X-Account-Id` must equal the path account; a mismatch is **403** and a missing caller is **401**. The starter serves whatever account the path names to whoever asks.',
      match: {
        python: {all: [/\b403\b/, /X-Account-Id/]},
        typescript: {all: [/code\(\s*403\s*\)/, /x-account-id/]},
        go: {all: [/StatusForbidden/, /X-Account-Id/]},
        scala: {all: [/StatusCodes\.Forbidden/, /X-Account-Id/]},
        cpp: {all: [/\b403\b/, /X-Account-Id/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/accounts/{account}/usage")
def get_usage(account: str) -> JSONResponse:
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    units = int(r.get(f"batch:usage:{account}") or 0)
    return JSONResponse({"account": account, "units": units}, status_code=200)
`,
      solution: `import time

import redis
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

WINDOW_SECONDS = 3600


def window_key(account: str, window: int) -> str:
    return f"usage:{{{account}}}:{window}"


@app.get("/v1/accounts/{account}/usage")
def get_usage(
    account: str, caller: str | None = Header(default=None, alias="X-Account-Id")
) -> JSONResponse:
    if caller is None or caller == "":
        raise HTTPException(status_code=401, detail="missing X-Account-Id")
    if caller != account:
        raise HTTPException(status_code=403, detail="account not visible to caller")

    window = int(time.time()) // WINDOW_SECONDS
    key = window_key(account, window)
    units = int(r.hget(key, "units") or 0)
    cap = int(r.hget(key, "cap") or 0)
    overage = r.hget(key, "overage") is not None
    close_id = r.get(f"close:{account}:{window}")
    return JSONResponse(
        {
            "account": account,
            "period": window,
            "units": units,
            "cap": cap,
            "overage": overage,
            "close_id": close_id,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/accounts/:account/usage. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

app.get('/v1/accounts/:account/usage', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  const {account} = request.params as {account: string};
  const units = Number((await r.get(\`batch:usage:\${account}\`)) ?? 0);
  return reply.code(200).send({account, units});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/accounts/:account/usage: a number that ties out with the counters billing sees. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

const WINDOW_SECONDS = 3600;

const windowKey = (account: string, window: number): string => \`usage:{\${account}}:\${window}\`;

app.get('/v1/accounts/:account/usage', async (request, reply) => {
  const {account} = request.params as {account: string};
  const caller = request.headers['x-account-id'];
  if (typeof caller !== 'string' || caller === '')
    return reply.code(401).send({error: 'missing X-Account-Id'});
  if (caller !== account) return reply.code(403).send({error: 'account not visible to caller'});

  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  const key = windowKey(account, window);
  const [units, cap, overage] = await r.hmget(key, 'units', 'cap', 'overage');
  const closeId = await r.get(\`close:\${account}:\${window}\`);
  return reply.code(200).send({
    account: account,
    period: window,
    units: Number(units ?? 0),
    cap: Number(cap ?? 0),
    overage: overage === '1',
    close_id: closeId,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"net/http"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func getUsage(rw http.ResponseWriter, req *http.Request) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	account := req.PathValue("account")
	units, _ := rdb.Get(req.Context(), "batch:usage:"+account).Int64()
	writeJSON(rw, http.StatusOK, map[string]any{"account": account, "units": units})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/accounts/{account}/usage", getUsage)
	http.ListenAndServe(":8443", mux)
}
`,
      solution: `package main

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const windowSeconds = 3600

func windowKey(account string, window int64) string {
	return "usage:{" + account + "}:" + strconv.FormatInt(window, 10)
}

func getUsage(rw http.ResponseWriter, req *http.Request) {
	account := req.PathValue("account")
	caller := req.Header.Get("X-Account-Id")
	if caller == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Account-Id"})
		return
	}
	if caller != account {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "account not visible to caller"})
		return
	}
	window := time.Now().Unix() / windowSeconds
	key := windowKey(account, window)
	ctx := req.Context()
	values, err := rdb.HMGet(ctx, key, "units", "cap", "overage").Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	closeID, _ := rdb.Get(ctx, "close:"+account+":"+strconv.FormatInt(window, 10)).Result()
	writeJSON(rw, http.StatusOK, map[string]any{
		"account":  account,
		"period":   window,
		"units":    values[0],
		"cap":      values[1],
		"overage":  values[2] != nil,
		"close_id": closeID,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/accounts/{account}/usage", getUsage)
	http.ListenAndServe(":8443", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object Read {
  implicit val system: ActorSystem = ActorSystem("metering")

  val route: Route =
    path("v1" / "accounts" / Segment / "usage") { account =>
      get {
        // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
        val units = MeteringState.r.get(s"batch:usage:$account").toLongOption.getOrElse(0L)
        complete(StatusCodes.OK, s"""{"account":"$account","units":$units}""")
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object Read {
  implicit val system: ActorSystem = ActorSystem("metering")

  val WindowSeconds = 3600

  def windowKey(account: String, window: Long): String = s"usage:{$account}:$window"

  val route: Route =
    path("v1" / "accounts" / Segment / "usage") { account =>
      get {
        optionalHeaderValueByName("X-Account-Id") { callerOpt =>
          callerOpt match {
            case Some(caller) if caller.nonEmpty =>
              if (caller != account) {
                complete(StatusCodes.Forbidden, """{"error":"account not visible to caller"}""")
              } else {
                val window = System.currentTimeMillis() / 1000L / WindowSeconds
                val key = windowKey(account, window)
                val units = MeteringState.r.hget(key, "units").toLongOption.getOrElse(0L)
                val cap = MeteringState.r.hget(key, "cap").toLongOption.getOrElse(0L)
                val overage = MeteringState.r.hget(key, "overage") != null
                val closeId = MeteringState.r.get(s"close:$account:$window")
                complete(
                  StatusCodes.OK,
                  s"""{"account":"$account","period":$window,"units":$units,"cap":$cap,"overage":$overage,"close_id":"$closeId"}"""
                )
              }
            case _ =>
              complete(StatusCodes.Unauthorized, """{"error":"missing X-Account-Id"}""")
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

int main() {
  httplib::Server svr;

  svr.Get("/v1/accounts/:account/usage", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    const auto account = req.path_params.at("account");
    const auto units = std::stoll(redisGet("batch:usage:" + account));
    res.status = 200;
    res.set_content(json{{"account", account}, {"units", units}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>

using json = nlohmann::json;

constexpr long long kWindowSeconds = 3600;

std::string redisGet(const std::string& key);
std::string redisHGet(const std::string& key, const std::string& field);

std::string windowKey(const std::string& account, long long window) {
  return "usage:{" + account + "}:" + std::to_string(window);
}

int main() {
  httplib::Server svr;

  svr.Get("/v1/accounts/:account/usage", [](const httplib::Request& req, httplib::Response& res) {
    const auto account = req.path_params.at("account");
    const auto caller = req.get_header_value("X-Account-Id");
    if (caller.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Account-Id"})", "application/json");
      return;
    }
    if (caller != account) {
      res.status = 403;
      res.set_content(R"({"error":"account not visible to caller"})", "application/json");
      return;
    }
    const long long window =
        std::chrono::system_clock::now().time_since_epoch() / std::chrono::seconds(1) / kWindowSeconds;
    const auto key = windowKey(account, window);
    const auto units = redisHGet(key, "units");
    const auto cap = redisHGet(key, "cap");
    const bool overage = !redisHGet(key, "overage").empty();
    const auto close_id = redisGet("close:" + account + ":" + std::to_string(window));
    res.status = 200;
    res.set_content(
        json{{"account", account},
             {"period", window},
             {"units", units},
             {"cap", cap},
             {"overage", overage},
             {"close_id", close_id}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'A customer who was flagged over their cap ten minutes ago reads a number from yesterday with no cap state, and a client holding one account’s token can read every other account by changing the path.',
    'The handler takes the path account, does one `GET` on `batch:usage:{account}` and returns two fields. It reads no header, no window key, no overage flag and no close id.',
    'Require `X-Account-Id` (401 missing, 403 mismatch), read `window_key(account, now)` via `WINDOW_SECONDS`, and return units, cap, `overage`, `period` and the `close:{account}:{period}` close id.',
  ],
  debrief: `The read takes its number from the live window key because a read that disagrees with the
limiter is not a read of usage, it is a read of something else; the two paths have to share one
source. The cap state and the close id ride along for the same reason: the number alone cannot say
whether the account is over or whether billing has confirmed it, and those are the two questions a
caller has. Authorizing against the path turns an enumeration oracle into a tenant-scoped read. A
production read usually fronts the window key with a short cache that includes the bucket in its key,
so it stays cheap without going stale, and takes the caller identity from a signed token rather than
a bare header.`,
};
