import type {Step} from '@/lib/types';

// ---- 2. gRPC bidirectional chat stream --------------------------------------------------------
export const chatStreamStep: Step = {
  id: 'chat-stream',
  title: 'One bidirectional stream per client',
  concept: 'grpc',
  file: 'chat_service',
  focus: ['client-a', 'server-a'],
  task: `## Task

Every connected client holds one gRPC stream open for as long as it is in a room:

\`\`\`proto
service Chat {
  rpc Chat(stream ClientMsg) returns (stream ServerMsg);
}
message Join      { string room = 1; string user = 2; }
message Say       { string text = 1; }
message ClientMsg { oneof kind { Join join = 1; Say say = 2; } }
message ServerMsg { string room = 1; string user = 2; string text = 3; int64 ts = 4; }
\`\`\`

Implement the \`Chat\` handler. The room bus is provided (you build it in the next step):
\`publish(room, msg)\` sends a message to every instance, \`subscribe(room)\` hands you what other
people say in the room, \`unsubscribe\` undoes it.

- The **first** message must be a \`join\`. Anything else ends the call with \`INVALID_ARGUMENT\`.
- After the join, \`subscribe(room)\` and forward everything it yields to the client stream.
- Every incoming \`say\` becomes a \`ServerMsg{room, user, text, ts}\` passed to \`publish(room, …)\`.
  Nothing is written back directly: the message reaches this client through the bus like everyone else.
- When the client hangs up (cancels, or the connection drops) **unsubscribe**: use the call's
  cancellation hook (\`add_done_callback\` / \`ctx.Done()\` / \`setOnCancelHandler\` / \`IsCancelled\`).
  A stream that keeps its subscription after the client is gone leaks one per disconnect.

:::widget grpc-streams {"mode": "bidi"}

> Reads and writes on one bidi stream are independent: a message from the bus can arrive while you are
> blocked waiting for the client's next \`say\`. That is why the forwarding side runs on its own task,
> goroutine, callback or thread.`,
  sequence: {
    participants: ['Client', 'chat-server', 'room bus'],
    messages: [
      {from: 'Client', to: 'chat-server', label: 'ClientMsg{join: room-7, ana}', kind: 'sync'},
      {from: 'chat-server', to: 'room bus', label: 'subscribe(room-7)', kind: 'sync'},
      {from: 'Client', to: 'chat-server', label: 'ClientMsg{say: "hi"}', kind: 'async'},
      {from: 'chat-server', to: 'room bus', label: 'publish(room-7, ServerMsg{ana, "hi"})', kind: 'async'},
      {from: 'room bus', to: 'chat-server', label: 'ServerMsg{bo, "hello ana"}', kind: 'async'},
      {from: 'chat-server', to: 'Client', label: 'ServerMsg{bo, "hello ana"}', kind: 'async'},
      {from: 'Client', to: 'chat-server', label: 'cancel → unsubscribe(room-7)', kind: 'async'},
    ],
  },
  hints: [
    'Read exactly one message before doing anything else. If it is not a join, abort with INVALID_ARGUMENT and return: no subscription has been made yet, so there is nothing to clean up.',
    'Forwarding is its own loop: take from the subscription, write to the stream, repeat. Start it right after subscribing, then read the client side in the handler body.',
    'Register the cleanup the moment you subscribe, not at the end of the handler: on a cancellation the end of the handler may never run normally.',
  ],
  checks: [
    {
      id: 'join-first',
      title: 'The first message must be a join',
      detail:
        'Inspect the `join` branch of the first `ClientMsg` (`HasField("join")` / `GetJoin()` / `Kind.Join` / `has_join()`); anything else ends the call with `INVALID_ARGUMENT` (or `FAILED_PRECONDITION`).',
      match: {
        python: {
          all: [
            /HasField\(\s*"join"\s*\)|WhichOneof\(\s*"kind"\s*\)/,
            /StatusCode\.(INVALID_ARGUMENT|FAILED_PRECONDITION)/,
          ],
        },
        typescript: {
          all: [/\.kind\s*[!=]==?\s*['"]join['"]|\.join\b/, /status\.(INVALID_ARGUMENT|FAILED_PRECONDITION)/],
        },
        go: {all: [/GetJoin\(\)|ClientMsg_Join\b/, /codes\.(InvalidArgument|FailedPrecondition)/]},
        scala: {all: [/Kind\.Join\(|\.kind\.join/, /Status\.(INVALID_ARGUMENT|FAILED_PRECONDITION)/]},
        cpp: {all: [/has_join\(\)|kJoin\b/, /StatusCode::(INVALID_ARGUMENT|FAILED_PRECONDITION)/]},
      },
    },
    {
      id: 'say-publishes',
      title: 'Every say is published to the room',
      detail:
        'A `say` becomes a `ServerMsg` handed to `publish(room, …)`; the bus, not the handler, delivers it to everyone (including this client).',
      match: {
        python: {all: [/HasField\(\s*"say"\s*\)|WhichOneof\(\s*"kind"\s*\)/, /\bpublish\(\s*room\s*,/]},
        typescript: {all: [/\.kind\s*[!=]==?\s*['"]say['"]|\.say\b/, /\bpublish\(\s*room\s*,/]},
        go: {all: [/GetSay\(\)|ClientMsg_Say\b/, /\bpublish\(\s*ctx\s*,\s*room\s*,/]},
        scala: {all: [/Kind\.Say\(|\.kind\.say/, /\bpublish\(\s*room\s*,/]},
        cpp: {all: [/has_say\(\)|kSay\b/, /\bpublish\(\s*room\s*,/]},
      },
    },
    {
      id: 'subscribe-forward',
      title: 'Forwards the subscription to the client stream',
      detail: 'After the join, `subscribe(room)` and write every message it yields to the response stream.',
      match: {
        python: {all: [/\bsubscribe\(\s*room\s*\)/, /context\.write\(/]},
        typescript: {all: [/\bsubscribe\(\s*room\s*\)/, /call\.write\(/]},
        go: {all: [/\bsubscribe\(\s*room\s*\)/, /stream\.Send\(/]},
        scala: {all: [/\bsubscribe\(\s*room\s*,/, /out\.onNext\(|responseObserver\.onNext\(/]},
        cpp: {all: [/\bsubscribe\(\s*room\s*,/, /stream->Write\(/]},
      },
    },
    {
      id: 'cancel-cleanup',
      title: 'Unsubscribes when the client hangs up',
      detail:
        "Hook the call's cancellation (`add_done_callback`, `ctx.Done()`, `setOnCancelHandler`, `IsCancelled`) and `unsubscribe(room, …)` from it.",
      match: {
        python: {all: [/add_done_callback\(|add_callback\(/, /\bunsubscribe\(\s*room\s*,/]},
        typescript: {all: [/on\(\s*['"]cancelled['"]/, /\bunsubscribe\(\s*room\s*,/]},
        go: {all: [/ctx\.Done\(\)|Context\(\)\.Done\(\)/, /\bunsubscribe\(\s*room\s*,/]},
        scala: {all: [/setOnCancelHandler\(|isCancelled/, /\bunsubscribe\(\s*room\s*,/]},
        cpp: {all: [/IsCancelled\(\)/, /\bunsubscribe\(\s*room\s*,/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio
import time

import grpc

import chat_pb2
import chat_pb2_grpc
from room_bus import publish  # built in step 3: produce to Kafka
from subscriptions import subscribe, unsubscribe  # subscribe(room) -> asyncio.Queue[ServerMsg]


def now_ms() -> int:
    return int(time.time() * 1000)


class ChatService(chat_pb2_grpc.ChatServicer):
    async def Chat(self, request_iterator, context: grpc.aio.ServicerContext):
        # TODO: the first message must be a join → otherwise abort INVALID_ARGUMENT
        # TODO: subscribe(room); register unsubscribe with context.add_done_callback
        # TODO: forward everything the queue yields with context.write on its own task
        # TODO: publish(room, ServerMsg(...)) for every say
        await context.abort(grpc.StatusCode.UNIMPLEMENTED, "not implemented")


async def serve() -> None:
    server = grpc.aio.server()
    chat_pb2_grpc.add_ChatServicer_to_server(ChatService(), server)
    server.add_insecure_port("[::]:9000")
    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
`,
      solution: `import asyncio
import time

import grpc

import chat_pb2
import chat_pb2_grpc
from room_bus import publish  # built in step 3: produce to Kafka
from subscriptions import subscribe, unsubscribe  # subscribe(room) -> asyncio.Queue[ServerMsg]


def now_ms() -> int:
    return int(time.time() * 1000)


class ChatService(chat_pb2_grpc.ChatServicer):
    async def Chat(self, request_iterator, context: grpc.aio.ServicerContext):
        first = await anext(request_iterator, None)
        if first is None or not first.HasField("join"):
            await context.abort(grpc.StatusCode.INVALID_ARGUMENT, "first message must be a join")
        room, user = first.join.room, first.join.user
        queue = subscribe(room)
        context.add_done_callback(lambda _: unsubscribe(room, queue))  # cancel, error or normal end

        async def forward() -> None:
            while True:
                await context.write(await queue.get())

        writer = asyncio.create_task(forward())
        try:
            async for msg in request_iterator:
                if msg.HasField("say"):
                    publish(room, chat_pb2.ServerMsg(room=room, user=user, text=msg.say.text, ts=now_ms()))
        finally:
            writer.cancel()


async def serve() -> None:
    server = grpc.aio.server()
    chat_pb2_grpc.add_ChatServicer_to_server(ChatService(), server)
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
import {type ServerMsg, type Subscription, subscribe, unsubscribe} from 'subscriptions'; // subscribe(room) -> Subscription

import {publish} from './room_bus'; // built in step 3: produce to Kafka

interface ClientMsg {
  kind?: 'join' | 'say';
  join?: {room: string; user: string};
  say?: {text: string};
}

const chatProto = grpc.loadPackageDefinition(protoLoader.loadSync('chat.proto')) as unknown as {
  chat: {Chat: {service: grpc.ServiceDefinition}};
};

/** One bidi stream per client: a join first, then says in and the room's messages out. */
export function chat(call: grpc.ServerDuplexStream<ClientMsg, ServerMsg>): void {
  // TODO: the first message must be a join → otherwise end the call with INVALID_ARGUMENT
  // TODO: subscribe(room); unsubscribe from the call's 'cancelled' (and 'end') hook
  // TODO: forward everything the subscription yields with call.write on its own loop
  // TODO: publish(room, {room, user, text, ts}) for every say
  call.emit('error', {code: grpc.status.UNIMPLEMENTED, details: 'not implemented'});
}

export function serve(): void {
  const server = new grpc.Server();
  server.addService(chatProto.chat.Chat.service, {Chat: chat});
  server.bindAsync('0.0.0.0:9000', grpc.ServerCredentials.createInsecure(), () => server.start());
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {type ServerMsg, type Subscription, subscribe, unsubscribe} from 'subscriptions'; // subscribe(room) -> Subscription

import {publish} from './room_bus'; // built in step 3: produce to Kafka

interface ClientMsg {
  kind?: 'join' | 'say';
  join?: {room: string; user: string};
  say?: {text: string};
}

const chatProto = grpc.loadPackageDefinition(protoLoader.loadSync('chat.proto')) as unknown as {
  chat: {Chat: {service: grpc.ServiceDefinition}};
};

/** Write every message the subscription yields to the client; ends when the subscription is closed. */
async function forward(sub: Subscription, call: grpc.ServerDuplexStream<ClientMsg, ServerMsg>): Promise<void> {
  for await (const msg of sub) call.write(msg);
}

/** One bidi stream per client: a join first, then says in and the room's messages out. */
export function chat(call: grpc.ServerDuplexStream<ClientMsg, ServerMsg>): void {
  let room = '';
  let user = '';
  let sub: Subscription | null = null;
  const done = (): void => {
    if (sub !== null) unsubscribe(room, sub);
    sub = null;
  };
  call.on('cancelled', done); // the client hung up or the connection dropped
  call.on('end', () => {
    done(); // the client closed its side normally
    call.end();
  });
  call.on('data', (msg: ClientMsg) => {
    if (sub === null) {
      if (msg.kind !== 'join' || msg.join === undefined) {
        call.emit('error', {code: grpc.status.INVALID_ARGUMENT, details: 'first message must be a join'});
        return;
      }
      ({room, user} = msg.join);
      sub = subscribe(room);
      void forward(sub, call);
      return;
    }
    if (msg.kind === 'say' && msg.say !== undefined) {
      void publish(room, {room, user, text: msg.say.text, ts: Date.now()});
    }
  });
}

export function serve(): void {
  const server = new grpc.Server();
  server.addService(chatProto.chat.Chat.service, {Chat: chat});
  server.bindAsync('0.0.0.0:9000', grpc.ServerCredentials.createInsecure(), () => server.start());
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"io"
	"log"
	"net"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "chat/gen/chat"
	"chat/subscriptions"
)

// Built in step 3 (room_bus.go): sends msg to every instance.
var publish = func(ctx context.Context, room string, msg *pb.ServerMsg) error { panic("not implemented") }

// Provided: this instance's subscription table (package chat/subscriptions). subscribe returns a
// channel that receives every message delivered to the room here; unsubscribe stops it.
var (
	subscribe   = subscriptions.Subscribe
	unsubscribe = subscriptions.Unsubscribe
)

type chatServer struct {
	pb.UnimplementedChatServer
}

// Chat is a bidirectional stream: the first message joins a room, every later one is said in it.
func (s *chatServer) Chat(stream pb.Chat_ChatServer) error {
	// TODO: the first Recv must be a join → otherwise codes.InvalidArgument
	// TODO: subscribe(room); defer unsubscribe; a goroutine forwards sub → stream.Send until ctx.Done()
	// TODO: publish(ctx, room, &pb.ServerMsg{...}) for every say; io.EOF ends the call cleanly
	_ = io.EOF
	_ = time.Now
	return status.Error(codes.Unimplemented, "not implemented")
}

func main() {
	lis, _ := net.Listen("tcp", ":9000")
	srv := grpc.NewServer()
	pb.RegisterChatServer(srv, &chatServer{})
	log.Fatal(srv.Serve(lis))
}
`,
      solution: `package main

import (
	"context"
	"io"
	"log"
	"net"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "chat/gen/chat"
	"chat/subscriptions"
)

// Built in step 3 (room_bus.go): sends msg to every instance.
var publish = func(ctx context.Context, room string, msg *pb.ServerMsg) error { panic("not implemented") }

// Provided: this instance's subscription table (package chat/subscriptions). subscribe returns a
// channel that receives every message delivered to the room here; unsubscribe stops it.
var (
	subscribe   = subscriptions.Subscribe
	unsubscribe = subscriptions.Unsubscribe
)

type chatServer struct {
	pb.UnimplementedChatServer
}

// Chat is a bidirectional stream: the first message joins a room, every later one is said in it.
func (s *chatServer) Chat(stream pb.Chat_ChatServer) error {
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	join := first.GetJoin()
	if join == nil {
		return status.Error(codes.InvalidArgument, "first message must be a join")
	}
	room, user := join.GetRoom(), join.GetUser()
	ctx := stream.Context()
	sub := subscribe(room)
	defer unsubscribe(room, sub)

	go func() {
		for {
			select {
			case msg := <-sub:
				if err := stream.Send(msg); err != nil {
					return
				}
			case <-ctx.Done(): // the client hung up
				return
			}
		}
	}()

	for {
		in, err := stream.Recv()
		if err == io.EOF {
			return nil // the client closed its side
		}
		if err != nil {
			return err // cancelled or connection dropped: ctx is done, the goroutine exits
		}
		if say := in.GetSay(); say != nil {
			publish(ctx, room, &pb.ServerMsg{Room: room, User: user, Text: say.GetText(), Ts: time.Now().UnixMilli()})
		}
	}
}

func main() {
	lis, _ := net.Listen("tcp", ":9000")
	srv := grpc.NewServer()
	pb.RegisterChatServer(srv, &chatServer{})
	log.Fatal(srv.Serve(lis))
}
`,
    },
    scala: {
      starter: `import chat.chat.{ChatGrpc, ClientMsg, ServerMsg}
import io.grpc.{ServerBuilder, Status}
import io.grpc.stub.{ServerCallStreamObserver, StreamObserver}
import scala.concurrent.ExecutionContext

object ChatService extends ChatGrpc.Chat {
  /** Built in step 3 (RoomBus) and provided (Subscriptions): deliver is called for every message in the room. */
  def publish(room: String, msg: ServerMsg): Unit = ???
  def subscribe(room: String, deliver: ServerMsg => Unit): Unit = ???
  def unsubscribe(room: String, deliver: ServerMsg => Unit): Unit = ???

  override def chat(responseObserver: StreamObserver[ServerMsg]): StreamObserver[ClientMsg] = {
    val out = responseObserver.asInstanceOf[ServerCallStreamObserver[ServerMsg]]
    new StreamObserver[ClientMsg] {
      // TODO: the first message must be a Join → otherwise onError(INVALID_ARGUMENT)
      // TODO: subscribe(room, deliver) where deliver calls out.onNext; setOnCancelHandler → unsubscribe
      // TODO: publish(room, ServerMsg(...)) for every Say
      override def onNext(msg: ClientMsg): Unit =
        out.onError(Status.UNIMPLEMENTED.asRuntimeException())
      override def onError(t: Throwable): Unit = ()
      override def onCompleted(): Unit = out.onCompleted()
    }
  }

  def main(args: Array[String]): Unit =
    ServerBuilder.forPort(9000).addService(ChatGrpc.bindService(this, ExecutionContext.global)).build().start().awaitTermination()
}
`,
      solution: `import chat.chat.{ChatGrpc, ClientMsg, ServerMsg}
import io.grpc.{ServerBuilder, Status}
import io.grpc.stub.{ServerCallStreamObserver, StreamObserver}
import scala.concurrent.ExecutionContext

object ChatService extends ChatGrpc.Chat {
  /** Built in step 3 (RoomBus) and provided (Subscriptions): deliver is called for every message in the room. */
  def publish(room: String, msg: ServerMsg): Unit = ???
  def subscribe(room: String, deliver: ServerMsg => Unit): Unit = ???
  def unsubscribe(room: String, deliver: ServerMsg => Unit): Unit = ???

  override def chat(responseObserver: StreamObserver[ServerMsg]): StreamObserver[ClientMsg] = {
    val out = responseObserver.asInstanceOf[ServerCallStreamObserver[ServerMsg]]
    new StreamObserver[ClientMsg] {
      private var room: String = _
      private var user: String = _
      private val deliver: ServerMsg => Unit = m => out.synchronized(out.onNext(m)) // onNext is not thread-safe

      override def onNext(msg: ClientMsg): Unit = msg.kind match {
        case ClientMsg.Kind.Join(join) if room == null =>
          room = join.room
          user = join.user
          subscribe(room, deliver)
          out.setOnCancelHandler(() => unsubscribe(room, deliver)) // the client hung up
        case ClientMsg.Kind.Say(say) if room != null =>
          publish(room, ServerMsg(room = room, user = user, text = say.text, ts = System.currentTimeMillis()))
        case _ =>
          out.onError(Status.INVALID_ARGUMENT.withDescription("first message must be a join").asRuntimeException())
      }

      override def onError(t: Throwable): Unit = if (room != null) unsubscribe(room, deliver)

      override def onCompleted(): Unit = {
        if (room != null) unsubscribe(room, deliver)
        out.onCompleted()
      }
    }
  }

  def main(args: Array[String]): Unit =
    ServerBuilder.forPort(9000).addService(ChatGrpc.bindService(this, ExecutionContext.global)).build().start().awaitTermination()
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <string>

#include "chat.grpc.pb.h"

using chat::ClientMsg;
using chat::ServerMsg;

// Built in step 3 (room_bus.cpp) and provided (subscriptions.cpp).
using Deliver = std::function<void(const ServerMsg&)>;
using Subscription = std::shared_ptr<Deliver>;
void publish(const std::string& room, const ServerMsg& msg);
Subscription subscribe(const std::string& room, Deliver deliver);
void unsubscribe(const std::string& room, const Subscription& sub);

long long now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

class ChatService final : public chat::Chat::Service {
 public:
  grpc::Status Chat(grpc::ServerContext* ctx, grpc::ServerReaderWriter<ServerMsg, ClientMsg>* stream) override {
    // TODO: the first Read must be a join → otherwise INVALID_ARGUMENT
    // TODO: subscribe(room, deliver) where deliver does stream->Write under a mutex
    // TODO: publish(room, ServerMsg{...}) for every say
    // TODO: when Read returns false (client finished or ctx->IsCancelled()) unsubscribe
    return grpc::Status(grpc::StatusCode::UNIMPLEMENTED, "not implemented");
  }
};

int main() {
  ChatService service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:9000", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <functional>
#include <memory>
#include <mutex>
#include <string>

#include "chat.grpc.pb.h"

using chat::ClientMsg;
using chat::ServerMsg;

// Built in step 3 (room_bus.cpp) and provided (subscriptions.cpp).
using Deliver = std::function<void(const ServerMsg&)>;
using Subscription = std::shared_ptr<Deliver>;
void publish(const std::string& room, const ServerMsg& msg);
Subscription subscribe(const std::string& room, Deliver deliver);
void unsubscribe(const std::string& room, const Subscription& sub);

long long now_ms() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
}

class ChatService final : public chat::Chat::Service {
 public:
  grpc::Status Chat(grpc::ServerContext* ctx, grpc::ServerReaderWriter<ServerMsg, ClientMsg>* stream) override {
    ClientMsg first;
    if (!stream->Read(&first) || !first.has_join())
      return grpc::Status(grpc::StatusCode::INVALID_ARGUMENT, "first message must be a join");
    const std::string room = first.join().room();
    const std::string user = first.join().user();
    std::mutex write_mu;  // Write is not thread-safe: the bus delivers from its own thread
    const Subscription sub = subscribe(room, [&](const ServerMsg& msg) {
      std::lock_guard<std::mutex> lock(write_mu);
      if (!ctx->IsCancelled()) stream->Write(msg);
    });
    ClientMsg in;
    while (stream->Read(&in)) {
      if (!in.has_say()) continue;
      ServerMsg msg;
      msg.set_room(room);
      msg.set_user(user);
      msg.set_text(in.say().text());
      msg.set_ts(now_ms());
      publish(room, msg);
    }
    unsubscribe(room, sub);  // Read returned false: the client finished, or hung up
    return ctx->IsCancelled() ? grpc::Status::CANCELLED : grpc::Status::OK;
  }
};

int main() {
  ChatService service;
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
import sys
import time

import grpc

import chat_pb2
import chat_pb2_grpc


def _join(room, user):
    return chat_pb2.ClientMsg(join=chat_pb2.Join(room=room, user=user))


def _say(text):
    return chat_pb2.ClientMsg(say=chat_pb2.Say(text=text))


def _server_msg(user, text, ts=1):
    return chat_pb2.ServerMsg(room="room-7", user=user, text=text, ts=ts)


async def _settle():
    for _ in range(5):
        await asyncio.sleep(0)


async def _start(ctx):
    """The learner's server as a task, a stub on it, the subscription table it shares, and what it published."""
    m = ctx.load("chat_service")
    published = []
    m.publish = lambda room, msg: published.append((room, msg))  # the room bus is step 3's
    asyncio.create_task(m.serve())
    await asyncio.sleep(0)
    assert ctx.grpc.find("/chat.Chat/Chat") is not None, "serve() registered no Chat handler"
    stub = chat_pb2_grpc.ChatStub(grpc.aio.insecure_channel("chat-server:9000"))
    return m, stub, sys.modules["subscriptions"], published


async def _joined(ctx, room="room-7", user="ana"):
    m, stub, subs, published = await _start(ctx)
    call = stub.Chat()
    await call.write(_join(room, user))
    await _settle()
    return call, subs, published


async def check_join_first(ctx):
    m, stub, subs, published = await _start(ctx)
    call = stub.Chat()
    await call.write(_say("hi"))
    try:
        await call.read()
        raise AssertionError("a stream whose first message is a say must end with INVALID_ARGUMENT, but it did not fail")
    except grpc.RpcError as e:
        assert e.code() in (grpc.StatusCode.INVALID_ARGUMENT, grpc.StatusCode.FAILED_PRECONDITION), f"a say before any join ended the call with {e.code()}, expected INVALID_ARGUMENT"
    assert subs.subscribers("room-7") == 0, "a rejected first message must not leave a subscription behind"
    assert published == [], f"a rejected first message must not be published, got {published}"
    call = stub.Chat()
    await call.write(_join("room-7", "ana"))
    await _settle()
    assert not call.done(), f"a stream that starts with a join must stay open, but it ended with {await call.code()}"


async def check_say_publishes(ctx):
    call, subs, published = await _joined(ctx)
    await call.write(_say("hi"))
    await call.write(_say("anyone here?"))
    await _settle()
    assert len(published) == 2, f"two says must publish exactly two messages, got {len(published)}: {published}"
    for (room, msg), text in zip(published, ("hi", "anyone here?")):
        assert room == "room-7", f"published to room {room!r}, expected 'room-7'"
        assert isinstance(msg, chat_pb2.ServerMsg), f"publish must receive a ServerMsg, got {type(msg).__name__}"
        assert (msg.room, msg.user, msg.text) == ("room-7", "ana", text), f"published ServerMsg is {msg!r}, expected room='room-7' user='ana' text={text!r}"
        assert abs(msg.ts - int(time.time() * 1000)) < 60000, f"ServerMsg.ts is {msg.ts}, expected the current time in milliseconds"
    # Nothing is written back directly: the first thing this client reads is what the bus delivers.
    subs.local_deliver("room-7", _server_msg("bo", "hello ana"))
    got = await asyncio.wait_for(call.read(), 1.0)
    assert (got.user, got.text) == ("bo", "hello ana"), f"the client received {got!r} before anything came from the bus: a say reaches its sender through publish, never through a direct write"


async def check_subscribe_forward(ctx):
    call, subs, published = await _joined(ctx)
    n = subs.subscribers("room-7")
    assert n == 1, f"after the join, room-7 has {n} subscription(s) on this instance, expected 1 (subscribe(room))"
    subs.local_deliver("room-7", _server_msg("bo", "hello ana", ts=1))
    subs.local_deliver("room-7", _server_msg("cy", "hi both", ts=2))
    first = await asyncio.wait_for(call.read(), 1.0)
    second = await asyncio.wait_for(call.read(), 1.0)
    assert (first.user, first.text) == ("bo", "hello ana"), f"first forwarded message is {first!r}, expected bo: 'hello ana'"
    assert (second.user, second.text) == ("cy", "hi both"), f"second forwarded message is {second!r}, expected cy: 'hi both' (forward in order)"
    assert published == [], "forwarding bus messages must not publish them again"


async def check_cancel_cleanup(ctx):
    call, subs, published = await _joined(ctx)
    assert subs.subscribers("room-7") == 1, f"after the join, room-7 has {subs.subscribers('room-7')} subscription(s), expected 1"
    call.cancel()
    await _settle()
    n = subs.subscribers("room-7")
    assert n == 0, f"the client hung up but room-7 still has {n} subscription(s) on this instance: unsubscribe from the call's done callback"
    # A client that closes its side normally must be cleaned up the same way.
    m, stub, subs, published = await _start(ctx)
    call = stub.Chat()
    await call.write(_join("room-7", "bo"))
    await _settle()
    await call.done_writing()
    await _settle()
    n = subs.subscribers("room-7")
    assert n == 0, f"the client finished its stream but room-7 still has {n} subscription(s): the done callback runs however the call ends"
`,
    typescript: `const TOPIC = 'chat-messages';

const join = (room, user) => ({join: {room, user}});
const say = (text) => ({say: {text}});
const serverMsg = (user, text, ts = 1) => ({room: 'room-7', user, text, ts});
const statusName = (ctx, code) => Object.keys(ctx.grpc.status).find(k => ctx.grpc.status[k] === code) ?? String(code);

/** A few turns of the event loop, for writes to reach the handler and the handler to react. */
async function settle() {
  for (let i = 0; i < 5; i++) {
    const {promise, resolve} = Promise.withResolvers();
    setTimeout(resolve, 0);
    await promise;
  }
}

/** The client side of one stream: what arrived, how it ended, and a read with a (virtual) 1 s patience. */
function open(client) {
  const call = client.Chat();
  const inbox = [];
  const waiters = [];
  let status = null;
  call.on('data', m => {
    inbox.push(m);
    waiters.splice(0).forEach(w => w());
  });
  call.on('status', s => {
    status = s;
    waiters.splice(0).forEach(w => w());
  });
  const read = async () => {
    const started = Date.now();
    while (inbox.length === 0) {
      if (status !== null) return null;
      if (Date.now() - started >= 1000) return null;
      const {promise, resolve} = Promise.withResolvers();
      waiters.push(resolve);
      setTimeout(resolve, 200);
      await promise;
    }
    return inbox.shift();
  };
  return {call, read, status: () => status};
}

/** What the stream handler published: the records on chat-messages, parsed back. */
const published = ctx => ctx.kafka.records(TOPIC).map(r => [r.key.toString(), JSON.parse(r.value.toString())]);

/** The learner's server, a client on it and the subscription table it shares with the room bus. */
function start(ctx) {
  const m = ctx.load('chat_service');
  const subs = ctx.load('/support/subscriptions.ts');
  m.serve();
  const pkg = ctx.proto('chat.proto');
  const client = new pkg.chat.Chat('chat-server:9000');
  return {m, client, subs};
}

async function joined(ctx, room = 'room-7', user = 'ana') {
  const {client, subs} = start(ctx);
  const stream = open(client);
  stream.call.write(join(room, user));
  await settle();
  const s = stream.status();
  assert(s === null, \`the stream ended with \${s === null ? '' : statusName(ctx, s.code)} right after the join\${s !== null && s.code === ctx.grpc.status.UNAVAILABLE ? ' (serve() registered no Chat handler)' : ''}\`);
  return {stream, subs};
}

export async function check_join_first(ctx) {
  const {client, subs} = start(ctx);
  const stream = open(client);
  stream.call.write(say('hi'));
  await settle();
  const s = stream.status();
  assert(s !== null, 'a stream whose first message is a say must end with INVALID_ARGUMENT, but it did not fail');
  assert(s.code !== ctx.grpc.status.UNAVAILABLE, 'serve() registered no Chat handler');
  assert([ctx.grpc.status.INVALID_ARGUMENT, ctx.grpc.status.FAILED_PRECONDITION].includes(s.code), \`a say before any join ended the call with \${statusName(ctx, s.code)}, expected INVALID_ARGUMENT\`);
  assert.equal(subs.subscribers('room-7'), 0, 'a rejected first message must not leave a subscription behind');
  assert.deepEqual(published(ctx), [], \`a rejected first message must not be published, got \${JSON.stringify(published(ctx))}\`);
  const second = open(client);
  second.call.write(join('room-7', 'ana'));
  await settle();
  assert(second.status() === null, \`a stream that starts with a join must stay open, but it ended with \${second.status() === null ? '' : statusName(ctx, second.status().code)}\`);
}

export async function check_say_publishes(ctx) {
  const {stream, subs} = await joined(ctx);
  stream.call.write(say('hi'));
  stream.call.write(say('anyone here?'));
  await settle();
  const got = published(ctx);
  assert.equal(got.length, 2, \`two says must publish exactly two messages, got \${got.length}: \${JSON.stringify(got)}\`);
  ['hi', 'anyone here?'].forEach((text, i) => {
    const [room, msg] = got[i];
    assert.equal(room, 'room-7', \`published to room \${JSON.stringify(room)}, expected 'room-7'\`);
    assert.deepEqual([msg.room, msg.user, msg.text], ['room-7', 'ana', text], \`published ServerMsg is \${JSON.stringify(msg)}, expected room 'room-7' user 'ana' text \${JSON.stringify(text)}\`);
    assert(Math.abs(Number(msg.ts) - Date.now()) < 60000, \`ServerMsg.ts is \${JSON.stringify(msg.ts)}, expected the current time in milliseconds\`);
  });
  // Nothing is written back directly: the first thing this client reads is what the bus delivers.
  subs.localDeliver('room-7', serverMsg('bo', 'hello ana'));
  const got1 = await stream.read();
  assert(got1 !== null, 'nothing reached the client after the bus delivered a message');
  assert.deepEqual([got1.user, got1.text], ['bo', 'hello ana'], \`the client received \${JSON.stringify(got1)} before anything came from the bus: a say reaches its sender through publish, never through a direct write\`);
}

export async function check_subscribe_forward(ctx) {
  const {stream, subs} = await joined(ctx);
  const n = subs.subscribers('room-7');
  assert.equal(n, 1, \`after the join, room-7 has \${n} subscription(s) on this instance, expected 1 (subscribe(room))\`);
  subs.localDeliver('room-7', serverMsg('bo', 'hello ana', 1));
  subs.localDeliver('room-7', serverMsg('cy', 'hi both', 2));
  const first = await stream.read();
  const second = await stream.read();
  assert(first !== null && second !== null, \`the client received \${first === null ? 'nothing' : 'one message'} after the bus delivered two: forward every message the subscription yields\`);
  assert.deepEqual([first.user, first.text], ['bo', 'hello ana'], \`first forwarded message is \${JSON.stringify(first)}, expected bo: 'hello ana'\`);
  assert.deepEqual([second.user, second.text], ['cy', 'hi both'], \`second forwarded message is \${JSON.stringify(second)}, expected cy: 'hi both' (forward in order)\`);
  assert.deepEqual(published(ctx), [], 'forwarding bus messages must not publish them again');
}

export async function check_cancel_cleanup(ctx) {
  const {stream, subs} = await joined(ctx);
  assert.equal(subs.subscribers('room-7'), 1, \`after the join, room-7 has \${subs.subscribers('room-7')} subscription(s), expected 1\`);
  stream.call.cancel();
  await settle();
  let n = subs.subscribers('room-7');
  assert.equal(n, 0, \`the client hung up but room-7 still has \${n} subscription(s) on this instance: unsubscribe from the call's cancelled hook\`);
  // A client that closes its side normally must be cleaned up the same way.
  const {client} = start(ctx);
  const second = open(client);
  second.call.write(join('room-7', 'bo'));
  await settle();
  second.call.end();
  await settle();
  n = subs.subscribers('room-7');
  assert.equal(n, 0, \`the client finished its stream but room-7 still has \${n} subscription(s): clean up however the call ends\`);
}
`,
    go: `package main

import (
	"context"
	"io"
	"sync"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"leetbuild/harness"

	pb "chat/gen/chat"
	"chat/subscriptions"
)

func chatJoin(room, user string) *pb.ClientMsg {
	return &pb.ClientMsg{Kind: &pb.ClientMsg_Join{Join: &pb.Join{Room: room, User: user}}}
}

func chatSay(text string) *pb.ClientMsg {
	return &pb.ClientMsg{Kind: &pb.ClientMsg_Say{Say: &pb.Say{Text: text}}}
}

func chatServerMsg(user, text string, ts int64) *pb.ServerMsg {
	return &pb.ServerMsg{Room: "room-7", User: user, Text: text, Ts: ts}
}

// chatPublished is one publish(ctx, room, msg) the stream handler made.
type chatPublished struct {
	room string
	msg  *pb.ServerMsg
}

// chatBus stands in for step 3's room bus: publish only records.
type chatBus struct {
	mu        sync.Mutex
	published []chatPublished
}

func (b *chatBus) all() []chatPublished {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]chatPublished(nil), b.published...)
}

// chatEnd is how a stream ended: its status code (OK when the server returned nil).
type chatEnd struct{ code codes.Code }

// chatClientStream is the client side of one stream: what arrived, how it ended, and a read with a
// (virtual) 1 s patience.
type chatClientStream struct {
	stream pb.Chat_ChatClient
	cancel context.CancelFunc
	inbox  chan *pb.ServerMsg
	ended  chan chatEnd
	end    *chatEnd
}

func openChat(ctx *harness.Ctx, client pb.ChatClient) *chatClientStream {
	callCtx, cancel := context.WithCancel(context.Background())
	stream, err := client.Chat(callCtx)
	ctx.NoError(err, "opening a Chat stream")
	s := &chatClientStream{stream: stream, cancel: cancel, inbox: make(chan *pb.ServerMsg, 64), ended: make(chan chatEnd, 1)}
	go func() {
		for {
			msg, err := stream.Recv()
			if err == io.EOF {
				s.ended <- chatEnd{code: codes.OK}
				return
			}
			if err != nil {
				s.ended <- chatEnd{code: status.Code(err)}
				return
			}
			s.inbox <- msg
		}
	}()
	return s
}

func (s *chatClientStream) send(ctx *harness.Ctx, msg *pb.ClientMsg) {
	ctx.NoError(s.stream.Send(msg), "sending %v", msg)
}

// status is how the stream ended, nil while it is open.
func (s *chatClientStream) status() *chatEnd {
	if s.end == nil {
		select {
		case e := <-s.ended:
			s.end = &e
		default:
		}
	}
	return s.end
}

// read is the next message the server sent, nil when none arrives within 1 s or the stream ended.
func (s *chatClientStream) read() *pb.ServerMsg {
	select {
	case msg := <-s.inbox:
		return msg
	default:
	}
	if s.status() != nil {
		return nil
	}
	select {
	case msg := <-s.inbox:
		return msg
	case e := <-s.ended:
		s.end = &e
		select {
		case msg := <-s.inbox:
			return msg
		default:
			return nil
		}
	case <-time.After(time.Second):
		return nil
	}
}

// startChat runs the learner's server with publish recording, and returns a client on it.
func startChat(ctx *harness.Ctx) (pb.ChatClient, *chatBus) {
	bus := &chatBus{}
	publish = func(_ context.Context, room string, msg *pb.ServerMsg) error {
		bus.mu.Lock()
		defer bus.mu.Unlock()
		bus.published = append(bus.published, chatPublished{room: room, msg: msg})
		return nil
	}
	ctx.Main(main)
	return pb.NewChatClient(ctx.GRPC.Dial("chat-server:9000")), bus
}

func joinedChat(ctx *harness.Ctx, client pb.ChatClient, room, user string) *chatClientStream {
	s := openChat(ctx, client)
	s.send(ctx, chatJoin(room, user))
	ctx.Settle()
	if e := s.status(); e != nil {
		hint := ""
		if e.code == codes.Unavailable {
			hint = " (main registered no Chat handler)"
		}
		ctx.Fatalf("the stream ended with %v right after the join%s", e.code, hint)
	}
	return s
}

func CheckJoinFirst(ctx *harness.Ctx) {
	client, bus := startChat(ctx)
	s := openChat(ctx, client)
	s.send(ctx, chatSay("hi"))
	ctx.Settle()
	e := s.status()
	ctx.Assert(e != nil, "a stream whose first message is a say must end with InvalidArgument, but it did not fail")
	ctx.Assert(e.code != codes.Unavailable, "main registered no Chat handler")
	ctx.Assert(e.code == codes.InvalidArgument || e.code == codes.FailedPrecondition, "a say before any join ended the call with %v, expected InvalidArgument", e.code)
	ctx.Equal(subscriptions.Subscribers("room-7"), 0, "a rejected first message must not leave a subscription behind: subscriptions in room-7")
	ctx.Assert(len(bus.all()) == 0, "a rejected first message must not be published, got %v", bus.all())
	second := openChat(ctx, client)
	second.send(ctx, chatJoin("room-7", "ana"))
	ctx.Settle()
	if e := second.status(); e != nil {
		ctx.Fatalf("a stream that starts with a join must stay open, but it ended with %v", e.code)
	}
}

func CheckSayPublishes(ctx *harness.Ctx) {
	client, bus := startChat(ctx)
	s := joinedChat(ctx, client, "room-7", "ana")
	s.send(ctx, chatSay("hi"))
	s.send(ctx, chatSay("anyone here?"))
	ctx.Settle()
	got := bus.all()
	ctx.Equal(len(got), 2, "two says must publish exactly two messages (published: %v)", got)
	for i, text := range []string{"hi", "anyone here?"} {
		room, msg := got[i].room, got[i].msg
		ctx.Equal(room, "room-7", "the room publish was called with")
		ctx.Equal([]string{msg.GetRoom(), msg.GetUser(), msg.GetText()}, []string{"room-7", "ana", text}, "the published ServerMsg's room, user and text")
		delta := msg.GetTs() - ctx.Clock.Now()
		ctx.Assert(-60000 < delta && delta < 60000, "ServerMsg.Ts is %d, expected the current time in milliseconds", msg.GetTs())
	}
	// Nothing is written back directly: the first thing this client reads is what the bus delivers.
	subscriptions.LocalDeliver("room-7", chatServerMsg("bo", "hello ana", 1))
	first := s.read()
	ctx.Assert(first != nil, "nothing reached the client after the bus delivered a message")
	ctx.Equal([]string{first.GetUser(), first.GetText()}, []string{"bo", "hello ana"}, "the client received %v before anything came from the bus: a say reaches its sender through publish, never through a direct write; user and text", first)
}

func CheckSubscribeForward(ctx *harness.Ctx) {
	client, bus := startChat(ctx)
	s := joinedChat(ctx, client, "room-7", "ana")
	n := subscriptions.Subscribers("room-7")
	ctx.Equal(n, 1, "after the join, the subscriptions in room-7 on this instance (subscribe(room))")
	subscriptions.LocalDeliver("room-7", chatServerMsg("bo", "hello ana", 1))
	subscriptions.LocalDeliver("room-7", chatServerMsg("cy", "hi both", 2))
	first := s.read()
	second := s.read()
	if first == nil || second == nil {
		what := "nothing"
		if first != nil {
			what = "one message"
		}
		ctx.Fatalf("the client received %s after the bus delivered two: forward every message the subscription yields", what)
	}
	ctx.Equal([]string{first.GetUser(), first.GetText()}, []string{"bo", "hello ana"}, "the first forwarded message's user and text")
	ctx.Equal([]string{second.GetUser(), second.GetText()}, []string{"cy", "hi both"}, "the second forwarded message's user and text (forward in order)")
	ctx.Assert(len(bus.all()) == 0, "forwarding bus messages must not publish them again")
}

func CheckCancelCleanup(ctx *harness.Ctx) {
	client, _ := startChat(ctx)
	s := joinedChat(ctx, client, "room-7", "ana")
	ctx.Equal(subscriptions.Subscribers("room-7"), 1, "after the join, the subscriptions in room-7")
	s.cancel()
	ctx.Settle()
	n := subscriptions.Subscribers("room-7")
	ctx.Equal(n, 0, "the client hung up: unsubscribe once stream.Context() is done; subscriptions left in room-7 on this instance")
	// A client that closes its side normally must be cleaned up the same way.
	second := openChat(ctx, client)
	second.send(ctx, chatJoin("room-7", "bo"))
	ctx.Settle()
	ctx.NoError(second.stream.CloseSend(), "closing the client side")
	ctx.Settle()
	n = subscriptions.Subscribers("room-7")
	ctx.Equal(n, 0, "the client finished its stream: clean up however the call ends; subscriptions left in room-7")
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

#include "chat.grpc.pb.h"
#include "subscriptions.cpp"

namespace {

chat::ClientMsg chatJoin(const std::string& room, const std::string& user) {
  chat::ClientMsg msg;
  msg.mutable_join()->set_room(room);
  msg.mutable_join()->set_user(user);
  return msg;
}

chat::ClientMsg chatSay(const std::string& text) {
  chat::ClientMsg msg;
  msg.mutable_say()->set_text(text);
  return msg;
}

chat::ServerMsg chatServerMsg(const std::string& user, const std::string& text, int64_t ts) {
  chat::ServerMsg msg;
  msg.set_room("room-7");
  msg.set_user(user);
  msg.set_text(text);
  msg.set_ts(ts);
  return msg;
}

// One publish(room, msg) the stream handler made.
struct ChatPublished {
  std::string room;
  chat::ServerMsg msg;
};

// What the stand-in for step 3's room bus recorded: publish only records.
std::mutex chatBusMu;
std::vector<ChatPublished> chatBus;

std::vector<ChatPublished> published() {
  std::lock_guard<std::mutex> lock(chatBusMu);
  return chatBus;
}

std::vector<std::string> publishedText(const std::vector<ChatPublished>& all) {
  std::vector<std::string> out;
  for (const auto& p : all) out.push_back(p.room + ": " + p.msg.ShortDebugString());
  return out;
}

// The client side of one stream: what arrived, how it ended, and a read with a (virtual) 1 s
// patience. A thread of its own reads the stream (Go's receiving goroutine); it owns the state.
struct ChatClientStream {
  grpc::ClientContext context;
  std::unique_ptr<grpc::ClientReaderWriter<chat::ClientMsg, chat::ServerMsg>> stream;
  std::mutex mu;
  std::condition_variable cv;
  std::deque<chat::ServerMsg> inbox;
  std::optional<grpc::StatusCode> end;  // how the stream ended (OK when the server returned OK)

  void send(harness::Ctx& ctx, const chat::ClientMsg& msg) {
    ctx.Assert(stream->Write(msg), "sending %s: the stream is closed", msg.ShortDebugString());
  }

  // How the stream ended, nullopt while it is open.
  std::optional<grpc::StatusCode> status() {
    std::lock_guard<std::mutex> lock(mu);
    return end;
  }

  // The next message the server sent, nullopt when none arrives within 1 s or the stream ended.
  std::optional<chat::ServerMsg> read() {
    std::unique_lock<std::mutex> lock(mu);
    cv.wait_for(lock, std::chrono::seconds(1), [&] { return !inbox.empty() || end.has_value(); });
    if (inbox.empty()) return std::nullopt;
    chat::ServerMsg msg = inbox.front();
    inbox.pop_front();
    return msg;
  }
};

std::shared_ptr<ChatClientStream> openChat(chat::Chat::Stub& client) {
  auto s = std::make_shared<ChatClientStream>();
  s->stream = client.Chat(&s->context);
  std::thread([s] {
    chat::ServerMsg msg;
    while (s->stream->Read(&msg)) {
      std::lock_guard<std::mutex> lock(s->mu);
      s->inbox.push_back(msg);
      s->cv.notify_all();
    }
    const grpc::Status st = s->stream->Finish();
    std::lock_guard<std::mutex> lock(s->mu);
    s->end = st.error_code();
    s->cv.notify_all();
  }).detach();
  return s;
}

// Runs the learner's server with publish recording, and returns a client on it.
std::unique_ptr<chat::Chat::Stub> startChat(harness::Ctx& ctx) {
  ctx.Main();
  return chat::Chat::NewStub(ctx.GRPC.Dial("chat-server:9000"));
}

std::shared_ptr<ChatClientStream> joinedChat(harness::Ctx& ctx, chat::Chat::Stub& client, const std::string& room,
                                             const std::string& user) {
  auto s = openChat(client);
  s->send(ctx, chatJoin(room, user));
  ctx.Settle();
  if (const auto e = s->status()) {
    ctx.Fatalf("the stream ended with %v right after the join%s", *e,
               *e == grpc::StatusCode::UNAVAILABLE ? " (main registered no Chat handler)" : "");
  }
  return s;
}

}  // namespace

// Stands in for step 3's room bus (room_bus.cpp), as the Go harness does: publish only records.
void publish(const std::string& room, const chat::ServerMsg& msg) {
  std::lock_guard<std::mutex> lock(chatBusMu);
  chatBus.push_back({room, msg});
}

void CheckJoinFirst(harness::Ctx& ctx) {
  auto client = startChat(ctx);
  auto s = openChat(*client);
  s->send(ctx, chatSay("hi"));
  ctx.Settle();
  const auto e = s->status();
  ctx.Assert(e.has_value(), "a stream whose first message is a say must end with INVALID_ARGUMENT, but it did not fail");
  ctx.Assert(*e != grpc::StatusCode::UNAVAILABLE, "main registered no Chat handler");
  ctx.Assert(*e == grpc::StatusCode::INVALID_ARGUMENT || *e == grpc::StatusCode::FAILED_PRECONDITION,
             "a say before any join ended the call with %v, expected INVALID_ARGUMENT", *e);
  ctx.Equal(subscribers("room-7"), 0,
            "a rejected first message must not leave a subscription behind: subscriptions in room-7");
  ctx.Assert(published().empty(), "a rejected first message must not be published, got %v", publishedText(published()));
  auto second = openChat(*client);
  second->send(ctx, chatJoin("room-7", "ana"));
  ctx.Settle();
  if (const auto e2 = second->status()) {
    ctx.Fatalf("a stream that starts with a join must stay open, but it ended with %v", *e2);
  }
}

void CheckSayPublishes(harness::Ctx& ctx) {
  auto client = startChat(ctx);
  auto s = joinedChat(ctx, *client, "room-7", "ana");
  s->send(ctx, chatSay("hi"));
  s->send(ctx, chatSay("anyone here?"));
  ctx.Settle();
  const auto got = published();
  ctx.Equal(got.size(), 2, "two says must publish exactly two messages (published: %v)", publishedText(got));
  const std::vector<std::string> texts = {"hi", "anyone here?"};
  for (size_t i = 0; i < texts.size(); i++) {
    const auto& [room, msg] = got[i];
    ctx.Equal(room, "room-7", "the room publish was called with");
    ctx.Equal(std::vector<std::string>{msg.room(), msg.user(), msg.text()}, std::vector<std::string>{"room-7", "ana", texts[i]},
              "the published ServerMsg's room, user and text");
    const int64_t delta = msg.ts() - ctx.Clock.Now();
    ctx.Assert(-60000 < delta && delta < 60000, "ServerMsg.ts is %d, expected the current time in milliseconds", msg.ts());
  }
  // Nothing is written back directly: the first thing this client reads is what the bus delivers.
  local_deliver("room-7", chatServerMsg("bo", "hello ana", 1));
  const auto first = s->read();
  ctx.Assert(first.has_value(), "nothing reached the client after the bus delivered a message");
  ctx.Equal(std::vector<std::string>{first->user(), first->text()}, {"bo", "hello ana"},
            "the client received %s before anything came from the bus: a say reaches its sender through publish, "
            "never through a direct write; user and text",
            first->ShortDebugString());
}

void CheckSubscribeForward(harness::Ctx& ctx) {
  auto client = startChat(ctx);
  auto s = joinedChat(ctx, *client, "room-7", "ana");
  ctx.Equal(subscribers("room-7"), 1, "after the join, the subscriptions in room-7 on this instance (subscribe(room, …))");
  local_deliver("room-7", chatServerMsg("bo", "hello ana", 1));
  local_deliver("room-7", chatServerMsg("cy", "hi both", 2));
  const auto first = s->read();
  const auto second = s->read();
  if (!first || !second) {
    ctx.Fatalf("the client received %s after the bus delivered two: forward every message the subscription yields",
               first ? "one message" : "nothing");
  }
  ctx.Equal(std::vector<std::string>{first->user(), first->text()}, {"bo", "hello ana"},
            "the first forwarded message's user and text");
  ctx.Equal(std::vector<std::string>{second->user(), second->text()}, {"cy", "hi both"},
            "the second forwarded message's user and text (forward in order)");
  ctx.Assert(published().empty(), "forwarding bus messages must not publish them again");
}

void CheckCancelCleanup(harness::Ctx& ctx) {
  auto client = startChat(ctx);
  auto s = joinedChat(ctx, *client, "room-7", "ana");
  ctx.Equal(subscribers("room-7"), 1, "after the join, the subscriptions in room-7");
  s->context.TryCancel();
  ctx.Settle();
  ctx.Equal(subscribers("room-7"), 0,
            "the client hung up: unsubscribe once the call is cancelled (ctx->IsCancelled()); subscriptions left in "
            "room-7 on this instance");
  // A client that closes its side normally must be cleaned up the same way.
  auto second = openChat(*client);
  second->send(ctx, chatJoin("room-7", "bo"));
  ctx.Settle();
  ctx.Assert(second->stream->WritesDone(), "closing the client side failed");
  ctx.Settle();
  ctx.Equal(subscribers("room-7"), 0,
            "the client finished its stream: clean up however the call ends; subscriptions left in room-7");
}
`,
  },
  debrief: `A bidi stream is two independent half-duplex streams over one HTTP/2 stream, which is why the handler splits into a reader and a writer. The join-first rule turns a stateless RPC into a session with a validated first message, and the cancellation hook is what makes long-lived calls safe: every resource acquired for the call is released by the call's end, whatever caused it. Real chat gateways add flow control (drop or coalesce when a slow client cannot keep up), keep-alive pings, and resume tokens so a reconnecting client asks for "everything since sequence N" instead of rejoining blind.`,
};
