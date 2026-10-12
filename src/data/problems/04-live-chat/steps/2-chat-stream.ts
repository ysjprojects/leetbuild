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
)

// Built in step 3 (room_bus.go) and provided (subscriptions.go).
func publish(ctx context.Context, room string, msg *pb.ServerMsg) error { panic("not implemented") }
func subscribe(room string) <-chan *pb.ServerMsg                       { panic("not implemented") }
func unsubscribe(room string, sub <-chan *pb.ServerMsg)                { panic("not implemented") }

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
)

// Built in step 3 (room_bus.go) and provided (subscriptions.go).
func publish(ctx context.Context, room string, msg *pb.ServerMsg) error { panic("not implemented") }
func subscribe(room string) <-chan *pb.ServerMsg                       { panic("not implemented") }
func unsubscribe(room string, sub <-chan *pb.ServerMsg)                { panic("not implemented") }

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
  },
  debrief: `A bidi stream is two independent half-duplex streams over one HTTP/2 stream, which is why the handler splits into a reader and a writer. The join-first rule turns a stateless RPC into a session with a validated first message, and the cancellation hook is what makes long-lived calls safe: every resource acquired for the call is released by the call's end, whatever caused it. Real chat gateways add flow control (drop or coalesce when a slow client cannot keep up), keep-alive pings, and resume tokens so a reconnecting client asks for "everything since sequence N" instead of rejoining blind.`,
};
