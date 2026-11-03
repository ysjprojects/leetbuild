import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/connectors/{id}/health: lag you can alert on',
  concept: 'http',
  file: 'read',
  focus: ['client', 'hub', 'redis'],
  task: `## Task

**Starting point.** The starter's \`GET /v1/connectors/{id}/health\` reads the hash
\`connector:{id}:health\` for whatever id is in the path, takes \`last_run_at\` from it, and answers
\`healthy\` when that is under an hour old, \`stale\` otherwise, with the id and the run timestamp.
It compiles, serves the demo and hides 4 flaws.

**Failure mode the checks target.** \`last_run_at\` is the trap: it moves on every attempt, so a
connector whose every page fails reports healthy for as long as it keeps failing, and the alert that
should fire does not. Hiding the breaker removes the difference between a connector waiting out a
vendor outage and one that needs a human. And serving any id lets a caller read another tenant's
connector ids and their lag: an authorization bug in an endpoint that looks like a status page.

- The connector is authorized against the authenticated tenant: a connector that belongs to
  another tenant, or does not exist, answers **404**, the same answer for both, so ids cannot be
  probed.
- The read reports \`last_success_at\`, \`cursor_lag_s = now − last_success_at\`,
  \`consecutive_failures\`, \`breaker\` state and the connector's \`sync_interval_s\`.
- The verdict turns \`unhealthy\` when no page has landed in twice the configured sync interval
  (\`STALE_INTERVALS = 2\`): \`cursor_lag_s > STALE_INTERVALS × sync_interval_s\`, or no successful
  page at all. Staleness is measured from the last successful page, not the last run.
- The breaker state is exposed (\`closed\`/\`open\`), so an operator can tell "the vendor is down,
  we are backing off" from "the connector is broken".`,
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
        'The connector is authorized against the request tenant before its health is read, and a foreign or unknown connector answers **404**. The starter serves any connector id in the path.',
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
        'The verdict is measured from the last **successful** page against `STALE_INTERVALS = 2` sync intervals, and reports `unhealthy` when the lag exceeds it. The starter measures from `last_run_at`, which moves on every failed attempt, so a connector that syncs nothing reads healthy forever.',
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
        'The body carries `breaker` (`closed`/`open`) and `consecutive_failures`, so an operator can separate "waiting out a vendor outage" from "needs a human". The starter hides both.',
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
        "`cursor_lag_s` is reported alongside the connector's `sync_interval_s`, so the lag means something to the person reading the alert. The starter reports only a run timestamp.",
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
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
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
      starter: `/** GET /v1/connectors/{id}/health. */
import Fastify from 'fastify';
import {Redis} from 'ioredis';

export const app = Fastify();
const r = new Redis('redis://redis:6379');

app.get('/v1/connectors/:id/health', async (request, reply) => {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
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
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
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
          // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
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
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
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
    'Symptoms: a connector whose token expired a week ago shows green on the dashboard, no page lag alert has fired, and a curl with any connector id from any tenant returns a body.',
    'The handler reads `connector:{id}:health` without checking who owns `id`, compares `last_run_at` (bumped on every failed attempt) against a fixed hour, and returns only `status` and that timestamp.',
    'Call `store.owner_of(id)`; mismatch or None is 404. Compute `cursor_lag_s` from `last_success_at`, `unhealthy` above `STALE_INTERVALS * sync_interval_s`. Return `consecutive_failures`, `breaker` and `sync_interval_s` too.',
  ],
  debrief: `The fix takes the shape of an alert input rather than a status page: every field in the body is one an alert rule can act on, and the verdict is computed from the clock that only moves on success, scaled by the connector's own interval instead of a global hour. Authorization answers 404 for both "missing" and "foreign" because any difference between the two is an enumeration oracle, and the breaker state is in the body because on-call needs to know whether to wait or to page someone. Production hubs add per-connector SLOs in place of a single multiplier, a scheduler heartbeat so a connector that is not even being attempted reads unhealthy too, and a synthetic sandbox connector whose sync exercises the health read itself.`,
};
