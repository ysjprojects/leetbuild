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
`,
    },
  },
  debrief: `Snapshot-then-stream is the shape of every subscription API: the stream alone cannot tell a new client the current state, and the snapshot alone goes stale in a millisecond. The gap between them is the classic race — a tick published between HGETALL and SUBSCRIBE is lost — which real feeds close with sequence numbers (subscribe first, then snapshot, then drop buffered ticks older than the snapshot's sequence). Checking cancellation on a timer instead of only when a message arrives is what keeps a quiet symbol from pinning a connection forever; at scale, one Redis subscription per process fanning out to all its gRPC streams replaces one connection per client.`,
};
