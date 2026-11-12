/**
 * Hand-written support modules the maps-routing steps import but no step builds: the `mapsd`
 * package. `mapsd.geo` holds the shared types (a point, a route) and the geometry every step uses;
 * `mapsd.coverage` the tenants' map coverage; `mapsd.routes` the route store and the event outbox.
 * `mapsd.engine` is step 3's engine client and `mapsd.cache` step 2's route cache, as the steps
 * that come before and after them use them. The five languages keep the same Redis keys, so a
 * harness reads one layout whatever the stack.
 */
import {scalaPath} from '../scala-support';

export const supportModules: Record<string, string> = {
  'mapsd/__init__.py': '',
  'mapsd/geo.py': `"""
Shared route types and geometry (provided). A Point is a WGS84 coordinate; a route is a dict with
distance_m, duration_s, geometry, epoch, engine_version and degraded, as every step passes it. The
traffic epoch is floor(unix seconds / EPOCH_S). trip_cell coarsens a trip's endpoints to ~1 km cells
(floor of degrees x 100) and hashes them (FNV-1a, 64 bits, 16 hex digits), so an event can group
trips without carrying where anyone went.
"""
import math
import time
from dataclasses import dataclass

EPOCH_S = 300
EARTH_RADIUS_M = 6_371_000.0
FNV_OFFSET = 0xCBF29CE484222325
FNV_PRIME = 0x100000001B3


@dataclass(frozen=True)
class Point:
    lat: float
    lng: float


def current_epoch() -> int:
    """The traffic epoch now: it advances every EPOCH_S seconds."""
    return int(time.time() // EPOCH_S)


def haversine_m(a, b) -> float:
    """Great-circle distance in metres between two points (anything with lat and lng)."""
    lat1, lat2 = math.radians(a.lat), math.radians(b.lat)
    dlat = lat2 - lat1
    dlng = math.radians(b.lng - a.lng)
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(h))


def trip_cell(origin, destination) -> str:
    """The hash of the trip's ~1 km origin and destination cells."""
    cells = f"{math.floor(origin.lat * 100)},{math.floor(origin.lng * 100)};{math.floor(destination.lat * 100)},{math.floor(destination.lng * 100)}"
    h = FNV_OFFSET
    for byte in cells.encode():
        h ^= byte
        h = (h * FNV_PRIME) & 0xFFFFFFFFFFFFFFFF
    return f"{h:016x}"
`,
  'mapsd/coverage.py': `"""
Tenant map coverage (provided): coverage:{tenant} is a Redis hash with min_lat, max_lat, min_lng and
max_lng, the box the tenant's map data covers. A tenant without one covers nothing.
"""
import redis

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def coverage_key(tenant: str) -> str:
    return f"coverage:{tenant}"


def set_coverage(tenant: str, min_lat: float, max_lat: float, min_lng: float, max_lng: float) -> None:
    r.hset(coverage_key(tenant), mapping={"min_lat": min_lat, "max_lat": max_lat, "min_lng": min_lng, "max_lng": max_lng})


def covers(tenant: str, point) -> bool:
    """Whether the point lies inside the tenant's coverage."""
    box = r.hgetall(coverage_key(tenant))
    if not box:
        return False
    return float(box["min_lat"]) <= point.lat <= float(box["max_lat"]) and float(box["min_lng"]) <= point.lng <= float(box["max_lng"])
`,
  'mapsd/engine.py': `"""
The routing engine client (provided; step 3 builds the same compute_route): one ComputeRoute per
attempt to engine:9000 with a DEADLINE_S deadline, at most MAX_ATTEMPTS attempts, retrying only
UNAVAILABLE and DEADLINE_EXCEEDED. NOT_FOUND (no road connects the points) raises NoRoute. When the
attempts run out, or the engine answers any other status, the route is a straight-line estimate
marked degraded, for the caller's epoch.
"""
import grpc

import maps_routing_pb2
import maps_routing_pb2_grpc
from mapsd.geo import haversine_m

DEADLINE_S = 1.5
MAX_ATTEMPTS = 3
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)
FALLBACK_SPEED_MPS = 13.9
STRAIGHT_LINE = "straight-line"

engine = maps_routing_pb2_grpc.RoutingEngineStub(grpc.insecure_channel("engine:9000"))


class NoRoute(Exception):
    """No road connects the points: terminal, a retry or an estimate cannot invent one."""


def straight_line(origin, destination, epoch: int) -> dict:
    """The great-circle estimate, marked degraded: what to answer when the engine cannot."""
    distance = haversine_m(origin, destination)
    return {"distance_m": distance, "duration_s": distance / FALLBACK_SPEED_MPS, "geometry": "", "epoch": epoch, "engine_version": STRAIGHT_LINE, "degraded": True}


def _latlng(point) -> maps_routing_pb2.LatLng:
    return maps_routing_pb2.LatLng(lat=point.lat, lng=point.lng)


def compute_route(origin, destination, waypoints, epoch: int) -> dict:
    """The engine's route for the trip at the traffic epoch, or the degraded estimate."""
    request = maps_routing_pb2.ComputeRouteRequest(
        origin=_latlng(origin), destination=_latlng(destination), waypoints=[_latlng(p) for p in waypoints], epoch=epoch
    )
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = engine.ComputeRoute(request, timeout=DEADLINE_S)
        except grpc.RpcError as exc:
            if exc.code() == grpc.StatusCode.NOT_FOUND:
                raise NoRoute(exc.details()) from exc
            if exc.code() in RETRYABLE:
                continue
            break
        return {"distance_m": reply.distance_m, "duration_s": reply.duration_s, "geometry": reply.geometry, "epoch": epoch, "engine_version": reply.engine_version, "degraded": False}
    return straight_line(origin, destination, epoch)
`,
  'mapsd/cache.py': `"""
The route cache (provided; step 2 builds the same cached_route): route:{epoch}:{cells} holds a
computed route as JSON for TTL_S seconds, where cells are the origin, each waypoint and the
destination snapped to a CELL_DEGREES grid (floor), "lat,lng" each, joined by ";". A degraded
estimate is returned but not stored.
"""
import json
import math

import redis

from mapsd.engine import compute_route
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
    if not route["degraded"]:
        r.set(key, json.dumps(route), ex=TTL_S)
    return route
`,
  'mapsd/routes.py': `"""
The route store (provided): routes:{id} is a Redis hash with the tenant that computed the route and
the route's fields (distance_m, duration_s, geometry, epoch, engine_version, degraded as "1"/"0");
ids are r-1, r-2, ... from routes:seq. outbox:route.computed is the list of route events the broker
refused, one JSON row {"key", "payload"} each, which a relay republishes.
"""
import json

import redis

OUTBOX_KEY = "outbox:route.computed"

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def stored_key(route_id: str) -> str:
    return f"routes:{route_id}"


def save_route(tenant: str, route: dict) -> str:
    """Store the route for the tenant; its id."""
    route_id = f"r-{r.incr('routes:seq')}"
    r.hset(
        stored_key(route_id),
        mapping={
            "tenant": tenant,
            "distance_m": route["distance_m"],
            "duration_s": route["duration_s"],
            "geometry": route["geometry"],
            "epoch": route["epoch"],
            "engine_version": route["engine_version"],
            "degraded": "1" if route["degraded"] else "0",
        },
    )
    return route_id


def load_route(route_id: str) -> dict | None:
    """The stored route (the route's fields and its tenant), or None."""
    raw = r.hgetall(stored_key(route_id))
    if not raw:
        return None
    return {
        "tenant": raw["tenant"],
        "distance_m": float(raw["distance_m"]),
        "duration_s": float(raw["duration_s"]),
        "geometry": raw["geometry"],
        "epoch": int(raw["epoch"]),
        "engine_version": raw["engine_version"],
        "degraded": raw["degraded"] == "1",
    }


def add_outbox(key: str, payload: str) -> None:
    """Keep a refused event (its record key and value) for the relay."""
    r.rpush(OUTBOX_KEY, json.dumps({"key": key, "payload": payload}))
`,
};

export const supportModulesTs: Record<string, string> = {
  'mapsd/geo.ts': `/**
 * Shared route types and geometry (provided). A Point is a WGS84 coordinate; a Route is what every
 * step passes. The traffic epoch is floor(unix seconds / EPOCH_S). tripCell coarsens a trip's
 * endpoints to ~1 km cells (floor of degrees x 100) and hashes them (FNV-1a, 64 bits, 16 hex
 * digits), so an event can group trips without carrying where anyone went.
 */
export const EPOCH_S = 300;
const EARTH_RADIUS_M = 6_371_000;
const FNV_OFFSET = BigInt('0xcbf29ce484222325');
const FNV_PRIME = BigInt('0x100000001b3');
const MASK_64 = BigInt('0xffffffffffffffff');

export interface Point {
  lat: number;
  lng: number;
}

export interface Route {
  distance_m: number;
  duration_s: number;
  geometry: string;
  epoch: number;
  engine_version: string;
  degraded: boolean;
}

/** The traffic epoch now: it advances every EPOCH_S seconds. */
export const currentEpoch = (): number => Math.floor(Date.now() / 1000 / EPOCH_S);

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance in metres between two points. */
export function haversineM(a: Point, b: Point): number {
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const dlat = lat2 - lat1;
  const dlng = radians(b.lng - a.lng);
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** The hash of the trip's ~1 km origin and destination cells. */
export function tripCell(origin: Point, destination: Point): string {
  const cells = \`\${Math.floor(origin.lat * 100)},\${Math.floor(origin.lng * 100)};\${Math.floor(destination.lat * 100)},\${Math.floor(destination.lng * 100)}\`;
  let h = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(cells)) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK_64;
  }
  return h.toString(16).padStart(16, '0');
}
`,
  'mapsd/coverage.ts': `/**
 * Tenant map coverage (provided): coverage:{tenant} is a Redis hash with min_lat, max_lat, min_lng
 * and max_lng, the box the tenant's map data covers. A tenant without one covers nothing.
 */
import Redis from 'ioredis';

import type {Point} from 'mapsd/geo';

const redis = new Redis({host: 'redis', port: 6379});

export const coverageKey = (tenant: string): string => \`coverage:\${tenant}\`;

export async function setCoverage(tenant: string, minLat: number, maxLat: number, minLng: number, maxLng: number): Promise<void> {
  await redis.hset(coverageKey(tenant), {min_lat: minLat, max_lat: maxLat, min_lng: minLng, max_lng: maxLng});
}

/** Whether the point lies inside the tenant's coverage. */
export async function covers(tenant: string, point: Point): Promise<boolean> {
  const box = await redis.hgetall(coverageKey(tenant));
  if (Object.keys(box).length === 0) return false;
  return Number(box.min_lat) <= point.lat && point.lat <= Number(box.max_lat) && Number(box.min_lng) <= point.lng && point.lng <= Number(box.max_lng);
}
`,
  'mapsd/engine.ts': `/**
 * The routing engine client (provided; step 3 builds the same computeRoute): one ComputeRoute per
 * attempt to engine:9000 with a DEADLINE_MS deadline, at most MAX_ATTEMPTS attempts, retrying only
 * UNAVAILABLE and DEADLINE_EXCEEDED. NOT_FOUND (no road connects the points) throws NoRoute. When
 * the attempts run out, or the engine answers any other status, the route is a straight-line
 * estimate marked degraded, for the caller's epoch.
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Point, type Route, haversineM} from 'mapsd/geo';

export const DEADLINE_MS = 1500;
export const MAX_ATTEMPTS = 3;
export const FALLBACK_SPEED_MPS = 13.9;
export const STRAIGHT_LINE = 'straight-line';

interface ComputeRouteRequest {
  origin: Point;
  destination: Point;
  waypoints: Point[];
  epoch: number;
}

interface ComputeRouteReply {
  distance_m: number;
  duration_s: number;
  geometry: string;
  engine_version: string;
}

type EngineClient = grpc.Client & {
  ComputeRoute(request: ComputeRouteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<ComputeRouteReply>;
};

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('maps_routing.proto')) as unknown as {
  mapsrouting: {RoutingEngine: grpc.ServiceClientConstructor};
};
const engine = new pkg.mapsrouting.RoutingEngine('engine:9000', grpc.credentials.createInsecure()) as EngineClient;

const RETRYABLE = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);

/** No road connects the points: terminal, a retry or an estimate cannot invent one. */
export class NoRoute extends Error {}

/** The great-circle estimate, marked degraded: what to answer when the engine cannot. */
export function straightLine(origin: Point, destination: Point, epoch: number): Route {
  const distance = haversineM(origin, destination);
  return {distance_m: distance, duration_s: distance / FALLBACK_SPEED_MPS, geometry: '', epoch, engine_version: STRAIGHT_LINE, degraded: true};
}

/** The engine's route for the trip at the traffic epoch, or the degraded estimate. */
export async function computeRoute(origin: Point, destination: Point, waypoints: Point[], epoch: number): Promise<Route> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await engine.ComputeRoute({origin, destination, waypoints, epoch}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      return {distance_m: reply.distance_m, duration_s: reply.duration_s, geometry: reply.geometry, epoch, engine_version: reply.engine_version, degraded: false};
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      if (code === grpc.status.NOT_FOUND) throw new NoRoute(details);
      if (!RETRYABLE.has(code)) break;
    }
  }
  return straightLine(origin, destination, epoch);
}
`,
  'mapsd/cache.ts': `/**
 * The route cache (provided; step 2 builds the same cachedRoute): route:{epoch}:{cells} holds a
 * computed route as JSON for TTL_S seconds, where cells are the origin, each waypoint and the
 * destination snapped to a CELL_DEGREES grid (floor), "lat,lng" each, joined by ";". A degraded
 * estimate is returned but not stored.
 */
import Redis from 'ioredis';

import {computeRoute} from 'mapsd/engine';
import {EPOCH_S, type Point, type Route, currentEpoch} from 'mapsd/geo';

export const CELL_DEGREES = 0.001;
export const TTL_S = 2 * EPOCH_S;

const redis = new Redis({host: 'redis', port: 6379});

export const cell = (point: Point): string => \`\${Math.floor(point.lat / CELL_DEGREES)},\${Math.floor(point.lng / CELL_DEGREES)}\`;

export const routeKey = (epoch: number, origin: Point, destination: Point, waypoints: Point[]): string =>
  \`route:\${epoch}:\${[origin, ...waypoints, destination].map(cell).join(';')}\`;

/** The route for the trip at the current traffic epoch, from the cache or the engine. */
export async function cachedRoute(origin: Point, destination: Point, waypoints: Point[]): Promise<Route> {
  const epoch = currentEpoch();
  const key = routeKey(epoch, origin, destination, waypoints);
  const raw = await redis.get(key);
  if (raw !== null) return JSON.parse(raw) as Route;
  const route = await computeRoute(origin, destination, waypoints, epoch);
  if (!route.degraded) await redis.set(key, JSON.stringify(route), 'EX', TTL_S);
  return route;
}
`,
  'mapsd/routes.ts': `/**
 * The route store (provided): routes:{id} is a Redis hash with the tenant that computed the route
 * and the route's fields (distance_m, duration_s, geometry, epoch, engine_version, degraded as
 * "1"/"0"); ids are r-1, r-2, ... from routes:seq. outbox:route.computed is the list of route events
 * the broker refused, one JSON row {"key", "payload"} each, which a relay republishes.
 */
import Redis from 'ioredis';

import type {Route} from 'mapsd/geo';

export const OUTBOX_KEY = 'outbox:route.computed';

const redis = new Redis({host: 'redis', port: 6379});

/** A stored route: the route's fields and the tenant that computed it. */
export interface StoredRoute extends Route {
  tenant: string;
}

export const storedKey = (routeId: string): string => \`routes:\${routeId}\`;

/** Store the route for the tenant; its id. */
export async function saveRoute(tenant: string, route: Route): Promise<string> {
  const routeId = \`r-\${await redis.incr('routes:seq')}\`;
  await redis.hset(storedKey(routeId), {
    tenant,
    distance_m: String(route.distance_m),
    duration_s: String(route.duration_s),
    geometry: route.geometry,
    epoch: String(route.epoch),
    engine_version: route.engine_version,
    degraded: route.degraded ? '1' : '0',
  });
  return routeId;
}

/** The stored route, or null. */
export async function loadRoute(routeId: string): Promise<StoredRoute | null> {
  const raw = await redis.hgetall(storedKey(routeId));
  if (Object.keys(raw).length === 0) return null;
  return {
    tenant: raw.tenant,
    distance_m: Number(raw.distance_m),
    duration_s: Number(raw.duration_s),
    geometry: raw.geometry,
    epoch: Number(raw.epoch),
    engine_version: raw.engine_version,
    degraded: raw.degraded === '1',
  };
}

/** Keep a refused event (its record key and value) for the relay. */
export async function addOutbox(key: string, payload: string): Promise<void> {
  await redis.rpush(OUTBOX_KEY, JSON.stringify({key, payload}));
}
`,
};

export const supportModulesGo: Record<string, string> = {
  'mapsd/geo/geo.go': `// Package geo holds the shared route types and geometry (provided). A Point is a WGS84
// coordinate; a Route is what every step passes. The traffic epoch is floor(unix seconds /
// EpochS). TripCell coarsens a trip's endpoints to ~1 km cells (floor of degrees x 100) and hashes
// them (FNV-1a, 64 bits, 16 hex digits), so an event can group trips without carrying where
// anyone went.
package geo

import (
	"fmt"
	"math"
	"time"
)

const (
	EpochS       = 300
	earthRadiusM = 6371000.0
	fnvOffset    = uint64(14695981039346656037)
	fnvPrime     = uint64(1099511628211)
)

// Point is a WGS84 coordinate.
type Point struct {
	Lat float64 \`json:"lat"\`
	Lng float64 \`json:"lng"\`
}

// Route is a computed route: the engine's, or the straight-line estimate marked Degraded.
type Route struct {
	DistanceM     float64 \`json:"distance_m"\`
	DurationS     float64 \`json:"duration_s"\`
	Geometry      string  \`json:"geometry"\`
	Epoch         int64   \`json:"epoch"\`
	EngineVersion string  \`json:"engine_version"\`
	Degraded      bool    \`json:"degraded"\`
}

// CurrentEpoch is the traffic epoch now: it advances every EpochS seconds.
func CurrentEpoch() int64 { return time.Now().Unix() / EpochS }

func radians(degrees float64) float64 { return degrees * math.Pi / 180 }

// HaversineM is the great-circle distance in metres between two points.
func HaversineM(a, b Point) float64 {
	lat1, lat2 := radians(a.Lat), radians(b.Lat)
	dlat := lat2 - lat1
	dlng := radians(b.Lng - a.Lng)
	h := math.Pow(math.Sin(dlat/2), 2) + math.Cos(lat1)*math.Cos(lat2)*math.Pow(math.Sin(dlng/2), 2)
	return 2 * earthRadiusM * math.Asin(math.Sqrt(h))
}

func floor100(degrees float64) int64 { return int64(math.Floor(degrees * 100)) }

// TripCell is the hash of the trip's ~1 km origin and destination cells.
func TripCell(origin, destination Point) string {
	cells := fmt.Sprintf("%d,%d;%d,%d", floor100(origin.Lat), floor100(origin.Lng), floor100(destination.Lat), floor100(destination.Lng))
	h := fnvOffset
	for _, b := range []byte(cells) {
		h ^= uint64(b)
		h *= fnvPrime
	}
	return fmt.Sprintf("%016x", h)
}
`,
  'mapsd/coverage/coverage.go': `// Package coverage is the tenants' map coverage (provided): coverage:{tenant} is a Redis hash
// with min_lat, max_lat, min_lng and max_lng, the box the tenant's map data covers. A tenant
// without one covers nothing.
package coverage

import (
	"context"
	"strconv"

	"github.com/redis/go-redis/v9"

	"mapsd/geo"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func Key(tenant string) string { return "coverage:" + tenant }

func SetCoverage(ctx context.Context, tenant string, minLat, maxLat, minLng, maxLng float64) {
	rdb.HSet(ctx, Key(tenant), "min_lat", minLat, "max_lat", maxLat, "min_lng", minLng, "max_lng", maxLng)
}

// Covers reports whether the point lies inside the tenant's coverage.
func Covers(ctx context.Context, tenant string, p geo.Point) bool {
	box := rdb.HGetAll(ctx, Key(tenant)).Val()
	if len(box) == 0 {
		return false
	}
	bound := func(name string) float64 {
		v, _ := strconv.ParseFloat(box[name], 64)
		return v
	}
	return bound("min_lat") <= p.Lat && p.Lat <= bound("max_lat") && bound("min_lng") <= p.Lng && p.Lng <= bound("max_lng")
}
`,
  'mapsd/engine/engine.go': `// Package engine is the routing engine client (provided; step 3 builds the same ComputeRoute):
// one ComputeRoute per attempt to engine:9000 with a Deadline, at most MaxAttempts attempts,
// retrying only Unavailable and DeadlineExceeded. NotFound (no road connects the points) returns
// an error wrapping ErrNoRoute. When the attempts run out, or the engine answers any other status,
// the route is a straight-line estimate marked degraded, for the caller's epoch.
package engine

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "mapsd/gen/maps_routing"
	"mapsd/geo"
)

const (
	Deadline         = 1500 * time.Millisecond
	MaxAttempts      = 3
	FallbackSpeedMPS = 13.9
	StraightLineName = "straight-line"
)

// ErrNoRoute: no road connects the points; terminal, a retry or an estimate cannot invent one.
var ErrNoRoute = errors.New("no route")

var (
	conn, _ = grpc.NewClient("engine:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	client  = pb.NewRoutingEngineClient(conn)
)

// StraightLine is the great-circle estimate, marked degraded: what to answer when the engine cannot.
func StraightLine(origin, destination geo.Point, epoch int64) geo.Route {
	distance := geo.HaversineM(origin, destination)
	return geo.Route{DistanceM: distance, DurationS: distance / FallbackSpeedMPS, Epoch: epoch, EngineVersion: StraightLineName, Degraded: true}
}

func latLng(p geo.Point) *pb.LatLng { return &pb.LatLng{Lat: p.Lat, Lng: p.Lng} }

// ComputeRoute is the engine's route for the trip at the traffic epoch, or the degraded estimate.
func ComputeRoute(ctx context.Context, origin, destination geo.Point, waypoints []geo.Point, epoch int64) (geo.Route, error) {
	request := &pb.ComputeRouteRequest{Origin: latLng(origin), Destination: latLng(destination), Epoch: epoch}
	for _, p := range waypoints {
		request.Waypoints = append(request.Waypoints, latLng(p))
	}
	for attempt := 0; attempt < MaxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, Deadline)
		reply, err := client.ComputeRoute(callCtx, request)
		cancel()
		if err == nil {
			return geo.Route{DistanceM: reply.GetDistanceM(), DurationS: reply.GetDurationS(), Geometry: reply.GetGeometry(), Epoch: epoch, EngineVersion: reply.GetEngineVersion()}, nil
		}
		code := status.Code(err)
		if code == codes.NotFound {
			return geo.Route{}, fmt.Errorf("%w: %s", ErrNoRoute, status.Convert(err).Message())
		}
		if code != codes.Unavailable && code != codes.DeadlineExceeded {
			break
		}
	}
	return StraightLine(origin, destination, epoch), nil
}
`,
  'mapsd/cache/cache.go': `// Package cache is the route cache (provided; step 2 builds the same CachedRoute):
// route:{epoch}:{cells} holds a computed route as JSON for TTL, where cells are the origin, each
// waypoint and the destination snapped to a CellDegrees grid (floor), "lat,lng" each, joined by
// ";". A degraded estimate is returned but not stored.
package cache

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"

	"mapsd/engine"
	"mapsd/geo"
)

const (
	CellDegrees = 0.001
	TTL         = 2 * geo.EpochS * time.Second
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

func Cell(p geo.Point) string {
	return fmt.Sprintf("%d,%d", int64(math.Floor(p.Lat/CellDegrees)), int64(math.Floor(p.Lng/CellDegrees)))
}

func RouteKey(epoch int64, origin, destination geo.Point, waypoints []geo.Point) string {
	cells := []string{Cell(origin)}
	for _, p := range waypoints {
		cells = append(cells, Cell(p))
	}
	cells = append(cells, Cell(destination))
	return fmt.Sprintf("route:%d:%s", epoch, strings.Join(cells, ";"))
}

// CachedRoute is the route for the trip at the current traffic epoch, from the cache or the engine.
func CachedRoute(ctx context.Context, origin, destination geo.Point, waypoints []geo.Point) (geo.Route, error) {
	epoch := geo.CurrentEpoch()
	key := RouteKey(epoch, origin, destination, waypoints)
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
	if !route.Degraded {
		value, _ := json.Marshal(route)
		rdb.Set(ctx, key, string(value), TTL)
	}
	return route, nil
}
`,
  'mapsd/routes/routes.go': `// Package routes is the route store (provided): routes:{id} is a Redis hash with the tenant that
// computed the route and the route's fields (distance_m, duration_s, geometry, epoch,
// engine_version, degraded as "1"/"0"); ids are r-1, r-2, ... from routes:seq.
// outbox:route.computed is the list of route events the broker refused, one JSON row
// {"key", "payload"} each, which a relay republishes.
package routes

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"

	"mapsd/geo"
)

const OutboxKey = "outbox:route.computed"

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

// Stored is a stored route and the tenant that computed it.
type Stored struct {
	Tenant string
	Route  geo.Route
}

func StoredKey(routeID string) string { return "routes:" + routeID }

// SaveRoute stores the route for the tenant and returns its id.
func SaveRoute(ctx context.Context, tenant string, route geo.Route) string {
	routeID := fmt.Sprintf("r-%d", rdb.Incr(ctx, "routes:seq").Val())
	degraded := "0"
	if route.Degraded {
		degraded = "1"
	}
	rdb.HSet(ctx, StoredKey(routeID),
		"tenant", tenant,
		"distance_m", strconv.FormatFloat(route.DistanceM, 'f', -1, 64),
		"duration_s", strconv.FormatFloat(route.DurationS, 'f', -1, 64),
		"geometry", route.Geometry,
		"epoch", strconv.FormatInt(route.Epoch, 10),
		"engine_version", route.EngineVersion,
		"degraded", degraded)
	return routeID
}

// LoadRoute is the stored route, or nil.
func LoadRoute(ctx context.Context, routeID string) *Stored {
	raw := rdb.HGetAll(ctx, StoredKey(routeID)).Val()
	if len(raw) == 0 {
		return nil
	}
	distance, _ := strconv.ParseFloat(raw["distance_m"], 64)
	duration, _ := strconv.ParseFloat(raw["duration_s"], 64)
	epoch, _ := strconv.ParseInt(raw["epoch"], 10, 64)
	return &Stored{Tenant: raw["tenant"], Route: geo.Route{DistanceM: distance, DurationS: duration, Geometry: raw["geometry"], Epoch: epoch, EngineVersion: raw["engine_version"], Degraded: raw["degraded"] == "1"}}
}

// AddOutbox keeps a refused event (its record key and value) for the relay.
func AddOutbox(ctx context.Context, key, payload string) {
	row, _ := json.Marshal(map[string]string{"key": key, "payload": payload})
	rdb.RPush(ctx, OutboxKey, string(row))
}
`,
};

export const supportModulesCpp: Record<string, string> = {
  'mapsd/geo.h': `// Shared route types and geometry (provided). A Point is a WGS84 coordinate; a Route is what every
// step passes. The traffic epoch is floor(unix seconds / kEpochS). tripCell coarsens a trip's
// endpoints to ~1 km cells (floor of degrees x 100) and hashes them (FNV-1a, 64 bits, 16 hex
// digits), so an event can group trips without carrying where anyone went.
#pragma once

#include <nlohmann/json.hpp>

#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>

namespace geo {

constexpr long long kEpochS = 300;
constexpr double kEarthRadiusM = 6371000.0;

struct Point {
  double lat = 0;
  double lng = 0;
};

// A computed route: the engine's, or the straight-line estimate marked degraded.
struct Route {
  double distance_m = 0;
  double duration_s = 0;
  std::string geometry;
  long long epoch = 0;
  std::string engine_version;
  bool degraded = false;
};

// The traffic epoch now: it advances every kEpochS seconds.
inline long long currentEpoch() {
  const auto seconds = std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
  return static_cast<long long>(seconds) / kEpochS;
}

inline double radians(double degrees) { return degrees * 3.14159265358979323846 / 180.0; }

// Great-circle distance in metres between two points.
inline double haversineM(const Point& a, const Point& b) {
  const double lat1 = radians(a.lat);
  const double lat2 = radians(b.lat);
  const double dlat = lat2 - lat1;
  const double dlng = radians(b.lng - a.lng);
  const double h = std::pow(std::sin(dlat / 2), 2) + std::cos(lat1) * std::cos(lat2) * std::pow(std::sin(dlng / 2), 2);
  return 2 * kEarthRadiusM * std::asin(std::sqrt(h));
}

inline std::string floor100(double degrees) { return std::to_string(static_cast<long long>(std::floor(degrees * 100))); }

// The hash of the trip's ~1 km origin and destination cells.
inline std::string tripCell(const Point& origin, const Point& destination) {
  const std::string cells = floor100(origin.lat) + "," + floor100(origin.lng) + ";" + floor100(destination.lat) + "," + floor100(destination.lng);
  uint64_t h = 14695981039346656037ULL;
  for (const unsigned char c : cells) {
    h ^= c;
    h *= 1099511628211ULL;
  }
  char out[17];
  std::snprintf(out, sizeof out, "%016llx", static_cast<unsigned long long>(h));
  return out;
}

inline nlohmann::json toJson(const Route& route) {
  return nlohmann::json{{"distance_m", route.distance_m}, {"duration_s", route.duration_s}, {"geometry", route.geometry},
                        {"epoch", route.epoch}, {"engine_version", route.engine_version}, {"degraded", route.degraded}};
}

inline Route routeFromJson(const nlohmann::json& j) {
  Route route;
  route.distance_m = j.value("distance_m", 0.0);
  route.duration_s = j.value("duration_s", 0.0);
  route.geometry = j.value("geometry", "");
  route.epoch = j.value("epoch", 0LL);
  route.engine_version = j.value("engine_version", "");
  route.degraded = j.value("degraded", false);
  return route;
}

}  // namespace geo
`,
  'mapsd/coverage.h': `// Tenant map coverage (provided): coverage:{tenant} is a Redis hash with min_lat, max_lat, min_lng
// and max_lng, the box the tenant's map data covers. A tenant without one covers nothing.
#pragma once

#include <sw/redis++/redis++.h>

#include <iterator>
#include <string>
#include <unordered_map>

#include "mapsd/geo.h"

namespace coverage {

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string coverageKey(const std::string& tenant) { return "coverage:" + tenant; }

inline void setCoverage(const std::string& tenant, double min_lat, double max_lat, double min_lng, double max_lng) {
  const std::unordered_map<std::string, std::string> box = {{"min_lat", std::to_string(min_lat)},
                                                            {"max_lat", std::to_string(max_lat)},
                                                            {"min_lng", std::to_string(min_lng)},
                                                            {"max_lng", std::to_string(max_lng)}};
  redis().hset(coverageKey(tenant), box.begin(), box.end());
}

// Whether the point lies inside the tenant's coverage.
inline bool covers(const std::string& tenant, const geo::Point& p) {
  std::unordered_map<std::string, std::string> box;
  redis().hgetall(coverageKey(tenant), std::inserter(box, box.begin()));
  if (box.empty()) return false;
  return std::stod(box["min_lat"]) <= p.lat && p.lat <= std::stod(box["max_lat"]) && std::stod(box["min_lng"]) <= p.lng &&
         p.lng <= std::stod(box["max_lng"]);
}

}  // namespace coverage
`,
  'mapsd/engine.h': `// The routing engine client (provided; step 3 builds the same computeRoute): one ComputeRoute per
// attempt to engine:9000 with a kDeadline, at most kMaxAttempts attempts, retrying only UNAVAILABLE
// and DEADLINE_EXCEEDED. NOT_FOUND (no road connects the points) throws NoRoute. When the attempts
// run out, or the engine answers any other status, the route is a straight-line estimate marked
// degraded, for the caller's epoch.
#pragma once

#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

#include "maps_routing.grpc.pb.h"
#include "mapsd/geo.h"

namespace engine {

constexpr std::chrono::milliseconds kDeadline{1500};
constexpr int kMaxAttempts = 3;
constexpr double kFallbackSpeedMps = 13.9;
const std::string kStraightLine = "straight-line";

// No road connects the points: terminal, a retry or an estimate cannot invent one.
struct NoRoute : std::runtime_error {
  using std::runtime_error::runtime_error;
};

inline mapsrouting::RoutingEngine::Stub& stub() {
  static auto s = mapsrouting::RoutingEngine::NewStub(grpc::CreateChannel("engine:9000", grpc::InsecureChannelCredentials()));
  return *s;
}

// The great-circle estimate, marked degraded: what to answer when the engine cannot.
inline geo::Route straightLine(const geo::Point& origin, const geo::Point& destination, long long epoch) {
  geo::Route route;
  route.distance_m = geo::haversineM(origin, destination);
  route.duration_s = route.distance_m / kFallbackSpeedMps;
  route.epoch = epoch;
  route.engine_version = kStraightLine;
  route.degraded = true;
  return route;
}

inline void setLatLng(mapsrouting::LatLng* out, const geo::Point& p) {
  out->set_lat(p.lat);
  out->set_lng(p.lng);
}

// The engine's route for the trip at the traffic epoch, or the degraded estimate.
inline geo::Route computeRoute(const geo::Point& origin, const geo::Point& destination, const std::vector<geo::Point>& waypoints, long long epoch) {
  mapsrouting::ComputeRouteRequest request;
  setLatLng(request.mutable_origin(), origin);
  setLatLng(request.mutable_destination(), destination);
  for (const geo::Point& p : waypoints) setLatLng(request.add_waypoints(), p);
  request.set_epoch(epoch);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    mapsrouting::ComputeRouteReply reply;
    const grpc::Status status = stub().ComputeRoute(&ctx, request, &reply);
    if (status.ok()) {
      geo::Route route;
      route.distance_m = reply.distance_m();
      route.duration_s = reply.duration_s();
      route.geometry = reply.geometry();
      route.epoch = epoch;
      route.engine_version = reply.engine_version();
      return route;
    }
    if (status.error_code() == grpc::StatusCode::NOT_FOUND) throw NoRoute(status.error_message());
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE && status.error_code() != grpc::StatusCode::DEADLINE_EXCEEDED) break;
  }
  return straightLine(origin, destination, epoch);
}

}  // namespace engine
`,
  'mapsd/cache.h': `// The route cache (provided; step 2 builds the same cachedRoute): route:{epoch}:{cells} holds a
// computed route as JSON for kTtl, where cells are the origin, each waypoint and the destination
// snapped to a kCellDegrees grid (floor), "lat,lng" each, joined by ";". A degraded estimate is
// returned but not stored.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cmath>
#include <string>
#include <vector>

#include "mapsd/engine.h"
#include "mapsd/geo.h"

namespace cache {

constexpr double kCellDegrees = 0.001;
constexpr std::chrono::seconds kTtl{2 * geo::kEpochS};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string cell(const geo::Point& p) {
  return std::to_string(static_cast<long long>(std::floor(p.lat / kCellDegrees))) + "," +
         std::to_string(static_cast<long long>(std::floor(p.lng / kCellDegrees)));
}

inline std::string routeKey(long long epoch, const geo::Point& origin, const geo::Point& destination, const std::vector<geo::Point>& waypoints) {
  std::string key = "route:" + std::to_string(epoch) + ":" + cell(origin);
  for (const geo::Point& p : waypoints) key += ";" + cell(p);
  return key + ";" + cell(destination);
}

// The route for the trip at the current traffic epoch, from the cache or the engine.
inline geo::Route cachedRoute(const geo::Point& origin, const geo::Point& destination, const std::vector<geo::Point>& waypoints) {
  const long long epoch = geo::currentEpoch();
  const std::string key = routeKey(epoch, origin, destination, waypoints);
  if (const auto raw = redis().get(key)) return geo::routeFromJson(nlohmann::json::parse(*raw));
  const geo::Route route = engine::computeRoute(origin, destination, waypoints, epoch);
  if (!route.degraded) redis().set(key, geo::toJson(route).dump(), kTtl);
  return route;
}

}  // namespace cache
`,
  'mapsd/routes.h': `// The route store (provided): routes:{id} is a Redis hash with the tenant that computed the route
// and the route's fields (distance_m, duration_s, geometry, epoch, engine_version, degraded as
// "1"/"0"); ids are r-1, r-2, ... from routes:seq. outbox:route.computed is the list of route events
// the broker refused, one JSON row {"key", "payload"} each, which a relay republishes.
#pragma once

#include <nlohmann/json.hpp>
#include <sw/redis++/redis++.h>

#include <optional>
#include <iterator>
#include <string>
#include <unordered_map>

#include "mapsd/geo.h"

namespace routes {

const std::string kOutboxKey = "outbox:route.computed";

// A stored route and the tenant that computed it.
struct Stored {
  std::string tenant;
  geo::Route route;
};

inline sw::redis::Redis& redis() {
  static sw::redis::Redis r("tcp://redis:6379");
  return r;
}

inline std::string storedKey(const std::string& route_id) { return "routes:" + route_id; }

// Store the route for the tenant; its id.
inline std::string saveRoute(const std::string& tenant, const geo::Route& route) {
  const std::string route_id = "r-" + std::to_string(redis().incr("routes:seq"));
  const std::unordered_map<std::string, std::string> fields = {{"tenant", tenant},
                                                               {"distance_m", nlohmann::json(route.distance_m).dump()},
                                                               {"duration_s", nlohmann::json(route.duration_s).dump()},
                                                               {"geometry", route.geometry},
                                                               {"epoch", std::to_string(route.epoch)},
                                                               {"engine_version", route.engine_version},
                                                               {"degraded", route.degraded ? "1" : "0"}};
  redis().hset(storedKey(route_id), fields.begin(), fields.end());
  return route_id;
}

// The stored route, if there is one.
inline std::optional<Stored> loadRoute(const std::string& route_id) {
  std::unordered_map<std::string, std::string> raw;
  redis().hgetall(storedKey(route_id), std::inserter(raw, raw.begin()));
  if (raw.empty()) return std::nullopt;
  Stored stored;
  stored.tenant = raw["tenant"];
  stored.route.distance_m = std::stod(raw["distance_m"]);
  stored.route.duration_s = std::stod(raw["duration_s"]);
  stored.route.geometry = raw["geometry"];
  stored.route.epoch = std::stoll(raw["epoch"]);
  stored.route.engine_version = raw["engine_version"];
  stored.route.degraded = raw["degraded"] == "1";
  return stored;
}

// Keep a refused event (its record key and value) for the relay.
inline void addOutbox(const std::string& key, const std::string& payload) {
  redis().rpush(kOutboxKey, nlohmann::json{{"key", key}, {"payload", payload}}.dump());
}

}  // namespace routes
`,
};

export const supportModulesScala: Record<string, string> = {
  [scalaPath('mapsd', 'Geo')]: `package mapsd

import spray.json._

/**
 * Shared route types and geometry (provided). A Point is a WGS84 coordinate; a Route is what every
 * step passes. The traffic epoch is floor(unix seconds / EpochS). tripCell coarsens a trip's
 * endpoints to ~1 km cells (floor of degrees x 100) and hashes them (FNV-1a, 64 bits, 16 hex
 * digits), so an event can group trips without carrying where anyone went.
 */
object Geo {
  final case class Point(lat: Double, lng: Double)

  /** A computed route: the engine's, or the straight-line estimate marked degraded. */
  final case class Route(distanceM: Double, durationS: Double, geometry: String, epoch: Long, engineVersion: String, degraded: Boolean)

  val EpochS = 300L
  private val EarthRadiusM = 6371000.0
  private val FnvOffset = java.lang.Long.parseUnsignedLong("cbf29ce484222325", 16)
  private val FnvPrime = 0x100000001b3L

  /** The traffic epoch now: it advances every EpochS seconds. */
  def currentEpoch(): Long = System.currentTimeMillis() / 1000 / EpochS

  /** Great-circle distance in metres between two points. */
  def haversineM(a: Point, b: Point): Double = {
    val lat1 = math.toRadians(a.lat)
    val lat2 = math.toRadians(b.lat)
    val dlat = lat2 - lat1
    val dlng = math.toRadians(b.lng - a.lng)
    val h = math.pow(math.sin(dlat / 2), 2) + math.cos(lat1) * math.cos(lat2) * math.pow(math.sin(dlng / 2), 2)
    2 * EarthRadiusM * math.asin(math.sqrt(h))
  }

  private def floor100(degrees: Double): Long = math.floor(degrees * 100).toLong

  /** The hash of the trip's ~1 km origin and destination cells. */
  def tripCell(origin: Point, destination: Point): String = {
    val cells = s"\${floor100(origin.lat)},\${floor100(origin.lng)};\${floor100(destination.lat)},\${floor100(destination.lng)}"
    var h = FnvOffset
    cells.getBytes("UTF-8").foreach { b =>
      h ^= (b & 0xff).toLong
      h *= FnvPrime
    }
    f"$h%016x"
  }

  def toJson(route: Route): JsObject = JsObject(
    "distance_m" -> JsNumber(route.distanceM),
    "duration_s" -> JsNumber(route.durationS),
    "geometry" -> JsString(route.geometry),
    "epoch" -> JsNumber(route.epoch),
    "engine_version" -> JsString(route.engineVersion),
    "degraded" -> JsBoolean(route.degraded),
  )

  def routeFromJson(json: JsObject): Route = {
    val f = json.fields
    Route(
      f("distance_m").asInstanceOf[JsNumber].value.toDouble,
      f("duration_s").asInstanceOf[JsNumber].value.toDouble,
      f("geometry").asInstanceOf[JsString].value,
      f("epoch").asInstanceOf[JsNumber].value.toLong,
      f("engine_version").asInstanceOf[JsString].value,
      f("degraded").asInstanceOf[JsBoolean].value,
    )
  }
}
`,
  [scalaPath('mapsd', 'Coverage')]: `package mapsd

import redis.clients.jedis.JedisPooled

import scala.jdk.CollectionConverters._

/**
 * Tenant map coverage (provided): coverage:{tenant} is a Redis hash with min_lat, max_lat, min_lng
 * and max_lng, the box the tenant's map data covers. A tenant without one covers nothing.
 */
object Coverage {
  val jedis = new JedisPooled("redis", 6379)

  def coverageKey(tenant: String): String = s"coverage:$tenant"

  def setCoverage(tenant: String, minLat: Double, maxLat: Double, minLng: Double, maxLng: Double): Unit =
    jedis.hset(coverageKey(tenant), Map("min_lat" -> minLat.toString, "max_lat" -> maxLat.toString, "min_lng" -> minLng.toString, "max_lng" -> maxLng.toString).asJava)

  /** Whether the point lies inside the tenant's coverage. */
  def covers(tenant: String, p: Geo.Point): Boolean = {
    val box = jedis.hgetAll(coverageKey(tenant)).asScala
    box.nonEmpty && box("min_lat").toDouble <= p.lat && p.lat <= box("max_lat").toDouble && box("min_lng").toDouble <= p.lng && p.lng <= box("max_lng").toDouble
  }
}
`,
  [scalaPath('mapsd', 'Engine')]: `package mapsd

import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import mapsrouting.maps_routing.{ComputeRouteRequest, LatLng, RoutingEngineGrpc}

/**
 * The routing engine client (provided; step 3 builds the same computeRoute): one ComputeRoute per
 * attempt to engine:9000 with a DeadlineMs deadline, at most MaxAttempts attempts, retrying only
 * UNAVAILABLE and DEADLINE_EXCEEDED. NOT_FOUND (no road connects the points) throws NoRoute. When
 * the attempts run out, or the engine answers any other status, the route is a straight-line
 * estimate marked degraded, for the caller's epoch.
 */
object Engine {
  /** No road connects the points: terminal, a retry or an estimate cannot invent one. */
  final class NoRoute(message: String) extends Exception(message)

  val DeadlineMs = 1500L
  val MaxAttempts = 3
  val FallbackSpeedMps = 13.9
  val StraightLine = "straight-line"

  private val stub = RoutingEngineGrpc.blockingStub(ManagedChannelBuilder.forAddress("engine", 9000).usePlaintext().build())

  /** The great-circle estimate, marked degraded: what to answer when the engine cannot. */
  def straightLine(origin: Geo.Point, destination: Geo.Point, epoch: Long): Geo.Route = {
    val distance = Geo.haversineM(origin, destination)
    Geo.Route(distance, distance / FallbackSpeedMps, "", epoch, StraightLine, degraded = true)
  }

  private def latLng(p: Geo.Point): LatLng = LatLng(p.lat, p.lng)

  /** The engine's route for the trip at the traffic epoch, or the degraded estimate. */
  def computeRoute(origin: Geo.Point, destination: Geo.Point, waypoints: Seq[Geo.Point], epoch: Long): Geo.Route = {
    val request = ComputeRouteRequest(Some(latLng(origin)), Some(latLng(destination)), waypoints.map(latLng), epoch)
    var attempt = 0
    var giveUp = false
    var result: Option[Geo.Route] = None
    while (result.isEmpty && !giveUp && attempt < MaxAttempts) {
      attempt += 1
      try {
        val reply = stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).computeRoute(request)
        result = Some(Geo.Route(reply.distanceM, reply.durationS, reply.geometry, epoch, reply.engineVersion, degraded = false))
      } catch {
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.NOT_FOUND =>
          throw new NoRoute(Option(e.getStatus.getDescription).getOrElse("no route"))
        case e: StatusRuntimeException =>
          val code = e.getStatus.getCode
          giveUp = code != Status.Code.UNAVAILABLE && code != Status.Code.DEADLINE_EXCEEDED
      }
    }
    result.getOrElse(straightLine(origin, destination, epoch))
  }
}
`,
  [scalaPath('mapsd', 'RouteCache')]: `package mapsd

import redis.clients.jedis.JedisPooled
import redis.clients.jedis.params.SetParams
import spray.json._

/**
 * The route cache (provided; step 2 builds the same cachedRoute): route:{epoch}:{cells} holds a
 * computed route as JSON for TtlS seconds, where cells are the origin, each waypoint and the
 * destination snapped to a CellDegrees grid (floor), "lat,lng" each, joined by ";". A degraded
 * estimate is returned but not stored.
 */
object RouteCache {
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
        if (!route.degraded) jedis.set(key, Geo.toJson(route).compactPrint, SetParams.setParams().ex(TtlS))
        route
    }
  }
}
`,
  [scalaPath('mapsd', 'Routes')]: `package mapsd

import redis.clients.jedis.JedisPooled
import spray.json._

import scala.jdk.CollectionConverters._

/**
 * The route store (provided): routes:{id} is a Redis hash with the tenant that computed the route
 * and the route's fields (distance_m, duration_s, geometry, epoch, engine_version, degraded as
 * "1"/"0"); ids are r-1, r-2, ... from routes:seq. outbox:route.computed is the list of route events
 * the broker refused, one JSON row {"key", "payload"} each, which a relay republishes.
 */
object Routes {
  /** A stored route and the tenant that computed it. */
  final case class Stored(tenant: String, route: Geo.Route)

  val OutboxKey = "outbox:route.computed"

  val jedis = new JedisPooled("redis", 6379)

  def storedKey(routeId: String): String = s"routes:$routeId"

  /** Store the route for the tenant; its id. */
  def saveRoute(tenant: String, route: Geo.Route): String = {
    val routeId = s"r-\${jedis.incr("routes:seq")}"
    jedis.hset(
      storedKey(routeId),
      Map(
        "tenant" -> tenant,
        "distance_m" -> route.distanceM.toString,
        "duration_s" -> route.durationS.toString,
        "geometry" -> route.geometry,
        "epoch" -> route.epoch.toString,
        "engine_version" -> route.engineVersion,
        "degraded" -> (if (route.degraded) "1" else "0"),
      ).asJava,
    )
    routeId
  }

  /** The stored route, if there is one. */
  def loadRoute(routeId: String): Option[Stored] = {
    val raw = jedis.hgetAll(storedKey(routeId)).asScala
    if (raw.isEmpty) None
    else
      Some(Stored(raw("tenant"), Geo.Route(raw("distance_m").toDouble, raw("duration_s").toDouble, raw("geometry"), raw("epoch").toLong, raw("engine_version"), raw("degraded") == "1")))
  }

  /** Keep a refused event (its record key and value) for the relay. */
  def addOutbox(key: String, payload: String): Unit =
    jedis.rpush(OutboxKey, JsObject("key" -> JsString(key), "payload" -> JsString(payload)).compactPrint)
}
`,
};
