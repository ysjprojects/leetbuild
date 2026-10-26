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
        typescript: {all: [/`drivers:|['"]drivers:/, /\.geoadd\([^\n]*\blng\b[^\n]*\blat\b/]},
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
        typescript: {
          all: [/:seen/, /\.set\([^\n]*['"]EX['"]\s*,\s*(?:SEEN_TTL_S|30)\b|\.setex\([^\n]*\b(?:SEEN_TTL_S|30)\b/],
        },
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
        typescript: {all: [/\.pipeline\(\)|\.multi\(\)/, /\.exec\(\)/]},
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
        typescript: {all: [/callback\(\s*null\s*,\s*\{\s*count\b/]},
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
        typescript: {all: [/\.cancelled\b|['"]cancelled['"]/]},
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


if __name__ == "__main__":
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


if __name__ == "__main__":
    asyncio.run(serve())
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const SEEN_TTL_S = 30;

/** One message of the client stream; int64 ts crosses the wire as a decimal string. */
interface LocationUpdate {
  driver_id: string;
  city: string;
  lat: number;
  lng: number;
  ts: string;
}

interface Ack {
  count: number;
}

export function updateLocations(
  call: grpc.ServerReadableStream<LocationUpdate, Ack>,
  callback: grpc.sendUnaryData<Ack>,
): void {
  let count = 0;
  // TODO: on every 'data' update, one pipeline: GEOADD drivers:{city} (lng, lat, driver_id) and SET driver:{id}:seen ts EX SEEN_TTL_S
  // TODO: on 'cancelled' (the client went away): log the count, send nothing
  // TODO: on 'end' (the client finished its side, every write applied): callback(null, {count})
  count += 0;
  callback({code: grpc.status.UNIMPLEMENTED, details: 'not implemented'});
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('locations.proto')) as {
  dispatch: {Locations: grpc.ServiceClientConstructor};
};

export const server = new grpc.Server();
server.addService(pkg.dispatch.Locations.service, {UpdateLocations: updateLocations});
server.bindAsync('0.0.0.0:9000', grpc.ServerCredentials.createInsecure(), () => server.start());
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

export const SEEN_TTL_S = 30;

/** One message of the client stream; int64 ts crosses the wire as a decimal string. */
interface LocationUpdate {
  driver_id: string;
  city: string;
  lat: number;
  lng: number;
  ts: string;
}

interface Ack {
  count: number;
}

export function updateLocations(
  call: grpc.ServerReadableStream<LocationUpdate, Ack>,
  callback: grpc.sendUnaryData<Ack>,
): void {
  let count = 0;
  let applied = Promise.resolve();
  call.on('data', (u: LocationUpdate) => {
    // Updates are applied in order, each as one round trip: the GEOADD and the SET travel together.
    applied = applied.then(async () => {
      await redis
        .pipeline()
        .geoadd(\`drivers:\${u.city}\`, u.lng, u.lat, u.driver_id) // longitude first
        .set(\`driver:\${u.driver_id}:seen\`, u.ts, 'EX', SEEN_TTL_S)
        .exec();
      count += 1;
    });
  });
  call.on('cancelled', () => {
    console.log(\`client cancelled after \${count} updates\`);
  });
  call.on('end', () => {
    void applied.then(() => {
      if (!call.cancelled) callback(null, {count});
    });
  });
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('locations.proto')) as {
  dispatch: {Locations: grpc.ServiceClientConstructor};
};

export const server = new grpc.Server();
server.addService(pkg.dispatch.Locations.service, {UpdateLocations: updateLocations});
server.bindAsync('0.0.0.0:9000', grpc.ServerCredentials.createInsecure(), () => server.start());
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
  harness: {
    python: `import asyncio
import logging

import grpc

import locations_pb2
import locations_pb2_grpc


def _update(driver_id, lat, lng, ts, city="paris"):
    return locations_pb2.LocationUpdate(driver_id=driver_id, city=city, lat=lat, lng=lng, ts=ts)


async def _serve(ctx):
    m = ctx.load("location_service")
    asyncio.create_task(m.serve())
    await asyncio.sleep(0)
    stub = locations_pb2_grpc.LocationsStub(grpc.aio.insecure_channel("location:9000"))
    return m, stub


async def _push(stub, updates):
    """One client stream: write every update, half-close, await the single Ack."""
    call = stub.UpdateLocations()
    for u in updates:
        await call.write(u)
    await call.done_writing()
    return await call


def _count_round_trips(m):
    """Count Redis round trips on the learner's client: direct commands vs executed pipelines."""
    trips = {"direct": 0, "pipelines": 0}
    real_execute = m.r.execute_command
    real_pipeline = m.r.pipeline

    async def execute_command(*args, **kwargs):
        trips["direct"] += 1
        return await real_execute(*args, **kwargs)

    def pipeline(*args, **kwargs):
        pipe = real_pipeline(*args, **kwargs)
        real_pipe_execute = pipe.execute

        async def execute(*a, **k):
            trips["pipelines"] += 1
            return await real_pipe_execute(*a, **k)

        pipe.execute = execute
        return pipe

    m.r.execute_command = execute_command
    m.r.pipeline = pipeline
    return trips


def _pos(ctx, city, driver_id):
    found = ctx.redis.geopos(f"drivers:{city}", driver_id)
    return found[0] if found and found[0] is not None else None


async def check_geoadd_lng_lat(ctx):
    m, stub = await _serve(ctx)
    await _push(stub, [_update("d-7", 48.85, 2.35, 1000), _update("d-2", 48.86, 2.30, 1000), _update("d-l", 45.76, 4.84, 1000, city="lyon")])
    pos = _pos(ctx, "paris", "d-7")
    assert pos is not None, f"drivers:paris has no member d-7 after an update (members: {ctx.redis.zrange('drivers:paris', 0, -1)})"
    lng, lat = pos
    assert abs(lng - 2.35) < 1e-3 and abs(lat - 48.85) < 1e-3, f"d-7 is stored at lng={lng:.4f} lat={lat:.4f}, expected lng=2.35 lat=48.85 (GEOADD takes longitude first)"
    lng, lat = _pos(ctx, "paris", "d-2")
    assert abs(lng - 2.30) < 1e-3 and abs(lat - 48.86) < 1e-3, f"d-2 is stored at lng={lng:.4f} lat={lat:.4f}, expected lng=2.30 lat=48.86"
    assert _pos(ctx, "lyon", "d-l") is not None, "an update for city lyon must land in drivers:lyon"
    assert _pos(ctx, "paris", "d-l") is None, "a lyon driver must not be added to drivers:paris: the GEO key is per city"


async def check_presence_ttl(ctx):
    m, stub = await _serve(ctx)
    await _push(stub, [_update("d-7", 48.85, 2.35, 1000)])
    seen = ctx.redis.get("driver:d-7:seen")
    assert seen is not None, "driver:d-7:seen was not written"
    assert seen == "1000", f"driver:d-7:seen holds {seen!r}, expected the update's ts 1000"
    ttl = ctx.redis.ttl("driver:d-7:seen")
    assert 0 < ttl <= 30, f"driver:d-7:seen has TTL {ttl}, expected EX 30"
    ctx.clock.advance(20)
    await _push(stub, [_update("d-7", 48.851, 2.351, 1020)])
    ttl = ctx.redis.ttl("driver:d-7:seen")
    assert ttl > 25, f"a new update must refresh the presence key: TTL is {ttl} after the second update"
    assert ctx.redis.get("driver:d-7:seen") == "1020", "the presence value must be the latest ts"
    ctx.clock.advance(31)
    assert ctx.redis.get("driver:d-7:seen") is None, "31 s after the last update the presence key must have expired"
    assert _pos(ctx, "paris", "d-7") is not None, "the GEO member stays (only the presence key expires)"


async def check_pipelined(ctx):
    m, stub = await _serve(ctx)
    trips = _count_round_trips(m)
    updates = [_update("d-7", 48.85, 2.35, 1000), _update("d-2", 48.86, 2.30, 1001), _update("d-9", 48.84, 2.37, 1002)]
    await _push(stub, updates)
    for u in updates:
        assert _pos(ctx, "paris", u.driver_id) is not None, f"{u.driver_id} was not GEOADDed (was the pipeline executed?)"
        assert ctx.redis.get(f"driver:{u.driver_id}:seen") == str(u.ts), f"driver:{u.driver_id}:seen is {ctx.redis.get(f'driver:{u.driver_id}:seen')!r}"
    assert trips["direct"] == 0, f"{trips['direct']} commands were sent outside a pipeline: GEOADD and SET must travel together in one round trip"
    assert 1 <= trips["pipelines"] <= len(updates), f"{trips['pipelines']} pipelines executed for {len(updates)} updates; expected one per update (or per small batch)"


async def check_ack_count(ctx):
    m, stub = await _serve(ctx)
    ack = await _push(stub, [_update(f"d-{i}", 48.85 + i / 1000, 2.35, 1000 + i) for i in range(4)])
    assert isinstance(ack, locations_pb2.Ack), f"the stream must end with an Ack, got {type(ack).__name__}"
    assert ack.count == 4, f"Ack.count is {ack.count} after 4 updates, expected 4"
    ack = await _push(stub, [_update("d-7", 48.85, 2.35, 2000), _update("d-7", 48.851, 2.35, 2004)])
    assert ack.count == 2, f"a second stream of 2 updates was acknowledged with count {ack.count}: the count is per stream"
    ack = await _push(stub, [])
    assert ack.count == 0, f"a stream that sent nothing must be acknowledged with count 0, got {ack.count}"


async def check_cancel(ctx):
    m, stub = await _serve(ctx)
    records = []
    handler = logging.Handler()
    handler.emit = records.append
    root = logging.getLogger()
    level = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    try:
        call = stub.UpdateLocations()
        await call.write(_update("d-7", 48.85, 2.35, 1000))
        await call.write(_update("d-2", 48.86, 2.30, 1001))
        for _ in range(20):
            await asyncio.sleep(0)
        assert _pos(ctx, "paris", "d-2") is not None, "updates must be applied as they arrive, not only when the stream ends"
        call.cancel()
        for _ in range(20):
            await asyncio.sleep(0)
        code = await call.code()
        assert code == grpc.StatusCode.CANCELLED, f"after a client cancel the call ended with {code}, expected CANCELLED (no Ack)"
        assert ctx.redis.zcard("drivers:paris") == 2, "the two updates before the cancel stay applied"
        logged = [r.getMessage() for r in records]
        assert any("2" in msg for msg in logged), f"a cancelled stream must log how many updates were applied (2); logged: {logged}"
    finally:
        root.removeHandler(handler)
        root.setLevel(level)
    ack = await _push(stub, [_update("d-9", 48.84, 2.37, 1002)])
    assert ack.count == 1, "the server must keep serving new streams after a cancel"
`,
    typescript: `import * as grpc from '@grpc/grpc-js';

interface Update {
  driver_id: string;
  city: string;
  lat: number;
  lng: number;
  ts: number;
}

function update(driver_id: string, lat: number, lng: number, ts: number, city = 'paris'): Update {
  return {driver_id, city, lat, lng, ts};
}

/** Load the learner's server (its addService installs the handler) and open a client to it. */
function serve(ctx) {
  const m = ctx.load('location_service');
  const pkg = ctx.proto('locations.proto');
  const client = new pkg.dispatch.Locations('location:9000', grpc.credentials.createInsecure());
  return {m, client};
}

/** One client stream: write every update, half-close, await the single Ack. */
function push(client, updates: Update[]): Promise<{count: number}> {
  const {promise, resolve, reject} = Promise.withResolvers<{count: number}>();
  const call = client.UpdateLocations((err, ack) => (err ? reject(err) : resolve(ack)));
  for (const u of updates) call.write(u);
  call.end();
  return promise;
}

/** Let every queued microtask and the server's pending writes run. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function pos(ctx, city: string, driverId: string): [number, number] | null {
  const found = ctx.redis.geopos(\`drivers:\${city}\`, driverId);
  if (!Array.isArray(found) || found[0] === null || found[0] === undefined) return null;
  return [Number(found[0][0]), Number(found[0][1])];
}

export async function check_geoadd_lng_lat(ctx) {
  const {client} = serve(ctx);
  await push(client, [update('d-7', 48.85, 2.35, 1000), update('d-2', 48.86, 2.3, 1000), update('d-l', 45.76, 4.84, 1000, 'lyon')]);
  const d7 = pos(ctx, 'paris', 'd-7');
  assert(d7 !== null, \`drivers:paris has no member d-7 after an update (members: \${JSON.stringify(ctx.redis.zrange('drivers:paris', 0, -1))})\`);
  let [lng, lat] = d7;
  assert(Math.abs(lng - 2.35) < 1e-3 && Math.abs(lat - 48.85) < 1e-3, \`d-7 is stored at lng=\${lng.toFixed(4)} lat=\${lat.toFixed(4)}, expected lng=2.35 lat=48.85 (GEOADD takes longitude first)\`);
  const d2 = pos(ctx, 'paris', 'd-2');
  assert(d2 !== null, 'drivers:paris has no member d-2 after an update');
  [lng, lat] = d2;
  assert(Math.abs(lng - 2.3) < 1e-3 && Math.abs(lat - 48.86) < 1e-3, \`d-2 is stored at lng=\${lng.toFixed(4)} lat=\${lat.toFixed(4)}, expected lng=2.30 lat=48.86\`);
  assert(pos(ctx, 'lyon', 'd-l') !== null, 'an update for city lyon must land in drivers:lyon');
  assert(pos(ctx, 'paris', 'd-l') === null, 'a lyon driver must not be added to drivers:paris: the GEO key is per city');
}

export async function check_presence_ttl(ctx) {
  const {client} = serve(ctx);
  await push(client, [update('d-7', 48.85, 2.35, 1000)]);
  const seen = ctx.redis.get('driver:d-7:seen');
  assert(seen !== null, 'driver:d-7:seen was not written');
  assert.equal(seen, '1000', \`driver:d-7:seen holds \${JSON.stringify(seen)}, expected the update's ts 1000\`);
  let ttl = ctx.redis.ttl('driver:d-7:seen');
  assert(0 < ttl && ttl <= 30, \`driver:d-7:seen has TTL \${ttl}, expected EX 30\`);
  ctx.clock.advance(20);
  await push(client, [update('d-7', 48.851, 2.351, 1020)]);
  ttl = ctx.redis.ttl('driver:d-7:seen');
  assert(ttl > 25, \`a new update must refresh the presence key: TTL is \${ttl} after the second update\`);
  assert.equal(ctx.redis.get('driver:d-7:seen'), '1020', 'the presence value must be the latest ts');
  ctx.clock.advance(31);
  assert.equal(ctx.redis.get('driver:d-7:seen'), null, '31 s after the last update the presence key must have expired');
  assert(pos(ctx, 'paris', 'd-7') !== null, 'the GEO member stays (only the presence key expires)');
}

export async function check_pipelined(ctx) {
  const {client} = serve(ctx);
  const updates = [update('d-7', 48.85, 2.35, 1000), update('d-2', 48.86, 2.3, 1001), update('d-9', 48.84, 2.37, 1002)];
  const before = ctx.redisRoundTrips().length;
  await push(client, updates);
  const trips = ctx.redisRoundTrips().slice(before);
  for (const u of updates) {
    assert(pos(ctx, 'paris', u.driver_id) !== null, \`\${u.driver_id} was not GEOADDed (was the pipeline executed?)\`);
    assert.equal(ctx.redis.get(\`driver:\${u.driver_id}:seen\`), String(u.ts), \`driver:\${u.driver_id}:seen is \${JSON.stringify(ctx.redis.get(\`driver:\${u.driver_id}:seen\`))}\`);
  }
  const direct = trips.filter(t => t.length === 1 && t[0] !== 'MULTI').length;
  const pipelines = trips.filter(t => t.length > 1).length;
  assert.equal(direct, 0, \`\${direct} commands were sent outside a pipeline: GEOADD and SET must travel together in one round trip (round trips: \${JSON.stringify(trips)})\`);
  assert(1 <= pipelines && pipelines <= updates.length, \`\${pipelines} pipelines executed for \${updates.length} updates; expected one per update (or per small batch)\`);
}

export async function check_ack_count(ctx) {
  const {client} = serve(ctx);
  let ack = await push(client, [0, 1, 2, 3].map(i => update(\`d-\${i}\`, 48.85 + i / 1000, 2.35, 1000 + i)));
  assert(ack !== null && typeof ack === 'object', \`the stream must end with an Ack, got \${JSON.stringify(ack)}\`);
  assert.equal(ack.count, 4, \`Ack.count is \${ack.count} after 4 updates, expected 4\`);
  ack = await push(client, [update('d-7', 48.85, 2.35, 2000), update('d-7', 48.851, 2.35, 2004)]);
  assert.equal(ack.count, 2, \`a second stream of 2 updates was acknowledged with count \${ack.count}: the count is per stream\`);
  ack = await push(client, []);
  assert.equal(ack.count, 0, \`a stream that sent nothing must be acknowledged with count 0, got \${ack.count}\`);
}

export async function check_cancel(ctx) {
  const {client} = serve(ctx);
  const logged: string[] = [];
  const real = {log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug};
  const capture = (...args: unknown[]) => void logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = console.info = console.warn = console.error = console.debug = capture;
  try {
    let outcome: {code: number} | {ack: unknown} | null = null;
    const call = client.UpdateLocations((err, ack) => (outcome = err ? {code: err.code} : {ack}));
    call.write(update('d-7', 48.85, 2.35, 1000));
    call.write(update('d-2', 48.86, 2.3, 1001));
    await settle();
    assert(pos(ctx, 'paris', 'd-2') !== null, 'updates must be applied as they arrive, not only when the stream ends');
    call.cancel();
    await settle();
    assert(outcome !== null && 'code' in outcome && outcome.code === ctx.grpc.status.CANCELLED, \`after a client cancel the call ended with \${JSON.stringify(outcome)}, expected CANCELLED (no Ack)\`);
    assert.equal(ctx.redis.zcard('drivers:paris'), 2, 'the two updates before the cancel stay applied');
    assert(logged.some(line => line.includes('2')), \`a cancelled stream must log how many updates were applied (2); logged: \${JSON.stringify(logged)}\`);
  } finally {
    Object.assign(console, real);
  }
  const ack = await push(client, [update('d-9', 48.84, 2.37, 1002)]);
  assert.equal(ack.count, 1, 'the server must keep serving new streams after a cancel');
}
`,
    go: `package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"math"
	"strconv"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"leetbuild/harness"

	pb "dispatch/gen/locations"
)

func locUpdate(driverID string, lat, lng float64, ts int64, city string) *pb.LocationUpdate {
	return &pb.LocationUpdate{DriverId: driverID, City: city, Lat: lat, Lng: lng, Ts: ts}
}

// locClient runs the learner's main (it serves Locations on :9000) and dials it.
func locClient(ctx *harness.Ctx) pb.LocationsClient {
	ctx.Main(main)
	return pb.NewLocationsClient(ctx.GRPC.Dial("location:9000"))
}

// pushUpdates is one client stream: send every update, half-close, wait for the single Ack.
func pushUpdates(ctx *harness.Ctx, client pb.LocationsClient, updates ...*pb.LocationUpdate) *pb.Ack {
	stream, err := client.UpdateLocations(context.Background())
	ctx.NoError(err, "opening an UpdateLocations stream")
	for _, u := range updates {
		if err := stream.Send(u); err != nil && err != io.EOF {
			ctx.Fatalf("sending %s's update: %v", u.GetDriverId(), err)
		}
	}
	ack, err := stream.CloseAndRecv()
	ctx.NoError(err, "the stream must end with an Ack")
	return ack
}

// driverPos is the member's GEOPOS in drivers:{city}; ok is false when it is not a member.
func driverPos(ctx *harness.Ctx, city, driverID string) (lng, lat float64, ok bool) {
	found, _ := ctx.Redis.Do("GEOPOS", "drivers:"+city, driverID).([]any)
	if len(found) == 0 {
		return 0, 0, false
	}
	pair, _ := found[0].([]any)
	if len(pair) != 2 {
		return 0, 0, false
	}
	lng, _ = strconv.ParseFloat(fmt.Sprint(pair[0]), 64)
	lat, _ = strconv.ParseFloat(fmt.Sprint(pair[1]), 64)
	return lng, lat, true
}

func CheckGeoaddLngLat(ctx *harness.Ctx) {
	client := locClient(ctx)
	pushUpdates(ctx, client, locUpdate("d-7", 48.85, 2.35, 1000, "paris"), locUpdate("d-2", 48.86, 2.3, 1000, "paris"), locUpdate("d-l", 45.76, 4.84, 1000, "lyon"))
	lng, lat, ok := driverPos(ctx, "paris", "d-7")
	ctx.Assert(ok, "drivers:paris has no member d-7 after an update (members: %v)", ctx.Redis.Do("ZRANGE", "drivers:paris", 0, -1))
	ctx.Assert(math.Abs(lng-2.35) < 1e-3 && math.Abs(lat-48.85) < 1e-3, "d-7 is stored at lng=%.4f lat=%.4f, expected lng=2.35 lat=48.85 (GEOADD takes longitude first)", lng, lat)
	lng, lat, ok = driverPos(ctx, "paris", "d-2")
	ctx.Assert(ok, "drivers:paris has no member d-2 after an update")
	ctx.Assert(math.Abs(lng-2.3) < 1e-3 && math.Abs(lat-48.86) < 1e-3, "d-2 is stored at lng=%.4f lat=%.4f, expected lng=2.30 lat=48.86", lng, lat)
	_, _, ok = driverPos(ctx, "lyon", "d-l")
	ctx.Assert(ok, "an update for city lyon must land in drivers:lyon")
	_, _, ok = driverPos(ctx, "paris", "d-l")
	ctx.Assert(!ok, "a lyon driver must not be added to drivers:paris: the GEO key is per city")
}

func CheckPresenceTtl(ctx *harness.Ctx) {
	client := locClient(ctx)
	pushUpdates(ctx, client, locUpdate("d-7", 48.85, 2.35, 1000, "paris"))
	seen, ok := ctx.Redis.Get("driver:d-7:seen")
	ctx.Assert(ok, "driver:d-7:seen was not written")
	ctx.Equal(seen, "1000", "driver:d-7:seen must hold the update's ts")
	ttl := ctx.Redis.TTL("driver:d-7:seen")
	ctx.Assert(0 < ttl && ttl <= 30, "driver:d-7:seen has TTL %d, expected seenTTL (30 s)", ttl)
	ctx.Clock.Advance(20)
	pushUpdates(ctx, client, locUpdate("d-7", 48.851, 2.351, 1020, "paris"))
	ttl = ctx.Redis.TTL("driver:d-7:seen")
	ctx.Assert(ttl > 25, "a new update must refresh the presence key: TTL is %d after the second update", ttl)
	seen, _ = ctx.Redis.Get("driver:d-7:seen")
	ctx.Equal(seen, "1020", "the presence value must be the latest ts")
	ctx.Clock.Advance(31)
	_, ok = ctx.Redis.Get("driver:d-7:seen")
	ctx.Assert(!ok, "31 s after the last update the presence key must have expired")
	_, _, ok = driverPos(ctx, "paris", "d-7")
	ctx.Assert(ok, "the GEO member stays (only the presence key expires)")
}

func CheckPipelined(ctx *harness.Ctx) {
	client := locClient(ctx)
	updates := []*pb.LocationUpdate{locUpdate("d-7", 48.85, 2.35, 1000, "paris"), locUpdate("d-2", 48.86, 2.3, 1001, "paris"), locUpdate("d-9", 48.84, 2.37, 1002, "paris")}
	before := len(ctx.Redis.RoundTrips())
	pushUpdates(ctx, client, updates...)
	trips := ctx.Redis.RoundTrips()[before:]
	for _, u := range updates {
		_, _, ok := driverPos(ctx, "paris", u.GetDriverId())
		ctx.Assert(ok, "%s was not GEOADDed (was the pipeline executed?)", u.GetDriverId())
		seen, _ := ctx.Redis.Get("driver:" + u.GetDriverId() + ":seen")
		ctx.Equal(seen, strconv.FormatInt(u.GetTs(), 10), "driver:%s:seen", u.GetDriverId())
	}
	direct, pipelines := 0, 0
	for _, t := range trips {
		if len(t) == 1 && t[0] != "MULTI" {
			direct++
		}
		if len(t) > 1 {
			pipelines++
		}
	}
	ctx.Equal(direct, 0, "commands sent outside a pipeline: GEOADD and SET must travel together in one round trip (round trips: %v)", trips)
	ctx.Assert(1 <= pipelines && pipelines <= len(updates), "%d pipelines executed for %d updates; expected one per update (or per small batch)", pipelines, len(updates))
}

func CheckAckCount(ctx *harness.Ctx) {
	client := locClient(ctx)
	var four []*pb.LocationUpdate
	for i := range 4 {
		four = append(four, locUpdate(fmt.Sprintf("d-%d", i), 48.85+float64(i)/1000, 2.35, int64(1000+i), "paris"))
	}
	ack := pushUpdates(ctx, client, four...)
	ctx.Assert(ack != nil, "the stream must end with an Ack, got nil")
	ctx.Equal(ack.GetCount(), 4, "Ack.Count after 4 updates")
	ack = pushUpdates(ctx, client, locUpdate("d-7", 48.85, 2.35, 2000, "paris"), locUpdate("d-7", 48.851, 2.35, 2004, "paris"))
	ctx.Equal(ack.GetCount(), 2, "a second stream of 2 updates: the count is per stream")
	ack = pushUpdates(ctx, client)
	ctx.Equal(ack.GetCount(), 0, "a stream that sent nothing must be acknowledged with count 0")
}

func CheckCancel(ctx *harness.Ctx) {
	client := locClient(ctx)
	var logged strings.Builder
	prevOut, prevFlags := log.Writer(), log.Flags()
	log.SetOutput(&logged)
	log.SetFlags(0) // no timestamp: its digits must not pass for the count
	func() {
		defer func() {
			log.SetOutput(prevOut)
			log.SetFlags(prevFlags)
		}()
		cctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		stream, err := client.UpdateLocations(cctx)
		ctx.NoError(err, "opening an UpdateLocations stream")
		_ = stream.Send(locUpdate("d-7", 48.85, 2.35, 1000, "paris"))
		_ = stream.Send(locUpdate("d-2", 48.86, 2.3, 1001, "paris"))
		ctx.Settle()
		_, _, ok := driverPos(ctx, "paris", "d-2")
		ctx.Assert(ok, "updates must be applied as they arrive, not only when the stream ends")
		cancel()
		ctx.Settle()
		_, err = stream.CloseAndRecv()
		ctx.Equal(status.Code(err), codes.Canceled, "after a client cancel the call must end CANCELLED (no Ack)")
		ctx.Equal(ctx.Redis.Do("ZCARD", "drivers:paris"), 2, "the two updates before the cancel stay applied: ZCARD drivers:paris")
		ctx.Assert(strings.Contains(logged.String(), "2"), "a cancelled stream must log how many updates were applied (2); logged: %q", logged.String())
	}()
	ack := pushUpdates(ctx, client, locUpdate("d-9", 48.84, 2.37, 1002, "paris"))
	ctx.Equal(ack.GetCount(), 1, "the server must keep serving new streams after a cancel")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <cmath>
#include <cstdlib>
#include <memory>
#include <mutex>
#include <streambuf>
#include <string>
#include <vector>

namespace {

LocationUpdate locUpdate(const std::string& driverID, double lat, double lng, int64_t ts, const std::string& city) {
  LocationUpdate u;
  u.set_driver_id(driverID);
  u.set_city(city);
  u.set_lat(lat);
  u.set_lng(lng);
  u.set_ts(ts);
  return u;
}

// locClient runs the learner's main (it serves Locations on :9000) and dials it.
std::unique_ptr<dispatch::Locations::Stub> locClient(harness::Ctx& ctx) {
  ctx.Main();
  return dispatch::Locations::NewStub(ctx.GRPC.Dial("location:9000"));
}

// pushUpdates is one client stream: send every update, half-close, wait for the single Ack.
Ack pushUpdates(harness::Ctx& ctx, dispatch::Locations::Stub& client, const std::vector<LocationUpdate>& updates) {
  grpc::ClientContext cctx;
  Ack ack;
  auto stream = client.UpdateLocations(&cctx, &ack);
  for (const auto& u : updates) stream->Write(u);  // false once the server ended the call: Finish says why
  stream->WritesDone();
  const grpc::Status status = stream->Finish();
  ctx.Assert(status.ok(), "the stream must end with an Ack: %v %s", status.error_code(), status.error_message());
  return ack;
}

struct driverPos {
  double lng = 0, lat = 0;
  bool ok = false;
};

// posOf is the member's GEOPOS in drivers:{city}; ok is false when it is not a member.
driverPos posOf(harness::Ctx& ctx, const std::string& city, const std::string& driverID) {
  const harness::Reply found = ctx.Redis.Do("GEOPOS", "drivers:" + city, driverID);
  if (!found.IsArray() || found.Array().empty()) return {};
  const harness::Reply pair = found.Array()[0];
  if (!pair.IsArray() || pair.Array().size() != 2) return {};
  return {std::strtod(pair.Array()[0].String().c_str(), nullptr), std::strtod(pair.Array()[1].String().c_str(), nullptr), true};
}

// locLogs tees what the learner writes to std::cerr (Go: the log package's output) until it is
// destroyed, which restores the previous buffer.
class locLogs : public std::streambuf {
 public:
  locLogs() : previous_(std::cerr.rdbuf(this)) {}
  ~locLogs() override { std::cerr.rdbuf(previous_); }
  std::string text() {
    std::lock_guard<std::mutex> lock(mu_);
    return text_;
  }

 protected:
  int overflow(int c) override {
    if (c == traits_type::eof()) return traits_type::not_eof(c);
    {
      std::lock_guard<std::mutex> lock(mu_);
      text_ += static_cast<char>(c);
    }
    return previous_->sputc(static_cast<char>(c));
  }
  std::streamsize xsputn(const char* s, std::streamsize n) override {
    {
      std::lock_guard<std::mutex> lock(mu_);
      text_.append(s, static_cast<size_t>(n));
    }
    return previous_->sputn(s, n);
  }
  int sync() override { return previous_->pubsync(); }

 private:
  std::streambuf* previous_;
  std::mutex mu_;
  std::string text_;
};

}  // namespace

void CheckGeoaddLngLat(harness::Ctx& ctx) {
  auto client = locClient(ctx);
  pushUpdates(ctx, *client, {locUpdate("d-7", 48.85, 2.35, 1000, "paris"), locUpdate("d-2", 48.86, 2.3, 1000, "paris"), locUpdate("d-l", 45.76, 4.84, 1000, "lyon")});
  driverPos p = posOf(ctx, "paris", "d-7");
  ctx.Assert(p.ok, "drivers:paris has no member d-7 after an update (members: %v)", ctx.Redis.Do("ZRANGE", "drivers:paris", 0, -1));
  ctx.Assert(std::abs(p.lng - 2.35) < 1e-3 && std::abs(p.lat - 48.85) < 1e-3, "d-7 is stored at lng=%.4f lat=%.4f, expected lng=2.35 lat=48.85 (GEOADD takes longitude first)", p.lng, p.lat);
  p = posOf(ctx, "paris", "d-2");
  ctx.Assert(p.ok, "drivers:paris has no member d-2 after an update");
  ctx.Assert(std::abs(p.lng - 2.3) < 1e-3 && std::abs(p.lat - 48.86) < 1e-3, "d-2 is stored at lng=%.4f lat=%.4f, expected lng=2.30 lat=48.86", p.lng, p.lat);
  ctx.Assert(posOf(ctx, "lyon", "d-l").ok, "an update for city lyon must land in drivers:lyon");
  ctx.Assert(!posOf(ctx, "paris", "d-l").ok, "a lyon driver must not be added to drivers:paris: the GEO key is per city");
}

void CheckPresenceTtl(harness::Ctx& ctx) {
  auto client = locClient(ctx);
  pushUpdates(ctx, *client, {locUpdate("d-7", 48.85, 2.35, 1000, "paris")});
  auto seen = ctx.Redis.Get("driver:d-7:seen");
  ctx.Assert(seen.has_value(), "driver:d-7:seen was not written");
  ctx.Equal(*seen, "1000", "driver:d-7:seen must hold the update's ts");
  long long ttl = ctx.Redis.TTL("driver:d-7:seen");
  ctx.Assert(0 < ttl && ttl <= 30, "driver:d-7:seen has TTL %d, expected kSeenTtl (30 s)", ttl);
  ctx.Clock.Advance(20);
  pushUpdates(ctx, *client, {locUpdate("d-7", 48.851, 2.351, 1020, "paris")});
  ttl = ctx.Redis.TTL("driver:d-7:seen");
  ctx.Assert(ttl > 25, "a new update must refresh the presence key: TTL is %d after the second update", ttl);
  ctx.Equal(ctx.Redis.Get("driver:d-7:seen").value_or(""), "1020", "the presence value must be the latest ts");
  ctx.Clock.Advance(31);
  ctx.Assert(!ctx.Redis.Get("driver:d-7:seen").has_value(), "31 s after the last update the presence key must have expired");
  ctx.Assert(posOf(ctx, "paris", "d-7").ok, "the GEO member stays (only the presence key expires)");
}

void CheckPipelined(harness::Ctx& ctx) {
  auto client = locClient(ctx);
  const std::vector<LocationUpdate> updates = {locUpdate("d-7", 48.85, 2.35, 1000, "paris"), locUpdate("d-2", 48.86, 2.3, 1001, "paris"), locUpdate("d-9", 48.84, 2.37, 1002, "paris")};
  const size_t before = ctx.Redis.RoundTrips().size();
  pushUpdates(ctx, *client, updates);
  const auto all = ctx.Redis.RoundTrips();
  const std::vector<std::vector<std::string>> trips(all.begin() + static_cast<long>(before), all.end());
  for (const auto& u : updates) {
    ctx.Assert(posOf(ctx, "paris", u.driver_id()).ok, "%s was not GEOADDed (was the pipeline executed?)", u.driver_id());
    ctx.Equal(ctx.Redis.Get("driver:" + u.driver_id() + ":seen").value_or(""), std::to_string(u.ts()), "driver:%s:seen", u.driver_id());
  }
  size_t direct = 0, pipelines = 0;
  for (const auto& t : trips) {
    if (t.size() == 1 && t[0] != "MULTI") direct++;
    if (t.size() > 1) pipelines++;
  }
  ctx.Equal(direct, 0, "commands sent outside a pipeline: GEOADD and SET must travel together in one round trip (round trips: %v)", trips);
  ctx.Assert(1 <= pipelines && pipelines <= updates.size(), "%d pipelines executed for %d updates; expected one per update (or per small batch)", pipelines, updates.size());
}

void CheckAckCount(harness::Ctx& ctx) {
  auto client = locClient(ctx);
  std::vector<LocationUpdate> four;
  for (int i = 0; i < 4; i++) four.push_back(locUpdate("d-" + std::to_string(i), 48.85 + i / 1000.0, 2.35, 1000 + i, "paris"));
  Ack ack = pushUpdates(ctx, *client, four);
  ctx.Equal(ack.count(), 4, "Ack.count after 4 updates");
  ack = pushUpdates(ctx, *client, {locUpdate("d-7", 48.85, 2.35, 2000, "paris"), locUpdate("d-7", 48.851, 2.35, 2004, "paris")});
  ctx.Equal(ack.count(), 2, "a second stream of 2 updates: the count is per stream");
  ack = pushUpdates(ctx, *client, {});
  ctx.Equal(ack.count(), 0, "a stream that sent nothing must be acknowledged with count 0");
}

void CheckCancel(harness::Ctx& ctx) {
  auto client = locClient(ctx);
  {
    locLogs logged;
    // Go cancels the stream's context.Context; C++ cancels its ClientContext (TryCancel).
    grpc::ClientContext cctx;
    Ack ack;
    auto stream = client->UpdateLocations(&cctx, &ack);
    stream->Write(locUpdate("d-7", 48.85, 2.35, 1000, "paris"));
    stream->Write(locUpdate("d-2", 48.86, 2.3, 1001, "paris"));
    ctx.Settle();
    ctx.Assert(posOf(ctx, "paris", "d-2").ok, "updates must be applied as they arrive, not only when the stream ends");
    cctx.TryCancel();
    ctx.Settle();
    const grpc::Status status = stream->Finish();
    ctx.Equal(status.error_code(), grpc::StatusCode::CANCELLED, "after a client cancel the call must end CANCELLED (no Ack)");
    ctx.Equal(ctx.Redis.ZCard("drivers:paris"), 2, "the two updates before the cancel stay applied: ZCARD drivers:paris");
    const std::string text = logged.text();
    ctx.Assert(text.find('2') != std::string::npos, "a cancelled stream must log how many updates were applied (2); logged: %q", text);
  }
  const Ack ack = pushUpdates(ctx, *client, {locUpdate("d-9", 48.84, 2.37, 1002, "paris")});
  ctx.Equal(ack.count(), 1, "the server must keep serving new streams after a cancel");
}
`,
  },
  debrief: `A client stream turns thousands of tiny unary calls into one long-lived HTTP/2 stream per driver: no per-message connection setup, back-pressure for free, and one place to notice the driver went away. The write path is deliberately two keys — a GEO set for *where* and a TTL key for *still here* — because a sorted set cannot expire its members. Real location services batch updates per pipeline, shard GEO sets per city cell to spread the write load, map-match the raw GPS onto roads before indexing, and keep a short history per driver to estimate heading and speed.`,
};
