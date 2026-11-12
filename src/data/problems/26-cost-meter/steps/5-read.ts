import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/tenants/{tenant}/spend: the number the limiter enforces',
  concept: 'http',
  guides: ['honest-reads', 'request-boundaries'],
  file: 'read',
  focus: ['client', 'meter', 'redis', 'limiter'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/tenants/{tenant}/spend\`, the number the dashboard shows
beside the budget: it lists every \`meter:{tenant}:*\` window with \`KEYS\`, adds up \`input_tokens\`,
\`output_tokens\` and \`events\` with one \`HGET\` each, prices the token total at \`BLENDED_RATE\`, and
answers \`spend_micros\`, \`budget_micros\` and \`budget_micros - spend_micros\` as \`remaining_micros\`. It
serves the demo and hides five flaws.

**Failure mode the checks target.** Any caller can read any tenant. The limiter enforces the current
window's \`cost_micros\`; the starter adds last hour's window, still in its grace period, and re-prices
tokens at a blended rate, so the dashboard and the 429 disagree. Field-by-field reads mix two moments
when a report lands between them, and an over-budget tenant sees a negative remainder.

Requirements:

- \`X-Tenant-Id\` is required (**401**); reading a tenant other than the caller's is **403**.
- Read only the current window, \`window_key(tenant, bucket_of(now))\`, in **one** command (\`HGETALL\`).
- Answer \`{tenant, bucket, input_tokens, output_tokens, events, spend_micros, budget_micros,
  remaining_micros}\`: \`spend_micros\` is the window's \`cost_micros\`, \`remaining_micros\` is
  \`max(0, BUDGET_MICROS - spend_micros)\`, and a window with no reports reads as zeros.`,
  sequence: {
    participants: ['Client', 'meterd', 'Redis'],
    messages: [
      {from: 'Client', to: 'meterd', label: 'GET /v1/tenants/t1/spend · X-Tenant-Id: t1', kind: 'sync'},
      {from: 'meterd', to: 'meterd', label: 'caller == tenant · bucket_of(now)', kind: 'sync'},
      {from: 'meterd', to: 'Redis', label: 'HGETALL meter:t1:{bucket}', kind: 'sync'},
      {from: 'Redis', to: 'meterd', label: '{input_tokens, output_tokens, cost_micros, events}', kind: 'reply'},
      {from: 'meterd', to: 'Client', label: '200 {spend_micros, budget_micros, remaining_micros ≥ 0}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'tenant-scope',
      title: "Answers only the caller's own tenant",
      detail:
        'Without X-Tenant-Id the read is 401; a caller asking for another tenant gets 403 and none of its numbers. The starter trusts the path.',
      match: {
        python: {all: [/X-Tenant-Id/, /status_code\s*=\s*403/]},
        typescript: {all: [/x-tenant-id/, /code\(\s*403\s*\)/]},
        go: {all: [/X-Tenant-Id/, /StatusForbidden/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.Forbidden/]},
        cpp: {all: [/X-Tenant-Id/, /\b403\b/]},
      },
    },
    {
      id: 'current-window',
      title: 'Reads the current window only',
      detail:
        "Spend is the current hour's window, meter:{tenant}:{bucket_of(now)}, the one the limiter enforces; the previous window, still alive in its grace hour, does not count. The starter sums every window KEYS finds.",
      match: {
        python: {all: [/bucket_of\(/, /window_key\(/], none: [/\.keys\(|\.scan(_iter)?\(/]},
        typescript: {all: [/bucketOf\(/, /windowKey\(/], none: [/\.keys\(|\.scan(Stream)?\(/]},
        go: {all: [/config\.BucketOf\(/, /config\.WindowKey\(/], none: [/\.Keys\(|\.Scan\(/]},
        scala: {all: [/Config\.bucketOf\(/, /Config\.windowKey\(/], none: [/\.keys\(|\.scan\(/]},
        cpp: {all: [/config::bucket_of\(/, /config::window_key\(/], none: [/\.keys\(|\.scan\(/]},
      },
    },
    {
      id: 'counter-source',
      title: "Reports the window's cost_micros as the spend",
      detail:
        "spend_micros is the cost_micros the metering path wrote at each model's rate, the number the limiter compares with the budget. The starter re-prices the token total at a blended rate.",
      match: {
        python: {all: [/["']cost_micros["']/], none: [/BLENDED_RATE/]},
        typescript: {all: [/cost_micros/], none: [/BLENDED_RATE/]},
        go: {all: [/"cost_micros"/], none: [/blendedRate/]},
        scala: {all: [/"cost_micros"/], none: [/BlendedRate/]},
        cpp: {all: [/"cost_micros"/], none: [/kBlendedRate/]},
      },
    },
    {
      id: 'snapshot-read',
      title: 'Reads the window in one command',
      detail:
        "Tokens, events and spend in the answer come from one instant: a report landing during the read is either wholly in it or wholly out. The starter reads one field per HGET, and a report between two of them pairs one moment's tokens with another's.",
      match: {
        python: {all: [/\.hgetall\(|\.hmget\(/], none: [/\.hget\(/]},
        typescript: {all: [/\.hgetall\(|\.hmget\(/], none: [/\.hget\(/]},
        go: {all: [/\.HGetAll\(|\.HMGet\(/], none: [/\.HGet\(/]},
        scala: {all: [/\.hgetAll\(|\.hmget\(/], none: [/\.hget\(/]},
        cpp: {all: [/\.hgetall\(|\.hmget\(/], none: [/\.hget\(/]},
      },
    },
    {
      id: 'remaining-floor',
      title: 'Clamps the remaining budget at zero',
      detail:
        'remaining_micros is BUDGET_MICROS minus the spend, and 0 for a tenant over budget; a tenant with no reports this hour has the whole budget. The starter answers a negative remainder.',
      match: {
        python: {all: [/max\(\s*0\s*,|max\([^)]*,\s*0\s*\)/]},
        typescript: {all: [/Math\.max\(\s*0\s*,|Math\.max\([^)]*,\s*0\s*\)/]},
        go: {all: [/max\(\s*0\s*,|max\([^)]*,\s*0\s*\)/]},
        scala: {all: [/math\.max\(\s*0L?\s*,|math\.max\([^)]*,\s*0L?\s*\)/]},
        cpp: {all: [/std::max(<long long>)?\(\s*0(LL)?\s*,|std::max(<long long>)?\([^)]*,\s*0(LL)?\s*\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import redis
from fastapi import FastAPI
from fastapi.responses import JSONResponse

from meter.config import BUDGET_MICROS

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# micro-dollars per 1 000 tokens, input and output alike
BLENDED_RATE = 5000


@app.get("/v1/tenants/{tenant}/spend")
def tenant_spend(tenant: str) -> JSONResponse:
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    input_tokens = output_tokens = events = 0
    for key in r.keys(f"meter:{tenant}:*"):
        input_tokens += int(r.hget(key, "input_tokens") or 0)
        output_tokens += int(r.hget(key, "output_tokens") or 0)
        events += int(r.hget(key, "events") or 0)
    spend_micros = (input_tokens + output_tokens) * BLENDED_RATE // 1000
    return JSONResponse({
        "tenant": tenant,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "events": events,
        "spend_micros": spend_micros,
        "budget_micros": BUDGET_MICROS,
        "remaining_micros": BUDGET_MICROS - spend_micros,
    })
`,
      solution: `import time

import redis
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from meter.config import BUDGET_MICROS, bucket_of, window_key

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


@app.get("/v1/tenants/{tenant}/spend")
def tenant_spend(tenant: str, request: Request) -> JSONResponse:
    caller = request.headers.get("X-Tenant-Id", "")
    if caller == "":
        return JSONResponse({"error": "missing X-Tenant-Id"}, status_code=401)
    if caller != tenant:
        return JSONResponse({"error": "a tenant reads its own spend"}, status_code=403)
    bucket = bucket_of(time.time())
    # One command: the limiter's own counters, all from one instant.
    window = r.hgetall(window_key(tenant, bucket))
    spend_micros = int(window.get("cost_micros", 0))
    return JSONResponse({
        "tenant": tenant,
        "bucket": bucket,
        "input_tokens": int(window.get("input_tokens", 0)),
        "output_tokens": int(window.get("output_tokens", 0)),
        "events": int(window.get("events", 0)),
        "spend_micros": spend_micros,
        "budget_micros": BUDGET_MICROS,
        "remaining_micros": max(0, BUDGET_MICROS - spend_micros),
    })
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {BUDGET_MICROS} from 'meter/config';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

/** micro-dollars per 1 000 tokens, input and output alike */
export const BLENDED_RATE = 5000;

app.get('/v1/tenants/:tenant/spend', async (request, reply) => {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const {tenant} = request.params as {tenant: string};
  let inputTokens = 0;
  let outputTokens = 0;
  let events = 0;
  for (const key of await redis.keys(\`meter:\${tenant}:*\`)) {
    inputTokens += Number((await redis.hget(key, 'input_tokens')) ?? 0);
    outputTokens += Number((await redis.hget(key, 'output_tokens')) ?? 0);
    events += Number((await redis.hget(key, 'events')) ?? 0);
  }
  const spendMicros = Math.floor(((inputTokens + outputTokens) * BLENDED_RATE) / 1000);
  return reply.send({
    tenant,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    events,
    spend_micros: spendMicros,
    budget_micros: BUDGET_MICROS,
    remaining_micros: BUDGET_MICROS - spendMicros,
  });
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {BUDGET_MICROS, bucketOf, windowKey} from 'meter/config';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

app.get('/v1/tenants/:tenant/spend', async (request, reply) => {
  const {tenant} = request.params as {tenant: string};
  const caller = request.headers['x-tenant-id'];
  if (typeof caller !== 'string' || caller === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  if (caller !== tenant) return reply.code(403).send({error: 'a tenant reads its own spend'});
  const bucket = bucketOf(Date.now() / 1000);
  // One command: the limiter's own counters, all from one instant.
  const window = await redis.hgetall(windowKey(tenant, bucket));
  const spendMicros = Number(window.cost_micros ?? 0);
  return reply.send({
    tenant,
    bucket,
    input_tokens: Number(window.input_tokens ?? 0),
    output_tokens: Number(window.output_tokens ?? 0),
    events: Number(window.events ?? 0),
    spend_micros: spendMicros,
    budget_micros: BUDGET_MICROS,
    remaining_micros: Math.max(0, BUDGET_MICROS - spendMicros),
  });
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/redis/go-redis/v9"

	"meter/config" // config.BudgetMicros — provided
)

// blendedRate is micro-dollars per 1 000 tokens, input and output alike.
const blendedRate = 5000

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func tenantSpend(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	tenant := r.PathValue("tenant")
	keys, err := rdb.Keys(r.Context(), "meter:"+tenant+":*").Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	var inputTokens, outputTokens, events int64
	for _, key := range keys {
		in, _ := rdb.HGet(r.Context(), key, "input_tokens").Int64()
		out, _ := rdb.HGet(r.Context(), key, "output_tokens").Int64()
		n, _ := rdb.HGet(r.Context(), key, "events").Int64()
		inputTokens, outputTokens, events = inputTokens+in, outputTokens+out, events+n
	}
	spend := (inputTokens + outputTokens) * blendedRate / 1000
	writeJSON(rw, http.StatusOK, map[string]any{
		"tenant":           tenant,
		"input_tokens":     inputTokens,
		"output_tokens":    outputTokens,
		"events":           events,
		"spend_micros":     spend,
		"budget_micros":    config.BudgetMicros,
		"remaining_micros": config.BudgetMicros - spend,
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/tenants/{tenant}/spend", tenantSpend)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
      solution: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"meter/config" // config.BudgetMicros, config.BucketOf, config.WindowKey — provided
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func tenantSpend(rw http.ResponseWriter, r *http.Request) {
	tenant := r.PathValue("tenant")
	caller := r.Header.Get("X-Tenant-Id")
	if caller == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	if caller != tenant {
		writeJSON(rw, http.StatusForbidden, map[string]string{"error": "a tenant reads its own spend"})
		return
	}
	bucket := config.BucketOf(time.Now().Unix())
	// One command: the limiter's own counters, all from one instant.
	window, err := rdb.HGetAll(r.Context(), config.WindowKey(tenant, bucket)).Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	field := func(name string) int64 {
		n, _ := strconv.ParseInt(window[name], 10, 64)
		return n
	}
	spend := field("cost_micros")
	writeJSON(rw, http.StatusOK, map[string]any{
		"tenant":           tenant,
		"bucket":           bucket,
		"input_tokens":     field("input_tokens"),
		"output_tokens":    field("output_tokens"),
		"events":           field("events"),
		"spend_micros":     spend,
		"budget_micros":    config.BudgetMicros,
		"remaining_micros": max(0, config.BudgetMicros-spend),
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/tenants/{tenant}/spend", tenantSpend)
}

func main() {
	mux := http.NewServeMux()
	register(mux)
	log.Fatal(http.ListenAndServe(":8443", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import meter.Config

object SpendApi {
  implicit val system: ActorSystem = ActorSystem("cost-meter")
  private val jedis = new JedisPooled("redis", 6379)

  /** micro-dollars per 1 000 tokens, input and output alike */
  val BlendedRate = 5000L

  private def field(key: String, name: String): Long = Option(jedis.hget(key, name)).map(_.toLong).getOrElse(0L)

  val route: Route =
    path("v1" / "tenants" / Segment / "spend") { tenant =>
      get {
        // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
        val keys = jedis.keys(s"meter:$tenant:*").asScala.toList
        val inputTokens = keys.map(field(_, "input_tokens")).sum
        val outputTokens = keys.map(field(_, "output_tokens")).sum
        val events = keys.map(field(_, "events")).sum
        val spend = (inputTokens + outputTokens) * BlendedRate / 1000
        val body = ujson.Obj(
          "tenant" -> tenant,
          "input_tokens" -> inputTokens.toDouble,
          "output_tokens" -> outputTokens.toDouble,
          "events" -> events.toDouble,
          "spend_micros" -> spend.toDouble,
          "budget_micros" -> Config.BudgetMicros.toDouble,
          "remaining_micros" -> (Config.BudgetMicros - spend).toDouble
        )
        complete(HttpEntity(ContentTypes.\`application/json\`, ujson.write(body)))
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
import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

import meter.Config

object SpendApi {
  implicit val system: ActorSystem = ActorSystem("cost-meter")
  private val jedis = new JedisPooled("redis", 6379)

  private def json(status: StatusCode, body: ujson.Value) =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, ujson.write(body))))

  val route: Route =
    path("v1" / "tenants" / Segment / "spend") { tenant =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") {
          case None | Some("") => json(StatusCodes.Unauthorized, ujson.Obj("error" -> "missing X-Tenant-Id"))
          case Some(caller) if caller != tenant =>
            json(StatusCodes.Forbidden, ujson.Obj("error" -> "a tenant reads its own spend"))
          case Some(_) =>
            val bucket = Config.bucketOf(System.currentTimeMillis() / 1000)
            // One command: the limiter's own counters, all from one instant.
            val window = jedis.hgetAll(Config.windowKey(tenant, bucket)).asScala
            def field(name: String): Long = window.get(name).map(_.toLong).getOrElse(0L)
            val spend = field("cost_micros")
            json(
              StatusCodes.OK,
              ujson.Obj(
                "tenant" -> tenant,
                "bucket" -> bucket.toDouble,
                "input_tokens" -> field("input_tokens").toDouble,
                "output_tokens" -> field("output_tokens").toDouble,
                "events" -> field("events").toDouble,
                "spend_micros" -> spend.toDouble,
                "budget_micros" -> Config.BudgetMicros.toDouble,
                "remaining_micros" -> math.max(0L, Config.BudgetMicros - spend).toDouble
              )
            )
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
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

#include "meter/config.h"  // config::kBudgetMicros — provided

using json = nlohmann::json;

// micro-dollars per 1 000 tokens, input and output alike
constexpr long long kBlendedRate = 5000;

sw::redis::Redis redis("tcp://redis:6379");

long long field(const std::string& key, const std::string& name) {
  const auto value = redis.hget(key, name);
  return value ? std::stoll(*value) : 0;
}

void tenant_spend(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const std::string tenant = req.matches[1].str();
  std::vector<std::string> keys;
  redis.keys("meter:" + tenant + ":*", std::back_inserter(keys));
  long long input_tokens = 0, output_tokens = 0, events = 0;
  for (const auto& key : keys) {
    input_tokens += field(key, "input_tokens");
    output_tokens += field(key, "output_tokens");
    events += field(key, "events");
  }
  const long long spend = (input_tokens + output_tokens) * kBlendedRate / 1000;
  const json body = {{"tenant", tenant},
                     {"input_tokens", input_tokens},
                     {"output_tokens", output_tokens},
                     {"events", events},
                     {"spend_micros", spend},
                     {"budget_micros", config::kBudgetMicros},
                     {"remaining_micros", config::kBudgetMicros - spend}};
  res.status = 200;
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/tenants/([^/]+)/spend)", tenant_spend); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <algorithm>
#include <chrono>
#include <string>
#include <unordered_map>

#include "meter/config.h"  // config::kBudgetMicros, config::bucket_of, config::window_key — provided

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

void reject(httplib::Response& res, int status, const std::string& error) {
  res.status = status;
  res.set_content(json({{"error", error}}).dump(), "application/json");
}

void tenant_spend(const httplib::Request& req, httplib::Response& res) {
  const std::string tenant = req.matches[1].str();
  const std::string caller = req.get_header_value("X-Tenant-Id");
  if (caller.empty()) return reject(res, 401, "missing X-Tenant-Id");
  if (caller != tenant) return reject(res, 403, "a tenant reads its own spend");
  const long long now =
      std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  const long long bucket = config::bucket_of(now);
  // One command: the limiter's own counters, all from one instant.
  const std::unordered_map<std::string, std::string> window = redis.hgetall(config::window_key(tenant, bucket));
  const auto field = [&window](const char* name) -> long long {
    const auto it = window.find(name);
    return it == window.end() ? 0 : std::stoll(it->second);
  };
  const long long spend = field("cost_micros");
  const json body = {{"tenant", tenant},
                     {"bucket", bucket},
                     {"input_tokens", field("input_tokens")},
                     {"output_tokens", field("output_tokens")},
                     {"events", field("events")},
                     {"spend_micros", spend},
                     {"budget_micros", config::kBudgetMicros},
                     {"remaining_micros", std::max(0LL, config::kBudgetMicros - spend)}};
  res.status = 200;
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/tenants/([^/]+)/spend)", tenant_spend); }

int main() {
  httplib::Server svr;
  register_routes(svr);
  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  harness: {
    python: `import time

WINDOW = 3600
BUDGET = 5_000_000


def _mid_window(ctx):
    """Move the clock to half past the next hour; the bucket it falls in."""
    ctx.clock.advance(WINDOW - time.time() % WINDOW + 1800)
    return int(time.time() // WINDOW)


def _seed(ctx, tenant, bucket, input_tokens, output_tokens, cost_micros, events):
    """A window as step 2's script leaves it."""
    ctx.redis.hset(f"meter:{tenant}:{bucket}", mapping={"input_tokens": input_tokens, "output_tokens": output_tokens, "cost_micros": cost_micros, "events": events})


async def _get(ctx, tenant, caller="t1"):
    headers = {"X-Tenant-Id": caller} if caller else {}
    async with ctx.client(ctx.load("read").app) as c:
        return await c.get(f"/v1/tenants/{tenant}/spend", headers=headers)


def _body(r):
    assert r.status_code == 200, f"the spend read answered {r.status_code}: {r.text}"
    return r.json()


async def check_tenant_scope(ctx):
    bucket = _mid_window(ctx)
    _seed(ctx, "t1", bucket, 1200, 300, 6000, 1)
    _seed(ctx, "t2", bucket, 9000, 900, 99_000, 3)
    own = _body(await _get(ctx, "t1", caller="t1"))
    assert own.get("tenant") == "t1" and own.get("spend_micros") == 6000, f"t1 reading its own spend got {own}"
    r = await _get(ctx, "t2", caller="t1")
    assert r.status_code == 403, f"t1 reading t2's spend answered {r.status_code}, expected 403: another tenant's spend is one URL away"
    assert "99000" not in r.text, f"the 403 must not carry t2's numbers: {r.text}"
    r = await _get(ctx, "t1", caller=None)
    assert r.status_code == 401, f"a read without X-Tenant-Id answered {r.status_code}, expected 401"


async def check_current_window(ctx):
    bucket = _mid_window(ctx)
    _seed(ctx, "t1", bucket - 1, 800_000, 200_000, 4_000_000, 40)  # last hour, still in its grace hour
    _seed(ctx, "t1", bucket, 1200, 300, 6000, 1)
    body = _body(await _get(ctx, "t1"))
    got = (body.get("input_tokens"), body.get("output_tokens"), body.get("events"), body.get("spend_micros"))
    assert got == (1200, 300, 1, 6000), f"the read answered tokens, events and spend {got}, expected the current window's (1200, 300, 1, 6000): last hour's window is not what the limiter enforces now"
    assert body.get("bucket") == bucket, f"the answer must name the window it read, bucket {bucket}: {body}"


async def check_counter_source(ctx):
    bucket = _mid_window(ctx)
    _seed(ctx, "t1", bucket, 1000, 1000, 18_000, 1)  # claude-sonnet-4: 3000 + 15000 micro-dollars
    body = _body(await _get(ctx, "t1"))
    assert body.get("spend_micros") == 18_000, f"the window's cost_micros is 18000 and the read answered spend_micros={body.get('spend_micros')}: re-pricing tokens at one rate disagrees with what the limiter enforces"
    assert body.get("budget_micros") == BUDGET and body.get("remaining_micros") == BUDGET - 18_000, f"budget and remainder follow from the same spend: {body}"


async def check_snapshot_read(ctx):
    bucket = _mid_window(ctx)
    key = f"meter:t1:{bucket}"
    _seed(ctx, "t1", bucket, 1000, 0, 2500, 1)

    def report_lands():
        # step 2's script recording another report while the read is under way
        ctx.redis.hincrby(key, "input_tokens", 1000)
        ctx.redis.hincrby(key, "output_tokens", 500)
        ctx.redis.hincrby(key, "cost_micros", 7500)
        ctx.redis.hincrby(key, "events", 1)

    probe = ctx.redis_after(key, report_lands)
    body = _body(await _get(ctx, "t1"))
    assert probe.fired, f"the read never touched {key}"
    got = (body.get("input_tokens"), body.get("output_tokens"), body.get("events"), body.get("spend_micros"))
    assert got in ((1000, 0, 1, 2500), (2000, 500, 2, 10_000)), f"a report landed during the read and the answer {got} pairs one moment's numbers with another's: read the window in one command"


async def check_remaining_floor(ctx):
    bucket = _mid_window(ctx)
    _seed(ctx, "t1", bucket, 900_000, 300_000, 5_250_000, 80)
    body = _body(await _get(ctx, "t1"))
    assert body.get("spend_micros") == 5_250_000, f"spend_micros must be the window's cost_micros, 5250000: {body}"
    assert body.get("remaining_micros") == 0, f"a tenant 250000 micro-dollars over budget has remaining_micros={body.get('remaining_micros')}, expected 0: there is no negative budget"
    fresh = _body(await _get(ctx, "t9", caller="t9"))
    got = (fresh.get("spend_micros"), fresh.get("events"), fresh.get("remaining_micros"))
    assert got == (0, 0, BUDGET), f"a tenant with no reports this hour must read spend 0, events 0, the whole budget; got {fresh}"
`,
    typescript: `const WINDOW = 3600;
const BUDGET = 5_000_000;

/** Move the clock to half past the next hour; the bucket it falls in. */
function midWindow(ctx): number {
  ctx.clock.advance(WINDOW - ((ctx.clock.now() / 1000) % WINDOW) + 1800);
  return Math.floor(ctx.clock.now() / 1000 / WINDOW);
}

/** A window as step 2's script leaves it. */
function seed(ctx, tenant: string, bucket: number, input: number, output: number, cost: number, events: number) {
  ctx.redis.hset(\`meter:\${tenant}:\${bucket}\`, 'input_tokens', input, 'output_tokens', output, 'cost_micros', cost, 'events', events);
}

async function get(ctx, tenant: string, caller: string | null = 't1') {
  const headers: Record<string, string> = caller === null ? {} : {'X-Tenant-Id': caller};
  return ctx.client(ctx.load('read').app).get(\`/v1/tenants/\${tenant}/spend\`, {headers});
}

function body(r) {
  assert.equal(r.status, 200, \`the spend read answered \${r.status}: \${r.text}\`);
  return r.json();
}

const numbers = b => [b.input_tokens, b.output_tokens, b.events, b.spend_micros];

export async function check_tenant_scope(ctx) {
  const bucket = midWindow(ctx);
  seed(ctx, 't1', bucket, 1200, 300, 6000, 1);
  seed(ctx, 't2', bucket, 9000, 900, 99_000, 3);
  const own = body(await get(ctx, 't1', 't1'));
  assert(own.tenant === 't1' && own.spend_micros === 6000, \`t1 reading its own spend got \${JSON.stringify(own)}\`);
  let r = await get(ctx, 't2', 't1');
  assert.equal(r.status, 403, \`t1 reading t2's spend answered \${r.status}, expected 403: another tenant's spend is one URL away\`);
  assert(!r.text.includes('99000'), \`the 403 must not carry t2's numbers: \${r.text}\`);
  r = await get(ctx, 't1', null);
  assert.equal(r.status, 401, \`a read without X-Tenant-Id answered \${r.status}, expected 401\`);
}

export async function check_current_window(ctx) {
  const bucket = midWindow(ctx);
  seed(ctx, 't1', bucket - 1, 800_000, 200_000, 4_000_000, 40); // last hour, still in its grace hour
  seed(ctx, 't1', bucket, 1200, 300, 6000, 1);
  const b = body(await get(ctx, 't1'));
  assert.deepEqual(numbers(b), [1200, 300, 1, 6000], \`the read answered tokens, events and spend \${JSON.stringify(numbers(b))}, expected the current window's [1200, 300, 1, 6000]: last hour's window is not what the limiter enforces now\`);
  assert.equal(b.bucket, bucket, \`the answer must name the window it read, bucket \${bucket}: \${JSON.stringify(b)}\`);
}

export async function check_counter_source(ctx) {
  const bucket = midWindow(ctx);
  seed(ctx, 't1', bucket, 1000, 1000, 18_000, 1); // claude-sonnet-4: 3000 + 15000 micro-dollars
  const b = body(await get(ctx, 't1'));
  assert.equal(b.spend_micros, 18_000, \`the window's cost_micros is 18000 and the read answered spend_micros=\${b.spend_micros}: re-pricing tokens at one rate disagrees with what the limiter enforces\`);
  assert(b.budget_micros === BUDGET && b.remaining_micros === BUDGET - 18_000, \`budget and remainder follow from the same spend: \${JSON.stringify(b)}\`);
}

export async function check_snapshot_read(ctx) {
  const bucket = midWindow(ctx);
  const key = \`meter:t1:\${bucket}\`;
  seed(ctx, 't1', bucket, 1000, 0, 2500, 1);
  // step 2's script recording another report while the read is under way
  const probe = ctx.redisAfter(key, () => {
    ctx.redis.hincrby(key, 'input_tokens', 1000);
    ctx.redis.hincrby(key, 'output_tokens', 500);
    ctx.redis.hincrby(key, 'cost_micros', 7500);
    ctx.redis.hincrby(key, 'events', 1);
  });
  const b = body(await get(ctx, 't1'));
  assert(probe.fired, \`the read never touched \${key}\`);
  const got = JSON.stringify(numbers(b));
  assert(got === '[1000,0,1,2500]' || got === '[2000,500,2,10000]', \`a report landed during the read and the answer \${got} pairs one moment's numbers with another's: read the window in one command\`);
}

export async function check_remaining_floor(ctx) {
  const bucket = midWindow(ctx);
  seed(ctx, 't1', bucket, 900_000, 300_000, 5_250_000, 80);
  const b = body(await get(ctx, 't1'));
  assert.equal(b.spend_micros, 5_250_000, \`spend_micros must be the window's cost_micros, 5250000: \${JSON.stringify(b)}\`);
  assert.equal(b.remaining_micros, 0, \`a tenant 250000 micro-dollars over budget has remaining_micros=\${b.remaining_micros}, expected 0: there is no negative budget\`);
  const fresh = body(await get(ctx, 't9', 't9'));
  assert.deepEqual([fresh.spend_micros, fresh.events, fresh.remaining_micros], [0, 0, BUDGET], \`a tenant with no reports this hour must read spend 0, events 0, the whole budget; got \${JSON.stringify(fresh)}\`);
}
`,
    go: `package main

import (
	"math"
	"net/http"
	"strconv"
	"strings"

	"leetbuild/harness"
)

const (
	readWindow = 3600
	readBudget = 5_000_000
)

// readMidWindow moves the clock to half past the next hour; the bucket it falls in.
func readMidWindow(ctx *harness.Ctx) int64 {
	now := float64(ctx.Clock.Now()) / 1000
	ctx.Clock.Advance(readWindow - math.Mod(now, readWindow) + 1800)
	return ctx.Clock.Now() / 1000 / readWindow
}

func readKey(tenant string, bucket int64) string {
	return "meter:" + tenant + ":" + strconv.FormatInt(bucket, 10)
}

// readSeed writes a window as step 2's script leaves it.
func readSeed(ctx *harness.Ctx, tenant string, bucket int64, in, out, cost, events int64) {
	ctx.Redis.Do("HSET", readKey(tenant, bucket), "input_tokens", in, "output_tokens", out, "cost_micros", cost, "events", events)
}

func readGet(ctx *harness.Ctx, tenant, caller string) *harness.Response {
	mux := http.NewServeMux()
	register(mux)
	if caller == "" {
		return ctx.HTTP(mux).Get("/v1/tenants/" + tenant + "/spend")
	}
	return ctx.HTTP(mux).Get("/v1/tenants/"+tenant+"/spend", "X-Tenant-Id", caller)
}

func readBody(ctx *harness.Ctx, r *harness.Response) map[string]any {
	ctx.Equal(r.Status, 200, "the spend read (%s)", r.Text())
	body, ok := r.JSON().(map[string]any)
	ctx.Assert(ok, "the body must be a JSON object: %s", r.Text())
	return body
}

func readNumbers(b map[string]any) []any {
	return []any{b["input_tokens"], b["output_tokens"], b["events"], b["spend_micros"]}
}

func CheckTenantScope(ctx *harness.Ctx) {
	bucket := readMidWindow(ctx)
	readSeed(ctx, "t1", bucket, 1200, 300, 6000, 1)
	readSeed(ctx, "t2", bucket, 9000, 900, 99_000, 3)
	own := readBody(ctx, readGet(ctx, "t1", "t1"))
	ctx.Assert(own["tenant"] == "t1" && own["spend_micros"] == float64(6000), "t1 reading its own spend got %v", own)
	r := readGet(ctx, "t2", "t1")
	ctx.Equal(r.Status, 403, "t1 reading t2's spend: another tenant's spend is one URL away")
	ctx.Assert(!strings.Contains(r.Text(), "99000"), "the 403 must not carry t2's numbers: %s", r.Text())
	ctx.Equal(readGet(ctx, "t1", "").Status, 401, "a read without X-Tenant-Id")
}

func CheckCurrentWindow(ctx *harness.Ctx) {
	bucket := readMidWindow(ctx)
	readSeed(ctx, "t1", bucket-1, 800_000, 200_000, 4_000_000, 40) // last hour, still in its grace hour
	readSeed(ctx, "t1", bucket, 1200, 300, 6000, 1)
	b := readBody(ctx, readGet(ctx, "t1", "t1"))
	ctx.Equal(readNumbers(b), []any{float64(1200), float64(300), float64(1), float64(6000)}, "the current window's tokens, events and spend (last hour's window is not what the limiter enforces now)")
	ctx.Equal(b["bucket"], float64(bucket), "the answer must name the window it read; bucket")
}

func CheckCounterSource(ctx *harness.Ctx) {
	bucket := readMidWindow(ctx)
	readSeed(ctx, "t1", bucket, 1000, 1000, 18_000, 1) // claude-sonnet-4: 3000 + 15000 micro-dollars
	b := readBody(ctx, readGet(ctx, "t1", "t1"))
	ctx.Equal(b["spend_micros"], float64(18_000), "the window's cost_micros is 18000 (re-pricing tokens at one rate disagrees with what the limiter enforces); spend_micros")
	ctx.Assert(b["budget_micros"] == float64(readBudget) && b["remaining_micros"] == float64(readBudget-18_000), "budget and remainder follow from the same spend: %v", b)
}

func CheckSnapshotRead(ctx *harness.Ctx) {
	bucket := readMidWindow(ctx)
	key := readKey("t1", bucket)
	readSeed(ctx, "t1", bucket, 1000, 0, 2500, 1)
	fired := false
	// step 2's script recording another report while the read is under way
	ctx.Redis.After(key, func() any {
		fired = true
		ctx.Redis.Do("HINCRBY", key, "input_tokens", 1000)
		ctx.Redis.Do("HINCRBY", key, "output_tokens", 500)
		ctx.Redis.Do("HINCRBY", key, "cost_micros", 7500)
		ctx.Redis.Do("HINCRBY", key, "events", 1)
		return nil
	})
	b := readBody(ctx, readGet(ctx, "t1", "t1"))
	ctx.Assert(fired, "the read never touched %s", key)
	got := harness.Show(readNumbers(b))
	ctx.Assert(got == harness.Show([]any{float64(1000), float64(0), float64(1), float64(2500)}) || got == harness.Show([]any{float64(2000), float64(500), float64(2), float64(10000)}),
		"a report landed during the read and the answer %s pairs one moment's numbers with another's: read the window in one command", got)
}

func CheckRemainingFloor(ctx *harness.Ctx) {
	bucket := readMidWindow(ctx)
	readSeed(ctx, "t1", bucket, 900_000, 300_000, 5_250_000, 80)
	b := readBody(ctx, readGet(ctx, "t1", "t1"))
	ctx.Equal(b["spend_micros"], float64(5_250_000), "spend_micros must be the window's cost_micros")
	ctx.Equal(b["remaining_micros"], float64(0), "a tenant 250000 micro-dollars over budget has no negative budget; remaining_micros")
	fresh := readBody(ctx, readGet(ctx, "t9", "t9"))
	ctx.Equal([]any{fresh["spend_micros"], fresh["events"], fresh["remaining_micros"]}, []any{float64(0), float64(0), float64(readBudget)}, "a tenant with no reports this hour reads spend 0, events 0, the whole budget")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <string>

namespace {

using json = nlohmann::json;

constexpr long long kWindow = 3600;
constexpr long long kBudget = 5000000;

// Move the clock to half past the next hour; the bucket it falls in.
long long midWindow(harness::Ctx& ctx) {
  const double now = static_cast<double>(ctx.Clock.Now()) / 1000;
  ctx.Clock.Advance(kWindow - std::fmod(now, kWindow) + 1800);
  return ctx.Clock.Now() / 1000 / kWindow;
}

std::string windowOf(const std::string& tenant, long long bucket) { return "meter:" + tenant + ":" + std::to_string(bucket); }

// A window as step 2's script leaves it.
void seed(harness::Ctx& ctx, const std::string& tenant, long long bucket, long long in, long long out, long long cost, long long events) {
  ctx.Redis.Do("HSET", windowOf(tenant, bucket), "input_tokens", in, "output_tokens", out, "cost_micros", cost, "events", events);
}

harness::Response get(harness::Ctx& ctx, const std::string& tenant, const std::string& caller) {
  httplib::Server svr;
  register_routes(svr);
  auto http = ctx.HTTP(svr);
  if (caller.empty()) return http.Get("/v1/tenants/" + tenant + "/spend");
  return http.Get("/v1/tenants/" + tenant + "/spend", "X-Tenant-Id", caller);
}

json bodyOf(harness::Ctx& ctx, const harness::Response& r) {
  ctx.Equal(r.Status, 200, "the spend read (%s)", r.Text());
  const json body = json::parse(r.Text(), nullptr, false);
  ctx.Assert(body.is_object(), "the body must be a JSON object: %s", r.Text());
  return body;
}

json numbers(const json& b) { return json::array({b.value("input_tokens", json()), b.value("output_tokens", json()), b.value("events", json()), b.value("spend_micros", json())}); }

}  // namespace

void CheckTenantScope(harness::Ctx& ctx) {
  const long long bucket = midWindow(ctx);
  seed(ctx, "t1", bucket, 1200, 300, 6000, 1);
  seed(ctx, "t2", bucket, 9000, 900, 99000, 3);
  const json own = bodyOf(ctx, get(ctx, "t1", "t1"));
  ctx.Assert(own.value("tenant", "") == "t1" && own.value("spend_micros", json()) == 6000, "t1 reading its own spend got %s", own.dump());
  const auto r = get(ctx, "t2", "t1");
  ctx.Equal(r.Status, 403, "t1 reading t2's spend: another tenant's spend is one URL away");
  ctx.Assert(r.Text().find("99000") == std::string::npos, "the 403 must not carry t2's numbers: %s", r.Text());
  ctx.Equal(get(ctx, "t1", "").Status, 401, "a read without X-Tenant-Id");
}

void CheckCurrentWindow(harness::Ctx& ctx) {
  const long long bucket = midWindow(ctx);
  seed(ctx, "t1", bucket - 1, 800000, 200000, 4000000, 40);  // last hour, still in its grace hour
  seed(ctx, "t1", bucket, 1200, 300, 6000, 1);
  const json b = bodyOf(ctx, get(ctx, "t1", "t1"));
  ctx.Equal(numbers(b), json::array({1200, 300, 1, 6000}), "the current window's tokens, events and spend (last hour's window is not what the limiter enforces now)");
  ctx.Equal(b.value("bucket", json()), json(bucket), "the answer must name the window it read; bucket");
}

void CheckCounterSource(harness::Ctx& ctx) {
  const long long bucket = midWindow(ctx);
  seed(ctx, "t1", bucket, 1000, 1000, 18000, 1);  // claude-sonnet-4: 3000 + 15000 micro-dollars
  const json b = bodyOf(ctx, get(ctx, "t1", "t1"));
  ctx.Equal(b.value("spend_micros", json()), json(18000), "the window's cost_micros is 18000 (re-pricing tokens at one rate disagrees with what the limiter enforces); spend_micros");
  ctx.Assert(b.value("budget_micros", json()) == kBudget && b.value("remaining_micros", json()) == kBudget - 18000, "budget and remainder follow from the same spend: %s", b.dump());
}

void CheckSnapshotRead(harness::Ctx& ctx) {
  const long long bucket = midWindow(ctx);
  const std::string key = windowOf("t1", bucket);
  seed(ctx, "t1", bucket, 1000, 0, 2500, 1);
  bool fired = false;
  // step 2's script recording another report while the read is under way
  ctx.Redis.After(key, [&] {
    fired = true;
    ctx.Redis.Do("HINCRBY", key, "input_tokens", 1000);
    ctx.Redis.Do("HINCRBY", key, "output_tokens", 500);
    ctx.Redis.Do("HINCRBY", key, "cost_micros", 7500);
    ctx.Redis.Do("HINCRBY", key, "events", 1);
  });
  const json b = bodyOf(ctx, get(ctx, "t1", "t1"));
  ctx.Assert(fired, "the read never touched %s", key);
  const json got = numbers(b);
  ctx.Assert(got == json::array({1000, 0, 1, 2500}) || got == json::array({2000, 500, 2, 10000}),
             "a report landed during the read and the answer %s pairs one moment's numbers with another's: read the window in one command", got.dump());
}

void CheckRemainingFloor(harness::Ctx& ctx) {
  const long long bucket = midWindow(ctx);
  seed(ctx, "t1", bucket, 900000, 300000, 5250000, 80);
  const json b = bodyOf(ctx, get(ctx, "t1", "t1"));
  ctx.Equal(b.value("spend_micros", json()), json(5250000), "spend_micros must be the window's cost_micros");
  ctx.Equal(b.value("remaining_micros", json()), json(0), "a tenant 250000 micro-dollars over budget has no negative budget; remaining_micros");
  const json fresh = bodyOf(ctx, get(ctx, "t9", "t9"));
  ctx.Equal(json::array({fresh.value("spend_micros", json()), fresh.value("events", json()), fresh.value("remaining_micros", json())}), json::array({0, 0, kBudget}),
            "a tenant with no reports this hour reads spend 0, events 0, the whole budget");
}
`,
  },
  hints: [
    "Symptom: the dashboard shows more spend than the limiter counted, at a price no model has; another tenant's spend is one URL away; an over-budget tenant sees a negative balance.",
    'Mechanism: the handler trusts the path, sums every window KEYS finds (the previous hour is still there in its grace period), recomputes cost from tokens at BLENDED_RATE instead of reading cost_micros, issues one HGET per field, and subtracts without a floor.',
    'Change: 401 without X-Tenant-Id and 403 when it differs from the path; one `HGETALL` of `window_key(tenant, bucket_of(now))`; `spend_micros` from its `cost_micros`; `remaining_micros = max(0, BUDGET_MICROS - spend_micros)`.',
  ],
  debrief: `The read is only useful if it agrees with the limiter, so it reads what the limiter reads: the current window's \`cost_micros\`, priced per model when each report was recorded. A blended rate or a sum over every live window produces a different number, and a customer who sees the dashboard say yes while the API says 429 stops trusting both. One \`HGETALL\` matters for the same reason: tokens and spend in one answer have to describe one moment, and Redis answers a single command atomically. The tenant check belongs here because spend is commercial data. The floor at zero is a contract with the dashboard; overspend shows up in \`spend_micros\`, not in a negative budget. A production read would add the previous window's final total for a rolling view, served from a durable store rather than from a key in its grace hour.`,
};
