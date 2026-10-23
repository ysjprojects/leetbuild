import type {Step} from '@/lib/types';

// ---- 6. ETA over gRPC: a deadline, a fallback, a cache -----------------------------------------
export const etaStep: Step = {
  id: 'eta',
  title: 'ETA with a deadline that degrades gracefully',
  concept: 'grpc',
  file: 'eta_client',
  focus: ['dispatcher', 'routing', 'redis'],
  task: `## Task

The rider's screen shows "driver arrives in 4 min". The number comes from a routing service:

\`\`\`proto
service Routing {
  rpc Eta(EtaRequest) returns (EtaReply);
}
message LatLng     { double lat = 1; double lng = 2; }
message EtaRequest { LatLng origin = 1; LatLng dest = 2; }
message EtaReply   { uint32 seconds = 1; }
\`\`\`

Implement \`eta_seconds(origin, dest)\`. \`cell(lat, lng)\` (a ~1 km grid id) and \`haversine_km(a, b)\`
(great-circle distance) are provided.

- Cache first: \`eta:{cell(origin)}:{cell(dest)}\` in Redis. A hit is the answer.
- Call \`Eta\` with a **500 ms deadline**. The ETA is decoration on the match, not the match itself: a
  rider would rather see a rough number now than an exact one in three seconds.
- On \`DEADLINE_EXCEEDED\` or \`UNAVAILABLE\`, **degrade**: \`haversine_km / 30 km/h\` as seconds, and mark
  the result \`estimated: true\` so the screen can show "~4 min". **No retry** on the request path — a
  second 500 ms would be spent on a service that just told you it is slow. Other statuses propagate.
- Cache a real answer for **60 s**; never cache an estimate.

:::widget deadline-retry {"base": 100, "deadline": 500, "attempts": 1}

> One attempt, one deadline, one fallback. Retries belong where a second try is likely to succeed
> (\`UNAVAILABLE\` on a background job); here the right move is to answer with less.

:::widget cache-aside {}`,
  sequence: {
    participants: ['dispatcher', 'Redis', 'Routing'],
    messages: [
      {from: 'dispatcher', to: 'Redis', label: 'GET eta:8f2a:8f31', kind: 'sync'},
      {from: 'Redis', to: 'dispatcher', label: '(nil)', kind: 'reply'},
      {from: 'dispatcher', to: 'Routing', label: 'Eta(origin, dest) · deadline 500 ms', kind: 'sync'},
      {from: 'Routing', to: 'dispatcher', label: 'EtaReply{seconds: 412}', kind: 'reply'},
      {from: 'dispatcher', to: 'Redis', label: 'SET eta:8f2a:8f31 412 EX 60', kind: 'sync'},
      {from: 'dispatcher', to: 'Routing', label: 'Eta(origin2, dest2) · deadline 500 ms', kind: 'sync'},
      {from: 'Routing', to: 'dispatcher', label: 'DEADLINE_EXCEEDED → haversine / 30 km/h, estimated', kind: 'reply'},
    ],
  },
  hints: [
    'Three outcomes, in order: cache hit → return; RPC ok → cache and return; RPC failed → look at the status code. There is no loop anywhere.',
    'The deadline is set on the call (a timeout argument, a context with timeout, a stub option, a ClientContext deadline), not with a timer around it.',
    'Two codes degrade (DEADLINE_EXCEEDED, UNAVAILABLE); everything else is re-raised. The estimate is `distance_km / 30 * 3600` seconds and is returned with the estimated flag set — and it is not written to the cache.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Sets a 500 ms deadline on the call',
      detail: 'Every `Eta` call carries a deadline so a slow routing service cannot hold the match open.',
      match: {
        python: {all: [/stub\.Eta\([^\n]*timeout\s*=/]},
        typescript: {all: [/stub\.Eta\([^\n]*deadline/]},
        go: {all: [/context\.WithTimeout\(/]},
        scala: {all: [/withDeadlineAfter\(/]},
        cpp: {all: [/set_deadline\(/]},
      },
    },
    {
      id: 'fallback',
      title: 'Falls back to a straight-line estimate on DEADLINE_EXCEEDED or UNAVAILABLE',
      detail:
        'Exactly those two statuses degrade to `haversine_km / 30 km/h`; a slow or absent routing service must not break the match.',
      match: {
        python: {all: [/StatusCode\.DEADLINE_EXCEEDED/, /StatusCode\.UNAVAILABLE/, /(?<!def )\bhaversine_km\(/]},
        typescript: {all: [/status\.DEADLINE_EXCEEDED/, /status\.UNAVAILABLE/, /\bhaversineKm\(/]},
        go: {all: [/codes\.DeadlineExceeded/, /codes\.Unavailable/, /(?<!func )\bhaversineKm\(/]},
        scala: {all: [/Code\.DEADLINE_EXCEEDED/, /Code\.UNAVAILABLE/, /(?<!def )\bhaversineKm\(/]},
        cpp: {all: [/StatusCode::DEADLINE_EXCEEDED/, /StatusCode::UNAVAILABLE/, /\bhaversine_km\(\s*(?!const\b)\w/]},
      },
    },
    {
      id: 'estimated-flag',
      title: 'Marks a fallback answer as estimated',
      detail: 'The estimate is returned with `estimated` set, so the screen can say "~4 min" instead of pretending.',
      match: {
        python: {all: [/estimated\s*=\s*True/]},
        typescript: {all: [/estimated:\s*true/]},
        go: {all: [/Estimated:\s*true/]},
        scala: {all: [/estimated\s*=\s*true|Eta\(\s*[^,\n]+,\s*true\s*\)/]},
        cpp: {all: [/Eta\{[^}\n]*,\s*true\s*\}|\.estimated\s*=\s*true/]},
      },
    },
    {
      id: 'no-retry',
      title: 'Calls Eta once: no retry loop on the request path',
      detail:
        'A single attempt: the fallback is the plan B, not another 500 ms spent on a service that is already slow.',
      match: {
        python: {all: [/stub\.Eta\(/], none: [/for \w+ in range\(/, /while True/]},
        typescript: {all: [/stub\.Eta\(/], none: [/\bfor\s*\(/, /\bwhile\s*\(/]},
        go: {all: [/stub\.Eta\(/], none: [/for \w+ := 0;/, /for \{/]},
        scala: {all: [/\.eta\(/], none: [/while\s*\(/, /for\s*\(/]},
        cpp: {all: [/stub->Eta\(/], none: [/for \(/, /while \(/]},
      },
    },
    {
      id: 'cache-60s',
      title: 'Reads eta:{cell}:{cell} first and caches real answers for 60 s',
      detail:
        'GET the cell-pair key before calling the service; after a successful call SET it with a 60 s TTL. Estimates are never cached.',
      match: {
        python: {
          all: [/["']eta:/, /(?<!def )\bcell\(/, /\.set\([^\n]*\bex\s*=\s*(?:ETA_TTL_S|60)\b|\.setex\(/],
          order: [/\br\.get\(/, /stub\.Eta\(/],
        },
        typescript: {
          all: [/`eta:|['"]eta:/, /\bcell\(/, /\.set\([^\n]*['"]EX['"]\s*,\s*(?:ETA_TTL_S|60)\b|\.setex\(/],
          order: [/\bredis\.get\(/, /stub\.Eta\(/],
        },
        go: {
          all: [
            /"eta:/,
            /(?<!func )\bcell\(/,
            /rdb\.Set(?:Ex)?\(\s*ctx\s*,[^\n]*\b(?:etaTTL|time\.Minute|60\s*\*\s*time\.Second)\b/,
          ],
          order: [/rdb\.Get\(/, /stub\.Eta\(/],
        },
        scala: {
          all: [
            /"eta:/,
            /(?<!def )\bcell\(/,
            /\.setex\([^\n]*\b(?:EtaTtlSeconds|60L?)\b|\.ex\(\s*(?:EtaTtlSeconds|60L?)\s*\)/,
          ],
          order: [/jedis\.get\(/, /\.eta\(/],
        },
        cpp: {
          all: [/"eta:/, /\bcell\(\s*(?!double\b)\w/, /redis\.set(?:ex)?\([^\n]*\bkEtaTtl\b/],
          order: [/redis\.get\(/, /stub->Eta\(/],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `from dataclasses import dataclass

import grpc
import redis

import routing_pb2
import routing_pb2_grpc
from geo import cell, haversine_km  # provided: cell(lat, lng) -> ~1 km grid id; haversine_km(a, b) -> great-circle distance

DEADLINE_S = 0.5
ETA_TTL_S = 60
FALLBACK_KMH = 30

r = redis.Redis(host="redis", port=6379, decode_responses=True)
channel = grpc.insecure_channel("routing:9000")
stub = routing_pb2_grpc.RoutingStub(channel)


@dataclass
class Eta:
    seconds: int
    estimated: bool  # the routing service did not answer in time; this is a straight-line guess


def eta_seconds(origin: routing_pb2.LatLng, dest: routing_pb2.LatLng) -> Eta:
    # TODO: key eta:{cell(origin)}:{cell(dest)}; GET → hit returns Eta(seconds, estimated=False)
    # TODO: stub.Eta(EtaRequest(origin, dest)) with a DEADLINE_S deadline; SET key EX ETA_TTL_S on success
    # TODO: DEADLINE_EXCEEDED / UNAVAILABLE → haversine_km / FALLBACK_KMH as seconds, estimated=True, not cached; other statuses propagate
    raise NotImplementedError
`,
      solution: `from dataclasses import dataclass

import grpc
import redis

import routing_pb2
import routing_pb2_grpc
from geo import cell, haversine_km  # provided: cell(lat, lng) -> ~1 km grid id; haversine_km(a, b) -> great-circle distance

DEADLINE_S = 0.5
ETA_TTL_S = 60
FALLBACK_KMH = 30

r = redis.Redis(host="redis", port=6379, decode_responses=True)
channel = grpc.insecure_channel("routing:9000")
stub = routing_pb2_grpc.RoutingStub(channel)


@dataclass
class Eta:
    seconds: int
    estimated: bool  # the routing service did not answer in time; this is a straight-line guess


def eta_seconds(origin: routing_pb2.LatLng, dest: routing_pb2.LatLng) -> Eta:
    key = f"eta:{cell(origin.lat, origin.lng)}:{cell(dest.lat, dest.lng)}"
    cached = r.get(key)
    if cached is not None:
        return Eta(seconds=int(cached), estimated=False)
    try:
        reply = stub.Eta(routing_pb2.EtaRequest(origin=origin, dest=dest), timeout=DEADLINE_S)
    except grpc.RpcError as e:
        if e.code() in (grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.UNAVAILABLE):
            seconds = int(haversine_km(origin, dest) / FALLBACK_KMH * 3600)
            return Eta(seconds=seconds, estimated=True)  # not cached: a guess must not outlive the outage
        raise
    r.set(key, reply.seconds, ex=ETA_TTL_S)
    return Eta(seconds=reply.seconds, estimated=False)
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {cell, haversineKm} from 'geo'; // provided: cell(lat, lng) -> ~1 km grid id; haversineKm(a, b) -> great-circle distance

export const DEADLINE_MS = 500;
export const ETA_TTL_S = 60;
export const FALLBACK_KMH = 30;

const redis = new Redis({host: 'redis', port: 6379});
const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('routing.proto')) as {
  dispatch: {Routing: grpc.ServiceClientConstructor};
};
const stub = new pkg.dispatch.Routing('routing:9000', grpc.credentials.createInsecure());

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Eta {
  seconds: number;
  /** The routing service did not answer in time; this is a straight-line guess. */
  estimated: boolean;
}

export async function etaSeconds(origin: LatLng, dest: LatLng): Promise<Eta> {
  // TODO: key eta:{cell(origin)}:{cell(dest)}; GET → hit returns {seconds, estimated: false}
  // TODO: stub.Eta({origin, dest}, {deadline: Date.now() + DEADLINE_MS}); SET key EX ETA_TTL_S on success
  // TODO: DEADLINE_EXCEEDED / UNAVAILABLE → haversineKm / FALLBACK_KMH as seconds, estimated, not cached; other statuses propagate
  throw new Error('not implemented');
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

import {cell, haversineKm} from 'geo'; // provided: cell(lat, lng) -> ~1 km grid id; haversineKm(a, b) -> great-circle distance

export const DEADLINE_MS = 500;
export const ETA_TTL_S = 60;
export const FALLBACK_KMH = 30;

const redis = new Redis({host: 'redis', port: 6379});
const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('routing.proto')) as {
  dispatch: {Routing: grpc.ServiceClientConstructor};
};
const stub = new pkg.dispatch.Routing('routing:9000', grpc.credentials.createInsecure());

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Eta {
  seconds: number;
  /** The routing service did not answer in time; this is a straight-line guess. */
  estimated: boolean;
}

export async function etaSeconds(origin: LatLng, dest: LatLng): Promise<Eta> {
  const key = \`eta:\${cell(origin.lat, origin.lng)}:\${cell(dest.lat, dest.lng)}\`;
  const cached = await redis.get(key);
  if (cached !== null) return {seconds: Number(cached), estimated: false};
  let reply: {seconds: number};
  try {
    reply = (await stub.Eta({origin, dest}, {deadline: Date.now() + DEADLINE_MS})) as {seconds: number};
  } catch (e) {
    const code = (e as grpc.ServiceError).code;
    if (code === grpc.status.DEADLINE_EXCEEDED || code === grpc.status.UNAVAILABLE) {
      const seconds = Math.floor((haversineKm(origin, dest) / FALLBACK_KMH) * 3600);
      return {seconds, estimated: true}; // not cached: a guess must not outlive the outage
    }
    throw e;
  }
  await redis.set(key, reply.seconds, 'EX', ETA_TTL_S);
  return {seconds: reply.seconds, estimated: false};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "dispatch/gen/routing"
)

const (
	deadline    = 500 * time.Millisecond
	etaTTL      = time.Minute
	fallbackKmh = 30.0
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
var conn, _ = grpc.NewClient("routing:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewRoutingClient(conn)

// Provided (geo.go): cell is a ~1 km grid id; haversineKm the great-circle distance.
var cell = func(lat, lng float64) string { panic("not implemented") }
var haversineKm = func(a, b *pb.LatLng) float64 { panic("not implemented") }

// Eta is the answer; Estimated is true when the routing service did not answer in time and this is a straight-line guess.
type Eta struct {
	Seconds   int
	Estimated bool
}

func etaSeconds(ctx context.Context, origin, dest *pb.LatLng) (Eta, error) {
	// TODO: key eta:{cell(origin)}:{cell(dest)}; Get → hit returns Eta{Seconds, false}
	// TODO: stub.Eta with a context that expires after \`deadline\`; Set key etaTTL on success
	// TODO: codes.DeadlineExceeded / codes.Unavailable → haversineKm / fallbackKmh as seconds, Estimated: true, not cached; other codes propagate
	_ = fmt.Sprintf
	_ = strconv.Atoi
	_ = codes.OK
	_ = status.Code
	return Eta{}, errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	pb "dispatch/gen/routing"
)

const (
	deadline    = 500 * time.Millisecond
	etaTTL      = time.Minute
	fallbackKmh = 30.0
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})
var conn, _ = grpc.NewClient("routing:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewRoutingClient(conn)

// Provided (geo.go): cell is a ~1 km grid id; haversineKm the great-circle distance.
var cell = func(lat, lng float64) string { panic("not implemented") }
var haversineKm = func(a, b *pb.LatLng) float64 { panic("not implemented") }

// Eta is the answer; Estimated is true when the routing service did not answer in time and this is a straight-line guess.
type Eta struct {
	Seconds   int
	Estimated bool
}

func etaSeconds(ctx context.Context, origin, dest *pb.LatLng) (Eta, error) {
	key := fmt.Sprintf("eta:%s:%s", cell(origin.GetLat(), origin.GetLng()), cell(dest.GetLat(), dest.GetLng()))
	cached, err := rdb.Get(ctx, key).Result()
	if err == nil {
		seconds, _ := strconv.Atoi(cached)
		return Eta{Seconds: seconds, Estimated: false}, nil
	}
	if !errors.Is(err, redis.Nil) {
		return Eta{}, err
	}
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	reply, err := stub.Eta(callCtx, &pb.EtaRequest{Origin: origin, Dest: dest})
	if err != nil {
		switch status.Code(err) {
		case codes.DeadlineExceeded, codes.Unavailable:
			seconds := int(haversineKm(origin, dest) / fallbackKmh * 3600)
			return Eta{Seconds: seconds, Estimated: true}, nil // not cached: a guess must not outlive the outage
		default:
			return Eta{}, err
		}
	}
	rdb.Set(ctx, key, int(reply.GetSeconds()), etaTTL)
	return Eta{Seconds: int(reply.GetSeconds()), Estimated: false}, nil
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import dispatch.Geo.{cell, haversineKm} // provided: cell(lat, lng): ~1 km grid id; haversineKm(a, b): great-circle distance
import dispatch.routing.{EtaRequest, LatLng, RoutingGrpc}
import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import redis.clients.jedis.JedisPooled

/** estimated is true when the routing service did not answer in time and this is a straight-line guess. */
final case class Eta(seconds: Int, estimated: Boolean)

object EtaClient {
  val DeadlineMillis = 500L
  val EtaTtlSeconds = 60L
  val FallbackKmh = 30.0

  val jedis = new JedisPooled("redis", 6379)
  private val channel = ManagedChannelBuilder.forAddress("routing", 9000).usePlaintext().build()
  private val stub = RoutingGrpc.blockingStub(channel)

  def etaSeconds(origin: LatLng, dest: LatLng): Eta = {
    // TODO: key eta:{cell(origin)}:{cell(dest)}; get → hit returns Eta(seconds, estimated = false)
    // TODO: stub.withDeadlineAfter(DeadlineMillis, MILLISECONDS).eta(EtaRequest(Some(origin), Some(dest))); setex key EtaTtlSeconds on success
    // TODO: DEADLINE_EXCEEDED / UNAVAILABLE → haversineKm / FallbackKmh as seconds, estimated = true, not cached; other statuses rethrow
    Eta(0, estimated = false)
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import dispatch.Geo.{cell, haversineKm} // provided: cell(lat, lng): ~1 km grid id; haversineKm(a, b): great-circle distance
import dispatch.routing.{EtaRequest, LatLng, RoutingGrpc}
import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import redis.clients.jedis.JedisPooled

/** estimated is true when the routing service did not answer in time and this is a straight-line guess. */
final case class Eta(seconds: Int, estimated: Boolean)

object EtaClient {
  val DeadlineMillis = 500L
  val EtaTtlSeconds = 60L
  val FallbackKmh = 30.0

  val jedis = new JedisPooled("redis", 6379)
  private val channel = ManagedChannelBuilder.forAddress("routing", 9000).usePlaintext().build()
  private val stub = RoutingGrpc.blockingStub(channel)

  def etaSeconds(origin: LatLng, dest: LatLng): Eta = {
    val key = s"eta:\${cell(origin.lat, origin.lng)}:\${cell(dest.lat, dest.lng)}"
    Option(jedis.get(key)) match {
      case Some(cached) => Eta(cached.toInt, estimated = false)
      case None =>
        try {
          val reply = stub.withDeadlineAfter(DeadlineMillis, TimeUnit.MILLISECONDS).eta(EtaRequest(origin = Some(origin), dest = Some(dest)))
          jedis.setex(key, EtaTtlSeconds, reply.seconds.toString)
          Eta(reply.seconds, estimated = false)
        } catch {
          case e: StatusRuntimeException =>
            e.getStatus.getCode match {
              case Status.Code.DEADLINE_EXCEEDED | Status.Code.UNAVAILABLE =>
                Eta((haversineKm(origin, dest) / FallbackKmh * 3600).toInt, estimated = true) // not cached
              case _ => throw e
            }
        }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "geo.h"  // std::string cell(double lat, double lng); double haversine_km(const dispatch::LatLng& a, const dispatch::LatLng& b)
#include "routing.grpc.pb.h"

using dispatch::LatLng;

constexpr std::chrono::milliseconds kDeadline{500};
constexpr std::chrono::seconds kEtaTtl{60};
constexpr double kFallbackKmh = 30.0;

sw::redis::Redis redis("tcp://redis:6379");
auto channel = grpc::CreateChannel("routing:9000", grpc::InsecureChannelCredentials());
auto stub = dispatch::Routing::NewStub(channel);

// estimated is true when the routing service did not answer in time and this is a straight-line guess.
struct Eta {
  int seconds;
  bool estimated;
};

Eta eta_seconds(const LatLng& origin, const LatLng& dest) {
  // TODO: key eta:{cell(origin)}:{cell(dest)}; GET → hit returns Eta{seconds, false}
  // TODO: stub->Eta with a ClientContext whose deadline is now + kDeadline; SET key EX kEtaTtl on success
  // TODO: DEADLINE_EXCEEDED / UNAVAILABLE → haversine_km / kFallbackKmh as seconds, Eta{…, true}, not cached; other statuses throw
  return Eta{0, false};
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <stdexcept>
#include <string>

#include "geo.h"  // std::string cell(double lat, double lng); double haversine_km(const dispatch::LatLng& a, const dispatch::LatLng& b)
#include "routing.grpc.pb.h"

using dispatch::LatLng;

constexpr std::chrono::milliseconds kDeadline{500};
constexpr std::chrono::seconds kEtaTtl{60};
constexpr double kFallbackKmh = 30.0;

sw::redis::Redis redis("tcp://redis:6379");
auto channel = grpc::CreateChannel("routing:9000", grpc::InsecureChannelCredentials());
auto stub = dispatch::Routing::NewStub(channel);

// estimated is true when the routing service did not answer in time and this is a straight-line guess.
struct Eta {
  int seconds;
  bool estimated;
};

Eta eta_seconds(const LatLng& origin, const LatLng& dest) {
  const std::string key = "eta:" + cell(origin.lat(), origin.lng()) + ":" + cell(dest.lat(), dest.lng());
  if (const auto cached = redis.get(key)) return Eta{std::stoi(*cached), false};
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  dispatch::EtaRequest request;
  *request.mutable_origin() = origin;
  *request.mutable_dest() = dest;
  dispatch::EtaReply reply;
  const grpc::Status status = stub->Eta(&ctx, request, &reply);
  if (status.ok()) {
    redis.set(key, std::to_string(reply.seconds()), kEtaTtl);
    return Eta{static_cast<int>(reply.seconds()), false};
  }
  if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED || status.error_code() == grpc::StatusCode::UNAVAILABLE)
    return Eta{static_cast<int>(haversine_km(origin, dest) / kFallbackKmh * 3600), true};  // not cached
  throw std::runtime_error("routing: " + status.error_message());
}
`,
    },
  },
  harness: {
    python: `import grpc

import geo
import routing_pb2
import routing_pb2_grpc


class FakeRouting(routing_pb2_grpc.RoutingServicer):
    def __init__(self):
        self.calls = 0

    def Eta(self, request, context):
        self.calls += 1
        return routing_pb2.EtaReply(seconds=412)


def _client(ctx):
    peer = FakeRouting()
    ctx.grpc.serve(routing_pb2_grpc.add_RoutingServicer_to_server, peer)
    return ctx.load("eta_client"), peer


def _pair(i=0):
    """Distinct origin/destination pairs (distinct cache cells) per i."""
    origin = routing_pb2.LatLng(lat=48.85 + i / 10, lng=2.35)
    dest = routing_pb2.LatLng(lat=48.86 + i / 10, lng=2.36)
    return origin, dest


def _fallback_seconds(origin, dest):
    return geo.haversine_km(origin, dest) / 30 * 3600


def _key(origin, dest):
    return f"eta:{geo.cell(origin.lat, origin.lng)}:{geo.cell(dest.lat, dest.lng)}"


def check_deadline(ctx):
    m, peer = _client(ctx)
    origin, dest = _pair()
    eta = m.eta_seconds(origin, dest)
    assert eta.seconds == 412 and not eta.estimated, f"a routing answer of 412 s must be returned as-is, got {eta}"
    calls = ctx.grpc.calls_to("Eta")
    assert calls, "no Eta RPC was made"
    assert calls[-1].timeout is not None, "the Eta call carries no deadline"
    assert 0.4 <= calls[-1].timeout <= 0.6, f"the deadline must be about 500 ms, got {calls[-1].timeout} s"
    assert calls[-1].request.origin.lat == origin.lat and calls[-1].request.dest.lng == dest.lng, "the request must carry origin and dest"


def check_fallback(ctx):
    m, peer = _client(ctx)
    origin, dest = _pair()
    ctx.grpc.set_latency("Eta", 3.0)
    eta = m.eta_seconds(origin, dest)
    expected = _fallback_seconds(origin, dest)
    assert eta.estimated, f"a routing service slower than the deadline must degrade to an estimate, got {eta}"
    assert abs(eta.seconds - expected) <= 2, f"the estimate must be haversine_km / 30 km/h in seconds (about {expected:.0f}), got {eta.seconds}"
    ctx.grpc.set_latency("Eta", 0.0)
    origin, dest = _pair(1)
    ctx.grpc.fail("Eta", grpc.StatusCode.UNAVAILABLE, "routing down")
    eta = m.eta_seconds(origin, dest)
    assert eta.estimated and abs(eta.seconds - _fallback_seconds(origin, dest)) <= 2, f"UNAVAILABLE must degrade to the straight-line estimate, got {eta}"
    origin, dest = _pair(2)
    ctx.grpc.fail("Eta", grpc.StatusCode.INVALID_ARGUMENT, "bad coordinates")
    try:
        eta = m.eta_seconds(origin, dest)
        raise AssertionError(f"INVALID_ARGUMENT must propagate, not be turned into an estimate: got {eta}")
    except grpc.RpcError as e:
        assert e.code() == grpc.StatusCode.INVALID_ARGUMENT, f"expected INVALID_ARGUMENT to propagate, got {e.code()}"


def check_estimated_flag(ctx):
    m, peer = _client(ctx)
    origin, dest = _pair()
    eta = m.eta_seconds(origin, dest)
    assert eta.estimated is False, f"a real routing answer must not be flagged as estimated: {eta}"
    origin, dest = _pair(1)
    ctx.grpc.set_latency("Eta", 3.0)
    eta = m.eta_seconds(origin, dest)
    assert eta.estimated is True, f"the straight-line fallback must be flagged estimated=True so the screen can say '~4 min': {eta}"


def check_no_retry(ctx):
    m, peer = _client(ctx)
    origin, dest = _pair()
    ctx.grpc.set_latency("Eta", 3.0)
    m.eta_seconds(origin, dest)
    assert len(ctx.grpc.calls_to("Eta")) == 1, f"a slow routing service was called {len(ctx.grpc.calls_to('Eta'))} times; one attempt, then the fallback"
    ctx.grpc.set_latency("Eta", 0.0)
    origin, dest = _pair(1)
    ctx.grpc.fail("Eta", grpc.StatusCode.UNAVAILABLE, "routing down", times=3)
    eta = m.eta_seconds(origin, dest)
    assert eta.estimated, "UNAVAILABLE must degrade, not raise"
    assert len(ctx.grpc.calls_to("Eta")) == 2, f"UNAVAILABLE was retried: {len(ctx.grpc.calls_to('Eta')) - 1} calls for the second request, expected exactly 1"


def check_cache_60s(ctx):
    m, peer = _client(ctx)
    origin, dest = _pair()
    key = _key(origin, dest)
    eta = m.eta_seconds(origin, dest)
    assert eta.seconds == 412
    assert ctx.redis.get(key) == "412", f"{key} is {ctx.redis.get(key)!r} after a real answer, expected 412 cached (keys: {ctx.redis.keys('eta:*')})"
    ttl = ctx.redis.ttl(key)
    assert 0 < ttl <= 60, f"{key} has TTL {ttl}, expected EX 60"
    near_origin = routing_pb2.LatLng(lat=origin.lat + 0.001, lng=origin.lng + 0.001)  # same ~1 km cell
    eta = m.eta_seconds(near_origin, dest)
    assert eta.seconds == 412 and not eta.estimated
    assert peer.calls == 1, f"a cached cell pair must not call Routing again (Routing saw {peer.calls} calls)"
    ctx.clock.advance(61)
    m.eta_seconds(origin, dest)
    assert peer.calls == 2, "after 60 s the cached answer has expired and Routing must be asked again"
    seeded_origin, seeded_dest = _pair(1)
    ctx.redis.set(_key(seeded_origin, seeded_dest), "99", ex=60)
    eta = m.eta_seconds(seeded_origin, seeded_dest)
    assert eta.seconds == 99 and not eta.estimated, f"a cached value must be returned without an RPC, got {eta}"
    assert peer.calls == 2, "the cache must be read before calling Routing"
    far_origin, far_dest = _pair(2)
    ctx.grpc.set_latency("Eta", 3.0)
    eta = m.eta_seconds(far_origin, far_dest)
    assert eta.estimated
    assert ctx.redis.get(_key(far_origin, far_dest)) is None, "an estimate must never be cached: a 500 ms outage would become a 60 s one"
`,
    typescript: `import {cell, haversineKm} from 'geo';

interface LatLng {
  lat: number;
  lng: number;
}

/** A fake Routing peer answering 412 s and counting its calls, then the learner's module. */
function client(ctx) {
  const pkg = ctx.proto('routing.proto');
  const peer = {calls: 0};
  ctx.grpc.serve(pkg.dispatch.Routing.service, {
    Eta: (call, callback) => {
      peer.calls += 1;
      callback(null, {seconds: 412});
    },
  });
  return {m: ctx.load('eta_client'), peer};
}

/** Distinct origin/destination pairs (distinct cache cells) per i. */
function pair(i = 0): [LatLng, LatLng] {
  return [
    {lat: 48.85 + i / 10, lng: 2.35},
    {lat: 48.86 + i / 10, lng: 2.36},
  ];
}

const fallbackSeconds = (origin: LatLng, dest: LatLng): number => (haversineKm(origin, dest) / 30) * 3600;

const key = (origin: LatLng, dest: LatLng): string => \`eta:\${cell(origin.lat, origin.lng)}:\${cell(dest.lat, dest.lng)}\`;

export async function check_deadline(ctx) {
  const {m} = client(ctx);
  const [origin, dest] = pair();
  const eta = await m.etaSeconds(origin, dest);
  assert(eta.seconds === 412 && !eta.estimated, \`a routing answer of 412 s must be returned as-is, got \${JSON.stringify(eta)}\`);
  const calls = ctx.grpc.callsTo('Eta');
  assert(calls.length > 0, 'no Eta RPC was made');
  const last = calls[calls.length - 1];
  assert(last.timeout !== null, 'the Eta call carries no deadline');
  assert(0.4 <= last.timeout && last.timeout <= 0.6, \`the deadline must be about 500 ms, got \${last.timeout} s\`);
  assert(last.request.origin.lat === origin.lat && last.request.dest.lng === dest.lng, 'the request must carry origin and dest');
}

export async function check_fallback(ctx) {
  const {m} = client(ctx);
  let [origin, dest] = pair();
  ctx.grpc.setLatency('Eta', 3.0);
  let eta = await m.etaSeconds(origin, dest);
  const expected = fallbackSeconds(origin, dest);
  assert(eta.estimated, \`a routing service slower than the deadline must degrade to an estimate, got \${JSON.stringify(eta)}\`);
  assert(Math.abs(eta.seconds - expected) <= 2, \`the estimate must be haversineKm / 30 km/h in seconds (about \${expected.toFixed(0)}), got \${eta.seconds}\`);
  ctx.grpc.setLatency('Eta', 0.0);
  [origin, dest] = pair(1);
  ctx.grpc.fail('Eta', ctx.grpc.status.UNAVAILABLE, 'routing down');
  eta = await m.etaSeconds(origin, dest);
  assert(eta.estimated && Math.abs(eta.seconds - fallbackSeconds(origin, dest)) <= 2, \`UNAVAILABLE must degrade to the straight-line estimate, got \${JSON.stringify(eta)}\`);
  [origin, dest] = pair(2);
  ctx.grpc.fail('Eta', ctx.grpc.status.INVALID_ARGUMENT, 'bad coordinates');
  let outcome: {eta: unknown} | {code: number};
  try {
    outcome = {eta: await m.etaSeconds(origin, dest)};
  } catch (e) {
    outcome = {code: (e as {code: number}).code};
  }
  assert('code' in outcome, \`INVALID_ARGUMENT must propagate, not be turned into an estimate: got \${JSON.stringify(outcome)}\`);
  assert.equal(outcome.code, ctx.grpc.status.INVALID_ARGUMENT, \`expected INVALID_ARGUMENT to propagate, got status \${outcome.code}\`);
}

export async function check_estimated_flag(ctx) {
  const {m} = client(ctx);
  let [origin, dest] = pair();
  let eta = await m.etaSeconds(origin, dest);
  assert.equal(eta.estimated, false, \`a real routing answer must not be flagged as estimated: \${JSON.stringify(eta)}\`);
  [origin, dest] = pair(1);
  ctx.grpc.setLatency('Eta', 3.0);
  eta = await m.etaSeconds(origin, dest);
  assert.equal(eta.estimated, true, \`the straight-line fallback must be flagged estimated: true so the screen can say '~4 min': \${JSON.stringify(eta)}\`);
}

export async function check_no_retry(ctx) {
  const {m} = client(ctx);
  let [origin, dest] = pair();
  ctx.grpc.setLatency('Eta', 3.0);
  await m.etaSeconds(origin, dest);
  assert.equal(ctx.grpc.callsTo('Eta').length, 1, \`a slow routing service was called \${ctx.grpc.callsTo('Eta').length} times; one attempt, then the fallback\`);
  ctx.grpc.setLatency('Eta', 0.0);
  [origin, dest] = pair(1);
  ctx.grpc.fail('Eta', ctx.grpc.status.UNAVAILABLE, 'routing down', 3);
  const eta = await m.etaSeconds(origin, dest);
  assert(eta.estimated, 'UNAVAILABLE must degrade, not throw');
  assert.equal(ctx.grpc.callsTo('Eta').length, 2, \`UNAVAILABLE was retried: \${ctx.grpc.callsTo('Eta').length - 1} calls for the second request, expected exactly 1\`);
}

export async function check_cache_60s(ctx) {
  const {m, peer} = client(ctx);
  const [origin, dest] = pair();
  const k = key(origin, dest);
  let eta = await m.etaSeconds(origin, dest);
  assert.equal(eta.seconds, 412);
  assert.equal(ctx.redis.get(k), '412', \`\${k} is \${JSON.stringify(ctx.redis.get(k))} after a real answer, expected 412 cached (keys: \${JSON.stringify(ctx.redis.keys('eta:*'))})\`);
  const ttl = ctx.redis.ttl(k);
  assert(0 < ttl && ttl <= 60, \`\${k} has TTL \${ttl}, expected EX 60\`);
  const nearOrigin = {lat: origin.lat + 0.001, lng: origin.lng + 0.001}; // same ~1 km cell
  eta = await m.etaSeconds(nearOrigin, dest);
  assert(eta.seconds === 412 && !eta.estimated, \`a nearby origin in the same cell must be served from the cache, got \${JSON.stringify(eta)}\`);
  assert.equal(peer.calls, 1, \`a cached cell pair must not call Routing again (Routing saw \${peer.calls} calls)\`);
  ctx.clock.advance(61);
  await m.etaSeconds(origin, dest);
  assert.equal(peer.calls, 2, 'after 60 s the cached answer has expired and Routing must be asked again');
  const [seededOrigin, seededDest] = pair(1);
  ctx.redis.set(key(seededOrigin, seededDest), '99', 'EX', 60);
  eta = await m.etaSeconds(seededOrigin, seededDest);
  assert(eta.seconds === 99 && !eta.estimated, \`a cached value must be returned without an RPC, got \${JSON.stringify(eta)}\`);
  assert.equal(peer.calls, 2, 'the cache must be read before calling Routing');
  const [farOrigin, farDest] = pair(2);
  ctx.grpc.setLatency('Eta', 3.0);
  eta = await m.etaSeconds(farOrigin, farDest);
  assert(eta.estimated, \`a routing service slower than the deadline must degrade to an estimate, got \${JSON.stringify(eta)}\`);
  assert.equal(ctx.redis.get(key(farOrigin, farDest)), null, 'an estimate must never be cached: a 500 ms outage would become a 60 s one');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"math"
	"sync"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"leetbuild/harness"

	pb "dispatch/gen/routing"
)

// geoCell is the provided geo.go's cell: both coordinates floored to 0.01 degrees, as 8 hex digits.
func geoCell(lat, lng float64) string {
	row := int64(math.Floor(lat/0.01)) & 0xffff
	col := int64(math.Floor(lng/0.01)) & 0xffff
	return fmt.Sprintf("%04x%04x", row, col)
}

// geoHaversineKm is the provided geo.go's great-circle distance in km.
func geoHaversineKm(a, b *pb.LatLng) float64 {
	rad := math.Pi / 180
	lat1, lat2 := a.GetLat()*rad, b.GetLat()*rad
	dLat := lat2 - lat1
	dLng := b.GetLng()*rad - a.GetLng()*rad
	h := math.Pow(math.Sin(dLat/2), 2) + math.Cos(lat1)*math.Cos(lat2)*math.Pow(math.Sin(dLng/2), 2)
	return 2 * 6371.0088 * math.Asin(math.Sqrt(h))
}

// routingPeer is a fake Routing service answering 412 s and counting its calls.
type routingPeer struct {
	pb.UnimplementedRoutingServer
	mu    sync.Mutex
	calls int
}

func (p *routingPeer) Eta(context.Context, *pb.EtaRequest) (*pb.EtaReply, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	return &pb.EtaReply{Seconds: 412}, nil
}

func (p *routingPeer) seen() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.calls
}

// etaWorld serves the fake Routing peer and installs the provided geo helpers.
func etaWorld(ctx *harness.Ctx) *routingPeer {
	cell, haversineKm = geoCell, geoHaversineKm
	peer := &routingPeer{}
	pb.RegisterRoutingServer(ctx.GRPC.Server(""), peer)
	return peer
}

// etaPair is a distinct origin/destination pair (distinct cache cells) per i.
func etaPair(i int) (*pb.LatLng, *pb.LatLng) {
	return &pb.LatLng{Lat: 48.85 + float64(i)/10, Lng: 2.35}, &pb.LatLng{Lat: 48.86 + float64(i)/10, Lng: 2.36}
}

func etaKey(origin, dest *pb.LatLng) string {
	return "eta:" + geoCell(origin.GetLat(), origin.GetLng()) + ":" + geoCell(dest.GetLat(), dest.GetLng())
}

func fallbackSeconds(origin, dest *pb.LatLng) float64 { return geoHaversineKm(origin, dest) / 30 * 3600 }

func etaOK(ctx *harness.Ctx, origin, dest *pb.LatLng) Eta {
	eta, err := etaSeconds(context.Background(), origin, dest)
	ctx.NoError(err, "etaSeconds returned an error")
	return eta
}

func CheckDeadline(ctx *harness.Ctx) {
	etaWorld(ctx)
	origin, dest := etaPair(0)
	eta := etaOK(ctx, origin, dest)
	ctx.Assert(eta.Seconds == 412 && !eta.Estimated, "a routing answer of 412 s must be returned as-is, got %+v", eta)
	calls := ctx.GRPC.CallsTo("Eta", "")
	ctx.Assert(len(calls) > 0, "no Eta RPC was made")
	last := calls[len(calls)-1]
	ctx.Assert(last.HasDeadline(), "the Eta call carries no deadline")
	timeout := last.Timeout.Seconds()
	ctx.Assert(0.4 <= timeout && timeout <= 0.6, "the deadline must be about 500 ms, got %v s", timeout)
	req, _ := last.Request.(*pb.EtaRequest)
	ctx.Assert(req != nil && req.GetOrigin().GetLat() == origin.GetLat() && req.GetDest().GetLng() == dest.GetLng(), "the request must carry origin and dest, got %v", last.Request)
}

func CheckFallback(ctx *harness.Ctx) {
	etaWorld(ctx)
	origin, dest := etaPair(0)
	ctx.GRPC.SetLatency("Eta", 3.0, "")
	eta := etaOK(ctx, origin, dest)
	expected := fallbackSeconds(origin, dest)
	ctx.Assert(eta.Estimated, "a routing service slower than the deadline must degrade to an estimate, got %+v", eta)
	ctx.Assert(math.Abs(float64(eta.Seconds)-expected) <= 2, "the estimate must be haversineKm / 30 km/h in seconds (about %.0f), got %d", expected, eta.Seconds)
	ctx.GRPC.SetLatency("Eta", 0.0, "")
	origin, dest = etaPair(1)
	ctx.GRPC.Fail("Eta", codes.Unavailable, "routing down", 1, "")
	eta = etaOK(ctx, origin, dest)
	ctx.Assert(eta.Estimated && math.Abs(float64(eta.Seconds)-fallbackSeconds(origin, dest)) <= 2, "UNAVAILABLE must degrade to the straight-line estimate, got %+v", eta)
	origin, dest = etaPair(2)
	ctx.GRPC.Fail("Eta", codes.InvalidArgument, "bad coordinates", 1, "")
	eta, err := etaSeconds(context.Background(), origin, dest)
	ctx.Assert(err != nil, "INVALID_ARGUMENT must propagate, not be turned into an estimate: got %+v", eta)
	ctx.Equal(status.Code(err), codes.InvalidArgument, "the status that must propagate")
}

func CheckEstimatedFlag(ctx *harness.Ctx) {
	etaWorld(ctx)
	origin, dest := etaPair(0)
	eta := etaOK(ctx, origin, dest)
	ctx.Equal(eta.Estimated, false, "a real routing answer must not be flagged as estimated (%+v)", eta)
	origin, dest = etaPair(1)
	ctx.GRPC.SetLatency("Eta", 3.0, "")
	eta = etaOK(ctx, origin, dest)
	ctx.Equal(eta.Estimated, true, "the straight-line fallback must be flagged Estimated: true so the screen can say '~4 min' (%+v)", eta)
}

func CheckNoRetry(ctx *harness.Ctx) {
	etaWorld(ctx)
	origin, dest := etaPair(0)
	ctx.GRPC.SetLatency("Eta", 3.0, "")
	etaOK(ctx, origin, dest)
	ctx.Equal(len(ctx.GRPC.CallsTo("Eta", "")), 1, "calls to a slow routing service: one attempt, then the fallback")
	ctx.GRPC.SetLatency("Eta", 0.0, "")
	origin, dest = etaPair(1)
	ctx.GRPC.Fail("Eta", codes.Unavailable, "routing down", 3, "")
	eta := etaOK(ctx, origin, dest)
	ctx.Assert(eta.Estimated, "UNAVAILABLE must degrade, not fail")
	ctx.Equal(len(ctx.GRPC.CallsTo("Eta", "")), 2, "calls after the second request: UNAVAILABLE must not be retried")
}

func CheckCache60s(ctx *harness.Ctx) {
	peer := etaWorld(ctx)
	origin, dest := etaPair(0)
	k := etaKey(origin, dest)
	eta := etaOK(ctx, origin, dest)
	ctx.Equal(eta.Seconds, 412, "the routing answer")
	cached, _ := ctx.Redis.Get(k)
	ctx.Equal(cached, "412", "%s after a real answer (keys: %v)", k, ctx.Redis.Keys("eta:*"))
	ttl := ctx.Redis.TTL(k)
	ctx.Assert(0 < ttl && ttl <= 60, "%s has TTL %d, expected etaTTL (60 s)", k, ttl)
	nearOrigin := &pb.LatLng{Lat: origin.GetLat() + 0.001, Lng: origin.GetLng() + 0.001} // same ~1 km cell
	eta = etaOK(ctx, nearOrigin, dest)
	ctx.Assert(eta.Seconds == 412 && !eta.Estimated, "a nearby origin in the same cell must be served from the cache, got %+v", eta)
	ctx.Equal(peer.seen(), 1, "a cached cell pair must not call Routing again: calls Routing saw")
	ctx.Clock.Advance(61)
	etaOK(ctx, origin, dest)
	ctx.Equal(peer.seen(), 2, "after 60 s the cached answer has expired and Routing must be asked again: calls Routing saw")
	seededOrigin, seededDest := etaPair(1)
	ctx.Redis.Set(etaKey(seededOrigin, seededDest), "99", "EX", 60)
	eta = etaOK(ctx, seededOrigin, seededDest)
	ctx.Assert(eta.Seconds == 99 && !eta.Estimated, "a cached value must be returned without an RPC, got %+v", eta)
	ctx.Equal(peer.seen(), 2, "the cache must be read before calling Routing: calls Routing saw")
	farOrigin, farDest := etaPair(2)
	ctx.GRPC.SetLatency("Eta", 3.0, "")
	eta = etaOK(ctx, farOrigin, farDest)
	ctx.Assert(eta.Estimated, "a routing service slower than the deadline must degrade to an estimate, got %+v", eta)
	_, cachedEstimate := ctx.Redis.Get(etaKey(farOrigin, farDest))
	ctx.Assert(!cachedEstimate, "an estimate must never be cached: a 500 ms outage would become a 60 s one")
}
`,
  },
  debrief: `Graceful degradation is a design decision made in advance: decide what a *worse but acceptable* answer looks like, and switch to it on exactly the failures that mean "slow or gone". The deadline bounds the cost of finding out, the flag keeps the degradation honest to the caller, and not caching the estimate keeps a 500 ms outage from becoming a 60 s one. Real clients propagate the caller's deadline instead of choosing their own, use hedged requests to a second routing replica, and feed the estimate/actual ratio back to tune the fallback speed per city and hour.`,
};
