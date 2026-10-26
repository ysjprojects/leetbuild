import type {Step} from '@/lib/types';

export const tileStreamStep: Step = {
  id: 'tile-stream',
  title: 'StreamTiles: one server stream per client',
  concept: 'grpc',
  file: 'tile_stream',
  focus: ['client', 'stream', 'kafka'],
  task: `## Task

Every open client holds one server-streaming call and receives each placement as it happens:

\`\`\`proto
service Place {
  rpc StreamTiles(Subscribe) returns (stream Tile);
}
message Subscribe { string client = 1; }
message Tile      { uint32 x = 1; uint32 y = 2; uint32 color = 3; string user = 4; int64 ts = 5; }
\`\`\`

Implement the \`StreamTiles\` handler of **tile-stream**. The per-instance bus is provided as
\`tile_bus\`: \`subscribe()\` returns a queue that receives every placement published on this instance
(dicts shaped like the Kafka event), \`unsubscribe(queue)\` undoes it. Each instance feeds its bus from
\`placements\` in its own consumer group — that part is given.

- On a call: \`subscribe()\`, then forward everything the queue yields as a \`Tile\`, in order, for as
  long as the client stays connected.
- When the client hangs up — cancel, connection drop, or any other end — **unsubscribe**, from the
  call's done callback (\`add_done_callback\` / \`ctx.Done()\` / \`setOnCancelHandler\` / \`IsCancelled\`).
  Reddit held ~80 000 of these at the peak; a subscription that outlives its stream is a leak per
  disconnect.
- A client that cannot keep up is **dropped, not buffered**: if more than \`MAX_LAG\` (1000) tiles are
  queued for it, end the call with \`RESOURCE_EXHAUSTED\`. The client reconnects and refetches
  \`/board\` — one cached request — instead of the server holding minutes of backlog per slow reader.

:::widget grpc-streams {"mode": "server"}

> The client's start-up order is the whole trick: open the stream *first*, then fetch \`/board\`, then
> replay the tiles that arrived in between. A board a second stale plus a stream that started before
> it was generated is a consistent picture.`,
  sequence: {
    participants: ['Client', 'tile-stream', 'tile bus'],
    messages: [
      {from: 'Client', to: 'tile-stream', label: 'StreamTiles(Subscribe{client: web})', kind: 'sync'},
      {from: 'tile-stream', to: 'tile bus', label: 'subscribe()', kind: 'sync'},
      {from: 'tile bus', to: 'tile-stream', label: '{ana, 3, 7, 12, ts}', kind: 'async'},
      {from: 'tile-stream', to: 'Client', label: 'Tile{3, 7, 12, ana, ts}', kind: 'async'},
      {from: 'tile bus', to: 'tile-stream', label: '{bo, 3, 8, 1, ts}', kind: 'async'},
      {from: 'tile-stream', to: 'Client', label: 'Tile{3, 8, 1, bo, ts}', kind: 'async'},
      {from: 'Client', to: 'tile-stream', label: 'cancel → unsubscribe(queue)', kind: 'async'},
    ],
  },
  hints: [
    'A server-streaming handler in grpc.aio is an `async def` that `yield`s responses: `tile = await queue.get()` then `yield place_pb2.Tile(x=…, y=…, color=…, user=…, ts=…)` in a `while True`.',
    'Register the cleanup the moment you subscribe — `context.add_done_callback(lambda _: tile_bus.unsubscribe(queue))` — not at the end of the handler: on a cancellation the end of the handler never runs normally.',
    'The backlog is `queue.qsize()` right after a `get()`; when it exceeds `MAX_LAG`, `await context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, …)`. The done callback unsubscribes for you.',
  ],
  checks: [
    {
      id: 'serve-stream',
      title: 'Serves StreamTiles and forwards placements as Tile messages',
      detail:
        'The `Place` servicer is registered on the server and `StreamTiles` streams `Tile` messages built from what the bus delivers.',
      match: {
        python: {
          all: [
            /add_PlaceServicer_to_server\(/,
            /async def StreamTiles\(/,
            /yield place_pb2\.Tile\(|context\.write\(\s*place_pb2\.Tile\(/,
          ],
        },
        typescript: {
          all: [/addService\(\s*\w+(\.\w+)*\.Place\.service/, /StreamTiles:|function streamTiles\(/, /call\.write\(/],
        },
        go: {all: [/RegisterPlaceServer\(/, /func \(\w+ \*\w+\) StreamTiles\(/, /stream\.Send\(/]},
        scala: {all: [/PlaceGrpc\.bindService\(/, /def streamTiles\(/, /out\.onNext\(|responseObserver\.onNext\(/]},
        cpp: {all: [/RegisterService\(/, /grpc::Status StreamTiles\(/, /writer->Write\(/]},
      },
    },
    {
      id: 'forward-order',
      title: 'Subscribes once and forwards every tile in order',
      detail:
        'One `subscribe()` per call; every placement the queue yields reaches the client, in the order published, with all five fields.',
      match: {
        python: {
          all: [/tile_bus\.subscribe\(\)|(?<![\w.])subscribe\(\)/, /while True:|async for/, /user\s*=/, /\bts\s*=/],
        },
        typescript: {all: [/(?<!function )subscribe\(\)/, /while\s*\(|for\s*\(;;\)/, /user:/, /\bts:/]},
        go: {all: [/(?<!func )subscribe\(\)/, /case \w+ := <-sub/, /User:/, /Ts:/]},
        scala: {all: [/(?<!def )subscribe\(\)/, /queue\.(take|poll)\(/, /while\s*\(/]},
        cpp: {all: [/(?<!Subscription )subscribe\(\)/, /sub->pop\(/, /while\s*\(/]},
      },
    },
    {
      id: 'cancel-cleanup',
      title: 'Unsubscribes when the client hangs up',
      detail:
        "Hook the call's end (`add_done_callback`, `ctx.Done()`, `setOnCancelHandler`, `IsCancelled`) and `unsubscribe` the queue from it — however the call ended.",
      match: {
        python: {all: [/add_done_callback\(|add_callback\(/, /unsubscribe\(\s*queue\s*\)/]},
        typescript: {all: [/on\(\s*['"]cancelled['"]/, /unsubscribe\(\s*queue\s*\)/]},
        go: {all: [/ctx\.Done\(\)|Context\(\)\.Done\(\)/, /defer unsubscribe\(\s*sub\s*\)/]},
        scala: {all: [/setOnCancelHandler\(|isCancelled/, /unsubscribe\(\s*queue\s*\)/]},
        cpp: {all: [/IsCancelled\(\)/, /unsubscribe\(\s*sub\s*\)/]},
      },
    },
    {
      id: 'slow-client',
      title: 'Drops a client more than MAX_LAG tiles behind',
      detail:
        'When the backlog queued for one client exceeds `MAX_LAG` (1000) the call ends with `RESOURCE_EXHAUSTED`; the server never buffers an unbounded backlog per reader.',
      match: {
        python: {all: [/qsize\(\)\s*>\s*MAX_LAG/, /StatusCode\.RESOURCE_EXHAUSTED/]},
        typescript: {all: [/queue\.size\s*>\s*MAX_LAG/, /status\.RESOURCE_EXHAUSTED/]},
        go: {all: [/len\(\s*sub\s*\)\s*>\s*maxLag/, /codes\.ResourceExhausted/]},
        scala: {all: [/queue\.size\(?\)?\s*>\s*MaxLag/, /Status\.RESOURCE_EXHAUSTED/]},
        cpp: {all: [/sub->size\(\)\s*>\s*kMaxLag/, /StatusCode::RESOURCE_EXHAUSTED/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio

import grpc

import place_pb2
import place_pb2_grpc
import tile_bus  # provided: subscribe() -> asyncio.Queue[dict], unsubscribe(queue)

MAX_LAG = 1000  # tiles a client may fall behind before it is dropped


class PlaceService(place_pb2_grpc.PlaceServicer):
    async def StreamTiles(self, request: place_pb2.Subscribe, context: grpc.aio.ServicerContext):
        # TODO: queue = tile_bus.subscribe(); context.add_done_callback → tile_bus.unsubscribe(queue)
        # TODO: loop: tile = await queue.get(); qsize() > MAX_LAG → abort RESOURCE_EXHAUSTED
        # TODO: yield place_pb2.Tile(x=, y=, color=, user=, ts=) for every tile
        await context.abort(grpc.StatusCode.UNIMPLEMENTED, "not implemented")


async def serve() -> None:
    server = grpc.aio.server()
    place_pb2_grpc.add_PlaceServicer_to_server(PlaceService(), server)
    server.add_insecure_port("[::]:9000")
    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
`,
      solution: `import asyncio

import grpc

import place_pb2
import place_pb2_grpc
import tile_bus  # provided: subscribe() -> asyncio.Queue[dict], unsubscribe(queue)

MAX_LAG = 1000  # tiles a client may fall behind before it is dropped


class PlaceService(place_pb2_grpc.PlaceServicer):
    async def StreamTiles(self, request: place_pb2.Subscribe, context: grpc.aio.ServicerContext):
        queue = tile_bus.subscribe()
        context.add_done_callback(lambda _: tile_bus.unsubscribe(queue))  # cancel, error or normal end
        while True:
            tile = await queue.get()
            if queue.qsize() > MAX_LAG:  # the client is not reading: drop it, it will refetch /board
                await context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, "client too slow; reconnect and refetch /board")
            yield place_pb2.Tile(x=tile["x"], y=tile["y"], color=tile["color"], user=tile["user"], ts=tile["ts"])


async def serve() -> None:
    server = grpc.aio.server()
    place_pb2_grpc.add_PlaceServicer_to_server(PlaceService(), server)
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
import {type TileQueue, subscribe, unsubscribe} from 'tile_bus'; // provided: subscribe() -> TileQueue, unsubscribe(queue)

export const MAX_LAG = 1000; // tiles a client may fall behind before it is dropped

interface Subscribe {
  client: string;
}

interface Tile {
  x: number;
  y: number;
  color: number;
  user: string;
  ts: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('place.proto')) as {
  place: {Place: grpc.ServiceClientConstructor};
};

/** One server stream per connected client: every placement published on this instance, in order. */
export async function streamTiles(call: grpc.ServerWritableStream<Subscribe, Tile>): Promise<void> {
  // TODO: const queue: TileQueue = subscribe(); call.on('cancelled', () => unsubscribe(queue))
  // TODO: loop: const tile = await queue.get(); queue.size > MAX_LAG → call.emit('error', {code: grpc.status.RESOURCE_EXHAUSTED, …})
  // TODO: call.write({x, y, color, user, ts}) for every tile
  call.emit('error', {code: grpc.status.UNIMPLEMENTED, details: 'not implemented'});
}

export const server = new grpc.Server();
server.addService(pkg.place.Place.service, {StreamTiles: streamTiles});

export function serve(): void {
  server.bindAsync('0.0.0.0:9000', grpc.ServerCredentials.createInsecure(), () => server.start());
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {type TileQueue, subscribe, unsubscribe} from 'tile_bus'; // provided: subscribe() -> TileQueue, unsubscribe(queue)

export const MAX_LAG = 1000; // tiles a client may fall behind before it is dropped

interface Subscribe {
  client: string;
}

interface Tile {
  x: number;
  y: number;
  color: number;
  user: string;
  ts: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('place.proto')) as {
  place: {Place: grpc.ServiceClientConstructor};
};

/** One server stream per connected client: every placement published on this instance, in order. */
export async function streamTiles(call: grpc.ServerWritableStream<Subscribe, Tile>): Promise<void> {
  const queue: TileQueue = subscribe();
  call.on('cancelled', () => unsubscribe(queue)); // the client hung up: cancel, connection drop
  try {
    while (!call.cancelled) {
      const tile = await queue.get();
      if (queue.size > MAX_LAG) {
        // the client is not reading: drop it, it will refetch /board
        call.emit('error', {code: grpc.status.RESOURCE_EXHAUSTED, details: 'client too slow; reconnect and refetch /board'});
        return;
      }
      call.write({x: tile.x, y: tile.y, color: tile.color, user: tile.user, ts: tile.ts});
    }
  } finally {
    unsubscribe(queue); // however the call ended
  }
}

export const server = new grpc.Server();
server.addService(pkg.place.Place.service, {StreamTiles: streamTiles});

export function serve(): void {
  server.bindAsync('0.0.0.0:9000', grpc.ServerCredentials.createInsecure(), () => server.start());
}
`,
    },
    go: {
      starter: `package main

import (
	"log"
	"net"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "place/gen/place"
)

const maxLag = 1000 // tiles a client may fall behind before it is dropped

// tile is what the bus delivers: the placements event.
type tile struct {
	User  string
	X     int
	Y     int
	Color int
	Ts    int64
}

// Provided (tile_bus.go): one buffered channel per open stream; publish sends to all of them.
var subscribe = func() <-chan tile { panic("not implemented") }
var unsubscribe = func(sub <-chan tile) { panic("not implemented") }

type placeServer struct {
	pb.UnimplementedPlaceServer
}

// StreamTiles forwards every placement published on this instance to one client.
func (s *placeServer) StreamTiles(req *pb.Subscribe, stream pb.Place_StreamTilesServer) error {
	// TODO: sub := subscribe(); defer unsubscribe(sub)
	// TODO: select on <-sub (len(sub) > maxLag → codes.ResourceExhausted; else stream.Send) and ctx.Done()
	return status.Error(codes.Unimplemented, "not implemented")
}

func main() {
	lis, _ := net.Listen("tcp", ":9000")
	srv := grpc.NewServer()
	pb.RegisterPlaceServer(srv, &placeServer{})
	log.Fatal(srv.Serve(lis))
}
`,
      solution: `package main

import (
	"log"
	"net"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "place/gen/place"
)

const maxLag = 1000 // tiles a client may fall behind before it is dropped

// tile is what the bus delivers: the placements event.
type tile struct {
	User  string
	X     int
	Y     int
	Color int
	Ts    int64
}

// Provided (tile_bus.go): one buffered channel per open stream; publish sends to all of them.
var subscribe = func() <-chan tile { panic("not implemented") }
var unsubscribe = func(sub <-chan tile) { panic("not implemented") }

type placeServer struct {
	pb.UnimplementedPlaceServer
}

// StreamTiles forwards every placement published on this instance to one client.
func (s *placeServer) StreamTiles(req *pb.Subscribe, stream pb.Place_StreamTilesServer) error {
	ctx := stream.Context()
	sub := subscribe()
	defer unsubscribe(sub) // runs on cancel, error or normal end
	for {
		select {
		case t := <-sub:
			if len(sub) > maxLag { // the client is not reading: drop it, it will refetch /board
				return status.Error(codes.ResourceExhausted, "client too slow; reconnect and refetch /board")
			}
			msg := &pb.Tile{X: uint32(t.X), Y: uint32(t.Y), Color: uint32(t.Color), User: t.User, Ts: t.Ts}
			if err := stream.Send(msg); err != nil {
				return err
			}
		case <-ctx.Done(): // the client hung up
			return ctx.Err()
		}
	}
}

func main() {
	lis, _ := net.Listen("tcp", ":9000")
	srv := grpc.NewServer()
	pb.RegisterPlaceServer(srv, &placeServer{})
	log.Fatal(srv.Serve(lis))
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.{BlockingQueue, TimeUnit}

import io.grpc.{ServerBuilder, Status}
import io.grpc.stub.{ServerCallStreamObserver, StreamObserver}
import place.place.{PlaceGrpc, Subscribe, Tile}
import scala.concurrent.ExecutionContext

object TileStream extends PlaceGrpc.Place {
  val MaxLag = 1000 // tiles a client may fall behind before it is dropped

  /** Provided (TileBus): one bounded queue per open stream; publish offers to all of them. */
  def subscribe(): BlockingQueue[Tile] = ???
  def unsubscribe(queue: BlockingQueue[Tile]): Unit = ???

  /** Forwards every placement published on this instance to one client. */
  override def streamTiles(request: Subscribe, responseObserver: StreamObserver[Tile]): Unit = {
    val out = responseObserver.asInstanceOf[ServerCallStreamObserver[Tile]]
    // TODO: val queue = subscribe(); out.setOnCancelHandler(() => unsubscribe(queue))
    // TODO: while !out.isCancelled: queue.poll(1, SECONDS); queue.size > MaxLag → onError(RESOURCE_EXHAUSTED); else out.onNext
    out.onError(Status.UNIMPLEMENTED.asRuntimeException())
  }

  def main(args: Array[String]): Unit =
    ServerBuilder.forPort(9000).addService(PlaceGrpc.bindService(this, ExecutionContext.global)).build().start().awaitTermination()
}
`,
      solution: `import java.util.concurrent.{BlockingQueue, TimeUnit}

import io.grpc.{ServerBuilder, Status}
import io.grpc.stub.{ServerCallStreamObserver, StreamObserver}
import place.place.{PlaceGrpc, Subscribe, Tile}
import scala.concurrent.ExecutionContext

object TileStream extends PlaceGrpc.Place {
  val MaxLag = 1000 // tiles a client may fall behind before it is dropped

  /** Provided (TileBus): one bounded queue per open stream; publish offers to all of them. */
  def subscribe(): BlockingQueue[Tile] = ???
  def unsubscribe(queue: BlockingQueue[Tile]): Unit = ???

  /** Forwards every placement published on this instance to one client. */
  override def streamTiles(request: Subscribe, responseObserver: StreamObserver[Tile]): Unit = {
    val out = responseObserver.asInstanceOf[ServerCallStreamObserver[Tile]]
    val queue = subscribe()
    out.setOnCancelHandler(() => unsubscribe(queue)) // the client hung up
    var open = true
    while (open && !out.isCancelled) {
      val tile = queue.poll(1, TimeUnit.SECONDS)
      if (tile != null) {
        if (queue.size > MaxLag) { // the client is not reading: drop it, it will refetch /board
          out.onError(Status.RESOURCE_EXHAUSTED.withDescription("client too slow; reconnect and refetch /board").asRuntimeException())
          open = false
        } else out.onNext(tile)
      }
    }
    unsubscribe(queue)
  }

  def main(args: Array[String]): Unit =
    ServerBuilder.forPort(9000).addService(PlaceGrpc.bindService(this, ExecutionContext.global)).build().start().awaitTermination()
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <memory>
#include <string>

#include "place.grpc.pb.h"
#include "tile_bus.h"  // Subscription subscribe(); void unsubscribe(const Subscription&); sub->pop(tile, timeout) / sub->size()

using place::Subscribe;
using place::Tile;

constexpr std::size_t kMaxLag = 1000;  // tiles a client may fall behind before it is dropped

class PlaceService final : public place::Place::Service {
 public:
  // Forwards every placement published on this instance to one client.
  grpc::Status StreamTiles(grpc::ServerContext* ctx, const Subscribe* request, grpc::ServerWriter<Tile>* writer) override {
    // TODO: const Subscription sub = subscribe()
    // TODO: while !ctx->IsCancelled(): sub->pop(tile, 1s); sub->size() > kMaxLag → RESOURCE_EXHAUSTED; else writer->Write
    // TODO: unsubscribe(sub) on every way out
    return grpc::Status(grpc::StatusCode::UNIMPLEMENTED, "not implemented");
  }
};

int main() {
  PlaceService service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:9000", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <memory>
#include <string>

#include "place.grpc.pb.h"
#include "tile_bus.h"  // Subscription subscribe(); void unsubscribe(const Subscription&); sub->pop(tile, timeout) / sub->size()

using place::Subscribe;
using place::Tile;

constexpr std::size_t kMaxLag = 1000;  // tiles a client may fall behind before it is dropped

class PlaceService final : public place::Place::Service {
 public:
  // Forwards every placement published on this instance to one client.
  grpc::Status StreamTiles(grpc::ServerContext* ctx, const Subscribe* request, grpc::ServerWriter<Tile>* writer) override {
    const Subscription sub = subscribe();
    Tile tile;
    while (!ctx->IsCancelled()) {
      if (!sub->pop(tile, std::chrono::seconds(1))) continue;  // nothing published: check for cancellation again
      if (sub->size() > kMaxLag) {  // the client is not reading: drop it, it will refetch /board
        unsubscribe(sub);
        return grpc::Status(grpc::StatusCode::RESOURCE_EXHAUSTED, "client too slow; reconnect and refetch /board");
      }
      if (!writer->Write(tile)) break;  // the connection dropped
    }
    unsubscribe(sub);  // the client hung up
    return ctx->IsCancelled() ? grpc::Status::CANCELLED : grpc::Status::OK;
  }
};

int main() {
  PlaceService service;
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
import importlib
import json

import grpc
from confluent_kafka import Consumer

import place_pb2
import place_pb2_grpc


async def _settle():
    for _ in range(5):
        await asyncio.sleep(0)


class _Instance:
    """One tile-stream instance as deployed: the learner's server, its bus fed from placements by the
    given pump in its own consumer group, and the real placement producer (step 3) upstream."""

    def __init__(self, ctx, m):
        self.ctx = ctx
        self.m = m
        self.bus = importlib.import_module("tile_bus")
        self.events = importlib.import_module("placement_events")
        self.feed = Consumer({"bootstrap.servers": "kafka:9092", "group.id": "tile-stream-1", "auto.offset.reset": "earliest"})
        self.feed.subscribe(["placements"])
        self.stub = place_pb2_grpc.PlaceStub(grpc.aio.insecure_channel("tile-stream:9000"))

    def pump(self):
        """The instance consumes everything on placements and publishes it on its bus."""
        self.ctx.drain(self.bus.pump, self.feed)

    def placed(self):
        return [json.loads(r.value) for r in self.ctx.kafka.records("placements")]


async def _start(ctx):
    m = ctx.load("tile_stream")
    asyncio.create_task(m.serve())
    await asyncio.sleep(0)
    assert ctx.grpc.find("/place.Place/StreamTiles") is not None, "serve() registered no StreamTiles handler"
    return _Instance(ctx, m)


async def _open(stub, client="web"):
    call = stub.StreamTiles(place_pb2.Subscribe(client=client))
    await _settle()
    return call


async def check_serve_stream(ctx):
    place = await _start(ctx)
    call = await _open(place.stub)
    assert not call.done(), f"a fresh StreamTiles call must stay open waiting for tiles, but it ended with {await call.code()}"
    place.events.record_placement("ana", 3, 7, 12)
    place.pump()
    want = place.placed()[0]
    got = await asyncio.wait_for(call.read(), 1.0)
    assert isinstance(got, place_pb2.Tile), f"the stream must carry Tile messages, got {type(got).__name__}"
    assert (got.x, got.y, got.color, got.user, got.ts) == (3, 7, 12, "ana", want["ts"]), f"the Tile is {got!r}, expected x=3 y=7 color=12 user='ana' ts={want['ts']}"


async def check_forward_order(ctx):
    place = await _start(ctx)
    call = await _open(place.stub)
    assert place.bus.subscribers() == 1, f"one open call must mean one subscription, found {place.bus.subscribers()}"
    other = await _open(place.stub, "mobile")
    assert place.bus.subscribers() == 2, f"two open calls must mean two subscriptions, found {place.bus.subscribers()}"
    for i, user in enumerate(("ana", "bo", "cy")):  # three tiles on one pixel: one partition, one order
        place.events.record_placement(user, 3, 7, i + 1)
        ctx.clock.advance(1)
    place.pump()
    want = [(e["user"], e["x"], e["y"], e["color"], e["ts"]) for e in place.placed()]
    for stream, name in ((call, "web"), (other, "mobile")):
        got = [await asyncio.wait_for(stream.read(), 1.0) for _ in range(3)]
        assert [t.user for t in got] == ["ana", "bo", "cy"], f"client {name} received {[t.user for t in got]}, expected ana, bo, cy in publish order"
        assert [(t.user, t.x, t.y, t.color, t.ts) for t in got] == want, f"client {name} received {got!r}: every field of every tile must be forwarded, expected {want}"
    assert place.bus.subscribers() == 2, f"after forwarding three tiles the bus has {place.bus.subscribers()} subscription(s), expected still 2: subscribe once per call, not per tile"


async def check_cancel_cleanup(ctx):
    place = await _start(ctx)
    call = await _open(place.stub)
    assert place.bus.subscribers() == 1, f"after the call opened the bus has {place.bus.subscribers()} subscription(s), expected 1 (subscribe())"
    call.cancel()
    await _settle()
    n = place.bus.subscribers()
    assert n == 0, f"the client hung up but the bus still has {n} subscription(s): unsubscribe from the call's done callback"
    place.events.record_placement("ana", 3, 7, 12)
    place.pump()  # must not reach anyone, must not raise
    second = await _open(place.stub, "mobile")
    assert place.bus.subscribers() == 1, "a new call after a cancelled one subscribes afresh"
    place.events.record_placement("bo", 4, 7, 1)
    place.pump()
    got = await asyncio.wait_for(second.read(), 1.0)
    assert got.user == "bo", f"the new client must only see tiles published after it subscribed, got {got!r}"


async def check_slow_client(ctx):
    place = await _start(ctx)
    call = await _open(place.stub)
    lag = place.m.MAX_LAG
    for i in range(lag):  # tiles from the other place-api instances, all on one pixel: one partition, one order
        ctx.kafka.seed("placements", key="3:7", value=json.dumps({"user": "ana", "x": 3, "y": 7, "color": i % 16, "ts": 1700000000000 + i}))
    place.pump()
    got = [await asyncio.wait_for(call.read(), 1.0) for _ in range(lag)]
    assert [t.ts for t in got] == [1700000000000 + i for i in range(lag)], "a backlog of exactly MAX_LAG tiles is still delivered in order"
    assert not call.done(), "a client that caught up stays connected"
    for i in range(lag + 2):
        ctx.kafka.seed("placements", key="3:7", value=json.dumps({"user": "ana", "x": 3, "y": 7, "color": 12, "ts": 1800000000000 + i}))
    place.pump()
    await _settle()
    try:
        while True:
            await asyncio.wait_for(call.read(), 1.0)
    except grpc.RpcError as e:
        assert e.code() == grpc.StatusCode.RESOURCE_EXHAUSTED, f"a client more than MAX_LAG tiles behind was ended with {e.code()}, expected RESOURCE_EXHAUSTED"
    except asyncio.TimeoutError:
        raise AssertionError("a client more than MAX_LAG tiles behind must be dropped with RESOURCE_EXHAUSTED, but the stream stayed open")
    await _settle()
    assert place.bus.subscribers() == 0, f"a dropped client must be unsubscribed, the bus still has {place.bus.subscribers()} subscription(s)"
`,
    typescript: `import * as grpc from '@grpc/grpc-js';
import {Kafka} from 'kafkajs';

interface Tile {
  x: number;
  y: number;
  color: number;
  user: string;
  ts: string;
}

/** Let the stream's microtasks (queue → handler → client) run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const {promise, resolve} = Promise.withResolvers<void>();
    setTimeout(resolve, 0);
    await promise;
  }
}

/** One tile-stream instance as deployed: the learner's server, its bus fed from placements by the given pump in its own consumer group, and the real placement producer (step 3) upstream. */
async function start(ctx) {
  const m = ctx.load('tile_stream');
  m.serve();
  const bus = ctx.load('/support/tile_bus.ts');
  const events = ctx.load('placement_events');
  const feed = new Kafka({clientId: 'tile-stream-1', brokers: ['kafka:9092']}).consumer({groupId: 'tile-stream-1'});
  await feed.connect();
  await feed.subscribe({topic: 'placements', fromBeginning: true});
  const pkg = ctx.proto('place.proto');
  const stub = new pkg.place.Place('tile-stream:9000', grpc.credentials.createInsecure());
  return {
    m,
    bus,
    events,
    stub,
    /** The instance consumes everything on placements and publishes it on its bus. */
    pump: async () => {
      await ctx.drain(bus.pump(feed));
      await settle();
    },
    placed: (): Record<string, unknown>[] => ctx.kafka.values('placements').map((v: string) => JSON.parse(v)),
  };
}

/** An open StreamTiles call: what it received so far and how it ended (null while open). */
async function open(stub, client = 'web') {
  const call = stub.StreamTiles({client});
  const got: Tile[] = [];
  let status: {code: number; details: string} | null = null;
  call.on('data', (tile: Tile) => got.push(tile));
  call.on('error', () => undefined);
  call.on('status', (s: {code: number; details: string}) => (status = s));
  await settle();
  assert(status === null || status.code !== grpc.status.UNAVAILABLE, 'serve() registered no StreamTiles handler');
  return {
    call,
    got,
    get status() {
      return status;
    },
  };
}

const name = (code: number): string => Object.keys(grpc.status).find(k => grpc.status[k] === code) ?? String(code);

export async function check_serve_stream(ctx) {
  const place = await start(ctx);
  const call = await open(place.stub);
  assert.equal(call.status, null, \`a fresh StreamTiles call must stay open waiting for tiles, but it ended with \${call.status && name(call.status.code)}\`);
  place.events.recordPlacement('ana', 3, 7, 12);
  await place.pump();
  const want = place.placed()[0];
  assert.equal(call.got.length, 1, \`the client must receive the one placement published, got \${call.got.length} Tile(s)\`);
  const got = call.got[0];
  assert.deepEqual([got.x, got.y, got.color, got.user, Number(got.ts)], [3, 7, 12, 'ana', want.ts], \`the Tile is \${JSON.stringify(got)}, expected x=3 y=7 color=12 user='ana' ts=\${want.ts}\`);
}

export async function check_forward_order(ctx) {
  const place = await start(ctx);
  const call = await open(place.stub);
  assert.equal(place.bus.subscribers(), 1, \`one open call must mean one subscription, found \${place.bus.subscribers()}\`);
  const other = await open(place.stub, 'mobile');
  assert.equal(place.bus.subscribers(), 2, \`two open calls must mean two subscriptions, found \${place.bus.subscribers()}\`);
  for (const [i, user] of ['ana', 'bo', 'cy'].entries()) {
    // three tiles on one pixel: one partition, one order
    place.events.recordPlacement(user, 3, 7, i + 1);
    ctx.clock.advance(1);
  }
  await place.pump();
  const want = place.placed().map(e => [e.user, e.x, e.y, e.color, e.ts]);
  for (const [stream, label] of [[call, 'web'], [other, 'mobile']] as const) {
    const users = stream.got.map(t => t.user);
    assert.deepEqual(users, ['ana', 'bo', 'cy'], \`client \${label} received \${JSON.stringify(users)}, expected ana, bo, cy in publish order\`);
    const fields = stream.got.map(t => [t.user, t.x, t.y, t.color, Number(t.ts)]);
    assert.deepEqual(fields, want, \`client \${label} received \${JSON.stringify(stream.got)}: every field of every tile must be forwarded, expected \${JSON.stringify(want)}\`);
  }
  assert.equal(place.bus.subscribers(), 2, \`after forwarding three tiles the bus has \${place.bus.subscribers()} subscription(s), expected still 2: subscribe once per call, not per tile\`);
}

export async function check_cancel_cleanup(ctx) {
  const place = await start(ctx);
  const call = await open(place.stub);
  assert.equal(place.bus.subscribers(), 1, \`after the call opened the bus has \${place.bus.subscribers()} subscription(s), expected 1 (subscribe())\`);
  call.call.cancel();
  await settle();
  const n = place.bus.subscribers();
  assert.equal(n, 0, \`the client hung up but the bus still has \${n} subscription(s): unsubscribe from the call's cancelled event\`);
  place.events.recordPlacement('ana', 3, 7, 12);
  await place.pump(); // must not reach anyone, must not throw
  const second = await open(place.stub, 'mobile');
  assert.equal(place.bus.subscribers(), 1, 'a new call after a cancelled one subscribes afresh');
  place.events.recordPlacement('bo', 4, 7, 1);
  await place.pump();
  assert.equal(second.got.length, 1, \`the new client must receive bo's tile, got \${second.got.length} Tile(s)\`);
  assert.equal(second.got[0].user, 'bo', \`the new client must only see tiles published after it subscribed, got \${JSON.stringify(second.got[0])}\`);
}

export async function check_slow_client(ctx) {
  const place = await start(ctx);
  const call = await open(place.stub);
  const lag: number = place.m.MAX_LAG;
  // Tiles from the other place-api instances arrive in one burst while the stream server is busy.
  for (let i = 0; i < lag; i++) place.bus.publish({user: 'ana', x: 3, y: 7, color: i % 16, ts: 1700000000000 + i});
  await settle();
  assert.deepEqual(call.got.map(t => Number(t.ts)), Array.from({length: lag}, (_, i) => 1700000000000 + i), 'a backlog of exactly MAX_LAG tiles is still delivered in order');
  assert.equal(call.status, null, 'a client that caught up stays connected');
  for (let i = 0; i < lag + 2; i++) place.bus.publish({user: 'ana', x: 3, y: 7, color: 12, ts: 1800000000000 + i});
  await settle();
  assert(call.status !== null, 'a client more than MAX_LAG tiles behind must be dropped with RESOURCE_EXHAUSTED, but the stream stayed open');
  assert.equal(call.status.code, grpc.status.RESOURCE_EXHAUSTED, \`a client more than MAX_LAG tiles behind was ended with \${name(call.status.code)}, expected RESOURCE_EXHAUSTED\`);
  await settle();
  assert.equal(place.bus.subscribers(), 0, \`a dropped client must be unsubscribed, the bus still has \${place.bus.subscribers()} subscription(s)\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"leetbuild/harness"

	pb "place/gen/place"
)

// stEvent is a placements event, and the five fields of a Tile.
type stEvent struct {
	User  string \`json:"user"\`
	X     int    \`json:"x"\`
	Y     int    \`json:"y"\`
	Color int    \`json:"color"\`
	Ts    int64  \`json:"ts"\`
}

// stPlace is one tile-stream instance as deployed: the learner's server, its bus fed from
// placements, and step 3's producer upstream.
type stPlace struct {
	ctx       *harness.Ctx
	mu        sync.Mutex
	subs      []chan tile
	published int // records of placements already pumped onto the bus
	client    pb.PlaceClient
}

func stStart(ctx *harness.Ctx) *stPlace {
	p := &stPlace{ctx: ctx}
	subscribe = func() <-chan tile {
		sub := make(chan tile, 4096)
		p.mu.Lock()
		defer p.mu.Unlock()
		p.subs = append(p.subs, sub)
		return sub
	}
	unsubscribe = func(sub <-chan tile) {
		p.mu.Lock()
		defer p.mu.Unlock()
		for i, s := range p.subs {
			if (<-chan tile)(s) == sub {
				p.subs = append(p.subs[:i], p.subs[i+1:]...)
				return
			}
		}
	}
	ctx.Main(main)
	p.client = pb.NewPlaceClient(ctx.GRPC.Dial("tile-stream:9000"))
	return p
}

// publish hands a placement to every open stream on this instance.
func (p *stPlace) publish(t tile) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, sub := range p.subs {
		sub <- t
	}
}

func (p *stPlace) subscribers() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.subs)
}

// recordPlacement is step 3's producer: one JSON record on placements, keyed by the tile.
func (p *stPlace) recordPlacement(user string, x, y, color int) {
	value, _ := json.Marshal(stEvent{User: user, X: x, Y: y, Color: color, Ts: p.ctx.Clock.Now()})
	p.ctx.Kafka.Seed("placements", fmt.Sprintf("%d:%d", x, y), value)
}

// placed is every event on placements.
func (p *stPlace) placed() []stEvent {
	out := []stEvent{}
	for _, v := range p.ctx.Kafka.Values("placements") {
		var e stEvent
		p.ctx.NoError(json.Unmarshal([]byte(v), &e), "a placements record is not JSON: %q", v)
		out = append(out, e)
	}
	return out
}

// pump: the instance consumes what is new on placements, publishes it on its bus, and the streams forward it.
func (p *stPlace) pump() {
	events := p.placed()
	for _, e := range events[p.published:] {
		p.publish(tile{User: e.User, X: e.X, Y: e.Y, Color: e.Color, Ts: e.Ts})
	}
	p.published = len(events)
	p.ctx.Settle()
}

// stCall is an open StreamTiles call: what it received so far and how it ended.
type stCall struct {
	mu     sync.Mutex
	got    []stEvent
	ended  bool
	err    error
	cancel context.CancelFunc
}

func (c *stCall) received() []stEvent {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]stEvent{}, c.got...)
}

// end is whether the call ended, and its status code.
func (c *stCall) end() (bool, codes.Code) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ended, status.Code(c.err)
}

func (p *stPlace) open(client string) *stCall {
	callCtx, cancel := context.WithCancel(context.Background())
	call := &stCall{cancel: cancel}
	stream, err := p.client.StreamTiles(callCtx, &pb.Subscribe{Client: client})
	if err != nil {
		call.ended, call.err = true, err
	} else {
		go func() {
			for {
				t, err := stream.Recv()
				call.mu.Lock()
				if err != nil {
					call.ended, call.err = true, err
					call.mu.Unlock()
					return
				}
				call.got = append(call.got, stEvent{User: t.GetUser(), X: int(t.GetX()), Y: int(t.GetY()), Color: int(t.GetColor()), Ts: t.GetTs()})
				call.mu.Unlock()
			}
		}()
	}
	p.ctx.Settle()
	ended, code := call.end()
	p.ctx.Assert(!ended || code != codes.Unavailable, "main serves no StreamTiles handler on :9000")
	return call
}

func CheckServeStream(ctx *harness.Ctx) {
	place := stStart(ctx)
	call := place.open("web")
	ended, code := call.end()
	ctx.Assert(!ended, "a fresh StreamTiles call must stay open waiting for tiles, but it ended with %v", code)
	place.recordPlacement("ana", 3, 7, 12)
	place.pump()
	want := place.placed()[0]
	got := call.received()
	ctx.Equal(len(got), 1, "the client must receive the one placement published: the Tiles received")
	ctx.Equal(got[0], stEvent{User: "ana", X: 3, Y: 7, Color: 12, Ts: want.Ts}, "the Tile")
}

func CheckForwardOrder(ctx *harness.Ctx) {
	place := stStart(ctx)
	call := place.open("web")
	ctx.Equal(place.subscribers(), 1, "one open call must mean one subscription: the subscriptions")
	other := place.open("mobile")
	ctx.Equal(place.subscribers(), 2, "two open calls must mean two subscriptions: the subscriptions")
	for i, user := range []string{"ana", "bo", "cy"} {
		// three tiles on one pixel: one partition, one order
		place.recordPlacement(user, 3, 7, i+1)
		ctx.Clock.Advance(1)
	}
	place.pump()
	want := place.placed()
	for _, stream := range []struct {
		call  *stCall
		label string
	}{{call, "web"}, {other, "mobile"}} {
		got := stream.call.received()
		users := []string{}
		for _, t := range got {
			users = append(users, t.User)
		}
		ctx.Equal(users, []string{"ana", "bo", "cy"}, "client %s must receive ana, bo, cy in publish order", stream.label)
		ctx.Equal(got, want, "client %s: every field of every tile must be forwarded", stream.label)
	}
	ctx.Equal(place.subscribers(), 2, "after forwarding three tiles the bus must still have 2 subscriptions: subscribe once per call, not per tile")
}

func CheckCancelCleanup(ctx *harness.Ctx) {
	place := stStart(ctx)
	call := place.open("web")
	ctx.Equal(place.subscribers(), 1, "after the call opened the bus must have 1 subscription (subscribe())")
	call.cancel()
	ctx.Settle()
	n := place.subscribers()
	ctx.Assert(n == 0, "the client hung up but the bus still has %d subscription(s): unsubscribe when the call's context is done", n)
	place.recordPlacement("ana", 3, 7, 12)
	place.pump() // must not reach anyone, must not fail
	second := place.open("mobile")
	ctx.Equal(place.subscribers(), 1, "a new call after a cancelled one subscribes afresh: the subscriptions")
	place.recordPlacement("bo", 4, 7, 1)
	place.pump()
	got := second.received()
	ctx.Equal(len(got), 1, "the new client must receive bo's tile: the Tiles received")
	ctx.Equal(got[0].User, "bo", "the new client must only see tiles published after it subscribed: the user of its Tile")
}

func CheckSlowClient(ctx *harness.Ctx) {
	place := stStart(ctx)
	call := place.open("web")
	lag := maxLag
	// Tiles from the other place-api instances arrive in one burst while the stream server is busy.
	for i := 0; i < lag; i++ {
		place.publish(tile{User: "ana", X: 3, Y: 7, Color: i % 16, Ts: 1700000000000 + int64(i)})
	}
	ctx.Settle()
	want := make([]int64, lag)
	for i := range want {
		want[i] = 1700000000000 + int64(i)
	}
	got := []int64{}
	for _, t := range call.received() {
		got = append(got, t.Ts)
	}
	ctx.Assert(fmt.Sprint(got) == fmt.Sprint(want), "a backlog of exactly maxLag tiles must still be delivered in order: received %d Tiles", len(got))
	ended, code := call.end()
	ctx.Assert(!ended, "a client that caught up stays connected, but the call ended with %v", code)
	for i := 0; i < lag+2; i++ {
		place.publish(tile{User: "ana", X: 3, Y: 7, Color: 12, Ts: 1800000000000 + int64(i)})
	}
	ctx.Settle()
	ended, code = call.end()
	ctx.Assert(ended, "a client more than maxLag tiles behind must be dropped with ResourceExhausted, but the stream stayed open")
	ctx.Equal(code, codes.ResourceExhausted, "the status of a client more than maxLag tiles behind")
	ctx.Settle()
	n := place.subscribers()
	ctx.Assert(n == 0, "a dropped client must be unsubscribed, the bus still has %d subscription(s)", n)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

namespace {

// stEvent is a placements event, and the five fields of a Tile.
struct stEvent {
  std::string User;
  int X = 0, Y = 0, Color = 0;
  int64_t Ts = 0;
  bool operator==(const stEvent& o) const { return User == o.User && X == o.X && Y == o.Y && Color == o.Color && Ts == o.Ts; }
  friend std::ostream& operator<<(std::ostream& out, const stEvent& e) {
    return out << "{User:" << e.User << " X:" << e.X << " Y:" << e.Y << " Color:" << e.Color << " Ts:" << e.Ts << "}";
  }
};

// stSettle lets the world settle with a few seconds of virtual time at most: the stream handler
// polls its subscription every second (Go's handler blocks on a channel and the call's context, with
// no clock involved), so an unbounded settle would spend the check's whole sleep budget.
void stSettle(harness::Ctx& ctx) {
  ctx.Clock.SetSleepLimit(ctx.Clock.Sleeps() + 3);
  ctx.Settle();
}

// stCall is an open StreamTiles call: what it received so far and how it ended. A thread of its
// own reads the stream (Go's receiving goroutine).
struct stCall {
  grpc::ClientContext context;
  std::unique_ptr<grpc::ClientReader<place::Tile>> stream;
  std::mutex mu;
  std::vector<stEvent> got;
  std::optional<grpc::StatusCode> code;  // set once the call ended

  std::vector<stEvent> received() {
    std::lock_guard<std::mutex> lock(mu);
    return got;
  }
  // How the call ended, nullopt while it is open.
  std::optional<grpc::StatusCode> end() {
    std::lock_guard<std::mutex> lock(mu);
    return code;
  }
  void cancel() { context.TryCancel(); }
};

// stPlace is one tile-stream instance as deployed: the learner's server, its bus (tile_bus.h) fed
// from placements, and step 3's producer upstream.
struct stPlace {
  harness::Ctx& ctx;
  std::unique_ptr<place::Place::Stub> client;
  size_t published = 0;  // records of placements already pumped onto the bus

  // record_placement is step 3's producer: one JSON record on placements, keyed by the tile.
  void recordPlacement(const std::string& user, int x, int y, int color) {
    const nlohmann::json value = {{"user", user}, {"x", x}, {"y", y}, {"color", color}, {"ts", ctx.Clock.Now()}};
    ctx.Kafka.Seed("placements", std::to_string(x) + ":" + std::to_string(y), value.dump());
  }

  // placed is every event on placements.
  std::vector<stEvent> placed() {
    std::vector<stEvent> out;
    for (const auto& v : ctx.Kafka.Values("placements")) {
      const auto e = nlohmann::json::parse(v, nullptr, false);
      ctx.Assert(e.is_object(), "a placements record is not JSON: %q", v);
      out.push_back({e.value("user", ""), e.value("x", 0), e.value("y", 0), e.value("color", 0), e.value("ts", int64_t{0})});
    }
    return out;
  }

  // pump: the instance consumes what is new on placements, publishes it on its bus, and the streams forward it.
  void pump() {
    const auto events = placed();
    for (size_t i = published; i < events.size(); i++) publish(stTile(events[i]));
    published = events.size();
    stSettle(ctx);
  }

  static place::Tile stTile(const stEvent& e) {
    place::Tile t;
    t.set_user(e.User);
    t.set_x(e.X);
    t.set_y(e.Y);
    t.set_color(e.Color);
    t.set_ts(e.Ts);
    return t;
  }

  std::shared_ptr<stCall> open(const std::string& name) {
    auto call = std::make_shared<stCall>();
    place::Subscribe req;
    req.set_client(name);
    call->stream = client->StreamTiles(&call->context, req);
    std::thread([call] {
      place::Tile t;
      while (call->stream->Read(&t)) {
        std::lock_guard<std::mutex> lock(call->mu);
        call->got.push_back({t.user(), static_cast<int>(t.x()), static_cast<int>(t.y()), static_cast<int>(t.color()), t.ts()});
      }
      const grpc::Status st = call->stream->Finish();
      std::lock_guard<std::mutex> lock(call->mu);
      call->code = st.error_code();
    }).detach();
    stSettle(ctx);
    const auto code = call->end();
    ctx.Assert(!code || *code != grpc::StatusCode::UNAVAILABLE, "main serves no StreamTiles handler on :9000");
    return call;
  }
};

stPlace stStart(harness::Ctx& ctx) {
  ctx.Main();
  return stPlace{ctx, place::Place::NewStub(ctx.GRPC.Dial("tile-stream:9000"))};
}

place::Tile stMake(const std::string& user, int x, int y, int color, int64_t ts) {
  return stPlace::stTile({user, x, y, color, ts});
}

}  // namespace

void CheckServeStream(harness::Ctx& ctx) {
  auto place = stStart(ctx);
  auto call = place.open("web");
  const auto code = call->end();
  ctx.Assert(!code, "a fresh StreamTiles call must stay open waiting for tiles, but it ended with %v", code);
  place.recordPlacement("ana", 3, 7, 12);
  place.pump();
  const stEvent want = place.placed()[0];
  const auto got = call->received();
  ctx.Equal(got.size(), 1, "the client must receive the one placement published: the Tiles received");
  ctx.Equal(got[0], stEvent{"ana", 3, 7, 12, want.Ts}, "the Tile");
}

void CheckForwardOrder(harness::Ctx& ctx) {
  auto place = stStart(ctx);
  auto call = place.open("web");
  ctx.Equal(subscribers(), 1, "one open call must mean one subscription: the subscriptions");
  auto other = place.open("mobile");
  ctx.Equal(subscribers(), 2, "two open calls must mean two subscriptions: the subscriptions");
  const std::vector<std::string> names = {"ana", "bo", "cy"};
  for (size_t i = 0; i < names.size(); i++) {
    // three tiles on one pixel: one partition, one order
    place.recordPlacement(names[i], 3, 7, static_cast<int>(i) + 1);
    ctx.Clock.Advance(1);
  }
  place.pump();
  const auto want = place.placed();
  for (const auto& [stream, label] : std::vector<std::pair<std::shared_ptr<stCall>, std::string>>{{call, "web"}, {other, "mobile"}}) {
    const auto got = stream->received();
    std::vector<std::string> users;
    for (const auto& t : got) users.push_back(t.User);
    ctx.Equal(users, names, "client %s must receive ana, bo, cy in publish order", label);
    ctx.Equal(got, want, "client %s: every field of every tile must be forwarded", label);
  }
  ctx.Equal(subscribers(), 2, "after forwarding three tiles the bus must still have 2 subscriptions: subscribe once per call, not per tile");
}

void CheckCancelCleanup(harness::Ctx& ctx) {
  auto place = stStart(ctx);
  auto call = place.open("web");
  ctx.Equal(subscribers(), 1, "after the call opened the bus must have 1 subscription (subscribe())");
  call->cancel();
  stSettle(ctx);
  const size_t n = subscribers();
  ctx.Assert(n == 0, "the client hung up but the bus still has %d subscription(s): unsubscribe when the call is cancelled", n);
  place.recordPlacement("ana", 3, 7, 12);
  place.pump();  // must not reach anyone, must not fail
  auto second = place.open("mobile");
  ctx.Equal(subscribers(), 1, "a new call after a cancelled one subscribes afresh: the subscriptions");
  place.recordPlacement("bo", 4, 7, 1);
  place.pump();
  const auto got = second->received();
  ctx.Equal(got.size(), 1, "the new client must receive bo's tile: the Tiles received");
  ctx.Equal(got[0].User, "bo", "the new client must only see tiles published after it subscribed: the user of its Tile");
}

void CheckSlowClient(harness::Ctx& ctx) {
  auto place = stStart(ctx);
  auto call = place.open("web");
  const int lag = static_cast<int>(kMaxLag);
  // Tiles from the other place-api instances arrive in one burst while the stream server is busy.
  for (int i = 0; i < lag; i++) publish(stMake("ana", 3, 7, i % 16, 1700000000000LL + i));
  stSettle(ctx);
  std::vector<int64_t> want(lag);
  for (int i = 0; i < lag; i++) want[i] = 1700000000000LL + i;
  std::vector<int64_t> got;
  for (const auto& t : call->received()) got.push_back(t.Ts);
  ctx.Assert(got == want, "a backlog of exactly kMaxLag tiles must still be delivered in order: received %d Tiles", got.size());
  auto code = call->end();
  ctx.Assert(!code, "a client that caught up stays connected, but the call ended with %v", code);
  for (int i = 0; i < lag + 2; i++) publish(stMake("ana", 3, 7, 12, 1800000000000LL + i));
  stSettle(ctx);
  code = call->end();
  ctx.Assert(code.has_value(), "a client more than kMaxLag tiles behind must be dropped with RESOURCE_EXHAUSTED, but the stream stayed open");
  ctx.Equal(*code, grpc::StatusCode::RESOURCE_EXHAUSTED, "the status of a client more than kMaxLag tiles behind");
  stSettle(ctx);
  const size_t n = subscribers();
  ctx.Assert(n == 0, "a dropped client must be unsubscribed, the bus still has %d subscription(s)", n);
}
`,
  },
  debrief: `A server stream is the gRPC shape of "tell me everything from now on": one request, an open HTTP/2 stream, messages pushed as they happen. The handler is a loop around a queue, and the two rules around it are what make it survive at 80 000 clients: the done callback guarantees every subscription dies with its call, whatever killed it, and the lag cap turns a slow reader from a memory leak into a reconnect — cheap, because the catch-up path is a single cached \`GET /board\`. That is also why the client opens the stream before it fetches the board: a snapshot plus every change since before the snapshot is consistent, and nothing is lost in between. Reddit ran 24 websocket instances pushing 4 Gbps of tiny messages and found the boxes CPU-bound, not network-bound — per-message work, not bytes, is the cost of fan-out; real deployments batch tiles per 50 ms frame, exactly as the browser batched draws per animation frame.`,
};
