import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/connectors/{id}/health: lag you can alert on',
  concept: 'http',
  file: 'read',
  focus: ['client', 'hub', 'redis'],
  task: `## Task

The starter is a plausible model-generated draft: a health response comes back and the dashboard
shows a green connector. It authorizes nothing, it measures the wrong clock, and it hides the reason
a connector is failing. Find the flaws, fix them, and prove the fix.

Implement \`GET /v1/connectors/{id}/health\`, the endpoint on-call alerts on:

- The connector is authorized against the **authenticated tenant**: a connector that belongs to
  another tenant, or does not exist, answers **404** — the same answer for both, so ids cannot be
  probed. The draft serves any id in the path.
- The read reports **last successful page time** (\`last_success_at\`), the **cursor lag**
  (\`cursor_lag_s = now − last_success_at\`), \`consecutive_failures\`, \`breaker\` state and the
  connector's \`sync_interval_s\`.
- The verdict turns **\`unhealthy\`** when no page has landed in **twice** the connector's
  configured sync interval (\`STALE_INTERVALS = 2\`): \`cursor_lag_s > STALE_INTERVALS ×
  sync_interval_s\`, or no successful page at all. Staleness is measured from the last **successful**
  page, never from the last run: a run that failed every page is not fresh.
- The **breaker state** is exposed (\`closed\`/\`open\`), so an operator can tell "the vendor is
  down, we are backing off" from "the connector is broken".

**Failure mode the checks target.** \`last_run_at\` is the trap: it moves on every attempt, so a
connector whose every page fails reports healthy forever while it syncs nothing — the alert that
should have fired never does. Hiding the breaker state removes the difference between a connector
that is waiting out a vendor outage and one that needs a human. And serving any id means a caller can
read another tenant's connector ids and their lag, which is an authorization bug in an endpoint that
looks like a read-only status page.`,
  sequence: {
    participants: ['Operator', 'Connector Hub', 'connector store', 'Redis'],
    messages: [
      {from: 'Operator', to: 'Connector Hub', label: 'GET /v1/connectors/conn-1/health · X-Tenant-Id', kind: 'sync'},
      {from: 'Connector Hub', to: 'connector store', label: 'owner_of(conn-1)', kind: 'sync'},
      {from: 'connector store', to: 'Connector Hub', label: 'acme / nil → 404', kind: 'reply'},
      {from: 'Connector Hub', to: 'Redis', label: 'HGETALL connector:conn-1:health', kind: 'sync'},
      {from: 'Redis', to: 'Connector Hub', label: 'last_success_at · consecutive_failures · breaker', kind: 'reply'},
      {from: 'Connector Hub', to: 'Connector Hub', label: 'lag > 2 × sync_interval_s → unhealthy', kind: 'sync'},
      {
        from: 'Connector Hub',
        to: 'Operator',
        label: '{status, last_success_at, cursor_lag_s, consecutive_failures, breaker}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Serves GET /v1/connectors/{id}/health',
      detail: 'Register the health read on `GET /v1/connectors/{id}/health`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/connectors\/\{id\}\/health["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/connectors\/:id\/health['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/connectors\/\{id\}\/health"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"connectors"\s*\/\s*Segment\s*\/\s*"health"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(/, /\/v1\/connectors\//, /health/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Scopes the health read to the authenticated tenant',
      detail:
        'The connector is authorized against the request tenant before its health is read, and a foreign or unknown connector answers **404**. The draft serves any connector id in the path.',
      match: {
        python: {all: [/owner_of\(/, /status_code\s*=\s*404/]},
        typescript: {all: [/ownerOf\(/, /code\(\s*404\s*\)/]},
        go: {all: [/OwnerOf\(/, /StatusNotFound/]},
        scala: {all: [/ownerOf\(/, /StatusCodes\.NotFound/]},
        cpp: {all: [/owner_of\(/, /\b404\b/]},
      },
    },
    {
      id: 'stale-unhealthy',
      title: 'Turns unhealthy a page-lag behind, not a run behind',
      detail:
        'The verdict is measured from the last **successful** page against `STALE_INTERVALS = 2` sync intervals, and reports `unhealthy` when the lag exceeds it. The draft measures from `last_run_at`, which moves on every failed attempt, so a connector that syncs nothing reads healthy forever.',
      match: {
        python: {all: [/STALE_INTERVALS\s*=\s*2/, /last_success_at/, /unhealthy/]},
        typescript: {all: [/STALE_INTERVALS\s*=\s*2/, /lastSuccessAt/, /unhealthy/]},
        go: {all: [/staleIntervals\s*=\s*2/, /LastSuccessAt/, /unhealthy/]},
        scala: {all: [/StaleIntervals\s*=\s*2/, /lastSuccessAt/, /unhealthy/]},
        cpp: {all: [/kStaleIntervals\s*=\s*2/, /last_success_at/, /unhealthy/]},
      },
    },
    {
      id: 'breaker-state',
      title: 'Exposes the breaker state and the failure count',
      detail:
        'The body carries `breaker` (`closed`/`open`) and `consecutive_failures`, so an operator can separate "waiting out a vendor outage" from "needs a human". The draft hides both.',
      match: {
        python: {all: [/consecutive_failures/, /breaker/]},
        typescript: {all: [/consecutive_failures/, /breaker/]},
        go: {all: [/consecutive_failures/, /Breaker/]},
        scala: {all: [/consecutive_failures/, /breaker/]},
        cpp: {all: [/consecutive_failures/, /breaker/]},
      },
    },
    {
      id: 'lag-field',
      title: 'Reports the cursor lag against the sync interval',
      detail:
        "`cursor_lag_s` is reported alongside the connector's `sync_interval_s`, so the lag means something to the person reading the alert. The draft reports only a run timestamp.",
      match: {
        python: {all: [/cursor_lag_s/, /sync_interval_s/]},
        typescript: {all: [/cursor_lag_s/, /sync_interval_s/]},
        go: {all: [/cursor_lag_s/, /sync_interval_s/]},
        scala: {all: [/cursor_lag_s/, /sync_interval_s/]},
        cpp: {all: [/cursor_lag_s/, /sync_interval_s/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import redis
from fastapi import FastAPI, Header
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Health(BaseModel):
    status: str


@app.get("/v1/connectors/{id}/health")
def health(id: str, tenant: str = Header(alias="X-Tenant-Id")) -> dict:
    # TODO: this draft trusts the path id, judges freshness from last_run_at (which moves on every
    # failed attempt), and hides the breaker. Authorize the connector against the tenant, measure
    # staleness from the last successful page against twice the sync interval, and expose the
    # breaker state.
    row = r.hgetall(f"connector:{id}:health")
    last_run_at = int(row.get("last_run_at", 0))
    return {
        "connector_id": id,
        "status": "healthy" if time.time() - last_run_at < 3600 else "stale",
        "last_run_at": last_run_at,
    }
`,
      solution: `import time

import redis
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

# A connector is unhealthy once no page has landed in twice its configured sync interval.
STALE_INTERVALS = 2
DEFAULT_SYNC_INTERVAL_S = 900


class Health(BaseModel):
    status: str


class ConnectorStore:
    def owner_of(self, connector_id: str) -> str | None:
        """The tenant that owns this connector, or None when it does not exist."""
        raise NotImplementedError


store = ConnectorStore()


def read_health(tenant: str, connector_id: str) -> dict:
    owner = store.owner_of(connector_id)
    if owner is None or owner != tenant:
        raise HTTPException(status_code=404, detail="connector not found")

    row = r.hgetall(f"connector:{connector_id}:health")
    interval_s = int(row.get("sync_interval_s", DEFAULT_SYNC_INTERVAL_S))
    last_success_at = int(row["last_success_at"]) if row.get("last_success_at") else None
    cursor_lag_s = None if last_success_at is None else int(time.time()) - last_success_at
    stale = cursor_lag_s is None or cursor_lag_s > STALE_INTERVALS * interval_s
    return {
        "connector_id": connector_id,
        "status": "unhealthy" if stale else "healthy",
        "last_success_at": last_success_at,
        "cursor_lag_s": cursor_lag_s,
        "consecutive_failures": int(row.get("consecutive_failures", 0)),
        "breaker": row.get("breaker", "closed"),
        "sync_interval_s": interval_s,
    }


@app.get("/v1/connectors/{id}/health")
def health(id: str, tenant: str | None = Header(default=None, alias="X-Tenant-Id")) -> dict:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    return read_health(tenant, id)
`,
    },
    typescript: {
      starter: `/** GET /v1/connectors/{id}/health: a model-generated draft that trusts the path id. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

app.get('/v1/connectors/:id/health', async (request, reply) => {
  // TODO: this draft trusts the path id, judges freshness from last_run_at (which moves on every
  // failed attempt), and hides the breaker. Authorize the connector against the tenant, measure
  // staleness from the last successful page against twice the sync interval, and expose the breaker
  // state.
  const {id} = request.params as {id: string};
  const row = await r.hgetall(\`connector:\${id}:health\`);
  const lastRunAt = Number(row.last_run_at ?? 0);
  const fresh = Date.now() / 1000 - lastRunAt < 3600;
  return reply.code(200).send({connector_id: id, status: fresh ? 'healthy' : 'stale', last_run_at: lastRunAt});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/connectors/{id}/health: tenant-scoped, measured from the last successful page. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

import {store} from './store';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

/** A connector is unhealthy once no page has landed in twice its configured sync interval. */
const STALE_INTERVALS = 2;
const DEFAULT_SYNC_INTERVAL_S = 900;

app.get('/v1/connectors/:id/health', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '') return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {id} = request.params as {id: string};

  const owner = await store.ownerOf(id);
  if (owner === null || owner !== tenant) return reply.code(404).send({error: 'connector not found'});

  const row = await r.hgetall(\`connector:\${id}:health\`);
  const intervalS = Number(row.sync_interval_s ?? DEFAULT_SYNC_INTERVAL_S);
  const lastSuccessAt = row.last_success_at === undefined ? null : Number(row.last_success_at);
  const cursorLagS = lastSuccessAt === null ? null : Math.floor(Date.now() / 1000) - lastSuccessAt;
  const stale = cursorLagS === null || cursorLagS > STALE_INTERVALS * intervalS;
  return reply.code(200).send({
    connector_id: id,
    status: stale ? 'unhealthy' : 'healthy',
    last_success_at: lastSuccessAt,
    cursor_lag_s: cursorLagS,
    consecutive_failures: Number(row.consecutive_failures ?? 0),
    breaker: row.breaker ?? 'closed',
    sync_interval_s: intervalS,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

var rdb *redis.Client

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func health(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft trusts the path id, judges freshness from last_run_at (which moves on every
	// failed attempt), and hides the breaker. Authorize the connector against the tenant, measure
	// staleness from the last successful page against twice the sync interval, and expose the
	// breaker state.
	id := r.PathValue("id")
	row, _ := rdb.HGetAll(r.Context(), "connector:"+id+":health").Result()
	lastRunAt := atoiDefault(row["last_run_at"], 0)
	status := "stale"
	if time.Now().Unix()-int64(lastRunAt) < 3600 {
		status = "healthy"
	}
	writeJSON(rw, http.StatusOK, map[string]any{"connector_id": id, "status": status, "last_run_at": lastRunAt})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/connectors/{id}/health", health)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// A connector is unhealthy once no page has landed in twice its configured sync interval.
const (
	staleIntervals        = 2
	defaultSyncIntervalS  = 900
)

var rdb *redis.Client

type ConnectorStore struct{}

func (s *ConnectorStore) OwnerOf(ctx context.Context, connectorID string) (string, bool) {
	return "", false
}

var store = &ConnectorStore{}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func atoiDefault(raw string, fallback int) int {
	if value, err := strconv.Atoi(raw); err == nil {
		return value
	}
	return fallback
}

type Health struct {
	ConnectorID         string \`json:"connector_id"\`
	Status              string \`json:"status"\`
	LastSuccessAt       *int64 \`json:"last_success_at"\`
	CursorLagS          *int64 \`json:"cursor_lag_s"\`
	ConsecutiveFailures int    \`json:"consecutive_failures"\`
	Breaker             string \`json:"breaker"\`
	SyncIntervalS       int    \`json:"sync_interval_s"\`
}

func health(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	id := r.PathValue("id")
	owner, ok := store.OwnerOf(r.Context(), id)
	if !ok || owner != tenant {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "connector not found"})
		return
	}
	row, err := rdb.HGetAll(r.Context(), "connector:"+id+":health").Result()
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	intervalS := atoiDefault(row["sync_interval_s"], defaultSyncIntervalS)
	var lastSuccessAt *int64
	if raw, present := row["last_success_at"]; present && raw != "" {
		value := int64(atoiDefault(raw, 0))
		lastSuccessAt = &value
	}
	var cursorLagS *int64
	if lastSuccessAt != nil {
		value := time.Now().Unix() - *lastSuccessAt
		cursorLagS = &value
	}
	status := "healthy"
	if cursorLagS == nil || *cursorLagS > int64(staleIntervals*intervalS) {
		status = "unhealthy"
	}
	breaker := row["breaker"]
	if breaker == "" {
		breaker = "closed"
	}
	writeJSON(rw, http.StatusOK, Health{
		ConnectorID:         id,
		Status:              status,
		LastSuccessAt:       lastSuccessAt,
		CursorLagS:          cursorLagS,
		ConsecutiveFailures: atoiDefault(row["consecutive_failures"], 0),
		Breaker:             breaker,
		SyncIntervalS:       intervalS,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/connectors/{id}/health", health)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis

object HealthApi {
  implicit val system: ActorSystem = ActorSystem("connector-hub")
  val jedis = new Jedis("redis", 6379)

  val route: Route =
    path("v1" / "connectors" / Segment / "health") {
      get {
        headerValueByName("X-Tenant-Id") { tenant =>
          // TODO: this draft trusts the path segment, judges freshness from last_run_at (which moves
          // on every failed attempt), and hides the breaker. Authorize the connector against the
          // tenant, measure staleness from the last successful page against twice the sync
          // interval, and expose the breaker state.
          val row = jedis.hgetAll(s"connector:$tenant:health")
          val lastRunAt = Option(row.get("last_run_at")).map(_.toLong).getOrElse(0L)
          val fresh = System.currentTimeMillis() / 1000 - lastRunAt < 3600
          complete(StatusCodes.OK, s"""{"status":"\${if (fresh) "healthy" else "stale"}","last_run_at":$lastRunAt}""")
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
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis

object HealthApi {
  implicit val system: ActorSystem = ActorSystem("connector-hub")
  val jedis = new Jedis("redis", 6379)

  // A connector is unhealthy once no page has landed in twice its configured sync interval.
  val StaleIntervals = 2
  val DefaultSyncIntervalS = 900

  val store = ConnectorStore.open()

  val route: Route =
    path("v1" / "connectors" / Segment / "health") { connectorId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            val tenant = tenantOpt.get
            store.ownerOf(connectorId) match {
              case Some(owner) if owner == tenant =>
                val row = jedis.hgetAll(s"connector:$connectorId:health")
                val intervalS = Option(row.get("sync_interval_s")).map(_.toInt).getOrElse(DefaultSyncIntervalS)
                val lastSuccessAt = Option(row.get("last_success_at")).filter(_.nonEmpty).map(_.toLong)
                val cursorLagS = lastSuccessAt.map(at => System.currentTimeMillis() / 1000 - at)
                val stale = cursorLagS.forall(lag => lag > (StaleIntervals * intervalS).toLong)
                val failures = Option(row.get("consecutive_failures")).map(_.toInt).getOrElse(0)
                val breaker = Option(row.get("breaker")).getOrElse("closed")
                complete(
                  StatusCodes.OK,
                  s"""{"connector_id":"$connectorId","status":"\${if (stale) "unhealthy" else "healthy"}","last_success_at":\${lastSuccessAt.getOrElse(0)},"cursor_lag_s":\${cursorLagS.getOrElse(-1)},"consecutive_failures":$failures,"breaker":"$breaker","sync_interval_s":$intervalS}"""
                )
              case _ =>
                complete(StatusCodes.NotFound, """{"error":"connector not found"}""")
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
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

using json = nlohmann::json;

int main() {
  httplib::Server svr;
  sw::redis::Redis redis("tcp://redis:6379");

  svr.Get("/v1/connectors/([^/]+)/health", [&](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft trusts the path id, judges freshness from last_run_at (which moves on every
    // failed attempt), and hides the breaker. Authorize the connector against the tenant, measure
    // staleness from the last successful page against twice the sync interval, and expose the
    // breaker state.
    const auto connectorId = req.matches[1];
    const auto row = redis.hgetall("connector:" + connectorId + ":health");
    const auto lastRunAt = row.count("last_run_at") ? std::stoll(row.at("last_run_at")) : 0LL;
    const auto now = std::chrono::duration_cast<std::chrono::seconds>(
                         std::chrono::system_clock::now().time_since_epoch())
                         .count();
    res.status = 200;
    res.set_content(json{{"connector_id", connectorId}, {"status", now - lastRunAt < 3600 ? "healthy" : "stale"}}
                            .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <string>

using json = nlohmann::json;

// A connector is unhealthy once no page has landed in twice its configured sync interval.
constexpr int kStaleIntervals = 2;
constexpr int kDefaultSyncIntervalS = 900;

struct ConnectorStore {
  std::optional<std::string> owner_of(const std::string& connectorId);
};

ConnectorStore store;

int main() {
  httplib::Server svr;
  sw::redis::Redis redis("tcp://redis:6379");

  svr.Get("/v1/connectors/([^/]+)/health", [&](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const auto connectorId = req.matches[1].str();
    const auto owner = store.owner_of(connectorId);
    if (!owner || *owner != tenant) {
      res.status = 404;
      res.set_content(R"({"error":"connector not found"})", "application/json");
      return;
    }
    const auto row = redis.hgetall("connector:" + connectorId + ":health");
    const int intervalS =
        row.count("sync_interval_s") ? std::stoi(row.at("sync_interval_s")) : kDefaultSyncIntervalS;
    const bool hasSuccess = row.count("last_success_at") && !row.at("last_success_at").empty();
    const long long lastSuccessAt = hasSuccess ? std::stoll(row.at("last_success_at")) : 0;
    const long long now = std::chrono::duration_cast<std::chrono::seconds>(
                              std::chrono::system_clock::now().time_since_epoch())
                              .count();
    const long long cursorLagS = hasSuccess ? now - lastSuccessAt : -1;
    const bool stale = !hasSuccess || cursorLagS > static_cast<long long>(kStaleIntervals) * intervalS;
    const auto failures =
        row.count("consecutive_failures") ? std::stoi(row.at("consecutive_failures")) : 0;
    const auto breaker = row.count("breaker") ? row.at("breaker") : std::string("closed");
    res.status = 200;
    res.set_content(json{{"connector_id", connectorId},
                         {"status", stale ? "unhealthy" : "healthy"},
                         {"last_success_at", lastSuccessAt},
                         {"cursor_lag_s", cursorLagS},
                         {"consecutive_failures", failures},
                         {"breaker", breaker},
                         {"sync_interval_s", intervalS}}
                            .dump(),
                    "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'Authorize the read like a write: fetch the connector row under the authenticated tenant first and answer `404` for both "missing" and "someone else\'s", so the endpoint cannot be used to enumerate connector ids.',
    'Staleness is measured from the last **successful** page: `cursor_lag_s = now − last_success_at`, and the connector is `unhealthy` once that exceeds `STALE_INTERVALS × sync_interval_s`. `last_run_at` is the wrong clock — it moves on the runs that fail every page, which is exactly the connector the alert exists for.',
    'Return the shape an alert needs: `status`, `last_success_at`, `cursor_lag_s`, `consecutive_failures`, `breaker` and `sync_interval_s`. Exposing the breaker is what lets on-call tell a vendor outage (closed → open, backing off) from a connector that will never recover on its own.',
  ],
  debrief: `The interview question is what a health endpoint is for. It is not a status page; it is the input an alert evaluates, so every field has to mean something the alert can act on. The draft fails three ways: it trusts the path so it leaks other tenants' lag, it measures freshness from the last run (a clock that a broken connector still advances), and it hides the breaker so a vendor outage and a dead connector look the same. The right verdict is lag against twice the configured interval, measured from the last page that actually landed, with the breaker state exposed beside the failure count. Real hubs add per-connector SLOs instead of a global interval, a scheduler heartbeat so a connector that is not even being attempted is unhealthy too, and a synthetic probe that syncs a sandbox vendor so the health read itself is monitored.`,
};
