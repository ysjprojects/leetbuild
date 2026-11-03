import type {Step} from '@/lib/types';

/**
 * The route cache in front of the routing engine: coordinate cells make near-identical requests
 * hit, the traffic epoch makes sure a hit is never confused with a fresher traffic state, and a
 * bounded TTL makes old epochs leave Redis instead of accumulating.
 */
export const stateStep: Step = {
  id: 'state',
  title: 'Redis route cache with a traffic epoch key',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'engine'],
  task: `## Task

**Starting point.** The starter is the route cache that fronts the routing engine on
\`POST /v1/routes\`: it looks up a Redis key built from the raw origin, destination and mode,
calls the engine on a miss, stores the geometry and returns it. It serves the demo and hides five
flaws.

**Failure mode the checks target.** Raw floats as keys make every request a miss on GPS noise.
Once a key does match, an epoch-less entry serves a rush-hour route at midnight with no way for the
caller to tell, and with no expiry every cell ever requested stays in Redis.

- **Cell key.** Round every coordinate to a \`CELL_DEGREES = 0.001\` grid (~110 m) before it goes
  into the key, so two requests for the same corner share one entry despite GPS jitter.
- **Epoch key.** \`route:{origin_cell}:{dest_cell}:{mode}:{epoch}\` with
  \`epoch = floor(unix_seconds / EPOCH_S)\` and \`EPOCH_S = 300\`.
- **Stale-epoch entry.** The stored entry carries the epoch it was computed under, and a read
  serves it only when that epoch equals the current one; a mismatch is a miss: recompute and
  overwrite under the current key.
- **Provenance in the response.** The response reports \`epoch\` and whether the route was
  \`cached\`, so a caller can tell which traffic state the geometry belongs to.
- **Bounded entries.** The write sets an expiry of \`TTL_S = EPOCH_S * 2\`, so old keys leave Redis
  instead of living forever.
- The cache is consulted **before** the engine: only a miss costs an engine call, and the computed
  route is stored before it is returned.`,
  sequence: {
    participants: ['Client', 'Maps API', 'Redis', 'Routing engine'],
    messages: [
      {from: 'Client', to: 'Maps API', label: 'POST /v1/routes · origin · destination · mode', kind: 'sync'},
      {from: 'Maps API', to: 'Redis', label: 'GET route:{cells}:{mode}:{epoch}', kind: 'sync'},
      {from: 'Redis', to: 'Maps API', label: 'entry (epoch matches) / nil', kind: 'reply'},
      {from: 'Maps API', to: 'Routing engine', label: 'ComputeRoute · only on a miss or stale epoch', kind: 'sync'},
      {from: 'Routing engine', to: 'Maps API', label: 'geometry', kind: 'reply'},
      {from: 'Maps API', to: 'Redis', label: 'SET route:{cells}:{mode}:{epoch} EX 600', kind: 'async'},
      {from: 'Maps API', to: 'Client', label: '200 {route, epoch, cached}', kind: 'reply'},
    ],
  },
  hints: [
    'Redis memory grows every day and the hit rate sits near zero, yet one driver who does get a hit at midnight is routed around a traffic jam that cleared six hours ago.',
    'The key is built from unrounded floats, so GPS jitter makes each request unique; the few entries that do match carry no epoch, no expiry, and the response carries no `epoch` or `cached` field.',
    'Add `cell()` with `round(lat / CELL_DEGREES)`, `route_key(…)` ending in `{epoch}` with `epoch = floor(now / EPOCH_S)`, store `epoch` in the entry and compare it on read, `SET … ex=TTL_S` with `TTL_S = EPOCH_S * 2`, and return `epoch` and `cached`.',
  ],
  checks: [
    {
      id: 'cell-key',
      title: 'Keys by rounded coordinate cells',
      detail:
        'Coordinates are rounded onto a ~0.001° grid (`CELL_DEGREES`) before they enter the key, so near-identical requests share one entry. The starter keys raw floats, so a 6th decimal of GPS noise makes every request a miss.',
      match: {
        python: {all: [/CELL_DEGREES/, /def cell\(/, /\bround\(/]},
        typescript: {all: [/CELL_DEGREES/, /function cell\(/, /Math\.round\(/]},
        go: {all: [/cellDegrees/, /func cell\(/, /math\.Round\(/]},
        scala: {all: [/CellDegrees/, /def cell\(/, /math\.round\(/]},
        cpp: {all: [/kCellDegrees/, /long long cell\(/, /std::llround\(/]},
      },
    },
    {
      id: 'epoch-key',
      title: 'The traffic epoch is part of the key',
      detail:
        'The key is `route:{origin_cell}:{dest_cell}:{mode}:{epoch}` with `epoch = floor(unix_seconds / EPOCH_S)`, a five-minute window. Without it, an entry written under one traffic state is addressed by every later request, so a rush-hour route answers at midnight.',
      match: {
        python: {all: [/EPOCH_S/, /def route_key\(/, /\{epoch\}/]},
        typescript: {all: [/EPOCH_S/, /function routeKey\(/, /\$\{epoch\}/]},
        go: {all: [/epochSeconds/, /func routeKey\(/, /%s:%d/]},
        scala: {all: [/EpochSeconds/, /def routeKey\(/, /\$epoch/]},
        cpp: {all: [/kEpochSeconds/, /routeKey/, /std::to_string\(epoch\)/]},
      },
    },
    {
      id: 'stale-epoch',
      title: 'An entry from another epoch is not served',
      detail:
        'The stored entry records the epoch it was computed under and a read compares that with the current epoch; a mismatch is a miss, not a hit — the route is recomputed and overwritten under the current key. The starter serves whatever the key returns.',
      match: {
        python: {all: [/get\("epoch"\)|\["epoch"\]/, /[!=]=\s*epoch/]},
        typescript: {all: [/entry\.epoch/, /[!=]=\s*epoch/]},
        go: {all: [/\.Epoch/, /[!=]=\s*epoch/]},
        scala: {all: [/entry\.epoch/, /[!=]=\s*epoch/]},
        cpp: {all: [/value\("epoch"/, /[!=]=\s*epoch/]},
      },
    },
    {
      id: 'epoch-response',
      title: 'The response reports epoch and hit',
      detail:
        'The response carries the `epoch` the geometry belongs to and a `cached` marker saying whether it came from Redis or the engine. The starter returns geometry with no provenance, so a caller cannot tell a 6 a.m. route from a fresh one.',
      match: {
        python: {all: [/"epoch":\s*epoch/, /"cached":/]},
        typescript: {all: [/\bepoch\b/, /cached:\s*(true|false)/]},
        go: {all: [/"epoch":/, /"cached":/]},
        scala: {all: [/CachedRoute\(/, /\bcached\b/]},
        cpp: {all: [/"epoch",\s*epoch/, /"cached",\s*(true|false)/]},
      },
    },
    {
      id: 'ttl',
      title: 'Cache entries expire',
      detail:
        'The write sets an expiry of `TTL_S = EPOCH_S * 2`, so a superseded epoch’s entries leave Redis on their own. The starter writes without an expiry, so every cell ever requested stays in the keyspace forever.',
      match: {
        python: {all: [/TTL_S\s*=\s*EPOCH_S\s*\*\s*2/, /ex\s*=\s*TTL_S/]},
        typescript: {all: [/TTL_S\s*=\s*EPOCH_S\s*\*\s*2/, /'EX',\s*TTL_S/]},
        go: {all: [/ttlSeconds\s*=\s*epochSeconds\s*\*\s*2/, /time\.Second/]},
        scala: {all: [/TtlSeconds\s*=\s*EpochSeconds\s*\*\s*2/, /setex\(/]},
        cpp: {all: [/kTtlSeconds\s*=\s*kEpochSeconds\s*\*\s*2/, /std::chrono::seconds\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""POST /v1/routes."""
import json

import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)


class Point(BaseModel):
    lat: float
    lng: float


class RouteRequest(BaseModel):
    origin: Point
    destination: Point
    waypoints: list[Point] = []
    mode: str = "driving"


class RoutingEngine:
    def ComputeRoute(self, origin: Point, destination: Point, waypoints: list[Point]) -> dict:
        """The gRPC routing engine call (see the client step)."""
        raise NotImplementedError


engine = RoutingEngine()


@app.post("/v1/routes")
def compute_route(body: RouteRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    key = (
        f"route:{body.origin.lat}:{body.origin.lng}"
        f":{body.destination.lat}:{body.destination.lng}:{body.mode}"
    )
    raw = r.get(key)
    if raw is not None:
        return JSONResponse({"route": json.loads(raw)}, status_code=200)
    route = engine.ComputeRoute(body.origin, body.destination, body.waypoints)
    r.set(key, json.dumps(route))
    return JSONResponse({"route": route}, status_code=200)
`,
      solution: `"""POST /v1/routes: a cell-keyed, epoch-keyed route cache in front of the routing engine."""
import json
import time

import redis
from fastapi import FastAPI, Header
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
r = redis.Redis(host="redis", port=6379, decode_responses=True)

EPOCH_S = 300           # traffic epoch: five minutes
CELL_DEGREES = 0.001    # ~110 m grid: GPS jitter shares a cell, different streets do not
TTL_S = EPOCH_S * 2     # an entry dies one epoch after it stops being servable


class Point(BaseModel):
    lat: float
    lng: float


class RouteRequest(BaseModel):
    origin: Point
    destination: Point
    waypoints: list[Point] = []
    mode: str = "driving"


class RoutingEngine:
    def ComputeRoute(self, origin: Point, destination: Point, waypoints: list[Point]) -> dict:
        """The gRPC routing engine call (see the client step)."""
        raise NotImplementedError


engine = RoutingEngine()


def cell(value: float) -> int:
    """Snap a coordinate onto the cache grid so near-identical requests share one entry."""
    return round(value / CELL_DEGREES)


def route_key(origin: Point, destination: Point, mode: str, epoch: int) -> str:
    return (
        f"route:{cell(origin.lat)}:{cell(origin.lng)}"
        f":{cell(destination.lat)}:{cell(destination.lng)}:{mode}:{epoch}"
    )


def epoch_now() -> int:
    return int(time.time()) // EPOCH_S


def cache_get(origin: Point, destination: Point, mode: str, epoch: int) -> dict | None:
    raw = r.get(route_key(origin, destination, mode, epoch))
    if raw is None:
        return None
    entry = json.loads(raw)
    if entry.get("epoch") != epoch:
        # computed under a different traffic epoch: a miss, never a hit
        return None
    return entry


def cache_put(origin: Point, destination: Point, mode: str, epoch: int, route: dict) -> None:
    entry = {"route": route, "epoch": epoch}
    r.set(route_key(origin, destination, mode, epoch), json.dumps(entry), ex=TTL_S)


@app.post("/v1/routes")
def compute_route(body: RouteRequest, tenant: str = Header(alias="X-Tenant-Id")) -> JSONResponse:
    epoch = epoch_now()
    entry = cache_get(body.origin, body.destination, body.mode, epoch)
    cached = entry is not None
    if cached:
        route = entry["route"]
    else:
        route = engine.ComputeRoute(body.origin, body.destination, body.waypoints)
        cache_put(body.origin, body.destination, body.mode, epoch, route)
    return JSONResponse({"route": route, "epoch": epoch, "cached": cached}, status_code=200)
`,
    },
    typescript: {
      starter: `/** POST /v1/routes. */
import {Redis} from 'ioredis';

import {engine} from './engine';

const r = new Redis('redis://redis:6379');

interface Point {
  lat: number;
  lng: number;
}

interface RouteBody {
  origin: Point;
  destination: Point;
  waypoints: Point[];
  mode: string;
}

export async function routeWithCache(body: RouteBody): Promise<{route: string}> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const key = \`route:\${body.origin.lat}:\${body.origin.lng}:\${body.destination.lat}:\${body.destination.lng}:\${body.mode}\`;
  const raw = await r.get(key);
  if (raw !== null) return {route: JSON.parse(raw) as string};
  const route = await engine.ComputeRoute(body.origin, body.destination, body.waypoints);
  await r.set(key, JSON.stringify(route));
  return {route};
}
`,
      solution: `/** POST /v1/routes: a cell-keyed, epoch-keyed route cache in front of the routing engine. */
import {Redis} from 'ioredis';

import {engine} from './engine';

const r = new Redis('redis://redis:6379');

const EPOCH_S = 300; // traffic epoch: five minutes
const CELL_DEGREES = 0.001; // ~110 m grid: GPS jitter shares a cell, different streets do not
const TTL_S = EPOCH_S * 2; // an entry dies one epoch after it stops being servable

interface Point {
  lat: number;
  lng: number;
}

interface RouteBody {
  origin: Point;
  destination: Point;
  waypoints: Point[];
  mode: string;
}

interface RouteEntry {
  route: string;
  epoch: number;
}

function cell(value: number): number {
  return Math.round(value / CELL_DEGREES);
}

function routeKey(origin: Point, destination: Point, mode: string, epoch: number): string {
  return \`route:\${cell(origin.lat)}:\${cell(origin.lng)}:\${cell(destination.lat)}:\${cell(destination.lng)}:\${mode}:\${epoch}\`;
}

function epochNow(): number {
  return Math.floor(Date.now() / 1000 / EPOCH_S);
}

async function cacheGet(
  origin: Point,
  destination: Point,
  mode: string,
  epoch: number,
): Promise<RouteEntry | null> {
  const raw = await r.get(routeKey(origin, destination, mode, epoch));
  if (raw === null) return null;
  const entry = JSON.parse(raw) as RouteEntry;
  if (entry.epoch !== epoch) return null; // computed under another traffic epoch: recompute
  return entry;
}

async function cachePut(
  origin: Point,
  destination: Point,
  mode: string,
  epoch: number,
  route: string,
): Promise<void> {
  const entry: RouteEntry = {route, epoch};
  await r.set(routeKey(origin, destination, mode, epoch), JSON.stringify(entry), 'EX', TTL_S);
}

export async function routeWithCache(body: RouteBody): Promise<{route: string; epoch: number; cached: boolean}> {
  const epoch = epochNow();
  const entry = await cacheGet(body.origin, body.destination, body.mode, epoch);
  if (entry !== null) return {route: entry.route, epoch, cached: true};
  const route = await engine.ComputeRoute(body.origin, body.destination, body.waypoints);
  await cachePut(body.origin, body.destination, body.mode, epoch, route);
  return {route, epoch, cached: false};
}
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/redis/go-redis/v9"
)

type Point struct {
	Lat float64 \`json:"lat"\`
	Lng float64 \`json:"lng"\`
}

type RouteRequest struct {
	Origin      Point   \`json:"origin"\`
	Destination Point   \`json:"destination"\`
	Waypoints   []Point \`json:"waypoints"\`
	Mode        string  \`json:"mode"\`
}

var (
	rdb    *redis.Client
	engine RoutingEngineClient
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func handleRoute(rw http.ResponseWriter, r *http.Request) {
	var body RouteRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	key := fmt.Sprintf("route:%v:%v:%v:%v:%s", body.Origin.Lat, body.Origin.Lng, body.Destination.Lat, body.Destination.Lng, body.Mode)
	if raw, err := rdb.Get(r.Context(), key).Bytes(); err == nil {
		writeJSON(rw, http.StatusOK, map[string]any{"route": string(raw)})
		return
	}
	reply, err := engine.ComputeRoute(r.Context(), &ComputeRouteRequest{
		Origin:      &body.Origin,
		Destination: &body.Destination,
		Waypoints:   body.Waypoints,
		Mode:        body.Mode,
	})
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "engine failed"})
		return
	}
	rdb.Set(r.Context(), key, reply.Geometry, 0)
	writeJSON(rw, http.StatusOK, map[string]any{"route": reply.Geometry})
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	epochSeconds = 300   // traffic epoch: five minutes
	cellDegrees  = 0.001 // ~110 m grid: GPS jitter shares a cell, different streets do not
	ttlSeconds   = epochSeconds * 2
)

type Point struct {
	Lat float64 \`json:"lat"\`
	Lng float64 \`json:"lng"\`
}

type RouteRequest struct {
	Origin      Point   \`json:"origin"\`
	Destination Point   \`json:"destination"\`
	Waypoints   []Point \`json:"waypoints"\`
	Mode        string  \`json:"mode"\`
}

type RouteEntry struct {
	Route string \`json:"route"\`
	Epoch int64  \`json:"epoch"\`
}

// cell snaps a coordinate onto the cache grid so near-identical requests share one entry.
func cell(value float64) int64 {
	return int64(math.Round(value / cellDegrees))
}

func routeKey(origin, destination Point, mode string, epoch int64) string {
	return fmt.Sprintf(
		"route:%d:%d:%d:%d:%s:%d",
		cell(origin.Lat), cell(origin.Lng), cell(destination.Lat), cell(destination.Lng), mode, epoch,
	)
}

func epochNow() int64 {
	return time.Now().Unix() / epochSeconds
}

func cacheGet(ctx context.Context, origin, destination Point, mode string, epoch int64) (*RouteEntry, bool) {
	raw, err := rdb.Get(ctx, routeKey(origin, destination, mode, epoch)).Bytes()
	if err != nil {
		return nil, false
	}
	var entry RouteEntry
	if json.Unmarshal(raw, &entry) != nil {
		return nil, false
	}
	if entry.Epoch != epoch {
		return nil, false // computed under another traffic epoch: recompute
	}
	return &entry, true
}

func cachePut(ctx context.Context, origin, destination Point, mode string, epoch int64, route string) {
	payload, _ := json.Marshal(RouteEntry{Route: route, Epoch: epoch})
	rdb.Set(ctx, routeKey(origin, destination, mode, epoch), payload, ttlSeconds*time.Second)
}

var (
	rdb    *redis.Client
	engine RoutingEngineClient
)

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func handleRoute(rw http.ResponseWriter, r *http.Request) {
	var body RouteRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	epoch := epochNow()
	entry, hit := cacheGet(r.Context(), body.Origin, body.Destination, body.Mode, epoch)
	if !hit {
		reply, err := engine.ComputeRoute(r.Context(), &ComputeRouteRequest{
			Origin:      &body.Origin,
			Destination: &body.Destination,
			Waypoints:   body.Waypoints,
			Mode:        body.Mode,
		})
		if err != nil {
			writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "engine failed"})
			return
		}
		entry = &RouteEntry{Route: reply.Geometry, Epoch: epoch}
		cachePut(r.Context(), body.Origin, body.Destination, body.Mode, epoch, entry.Route)
	}
	writeJSON(rw, http.StatusOK, map[string]any{"route": entry.Route, "epoch": entry.Epoch, "cached": hit})
}
`,
    },
    scala: {
      starter: `import java.nio.charset.StandardCharsets

import io.grpc.ManagedChannelBuilder
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Point(lat: Double, lng: Double)

final case class RouteRequest(origin: Point, destination: Point, waypoints: List[Point] = Nil, mode: String = "driving")

object StateApi {
  implicit val system: ActorSystem = ActorSystem("maps-routing")
  implicit val routeRequestFormat: RootJsonFormat[RouteRequest] = jsonFormat4(RouteRequest)

  val jedis = new Jedis("redis", 6379)
  val stub = RoutingEngineGrpc.blockingStub(ManagedChannelBuilder.forAddress("engine", 9000).usePlaintext().build())

  val route: Route =
    path("v1" / "routes") {
      post {
        headerValueByName("X-Tenant-Id") { _ =>
          entity(as[RouteRequest]) { body =>
            // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
            val key = s"route:\${body.origin.lat}:\${body.origin.lng}:\${body.destination.lat}:\${body.destination.lng}:\${body.mode}"
            Option(jedis.get(key)) match {
              case Some(payload) =>
                complete(StatusCodes.OK, payload)
              case None =>
                val geometry = stub
                  .computeRoute(
                    ComputeRouteRequest(origin = body.origin, destination = body.destination, mode = body.mode)
                  )
                  .geometry
                jedis.set(key, geometry)
                complete(StatusCodes.OK, geometry)
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
      solution: `import java.nio.charset.StandardCharsets

import io.grpc.ManagedChannelBuilder
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import redis.clients.jedis.Jedis
import spray.json.DefaultJsonProtocol._
import spray.json.RootJsonFormat

final case class Point(lat: Double, lng: Double)

final case class RouteRequest(origin: Point, destination: Point, waypoints: List[Point] = Nil, mode: String = "driving")

final case class RouteEntry(route: String, epoch: Long)

final case class CachedRoute(route: String, epoch: Long, cached: Boolean)

object StateApi {
  implicit val system: ActorSystem = ActorSystem("maps-routing")
  implicit val routeRequestFormat: RootJsonFormat[RouteRequest] = jsonFormat4(RouteRequest)
  implicit val routeEntryFormat: RootJsonFormat[RouteEntry] = jsonFormat2(RouteEntry)
  implicit val cachedRouteFormat: RootJsonFormat[CachedRoute] = jsonFormat3(CachedRoute)

  val EpochSeconds = 300L        // traffic epoch: five minutes
  val CellDegrees = 0.001        // ~110 m grid: GPS jitter shares a cell, different streets do not
  val TtlSeconds = EpochSeconds * 2
  val jedis = new Jedis("redis", 6379)
  val stub = RoutingEngineGrpc.blockingStub(ManagedChannelBuilder.forAddress("engine", 9000).usePlaintext().build())

  // cell snaps a coordinate onto the cache grid so near-identical requests share one entry.
  def cell(value: Double): Long = math.round(value / CellDegrees)

  def routeKey(origin: Point, destination: Point, mode: String, epoch: Long): String =
    s"route:\${cell(origin.lat)}:\${cell(origin.lng)}:\${cell(destination.lat)}:\${cell(destination.lng)}:$mode:$epoch"

  def epochNow(): Long = System.currentTimeMillis() / 1000 / EpochSeconds

  def cacheGet(origin: Point, destination: Point, mode: String, epoch: Long): Option[RouteEntry] =
    Option(jedis.get(routeKey(origin, destination, mode, epoch))).flatMap { payload =>
      val entry = payload.parseJson.convertTo[RouteEntry]
      if (entry.epoch != epoch) None // computed under another traffic epoch: recompute
      else Some(entry)
    }

  def cachePut(origin: Point, destination: Point, mode: String, epoch: Long, route: String): Unit =
    jedis.setex(routeKey(origin, destination, mode, epoch), TtlSeconds, RouteEntry(route, epoch).toJson.compactPrint)

  val route: Route =
    path("v1" / "routes") {
      post {
        headerValueByName("X-Tenant-Id") { _ =>
          entity(as[RouteRequest]) { body =>
            val epoch = epochNow()
            cacheGet(body.origin, body.destination, body.mode, epoch) match {
              case Some(entry) =>
                complete(StatusCodes.OK, CachedRoute(entry.route, epoch, cached = true))
              case None =>
                val geometry = stub
                  .computeRoute(
                    ComputeRouteRequest(origin = body.origin, destination = body.destination, mode = body.mode)
                  )
                  .geometry
                cachePut(body.origin, body.destination, body.mode, epoch, geometry)
                complete(StatusCodes.OK, CachedRoute(geometry, epoch, cached = false))
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
      starter: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include "routing.grpc.pb.h"

#include <string>

using json = nlohmann::json;

std::unique_ptr<RoutingEngine::Stub> stub;

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::SSLServer svr("cert.pem", "key.pem");
  auto channel = grpc::CreateChannel("engine:9000", grpc::InsecureChannelCredentials());
  stub = RoutingEngine::NewStub(channel);

  svr.Post("/v1/routes", [&redis](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    const std::string key = "route:" + std::to_string(body["origin"].value("lat", 0.0)) + ":" +
                            std::to_string(body["origin"].value("lng", 0.0)) + ":" +
                            std::to_string(body["destination"].value("lat", 0.0)) + ":" +
                            std::to_string(body["destination"].value("lng", 0.0)) + ":" +
                            body.value("mode", std::string("driving"));
    const auto stored = redis.get(key);
    if (stored) {
      res.status = 200;
      res.set_content(*stored, "application/json");
      return;
    }
    grpc::ClientContext ctx;
    ComputeRouteRequest request;
    request.mutable_origin()->set_lat(body["origin"].value("lat", 0.0));
    request.mutable_origin()->set_lng(body["origin"].value("lng", 0.0));
    request.mutable_destination()->set_lat(body["destination"].value("lat", 0.0));
    request.mutable_destination()->set_lng(body["destination"].value("lng", 0.0));
    request.set_mode(body.value("mode", std::string("driving")));
    ComputeRouteReply reply;
    if (!stub->ComputeRoute(&ctx, request, &reply).ok()) {
      res.status = 502;
      res.set_content(R"({"error":"engine failed"})", "application/json");
      return;
    }
    redis.set(key, reply.geometry());
    res.status = 200;
    res.set_content(json{{"route", reply.geometry()}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include "routing.grpc.pb.h"

#include <chrono>
#include <cmath>
#include <optional>
#include <string>

using json = nlohmann::json;

constexpr long long kEpochSeconds = 300; // traffic epoch: five minutes
constexpr double kCellDegrees = 0.001;   // ~110 m grid
constexpr long long kTtlSeconds = kEpochSeconds * 2;

std::unique_ptr<RoutingEngine::Stub> stub;

// cell snaps a coordinate onto the cache grid so near-identical requests share one entry.
long long cell(double value) {
  return std::llround(value / kCellDegrees);
}

std::string routeKey(const Point& origin, const Point& destination, const std::string& mode, long long epoch) {
  return "route:" + std::to_string(cell(origin.lat())) + ":" + std::to_string(cell(origin.lng())) + ":" +
         std::to_string(cell(destination.lat())) + ":" + std::to_string(cell(destination.lng())) + ":" + mode + ":" +
         std::to_string(epoch);
}

long long epochNow() {
  const auto seconds = std::chrono::duration_cast<std::chrono::seconds>(
                           std::chrono::system_clock::now().time_since_epoch())
                           .count();
  return seconds / kEpochSeconds;
}

std::optional<json> cacheGet(
    sw::redis::Redis& redis,
    const Point& origin,
    const Point& destination,
    const std::string& mode,
    long long epoch) {
  const auto raw = redis.get(routeKey(origin, destination, mode, epoch));
  if (!raw) return std::nullopt;
  const json entry = json::parse(*raw, nullptr, false);
  if (entry.is_discarded()) return std::nullopt;
  if (entry.value("epoch", -1LL) != epoch) return std::nullopt; // stale traffic state: recompute
  return entry;
}

void cachePut(
    sw::redis::Redis& redis,
    const Point& origin,
    const Point& destination,
    const std::string& mode,
    long long epoch,
    const std::string& route) {
  const json entry{{"route", route}, {"epoch", epoch}};
  redis.set(routeKey(origin, destination, mode, epoch), entry.dump(), std::chrono::seconds(kTtlSeconds));
}

int main() {
  sw::redis::Redis redis("tcp://redis:6379");
  httplib::SSLServer svr("cert.pem", "key.pem");
  auto channel = grpc::CreateChannel("engine:9000", grpc::InsecureChannelCredentials());
  stub = RoutingEngine::NewStub(channel);

  svr.Post("/v1/routes", [&redis](const httplib::Request& req, httplib::Response& res) {
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    Point origin{body["origin"].value("lat", 0.0), body["origin"].value("lng", 0.0)};
    Point destination{body["destination"].value("lat", 0.0), body["destination"].value("lng", 0.0)};
    const auto mode = body.value("mode", std::string("driving"));

    const long long epoch = epochNow();
    const auto entry = cacheGet(redis, origin, destination, mode, epoch);
    if (entry) {
      res.status = 200;
      res.set_content(
          json{{"route", (*entry)["route"]}, {"epoch", epoch}, {"cached", true}}.dump(), "application/json");
      return;
    }

    grpc::ClientContext ctx;
    ComputeRouteRequest request;
    request.mutable_origin()->set_lat(origin.lat());
    request.mutable_origin()->set_lng(origin.lng());
    request.mutable_destination()->set_lat(destination.lat());
    request.mutable_destination()->set_lng(destination.lng());
    request.set_mode(mode);
    ComputeRouteReply reply;
    if (!stub->ComputeRoute(&ctx, request, &reply).ok()) {
      res.status = 502;
      res.set_content(R"({"error":"engine failed"})", "application/json");
      return;
    }
    cachePut(redis, origin, destination, mode, epoch, reply.geometry());
    res.status = 200;
    res.set_content(
        json{{"route", reply.geometry()}, {"epoch", epoch}, {"cached", false}}.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
  },
  debrief: `The fix has the shape of a key that says what two requests are allowed to share. The cell size decides how much GPS noise and map-snapping difference an entry tolerates, and the traffic epoch decides how old a route may be before it is a different route. Keeping the epoch inside the entry as well as in the key lets a reader verify provenance instead of trusting the key alone, and the \`epoch\` and \`cached\` fields hand that provenance to the client, the fallback in the next step and the telemetry. The TTL is twice the epoch so entries survive one bump and then leave on their own.

Production maps caches vary the cell size with road density (H3 or geohash tiles) and invalidate cells explicitly on road closures instead of waiting for the next epoch.`,
};
