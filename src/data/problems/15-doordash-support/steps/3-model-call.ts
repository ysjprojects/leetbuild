import type {Step} from '@/lib/types';

export const modelCallStep: Step = {
  id: 'model-call',
  title: 'Call the model with a deadline, one retry and a smaller fallback',
  concept: 'grpc',
  file: 'generate',
  focus: ['llm'],
  task: `## Task

\`generate\` is the one place the assistant talks to a model. The model server speaks \`Llm.Generate\`
(\`support.proto\`); the checks serve it as a deterministic stand-in at two addresses, \`config.LLM_LARGE\`
and \`config.LLM_SMALL\`:

\`\`\`proto
service Llm { rpc Generate(GenerateRequest) returns (GenerateReply); }
message GenerateRequest { string model = 1; string prompt = 2; int32 max_tokens = 3; }
message GenerateReply   { string text = 1; int32 tokens = 2; string model = 3; }
\`\`\`

Implement \`generate(question, chunks, history)\`:

- The prompt is \`assistant.prompt.build_prompt\` / \`buildPrompt(question, chunks, history)\` — the one
  prompt format. The model reads the chunks off its \`[kb:<id>] <text>\` lines; a prompt of your own
  gets an answer with no citations.
- \`Generate(model="large", prompt, max_tokens=MAX_TOKENS)\` on \`LLM_LARGE\`, with a **deadline of
  \`DEADLINE_S\`** (2 s) on the call itself. \`MAX_TOKENS\` is the hard cap on the reply.
- \`UNAVAILABLE\` or \`DEADLINE_EXCEEDED\` → wait **0.2 s** and try the large model **once more**. A second
  transient failure → the same prompt to \`LLM_SMALL\` with \`model="small"\`. Any other status
  propagates: an \`INVALID_ARGUMENT\` will fail the same way twice.
- Return \`{answer: reply.text, model: reply.model, tokens: reply.tokens}\` — the guardrail (next step)
  reports which model answered.
- Never more than **three** model calls per \`generate\`: two to the large model, one to the small one.

:::widget deadline-retry {"base": 200, "deadline": 2000, "attempts": 2}

> A Dasher at a closed restaurant does not care which model answered. A 2 s budget, one retry and a
> smaller model turn "the large model is slow tonight" into an answer instead of a spinner.`,
  sequence: {
    participants: ['assistant', 'llm-large', 'llm-small'],
    messages: [
      {
        from: 'assistant',
        to: 'llm-large',
        label: 'Generate(large, prompt, max_tokens 120) · deadline 2 s',
        kind: 'sync',
      },
      {from: 'llm-large', to: 'assistant', label: 'status UNAVAILABLE', kind: 'reply'},
      {from: 'assistant', to: 'llm-large', label: 'Generate(large, …) · after 200 ms · deadline 2 s', kind: 'sync'},
      {from: 'llm-large', to: 'assistant', label: 'status DEADLINE_EXCEEDED', kind: 'reply'},
      {
        from: 'assistant',
        to: 'llm-small',
        label: 'Generate(small, prompt, max_tokens 120) · deadline 2 s',
        kind: 'sync',
      },
      {from: 'llm-small', to: 'assistant', label: 'GenerateReply{text, tokens, model: small}', kind: 'reply'},
    ],
  },
  hints: [
    'Build the prompt once with `build_prompt` / `buildPrompt`: both attempts and the fallback send the same text. The deadline goes on the call (`timeout=` in Python, `{deadline: Date.now() + …}` in TypeScript), never a sleep around it.',
    'Catch the RPC error and read its status code: `UNAVAILABLE` or `DEADLINE_EXCEEDED` on the first attempt → sleep 0.2 s and call the large model again; any other code → re-raise. The small model is reached only after the second transient failure.',
    'A `for attempt in range(2)` over the large model with the status check inside, then one unconditional call to the small model: three calls at most, and the same `{answer, model, tokens}` from either stub.',
  ],
  checks: [
    {
      id: 'prompt',
      title: 'Sends the one prompt to the large model',
      detail:
        'The request to `LLM_LARGE` carries `model="large"` and the prompt from `build_prompt` / `buildPrompt`: every retrieved chunk as a `[kb:<id>] <text>` line, the history turns, the question. The answer, model and token count come from the reply.',
      match: {
        python: {all: [/build_prompt\(/, /"large"/]},
        typescript: {all: [/buildPrompt\(/, /'large'/]},
        go: {all: [/prompt\.Build\(/, /"large"/]},
        scala: {all: [/Prompt\.build\(/, /"large"/]},
        cpp: {all: [/build_prompt\(/, /"large"/]},
      },
    },
    {
      id: 'deadline',
      title: 'Every model call carries a deadline',
      detail:
        'Each `Generate` is sent with a deadline of `DEADLINE_S` (2 s). A large model that takes 3 s is abandoned at 2 s — the Dasher waits for the budget, never for the model.',
      match: {
        python: {all: [/timeout\s*=\s*(config\.)?DEADLINE_S/]},
        typescript: {all: [/deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_S/]},
        go: {all: [/context\.WithTimeout\(/, /DeadlineS/]},
        scala: {all: [/withDeadlineAfter\(/, /DeadlineS/]},
        cpp: {all: [/set_deadline\(/, /kDeadline\b/]},
      },
    },
    {
      id: 'retry-transient',
      title: 'Retries once on UNAVAILABLE or DEADLINE_EXCEEDED',
      detail:
        'Only the transient statuses earn a second attempt, after a 0.2 s backoff and against the large model; the attempts are bounded (two), and any other status propagates without a retry.',
      match: {
        python: {
          all: [
            /StatusCode\.UNAVAILABLE/,
            /StatusCode\.DEADLINE_EXCEEDED/,
            /asyncio\.sleep\(|time\.sleep\(/,
            /for \w+ in range\(\s*2\s*\)/,
          ],
          none: [/while True/],
        },
        typescript: {
          all: [
            /status\.UNAVAILABLE/,
            /status\.DEADLINE_EXCEEDED/,
            /\bsleep\(|setTimeout\(/,
            /for \(let \w+ = 0; \w+ < 2; (\+\+\w+|\w+\+\+)\)/,
          ],
          none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
        },
        go: {
          all: [/codes\.Unavailable/, /codes\.DeadlineExceeded/, /time\.Sleep\(/, /for \w+ := 0; \w+ < 2; \w+\+\+/],
          none: [/for \{/],
        },
        scala: {
          all: [/Code\.UNAVAILABLE/, /Code\.DEADLINE_EXCEEDED/, /Thread\.sleep\(/, /\w+ < 2\b/],
          none: [/while\s*\(\s*true\s*\)/],
        },
        cpp: {
          all: [
            /StatusCode::UNAVAILABLE/,
            /StatusCode::DEADLINE_EXCEEDED/,
            /sleep_for\(/,
            /for \(int \w+ = 0; \w+ < 2; (\+\+\w+|\w+\+\+)\)/,
          ],
          none: [/while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/],
        },
      },
    },
    {
      id: 'fallback-small',
      title: 'Falls back to the small model',
      detail:
        'When the large model fails twice, the same prompt goes once to `LLM_SMALL` with `model="small"`; the large model down means exactly two calls to it, one to the small one, and never more than three in total.',
      match: {
        python: {all: [/LLM_SMALL/, /"small"/]},
        typescript: {all: [/LLM_SMALL/, /'small'/]},
        go: {all: [/LLMSmall/, /"small"/]},
        scala: {all: [/LlmSmall/, /"small"/]},
        cpp: {all: [/kLlmSmall/, /"small"/]},
      },
    },
    {
      id: 'max-tokens',
      title: 'Caps the reply at MAX_TOKENS',
      detail:
        'The request carries `max_tokens = MAX_TOKENS`: a model that rambles is cut at 120 tokens by the server and the result reports that count.',
      match: {
        python: {all: [/max_tokens\s*=\s*(config\.)?MAX_TOKENS/]},
        typescript: {all: [/max_tokens:\s*MAX_TOKENS/]},
        go: {all: [/MaxTokens:\s*config\.MaxTokens/]},
        scala: {all: [/maxTokens\s*=\s*Config\.MaxTokens/]},
        cpp: {all: [/set_max_tokens\(assistant::kMaxTokens\)/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import asyncio

import grpc

import support_pb2
import support_pb2_grpc
from assistant import config
from assistant.prompt import build_prompt

BACKOFF_S = 0.2
TRANSIENT = ()  # TODO: the status codes worth one retry

large = support_pb2_grpc.LlmStub(grpc.aio.insecure_channel(config.LLM_LARGE))
small = support_pb2_grpc.LlmStub(grpc.aio.insecure_channel(config.LLM_SMALL))


async def _ask(stub, model: str, prompt: str) -> dict:
    """One Generate call: {answer, model, tokens} from the reply."""
    # TODO: GenerateRequest(model, prompt, max_tokens from config) with a deadline of config.DEADLINE_S
    raise NotImplementedError


async def generate(question: str, chunks: list[dict], history: list[dict] | None = None) -> dict:
    """Answer the question from the chunks and the conversation: {answer, model, tokens}."""
    # TODO: the prompt from build_prompt
    # TODO: two attempts on the large model; a transient failure sleeps BACKOFF_S before the second
    # TODO: still failing → the same prompt to the small model; anything else → raise
    raise NotImplementedError
`,
      solution: `import asyncio

import grpc

import support_pb2
import support_pb2_grpc
from assistant import config
from assistant.prompt import build_prompt

BACKOFF_S = 0.2
TRANSIENT = (grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED)

large = support_pb2_grpc.LlmStub(grpc.aio.insecure_channel(config.LLM_LARGE))
small = support_pb2_grpc.LlmStub(grpc.aio.insecure_channel(config.LLM_SMALL))


async def _ask(stub, model: str, prompt: str) -> dict:
    """One Generate call: {answer, model, tokens} from the reply."""
    request = support_pb2.GenerateRequest(model=model, prompt=prompt, max_tokens=config.MAX_TOKENS)
    reply = await stub.Generate(request, timeout=config.DEADLINE_S)
    return {"answer": reply.text, "model": reply.model, "tokens": reply.tokens}


async def generate(question: str, chunks: list[dict], history: list[dict] | None = None) -> dict:
    """Answer the question from the chunks and the conversation: {answer, model, tokens}."""
    prompt = build_prompt(question, chunks, history or [])
    for attempt in range(2):
        try:
            return await _ask(large, "large", prompt)
        except grpc.RpcError as e:
            if e.code() not in TRANSIENT:
                raise
            if attempt == 0:
                await asyncio.sleep(BACKOFF_S)
    return await _ask(small, "small", prompt)
`,
    },
    typescript: {
      starter: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {DEADLINE_S, LLM_LARGE, LLM_SMALL, MAX_TOKENS} from 'assistant/config';
import {buildPrompt} from 'assistant/prompt';
import type {Chunk, Turn} from 'assistant/prompt';

export const BACKOFF_MS = 200;
const TRANSIENT: number[] = []; // TODO: the status codes worth one retry

interface GenerateRequest {
  model: string;
  prompt: string;
  max_tokens: number;
}
interface GenerateReply {
  text: string;
  tokens: number;
  model: string;
}
interface LlmClient {
  Generate(request: GenerateRequest, options: {deadline: number}): Promise<GenerateReply>;
}

const {support} = grpc.loadPackageDefinition(protoLoader.loadSync('support.proto')) as unknown as {
  support: {Llm: new (target: string, credentials: grpc.ChannelCredentials) => LlmClient};
};
const large = new support.Llm(LLM_LARGE, grpc.credentials.createInsecure());
const small = new support.Llm(LLM_SMALL, grpc.credentials.createInsecure());

export interface Generated {
  answer: string;
  model: string;
  tokens: number;
}

/** One Generate call: {answer, model, tokens} from the reply. */
async function ask(client: LlmClient, model: string, prompt: string): Promise<Generated> {
  // TODO: client.Generate({model, prompt, max_tokens from config}) with a deadline DEADLINE_S from now
  throw new Error('not implemented');
}

/** Answer the question from the chunks and the conversation: {answer, model, tokens}. */
export async function generate(question: string, chunks: Chunk[], history: Turn[] = []): Promise<Generated> {
  // TODO: the prompt from buildPrompt
  // TODO: two attempts on the large model; a transient failure sleeps BACKOFF_MS before the second
  // TODO: still failing → the same prompt to the small model; anything else → throw
  throw new Error('not implemented');
}
`,
      solution: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {DEADLINE_S, LLM_LARGE, LLM_SMALL, MAX_TOKENS} from 'assistant/config';
import {buildPrompt} from 'assistant/prompt';
import type {Chunk, Turn} from 'assistant/prompt';

export const BACKOFF_MS = 200;
const TRANSIENT = [grpc.status.UNAVAILABLE, grpc.status.DEADLINE_EXCEEDED];

interface GenerateRequest {
  model: string;
  prompt: string;
  max_tokens: number;
}
interface GenerateReply {
  text: string;
  tokens: number;
  model: string;
}
interface LlmClient {
  Generate(request: GenerateRequest, options: {deadline: number}): Promise<GenerateReply>;
}

const {support} = grpc.loadPackageDefinition(protoLoader.loadSync('support.proto')) as unknown as {
  support: {Llm: new (target: string, credentials: grpc.ChannelCredentials) => LlmClient};
};
const large = new support.Llm(LLM_LARGE, grpc.credentials.createInsecure());
const small = new support.Llm(LLM_SMALL, grpc.credentials.createInsecure());

export interface Generated {
  answer: string;
  model: string;
  tokens: number;
}

/** One Generate call: {answer, model, tokens} from the reply. */
async function ask(client: LlmClient, model: string, prompt: string): Promise<Generated> {
  const reply = await client.Generate({model, prompt, max_tokens: MAX_TOKENS}, {deadline: Date.now() + DEADLINE_S * 1000});
  return {answer: reply.text, model: reply.model, tokens: reply.tokens};
}

/** Answer the question from the chunks and the conversation: {answer, model, tokens}. */
export async function generate(question: string, chunks: Chunk[], history: Turn[] = []): Promise<Generated> {
  const prompt = buildPrompt(question, chunks, history);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await ask(large, 'large', prompt);
    } catch (e) {
      if (!TRANSIENT.includes((e as grpc.ServiceError).code)) throw e;
      if (attempt === 0) await sleep(BACKOFF_MS);
    }
  }
  return ask(small, 'small', prompt);
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"assistant/config" // config.LLMLarge, config.LLMSmall, config.MaxTokens, config.DeadlineS — provided
	"assistant/prompt" // prompt.Build(question, chunks, history), prompt.Chunk, prompt.Turn — provided
	pb "assistant/gen/support"
)

const backoff = 200 * time.Millisecond

// Generated is what the guardrail and the API see: the answer and which model gave it.
type Generated struct {
	Answer string
	Model  string
	Tokens int32
}

func dial(target string) pb.LlmClient {
	conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		panic(err)
	}
	return pb.NewLlmClient(conn)
}

var large = dial(config.LLMLarge)
var small = dial(config.LLMSmall)

// ask makes one Generate call and shapes the reply.
func ask(ctx context.Context, client pb.LlmClient, model, text string) (*Generated, error) {
	// TODO: GenerateRequest{model, text, config.MaxTokens} with a context that expires after config.DeadlineS
	_ = client
	return nil, errors.New("not implemented")
}

// transient reports whether the status is worth one retry.
func transient(err error) bool {
	// TODO: codes.Unavailable or codes.DeadlineExceeded
	_ = status.Code
	_ = codes.OK
	return false
}

func generate(ctx context.Context, question string, chunks []prompt.Chunk, history []prompt.Turn) (*Generated, error) {
	// TODO: the prompt from prompt.Build
	// TODO: two attempts on the large model; a transient failure sleeps backoff before the second
	// TODO: still failing → the same prompt to the small model; anything else → return the error
	return nil, errors.New("not implemented")
}
`,
      solution: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"assistant/config" // config.LLMLarge, config.LLMSmall, config.MaxTokens, config.DeadlineS — provided
	"assistant/prompt" // prompt.Build(question, chunks, history), prompt.Chunk, prompt.Turn — provided
	pb "assistant/gen/support"
)

const backoff = 200 * time.Millisecond

// Generated is what the guardrail and the API see: the answer and which model gave it.
type Generated struct {
	Answer string
	Model  string
	Tokens int32
}

func dial(target string) pb.LlmClient {
	conn, err := grpc.NewClient(target, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		panic(err)
	}
	return pb.NewLlmClient(conn)
}

var large = dial(config.LLMLarge)
var small = dial(config.LLMSmall)

// ask makes one Generate call and shapes the reply.
func ask(ctx context.Context, client pb.LlmClient, model, text string) (*Generated, error) {
	callCtx, cancel := context.WithTimeout(ctx, time.Duration(config.DeadlineS*float64(time.Second)))
	defer cancel()
	reply, err := client.Generate(callCtx, &pb.GenerateRequest{Model: model, Prompt: text, MaxTokens: config.MaxTokens})
	if err != nil {
		return nil, err
	}
	return &Generated{Answer: reply.GetText(), Model: reply.GetModel(), Tokens: reply.GetTokens()}, nil
}

// transient reports whether the status is worth one retry.
func transient(err error) bool {
	switch status.Code(err) {
	case codes.Unavailable, codes.DeadlineExceeded:
		return true
	}
	return false
}

func generate(ctx context.Context, question string, chunks []prompt.Chunk, history []prompt.Turn) (*Generated, error) {
	text := prompt.Build(question, chunks, history)
	for attempt := 0; attempt < 2; attempt++ {
		out, err := ask(ctx, large, "large", text)
		if err == nil {
			return out, nil
		}
		if !transient(err) {
			return nil, err
		}
		if attempt == 0 {
			time.Sleep(backoff)
		}
	}
	return ask(ctx, small, "small", text)
}
`,
    },
    scala: {
      starter: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import assistant.Config // Config.LlmLarge, Config.LlmSmall, Config.MaxTokens, Config.DeadlineS — provided
import assistant.Prompt // Prompt.build(question, chunks, history), Prompt.Chunk, Prompt.Turn — provided
import support.support.{GenerateRequest, LlmGrpc}

/** What the guardrail and the API see: the answer and which model gave it. */
final case class Generated(answer: String, model: String, tokens: Int)

object Generate {
  val BackoffMillis = 200L
  private val Transient: Set[Status.Code] = Set() // TODO: the status codes worth one retry

  private def stub(target: String): LlmGrpc.LlmBlockingStub = {
    val Array(host, port) = target.split(":")
    LlmGrpc.blockingStub(ManagedChannelBuilder.forAddress(host, port.toInt).usePlaintext().build())
  }
  private val large = stub(Config.LlmLarge)
  private val small = stub(Config.LlmSmall)

  /** One Generate call, shaped. */
  private def ask(stub: LlmGrpc.LlmBlockingStub, model: String, prompt: String): Generated = {
    // TODO: GenerateRequest(model, prompt, Config.MaxTokens) with a deadline of Config.DeadlineS
    throw new NotImplementedError
  }

  def generate(question: String, chunks: Seq[Prompt.Chunk], history: Seq[Prompt.Turn]): Generated = {
    // TODO: the prompt from Prompt.build
    // TODO: two attempts on the large model; a transient failure sleeps BackoffMillis before the second
    // TODO: still failing → the same prompt to the small model; anything else → rethrow
    throw new NotImplementedError
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import assistant.Config // Config.LlmLarge, Config.LlmSmall, Config.MaxTokens, Config.DeadlineS — provided
import assistant.Prompt // Prompt.build(question, chunks, history), Prompt.Chunk, Prompt.Turn — provided
import support.support.{GenerateRequest, LlmGrpc}

/** What the guardrail and the API see: the answer and which model gave it. */
final case class Generated(answer: String, model: String, tokens: Int)

object Generate {
  val BackoffMillis = 200L
  private val Transient: Set[Status.Code] = Set(Status.Code.UNAVAILABLE, Status.Code.DEADLINE_EXCEEDED)

  private def stub(target: String): LlmGrpc.LlmBlockingStub = {
    val Array(host, port) = target.split(":")
    LlmGrpc.blockingStub(ManagedChannelBuilder.forAddress(host, port.toInt).usePlaintext().build())
  }
  private val large = stub(Config.LlmLarge)
  private val small = stub(Config.LlmSmall)

  /** One Generate call, shaped. */
  private def ask(stub: LlmGrpc.LlmBlockingStub, model: String, prompt: String): Generated = {
    val reply = stub
      .withDeadlineAfter((Config.DeadlineS * 1000).toLong, TimeUnit.MILLISECONDS)
      .generate(GenerateRequest(model = model, prompt = prompt, maxTokens = Config.MaxTokens))
    Generated(reply.text, reply.model, reply.tokens)
  }

  def generate(question: String, chunks: Seq[Prompt.Chunk], history: Seq[Prompt.Turn]): Generated = {
    val prompt = Prompt.build(question, chunks, history)
    var attempt = 0
    while (attempt < 2) {
      try return ask(large, "large", prompt)
      catch {
        case e: StatusRuntimeException if Transient(e.getStatus.getCode) =>
          if (attempt == 0) Thread.sleep(BackoffMillis)
      }
      attempt += 1
    }
    ask(small, "small", prompt)
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "assistant/config.h"  // assistant::kLlmLarge, kLlmSmall, kMaxTokens, kDeadline — provided
#include "assistant/prompt.h"  // assistant::build_prompt(question, chunks, history), Chunk, Turn — provided
#include "support.grpc.pb.h"

constexpr std::chrono::milliseconds kBackoff{200};

// What the guardrail and the API see: the answer and which model gave it.
struct Generated {
  std::string answer;
  std::string model;
  int tokens;
};

auto large = support::Llm::NewStub(grpc::CreateChannel(assistant::kLlmLarge, grpc::InsecureChannelCredentials()));
auto small = support::Llm::NewStub(grpc::CreateChannel(assistant::kLlmSmall, grpc::InsecureChannelCredentials()));

// One Generate call: fills \`out\` on success, returns the status either way.
grpc::Status ask(support::Llm::Stub& stub, const std::string& model, const std::string& prompt, Generated& out) {
  // TODO: GenerateRequest{model, prompt, assistant::kMaxTokens} on a ClientContext whose deadline is now + assistant::kDeadline
  return grpc::Status(grpc::StatusCode::UNIMPLEMENTED, "not implemented");
}

// Whether the status is worth one retry.
bool transient(const grpc::Status& status) {
  // TODO: UNAVAILABLE or DEADLINE_EXCEEDED
  return false;
}

Generated generate(const std::string& question, const std::vector<assistant::Chunk>& chunks,
                   const std::vector<assistant::Turn>& history) {
  // TODO: the prompt from assistant::build_prompt
  // TODO: two attempts on the large model; a transient failure sleeps kBackoff before the second
  // TODO: still failing → the same prompt to the small model; anything else → throw
  throw std::runtime_error("not implemented");
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "assistant/config.h"  // assistant::kLlmLarge, kLlmSmall, kMaxTokens, kDeadline — provided
#include "assistant/prompt.h"  // assistant::build_prompt(question, chunks, history), Chunk, Turn — provided
#include "support.grpc.pb.h"

constexpr std::chrono::milliseconds kBackoff{200};

// What the guardrail and the API see: the answer and which model gave it.
struct Generated {
  std::string answer;
  std::string model;
  int tokens;
};

auto large = support::Llm::NewStub(grpc::CreateChannel(assistant::kLlmLarge, grpc::InsecureChannelCredentials()));
auto small = support::Llm::NewStub(grpc::CreateChannel(assistant::kLlmSmall, grpc::InsecureChannelCredentials()));

// One Generate call: fills \`out\` on success, returns the status either way.
grpc::Status ask(support::Llm::Stub& stub, const std::string& model, const std::string& prompt, Generated& out) {
  support::GenerateRequest request;
  request.set_model(model);
  request.set_prompt(prompt);
  request.set_max_tokens(assistant::kMaxTokens);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + assistant::kDeadline);
  support::GenerateReply reply;
  const grpc::Status status = stub.Generate(&ctx, request, &reply);
  if (status.ok()) out = Generated{reply.text(), reply.model(), reply.tokens()};
  return status;
}

// Whether the status is worth one retry.
bool transient(const grpc::Status& status) {
  return status.error_code() == grpc::StatusCode::UNAVAILABLE ||
         status.error_code() == grpc::StatusCode::DEADLINE_EXCEEDED;
}

Generated generate(const std::string& question, const std::vector<assistant::Chunk>& chunks,
                   const std::vector<assistant::Turn>& history) {
  const std::string prompt = assistant::build_prompt(question, chunks, history);
  Generated out;
  for (int attempt = 0; attempt < 2; ++attempt) {
    const grpc::Status status = ask(*large, "large", prompt, out);
    if (status.ok()) return out;
    if (!transient(status)) throw std::runtime_error("llm: " + status.error_message());
    if (attempt == 0) std::this_thread::sleep_for(kBackoff);
  }
  const grpc::Status status = ask(*small, "small", prompt, out);
  if (!status.ok()) throw std::runtime_error("llm: " + status.error_message());
  return out;
}
`,
    },
  },
  harness: {
    python: `import inspect

import grpc

import support_pb2
import support_pb2_grpc
from assistant import config, model, prompt

QUESTION = "My payout has not arrived, when is it paid?"
CHUNKS = [
    {"id": "pay-0", "text": "Dasher earnings for a week are paid out every Monday by direct deposit and usually arrive within two to three business days, depending on the bank.", "score": 0.71},
    {"id": "tips-0", "text": "Tips are included in the weekly payout and in Fast Pay.", "score": 0.52},
    {"id": "undeliverable-0", "text": "If the timer runs out, the app allows the order to be marked as undeliverable and the Dasher is still paid in full for the delivery.", "score": 0.33},
]
HISTORY = [
    {"role": "dasher", "text": "Hi, I dashed all of last week."},
    {"role": "assistant", "text": "Hello! What can I help you with about last week's dashes?"},
]
PROMPT = prompt.build_prompt(QUESTION, CHUNKS, HISTORY)
EXPECTED = model.complete(PROMPT, config.MAX_TOKENS)


class LlmServicer(support_pb2_grpc.LlmServicer):
    """The stand-in model server: answers from assistant.model in the harness's mode."""

    def __init__(self, mode="faithful"):
        self.mode = mode

    def Generate(self, request, context):
        text = model.complete(request.prompt, request.max_tokens, self.mode)
        return support_pb2.GenerateReply(text=text, tokens=len(text.split()), model=request.model)


def _serve(ctx, mode="faithful"):
    ctx.grpc.serve(support_pb2_grpc.add_LlmServicer_to_server, LlmServicer(mode), config.LLM_LARGE)
    ctx.grpc.serve(support_pb2_grpc.add_LlmServicer_to_server, LlmServicer(mode), config.LLM_SMALL)
    return ctx.load("generate")


async def _generate(m):
    result = m.generate(QUESTION, CHUNKS, HISTORY)
    if inspect.isawaitable(result):
        result = await result
    assert isinstance(result, dict), f"generate must return a dict {{answer, model, tokens}}, got {type(result).__name__}"
    for key in ("answer", "model", "tokens"):
        assert key in result, f"generate's result has no {key!r}: {result}"
    return result


async def _failure(m, what):
    """The gRPC status code generate surfaced, or an assertion when it returned."""
    try:
        result = await _generate(m)
    except grpc.RpcError as e:
        return e.code()
    raise AssertionError(f"{what} must raise, generate returned {result}")


def _large(ctx):
    return ctx.grpc.calls_to("Generate", config.LLM_LARGE)


def _small(ctx):
    return ctx.grpc.calls_to("Generate", config.LLM_SMALL)


async def check_prompt(ctx):
    m = _serve(ctx)
    result = await _generate(m)
    calls = _large(ctx)
    assert len(calls) == 1, f"a healthy large model must be called exactly once, saw {len(calls)} calls to {config.LLM_LARGE}"
    assert not _small(ctx), "the small model must not be called while the large one answers"
    request = calls[0].request
    assert request.model == "large", f"the request to {config.LLM_LARGE} must say model='large', got {request.model!r}"
    for c in CHUNKS:
        assert f"[kb:{c['id']}] {c['text']}" in request.prompt, f"the prompt has no '[kb:{c['id']}] <text>' line for a retrieved chunk; use assistant.prompt.build_prompt"
    for turn in HISTORY:
        assert f"{turn['role']}: {turn['text']}" in request.prompt, f"the prompt is missing the history turn {turn['role']}: {turn['text']!r}"
    assert f"Question: {QUESTION}" in request.prompt, "the prompt is missing the 'Question: …' line"
    assert request.prompt == PROMPT, "the prompt must be exactly build_prompt(question, chunks, history): the model parses that format"
    assert result["answer"] == EXPECTED, f"answer must be the reply's text {EXPECTED!r}, got {result['answer']!r}"
    assert result["model"] == "large", f"model must be the reply's model 'large', got {result['model']!r}"
    assert result["tokens"] == len(EXPECTED.split()), f"tokens must be the reply's token count {len(EXPECTED.split())}, got {result['tokens']!r}"


async def check_deadline(ctx):
    m = _serve(ctx)
    await _generate(m)
    call = _large(ctx)[-1]
    assert call.timeout is not None, "the Generate call carries no deadline: a stalled model would hold the chat open forever"
    assert 1.5 <= call.timeout <= 2.0, f"the deadline must be DEADLINE_S = {config.DEADLINE_S} s, got {call.timeout} s"
    ctx.grpc.set_latency("Generate", 3.0, config.LLM_LARGE)
    started = ctx.clock.offset
    result = await _generate(m)
    elapsed = round(ctx.clock.offset - started, 3)
    large = _large(ctx)[1:]
    assert all(c.code == grpc.StatusCode.DEADLINE_EXCEEDED for c in large), "a large model slower than the deadline must be abandoned with DEADLINE_EXCEEDED, not waited for"
    assert len(large) == 2, f"a large model past its deadline earns one retry: expected 2 calls to {config.LLM_LARGE}, saw {len(large)}"
    assert result["model"] == "small", f"after two deadlines the small model must answer (model='small'), got {result['model']!r}"
    assert len(_small(ctx)) == 1, f"expected exactly one call to {config.LLM_SMALL}, saw {len(_small(ctx))}"
    assert 4.0 <= elapsed <= 4.8, f"two attempts of {config.DEADLINE_S} s plus one 0.2 s backoff should take about 4.2 s of virtual time, took {elapsed} s (6 s means the deadline was not attached to the call)"


async def check_retry_transient(ctx):
    m = _serve(ctx)
    ctx.grpc.fail("Generate", grpc.StatusCode.UNAVAILABLE, "", 1, config.LLM_LARGE)
    started = ctx.clock.offset
    result = await _generate(m)
    elapsed = round(ctx.clock.offset - started, 3)
    assert len(_large(ctx)) == 2, f"one UNAVAILABLE must be retried against the large model: expected 2 calls to {config.LLM_LARGE}, saw {len(_large(ctx))}"
    assert not _small(ctx), "one UNAVAILABLE is a retry, not a fallback: the small model must not be called"
    assert result["model"] == "large", f"the retry must be answered by the large model, got model={result['model']!r}"
    assert result["answer"] == EXPECTED, f"the retried answer must be the reply's text, got {result['answer']!r}"
    assert 0.15 <= elapsed <= 0.5, f"the retry must wait a 0.2 s backoff (virtual), it waited {elapsed} s"
    ctx.grpc.fail("Generate", grpc.StatusCode.INVALID_ARGUMENT, "prompt too long", 1, config.LLM_LARGE)
    code = await _failure(m, "INVALID_ARGUMENT is not transient: it")
    assert code == grpc.StatusCode.INVALID_ARGUMENT, f"INVALID_ARGUMENT must propagate as is, got {code}"
    assert len(_large(ctx)) == 3, "INVALID_ARGUMENT must not be retried: it will fail the same way"
    assert not _small(ctx), "INVALID_ARGUMENT must not fall back: the small model gets the same bad request"


async def check_fallback_small(ctx):
    m = _serve(ctx)
    ctx.grpc.stop(config.LLM_LARGE)
    result = await _generate(m)
    assert result["model"] == "small", f"with the large model down the small one must answer (model='small'), got {result['model']!r}"
    assert result["answer"] == EXPECTED, f"the small model's reply must come back as the answer, got {result['answer']!r}"
    assert len(_large(ctx)) == 2, f"a large model that is down earns exactly one retry: expected 2 calls to {config.LLM_LARGE}, saw {len(_large(ctx))}"
    assert len(_small(ctx)) == 1, f"expected exactly one call to {config.LLM_SMALL}, saw {len(_small(ctx))}"
    small = _small(ctx)[0].request
    assert small.model == "small" and small.prompt == PROMPT and small.max_tokens == config.MAX_TOKENS, "the fallback must send the same prompt and max_tokens with model='small'"
    ctx.grpc.stop(config.LLM_SMALL)
    code = await _failure(m, "both models down")
    assert code == grpc.StatusCode.UNAVAILABLE, f"both models down must surface UNAVAILABLE, got {code}"
    total = len(ctx.grpc.calls_to("Generate"))
    assert total == 6, f"never more than three model calls per generate: the second generate made {total - 3}"


async def check_max_tokens(ctx):
    m = _serve(ctx, "verbose")
    result = await _generate(m)
    request = _large(ctx)[0].request
    assert request.max_tokens == config.MAX_TOKENS, f"the request must carry max_tokens = MAX_TOKENS ({config.MAX_TOKENS}), got {request.max_tokens}"
    assert result["model"] == "large"
    words = len(result["answer"].split())
    assert words == config.MAX_TOKENS, f"a verbose model is cut at max_tokens by the server: expected {config.MAX_TOKENS} words, got {words}"
    assert result["tokens"] == config.MAX_TOKENS, f"tokens must be the reply's count {config.MAX_TOKENS}, got {result['tokens']!r}"
`,
    typescript: `const QUESTION = 'My payout has not arrived, when is it paid?';
const CHUNKS = [
  {id: 'pay-0', text: 'Dasher earnings for a week are paid out every Monday by direct deposit and usually arrive within two to three business days, depending on the bank.', score: 0.71},
  {id: 'tips-0', text: 'Tips are included in the weekly payout and in Fast Pay.', score: 0.52},
  {id: 'undeliverable-0', text: 'If the timer runs out, the app allows the order to be marked as undeliverable and the Dasher is still paid in full for the delivery.', score: 0.33},
];
const HISTORY = [
  {role: 'dasher', text: 'Hi, I dashed all of last week.'},
  {role: 'assistant', text: "Hello! What can I help you with about last week's dashes?"},
];

const words = (text: string) => text.split(/\\s+/).filter(w => w !== '').length;

/** Both model addresses served by the stand-in model in \`mode\`; the learner's module; the expected faithful answer. */
function serve(ctx, mode = 'faithful') {
  const {support} = ctx.proto('support.proto');
  const config = ctx.load('/support/assistant/config.ts');
  const model = ctx.load('/support/assistant/model.ts');
  const {buildPrompt} = ctx.load('/support/assistant/prompt.ts');
  const impl = {
    Generate: (call, callback) => {
      const text = model.complete(call.request.prompt, call.request.max_tokens, mode);
      callback(null, {text, tokens: words(text), model: call.request.model});
    },
  };
  ctx.grpc.serve(support.Llm.service, impl, config.LLM_LARGE);
  ctx.grpc.serve(support.Llm.service, impl, config.LLM_SMALL);
  const PROMPT = buildPrompt(QUESTION, CHUNKS, HISTORY);
  return {m: ctx.load('generate'), config, PROMPT, EXPECTED: model.complete(PROMPT, config.MAX_TOKENS)};
}

async function generate(m) {
  const result = await m.generate(QUESTION, CHUNKS, HISTORY);
  assert(result !== null && typeof result === 'object', \`generate must resolve to {answer, model, tokens}, got \${JSON.stringify(result)}\`);
  for (const key of ['answer', 'model', 'tokens']) assert(key in result, \`generate's result has no \${key}: \${JSON.stringify(result)}\`);
  return result;
}

/** The gRPC status code generate rejected with, or an assertion when it resolved. */
async function failure(m, what: string): Promise<number> {
  let result;
  try {
    result = await generate(m);
  } catch (e) {
    return (e as {code: number}).code;
  }
  throw new assert.AssertionError({message: \`\${what} must reject, generate resolved \${JSON.stringify(result)}\`});
}

const statusName = (ctx, code: number) => Object.keys(ctx.grpc.status).find(k => ctx.grpc.status[k] === code) ?? String(code);
const large = (ctx, config) => ctx.grpc.callsTo('Generate', config.LLM_LARGE);
const small = (ctx, config) => ctx.grpc.callsTo('Generate', config.LLM_SMALL);

export async function check_prompt(ctx) {
  const {m, config, PROMPT, EXPECTED} = serve(ctx);
  const result = await generate(m);
  const calls = large(ctx, config);
  assert.equal(calls.length, 1, \`a healthy large model must be called exactly once, saw \${calls.length} calls to \${config.LLM_LARGE}\`);
  assert.equal(small(ctx, config).length, 0, 'the small model must not be called while the large one answers');
  const request = calls[0].request;
  assert.equal(request.model, 'large', \`the request to \${config.LLM_LARGE} must say model: 'large', got \${JSON.stringify(request.model)}\`);
  for (const c of CHUNKS)
    assert(request.prompt.includes(\`[kb:\${c.id}] \${c.text}\`), \`the prompt has no '[kb:\${c.id}] <text>' line for a retrieved chunk; use buildPrompt from assistant/prompt\`);
  for (const turn of HISTORY)
    assert(request.prompt.includes(\`\${turn.role}: \${turn.text}\`), \`the prompt is missing the history turn \${turn.role}: \${JSON.stringify(turn.text)}\`);
  assert(request.prompt.includes(\`Question: \${QUESTION}\`), "the prompt is missing the 'Question: …' line");
  assert.equal(request.prompt, PROMPT, 'the prompt must be exactly buildPrompt(question, chunks, history): the model parses that format');
  assert.equal(result.answer, EXPECTED, \`answer must be the reply's text \${JSON.stringify(EXPECTED)}, got \${JSON.stringify(result.answer)}\`);
  assert.equal(result.model, 'large', \`model must be the reply's model 'large', got \${JSON.stringify(result.model)}\`);
  assert.equal(result.tokens, words(EXPECTED), \`tokens must be the reply's token count \${words(EXPECTED)}, got \${JSON.stringify(result.tokens)}\`);
}

export async function check_deadline(ctx) {
  const {m, config} = serve(ctx);
  await generate(m);
  const call = large(ctx, config).at(-1);
  assert(call.timeout !== null, 'the Generate call carries no deadline: a stalled model would hold the chat open forever');
  assert(1.5 <= call.timeout && call.timeout <= 2.0, \`the deadline must be DEADLINE_S = \${config.DEADLINE_S} s, got \${call.timeout} s\`);
  ctx.grpc.setLatency('Generate', 3.0, config.LLM_LARGE);
  const started = ctx.clock.now();
  const result = await generate(m);
  const elapsed = Math.round(ctx.clock.now() - started);
  const slow = large(ctx, config).slice(1);
  assert(slow.every(c => c.code === ctx.grpc.status.DEADLINE_EXCEEDED), 'a large model slower than the deadline must be abandoned with DEADLINE_EXCEEDED, not waited for');
  assert.equal(slow.length, 2, \`a large model past its deadline earns one retry: expected 2 calls to \${config.LLM_LARGE}, saw \${slow.length}\`);
  assert.equal(result.model, 'small', \`after two deadlines the small model must answer (model: 'small'), got \${JSON.stringify(result.model)}\`);
  assert.equal(small(ctx, config).length, 1, \`expected exactly one call to \${config.LLM_SMALL}, saw \${small(ctx, config).length}\`);
  assert(4000 <= elapsed && elapsed <= 4800, \`two attempts of \${config.DEADLINE_S} s plus one 200 ms backoff should take about 4200 ms of virtual time, took \${elapsed} ms (6000 means the deadline was not attached to the call)\`);
}

export async function check_retry_transient(ctx) {
  const {m, config, EXPECTED} = serve(ctx);
  ctx.grpc.fail('Generate', ctx.grpc.status.UNAVAILABLE, '', 1, config.LLM_LARGE);
  const started = ctx.clock.now();
  const result = await generate(m);
  const elapsed = Math.round(ctx.clock.now() - started);
  assert.equal(large(ctx, config).length, 2, \`one UNAVAILABLE must be retried against the large model: expected 2 calls to \${config.LLM_LARGE}, saw \${large(ctx, config).length}\`);
  assert.equal(small(ctx, config).length, 0, 'one UNAVAILABLE is a retry, not a fallback: the small model must not be called');
  assert.equal(result.model, 'large', \`the retry must be answered by the large model, got model \${JSON.stringify(result.model)}\`);
  assert.equal(result.answer, EXPECTED, \`the retried answer must be the reply's text, got \${JSON.stringify(result.answer)}\`);
  assert(150 <= elapsed && elapsed <= 500, \`the retry must wait a 200 ms backoff (virtual), it waited \${elapsed} ms\`);
  ctx.grpc.fail('Generate', ctx.grpc.status.INVALID_ARGUMENT, 'prompt too long', 1, config.LLM_LARGE);
  const code = await failure(m, 'INVALID_ARGUMENT is not transient: it');
  assert.equal(code, ctx.grpc.status.INVALID_ARGUMENT, \`INVALID_ARGUMENT must propagate as is, got \${statusName(ctx, code)}\`);
  assert.equal(large(ctx, config).length, 3, 'INVALID_ARGUMENT must not be retried: it will fail the same way');
  assert.equal(small(ctx, config).length, 0, 'INVALID_ARGUMENT must not fall back: the small model gets the same bad request');
}

export async function check_fallback_small(ctx) {
  const {m, config, PROMPT, EXPECTED} = serve(ctx);
  ctx.grpc.stop(config.LLM_LARGE);
  const result = await generate(m);
  assert.equal(result.model, 'small', \`with the large model down the small one must answer (model: 'small'), got \${JSON.stringify(result.model)}\`);
  assert.equal(result.answer, EXPECTED, \`the small model's reply must come back as the answer, got \${JSON.stringify(result.answer)}\`);
  assert.equal(large(ctx, config).length, 2, \`a large model that is down earns exactly one retry: expected 2 calls to \${config.LLM_LARGE}, saw \${large(ctx, config).length}\`);
  assert.equal(small(ctx, config).length, 1, \`expected exactly one call to \${config.LLM_SMALL}, saw \${small(ctx, config).length}\`);
  const request = small(ctx, config)[0].request;
  assert(request.model === 'small' && request.prompt === PROMPT && request.max_tokens === config.MAX_TOKENS, "the fallback must send the same prompt and max_tokens with model: 'small'");
  ctx.grpc.stop(config.LLM_SMALL);
  const code = await failure(m, 'both models down');
  assert.equal(code, ctx.grpc.status.UNAVAILABLE, \`both models down must surface UNAVAILABLE, got \${statusName(ctx, code)}\`);
  const total = ctx.grpc.callsTo('Generate').length;
  assert.equal(total, 6, \`never more than three model calls per generate: the second generate made \${total - 3}\`);
}

export async function check_max_tokens(ctx) {
  const {m, config} = serve(ctx, 'verbose');
  const result = await generate(m);
  const request = large(ctx, config)[0].request;
  assert.equal(request.max_tokens, config.MAX_TOKENS, \`the request must carry max_tokens: MAX_TOKENS (\${config.MAX_TOKENS}), got \${request.max_tokens}\`);
  assert.equal(result.model, 'large');
  assert.equal(words(result.answer), config.MAX_TOKENS, \`a verbose model is cut at max_tokens by the server: expected \${config.MAX_TOKENS} words, got \${words(result.answer)}\`);
  assert.equal(result.tokens, config.MAX_TOKENS, \`tokens must be the reply's count \${config.MAX_TOKENS}, got \${JSON.stringify(result.tokens)}\`);
}
`,
    go: `package main

import (
	"context"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"assistant/config"
	"assistant/model"
	"assistant/prompt"
	pb "assistant/gen/support"

	"leetbuild/harness"
)

const modelQuestion = "My payout has not arrived, when is it paid?"

var modelChunks = []prompt.Chunk{
	{ID: "pay-0", Text: "Dasher earnings for a week are paid out every Monday by direct deposit and usually arrive within two to three business days, depending on the bank.", Score: 0.71},
	{ID: "tips-0", Text: "Tips are included in the weekly payout and in Fast Pay.", Score: 0.52},
	{ID: "undeliverable-0", Text: "If the timer runs out, the app allows the order to be marked as undeliverable and the Dasher is still paid in full for the delivery.", Score: 0.33},
}

var modelHistory = []prompt.Turn{
	{Role: "dasher", Text: "Hi, I dashed all of last week."},
	{Role: "assistant", Text: "Hello! What can I help you with about last week's dashes?"},
}

// llmPeer is the stand-in model server, answering in mode.
type llmPeer struct {
	pb.UnimplementedLlmServer
	mode string
}

func (p *llmPeer) Generate(_ context.Context, req *pb.GenerateRequest) (*pb.GenerateReply, error) {
	text := model.Complete(req.GetPrompt(), int(req.GetMaxTokens()), p.mode)
	return &pb.GenerateReply{Text: text, Tokens: int32(len(strings.Fields(text))), Model: req.GetModel()}, nil
}

// modelWorld is what a check compares against: the one prompt and the faithful model's answer to it.
type modelWorld struct {
	prompt   string
	expected string
}

// serveModels serves both model addresses with the stand-in model in mode.
func serveModels(ctx *harness.Ctx, mode string) modelWorld {
	peer := &llmPeer{mode: mode}
	pb.RegisterLlmServer(ctx.GRPC.Server(config.LLMLarge), peer)
	pb.RegisterLlmServer(ctx.GRPC.Server(config.LLMSmall), peer)
	p := prompt.Build(modelQuestion, modelChunks, modelHistory)
	return modelWorld{prompt: p, expected: model.Complete(p, config.MaxTokens, "faithful")}
}

// generateOK calls generate and requires a result.
func generateOK(ctx *harness.Ctx) *Generated {
	result, err := generate(context.Background(), modelQuestion, modelChunks, modelHistory)
	ctx.NoError(err, "generate(question, chunks, history) must return {Answer, Model, Tokens}")
	ctx.Assert(result != nil, "generate must return a *Generated, got nil")
	return result
}

// generateFails calls generate, requires an error and returns its status code.
func generateFails(ctx *harness.Ctx, what string) codes.Code {
	result, err := generate(context.Background(), modelQuestion, modelChunks, modelHistory)
	if err == nil {
		ctx.Fatalf("%s must fail, generate returned %+v", what, result)
	}
	return status.Code(err)
}

func generateCalls(ctx *harness.Ctx, target string) []harness.Call {
	return ctx.GRPC.CallsTo("Generate", target)
}

func generateRequest(call harness.Call) *pb.GenerateRequest {
	req, _ := call.Request.(*pb.GenerateRequest)
	return req
}

func replyWords(text string) int { return len(strings.Fields(text)) }

func CheckPrompt(ctx *harness.Ctx) {
	w := serveModels(ctx, "faithful")
	result := generateOK(ctx)
	calls := generateCalls(ctx, config.LLMLarge)
	ctx.Equal(len(calls), 1, "a healthy large model must be called exactly once: calls to %s", config.LLMLarge)
	ctx.Equal(len(generateCalls(ctx, config.LLMSmall)), 0, "the small model must not be called while the large one answers")
	request := generateRequest(calls[0])
	ctx.Equal(request.GetModel(), "large", "the request to %s must say Model: \\"large\\"", config.LLMLarge)
	for _, c := range modelChunks {
		ctx.Assert(strings.Contains(request.GetPrompt(), "[kb:"+c.ID+"] "+c.Text), "the prompt has no '[kb:%s] <text>' line for a retrieved chunk; use prompt.Build", c.ID)
	}
	for _, turn := range modelHistory {
		ctx.Assert(strings.Contains(request.GetPrompt(), turn.Role+": "+turn.Text), "the prompt is missing the history turn %s: %q", turn.Role, turn.Text)
	}
	ctx.Assert(strings.Contains(request.GetPrompt(), "Question: "+modelQuestion), "the prompt is missing the 'Question: …' line")
	ctx.Equal(request.GetPrompt(), w.prompt, "the prompt must be exactly prompt.Build(question, chunks, history): the model parses that format")
	ctx.Equal(result.Answer, w.expected, "Answer must be the reply's text")
	ctx.Equal(result.Model, "large", "Model must be the reply's model")
	ctx.Equal(result.Tokens, replyWords(w.expected), "Tokens must be the reply's token count")
}

func CheckDeadline(ctx *harness.Ctx) {
	serveModels(ctx, "faithful")
	generateOK(ctx)
	calls := generateCalls(ctx, config.LLMLarge)
	call := calls[len(calls)-1]
	ctx.Assert(call.HasDeadline(), "the Generate call carries no deadline: a stalled model would hold the chat open forever")
	ctx.Assert(1.5 <= call.Timeout.Seconds() && call.Timeout.Seconds() <= 2.0, "the deadline must be config.DeadlineS = %v s, got %v s", config.DeadlineS, call.Timeout.Seconds())
	ctx.GRPC.SetLatency("Generate", 3.0, config.LLMLarge)
	started := ctx.Clock.Now()
	result := generateOK(ctx)
	elapsed := ctx.Clock.Now() - started
	slow := generateCalls(ctx, config.LLMLarge)[1:]
	for _, c := range slow {
		ctx.Assert(c.Code == codes.DeadlineExceeded, "a large model slower than the deadline must be abandoned with DEADLINE_EXCEEDED, not waited for")
	}
	ctx.Equal(len(slow), 2, "a large model past its deadline earns one retry: calls to %s", config.LLMLarge)
	ctx.Equal(result.Model, "small", "after two deadlines the small model must answer")
	ctx.Equal(len(generateCalls(ctx, config.LLMSmall)), 1, "calls to %s", config.LLMSmall)
	ctx.Assert(4000 <= elapsed && elapsed <= 4800, "two attempts of %v s plus one 200 ms backoff should take about 4200 ms of virtual time, took %d ms (6000 means the deadline was not attached to the call)", config.DeadlineS, elapsed)
}

func CheckRetryTransient(ctx *harness.Ctx) {
	w := serveModels(ctx, "faithful")
	ctx.GRPC.Fail("Generate", codes.Unavailable, "", 1, config.LLMLarge)
	started := ctx.Clock.Now()
	result := generateOK(ctx)
	elapsed := ctx.Clock.Now() - started
	ctx.Equal(len(generateCalls(ctx, config.LLMLarge)), 2, "one UNAVAILABLE must be retried against the large model: calls to %s", config.LLMLarge)
	ctx.Equal(len(generateCalls(ctx, config.LLMSmall)), 0, "one UNAVAILABLE is a retry, not a fallback: the small model must not be called")
	ctx.Equal(result.Model, "large", "the retry must be answered by the large model")
	ctx.Equal(result.Answer, w.expected, "the retried answer must be the reply's text")
	ctx.Assert(150 <= elapsed && elapsed <= 500, "the retry must wait a 200 ms backoff (virtual), it waited %d ms", elapsed)
	ctx.GRPC.Fail("Generate", codes.InvalidArgument, "prompt too long", 1, config.LLMLarge)
	code := generateFails(ctx, "INVALID_ARGUMENT is not transient: it")
	ctx.Equal(code, codes.InvalidArgument, "INVALID_ARGUMENT must propagate as is")
	ctx.Equal(len(generateCalls(ctx, config.LLMLarge)), 3, "INVALID_ARGUMENT must not be retried: it will fail the same way")
	ctx.Equal(len(generateCalls(ctx, config.LLMSmall)), 0, "INVALID_ARGUMENT must not fall back: the small model gets the same bad request")
}

func CheckFallbackSmall(ctx *harness.Ctx) {
	w := serveModels(ctx, "faithful")
	ctx.GRPC.Stop(config.LLMLarge)
	result := generateOK(ctx)
	ctx.Equal(result.Model, "small", "with the large model down the small one must answer")
	ctx.Equal(result.Answer, w.expected, "the small model's reply must come back as the answer")
	ctx.Equal(len(generateCalls(ctx, config.LLMLarge)), 2, "a large model that is down earns exactly one retry: calls to %s", config.LLMLarge)
	ctx.Equal(len(generateCalls(ctx, config.LLMSmall)), 1, "calls to %s", config.LLMSmall)
	request := generateRequest(generateCalls(ctx, config.LLMSmall)[0])
	ctx.Assert(request.GetModel() == "small" && request.GetPrompt() == w.prompt && request.GetMaxTokens() == config.MaxTokens, "the fallback must send the same prompt and MaxTokens with Model: \\"small\\"")
	ctx.GRPC.Stop(config.LLMSmall)
	code := generateFails(ctx, "both models down")
	ctx.Equal(code, codes.Unavailable, "both models down must surface UNAVAILABLE")
	total := len(generateCalls(ctx, ""))
	ctx.Assert(total == 6, "never more than three model calls per generate: the second generate made %d", total-3)
}

func CheckMaxTokens(ctx *harness.Ctx) {
	serveModels(ctx, "verbose")
	result := generateOK(ctx)
	request := generateRequest(generateCalls(ctx, config.LLMLarge)[0])
	ctx.Equal(request.GetMaxTokens(), config.MaxTokens, "the request must carry MaxTokens: config.MaxTokens")
	ctx.Equal(result.Model, "large", "Model")
	ctx.Equal(replyWords(result.Answer), config.MaxTokens, "a verbose model is cut at max_tokens by the server: words in the answer")
	ctx.Equal(result.Tokens, config.MaxTokens, "Tokens must be the reply's count")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <sstream>

#include "assistant/model.h"

namespace {

const std::string modelQuestion = "My payout has not arrived, when is it paid?";

const std::vector<assistant::Chunk> modelChunks = {
    {"pay-0", "Dasher earnings for a week are paid out every Monday by direct deposit and usually arrive within two to three business days, depending on the bank.", 0.71},
    {"tips-0", "Tips are included in the weekly payout and in Fast Pay.", 0.52},
    {"undeliverable-0", "If the timer runs out, the app allows the order to be marked as undeliverable and the Dasher is still paid in full for the delivery.", 0.33},
};

const std::vector<assistant::Turn> modelHistory = {
    {"dasher", "Hi, I dashed all of last week."},
    {"assistant", "Hello! What can I help you with about last week's dashes?"},
};

int replyWords(const std::string& text) { return static_cast<int>(model::fields(text).size()); }

// llmPeer is the stand-in model server, answering in mode.
class llmPeer final : public support::Llm::Service {
 public:
  explicit llmPeer(std::string mode) : mode_(std::move(mode)) {}
  grpc::Status Generate(grpc::ServerContext*, const support::GenerateRequest* req, support::GenerateReply* reply) override {
    const std::string text = model::complete(req->prompt(), req->max_tokens(), mode_);
    reply->set_text(text);
    reply->set_tokens(replyWords(text));
    reply->set_model(req->model());
    return grpc::Status::OK;
  }

 private:
  std::string mode_;
};

// modelWorld is what a check compares against: the one prompt and the faithful model's answer to it.
struct modelWorld {
  std::string prompt;
  std::string expected;
};

// serveModels serves both model addresses with the stand-in model in mode.
modelWorld serveModels(harness::Ctx& ctx, const std::string& mode) {
  static std::unique_ptr<llmPeer> peer;
  peer = std::make_unique<llmPeer>(mode);
  ctx.GRPC.Server(config::kLlmLarge)->RegisterService(peer.get());
  ctx.GRPC.Server(config::kLlmSmall)->RegisterService(peer.get());
  const std::string p = assistant::build_prompt(modelQuestion, modelChunks, modelHistory);
  return modelWorld{p, model::complete(p, config::kMaxTokens, "faithful")};
}

// generateOK calls generate and requires a result.
Generated generateOK(harness::Ctx& ctx) {
  try {
    return generate(modelQuestion, modelChunks, modelHistory);
  } catch (const std::exception& e) {
    ctx.Fatalf("generate(question, chunks, history) must return {Answer, Model, Tokens}: %v", std::string(e.what()));
  }
}

std::vector<harness::Call> generateCalls(harness::Ctx& ctx, const std::string& target) { return ctx.GRPC.CallsTo("Generate", target); }

// generateFails calls generate, requires it to throw and returns the status code it failed with.
// Go reads the code off the returned error; the C++ step throws a std::runtime_error carrying the
// status message, so the code is the last model call's, and the exception must carry its message.
grpc::StatusCode generateFails(harness::Ctx& ctx, const std::string& what) {
  try {
    const Generated result = generate(modelQuestion, modelChunks, modelHistory);
    ctx.Fatalf("%s must fail, generate returned &{Answer:%s Model:%s Tokens:%d}", what, result.answer, result.model, result.tokens);
  } catch (const std::exception& e) {
    const auto calls = generateCalls(ctx, "");
    ctx.Assert(!calls.empty(), "%s must fail after calling the model, no Generate call was made", what);
    const harness::Call& last = calls.back();
    ctx.Assert(std::string(e.what()).find(last.Message) != std::string::npos, "%s: the error must carry the model's status (%q), it was %q", what, last.Message, std::string(e.what()));
    return last.Code;
  }
}

}  // namespace

void CheckPrompt(harness::Ctx& ctx) {
  const auto w = serveModels(ctx, "faithful");
  const Generated result = generateOK(ctx);
  const auto calls = generateCalls(ctx, config::kLlmLarge);
  ctx.Equal(calls.size(), 1, "a healthy large model must be called exactly once: calls to %s", config::kLlmLarge);
  ctx.Equal(generateCalls(ctx, config::kLlmSmall).size(), 0, "the small model must not be called while the large one answers");
  const auto request = calls[0].Request<support::GenerateRequest>();
  ctx.Equal(request.model(), "large", "the request to %s must say Model: \\"large\\"", config::kLlmLarge);
  for (const auto& c : modelChunks) {
    ctx.Assert(request.prompt().find("[kb:" + c.id + "] " + c.text) != std::string::npos, "the prompt has no '[kb:%s] <text>' line for a retrieved chunk; use prompt.Build", c.id);
  }
  for (const auto& turn : modelHistory) {
    ctx.Assert(request.prompt().find(turn.role + ": " + turn.text) != std::string::npos, "the prompt is missing the history turn %s: %q", turn.role, turn.text);
  }
  ctx.Assert(request.prompt().find("Question: " + modelQuestion) != std::string::npos, "the prompt is missing the 'Question: …' line");
  ctx.Equal(request.prompt(), w.prompt, "the prompt must be exactly prompt.Build(question, chunks, history): the model parses that format");
  ctx.Equal(result.answer, w.expected, "Answer must be the reply's text");
  ctx.Equal(result.model, "large", "Model must be the reply's model");
  ctx.Equal(result.tokens, replyWords(w.expected), "Tokens must be the reply's token count");
}

void CheckDeadline(harness::Ctx& ctx) {
  serveModels(ctx, "faithful");
  generateOK(ctx);
  const auto calls = generateCalls(ctx, config::kLlmLarge);
  const harness::Call& call = calls.back();
  ctx.Assert(call.HasDeadline(), "the Generate call carries no deadline: a stalled model would hold the chat open forever");
  const double deadlineS = config::kDeadline.count() / 1000.0;
  ctx.Assert(1.5 <= call.TimeoutSeconds() && call.TimeoutSeconds() <= 2.0, "the deadline must be config.DeadlineS = %v s, got %v s", deadlineS, call.TimeoutSeconds());
  ctx.GRPC.SetLatency("Generate", 3.0, config::kLlmLarge);
  const int64_t started = ctx.Clock.Now();
  const Generated result = generateOK(ctx);
  const int64_t elapsed = ctx.Clock.Now() - started;
  const auto all = generateCalls(ctx, config::kLlmLarge);
  const std::vector<harness::Call> slow(all.begin() + 1, all.end());
  for (const auto& c : slow) {
    ctx.Assert(c.Code == grpc::StatusCode::DEADLINE_EXCEEDED, "a large model slower than the deadline must be abandoned with DEADLINE_EXCEEDED, not waited for");
  }
  ctx.Equal(slow.size(), 2, "a large model past its deadline earns one retry: calls to %s", config::kLlmLarge);
  ctx.Equal(result.model, "small", "after two deadlines the small model must answer");
  ctx.Equal(generateCalls(ctx, config::kLlmSmall).size(), 1, "calls to %s", config::kLlmSmall);
  ctx.Assert(4000 <= elapsed && elapsed <= 4800, "two attempts of %v s plus one 200 ms backoff should take about 4200 ms of virtual time, took %d ms (6000 means the deadline was not attached to the call)", deadlineS, elapsed);
}

void CheckRetryTransient(harness::Ctx& ctx) {
  const auto w = serveModels(ctx, "faithful");
  ctx.GRPC.Fail("Generate", grpc::StatusCode::UNAVAILABLE, "", 1, config::kLlmLarge);
  const int64_t started = ctx.Clock.Now();
  const Generated result = generateOK(ctx);
  const int64_t elapsed = ctx.Clock.Now() - started;
  ctx.Equal(generateCalls(ctx, config::kLlmLarge).size(), 2, "one UNAVAILABLE must be retried against the large model: calls to %s", config::kLlmLarge);
  ctx.Equal(generateCalls(ctx, config::kLlmSmall).size(), 0, "one UNAVAILABLE is a retry, not a fallback: the small model must not be called");
  ctx.Equal(result.model, "large", "the retry must be answered by the large model");
  ctx.Equal(result.answer, w.expected, "the retried answer must be the reply's text");
  ctx.Assert(150 <= elapsed && elapsed <= 500, "the retry must wait a 200 ms backoff (virtual), it waited %d ms", elapsed);
  ctx.GRPC.Fail("Generate", grpc::StatusCode::INVALID_ARGUMENT, "prompt too long", 1, config::kLlmLarge);
  const auto code = generateFails(ctx, "INVALID_ARGUMENT is not transient: it");
  ctx.Assert(code == grpc::StatusCode::INVALID_ARGUMENT, "INVALID_ARGUMENT must propagate as is, got code %d", static_cast<int>(code));
  ctx.Equal(generateCalls(ctx, config::kLlmLarge).size(), 3, "INVALID_ARGUMENT must not be retried: it will fail the same way");
  ctx.Equal(generateCalls(ctx, config::kLlmSmall).size(), 0, "INVALID_ARGUMENT must not fall back: the small model gets the same bad request");
}

void CheckFallbackSmall(harness::Ctx& ctx) {
  const auto w = serveModels(ctx, "faithful");
  ctx.GRPC.Stop(config::kLlmLarge);
  const Generated result = generateOK(ctx);
  ctx.Equal(result.model, "small", "with the large model down the small one must answer");
  ctx.Equal(result.answer, w.expected, "the small model's reply must come back as the answer");
  ctx.Equal(generateCalls(ctx, config::kLlmLarge).size(), 2, "a large model that is down earns exactly one retry: calls to %s", config::kLlmLarge);
  ctx.Equal(generateCalls(ctx, config::kLlmSmall).size(), 1, "calls to %s", config::kLlmSmall);
  const auto request = generateCalls(ctx, config::kLlmSmall)[0].Request<support::GenerateRequest>();
  ctx.Assert(request.model() == "small" && request.prompt() == w.prompt && request.max_tokens() == config::kMaxTokens, "the fallback must send the same prompt and MaxTokens with Model: \\"small\\"");
  ctx.GRPC.Stop(config::kLlmSmall);
  const auto code = generateFails(ctx, "both models down");
  ctx.Assert(code == grpc::StatusCode::UNAVAILABLE, "both models down must surface UNAVAILABLE, got code %d", static_cast<int>(code));
  const size_t total = generateCalls(ctx, "").size();
  ctx.Assert(total == 6, "never more than three model calls per generate: the second generate made %d", total - 3);
}

void CheckMaxTokens(harness::Ctx& ctx) {
  serveModels(ctx, "verbose");
  const Generated result = generateOK(ctx);
  const auto request = generateCalls(ctx, config::kLlmLarge)[0].Request<support::GenerateRequest>();
  ctx.Equal(request.max_tokens(), config::kMaxTokens, "the request must carry MaxTokens: config.MaxTokens");
  ctx.Equal(result.model, "large", "Model");
  ctx.Equal(replyWords(result.answer), config::kMaxTokens, "a verbose model is cut at max_tokens by the server: words in the answer");
  ctx.Equal(result.tokens, config::kMaxTokens, "Tokens must be the reply's count");
}
`,
  },
  debrief: `A deadline is a budget, not a timeout: the Dasher is owed an answer within a few seconds, and every call the assistant makes spends from that. Attaching \`DEADLINE_S\` to the call itself is what lets a slow model be abandoned at 2 s instead of 3 — a sleep around the call would still wait for the reply. Retrying only \`UNAVAILABLE\` and \`DEADLINE_EXCEEDED\`, once, after a short backoff, is the difference between a retry and a retry storm: those statuses mean "not right now", while an \`INVALID_ARGUMENT\` fails identically twice. The fallback is the part a model service adds: when the large model fails twice, a smaller one with the same prompt and the same citations is a better outcome than an error page — the guardrail (next step) judges its answer on the same terms, and the hand-off to a person is reserved for answers that fail *that*, not for a model that was slow. LinkedIn's platform post frames the same budget in streaming terms: time to first token and time between tokens are what the user feels, so the model sits behind an interface that can swap in a smaller one when the large one cannot meet them (step 5 streams, and the deadline becomes a budget for the first token). Grab's AI Gateway makes the fallback a property of the gateway rather than of each caller — dynamic routing to another model or provider when one fails, with every request and its outcome recorded. Production clients also propagate the caller's remaining deadline instead of picking a fresh one per hop, add jitter to the backoff, hedge a slow request against a second replica, and open a circuit to the large model once its error rate stays high so the fallback stops paying for two failed calls first.`,
};
