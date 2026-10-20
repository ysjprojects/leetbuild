import type {Step} from '@/lib/types';

export const chatEndpointStep: Step = {
  id: 'chat-endpoint',
  title: 'POST /v1/chat: validate, call, account',
  concept: 'http',
  file: 'chat_api',
  focus: ['client', 'gateway', 'providers'],
  task: `## Task

The starter is a plausible model-generated draft: it passes the happy path — one authenticated
request with a small prompt gets a completion — but it hides several review problems. Find them,
fix them, and prove the fix.

Implement \`POST /v1/chat\` with body \`{"model": "…", "messages": [{"role": "…", "content": "…"}], "max_tokens": 512}\`.
The tenant comes from the \`Authorization: Bearer …\` header; \`authenticate\` is provided.

- Reject an empty \`messages\` list, an unknown role, an estimated input over **MAX_INPUT_TOKENS =
  8192**, and \`max_tokens\` outside **1…4096** with **400** — before the provider is called. Tokens
  are estimated as \`ceil(total characters / 4)\`.
- Call \`providers.Complete(model, messages, max_tokens)\` over gRPC with an **8 second** deadline.
- Map \`DEADLINE_EXCEEDED\` to **504** and every other provider failure to **502**.
- Answer **200** with \`{id, content, usage: {input_tokens, output_tokens}}\`, where \`id\` is a fresh
  request id and the usage numbers are the ones the provider reported.
- Never return, log, or serialise the prompt. A gateway that echoes messages into responses or
  logs leaks customer data and breaks the trust boundary the tenant came through.

The subtle failure mode the checks target is a validation path that looks complete but runs *after*
the paid call, and a provider call with no deadline: one hung provider then pins every worker, and
every malformed request still costs money.`,
  sequence: {
    participants: ['Client', 'Gateway', 'Providers'],
    messages: [
      {from: 'Client', to: 'Gateway', label: 'POST /v1/chat · Bearer token', kind: 'sync'},
      {from: 'Gateway', to: 'Gateway', label: 'validate roles · 8192 input · max_tokens 1…4096', kind: 'sync'},
      {from: 'Gateway', to: 'Providers', label: 'Complete(model, messages, max_tokens) · deadline 8 s', kind: 'sync'},
      {from: 'Providers', to: 'Gateway', label: 'CompleteReply{content, usage}', kind: 'reply'},
      {from: 'Gateway', to: 'Client', label: '200 {id, content, usage}', kind: 'reply'},
    ],
  },
  hints: [
    'Do the cheap checks first: an empty list and an unknown role are comparisons on the request; the token estimate is one pass over the content lengths. All of them must return 400 before the gRPC call.',
    'A deadline is an argument on the call itself (`timeout=`, a context with timeout, `withDeadlineAfter`, `set_deadline`) — a wrapper around the call does not cancel it. Then inspect the status: only `DEADLINE_EXCEEDED` is a 504; the rest are 502.',
    'Forward `reply.usage` rather than estimating the completion again, and build the response from named fields only — never from the request body — so there is no path for the prompt to come back out.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/chat',
      detail: 'A handler is registered for `POST` on `/v1/chat` and the handler requires the bearer token.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/chat["']/, /authorization/i]},
        go: {all: [/HandleFunc\(\s*"POST \/v1\/chat"/, /Authorization/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"chat"\s*\)/, /\bpost\s*\{/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/chat"/, /Authorization/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/chat['"]/, /authorization/i]},
      },
    },
    {
      id: 'validate',
      title: 'Rejects bad requests with 400 before the provider',
      detail:
        'Empty `messages`, an unknown role, more than `MAX_INPUT_TOKENS` (ceil(chars / 4)), and `max_tokens` outside 1…4096 all answer `400` before `Complete` is called.',
      match: {
        python: {
          all: [/MAX_INPUT_TOKENS/, /MAX_OUTPUT_TOKENS/, /status_code\s*=\s*400/, /estimate_tokens|math\.ceil/],
          order: [/status_code\s*=\s*400/, /providers\.Complete\(/],
        },
        go: {
          all: [/maxInputTokens/, /maxOutputTokens/, /http\.StatusBadRequest|\b400\b/, /estimateTokens/],
          order: [/http\.StatusBadRequest|\b400\b/, /providers\.Complete\(/],
        },
        scala: {
          all: [/MaxInputTokens/, /MaxOutputTokens/, /StatusCodes\.BadRequest|\b400\b/, /estimateTokens/],
          order: [/StatusCodes\.BadRequest|\b400\b/, /callProvider\(body\)/],
        },
        cpp: {
          all: [/kMaxInputTokens/, /kMaxOutputTokens/, /status\s*=\s*400/, /estimate_tokens/],
          order: [/status\s*=\s*400/, /stub->Complete\(/],
        },
        typescript: {
          all: [/MAX_INPUT_TOKENS/, /MAX_OUTPUT_TOKENS/, /\.code\(\s*400\s*\)/, /estimateTokens/],
          order: [/\.code\(\s*400\s*\)/, /\.Complete\(/],
        },
      },
    },
    {
      id: 'deadline',
      title: 'Provider call has an 8 s deadline and maps errors',
      detail:
        'The gRPC call carries an 8 second deadline. `DEADLINE_EXCEEDED` becomes `504`, every other provider error becomes `502`; a call without a deadline can pin a worker indefinitely.',
      match: {
        python: {
          all: [
            /timeout\s*=\s*PROVIDER_TIMEOUT_S/,
            /StatusCode\.DEADLINE_EXCEEDED/,
            /status_code\s*=\s*504/,
            /status_code\s*=\s*502/,
          ],
        },
        go: {
          all: [
            /context\.WithTimeout\(/,
            /codes\.DeadlineExceeded/,
            /http\.StatusGatewayTimeout/,
            /http\.StatusBadGateway/,
          ],
        },
        scala: {
          all: [
            /withDeadlineAfter\(/,
            /StatusCode\.DEADLINE_EXCEEDED/,
            /StatusCodes\.GatewayTimeout/,
            /StatusCodes\.BadGateway/,
          ],
        },
        cpp: {
          all: [/set_deadline\(/, /StatusCode::DEADLINE_EXCEEDED/, /status\s*=\s*504/, /status\s*=\s*502/],
        },
        typescript: {
          all: [
            /PROVIDER_TIMEOUT_MS/,
            /deadline:\s*Date\.now\(\)\s*\+\s*PROVIDER_TIMEOUT_MS/,
            /grpc\.status\.DEADLINE_EXCEEDED/,
            /\.code\(\s*504\s*\)/,
            /\.code\(\s*502\s*\)/,
          ],
        },
      },
    },
    {
      id: 'usage',
      title: 'Returns the provider-reported usage and a request id',
      detail:
        'The response is `{id, content, usage: {input_tokens, output_tokens}}`; both usage numbers come from the provider reply, not from a local estimate of the text.',
      match: {
        python: {all: [/reply\.usage\.input_tokens/, /reply\.usage\.output_tokens/, /id\s*=\s*(str\(uuid|request_id)/]},
        go: {all: [/GetUsage\(\)\.GetInputTokens\(\)/, /GetUsage\(\)\.GetOutputTokens\(\)/, /"id"/]},
        scala: {all: [/reply\.usage\.inputTokens/, /reply\.usage\.outputTokens/, /UUID|requestId/]},
        cpp: {all: [/usage\(\)\.input_tokens\(\)/, /usage\(\)\.output_tokens\(\)/, /request_id\(\)/]},
        typescript: {
          all: [/completion\.usage\.inputTokens/, /completion\.usage\.outputTokens/, /id:\s*randomUUID\(\)/],
        },
      },
    },
    {
      id: 'no-prompt-echo',
      title: 'Never echoes the prompt or raw messages',
      detail:
        'The response and the logs carry the completion and the usage only. Serialising or logging `messages` sends the tenant prompt back out through a side channel.',
      match: {
        python: {none: [/print\([^\n]*body\.messages|logger[^\n]*body\.messages|["']messages["']\s*:/]},
        go: {none: [/log\.(Printf|Println)\([^\n]*body\.Messages|["']messages["']\s*:/]},
        scala: {none: [/logger\.(info|debug)\([^\n]*messages|println\([^\n]*messages|["']messages["']\s*:/]},
        cpp: {
          none: [/std::cout[^\n]*messages|std::cout[^\n]*body\.dump\(\)|spdlog[^\n]*messages|["']messages["']\s*:/],
        },
        typescript: {
          none: [
            /["']messages["']\s*:/,
            /(?:logger|request\.log|app\.log)[^\n]*(?:messages|prompt)/i,
            /console\.(?:log|info|debug)\([^\n]*(?:messages|prompt)/i,
          ],
        },
      },
    },
  ],
  code: {
    python: {
      starter: `import math
import uuid

import grpc

import providers_pb2
import providers_pb2_grpc
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()

MAX_INPUT_TOKENS = 8192
MAX_OUTPUT_TOKENS = 4096
PROVIDER_TIMEOUT_S = 8.0
ROLES = {"system", "user", "assistant"}

channel = grpc.insecure_channel("providers:9000")
providers = providers_pb2_grpc.ProviderStub(channel)


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str = "gpt-4o-mini"
    messages: list[Message]
    max_tokens: int = 512


class Usage(BaseModel):
    input_tokens: int
    output_tokens: int


class ChatReply(BaseModel):
    id: str
    content: str
    usage: Usage


def authenticate(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    return authorization.removeprefix("Bearer ")


@app.post("/v1/chat")
def chat(body: ChatRequest, authorization: str | None = Header(default=None)) -> ChatReply:
    tenant = authenticate(authorization)
    # TODO: reject empty messages, unknown roles, over MAX_INPUT_TOKENS, and max_tokens > MAX_OUTPUT_TOKENS
    # TODO: pass timeout=PROVIDER_TIMEOUT_S; map DEADLINE_EXCEEDED to 504 and other RPC failures to 502
    # TODO: return reply.usage instead of estimating, and never log or serialise the prompt
    request = providers_pb2.CompleteRequest(
        model=body.model,
        messages=[providers_pb2.Message(role=m.role, content=m.content) for m in body.messages],
        max_tokens=body.max_tokens,
    )
    reply = providers.Complete(request)
    print("chat", tenant, body.messages)
    return ChatReply(
        id=str(uuid.uuid4()),
        content=reply.content,
        usage=Usage(
            input_tokens=(sum(len(m.content) for m in body.messages) + 3) // 4,
            output_tokens=(len(reply.content) + 3) // 4,
        ),
    )


# uvicorn chat_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
      solution: `import math
import uuid

import grpc

import providers_pb2
import providers_pb2_grpc
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

app = FastAPI()

MAX_INPUT_TOKENS = 8192
MAX_OUTPUT_TOKENS = 4096
PROVIDER_TIMEOUT_S = 8.0
ROLES = {"system", "user", "assistant"}

channel = grpc.insecure_channel("providers:9000")
providers = providers_pb2_grpc.ProviderStub(channel)


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str = "gpt-4o-mini"
    messages: list[Message]
    max_tokens: int = 512


class Usage(BaseModel):
    input_tokens: int
    output_tokens: int


class ChatReply(BaseModel):
    id: str
    content: str
    usage: Usage


def authenticate(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    return authorization.removeprefix("Bearer ")


def estimate_tokens(messages: list[Message]) -> int:
    return math.ceil(sum(len(m.content) for m in messages) / 4)


@app.post("/v1/chat")
def chat(body: ChatRequest, authorization: str | None = Header(default=None)) -> ChatReply:
    authenticate(authorization)
    if not body.messages:
        raise HTTPException(status_code=400, detail="messages must not be empty")
    if any(m.role not in ROLES for m in body.messages):
        raise HTTPException(status_code=400, detail="role must be system, user or assistant")
    if estimate_tokens(body.messages) > MAX_INPUT_TOKENS:
        raise HTTPException(status_code=400, detail="input exceeds 8192 tokens")
    if body.max_tokens < 1 or body.max_tokens > MAX_OUTPUT_TOKENS:
        raise HTTPException(status_code=400, detail="max_tokens must be between 1 and 4096")
    request = providers_pb2.CompleteRequest(
        model=body.model,
        messages=[providers_pb2.Message(role=m.role, content=m.content) for m in body.messages],
        max_tokens=body.max_tokens,
    )
    try:
        reply = providers.Complete(request, timeout=PROVIDER_TIMEOUT_S)
    except grpc.RpcError as exc:
        if exc.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
            raise HTTPException(status_code=504, detail="provider deadline exceeded") from exc
        raise HTTPException(status_code=502, detail="provider failed") from exc
    return ChatReply(
        id=str(uuid.uuid4()),
        content=reply.content,
        usage=Usage(input_tokens=reply.usage.input_tokens, output_tokens=reply.usage.output_tokens),
    )


# uvicorn chat_api:app --port 8443 --ssl-certfile cert.pem --ssl-keyfile key.pem
`,
    },
    go: {
      starter: `package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"google.golang.org/grpc"
	pb "gateway/providerspb"
)

const (
	maxInputTokens  = 8192
	maxOutputTokens = 4096
)

var roles = map[string]bool{"system": true, "user": true, "assistant": true}

var providers pb.ProviderClient

type chatMessage struct {
	Role    string \`json:"role"\`
	Content string \`json:"content"\`
}

type chatRequest struct {
	Model     string        \`json:"model"\`
	Messages  []chatMessage \`json:"messages"\`
	MaxTokens int           \`json:"max_tokens"\`
}

func newRequestID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func authenticate(r *http.Request) (string, bool) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return "", false
	}
	return strings.TrimPrefix(auth, "Bearer "), true
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func chat(rw http.ResponseWriter, r *http.Request) {
	tenant, ok := authenticate(r)
	if !ok {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
		return
	}
	var body chatRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	// TODO: 400 for empty messages, unknown roles, estimate > maxInputTokens, max_tokens outside 1...4096
	// TODO: context.WithTimeout(8s); codes.DeadlineExceeded -> 504, other provider errors -> 502
	// TODO: return reply.GetUsage(), never log body.Messages
	req := &pb.CompleteRequest{Model: body.Model, MaxTokens: int32(body.MaxTokens)}
	for _, m := range body.Messages {
		req.Messages = append(req.Messages, &pb.Message{Role: m.Role, Content: m.Content})
	}
	reply, err := providers.Complete(r.Context(), req)
	if err != nil {
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "provider failed"})
		return
	}
	log.Printf("tenant=%s messages=%v", tenant, body.Messages)
	chars := 0
	for _, m := range body.Messages {
		chars += len(m.Content)
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"id":      newRequestID(),
		"content": reply.GetContent(),
		"usage": map[string]int{
			"input_tokens":  (chars + 3) / 4,
			"output_tokens": (len(reply.GetContent()) + 3) / 4,
		},
	})
}

func main() {
	conn, _ := grpc.NewClient("providers:9000", grpc.WithInsecure())
	providers = pb.NewProviderClient(conn)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/chat", chat)
	_ = http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux)
}
`,
      solution: `package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	pb "gateway/providerspb"
)

const (
	maxInputTokens  = 8192
	maxOutputTokens = 4096
)

var (
	providerTimeout = 8 * time.Second
	roles           = map[string]bool{"system": true, "user": true, "assistant": true}
	providers       pb.ProviderClient
)

type chatMessage struct {
	Role    string \`json:"role"\`
	Content string \`json:"content"\`
}

type chatRequest struct {
	Model     string        \`json:"model"\`
	Messages  []chatMessage \`json:"messages"\`
	MaxTokens int           \`json:"max_tokens"\`
}

func newRequestID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func authenticate(r *http.Request) (string, bool) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return "", false
	}
	return strings.TrimPrefix(auth, "Bearer "), true
}

func estimateTokens(messages []chatMessage) int {
	chars := 0
	for _, m := range messages {
		chars += len(m.Content)
	}
	return (chars + 3) / 4
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	_ = json.NewEncoder(rw).Encode(body)
}

func chat(rw http.ResponseWriter, r *http.Request) {
	if _, ok := authenticate(r); !ok {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
		return
	}
	var body chatRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if len(body.Messages) == 0 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "messages must not be empty"})
		return
	}
	for _, m := range body.Messages {
		if !roles[m.Role] {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "unknown role"})
			return
		}
	}
	if estimateTokens(body.Messages) > maxInputTokens {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "input exceeds 8192 tokens"})
		return
	}
	if body.MaxTokens < 1 || body.MaxTokens > maxOutputTokens {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "max_tokens must be 1...4096"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), providerTimeout)
	defer cancel()
	req := &pb.CompleteRequest{Model: body.Model, MaxTokens: int32(body.MaxTokens)}
	for _, m := range body.Messages {
		req.Messages = append(req.Messages, &pb.Message{Role: m.Role, Content: m.Content})
	}
	reply, err := providers.Complete(ctx, req)
	if err != nil {
		if status.Code(err) == codes.DeadlineExceeded {
			writeJSON(rw, http.StatusGatewayTimeout, map[string]string{"error": "provider deadline exceeded"})
			return
		}
		writeJSON(rw, http.StatusBadGateway, map[string]string{"error": "provider failed"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"id":      newRequestID(),
		"content": reply.GetContent(),
		"usage": map[string]int{
			"input_tokens":  int(reply.GetUsage().GetInputTokens()),
			"output_tokens": int(reply.GetUsage().GetOutputTokens()),
		},
	})
}

func main() {
	conn, _ := grpc.NewClient("providers:9000", grpc.WithInsecure())
	providers = pb.NewProviderClient(conn)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/chat", chat)
	_ = http.ListenAndServeTLS(":8443", "cert.pem", "key.pem", mux)
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import io.grpc.ManagedChannelBuilder
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import org.slf4j.LoggerFactory
import providers.{CompleteRequest, Message, ProviderGrpc}
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class ChatMessage(role: String, content: String)
final case class ChatRequest(model: String, messages: List[ChatMessage], max_tokens: Int)
final case class Usage(input_tokens: Int, output_tokens: Int)
final case class ChatReply(id: String, content: String, usage: Usage)

object ChatApi {
  val MaxInputTokens = 8192
  val MaxOutputTokens = 4096
  val ProviderTimeoutSeconds = 8L
  val Roles = Set("system", "user", "assistant")

  private val logger = LoggerFactory.getLogger(getClass)
  private val channel = ManagedChannelBuilder.forAddress("providers", 9000).usePlaintext().build()
  private val stub = ProviderGrpc.blockingStub(channel)

  implicit val messageFormat: RootJsonFormat[ChatMessage] = jsonFormat2(ChatMessage)
  implicit val chatFormat: RootJsonFormat[ChatRequest] = jsonFormat3(ChatRequest)
  implicit val usageFormat: RootJsonFormat[Usage] = jsonFormat2(Usage)
  implicit val replyFormat: RootJsonFormat[ChatReply] = jsonFormat3(ChatReply)

  private def json(status: StatusCode, body: String): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  def authenticate(authorization: Option[String]): String =
    authorization.filter(_.startsWith("Bearer ")).map(_.drop(7)).getOrElse(
      throw new IllegalArgumentException("missing bearer token")
    )

  val route: Route =
    path("v1" / "chat") {
      post {
        headerValueByName("Authorization") { authorization =>
          entity(as[ChatRequest]) { body =>
            val tenant = authenticate(Some(authorization))
            // TODO: 400 on empty messages, unknown role, input > MaxInputTokens or max_tokens outside 1...MaxOutputTokens
            // TODO: withDeadlineAfter(8, SECONDS); DEADLINE_EXCEEDED -> 504, every other failure -> 502
            // TODO: return reply.usage, never log the messages
            val request = CompleteRequest(
              model = body.model,
              messages = body.messages.map(m => Message(role = m.role, content = m.content)),
              maxTokens = body.max_tokens
            )
            val reply = stub.complete(request)
            logger.info("chat tenant=" + tenant + " messages=" + body.messages.toString)
            val chars = body.messages.map(_.content.length).sum
            json(
              StatusCodes.OK,
              ChatReply(UUID.randomUUID().toString, reply.content, Usage((chars + 3) / 4, (reply.content.length + 3) / 4)).toJson.compactPrint
            )
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("gateway")
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
      solution: `import java.util.UUID
import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, StatusCode, StatusRuntimeException}
import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route
import providers.{CompleteReply, CompleteRequest, Message, ProviderGrpc}
import spray.json._
import spray.json.DefaultJsonProtocol._

final case class ChatMessage(role: String, content: String)
final case class ChatRequest(model: String, messages: List[ChatMessage], max_tokens: Int)
final case class Usage(input_tokens: Int, output_tokens: Int)
final case class ChatReply(id: String, content: String, usage: Usage)

object ChatApi {
  val MaxInputTokens = 8192
  val MaxOutputTokens = 4096
  val ProviderTimeoutSeconds = 8L
  val Roles = Set("system", "user", "assistant")

  private val channel = ManagedChannelBuilder.forAddress("providers", 9000).usePlaintext().build()
  private val stub = ProviderGrpc.blockingStub(channel)

  implicit val messageFormat: RootJsonFormat[ChatMessage] = jsonFormat2(ChatMessage)
  implicit val chatFormat: RootJsonFormat[ChatRequest] = jsonFormat3(ChatRequest)
  implicit val usageFormat: RootJsonFormat[Usage] = jsonFormat2(Usage)
  implicit val replyFormat: RootJsonFormat[ChatReply] = jsonFormat3(ChatReply)

  private def json(status: StatusCode, body: String): Route =
    complete(HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, body)))

  def authenticate(authorization: Option[String]): String =
    authorization.filter(_.startsWith("Bearer ")).map(_.drop(7)).getOrElse(
      throw new IllegalArgumentException("missing bearer token")
    )

  private def estimateTokens(messages: List[ChatMessage]): Int =
    (messages.map(_.content.length).sum + 3) / 4

  private def callProvider(body: ChatRequest): Either[StatusCode, CompleteReply] =
    try {
      val request = CompleteRequest(
        model = body.model,
        messages = body.messages.map(m => Message(role = m.role, content = m.content)),
        maxTokens = body.max_tokens
      )
      val call = stub.withDeadlineAfter(ProviderTimeoutSeconds, TimeUnit.SECONDS)
      Right(call.complete(request))
    } catch {
      case e: StatusRuntimeException => Left(e.getStatus.getCode)
    }

  val route: Route =
    path("v1" / "chat") {
      post {
        headerValueByName("Authorization") { authorization =>
          entity(as[ChatRequest]) { body =>
            authenticate(Some(authorization))
            if (body.messages.isEmpty) json(StatusCodes.BadRequest, """{"error":"messages must not be empty"}""")
            else if (body.messages.exists(m => !Roles.contains(m.role))) json(StatusCodes.BadRequest, """{"error":"unknown role"}""")
            else if (estimateTokens(body.messages) > MaxInputTokens) json(StatusCodes.BadRequest, """{"error":"input exceeds 8192 tokens"}""")
            else if (body.max_tokens < 1 || body.max_tokens > MaxOutputTokens) json(StatusCodes.BadRequest, """{"error":"max_tokens must be 1...4096"}""")
            else callProvider(body) match {
              case Left(StatusCode.DEADLINE_EXCEEDED) =>
                json(StatusCodes.GatewayTimeout, """{"error":"provider deadline exceeded"}""")
              case Left(_) =>
                json(StatusCodes.BadGateway, """{"error":"provider failed"}""")
              case Right(reply) =>
                json(
                  StatusCodes.OK,
                  ChatReply(UUID.randomUUID().toString, reply.content, Usage(reply.usage.inputTokens, reply.usage.outputTokens)).toJson.compactPrint
                )
            }
          }
        }
      }
    }

  def main(args: Array[String]): Unit = {
    implicit val system: ActorSystem = ActorSystem("gateway")
    Http().newServerAt("0.0.0.0", 8443).bind(route)
  }
}
`,
    },
    cpp: {
      starter: `#include <chrono>
#include <iostream>
#include <memory>
#include <random>
#include <string>

#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include "providers.grpc.pb.h"

using json = nlohmann::json;

constexpr int kMaxInputTokens = 8192;
constexpr int kMaxOutputTokens = 4096;

static std::string request_id() {
  static std::mt19937_64 rng{std::random_device{}()};
  return std::to_string(rng());
}

static bool valid_role(const std::string& role) {
  return role == "system" || role == "user" || role == "assistant";
}

int main() {
  auto channel = grpc::CreateChannel("providers:9000", grpc::InsecureChannelCredentials());
  auto stub = Provider::NewStub(channel);
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/v1/chat", [&stub](const httplib::Request& req, httplib::Response& res) {
    const std::string auth = req.get_header_value("Authorization");
    if (auth.rfind("Bearer ", 0) != 0) {
      res.status = 401;
      res.set_content(R"({"error":"missing bearer token"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    // TODO: 400 on empty messages, unknown role, estimate > kMaxInputTokens, max_tokens outside 1...4096
    // TODO: set_deadline(8s); DEADLINE_EXCEEDED -> 504, other failures -> 502
    // TODO: return reply.usage(), not local estimates; never log the prompt
    ::CompleteRequest request;
    request.set_model(body.value("model", "gpt-4o-mini"));
    request.set_max_tokens(body.value("max_tokens", 512));
    int chars = 0;
    if (body.contains("messages") && body["messages"].is_array()) {
      for (const auto& m : body["messages"]) {
        auto* message = request.add_messages();
        message->set_role(m.value("role", "user"));
        message->set_content(m.value("content", ""));
        chars += static_cast<int>(m.value("content", "").size());
      }
    }
    ::CompleteReply reply;
    grpc::ClientContext ctx;
    const grpc::Status status = stub->Complete(&ctx, request, &reply);
    if (!status.ok()) {
      res.status = 502;
      res.set_content(R"({"error":"provider failed"})", "application/json");
      return;
    }
    std::cout << "chat messages=" << body.dump() << std::endl;
    json out = {
        {"id", request_id()},
        {"content", reply.content()},
        {"usage", {{"input_tokens", (chars + 3) / 4}, {"output_tokens", (static_cast<int>(reply.content().size()) + 3) / 4}}},
    };
    res.status = 200;
    res.set_content(out.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
      solution: `#include <chrono>
#include <memory>
#include <random>
#include <string>

#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include "providers.grpc.pb.h"

using json = nlohmann::json;

constexpr int kMaxInputTokens = 8192;
constexpr int kMaxOutputTokens = 4096;
constexpr auto kProviderTimeout = std::chrono::seconds(8);

static std::string request_id() {
  static std::mt19937_64 rng{std::random_device{}()};
  return std::to_string(rng());
}

static bool valid_role(const std::string& role) {
  return role == "system" || role == "user" || role == "assistant";
}

static int estimate_tokens(const json& messages) {
  int chars = 0;
  for (const auto& m : messages) chars += static_cast<int>(m.value("content", "").size());
  return (chars + 3) / 4;
}

int main() {
  auto channel = grpc::CreateChannel("providers:9000", grpc::InsecureChannelCredentials());
  auto stub = Provider::NewStub(channel);
  httplib::SSLServer svr("cert.pem", "key.pem");

  svr.Post("/v1/chat", [&stub](const httplib::Request& req, httplib::Response& res) {
    const std::string auth = req.get_header_value("Authorization");
    if (auth.rfind("Bearer ", 0) != 0) {
      res.status = 401;
      res.set_content(R"({"error":"missing bearer token"})", "application/json");
      return;
    }
    json body = json::parse(req.body, nullptr, false);
    if (!body.is_object()) body = json::object();
    if (!body.contains("messages") || !body["messages"].is_array() || body["messages"].empty()) {
      res.status = 400;
      res.set_content(R"({"error":"messages must not be empty"})", "application/json");
      return;
    }
    for (const auto& m : body["messages"]) {
      if (!m.is_object() || !m.contains("role") || !m.contains("content") || !valid_role(m["role"].get<std::string>())) {
        res.status = 400;
        res.set_content(R"({"error":"unknown role"})", "application/json");
        return;
      }
    }
    if (estimate_tokens(body["messages"]) > kMaxInputTokens) {
      res.status = 400;
      res.set_content(R"({"error":"input exceeds 8192 tokens"})", "application/json");
      return;
    }
    const int max_tokens = body.value("max_tokens", 512);
    if (max_tokens < 1 || max_tokens > kMaxOutputTokens) {
      res.status = 400;
      res.set_content(R"({"error":"max_tokens must be 1...4096"})", "application/json");
      return;
    }
    ::CompleteRequest request;
    request.set_model(body.value("model", "gpt-4o-mini"));
    request.set_max_tokens(max_tokens);
    for (const auto& m : body["messages"]) {
      auto* message = request.add_messages();
      message->set_role(m["role"].get<std::string>());
      message->set_content(m["content"].get<std::string>());
    }
    ::CompleteReply reply;
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kProviderTimeout);
    const grpc::Status status = stub->Complete(&ctx, request, &reply);
    if (!status.ok()) {
      if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
        res.status = 504;
        res.set_content(R"({"error":"provider deadline exceeded"})", "application/json");
      } else {
        res.status = 502;
        res.set_content(R"({"error":"provider failed"})", "application/json");
      }
      return;
    }
    json out = {
        {"id", request_id()},
        {"content", reply.content()},
        {"usage", {{"input_tokens", reply.usage().input_tokens()}, {"output_tokens", reply.usage().output_tokens()}}},
    };
    res.status = 200;
    res.set_content(out.dump(), "application/json");
  });

  svr.listen("0.0.0.0", 8443);
}
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

const app = Fastify({logger: true});

const MAX_INPUT_TOKENS = 8192;
const MAX_OUTPUT_TOKENS = 4096;
const PROVIDER_TIMEOUT_MS = 8_000;
const ROLES: Record<string, true> = {system: true, user: true, assistant: true};

interface Message {
  role: string;
  content: string;
}
interface ChatRequest {
  model: string;
  messages: Message[];
  max_tokens: number;
}
interface CompleteRequest {
  model: string;
  messages: Message[];
  max_tokens: number;
}
interface CompleteReply {
  content: string;
  usage: {inputTokens: number; outputTokens: number};
}
interface ProviderClient {
  Complete(
    request: CompleteRequest,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: CompleteReply) => void,
  ): void;
}

const {providers} = grpc.loadPackageDefinition(protoLoader.loadSync('providers.proto')) as unknown as {
  providers: {Provider: new (target: string, credentials: grpc.ChannelCredentials) => ProviderClient};
};
const provider = new providers.Provider('providers:9000', grpc.credentials.createInsecure());

function estimateTokens(messages: Message[]): number {
  const characters = messages.reduce((sum, message) => sum + message.content.length, 0);
  return Math.ceil(characters / 4);
}

app.post('/v1/chat', async (request, reply) => {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith('Bearer ')) {
    return reply.code(401).send({error: 'missing bearer token'});
  }
  const body = request.body as ChatRequest;
  // TODO: reject an empty messages list, unknown roles, MAX_INPUT_TOKENS and max_tokens outside 1...4096 before the paid call
  // TODO: pass {deadline: Date.now() + PROVIDER_TIMEOUT_MS}; map DEADLINE_EXCEEDED to 504 and other RPC failures to 502
  // TODO: return completion.usage and stop logging the prompt
  const completion = await new Promise<CompleteReply>((resolve, reject) => {
    provider.Complete(
      {
        model: body.model,
        messages: body.messages.map(message => ({role: message.role, content: message.content})),
        max_tokens: body.max_tokens,
      },
      {},
      (error, response) => (error === null ? resolve(response) : reject(error)),
    );
  });
  request.log.info({messages: body.messages}, 'chat');
  if (body.messages.length === 0) return reply.code(400).send({error: 'messages must not be empty'});
  if (body.messages.some(message => !ROLES[message.role])) {
    return reply.code(400).send({error: 'role must be system, user or assistant'});
  }
  if (estimateTokens(body.messages) > MAX_INPUT_TOKENS) {
    return reply.code(400).send({error: 'input exceeds 8192 tokens'});
  }
  if (body.max_tokens < 1 || body.max_tokens > MAX_OUTPUT_TOKENS) {
    return reply.code(400).send({error: 'max_tokens must be between 1 and 4096'});
  }
  return reply.code(200).send({
    id: randomUUID(),
    content: completion.content,
    usage: {
      input_tokens: estimateTokens(body.messages),
      output_tokens: Math.ceil(completion.content.length / 4),
    },
  });
});

await app.listen({host: '0.0.0.0', port: 8443});
`,
      solution: `import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';

const app = Fastify({logger: true});

const MAX_INPUT_TOKENS = 8192;
const MAX_OUTPUT_TOKENS = 4096;
const PROVIDER_TIMEOUT_MS = 8_000;
const ROLES: Record<string, true> = {system: true, user: true, assistant: true};

interface Message {
  role: string;
  content: string;
}
interface ChatRequest {
  model: string;
  messages: Message[];
  max_tokens: number;
}
interface CompleteRequest {
  model: string;
  messages: Message[];
  max_tokens: number;
}
interface CompleteReply {
  content: string;
  usage: {inputTokens: number; outputTokens: number};
}
interface ProviderClient {
  Complete(
    request: CompleteRequest,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: CompleteReply) => void,
  ): void;
}

const {providers} = grpc.loadPackageDefinition(protoLoader.loadSync('providers.proto')) as unknown as {
  providers: {Provider: new (target: string, credentials: grpc.ChannelCredentials) => ProviderClient};
};
const provider = new providers.Provider('providers:9000', grpc.credentials.createInsecure());

function estimateTokens(messages: Message[]): number {
  const characters = messages.reduce((sum, message) => sum + message.content.length, 0);
  return Math.ceil(characters / 4);
}

app.post('/v1/chat', async (request, reply) => {
  const authorization = request.headers.authorization;
  if (authorization === undefined || !authorization.startsWith('Bearer ')) {
    return reply.code(401).send({error: 'missing bearer token'});
  }
  const body = request.body as ChatRequest;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return reply.code(400).send({error: 'messages must not be empty'});
  }
  if (body.messages.some(message => !ROLES[message.role])) {
    return reply.code(400).send({error: 'role must be system, user or assistant'});
  }
  if (estimateTokens(body.messages) > MAX_INPUT_TOKENS) {
    return reply.code(400).send({error: 'input exceeds 8192 tokens'});
  }
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > MAX_OUTPUT_TOKENS) {
    return reply.code(400).send({error: 'max_tokens must be between 1 and 4096'});
  }
  let completion: CompleteReply;
  try {
    completion = await new Promise<CompleteReply>((resolve, reject) => {
      provider.Complete(
        {
          model: body.model,
          messages: body.messages.map(message => ({role: message.role, content: message.content})),
          max_tokens: body.max_tokens,
        },
        {deadline: Date.now() + PROVIDER_TIMEOUT_MS},
        (error, response) => (error === null ? resolve(response) : reject(error)),
      );
    });
  } catch (error) {
    if ((error as grpc.ServiceError).code === grpc.status.DEADLINE_EXCEEDED) {
      return reply.code(504).send({error: 'provider deadline exceeded'});
    }
    return reply.code(502).send({error: 'provider failed'});
  }
  return reply.code(200).send({
    id: randomUUID(),
    content: completion.content,
    usage: {
      input_tokens: completion.usage.inputTokens,
      output_tokens: completion.usage.outputTokens,
    },
  });
});

await app.listen({host: '0.0.0.0', port: 8443});
`,
    },
  },
  debrief: `The review question an interviewer is really asking here is: **can you tell the difference between a draft that works and a contract you would put in front of tenants?** The draft did the visible thing — decode, call, return content — and skipped the invisible edges: rejecting before spending money, putting a deadline on a network call, and returning the provider's accounting rather than guessing. The 504/502 split matters because the client can retry a 504 with backoff but should not retry a 502 blindly; the hidden prompt is the security failure. Real gateways add per-route input limits, provider-specific tokenizers instead of the chars/4 estimate, and structured audit logs that record ids and token counts but never message content.`,
};
