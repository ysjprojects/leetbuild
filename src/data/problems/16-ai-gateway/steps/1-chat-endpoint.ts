import type {Step} from '@/lib/types';

// ---- 1. POST /v1/chat --------------------------------------------------------------------------------
export const chatEndpointStep: Step = {
  id: 'chat-endpoint',
  title: 'POST /v1/chat: validate, call, account',
  concept: 'http',
  file: 'chat_api',
  focus: ['client', 'gateway', 'providers'],
  task: `## Task

**Starting point.** The starter serves \`POST /v1/chat\` with body
\`{"model", "messages": [{"role", "content"}], "max_tokens"}\`. It takes the tenant from
\`Authorization: Bearer <tenant>\` through the provided \`authenticate\`, calls
\`Provider.Complete(model, messages, max_tokens)\` at \`providers:9000\`, and answers 200 with
\`{id, content, usage: {input_tokens, output_tokens}}\`. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** A malformed request that still costs a provider call, a provider
that hangs and takes every worker with it, token counts billing cannot reconcile with the
provider's invoice, and a prompt that leaks into a log line.

- An empty \`messages\`, a role outside \`system\` / \`user\` / \`assistant\`, an estimated input over
  **MAX_INPUT_TOKENS = 8192** (\`ceil(characters / 4)\`), or \`max_tokens\` outside **1…4096** answers
  **400** and makes no provider call.
- The \`Complete\` call carries an **8 s deadline**. \`DEADLINE_EXCEEDED\` becomes **504**; any other
  provider failure becomes **502**.
- \`usage\` is what the provider reported, not an estimate of the text; \`id\` is a fresh request id.
- Neither the response nor a log line carries the messages.`,
  sequence: {
    participants: ['Client', 'gateway', 'Provider'],
    messages: [
      {from: 'Client', to: 'gateway', label: 'POST /v1/chat · Bearer acme', kind: 'sync'},
      {from: 'gateway', to: 'gateway', label: 'roles · ceil(chars / 4) ≤ 8192 · 1 ≤ max_tokens ≤ 4096', kind: 'sync'},
      {from: 'gateway', to: 'Provider', label: 'Complete(model, messages, max_tokens) · deadline 8 s', kind: 'sync'},
      {from: 'Provider', to: 'gateway', label: 'CompleteReply{content, usage}', kind: 'reply'},
      {from: 'gateway', to: 'Client', label: '200 {id, content, usage}', kind: 'reply'},
      {from: 'Client', to: 'gateway', label: 'POST /v1/chat · max_tokens: 0', kind: 'sync'},
      {from: 'gateway', to: 'Client', label: '400 (no provider call)', kind: 'reply'},
    ],
  },
  hints: [
    'A request with `max_tokens: 0` is answered 400, yet the provider dashboard shows a call for it; a stalled provider leaves the request open for minutes; `usage` in the answer disagrees with the invoice.',
    'The handler calls the provider first and validates afterwards, so the call is already paid for; the call has no deadline, so nothing ends it; `usage` is recomputed from text lengths instead of read from the reply.',
    'Move the four checks above the call. Pass the deadline on the call itself (`timeout=`, a context with timeout, `deadline:`, `set_deadline`), map `DEADLINE_EXCEEDED` to 504 and the rest to 502, return `reply.usage`, and delete the log line.',
  ],
  checks: [
    {
      id: 'route',
      title: 'Handles POST /v1/chat behind the bearer token',
      detail:
        'A handler is registered for `POST /v1/chat`; it authenticates the tenant through the provided `authenticate` and answers JSON.',
      match: {
        python: {all: [/@app\.post\(\s*["']\/v1\/chat["']/, /authenticate\(/]},
        typescript: {all: [/app\.post\(\s*['"]\/v1\/chat['"]/, /authenticate\(/]},
        go: {all: [/"POST \/v1\/chat"/, /auth\.Tenant\(/]},
        scala: {all: [/path\(\s*"v1"\s*\/\s*"chat"\s*\)/, /Auth\.tenant\(/]},
        cpp: {all: [/svr\.Post\(\s*"\/v1\/chat"/, /gateway::tenant\(/]},
      },
    },
    {
      id: 'validate',
      title: 'Rejects bad requests with 400 before the provider call',
      detail:
        'Empty `messages`, an unknown role, more than `MAX_INPUT_TOKENS` (ceil(chars / 4)) and `max_tokens` outside 1…4096 answer 400 before `Complete` is called: the input estimate and the limit comparison come before the call site.',
      match: {
        python: {
          all: [/>\s*MAX_INPUT_TOKENS/, /MAX_OUTPUT_TOKENS/, /\b400\b/],
          order: [/(?<!def )estimate_tokens\(|>\s*MAX_INPUT_TOKENS/, /providers\.Complete\(/],
        },
        typescript: {
          all: [/>\s*MAX_INPUT_TOKENS/, /MAX_OUTPUT_TOKENS/, /\b400\b/],
          order: [/(?<!function )estimateTokens\(|>\s*MAX_INPUT_TOKENS/, /\.Complete\(/],
        },
        go: {
          all: [/>\s*maxInputTokens/, /maxOutputTokens/, /http\.StatusBadRequest|\b400\b/],
          order: [/(?<!func )estimateTokens\(|>\s*maxInputTokens/, /\.Complete\(/],
        },
        scala: {
          all: [/>\s*MaxInputTokens/, /MaxOutputTokens/, /StatusCodes\.BadRequest|\b400\b/],
          order: [/(?<!def )estimateTokens\(|>\s*MaxInputTokens/, /\.complete\(/],
        },
        cpp: {
          all: [/>\s*kMaxInputTokens/, /kMaxOutputTokens/, /\b400\b/],
          order: [/(?<!int )estimate_tokens\(|>\s*kMaxInputTokens/, /stub->Complete\(/],
        },
      },
    },
    {
      id: 'deadline',
      title: 'The provider call has an 8 s deadline and maps failures',
      detail:
        'The `Complete` call carries the 8 second deadline; `DEADLINE_EXCEEDED` is answered 504 and every other provider failure 502. Without the deadline one hung provider pins a worker for good.',
      match: {
        python: {all: [/\.Complete\([\s\S]{0,300}?timeout\s*=/, /DEADLINE_EXCEEDED/, /\b504\b/, /\b502\b/]},
        typescript: {all: [/\.Complete\([\s\S]{0,400}?deadline\s*:/, /DEADLINE_EXCEEDED/, /\b504\b/, /\b502\b/]},
        go: {
          all: [
            /context\.WithTimeout\(|context\.WithDeadline\(/,
            /codes\.DeadlineExceeded/,
            /http\.StatusGatewayTimeout|\b504\b/,
            /http\.StatusBadGateway|\b502\b/,
          ],
        },
        scala: {
          all: [
            /withDeadlineAfter\(/,
            /DEADLINE_EXCEEDED/,
            /StatusCodes\.GatewayTimeout|\b504\b/,
            /StatusCodes\.BadGateway|\b502\b/,
          ],
        },
        cpp: {all: [/set_deadline\(/, /DEADLINE_EXCEEDED/, /\b504\b/, /\b502\b/]},
      },
    },
    {
      id: 'usage',
      title: 'Returns the provider-reported usage and a request id',
      detail:
        'The answer is `{id, content, usage: {input_tokens, output_tokens}}` where both counts are the ones in the provider reply; an estimate from text lengths disagrees with the invoice.',
      match: {
        python: {all: [/\.usage\.input_tokens/, /\.usage\.output_tokens/], none: [/len\(\s*reply\.content\s*\)/]},
        typescript: {
          all: [/\.usage\.input_tokens/, /\.usage\.output_tokens/],
          none: [/completion\.content\.length|reply\.content\.length/],
        },
        go: {
          all: [/GetUsage\(\)\.GetInputTokens\(\)/, /GetUsage\(\)\.GetOutputTokens\(\)/],
          none: [/len\(\s*reply\.GetContent\(\)\s*\)/],
        },
        scala: {
          all: [
            /\.usage\.map\(_\.inputTokens\)|\.getUsage\.inputTokens|usage\.inputTokens/,
            /\.usage\.map\(_\.outputTokens\)|\.getUsage\.outputTokens|usage\.outputTokens/,
          ],
          none: [/reply\.content\.length/],
        },
        cpp: {
          all: [/usage\(\)\.input_tokens\(\)/, /usage\(\)\.output_tokens\(\)/],
          none: [/reply\.content\(\)\.size\(\)/],
        },
      },
    },
    {
      id: 'no-prompt-echo',
      title: 'Neither the answer nor a log line carries the messages',
      detail:
        'The response holds the completion and the usage only; nothing prints or logs the body, the messages or their content. A prompt in a log file is customer data in a place with no access control.',
      match: {
        python: {
          none: [
            /print\([^\n]*(body|messages|content|prompt)/i,
            /logg?(er|ing)\.[a-z]+\([^\n]*(body|messages|content|prompt)/i,
            /["']messages["']\s*:/,
          ],
        },
        typescript: {
          none: [
            /console\.(log|info|debug|warn|error)\([^\n]*(body|messages|content|prompt)/i,
            /\.log\.(info|debug|warn|error)\([^\n]*(body|messages|content|prompt)/i,
          ],
        },
        go: {none: [/(log|fmt)\.Print[a-z]*\([^\n]*(body|Messages|Content|prompt)/i, /"messages"\s*:/]},
        scala: {
          none: [
            /println\([^\n]*(body|messages|content|prompt)/i,
            /log\.(info|debug|warn)\([^\n]*(body|messages|content|prompt)/i,
            /"messages"\s*->/,
          ],
        },
        cpp: {none: [/std::c(out|err)[^\n]*(body|messages|content|prompt)/i, /\["messages"\]\s*=/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import math
import uuid

import grpc
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

import providers_pb2
import providers_pb2_grpc
from gateway.auth import authenticate

app = FastAPI()

MAX_INPUT_TOKENS = 8192
MAX_OUTPUT_TOKENS = 4096
PROVIDER_TIMEOUT_S = 8.0
ROLES = {"system", "user", "assistant"}

providers = providers_pb2_grpc.ProviderStub(grpc.insecure_channel("providers:9000"))


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str = "gpt-4o-mini"
    messages: list[Message]
    max_tokens: int = 512


def estimate_tokens(messages: list[Message]) -> int:
    return math.ceil(sum(len(m.content) for m in messages) / 4)


# TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
@app.post("/v1/chat")
def chat(body: ChatRequest, authorization: str | None = Header(default=None)) -> dict:
    tenant = authenticate(authorization)
    request = providers_pb2.CompleteRequest(
        model=body.model,
        messages=[providers_pb2.Message(role=m.role, content=m.content) for m in body.messages],
        max_tokens=body.max_tokens,
    )
    reply = providers.Complete(request)
    print("chat", tenant, [m.content for m in body.messages])
    if not body.messages:
        raise HTTPException(status_code=400, detail="messages must not be empty")
    if any(m.role not in ROLES for m in body.messages):
        raise HTTPException(status_code=400, detail="role must be system, user or assistant")
    if estimate_tokens(body.messages) > MAX_INPUT_TOKENS:
        raise HTTPException(status_code=400, detail="input exceeds 8192 tokens")
    if body.max_tokens < 1 or body.max_tokens > MAX_OUTPUT_TOKENS:
        raise HTTPException(status_code=400, detail="max_tokens must be between 1 and 4096")
    return {
        "id": str(uuid.uuid4()),
        "content": reply.content,
        "usage": {
            "input_tokens": estimate_tokens(body.messages),
            "output_tokens": math.ceil(len(reply.content) / 4),
        },
    }
`,
      solution: `import math
import uuid

import grpc
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

import providers_pb2
import providers_pb2_grpc
from gateway.auth import authenticate

app = FastAPI()

MAX_INPUT_TOKENS = 8192
MAX_OUTPUT_TOKENS = 4096
PROVIDER_TIMEOUT_S = 8.0
ROLES = {"system", "user", "assistant"}

providers = providers_pb2_grpc.ProviderStub(grpc.insecure_channel("providers:9000"))


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    model: str = "gpt-4o-mini"
    messages: list[Message]
    max_tokens: int = 512


def estimate_tokens(messages: list[Message]) -> int:
    return math.ceil(sum(len(m.content) for m in messages) / 4)


@app.post("/v1/chat")
def chat(body: ChatRequest, authorization: str | None = Header(default=None)) -> dict:
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
    return {
        "id": str(uuid.uuid4()),
        "content": reply.content,
        "usage": {"input_tokens": reply.usage.input_tokens, "output_tokens": reply.usage.output_tokens},
    }
`,
    },
    typescript: {
      starter: `import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';
import {authenticate} from 'gateway/auth';

export const app = Fastify();

export const MAX_INPUT_TOKENS = 8192;
export const MAX_OUTPUT_TOKENS = 4096;
export const PROVIDER_TIMEOUT_MS = 8_000;
const ROLES = new Set(['system', 'user', 'assistant']);

interface Message {
  role: string;
  content: string;
}
interface ChatRequest {
  model: string;
  messages: Message[];
  max_tokens: number;
}
interface CompleteReply {
  content: string;
  usage: {input_tokens: number; output_tokens: number};
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('providers.proto')) as unknown as {
  gateway: {Provider: grpc.ServiceClientConstructor};
};
const providers = new pkg.gateway.Provider('providers:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Complete(request: ChatRequest, options: grpc.CallOptions): Promise<CompleteReply>;
};

function estimateTokens(messages: Message[]): number {
  return Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
}

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
app.post('/v1/chat', async (request, reply) => {
  const tenant = authenticate(request.headers.authorization);
  const body = request.body as ChatRequest;
  const completion = await providers.Complete(
    {model: body.model, messages: body.messages.map(m => ({role: m.role, content: m.content})), max_tokens: body.max_tokens},
    {},
  );
  console.log('chat', tenant, body.messages.map(m => m.content));
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return reply.code(400).send({error: 'messages must not be empty'});
  }
  if (body.messages.some(m => !ROLES.has(m.role))) {
    return reply.code(400).send({error: 'role must be system, user or assistant'});
  }
  if (estimateTokens(body.messages) > MAX_INPUT_TOKENS) {
    return reply.code(400).send({error: 'input exceeds 8192 tokens'});
  }
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > MAX_OUTPUT_TOKENS) {
    return reply.code(400).send({error: 'max_tokens must be between 1 and 4096'});
  }
  return {
    id: randomUUID(),
    content: completion.content,
    usage: {input_tokens: estimateTokens(body.messages), output_tokens: Math.ceil(completion.content.length / 4)},
  };
});
`,
      solution: `import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';
import {authenticate} from 'gateway/auth';

export const app = Fastify();

export const MAX_INPUT_TOKENS = 8192;
export const MAX_OUTPUT_TOKENS = 4096;
export const PROVIDER_TIMEOUT_MS = 8_000;
const ROLES = new Set(['system', 'user', 'assistant']);

interface Message {
  role: string;
  content: string;
}
interface ChatRequest {
  model: string;
  messages: Message[];
  max_tokens: number;
}
interface CompleteReply {
  content: string;
  usage: {input_tokens: number; output_tokens: number};
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('providers.proto')) as unknown as {
  gateway: {Provider: grpc.ServiceClientConstructor};
};
const providers = new pkg.gateway.Provider('providers:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Complete(request: ChatRequest, options: grpc.CallOptions): Promise<CompleteReply>;
};

function estimateTokens(messages: Message[]): number {
  return Math.ceil(messages.reduce((sum, m) => sum + m.content.length, 0) / 4);
}

app.post('/v1/chat', async (request, reply) => {
  authenticate(request.headers.authorization);
  const body = request.body as ChatRequest;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return reply.code(400).send({error: 'messages must not be empty'});
  }
  if (body.messages.some(m => !ROLES.has(m.role))) {
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
    completion = await providers.Complete(
      {model: body.model, messages: body.messages.map(m => ({role: m.role, content: m.content})), max_tokens: body.max_tokens},
      {deadline: Date.now() + PROVIDER_TIMEOUT_MS},
    );
  } catch (e) {
    const {code} = e as grpc.ServiceError;
    if (code === grpc.status.DEADLINE_EXCEEDED) return reply.code(504).send({error: 'provider deadline exceeded'});
    return reply.code(502).send({error: 'provider failed'});
  }
  return {
    id: randomUUID(),
    content: completion.content,
    usage: {input_tokens: completion.usage.input_tokens, output_tokens: completion.usage.output_tokens},
  };
});
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"encoding/json"
	"log"
	"math"
	"net/http"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"gateway/auth"
	pb "gateway/gen/providers"
)

const (
	maxInputTokens  = 8192
	maxOutputTokens = 4096
	providerTimeout = 8 * 1000 // milliseconds
)

var roles = map[string]bool{"system": true, "user": true, "assistant": true}

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

func estimateTokens(messages []chatMessage) int {
	chars := 0
	for _, m := range messages {
		chars += len(m.Content)
	}
	return int(math.Ceil(float64(chars) / 4))
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
func chat(rw http.ResponseWriter, r *http.Request) {
	tenant, ok := auth.Tenant(r)
	if !ok {
		writeJSON(rw, http.StatusUnauthorized, map[string]string{"error": "missing bearer token"})
		return
	}
	var body chatRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	req := &pb.CompleteRequest{Model: body.Model, MaxTokens: int32(body.MaxTokens)}
	for _, m := range body.Messages {
		req.Messages = append(req.Messages, &pb.Message{Role: m.Role, Content: m.Content})
	}
	reply, err := providers.Complete(context.Background(), req)
	if err != nil {
		writeJSON(rw, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	log.Printf("chat tenant=%s messages=%v", tenant, body.Messages)
	if len(body.Messages) == 0 {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "messages must not be empty"})
		return
	}
	for _, m := range body.Messages {
		if !roles[m.Role] {
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "role must be system, user or assistant"})
			return
		}
	}
	if estimateTokens(body.Messages) > maxInputTokens {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "input exceeds 8192 tokens"})
		return
	}
	if body.MaxTokens < 1 || body.MaxTokens > maxOutputTokens {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "max_tokens must be between 1 and 4096"})
		return
	}
	writeJSON(rw, http.StatusOK, map[string]any{
		"id":      uuid.NewString(),
		"content": reply.GetContent(),
		"usage": map[string]int{
			"input_tokens":  estimateTokens(body.Messages),
			"output_tokens": int(math.Ceil(float64(len(reply.GetContent())) / 4)),
		},
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/chat", chat)
}
`,
      solution: `package main

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"gateway/auth"
	pb "gateway/gen/providers"
)

const (
	maxInputTokens  = 8192
	maxOutputTokens = 4096
	providerTimeout = 8 * time.Second
)

var roles = map[string]bool{"system": true, "user": true, "assistant": true}

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

func estimateTokens(messages []chatMessage) int {
	chars := 0
	for _, m := range messages {
		chars += len(m.Content)
	}
	return int(math.Ceil(float64(chars) / 4))
}

func writeJSON(rw http.ResponseWriter, status int, body any) {
	rw.Header().Set("Content-Type", "application/json")
	rw.WriteHeader(status)
	json.NewEncoder(rw).Encode(body)
}

func chat(rw http.ResponseWriter, r *http.Request) {
	if _, ok := auth.Tenant(r); !ok {
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
			writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "role must be system, user or assistant"})
			return
		}
	}
	if estimateTokens(body.Messages) > maxInputTokens {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "input exceeds 8192 tokens"})
		return
	}
	if body.MaxTokens < 1 || body.MaxTokens > maxOutputTokens {
		writeJSON(rw, http.StatusBadRequest, map[string]string{"error": "max_tokens must be between 1 and 4096"})
		return
	}
	req := &pb.CompleteRequest{Model: body.Model, MaxTokens: int32(body.MaxTokens)}
	for _, m := range body.Messages {
		req.Messages = append(req.Messages, &pb.Message{Role: m.Role, Content: m.Content})
	}
	ctx, cancel := context.WithTimeout(r.Context(), providerTimeout)
	defer cancel()
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
		"id":      uuid.NewString(),
		"content": reply.GetContent(),
		"usage": map[string]int32{
			"input_tokens":  reply.GetUsage().GetInputTokens(),
			"output_tokens": reply.GetUsage().GetOutputTokens(),
		},
	})
}

func register(mux *http.ServeMux) {
	mux.HandleFunc("POST /v1/chat", chat)
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import gateway.Auth
import gateway.providers.{CompleteRequest, Message, ProviderGrpc}
import io.grpc.ManagedChannelBuilder
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object ChatApi {
  val MaxInputTokens = 8192
  val MaxOutputTokens = 4096
  val ProviderTimeoutMillis = 8000L
  val Roles = Set("system", "user", "assistant")

  private val channel = ManagedChannelBuilder.forAddress("providers", 9000).usePlaintext().build()
  private val providers = ProviderGrpc.blockingStub(channel)

  case class ChatMessage(role: String, content: String)
  case class ChatRequest(model: String, messages: Seq[ChatMessage], maxTokens: Int)

  def parse(body: String): ChatRequest = {
    val json = ujson.read(body)
    val messages = json.obj.get("messages").map(_.arr.toSeq).getOrElse(Seq.empty).map { m =>
      ChatMessage(m.obj.get("role").map(_.str).getOrElse(""), m.obj.get("content").map(_.str).getOrElse(""))
    }
    ChatRequest(
      json.obj.get("model").map(_.str).getOrElse("gpt-4o-mini"),
      messages,
      json.obj.get("max_tokens").map(_.num.toInt).getOrElse(512),
    )
  }

  def estimateTokens(messages: Seq[ChatMessage]): Int = math.ceil(messages.map(_.content.length).sum / 4.0).toInt

  private def error(status: StatusCode, message: String): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, s"""{"error":"$message"}"""))

  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  val route: Route =
    path("v1" / "chat") {
      post {
        optionalHeaderValueByName("Authorization") { authorization =>
          Auth.tenant(authorization) match {
            case None => complete(error(StatusCodes.Unauthorized, "missing bearer token"))
            case Some(tenant) =>
              entity(as[String]) { raw =>
                val body = parse(raw)
                val request = CompleteRequest(
                  model = body.model,
                  messages = body.messages.map(m => Message(role = m.role, content = m.content)),
                  maxTokens = body.maxTokens,
                )
                val reply = providers.complete(request)
                println(s"chat $tenant \${body.messages.map(_.content)}")
                if (body.messages.isEmpty) complete(error(StatusCodes.BadRequest, "messages must not be empty"))
                else if (body.messages.exists(m => !Roles.contains(m.role)))
                  complete(error(StatusCodes.BadRequest, "role must be system, user or assistant"))
                else if (estimateTokens(body.messages) > MaxInputTokens)
                  complete(error(StatusCodes.BadRequest, "input exceeds 8192 tokens"))
                else if (body.maxTokens < 1 || body.maxTokens > MaxOutputTokens)
                  complete(error(StatusCodes.BadRequest, "max_tokens must be between 1 and 4096"))
                else {
                  val usage = ujson.Obj(
                    "input_tokens" -> estimateTokens(body.messages),
                    "output_tokens" -> math.ceil(reply.content.length / 4.0).toInt,
                  )
                  val json = ujson.Obj("id" -> UUID.randomUUID().toString, "content" -> reply.content, "usage" -> usage)
                  complete(HttpEntity(ContentTypes.\`application/json\`, ujson.write(json)))
                }
              }
          }
        }
      }
    }
}
`,
      solution: `import java.util.UUID
import java.util.concurrent.TimeUnit

import gateway.Auth
import gateway.providers.{CompleteRequest, Message, ProviderGrpc}
import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}
import org.apache.pekko.http.scaladsl.model._
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object ChatApi {
  val MaxInputTokens = 8192
  val MaxOutputTokens = 4096
  val ProviderTimeoutMillis = 8000L
  val Roles = Set("system", "user", "assistant")

  private val channel = ManagedChannelBuilder.forAddress("providers", 9000).usePlaintext().build()
  private val providers = ProviderGrpc.blockingStub(channel)

  case class ChatMessage(role: String, content: String)
  case class ChatRequest(model: String, messages: Seq[ChatMessage], maxTokens: Int)

  def parse(body: String): ChatRequest = {
    val json = ujson.read(body)
    val messages = json.obj.get("messages").map(_.arr.toSeq).getOrElse(Seq.empty).map { m =>
      ChatMessage(m.obj.get("role").map(_.str).getOrElse(""), m.obj.get("content").map(_.str).getOrElse(""))
    }
    ChatRequest(
      json.obj.get("model").map(_.str).getOrElse("gpt-4o-mini"),
      messages,
      json.obj.get("max_tokens").map(_.num.toInt).getOrElse(512),
    )
  }

  def estimateTokens(messages: Seq[ChatMessage]): Int = math.ceil(messages.map(_.content.length).sum / 4.0).toInt

  private def error(status: StatusCode, message: String): HttpResponse =
    HttpResponse(status, entity = HttpEntity(ContentTypes.\`application/json\`, s"""{"error":"$message"}"""))

  val route: Route =
    path("v1" / "chat") {
      post {
        optionalHeaderValueByName("Authorization") { authorization =>
          Auth.tenant(authorization) match {
            case None => complete(error(StatusCodes.Unauthorized, "missing bearer token"))
            case Some(_) =>
              entity(as[String]) { raw =>
                val body = parse(raw)
                if (body.messages.isEmpty) complete(error(StatusCodes.BadRequest, "messages must not be empty"))
                else if (body.messages.exists(m => !Roles.contains(m.role)))
                  complete(error(StatusCodes.BadRequest, "role must be system, user or assistant"))
                else if (estimateTokens(body.messages) > MaxInputTokens)
                  complete(error(StatusCodes.BadRequest, "input exceeds 8192 tokens"))
                else if (body.maxTokens < 1 || body.maxTokens > MaxOutputTokens)
                  complete(error(StatusCodes.BadRequest, "max_tokens must be between 1 and 4096"))
                else {
                  val request = CompleteRequest(
                    model = body.model,
                    messages = body.messages.map(m => Message(role = m.role, content = m.content)),
                    maxTokens = body.maxTokens,
                  )
                  try {
                    val reply = providers.withDeadlineAfter(ProviderTimeoutMillis, TimeUnit.MILLISECONDS).complete(request)
                    val usage = ujson.Obj(
                      "input_tokens" -> reply.getUsage.inputTokens,
                      "output_tokens" -> reply.getUsage.outputTokens,
                    )
                    val json = ujson.Obj("id" -> UUID.randomUUID().toString, "content" -> reply.content, "usage" -> usage)
                    complete(HttpEntity(ContentTypes.\`application/json\`, ujson.write(json)))
                  } catch {
                    case e: StatusRuntimeException if e.getStatus.getCode == Status.Code.DEADLINE_EXCEEDED =>
                      complete(error(StatusCodes.GatewayTimeout, "provider deadline exceeded"))
                    case _: StatusRuntimeException =>
                      complete(error(StatusCodes.BadGateway, "provider failed"))
                  }
                }
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
#include <cmath>
#include <iostream>
#include <random>
#include <set>
#include <string>
#include <vector>

#include "gateway/auth.h"
#include "providers.grpc.pb.h"

constexpr int kMaxInputTokens = 8192;
constexpr int kMaxOutputTokens = 4096;
constexpr std::chrono::seconds kProviderTimeout{8};
const std::set<std::string> kRoles = {"system", "user", "assistant"};

auto channel = grpc::CreateChannel("providers:9000", grpc::InsecureChannelCredentials());
auto stub = gateway::Provider::NewStub(channel);

std::string request_id() {
  static std::mt19937_64 rng{std::random_device{}()};
  char buf[33];
  std::snprintf(buf, sizeof buf, "%016llx%016llx", static_cast<unsigned long long>(rng()),
                static_cast<unsigned long long>(rng()));
  return buf;
}

int estimate_tokens(const nlohmann::json& messages) {
  size_t chars = 0;
  for (const auto& m : messages) chars += m.value("content", "").size();
  return static_cast<int>(std::ceil(chars / 4.0));
}

void answer(httplib::Response& res, int status, const nlohmann::json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
void chat(const httplib::Request& req, httplib::Response& res) {
  const auto tenant = gateway::tenant(req);
  if (!tenant) return answer(res, 401, {{"error", "missing bearer token"}});
  nlohmann::json body;
  try {
    body = nlohmann::json::parse(req.body);
  } catch (const std::exception&) {
    return answer(res, 400, {{"error", "invalid json"}});
  }
  const nlohmann::json messages = body.value("messages", nlohmann::json::array());
  const int max_tokens = body.value("max_tokens", 512);

  gateway::CompleteRequest request;
  request.set_model(body.value("model", "gpt-4o-mini"));
  request.set_max_tokens(max_tokens);
  for (const auto& m : messages) {
    auto* msg = request.add_messages();
    msg->set_role(m.value("role", ""));
    msg->set_content(m.value("content", ""));
  }
  grpc::ClientContext ctx;
  gateway::CompleteReply reply;
  const grpc::Status status = stub->Complete(&ctx, request, &reply);
  if (!status.ok()) return answer(res, 500, {{"error", status.error_message()}});
  std::cout << "chat " << *tenant << " " << messages.dump() << "\\n";
  if (messages.empty()) return answer(res, 400, {{"error", "messages must not be empty"}});
  for (const auto& m : messages) {
    if (!kRoles.count(m.value("role", ""))) return answer(res, 400, {{"error", "role must be system, user or assistant"}});
  }
  if (estimate_tokens(messages) > kMaxInputTokens) return answer(res, 400, {{"error", "input exceeds 8192 tokens"}});
  if (max_tokens < 1 || max_tokens > kMaxOutputTokens) {
    return answer(res, 400, {{"error", "max_tokens must be between 1 and 4096"}});
  }
  nlohmann::json out;
  out["id"] = request_id();
  out["content"] = reply.content();
  out["usage"] = {{"input_tokens", estimate_tokens(messages)},
                  {"output_tokens", static_cast<int>(std::ceil(reply.content().size() / 4.0))}};
  answer(res, 200, out);
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/chat", chat);
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cmath>
#include <random>
#include <set>
#include <string>
#include <vector>

#include "gateway/auth.h"
#include "providers.grpc.pb.h"

constexpr int kMaxInputTokens = 8192;
constexpr int kMaxOutputTokens = 4096;
constexpr std::chrono::seconds kProviderTimeout{8};
const std::set<std::string> kRoles = {"system", "user", "assistant"};

auto channel = grpc::CreateChannel("providers:9000", grpc::InsecureChannelCredentials());
auto stub = gateway::Provider::NewStub(channel);

std::string request_id() {
  static std::mt19937_64 rng{std::random_device{}()};
  char buf[33];
  std::snprintf(buf, sizeof buf, "%016llx%016llx", static_cast<unsigned long long>(rng()),
                static_cast<unsigned long long>(rng()));
  return buf;
}

int estimate_tokens(const nlohmann::json& messages) {
  size_t chars = 0;
  for (const auto& m : messages) chars += m.value("content", "").size();
  return static_cast<int>(std::ceil(chars / 4.0));
}

void answer(httplib::Response& res, int status, const nlohmann::json& body) {
  res.status = status;
  res.set_content(body.dump(), "application/json");
}

void chat(const httplib::Request& req, httplib::Response& res) {
  if (!gateway::tenant(req)) return answer(res, 401, {{"error", "missing bearer token"}});
  nlohmann::json body;
  try {
    body = nlohmann::json::parse(req.body);
  } catch (const std::exception&) {
    return answer(res, 400, {{"error", "invalid json"}});
  }
  const nlohmann::json messages = body.value("messages", nlohmann::json::array());
  const int max_tokens = body.value("max_tokens", 512);
  if (messages.empty()) return answer(res, 400, {{"error", "messages must not be empty"}});
  for (const auto& m : messages) {
    if (!kRoles.count(m.value("role", ""))) return answer(res, 400, {{"error", "role must be system, user or assistant"}});
  }
  if (estimate_tokens(messages) > kMaxInputTokens) return answer(res, 400, {{"error", "input exceeds 8192 tokens"}});
  if (max_tokens < 1 || max_tokens > kMaxOutputTokens) {
    return answer(res, 400, {{"error", "max_tokens must be between 1 and 4096"}});
  }

  gateway::CompleteRequest request;
  request.set_model(body.value("model", "gpt-4o-mini"));
  request.set_max_tokens(max_tokens);
  for (const auto& m : messages) {
    auto* msg = request.add_messages();
    msg->set_role(m.value("role", ""));
    msg->set_content(m.value("content", ""));
  }
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kProviderTimeout);
  gateway::CompleteReply reply;
  const grpc::Status status = stub->Complete(&ctx, request, &reply);
  if (!status.ok()) {
    if (status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED) {
      return answer(res, 504, {{"error", "provider deadline exceeded"}});
    }
    return answer(res, 502, {{"error", "provider failed"}});
  }
  nlohmann::json out;
  out["id"] = request_id();
  out["content"] = reply.content();
  out["usage"] = {{"input_tokens", reply.usage().input_tokens()}, {"output_tokens", reply.usage().output_tokens()}};
  answer(res, 200, out);
}

void register_routes(httplib::Server& svr) {
  svr.Post("/v1/chat", chat);
}
`,
    },
  },
  harness: {
    python: `import contextlib
import io
import logging

import grpc

import providers_pb2
import providers_pb2_grpc

AUTH = {"Authorization": "Bearer acme"}
CANARY = "CANARY-7731 my account number is 4111"
ANSWER = "The capital of France is Paris."


class Providers(providers_pb2_grpc.ProviderServicer):
    """The model provider: a fixed answer, usage numbers a text estimate cannot reproduce."""

    def Complete(self, request, context):
        chars = sum(len(m.content) for m in request.messages)
        return providers_pb2.CompleteReply(content=ANSWER, usage=providers_pb2.Usage(input_tokens=chars // 4 + 11, output_tokens=42))


def _gateway(ctx):
    ctx.grpc.serve(providers_pb2_grpc.add_ProviderServicer_to_server, Providers())
    return ctx.load("chat_api")


def _body(content="What is the capital of France?", role="user", max_tokens=64, messages=None):
    return {"model": "gpt-4o-mini", "messages": [{"role": role, "content": content}] if messages is None else messages, "max_tokens": max_tokens}


async def _chat(ctx, m, body, headers=AUTH):
    async with ctx.client(m.app) as c:
        return await c.post("/v1/chat", json=body, headers=headers)


async def check_route(ctx):
    m = _gateway(ctx)
    r = await _chat(ctx, m, _body())
    assert r.status_code == 200, f"POST /v1/chat answered {r.status_code}: {r.text}"
    assert r.headers.get("content-type", "").startswith("application/json"), f"the answer must be JSON, got Content-Type {r.headers.get('content-type')!r}"
    body = r.json()
    assert body.get("content") == ANSWER, f"the answer's content must be the provider's completion {ANSWER!r}, got {body.get('content')!r}"
    assert isinstance(body.get("id"), str) and body["id"], f"the answer carries no request id: {body}"
    assert len(ctx.grpc.calls_to("Complete")) == 1, f"one chat made {len(ctx.grpc.calls_to('Complete'))} Complete calls, expected one"
    anonymous = await _chat(ctx, m, _body(), headers={})
    assert anonymous.status_code == 401, f"a request without a bearer token answered {anonymous.status_code}, expected 401"


async def check_validate(ctx):
    m = _gateway(ctx)
    bad = [
        ("an empty messages list", _body(messages=[])),
        ("an unknown role", _body(role="operator")),
        ("an input over 8192 tokens", _body(content="x" * (8192 * 4 + 4))),
        ("max_tokens 0", _body(max_tokens=0)),
        ("max_tokens 5000", _body(max_tokens=5000)),
    ]
    for what, body in bad:
        r = await _chat(ctx, m, body)
        assert r.status_code == 400, f"{what} answered {r.status_code}, expected 400"
        calls = len(ctx.grpc.calls_to("Complete"))
        assert calls == 0, f"{what} was answered 400 but the provider was called ({calls} Complete call(s) so far): validate before the paid call"
    ok = await _chat(ctx, m, _body(content="x" * 8192 * 4, max_tokens=4096))
    assert ok.status_code == 200, f"a request at the limits (8192 input tokens, max_tokens 4096) answered {ok.status_code}: {ok.text}"


async def check_deadline(ctx):
    m = _gateway(ctx)
    r = await _chat(ctx, m, _body())
    assert r.status_code == 200, f"POST /v1/chat answered {r.status_code}: {r.text}"
    call = ctx.grpc.calls_to("Complete")[-1]
    assert call.timeout is not None, "the Complete call carries no deadline: a hung provider would hold the worker forever"
    assert 7.5 <= call.timeout <= 8.5, f"the deadline must be about 8 s, got {call.timeout} s"
    ctx.grpc.set_latency("Complete", 20.0)
    slow = await _chat(ctx, m, _body())
    assert slow.status_code == 504, f"a provider slower than the deadline answered {slow.status_code}, expected 504 (DEADLINE_EXCEEDED)"
    ctx.grpc.set_latency("Complete", 0.0)
    ctx.grpc.fail("Complete", grpc.StatusCode.UNAVAILABLE, "provider restarting", times=1)
    down = await _chat(ctx, m, _body())
    assert down.status_code == 502, f"UNAVAILABLE from the provider answered {down.status_code}, expected 502"
    ctx.grpc.fail("Complete", grpc.StatusCode.RESOURCE_EXHAUSTED, "rate limited", times=1)
    limited = await _chat(ctx, m, _body())
    assert limited.status_code == 502, f"RESOURCE_EXHAUSTED from the provider answered {limited.status_code}, expected 502"
    assert len(ctx.grpc.calls_to("Complete")) == 4, f"the four requests made {len(ctx.grpc.calls_to('Complete'))} Complete calls: the gateway must not retry on the client's behalf"


async def check_usage(ctx):
    m = _gateway(ctx)
    content = "Tell me about the weather in Lisbon this week"
    r = await _chat(ctx, m, _body(content=content))
    assert r.status_code == 200, f"POST /v1/chat answered {r.status_code}: {r.text}"
    usage = r.json().get("usage")
    expected = {"input_tokens": len(content) // 4 + 11, "output_tokens": 42}
    assert usage == expected, f"usage is {usage}, expected the provider's own numbers {expected} (an estimate from text lengths disagrees with the invoice)"
    second = await _chat(ctx, m, _body(content=content))
    assert r.json()["id"] != second.json().get("id"), "two requests answered the same id: the request id must be fresh per request"


async def check_no_prompt_echo(ctx):
    m = _gateway(ctx)
    captured = io.StringIO()
    handler = logging.StreamHandler(captured)
    logging.getLogger().addHandler(handler)
    try:
        with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
            r = await _chat(ctx, m, _body(content=CANARY))
    finally:
        logging.getLogger().removeHandler(handler)
    assert r.status_code == 200, f"POST /v1/chat answered {r.status_code}: {r.text}"
    assert "CANARY-7731" not in r.text, f"the answer echoes the prompt: {r.text}"
    assert "CANARY-7731" not in captured.getvalue(), f"the prompt was printed or logged: {captured.getvalue().strip()!r}"
`,
    typescript: `const AUTH = {Authorization: 'Bearer acme'};
const CANARY = 'CANARY-7731 my account number is 4111';
const ANSWER = 'The capital of France is Paris.';

/** The model provider: a fixed answer, usage numbers a text estimate cannot reproduce. */
function gateway(ctx) {
  const pkg = ctx.proto('providers.proto');
  ctx.grpc.serve(pkg.gateway.Provider.service, {
    Complete(call, callback) {
      const chars = call.request.messages.reduce((n, m) => n + m.content.length, 0);
      callback(null, {content: ANSWER, usage: {input_tokens: Math.floor(chars / 4) + 11, output_tokens: 42}});
    },
  });
  const m = ctx.load('chat_api');
  return {m, c: ctx.client(m.app)};
}

const body = (o: {content?: string; role?: string; max_tokens?: number; messages?: unknown[]} = {}) => ({
  model: 'gpt-4o-mini',
  messages: o.messages ?? [{role: o.role ?? 'user', content: o.content ?? 'What is the capital of France?'}],
  max_tokens: o.max_tokens ?? 64,
});

export async function check_route(ctx) {
  const {c} = gateway(ctx);
  const r = await c.post('/v1/chat', {body: body(), headers: AUTH});
  assert.equal(r.status, 200, \`POST /v1/chat answered \${r.status}: \${r.text}\`);
  assert((r.headers['content-type'] ?? '').startsWith('application/json'), \`the answer must be JSON, got Content-Type \${JSON.stringify(r.headers['content-type'])}\`);
  const out = r.json();
  assert.equal(out.content, ANSWER, \`the answer's content must be the provider's completion \${JSON.stringify(ANSWER)}, got \${JSON.stringify(out.content)}\`);
  assert(typeof out.id === 'string' && out.id !== '', \`the answer carries no request id: \${r.text}\`);
  assert.equal(ctx.grpc.callsTo('Complete').length, 1, \`one chat made \${ctx.grpc.callsTo('Complete').length} Complete calls, expected one\`);
  const anonymous = await c.post('/v1/chat', {body: body()});
  assert.equal(anonymous.status, 401, \`a request without a bearer token answered \${anonymous.status}, expected 401\`);
}

export async function check_validate(ctx) {
  const {c} = gateway(ctx);
  const bad: [string, unknown][] = [
    ['an empty messages list', body({messages: []})],
    ['an unknown role', body({role: 'operator'})],
    ['an input over 8192 tokens', body({content: 'x'.repeat(8192 * 4 + 4)})],
    ['max_tokens 0', body({max_tokens: 0})],
    ['max_tokens 5000', body({max_tokens: 5000})],
  ];
  for (const [what, b] of bad) {
    const r = await c.post('/v1/chat', {body: b, headers: AUTH});
    assert.equal(r.status, 400, \`\${what} answered \${r.status}, expected 400\`);
    const calls = ctx.grpc.callsTo('Complete').length;
    assert.equal(calls, 0, \`\${what} was answered 400 but the provider was called (\${calls} Complete call(s) so far): validate before the paid call\`);
  }
  const ok = await c.post('/v1/chat', {body: body({content: 'x'.repeat(8192 * 4), max_tokens: 4096}), headers: AUTH});
  assert.equal(ok.status, 200, \`a request at the limits (8192 input tokens, max_tokens 4096) answered \${ok.status}: \${ok.text}\`);
}

export async function check_deadline(ctx) {
  const {c} = gateway(ctx);
  const r = await c.post('/v1/chat', {body: body(), headers: AUTH});
  assert.equal(r.status, 200, \`POST /v1/chat answered \${r.status}: \${r.text}\`);
  const call = ctx.grpc.callsTo('Complete').at(-1);
  assert(call.timeout !== null, 'the Complete call carries no deadline: a hung provider would hold the worker forever');
  assert(7.5 <= call.timeout && call.timeout <= 8.5, \`the deadline must be about 8 s, got \${call.timeout} s\`);
  ctx.grpc.setLatency('Complete', 20.0);
  const slow = await c.post('/v1/chat', {body: body(), headers: AUTH});
  assert.equal(slow.status, 504, \`a provider slower than the deadline answered \${slow.status}, expected 504 (DEADLINE_EXCEEDED)\`);
  ctx.grpc.setLatency('Complete', 0);
  ctx.grpc.fail('Complete', ctx.grpc.status.UNAVAILABLE, 'provider restarting', 1);
  const down = await c.post('/v1/chat', {body: body(), headers: AUTH});
  assert.equal(down.status, 502, \`UNAVAILABLE from the provider answered \${down.status}, expected 502\`);
  ctx.grpc.fail('Complete', ctx.grpc.status.RESOURCE_EXHAUSTED, 'rate limited', 1);
  const limited = await c.post('/v1/chat', {body: body(), headers: AUTH});
  assert.equal(limited.status, 502, \`RESOURCE_EXHAUSTED from the provider answered \${limited.status}, expected 502\`);
  assert.equal(ctx.grpc.callsTo('Complete').length, 4, \`the four requests made \${ctx.grpc.callsTo('Complete').length} Complete calls: the gateway must not retry on the client's behalf\`);
}

export async function check_usage(ctx) {
  const {c} = gateway(ctx);
  const content = 'Tell me about the weather in Lisbon this week';
  const r = await c.post('/v1/chat', {body: body({content}), headers: AUTH});
  assert.equal(r.status, 200, \`POST /v1/chat answered \${r.status}: \${r.text}\`);
  const expected = {input_tokens: Math.floor(content.length / 4) + 11, output_tokens: 42};
  assert.deepStrictEqual(r.json().usage, expected, \`usage is \${JSON.stringify(r.json().usage)}, expected the provider's own numbers \${JSON.stringify(expected)} (an estimate from text lengths disagrees with the invoice)\`);
  const second = await c.post('/v1/chat', {body: body({content}), headers: AUTH});
  assert.notEqual(r.json().id, second.json().id, 'two requests answered the same id: the request id must be fresh per request');
}

export async function check_no_prompt_echo(ctx) {
  const {c} = gateway(ctx);
  const logged: string[] = [];
  const prior = {log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error};
  const capture = (...args: unknown[]) => void logged.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = console.info = console.debug = console.warn = console.error = capture;
  let r;
  try {
    r = await c.post('/v1/chat', {body: body({content: CANARY}), headers: AUTH});
  } finally {
    Object.assign(console, prior);
  }
  assert.equal(r.status, 200, \`POST /v1/chat answered \${r.status}: \${r.text}\`);
  assert(!r.text.includes('CANARY-7731'), \`the answer echoes the prompt: \${r.text}\`);
  const leak = logged.find(l => l.includes('CANARY-7731'));
  assert(leak === undefined, \`the prompt was printed or logged: \${JSON.stringify(leak)}\`);
}
`,
    go: `package main

import (
	"bytes"
	"context"
	"log"
	"net/http"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"leetbuild/harness"

	pb "gateway/gen/providers"
)

const (
	chatCanary = "CANARY-7731 my account number is 4111"
	chatAnswer = "The capital of France is Paris."
)

// providerPeer is the model provider: a fixed answer, usage numbers a text estimate cannot reproduce.
type providerPeer struct {
	pb.UnimplementedProviderServer
}

func (providerPeer) Complete(_ context.Context, req *pb.CompleteRequest) (*pb.CompleteReply, error) {
	chars := 0
	for _, m := range req.GetMessages() {
		chars += len(m.GetContent())
	}
	return &pb.CompleteReply{Content: chatAnswer, Usage: &pb.Usage{InputTokens: int32(chars/4 + 11), OutputTokens: 42}}, nil
}

func chatGateway(ctx *harness.Ctx) *harness.HTTP {
	pb.RegisterProviderServer(ctx.GRPC.Server(""), &providerPeer{})
	mux := http.NewServeMux()
	register(mux)
	return ctx.HTTP(mux)
}

type chatBody struct {
	Model     string           \`json:"model"\`
	Messages  []map[string]any \`json:"messages"\`
	MaxTokens int              \`json:"max_tokens"\`
}

func chatWith(content, role string, maxTokens int) chatBody {
	return chatBody{Model: "gpt-4o-mini", Messages: []map[string]any{{"role": role, "content": content}}, MaxTokens: maxTokens}
}

func chatOK() chatBody { return chatWith("What is the capital of France?", "user", 64) }

func CheckRoute(ctx *harness.Ctx) {
	c := chatGateway(ctx)
	r := c.Post("/v1/chat", chatOK(), "Authorization", "Bearer acme")
	ctx.Equal(r.Status, 200, "POST /v1/chat (%s)", r.Text())
	ctype := r.Header.Get("Content-Type")
	ctx.Assert(strings.HasPrefix(ctype, "application/json"), "the answer must be JSON, got Content-Type %q", ctype)
	out, _ := r.JSON().(map[string]any)
	ctx.Equal(out["content"], chatAnswer, "the answer's content must be the provider's completion")
	id, _ := out["id"].(string)
	ctx.Assert(id != "", "the answer carries no request id: %s", r.Text())
	ctx.Equal(len(ctx.GRPC.CallsTo("Complete", "")), 1, "one chat must make exactly one Complete call; the calls made")
	anonymous := c.Post("/v1/chat", chatOK())
	ctx.Equal(anonymous.Status, 401, "a request without a bearer token")
}

func CheckValidate(ctx *harness.Ctx) {
	c := chatGateway(ctx)
	bad := []struct {
		what string
		body chatBody
	}{
		{"an empty messages list", chatBody{Model: "gpt-4o-mini", Messages: []map[string]any{}, MaxTokens: 64}},
		{"an unknown role", chatWith("hi", "operator", 64)},
		{"an input over 8192 tokens", chatWith(strings.Repeat("x", 8192*4+4), "user", 64)},
		{"max_tokens 0", chatWith("hi", "user", 0)},
		{"max_tokens 5000", chatWith("hi", "user", 5000)},
	}
	for _, b := range bad {
		r := c.Post("/v1/chat", b.body, "Authorization", "Bearer acme")
		ctx.Equal(r.Status, 400, "%s", b.what)
		calls := len(ctx.GRPC.CallsTo("Complete", ""))
		ctx.Assert(calls == 0, "%s was answered 400 but the provider was called (%d Complete call(s) so far): validate before the paid call", b.what, calls)
	}
	ok := c.Post("/v1/chat", chatWith(strings.Repeat("x", 8192*4), "user", 4096), "Authorization", "Bearer acme")
	ctx.Equal(ok.Status, 200, "a request at the limits (8192 input tokens, max_tokens 4096) (%s)", ok.Text())
}

func CheckDeadline(ctx *harness.Ctx) {
	c := chatGateway(ctx)
	r := c.Post("/v1/chat", chatOK(), "Authorization", "Bearer acme")
	ctx.Equal(r.Status, 200, "POST /v1/chat (%s)", r.Text())
	calls := ctx.GRPC.CallsTo("Complete", "")
	call := calls[len(calls)-1]
	ctx.Assert(call.HasDeadline(), "the Complete call carries no deadline: a hung provider would hold the worker forever")
	ctx.Assert(7500*time.Millisecond <= call.Timeout && call.Timeout <= 8500*time.Millisecond, "the deadline must be about 8 s, got %v", call.Timeout)
	ctx.GRPC.SetLatency("Complete", 20.0, "")
	slow := c.Post("/v1/chat", chatOK(), "Authorization", "Bearer acme")
	ctx.Equal(slow.Status, 504, "a provider slower than the deadline (DEADLINE_EXCEEDED)")
	ctx.GRPC.SetLatency("Complete", 0, "")
	ctx.GRPC.Fail("Complete", codes.Unavailable, "provider restarting", 1, "")
	down := c.Post("/v1/chat", chatOK(), "Authorization", "Bearer acme")
	ctx.Equal(down.Status, 502, "UNAVAILABLE from the provider")
	ctx.GRPC.Fail("Complete", codes.ResourceExhausted, "rate limited", 1, "")
	limited := c.Post("/v1/chat", chatOK(), "Authorization", "Bearer acme")
	ctx.Equal(limited.Status, 502, "RESOURCE_EXHAUSTED from the provider")
	ctx.Equal(len(ctx.GRPC.CallsTo("Complete", "")), 4, "the four requests' Complete calls (the gateway must not retry on the client's behalf)")
	_ = status.Code
}

func CheckUsage(ctx *harness.Ctx) {
	c := chatGateway(ctx)
	content := "Tell me about the weather in Lisbon this week"
	r := c.Post("/v1/chat", chatWith(content, "user", 64), "Authorization", "Bearer acme")
	ctx.Equal(r.Status, 200, "POST /v1/chat (%s)", r.Text())
	out, _ := r.JSON().(map[string]any)
	ctx.Equal(out["usage"], map[string]any{"input_tokens": float64(len(content)/4 + 11), "output_tokens": float64(42)}, "usage must be the provider's own numbers (an estimate from text lengths disagrees with the invoice)")
	second, _ := c.Post("/v1/chat", chatWith(content, "user", 64), "Authorization", "Bearer acme").JSON().(map[string]any)
	ctx.Assert(out["id"] != second["id"], "two requests answered the same id: the request id must be fresh per request")
}

func CheckNoPromptEcho(ctx *harness.Ctx) {
	c := chatGateway(ctx)
	var logged bytes.Buffer
	log.SetOutput(&logged)
	r := c.Post("/v1/chat", chatWith(chatCanary, "user", 64), "Authorization", "Bearer acme")
	ctx.Equal(r.Status, 200, "POST /v1/chat (%s)", r.Text())
	ctx.Assert(!strings.Contains(r.Text(), "CANARY-7731"), "the answer echoes the prompt: %s", r.Text())
	ctx.Assert(!strings.Contains(logged.String(), "CANARY-7731"), "the prompt was printed or logged: %q", strings.TrimSpace(logged.String()))
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <iostream>
#include <sstream>
#include <string>

namespace {

const std::string kChatCanary = "CANARY-7731 my account number is 4111";
const std::string kChatAnswer = "The capital of France is Paris.";

// The model provider: a fixed answer, usage numbers a text estimate cannot reproduce.
class ProviderPeer final : public gateway::Provider::Service {
 public:
  grpc::Status Complete(grpc::ServerContext*, const gateway::CompleteRequest* req, gateway::CompleteReply* reply) override {
    size_t chars = 0;
    for (const auto& m : req->messages()) chars += m.content().size();
    reply->set_content(kChatAnswer);
    reply->mutable_usage()->set_input_tokens(static_cast<int32_t>(chars / 4 + 11));
    reply->mutable_usage()->set_output_tokens(42);
    return grpc::Status::OK;
  }
};

struct ChatGateway {
  ProviderPeer peer;
  httplib::Server svr;
};

harness::HTTP chatGateway(harness::Ctx& ctx) {
  static ChatGateway* g = nullptr;
  delete g;
  g = new ChatGateway;
  ctx.GRPC.Server("")->RegisterService(&g->peer);
  register_routes(g->svr);
  return ctx.HTTP(g->svr);
}

std::string chatWith(const std::string& content, const std::string& role = "user", int max_tokens = 64) {
  nlohmann::json b;
  b["model"] = "gpt-4o-mini";
  b["messages"] = nlohmann::json::array({{{"role", role}, {"content", content}}});
  b["max_tokens"] = max_tokens;
  return b.dump();
}

std::string chatOK() { return chatWith("What is the capital of France?"); }

}  // namespace

void CheckRoute(harness::Ctx& ctx) {
  auto c = chatGateway(ctx);
  auto r = c.Post("/v1/chat", chatOK(), "Authorization", "Bearer acme");
  ctx.Equal(r.Status, 200, "POST /v1/chat (%s)", r.Text());
  const std::string ctype = r.HeaderValue("Content-Type");
  ctx.Assert(ctype.rfind("application/json", 0) == 0, "the answer must be JSON, got Content-Type %q", ctype);
  const auto out = nlohmann::json::parse(r.Text());
  ctx.Equal(out.value("content", ""), kChatAnswer, "the answer's content must be the provider's completion");
  ctx.Assert(!out.value("id", "").empty(), "the answer carries no request id: %s", r.Text());
  ctx.Equal(ctx.GRPC.CallsTo("Complete").size(), 1, "one chat must make exactly one Complete call; the calls made");
  auto anonymous = c.Post("/v1/chat", chatOK());
  ctx.Equal(anonymous.Status, 401, "a request without a bearer token");
}

void CheckValidate(harness::Ctx& ctx) {
  auto c = chatGateway(ctx);
  nlohmann::json empty;
  empty["model"] = "gpt-4o-mini";
  empty["messages"] = nlohmann::json::array();
  empty["max_tokens"] = 64;
  const std::vector<std::pair<std::string, std::string>> bad = {
      {"an empty messages list", empty.dump()},
      {"an unknown role", chatWith("hi", "operator")},
      {"an input over 8192 tokens", chatWith(std::string(8192 * 4 + 4, 'x'))},
      {"max_tokens 0", chatWith("hi", "user", 0)},
      {"max_tokens 5000", chatWith("hi", "user", 5000)},
  };
  for (const auto& [what, body] : bad) {
    auto r = c.Post("/v1/chat", body, "Authorization", "Bearer acme");
    ctx.Equal(r.Status, 400, "%s", what);
    const size_t calls = ctx.GRPC.CallsTo("Complete").size();
    ctx.Assert(calls == 0, "%s was answered 400 but the provider was called (%d Complete call(s) so far): validate before the paid call", what, calls);
  }
  auto ok = c.Post("/v1/chat", chatWith(std::string(8192 * 4, 'x'), "user", 4096), "Authorization", "Bearer acme");
  ctx.Equal(ok.Status, 200, "a request at the limits (8192 input tokens, max_tokens 4096) (%s)", ok.Text());
}

void CheckDeadline(harness::Ctx& ctx) {
  auto c = chatGateway(ctx);
  auto r = c.Post("/v1/chat", chatOK(), "Authorization", "Bearer acme");
  ctx.Equal(r.Status, 200, "POST /v1/chat (%s)", r.Text());
  const auto calls = ctx.GRPC.CallsTo("Complete");
  const auto& call = calls.back();
  ctx.Assert(call.HasDeadline(), "the Complete call carries no deadline: a hung provider would hold the worker forever");
  ctx.Assert(7.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 8.5, "the deadline must be about 8 s, got %vs", call.TimeoutSeconds());
  ctx.GRPC.SetLatency("Complete", 20.0);
  auto slow = c.Post("/v1/chat", chatOK(), "Authorization", "Bearer acme");
  ctx.Equal(slow.Status, 504, "a provider slower than the deadline (DEADLINE_EXCEEDED)");
  ctx.GRPC.SetLatency("Complete", 0.0);
  ctx.GRPC.Fail("Complete", grpc::StatusCode::UNAVAILABLE, "provider restarting", 1);
  auto down = c.Post("/v1/chat", chatOK(), "Authorization", "Bearer acme");
  ctx.Equal(down.Status, 502, "UNAVAILABLE from the provider");
  ctx.GRPC.Fail("Complete", grpc::StatusCode::RESOURCE_EXHAUSTED, "rate limited", 1);
  auto limited = c.Post("/v1/chat", chatOK(), "Authorization", "Bearer acme");
  ctx.Equal(limited.Status, 502, "RESOURCE_EXHAUSTED from the provider");
  ctx.Equal(ctx.GRPC.CallsTo("Complete").size(), 4, "the four requests' Complete calls (the gateway must not retry on the client's behalf)");
}

void CheckUsage(harness::Ctx& ctx) {
  auto c = chatGateway(ctx);
  const std::string content = "Tell me about the weather in Lisbon this week";
  auto r = c.Post("/v1/chat", chatWith(content), "Authorization", "Bearer acme");
  ctx.Equal(r.Status, 200, "POST /v1/chat (%s)", r.Text());
  const auto out = nlohmann::json::parse(r.Text());
  nlohmann::json expected = {{"input_tokens", static_cast<int>(content.size() / 4 + 11)}, {"output_tokens", 42}};
  ctx.Equal(out.value("usage", nlohmann::json()), expected, "usage must be the provider's own numbers (an estimate from text lengths disagrees with the invoice)");
  const auto second = nlohmann::json::parse(c.Post("/v1/chat", chatWith(content), "Authorization", "Bearer acme").Text());
  ctx.Assert(out.value("id", "") != second.value("id", ""), "two requests answered the same id: the request id must be fresh per request");
}

void CheckNoPromptEcho(harness::Ctx& ctx) {
  auto c = chatGateway(ctx);
  std::ostringstream logged;
  auto* out = std::cout.rdbuf(logged.rdbuf());
  auto* err = std::cerr.rdbuf(logged.rdbuf());
  auto r = c.Post("/v1/chat", chatWith(kChatCanary), "Authorization", "Bearer acme");
  std::cout.rdbuf(out);
  std::cerr.rdbuf(err);
  ctx.Equal(r.Status, 200, "POST /v1/chat (%s)", r.Text());
  ctx.Assert(r.Text().find("CANARY-7731") == std::string::npos, "the answer echoes the prompt: %s", r.Text());
  ctx.Assert(logged.str().find("CANARY-7731") == std::string::npos, "the prompt was printed or logged: %q", logged.str());
}
`,
  },
  debrief: `The order of the handler is the fix: everything that can reject a request runs before the one line that costs money, and the deadline sits on that line because nothing outside the call can end it. The 504/502 split is for the client: a 504 is safe to retry with backoff, a 502 says the provider refused and a retry is a guess. Taking \`usage\` from the reply makes the gateway's answer and the provider's invoice the same number by construction. Production gateways add what this step leaves out: the provider's own tokeniser instead of the four-characters rule, a request-id header the client can quote back, and audit logs that record ids and counts with the message content redacted at the source.`,
};
