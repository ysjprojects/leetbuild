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
func cell(lat, lng float64) string        { panic("not implemented") }
func haversineKm(a, b *pb.LatLng) float64 { panic("not implemented") }

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
func cell(lat, lng float64) string        { panic("not implemented") }
func haversineKm(a, b *pb.LatLng) float64 { panic("not implemented") }

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
  debrief: `Graceful degradation is a design decision made in advance: decide what a *worse but acceptable* answer looks like, and switch to it on exactly the failures that mean "slow or gone". The deadline bounds the cost of finding out, the flag keeps the degradation honest to the caller, and not caching the estimate keeps a 500 ms outage from becoming a 60 s one. Real clients propagate the caller's deadline instead of choosing their own, use hedged requests to a second routing replica, and feed the estimate/actual ratio back to tune the fallback speed per city and hour.`,
};
