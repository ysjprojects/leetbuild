import type {Step} from '@/lib/types';

export const readStep: Step = {
  id: 'read',
  title: 'GET /v1/fleets/{id}/positions: a snapshot from one instant',
  concept: 'http',
  file: 'read',
  focus: ['tenant', 'read', 'state', 'db'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: it lists a fleet's vehicles
and returns whatever latest position each one's cache happens to hold. It compiles, it serves the
demo, and it hides three production flaws. Review it like the service owner, fix it, and prove the
fix with the checks below.

Implement \`GET /v1/fleets/{fleet_id}/positions\`.

- Every returned position must come from **one instant**: the read captures a single
  \`snapshot_at_ms\` and compares each vehicle's position against it, instead of reading per-vehicle
  caches that were refreshed at different times. The map must never show a fleet assembled from a
  five-minute window.
- Each position must be within the **freshness bound** (\`FRESHNESS_BOUND_MS\`, 60 000 ms). A
  vehicle whose latest position is older than that bound is returned with \`"stale": true\` rather
  than presented as current; a vehicle that has not reported in hours is not "current".
- The response is **capped at 5 000 vehicles** and **paginated**: callers pass \`limit\` (1..1000,
  default 500) and an opaque \`cursor\`; the response carries the next \`cursor\` when more vehicles
  remain.
- The read is **tenant-scoped**: the tenant from \`X-Tenant-Id\` is passed into the query, so a
  caller can never read another fleet's vehicles. A missing tenant is **401**.
- The response includes the fleet id, the vehicle positions, a \`stale\` count and the
  \`max_vehicles\` cap.

**Failure mode the checks target.** The draft composes the snapshot from per-vehicle caches
refreshed lazily at different times, so the map shows a fleet assembled from a five-minute window,
and it returns vehicles that have not reported in hours as current. It also has no cap, no
pagination and no tenant scoping. The checks verify the freshness bound and stale flag, the cap,
pagination, and tenant scope.`,
  sequence: {
    participants: ['Dispatcher', 'Snapshot API', 'Redis', 'Position Store'],
    messages: [
      {from: 'Dispatcher', to: 'Snapshot API', label: 'GET /v1/fleets/{id}/positions?limit&cursor', kind: 'sync'},
      {from: 'Snapshot API', to: 'Position Store', label: 'tenant-scoped page of vehicles', kind: 'sync'},
      {from: 'Snapshot API', to: 'Redis', label: 'one snapshot_at_ms comparison', kind: 'sync'},
      {from: 'Redis', to: 'Snapshot API', label: 'latest positions + ages', kind: 'reply'},
      {from: 'Snapshot API', to: 'Dispatcher', label: '200 {vehicles, stale, cursor, max_vehicles}', kind: 'reply'},
    ],
  },
  checks: [
    {
      id: 'route',
      title: 'Handles GET /v1/fleets/{id}/positions',
      detail: 'Register the fleet snapshot route on `GET /v1/fleets/{fleet_id}/positions`.',
      match: {
        python: {all: [/@app\.get\(\s*["']\/v1\/fleets\/\{fleet_id\}\/positions["']/]},
        typescript: {all: [/app\.get\(\s*['"]\/v1\/fleets\/:fleetId\/positions['"]/]},
        go: {all: [/HandleFunc\(\s*"GET \/v1\/fleets\/\{fleetID\}\/positions"/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"fleets"\s*\/\s*Segment\s*\/\s*"positions"\s*\)/, /\bget\s*\{/]},
        cpp: {all: [/svr\.Get\(/, /fleets/, /positions/]},
      },
    },
    {
      id: 'freshness',
      title: 'Flags positions older than the freshness bound',
      detail:
        'A single instant is captured and each position older than `FRESHNESS_BOUND_MS` is returned with `"stale": true`. The draft returns hours-old positions as current.',
      match: {
        python: {all: [/FRESHNESS_BOUND_MS/, /stale/]},
        typescript: {all: [/FRESHNESS_BOUND_MS/, /stale/]},
        go: {all: [/freshnessBoundMs/, /[Ss]tale/]},
        scala: {all: [/FreshnessBoundMs/, /stale/]},
        cpp: {all: [/kFreshnessBoundMs/, /stale/]},
      },
    },
    {
      id: 'cap',
      title: 'Caps the snapshot at 5000 vehicles',
      detail:
        'The read is capped at 5 000 vehicles so one fleet cannot exhaust a response. The draft returns every vehicle.',
      match: {
        python: {all: [/MAX_VEHICLES/, /5000/]},
        typescript: {all: [/MAX_VEHICLES/, /5000/]},
        go: {all: [/maxVehicles/, /5000/]},
        scala: {all: [/MaxVehicles/, /5000/]},
        cpp: {all: [/kMaxVehicles/, /5000/]},
      },
    },
    {
      id: 'pagination',
      title: 'Paginates with a limit and a cursor',
      detail:
        'The read takes `limit` (1..1000) and an opaque `cursor`, and returns the next `cursor` when a page fills. The draft returns the whole fleet at once.',
      match: {
        python: {all: [/cursor/, /limit/]},
        typescript: {all: [/cursor/, /limit/]},
        go: {all: [/cursor/, /limit/]},
        scala: {all: [/cursor/, /limit/]},
        cpp: {all: [/cursor/, /limit/]},
      },
    },
    {
      id: 'tenant-scope',
      title: 'Scopes the snapshot to the caller tenant',
      detail:
        'The tenant from `X-Tenant-Id` is passed into the query, so a caller can only read their own fleet. The draft lists vehicles by fleet id alone.',
      match: {
        python: {all: [/X-Tenant-Id/, /fleet_vehicles\(tenant/]},
        typescript: {all: [/x-tenant-id/, /fleetVehicles\(tenant/]},
        go: {all: [/X-Tenant-Id/, /FleetVehicles\([^;]*tenant/]},
        scala: {all: [/X-Tenant-Id/, /fleetVehicles\(tenant/]},
        cpp: {all: [/X-Tenant-Id/, /fleetVehicles\(tenant/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("fleet")


class FleetStore:
    def list_vehicles(self, fleet_id: str) -> list[str]:
        """Every vehicle id in the fleet."""
        raise NotImplementedError

    def latest(self, vehicle_id: str) -> dict:
        """The cache's copy of the vehicle's latest position."""
        raise NotImplementedError


store = FleetStore()


@app.get("/v1/fleets/{fleet_id}/positions")
def snapshot(fleet_id: str, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this draft composes the snapshot from per-vehicle caches refreshed at different times,
    # returns hours-old vehicles as current, and has no cap, pagination or tenant scoping.
    # Review the instant, the freshness bound, the cap and the cursor.
    vehicles = store.list_vehicles(fleet_id)
    positions = [store.latest(vehicle_id) for vehicle_id in vehicles]
    return JSONResponse({"vehicles": positions}, status_code=200)
`,
      solution: `import logging
import time

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

app = FastAPI()
logger = logging.getLogger("fleet")

FRESHNESS_BOUND_MS = 60_000
MAX_VEHICLES = 5000
DEFAULT_LIMIT = 500


class FleetStore:
    def fleet_vehicles(self, tenant: str, fleet_id: str, cursor: str | None, limit: int) -> list[str]:
        """One tenant-scoped page of vehicle ids for the fleet."""
        raise NotImplementedError

    def latest(self, tenant: str, vehicle_id: str) -> dict:
        """The vehicle's latest position for the tenant."""
        raise NotImplementedError


store = FleetStore()


@app.get("/v1/fleets/{fleet_id}/positions")
def snapshot(
    fleet_id: str,
    tenant: str | None = Header(default=None, alias="X-Tenant-Id"),
    cursor: str | None = None,
    limit: int = DEFAULT_LIMIT,
) -> JSONResponse:
    if tenant is None or tenant == "":
        raise HTTPException(status_code=401, detail="missing X-Tenant-Id")
    if limit < 1 or limit > 1000:
        raise HTTPException(status_code=400, detail="limit must be 1..1000")
    snapshot_at_ms = int(time.time() * 1000)
    vehicles = store.fleet_vehicles(tenant, fleet_id, cursor, limit)
    positions = []
    stale = 0
    for vehicle_id in vehicles:
        position = store.latest(tenant, vehicle_id)
        age_ms = snapshot_at_ms - position["device_timestamp_ms"]
        is_stale = age_ms > FRESHNESS_BOUND_MS
        if is_stale:
            stale += 1
        positions.append({**position, "stale": is_stale, "age_ms": age_ms})
    next_cursor = positions[-1]["vehicle_id"] if len(positions) == limit else None
    logger.info("snapshot tenant=%s fleet=%s vehicles=%d stale=%d", tenant, fleet_id, len(positions), stale)
    return JSONResponse(
        {
            "fleet_id": fleet_id,
            "snapshot_at_ms": snapshot_at_ms,
            "vehicles": positions,
            "stale": stale,
            "cursor": next_cursor,
            "max_vehicles": MAX_VEHICLES,
        },
        status_code=200,
    )
`,
    },
    typescript: {
      starter: `/** Fleet snapshot: a model-generated draft that stitches lazily refreshed caches. */
import Fastify from 'fastify';

export const app = Fastify();

interface PositionView {
  vehicle_id: string;
  device_timestamp_ms: number;
}

export interface FleetStore {
  listVehicles(fleetId: string): Promise<PositionView[]>;
}

declare const store: FleetStore;

app.get('/v1/fleets/:fleetId/positions', async (request, reply) => {
  // TODO: this draft composes the snapshot from per-vehicle caches refreshed at different times,
  // returns hours-old vehicles as current, and has no cap, pagination or tenant scoping.
  // Review the instant, the freshness bound, the cap and the cursor.
  const {fleetId} = request.params as {fleetId: string};
  const vehicles = await store.listVehicles(fleetId);
  return reply.code(200).send({vehicles});
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
      solution: `/** Fleet snapshot: one instant, a freshness bound, a cap and a cursor. */
import Fastify from 'fastify';

export const app = Fastify();

const FRESHNESS_BOUND_MS = 60_000;
const MAX_VEHICLES = 5000;
const DEFAULT_LIMIT = 500;

interface PositionView {
  vehicle_id: string;
  device_timestamp_ms: number;
}

export interface FleetStore {
  fleetVehicles(
    tenant: string,
    fleetId: string,
    cursor: string | null,
    limit: number,
  ): Promise<PositionView[]>;
}

declare const store: FleetStore;

app.get('/v1/fleets/:fleetId/positions', async (request, reply) => {
  const tenant = request.headers['x-tenant-id'];
  if (typeof tenant !== 'string' || tenant === '')
    return reply.code(401).send({error: 'missing X-Tenant-Id'});
  const query = request.query as {cursor?: string; limit?: string};
  const limit = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
    return reply.code(400).send({error: 'limit must be 1..1000'});
  const {fleetId} = request.params as {fleetId: string};
  const snapshotAtMs = Date.now();
  const vehicles = await store.fleetVehicles(tenant, fleetId, query.cursor ?? null, limit);
  let stale = 0;
  const positions = vehicles.map(vehicle => {
    const ageMs = snapshotAtMs - vehicle.device_timestamp_ms;
    const isStale = ageMs > FRESHNESS_BOUND_MS;
    if (isStale) stale += 1;
    return {...vehicle, stale: isStale, age_ms: ageMs};
  });
  const cursor = positions.length === limit ? positions[positions.length - 1].vehicle_id : null;
  request.log.info({tenant, fleetId, vehicles: positions.length, stale}, 'snapshot');
  return reply.code(200).send({
    fleet_id: fleetId,
    snapshot_at_ms: snapshotAtMs,
    vehicles: positions,
    stale,
    cursor,
    max_vehicles: MAX_VEHICLES,
  });
});

void app.listen({port: 8443, host: '0.0.0.0'});
`,
    },
    go: {
      starter: `package read

import (
	"context"
	"encoding/json"
	"net/http"
)

type Position struct {
	VehicleID         string
	DeviceTimestampMs int64
	Sequence          int
}

type Store interface {
	ListVehicles(ctx context.Context, fleetID string) ([]Position, error)
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func Snapshot(store Store) http.HandlerFunc {
	return func(rw http.ResponseWriter, r *http.Request) {
		// TODO: this draft composes the snapshot from per-vehicle caches refreshed at different
		// times, returns hours-old vehicles as current, and has no cap, pagination or tenant
		// scoping. Review the instant, the freshness bound, the cap and the cursor.
		fleetID := r.PathValue("fleetID")
		vehicles, err := store.ListVehicles(r.Context(), fleetID)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		writeJSON(rw, http.StatusOK, map[string]any{"vehicles": vehicles})
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/fleets/{fleetID}/positions", Snapshot(nil))
	_ = http.ListenAndServe(":8443", mux)
}
`,
      solution: `package read

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"
)

const (
	freshnessBoundMs = 60_000
	maxVehicles      = 5000
	defaultLimit     = 500
)

type Position struct {
	VehicleID         string
	DeviceTimestampMs int64
	Sequence          int
}

type Store interface {
	FleetVehicles(ctx context.Context, tenant, fleetID, cursor string, limit int) ([]Position, error)
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func Snapshot(store Store) http.HandlerFunc {
	return func(rw http.ResponseWriter, r *http.Request) {
		tenant := r.Header.Get("X-Tenant-Id")
		if tenant == "" {
			writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing X-Tenant-Id"})
			return
		}
		fleetID := r.PathValue("fleetID")
		query := r.URL.Query()
		limit := defaultLimit
		if raw := query.Get("limit"); raw != "" {
			parsed, err := strconv.Atoi(raw)
			if err != nil || parsed < 1 || parsed > 1000 {
				writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "limit must be 1..1000"})
				return
			}
			limit = parsed
		}
		cursor := query.Get("cursor")
		vehicles, err := store.FleetVehicles(r.Context(), tenant, fleetID, cursor, limit)
		if err != nil {
			writeJSON(rw, http.StatusServiceUnavailable, map[string]string{"error": "TRY_AGAIN"})
			return
		}
		type view struct {
			Position
			Stale bool  \`json:"stale"\`
			AgeMs int64 \`json:"age_ms"\`
		}
		snapshotAtMs := time.Now().UnixMilli()
		positions := make([]view, 0, len(vehicles))
		staleCount := 0
		for _, v := range vehicles {
			ageMs := snapshotAtMs - v.DeviceTimestampMs
			isStale := ageMs > freshnessBoundMs
			if isStale {
				staleCount++
			}
			positions = append(positions, view{Position: v, Stale: isStale, AgeMs: ageMs})
		}
		nextCursor := ""
		if len(positions) == limit {
			nextCursor = positions[len(positions)-1].VehicleID
		}
		writeJSON(rw, http.StatusOK, map[string]any{
			"fleet_id":        fleetID,
			"snapshot_at_ms":  snapshotAtMs,
			"vehicles":        positions,
			"stale":           staleCount,
			"cursor":          nextCursor,
			"max_vehicles":    maxVehicles,
		})
	}
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/fleets/{fleetID}/positions", Snapshot(nil))
	_ = http.ListenAndServe(":8443", mux)
}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object FleetSnapshot {
  implicit val system: ActorSystem = ActorSystem("fleet")

  val route: Route =
    path("v1" / "fleets" / Segment / "positions") {
      get {
        parameterMap { _ =>
          // TODO: this draft composes the snapshot from per-vehicle caches refreshed at different
          // times, returns hours-old vehicles as current, and has no cap, pagination or tenant
          // scoping. Review the instant, the freshness bound, the cap and the cursor.
          val fleetId = "fleet"
          val vehicles = store.listVehicles(fleetId)
          complete(StatusCodes.OK, s"""{"vehicles":\${vehicles.size}}""")
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
import play.api.libs.json.Json

object FleetSnapshot {
  implicit val system: ActorSystem = ActorSystem("fleet")

  val FreshnessBoundMs = 60_000L
  val MaxVehicles = 5000
  val DefaultLimit = 500

  val route: Route =
    path("v1" / "fleets" / Segment / "positions") { fleetId =>
      get {
        optionalHeaderValueByName("X-Tenant-Id") { tenantOpt =>
          parameters("cursor".?, "limit".as[Int].?(DefaultLimit)) { (cursor, limit) =>
            tenantOpt.filter(_.nonEmpty) match {
              case None =>
                complete(StatusCodes.Unauthorized, """{"error":"missing X-Tenant-Id"}""")
              case Some(tenant) if limit < 1 || limit > 1000 =>
                complete(StatusCodes.BadRequest, """{"error":"limit must be 1..1000"}""")
              case Some(tenant) =>
                val snapshotAtMs = System.currentTimeMillis()
                val vehicles = store.fleetVehicles(tenant, fleetId, cursor, limit)
                val stale = vehicles.count(v => snapshotAtMs - v.deviceTimestampMs > FreshnessBoundMs)
                val cursorOut = if (vehicles.size == limit) vehicles.last.vehicleId else ""
                system.log.info(s"snapshot tenant=$tenant fleet=$fleetId vehicles=\${vehicles.size} stale=$stale")
                complete(
                  StatusCodes.OK,
                  Json.stringify(
                    Json.obj(
                      "fleet_id" -> fleetId,
                      "snapshot_at_ms" -> snapshotAtMs,
                      "vehicles" -> Json.toJson(vehicles.map { v =>
                        Json.obj(
                          "vehicle_id" -> v.vehicleId,
                          "device_timestamp_ms" -> v.deviceTimestampMs,
                          "sequence" -> v.sequence,
                          "stale" -> (snapshotAtMs - v.deviceTimestampMs > FreshnessBoundMs),
                          "age_ms" -> (snapshotAtMs - v.deviceTimestampMs),
                        )
                      }),
                      "stale" -> stale,
                      "cursor" -> cursorOut,
                      "max_vehicles" -> MaxVehicles,
                    ),
                  ),
                )
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
#include <vector>

using json = nlohmann::json;

struct FleetStore {
  std::vector<std::string> listVehicles(const std::string& fleetId);
};

FleetStore store;

void registerFleetRoutes(httplib::Server& svr) {
  svr.Get(R"(/v1/fleets/([^/]+)/positions)",
          [](const httplib::Request& req, httplib::Response& res) {
            // TODO: this draft composes the snapshot from per-vehicle caches refreshed at
            // different times, returns hours-old vehicles as current, and has no cap, pagination
            // or tenant scoping. Review the instant, the freshness bound, the cap and the cursor.
            const auto fleetId = req.matches[1].str();
            const auto vehicles = store.listVehicles(fleetId);
            res.status = 200;
            res.set_content(json{{"vehicles", vehicles.size()}}.dump(), "application/json");
          });
}
`,
      solution: `#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <string>
#include <vector>

using json = nlohmann::json;

constexpr long long kFreshnessBoundMs = 60'000;
constexpr int kMaxVehicles = 5000;
constexpr int kDefaultLimit = 500;

struct VehicleView {
  std::string vehicle_id;
  long long device_timestamp_ms;
  int sequence;
};

struct FleetStore {
  std::vector<VehicleView> fleetVehicles(
      const std::string& tenant,
      const std::string& fleetId,
      const std::string& cursor,
      int limit);
};

FleetStore store;

void registerFleetRoutes(httplib::Server& svr) {
  svr.Get(R"(/v1/fleets/([^/]+)/positions)",
          [](const httplib::Request& req, httplib::Response& res) {
            const auto tenant = req.get_header_value("X-Tenant-Id");
            if (tenant.empty()) {
              res.status = 401;
              res.set_content(R"({"error":"missing X-Tenant-Id"})", "application/json");
              return;
            }
            const auto fleetId = req.matches[1].str();
            const auto cursor = req.has_param("cursor") ? req.get_param_value("cursor") : std::string();
            int limit = kDefaultLimit;
            if (req.has_param("limit")) {
              limit = std::stoi(req.get_param_value("limit"));
              if (limit < 1 || limit > 1000) {
                res.status = 400;
                res.set_content(R"({"error":"limit must be 1..1000"})", "application/json");
                return;
              }
            }
            const auto snapshotAtMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                                          std::chrono::system_clock::now().time_since_epoch())
                                          .count();
            const auto vehicles = store.fleetVehicles(tenant, fleetId, cursor, limit);
            json positions = json::array();
            int stale = 0;
            for (const auto& v : vehicles) {
              const long long ageMs = snapshotAtMs - v.device_timestamp_ms;
              const bool isStale = ageMs > kFreshnessBoundMs;
              if (isStale) ++stale;
              positions.push_back(json{
                  {"vehicle_id", v.vehicle_id},
                  {"device_timestamp_ms", v.device_timestamp_ms},
                  {"sequence", v.sequence},
                  {"stale", isStale},
                  {"age_ms", ageMs},
              });
            }
            const std::string nextCursor =
                static_cast<int>(vehicles.size()) == limit ? vehicles.back().vehicle_id : std::string();
            res.status = 200;
            res.set_content(
                json{
                    {"fleet_id", fleetId},
                    {"snapshot_at_ms", snapshotAtMs},
                    {"vehicles", positions},
                    {"stale", stale},
                    {"cursor", nextCursor},
                    {"max_vehicles", kMaxVehicles},
                }
                    .dump(),
                "application/json");
          });
}
`,
    },
  },
  hints: [
    'Capture one instant before you read any vehicle: `snapshot_at_ms` is what turns a scan into a snapshot. Compare each position against that instant, never against the wall clock at the moment each cache was refreshed.',
    'The freshness rule is `age_ms > FRESHNESS_BOUND_MS` and the response carries `"stale": true` for those vehicles plus a total `stale` count. A vehicle that has not reported in hours is stale, not current.',
    'Scope the query by the tenant and page it: `fleet_vehicles(tenant, fleet_id, cursor, limit)` with `limit` in 1..1000, default 500, capped at 5 000 vehicles per snapshot. Return the next `cursor` whenever the page fills.',
  ],
  debrief: `The interviewer is testing whether you can review a generated read path for consistency, not just compilation. The draft passes the demo because one fleet has three vehicles that all reported a second ago. Three defects are being checked: the snapshot instant (a lazily refreshed per-vehicle cache produces a fleet assembled from a five-minute window), the freshness bound (hours-old vehicles must be flagged stale), and the read contract (tenant scope, a 5 000-vehicle cap, limit/cursor pagination). Real platforms add a read-through cache keyed by the snapshot instant, a separate stale-vehicle count metric, and geohash-bounded queries for viewport reads.`,
};
