import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Routing engine calls with a straight-line fallback marked',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'engine', 'fallback'],
  task: `## Task

**Starting point.** The starter is the API service's engine client,
\`compute_route(origin, destination, waypoints, epoch)\`: it calls the engine's \`ComputeRoute\` RPC
in a \`while True\` loop, retries any error, and on a timeout serves whatever a \`last_known\` cache
happens to hold. When the engine is healthy the demo passes. It hides five flaws.

**Failure mode the checks target.** Every failure path is wrong, and each is invisible while the
engine is up. The call has no deadline, so one stuck solver pins the request worker. The loop
retries a \`NO_ROUTE\` answer until the request deadline, because "there must be some route". And
the \`last_known\` cache is keyed by nothing, so a route computed for an old traffic epoch is
presented as the current one the moment the engine goes quiet.

- Every attempt carries a **1.5 s deadline** on the gRPC call.
- At most **3 attempts**, and only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\` are retryable; every
  other status is returned to the caller immediately.
- When the attempts are exhausted, return a **straight-line distance estimate** between origin and
  destination, marked \`degraded = true\`. A road route cached at another traffic epoch is not a
  substitute.
- The returned route's \`epoch\` is the **caller's epoch**. Geometry the engine computed for a
  different epoch (a retry that raced an epoch bump) is not served as current.
- \`NO_ROUTE\` is **terminal**: there is no road, so a retry cannot invent one, and the fallback must
  not turn "unroutable" into "here is a rough guess".`,
  sequence: {
    participants: ['Route Handler', 'Routing Engine', 'Fallback'],
    messages: [
      {
        from: 'Route Handler',
        to: 'Routing Engine',
        label: 'ComputeRoute · deadline 1.5 s · attempt ≤ 3',
        kind: 'sync',
      },
      {from: 'Routing Engine', to: 'Route Handler', label: 'DEADLINE_EXCEEDED', kind: 'reply'},
      {
        from: 'Route Handler',
        to: 'Route Handler',
        label: 'retry only UNAVAILABLE / DEADLINE_EXCEEDED',
        kind: 'sync',
      },
      {from: 'Routing Engine', to: 'Route Handler', label: 'NO_ROUTE → terminal, no fallback', kind: 'reply'},
      {
        from: 'Route Handler',
        to: 'Fallback',
        label: 'attempts exhausted → straight-line estimate, degraded = true',
        kind: 'sync',
      },
      {
        from: 'Route Handler',
        to: 'Route Handler',
        label: 'returned epoch must equal the request · never serve cached geometry',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'The engine pod restarts and every route request hangs for the full request timeout; the ones that do return show rush-hour geometry at midnight, and an unroutable island pair comes back as a straight line.',
    'The call has no deadline, the `while True` loop treats `NO_ROUTE` like `UNAVAILABLE`, and the timeout path reads `last_known`, which stores a route under no epoch and returns it under any.',
    'Use `timeout=DEADLINE_S` on `ComputeRoute`, `for attempt in range(MAX_ATTEMPTS)` with a `RETRYABLE` set, return `NO_ROUTE` at once, reject `response.epoch != epoch`, and build the fallback from `straight_line(…)` with `degraded=True, epoch=epoch`.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every engine call carries a 1.5 s deadline',
      detail:
        'The call is created with a 1.5-second deadline — a call timeout, a context with timeout, `withDeadlineAfter`, `set_deadline` or `deadline: Date.now() + DEADLINE_MS`. Without it a stuck solver holds the request worker open indefinitely.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*1\.5/, /timeout\s*=\s*DEADLINE_S/, /ComputeRoute\(/]},
        typescript: {
          all: [/DEADLINE_MS\s*=\s*1500/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/, /ComputeRoute\(/],
        },
        go: {all: [/deadlineMS\s*=\s*1500/, /context\.WithTimeout/, /ComputeRoute\(/]},
        scala: {all: [/DeadlineMs\s*=\s*1500/, /withDeadlineAfter/, /computeRoute\(/]},
        cpp: {all: [/kDeadlineMs\s*=\s*1500/, /set_deadline\(/, /ComputeRoute\(/]},
      },
    },
    {
      id: 'degraded-fallback',
      title: 'Exhausted attempts return a marked straight-line estimate',
      detail:
        'When no attempt succeeds the client returns a straight-line distance estimate carrying `degraded = true` and the caller’s epoch. It must not return a cached road route, which would present old traffic as current.',
      match: {
        python: {all: [/degraded\s*=\s*True/, /straight_line\(/, /epoch\s*=\s*epoch/]},
        typescript: {all: [/degraded:\s*true/, /straightLine\(/, /epoch:\s*epoch/]},
        go: {all: [/Degraded:\s*true/, /straightLine\(/, /Epoch:\s*epoch/]},
        scala: {all: [/degraded\s*=\s*true/, /straightLine\(/, /epoch\s*=\s*epoch/]},
        cpp: {all: [/set_degraded\(true\)/, /StraightLine\(/, /set_epoch\(epoch\)/]},
      },
    },
    {
      id: 'terminal-no-route',
      title: 'A no-route answer is terminal',
      detail:
        'A `NO_ROUTE` response is returned to the caller immediately: it is not retried and it does not fall back to a straight-line guess. The starter retries it because "there must be some route".',
      match: {
        python: {all: [/NO_ROUTE/, /if response\.status\s*==/], none: [/while\s+True/]},
        typescript: {
          all: [/NO_ROUTE/, /if\s*\(response\.status\s*===/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {all: [/NO_ROUTE/, /if resp\.Status\s*==/], none: [/for\s*\{/]},
        scala: {all: [/NO_ROUTE/, /if \(response\.status\s*==/], none: [/while\s*\(\s*true\s*\)/]},
        cpp: {all: [/NO_ROUTE/, /if \(response\.status\(\)\s*==/], none: [/while\s*\(\s*true\s*\)/]},
      },
    },
    {
      id: 'epoch-purity',
      title: 'A response never mixes epochs',
      detail:
        'The returned geometry must carry the caller’s epoch. If the engine answers with a route computed for a different traffic state, the client must not serve it as the current one; a cached route from another epoch is the bug, not the fallback.',
      match: {
        python: {all: [/response\.epoch\s*!=\s*epoch/, /epoch\s*=\s*epoch/]},
        typescript: {all: [/response\.epoch\s*!==\s*epoch/, /epoch:\s*epoch/]},
        go: {all: [/resp\.Epoch\s*!=\s*epoch/, /Epoch:\s*epoch/]},
        scala: {all: [/response\.epoch\s*!=\s*epoch/, /epoch\s*=\s*epoch/]},
        cpp: {all: [/response\.epoch\(\)\s*!=\s*epoch/, /set_epoch\(epoch\)/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'At most three attempts, only the two retryable codes',
      detail:
        'Attempts are bounded by `MAX_ATTEMPTS = 3` and only `UNAVAILABLE` and `DEADLINE_EXCEEDED` are retried; there is no unbounded retry loop. The starter retries every error forever.',
      match: {
        python: {
          all: [/MAX_ATTEMPTS\s*=\s*3/, /range\(MAX_ATTEMPTS\)/, /RETRYABLE/],
          none: [/while\s+True/],
        },
        typescript: {
          all: [/MAX_ATTEMPTS\s*=\s*3/, /attempt\s*<\s*MAX_ATTEMPTS/, /RETRYABLE/],
          none: [/while\s*\(\s*true\s*\)/, /for\s*\(\s*;\s*;\s*\)/],
        },
        go: {
          all: [/maxAttempts\s*=\s*3/, /attempt\s*<\s*maxAttempts/, /retryable/],
          none: [/for\s*\{/],
        },
        scala: {
          all: [/MaxAttempts\s*=\s*3/, /attempt\s*<\s*MaxAttempts/, /Retryable/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [/kMaxAttempts\s*=\s*3/, /attempt\s*<\s*kMaxAttempts/, /Retryable\(/],
          none: [/while\s*\(\s*true\s*\)/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import grpc

import routing_pb2
import routing_pb2_grpc

channel = grpc.insecure_channel("engine:9000")
engine = routing_pb2_grpc.RoutingStub(channel)

last_known = {}


def compute_route(origin, destination, waypoints, epoch):
    # TODO: this starter has five flaws. The task says where to look; the checks say what must change.
    global last_known
    while True:
        try:
            response = engine.ComputeRoute(
                routing_pb2.RouteRequest(
                    origin=origin,
                    destination=destination,
                    waypoints=waypoints,
                    epoch=epoch,
                )
            )
            last_known[epoch] = response
            return response
        except Exception:
            pass
        if last_known:
            return next(iter(last_known.values()))
`,
      solution: `import math

import grpc

import routing_pb2
import routing_pb2_grpc

DEADLINE_S = 1.5
MAX_ATTEMPTS = 3
RETRYABLE = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED}

channel = grpc.insecure_channel("engine:9000")
engine = routing_pb2_grpc.RoutingStub(channel)


def straight_line(origin, destination):
    """Coarse equirectangular distance in metres: honest, not a road route."""
    mean_lat = math.radians((origin.lat + destination.lat) / 2)
    dx = (destination.lng - origin.lng) * math.cos(mean_lat) * 111_320
    dy = (destination.lat - origin.lat) * 110_540
    return math.hypot(dx, dy)


def compute_route(origin, destination, waypoints, epoch):
    for _ in range(MAX_ATTEMPTS):
        try:
            response = engine.ComputeRoute(
                routing_pb2.RouteRequest(
                    origin=origin,
                    destination=destination,
                    waypoints=waypoints,
                    epoch=epoch,
                ),
                timeout=DEADLINE_S,
            )
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE:
                raise
            continue
        if response.status == routing_pb2.RouteResponse.NO_ROUTE:
            return response  # terminal: no road exists, a retry cannot invent one
        if response.epoch != epoch:
            continue  # the engine answered a different traffic state
        return response
    return routing_pb2.RouteResponse(
        status=routing_pb2.RouteResponse.DEGRADED,
        distance_m=straight_line(origin, destination),
        epoch=epoch,
        degraded=True,
    )
`,
    },
    typescript: {
      starter: `/** Engine client. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

interface LatLng {
  lat: number;
  lng: number;
}

interface RouteResponse {
  status: number;
  distanceM: number;
  epoch: number;
  degraded: boolean;
}

interface RoutingClient {
  ComputeRoute(
    request: {origin: LatLng; destination: LatLng; waypoints: LatLng[]; epoch: number},
    callback: (error: grpc.ServiceError | null, response: RouteResponse) => void,
  ): grpc.ClientUnaryCall;
}

const {routing} = grpc.loadPackageDefinition(protoLoader.loadSync('routing.proto')) as unknown as {
  routing: {Routing: new (target: string, credentials: grpc.ChannelCredentials) => RoutingClient};
};
const engine = new routing.Routing('engine:9000', grpc.credentials.createInsecure());

const lastKnown = new Map<number, RouteResponse>();

export async function computeRoute(
  origin: LatLng,
  destination: LatLng,
  waypoints: LatLng[],
  epoch: number,
): Promise<RouteResponse> {
  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  for (;;) {
    try {
      const response = await new Promise<RouteResponse>((resolve, reject) => {
        engine.ComputeRoute({origin, destination, waypoints, epoch}, (error, reply) => {
          if (error) reject(error);
          else resolve(reply);
        });
      });
      lastKnown.set(epoch, response);
      return response;
    } catch {
      // serve whatever we already have
    }
    for (const cached of lastKnown.values()) return cached;
  }
}
`,
      solution: `/** Engine client: 1.5 s deadline, bounded attempts, honest degradation, epoch-pure. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const DEADLINE_MS = 1500;
const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set<number>([grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED]);

interface LatLng {
  lat: number;
  lng: number;
}

interface RouteResponse {
  status: number;
  distanceM: number;
  epoch: number;
  degraded: boolean;
}

interface RoutingClient {
  ComputeRoute(
    request: {origin: LatLng; destination: LatLng; waypoints: LatLng[]; epoch: number},
    metadata: grpc.Metadata,
    options: {deadline: number},
    callback: (error: grpc.ServiceError | null, response: RouteResponse) => void,
  ): grpc.ClientUnaryCall;
}

const {routing} = grpc.loadPackageDefinition(protoLoader.loadSync('routing.proto')) as unknown as {
  routing: {Routing: new (target: string, credentials: grpc.ChannelCredentials) => RoutingClient};
};
const engine = new routing.Routing('engine:9000', grpc.credentials.createInsecure());

function straightLine(origin: LatLng, destination: LatLng): number {
  const meanLat = ((origin.lat + destination.lat) / 2) * (Math.PI / 180);
  const dx = (destination.lng - origin.lng) * Math.cos(meanLat) * 111320;
  const dy = (destination.lat - origin.lat) * 110540;
  return Math.hypot(dx, dy);
}

export async function computeRoute(
  origin: LatLng,
  destination: LatLng,
  waypoints: LatLng[],
  epoch: number,
): Promise<RouteResponse> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const response = await new Promise<RouteResponse>((resolve, reject) => {
        engine.ComputeRoute(
          {origin: origin, destination: destination, waypoints: waypoints, epoch: epoch},
          new grpc.Metadata(),
          {deadline: Date.now() + DEADLINE_MS},
          (error, reply) => {
            if (error) reject(error);
            else resolve(reply);
          },
        );
      });
      if (response.status === NO_ROUTE) return response;
      if (response.epoch !== epoch) continue;
      return response;
    } catch (error) {
      const serviceError = error as grpc.ServiceError;
      if (RETRYABLE.has(serviceError.code)) continue;
      throw serviceError;
    }
  }
  return {
    status: DEGRADED,
    distanceM: straightLine(origin, destination),
    epoch: epoch,
    degraded: true,
  };
}
`,
    },
    go: {
      starter: `package main

import (
	"context"

	pb "router/routingpb"
)

var lastKnown = map[uint64]*pb.RouteResponse{}

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
func computeRoute(
	ctx context.Context,
	client pb.RoutingClient,
	origin, destination *pb.LatLng,
	waypoints []*pb.LatLng,
	epoch uint64,
) (*pb.RouteResponse, error) {
	for {
		resp, err := client.ComputeRoute(ctx, &pb.RouteRequest{
			Origin:      origin,
			Destination: destination,
			Waypoints:   waypoints,
			Epoch:       epoch,
		})
		if err == nil {
			lastKnown[epoch] = resp
			return resp, nil
		}
		for _, cached := range lastKnown {
			return cached, nil
		}
	}
}
`,
      solution: `package main

import (
	"context"
	"math"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "router/routingpb"
)

const (
	deadlineMS  = 1500
	maxAttempts = 3
)

var retryable = map[codes.Code]bool{codes.Unavailable: true, codes.DeadlineExceeded: true}

func straightLine(origin, destination *pb.LatLng) float64 {
	meanLat := (origin.Lat + destination.Lat) / 2 * math.Pi / 180
	dx := (destination.Lng - origin.Lng) * math.Cos(meanLat) * 111320
	dy := (destination.Lat - origin.Lat) * 110540
	return math.Hypot(dx, dy)
}

func computeRoute(
	ctx context.Context,
	client pb.RoutingClient,
	origin, destination *pb.LatLng,
	waypoints []*pb.LatLng,
	epoch uint64,
) (*pb.RouteResponse, error) {
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
		resp, err := client.ComputeRoute(callCtx, &pb.RouteRequest{
			Origin:      origin,
			Destination: destination,
			Waypoints:   waypoints,
			Epoch:       epoch,
		})
		cancel()
		if err != nil {
			if !retryable[status.Code(err)] {
				return nil, err
			}
			continue
		}
		if resp.Status == pb.RouteResponse_NO_ROUTE {
			return resp, nil // terminal: no road exists, a retry cannot invent one
		}
		if resp.Epoch != epoch {
			continue // the engine answered a different traffic state
		}
		return resp, nil
	}
	return &pb.RouteResponse{
		Status:    pb.RouteResponse_DEGRADED,
		DistanceM: straightLine(origin, destination),
		Epoch:     epoch,
		Degraded:  true,
	}, nil
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

object RouteClient {
  val stub = RoutingGrpc.blockingStub(ManagedChannelBuilder.forAddress("engine", 9000).usePlaintext().build())

  var lastKnown = Map.empty[Long, RouteResponse]

  // TODO: this starter has five flaws. The task says where to look; the checks say what must change.
  def computeRoute(origin: LatLng, destination: LatLng, waypoints: Seq[LatLng], epoch: Long): RouteResponse = {
    var done = false
    var answer: RouteResponse = null
    while (!done) {
      try {
        answer = stub.computeRoute(
          RouteRequest(origin = origin, destination = destination, waypoints = waypoints, epoch = epoch)
        )
        lastKnown += (epoch -> answer)
        done = true
      } catch {
        case _: StatusRuntimeException =>
          if (lastKnown.nonEmpty) {
            answer = lastKnown.head._2
            done = true
          }
      }
    }
    answer
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

object RouteClient {
  val DeadlineMs = 1500
  val MaxAttempts = 3
  val Retryable = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  val stub = RoutingGrpc.blockingStub(ManagedChannelBuilder.forAddress("engine", 9000).usePlaintext().build())

  def straightLine(origin: LatLng, destination: LatLng): Double = {
    val meanLat = (origin.lat + destination.lat) / 2 * math.Pi / 180
    val dx = (destination.lng - origin.lng) * math.cos(meanLat) * 111320
    val dy = (destination.lat - origin.lat) * 110540
    math.hypot(dx, dy)
  }

  def computeRoute(origin: LatLng, destination: LatLng, waypoints: Seq[LatLng], epoch: Long): RouteResponse = {
    var attempt = 0
    var stop = false
    var lastError: Option[StatusRuntimeException] = None
    while (attempt < MaxAttempts && !stop) {
      try {
        val response = stub
          .withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS)
          .computeRoute(
            RouteRequest(origin = origin, destination = destination, waypoints = waypoints, epoch = epoch)
          )
        if (response.status == RouteResponse.Status.NO_ROUTE) return response
        if (response.epoch != epoch) {
          attempt += 1
        } else {
          return response
        }
      } catch {
        case exc: StatusRuntimeException =>
          lastError = Some(exc)
          if (!Retryable.contains(exc.getStatus.getCode)) stop = true
          attempt += 1
      }
    }
    RouteResponse(
      status = RouteResponse.Status.DEGRADED,
      distanceM = straightLine(origin, destination),
      epoch = epoch,
      degraded = true,
    )
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include "routing.grpc.pb.h"

#include <map>
#include <vector>

namespace {

std::map<long, RouteResponse> last_known;

}  // namespace

// TODO: this starter has five flaws. The task says where to look; the checks say what must change.
RouteResponse ComputeRoute(
    Routing::Stub* stub,
    const LatLng& origin,
    const LatLng& destination,
    const std::vector<LatLng>& waypoints,
    long epoch) {
  while (true) {
    grpc::ClientContext ctx;
    RouteRequest request;
    *request.mutable_origin() = origin;
    *request.mutable_destination() = destination;
    for (const auto& waypoint : waypoints) *request.add_waypoints() = waypoint;
    request.set_epoch(epoch);
    RouteResponse response;
    const grpc::Status status = stub->ComputeRoute(&ctx, request, &response);
    if (status.ok()) {
      last_known[epoch] = response;
      return response;
    }
    if (!last_known.empty()) return last_known.begin()->second;
  }
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include "routing.grpc.pb.h"

#include <chrono>
#include <cmath>
#include <vector>

namespace {

constexpr int kDeadlineMs = 1500;
constexpr int kMaxAttempts = 3;

double StraightLine(const LatLng& origin, const LatLng& destination) {
  const double mean_lat = (origin.lat() + destination.lat()) / 2 * M_PI / 180;
  const double dx = (destination.lng() - origin.lng()) * std::cos(mean_lat) * 111320;
  const double dy = (destination.lat() - origin.lat()) * 110540;
  return std::hypot(dx, dy);
}

bool Retryable(const grpc::Status& status) {
  return status.error_code() == grpc::StatusCode::UNAVAILABLE ||
         status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
}

}  // namespace

RouteResponse ComputeRoute(
    Routing::Stub* stub,
    const LatLng& origin,
    const LatLng& destination,
    const std::vector<LatLng>& waypoints,
    long epoch) {
  grpc::Status last_status;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    RouteRequest request;
    *request.mutable_origin() = origin;
    *request.mutable_destination() = destination;
    for (const auto& waypoint : waypoints) *request.add_waypoints() = waypoint;
    request.set_epoch(epoch);
    RouteResponse response;
    const grpc::Status status = stub->ComputeRoute(&ctx, request, &response);
    if (!status.ok()) {
      last_status = status;
      if (!Retryable(status)) break;
      continue;
    }
    if (response.status() == RouteResponse::NO_ROUTE) return response;
    if (response.epoch() != epoch) continue;
    return response;
  }
  RouteResponse degraded;
  degraded.set_status(RouteResponse::DEGRADED);
  degraded.set_distance_m(StraightLine(origin, destination));
  degraded.set_epoch(epoch);
  degraded.set_degraded(true);
  return degraded;
}
`,
    },
  },
  debrief: `The fix has this shape because each piece bounds a different thing: the deadline bounds one attempt, the attempt count bounds the call, the retryable set decides which failures deserve another try, and \`NO_ROUTE\` is an answer rather than a failure. What the shape protects is the meaning of the response. A straight-line estimate marked \`degraded = true\` tells the caller exactly what it is; a cached road route from another epoch tells a story about traffic that is no longer true, and the \`epoch\` comparison is what keeps that story out of the response. The starter passed only because a healthy engine never enters any of these paths. Production clients add jittered backoff between attempts, a circuit breaker per engine endpoint, and a response field that separates "no road exists" from "we could not ask".`,
};
