import type {Step} from '@/lib/types';

export const streamTicksStep: Step = {
  id: 'stream-ticks',
  title: 'Stream ticks over gRPC: snapshot, then Pub/Sub',
  concept: 'grpc',
  file: 'tick_stream',
  focus: ['redis', 'ticks', 'client'],
  task: `## Task

Market-data clients subscribe to a symbol and receive a stream of ticks. The service contract:

\`\`\`proto
service TickService {
  rpc SubscribeTicks(SubscribeRequest) returns (stream Tick);
}
message SubscribeRequest { string symbol = 1; }
message Tick { string symbol = 1; double bid = 2; double ask = 3; double last = 4; }
\`\`\`

Implement \`SubscribeTicks\` on the provided server skeleton (\`to_tick(symbol, fields)\` builds a \`Tick\` from
the hash fields; the tick JSON published in the previous step maps 1:1 onto \`Tick\`):

- Send a **snapshot first**: \`HGETALL book:{symbol}\`, converted to one \`Tick\`. A client must never wait for
  the next trade to learn the current price.
- An empty hash means the symbol does not exist → end the call with status **\`NOT_FOUND\`**.
- Then **subscribe** to \`ticks:{symbol}\` and forward every message as a \`Tick\`.
- Stop when the client goes away — poll the call's cancellation (\`context.cancelled()\`, \`ctx.Done()\`,
  \`isCancelled\`, \`IsCancelled()\`) — and **unsubscribe** so the Redis connection is released.

:::widget grpc-streams {"mode": "server"}`,
  sequence: {
    participants: ['Client', 'ticks', 'Redis'],
    messages: [
      {from: 'Client', to: 'ticks', label: 'SubscribeTicks{symbol: ACME}', kind: 'sync'},
      {from: 'ticks', to: 'Redis', label: 'HGETALL book:ACME', kind: 'sync'},
      {from: 'Redis', to: 'ticks', label: '{bid, ask, last}', kind: 'reply'},
      {from: 'ticks', to: 'Client', label: 'Tick (snapshot)', kind: 'reply'},
      {from: 'ticks', to: 'Redis', label: 'SUBSCRIBE ticks:ACME', kind: 'sync'},
      {from: 'Redis', to: 'ticks', label: 'message {"symbol":"ACME",…}', kind: 'async'},
      {from: 'ticks', to: 'Client', label: 'Tick', kind: 'reply'},
    ],
  },
  hints: [
    'Three phases in order: read the hash and send it (or fail with NOT_FOUND), open the subscription, loop. The snapshot must be sent before you subscribe, not after.',
    'The loop condition is the call’s liveness, not the subscription’s: wake up regularly (a receive timeout or a select on the context) so a client that disconnected on a quiet symbol is noticed within a second.',
    'Unsubscribing belongs in a `finally`/`defer`/scope exit so it runs on cancellation, on a send error and on normal completion alike.',
  ],
  checks: [
    {
      id: 'snapshot-first',
      title: 'Sends a snapshot from the hash before subscribing',
      detail:
        'HGETALL `book:{symbol}` and send it as the first Tick, then subscribe: a late subscriber sees the current price immediately.',
      match: {
        python: {
          all: [/f"book:\{symbol\}"/],
          order: [/\.hgetall\(/, /yield to_tick\(/, /\.subscribe\(/],
        },
        typescript: {
          all: [/`book:\$\{symbol\}`|['"]book:['"]\s*\+\s*symbol/],
          order: [/\.hgetall\(/, /call\.write\(\s*toTick\(/, /\.subscribe\(/],
        },
        go: {
          all: [/"book:"\s*\+\s*symbol/],
          order: [/rdb\.HGetAll\(\s*ctx\s*,/, /stream\.Send\(\s*toTick\(/, /rdb\.Subscribe\(/],
        },
        scala: {
          all: [/s"book:\$symbol"/],
          order: [/\.hgetAll\(/, /observer\.onNext\(\s*toTick\(/, /jedis\.subscribe\(/],
        },
        cpp: {
          all: [/"book:"\s*\+\s*symbol/],
          order: [/redis\.hgetall\(/, /writer->Write\(\s*to_tick\(/, /sub\.subscribe\(/],
        },
      },
    },
    {
      id: 'not-found',
      title: 'Ends with NOT_FOUND for an unknown symbol',
      detail:
        'An empty hash means no such book; the call must end with the `NOT_FOUND` status rather than an empty stream.',
      match: {
        python: {all: [/StatusCode\.NOT_FOUND/]},
        typescript: {all: [/status\.NOT_FOUND/]},
        go: {all: [/codes\.NotFound/]},
        scala: {all: [/Status\.NOT_FOUND/, /onError\(/]},
        cpp: {all: [/StatusCode::NOT_FOUND/]},
      },
    },
    {
      id: 'forward',
      title: 'Forwards every Pub/Sub message as a Tick',
      detail: 'Subscribe to `ticks:{symbol}` and turn each message into a Tick on the stream.',
      match: {
        python: {all: [/f"ticks:\{symbol\}"/, /\.subscribe\(/, /get_message\(|\.listen\(\)/]},
        typescript: {
          all: [/`ticks:\$\{symbol\}`|['"]ticks:['"]\s*\+\s*symbol/, /\.subscribe\(/, /on\(\s*['"]message['"]/],
        },
        go: {all: [/"ticks:"\s*\+\s*symbol/, /rdb\.Subscribe\(\s*ctx\s*,/, /sub\.Channel\(\)|sub\.ReceiveMessage\(/]},
        scala: {all: [/s"ticks:\$symbol"/, /jedis\.subscribe\(/, /onMessage\(/]},
        cpp: {all: [/"ticks:"\s*\+\s*symbol/, /sub\.subscribe\(/, /on_message\(/, /sub\.consume\(\)/]},
      },
    },
    {
      id: 'cancel',
      title: 'Stops and unsubscribes when the client goes away',
      detail:
        'Check the call’s cancellation on every iteration and unsubscribe on the way out; otherwise every disconnected client leaks a Redis connection.',
      match: {
        python: {all: [/context\.cancelled\(\)|context\.done\(\)/, /\.unsubscribe\(/]},
        typescript: {all: [/call\.on\(\s*['"]cancelled['"]|call\.cancelled/, /\.unsubscribe\(/]},
        go: {all: [/<-ctx\.Done\(\)/, /sub\.Close\(\)|sub\.Unsubscribe\(/]},
        scala: {all: [/observer\.isCancelled/, /unsubscribe\(\)/]},
        cpp: {all: [/context->IsCancelled\(\)/, /sub\.unsubscribe\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import grpc
import redis.asyncio as redis

import ticks_pb2
import ticks_pb2_grpc

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def to_tick(symbol: str, fields: dict) -> ticks_pb2.Tick:
    price = lambda name: float(fields.get(name, 0))
    return ticks_pb2.Tick(symbol=symbol, bid=price("bid"), ask=price("ask"), last=price("last"))


class TickService(ticks_pb2_grpc.TickServiceServicer):
    async def SubscribeTicks(self, request: ticks_pb2.SubscribeRequest, context: grpc.aio.ServicerContext):
        symbol = request.symbol
        # TODO: HGETALL book:{symbol}; empty → context.abort(NOT_FOUND)
        # TODO: yield to_tick(symbol, snapshot) first
        # TODO: pubsub = r.pubsub(); subscribe ticks:{symbol}; yield a Tick per message while not context.cancelled()
        # TODO: finally: unsubscribe and close the pubsub
        _ = json.loads
        await context.abort(grpc.StatusCode.UNIMPLEMENTED, "not implemented")


async def serve() -> None:
    server = grpc.aio.server()
    ticks_pb2_grpc.add_TickServiceServicer_to_server(TickService(), server)
    server.add_insecure_port("[::]:9100")
    await server.start()
    await server.wait_for_termination()
`,
      solution: `import json

import grpc
import redis.asyncio as redis

import ticks_pb2
import ticks_pb2_grpc

r = redis.Redis(host="redis", port=6379, decode_responses=True)


def to_tick(symbol: str, fields: dict) -> ticks_pb2.Tick:
    price = lambda name: float(fields.get(name, 0))
    return ticks_pb2.Tick(symbol=symbol, bid=price("bid"), ask=price("ask"), last=price("last"))


class TickService(ticks_pb2_grpc.TickServiceServicer):
    async def SubscribeTicks(self, request: ticks_pb2.SubscribeRequest, context: grpc.aio.ServicerContext):
        symbol = request.symbol
        snapshot = await r.hgetall(f"book:{symbol}")
        if not snapshot:
            await context.abort(grpc.StatusCode.NOT_FOUND, f"unknown symbol {symbol}")
        yield to_tick(symbol, snapshot)
        pubsub = r.pubsub()
        await pubsub.subscribe(f"ticks:{symbol}")
        try:
            while not context.cancelled():
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message is not None:
                    yield to_tick(symbol, json.loads(message["data"]))
        finally:
            await pubsub.unsubscribe(f"ticks:{symbol}")
            await pubsub.aclose()


async def serve() -> None:
    server = grpc.aio.server()
    ticks_pb2_grpc.add_TickServiceServicer_to_server(TickService(), server)
    server.add_insecure_port("[::]:9100")
    await server.start()
    await server.wait_for_termination()
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

interface SubscribeRequest {
  symbol: string;
}

export interface Tick {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
}

/** A Tick from the hash fields (or a tick's JSON): missing fields read as 0. */
export function toTick(symbol: string, fields: Record<string, unknown>): Tick {
  const price = (name: string): number => Number(fields[name] ?? 0);
  return {symbol, bid: price('bid'), ask: price('ask'), last: price('last')};
}

export async function subscribeTicks(call: grpc.ServerWritableStream<SubscribeRequest, Tick>): Promise<void> {
  const symbol = call.request.symbol;
  // TODO: HGETALL book:{symbol}; empty → call.emit('error', {code: grpc.status.NOT_FOUND, …}) and return
  // TODO: call.write(toTick(symbol, snapshot)) first
  // TODO: sub = redis.duplicate(); sub.on('message', …) writes a Tick per message; subscribe ticks:{symbol}
  // TODO: wait for call.on('cancelled') (or call.cancelled), then unsubscribe, quit the subscriber and end the call
  void symbol;
  call.emit('error', {code: grpc.status.UNIMPLEMENTED, details: 'not implemented'});
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('ticks.proto')) as {
  exchange: {TickService: grpc.ServiceClientConstructor};
};

export const server = new grpc.Server();
server.addService(pkg.exchange.TickService.service, {SubscribeTicks: subscribeTicks});
server.bindAsync('0.0.0.0:9100', grpc.ServerCredentials.createInsecure(), () => server.start());
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Redis from 'ioredis';

const redis = new Redis({host: 'redis', port: 6379});

interface SubscribeRequest {
  symbol: string;
}

export interface Tick {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
}

/** A Tick from the hash fields (or a tick's JSON): missing fields read as 0. */
export function toTick(symbol: string, fields: Record<string, unknown>): Tick {
  const price = (name: string): number => Number(fields[name] ?? 0);
  return {symbol, bid: price('bid'), ask: price('ask'), last: price('last')};
}

export async function subscribeTicks(call: grpc.ServerWritableStream<SubscribeRequest, Tick>): Promise<void> {
  const symbol = call.request.symbol;
  const snapshot = await redis.hgetall(\`book:\${symbol}\`);
  if (Object.keys(snapshot).length === 0) {
    call.emit('error', {code: grpc.status.NOT_FOUND, details: \`unknown symbol \${symbol}\`});
    return;
  }
  call.write(toTick(symbol, snapshot));
  const sub = redis.duplicate(); // a subscribed connection can do nothing else
  sub.on('message', (_channel: string, message: string) => {
    call.write(toTick(symbol, JSON.parse(message) as Record<string, unknown>));
  });
  await sub.subscribe(\`ticks:\${symbol}\`);
  const gone = Promise.withResolvers<void>();
  if (call.cancelled) gone.resolve();
  else call.on('cancelled', gone.resolve);
  try {
    // The stream lives as long as the client: the call ends when it goes away.
    await gone.promise;
  } finally {
    await sub.unsubscribe(\`ticks:\${symbol}\`);
    await sub.quit();
    call.end();
  }
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('ticks.proto')) as {
  exchange: {TickService: grpc.ServiceClientConstructor};
};

export const server = new grpc.Server();
server.addService(pkg.exchange.TickService.service, {SubscribeTicks: subscribeTicks});
server.bindAsync('0.0.0.0:9100', grpc.ServerCredentials.createInsecure(), () => server.start());
`,
    },
    go: {
      starter: `package main

import (
	"log"
	"net"
	"strconv"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"

	pb "exchange/gen/ticks"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type tickServer struct {
	pb.UnimplementedTickServiceServer
}

func toTick(symbol string, fields map[string]string) *pb.Tick {
	price := func(name string) float64 { v, _ := strconv.ParseFloat(fields[name], 64); return v }
	return &pb.Tick{Symbol: symbol, Bid: price("bid"), Ask: price("ask"), Last: price("last")}
}

func (s *tickServer) SubscribeTicks(req *pb.SubscribeRequest, stream pb.TickService_SubscribeTicksServer) error {
	ctx := stream.Context()
	symbol := req.GetSymbol()
	// TODO: HGetAll book:{symbol}; empty → status codes.NotFound
	// TODO: stream.Send(toTick(symbol, snapshot)) first
	// TODO: sub := rdb.Subscribe(ctx, "ticks:"+symbol); select on ctx.Done() and sub.Channel(); protojson.Unmarshal each payload into a pb.Tick
	// TODO: defer sub.Close() so the subscription ends with the call
	_ = ctx
	_ = symbol
	_ = protojson.Unmarshal
	return status.Error(codes.Unimplemented, "not implemented")
}

func main() {
	lis, _ := net.Listen("tcp", ":9100")
	srv := grpc.NewServer()
	pb.RegisterTickServiceServer(srv, &tickServer{})
	log.Fatal(srv.Serve(lis))
}
`,
      solution: `package main

import (
	"log"
	"net"
	"strconv"

	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/encoding/protojson"

	pb "exchange/gen/ticks"
)

var rdb = redis.NewClient(&redis.Options{Addr: "redis:6379"})

type tickServer struct {
	pb.UnimplementedTickServiceServer
}

func toTick(symbol string, fields map[string]string) *pb.Tick {
	price := func(name string) float64 { v, _ := strconv.ParseFloat(fields[name], 64); return v }
	return &pb.Tick{Symbol: symbol, Bid: price("bid"), Ask: price("ask"), Last: price("last")}
}

func (s *tickServer) SubscribeTicks(req *pb.SubscribeRequest, stream pb.TickService_SubscribeTicksServer) error {
	ctx := stream.Context()
	symbol := req.GetSymbol()
	snapshot, err := rdb.HGetAll(ctx, "book:"+symbol).Result()
	if err != nil {
		return err
	}
	if len(snapshot) == 0 {
		return status.Errorf(codes.NotFound, "unknown symbol %s", symbol)
	}
	if err := stream.Send(toTick(symbol, snapshot)); err != nil {
		return err
	}
	sub := rdb.Subscribe(ctx, "ticks:"+symbol)
	defer sub.Close() // UNSUBSCRIBE and release the connection, however the call ends
	for {
		select {
		case <-ctx.Done():
			return nil // the client cancelled or disconnected
		case m := <-sub.Channel():
			var tick pb.Tick
			if err := protojson.Unmarshal([]byte(m.Payload), &tick); err != nil {
				log.Printf("bad tick on %s: %v", m.Channel, err)
				continue
			}
			if err := stream.Send(&tick); err != nil {
				return err
			}
		}
	}
}

func main() {
	lis, _ := net.Listen("tcp", ":9100")
	srv := grpc.NewServer()
	pb.RegisterTickServiceServer(srv, &tickServer{})
	log.Fatal(srv.Serve(lis))
}
`,
    },
    scala: {
      starter: `import io.grpc.Status
import io.grpc.stub.{ServerCallStreamObserver, StreamObserver}
import redis.clients.jedis.{JedisPool, JedisPubSub}
import scala.jdk.CollectionConverters._
import scala.util.Using
import scalapb.json4s.JsonFormat

import exchange.ticks.{SubscribeRequest, Tick, TickServiceGrpc}

object TickStream {
  // A subscription holds its connection for the whole stream: borrow one from the pool per call.
  private val pool = new JedisPool("redis", 6379)

  def toTick(symbol: String, fields: Map[String, String]): Tick = {
    def price(name: String) = fields.get(name).fold(0.0)(_.toDouble)
    Tick(symbol = symbol, bid = price("bid"), ask = price("ask"), last = price("last"))
  }

  class TickService extends TickServiceGrpc.TickService {
    override def subscribeTicks(request: SubscribeRequest, responseObserver: StreamObserver[Tick]): Unit = {
      val observer = responseObserver.asInstanceOf[ServerCallStreamObserver[Tick]]
      val symbol = request.symbol
      Using.resource(pool.getResource) { jedis =>
        // TODO: hgetAll book:{symbol}; empty → observer.onError(Status.NOT_FOUND …)
        // TODO: observer.onNext(toTick(symbol, snapshot)) first
        // TODO: listener = new JedisPubSub { onMessage: unsubscribe() if observer.isCancelled else onNext(JsonFormat.fromJsonString[Tick](payload)) }
        // TODO: observer.setOnCancelHandler(() => listener.unsubscribe()) so a cancel on a quiet symbol also ends the subscribe
        // TODO: jedis.subscribe(listener, "ticks:{symbol}") — blocks until unsubscribe(); then onCompleted()
        val _ = (jedis, observer, symbol, classOf[JedisPubSub], JsonFormat)
        observer.onError(Status.UNIMPLEMENTED.asRuntimeException())
      }
    }
  }
}
`,
      solution: `import io.grpc.Status
import io.grpc.stub.{ServerCallStreamObserver, StreamObserver}
import redis.clients.jedis.{JedisPool, JedisPubSub}
import scala.jdk.CollectionConverters._
import scala.util.Using
import scalapb.json4s.JsonFormat

import exchange.ticks.{SubscribeRequest, Tick, TickServiceGrpc}

object TickStream {
  // A subscription holds its connection for the whole stream: borrow one from the pool per call.
  private val pool = new JedisPool("redis", 6379)

  def toTick(symbol: String, fields: Map[String, String]): Tick = {
    def price(name: String) = fields.get(name).fold(0.0)(_.toDouble)
    Tick(symbol = symbol, bid = price("bid"), ask = price("ask"), last = price("last"))
  }

  class TickService extends TickServiceGrpc.TickService {
    override def subscribeTicks(request: SubscribeRequest, responseObserver: StreamObserver[Tick]): Unit = {
      val observer = responseObserver.asInstanceOf[ServerCallStreamObserver[Tick]]
      val symbol = request.symbol
      Using.resource(pool.getResource) { jedis =>
        val snapshot = jedis.hgetAll(s"book:$symbol").asScala.toMap
        if (snapshot.isEmpty) observer.onError(Status.NOT_FOUND.withDescription(s"unknown symbol $symbol").asRuntimeException())
        else {
          observer.onNext(toTick(symbol, snapshot))
          val listener = new JedisPubSub {
            override def onMessage(channel: String, payload: String): Unit =
              if (observer.isCancelled) unsubscribe() // the client went away: end the blocking subscribe below
              else observer.onNext(JsonFormat.fromJsonString[Tick](payload))
          }
          observer.setOnCancelHandler(() => listener.unsubscribe()) // a cancel on a quiet symbol must not block forever
          jedis.subscribe(listener, s"ticks:$symbol") // blocks this handler thread until unsubscribe()
          observer.onCompleted()
        }
      }
    }
  }
}
`,
    },
    cpp: {
      starter: `#include <google/protobuf/util/json_util.h>
#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <string>
#include <unordered_map>

#include "ticks.grpc.pb.h"

using exchange::SubscribeRequest;
using exchange::Tick;
using exchange::TickService;

sw::redis::ConnectionOptions redis_options() {
  sw::redis::ConnectionOptions opts;
  opts.host = "redis";
  opts.port = 6379;
  opts.socket_timeout = std::chrono::milliseconds(1000);  // consume() returns (TimeoutError) once a second
  return opts;
}

sw::redis::Redis redis(redis_options());

Tick to_tick(const std::string& symbol, const std::unordered_map<std::string, std::string>& fields) {
  const auto price = [&](const char* name) { const auto it = fields.find(name); return it == fields.end() ? 0.0 : std::stod(it->second); };
  Tick tick;
  tick.set_symbol(symbol);
  tick.set_bid(price("bid"));
  tick.set_ask(price("ask"));
  tick.set_last(price("last"));
  return tick;
}

class TickServiceImpl final : public TickService::Service {
 public:
  grpc::Status SubscribeTicks(grpc::ServerContext* context, const SubscribeRequest* request, grpc::ServerWriter<Tick>* writer) override {
    const std::string symbol = request->symbol();
    // TODO: redis.hgetall("book:" + symbol, inserter); empty → Status(NOT_FOUND)
    // TODO: writer->Write(to_tick(symbol, snapshot)) first
    // TODO: auto sub = redis.subscriber(); on_message → JsonStringToMessage into a Tick → writer->Write; subscribe ticks:{symbol}
    // TODO: while (!context->IsCancelled()) sub.consume() (swallow TimeoutError); then unsubscribe
    return grpc::Status(grpc::StatusCode::UNIMPLEMENTED, "not implemented");
  }
};

int main() {
  TickServiceImpl service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:9100", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
      solution: `#include <google/protobuf/util/json_util.h>
#include <grpcpp/grpcpp.h>
#include <sw/redis++/redis++.h>

#include <chrono>
#include <iterator>
#include <string>
#include <unordered_map>

#include "ticks.grpc.pb.h"

using exchange::SubscribeRequest;
using exchange::Tick;
using exchange::TickService;

sw::redis::ConnectionOptions redis_options() {
  sw::redis::ConnectionOptions opts;
  opts.host = "redis";
  opts.port = 6379;
  opts.socket_timeout = std::chrono::milliseconds(1000);  // consume() returns (TimeoutError) once a second
  return opts;
}

sw::redis::Redis redis(redis_options());

Tick to_tick(const std::string& symbol, const std::unordered_map<std::string, std::string>& fields) {
  const auto price = [&](const char* name) { const auto it = fields.find(name); return it == fields.end() ? 0.0 : std::stod(it->second); };
  Tick tick;
  tick.set_symbol(symbol);
  tick.set_bid(price("bid"));
  tick.set_ask(price("ask"));
  tick.set_last(price("last"));
  return tick;
}

class TickServiceImpl final : public TickService::Service {
 public:
  grpc::Status SubscribeTicks(grpc::ServerContext* context, const SubscribeRequest* request, grpc::ServerWriter<Tick>* writer) override {
    const std::string symbol = request->symbol();
    std::unordered_map<std::string, std::string> snapshot;
    redis.hgetall("book:" + symbol, std::inserter(snapshot, snapshot.begin()));
    if (snapshot.empty()) return grpc::Status(grpc::StatusCode::NOT_FOUND, "unknown symbol " + symbol);
    writer->Write(to_tick(symbol, snapshot));
    auto sub = redis.subscriber();
    sub.on_message([writer](std::string /*channel*/, std::string payload) {
      Tick tick;
      google::protobuf::util::JsonStringToMessage(payload, &tick);
      writer->Write(tick);
    });
    sub.subscribe("ticks:" + symbol);
    while (!context->IsCancelled()) {
      try {
        sub.consume();  // one message, or TimeoutError after socket_timeout so the cancel check runs
      } catch (const sw::redis::TimeoutError&) {
      }
    }
    sub.unsubscribe("ticks:" + symbol);
    return grpc::Status::OK;
  }
};

int main() {
  TickServiceImpl service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:9100", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
    },
  },
  harness: {
    python: `import asyncio
import json

import grpc

import ticks_pb2
import ticks_pb2_grpc

BOOK = {"bid": "10.05", "ask": "10.06", "last": "10.05"}


async def _stub(ctx):
    """The learner's server running as a task, and a stub talking to it."""
    ctx.redis.hset("book:ACME", mapping=BOOK)
    m = ctx.load("tick_stream")
    asyncio.create_task(m.serve())
    await asyncio.sleep(0)
    channel = grpc.aio.insecure_channel("ticks:9100")
    return ticks_pb2_grpc.TickServiceStub(channel)


async def _read(call, what):
    try:
        return await asyncio.wait_for(call.read(), 0.5)
    except asyncio.TimeoutError:
        raise AssertionError(f"the stream sent nothing within 0.5s: expected {what}")


def _assert_tick(tick, what, bid, ask, last):
    assert tick is not grpc.aio.EOF, f"the stream ended before sending {what}"
    assert tick.symbol == "ACME", f"{what} names symbol {tick.symbol!r}, expected ACME"
    assert (tick.bid, tick.ask, tick.last) == (bid, ask, last), f"{what} is bid={tick.bid} ask={tick.ask} last={tick.last}, expected {bid}/{ask}/{last}"


async def _settle(call):
    for _ in range(200):
        if call.done():
            return
        await asyncio.sleep(0)


def _subscribers(ctx, symbol):
    """Subscribers of ticks:{symbol}. Compared as deltas: a subscription leaked by an earlier run stays on the fake server."""
    return dict(ctx.redis.pubsub_numsub("ticks:" + symbol))["ticks:" + symbol]


async def _subscribed(ctx, symbol, before):
    """Wait (loop turns only) for the handler to add its subscription on top of the count before the call."""
    for _ in range(50):
        if _subscribers(ctx, symbol) > before:
            break
        await asyncio.sleep(0)
    return _subscribers(ctx, symbol) - before


async def check_snapshot_first(ctx):
    stub = await _stub(ctx)
    ctx.redis.publish("ticks:ACME", json.dumps({"symbol": "ACME", "bid": 1, "ask": 2, "last": 3}))  # before this client subscribed: must not reach it
    call = stub.SubscribeTicks(ticks_pb2.SubscribeRequest(symbol="ACME"))
    first = await _read(call, "the snapshot of book:ACME")
    _assert_tick(first, "the first tick (the snapshot from the hash)", 10.05, 10.06, 10.05)
    call.cancel()


async def check_not_found(ctx):
    stub = await _stub(ctx)
    before = _subscribers(ctx, "GHOST")
    call = stub.SubscribeTicks(ticks_pb2.SubscribeRequest(symbol="GHOST"))
    try:
        item = await _read(call, "a NOT_FOUND status")
        raise AssertionError(f"an unknown symbol must end the call with NOT_FOUND; the stream {'ended normally' if item is grpc.aio.EOF else 'sent a tick'}")
    except grpc.aio.AioRpcError as e:
        assert e.code() == grpc.StatusCode.NOT_FOUND, f"an unknown symbol ended the call with {e.code()}, expected NOT_FOUND"
    assert _subscribers(ctx, "GHOST") == before, "nothing must be subscribed for a symbol that does not exist"


async def check_forward(ctx):
    stub = await _stub(ctx)
    before = _subscribers(ctx, "ACME")
    call = stub.SubscribeTicks(ticks_pb2.SubscribeRequest(symbol="ACME"))
    await _read(call, "the snapshot")
    assert await _subscribed(ctx, "ACME", before) == 1, "after the snapshot the handler must SUBSCRIBE to ticks:ACME"
    ctx.redis.publish("ticks:ACME", json.dumps({"symbol": "ACME", "bid": 10.07, "ask": 10.08, "last": 10.07}))
    tick = await _read(call, "the published tick")
    _assert_tick(tick, "the forwarded tick", 10.07, 10.08, 10.07)
    ctx.redis.publish("ticks:ACME", json.dumps({"symbol": "ACME", "bid": 10.09, "ask": 10.10, "last": 10.09}))
    tick = await _read(call, "the second published tick")
    _assert_tick(tick, "the second forwarded tick", 10.09, 10.10, 10.09)
    call.cancel()


async def check_cancel(ctx):
    stub = await _stub(ctx)
    before = _subscribers(ctx, "ACME")
    call = stub.SubscribeTicks(ticks_pb2.SubscribeRequest(symbol="ACME"))
    await _read(call, "the snapshot")
    assert await _subscribed(ctx, "ACME", before) == 1, "the handler must be subscribed to ticks:ACME while the client is connected"
    call.cancel()
    await _settle(call)
    assert call.done(), "the handler kept running after the client cancelled"
    leaked = _subscribers(ctx, "ACME") - before
    assert leaked == 0, f"the client went away but ticks:ACME still has {leaked} subscriber(s) from this call: unsubscribe on the way out"
`,
    typescript: `import * as grpc from '@grpc/grpc-js';

const BOOK = ['bid', '10.05', 'ask', '10.06', 'last', '10.05'];

type Item = {tick: Record<string, unknown>} | {error: {code: number; details: string}} | {end: true};

/** The learner's server (addService installs the handler at load) and a client talking to it. */
function stub(ctx) {
  ctx.redis.hset('book:ACME', ...BOOK);
  ctx.load('tick_stream');
  const pkg = ctx.proto('ticks.proto');
  return new pkg.exchange.TickService('ticks:9100', grpc.credentials.createInsecure());
}

/** Let every queued microtask and the server's pending writes run. */
function settle(ms = 0): Promise<void> {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** One SubscribeTicks call, read item by item: a tick, the end of the stream, or its error status. */
function open(client, symbol: string) {
  const call = client.SubscribeTicks({symbol});
  const items: Item[] = [];
  const waiters: (() => void)[] = [];
  const push = (item: Item) => {
    items.push(item);
    for (const w of waiters.splice(0)) w();
  };
  call.on('data', (tick: Record<string, unknown>) => push({tick}));
  call.on('error', (e: {code: number; details: string}) => push({error: e}));
  call.on('end', () => push({end: true}));
  let i = 0;
  const read = async (what: string): Promise<Item> => {
    if (i >= items.length) {
      const next = Promise.withResolvers<void>();
      waiters.push(next.resolve);
      await Promise.race([next.promise, settle(500)]);
    }
    assert(i < items.length, \`the stream sent nothing within 0.5s: expected \${what}\`);
    return items[i++];
  };
  return {call, read};
}

function assertTick(item: Item, what: string, bid: number, ask: number, last: number) {
  assert(!('end' in item), \`the stream ended before sending \${what}\`);
  assert(!('error' in item), \`the call failed with \${'error' in item ? JSON.stringify(item.error) : ''} before sending \${what}\`);
  const tick = item.tick;
  assert.equal(tick.symbol, 'ACME', \`\${what} names symbol \${JSON.stringify(tick.symbol)}, expected ACME\`);
  assert.deepEqual([tick.bid, tick.ask, tick.last], [bid, ask, last], \`\${what} is bid=\${tick.bid} ask=\${tick.ask} last=\${tick.last}, expected \${bid}/\${ask}/\${last}\`);
}

/** Subscribers of ticks:{symbol}. Compared as deltas: a subscription leaked by an earlier call stays on the server. */
function subscribers(ctx, symbol: string): number {
  return Number(ctx.redis.pubsub('NUMSUB', 'ticks:' + symbol)[1]);
}

/** Wait (loop turns only) for the handler to add its subscription on top of the count before the call. */
async function subscribed(ctx, symbol: string, before: number): Promise<number> {
  for (let i = 0; i < 50 && subscribers(ctx, symbol) <= before; i++) await settle();
  return subscribers(ctx, symbol) - before;
}

export async function check_snapshot_first(ctx) {
  const client = stub(ctx);
  ctx.redis.publish('ticks:ACME', JSON.stringify({symbol: 'ACME', bid: 1, ask: 2, last: 3})); // before this client subscribed: must not reach it
  // The engine publishes a tick the moment the handler has read the hash: a handler that subscribed first forwards it before its snapshot.
  ctx.redisAfter('book:ACME', () => ctx.redis.publish('ticks:ACME', JSON.stringify({symbol: 'ACME', bid: 1, ask: 2, last: 3})));
  const {call, read} = open(client, 'ACME');
  const first = await read('the snapshot of book:ACME');
  assertTick(first, 'the first tick (the snapshot from the hash, before any Pub/Sub message)', 10.05, 10.06, 10.05);
  call.cancel();
}

export async function check_not_found(ctx) {
  const client = stub(ctx);
  const before = subscribers(ctx, 'GHOST');
  const {read} = open(client, 'GHOST');
  const item = await read('a NOT_FOUND status');
  assert('error' in item, \`an unknown symbol must end the call with NOT_FOUND; the stream \${'end' in item ? 'ended normally' : 'sent a tick'}\`);
  assert.equal(item.error.code, ctx.grpc.status.NOT_FOUND, \`an unknown symbol ended the call with status \${item.error.code} (\${item.error.details}), expected NOT_FOUND\`);
  await settle();
  assert.equal(subscribers(ctx, 'GHOST'), before, 'nothing must be subscribed for a symbol that does not exist');
}

export async function check_forward(ctx) {
  const client = stub(ctx);
  const before = subscribers(ctx, 'ACME');
  const {call, read} = open(client, 'ACME');
  await read('the snapshot');
  assert.equal(await subscribed(ctx, 'ACME', before), 1, 'after the snapshot the handler must SUBSCRIBE to ticks:ACME');
  ctx.redis.publish('ticks:ACME', JSON.stringify({symbol: 'ACME', bid: 10.07, ask: 10.08, last: 10.07}));
  assertTick(await read('the published tick'), 'the forwarded tick', 10.07, 10.08, 10.07);
  ctx.redis.publish('ticks:ACME', JSON.stringify({symbol: 'ACME', bid: 10.09, ask: 10.1, last: 10.09}));
  assertTick(await read('the second published tick'), 'the second forwarded tick', 10.09, 10.1, 10.09);
  call.cancel();
}

export async function check_cancel(ctx) {
  const client = stub(ctx);
  const before = subscribers(ctx, 'ACME');
  const {call, read} = open(client, 'ACME');
  await read('the snapshot');
  assert.equal(await subscribed(ctx, 'ACME', before), 1, 'the handler must be subscribed to ticks:ACME while the client is connected');
  call.cancel();
  for (let i = 0; i < 20 && subscribers(ctx, 'ACME') > before; i++) await settle();
  const leaked = subscribers(ctx, 'ACME') - before;
  assert.equal(leaked, 0, \`the client went away but ticks:ACME still has \${leaked} subscriber(s) from this call: unsubscribe on the way out\`);
}
`,
    go: `package main

import (
	"context"
	"io"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"leetbuild/harness"

	pb "exchange/gen/ticks"
)

// tickClient seeds book:ACME, runs the learner's server and returns a client talking to it.
func tickClient(ctx *harness.Ctx) pb.TickServiceClient {
	ctx.Redis.Do("HSET", "book:ACME", "bid", "10.05", "ask", "10.06", "last", "10.05")
	ctx.Main(main)
	return pb.NewTickServiceClient(ctx.GRPC.Dial("ticks:9100"))
}

// tickItem is what the stream delivered: a tick, or the error that ended it (io.EOF: a normal end).
type tickItem struct {
	tick *pb.Tick
	err  error
}

// tickCall is one SubscribeTicks call, read item by item.
type tickCall struct {
	ctx    *harness.Ctx
	cancel context.CancelFunc
	items  chan tickItem
}

func openTicks(ctx *harness.Ctx, client pb.TickServiceClient, symbol string) *tickCall {
	c, cancel := context.WithCancel(context.Background())
	call := &tickCall{ctx: ctx, cancel: cancel, items: make(chan tickItem, 64)}
	stream, err := client.SubscribeTicks(c, &pb.SubscribeRequest{Symbol: symbol})
	if err != nil {
		call.items <- tickItem{err: err}
		return call
	}
	go func() {
		for {
			tick, err := stream.Recv()
			call.items <- tickItem{tick, err}
			if err != nil {
				return
			}
		}
	}()
	return call
}

func (t *tickCall) read(what string) tickItem {
	select {
	case item := <-t.items:
		return item
	case <-time.After(500 * time.Millisecond):
		t.ctx.Fatalf("the stream sent nothing within 0.5s: expected %s", what)
		return tickItem{}
	}
}

func assertTick(ctx *harness.Ctx, item tickItem, what string, bid, ask, last float64) {
	ctx.Assert(item.err != io.EOF, "the stream ended before sending %s", what)
	ctx.Assert(item.err == nil, "the call failed with %v before sending %s", item.err, what)
	tick := item.tick
	ctx.Equal(tick.GetSymbol(), "ACME", "%s names the wrong symbol", what)
	ctx.Equal([]float64{tick.GetBid(), tick.GetAsk(), tick.GetLast()}, []float64{bid, ask, last}, "%s: bid, ask, last", what)
}

// tickSubscribers counts the subscribers of ticks:{symbol}. Compared as deltas: a subscription leaked
// by an earlier call stays on the server.
func tickSubscribers(ctx *harness.Ctx, symbol string) int64 {
	reply, _ := ctx.Redis.Do("PUBSUB", "NUMSUB", "ticks:"+symbol).([]any)
	ctx.Assert(len(reply) == 2, "PUBSUB NUMSUB answered %v", reply)
	n, _ := reply[1].(int64)
	return n
}

// subscribedSince waits for the handler to add its subscription on top of the count before the call.
func subscribedSince(ctx *harness.Ctx, symbol string, before int64) int64 {
	for i := 0; i < 50 && tickSubscribers(ctx, symbol) <= before; i++ {
		ctx.Settle()
	}
	return tickSubscribers(ctx, symbol) - before
}

func CheckSnapshotFirst(ctx *harness.Ctx) {
	client := tickClient(ctx)
	ctx.Redis.Publish("ticks:ACME", \`{"symbol":"ACME","bid":1,"ask":2,"last":3}\`) // before this client subscribed: must not reach it
	// The engine publishes a tick the moment the handler has read the hash: a handler that subscribed first forwards it before its snapshot.
	ctx.Redis.After("book:ACME", func() any {
		return ctx.Redis.Publish("ticks:ACME", \`{"symbol":"ACME","bid":1,"ask":2,"last":3}\`)
	})
	call := openTicks(ctx, client, "ACME")
	first := call.read("the snapshot of book:ACME")
	assertTick(ctx, first, "the first tick (the snapshot from the hash, before any Pub/Sub message)", 10.05, 10.06, 10.05)
	call.cancel()
}

func CheckNotFound(ctx *harness.Ctx) {
	client := tickClient(ctx)
	before := tickSubscribers(ctx, "GHOST")
	call := openTicks(ctx, client, "GHOST")
	item := call.read("a NOT_FOUND status")
	outcome := "sent a tick"
	if item.err == io.EOF {
		outcome = "ended normally"
	}
	ctx.Assert(item.err != nil && item.err != io.EOF, "an unknown symbol must end the call with NOT_FOUND; the stream %s", outcome)
	ctx.Equal(status.Code(item.err), codes.NotFound, "an unknown symbol ended the call with status %v", item.err)
	ctx.Settle()
	ctx.Equal(tickSubscribers(ctx, "GHOST"), before, "nothing must be subscribed for a symbol that does not exist; subscribers of ticks:GHOST")
}

func CheckForward(ctx *harness.Ctx) {
	client := tickClient(ctx)
	before := tickSubscribers(ctx, "ACME")
	call := openTicks(ctx, client, "ACME")
	call.read("the snapshot")
	ctx.Equal(subscribedSince(ctx, "ACME", before), 1, "after the snapshot the handler must SUBSCRIBE to ticks:ACME; new subscribers")
	ctx.Redis.Publish("ticks:ACME", \`{"symbol":"ACME","bid":10.07,"ask":10.08,"last":10.07}\`)
	assertTick(ctx, call.read("the published tick"), "the forwarded tick", 10.07, 10.08, 10.07)
	ctx.Redis.Publish("ticks:ACME", \`{"symbol":"ACME","bid":10.09,"ask":10.1,"last":10.09}\`)
	assertTick(ctx, call.read("the second published tick"), "the second forwarded tick", 10.09, 10.1, 10.09)
	call.cancel()
}

func CheckCancel(ctx *harness.Ctx) {
	client := tickClient(ctx)
	before := tickSubscribers(ctx, "ACME")
	call := openTicks(ctx, client, "ACME")
	call.read("the snapshot")
	ctx.Equal(subscribedSince(ctx, "ACME", before), 1, "the handler must be subscribed to ticks:ACME while the client is connected; new subscribers")
	call.cancel()
	for i := 0; i < 20 && tickSubscribers(ctx, "ACME") > before; i++ {
		ctx.Settle()
	}
	leaked := tickSubscribers(ctx, "ACME") - before
	ctx.Equal(leaked, 0, "the client went away but ticks:ACME still has subscribers from this call: unsubscribe on the way out (defer sub.Close()); leaked subscribers")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <chrono>
#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

namespace {

// tickClient seeds book:ACME, runs the learner's server and returns a client talking to it.
std::unique_ptr<exchange::TickService::Stub> tickClient(harness::Ctx& ctx) {
  ctx.Redis.Do("HSET", "book:ACME", "bid", "10.05", "ask", "10.06", "last", "10.05");
  ctx.Main();
  return exchange::TickService::NewStub(ctx.GRPC.Dial("ticks:9100"));
}

// tickItem is what the stream delivered: a tick, or the status that ended it (ended: OK, a normal end).
struct tickItem {
  std::optional<exchange::Tick> tick;
  grpc::Status status;
  bool ended = false;
};

// The status as grpc-go prints an error.
std::string describe(const grpc::Status& s) {
  return harness::Sprintf("rpc error: code = %v desc = %s", s.error_code(), s.error_message());
}

// tickCall is one SubscribeTicks call, read item by item (a reader thread fills items, as the Go
// harness's goroutine fills its channel).
struct tickCall {
  harness::Ctx* ctx = nullptr;
  grpc::ClientContext context;
  std::unique_ptr<grpc::ClientReader<exchange::Tick>> stream;
  std::mutex mu;
  std::condition_variable arrived;
  std::deque<tickItem> items;

  void cancel() { context.TryCancel(); }

  tickItem read(const std::string& what) {
    std::unique_lock<std::mutex> lock(mu);
    if (!arrived.wait_for(lock, std::chrono::milliseconds(500), [&] { return !items.empty(); })) {
      lock.unlock();
      ctx->Fatalf("the stream sent nothing within 0.5s: expected %s", what);
    }
    tickItem item = items.front();
    items.pop_front();
    return item;
  }
};

std::shared_ptr<tickCall> openTicks(harness::Ctx& ctx, exchange::TickService::Stub& client, const std::string& symbol) {
  auto call = std::make_shared<tickCall>();
  call->ctx = &ctx;
  exchange::SubscribeRequest request;
  request.set_symbol(symbol);
  call->stream = client.SubscribeTicks(&call->context, request);
  std::thread([call] {
    for (;;) {
      exchange::Tick tick;
      tickItem item;
      const bool got = call->stream->Read(&tick);
      if (got) {
        item.tick = tick;
      } else {
        item.status = call->stream->Finish();
        item.ended = item.status.ok();
      }
      {
        std::lock_guard<std::mutex> lock(call->mu);
        call->items.push_back(item);
      }
      call->arrived.notify_all();
      if (!got) return;
    }
  }).detach();
  return call;
}

void assertTick(harness::Ctx& ctx, const tickItem& item, const std::string& what, double bid, double ask, double last) {
  ctx.Assert(!item.ended, "the stream ended before sending %s", what);
  ctx.Assert(item.tick.has_value(), "the call failed with %v before sending %s", describe(item.status), what);
  const exchange::Tick& tick = *item.tick;
  ctx.Equal(tick.symbol(), "ACME", "%s names the wrong symbol", what);
  ctx.Equal(std::vector<double>{tick.bid(), tick.ask(), tick.last()}, {bid, ask, last}, "%s: bid, ask, last", what);
}

// tickSubscribers counts the subscribers of ticks:{symbol}. Compared as deltas: a subscription leaked
// by an earlier call stays on the server.
long long tickSubscribers(harness::Ctx& ctx, const std::string& symbol) {
  const auto reply = ctx.Redis.Do("PUBSUB", "NUMSUB", "ticks:" + symbol).Array();
  ctx.Assert(reply.size() == 2, "PUBSUB NUMSUB answered %v", reply);
  return reply[1].Int();
}

// subscribedSince waits for the handler to add its subscription on top of the count before the call.
long long subscribedSince(harness::Ctx& ctx, const std::string& symbol, long long before) {
  for (int i = 0; i < 50 && tickSubscribers(ctx, symbol) <= before; i++) ctx.Settle();
  return tickSubscribers(ctx, symbol) - before;
}

}  // namespace

void CheckSnapshotFirst(harness::Ctx& ctx) {
  auto client = tickClient(ctx);
  ctx.Redis.Publish("ticks:ACME", R"({"symbol":"ACME","bid":1,"ask":2,"last":3})");  // before this client subscribed: must not reach it
  // The engine publishes a tick the moment the handler has read the hash: a handler that subscribed first forwards it before its snapshot.
  ctx.Redis.After("book:ACME", [&] { ctx.Redis.Publish("ticks:ACME", R"({"symbol":"ACME","bid":1,"ask":2,"last":3})"); });
  auto call = openTicks(ctx, *client, "ACME");
  const tickItem first = call->read("the snapshot of book:ACME");
  assertTick(ctx, first, "the first tick (the snapshot from the hash, before any Pub/Sub message)", 10.05, 10.06, 10.05);
  call->cancel();
}

void CheckNotFound(harness::Ctx& ctx) {
  auto client = tickClient(ctx);
  const long long before = tickSubscribers(ctx, "GHOST");
  auto call = openTicks(ctx, *client, "GHOST");
  const tickItem item = call->read("a NOT_FOUND status");
  const std::string outcome = item.ended ? "ended normally" : "sent a tick";
  ctx.Assert(!item.tick.has_value() && !item.ended, "an unknown symbol must end the call with NOT_FOUND; the stream %s", outcome);
  ctx.Equal(item.status.error_code(), grpc::StatusCode::NOT_FOUND, "an unknown symbol ended the call with status %v", describe(item.status));
  ctx.Settle();
  ctx.Equal(tickSubscribers(ctx, "GHOST"), before, "nothing must be subscribed for a symbol that does not exist; subscribers of ticks:GHOST");
}

void CheckForward(harness::Ctx& ctx) {
  auto client = tickClient(ctx);
  const long long before = tickSubscribers(ctx, "ACME");
  auto call = openTicks(ctx, *client, "ACME");
  call->read("the snapshot");
  ctx.Equal(subscribedSince(ctx, "ACME", before), 1, "after the snapshot the handler must SUBSCRIBE to ticks:ACME; new subscribers");
  ctx.Redis.Publish("ticks:ACME", R"({"symbol":"ACME","bid":10.07,"ask":10.08,"last":10.07})");
  assertTick(ctx, call->read("the published tick"), "the forwarded tick", 10.07, 10.08, 10.07);
  ctx.Redis.Publish("ticks:ACME", R"({"symbol":"ACME","bid":10.09,"ask":10.1,"last":10.09})");
  assertTick(ctx, call->read("the second published tick"), "the second forwarded tick", 10.09, 10.1, 10.09);
  call->cancel();
}

void CheckCancel(harness::Ctx& ctx) {
  auto client = tickClient(ctx);
  const long long before = tickSubscribers(ctx, "ACME");
  auto call = openTicks(ctx, *client, "ACME");
  call->read("the snapshot");
  ctx.Equal(subscribedSince(ctx, "ACME", before), 1, "the handler must be subscribed to ticks:ACME while the client is connected; new subscribers");
  call->cancel();
  for (int i = 0; i < 20 && tickSubscribers(ctx, "ACME") > before; i++) ctx.Settle();
  const long long leaked = tickSubscribers(ctx, "ACME") - before;
  ctx.Equal(leaked, 0, "the client went away but ticks:ACME still has subscribers from this call: unsubscribe on the way out (sub.unsubscribe()); leaked subscribers");
}
`,
  },
  debrief: `Snapshot-then-stream is the shape of every subscription API: the stream alone cannot tell a new client the current state, and the snapshot alone goes stale in a millisecond. The gap between them is the classic race — a tick published between HGETALL and SUBSCRIBE is lost — which real feeds close with sequence numbers (subscribe first, then snapshot, then drop buffered ticks older than the snapshot's sequence). Checking cancellation on a timer instead of only when a message arrives is what keeps a quiet symbol from pinning a connection forever; at scale, one Redis subscription per process fanning out to all its gRPC streams replaces one connection per client.`,
};
