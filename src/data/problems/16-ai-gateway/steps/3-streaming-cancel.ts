import type {Step} from '@/lib/types';

// ---- 3. SSE stream that stops when the client leaves -------------------------------------------------
export const streamingCancelStep: Step = {
  id: 'streaming-cancel',
  title: 'Stream tokens, stop when the tab closes',
  concept: 'http',
  file: 'chat_stream',
  focus: ['client', 'gateway', 'providers'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/chat/stream\` with the chat body of step 1. It
authenticates the tenant, opens \`Provider.StreamComplete\` with the 8 s stream deadline and writes
one \`data: {"delta": "<token>"}\` frame, terminated by a blank line, per chunk the provider sends.
It serves the demo and hides 4 flaws.

**Failure mode the checks target.** A user closes the tab after the second token and the gateway
keeps reading tokens from the provider into a dead connection, paying for every one of them; a
proxy in front of the gateway buffers the whole stream because the response did not say what it
was; and billing has no number for what was streamed.

- The response is \`Content-Type: text/event-stream\`.
- While streaming, notice that the **client disconnected** (the request's disconnect signal, the
  write's return value, the connection's lifetime) and stop writing.
- On disconnect, **cancel the upstream call** so the provider stops generating.
- A stream that completes ends with \`data: {"usage": {"output_tokens": N}}\` (N chunks relayed)
  and then \`data: [DONE]\`, each followed by a blank line.`,
  sequence: {
    participants: ['Client', 'gateway', 'Provider'],
    messages: [
      {from: 'Client', to: 'gateway', label: 'POST /v1/chat/stream', kind: 'sync'},
      {from: 'gateway', to: 'Provider', label: 'StreamComplete(...) · deadline 8 s', kind: 'sync'},
      {from: 'Provider', to: 'gateway', label: 'Chunk{"The"}', kind: 'async'},
      {from: 'gateway', to: 'Client', label: 'data: {"delta": "The"}', kind: 'async'},
      {from: 'Client', to: 'gateway', label: 'connection closed', kind: 'async'},
      {from: 'gateway', to: 'Provider', label: 'cancel', kind: 'async'},
      {
        from: 'gateway',
        to: 'Client',
        label: 'data: {"usage": …} · data: [DONE]  (a stream that completes)',
        kind: 'async',
      },
    ],
  },
  hints: [
    'A tenant closes the tab mid-answer and the provider bill still shows the full completion; the browser never sees the stream as events because the response arrived as plain text, all at once.',
    'The loop reads the next chunk and writes it without ever asking whether anyone is still reading, and the upstream call outlives the response: nothing tells the provider to stop. The response never declared `text/event-stream`.',
    'Declare the media type; in the loop, stop on the disconnect signal (`is_disconnected()`, the `close` event, the request context, `sink.write` returning false) and cancel the upstream call (`cancel()`, `TryCancel()`, the request-bound context); count chunks and write the usage frame and `[DONE]` after the loop.',
  ],
  checks: [
    {
      id: 'sse-frames',
      title: 'Writes data frames followed by a blank line',
      detail:
        'Each chunk is written as `data: {"delta": …}` terminated by two newlines, the framing SSE clients require.',
      match: {
        python: {all: [/data: /, /\\n\\n/]},
        typescript: {all: [/data: /, /\\n\\n/]},
        go: {all: [/data: /, /\\n\\n/]},
        scala: {all: [/data: /, /\\n\\n/]},
        cpp: {all: [/data: /, /\\n\\n/]},
      },
    },
    {
      id: 'content-type',
      title: 'Responds as text/event-stream',
      detail:
        'The response declares `text/event-stream`; without it intermediaries buffer the stream and the browser does not treat the body as events.',
      match: {
        python: {all: [/text\/event-stream/]},
        typescript: {all: [/text\/event-stream/]},
        go: {all: [/text\/event-stream/]},
        scala: {all: [/text\/event-stream/]},
        cpp: {all: [/text\/event-stream/]},
      },
    },
    {
      id: 'disconnect',
      title: 'Stops writing once the client has left',
      detail:
        "The loop consults the disconnect signal before relaying the next chunk (`is_disconnected()`, the connection's `close` event, the request context, `sink.write` / `is_writable()`); frames written into a closed connection are tokens paid for nothing.",
      match: {
        python: {all: [/is_disconnected\(\)/]},
        typescript: {all: [/\.on\(\s*['"]close['"]|\.once\(\s*['"]close['"]|\.destroyed\b|\.aborted\b/]},
        go: {
          all: [/r\.Context\(\)/],
          none: [/StreamComplete\(\s*context\.Background\(\)|WithTimeout\(\s*context\.Background\(\)/],
        },
        scala: {all: [/watchTermination/]},
        cpp: {all: [/sink\.is_writable\(\)|!\s*sink\.write\(/]},
      },
    },
    {
      id: 'cancel-upstream',
      title: 'Cancels the upstream call on disconnect',
      detail:
        "A disconnect cancels the provider call itself (`cancel()`, `TryCancel()`, a context derived from the request's) rather than only returning from the writer; a call nobody cancels keeps the provider generating.",
      match: {
        python: {all: [/\.cancel\(\)/]},
        typescript: {all: [/\.cancel\(\)/]},
        go: {all: [/context\.With(Timeout|Deadline|Cancel)\(\s*r\.Context\(\)/]},
        scala: {all: [/\.cancel\(/]},
        cpp: {all: [/TryCancel\(\)/]},
      },
    },
    {
      id: 'done-and-usage',
      title: 'Ends with a usage frame and [DONE]',
      detail:
        'A stream that completes writes `data: {"usage": {"output_tokens": N}}` with the number of chunks relayed, then `data: [DONE]`.',
      match: {
        python: {all: [/\[DONE\]/, /output_tokens/]},
        typescript: {all: [/\[DONE\]/, /output_tokens/]},
        go: {all: [/\[DONE\]/, /output_tokens/]},
        scala: {all: [/\[DONE\]/, /output_tokens/]},
        cpp: {all: [/\[DONE\]/, /output_tokens/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import json

import grpc
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import providers_pb2
import providers_pb2_grpc
from gateway.auth import authenticate

app = FastAPI()

STREAM_TIMEOUT_S = 8.0

providers = providers_pb2_grpc.ProviderStub(grpc.aio.insecure_channel("providers:9000"))


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str = "gpt-4o-mini"
    messages: list[Message]
    max_tokens: int = 512


def frame(data) -> str:
    """One SSE frame: \`data: <json>\` and a blank line."""
    return f"data: {json.dumps(data)}\\n\\n"


# TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
@app.post("/v1/chat/stream")
async def stream(body: ChatRequest, request: Request):
    authenticate(request.headers.get("authorization"))
    upstream = providers.StreamComplete(
        providers_pb2.CompleteRequest(
            model=body.model,
            messages=[providers_pb2.Message(role=m.role, content=m.content) for m in body.messages],
            max_tokens=body.max_tokens,
        ),
        timeout=STREAM_TIMEOUT_S,
    )

    async def events():
        async for chunk in upstream:
            yield frame({"delta": chunk.text})

    return StreamingResponse(events())
`,
      solution: `import json

import grpc
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import providers_pb2
import providers_pb2_grpc
from gateway.auth import authenticate

app = FastAPI()

STREAM_TIMEOUT_S = 8.0

providers = providers_pb2_grpc.ProviderStub(grpc.aio.insecure_channel("providers:9000"))


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str = "gpt-4o-mini"
    messages: list[Message]
    max_tokens: int = 512


def frame(data) -> str:
    """One SSE frame: \`data: <json>\` and a blank line."""
    return f"data: {json.dumps(data)}\\n\\n"


@app.post("/v1/chat/stream")
async def stream(body: ChatRequest, request: Request):
    authenticate(request.headers.get("authorization"))
    upstream = providers.StreamComplete(
        providers_pb2.CompleteRequest(
            model=body.model,
            messages=[providers_pb2.Message(role=m.role, content=m.content) for m in body.messages],
            max_tokens=body.max_tokens,
        ),
        timeout=STREAM_TIMEOUT_S,
    )

    async def events():
        output_tokens = 0
        try:
            async for chunk in upstream:
                if await request.is_disconnected():
                    return  # the finally cancels: the provider stops generating
                output_tokens += 1
                yield frame({"delta": chunk.text})
        except grpc.RpcError:
            return  # the provider failed mid-stream: the client sees the stream end without [DONE]
        finally:
            upstream.cancel()  # a no-op once the stream has completed
        yield frame({"usage": {"output_tokens": output_tokens}})
        yield "data: [DONE]\\n\\n"

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify, {type FastifyReply, type FastifyRequest} from 'fastify';
import {authenticate} from 'gateway/auth';

export const app = Fastify();

export const STREAM_TIMEOUT_MS = 8_000;

interface Message {
  role: string;
  content: string;
}
interface ChatRequest {
  model: string;
  messages: Message[];
  max_tokens: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('providers.proto')) as unknown as {
  gateway: {Provider: grpc.ServiceClientConstructor};
};
const providers = new pkg.gateway.Provider('providers:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  StreamComplete(request: ChatRequest, options: grpc.CallOptions): grpc.ClientReadableStream<{text: string}>;
};

/** One SSE frame: \`data: <json>\` and a blank line. */
const frame = (data: unknown): string => \`data: \${JSON.stringify(data)}\\n\\n\`;

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
/** The stream handler, on the raw response: Fastify hands the socket over with reply.hijack(). */
export async function streamChat(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  authenticate(request.headers.authorization);
  const body = request.body as ChatRequest;
  const upstream = providers.StreamComplete(
    {model: body.model, messages: body.messages.map(m => ({role: m.role, content: m.content})), max_tokens: body.max_tokens},
    {deadline: Date.now() + STREAM_TIMEOUT_MS},
  );
  reply.hijack();
  reply.raw.writeHead(200, {'Cache-Control': 'no-cache'});
  try {
    for await (const chunk of upstream) {
      reply.raw.write(frame({delta: chunk.text}));
    }
  } catch {
    // the provider failed mid-stream: the client sees the stream end
  }
  reply.raw.end();
}

app.post('/v1/chat/stream', streamChat);
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify, {type FastifyReply, type FastifyRequest} from 'fastify';
import {authenticate} from 'gateway/auth';

export const app = Fastify();

export const STREAM_TIMEOUT_MS = 8_000;

interface Message {
  role: string;
  content: string;
}
interface ChatRequest {
  model: string;
  messages: Message[];
  max_tokens: number;
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('providers.proto')) as unknown as {
  gateway: {Provider: grpc.ServiceClientConstructor};
};
const providers = new pkg.gateway.Provider('providers:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  StreamComplete(request: ChatRequest, options: grpc.CallOptions): grpc.ClientReadableStream<{text: string}>;
};

/** One SSE frame: \`data: <json>\` and a blank line. */
const frame = (data: unknown): string => \`data: \${JSON.stringify(data)}\\n\\n\`;

/** The stream handler, on the raw response: Fastify hands the socket over with reply.hijack(). */
export async function streamChat(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  authenticate(request.headers.authorization);
  const body = request.body as ChatRequest;
  const upstream = providers.StreamComplete(
    {model: body.model, messages: body.messages.map(m => ({role: m.role, content: m.content})), max_tokens: body.max_tokens},
    {deadline: Date.now() + STREAM_TIMEOUT_MS},
  );
  let closed = false;
  request.raw.on('close', () => {
    closed = true;
    upstream.cancel(); // the provider stops generating
  });
  reply.hijack();
  reply.raw.writeHead(200, {'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'});
  let outputTokens = 0;
  try {
    for await (const chunk of upstream) {
      if (closed) return;
      outputTokens += 1;
      reply.raw.write(frame({delta: chunk.text}));
    }
  } catch {
    reply.raw.end(); // the provider failed mid-stream: the client sees the stream end without [DONE]
    return;
  }
  if (closed) return;
  reply.raw.write(frame({usage: {output_tokens: outputTokens}}));
  reply.raw.write('data: [DONE]\\n\\n');
  reply.raw.end();
}

app.post('/v1/chat/stream', streamChat);
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"gateway/auth"
	pb "gateway/gen/providers"
)

const streamTimeout = 8 * time.Second

var conn, _ = grpc.NewClient("providers:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var providers = pb.NewProviderClient(conn)

type chatMessage struct {
	Role    string \`json:"role"\`
	Content string \`json:"content"\`
}

type chatRequest struct {
	Model     string        \`json:"model"\`
	Messages  []chatMessage \`json:"messages"\`
	MaxTokens int           \`json:"max_tokens"\`
}

// frame is one SSE frame: "data: <json>" and a blank line.
func frame(data any) string {
	payload, _ := json.Marshal(data)
	return fmt.Sprintf("data: %s\\n\\n", payload)
}

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
func streamChat(rw http.ResponseWriter, r *http.Request) {
	if _, ok := auth.Tenant(r); !ok {
		http.Error(rw, "missing bearer token", http.StatusUnauthorized)
		return
	}
	var body chatRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid json", http.StatusBadRequest)
		return
	}
	req := &pb.CompleteRequest{Model: body.Model, MaxTokens: int32(body.MaxTokens)}
	for _, m := range body.Messages {
		req.Messages = append(req.Messages, &pb.Message{Role: m.Role, Content: m.Content})
	}
	ctx, cancel := context.WithTimeout(context.Background(), streamTimeout)
	defer cancel()
	upstream, err := providers.StreamComplete(ctx, req)
	if err != nil {
		http.Error(rw, "provider failed", http.StatusBadGateway)
		return
	}
	rw.Header().Set("Cache-Control", "no-cache")
	rw.WriteHeader(http.StatusOK)
	flusher, _ := rw.(http.Flusher)
	for {
		chunk, err := upstream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			return // the provider failed mid-stream: the client sees the stream end
		}
		io.WriteString(rw, frame(map[string]string{"delta": chunk.GetText()}))
		if flusher != nil {
			flusher.Flush()
		}
	}
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/chat/stream", streamChat)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"gateway/auth"
	pb "gateway/gen/providers"
)

const streamTimeout = 8 * time.Second

var conn, _ = grpc.NewClient("providers:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var providers = pb.NewProviderClient(conn)

type chatMessage struct {
	Role    string \`json:"role"\`
	Content string \`json:"content"\`
}

type chatRequest struct {
	Model     string        \`json:"model"\`
	Messages  []chatMessage \`json:"messages"\`
	MaxTokens int           \`json:"max_tokens"\`
}

// frame is one SSE frame: "data: <json>" and a blank line.
func frame(data any) string {
	payload, _ := json.Marshal(data)
	return fmt.Sprintf("data: %s\\n\\n", payload)
}

func streamChat(rw http.ResponseWriter, r *http.Request) {
	if _, ok := auth.Tenant(r); !ok {
		http.Error(rw, "missing bearer token", http.StatusUnauthorized)
		return
	}
	var body chatRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		http.Error(rw, "invalid json", http.StatusBadRequest)
		return
	}
	req := &pb.CompleteRequest{Model: body.Model, MaxTokens: int32(body.MaxTokens)}
	for _, m := range body.Messages {
		req.Messages = append(req.Messages, &pb.Message{Role: m.Role, Content: m.Content})
	}
	// Derived from the request's context: when the client disconnects, net/http cancels it, and
	// with it the upstream call. The deadline bounds the whole stream.
	ctx, cancel := context.WithTimeout(r.Context(), streamTimeout)
	defer cancel()
	upstream, err := providers.StreamComplete(ctx, req)
	if err != nil {
		http.Error(rw, "provider failed", http.StatusBadGateway)
		return
	}
	rw.Header().Set("Content-Type", "text/event-stream")
	rw.Header().Set("Cache-Control", "no-cache")
	rw.WriteHeader(http.StatusOK)
	flusher, _ := rw.(http.Flusher)
	outputTokens := 0
	for {
		chunk, err := upstream.Recv()
		if err == io.EOF {
			break
		}
		if err != nil {
			return // cancelled by the client, or the provider failed mid-stream: the client sees the stream end
		}
		if r.Context().Err() != nil {
			return // the client is gone: nothing to write to
		}
		outputTokens++
		if _, err := io.WriteString(rw, frame(map[string]string{"delta": chunk.GetText()})); err != nil {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
	}
	io.WriteString(rw, frame(map[string]any{"usage": map[string]int{"output_tokens": outputTokens}}))
	io.WriteString(rw, "data: [DONE]\\n\\n")
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/chat/stream", streamChat)
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import gateway.Auth
import gateway.providers.{Chunk, CompleteRequest, Message, ProviderGrpc}
import io.grpc.ManagedChannelBuilder
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.stream.scaladsl.Source
import org.apache.pekko.util.ByteString

import scala.jdk.CollectionConverters._

object ChatStream {
  val StreamTimeoutMillis = 8000L

  private val channel = ManagedChannelBuilder.forAddress("providers", 9000).usePlaintext().build()
  private val providers = ProviderGrpc.blockingStub(channel)

  case class ChatMessage(role: String, content: String)
  case class ChatRequest(model: String, messages: Seq[ChatMessage], maxTokens: Int)

  def parse(body: String): ChatRequest = {
    val json = ujson.read(body)
    val messages = json.obj.get("messages").map(_.arr.toSeq).getOrElse(Seq.empty).map { m =>
      ChatMessage(m.obj.get("role").map(_.str).getOrElse(""), m.obj.get("content").map(_.str).getOrElse(""))
    }
    ChatRequest(json.obj.get("model").map(_.str).getOrElse("gpt-4o-mini"), messages, json.obj.get("max_tokens").map(_.num.toInt).getOrElse(512))
  }

  /** One SSE frame: \`data: <json>\` and a blank line. */
  def frame(data: ujson.Value): ByteString = ByteString(s"data: \${ujson.write(data)}\\n\\n")

  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  val route: Route =
    path("v1" / "chat" / "stream") {
      post {
        optionalHeaderValueByName("Authorization") { authorization =>
          Auth.tenant(authorization) match {
            case None => complete(HttpResponse(StatusCodes.Unauthorized, entity = "missing bearer token"))
            case Some(_) =>
              entity(as[String]) { raw =>
                val body = parse(raw)
                val request = CompleteRequest(
                  model = body.model,
                  messages = body.messages.map(m => Message(role = m.role, content = m.content)),
                  maxTokens = body.maxTokens,
                )
                val upstream: Iterator[Chunk] =
                  providers.withDeadlineAfter(StreamTimeoutMillis, TimeUnit.MILLISECONDS).streamComplete(request)
                val frames = Source.fromIterator(() => upstream).map(chunk => frame(ujson.Obj("delta" -> chunk.text)))
                complete(HttpEntity(ContentTypes.\`text/plain(UTF-8)\`, frames))
              }
          }
        }
      }
    }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import gateway.Auth
import gateway.providers.{Chunk, CompleteRequest, Message, ProviderGrpc}
import io.grpc.{Context, ManagedChannelBuilder}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import org.apache.pekko.stream.scaladsl.Source
import org.apache.pekko.util.ByteString

import scala.jdk.CollectionConverters._

object ChatStream {
  val StreamTimeoutMillis = 8000L

  private val channel = ManagedChannelBuilder.forAddress("providers", 9000).usePlaintext().build()
  private val providers = ProviderGrpc.blockingStub(channel)

  case class ChatMessage(role: String, content: String)
  case class ChatRequest(model: String, messages: Seq[ChatMessage], maxTokens: Int)

  def parse(body: String): ChatRequest = {
    val json = ujson.read(body)
    val messages = json.obj.get("messages").map(_.arr.toSeq).getOrElse(Seq.empty).map { m =>
      ChatMessage(m.obj.get("role").map(_.str).getOrElse(""), m.obj.get("content").map(_.str).getOrElse(""))
    }
    ChatRequest(json.obj.get("model").map(_.str).getOrElse("gpt-4o-mini"), messages, json.obj.get("max_tokens").map(_.num.toInt).getOrElse(512))
  }

  /** One SSE frame: \`data: <json>\` and a blank line. */
  def frame(data: ujson.Value): ByteString = ByteString(s"data: \${ujson.write(data)}\\n\\n")

  val EventStream: ContentType = MediaTypes.\`text/event-stream\`.toContentType

  val route: Route =
    path("v1" / "chat" / "stream") {
      post {
        optionalHeaderValueByName("Authorization") { authorization =>
          Auth.tenant(authorization) match {
            case None => complete(HttpResponse(StatusCodes.Unauthorized, entity = "missing bearer token"))
            case Some(_) =>
              (entity(as[String]) & extractExecutionContext) { (raw, ec) =>
                val body = parse(raw)
                val request = CompleteRequest(
                  model = body.model,
                  messages = body.messages.map(m => Message(role = m.role, content = m.content)),
                  maxTokens = body.maxTokens,
                )
                // The call runs under a cancellable gRPC context: cancelling it ends the upstream stream.
                val cancellable = Context.current().withCancellation()
                val upstream: Iterator[Chunk] = cancellable.call(() =>
                  providers.withDeadlineAfter(StreamTimeoutMillis, TimeUnit.MILLISECONDS).streamComplete(request)
                )
                var outputTokens = 0
                val frames = Source
                  .fromIterator(() => upstream)
                  .map { chunk =>
                    outputTokens += 1
                    frame(ujson.Obj("delta" -> chunk.text))
                  }
                  .concat(Source.lazySingle(() => frame(ujson.Obj("usage" -> ujson.Obj("output_tokens" -> outputTokens)))))
                  .concat(Source.single(ByteString("data: [DONE]\\n\\n")))
                  .watchTermination() { (mat, done) =>
                    // The client left (or the stream ended): cancel the provider call either way.
                    done.onComplete(_ => cancellable.cancel(null))(ec)
                    mat
                  }
                complete(HttpEntity(EventStream, frames))
              }
          }
        }
      }
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <string>

#include "gateway/auth.h"
#include "providers.grpc.pb.h"

constexpr std::chrono::seconds kStreamTimeout{8};

auto channel = grpc::CreateChannel("providers:9000", grpc::InsecureChannelCredentials());
auto stub = gateway::Provider::NewStub(channel);

// One SSE frame: "data: <json>" and a blank line.
std::string frame(const nlohmann::json& data) { return "data: " + data.dump() + "\\n\\n"; }

// The upstream call, kept alive for as long as the response is being written.
struct Upstream {
  grpc::ClientContext ctx;
  std::unique_ptr<grpc::ClientReader<gateway::Chunk>> reader;
};

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
void stream_chat(const httplib::Request& req, httplib::Response& res) {
  if (!gateway::tenant(req)) {
    res.status = 401;
    res.set_content("missing bearer token", "text/plain");
    return;
  }
  nlohmann::json body;
  try {
    body = nlohmann::json::parse(req.body);
  } catch (const std::exception&) {
    res.status = 400;
    res.set_content("invalid json", "text/plain");
    return;
  }
  gateway::CompleteRequest request;
  request.set_model(body.value("model", "gpt-4o-mini"));
  request.set_max_tokens(body.value("max_tokens", 512));
  for (const auto& m : body.value("messages", nlohmann::json::array())) {
    auto* msg = request.add_messages();
    msg->set_role(m.value("role", ""));
    msg->set_content(m.value("content", ""));
  }
  auto up = std::make_shared<Upstream>();
  up->ctx.set_deadline(std::chrono::system_clock::now() + kStreamTimeout);
  up->reader = stub->StreamComplete(&up->ctx, request);
  res.set_header("Cache-Control", "no-cache");
  res.set_chunked_content_provider("text/plain", [up](size_t, httplib::DataSink& sink) {
    gateway::Chunk chunk;
    while (up->reader->Read(&chunk)) {
      const std::string f = frame({{"delta", chunk.text()}});
      sink.write(f.data(), f.size());
    }
    sink.done();
    return true;
  });
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/chat/stream", stream_chat);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <memory>
#include <string>

#include "gateway/auth.h"
#include "providers.grpc.pb.h"

constexpr std::chrono::seconds kStreamTimeout{8};

auto channel = grpc::CreateChannel("providers:9000", grpc::InsecureChannelCredentials());
auto stub = gateway::Provider::NewStub(channel);

// One SSE frame: "data: <json>" and a blank line.
std::string frame(const nlohmann::json& data) { return "data: " + data.dump() + "\\n\\n"; }

// The upstream call, kept alive for as long as the response is being written.
struct Upstream {
  grpc::ClientContext ctx;
  std::unique_ptr<grpc::ClientReader<gateway::Chunk>> reader;
};

void stream_chat(const httplib::Request& req, httplib::Response& res) {
  if (!gateway::tenant(req)) {
    res.status = 401;
    res.set_content("missing bearer token", "text/plain");
    return;
  }
  nlohmann::json body;
  try {
    body = nlohmann::json::parse(req.body);
  } catch (const std::exception&) {
    res.status = 400;
    res.set_content("invalid json", "text/plain");
    return;
  }
  gateway::CompleteRequest request;
  request.set_model(body.value("model", "gpt-4o-mini"));
  request.set_max_tokens(body.value("max_tokens", 512));
  for (const auto& m : body.value("messages", nlohmann::json::array())) {
    auto* msg = request.add_messages();
    msg->set_role(m.value("role", ""));
    msg->set_content(m.value("content", ""));
  }
  auto up = std::make_shared<Upstream>();
  up->ctx.set_deadline(std::chrono::system_clock::now() + kStreamTimeout);
  up->reader = stub->StreamComplete(&up->ctx, request);
  res.set_header("Cache-Control", "no-cache");
  res.set_chunked_content_provider("text/event-stream", [up](size_t, httplib::DataSink& sink) {
    gateway::Chunk chunk;
    int output_tokens = 0;
    while (up->reader->Read(&chunk)) {
      const std::string f = frame({{"delta", chunk.text()}});
      if (!sink.is_writable() || !sink.write(f.data(), f.size())) {
        up->ctx.TryCancel();  // the client is gone: the provider stops generating
        return false;
      }
      output_tokens++;
    }
    if (!up->reader->Finish().ok()) {
      sink.done();  // the provider failed mid-stream: the client sees the stream end without [DONE]
      return true;
    }
    const std::string usage = frame({{"usage", {{"output_tokens", output_tokens}}}});
    sink.write(usage.data(), usage.size());
    const std::string done = "data: [DONE]\\n\\n";
    sink.write(done.data(), done.size());
    sink.done();
    return true;
  });
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/chat/stream", stream_chat);
}
`,
    },
  },
  harness: {
    python: `import asyncio
import json

import providers_pb2
import providers_pb2_grpc

TOKENS = ["The", " capital", " of", " France", " is", " Paris", "."]
GAP_S = 0.05
BODY = {"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "What is the capital of France?"}], "max_tokens": 64}


class Providers(providers_pb2_grpc.ProviderServicer):
    """The model provider, streaming: one Chunk per token, GAP_S of virtual time between two."""

    def __init__(self):
        self.produced = 0
        self.cancelled = False

    async def StreamComplete(self, request, context):
        try:
            for t in TOKENS:
                if context.cancelled():
                    break
                self.produced += 1
                yield providers_pb2.Chunk(text=t)
                await asyncio.sleep(GAP_S)
                for _ in range(20):
                    await asyncio.sleep(0)  # generation is slower than the relay: a token takes several turns of the loop
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        finally:
            if context.cancelled():
                self.cancelled = True


def _gateway(ctx):
    peer = Providers()
    ctx.grpc.serve(providers_pb2_grpc.add_ProviderServicer_to_server, peer)
    return ctx.load("chat_stream"), peer


async def _stream(ctx, m, disconnect_after=None):
    """
    Drive the app over ASGI the way a server does, frame by frame; after \`disconnect_after\` body
    frames the client hangs up. The server keeps accepting writes to the closed connection without
    raising (as uvicorn did before 0.28): a handler that does not ask notices nothing.
    """
    payload = json.dumps(BODY).encode()
    scope = {
        "type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"}, "http_version": "1.1", "method": "POST",
        "scheme": "http", "path": "/v1/chat/stream", "raw_path": b"/v1/chat/stream", "query_string": b"", "root_path": "",
        "headers": [(b"host", b"gateway"), (b"content-type", b"application/json"), (b"content-length", str(len(payload)).encode()), (b"authorization", b"Bearer acme")],
        "client": ("203.0.113.10", 51000), "server": ("gateway", 8443),
    }
    out = {"status": None, "headers": {}, "frames": [], "after": [], "body_sent": False, "disconnected": False}
    gone = asyncio.Event()

    async def receive():
        if not out["body_sent"]:
            out["body_sent"] = True
            return {"type": "http.request", "body": payload, "more_body": False}
        await gone.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        if message["type"] == "http.response.start":
            out["status"] = message["status"]
            out["headers"] = {k.decode().lower(): v.decode() for k, v in message.get("headers", [])}
        elif message["type"] == "http.response.body":
            chunk = message.get("body", b"")
            if chunk:
                (out["after"] if out["disconnected"] else out["frames"]).append(chunk.decode())
                if disconnect_after is not None and not out["disconnected"] and len(out["frames"]) >= disconnect_after:
                    out["disconnected"] = True
                    gone.set()
        await asyncio.sleep(0)

    try:
        await asyncio.wait_for(m.app(scope, receive, send), 5.0)
    except asyncio.TimeoutError:
        raise AssertionError(f"the stream did not end within 5 s of real time after {len(out['frames'])} frame(s)")
    for _ in range(100):
        await asyncio.sleep(0)  # whatever the handler left running gets to run
    return out


def _events(frames):
    """The frames parsed: each 'data: <text>' terminated by a blank line."""
    text = "".join(frames)
    assert text.endswith("\\n\\n") or text == "", f"the body must end with a blank line after the last frame, it ends with {text[-20:]!r}"
    events = []
    for block in text.split("\\n\\n"):
        if not block:
            continue
        assert block.startswith("data: "), f"a frame must start with 'data: ', got {block!r}"
        events.append(block[len("data: "):])
    return events


async def check_sse_frames(ctx):
    m, peer = _gateway(ctx)
    out = await _stream(ctx, m)
    assert out["status"] == 200, f"POST /v1/chat/stream answered {out['status']}"
    assert out["frames"], "the stream wrote nothing"
    events = _events(out["frames"])
    deltas = [json.loads(e)["delta"] for e in events if e != "[DONE]" and "delta" in json.loads(e)]
    assert deltas == TOKENS, f"the delta frames must relay the provider's chunks in order, expected {TOKENS}, got {deltas}"
    assert len(out["frames"]) >= len(TOKENS), f"the {len(TOKENS)} chunks arrived as {len(out['frames'])} write(s): relay each chunk as it arrives, do not collect the answer first"


async def check_content_type(ctx):
    m, peer = _gateway(ctx)
    out = await _stream(ctx, m)
    assert out["status"] == 200, f"POST /v1/chat/stream answered {out['status']}"
    ctype = out["headers"].get("content-type", "")
    assert ctype.startswith("text/event-stream"), f"Content-Type is {ctype!r}, expected text/event-stream: without it proxies buffer the stream and the browser does not see events"


async def check_disconnect(ctx):
    m, peer = _gateway(ctx)
    out = await _stream(ctx, m, disconnect_after=2)
    assert len(out["frames"]) == 2, f"the client hung up after 2 frames, the server had written {len(out['frames'])}"
    assert len(out["after"]) == 0, f"after the client hung up the stream wrote {len(out['after'])} more frame(s) into the closed connection: {out['after'][:2]}. Check request.is_disconnected() before relaying the next chunk"


async def check_cancel_upstream(ctx):
    m, peer = _gateway(ctx)
    out = await _stream(ctx, m, disconnect_after=2)
    assert peer.cancelled, f"the client hung up after 2 frames but the provider call was not cancelled: it generated {peer.produced} of {len(TOKENS)} tokens nobody read. Cancel the upstream call (upstream.cancel()) when the client leaves"
    assert peer.produced < len(TOKENS), f"the provider generated all {len(TOKENS)} tokens after the client hung up at 2: the cancel came too late"


async def check_done_and_usage(ctx):
    m, peer = _gateway(ctx)
    out = await _stream(ctx, m)
    events = _events(out["frames"])
    assert events and events[-1] == "[DONE]", f"a stream that completes must end with 'data: [DONE]', the last frame was {events[-1] if events else None!r}"
    assert len(events) >= 2, "the usage frame must come before [DONE]"
    usage = json.loads(events[-2])
    assert usage == {"usage": {"output_tokens": len(TOKENS)}}, f"the frame before [DONE] must be {{'usage': {{'output_tokens': {len(TOKENS)}}}}} ({len(TOKENS)} chunks relayed), got {usage}"
    assert not peer.cancelled or peer.produced == len(TOKENS), "a stream that completed must not be reported as cancelled before the provider finished"
`,
    typescript: `const TOKENS = ['The', ' capital', ' of', ' France', ' is', ' Paris', '.'];
const GAP_MS = 50;
const BODY = {model: 'gpt-4o-mini', messages: [{role: 'user', content: 'What is the capital of France?'}], max_tokens: 64};

const sleep = (ms: number): Promise<void> => {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

interface Peer {
  produced: number;
  cancelled: boolean;
}

/** The model provider, streaming: one Chunk per token, GAP_MS of virtual time between two. */
function gateway(ctx) {
  const peer: Peer = {produced: 0, cancelled: false};
  const pkg = ctx.proto('providers.proto');
  ctx.grpc.serve(pkg.gateway.Provider.service, {
    StreamComplete: async call => {
      call.on('cancelled', () => {
        peer.cancelled = true;
      });
      for (const t of TOKENS) {
        if (call.cancelled) {
          peer.cancelled = true;
          return;
        }
        peer.produced += 1;
        call.write({text: t});
        await sleep(GAP_MS);
      }
      call.end();
    },
  });
  return {m: ctx.load('chat_stream'), peer};
}

/**
 * The runtime's Fastify has no socket to hand over, so the handler is called the way Fastify calls
 * it, with a request and a reply whose raw halves are the harness's: writes are recorded frame by
 * frame, and after \`disconnectAfter\` frames the client hangs up (the raw request emits close,
 * further writes are refused), as Node does when the browser closes the tab.
 */
async function stream(ctx, m, disconnectAfter = Infinity) {
  const frames: string[] = [];
  const after: string[] = [];
  const headers: Record<string, string> = {};
  const listeners: Record<string, (() => void)[]> = {};
  let status = 0;
  let disconnected = false;
  let ended = false;
  const setHeader = (k: string, v: unknown) => {
    headers[k.toLowerCase()] = String(v);
  };
  const request = {
    headers: {authorization: 'Bearer acme', 'content-type': 'application/json'},
    body: BODY,
    raw: {
      headers: {authorization: 'Bearer acme'},
      on(event: string, fn: () => void) {
        (listeners[event] ??= []).push(fn);
        return this;
      },
      once(event: string, fn: () => void) {
        (listeners[event] ??= []).push(fn);
        return this;
      },
      get destroyed() {
        return disconnected;
      },
      get aborted() {
        return disconnected;
      },
    },
  };
  const reply = {
    sent: false,
    hijack() {
      return this;
    },
    header(k: string, v: unknown) {
      setHeader(k, v);
      return this;
    },
    raw: {
      writeHead(code: number, h: Record<string, unknown> = {}) {
        status = code;
        for (const [k, v] of Object.entries(h)) setHeader(k, v);
        return this;
      },
      setHeader,
      write(chunk: unknown) {
        const text = String(chunk);
        if (disconnected) {
          after.push(text);
          return false;
        }
        frames.push(text);
        if (frames.length >= disconnectAfter) {
          disconnected = true;
          for (const fn of listeners.close ?? []) fn();
        }
        return true;
      },
      end() {
        ended = true;
      },
      get writableEnded() {
        return ended;
      },
      get destroyed() {
        return disconnected;
      },
    },
  };
  const budget = sleep(5000).then(() => {
    throw new Error(\`the stream did not end within 5 s after \${frames.length} frame(s)\`);
  });
  await Promise.race([m.streamChat(request, reply), budget]);
  await sleep(GAP_MS * (TOKENS.length + 2)); // whatever the handler left running gets to run
  return {frames, after, headers, status: () => status, ended: () => ended};
}

/** The frames parsed: each 'data: <text>' terminated by a blank line. */
function events(frames: string[]): string[] {
  const text = frames.join('');
  assert(text === '' || text.endsWith('\\n\\n'), \`the body must end with a blank line after the last frame, it ends with \${JSON.stringify(text.slice(-20))}\`);
  const out: string[] = [];
  for (const block of text.split('\\n\\n')) {
    if (block === '') continue;
    assert(block.startsWith('data: '), \`a frame must start with 'data: ', got \${JSON.stringify(block)}\`);
    out.push(block.slice('data: '.length));
  }
  return out;
}

export async function check_sse_frames(ctx) {
  const {m} = gateway(ctx);
  const out = await stream(ctx, m);
  assert.equal(out.status(), 200, \`POST /v1/chat/stream answered \${out.status()}\`);
  assert(out.frames.length > 0, 'the stream wrote nothing');
  const deltas = events(out.frames)
    .filter(e => e !== '[DONE]')
    .map(e => JSON.parse(e))
    .filter(e => 'delta' in e)
    .map(e => e.delta);
  assert.deepStrictEqual(deltas, TOKENS, \`the delta frames must relay the provider's chunks in order, expected \${JSON.stringify(TOKENS)}, got \${JSON.stringify(deltas)}\`);
  assert(out.frames.length >= TOKENS.length, \`the \${TOKENS.length} chunks arrived as \${out.frames.length} write(s): relay each chunk as it arrives, do not collect the answer first\`);
}

export async function check_content_type(ctx) {
  const {m} = gateway(ctx);
  const out = await stream(ctx, m);
  assert.equal(out.status(), 200, \`POST /v1/chat/stream answered \${out.status()}\`);
  const ctype = out.headers['content-type'] ?? '';
  assert(ctype.startsWith('text/event-stream'), \`Content-Type is \${JSON.stringify(ctype)}, expected text/event-stream: without it proxies buffer the stream and the browser does not see events\`);
}

export async function check_disconnect(ctx) {
  const {m} = gateway(ctx);
  const out = await stream(ctx, m, 2);
  assert.equal(out.frames.length, 2, \`the client hung up after 2 frames, the server had written \${out.frames.length}\`);
  assert.equal(out.after.length, 0, \`after the client hung up the stream wrote \${out.after.length} more frame(s) into the closed connection: \${JSON.stringify(out.after.slice(0, 2))}. Watch the raw request's close event and stop relaying\`);
}

export async function check_cancel_upstream(ctx) {
  const {m, peer} = gateway(ctx);
  await stream(ctx, m, 2);
  assert(peer.cancelled, \`the client hung up after 2 frames but the provider call was not cancelled: it generated \${peer.produced} of \${TOKENS.length} tokens nobody read. Cancel the upstream call (upstream.cancel()) when the client leaves\`);
  assert(peer.produced < TOKENS.length, \`the provider generated all \${TOKENS.length} tokens after the client hung up at 2: the cancel came too late\`);
}

export async function check_done_and_usage(ctx) {
  const {m} = gateway(ctx);
  const out = await stream(ctx, m);
  const seen = events(out.frames);
  assert(seen.length > 0 && seen.at(-1) === '[DONE]', \`a stream that completes must end with 'data: [DONE]', the last frame was \${JSON.stringify(seen.at(-1))}\`);
  assert(seen.length >= 2, 'the usage frame must come before [DONE]');
  const usage = JSON.parse(seen.at(-2));
  assert.deepStrictEqual(usage, {usage: {output_tokens: TOKENS.length}}, \`the frame before [DONE] must be {"usage": {"output_tokens": \${TOKENS.length}}} (\${TOKENS.length} chunks relayed), got \${JSON.stringify(usage)}\`);
  assert(out.ended(), 'a stream that completes ends the response');
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"time"

	"leetbuild/harness"

	pb "gateway/gen/providers"
)

var streamTokens = []string{"The", " capital", " of", " France", " is", " Paris", "."}

const (
	streamGap  = 50 * time.Millisecond
	streamBody = \`{"model":"gpt-4o-mini","messages":[{"role":"user","content":"What is the capital of France?"}],"max_tokens":64}\`
)

// streamPeer is the model provider, streaming: one Chunk per token, streamGap of virtual time between two.
type streamPeer struct {
	pb.UnimplementedProviderServer
	mu        sync.Mutex
	produced  int
	cancelled bool
}

func (p *streamPeer) StreamComplete(_ *pb.CompleteRequest, srv pb.Provider_StreamCompleteServer) error {
	for _, t := range streamTokens {
		if srv.Context().Err() != nil {
			p.mu.Lock()
			p.cancelled = true
			p.mu.Unlock()
			return srv.Context().Err()
		}
		p.mu.Lock()
		p.produced++
		p.mu.Unlock()
		if err := srv.Send(&pb.Chunk{Text: t}); err != nil {
			return err
		}
		time.Sleep(streamGap)
	}
	return nil
}

func (p *streamPeer) state() (int, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.produced, p.cancelled
}

// sseWriter is the connection as net/http presents it to the handler: writes are recorded, and
// after disconnectAfter frames the client hangs up: the request's context is cancelled (as the
// server does) and further writes fail.
type sseWriter struct {
	rec             *httptest.ResponseRecorder
	disconnectAfter int
	cancel          context.CancelFunc
	mu              sync.Mutex
	body            strings.Builder
	after           strings.Builder
	disconnected    bool
}

func (w *sseWriter) Header() http.Header  { return w.rec.Header() }
func (w *sseWriter) WriteHeader(code int) { w.rec.WriteHeader(code) }
func (w *sseWriter) Flush()               {}

func (w *sseWriter) Write(b []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.disconnected {
		w.after.Write(b)
		return 0, errors.New("write: broken pipe")
	}
	w.body.Write(b)
	w.rec.Write(b)
	if w.disconnectAfter > 0 && strings.Count(w.body.String(), "\\n\\n") >= w.disconnectAfter {
		w.disconnected = true
		w.cancel()
	}
	return len(b), nil
}

type streamOut struct {
	status  int
	headers http.Header
	frames  []string // the frames the client received
	after   string   // what was written after the client hung up
	done    bool
}

func streamGateway(ctx *harness.Ctx) (*http.ServeMux, *streamPeer) {
	peer := &streamPeer{}
	pb.RegisterProviderServer(ctx.GRPC.Server(""), peer)
	mux := http.NewServeMux()
	register(mux)
	return mux, peer
}

// streamOnce drives the handler as the server would; after disconnectAfter frames (0: never) the client hangs up.
func streamOnce(ctx *harness.Ctx, mux *http.ServeMux, disconnectAfter int) streamOut {
	reqCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest("POST", "http://gateway/v1/chat/stream", strings.NewReader(streamBody)).WithContext(reqCtx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer acme")
	w := &sseWriter{rec: httptest.NewRecorder(), disconnectAfter: disconnectAfter, cancel: cancel}
	done := ctx.Drain(func() { mux.ServeHTTP(w, req) })
	ctx.Settle() // whatever the handler left running gets to run
	w.mu.Lock()
	defer w.mu.Unlock()
	out := streamOut{status: w.rec.Code, headers: w.rec.Header(), after: w.after.String(), done: done}
	for _, block := range strings.Split(w.body.String(), "\\n\\n") {
		if block != "" {
			out.frames = append(out.frames, block)
		}
	}
	return out
}

// streamEvents is each frame's text after "data: ".
func streamEvents(ctx *harness.Ctx, out streamOut) []string {
	var events []string
	for _, f := range out.frames {
		ctx.Assert(strings.HasPrefix(f, "data: "), "a frame must start with 'data: ', got %q", f)
		events = append(events, strings.TrimPrefix(f, "data: "))
	}
	return events
}

func CheckSseFrames(ctx *harness.Ctx) {
	mux, _ := streamGateway(ctx)
	out := streamOnce(ctx, mux, 0)
	ctx.Assert(out.done, "the stream handler did not return")
	ctx.Equal(out.status, 200, "POST /v1/chat/stream")
	ctx.Assert(len(out.frames) > 0, "the stream wrote nothing")
	var deltas []string
	for _, e := range streamEvents(ctx, out) {
		var v map[string]any
		if json.Unmarshal([]byte(e), &v) == nil {
			if d, ok := v["delta"].(string); ok {
				deltas = append(deltas, d)
			}
		}
	}
	ctx.Equal(deltas, streamTokens, "the delta frames must relay the provider's chunks in order")
}

func CheckContentType(ctx *harness.Ctx) {
	mux, _ := streamGateway(ctx)
	out := streamOnce(ctx, mux, 0)
	ctx.Equal(out.status, 200, "POST /v1/chat/stream")
	ctype := out.headers.Get("Content-Type")
	ctx.Assert(strings.HasPrefix(ctype, "text/event-stream"), "Content-Type is %q, expected text/event-stream: without it proxies buffer the stream and the browser does not see events", ctype)
}

func CheckDisconnect(ctx *harness.Ctx) {
	mux, _ := streamGateway(ctx)
	out := streamOnce(ctx, mux, 2)
	ctx.Equal(len(out.frames), 2, "the client hung up after 2 frames; the frames the server had written")
	ctx.Assert(out.after == "", "after the client hung up the stream wrote %d more byte(s) into the closed connection: %q. Bind the upstream call to r.Context() and stop when it ends", len(out.after), out.after)
}

func CheckCancelUpstream(ctx *harness.Ctx) {
	mux, peer := streamGateway(ctx)
	streamOnce(ctx, mux, 2)
	produced, cancelled := peer.state()
	ctx.Assert(cancelled, "the client hung up after 2 frames but the provider call was not cancelled: it generated %d of %d tokens nobody read. Derive the upstream context from r.Context() so the disconnect cancels the call", produced, len(streamTokens))
	ctx.Assert(produced < len(streamTokens), "the provider generated all %d tokens after the client hung up at 2: the cancel came too late", len(streamTokens))
}

func CheckDoneAndUsage(ctx *harness.Ctx) {
	mux, _ := streamGateway(ctx)
	out := streamOnce(ctx, mux, 0)
	events := streamEvents(ctx, out)
	ctx.Assert(len(events) > 0 && events[len(events)-1] == "[DONE]", "a stream that completes must end with 'data: [DONE]', the frames were %q", events)
	ctx.Assert(len(events) >= 2, "the usage frame must come before [DONE]")
	var usage map[string]any
	ctx.NoError(json.Unmarshal([]byte(events[len(events)-2]), &usage), "the frame before [DONE] must be JSON, got %q", events[len(events)-2])
	ctx.Equal(usage, map[string]any{"usage": map[string]any{"output_tokens": float64(len(streamTokens))}}, "the frame before [DONE] (%d chunks relayed)", len(streamTokens))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <chrono>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

const std::vector<std::string> kStreamTokens = {"The", " capital", " of", " France", " is", " Paris", "."};
constexpr std::chrono::milliseconds kStreamGap{50};
const std::string kStreamBody =
    R"({"model":"gpt-4o-mini","messages":[{"role":"user","content":"What is the capital of France?"}],"max_tokens":64})";

// The model provider, streaming: one Chunk per token, kStreamGap of virtual time between two.
class StreamPeer final : public gateway::Provider::Service {
 public:
  grpc::Status StreamComplete(grpc::ServerContext* context, const gateway::CompleteRequest*,
                              grpc::ServerWriter<gateway::Chunk>* srv) override {
    for (const auto& t : kStreamTokens) {
      if (context->IsCancelled()) {
        std::lock_guard<std::mutex> lock(mu_);
        cancelled_ = true;
        return grpc::Status::CANCELLED;
      }
      {
        std::lock_guard<std::mutex> lock(mu_);
        produced_++;
      }
      gateway::Chunk chunk;
      chunk.set_text(t);
      if (!srv->Write(chunk)) {
        std::lock_guard<std::mutex> lock(mu_);
        cancelled_ = true;
        return grpc::Status::CANCELLED;
      }
      std::this_thread::sleep_for(kStreamGap);
    }
    return grpc::Status::OK;
  }

  struct State {
    int produced;
    bool cancelled;
  };
  State state() {
    std::lock_guard<std::mutex> lock(mu_);
    return {produced_, cancelled_};
  }

 private:
  std::mutex mu_;
  int produced_ = 0;
  bool cancelled_ = false;
};

struct StreamGateway {
  StreamPeer peer;
  httplib::Server svr;
};

StreamGateway& streamGateway(harness::Ctx& ctx) {
  static StreamGateway* g = nullptr;
  delete g;
  g = new StreamGateway;
  ctx.GRPC.Server("")->RegisterService(&g->peer);
  register_routes(g->svr);
  return *g;
}

// One request, driven through the server; the client reads at most client_reads bytes of the body
// and hangs up (the sink stops being writable), as a browser closing an event stream.
httplib::Response streamOnce(harness::Ctx& ctx, StreamGateway& g, size_t client_reads = static_cast<size_t>(-1)) {
  httplib::Request req;
  req.method = "POST";
  req.path = "/v1/chat/stream";
  req.target = req.path;
  req.body = kStreamBody;
  req.headers.emplace("Content-Type", "application/json");
  req.headers.emplace("Authorization", "Bearer acme");
  req.client_reads = client_reads;
  httplib::Response res = g.svr.handle(req);
  ctx.Settle();  // whatever the handler left running gets to run
  return res;
}

// The frames of a body: each block terminated by a blank line.
std::vector<std::string> streamFrames(const std::string& body) {
  std::vector<std::string> frames;
  size_t start = 0;
  while (true) {
    const size_t end = body.find("\\n\\n", start);
    if (end == std::string::npos) break;
    frames.push_back(body.substr(start, end - start));
    start = end + 2;
  }
  return frames;
}

// Each frame's text after "data: ".
std::vector<std::string> streamEvents(harness::Ctx& ctx, const std::string& body) {
  std::vector<std::string> events;
  for (const auto& f : streamFrames(body)) {
    ctx.Assert(f.rfind("data: ", 0) == 0, "a frame must start with 'data: ', got %q", f);
    events.push_back(f.substr(6));
  }
  return events;
}

// The byte offset at which the client has read exactly n frames, learned from a full stream.
size_t streamBytesOfFrames(harness::Ctx& ctx, StreamGateway& g, size_t n) {
  const auto full = streamOnce(ctx, g);
  ctx.Assert(streamFrames(full.body).size() > n, "the stream wrote fewer than %d frames: %q", n + 1, full.body);
  size_t offset = 0;
  for (size_t i = 0; i < n; i++) offset = full.body.find("\\n\\n", offset) + 2;
  return offset;
}

}  // namespace

void CheckSseFrames(harness::Ctx& ctx) {
  auto& g = streamGateway(ctx);
  const auto res = streamOnce(ctx, g);
  ctx.Equal(res.status, 200, "POST /v1/chat/stream");
  ctx.Assert(!res.body.empty(), "the stream wrote nothing");
  std::vector<std::string> deltas;
  for (const auto& e : streamEvents(ctx, res.body)) {
    if (e == "[DONE]") continue;
    const auto v = nlohmann::json::parse(e, nullptr, false);
    if (v.is_object() && v.contains("delta")) deltas.push_back(v["delta"].get<std::string>());
  }
  ctx.Equal(deltas, kStreamTokens, "the delta frames must relay the provider's chunks in order");
}

void CheckContentType(harness::Ctx& ctx) {
  auto& g = streamGateway(ctx);
  const auto res = streamOnce(ctx, g);
  ctx.Equal(res.status, 200, "POST /v1/chat/stream");
  const std::string ctype = res.get_header_value("Content-Type");
  ctx.Assert(ctype.rfind("text/event-stream", 0) == 0,
             "Content-Type is %q, expected text/event-stream: without it proxies buffer the stream and the browser does not see events", ctype);
}

void CheckDisconnect(harness::Ctx& ctx) {
  auto& g = streamGateway(ctx);
  const size_t two = streamBytesOfFrames(ctx, g, 2);
  const int before = g.peer.state().produced;
  streamOnce(ctx, g, two);
  const auto s = g.peer.state();
  ctx.Assert(s.produced - before <= 3,
             "the client hung up after 2 frames but the handler kept reading: the provider generated %d tokens for that stream. Stop when sink.write() returns false (the client is gone)",
             s.produced - before);
}

void CheckCancelUpstream(harness::Ctx& ctx) {
  auto& g = streamGateway(ctx);
  const size_t two = streamBytesOfFrames(ctx, g, 2);
  const int before = g.peer.state().produced;
  streamOnce(ctx, g, two);
  const auto s = g.peer.state();
  ctx.Assert(s.cancelled, "the client hung up after 2 frames but the provider call was not cancelled: it generated %d of %d tokens nobody read. TryCancel() the upstream context when the client leaves",
             s.produced - before, static_cast<int>(kStreamTokens.size()));
}

void CheckDoneAndUsage(harness::Ctx& ctx) {
  auto& g = streamGateway(ctx);
  const auto res = streamOnce(ctx, g);
  const auto events = streamEvents(ctx, res.body);
  ctx.Assert(!events.empty() && events.back() == "[DONE]", "a stream that completes must end with 'data: [DONE]', the frames were %v", events);
  ctx.Assert(events.size() >= 2, "the usage frame must come before [DONE]");
  const auto usage = nlohmann::json::parse(events[events.size() - 2], nullptr, false);
  nlohmann::json expected = {{"usage", {{"output_tokens", static_cast<int>(kStreamTokens.size())}}}};
  ctx.Equal(usage, expected, "the frame before [DONE] (%d chunks relayed)", static_cast<int>(kStreamTokens.size()));
}
`,
  },
  debrief: `Cancellation is a path of its own, not an error path. The disconnect is a fact the server learns from the connection (a receive, a close event, a cancelled request context, a write that fails), and the fix carries that fact one hop further, to the provider call, because the browser's socket closing says nothing to the provider. The content type is what makes the bytes a stream at all: proxies and browsers treat \`text/event-stream\` as something to forward on sight. Counting chunks in the loop gives billing a number for what was delivered rather than what was generated. Production gateways also emit a usage event for a cancelled stream (step 5), set \`X-Accel-Buffering: no\` for nginx, and send a comment frame every few seconds so idle connections survive load balancers.`,
};
