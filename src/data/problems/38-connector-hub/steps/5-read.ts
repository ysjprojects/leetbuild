import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/connectors/{id}/health: lag measured from the last page that landed',
  concept: 'http',
  file: 'read',
  focus: ['client', 'hub', 'redis', 'db'],
  task: `## Task

**Starting point.** The starter serves \`GET /v1/connectors/{id}/health\`: it loads the connector
from \`hub.store\` (404 when there is none), reads \`health:{id}\` and answers
\`{connector_id, status, last_run_at}\`, healthy while \`last_run_at\` is less than \`STALE_AFTER_S\` (an
hour) old. It serves the demo and hides four flaws.

**Failure mode the checks target.** Any caller reads any tenant's connector. A connector whose every
run fails reads healthy, because a failed run moves \`last_run_at\` too, while a daily connector reads
unhealthy most of the day. An open breaker is invisible, and a connector disabled on a revoked token
looks fine.

- A missing \`X-Tenant-Id\` is **401**; another tenant's connector answers what a missing one does:
  **404**.
- Lag runs from \`last_success_at\` (step 4's consumer writes it): \`cursor_lag_s\` is now minus it,
  and \`status\` is \`unhealthy\` when there is none or the lag exceeds \`STALE_INTERVALS\` (2) times
  the connector's \`sync_interval_s\`.
- \`breaker\` is \`open\` while now is before \`open_until\`, else \`closed\`, beside
  \`consecutive_failures\` (step 3 writes both).
- A disabled connector reads \`status: "disabled"\` with its \`disabled_reason\`.
- The answer is \`{connector_id, status, disabled_reason, last_success_at, cursor_lag_s,
  sync_interval_s, consecutive_failures, breaker}\`.`,
  sequence: {
    participants: ['Operator', 'connectord', 'connector registry', 'Redis'],
    messages: [
      {from: 'Operator', to: 'connectord', label: 'GET /v1/connectors/c-1/health · X-Tenant-Id', kind: 'sync'},
      {from: 'connectord', to: 'connector registry', label: 'get(c-1) · tenant matches, else 404', kind: 'sync'},
      {from: 'connectord', to: 'Redis', label: 'HGETALL health:c-1', kind: 'sync'},
      {from: 'Redis', to: 'connectord', label: 'last_success_at · consecutive_failures · open_until', kind: 'reply'},
      {from: 'connectord', to: 'connectord', label: 'disabled · lag > 2 × sync_interval_s → unhealthy', kind: 'sync'},
      {from: 'connectord', to: 'Operator', label: '{status, cursor_lag_s, breaker, …}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/connectors/{id}/health',
      detail: 'Register `GET /v1/connectors/{id}/health`; a connector whose pages land on time reads healthy.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/connectors\/\{\w+\}\/health["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/connectors\/:\w+\/health['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/connectors\/\{\w+\}\/health"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"connectors"\s*\/\s*Segment\s*\/\s*"health"\s*\)/, /\bget\b/]},
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/connectors\//, /\/health\)"/]},
      },
    },
    {
      id: 'tenant-scope',
      title: "Scopes the read to the caller's tenant",
      detail:
        'A missing `X-Tenant-Id` is **401**, and a connector of another tenant answers the same **404** as a missing one, so connector ids cannot be probed across tenants.',
      match: {
        python: {
          all: [
            /x-tenant-id/i,
            /\[["']tenant["']\]\s*!=\s*tenant|tenant\s*!=\s*\w+\[["']tenant["']\]/,
            /status_code\s*=\s*401/,
          ],
        },
        typescript: {all: [/x-tenant-id/i, /\.tenant\s*!==\s*tenant|tenant\s*!==\s*\w+\.tenant/, /code\(\s*401\s*\)/]},
        go: {all: [/X-Tenant-Id/i, /\.Tenant\s*!=\s*tenant|tenant\s*!=\s*\w+\.Tenant/, /StatusUnauthorized/]},
        scala: {all: [/X-Tenant-Id/i, /\.tenant\s*[!=]=\s*tenant|tenant\s*[!=]=\s*\w+\.tenant/, /Unauthorized/]},
        cpp: {all: [/X-Tenant-Id/i, /->tenant\s*!=\s*tenant|tenant\s*!=\s*\w+->tenant/, /\b401\b/]},
      },
    },
    {
      id: 'stale-from-success',
      title: 'Measures lag from the last successful page, in sync intervals',
      detail:
        '`cursor_lag_s` runs from `last_success_at` and the connector is `unhealthy` past `STALE_INTERVALS` (2) of its own `sync_interval_s`; `last_run_at` moves on every failed run, so a connector that syncs nothing reads healthy forever.',
      match: {
        python: {
          all: [/STALE_INTERVALS\s*=\s*2\b/, /last_success_at/, /sync_interval_s/, /cursor_lag_s/],
          none: [/last_run_at/],
        },
        typescript: {
          all: [/STALE_INTERVALS\s*=\s*2\b/, /last_success_at/, /sync_interval_s/, /cursor_lag_s/],
          none: [/last_run_at/],
        },
        go: {
          all: [/staleIntervals\s*=\s*2\b/, /last_success_at/, /SyncIntervalS/, /cursor_lag_s/],
          none: [/last_run_at/],
        },
        scala: {
          all: [/StaleIntervals\s*=\s*2L?\b/, /last_success_at/, /syncIntervalS/, /cursor_lag_s/],
          none: [/last_run_at/],
        },
        cpp: {
          all: [/kStaleIntervals\s*=\s*2\b/, /last_success_at/, /sync_interval_s/, /cursor_lag_s/],
          none: [/last_run_at/],
        },
      },
    },
    {
      id: 'breaker-state',
      title: 'Shows the breaker and the failure count',
      detail:
        'The answer carries `breaker` (`open` while now is before `open_until`) and `consecutive_failures`, so an operator can tell a vendor outage being waited out from a connector that needs a human.',
      match: {
        python: {all: [/open_until/, /["']open["']/, /consecutive_failures/]},
        typescript: {all: [/open_until/, /['"]open['"]/, /consecutive_failures/]},
        go: {all: [/open_until/, /"open"/, /consecutive_failures/]},
        scala: {all: [/open_until/, /"open"/, /consecutive_failures/]},
        cpp: {all: [/open_until/, /"open"/, /consecutive_failures/]},
      },
    },
    {
      id: 'disabled-status',
      title: 'A disabled connector reads disabled, with its reason',
      detail:
        'When the registry has the connector disabled (step 3 disables it on a rejected token), `status` is `disabled` and the answer carries `disabled_reason`, whatever its lag.',
      match: {
        python: {all: [/["']disabled["']/, /disabled_reason/]},
        typescript: {all: [/['"]disabled['"]/, /disabled_reason/]},
        go: {all: [/"disabled"/, /disabled_reason/]},
        scala: {all: [/"disabled"/, /disabled_reason/]},
        cpp: {all: [/"disabled"/, /disabled_reason/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis
from fastapi import FastAPI, HTTPException, Request

from hub import store  # get

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

STALE_AFTER_S = 3600


@app.get("/v1/connectors/{connector_id}/health")
def health(connector_id: str, request: Request) -> dict:
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    connector = store.get(connector_id)
    if connector is None:
        raise HTTPException(status_code=404, detail="no such connector")
    row = r.hgetall(f"health:{connector_id}")
    last_run_at = int(row.get("last_run_at") or 0)
    fresh = time.time() - last_run_at < STALE_AFTER_S
    return {"connector_id": connector_id, "status": "healthy" if fresh else "unhealthy", "last_run_at": last_run_at}
`,
      solution: `import time

import redis
from fastapi import FastAPI, HTTPException, Request

from hub import store  # get

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# A connector is unhealthy once no page has landed in this many of its sync intervals.
STALE_INTERVALS = 2


@app.get("/v1/connectors/{connector_id}/health")
def health(connector_id: str, request: Request) -> dict:
    tenant = request.headers.get("x-tenant-id", "")
    if not tenant:
        raise HTTPException(status_code=401, detail="X-Tenant-Id is required")
    connector = store.get(connector_id)
    # Another tenant's connector and a missing one answer the same, so ids cannot be probed.
    if connector is None or connector["tenant"] != tenant:
        raise HTTPException(status_code=404, detail="no such connector")
    row = r.hgetall(f"health:{connector_id}")
    now = int(time.time())
    last_success_at = int(row["last_success_at"]) if row.get("last_success_at") else None
    cursor_lag_s = None if last_success_at is None else now - last_success_at
    interval = connector["sync_interval_s"]
    if connector["status"] == "disabled":
        status = "disabled"
    elif cursor_lag_s is None or cursor_lag_s > STALE_INTERVALS * interval:
        status = "unhealthy"
    else:
        status = "healthy"
    return {
        "connector_id": connector_id,
        "status": status,
        "disabled_reason": connector["disabled_reason"],
        "last_success_at": last_success_at,
        "cursor_lag_s": cursor_lag_s,
        "sync_interval_s": interval,
        "consecutive_failures": int(row.get("consecutive_failures") or 0),
        "breaker": "open" if now < int(row.get("open_until") or 0) else "closed",
    }
`,
    },
    typescript: {
      starter: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {get} from 'hub/store';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

export const STALE_AFTER_S = 3600;

app.get('/v1/connectors/:connectorId/health', async (request, reply) => {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const {connectorId} = request.params as {connectorId: string};
  const connector = await get(connectorId);
  if (connector === null) return reply.code(404).send({error: 'no such connector'});
  const row = await redis.hgetall(\`health:\${connectorId}\`);
  const lastRunAt = Number(row.last_run_at ?? 0);
  const fresh = Date.now() / 1000 - lastRunAt < STALE_AFTER_S;
  return {connector_id: connectorId, status: fresh ? 'healthy' : 'unhealthy', last_run_at: lastRunAt};
});
`,
      solution: `import Fastify from 'fastify';
import Redis from 'ioredis';

import {get} from 'hub/store';

export const app = Fastify();
const redis = new Redis({host: 'redis', port: 6379});

/** A connector is unhealthy once no page has landed in this many of its sync intervals. */
export const STALE_INTERVALS = 2;

app.get('/v1/connectors/:connectorId/health', async (request, reply) => {
  const {connectorId} = request.params as {connectorId: string};
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'X-Tenant-Id is required'});
  const connector = await get(connectorId);
  // Another tenant's connector and a missing one answer the same, so ids cannot be probed.
  if (connector === null || connector.tenant !== tenant) return reply.code(404).send({error: 'no such connector'});
  const row = await redis.hgetall(\`health:\${connectorId}\`);
  const now = Math.floor(Date.now() / 1000);
  const lastSuccessAt = row.last_success_at ? Number(row.last_success_at) : null;
  const lagS = lastSuccessAt === null ? null : now - lastSuccessAt;
  const interval = connector.sync_interval_s;
  let status = 'healthy';
  if (connector.status === 'disabled') status = 'disabled';
  else if (lagS === null || lagS > STALE_INTERVALS * interval) status = 'unhealthy';
  return {
    connector_id: connectorId,
    status,
    disabled_reason: connector.disabled_reason,
    last_success_at: lastSuccessAt,
    cursor_lag_s: lagS,
    sync_interval_s: interval,
    consecutive_failures: Number(row.consecutive_failures ?? 0),
    breaker: now < Number(row.open_until ?? 0) ? 'open' : 'closed',
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"hub/store" // store.Get
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const staleAfterS = 3600

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func connectorHealth(rw http.ResponseWriter, r *http.Request) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	connectorID := r.PathValue("id")
	if store.Get(r.Context(), connectorID) == nil {
		http.Error(rw, "no such connector", http.StatusNotFound)
		return
	}
	row := rdb.HGetAll(r.Context(), "health:"+connectorID).Val()
	lastRunAt, _ := strconv.ParseInt(row["last_run_at"], 10, 64)
	status := "unhealthy"
	if time.Now().Unix()-lastRunAt < staleAfterS {
		status = "healthy"
	}
	writeJSON(rw, http.StatusOK, map[string]any{"connector_id": connectorID, "status": status, "last_run_at": lastRunAt})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/connectors/{id}/health", connectorHealth)
}
`,
      solution: `package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"hub/store" // store.Get
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// staleIntervals: a connector is unhealthy once no page has landed in this many of its sync intervals.
const staleIntervals = 2

type healthView struct {
	ConnectorID         string \`json:"connector_id"\`
	Status              string \`json:"status"\`
	DisabledReason      string \`json:"disabled_reason"\`
	LastSuccessAt       *int64 \`json:"last_success_at"\`
	CursorLagS          *int64 \`json:"cursor_lag_s"\`
	SyncIntervalS       int    \`json:"sync_interval_s"\`
	ConsecutiveFailures int    \`json:"consecutive_failures"\`
	Breaker             string \`json:"breaker"\`
}

func writeJSON(rw http.ResponseWriter, status int, v any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(v)
}

func connectorHealth(rw http.ResponseWriter, r *http.Request) {
	connectorID := r.PathValue("id")
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		http.Error(rw, "X-Tenant-Id is required", http.StatusUnauthorized)
		return
	}
	connector := store.Get(r.Context(), connectorID)
	// Another tenant's connector and a missing one answer the same, so ids cannot be probed.
	if connector == nil || connector.Tenant != tenant {
		http.Error(rw, "no such connector", http.StatusNotFound)
		return
	}
	row := rdb.HGetAll(r.Context(), "health:"+connectorID).Val()
	now := time.Now().Unix()
	view := healthView{ConnectorID: connectorID, Status: "healthy", DisabledReason: connector.DisabledReason, SyncIntervalS: connector.SyncIntervalS, Breaker: "closed"}
	if text := row["last_success_at"]; text != "" {
		at, _ := strconv.ParseInt(text, 10, 64)
		lag := now - at
		view.LastSuccessAt = &at
		view.CursorLagS = &lag
	}
	failures, _ := strconv.Atoi(row["consecutive_failures"])
	view.ConsecutiveFailures = failures
	if openUntil, _ := strconv.ParseInt(row["open_until"], 10, 64); now < openUntil {
		view.Breaker = "open"
	}
	if connector.Status == "disabled" {
		view.Status = "disabled"
	} else if view.CursorLagS == nil || *view.CursorLagS > int64(staleIntervals*connector.SyncIntervalS) {
		view.Status = "unhealthy"
	}
	writeJSON(rw, http.StatusOK, view)
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/connectors/{id}/health", connectorHealth)
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

import hub.Store // Store.get

object Read {
  val StaleAfterS = 3600L

  val jedis = new JedisPooled("redis", 6379)

  val route: Route = path("v1" / "connectors" / Segment / "health") { connectorId =>
    get {
      // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
      Store.get(connectorId) match {
        case None => complete(StatusCodes.NotFound -> "no such connector")
        case Some(_) =>
          val row = jedis.hgetAll(s"health:$connectorId").asScala.toMap
          val lastRunAt = row.get("last_run_at").flatMap(_.toLongOption).getOrElse(0L)
          val fresh = System.currentTimeMillis() / 1000 - lastRunAt < StaleAfterS
          val body = JsObject(
            "connector_id" -> JsString(connectorId),
            "status" -> JsString(if (fresh) "healthy" else "unhealthy"),
            "last_run_at" -> JsNumber(lastRunAt))
          complete(HttpResponse(entity = HttpEntity(ContentTypes.\`application/json\`, body.compactPrint)))
      }
    }
  }
}
`,
      solution: `import org.apache.pekko.http.scaladsl.model.{ContentTypes, HttpEntity, HttpResponse, StatusCodes}
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

import hub.Store // Store.get

object Read {
  /** A connector is unhealthy once no page has landed in this many of its sync intervals. */
  val StaleIntervals = 2L

  val jedis = new JedisPooled("redis", 6379)

  private def view(connector: Store.Connector): JsObject = {
    val row = jedis.hgetAll(s"health:\${connector.connectorId}").asScala.toMap
    def number(name: String): Option[Long] = row.get(name).flatMap(_.toLongOption)
    val now = System.currentTimeMillis() / 1000
    val lastSuccessAt = number("last_success_at")
    val lagS = lastSuccessAt.map(now - _)
    val status =
      if (connector.status == "disabled") "disabled"
      else if (lagS.forall(_ > StaleIntervals * connector.syncIntervalS)) "unhealthy"
      else "healthy"
    JsObject(
      "connector_id" -> JsString(connector.connectorId),
      "status" -> JsString(status),
      "disabled_reason" -> JsString(connector.disabledReason),
      "last_success_at" -> lastSuccessAt.map(JsNumber(_)).getOrElse(JsNull),
      "cursor_lag_s" -> lagS.map(JsNumber(_)).getOrElse(JsNull),
      "sync_interval_s" -> JsNumber(connector.syncIntervalS),
      "consecutive_failures" -> JsNumber(number("consecutive_failures").getOrElse(0L)),
      "breaker" -> JsString(if (now < number("open_until").getOrElse(0L)) "open" else "closed"))
  }

  val route: Route = path("v1" / "connectors" / Segment / "health") { connectorId =>
    get {
      optionalHeaderValueByName("X-Tenant-Id") {
        case None | Some("") => complete(StatusCodes.Unauthorized -> "X-Tenant-Id is required")
        case Some(tenant) =>
          // Another tenant's connector and a missing one answer the same, so ids cannot be probed.
          Store.get(connectorId).filter(_.tenant == tenant) match {
            case None => complete(StatusCodes.NotFound -> "no such connector")
            case Some(connector) => complete(HttpResponse(entity = HttpEntity(ContentTypes.\`application/json\`, view(connector).compactPrint)))
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

#include <chrono>
#include <string>
#include <unordered_map>

#include "hub/store.h"  // store::get

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

constexpr long kStaleAfterS = 3600;

long nowS() { return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }

void connector_health(const httplib::Request& req, httplib::Response& res) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  const std::string connector_id = req.matches[1];
  if (!store::get(connector_id)) {
    res.status = 404;
    res.set_content("no such connector", "text/plain");
    return;
  }
  const std::unordered_map<std::string, std::string> row = redis.hgetall("health:" + connector_id);
  const long last_run_at = row.count("last_run_at") && !row.at("last_run_at").empty() ? std::stol(row.at("last_run_at")) : 0;
  const bool fresh = nowS() - last_run_at < kStaleAfterS;
  res.set_content(json{{"connector_id", connector_id}, {"status", fresh ? "healthy" : "unhealthy"}, {"last_run_at", last_run_at}}.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/connectors/([\\w-]+)/health)", connector_health); }
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <optional>
#include <string>
#include <unordered_map>

#include "hub/store.h"  // store::get

using json = nlohmann::json;

sw::redis::Redis redis("tcp://redis:6379");

// A connector is unhealthy once no page has landed in this many of its sync intervals.
constexpr long kStaleIntervals = 2;

long nowS() { return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }

void connector_health(const httplib::Request& req, httplib::Response& res) {
  const std::string connector_id = req.matches[1];
  const std::string tenant = req.get_header_value("X-Tenant-Id");
  if (tenant.empty()) {
    res.status = 401;
    res.set_content("X-Tenant-Id is required", "text/plain");
    return;
  }
  const auto connector = store::get(connector_id);
  // Another tenant's connector and a missing one answer the same, so ids cannot be probed.
  if (!connector || connector->tenant != tenant) {
    res.status = 404;
    res.set_content("no such connector", "text/plain");
    return;
  }
  const std::unordered_map<std::string, std::string> row = redis.hgetall("health:" + connector_id);
  const auto number = [&row](const char* name) -> std::optional<long> {
    if (!row.count(name) || row.at(name).empty()) return std::nullopt;
    return std::stol(row.at(name));
  };
  const long now = nowS();
  const std::optional<long> last_success_at = number("last_success_at");
  const std::optional<long> lag_s = last_success_at ? std::optional<long>(now - *last_success_at) : std::nullopt;
  std::string status = "healthy";
  if (connector->status == "disabled") {
    status = "disabled";
  } else if (!lag_s || *lag_s > kStaleIntervals * connector->sync_interval_s) {
    status = "unhealthy";
  }
  const json body = {{"connector_id", connector_id},
                     {"status", status},
                     {"disabled_reason", connector->disabled_reason},
                     {"last_success_at", last_success_at ? json(*last_success_at) : json(nullptr)},
                     {"cursor_lag_s", lag_s ? json(*lag_s) : json(nullptr)},
                     {"sync_interval_s", connector->sync_interval_s},
                     {"consecutive_failures", number("consecutive_failures").value_or(0)},
                     {"breaker", now < number("open_until").value_or(0) ? "open" : "closed"}};
  res.set_content(body.dump(), "application/json");
}

void register_routes(httplib::Server& svr) { svr.Get(R"(/v1/connectors/([\\w-]+)/health)", connector_health); }
`,
    },
  },
  harness: {
    python: `from hub import store


def _world(ctx):
    m = ctx.load("read")
    connector = store.create("acme", "github", "api.github.com", "vault:acme/github#4", 900)
    return ctx.client(m.app), connector["connector_id"], int(ctx.clock.time())


def _health(ctx, connector_id, **fields):
    ctx.redis.hset(f"health:{connector_id}", mapping=fields)


async def _get(c, connector_id, tenant="acme"):
    return await c.get(f"/v1/connectors/{connector_id}/health", headers={"X-Tenant-Id": tenant} if tenant else {})


async def _body(c, connector_id, what):
    r = await _get(c, connector_id)
    assert r.status_code == 200, f"GET /v1/connectors/{connector_id}/health {what} answered {r.status_code}: {r.text}"
    return r.json()


async def check_route(ctx):
    client, cid, now = _world(ctx)
    _health(ctx, cid, last_run_at=now - 60, last_success_at=now - 60, consecutive_failures=0, open_until=0, pages=4, records=8)
    async with client as c:
        body = await _body(c, cid, "for a connector synced a minute ago")
    assert body.get("connector_id") == cid and body.get("status") == "healthy", f"a connector synced a minute ago must read healthy, got {body}"


async def check_tenant_scope(ctx):
    client, cid, now = _world(ctx)
    other = store.create("globex", "slack", "slack.com", "vault:globex/slack#1", 900)["connector_id"]
    _health(ctx, other, last_run_at=now - 60, last_success_at=now - 60)
    async with client as c:
        anon = await _get(c, cid, tenant="")
        foreign = await _get(c, other)
        missing = await _get(c, "c-404")
    assert anon.status_code == 401, f"a health read without X-Tenant-Id answered {anon.status_code}, expected 401"
    assert foreign.status_code == 404, f"acme read globex's connector {other}: {foreign.status_code} {foreign.text}. Another tenant's connector must answer 404"
    assert missing.status_code == 404 and foreign.text == missing.text, f"another tenant's connector answered {foreign.status_code} {foreign.text!r}, a missing one {missing.status_code} {missing.text!r}: the two must be the same, or ids can be probed"


async def check_stale_from_success(ctx):
    client, cid, now = _world(ctx)
    # Every run fails, so last_run_at stays fresh; the last page landed three intervals ago.
    _health(ctx, cid, last_run_at=now - 30, last_success_at=now - 2700, consecutive_failures=3, open_until=0)
    daily = store.create("acme", "notion", "api.notion.com", "vault:acme/notion#1", 86400)["connector_id"]
    _health(ctx, daily, last_run_at=now - 7200, last_success_at=now - 7200, consecutive_failures=0, open_until=0)
    never = store.create("acme", "slack", "slack.com", "vault:acme/slack#1", 900)["connector_id"]
    _health(ctx, never, last_run_at=now - 30, consecutive_failures=1, open_until=0)
    async with client as c:
        failing = await _body(c, cid, "for a connector whose runs fail")
        quiet = await _body(c, daily, "for a daily connector")
        empty = await _body(c, never, "for a connector that never landed a page")
    assert failing.get("status") == "unhealthy", f"no page has landed for 2700 s, three sync intervals of 900 s, and the read says {failing}: a failed run moves last_run_at too. Measure from last_success_at"
    lag = failing.get("cursor_lag_s")
    assert isinstance(lag, int) and abs(lag - 2700) <= 5 and failing.get("sync_interval_s") == 900, f"the answer must carry cursor_lag_s (about 2700) and sync_interval_s 900, got {failing}"
    assert quiet.get("status") == "healthy", f"a daily connector whose last page landed 2 h ago reads {quiet}: staleness is two of its own sync intervals, not a fixed hour"
    assert empty.get("status") == "unhealthy" and empty.get("cursor_lag_s") is None, f"a connector that never landed a page must read unhealthy with no lag, got {empty}"


async def check_breaker_state(ctx):
    client, cid, now = _world(ctx)
    _health(ctx, cid, last_run_at=now - 5, last_success_at=now - 300, consecutive_failures=5, open_until=now + 20)
    async with client as c:
        body = await _body(c, cid, "with the breaker open")
        assert body.get("breaker") == "open" and body.get("consecutive_failures") == 5, f"five consecutive failures and open_until 20 s ahead read {body}: the answer must show breaker open and consecutive_failures 5"
        ctx.clock.advance(30)
        body = await _body(c, cid, "after the cooldown")
    assert body.get("breaker") == "closed", f"30 s later open_until has passed and the read says {body}, expected breaker closed"


async def check_disabled_status(ctx):
    client, cid, now = _world(ctx)
    _health(ctx, cid, last_run_at=now - 60, last_success_at=now - 60, consecutive_failures=0, open_until=0)
    store.disable(cid, "vendor rejected the OAuth token (401)")
    async with client as c:
        body = await _body(c, cid, "for a disabled connector")
    assert body.get("status") == "disabled", f"a connector disabled on a rejected token reads {body}: it syncs nothing until a human acts, and must say so"
    assert body.get("disabled_reason") == "vendor rejected the OAuth token (401)", f"the answer must carry the reason the connector was disabled, got {body}"
`,
    typescript: `async function world(ctx) {
  const m = ctx.load('read');
  const store = ctx.load('/support/hub/store.ts');
  const connector = await store.create('acme', 'github', 'api.github.com', 'vault:acme/github#4', 900);
  return {c: ctx.client(m.app), store, cid: connector.connector_id, now: Math.floor(ctx.clock.now() / 1000)};
}

function health(ctx, connectorId: string, fields: Record<string, number>) {
  ctx.redis.hset(\`health:\${connectorId}\`, ...Object.entries(fields).flat());
}

const read = (c, connectorId: string, tenant = 'acme') =>
  c.get(\`/v1/connectors/\${connectorId}/health\`, {headers: tenant === '' ? {} : {'X-Tenant-Id': tenant}});

async function body(c, connectorId: string, what: string) {
  const r = await read(c, connectorId);
  assert.equal(r.status, 200, \`GET /v1/connectors/\${connectorId}/health \${what} answered \${r.status}: \${r.text}\`);
  return r.json();
}

export async function check_route(ctx) {
  const {c, cid, now} = await world(ctx);
  health(ctx, cid, {last_run_at: now - 60, last_success_at: now - 60, consecutive_failures: 0, open_until: 0, pages: 4, records: 8});
  const b = await body(c, cid, 'for a connector synced a minute ago');
  assert(b.connector_id === cid && b.status === 'healthy', \`a connector synced a minute ago must read healthy, got \${JSON.stringify(b)}\`);
}

export async function check_tenant_scope(ctx) {
  const {c, store, cid, now} = await world(ctx);
  const other = (await store.create('globex', 'slack', 'slack.com', 'vault:globex/slack#1', 900)).connector_id;
  health(ctx, other, {last_run_at: now - 60, last_success_at: now - 60});
  const anon = await read(c, cid, '');
  const foreign = await read(c, other);
  const missing = await read(c, 'c-404');
  assert.equal(anon.status, 401, \`a health read without X-Tenant-Id answered \${anon.status}, expected 401\`);
  assert.equal(foreign.status, 404, \`acme read globex's connector \${other}: \${foreign.status} \${foreign.text}. Another tenant's connector must answer 404\`);
  assert(missing.status === 404 && foreign.text === missing.text, \`another tenant's connector answered \${foreign.status} \${JSON.stringify(foreign.text)}, a missing one \${missing.status} \${JSON.stringify(missing.text)}: the two must be the same, or ids can be probed\`);
}

export async function check_stale_from_success(ctx) {
  const {c, store, cid, now} = await world(ctx);
  // Every run fails, so last_run_at stays fresh; the last page landed three intervals ago.
  health(ctx, cid, {last_run_at: now - 30, last_success_at: now - 2700, consecutive_failures: 3, open_until: 0});
  const daily = (await store.create('acme', 'notion', 'api.notion.com', 'vault:acme/notion#1', 86400)).connector_id;
  health(ctx, daily, {last_run_at: now - 7200, last_success_at: now - 7200, consecutive_failures: 0, open_until: 0});
  const never = (await store.create('acme', 'slack', 'slack.com', 'vault:acme/slack#1', 900)).connector_id;
  health(ctx, never, {last_run_at: now - 30, consecutive_failures: 1, open_until: 0});
  const failing = await body(c, cid, 'for a connector whose runs fail');
  const quiet = await body(c, daily, 'for a daily connector');
  const empty = await body(c, never, 'for a connector that never landed a page');
  assert.equal(failing.status, 'unhealthy', \`no page has landed for 2700 s, three sync intervals of 900 s, and the read says \${JSON.stringify(failing)}: a failed run moves last_run_at too. Measure from last_success_at\`);
  assert(typeof failing.cursor_lag_s === 'number' && Math.abs(failing.cursor_lag_s - 2700) <= 5 && failing.sync_interval_s === 900, \`the answer must carry cursor_lag_s (about 2700) and sync_interval_s 900, got \${JSON.stringify(failing)}\`);
  assert.equal(quiet.status, 'healthy', \`a daily connector whose last page landed 2 h ago reads \${JSON.stringify(quiet)}: staleness is two of its own sync intervals, not a fixed hour\`);
  assert(empty.status === 'unhealthy' && (empty.cursor_lag_s ?? null) === null, \`a connector that never landed a page must read unhealthy with no lag, got \${JSON.stringify(empty)}\`);
}

export async function check_breaker_state(ctx) {
  const {c, cid, now} = await world(ctx);
  health(ctx, cid, {last_run_at: now - 5, last_success_at: now - 300, consecutive_failures: 5, open_until: now + 20});
  let b = await body(c, cid, 'with the breaker open');
  assert(b.breaker === 'open' && b.consecutive_failures === 5, \`five consecutive failures and open_until 20 s ahead read \${JSON.stringify(b)}: the answer must show breaker open and consecutive_failures 5\`);
  ctx.clock.advance(30);
  b = await body(c, cid, 'after the cooldown');
  assert.equal(b.breaker, 'closed', \`30 s later open_until has passed and the read says \${JSON.stringify(b)}, expected breaker closed\`);
}

export async function check_disabled_status(ctx) {
  const {c, store, cid, now} = await world(ctx);
  health(ctx, cid, {last_run_at: now - 60, last_success_at: now - 60, consecutive_failures: 0, open_until: 0});
  await store.disable(cid, 'vendor rejected the OAuth token (401)');
  const b = await body(c, cid, 'for a disabled connector');
  assert.equal(b.status, 'disabled', \`a connector disabled on a rejected token reads \${JSON.stringify(b)}: it syncs nothing until a human acts, and must say so\`);
  assert.equal(b.disabled_reason, 'vendor rejected the OAuth token (401)', \`the answer must carry the reason the connector was disabled, got \${JSON.stringify(b)}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"math"
	"net/http"

	"hub/store"

	"leetbuild/harness"
)

var readBg = context.Background()

func readWorld(ctx *harness.Ctx) (*harness.HTTP, string, int64) {
	mux := http.NewServeMux()
	register(mux)
	cid := store.Create(readBg, "acme", "github", "api.github.com", "vault:acme/github#4", 900).ConnectorID
	return ctx.HTTP(mux), cid, ctx.Clock.Now() / 1000
}

func seedHealth(ctx *harness.Ctx, connectorID string, fields map[string]int64) {
	args := []any{"HSET", "health:" + connectorID}
	for k, v := range fields {
		args = append(args, k, v)
	}
	ctx.Redis.Do(args...)
}

func readHealth(c *harness.HTTP, connectorID, tenant string) *harness.Response {
	if tenant == "" {
		return c.Get("/v1/connectors/" + connectorID + "/health")
	}
	return c.Get("/v1/connectors/"+connectorID+"/health", "X-Tenant-Id", tenant)
}

func healthBody(ctx *harness.Ctx, c *harness.HTTP, connectorID, what string) map[string]any {
	r := readHealth(c, connectorID, "acme")
	ctx.Equal(r.Status, 200, "GET /v1/connectors/%s/health %s (%s)", connectorID, what, r.Text())
	var body map[string]any
	r.Decode(&body)
	return body
}

func CheckRoute(ctx *harness.Ctx) {
	c, cid, now := readWorld(ctx)
	seedHealth(ctx, cid, map[string]int64{"last_run_at": now - 60, "last_success_at": now - 60, "consecutive_failures": 0, "open_until": 0, "pages": 4, "records": 8})
	body := healthBody(ctx, c, cid, "for a connector synced a minute ago")
	ctx.Assert(body["connector_id"] == cid && body["status"] == "healthy", "a connector synced a minute ago must read healthy, got %v", body)
}

func CheckTenantScope(ctx *harness.Ctx) {
	c, cid, now := readWorld(ctx)
	other := store.Create(readBg, "globex", "slack", "slack.com", "vault:globex/slack#1", 900).ConnectorID
	seedHealth(ctx, other, map[string]int64{"last_run_at": now - 60, "last_success_at": now - 60})
	anon := readHealth(c, cid, "")
	foreign := readHealth(c, other, "acme")
	missing := readHealth(c, "c-404", "acme")
	ctx.Equal(anon.Status, 401, "a health read without X-Tenant-Id")
	ctx.Equal(foreign.Status, 404, "acme read globex's connector %s (%s): another tenant's connector", other, foreign.Text())
	ctx.Assert(missing.Status == 404 && foreign.Text() == missing.Text(), "another tenant's connector answered %d %q, a missing one %d %q: the two must be the same, or ids can be probed", foreign.Status, foreign.Text(), missing.Status, missing.Text())
}

func CheckStaleFromSuccess(ctx *harness.Ctx) {
	c, cid, now := readWorld(ctx)
	// Every run fails, so last_run_at stays fresh; the last page landed three intervals ago.
	seedHealth(ctx, cid, map[string]int64{"last_run_at": now - 30, "last_success_at": now - 2700, "consecutive_failures": 3, "open_until": 0})
	daily := store.Create(readBg, "acme", "notion", "api.notion.com", "vault:acme/notion#1", 86400).ConnectorID
	seedHealth(ctx, daily, map[string]int64{"last_run_at": now - 7200, "last_success_at": now - 7200, "consecutive_failures": 0, "open_until": 0})
	never := store.Create(readBg, "acme", "slack", "slack.com", "vault:acme/slack#1", 900).ConnectorID
	seedHealth(ctx, never, map[string]int64{"last_run_at": now - 30, "consecutive_failures": 1, "open_until": 0})
	failing := healthBody(ctx, c, cid, "for a connector whose runs fail")
	quiet := healthBody(ctx, c, daily, "for a daily connector")
	empty := healthBody(ctx, c, never, "for a connector that never landed a page")
	ctx.Equal(failing["status"], "unhealthy", "no page has landed for 2700 s, three sync intervals of 900 s (%v): a failed run moves last_run_at too. Measure from last_success_at; the status", failing)
	lag, ok := failing["cursor_lag_s"].(float64)
	ctx.Assert(ok && math.Abs(lag-2700) <= 5 && failing["sync_interval_s"] == float64(900), "the answer must carry cursor_lag_s (about 2700) and sync_interval_s 900, got %v", failing)
	ctx.Equal(quiet["status"], "healthy", "a daily connector whose last page landed 2 h ago (%v): staleness is two of its own sync intervals, not a fixed hour; the status", quiet)
	ctx.Assert(empty["status"] == "unhealthy" && empty["cursor_lag_s"] == nil, "a connector that never landed a page must read unhealthy with no lag, got %v", empty)
}

func CheckBreakerState(ctx *harness.Ctx) {
	c, cid, now := readWorld(ctx)
	seedHealth(ctx, cid, map[string]int64{"last_run_at": now - 5, "last_success_at": now - 300, "consecutive_failures": 5, "open_until": now + 20})
	body := healthBody(ctx, c, cid, "with the breaker open")
	ctx.Assert(body["breaker"] == "open" && body["consecutive_failures"] == float64(5), "five consecutive failures and open_until 20 s ahead read %v: the answer must show breaker open and consecutive_failures 5", body)
	ctx.Clock.Advance(30)
	body = healthBody(ctx, c, cid, "after the cooldown")
	ctx.Equal(body["breaker"], "closed", "30 s later open_until has passed (%v); the breaker", fmt.Sprint(body))
}

func CheckDisabledStatus(ctx *harness.Ctx) {
	c, cid, now := readWorld(ctx)
	seedHealth(ctx, cid, map[string]int64{"last_run_at": now - 60, "last_success_at": now - 60, "consecutive_failures": 0, "open_until": 0})
	store.Disable(readBg, cid, "vendor rejected the OAuth token (401)")
	body := healthBody(ctx, c, cid, "for a disabled connector")
	ctx.Equal(body["status"], "disabled", "a connector disabled on a rejected token syncs nothing until a human acts, and must say so (%v); the status", body)
	ctx.Equal(body["disabled_reason"], "vendor rejected the OAuth token (401)", "the reason the connector was disabled")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <cmath>
#include <map>
#include <string>

namespace {

struct World {
  harness::HTTP c;
  std::string cid;
  long long now;
};

World readWorld(harness::Ctx& ctx) {
  static httplib::Server* svr = nullptr;
  delete svr;
  svr = new httplib::Server;
  register_routes(*svr);
  const std::string cid = store::create("acme", "github", "api.github.com", "vault:acme/github#4", 900).connector_id;
  return World{ctx.HTTP(*svr), cid, ctx.Clock.Now() / 1000};
}

void seedHealth(harness::Ctx& ctx, const std::string& connector_id, const std::map<std::string, long long>& fields) {
  for (const auto& [k, v] : fields) ctx.Redis.Do("HSET", "health:" + connector_id, k, v);
}

harness::Response readHealth(harness::HTTP& c, const std::string& connector_id, const std::string& tenant) {
  if (tenant.empty()) return c.Get("/v1/connectors/" + connector_id + "/health");
  return c.Get("/v1/connectors/" + connector_id + "/health", "X-Tenant-Id", tenant);
}

nlohmann::json healthBody(harness::Ctx& ctx, harness::HTTP& c, const std::string& connector_id, const std::string& what) {
  const auto r = readHealth(c, connector_id, "acme");
  ctx.Equal(r.Status, 200, "GET /v1/connectors/%s/health %s (%s)", connector_id, what, r.Text());
  try {
    return nlohmann::json::parse(r.Text());
  } catch (const std::exception&) {
    ctx.Fatalf("the answer is not JSON: %s", r.Text());
  }
}

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  World w = readWorld(ctx);
  seedHealth(ctx, w.cid, {{"last_run_at", w.now - 60}, {"last_success_at", w.now - 60}, {"consecutive_failures", 0}, {"open_until", 0}, {"pages", 4}, {"records", 8}});
  const auto body = healthBody(ctx, w.c, w.cid, "for a connector synced a minute ago");
  ctx.Assert(body.value("connector_id", "") == w.cid && body.value("status", "") == "healthy", "a connector synced a minute ago must read healthy, got %s", body.dump());
}

void CheckTenantScope(harness::Ctx& ctx) {
  World w = readWorld(ctx);
  const std::string other = store::create("globex", "slack", "slack.com", "vault:globex/slack#1", 900).connector_id;
  seedHealth(ctx, other, {{"last_run_at", w.now - 60}, {"last_success_at", w.now - 60}});
  const auto anon = readHealth(w.c, w.cid, "");
  const auto foreign = readHealth(w.c, other, "acme");
  const auto missing = readHealth(w.c, "c-404", "acme");
  ctx.Equal(anon.Status, 401, "a health read without X-Tenant-Id");
  ctx.Equal(foreign.Status, 404, "acme read globex's connector %s (%s): another tenant's connector", other, foreign.Text());
  ctx.Assert(missing.Status == 404 && foreign.Text() == missing.Text(), "another tenant's connector answered %d %q, a missing one %d %q: the two must be the same, or ids can be probed",
             foreign.Status, foreign.Text(), missing.Status, missing.Text());
}

void CheckStaleFromSuccess(harness::Ctx& ctx) {
  World w = readWorld(ctx);
  // Every run fails, so last_run_at stays fresh; the last page landed three intervals ago.
  seedHealth(ctx, w.cid, {{"last_run_at", w.now - 30}, {"last_success_at", w.now - 2700}, {"consecutive_failures", 3}, {"open_until", 0}});
  const std::string daily = store::create("acme", "notion", "api.notion.com", "vault:acme/notion#1", 86400).connector_id;
  seedHealth(ctx, daily, {{"last_run_at", w.now - 7200}, {"last_success_at", w.now - 7200}, {"consecutive_failures", 0}, {"open_until", 0}});
  const std::string never = store::create("acme", "slack", "slack.com", "vault:acme/slack#1", 900).connector_id;
  seedHealth(ctx, never, {{"last_run_at", w.now - 30}, {"consecutive_failures", 1}, {"open_until", 0}});
  const auto failing = healthBody(ctx, w.c, w.cid, "for a connector whose runs fail");
  const auto quiet = healthBody(ctx, w.c, daily, "for a daily connector");
  const auto empty = healthBody(ctx, w.c, never, "for a connector that never landed a page");
  ctx.Equal(failing.value("status", ""), "unhealthy", "no page has landed for 2700 s, three sync intervals of 900 s (%s): a failed run moves last_run_at too. Measure from last_success_at; the status", failing.dump());
  const bool lagged = failing.contains("cursor_lag_s") && failing["cursor_lag_s"].is_number() && std::abs(failing["cursor_lag_s"].get<double>() - 2700) <= 5;
  ctx.Assert(lagged && failing.value("sync_interval_s", 0) == 900, "the answer must carry cursor_lag_s (about 2700) and sync_interval_s 900, got %s", failing.dump());
  ctx.Equal(quiet.value("status", ""), "healthy", "a daily connector whose last page landed 2 h ago (%s): staleness is two of its own sync intervals, not a fixed hour; the status", quiet.dump());
  ctx.Assert(empty.value("status", "") == "unhealthy" && (!empty.contains("cursor_lag_s") || empty["cursor_lag_s"].is_null()),
             "a connector that never landed a page must read unhealthy with no lag, got %s", empty.dump());
}

void CheckBreakerState(harness::Ctx& ctx) {
  World w = readWorld(ctx);
  seedHealth(ctx, w.cid, {{"last_run_at", w.now - 5}, {"last_success_at", w.now - 300}, {"consecutive_failures", 5}, {"open_until", w.now + 20}});
  auto body = healthBody(ctx, w.c, w.cid, "with the breaker open");
  ctx.Assert(body.value("breaker", "") == "open" && body.value("consecutive_failures", 0) == 5,
             "five consecutive failures and open_until 20 s ahead read %s: the answer must show breaker open and consecutive_failures 5", body.dump());
  ctx.Clock.Advance(30);
  body = healthBody(ctx, w.c, w.cid, "after the cooldown");
  ctx.Equal(body.value("breaker", ""), "closed", "30 s later open_until has passed (%s); the breaker", body.dump());
}

void CheckDisabledStatus(harness::Ctx& ctx) {
  World w = readWorld(ctx);
  seedHealth(ctx, w.cid, {{"last_run_at", w.now - 60}, {"last_success_at", w.now - 60}, {"consecutive_failures", 0}, {"open_until", 0}});
  store::disable(w.cid, "vendor rejected the OAuth token (401)");
  const auto body = healthBody(ctx, w.c, w.cid, "for a disabled connector");
  ctx.Equal(body.value("status", ""), "disabled", "a connector disabled on a rejected token syncs nothing until a human acts, and must say so (%s); the status", body.dump());
  ctx.Equal(body.value("disabled_reason", ""), "vendor rejected the OAuth token (401)", "the reason the connector was disabled");
}
`,
  },
  hints: [
    "Read another tenant's connector: it answers. Make every run fail while the last page landed hours ago: the read says healthy. Open the breaker or disable the connector: the answer looks the same.",
    "The handler never reads `X-Tenant-Id`, and it measures freshness from `last_run_at`, which every attempt moves whether a page landed or not, against a fixed hour rather than the connector's own interval. It reads neither the breaker fields nor the registry status.",
    'Check the tenant (401, then 404 when `connector["tenant"]` differs); compute `cursor_lag_s` from `last_success_at` against `STALE_INTERVALS * sync_interval_s`; report `breaker` from `open_until` and `consecutive_failures`; answer `disabled` with `disabled_reason` first.',
  ],
  debrief: `The read is useful because it measures the one thing users care about, the time since data last arrived, in units of the interval the connector promised, and because it reports the breaker and the disable reason separately: "waiting out a vendor outage" and "needs a human" call for different pages to different people. Scoping to the tenant with one 404 for both foreign and missing ids keeps a status page from becoming an enumeration oracle. Production hubs export the lag as a metric, so the alert is a threshold in the monitoring system rather than someone polling this endpoint.`,
};
