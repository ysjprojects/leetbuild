import type {Step} from '@/lib/types';

export const streamingCancelStep: Step = {
  id: 'streaming-cancel',
  title: 'SSE stream: stop when the client leaves',
  concept: 'http',
  file: 'stream_api',
  focus: ['client', 'gateway', 'providers'],
  task: `## Task

The starter is a plausible model-generated draft: it streams the happy path correctly — connect,
receive chunks, write SSE frames — but it keeps paying the provider after the browser tab closes.
Find the missing cancellation path, fix it, and prove the fix.

Implement \`POST /v1/chat/stream\` as **Server-Sent Events**:

- Respond with \`Content-Type: text/event-stream\` and one frame per token:
  \`data: {"delta": "…"}\\n\\n\`.
- While streaming, check whether the **client disconnected**. On disconnect, cancel or close the
  upstream gRPC stream immediately and stop writing. A cancelled request that keeps generating is
  the most expensive bug in an AI gateway: the tenant is charged for tokens nobody will read.
- On normal completion emit the terminal \`data: [DONE]\\n\\n\` marker and record the number of
  output tokens so the usage step can bill them.
- Keep the provider deadline (8 s) and map an upstream failure to a closed stream rather than a
  half-written 500.

The failure mode the checks target is a stream that looks cancellable from the browser's point of
view but leaves the provider generating into a dead connection — and a response with no SSE content
type, which makes proxies buffer the whole stream.`,
  sequence: {
    participants: ['Client', 'Gateway', 'Providers'],
    messages: [
      {from: 'Client', to: 'Gateway', label: 'POST /v1/chat/stream', kind: 'sync'},
      {from: 'Gateway', to: 'Providers', label: 'StreamComplete(...) · deadline 8 s', kind: 'sync'},
      {from: 'Providers', to: 'Gateway', label: 'token', kind: 'async'},
      {from: 'Gateway', to: 'Client', label: 'data: {"delta":"…"}', kind: 'async'},
      {from: 'Client', to: 'Gateway', label: 'disconnect', kind: 'async'},
      {from: 'Gateway', to: 'Providers', label: 'cancel upstream · stop billing', kind: 'async'},
    ],
  },
  hints: [
    'The disconnect signal is on the request, not on the response: check it inside the streaming loop (once per chunk is enough), and return from the generator before the next provider read.',
    'Cancelling means acting on the upstream handle: `cancel()` on the async gRPC call, the stream context on Go, a kill switch on the Pekko source, or `TryCancel()` on the gRPC client context. Closing only the browser response leaves the provider running.',
    'The SSE contract has two easy-to-miss details: the media type must be exactly `text/event-stream`, and the terminal marker is `data: [DONE]` followed by a blank line. Count output tokens before the done frame so the usage event has a number.',
  ],
  checks: [
    {
      id: 'content-type',
      title: 'Responds as text/event-stream',
      detail:
        'The response declares `text/event-stream`; without it, intermediaries may buffer the stream and the browser will not treat the body as SSE.',
      match: {
        python: {all: [/media_type\s*=\s*"text\/event-stream"/]},
        go: {all: [/Content-Type", "text\/event-stream/]},
        scala: {all: [/text\/event-stream/]},
        cpp: {all: [/Content-Type", "text\/event-stream/]},
        typescript: {all: [/text\/event-stream/]},
      },
    },
    {
      id: 'sse-frames',
      title: 'Writes data frames followed by a blank line',
      detail:
        'Each chunk is written as `data: {"delta": …}` and terminated by two newlines, the framing SSE clients require.',
      match: {
        python: {all: [/data: /, /\\n\\n/]},
        go: {all: [/data: /, /\\n\\n/]},
        scala: {all: [/data: /, /\\n\\n/]},
        cpp: {all: [/data: /, /\\n\\n/]},
        typescript: {all: [/data: /, /\\n\\n/]},
      },
    },
    {
      id: 'disconnect',
      title: 'Checks for a client disconnect in the loop',
      detail:
        'The stream checks the request/connection signal on every chunk (or watches source termination) and stops before asking the provider for more.',
      match: {
        python: {all: [/request\.is_disconnected\(\)/]},
        go: {all: [/r\.Context\(\)\.Done\(\)|ctx\.Done\(\)/]},
        scala: {all: [/watchTermination/]},
        cpp: {all: [/sink\.is_writable\(\)/]},
        typescript: {all: [/request\.raw\.on\(\s*['"]close['"]/, /\bclosed\b/]},
      },
    },
    {
      id: 'cancel-upstream',
      title: 'Cancels or closes the upstream stream',
      detail:
        'A disconnect cancels the provider call itself — `cancel()`, the stream context, a kill switch, or `TryCancel()` — rather than merely returning from the writer.',
      match: {
        python: {all: [/upstream\.cancel\(\)/, /break|return/]},
        go: {all: [/cancel\(\)/, /return/]},
        scala: {all: [/killSwitch\.shutdown\(\)/]},
        cpp: {all: [/TryCancel\(\)/]},
        typescript: {all: [/upstream\.cancel\(\)/, /return|break/]},
      },
    },
    {
      id: 'done-and-usage',
      title: 'Emits [DONE] and counts output tokens',
      detail:
        'A normal completion ends with `data: [DONE]` and the stream has counted its output tokens for the usage event.',
      match: {
        python: {all: [/\[DONE\]/, /output_tokens/]},
        go: {all: [/\[DONE\]/, /outputTokens/]},
        scala: {all: [/\[DONE\]/, /outputTokens/]},
        cpp: {all: [/\[DONE\]/, /output_tokens/]},
        typescript: {all: [/\[DONE\]/, /outputTokens/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json
import math

import grpc

import providers_pb2
import providers_pb2_grpc
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI()
providers = providers_pb2_grpc.ProviderStub(grpc.aio.insecure_channel("providers:9000"))


class Message(BaseModel):
    role: str
    content: str


class StreamRequest(BaseModel):
    model: str = "gpt-4o-mini"
    messages: list[Message]
    max_tokens: int = 512


def authenticate(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise RuntimeError("missing bearer token")
    return authorization.removeprefix("Bearer ")


@app.post("/v1/chat/stream")
async def stream(body: StreamRequest, request: Request):
    authenticate(request.headers.get("authorization"))
    upstream = providers.StreamComplete(
        providers_pb2.StreamRequest(
            model=body.model,
            messages=[providers_pb2.Message(role=m.role, content=m.content) for m in body.messages],
            max_tokens=body.max_tokens,
        ),
        timeout=8.0,
    )

    # TODO: set media_type="text/event-stream"
    # TODO: check await request.is_disconnected(), cancel upstream, and stop reading
    # TODO: count output tokens and finish with data: [DONE]
    async def events():
        async for chunk in upstream:
            yield f"data: {json.dumps({'delta': chunk.text})}\\n\\n"

    return StreamingResponse(events())
`,
      solution: `import json
import math

import grpc

import providers_pb2
import providers_pb2_grpc
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI()
providers = providers_pb2_grpc.ProviderStub(grpc.aio.insecure_channel("providers:9000"))


class Message(BaseModel):
    role: str
    content: str


class StreamRequest(BaseModel):
    model: str = "gpt-4o-mini"
    messages: list[Message]
    max_tokens: int = 512


def authenticate(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise RuntimeError("missing bearer token")
    return authorization.removeprefix("Bearer ")


@app.post("/v1/chat/stream")
async def stream(body: StreamRequest, request: Request):
    authenticate(request.headers.get("authorization"))
    upstream = providers.StreamComplete(
        providers_pb2.StreamRequest(
            model=body.model,
            messages=[providers_pb2.Message(role=m.role, content=m.content) for m in body.messages],
            max_tokens=body.max_tokens,
        ),
        timeout=8.0,
    )

    async def events():
        output_tokens = 0
        try:
            async for chunk in upstream:
                if await request.is_disconnected():
                    upstream.cancel()
                    return
                output_tokens += max(1, math.ceil(len(chunk.text) / 4))
                yield f"data: {json.dumps({'delta': chunk.text})}\\n\\n"
        except grpc.aio.AioRpcError:
            return
        finally:
            upstream.cancel()
        yield "data: [DONE]\\n\\n"
        record_usage(output_tokens)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
`,
    },
    go: {
      starter: `package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	pb "gateway/providerspb"
)

var providers pb.ProviderClient

func streamChat(rw http.ResponseWriter, r *http.Request) {
	stream, err := providers.StreamComplete(r.Context(), &pb.StreamRequest{Model: "gpt-4o-mini"})
	if err != nil {
		return
	}
	// TODO: set Content-Type: text/event-stream
	// TODO: select on r.Context().Done(), cancel the stream and stop
	// TODO: count output tokens and finish with data: [DONE]
	for {
		chunk, err := stream.Recv()
		if err == io.EOF {
			return
		}
		if err != nil {
			return
		}
		payload, _ := json.Marshal(map[string]string{"delta": chunk.GetText()})
		_, _ = fmt.Fprintf(rw, "data: %s\\n\\n", payload)
	}
}

func main() {}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"

	pb "gateway/providerspb"
)

var providers pb.ProviderClient

func streamChat(rw http.ResponseWriter, r *http.Request) {
	rw.Header().Set("Content-Type", "text/event-stream")
	rw.Header().Set("Cache-Control", "no-cache")
	rw.Header().Set("X-Accel-Buffering", "no")
	flusher, _ := rw.(http.Flusher)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stream, err := providers.StreamComplete(ctx, &pb.StreamRequest{Model: "gpt-4o-mini"})
	if err != nil {
		return
	}
	outputTokens := 0
	for {
		select {
		case <-r.Context().Done():
			cancel()
			return
		default:
		}
		chunk, err := stream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			cancel()
			return
		}
		outputTokens += (len(chunk.GetText()) + 3) / 4
		payload, _ := json.Marshal(map[string]string{"delta": chunk.GetText()})
		if _, err := fmt.Fprintf(rw, "data: %s\\n\\n", payload); err != nil {
			cancel()
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
	}
	if _, err := fmt.Fprint(rw, "data: [DONE]\\n\\n"); err != nil {
		return
	}
	recordUsage(outputTokens)
}

func main() {}
`,
    },
    scala: {
      starter: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.stream.scaladsl.Source
import org.apache.pekko.util.ByteString
import providers.{ProviderGrpc, StreamRequest}
import scala.jdk.CollectionConverters._

object StreamApi {
  private val channel = io.grpc.ManagedChannelBuilder.forAddress("providers", 9000).usePlaintext().build()
  private val stub = ProviderGrpc.blockingStub(channel)

  val route: Route =
    path("v1" / "chat" / "stream") {
      post {
        entity(as[String]) { _ =>
          // TODO: use text/event-stream and watch termination to cancel upstream
          // TODO: stop when the client disconnects and finish with data: [DONE]
          val frames = Source
            .fromIterator(() => stub.streamComplete(StreamRequest(model = "gpt-4o-mini")).asScala)
            .map(chunk => ByteString("data: " + chunk.text + "\\n\\n"))
          complete(HttpResponse(StatusCodes.OK, entity = HttpEntity(ContentType.parse("application/json"), frames)))
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("gateway")
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.stream.{KillSwitches, Materializer}
import org.apache.pekko.stream.scaladsl.{Keep, Source}
import org.apache.pekko.util.ByteString
import providers.{ProviderGrpc, StreamRequest}
import scala.jdk.CollectionConverters._

object StreamApi {
  private implicit val system: ActorSystem = ActorSystem("gateway")
  private implicit val materializer: Materializer = Materializer(system)
  private val channel = io.grpc.ManagedChannelBuilder.forAddress("providers", 9000).usePlaintext().build()
  private val stub = ProviderGrpc.blockingStub(channel)

  val route: Route =
    path("v1" / "chat" / "stream") {
      post {
        entity(as[String]) { _ =>
          val outputTokens = new java.util.concurrent.atomic.AtomicLong(0)
          val (killSwitch, frames) = Source
            .fromIterator(() => stub.streamComplete(StreamRequest(model = "gpt-4o-mini")).asScala)
            .map { chunk =>
              outputTokens.addAndGet((chunk.text.length + 3) / 4)
              ByteString("data: " + chunk.text + "\\n\\n")
            }
            .concat(Source.single(ByteString("data: [DONE]\\n\\n")))
            .viaMat(KillSwitches.single)(Keep.right)
            .watchTermination() { (killSwitch, done) =>
              done.onComplete(_ => {
                killSwitch.shutdown()
                recordUsage(outputTokens.get())
              })
              killSwitch
            }
            .preMaterialize()
          complete(
            HttpResponse(
              StatusCodes.OK,
              entity = HttpEntity(ContentType.parse("text/event-stream"), frames)
            )
          )
        }
      }
    }

  def main(args: Array[String]): Unit = {
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <memory>
#include <string>

#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include "providers.grpc.pb.h"

using json = nlohmann::json;

int main() {
  auto channel = grpc::CreateChannel("providers:9000", grpc::InsecureChannelCredentials());
  auto stub = Provider::NewStub(channel);
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/v1/chat/stream", [&stub](const httplib::Request& req, httplib::Response& res) {
    auto context = std::make_shared<grpc::ClientContext>();
    ::StreamRequest request;
    request.set_model("gpt-4o-mini");
    auto reader = stub->StreamComplete(context.get(), request);
    // TODO: set Content-Type: text/event-stream
    // TODO: check sink.is_writable(), cancel with context->TryCancel() on disconnect
    // TODO: count output tokens and finish with data: [DONE]
    res.set_chunked_content_provider(
        "application/json",
        [reader](size_t, httplib::DataSink& sink) {
          ::StreamReply chunk;
          while (reader->Read(&chunk)) {
            const std::string frame = "data: " + json{{"delta", chunk.text()}}.dump() + "\\n\\n";
            if (!sink.write(frame.data(), frame.size())) return false;
          }
          sink.done();
          return true;
        });
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <memory>
#include <string>

#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include "providers.grpc.pb.h"

using json = nlohmann::json;

int main() {
  auto channel = grpc::CreateChannel("providers:9000", grpc::InsecureChannelCredentials());
  auto stub = Provider::NewStub(channel);
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/v1/chat/stream", [&stub](const httplib::Request& req, httplib::Response& res) {
    res.set_header("Content-Type", "text/event-stream");
    res.set_header("Cache-Control", "no-cache");
    auto context = std::make_shared<grpc::ClientContext>();
    context->set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(8));
    ::StreamRequest request;
    request.set_model("gpt-4o-mini");
    auto reader = stub->StreamComplete(context.get(), request);

    res.set_chunked_content_provider(
        "text/event-stream",
        [context, reader](size_t, httplib::DataSink& sink) {
          int output_tokens = 0;
          ::StreamReply chunk;
          while (reader->Read(&chunk)) {
            if (!sink.is_writable()) {
              context->TryCancel();
              return false;
            }
            output_tokens += (static_cast<int>(chunk.text().size()) + 3) / 4;
            const std::string frame = "data: " + json{{"delta", chunk.text()}}.dump() + "\\n\\n";
            if (!sink.write(frame.data(), frame.size())) {
              context->TryCancel();
              return false;
            }
          }
          const std::string done = "data: [DONE]\\n\\n";
          if (!sink.write(done.data(), done.size())) return false;
          sink.done();
          record_usage(output_tokens);
          return true;
        });
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

const app = Fastify();
const PROVIDER_TIMEOUT_MS = 8_000;

interface Message {
  role: string;
  content: string;
}
interface StreamRequest {
  model: string;
  messages: Message[];
  max_tokens: number;
}
interface StreamChunk {
  text: string;
}
interface ProviderClient {
  StreamComplete(
    request: StreamRequest,
    options: {deadline: number},
  ): grpc.ClientReadableStream<StreamChunk>;
}

const {providers} = grpc.loadPackageDefinition(protoLoader.loadSync('providers.proto')) as unknown as {
  providers: {Provider: new (target: string, credentials: grpc.ChannelCredentials) => ProviderClient};
};
const provider = new providers.Provider('providers:9000', grpc.credentials.createInsecure());

app.post('/v1/chat/stream', async (request, reply) => {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith('Bearer ')) {
    return reply.code(401).send({error: 'missing bearer token'});
  }
  const tenant = authorization.slice('Bearer '.length);
  const body = request.body as StreamRequest;
  reply.hijack();
  reply.raw.writeHead(200, {'Cache-Control': 'no-cache'});
  // TODO: set Content-Type: text/event-stream
  // TODO: watch request.raw 'close', cancel upstream and stop writing
  // TODO: count output tokens and finish with data: [DONE]
  const upstream = provider.StreamComplete(
    {
      model: body.model,
      messages: body.messages.map(message => ({role: message.role, content: message.content})),
      max_tokens: body.max_tokens,
    },
    {deadline: Date.now() + PROVIDER_TIMEOUT_MS},
  );
  try {
    for await (const chunk of upstream) {
      reply.raw.write(\`data: \${JSON.stringify({delta: chunk.text})}\\n\\n\`);
    }
  } catch {
    reply.raw.end();
    return;
  }
  reply.raw.end();
  return reply;
});

await app.listen({host: '0.0.0.0', port: 8443});
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

const app = Fastify();
const PROVIDER_TIMEOUT_MS = 8_000;

interface Message {
  role: string;
  content: string;
}
interface StreamRequest {
  model: string;
  messages: Message[];
  max_tokens: number;
}
interface StreamChunk {
  text: string;
}
interface ProviderClient {
  StreamComplete(
    request: StreamRequest,
    options: {deadline: number},
  ): grpc.ClientReadableStream<StreamChunk>;
}

const {providers} = grpc.loadPackageDefinition(protoLoader.loadSync('providers.proto')) as unknown as {
  providers: {Provider: new (target: string, credentials: grpc.ChannelCredentials) => ProviderClient};
};
const provider = new providers.Provider('providers:9000', grpc.credentials.createInsecure());

app.post('/v1/chat/stream', async (request, reply) => {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith('Bearer ')) {
    return reply.code(401).send({error: 'missing bearer token'});
  }
  const tenant = authorization.slice('Bearer '.length);
  const body = request.body as StreamRequest;
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  let closed = false;
  request.raw.on('close', () => {
    closed = true;
  });
  const upstream = provider.StreamComplete(
    {
      model: body.model,
      messages: body.messages.map(message => ({role: message.role, content: message.content})),
      max_tokens: body.max_tokens,
    },
    {deadline: Date.now() + PROVIDER_TIMEOUT_MS},
  );
  let outputTokens = 0;
  try {
    for await (const chunk of upstream) {
      if (closed) {
        upstream.cancel();
        reply.raw.end();
        return;
      }
      outputTokens += Math.max(1, Math.ceil(chunk.text.length / 4));
      reply.raw.write(\`data: \${JSON.stringify({delta: chunk.text})}\\n\\n\`);
    }
  } catch {
    reply.raw.end();
    return;
  }
  reply.raw.write('data: [DONE]\\n\\n');
  recordUsage(tenant, outputTokens);
  reply.raw.end();
  return reply;
});

await app.listen({host: '0.0.0.0', port: 8443});
`,
    },
  },
  debrief: `The interview signal is **cancellation as a first-class path**, not an error path. Most candidates demo the happy stream and never ask what happens when the client disconnects; the reviewer wants to see that you know where the disconnect signal lives, how to propagate it to the provider, and why closing the socket is not enough. The trace to draw is client disconnect → handler notices → upstream RPC cancelled → output tokens stop → usage reflects what was actually generated. Real gateways also cap stream duration, send keep-alive comments through idle proxies, and use a provider that supports cancellation end to end.`,
};
