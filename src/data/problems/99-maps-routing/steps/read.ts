import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/routes/{id}: a route with provenance',
  concept: 'http',
  file: 'read',
  focus: ['client', 'api', 'store'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it parses the route id, loads
the record and returns the geometry. It compiles, it serves the demo, and it quietly lies about the
age of what it returns. Review it like the service owner, fix it, and prove the fix with the checks
below.

Implement \`GET /v1/routes/{id}\`, the read that hands one stored route back to a caller:

- The tenant comes from the authenticated \`X-Tenant-Id\` header; a missing tenant is **401**.
- A route is visible only to the tenant that computed it. An unknown id and another tenant's id
  answer the same **404** with the same body — the read never confirms that a foreign route exists.
- The response carries the stored \`geometry\`, the \`epoch\` the geometry was computed in, the
  \`engine_version\` that produced it, and the \`degraded\` marker when the fallback answered with a
  straight-line estimate instead of a road route.
- The reported \`epoch\` is the geometry's epoch — the epoch it was computed in — never the current
  traffic epoch stamped on old geometry. \`stale\` is true whenever the geometry's epoch is not the
  current epoch (floor(now / 300)), so the caller can tell the snapshot from a fresh computation; a
  stored route is never a substitute for one.
- The read answers from the store or answers 404: it never calls the routing engine and never
  recomputes.

**Failure mode the checks target.** Stamping the current epoch on a stale geometry is worse than an
empty response: the caller cannot tell that the route was computed at rush hour and keeps a closed
exit in the plan. Dropping \`degraded\` dresses a straight-line fallback up as a road route. And a
read that trusts only the id turns route ids into a cross-tenant enumeration oracle.`,
  sequence: {
    participants: ['Client', 'Maps API', 'Route store'],
    messages: [
      {from: 'Client', to: 'Maps API', label: 'GET /v1/routes/{id} · X-Tenant-Id', kind: 'sync'},
      {from: 'Maps API', to: 'Maps API', label: 'tenant missing → 401', kind: 'sync'},
      {from: 'Maps API', to: 'Route store', label: 'get(route_id)', kind: 'sync'},
      {
        from: 'Route store',
        to: 'Maps API',
        label: 'record {tenant, geometry, epoch, engine_version, degraded} / none',
        kind: 'reply',
      },
      {
        from: 'Maps API',
        to: 'Maps API',
        label: 'record.tenant ≠ tenant → 404 · stale = record.epoch ≠ floor(now / 300)',
        kind: 'sync',
      },
      {
        from: 'Maps API',
        to: 'Client',
        label: '200 {geometry, epoch, engine_version, degraded, stale}',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'route-read',
      title: 'Answers GET /v1/routes/{id} with the stored route',
      detail:
        'The read is registered on `GET /v1/routes/{route_id}` (the language’s path-parameter route) and its response carries the stored `geometry` together with `epoch`, `engine_version` and the `degraded` marker. The draft already answers this route, so this check passes on it — the four below are where it fails.',
      match: {
        python: {
          all: [
            /@app\.get\(\s*["']\/v1\/routes\/\{route_id\}["']/,
            /["']geometry["']/,
            /["']epoch["']/,
            /["']engine_version["']/,
          ],
        },
        typescript: {all: [/app\.get\(\s*['"]\/v1\/routes\/:routeId['"]/, /geometry/, /epoch/, /engine_version/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/routes\/\{route_id\}"/, /"geometry"/, /"epoch"/, /"engine_version"/]},
        scala: {
          all: [/path\(\s*"v1"\s*\/\s*"routes"\s*\/\s*Segment\s*\)/, /\bgeometry\b/, /\bepoch\b/, /\bengine_version\b/],
        },
        cpp: {all: [/svr\.Get\(\s*R"\(\/v1\/routes\//, /"geometry"/, /"epoch"/, /"engine_version"/]},
      },
    },
    {
      id: 'tenant-required',
      title: 'Requires the tenant, 401 without it',
      detail:
        'The read is a tenant surface: no `X-Tenant-Id` is **401**, before the store is touched. The draft has no tenant gate at all, so a request with no credential is served like any other.',
      match: {
        python: {all: [/X-Tenant-Id/, /status_code\s*=\s*401/]},
        typescript: {all: [/x-tenant-id/, /code\(\s*401\s*\)/]},
        go: {all: [/X-Tenant-Id/, /StatusUnauthorized/]},
        scala: {all: [/X-Tenant-Id/, /StatusCodes\.Unauthorized/]},
        cpp: {all: [/X-Tenant-Id/, /\b401\b/]},
      },
    },
    {
      id: 'ownership-scope',
      title: 'Foreign route ids answer 404, same as unknown ones',
      detail:
        'The stored record carries its `tenant`, and the read returns it only to that tenant: an unknown id and a foreign id get the same **404** body, so the endpoint never confirms that another tenant’s route exists. The draft reads by id alone and hands any record to any caller.',
      match: {
        python: {all: [/route\[["']tenant["']\]\s*!=\s*tenant/, /status_code\s*=\s*404/]},
        typescript: {all: [/route\.tenant\s*!==\s*tenant/, /code\(\s*404\s*\)/]},
        go: {all: [/route\.Tenant\s*!=\s*tenant/, /StatusNotFound/]},
        scala: {all: [/stored\.tenant\s*==\s*tenant/, /StatusCodes\.NotFound/]},
        cpp: {all: [/routeVisibleTo\(/, /\b404\b/]},
      },
    },
    {
      id: 'epoch-provenance',
      title: 'Reports the geometry’s real epoch, never the current clock',
      detail:
        'The response `epoch` is the epoch the geometry was computed in, read from the record; the current traffic epoch is used only to compute `stale`, true whenever they differ, so a stored route is never sold as a fresh computation. The draft stamps `current_epoch()` on geometry from an older epoch, so a rush-hour route reads as freshly computed forever.',
      match: {
        python: {
          all: [/route\[["']epoch["']\]/, /stale/, /current_epoch\(\)/],
          none: [/["']epoch["']\s*:\s*current_epoch\(\)/],
        },
        typescript: {all: [/route\.epoch/, /stale/, /currentEpoch\(\)/], none: [/epoch:\s*currentEpoch\(\)/]},
        go: {
          all: [/route\.Epoch/, /stale/, /currentEpoch\(\)/],
          none: [/["']epoch["']\s*:\s*currentEpoch\(\)/],
        },
        scala: {
          all: [/stored\.epoch/, /stale/, /currentEpoch\(\)/],
          none: [/currentEpoch\(\),\s*stored\.engine_version/],
        },
        cpp: {
          all: [/stored->value\("epoch"/, /stale/, /currentEpoch\(\)/],
          none: [/["']epoch["']\s*,\s*currentEpoch\(\)/],
        },
      },
    },
    {
      id: 'degraded-marker',
      title: 'Serves the stored geometry with its degraded marker intact',
      detail:
        'The record’s `geometry` is returned verbatim and `degraded` travels with it: a straight-line estimate produced by the fallback stays marked instead of being dressed up as a road route, and a marker is never replaced by a hardcoded healthy default. The draft drops `degraded` from the response entirely, so the marker is hidden.',
      match: {
        python: {
          all: [/route\[["']geometry["']\]/, /route\[["']degraded["']\]/],
          none: [/["']degraded["']\s*:\s*(False|None)/],
        },
        typescript: {all: [/route\.geometry/, /route\.degraded/], none: [/degraded:\s*(false|null)/]},
        go: {all: [/route\.Geometry/, /route\.Degraded/], none: [/["']degraded["']\s*:\s*false/]},
        scala: {all: [/stored\.geometry/, /stored\.degraded/], none: [/degraded\s*=\s*false/]},
        cpp: {all: [/stored->value\("geometry"/, /stored->value\("degraded"/], none: [/["']degraded["']\s*,\s*false/]},
      },
    },
  ],
  code: {
    python: {
      starter: `from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI()


class RouteStore:
    def get(self, route_id: str):
        """The stored route record for route_id, if any."""
        raise NotImplementedError


store = RouteStore()


def current_epoch() -> int:
    """The traffic epoch, bumped every five minutes."""
    raise NotImplementedError


@app.get("/v1/routes/{route_id}")
def read_route(route_id: str) -> JSONResponse:
    # TODO: this draft ignores the tenant, stamps the current epoch on stored geometry and drops
    # the degraded marker. Review all three.
    route = store.get(route_id)
    if route is None:
        return JSONResponse({"error": "route not found"}, status_code=404)
    return JSONResponse(
        {
            "route_id": route_id,
            "geometry": route["geometry"],
            "epoch": current_epoch(),
            "engine_version": route["engine_version"],
        },
        status_code=200,
    )
`,
      solution: `from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()


class RouteStore:
    def get(self, route_id: str) -> dict | None:
        """The stored route record for route_id, if any."""
        raise NotImplementedError


store = RouteStore()


def current_epoch() -> int:
    """The traffic epoch, bumped every five minutes."""
    raise NotImplementedError


@app.get("/v1/routes/{route_id}")
def read_route(
    route_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    route = store.get(route_id)
    if route is None or route["tenant"] != tenant:
        # A foreign route id is indistinguishable from a missing one.
        raise HTTPException(status_code=404, detail="route not found")
    return JSONResponse(
        {
            "route_id": route["route_id"],
            "geometry": route["geometry"],
            "epoch": route["epoch"],
            "engine_version": route["engine_version"],
            "degraded": route["degraded"],
            "stale": route["epoch"] != current_epoch(),
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** GET /v1/routes/{id}: a model-generated draft that trusts whatever the store returns. */
import Fastify from 'fastify';

export const app = Fastify();

interface StoredRoute {
  route_id: string;
  tenant: string;
  geometry: string;
  epoch: number;
  engine_version: string;
  degraded: boolean;
}

const store = {
  /** The stored route record for routeId, if any. */
  async get(routeId: string): Promise<StoredRoute | null> {
    throw new Error(\`the route store is not wired up (\${routeId})\`);
  },
};

/** The traffic epoch, bumped every five minutes: floor(now / 300). */
function currentEpoch(): number {
  return Math.floor(Date.now() / 300_000);
}

app.get('/v1/routes/:routeId', async (request, reply) => {
  // TODO: this draft ignores the tenant, stamps the current epoch on stored geometry and drops
  // the degraded marker. Review all three.
  const {routeId} = request.params as {routeId: string};
  const route = await store.get(routeId);
  if (route === null) return reply.code(404).send({error: 'route not found'});
  return reply.code(200).send({
    route_id: routeId,
    geometry: route.geometry,
    epoch: currentEpoch(),
    engine_version: route.engine_version,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** GET /v1/routes/{id}: the stored route, handed back with its real provenance. */
import Fastify from 'fastify';

export const app = Fastify();

interface StoredRoute {
  route_id: string;
  tenant: string;
  geometry: string;
  epoch: number;
  engine_version: string;
  degraded: boolean;
}

const store = {
  /** The stored route record for routeId, if any. */
  async get(routeId: string): Promise<StoredRoute | null> {
    throw new Error(\`the route store is not wired up (\${routeId})\`);
  },
};

/** The traffic epoch, bumped every five minutes: floor(now / 300). */
function currentEpoch(): number {
  return Math.floor(Date.now() / 300_000);
}

app.get('/v1/routes/:routeId', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const {routeId} = request.params as {routeId: string};
  const route = await store.get(routeId);
  if (route === null || route.tenant !== tenant)
    // A foreign route id is indistinguishable from a missing one.
    return reply.code(404).send({error: 'route not found'});
  return reply.code(200).send({
    route_id: route.route_id,
    geometry: route.geometry,
    epoch: route.epoch,
    engine_version: route.engine_version,
    degraded: route.degraded,
    stale: route.epoch !== currentEpoch(),
  });
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
	"time"
)

type StoredRoute struct {
	RouteID       string \`json:"route_id"\`
	Tenant        string \`json:"tenant"\`
	Geometry      string \`json:"geometry"\`
	Epoch         int64  \`json:"epoch"\`
	EngineVersion string \`json:"engine_version"\`
	Degraded      bool   \`json:"degraded"\`
}

type RouteStore struct{}

// Get returns the stored route record for routeID, if any.
func (s *RouteStore) Get(ctx context.Context, routeID string) (*StoredRoute, error) {
	return nil, nil
}

var store = &RouteStore{}

// currentEpoch is the traffic epoch, bumped every five minutes: now / 300.
func currentEpoch() int64 { return time.Now().Unix() / 300 }

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readRoute(rw http.ResponseWriter, r *http.Request) {
	// TODO: this draft ignores the tenant, stamps the current epoch on stored geometry and drops
	// the degraded marker. Review all three.
	routeID := r.PathValue("route_id")
	route, err := store.Get(r.Context(), routeID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if route == nil {
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "route not found"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"route_id":       routeID,
		"geometry":       route.Geometry,
		"epoch":          currentEpoch(),
		"engine_version": route.EngineVersion,
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/routes/{route_id}", readRoute)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"
)

type StoredRoute struct {
	RouteID       string \`json:"route_id"\`
	Tenant        string \`json:"tenant"\`
	Geometry      string \`json:"geometry"\`
	Epoch         int64  \`json:"epoch"\`
	EngineVersion string \`json:"engine_version"\`
	Degraded      bool   \`json:"degraded"\`
}

type RouteStore struct{}

// Get returns the stored route record for routeID, if any.
func (s *RouteStore) Get(ctx context.Context, routeID string) (*StoredRoute, error) {
	return nil, nil
}

var store = &RouteStore{}

// currentEpoch is the traffic epoch, bumped every five minutes: now / 300.
func currentEpoch() int64 { return time.Now().Unix() / 300 }

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func readRoute(rw http.ResponseWriter, r *http.Request) {
	tenant := r.Header.Get("X-Tenant-Id")
	if tenant == "" {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
		return
	}
	routeID := r.PathValue("route_id")
	route, err := store.Get(r.Context(), routeID)
	if err != nil {
		writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
		return
	}
	if route == nil || route.Tenant != tenant {
		// A foreign route id is indistinguishable from a missing one.
		writeJSON(rw, http.StatusNotFound, map[string]string{"error": "route not found"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"route_id":       route.RouteID,
		"geometry":       route.Geometry,
		"epoch":          route.Epoch,
		"engine_version": route.EngineVersion,
		"degraded":       route.Degraded,
		"stale":          route.Epoch != currentEpoch(),
	})
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/routes/{route_id}", readRoute)
	log.Fatal(http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux))
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

final case class StoredRoute(
    route_id: String,
    tenant: String,
    geometry: String,
    epoch: Long,
    engine_version: String,
    degraded: Boolean,
)

final case class RouteRead(route_id: String, geometry: String, epoch: Long, engine_version: String)

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("maps-routing")
  implicit val storedFormat: RootJsonFormat[StoredRoute] = jsonFormat6(StoredRoute)
  implicit val readFormat: RootJsonFormat[RouteRead] = jsonFormat4(RouteRead)

  final class RouteStore {
    /** The stored route record for routeId, if any. */
    def get(routeId: String): Option[StoredRoute] =
      throw new UnsupportedOperationException("the route store is not wired up")
  }

  val store = new RouteStore()

  // The traffic epoch, bumped every five minutes: now / 300000.
  def currentEpoch(): Long = System.currentTimeMillis() / 300000L

  val route: Route =
    path("v1" / "routes" / Segment) { routeId =>
      get {
        // TODO: this draft ignores the tenant, stamps the current epoch on stored geometry and
        // drops the degraded marker. Review all three.
        store.get(routeId) match {
          case None => complete(StatusCodes.NotFound, """{"error":"route not found"}""")
          case Some(stored) =>
            complete(StatusCodes.OK, RouteRead(routeId, stored.geometry, currentEpoch(), stored.engine_version))
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

final case class StoredRoute(
    route_id: String,
    tenant: String,
    geometry: String,
    epoch: Long,
    engine_version: String,
    degraded: Boolean,
)

final case class RouteRead(
    route_id: String,
    geometry: String,
    epoch: Long,
    engine_version: String,
    degraded: Boolean,
    stale: Boolean,
)

object ReadApi {
  implicit val system: ActorSystem = ActorSystem("maps-routing")
  implicit val storedFormat: RootJsonFormat[StoredRoute] = jsonFormat6(StoredRoute)
  implicit val readFormat: RootJsonFormat[RouteRead] = jsonFormat6(RouteRead)

  final class RouteStore {
    /** The stored route record for routeId, if any. */
    def get(routeId: String): Option[StoredRoute] =
      throw new UnsupportedOperationException("the route store is not wired up")
  }

  val store = new RouteStore()

  // The traffic epoch, bumped every five minutes: now / 300000.
  def currentEpoch(): Long = System.currentTimeMillis() / 300000L

  val route: Route =
    path("v1" / "routes" / Segment) { routeId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          if (!tenantOpt.exists(_.nonEmpty)) {
            complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
          } else {
            val tenant = tenantOpt.get
            store.get(routeId) match {
              case Some(stored) if stored.tenant == tenant =>
                complete(
                  StatusCodes.OK,
                  RouteRead(
                    stored.route_id,
                    stored.geometry,
                    stored.epoch,
                    stored.engine_version,
                    stored.degraded,
                    stored.epoch != currentEpoch(),
                  ),
                )
              case _ =>
                // A foreign route id is indistinguishable from a missing one.
                complete(StatusCodes.NotFound, """{"error":"route not found"}""")
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

#include <optional>
#include <string>

using json = nlohmann::json;

struct RouteStore {
  /** The stored route record for route_id, if any. */
  std::optional<json> get(const std::string& route_id);
};

RouteStore store;

// The traffic epoch, bumped every five minutes: floor(now / 300).
long long currentEpoch();

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/routes/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    // TODO: this draft ignores the tenant, stamps the current epoch on stored geometry and drops
    // the degraded marker. Review all three.
    const std::string route_id = req.matches[1];
    const auto stored = store.get(route_id);
    if (!stored) {
      res.status = 404;
      res.set_content(R"({"error":"route not found"})", "application/json");
      return;
    }
    res.status = 200;
    res.set_content(
        json{{"route_id", route_id},
             {"geometry", stored->value("geometry", std::string())},
             {"epoch", currentEpoch()},
             {"engine_version", stored->value("engine_version", std::string())}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <optional>
#include <string>

using json = nlohmann::json;

struct RouteStore {
  /** The stored route record for route_id, if any. */
  std::optional<json> get(const std::string& route_id);
};

RouteStore store;

// The traffic epoch, bumped every five minutes: floor(now / 300).
long long currentEpoch();

// routeVisibleTo: a stored route is only readable by the tenant that computed it.
bool routeVisibleTo(const json& stored, const std::string& tenant) {
  return stored.value("tenant", std::string()) == tenant;
}

int main() {
  httplib::Server svr;

  svr.Get(R"(/v1/routes/([^/]+))", [](const httplib::Request& req, httplib::Response& res) {
    const auto tenant = req.get_header_value("X-Tenant-Id");
    if (tenant.empty()) {
      res.status = 401;
      res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
      return;
    }
    const std::string route_id = req.matches[1];
    const auto stored = store.get(route_id);
    if (!stored || !routeVisibleTo(*stored, tenant)) {
      // A foreign route id is indistinguishable from a missing one.
      res.status = 404;
      res.set_content(R"({"error":"route not found"})", "application/json");
      return;
    }
    const long long epoch = stored->value("epoch", 0LL);
    res.status = 200;
    res.set_content(
        json{{"route_id", route_id},
             {"geometry", stored->value("geometry", std::string())},
             {"epoch", epoch},
             {"engine_version", stored->value("engine_version", std::string())},
             {"degraded", stored->value("degraded", true)},
             {"stale", epoch != currentEpoch()}}
            .dump(),
        "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  hints: [
    'The tenant gate comes first: no `X-Tenant-Id` is **401**, before the store is touched. Then scope by ownership: the record carries its own `tenant`, and a foreign id must answer exactly what an unknown id answers — 404 — so the read never confirms that another tenant’s route exists.',
    'The `epoch` you return is the geometry’s, not the clock’s: read it from the record. The current epoch (floor(now / 300)) is only for the `stale` comparison — true whenever the geometry was not computed in the current epoch — because a stored route is a snapshot, never a substitute for a fresh computation.',
    'Return the record as stored: `geometry` verbatim and `degraded` alongside it. Dropping the marker, or replacing it with a hardcoded false, dresses a straight-line fallback up as a road route — and the caller has no way to tell until the car is on a road that does not exist.',
  ],
  debrief: `The interviewer is testing the read half of a routing cache: not “does it return geometry” but “can the caller tell what it is holding”. Three truths the draft breaks, and each check owns one. Ownership: the record’s \`tenant\` decides who may read it, and a foreign id answers the same 404 as an unknown one, so the read cannot be used to enumerate another tenant’s routes. Provenance: the epoch on the response is the epoch the geometry was computed in, and the current traffic epoch is used only to say \`stale\` — never to relabel old geometry as fresh. Honest degradation: \`degraded\` travels with the geometry, so a straight-line fallback estimate is never mistaken for a road route. Real platforms add a signed route token so a client can prove what it was served, per-epoch metric labels on the read path, and a reaper that deletes routes older than the retention window instead of serving them forever.`,
};
