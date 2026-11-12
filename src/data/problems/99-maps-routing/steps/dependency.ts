import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Engine calls with a deadline and an honest fallback',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'failing-dependencies'],
  file: 'client',
  focus: ['api', 'engine', 'fallback'],
  task: `## Task

**Starting point.** The starter is the engine client the cache calls:
\`compute_route(origin, destination, waypoints, epoch)\` sends \`ComputeRoute\` to \`engine:9000\`, retries
any error up to five times, keeps the last route the engine answered in \`last_known\`, and when every
attempt failed returns \`last_known\`, or \`straight_line(origin, destination, epoch)\` (the estimate
marked \`degraded\`) when there is none. With the engine healthy it serves the demo; it hides four
flaws.

**Failure mode the checks target.** A stalled solver holds every request for as long as it likes; an
engine that is down is called five times per request; a trip no road connects is retried, then
answered with a straight line across the water; and during an outage one user's trip is answered
with another user's route.

\`\`\`proto
service RoutingEngine { rpc ComputeRoute(ComputeRouteRequest) returns (ComputeRouteReply); }  // NOT_FOUND: no road
\`\`\`

- Every call carries a \`DEADLINE_S = 1.5\` s deadline.
- At most \`MAX_ATTEMPTS = 3\` attempts. Only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retried; any
  other status goes to the estimate at once.
- \`NOT_FOUND\` raises \`NoRoute\` (Go: an error wrapping \`ErrNoRoute\`) after one call.
- When the engine cannot answer, the result is \`straight_line(origin, destination, epoch)\` for this
  trip, never a remembered route.`,
  sequence: {
    participants: ['Route cache', 'Engine client', 'Routing engine'],
    messages: [
      {
        from: 'Route cache',
        to: 'Engine client',
        label: 'compute_route(origin, destination, waypoints, epoch)',
        kind: 'sync',
      },
      {from: 'Engine client', to: 'Routing engine', label: 'ComputeRoute · deadline 1.5 s · attempt ≤ 3', kind: 'sync'},
      {from: 'Routing engine', to: 'Engine client', label: 'UNAVAILABLE / DEADLINE_EXCEEDED → retry', kind: 'reply'},
      {from: 'Routing engine', to: 'Engine client', label: 'NOT_FOUND → NoRoute, no retry, no estimate', kind: 'reply'},
      {
        from: 'Engine client',
        to: 'Route cache',
        label: 'route · or straight_line(origin, destination, epoch), degraded',
        kind: 'reply',
      },
    ],
  },
  checks: [
    {
      id: 'deadline',
      title: 'Every engine call carries a 1.5-second deadline',
      detail:
        'Each `ComputeRoute` is made with `DEADLINE_S` (1.5 s), so a stalled solver costs at most three short attempts; the starter sets no deadline and waits as long as the solver does.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*1\.5/, /ComputeRoute\([\s\S]{0,120}?timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*1500/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadline\s*=\s*1500\s*\*\s*time\.Millisecond/, /context\.WithTimeout\([^\n]*deadline\)/]},
        scala: {all: [/DeadlineMs\s*=\s*1500/, /withDeadlineAfter\(\s*DeadlineMs/]},
        cpp: {all: [/kDeadline\{1500\}/, /set_deadline\([^\n]*kDeadline\)/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'Three attempts, and only the two retryable codes',
      detail:
        'At most `MAX_ATTEMPTS` (3) calls per request, retrying `UNAVAILABLE` and `DEADLINE_EXCEEDED` only; any other status goes to the estimate after one call. The starter retries every error five times.',
      match: {
        python: {
          all: [/MAX_ATTEMPTS\s*=\s*3/, /range\(MAX_ATTEMPTS\)/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/range\(5\)/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*3/, /attempt\s*<\s*MAX_ATTEMPTS/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/attempt\s*<\s*5/],
        },
        go: {
          all: [/maxAttempts\s*=\s*3/, /attempt\s*<\s*maxAttempts/, /codes\.Unavailable/, /codes\.DeadlineExceeded/],
          none: [/attempt\s*<\s*5/],
        },
        scala: {
          all: [/MaxAttempts\s*=\s*3/, /attempt\s*<\s*MaxAttempts/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/attempt\s*<\s*5/],
        },
        cpp: {
          all: [/kMaxAttempts\s*=\s*3/, /attempt\s*<\s*kMaxAttempts/, /UNAVAILABLE/, /DEADLINE_EXCEEDED/],
          none: [/attempt\s*<\s*5/],
        },
      },
    },
    {
      id: 'no-route',
      title: 'NOT_FOUND is terminal: NoRoute after one call',
      detail:
        'A `NOT_FOUND` answer raises `NoRoute` at once: no road connects the points, so a retry or a straight line would only invent one. The starter retries it and then answers with the estimate.',
      match: {
        python: {all: [/StatusCode\.NOT_FOUND/, /raise NoRoute/]},
        typescript: {all: [/grpc\.status\.NOT_FOUND/, /throw new NoRoute/]},
        go: {all: [/codes\.NotFound/, /return geo\.Route\{\},\s*(fmt\.Errorf\("%w[^\n]*ErrNoRoute|ErrNoRoute)/]},
        scala: {all: [/Status\.Code\.NOT_FOUND/, /throw new NoRoute/]},
        cpp: {all: [/StatusCode::NOT_FOUND/, /throw NoRoute/]},
      },
    },
    {
      id: 'degraded-fallback',
      title: "The fallback is this trip's estimate, not a remembered route",
      detail:
        'When the engine cannot answer, the result is `straight_line(origin, destination, epoch)`, marked degraded; the starter returns `last_known`, the last route the engine answered, whatever trip it was for.',
      match: {
        python: {all: [/return straight_line\(origin, destination, epoch\)/], none: [/last_known/]},
        typescript: {all: [/return straightLine\(origin, destination, epoch\)/], none: [/lastKnown/]},
        go: {all: [/return straightLine\(origin, destination, epoch\)/], none: [/lastKnown/]},
        scala: {all: [/straightLine\(origin, destination, epoch\)/], none: [/lastKnown/]},
        cpp: {all: [/return straightLine\(origin, destination, epoch\)/], none: [/last_known/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import maps_routing_pb2
import maps_routing_pb2_grpc
from mapsd.geo import haversine_m

FALLBACK_SPEED_MPS = 13.9

engine = maps_routing_pb2_grpc.RoutingEngineStub(grpc.insecure_channel("engine:9000"))

# The last route the engine answered: better than nothing while it is down.
last_known: dict | None = None


class NoRoute(Exception):
    """No road connects the points: terminal, a retry or an estimate cannot invent one."""


def straight_line(origin, destination, epoch: int) -> dict:
    """The great-circle estimate, marked degraded: what to answer when the engine cannot."""
    distance = haversine_m(origin, destination)
    return {"distance_m": distance, "duration_s": distance / FALLBACK_SPEED_MPS, "geometry": "", "epoch": epoch, "engine_version": "straight-line", "degraded": True}


def _latlng(point) -> maps_routing_pb2.LatLng:
    return maps_routing_pb2.LatLng(lat=point.lat, lng=point.lng)


def compute_route(origin, destination, waypoints, epoch: int) -> dict:
    """The engine's route for the trip at the traffic epoch, or the degraded estimate."""
    # TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    global last_known
    request = maps_routing_pb2.ComputeRouteRequest(
        origin=_latlng(origin), destination=_latlng(destination), waypoints=[_latlng(p) for p in waypoints], epoch=epoch
    )
    for _ in range(5):
        try:
            reply = engine.ComputeRoute(request)
        except grpc.RpcError:
            continue
        last_known = {"distance_m": reply.distance_m, "duration_s": reply.duration_s, "geometry": reply.geometry, "epoch": epoch, "engine_version": reply.engine_version, "degraded": False}
        return last_known
    return last_known if last_known is not None else straight_line(origin, destination, epoch)
`,
      solution: `import grpc

import maps_routing_pb2
import maps_routing_pb2_grpc
from mapsd.geo import haversine_m

DEADLINE_S = 1.5
MAX_ATTEMPTS = 3
RETRYABLE = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)
FALLBACK_SPEED_MPS = 13.9

engine = maps_routing_pb2_grpc.RoutingEngineStub(grpc.insecure_channel("engine:9000"))


class NoRoute(Exception):
    """No road connects the points: terminal, a retry or an estimate cannot invent one."""


def straight_line(origin, destination, epoch: int) -> dict:
    """The great-circle estimate, marked degraded: what to answer when the engine cannot."""
    distance = haversine_m(origin, destination)
    return {"distance_m": distance, "duration_s": distance / FALLBACK_SPEED_MPS, "geometry": "", "epoch": epoch, "engine_version": "straight-line", "degraded": True}


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
                raise NoRoute(exc.details()) from exc  # no road: a retry cannot invent one
            if exc.code() in RETRYABLE:
                continue
            break  # the engine refused this request: retrying would only add load
        return {"distance_m": reply.distance_m, "duration_s": reply.duration_s, "geometry": reply.geometry, "epoch": epoch, "engine_version": reply.engine_version, "degraded": False}
    return straight_line(origin, destination, epoch)
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Point, type Route, haversineM} from 'mapsd/geo';

export const FALLBACK_SPEED_MPS = 13.9;

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

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('maps_routing.proto')) as unknown as {
  mapsrouting: {RoutingEngine: grpc.ServiceClientConstructor};
};
const engine = new pkg.mapsrouting.RoutingEngine('engine:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  ComputeRoute(request: ComputeRouteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<ComputeRouteReply>;
};

/** No road connects the points: terminal, a retry or an estimate cannot invent one. */
export class NoRoute extends Error {}

/** The last route the engine answered: better than nothing while it is down. */
let lastKnown: Route | null = null;

/** The great-circle estimate, marked degraded: what to answer when the engine cannot. */
export function straightLine(origin: Point, destination: Point, epoch: number): Route {
  const distance = haversineM(origin, destination);
  return {distance_m: distance, duration_s: distance / FALLBACK_SPEED_MPS, geometry: '', epoch, engine_version: 'straight-line', degraded: true};
}

/** The engine's route for the trip at the traffic epoch, or the degraded estimate. */
export async function computeRoute(origin: Point, destination: Point, waypoints: Point[], epoch: number): Promise<Route> {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const reply = await engine.ComputeRoute({origin, destination, waypoints, epoch}, new grpc.Metadata(), {});
      lastKnown = {distance_m: reply.distance_m, duration_s: reply.duration_s, geometry: reply.geometry, epoch, engine_version: reply.engine_version, degraded: false};
      return lastKnown;
    } catch {
      continue;
    }
  }
  return lastKnown ?? straightLine(origin, destination, epoch);
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {type Point, type Route, haversineM} from 'mapsd/geo';

export const DEADLINE_MS = 1500;
export const MAX_ATTEMPTS = 3;
export const FALLBACK_SPEED_MPS = 13.9;

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

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('maps_routing.proto')) as unknown as {
  mapsrouting: {RoutingEngine: grpc.ServiceClientConstructor};
};
const engine = new pkg.mapsrouting.RoutingEngine('engine:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  ComputeRoute(request: ComputeRouteRequest, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<ComputeRouteReply>;
};

const RETRYABLE = new Set([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);

/** No road connects the points: terminal, a retry or an estimate cannot invent one. */
export class NoRoute extends Error {}

/** The great-circle estimate, marked degraded: what to answer when the engine cannot. */
export function straightLine(origin: Point, destination: Point, epoch: number): Route {
  const distance = haversineM(origin, destination);
  return {distance_m: distance, duration_s: distance / FALLBACK_SPEED_MPS, geometry: '', epoch, engine_version: 'straight-line', degraded: true};
}

/** The engine's route for the trip at the traffic epoch, or the degraded estimate. */
export async function computeRoute(origin: Point, destination: Point, waypoints: Point[], epoch: number): Promise<Route> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await engine.ComputeRoute({origin, destination, waypoints, epoch}, new grpc.Metadata(), {deadline: Date.now() + DEADLINE_MS});
      return {distance_m: reply.distance_m, duration_s: reply.duration_s, geometry: reply.geometry, epoch, engine_version: reply.engine_version, degraded: false};
    } catch (e) {
      const {code, details} = e as grpc.ServiceError;
      if (code === grpc.status.NOT_FOUND) throw new NoRoute(details); // no road: a retry cannot invent one
      if (!RETRYABLE.has(code)) break; // the engine refused this request: retrying would only add load
    }
  }
  return straightLine(origin, destination, epoch);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "mapsd/gen/maps_routing"
	"mapsd/geo" // geo.Point, geo.Route, geo.HaversineM
)

const fallbackSpeedMPS = 13.9

var (
	conn, _ = grpc.NewClient("engine:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	engine  = pb.NewRoutingEngineClient(conn)
)

// ErrNoRoute: no road connects the points; terminal, a retry or an estimate cannot invent one.
var ErrNoRoute = errors.New("no route")

// lastKnown is the last route the engine answered: better than nothing while it is down.
var lastKnown *geo.Route

// straightLine is the great-circle estimate, marked degraded: what to answer when the engine cannot.
func straightLine(origin, destination geo.Point, epoch int64) geo.Route {
	distance := geo.HaversineM(origin, destination)
	return geo.Route{DistanceM: distance, DurationS: distance / fallbackSpeedMPS, Epoch: epoch, EngineVersion: "straight-line", Degraded: true}
}

func latLng(p geo.Point) *pb.LatLng { return &pb.LatLng{Lat: p.Lat, Lng: p.Lng} }

// computeRoute is the engine's route for the trip at the traffic epoch, or the degraded estimate.
func computeRoute(ctx context.Context, origin, destination geo.Point, waypoints []geo.Point, epoch int64) (geo.Route, error) {
	// TODO: this starter has four flaws. The task says where to look; the checks say what must change.
	request := &pb.ComputeRouteRequest{Origin: latLng(origin), Destination: latLng(destination), Epoch: epoch}
	for _, p := range waypoints {
		request.Waypoints = append(request.Waypoints, latLng(p))
	}
	for attempt := 0; attempt < 5; attempt++ {
		reply, err := engine.ComputeRoute(ctx, request)
		if err != nil {
			continue
		}
		route := geo.Route{DistanceM: reply.GetDistanceM(), DurationS: reply.GetDurationS(), Geometry: reply.GetGeometry(), Epoch: epoch, EngineVersion: reply.GetEngineVersion()}
		lastKnown = &route
		return route, nil
	}
	if lastKnown != nil {
		return *lastKnown, nil
	}
	return straightLine(origin, destination, epoch), nil
}
`,
      solution: `package main

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
	"mapsd/geo" // geo.Point, geo.Route, geo.HaversineM
)

const (
	deadline         = 1500 * time.Millisecond
	maxAttempts      = 3
	fallbackSpeedMPS = 13.9
)

var (
	conn, _ = grpc.NewClient("engine:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
	engine  = pb.NewRoutingEngineClient(conn)
)

// ErrNoRoute: no road connects the points; terminal, a retry or an estimate cannot invent one.
var ErrNoRoute = errors.New("no route")

// straightLine is the great-circle estimate, marked degraded: what to answer when the engine cannot.
func straightLine(origin, destination geo.Point, epoch int64) geo.Route {
	distance := geo.HaversineM(origin, destination)
	return geo.Route{DistanceM: distance, DurationS: distance / fallbackSpeedMPS, Epoch: epoch, EngineVersion: "straight-line", Degraded: true}
}

func latLng(p geo.Point) *pb.LatLng { return &pb.LatLng{Lat: p.Lat, Lng: p.Lng} }

// computeRoute is the engine's route for the trip at the traffic epoch, or the degraded estimate.
func computeRoute(ctx context.Context, origin, destination geo.Point, waypoints []geo.Point, epoch int64) (geo.Route, error) {
	request := &pb.ComputeRouteRequest{Origin: latLng(origin), Destination: latLng(destination), Epoch: epoch}
	for _, p := range waypoints {
		request.Waypoints = append(request.Waypoints, latLng(p))
	}
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := engine.ComputeRoute(callCtx, request)
		cancel()
		if err == nil {
			return geo.Route{DistanceM: reply.GetDistanceM(), DurationS: reply.GetDurationS(), Geometry: reply.GetGeometry(), Epoch: epoch, EngineVersion: reply.GetEngineVersion()}, nil
		}
		code := status.Code(err)
		if code == codes.NotFound {
			return geo.Route{}, fmt.Errorf("%w: %s", ErrNoRoute, status.Convert(err).Message()) // no road: a retry cannot invent one
		}
		if code != codes.Unavailable && code != codes.DeadlineExceeded {
			break // the engine refused this request: retrying would only add load
		}
	}
	return straightLine(origin, destination, epoch), nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import mapsd.Geo // Geo.Point, Geo.Route, Geo.haversineM
import mapsrouting.maps_routing.{ComputeRouteRequest, LatLng, RoutingEngineGrpc}

/** No road connects the points: terminal, a retry or an estimate cannot invent one. */
final class NoRoute(message: String) extends Exception(message)

object EngineClient {
  val FallbackSpeedMps = 13.9

  private val engine = RoutingEngineGrpc.blockingStub(ManagedChannelBuilder.forAddress("engine", 9000).usePlaintext().build())

  /** The last route the engine answered: better than nothing while it is down. */
  private var lastKnown: Option[Geo.Route] = None

  /** The great-circle estimate, marked degraded: what to answer when the engine cannot. */
  def straightLine(origin: Geo.Point, destination: Geo.Point, epoch: Long): Geo.Route = {
    val distance = Geo.haversineM(origin, destination)
    Geo.Route(distance, distance / FallbackSpeedMps, "", epoch, "straight-line", degraded = true)
  }

  private def latLng(p: Geo.Point): LatLng = LatLng(p.lat, p.lng)

  /** The engine's route for the trip at the traffic epoch, or the degraded estimate. */
  def computeRoute(origin: Geo.Point, destination: Geo.Point, waypoints: Seq[Geo.Point], epoch: Long): Geo.Route = {
    // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
    val request = ComputeRouteRequest(Some(latLng(origin)), Some(latLng(destination)), waypoints.map(latLng), epoch)
    var attempt = 0
    var result: Option[Geo.Route] = None
    while (result.isEmpty && attempt < 5) {
      attempt += 1
      try {
        val reply = engine.computeRoute(request)
        result = Some(Geo.Route(reply.distanceM, reply.durationS, reply.geometry, epoch, reply.engineVersion, degraded = false))
        lastKnown = result
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
    result.orElse(lastKnown).getOrElse(straightLine(origin, destination, epoch))
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import mapsd.Geo // Geo.Point, Geo.Route, Geo.haversineM
import mapsrouting.maps_routing.{ComputeRouteRequest, LatLng, RoutingEngineGrpc}

/** No road connects the points: terminal, a retry or an estimate cannot invent one. */
final class NoRoute(message: String) extends Exception(message)

object EngineClient {
  val DeadlineMs = 1500L
  val MaxAttempts = 3
  val FallbackSpeedMps = 13.9

  private val engine = RoutingEngineGrpc.blockingStub(ManagedChannelBuilder.forAddress("engine", 9000).usePlaintext().build())

  /** The great-circle estimate, marked degraded: what to answer when the engine cannot. */
  def straightLine(origin: Geo.Point, destination: Geo.Point, epoch: Long): Geo.Route = {
    val distance = Geo.haversineM(origin, destination)
    Geo.Route(distance, distance / FallbackSpeedMps, "", epoch, "straight-line", degraded = true)
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
        val reply = engine.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).computeRoute(request)
        result = Some(Geo.Route(reply.distanceM, reply.durationS, reply.geometry, epoch, reply.engineVersion, degraded = false))
      } catch {
        case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.NOT_FOUND =>
          throw new NoRoute(Option(e.getStatus.getDescription).getOrElse("no route")) // no road: a retry cannot invent one
        case e: StatusRuntimeException =>
          val code = e.getStatus.getCode
          // Anything but UNAVAILABLE or DEADLINE_EXCEEDED: the engine refused this request, retrying would only add load.
          giveUp = code != Status.Code.UNAVAILABLE && code != Status.Code.DEADLINE_EXCEEDED
      }
    }
    result.getOrElse(straightLine(origin, destination, epoch))
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

#include "maps_routing.grpc.pb.h"
#include "mapsd/geo.h"  // geo::Point, geo::Route, geo::haversineM

constexpr double kFallbackSpeedMps = 13.9;

auto engine = mapsrouting::RoutingEngine::NewStub(grpc::CreateChannel("engine:9000", grpc::InsecureChannelCredentials()));

// No road connects the points: terminal, a retry or an estimate cannot invent one.
struct NoRoute : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The last route the engine answered: better than nothing while it is down.
std::optional<geo::Route> last_known;

// The great-circle estimate, marked degraded: what to answer when the engine cannot.
geo::Route straightLine(const geo::Point& origin, const geo::Point& destination, long long epoch) {
  geo::Route route;
  route.distance_m = geo::haversineM(origin, destination);
  route.duration_s = route.distance_m / kFallbackSpeedMps;
  route.epoch = epoch;
  route.engine_version = "straight-line";
  route.degraded = true;
  return route;
}

void setLatLng(mapsrouting::LatLng* out, const geo::Point& p) {
  out->set_lat(p.lat);
  out->set_lng(p.lng);
}

// The engine's route for the trip at the traffic epoch, or the degraded estimate.
geo::Route computeRoute(const geo::Point& origin, const geo::Point& destination, const std::vector<geo::Point>& waypoints, long long epoch) {
  // TODO: this starter has four flaws. The task says where to look; the checks say what must change.
  mapsrouting::ComputeRouteRequest request;
  setLatLng(request.mutable_origin(), origin);
  setLatLng(request.mutable_destination(), destination);
  for (const geo::Point& p : waypoints) setLatLng(request.add_waypoints(), p);
  request.set_epoch(epoch);
  for (int attempt = 0; attempt < 5; attempt++) {
    grpc::ClientContext ctx;
    mapsrouting::ComputeRouteReply reply;
    if (!engine->ComputeRoute(&ctx, request, &reply).ok()) continue;
    geo::Route route;
    route.distance_m = reply.distance_m();
    route.duration_s = reply.duration_s();
    route.geometry = reply.geometry();
    route.epoch = epoch;
    route.engine_version = reply.engine_version();
    last_known = route;
    return route;
  }
  return last_known ? *last_known : straightLine(origin, destination, epoch);
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

#include "maps_routing.grpc.pb.h"
#include "mapsd/geo.h"  // geo::Point, geo::Route, geo::haversineM

constexpr std::chrono::milliseconds kDeadline{1500};
constexpr int kMaxAttempts = 3;
constexpr double kFallbackSpeedMps = 13.9;

auto engine = mapsrouting::RoutingEngine::NewStub(grpc::CreateChannel("engine:9000", grpc::InsecureChannelCredentials()));

// No road connects the points: terminal, a retry or an estimate cannot invent one.
struct NoRoute : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// The great-circle estimate, marked degraded: what to answer when the engine cannot.
geo::Route straightLine(const geo::Point& origin, const geo::Point& destination, long long epoch) {
  geo::Route route;
  route.distance_m = geo::haversineM(origin, destination);
  route.duration_s = route.distance_m / kFallbackSpeedMps;
  route.epoch = epoch;
  route.engine_version = "straight-line";
  route.degraded = true;
  return route;
}

void setLatLng(mapsrouting::LatLng* out, const geo::Point& p) {
  out->set_lat(p.lat);
  out->set_lng(p.lng);
}

// The engine's route for the trip at the traffic epoch, or the degraded estimate.
geo::Route computeRoute(const geo::Point& origin, const geo::Point& destination, const std::vector<geo::Point>& waypoints, long long epoch) {
  mapsrouting::ComputeRouteRequest request;
  setLatLng(request.mutable_origin(), origin);
  setLatLng(request.mutable_destination(), destination);
  for (const geo::Point& p : waypoints) setLatLng(request.add_waypoints(), p);
  request.set_epoch(epoch);
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    mapsrouting::ComputeRouteReply reply;
    const grpc::Status status = engine->ComputeRoute(&ctx, request, &reply);
    if (status.ok()) {
      geo::Route route;
      route.distance_m = reply.distance_m();
      route.duration_s = reply.duration_s();
      route.geometry = reply.geometry();
      route.epoch = epoch;
      route.engine_version = reply.engine_version();
      return route;
    }
    // No road: a retry cannot invent one.
    if (status.error_code() == grpc::StatusCode::NOT_FOUND) throw NoRoute(status.error_message());
    // Anything but UNAVAILABLE or DEADLINE_EXCEEDED: the engine refused this request, retrying would only add load.
    if (status.error_code() != grpc::StatusCode::UNAVAILABLE && status.error_code() != grpc::StatusCode::DEADLINE_EXCEEDED) break;
  }
  return straightLine(origin, destination, epoch);
}
`,
    },
  },
  harness: {
    python: `import grpc

import maps_routing_pb2
import maps_routing_pb2_grpc
from mapsd.geo import Point, haversine_m

SF = Point(37.77412, -122.41942)
OAKLAND = Point(37.80418, -122.27112)
ALCATRAZ = Point(37.82667, -122.42306)
SAN_JOSE = Point(37.33874, -121.88533)
PALO_ALTO = Point(37.44188, -122.14302)


class Engine(maps_routing_pb2_grpc.RoutingEngineServicer):
    """A road route is 1.3 times the great-circle legs; no road reaches Alcatraz."""

    def ComputeRoute(self, request, context):
        points = [request.origin, *request.waypoints, request.destination]
        if any(abs(p.lat - ALCATRAZ.lat) < 0.001 and abs(p.lng - ALCATRAZ.lng) < 0.001 for p in points):
            context.abort(grpc.StatusCode.NOT_FOUND, "no road reaches Alcatraz")
        distance = 1.3 * sum(haversine_m(a, b) for a, b in zip(points, points[1:]))
        return maps_routing_pb2.ComputeRouteReply(distance_m=distance, duration_s=distance / 11, geometry=f"poly:{len(points)}", engine_version="osrm-v26.9")


def _client(ctx):
    ctx.grpc.serve(maps_routing_pb2_grpc.add_RoutingEngineServicer_to_server, Engine())
    return ctx.load("client")


def _calls(ctx):
    return len(ctx.grpc.calls_to("ComputeRoute"))


def check_deadline(ctx):
    m = _client(ctx)
    assert m.compute_route(SF, OAKLAND, [], 7)["degraded"] is False, "with the engine healthy the answer must be its road route"
    ctx.grpc.set_latency("ComputeRoute", 10.0)
    started = ctx.clock.time()
    slow = m.compute_route(SAN_JOSE, PALO_ALTO, [], 7)
    waited = ctx.clock.time() - started
    for call in ctx.grpc.calls_to("ComputeRoute"):
        assert call.timeout is not None, "a ComputeRoute call carries no deadline: a stalled solver holds the request for as long as it likes"
        assert 1.4 <= call.timeout <= 1.6, f"a ComputeRoute call carries a {call.timeout} s deadline, expected DEADLINE_S = 1.5"
    assert waited <= 5, f"one request waited {waited:.1f} s on a stalled engine, expected at most three attempts of 1.5 s"
    assert slow["degraded"] is True, f"with every solve slower than the deadline the answer must be the degraded estimate, got {slow}"


def check_bounded_retry(ctx):
    m = _client(ctx)
    ctx.grpc.fail("ComputeRoute", grpc.StatusCode.UNAVAILABLE, "engine restarting", times=2)
    route = m.compute_route(SF, OAKLAND, [], 7)
    assert route["degraded"] is False and _calls(ctx) == 3, f"two UNAVAILABLE answers, then a healthy engine: the third attempt must get the road route (calls {_calls(ctx)}, answer {route})"
    ctx.grpc.fail("ComputeRoute", grpc.StatusCode.UNAVAILABLE, "engine down", times=3)
    before = _calls(ctx)
    down = m.compute_route(SAN_JOSE, PALO_ALTO, [], 7)
    assert _calls(ctx) - before == 3, f"an engine that stays UNAVAILABLE was called {_calls(ctx) - before} times for one request, expected MAX_ATTEMPTS = 3"
    assert down["degraded"] is True, f"after three UNAVAILABLE answers the answer must be the degraded estimate, got {down}"
    ctx.grpc.fail("ComputeRoute", grpc.StatusCode.RESOURCE_EXHAUSTED, "solver queue full", times=1)
    before = _calls(ctx)
    busy = m.compute_route(SAN_JOSE, PALO_ALTO, [], 7)
    assert _calls(ctx) - before == 1, f"RESOURCE_EXHAUSTED was retried ({_calls(ctx) - before} calls): only UNAVAILABLE and DEADLINE_EXCEEDED are"
    assert busy["degraded"] is True, f"after a RESOURCE_EXHAUSTED answer the answer must be the degraded estimate, got {busy}"


def check_no_route(ctx):
    m = _client(ctx)
    try:
        route = m.compute_route(SF, ALCATRAZ, [], 7)
    except m.NoRoute:
        pass
    else:
        raise AssertionError(f"no road reaches Alcatraz, but compute_route returned {route}: NOT_FOUND must raise NoRoute, not become an estimate")
    assert _calls(ctx) == 1, f"a NOT_FOUND answer was retried ({_calls(ctx)} calls): no road means no road"


def check_degraded_fallback(ctx):
    m = _client(ctx)
    m.compute_route(SF, OAKLAND, [], 7)
    ctx.grpc.fail("ComputeRoute", grpc.StatusCode.UNAVAILABLE, "engine down", times=5)
    route = m.compute_route(SAN_JOSE, PALO_ALTO, [], 8)
    expected = haversine_m(SAN_JOSE, PALO_ALTO)
    assert route["degraded"] is True, f"with the engine down the answer must be marked degraded, got {route}"
    assert abs(route["distance_m"] - expected) < 1, f"the answer for San Jose to Palo Alto says {route['distance_m']:.0f} m, its straight line is {expected:.0f} m: it is another trip's route"
    assert route["epoch"] == 8, f"the estimate must carry the caller's epoch 8, got {route['epoch']}"
`,
    typescript: `const SF = {lat: 37.77412, lng: -122.41942};
const OAKLAND = {lat: 37.80418, lng: -122.27112};
const ALCATRAZ = {lat: 37.82667, lng: -122.42306};
const SAN_JOSE = {lat: 37.33874, lng: -121.88533};
const PALO_ALTO = {lat: 37.44188, lng: -122.14302};

/** The engine stand-in (a road route is 1.3 times the great-circle legs; no road reaches Alcatraz) and the learner's client. */
function client(ctx) {
  const geo = ctx.load('/support/mapsd/geo.ts');
  const pkg = ctx.proto('maps_routing.proto');
  ctx.grpc.serve(pkg.mapsrouting.RoutingEngine.service, {
    ComputeRoute(call, callback) {
      const points = [call.request.origin, ...call.request.waypoints, call.request.destination];
      if (points.some(p => Math.abs(p.lat - ALCATRAZ.lat) < 0.001 && Math.abs(p.lng - ALCATRAZ.lng) < 0.001)) {
        return callback({code: ctx.grpc.status.NOT_FOUND, details: 'no road reaches Alcatraz'});
      }
      let distance = 0;
      for (let i = 1; i < points.length; i += 1) distance += geo.haversineM(points[i - 1], points[i]);
      distance *= 1.3;
      callback(null, {distance_m: distance, duration_s: distance / 11, geometry: \`poly:\${points.length}\`, engine_version: 'osrm-v26.9'});
    },
  });
  return {m: ctx.load('client'), geo};
}

const calls = ctx => ctx.grpc.callsTo('ComputeRoute').length;

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  assert.equal((await m.computeRoute(SF, OAKLAND, [], 7)).degraded, false, 'with the engine healthy the answer must be its road route');
  ctx.grpc.setLatency('ComputeRoute', 10.0);
  const started = ctx.clock.now();
  const slow = await m.computeRoute(SAN_JOSE, PALO_ALTO, [], 7);
  const waited = (ctx.clock.now() - started) / 1000;
  for (const call of ctx.grpc.callsTo('ComputeRoute')) {
    assert(call.timeout !== null, 'a ComputeRoute call carries no deadline: a stalled solver holds the request for as long as it likes');
    assert(1.4 <= call.timeout && call.timeout <= 1.6, \`a ComputeRoute call carries a \${call.timeout} s deadline, expected DEADLINE_MS = 1500\`);
  }
  assert(waited <= 5, \`one request waited \${waited} s on a stalled engine, expected at most three attempts of 1.5 s\`);
  assert.equal(slow.degraded, true, \`with every solve slower than the deadline the answer must be the degraded estimate, got \${JSON.stringify(slow)}\`);
}

export async function check_bounded_retry(ctx) {
  const {m} = client(ctx);
  ctx.grpc.fail('ComputeRoute', ctx.grpc.status.UNAVAILABLE, 'engine restarting', 2);
  const route = await m.computeRoute(SF, OAKLAND, [], 7);
  assert(route.degraded === false && calls(ctx) === 3, \`two UNAVAILABLE answers, then a healthy engine: the third attempt must get the road route (calls \${calls(ctx)}, answer \${JSON.stringify(route)})\`);
  ctx.grpc.fail('ComputeRoute', ctx.grpc.status.UNAVAILABLE, 'engine down', 3);
  let before = calls(ctx);
  const down = await m.computeRoute(SAN_JOSE, PALO_ALTO, [], 7);
  assert.equal(calls(ctx) - before, 3, \`an engine that stays UNAVAILABLE was called \${calls(ctx) - before} times for one request, expected MAX_ATTEMPTS = 3\`);
  assert.equal(down.degraded, true, \`after three UNAVAILABLE answers the answer must be the degraded estimate, got \${JSON.stringify(down)}\`);
  ctx.grpc.fail('ComputeRoute', ctx.grpc.status.RESOURCE_EXHAUSTED, 'solver queue full', 1);
  before = calls(ctx);
  const busy = await m.computeRoute(SAN_JOSE, PALO_ALTO, [], 7);
  assert.equal(calls(ctx) - before, 1, \`RESOURCE_EXHAUSTED was retried (\${calls(ctx) - before} calls): only UNAVAILABLE and DEADLINE_EXCEEDED are\`);
  assert.equal(busy.degraded, true, \`after a RESOURCE_EXHAUSTED answer the answer must be the degraded estimate, got \${JSON.stringify(busy)}\`);
}

export async function check_no_route(ctx) {
  const {m} = client(ctx);
  let route;
  try {
    route = await m.computeRoute(SF, ALCATRAZ, [], 7);
  } catch (e) {
    assert(e instanceof m.NoRoute, \`no road reaches Alcatraz: computeRoute threw \${(e as Error).constructor.name}, expected NoRoute\`);
  }
  assert.equal(route, undefined, \`no road reaches Alcatraz, but computeRoute returned \${JSON.stringify(route)}: NOT_FOUND must throw NoRoute, not become an estimate\`);
  assert.equal(calls(ctx), 1, \`a NOT_FOUND answer was retried (\${calls(ctx)} calls): no road means no road\`);
}

export async function check_degraded_fallback(ctx) {
  const {m, geo} = client(ctx);
  await m.computeRoute(SF, OAKLAND, [], 7);
  ctx.grpc.fail('ComputeRoute', ctx.grpc.status.UNAVAILABLE, 'engine down', 5);
  const route = await m.computeRoute(SAN_JOSE, PALO_ALTO, [], 8);
  const expected = geo.haversineM(SAN_JOSE, PALO_ALTO);
  assert.equal(route.degraded, true, \`with the engine down the answer must be marked degraded, got \${JSON.stringify(route)}\`);
  assert(Math.abs(route.distance_m - expected) < 1, \`the answer for San Jose to Palo Alto says \${route.distance_m} m, its straight line is \${expected} m: it is another trip's route\`);
  assert.equal(route.epoch, 8, \`the estimate must carry the caller's epoch 8, got \${route.epoch}\`);
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"math"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "mapsd/gen/maps_routing"
	"mapsd/geo"

	"leetbuild/harness"
)

var (
	clientBg = context.Background()
	sf       = geo.Point{Lat: 37.77412, Lng: -122.41942}
	oakland  = geo.Point{Lat: 37.80418, Lng: -122.27112}
	alcatraz = geo.Point{Lat: 37.82667, Lng: -122.42306}
	sanJose  = geo.Point{Lat: 37.33874, Lng: -121.88533}
	paloAlto = geo.Point{Lat: 37.44188, Lng: -122.14302}
)

// enginePeer: a road route is 1.3 times the great-circle legs; no road reaches Alcatraz.
type enginePeer struct {
	pb.UnimplementedRoutingEngineServer
}

func (enginePeer) ComputeRoute(_ context.Context, req *pb.ComputeRouteRequest) (*pb.ComputeRouteReply, error) {
	points := append([]*pb.LatLng{req.GetOrigin()}, req.GetWaypoints()...)
	points = append(points, req.GetDestination())
	distance := 0.0
	for i, p := range points {
		if math.Abs(p.GetLat()-alcatraz.Lat) < 0.001 && math.Abs(p.GetLng()-alcatraz.Lng) < 0.001 {
			return nil, status.Error(codes.NotFound, "no road reaches Alcatraz")
		}
		if i > 0 {
			distance += geo.HaversineM(geo.Point{Lat: points[i-1].GetLat(), Lng: points[i-1].GetLng()}, geo.Point{Lat: p.GetLat(), Lng: p.GetLng()})
		}
	}
	distance *= 1.3
	return &pb.ComputeRouteReply{DistanceM: distance, DurationS: distance / 11, Geometry: fmt.Sprintf("poly:%d", len(points)), EngineVersion: "osrm-v26.9"}, nil
}

func serveEngine(ctx *harness.Ctx) {
	pb.RegisterRoutingEngineServer(ctx.GRPC.Server(""), enginePeer{})
}

func calls(ctx *harness.Ctx) int { return len(ctx.GRPC.CallsTo("ComputeRoute", "")) }

func mustCompute(ctx *harness.Ctx, origin, destination geo.Point, epoch int64) geo.Route {
	route, err := computeRoute(clientBg, origin, destination, nil, epoch)
	ctx.NoError(err, "computeRoute failed")
	return route
}

func CheckDeadline(ctx *harness.Ctx) {
	serveEngine(ctx)
	ctx.Assert(!mustCompute(ctx, sf, oakland, 7).Degraded, "with the engine healthy the answer must be its road route")
	ctx.GRPC.SetLatency("ComputeRoute", 10.0, "")
	started := ctx.Clock.Time()
	slow := mustCompute(ctx, sanJose, paloAlto, 7)
	waited := ctx.Clock.Time().Sub(started)
	for _, call := range ctx.GRPC.CallsTo("ComputeRoute", "") {
		ctx.Assert(call.HasDeadline(), "a ComputeRoute call carries no deadline: a stalled solver holds the request for as long as it likes")
		ctx.Assert(1400*time.Millisecond <= call.Timeout && call.Timeout <= 1600*time.Millisecond, "a ComputeRoute call carries a %v deadline, expected 1.5 s", call.Timeout)
	}
	ctx.Assert(waited <= 5*time.Second, "one request waited %v on a stalled engine, expected at most three attempts of 1.5 s", waited)
	ctx.Assert(slow.Degraded, "with every solve slower than the deadline the answer must be the degraded estimate, got %+v", slow)
}

func CheckBoundedRetry(ctx *harness.Ctx) {
	serveEngine(ctx)
	ctx.GRPC.Fail("ComputeRoute", codes.Unavailable, "engine restarting", 2, "")
	route := mustCompute(ctx, sf, oakland, 7)
	ctx.Assert(!route.Degraded && calls(ctx) == 3, "two UNAVAILABLE answers, then a healthy engine: the third attempt must get the road route (calls %d, answer %+v)", calls(ctx), route)
	ctx.GRPC.Fail("ComputeRoute", codes.Unavailable, "engine down", 3, "")
	before := calls(ctx)
	down := mustCompute(ctx, sanJose, paloAlto, 7)
	ctx.Equal(calls(ctx)-before, 3, "an engine that stays UNAVAILABLE, the calls for one request (maxAttempts is 3)")
	ctx.Assert(down.Degraded, "after three UNAVAILABLE answers the answer must be the degraded estimate, got %+v", down)
	ctx.GRPC.Fail("ComputeRoute", codes.ResourceExhausted, "solver queue full", 1, "")
	before = calls(ctx)
	busy := mustCompute(ctx, sanJose, paloAlto, 7)
	ctx.Equal(calls(ctx)-before, 1, "RESOURCE_EXHAUSTED is not retried (only UNAVAILABLE and DEADLINE_EXCEEDED are); the calls")
	ctx.Assert(busy.Degraded, "after a RESOURCE_EXHAUSTED answer the answer must be the degraded estimate, got %+v", busy)
}

func CheckNoRoute(ctx *harness.Ctx) {
	serveEngine(ctx)
	route, err := computeRoute(clientBg, sf, alcatraz, nil, 7)
	ctx.Assert(err != nil, "no road reaches Alcatraz, but computeRoute returned %+v: NOT_FOUND must return ErrNoRoute, not become an estimate", route)
	ctx.ErrorIs(err, ErrNoRoute, "no road reaches Alcatraz: computeRoute returned %v", err)
	ctx.Equal(calls(ctx), 1, "a NOT_FOUND answer must not be retried (no road means no road); the calls")
}

func CheckDegradedFallback(ctx *harness.Ctx) {
	serveEngine(ctx)
	mustCompute(ctx, sf, oakland, 7)
	ctx.GRPC.Fail("ComputeRoute", codes.Unavailable, "engine down", 5, "")
	route := mustCompute(ctx, sanJose, paloAlto, 8)
	expected := geo.HaversineM(sanJose, paloAlto)
	ctx.Assert(route.Degraded, "with the engine down the answer must be marked degraded, got %+v", route)
	ctx.Assert(math.Abs(route.DistanceM-expected) < 1, "the answer for San Jose to Palo Alto says %.0f m, its straight line is %.0f m: it is another trip's route", route.DistanceM, expected)
	ctx.Equal(route.Epoch, int64(8), "the estimate must carry the caller's epoch")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cmath>
#include <string>
#include <vector>

#include "maps_routing.grpc.pb.h"
#include "mapsd/geo.h"

namespace {

const geo::Point kSf{37.77412, -122.41942};
const geo::Point kOakland{37.80418, -122.27112};
const geo::Point kAlcatraz{37.82667, -122.42306};
const geo::Point kSanJose{37.33874, -121.88533};
const geo::Point kPaloAlto{37.44188, -122.14302};

// A road route is 1.3 times the great-circle legs; no road reaches Alcatraz.
class EnginePeer final : public mapsrouting::RoutingEngine::Service {
 public:
  grpc::Status ComputeRoute(grpc::ServerContext*, const mapsrouting::ComputeRouteRequest* req, mapsrouting::ComputeRouteReply* out) override {
    std::vector<geo::Point> points = {{req->origin().lat(), req->origin().lng()}};
    for (const auto& w : req->waypoints()) points.push_back({w.lat(), w.lng()});
    points.push_back({req->destination().lat(), req->destination().lng()});
    double distance = 0;
    for (size_t i = 0; i < points.size(); i++) {
      if (std::abs(points[i].lat - kAlcatraz.lat) < 0.001 && std::abs(points[i].lng - kAlcatraz.lng) < 0.001) {
        return grpc::Status(grpc::StatusCode::NOT_FOUND, "no road reaches Alcatraz");
      }
      if (i > 0) distance += geo::haversineM(points[i - 1], points[i]);
    }
    distance *= 1.3;
    out->set_distance_m(distance);
    out->set_duration_s(distance / 11);
    out->set_geometry("poly:" + std::to_string(points.size()));
    out->set_engine_version("osrm-v26.9");
    return grpc::Status::OK;
  }
};

void serveEngine(harness::Ctx& ctx) {
  static EnginePeer* engine_peer = nullptr;
  delete engine_peer;
  engine_peer = new EnginePeer;
  ctx.GRPC.Server("")->RegisterService(engine_peer);
}

size_t calls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("ComputeRoute").size(); }

geo::Route mustCompute(harness::Ctx& ctx, const geo::Point& origin, const geo::Point& destination, long long epoch) {
  try {
    return computeRoute(origin, destination, {}, epoch);
  } catch (const std::exception& e) {
    ctx.Fatalf("computeRoute threw %s: %s", harness::CurrentExceptionType(), e.what());
  }
}

}  // namespace

void CheckDeadline(harness::Ctx& ctx) {
  serveEngine(ctx);
  ctx.Assert(!mustCompute(ctx, kSf, kOakland, 7).degraded, "with the engine healthy the answer must be its road route");
  ctx.GRPC.SetLatency("ComputeRoute", 10.0);
  const int64_t started = ctx.Clock.Now();
  const geo::Route slow = mustCompute(ctx, kSanJose, kPaloAlto, 7);
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  for (const auto& call : ctx.GRPC.CallsTo("ComputeRoute")) {
    ctx.Assert(call.HasDeadline(), "a ComputeRoute call carries no deadline: a stalled solver holds the request for as long as it likes");
    ctx.Assert(1.4 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 1.6, "a ComputeRoute call carries a %v s deadline, expected kDeadline = 1.5 s", call.TimeoutSeconds());
  }
  ctx.Assert(waited <= 5, "one request waited %v s on a stalled engine, expected at most three attempts of 1.5 s", waited);
  ctx.Assert(slow.degraded, "with every solve slower than the deadline the answer must be the degraded estimate, got engine_version %q", slow.engine_version);
}

void CheckBoundedRetry(harness::Ctx& ctx) {
  serveEngine(ctx);
  ctx.GRPC.Fail("ComputeRoute", grpc::StatusCode::UNAVAILABLE, "engine restarting", 2);
  const geo::Route route = mustCompute(ctx, kSf, kOakland, 7);
  ctx.Assert(!route.degraded && calls(ctx) == 3, "two UNAVAILABLE answers, then a healthy engine: the third attempt must get the road route (calls %d)", calls(ctx));
  ctx.GRPC.Fail("ComputeRoute", grpc::StatusCode::UNAVAILABLE, "engine down", 3);
  size_t before = calls(ctx);
  const geo::Route down = mustCompute(ctx, kSanJose, kPaloAlto, 7);
  ctx.Equal(calls(ctx) - before, 3, "an engine that stays UNAVAILABLE, the calls for one request (kMaxAttempts is 3)");
  ctx.Assert(down.degraded, "after three UNAVAILABLE answers the answer must be the degraded estimate");
  ctx.GRPC.Fail("ComputeRoute", grpc::StatusCode::RESOURCE_EXHAUSTED, "solver queue full", 1);
  before = calls(ctx);
  const geo::Route busy = mustCompute(ctx, kSanJose, kPaloAlto, 7);
  ctx.Equal(calls(ctx) - before, 1, "RESOURCE_EXHAUSTED is not retried (only UNAVAILABLE and DEADLINE_EXCEEDED are); the calls");
  ctx.Assert(busy.degraded, "after a RESOURCE_EXHAUSTED answer the answer must be the degraded estimate");
}

void CheckNoRoute(harness::Ctx& ctx) {
  serveEngine(ctx);
  bool raised = false;
  try {
    const geo::Route route = computeRoute(kSf, kAlcatraz, {}, 7);
    ctx.Fatalf("no road reaches Alcatraz, but computeRoute returned %v m (degraded %t): NOT_FOUND must throw NoRoute, not become an estimate", route.distance_m, route.degraded);
  } catch (const NoRoute&) {
    raised = true;
  }
  ctx.Assert(raised, "NOT_FOUND must throw NoRoute");
  ctx.Equal(calls(ctx), 1, "a NOT_FOUND answer must not be retried (no road means no road); the calls");
}

void CheckDegradedFallback(harness::Ctx& ctx) {
  serveEngine(ctx);
  mustCompute(ctx, kSf, kOakland, 7);
  ctx.GRPC.Fail("ComputeRoute", grpc::StatusCode::UNAVAILABLE, "engine down", 5);
  const geo::Route route = mustCompute(ctx, kSanJose, kPaloAlto, 8);
  const double expected = geo::haversineM(kSanJose, kPaloAlto);
  ctx.Assert(route.degraded, "with the engine down the answer must be marked degraded");
  ctx.Assert(std::abs(route.distance_m - expected) < 1, "the answer for San Jose to Palo Alto says %v m, its straight line is %v m: it is another trip's route", route.distance_m, expected);
  ctx.Equal(route.epoch, 8, "the estimate must carry the caller's epoch");
}
`,
  },
  hints: [
    "Stop the engine and ask for two different trips: the second comes back as the first trip's road route, with no `degraded` marker. Ask for Alcatraz and the engine is called five times before a straight line across the bay comes back.",
    'The loop catches every `RpcError` alike and tries five times with no deadline, so a stall waits as long as the solver does and a `NOT_FOUND` is retried like an outage. After the loop, `last_known` holds whatever trip the engine answered last.',
    '`timeout=DEADLINE_S` on the call; `for _ in range(MAX_ATTEMPTS)`; on `NOT_FOUND` raise `NoRoute`; `continue` only on `UNAVAILABLE` or `DEADLINE_EXCEEDED`, `break` on anything else; drop `last_known` and end with `straight_line(origin, destination, epoch)`.',
  ],
  debrief: `Each status code answers a different question, and the client's job is to keep them apart. UNAVAILABLE and DEADLINE_EXCEEDED say nothing about the trip, so they earn a bounded retry; NOT_FOUND says the trip is impossible, so a retry only spends solver time and an estimate would draw a road that does not exist. The deadline turns a stalled solver into a timeout the client can act on, and three attempts of 1.5 s cap the worst case at 4.5 s. The fallback has to describe this trip, which is why it is computed from its own endpoints and marked degraded. Production clients add jittered backoff between attempts, a circuit breaker that stops calling an engine that keeps failing, and hedged calls to a second replica.`,
};
