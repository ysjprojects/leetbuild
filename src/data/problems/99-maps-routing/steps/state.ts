import type {Step} from '@/lib/types';

/**
 * The route cache in front of the routing engine: snapped cells make near-identical requests hit,
 * the waypoints keep a detour from being served the direct route, the traffic epoch makes an entry
 * stop matching when the traffic it was solved for is gone, and a degraded estimate is never stored.
 */
export const stateStep: Step = {
  id: 'state',
  title: 'Redis route cache keyed by cell and traffic epoch',
  concept: 'redis',
  file: 'state',
  focus: ['api', 'redis', 'engine'],
  task: `## Task

**Starting point.** The starter is the route cache in front of the engine:
\`cached_route(origin, destination, waypoints)\` reads \`route:{origin}:{destination}\` (the raw floats)
from Redis and, on a miss, calls \`compute_route(origin, destination, waypoints, current_epoch())\`
(step 3's client, provided as \`mapsd.engine\`) and stores the route as JSON. It serves the demo and
hides five flaws.

**Failure mode the checks target.** GPS noise makes every request a miss; a trip through a waypoint
is served the direct route; a route solved at rush hour is still served at midnight; entries never
leave Redis; and while the engine is down, the straight-line estimate is cached and keeps being
served after it recovers.

- The key is \`route:{epoch}:{cells}\`: \`epoch\` is \`current_epoch()\`, and \`cells\` are the origin,
  each waypoint and the destination, each \`"{floor(lat / CELL_DEGREES)},{floor(lng / CELL_DEGREES)}"\`
  with \`CELL_DEGREES = 0.001\` (about 110 m), joined by \`;\`.
- An entry expires after \`TTL_S = 2 * EPOCH_S\` (600 s).
- A route marked \`degraded\` is returned but not stored.`,
  sequence: {
    participants: ['Maps API', 'Redis', 'Routing engine'],
    messages: [
      {
        from: 'Maps API',
        to: 'Maps API',
        label: 'key = route:{epoch}:{cell(origin)};{cell(waypoint)}…;{cell(destination)}',
        kind: 'sync',
      },
      {from: 'Maps API', to: 'Redis', label: 'GET key', kind: 'sync'},
      {from: 'Redis', to: 'Maps API', label: 'route JSON / nil', kind: 'reply'},
      {from: 'Maps API', to: 'Routing engine', label: 'compute_route(…, epoch) on a miss', kind: 'sync'},
      {from: 'Routing engine', to: 'Maps API', label: 'route (or degraded estimate)', kind: 'reply'},
      {from: 'Maps API', to: 'Redis', label: 'SET key route EX 600 · unless degraded', kind: 'async'},
    ],
  },
  checks: [
    {
      id: 'cell-key',
      title: 'Two requests a few metres apart share one entry',
      detail:
        'Every point is snapped to a `CELL_DEGREES` grid with a floor before it enters the key, so GPS noise lands in the same cell; the starter keys the raw floats and solves every request again.',
      match: {
        python: {all: [/\/\s*CELL_DEGREES/, /math\.floor\(/]},
        typescript: {all: [/\/\s*CELL_DEGREES/, /Math\.floor\(/]},
        go: {all: [/\/\s*cellDegrees/, /math\.Floor\(/]},
        scala: {all: [/\/\s*CellDegrees/, /math\.floor\(/]},
        cpp: {all: [/\/\s*kCellDegrees/, /std::floor\(/]},
      },
    },
    {
      id: 'waypoint-key',
      title: 'A trip through a waypoint is a different entry',
      detail:
        "The waypoints' cells are part of the key, so a detour is solved instead of being served the direct route; the starter's key has the two endpoints only.",
      match: {
        python: {all: [/def route_key\([^)]*waypoints/, /route_key\([^)]*waypoints\)/]},
        typescript: {all: [/routeKey\s*=\s*\([^)]*waypoints|function routeKey\([^)]*waypoints/]},
        go: {all: [/func routeKey\([^)]*waypoints/]},
        scala: {all: [/def routeKey\([^)]*waypoints/]},
        cpp: {all: [/std::string routeKey\([^)]*waypoints/]},
      },
    },
    {
      id: 'epoch-key',
      title: 'The traffic epoch is part of the key',
      detail:
        'The key starts `route:{epoch}:`, so a route solved for an earlier traffic state stops matching when the epoch moves; the starter serves it until something deletes it.',
      match: {
        python: {all: [/route:\{epoch\}/]},
        typescript: {all: [/route:\$\{epoch\}/]},
        go: {all: [/"route:%d:|"route:"\s*\+\s*strconv\.FormatInt\(epoch/]},
        scala: {all: [/s"route:\$epoch|s"route:\$\{epoch\}/]},
        cpp: {all: [/"route:"\s*\+\s*std::to_string\(epoch\)/]},
      },
    },
    {
      id: 'ttl',
      title: 'An entry expires after two epochs',
      detail:
        'The write sets an expiry of `TTL_S` (600 s), so superseded entries leave Redis; the starter writes with no expiry.',
      match: {
        python: {all: [/TTL_S\s*=\s*2\s*\*\s*EPOCH_S|TTL_S\s*=\s*600/, /ex\s*=\s*TTL_S/]},
        typescript: {all: [/TTL_S\s*=\s*2\s*\*\s*EPOCH_S|TTL_S\s*=\s*600/, /['"]EX['"],\s*TTL_S/]},
        go: {
          all: [
            /ttl\s*=\s*2\s*\*\s*geo\.EpochS\s*\*\s*time\.Second|ttl\s*=\s*600\s*\*\s*time\.Second/,
            /rdb\.Set\([^\n]*,\s*ttl\)/,
          ],
        },
        scala: {all: [/TtlS\s*(:\s*Long\s*)?=\s*(2\s*\*\s*Geo\.EpochS|600)/, /\.ex\(\s*TtlS\s*\)/]},
        cpp: {all: [/kTtl\{2\s*\*\s*geo::kEpochS\}|kTtl\{600\}/, /redis\.set\([^\n]*kTtl\)/]},
      },
    },
    {
      id: 'degraded-uncached',
      title: 'A degraded estimate is not cached',
      detail:
        "The write happens only when the route is not `degraded`, so the engine's recovery reaches the next request; the starter caches the straight-line estimate for as long as the entry lives.",
      match: {
        python: {order: [/route\["degraded"\]/, /r\.set\(/]},
        typescript: {order: [/route\.degraded/, /redis\.set\(/]},
        go: {order: [/route\.Degraded/, /rdb\.Set\(/]},
        scala: {order: [/route\.degraded/, /jedis\.set\(/]},
        cpp: {order: [/route\.degraded/, /redis\.set\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import redis

from mapsd.engine import compute_route  # compute_route(origin, destination, waypoints, epoch) -> route
from mapsd.geo import current_epoch

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def route_key(origin, destination) -> str:
    return f"route:{origin.lat},{origin.lng}:{destination.lat},{destination.lng}"


def cached_route(origin, destination, waypoints) -> dict:
    """The route for the trip at the current traffic epoch, from the cache or the engine."""
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    key = route_key(origin, destination)
    raw = r.get(key)
    if raw is not None:
        return json.loads(raw)
    route = compute_route(origin, destination, waypoints, current_epoch())
    r.set(key, json.dumps(route))
    return route
`,
      solution: `import json
import math

import redis

from mapsd.engine import compute_route  # compute_route(origin, destination, waypoints, epoch) -> route
from mapsd.geo import EPOCH_S, current_epoch

CELL_DEGREES = 0.001
TTL_S = 2 * EPOCH_S

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def cell(point) -> str:
    return f"{math.floor(point.lat / CELL_DEGREES)},{math.floor(point.lng / CELL_DEGREES)}"


def route_key(epoch: int, origin, destination, waypoints) -> str:
    return f"route:{epoch}:" + ";".join(cell(p) for p in [origin, *waypoints, destination])


def cached_route(origin, destination, waypoints) -> dict:
    """The route for the trip at the current traffic epoch, from the cache or the engine."""
    epoch = current_epoch()
    key = route_key(epoch, origin, destination, waypoints)
    raw = r.get(key)
    if raw is not None:
        return json.loads(raw)
    route = compute_route(origin, destination, waypoints, epoch)
    # An estimate is for this request only: the next one should reach the recovered engine.
    if not route["degraded"]:
        r.set(key, json.dumps(route), ex=TTL_S)
    return route
`,
    },
    typescript: {
      starter: `import Redis from 'ioredis';

import {computeRoute} from 'mapsd/engine'; // computeRoute(origin, destination, waypoints, epoch): Promise<Route>
import {type Point, type Route, currentEpoch} from 'mapsd/geo';

const redis = new Redis({host: 'redis', port: 6379});

export const routeKey = (origin: Point, destination: Point): string =>
  \`route:\${origin.lat},\${origin.lng}:\${destination.lat},\${destination.lng}\`;

/** The route for the trip at the current traffic epoch, from the cache or the engine. */
export async function cachedRoute(origin: Point, destination: Point, waypoints: Point[]): Promise<Route> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const key = routeKey(origin, destination);
  const raw = await redis.get(key);
  if (raw !== null) return JSON.parse(raw) as Route;
  const route = await computeRoute(origin, destination, waypoints, currentEpoch());
  await redis.set(key, JSON.stringify(route));
  return route;
}
`,
      solution: `import Redis from 'ioredis';

import {computeRoute} from 'mapsd/engine'; // computeRoute(origin, destination, waypoints, epoch): Promise<Route>
import {EPOCH_S, type Point, type Route, currentEpoch} from 'mapsd/geo';

export const CELL_DEGREES = 0.001;
export const TTL_S = 2 * EPOCH_S;

const redis = new Redis({host: 'redis', port: 6379});

const cell = (point: Point): string => \`\${Math.floor(point.lat / CELL_DEGREES)},\${Math.floor(point.lng / CELL_DEGREES)}\`;

export const routeKey = (epoch: number, origin: Point, destination: Point, waypoints: Point[]): string =>
  \`route:\${epoch}:\${[origin, ...waypoints, destination].map(cell).join(';')}\`;

/** The route for the trip at the current traffic epoch, from the cache or the engine. */
export async function cachedRoute(origin: Point, destination: Point, waypoints: Point[]): Promise<Route> {
  const epoch = currentEpoch();
  const key = routeKey(epoch, origin, destination, waypoints);
  const raw = await redis.get(key);
  if (raw !== null) return JSON.parse(raw) as Route;
  const route = await computeRoute(origin, destination, waypoints, epoch);
  // An estimate is for this request only: the next one should reach the recovered engine.
  if (!route.degraded) await redis.set(key, JSON.stringify(route), 'EX', TTL_S);
  return route;
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/redis/go-redis/v9"

	"mapsd/engine" // engine.ComputeRoute(ctx, origin, destination, waypoints, epoch) (geo.Route, error)
	"mapsd/geo"    // geo.Point, geo.Route, geo.CurrentEpoch
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func routeKey(origin, destination geo.Point) string {
	return fmt.Sprintf("route:%v,%v:%v,%v", origin.Lat, origin.Lng, destination.Lat, destination.Lng)
}

// cachedRoute is the route for the trip at the current traffic epoch, from the cache or the engine.
func cachedRoute(ctx context.Context, origin, destination geo.Point, waypoints []geo.Point) (geo.Route, error) {
	// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
	key := routeKey(origin, destination)
	if raw, err := rdb.Get(ctx, key).Result(); err == nil {
		var route geo.Route
		if json.Unmarshal([]byte(raw), &route) == nil {
			return route, nil
		}
	}
	route, err := engine.ComputeRoute(ctx, origin, destination, waypoints, geo.CurrentEpoch())
	if err != nil {
		return geo.Route{}, err
	}
	value, _ := json.Marshal(route)
	rdb.Set(ctx, key, string(value), 0)
	return route, nil
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"mapsd/engine" // engine.ComputeRoute(ctx, origin, destination, waypoints, epoch) (geo.Route, error)
	"mapsd/geo"    // geo.Point, geo.Route, geo.CurrentEpoch
)

const (
	cellDegrees = 0.001
	ttl         = 2 * geo.EpochS * time.Second
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func cell(p geo.Point) string {
	return fmt.Sprintf("%d,%d", int64(math.Floor(p.Lat/cellDegrees)), int64(math.Floor(p.Lng/cellDegrees)))
}

func routeKey(epoch int64, origin, destination geo.Point, waypoints []geo.Point) string {
	cells := []string{cell(origin)}
	for _, p := range waypoints {
		cells = append(cells, cell(p))
	}
	cells = append(cells, cell(destination))
	return fmt.Sprintf("route:%d:%s", epoch, strings.Join(cells, ";"))
}

// cachedRoute is the route for the trip at the current traffic epoch, from the cache or the engine.
func cachedRoute(ctx context.Context, origin, destination geo.Point, waypoints []geo.Point) (geo.Route, error) {
	epoch := geo.CurrentEpoch()
	key := routeKey(epoch, origin, destination, waypoints)
	if raw, err := rdb.Get(ctx, key).Result(); err == nil {
		var route geo.Route
		if json.Unmarshal([]byte(raw), &route) == nil {
			return route, nil
		}
	}
	route, err := engine.ComputeRoute(ctx, origin, destination, waypoints, epoch)
	if err != nil {
		return geo.Route{}, err
	}
	// An estimate is for this request only: the next one should reach the recovered engine.
	if !route.Degraded {
		value, _ := json.Marshal(route)
		rdb.Set(ctx, key, string(value), ttl)
	}
	return route, nil
}
`,
    },
    scala: {
      starter: `import redis.clients.jedis.JedisPooled
import spray.json._

import mapsd.{Engine, Geo} // Engine.computeRoute(origin, destination, waypoints, epoch), Geo.currentEpoch

object Cache {
  val jedis = new JedisPooled("redis", 6379)

  def routeKey(origin: Geo.Point, destination: Geo.Point): String =
    s"route:\${origin.lat},\${origin.lng}:\${destination.lat},\${destination.lng}"

  /** The route for the trip at the current traffic epoch, from the cache or the engine. */
  def cachedRoute(origin: Geo.Point, destination: Geo.Point, waypoints: Seq[Geo.Point]): Geo.Route = {
    // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    val key = routeKey(origin, destination)
    Option(jedis.get(key)) match {
      case Some(raw) => Geo.routeFromJson(raw.parseJson.asJsObject)
      case None =>
        val route = Engine.computeRoute(origin, destination, waypoints, Geo.currentEpoch())
        jedis.set(key, Geo.toJson(route).compactPrint)
        route
    }
  }
}
`,
      solution: `import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

import mapsd.{Engine, Geo} // Engine.computeRoute(origin, destination, waypoints, epoch), Geo.currentEpoch

object Cache {
  val CellDegrees = 0.001
  val TtlS: Long = 2 * Geo.EpochS

  val jedis = new JedisPooled("redis", 6379)

  def cell(p: Geo.Point): String = s"\${math.floor(p.lat / CellDegrees).toLong},\${math.floor(p.lng / CellDegrees).toLong}"

  def routeKey(epoch: Long, origin: Geo.Point, destination: Geo.Point, waypoints: Seq[Geo.Point]): String =
    s"route:$epoch:" + (origin +: waypoints :+ destination).map(cell).mkString(";")

  /** The route for the trip at the current traffic epoch, from the cache or the engine. */
  def cachedRoute(origin: Geo.Point, destination: Geo.Point, waypoints: Seq[Geo.Point]): Geo.Route = {
    val epoch = Geo.currentEpoch()
    val key = routeKey(epoch, origin, destination, waypoints)
    Option(jedis.get(key)) match {
      case Some(raw) => Geo.routeFromJson(raw.parseJson.asJsObject)
      case None =>
        val route = Engine.computeRoute(origin, destination, waypoints, epoch)
        // An estimate is for this request only: the next one should reach the recovered engine.
        if (!route.degraded) jedis.set(key, Geo.toJson(route).compactPrint, SetParams.setParams().ex(TtlS))
        route
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <string>
#include <vector>

#include "mapsd/engine.h"  // engine::computeRoute(origin, destination, waypoints, epoch) -> geo::Route
#include "mapsd/geo.h"     // geo::Point, geo::Route, geo::currentEpoch, geo::toJson, geo::routeFromJson

sw::redis::Redis redis("tcp://redis:6379");

std::string routeKey(const geo::Point& origin, const geo::Point& destination) {
  return "route:" + std::to_string(origin.lat) + "," + std::to_string(origin.lng) + ":" + std::to_string(destination.lat) + "," +
         std::to_string(destination.lng);
}

// The route for the trip at the current traffic epoch, from the cache or the engine.
geo::Route cachedRoute(const geo::Point& origin, const geo::Point& destination, const std::vector<geo::Point>& waypoints) {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  const std::string key = routeKey(origin, destination);
  if (const auto raw = redis.get(key)) return geo::routeFromJson(nlohmann::json::parse(*raw));
  const geo::Route route = engine::computeRoute(origin, destination, waypoints, geo::currentEpoch());
  redis.set(key, geo::toJson(route).dump());
  return route;
}
`,
      solution: `#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cmath>
#include <string>
#include <vector>

#include "mapsd/engine.h"  // engine::computeRoute(origin, destination, waypoints, epoch) -> geo::Route
#include "mapsd/geo.h"     // geo::Point, geo::Route, geo::currentEpoch, geo::toJson, geo::routeFromJson

constexpr double kCellDegrees = 0.001;
constexpr std::chrono::seconds kTtl{2 * geo::kEpochS};

sw::redis::Redis redis("tcp://redis:6379");

std::string cell(const geo::Point& p) {
  return std::to_string(static_cast<long long>(std::floor(p.lat / kCellDegrees))) + "," +
         std::to_string(static_cast<long long>(std::floor(p.lng / kCellDegrees)));
}

std::string routeKey(long long epoch, const geo::Point& origin, const geo::Point& destination, const std::vector<geo::Point>& waypoints) {
  std::string key = "route:" + std::to_string(epoch) + ":" + cell(origin);
  for (const geo::Point& p : waypoints) key += ";" + cell(p);
  return key + ";" + cell(destination);
}

// The route for the trip at the current traffic epoch, from the cache or the engine.
geo::Route cachedRoute(const geo::Point& origin, const geo::Point& destination, const std::vector<geo::Point>& waypoints) {
  const long long epoch = geo::currentEpoch();
  const std::string key = routeKey(epoch, origin, destination, waypoints);
  if (const auto raw = redis.get(key)) return geo::routeFromJson(nlohmann::json::parse(*raw));
  const geo::Route route = engine::computeRoute(origin, destination, waypoints, epoch);
  // An estimate is for this request only: the next one should reach the recovered engine.
  if (!route.degraded) redis.set(key, geo::toJson(route).dump(), kTtl);
  return route;
}
`,
    },
  },
  harness: {
    python: `import grpc

import maps_routing_pb2
import maps_routing_pb2_grpc
from mapsd.geo import EPOCH_S, Point, current_epoch, haversine_m

SF = Point(37.77412, -122.41942)
SF_JITTER = Point(37.77415, -122.41945)  # 4 m away, in the same cell
SF_TWO_BLOCKS = Point(37.77612, -122.41942)  # 220 m north
OAKLAND = Point(37.80418, -122.27112)
BERKELEY = Point(37.87159, -122.27275)


class Engine(maps_routing_pb2_grpc.RoutingEngineServicer):
    """A road route is 1.3 times the great-circle legs."""

    def ComputeRoute(self, request, context):
        points = [request.origin, *request.waypoints, request.destination]
        distance = 1.3 * sum(haversine_m(a, b) for a, b in zip(points, points[1:]))
        return maps_routing_pb2.ComputeRouteReply(distance_m=distance, duration_s=distance / 11, geometry=f"poly:{len(points)}", engine_version="osrm-v26.9")


def _cache(ctx):
    ctx.grpc.serve(maps_routing_pb2_grpc.add_RoutingEngineServicer_to_server, Engine())
    return ctx.load("state")


def _solves(ctx):
    return len(ctx.grpc.calls_to("ComputeRoute"))


def check_cell_key(ctx):
    m = _cache(ctx)
    first = m.cached_route(SF, OAKLAND, [])
    again = m.cached_route(SF_JITTER, OAKLAND, [])
    assert _solves(ctx) == 1, f"two requests 4 m apart cost {_solves(ctx)} engine solves: GPS noise must land in the same cell and hit the cache"
    assert again["distance_m"] == first["distance_m"], f"the cached answer differs from the first: {again} vs {first}"
    m.cached_route(SF_TWO_BLOCKS, OAKLAND, [])
    assert _solves(ctx) == 2, "a request starting two blocks away is another trip: it must be solved, not served from the cache"


def check_waypoint_key(ctx):
    m = _cache(ctx)
    direct = m.cached_route(SF, OAKLAND, [])
    via = m.cached_route(SF, OAKLAND, [BERKELEY])
    assert _solves(ctx) == 2, "a trip through Berkeley was served the direct route from the cache: the waypoints are part of the trip and of the key"
    assert via["distance_m"] > direct["distance_m"], f"the trip through Berkeley answered {via['distance_m']:.0f} m, the direct one {direct['distance_m']:.0f} m"
    again = m.cached_route(SF, OAKLAND, [BERKELEY])
    assert _solves(ctx) == 2 and again["distance_m"] == via["distance_m"], "the same trip through Berkeley, asked again, must hit the cache"


def check_epoch_key(ctx):
    m = _cache(ctx)
    before = m.cached_route(SF, OAKLAND, [])
    ctx.clock.advance(EPOCH_S)
    after = m.cached_route(SF, OAKLAND, [])
    assert _solves(ctx) == 2, "after the traffic epoch moved, the route solved for the previous epoch was served from the cache: the epoch must be part of the key"
    assert before["epoch"] == current_epoch() - 1 and after["epoch"] == current_epoch(), f"the answers carry epochs {before['epoch']} and {after['epoch']}, expected {current_epoch() - 1} and {current_epoch()}"


def check_ttl(ctx):
    m = _cache(ctx)
    m.cached_route(SF, OAKLAND, [])
    keys = ctx.redis.keys("route:*")
    assert len(keys) == 1, f"one solved trip left {keys} in Redis, expected one route:* entry"
    ttl = ctx.redis.ttl(keys[0])
    assert 0 < ttl <= 600, f"{keys[0]} has TTL {ttl}: an entry must expire after TTL_S = 600 s, or every cell ever asked for stays in Redis"
    ctx.clock.advance(601)
    assert not ctx.redis.exists(keys[0]), f"{keys[0]} is still in Redis 601 s after it was written"


def check_degraded_uncached(ctx):
    m = _cache(ctx)
    ctx.grpc.fail("ComputeRoute", grpc.StatusCode.UNAVAILABLE, "engine restarting", times=3)
    down = m.cached_route(SF, OAKLAND, [])
    assert down["degraded"] is True, f"with the engine unavailable for three attempts the answer must be the degraded estimate, got {down}"
    assert ctx.redis.keys("route:*") == [], f"the degraded estimate was stored as {ctx.redis.keys('route:*')}: it would be served after the engine recovers"
    up = m.cached_route(SF, OAKLAND, [])
    assert up["degraded"] is False, "the engine is back, but the next request got the straight-line estimate from the cache"
`,
    typescript: `const SF = {lat: 37.77412, lng: -122.41942};
const SF_JITTER = {lat: 37.77415, lng: -122.41945}; // 4 m away, in the same cell
const SF_TWO_BLOCKS = {lat: 37.77612, lng: -122.41942}; // 220 m north
const OAKLAND = {lat: 37.80418, lng: -122.27112};
const BERKELEY = {lat: 37.87159, lng: -122.27275};

/** The engine stand-in (a road route is 1.3 times the great-circle legs) and the learner's cache. */
function cache(ctx) {
  const geo = ctx.load('/support/mapsd/geo.ts');
  const pkg = ctx.proto('maps_routing.proto');
  ctx.grpc.serve(pkg.mapsrouting.RoutingEngine.service, {
    ComputeRoute(call, callback) {
      const points = [call.request.origin, ...call.request.waypoints, call.request.destination];
      let distance = 0;
      for (let i = 1; i < points.length; i += 1) distance += geo.haversineM(points[i - 1], points[i]);
      distance *= 1.3;
      callback(null, {distance_m: distance, duration_s: distance / 11, geometry: \`poly:\${points.length}\`, engine_version: 'osrm-v26.9'});
    },
  });
  return {m: ctx.load('state'), geo};
}

const solves = ctx => ctx.grpc.callsTo('ComputeRoute').length;

export async function check_cell_key(ctx) {
  const {m} = cache(ctx);
  const first = await m.cachedRoute(SF, OAKLAND, []);
  const again = await m.cachedRoute(SF_JITTER, OAKLAND, []);
  assert.equal(solves(ctx), 1, \`two requests 4 m apart cost \${solves(ctx)} engine solves: GPS noise must land in the same cell and hit the cache\`);
  assert.equal(again.distance_m, first.distance_m, 'the cached answer differs from the first');
  await m.cachedRoute(SF_TWO_BLOCKS, OAKLAND, []);
  assert.equal(solves(ctx), 2, 'a request starting two blocks away is another trip: it must be solved, not served from the cache');
}

export async function check_waypoint_key(ctx) {
  const {m} = cache(ctx);
  const direct = await m.cachedRoute(SF, OAKLAND, []);
  const via = await m.cachedRoute(SF, OAKLAND, [BERKELEY]);
  assert.equal(solves(ctx), 2, 'a trip through Berkeley was served the direct route from the cache: the waypoints are part of the trip and of the key');
  assert(via.distance_m > direct.distance_m, \`the trip through Berkeley answered \${via.distance_m} m, the direct one \${direct.distance_m} m\`);
  const again = await m.cachedRoute(SF, OAKLAND, [BERKELEY]);
  assert(solves(ctx) === 2 && again.distance_m === via.distance_m, 'the same trip through Berkeley, asked again, must hit the cache');
}

export async function check_epoch_key(ctx) {
  const {m, geo} = cache(ctx);
  const before = await m.cachedRoute(SF, OAKLAND, []);
  ctx.clock.advance(geo.EPOCH_S);
  const after = await m.cachedRoute(SF, OAKLAND, []);
  assert.equal(solves(ctx), 2, 'after the traffic epoch moved, the route solved for the previous epoch was served from the cache: the epoch must be part of the key');
  const now = geo.currentEpoch();
  assert(before.epoch === now - 1 && after.epoch === now, \`the answers carry epochs \${before.epoch} and \${after.epoch}, expected \${now - 1} and \${now}\`);
}

export async function check_ttl(ctx) {
  const {m} = cache(ctx);
  await m.cachedRoute(SF, OAKLAND, []);
  const keys = ctx.redis.keys('route:*');
  assert.equal(keys.length, 1, \`one solved trip left \${JSON.stringify(keys)} in Redis, expected one route:* entry\`);
  const ttl = ctx.redis.ttl(keys[0]);
  assert(ttl > 0 && ttl <= 600, \`\${keys[0]} has TTL \${ttl}: an entry must expire after TTL_S = 600 s, or every cell ever asked for stays in Redis\`);
  ctx.clock.advance(601);
  assert.equal(ctx.redis.exists(keys[0]), 0, \`\${keys[0]} is still in Redis 601 s after it was written\`);
}

export async function check_degraded_uncached(ctx) {
  const {m} = cache(ctx);
  ctx.grpc.fail('ComputeRoute', ctx.grpc.status.UNAVAILABLE, 'engine restarting', 3);
  const down = await m.cachedRoute(SF, OAKLAND, []);
  assert.equal(down.degraded, true, \`with the engine unavailable for three attempts the answer must be the degraded estimate, got \${JSON.stringify(down)}\`);
  assert.deepStrictEqual(ctx.redis.keys('route:*'), [], 'the degraded estimate was stored: it would be served after the engine recovers');
  const up = await m.cachedRoute(SF, OAKLAND, []);
  assert.equal(up.degraded, false, 'the engine is back, but the next request got the straight-line estimate from the cache');
}
`,
    go: `package main

import (
	"context"
	"fmt"

	"google.golang.org/grpc/codes"

	pb "mapsd/gen/maps_routing"
	"mapsd/geo"

	"leetbuild/harness"
)

var (
	stateBg     = context.Background()
	sf          = geo.Point{Lat: 37.77412, Lng: -122.41942}
	sfJitter    = geo.Point{Lat: 37.77415, Lng: -122.41945} // 4 m away, in the same cell
	sfTwoBlocks = geo.Point{Lat: 37.77612, Lng: -122.41942} // 220 m north
	oakland     = geo.Point{Lat: 37.80418, Lng: -122.27112}
	berkeley    = geo.Point{Lat: 37.87159, Lng: -122.27275}
)

// enginePeer: a road route is 1.3 times the great-circle legs.
type enginePeer struct {
	pb.UnimplementedRoutingEngineServer
}

func (enginePeer) ComputeRoute(_ context.Context, req *pb.ComputeRouteRequest) (*pb.ComputeRouteReply, error) {
	points := append([]*pb.LatLng{req.GetOrigin()}, req.GetWaypoints()...)
	points = append(points, req.GetDestination())
	distance := 0.0
	for i := 1; i < len(points); i++ {
		distance += geo.HaversineM(geo.Point{Lat: points[i-1].GetLat(), Lng: points[i-1].GetLng()}, geo.Point{Lat: points[i].GetLat(), Lng: points[i].GetLng()})
	}
	distance *= 1.3
	return &pb.ComputeRouteReply{DistanceM: distance, DurationS: distance / 11, Geometry: fmt.Sprintf("poly:%d", len(points)), EngineVersion: "osrm-v26.9"}, nil
}

func serveEngine(ctx *harness.Ctx) {
	pb.RegisterRoutingEngineServer(ctx.GRPC.Server(""), enginePeer{})
}

func solves(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("ComputeRoute", "")) }

func mustRoute(ctx *harness.Ctx, origin, destination geo.Point, waypoints ...geo.Point) geo.Route {
	route, err := cachedRoute(stateBg, origin, destination, waypoints)
	ctx.NoError(err, "cachedRoute failed")
	return route
}

func CheckCellKey(ctx *harness.Ctx) {
	serveEngine(ctx)
	first := mustRoute(ctx, sf, oakland)
	again := mustRoute(ctx, sfJitter, oakland)
	ctx.Equal(solves(ctx), 1, "two requests 4 m apart must land in the same cell and hit the cache; the engine solves")
	ctx.Equal(again.DistanceM, first.DistanceM, "the cached answer's distance")
	mustRoute(ctx, sfTwoBlocks, oakland)
	ctx.Equal(solves(ctx), 2, "a request starting two blocks away is another trip: it must be solved, not served from the cache; the engine solves")
}

func CheckWaypointKey(ctx *harness.Ctx) {
	serveEngine(ctx)
	direct := mustRoute(ctx, sf, oakland)
	via := mustRoute(ctx, sf, oakland, berkeley)
	ctx.Equal(solves(ctx), 2, "a trip through Berkeley was served the direct route from the cache (the waypoints are part of the trip and of the key); the engine solves")
	ctx.Assert(via.DistanceM > direct.DistanceM, "the trip through Berkeley answered %.0f m, the direct one %.0f m", via.DistanceM, direct.DistanceM)
	again := mustRoute(ctx, sf, oakland, berkeley)
	ctx.Assert(solves(ctx) == 2 && again.DistanceM == via.DistanceM, "the same trip through Berkeley, asked again, must hit the cache")
}

func CheckEpochKey(ctx *harness.Ctx) {
	serveEngine(ctx)
	before := mustRoute(ctx, sf, oakland)
	ctx.Clock.Advance(geo.EpochS)
	after := mustRoute(ctx, sf, oakland)
	ctx.Equal(solves(ctx), 2, "after the traffic epoch moved, the route solved for the previous epoch was served from the cache (the epoch must be part of the key); the engine solves")
	now := geo.CurrentEpoch()
	ctx.Assert(before.Epoch == now-1 && after.Epoch == now, "the answers carry epochs %d and %d, expected %d and %d", before.Epoch, after.Epoch, now-1, now)
}

func CheckTtl(ctx *harness.Ctx) {
	serveEngine(ctx)
	mustRoute(ctx, sf, oakland)
	keys := ctx.Redis.Keys("route:*")
	ctx.Equal(len(keys), 1, "one solved trip must leave one route:* entry; the entries %v", keys)
	ttl := ctx.Redis.TTL(keys[0])
	ctx.Assert(ttl > 0 && ttl <= 600, "%s has TTL %d: an entry must expire after TTL_S = 600 s, or every cell ever asked for stays in Redis", keys[0], ttl)
	ctx.Clock.Advance(601)
	ctx.Equal(ctx.Redis.Exists(keys[0]), int64(0), "%s 601 s after it was written; still in Redis", keys[0])
}

func CheckDegradedUncached(ctx *harness.Ctx) {
	serveEngine(ctx)
	ctx.GRPC.Fail("ComputeRoute", codes.Unavailable, "engine restarting", 3, "")
	down := mustRoute(ctx, sf, oakland)
	ctx.Assert(down.Degraded, "with the engine unavailable for three attempts the answer must be the degraded estimate, got %+v", down)
	ctx.Equal(len(ctx.Redis.Keys("route:*")), 0, "the degraded estimate was stored and would be served after the engine recovers; the route:* entries")
	up := mustRoute(ctx, sf, oakland)
	ctx.Assert(!up.Degraded, "the engine is back, but the next request got the straight-line estimate from the cache")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>
#include <vector>

#include "maps_routing.grpc.pb.h"
#include "mapsd/geo.h"

namespace {

const geo::Point kSf{37.77412, -122.41942};
const geo::Point kSfJitter{37.77415, -122.41945};    // 4 m away, in the same cell
const geo::Point kSfTwoBlocks{37.77612, -122.41942};  // 220 m north
const geo::Point kOakland{37.80418, -122.27112};
const geo::Point kBerkeley{37.87159, -122.27275};

// A road route is 1.3 times the great-circle legs.
class EnginePeer final : public mapsrouting::RoutingEngine::Service {
 public:
  grpc::Status ComputeRoute(grpc::ServerContext*, const mapsrouting::ComputeRouteRequest* req, mapsrouting::ComputeRouteReply* out) override {
    std::vector<geo::Point> points = {{req->origin().lat(), req->origin().lng()}};
    for (const auto& w : req->waypoints()) points.push_back({w.lat(), w.lng()});
    points.push_back({req->destination().lat(), req->destination().lng()});
    double distance = 0;
    for (size_t i = 1; i < points.size(); i++) distance += geo::haversineM(points[i - 1], points[i]);
    distance *= 1.3;
    out->set_distance_m(distance);
    out->set_duration_s(distance / 11);
    out->set_geometry("poly:" + std::to_string(points.size()));
    out->set_engine_version("osrm-v26.9");
    return grpc::Status::OK;
  }
};

void serveEngine(harness::Ctx& ctx) {
  static EnginePeer* peer = nullptr;
  delete peer;
  peer = new EnginePeer;
  ctx.GRPC.Server("")->RegisterService(peer);
}

size_t solves(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("ComputeRoute").size(); }

}  // namespace

void CheckCellKey(harness::Ctx& ctx) {
  serveEngine(ctx);
  const geo::Route first = cachedRoute(kSf, kOakland, {});
  const geo::Route again = cachedRoute(kSfJitter, kOakland, {});
  ctx.Equal(solves(ctx), 1, "two requests 4 m apart must land in the same cell and hit the cache; the engine solves");
  ctx.Equal(again.distance_m, first.distance_m, "the cached answer's distance");
  cachedRoute(kSfTwoBlocks, kOakland, {});
  ctx.Equal(solves(ctx), 2, "a request starting two blocks away is another trip: it must be solved, not served from the cache; the engine solves");
}

void CheckWaypointKey(harness::Ctx& ctx) {
  serveEngine(ctx);
  const geo::Route direct = cachedRoute(kSf, kOakland, {});
  const geo::Route via = cachedRoute(kSf, kOakland, {kBerkeley});
  ctx.Equal(solves(ctx), 2, "a trip through Berkeley was served the direct route from the cache (the waypoints are part of the trip and of the key); the engine solves");
  ctx.Assert(via.distance_m > direct.distance_m, "the trip through Berkeley answered %v m, the direct one %v m", via.distance_m, direct.distance_m);
  const geo::Route again = cachedRoute(kSf, kOakland, {kBerkeley});
  ctx.Assert(solves(ctx) == 2 && again.distance_m == via.distance_m, "the same trip through Berkeley, asked again, must hit the cache");
}

void CheckEpochKey(harness::Ctx& ctx) {
  serveEngine(ctx);
  const geo::Route before = cachedRoute(kSf, kOakland, {});
  ctx.Clock.Advance(geo::kEpochS);
  const geo::Route after = cachedRoute(kSf, kOakland, {});
  ctx.Equal(solves(ctx), 2, "after the traffic epoch moved, the route solved for the previous epoch was served from the cache (the epoch must be part of the key); the engine solves");
  const long long now = geo::currentEpoch();
  ctx.Assert(before.epoch == now - 1 && after.epoch == now, "the answers carry epochs %d and %d, expected %d and %d", before.epoch, after.epoch, now - 1, now);
}

void CheckTtl(harness::Ctx& ctx) {
  serveEngine(ctx);
  cachedRoute(kSf, kOakland, {});
  const auto keys = ctx.Redis.Keys("route:*");
  ctx.Equal(keys.size(), 1, "one solved trip must leave one route:* entry; the entries");
  const long long ttl = ctx.Redis.TTL(keys[0]);
  ctx.Assert(ttl > 0 && ttl <= 600, "%s has TTL %d: an entry must expire after kTtl = 600 s, or every cell ever asked for stays in Redis", keys[0], ttl);
  ctx.Clock.Advance(601);
  ctx.Equal(ctx.Redis.Exists(keys[0]), 0, "%s 601 s after it was written; still in Redis", keys[0]);
}

void CheckDegradedUncached(harness::Ctx& ctx) {
  serveEngine(ctx);
  ctx.GRPC.Fail("ComputeRoute", grpc::StatusCode::UNAVAILABLE, "engine restarting", 3);
  const geo::Route down = cachedRoute(kSf, kOakland, {});
  ctx.Assert(down.degraded, "with the engine unavailable for three attempts the answer must be the degraded estimate, got engine_version %q", down.engine_version);
  ctx.Equal(ctx.Redis.Keys("route:*").size(), 0, "the degraded estimate was stored and would be served after the engine recovers; the route:* entries");
  const geo::Route up = cachedRoute(kSf, kOakland, {});
  ctx.Assert(!up.degraded, "the engine is back, but the next request got the straight-line estimate from the cache");
}
`,
  },
  hints: [
    'Ask for the same trip twice from 4 m apart and the engine solves both; ask for it through Berkeley and you get the direct route; ask an hour later and you get the hour-old route, whose key never leaves Redis.',
    'The key is the raw floats of the two endpoints and nothing else: GPS noise changes it, a waypoint and the traffic epoch do not. `SET` has no expiry, and every answer is written, the degraded estimate included.',
    'Build `route:{epoch}:{cells}` from `current_epoch()` and `math.floor(lat / CELL_DEGREES)`, `math.floor(lng / CELL_DEGREES)` for the origin, each waypoint and the destination; `r.set(key, value, ex=TTL_S)`; skip the write when `route["degraded"]`.',
  ],
  debrief: `A cache key is a claim about which requests deserve the same answer. Here that is the snapped cell of every point plus the traffic epoch: the cell absorbs GPS noise without merging streets, the waypoints keep a detour from getting the direct route, and the epoch makes an entry stop matching the moment its traffic is gone. The expiry then only has to clean up. A degraded estimate stays out of the cache so the engine's recovery reaches the very next request. Production routers key by snapped road segments rather than a grid, so the two sides of a divided highway never share an entry, and refresh popular entries just before the epoch changes.`,
};
