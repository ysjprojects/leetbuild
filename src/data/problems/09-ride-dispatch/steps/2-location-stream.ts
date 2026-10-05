import type {Step} from '@/lib/types';

// ---- 2. Client-streaming driver positions into Redis GEO --------------------------------------
export const locationStreamStep: Step = {
  id: 'location-stream',
  title: 'Stream driver positions into a GEO set',
  concept: 'grpc',
  file: 'location_service',
  focus: ['driver', 'location', 'redis'],
  task: `## Task

Every driver app keeps one **client stream** open and pushes a position every few seconds:

\`\`\`proto
service Locations {
  rpc UpdateLocations(stream LocationUpdate) returns (Ack);
}
message LocationUpdate { string driver_id = 1; string city = 2; double lat = 3; double lng = 4; int64 ts = 5; }
message Ack            { uint32 count = 1; }
\`\`\`

Implement \`UpdateLocations\` on the servicer skeleton:

- For every update, \`GEOADD drivers:{city} lng lat driver_id\` — Redis takes **longitude first**, the
  opposite of how people say it — and \`SET driver:{id}:seen <ts> EX 30\`. A driver whose app stops
  sending drops out of search after 30 s without anyone deleting anything.
- Send both writes in **one pipeline** per update (or batch a handful of updates per pipeline): one
  round trip, not two, for the hottest write path in the system.
- When the client **finishes** its side, answer \`Ack{count}\` with the number of updates applied. When
  the client **cancels** or the connection drops, stop — log what you applied, send nothing.

:::widget grpc-streams {"mode": "client"}

> The GEO set never shrinks on its own: a member stays at its last position forever. That is why
> presence lives in a separate key with a TTL, and why the next step checks it before trusting a hit.`,
  sequence: {
    participants: ['Driver app', 'location-svc', 'Redis'],
    messages: [
      {from: 'Driver app', to: 'location-svc', label: 'UpdateLocations (open stream)', kind: 'sync'},
      {from: 'Driver app', to: 'location-svc', label: 'LocationUpdate{d-7, paris, 48.85, 2.35, ts}', kind: 'async'},
      {
        from: 'location-svc',
        to: 'Redis',
        label: 'GEOADD drivers:paris 2.35 48.85 d-7 · SET driver:d-7:seen ts EX 30',
        kind: 'sync',
      },
      {from: 'Redis', to: 'location-svc', label: 'OK · OK (one pipeline)', kind: 'reply'},
      {from: 'Driver app', to: 'location-svc', label: 'LocationUpdate … × N', kind: 'async'},
      {from: 'Driver app', to: 'location-svc', label: 'half-close', kind: 'async'},
      {from: 'location-svc', to: 'Driver app', label: 'Ack{count: N + 1}', kind: 'reply'},
    ],
  },
  hints: [
    'A client stream is a loop over the incoming messages with one response at the very end; the loop body is where the two Redis writes go.',
    'GEOADD takes (longitude, latitude, member) — pass `lng` before `lat`. The GEO key is per city; the presence key is per driver and carries the TTL.',
    'The end of the loop has two causes: the client finished (send the Ack) or the client went away (an error from Recv / a cancelled context / onError / IsCancelled). Only the first one gets a reply.',
  ],
  checks: [
    {
      id: 'geoadd-lng-lat',
      title: 'GEOADDs drivers:{city} with longitude before latitude',
      detail:
        'Each update is written to the per-city GEO set as `GEOADD drivers:{city} lng lat driver_id` — longitude first, as Redis expects.',
      match: {
        python: {all: [/["']drivers:/, /\.geoadd\([^\n]*\blng\b[^\n]*\blat\b/]},
        go: {
          all: [
            /"drivers:/,
            /\.GeoAdd\(/,
            /Longitude:\s*\w+\.(?:GetLng\(\)|Lng\b)/,
            /Latitude:\s*\w+\.(?:GetLat\(\)|Lat\b)/,
          ],
        },
        scala: {all: [/"drivers:/, /\.geoadd\([^\n]*\blng\b[^\n]*\blat\b/]},
        cpp: {all: [/"drivers:/, /\.geoadd\([^\n]*\blng\(\)[^\n]*\blat\(\)/]},
      },
    },
    {
      id: 'presence-ttl',
      title: 'Refreshes driver:{id}:seen with a 30 s expiry',
      detail:
        'Every update `SET`s `driver:{id}:seen` with `EX 30`: a silent driver expires out of the search without a delete.',
      match: {
        python: {all: [/:seen/, /\.set\([^\n]*\bex\s*=\s*(?:SEEN_TTL_S|30)\b|\.setex\([^\n]*\b(?:SEEN_TTL_S|30)\b/]},
        go: {all: [/:seen/, /\.Set(?:Ex)?\(\s*ctx\s*,[^\n]*\b(?:seenTTL|30\s*\*\s*time\.Second)\b/]},
        scala: {all: [/:seen/, /\.setex\([^\n]*\b(?:SeenTtlSeconds|30L?)\b|\.ex\(\s*(?:SeenTtlSeconds|30L?)\s*\)/]},
        cpp: {all: [/:seen/, /\.set(?:ex)?\([^\n]*\bkSeenTtl\b/]},
      },
    },
    {
      id: 'pipelined',
      title: 'Sends both writes in one pipeline',
      detail:
        'The GEOADD and the SET travel together — a pipeline executed once per update (or per small batch) — instead of two round trips per position.',
      match: {
        python: {all: [/\.pipeline\(/, /\.execute\(\)/]},
        go: {all: [/\.(?:Tx)?Pipeline\(\)|\.Pipelined\(/, /\.Exec\(\s*ctx\s*\)|\.Pipelined\(/]},
        scala: {all: [/\.pipelined\(\)/, /\.sync\(\)/]},
        cpp: {all: [/redis\.pipeline\(/, /\.exec\(\)/]},
      },
    },
    {
      id: 'ack-count',
      title: 'Acknowledges with the number of updates applied',
      detail:
        'When the client half-closes, the single response is `Ack{count}` — the client can compare it with what it sent.',
      match: {
        python: {all: [/Ack\(\s*count\s*=/]},
        go: {all: [/SendAndClose\(\s*&pb\.Ack\{\s*Count:/]},
        scala: {all: [/onNext\(\s*Ack\(/]},
        cpp: {all: [/ack->set_count\(/]},
      },
    },
    {
      id: 'cancel',
      title: 'Stops when the client cancels or disconnects',
      detail:
        'A cancelled stream ends the loop without an Ack: catch the cancellation (`CancelledError`, a non-EOF `Recv` error, `onError` with `CANCELLED`, `IsCancelled()`), log the count and return.',
      match: {
        python: {all: [/CancelledError|context\.cancelled\(\)|add_done_callback\(/]},
        go: {all: [/io\.EOF/, /return err\b/]},
        scala: {all: [/Status\.fromThrowable\(|Code\.CANCELLED/]},
        cpp: {all: [/IsCancelled\(\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio
import logging

import grpc
import redis.asyncio as redis

import locations_pb2
import locations_pb2_grpc

log = logging.getLogger("locations")
r = redis.Redis(host="redis", port=6379)

SEEN_TTL_S = 30


class LocationService(locations_pb2_grpc.LocationsServicer):
    async def UpdateLocations(self, request_iterator, context: grpc.aio.ServicerContext) -> locations_pb2.Ack:
        count = 0
        # TODO: for every update, one pipeline: GEOADD drivers:{city} (lng, lat, driver_id) and SET driver:{id}:seen ts EX SEEN_TTL_S
        # TODO: the client cancelling raises CancelledError inside the loop: log the count and re-raise
        # TODO: return Ack(count=...) when the client finishes its side
        await context.abort(grpc.StatusCode.UNIMPLEMENTED, "not implemented")


async def serve() -> None:
    server = grpc.aio.server()
    locations_pb2_grpc.add_LocationsServicer_to_server(LocationService(), server)
    server.add_insecure_port("[::]:9000")
    await server.start()
    await server.wait_for_termination()


asyncio.run(serve())
`,
      solution: `import asyncio
import logging

import grpc
import redis.asyncio as redis

import locations_pb2
import locations_pb2_grpc

log = logging.getLogger("locations")
r = redis.Redis(host="redis", port=6379)

SEEN_TTL_S = 30


class LocationService(locations_pb2_grpc.LocationsServicer):
    async def UpdateLocations(self, request_iterator, context: grpc.aio.ServicerContext) -> locations_pb2.Ack:
        count = 0
        try:
            async for u in request_iterator:
                pipe = r.pipeline(transaction=False)
                pipe.geoadd(f"drivers:{u.city}", (u.lng, u.lat, u.driver_id))  # longitude first
                pipe.set(f"driver:{u.driver_id}:seen", u.ts, ex=SEEN_TTL_S)
                await pipe.execute()
                count += 1
        except asyncio.CancelledError:
            log.info("client cancelled after %d updates", count)
            raise
        return locations_pb2.Ack(count=count)


async def serve() -> None:
    server = grpc.aio.server()
    locations_pb2_grpc.add_LocationsServicer_to_server(LocationService(), server)
    server.add_insecure_port("[::]:9000")
    await server.start()
    await server.wait_for_termination()


asyncio.run(serve())
`,
    },
    go: {
      starter: `package main

import (
	"io"
	"log"
	"net"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "dispatch/gen/locations"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const seenTTL = 30 * time.Second

type locationServer struct {
	pb.UnimplementedLocationsServer
}

// UpdateLocations is a client stream: the driver app sends a position every few seconds and gets one Ack at the end.
func (s *locationServer) UpdateLocations(stream pb.Locations_UpdateLocationsServer) error {
	ctx := stream.Context()
	var count uint32
	// TODO: Recv in a loop; io.EOF → SendAndClose(&pb.Ack{Count: count}); any other error (the client cancelled) → log and return it
	// TODO: per update, one pipeline: GeoAdd drivers:{city} {Name: driver_id, Longitude: lng, Latitude: lat} and Set driver:{id}:seen ts seenTTL
	_ = ctx
	_ = count
	_ = io.EOF
	return status.Error(codes.Unimplemented, "not implemented")
}

func main() {
	lis, _ := net.Listen("tcp", ":9000")
	srv := grpc.NewServer()
	pb.RegisterLocationsServer(srv, &locationServer{})
	log.Fatal(srv.Serve(lis))
}
`,
      solution: `package main

import (
	"io"
	"log"
	"net"
	"time"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"

	pb "dispatch/gen/locations"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

const seenTTL = 30 * time.Second

type locationServer struct {
	pb.UnimplementedLocationsServer
}

// UpdateLocations is a client stream: the driver app sends a position every few seconds and gets one Ack at the end.
func (s *locationServer) UpdateLocations(stream pb.Locations_UpdateLocationsServer) error {
	ctx := stream.Context()
	var count uint32
	for {
		u, err := stream.Recv()
		if err == io.EOF {
			return stream.SendAndClose(&pb.Ack{Count: count}) // the client finished its side
		}
		if err != nil {
			log.Printf("client went away after %d updates: %v", count, err) // cancelled or connection dropped
			return err
		}
		pipe := rdb.Pipeline()
		pipe.GeoAdd(ctx, "drivers:"+u.GetCity(), &redis.GeoLocation{Name: u.GetDriverId(), Longitude: u.GetLng(), Latitude: u.GetLat()})
		pipe.Set(ctx, "driver:"+u.GetDriverId()+":seen", u.GetTs(), seenTTL)
		if _, err := pipe.Exec(ctx); err != nil {
			return err
		}
		count++
	}
}

func main() {
	lis, _ := net.Listen("tcp", ":9000")
	srv := grpc.NewServer()
	pb.RegisterLocationsServer(srv, &locationServer{})
	log.Fatal(srv.Serve(lis))
}
`,
    },
    scala: {
      starter: `import dispatch.locations.{Ack, LocationUpdate, LocationsGrpc}
import io.grpc.{ServerBuilder, Status}
import io.grpc.stub.StreamObserver
import redis.clients.jedis.JedisPooled
import scala.concurrent.ExecutionContext

object LocationService extends LocationsGrpc.Locations {
  val jedis = new JedisPooled("redis", 6379)
  val SeenTtlSeconds = 30L

  /** A client stream: the driver app sends a position every few seconds and gets one Ack at the end. */
  override def updateLocations(responseObserver: StreamObserver[Ack]): StreamObserver[LocationUpdate] =
    new StreamObserver[LocationUpdate] {
      private var count = 0
      // TODO: onNext: one pipeline per update — geoadd(s"drivers:\${u.city}", u.lng, u.lat, u.driverId) and setex(s"driver:\${u.driverId}:seen", SeenTtlSeconds, u.ts.toString)
      // TODO: onError: the client cancelled (Status.fromThrowable(t).getCode == CANCELLED) — log the count, send nothing
      // TODO: onCompleted: onNext(Ack(count)) then onCompleted
      override def onNext(u: LocationUpdate): Unit = ()
      override def onError(t: Throwable): Unit = ()
      override def onCompleted(): Unit = responseObserver.onError(Status.UNIMPLEMENTED.asRuntimeException())
    }

  def main(args: Array[String]): Unit =
    ServerBuilder.forPort(9000).addService(LocationsGrpc.bindService(this, ExecutionContext.global)).build().start().awaitTermination()
}
`,
      solution: `import dispatch.locations.{Ack, LocationUpdate, LocationsGrpc}
import io.grpc.{ServerBuilder, Status}
import io.grpc.stub.StreamObserver
import redis.clients.jedis.JedisPooled
import scala.concurrent.ExecutionContext

object LocationService extends LocationsGrpc.Locations {
  val jedis = new JedisPooled("redis", 6379)
  val SeenTtlSeconds = 30L

  /** A client stream: the driver app sends a position every few seconds and gets one Ack at the end. */
  override def updateLocations(responseObserver: StreamObserver[Ack]): StreamObserver[LocationUpdate] =
    new StreamObserver[LocationUpdate] {
      private var count = 0

      override def onNext(u: LocationUpdate): Unit = {
        val pipeline = jedis.pipelined()
        pipeline.geoadd(s"drivers:\${u.city}", u.lng, u.lat, u.driverId) // longitude first
        pipeline.setex(s"driver:\${u.driverId}:seen", SeenTtlSeconds, u.ts.toString)
        pipeline.sync()
        count += 1
      }

      override def onError(t: Throwable): Unit =
        if (Status.fromThrowable(t).getCode == Status.Code.CANCELLED) println(s"client cancelled after $count updates")
        else System.err.println(s"stream failed after $count updates: \${t.getMessage}")

      override def onCompleted(): Unit = {
        responseObserver.onNext(Ack(count = count))
        responseObserver.onCompleted()
      }
    }

  def main(args: Array[String]): Unit =
    ServerBuilder.forPort(9000).addService(LocationsGrpc.bindService(this, ExecutionContext.global)).build().start().awaitTermination()
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cstdint>
#include <iostream>
#include <string>
#include <tuple>

#include "locations.grpc.pb.h"

using dispatch::Ack;
using dispatch::LocationUpdate;

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kSeenTtl{30};

class LocationService final : public dispatch::Locations::Service {
 public:
  // A client stream: the driver app sends a position every few seconds and gets one Ack at the end.
  grpc::Status UpdateLocations(grpc::ServerContext* ctx, grpc::ServerReader<LocationUpdate>* reader, Ack* ack) override {
    uint32_t count = 0;
    // TODO: Read in a loop; per update one pipeline: geoadd("drivers:" + city, {driver_id, lng, lat}) and set("driver:" + id + ":seen", ts, kSeenTtl)
    // TODO: Read returns false when the client finished or cancelled: ctx->IsCancelled() → log the count, Status::CANCELLED
    // TODO: ack->set_count(count) and return OK
    (void)count;
    return grpc::Status(grpc::StatusCode::UNIMPLEMENTED, "not implemented");
  }
};

int main() {
  LocationService service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:9000", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <cstdint>
#include <iostream>
#include <string>
#include <tuple>

#include "locations.grpc.pb.h"

using dispatch::Ack;
using dispatch::LocationUpdate;

sw::redis::Redis redis("tcp://redis:6379");

constexpr std::chrono::seconds kSeenTtl{30};

class LocationService final : public dispatch::Locations::Service {
 public:
  // A client stream: the driver app sends a position every few seconds and gets one Ack at the end.
  grpc::Status UpdateLocations(grpc::ServerContext* ctx, grpc::ServerReader<LocationUpdate>* reader, Ack* ack) override {
    uint32_t count = 0;
    LocationUpdate u;
    while (reader->Read(&u)) {
      auto pipe = redis.pipeline();
      pipe.geoadd("drivers:" + u.city(), std::make_tuple(u.driver_id(), u.lng(), u.lat()))  // member, longitude, latitude
          .set("driver:" + u.driver_id() + ":seen", std::to_string(u.ts()), kSeenTtl);
      pipe.exec();
      ++count;
    }
    if (ctx->IsCancelled()) {
      std::cerr << "client cancelled after " << count << " updates\\n";
      return grpc::Status::CANCELLED;
    }
    ack->set_count(count);
    return grpc::Status::OK;
  }
};

int main() {
  LocationService service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:9000", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
    },
  },
  debrief: `A client stream turns thousands of tiny unary calls into one long-lived HTTP/2 stream per driver: no per-message connection setup, back-pressure for free, and one place to notice the driver went away. The write path is deliberately two keys — a GEO set for *where* and a TTL key for *still here* — because a sorted set cannot expire its members. Real location services batch updates per pipeline, shard GEO sets per city cell to spread the write load, map-match the raw GPS onto roads before indexing, and keep a short history per driver to estimate heading and speed.`,
};
