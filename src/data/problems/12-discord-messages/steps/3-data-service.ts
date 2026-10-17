import type {Step} from '@/lib/types';

export const dataServiceStep: Step = {
  id: 'data-service',
  title: 'Data service: coalesce identical reads over gRPC',
  concept: 'grpc',
  file: 'data_service',
  focus: ['data', 'db'],
  task: `## Task

A hot channel is a thousand clients asking for the same page in the same second — every one of them a
range scan on the same partition. Put a **data service** in front of the table: one gRPC endpoint per
query, no business logic, and one trick, **request coalescing**.

\`\`\`proto
service MessageData {
  rpc GetMessages(GetMessagesRequest) returns (GetMessagesReply);
}
message GetMessagesRequest { uint64 channel_id = 1; uint64 before = 2; uint32 limit = 3; }
message Message           { uint64 id = 1; uint64 author_id = 2; string content = 3; }
message GetMessagesReply  { repeated Message messages = 1; }
\`\`\`

Implement \`GetMessages\` on the generated servicer; \`read_page\` (step 2) does the bucket walk and
\`serve()\` is provided.

- The coalescing key is **\`(channel_id, before, limit)\`**. The first caller for a key starts the
  database read as a task and records it in \`inflight\`; every caller that arrives while it runs
  **subscribes** to that task instead of reading again. One read, N replies.
- When the read finishes — success or failure — the key leaves \`inflight\`, so the next identical
  request reads fresh data rather than a stale result.
- A subscriber that hangs up must not cancel the read for everyone else: await the shared task through
  \`asyncio.shield\`. A failed read fails every subscriber with **UNAVAILABLE**.
- Map the rows to \`Message\` (ids are \`uint64\` on the wire) and answer a \`GetMessagesReply\`.

:::widget cache-aside {"stampede": true}

:::widget grpc-streams {"mode": "unary"}

> Coalescing is a cache with a lifetime of one request: nothing is stored, nothing can go stale, and the
> database sees one query per hot key per round trip instead of one per client.`,
  sequence: {
    participants: ['messages-api', 'data-service', 'messages'],
    messages: [
      {
        from: 'messages-api',
        to: 'data-service',
        label: 'GetMessages(ch 1032…, before, 50) ×400 within 8 ms',
        kind: 'sync',
      },
      {
        from: 'data-service',
        to: 'data-service',
        label: 'inflight[(ch, before, 50)] missing → start read_page task',
        kind: 'sync',
      },
      {from: 'data-service', to: 'messages', label: 'SELECT … bucket = 430 … LIMIT 50 (once)', kind: 'sync'},
      {from: 'data-service', to: 'data-service', label: '399 callers await the same task', kind: 'sync'},
      {from: 'messages', to: 'data-service', label: '50 rows', kind: 'reply'},
      {from: 'data-service', to: 'data-service', label: 'inflight.pop(key)', kind: 'sync'},
      {from: 'data-service', to: 'messages-api', label: 'GetMessagesReply{50 messages} ×400', kind: 'reply'},
    ],
  },
  hints: [
    'Look the key up in `inflight` first. Missing: create the task with `asyncio.create_task(read_page(...))`, store it under the key, and attach a done-callback that pops the key. Present: just use the task you found. Both paths then await the same task.',
    'Pop the key in a done-callback (or a `finally`), not after the await: it must disappear exactly once, however the read ended, and before any later caller could subscribe to a finished task.',
    '`await asyncio.shield(task)` lets a cancelled subscriber drop out without cancelling the task the others are waiting on; catch the exception around it and turn it into `context.abort(UNAVAILABLE, …)`.',
  ],
  checks: [
    {
      id: 'servicer',
      title: 'Serves MessageData.GetMessages',
      detail: 'A `MessageDataServicer` subclass is registered on the server with `add_MessageDataServicer_to_server`.',
      match: {
        python: {all: [/class \w+\(messages_pb2_grpc\.MessageDataServicer\)/, /add_MessageDataServicer_to_server\(/]},
        go: {all: [/pb\.UnimplementedMessageDataServer/, /pb\.RegisterMessageDataServer\(/]},
        scala: {all: [/extends MessageDataGrpc\.MessageData/, /MessageDataGrpc\.bindService\(/]},
        cpp: {all: [/public MessageData::Service/, /RegisterService\(/]},
      },
    },
    {
      id: 'reads-page',
      title: 'Delegates to read_page with the request’s channel, cursor and limit',
      detail:
        'The data service holds no business logic: the page comes from step 2’s `read_page(channel_id, before, limit)`.',
      match: {
        python: {all: [/read_page\(\s*request\.channel_id\s*,\s*request\.before\s*,\s*request\.limit\s*\)/]},
        go: {
          all: [
            /(?<!func )readPage\(/,
            /req\.GetChannelId\(\)|req\.ChannelId/,
            /req\.GetBefore\(\)|req\.Before/,
            /req\.GetLimit\(\)|req\.Limit/,
          ],
        },
        scala: {all: [/(?<!def )readPage\(/, /request\.channelId/, /request\.before/, /request\.limit/]},
        cpp: {all: [/(?<!json )read_page\(/, /request->channel_id\(\)/, /request->before\(\)/, /request->limit\(\)/]},
      },
    },
    {
      id: 'single-flight',
      title: 'One in-flight read per key, shared by every concurrent caller',
      detail:
        'The first request for `(channel_id, before, limit)` starts the read and stores it in `inflight`; concurrent requests for the same key await that same task instead of querying.',
      match: {
        python: {
          all: [/inflight\[\s*key\s*\]\s*=/, /inflight\.get\(\s*key\s*\)|key in inflight/, /asyncio\.create_task\(/],
        },
        go: {all: [/inflight\[\s*key\s*\]/, /<-\s*c\.done/, /close\(\s*c\.done\s*\)/]},
        scala: {all: [/inflight\.getOrElseUpdate\(\s*key/, /Future\s*[({]/]},
        cpp: {all: [/inflight\.find\(\s*key\s*\)/, /inflight\.emplace\(\s*key/, /std::shared_future</]},
      },
    },
    {
      id: 'slot-cleared',
      title: 'Removes the key when the read ends, success or failure',
      detail:
        'The key is popped from `inflight` once the task completes — in a done-callback or `finally` — so later requests read fresh data and a failed read is not served forever.',
      match: {
        python: {all: [/inflight\.pop\(\s*key|del inflight\[\s*key\s*\]/, /add_done_callback\(|finally:/]},
        go: {all: [/delete\(\s*inflight\s*,\s*key\s*\)/]},
        scala: {all: [/inflight\.remove\(\s*key\s*\)/, /onComplete/]},
        cpp: {all: [/inflight\.erase\(\s*key\s*\)/]},
      },
    },
    {
      id: 'reply',
      title: 'Answers a GetMessagesReply of Message rows',
      detail:
        'Each row becomes a `Message{id, author_id, content}` (ids as 64-bit integers) inside a `GetMessagesReply`.',
      match: {
        python: {all: [/messages_pb2\.GetMessagesReply\(/, /messages_pb2\.Message\(\s*id\s*=\s*int\(/]},
        go: {all: [/&pb\.GetMessagesReply\{/, /&pb\.Message\{\s*Id:/]},
        scala: {all: [/GetMessagesReply\(/, /Message\(\s*id\s*=/]},
        cpp: {all: [/reply->add_messages\(\)/, /set_id\(/, /set_author_id\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio

import grpc

import messages_pb2
import messages_pb2_grpc
from read_messages import read_page  # built in step 2: the bucket walk, [{"id", "author_id", "content"}] newest first

inflight: dict[tuple[int, int, int], asyncio.Task] = {}  # (channel_id, before, limit) → the one database read in flight


class MessageData(messages_pb2_grpc.MessageDataServicer):
    async def GetMessages(self, request, context: grpc.aio.ServicerContext):
        key = (request.channel_id, request.before, request.limit)
        # TODO: inflight.get(key) → missing: asyncio.create_task(read_page(...)), inflight[key] = task, done-callback pops key
        # TODO: rows = await asyncio.shield(task); a failed read → context.abort(UNAVAILABLE)
        # TODO: GetMessagesReply(messages=[Message(id=int(r["id"]), author_id=int(r["author_id"]), content=r["content"]) …])
        await context.abort(grpc.StatusCode.UNIMPLEMENTED, "not implemented")


async def serve() -> None:
    server = grpc.aio.server()
    messages_pb2_grpc.add_MessageDataServicer_to_server(MessageData(), server)
    server.add_insecure_port("[::]:9000")
    await server.start()
    await server.wait_for_termination()


if __name__ == "__main__":
    asyncio.run(serve())
`,
      solution: `import asyncio

import grpc

import messages_pb2
import messages_pb2_grpc
from read_messages import read_page  # built in step 2: the bucket walk, [{"id", "author_id", "content"}] newest first

inflight: dict[tuple[int, int, int], asyncio.Task] = {}  # (channel_id, before, limit) → the one database read in flight


class MessageData(messages_pb2_grpc.MessageDataServicer):
    async def GetMessages(self, request, context: grpc.aio.ServicerContext):
        key = (request.channel_id, request.before, request.limit)
        task = inflight.get(key)
        if task is None:  # first caller for this key: start the read; everyone arriving meanwhile subscribes to it
            task = asyncio.create_task(read_page(request.channel_id, request.before, request.limit))
            inflight[key] = task
            task.add_done_callback(lambda _: inflight.pop(key, None))
        try:
            rows = await asyncio.shield(task)  # a subscriber hanging up must not cancel the read for the others
        except Exception as e:
            await context.abort(grpc.StatusCode.UNAVAILABLE, f"messages store: {e}")
        return messages_pb2.GetMessagesReply(
            messages=[
                messages_pb2.Message(id=int(r["id"]), author_id=int(r["author_id"]), content=r["content"]) for r in rows
            ]
        )


async def serve() -> None:
    server = grpc.aio.server()
    messages_pb2_grpc.add_MessageDataServicer_to_server(MessageData(), server)
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
	"log"
	"net"
	"strconv"
	"sync"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "discord/gen/messages"
)

// Built in step 2 (read_messages.go): the bucket walk, newest first.
type storedMessage struct{ ID, AuthorID, Content string }

func readPage(ctx context.Context, channelID, before int64, limit int) ([]storedMessage, error) {
	panic("not implemented")
}

type pageKey struct {
	channel, before int64
	limit           uint32
}

// call is one database read in flight: done is closed once rows/err are set.
type call struct {
	done chan struct{}
	rows []*pb.Message
	err  error
}

var (
	mu       sync.Mutex
	inflight = map[pageKey]*call{} // (channel_id, before, limit) → the one database read in flight
)

type dataServer struct {
	pb.UnimplementedMessageDataServer
}

func (s *dataServer) GetMessages(ctx context.Context, req *pb.GetMessagesRequest) (*pb.GetMessagesReply, error) {
	key := pageKey{int64(req.GetChannelId()), int64(req.GetBefore()), req.GetLimit()}
	// TODO: under mu: inflight[key] present → wait on it; missing → register a new call and run readPage(...)
	// TODO: fill c.rows with &pb.Message{Id, AuthorId, Content}, close(c.done), delete(inflight, key)
	// TODO: c.err → codes.Unavailable; otherwise &pb.GetMessagesReply{Messages: c.rows}
	_ = key
	_ = strconv.ParseUint
	return nil, status.Error(codes.Unimplemented, "not implemented")
}

func main() {
	lis, _ := net.Listen("tcp", ":9000")
	srv := grpc.NewServer()
	pb.RegisterMessageDataServer(srv, &dataServer{})
	log.Fatal(srv.Serve(lis))
}
`,
      solution: `package main

import (
	"context"
	"log"
	"net"
	"strconv"
	"sync"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "discord/gen/messages"
)

// Built in step 2 (read_messages.go): the bucket walk, newest first.
type storedMessage struct{ ID, AuthorID, Content string }

func readPage(ctx context.Context, channelID, before int64, limit int) ([]storedMessage, error) {
	panic("not implemented")
}

type pageKey struct {
	channel, before int64
	limit           uint32
}

// call is one database read in flight: done is closed once rows/err are set.
type call struct {
	done chan struct{}
	rows []*pb.Message
	err  error
}

var (
	mu       sync.Mutex
	inflight = map[pageKey]*call{} // (channel_id, before, limit) → the one database read in flight
)

type dataServer struct {
	pb.UnimplementedMessageDataServer
}

func (s *dataServer) GetMessages(ctx context.Context, req *pb.GetMessagesRequest) (*pb.GetMessagesReply, error) {
	key := pageKey{int64(req.GetChannelId()), int64(req.GetBefore()), req.GetLimit()}
	mu.Lock()
	c, found := inflight[key]
	if found { // somebody is already reading this page: subscribe
		mu.Unlock()
		<-c.done
	} else { // first caller for this key: read on behalf of everyone who arrives meanwhile
		c = &call{done: make(chan struct{})}
		inflight[key] = c
		mu.Unlock()
		rows, err := readPage(context.WithoutCancel(ctx), key.channel, key.before, int(key.limit))
		for _, r := range rows {
			id, _ := strconv.ParseUint(r.ID, 10, 64)
			author, _ := strconv.ParseUint(r.AuthorID, 10, 64)
			c.rows = append(c.rows, &pb.Message{Id: id, AuthorId: author, Content: r.Content})
		}
		c.err = err
		mu.Lock()
		delete(inflight, key) // success or failure: the next identical request reads fresh
		mu.Unlock()
		close(c.done)
	}
	if c.err != nil {
		return nil, status.Error(codes.Unavailable, "messages store: "+c.err.Error())
	}
	return &pb.GetMessagesReply{Messages: c.rows}, nil
}

func main() {
	lis, _ := net.Listen("tcp", ":9000")
	srv := grpc.NewServer()
	pb.RegisterMessageDataServer(srv, &dataServer{})
	log.Fatal(srv.Serve(lis))
}
`,
    },
    scala: {
      starter: `import discord.messages.{GetMessagesReply, GetMessagesRequest, Message, MessageDataGrpc}
import io.grpc.{ServerBuilder, Status}
import scala.collection.mutable
import scala.concurrent.{ExecutionContext, Future}

object DataService extends MessageDataGrpc.MessageData {
  implicit val ec: ExecutionContext = ExecutionContext.global

  /** Built in step 2 (ReadMessages): the bucket walk, newest first. */
  final case class StoredMessage(id: String, authorId: String, content: String)
  def readPage(channelId: Long, before: Long, limit: Int): Vector[StoredMessage] = ???

  type Key = (Long, Long, Int)
  private val inflight = mutable.Map.empty[Key, Future[Vector[StoredMessage]]] // key → the one database read in flight

  override def getMessages(request: GetMessagesRequest): Future[GetMessagesReply] = {
    val key: Key = (request.channelId, request.before, request.limit)
    // TODO: inflight.synchronized: getOrElseUpdate(key, Future(readPage(...))) with onComplete removing the key
    // TODO: map the rows to Message(id = …, authorId = …, content = …) in a GetMessagesReply; a failure → UNAVAILABLE
    Future.failed(Status.UNIMPLEMENTED.withDescription("not implemented").asRuntimeException())
  }

  def main(args: Array[String]): Unit =
    ServerBuilder.forPort(9000).addService(MessageDataGrpc.bindService(this, ec)).build().start().awaitTermination()
}
`,
      solution: `import discord.messages.{GetMessagesReply, GetMessagesRequest, Message, MessageDataGrpc}
import io.grpc.{ServerBuilder, Status}
import scala.collection.mutable
import scala.concurrent.{ExecutionContext, Future}

object DataService extends MessageDataGrpc.MessageData {
  implicit val ec: ExecutionContext = ExecutionContext.global

  /** Built in step 2 (ReadMessages): the bucket walk, newest first. */
  final case class StoredMessage(id: String, authorId: String, content: String)
  def readPage(channelId: Long, before: Long, limit: Int): Vector[StoredMessage] = ???

  type Key = (Long, Long, Int)
  private val inflight = mutable.Map.empty[Key, Future[Vector[StoredMessage]]] // key → the one database read in flight

  override def getMessages(request: GetMessagesRequest): Future[GetMessagesReply] = {
    val key: Key = (request.channelId, request.before, request.limit)
    val read = inflight.synchronized {
      inflight.getOrElseUpdate(key, { // first caller for this key starts the read; the others subscribe to it
        val started = Future(readPage(request.channelId, request.before, request.limit))
        started.onComplete(_ => inflight.synchronized(inflight.remove(key))) // success or failure: the next request reads fresh
        started
      })
    }
    read
      .map(rows => GetMessagesReply(rows.map(r => Message(id = r.id.toLong, authorId = r.authorId.toLong, content = r.content))))
      .recover { case e: Exception =>
        throw Status.UNAVAILABLE.withDescription(s"messages store: \${e.getMessage}").asRuntimeException()
      }
  }

  def main(args: Array[String]): Unit =
    ServerBuilder.forPort(9000).addService(MessageDataGrpc.bindService(this, ec)).build().start().awaitTermination()
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <cstdint>
#include <exception>
#include <future>
#include <map>
#include <mutex>
#include <string>
#include <tuple>

#include "messages.grpc.pb.h"

using json = nlohmann::json;
using discord::GetMessagesReply;
using discord::GetMessagesRequest;
using discord::MessageData;

// Built in step 2 (read_messages.cpp): the bucket walk, [{"id", "author_id", "content"}] newest first.
json read_page(int64_t channel_id, int64_t before, int limit);

using Key = std::tuple<uint64_t, uint64_t, uint32_t>;
std::mutex inflight_mu;
std::map<Key, std::shared_future<json>> inflight;  // (channel_id, before, limit) → the one database read in flight

class DataService final : public MessageData::Service {
 public:
  grpc::Status GetMessages(grpc::ServerContext*, const GetMessagesRequest* request, GetMessagesReply* reply) override {
    const Key key{request->channel_id(), request->before(), request->limit()};
    // TODO: under inflight_mu: inflight.find(key) present → share its future; missing → emplace a promise's shared_future
    // TODO: the first caller runs read_page(...), fulfils the promise (value or exception), erases the key
    // TODO: for each row: reply->add_messages() with set_id / set_author_id / set_content; an exception → UNAVAILABLE
    (void)key;
    (void)reply;
    return grpc::Status(grpc::StatusCode::UNIMPLEMENTED, "not implemented");
  }
};

int main() {
  DataService service;
  grpc::ServerBuilder builder;
  builder.AddListeningPort("0.0.0.0:9000", grpc::InsecureServerCredentials());
  builder.RegisterService(&service);
  builder.BuildAndStart()->Wait();
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <cstdint>
#include <exception>
#include <future>
#include <map>
#include <mutex>
#include <string>
#include <tuple>

#include "messages.grpc.pb.h"

using json = nlohmann::json;
using discord::GetMessagesReply;
using discord::GetMessagesRequest;
using discord::MessageData;

// Built in step 2 (read_messages.cpp): the bucket walk, [{"id", "author_id", "content"}] newest first.
json read_page(int64_t channel_id, int64_t before, int limit);

using Key = std::tuple<uint64_t, uint64_t, uint32_t>;
std::mutex inflight_mu;
std::map<Key, std::shared_future<json>> inflight;  // (channel_id, before, limit) → the one database read in flight

class DataService final : public MessageData::Service {
 public:
  grpc::Status GetMessages(grpc::ServerContext*, const GetMessagesRequest* request, GetMessagesReply* reply) override {
    const Key key{request->channel_id(), request->before(), request->limit()};
    std::promise<json> promise;
    std::shared_future<json> read;
    bool leader = false;
    {
      std::lock_guard<std::mutex> guard(inflight_mu);
      const auto it = inflight.find(key);
      if (it != inflight.end()) {
        read = it->second;  // somebody is already reading this page: subscribe
      } else {
        read = promise.get_future().share();
        inflight.emplace(key, read);
        leader = true;
      }
    }
    if (leader) {  // first caller for this key: read on behalf of everyone who arrives meanwhile
      try {
        promise.set_value(read_page(static_cast<int64_t>(request->channel_id()), static_cast<int64_t>(request->before()),
                                    static_cast<int>(request->limit())));
      } catch (...) {
        promise.set_exception(std::current_exception());
      }
      std::lock_guard<std::mutex> guard(inflight_mu);
      inflight.erase(key);  // success or failure: the next identical request reads fresh
    }
    try {
      for (const auto& row : read.get()) {
        auto* message = reply->add_messages();
        message->set_id(std::stoull(row["id"].get<std::string>()));
        message->set_author_id(std::stoull(row["author_id"].get<std::string>()));
        message->set_content(row["content"].get<std::string>());
      }
    } catch (const std::exception& e) {
      return grpc::Status(grpc::StatusCode::UNAVAILABLE, std::string("messages store: ") + e.what());
    }
    return grpc::Status::OK;
  }
};

int main() {
  DataService service;
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
import time

import grpc

import messages_pb2
import messages_pb2_grpc
from messages.db import SCHEMA

EPOCH = 1420070400000
BUCKET_MS = 10 * 24 * 3600 * 1000
INSERT = "INSERT INTO messages (channel_id, bucket, message_id, author_id, content) VALUES (%s, %s, %s, %s, %s)"
NOW_B = (int(time.time() * 1000) - EPOCH) // BUCKET_MS


def sf(bucket, offset_ms=0):
    return ((bucket * BUCKET_MS + offset_ms) << 22) | (1 << 17)


CHANNEL = sf(NOW_B - 1, 5000)
END = sf(NOW_B, BUCKET_MS - 1)
PAGE = [{"id": str(sf(NOW_B, 3000)), "author_id": "7", "content": "c"}, {"id": str(sf(NOW_B, 2000)), "author_id": "7", "content": "b"}, {"id": str(sf(NOW_B, 1000)), "author_id": "9", "content": "a"}]


class _Store:
    """Stands in for step 2's read_page: counts reads, holds them until released, can fail once."""

    def __init__(self, page=PAGE):
        self.page = page
        self.calls = []
        self.gate = asyncio.Event()
        self.gate.set()
        self.fail = 0

    async def read_page(self, channel_id, before, limit):
        self.calls.append((channel_id, before, limit))
        await self.gate.wait()
        if self.fail:
            self.fail -= 1
            raise RuntimeError("scylla timed out")
        return [dict(r) for r in self.page[:limit]]


async def _start(ctx, rows=(), store=None):
    await ctx.db.reset(SCHEMA)
    for bucket, offset_ms, content in rows:
        await ctx.db.execute(INSERT, (str(CHANNEL), bucket, str(sf(bucket, offset_ms)), "7", content))
    m = ctx.load("data_service")
    if store is not None:
        m.read_page = store.read_page
    asyncio.create_task(m.serve())
    await asyncio.sleep(0)
    assert ctx.grpc.find("/discord.MessageData/GetMessages") is not None, "serve() registered no MessageData.GetMessages handler"
    return m, messages_pb2_grpc.MessageDataStub(grpc.aio.insecure_channel("data-1:9000"))


def _req(channel=CHANNEL, before=END, limit=50):
    return messages_pb2.GetMessagesRequest(channel_id=channel, before=before, limit=limit)


async def _settle(n=6):
    for _ in range(n):
        await asyncio.sleep(0)


async def check_servicer(ctx):
    m, stub = await _start(ctx, rows=[(NOW_B, 1000, "a"), (NOW_B, 2000, "b")])
    reply = await stub.GetMessages(_req())
    assert isinstance(reply, messages_pb2.GetMessagesReply), f"GetMessages must answer a GetMessagesReply, got {type(reply).__name__}"
    assert len(reply.messages) == 2, f"two stored messages must come back, got {len(reply.messages)}"


async def check_reads_page(ctx):
    rows = [(NOW_B - 1, 1000, "old"), (NOW_B, 1000, "a"), (NOW_B, 2000, "b"), (NOW_B, 3000, "c")]
    m, stub = await _start(ctx, rows=rows)
    reply = await stub.GetMessages(_req(limit=2))
    got = [(x.id, x.author_id, x.content) for x in reply.messages]
    assert got == [(sf(NOW_B, 3000), 7, "c"), (sf(NOW_B, 2000), 7, "b")], f"limit=2 must return the two newest rows, ids as 64-bit integers: got {got}"
    reply = await stub.GetMessages(_req(before=sf(NOW_B, 2000), limit=5))
    assert [x.content for x in reply.messages] == ["a", "old"], f"before=<id of b> must walk back to the channel's first bucket: expected a, old — got {[x.content for x in reply.messages]}"
    selects = [s for s in ctx.db.statements if s.lstrip().upper().startswith("SELECT")]
    assert selects, "the page must come from read_page, which queries the messages table"


async def check_single_flight(ctx):
    store = _Store()
    m, stub = await _start(ctx, store=store)
    store.gate.clear()
    fan_out = asyncio.gather(*[stub.GetMessages(_req()) for _ in range(5)])
    other = asyncio.ensure_future(stub.GetMessages(_req(limit=10)))
    await _settle()
    assert len(store.calls) >= 1, "no database read was started for the concurrent requests"
    assert len(store.calls) == 2, f"5 identical requests plus one with another limit must start exactly 2 reads while the first is still running, started {len(store.calls)}: {store.calls}"
    assert store.calls[0] == (CHANNEL, END, 50) and store.calls[1] == (CHANNEL, END, 10), f"read_page must receive the request's channel_id, before and limit, got {store.calls}"
    store.gate.set()
    replies = await fan_out
    await other
    for reply in replies:
        assert [x.content for x in reply.messages] == ["c", "b", "a"], f"every coalesced caller gets the full page, one got {[x.content for x in reply.messages]}"
    assert len(store.calls) == 2, f"no extra read may happen once the callers are served, saw {len(store.calls)}"
    # One impatient subscriber must not cancel the read for the others.
    store.gate.clear()
    first = asyncio.ensure_future(stub.GetMessages(_req()))
    second = asyncio.ensure_future(stub.GetMessages(_req()))
    await _settle()
    first.cancel()
    await _settle()
    store.gate.set()
    try:
        reply = await second
    except (grpc.RpcError, asyncio.CancelledError) as e:
        raise AssertionError(f"a subscriber hung up and the other caller's request failed with {e!r}: await the shared task through asyncio.shield")
    assert [x.content for x in reply.messages] == ["c", "b", "a"], "the remaining subscriber must still get the full page"


async def check_slot_cleared(ctx):
    store = _Store()
    m, stub = await _start(ctx, store=store)
    await stub.GetMessages(_req())
    await _settle()
    assert not m.inflight, f"the key must leave inflight once the read completed, inflight still holds {list(m.inflight)}"
    await stub.GetMessages(_req())
    assert len(store.calls) == 2, f"an identical request after the first completed must read again (no stale result), saw {len(store.calls)} read(s)"
    store.fail = 1
    store.gate.clear()
    calls = [asyncio.ensure_future(stub.GetMessages(_req())) for _ in range(2)]
    await _settle()
    store.gate.set()
    for call in calls:
        try:
            await call
            raise AssertionError("a failed database read must fail the callers, not answer an empty page")
        except grpc.RpcError as e:
            assert e.code() == grpc.StatusCode.UNAVAILABLE, f"a failed read must surface as UNAVAILABLE, got {e.code()}"
    assert len(store.calls) == 3, f"both callers must have shared the one failing read, saw {len(store.calls)} read(s)"
    await _settle()
    assert not m.inflight, f"a failed read must leave inflight too, it still holds {list(m.inflight)}"
    reply = await stub.GetMessages(_req())
    assert [x.content for x in reply.messages] == ["c", "b", "a"], "after a failure the next request must read fresh and succeed"


async def check_reply(ctx):
    rows = [(NOW_B, 1000, "a"), (NOW_B, 2000, "b")]
    m, stub = await _start(ctx, rows=rows)
    reply = await stub.GetMessages(_req())
    assert len(reply.messages) == 2, f"expected 2 messages, got {len(reply.messages)}"
    assert [x.id for x in reply.messages] == [sf(NOW_B, 2000), sf(NOW_B, 1000)], f"Message.id must carry the exact 64-bit snowflake, newest first: got {[x.id for x in reply.messages]}"
    assert all(x.id > 2**53 for x in reply.messages), "ids above 2**53 must survive: they are uint64 on the wire, not floats"
    assert [(x.author_id, x.content) for x in reply.messages] == [(7, "b"), (7, "a")], f"author_id and content must be copied into each Message: {[(x.author_id, x.content) for x in reply.messages]}"
    reply = await stub.GetMessages(_req(before=sf(NOW_B, 1000)))
    assert len(reply.messages) == 0, "an empty page is an empty GetMessagesReply, not an error"
`,
  },
  debrief: `The data service does less than the API and that is its value: one endpoint per query, no business logic, and the single place where concurrency towards the database can be shaped. Coalescing is the shape that matters for a chat system, because the hot key is never a secret — it is the newest page of the channel everyone just opened — and because identical reads in flight at the same instant want the same answer, so sharing it costs no freshness. Discord's Rust services do exactly this: the first request spawns a worker task, later requests check for the task and subscribe, the worker queries once and fans the rows out. Removing the key on completion keeps the cache's lifetime at one request; shielding the task keeps one client's timeout from becoming everyone's error. Real deployments add a per-key concurrency limit for writes, hedge a slow read against a second replica, and export the coalescing ratio as the metric that tells you a partition is hot before the database does.`,
};
