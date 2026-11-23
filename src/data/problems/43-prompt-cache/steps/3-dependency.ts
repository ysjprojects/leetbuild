import type {Step} from '@/lib/types';

export const cacheDependencyStep: Step = {
  id: 'dependency',
  title: 'The miss path: a deadline and a rule for what is stored',
  concept: 'grpc',
  guides: ['model-output', 'deadlines-and-retries'],
  file: 'miss',
  focus: ['cache', 'model', 'redis'],
  task: `## Task

**Starting point.** The starter's \`complete_miss(key, tenant, version, prefix, temperature)\` calls
\`Model.Complete\` (\`prompt_cache.proto\`, served as a stand-in at \`pcache/config\`'s \`MODEL\`), up to three times
while the reply is a \`content_filter\` refusal. When the call fails it falls back to a canned "busy"
message; whatever text it ends with goes through step 2's \`fill\`, and it answers \`{status: "cached",
completion, tokens}\`. Against a healthy model it answers in one call. It hides 5 flaws.

**Failure mode the checks target.** A cache multiplies whatever it stores: an outage message, a sampled
answer or a truncated one, filled once, is served to every caller of that prefix for six hours. A model
server that hangs takes the request down with it.

\`\`\`proto
service Model { rpc Complete(CompleteRequest) returns (CompleteReply); }
message CompleteRequest { string tenant = 1; int32 prompt_version = 2; string prefix = 3; double temperature = 4; }
message CompleteReply   { string text = 1; string finish_reason = 2; int32 completion_tokens = 3; }
\`\`\`

- Every call carries a **3-second deadline** (\`DEADLINE_S\`).
- A failed call (deadline, unavailable, any status) answers \`{status: "error"}\` and stores nothing.
- A \`content_filter\` reply answers \`{status: "refused"}\` after one call and stores nothing.
- Only \`temperature == 0\` **and** \`finish_reason == "stop"\` is filled: \`status: "cached"\` with the
  stored record's completion. Anything else is \`uncached\`: served, not stored.`,
  sequence: {
    participants: ['Prompt Cache', 'Model server', 'Redis'],
    messages: [
      {
        from: 'Prompt Cache',
        to: 'Model server',
        label: 'Complete(prefix, version, temperature) · deadline 3 s',
        kind: 'sync',
      },
      {from: 'Model server', to: 'Prompt Cache', label: '{text, finish_reason: "stop"}', kind: 'reply'},
      {from: 'Prompt Cache', to: 'Prompt Cache', label: 'temperature == 0 and stop?', kind: 'sync'},
      {from: 'Prompt Cache', to: 'Redis', label: 'fill: SET key record NX EX 21600', kind: 'sync'},
      {from: 'Redis', to: 'Prompt Cache', label: 'the record the cache holds', kind: 'reply'},
    ],
  },
  hints: [
    'A user who once saw "The assistant is busy" keeps seeing it for six hours, a creative answer comes back word for word to every caller, and one stuck model reply holds a request for ten seconds.',
    'The call has no deadline. The starter fills whatever text it ended with: the fallback after an error, a sampled or truncated answer, the empty text of a refusal it already asked three times.',
    'Pass `timeout=DEADLINE_S`; on an RpcError answer `error`; on `content_filter` answer `refused` after one call; fill only when `temperature == 0 and finish_reason == "stop"`, otherwise answer `uncached`.',
  ],
  checks: [
    {
      id: 'cached-answer',
      title: 'A deterministic, finished answer is stored',
      detail:
        'At temperature 0 with finish_reason stop, one call is made, the record {tenant, version, completion, tokens} is filled under the key, and the miss answers status cached with that completion. When another replica filled the key first, the miss answers the stored completion.',
      match: {
        python: {all: [/stub\.Complete\(/, /fill\(\s*key\s*,/]},
        typescript: {all: [/stub\.Complete\(/, /fill\(\s*key\s*,/]},
        go: {all: [/stub\.Complete\(/, /fill\(\s*ctx\s*,\s*key\s*,/]},
        cpp: {all: [/stub->Complete\(/, /fill\(\s*key\s*,/]},
      },
    },
    {
      id: 'deadline',
      title: 'Three-second deadline on the model call',
      detail:
        'A model that takes 10 s is cut at about 3 s, the miss answers status error and nothing is stored; a model that answers in 2 s is accepted. The starter sends no deadline and waits the whole 10 s.',
      match: {
        python: {all: [/timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/context\.WithTimeout\(/]},
        cpp: {all: [/set_deadline\(/]},
      },
    },
    {
      id: 'temperature-gate',
      title: 'A sampled answer is served, not stored',
      detail:
        "At temperature 0.7, and at 0.05, the miss answers status uncached with the sampled completion and leaves no entry. The starter stores it, so the first caller's sample becomes every caller's answer.",
      match: {
        python: {all: [/temperature\s*==\s*0\b/]},
        typescript: {all: [/temperature\s*===\s*0\b/]},
        go: {all: [/temperature\s*==\s*0\b/]},
        cpp: {all: [/temperature\s*==\s*0\b/]},
      },
    },
    {
      id: 'stop-only',
      title: 'A truncated answer is served, not stored',
      detail:
        'A reply that finished with length (cut at the token limit), or with any reason other than stop such as tool_calls, answers status uncached and leaves no entry. The starter stores it as the answer for the prefix.',
      match: {
        python: {all: [/finish_reason\s*==\s*["']stop["']/]},
        typescript: {all: [/finish_reason\s*===\s*['"]stop['"]/]},
        go: {all: [/FinishReason\(\)\s*==\s*"stop"/]},
        cpp: {all: [/finish_reason\(\)\s*==\s*"stop"/]},
      },
    },
    {
      id: 'refusal-terminal',
      title: 'A refusal is answered once and not stored',
      detail:
        'A content_filter reply answers status refused after exactly one call and leaves no entry. The starter asks three times and then stores the empty text.',
      match: {
        python: {all: [/["']refused["']/], none: [/MAX_ATTEMPTS/]},
        typescript: {all: [/['"]refused['"]/], none: [/MAX_ATTEMPTS/]},
        go: {all: [/"refused"/], none: [/maxAttempts/]},
        cpp: {all: [/"refused"/], none: [/kMaxAttempts/]},
      },
    },
    {
      id: 'error-uncached',
      title: 'A failed call stores nothing',
      detail:
        'An UNAVAILABLE, INTERNAL or RESOURCE_EXHAUSTED call answers status error with no completion and leaves no entry, so the next caller asks the model again. The starter fills its fallback message under the key.',
      match: {
        python: {all: [/["']error["']/], none: [/FALLBACK/]},
        typescript: {all: [/['"]error['"]/], none: [/FALLBACK/]},
        go: {all: [/"error"/], none: [/fallback/]},
        cpp: {all: [/"error"/], none: [/kFallback/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import logging

import grpc

import prompt_cache_pb2
import prompt_cache_pb2_grpc
from cache import fill  # step 2: one SET NX EX, returns the record the cache holds
from pcache.config import MODEL

log = logging.getLogger("pcache.miss")

MAX_ATTEMPTS = 3
FALLBACK = "The assistant is busy right now. Please try again in a minute."

channel = grpc.insecure_channel(MODEL)
stub = prompt_cache_pb2_grpc.ModelStub(channel)


def complete_miss(key: str, tenant: str, version: int, prefix: str, temperature: float) -> dict:
    """One model call for a cache miss; the answer is stored for the next caller."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    request = prompt_cache_pb2.CompleteRequest(tenant=tenant, prompt_version=version, prefix=prefix, temperature=temperature)
    text, tokens = FALLBACK, 0
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = stub.Complete(request)
        except grpc.RpcError as err:
            log.warning("model call failed key=%s code=%s", key, err.code())
            break
        text, tokens = reply.text, reply.completion_tokens
        if reply.finish_reason != "content_filter":
            break
    stored = fill(key, {"tenant": tenant, "version": version, "completion": text, "tokens": tokens})
    return {"status": "cached", "completion": stored["completion"], "tokens": stored["tokens"]}
`,
      solution: `import logging

import grpc

import prompt_cache_pb2
import prompt_cache_pb2_grpc
from cache import fill  # step 2: one SET NX EX, returns the record the cache holds
from pcache.config import MODEL

log = logging.getLogger("pcache.miss")

DEADLINE_S = 3.0

channel = grpc.insecure_channel(MODEL)
stub = prompt_cache_pb2_grpc.ModelStub(channel)


def complete_miss(key: str, tenant: str, version: int, prefix: str, temperature: float) -> dict:
    """One model call for a cache miss; only a deterministic, finished answer is stored."""
    request = prompt_cache_pb2.CompleteRequest(tenant=tenant, prompt_version=version, prefix=prefix, temperature=temperature)
    try:
        reply = stub.Complete(request, timeout=DEADLINE_S)
    except grpc.RpcError as err:
        log.warning("model call failed key=%s code=%s", key, err.code())
        return {"status": "error", "completion": "", "tokens": 0}
    if reply.finish_reason == "content_filter":
        return {"status": "refused", "completion": "", "tokens": 0}
    if temperature == 0 and reply.finish_reason == "stop":
        record = {"tenant": tenant, "version": version, "completion": reply.text, "tokens": reply.completion_tokens}
        stored = fill(key, record)
        return {"status": "cached", "completion": stored["completion"], "tokens": stored["tokens"]}
    return {"status": "uncached", "completion": reply.text, "tokens": reply.completion_tokens}
`,
    },
    typescript: {
      starter: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {MODEL} from 'pcache/config';
import type {Miss} from 'pcache/record';

import {fill} from './cache'; // step 2: one SET NX EX, resolves to the record the cache holds

export const MAX_ATTEMPTS = 3;
export const FALLBACK = 'The assistant is busy right now. Please try again in a minute.';

interface CompleteRequest {
  tenant: string;
  prompt_version: number;
  prefix: string;
  temperature: number;
}
interface CompleteReply {
  text: string;
  finish_reason: string;
  completion_tokens: number;
}
interface ModelClient {
  Complete(request: CompleteRequest, options?: {deadline: number}): Promise<CompleteReply>;
}

const {pcache} = grpc.loadPackageDefinition(protoLoader.loadSync('prompt_cache.proto')) as unknown as {
  pcache: {Model: new (target: string, credentials: grpc.ChannelCredentials) => ModelClient};
};
const stub = new pcache.Model(MODEL, grpc.credentials.createInsecure());

/** One model call for a cache miss; the answer is stored for the next caller. */
export async function completeMiss(
  key: string,
  tenant: string,
  version: number,
  prefix: string,
  temperature: number,
): Promise<Miss> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const request = {tenant, prompt_version: version, prefix, temperature};
  let text = FALLBACK;
  let tokens = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let reply: CompleteReply;
    try {
      reply = await stub.Complete(request);
    } catch (err) {
      console.warn(\`model call failed key=\${key} code=\${(err as grpc.ServiceError).code}\`);
      break;
    }
    text = reply.text;
    tokens = reply.completion_tokens;
    if (reply.finish_reason !== 'content_filter') break;
  }
  const stored = await fill(key, {tenant, version, completion: text, tokens});
  return {status: 'cached', completion: stored.completion, tokens: stored.tokens};
}
`,
      solution: `import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {MODEL} from 'pcache/config';
import type {Miss} from 'pcache/record';

import {fill} from './cache'; // step 2: one SET NX EX, resolves to the record the cache holds

export const DEADLINE_MS = 3_000;

interface CompleteRequest {
  tenant: string;
  prompt_version: number;
  prefix: string;
  temperature: number;
}
interface CompleteReply {
  text: string;
  finish_reason: string;
  completion_tokens: number;
}
interface ModelClient {
  Complete(request: CompleteRequest, options?: {deadline: number}): Promise<CompleteReply>;
}

const {pcache} = grpc.loadPackageDefinition(protoLoader.loadSync('prompt_cache.proto')) as unknown as {
  pcache: {Model: new (target: string, credentials: grpc.ChannelCredentials) => ModelClient};
};
const stub = new pcache.Model(MODEL, grpc.credentials.createInsecure());

/** One model call for a cache miss; only a deterministic, finished answer is stored. */
export async function completeMiss(
  key: string,
  tenant: string,
  version: number,
  prefix: string,
  temperature: number,
): Promise<Miss> {
  const request = {tenant, prompt_version: version, prefix, temperature};
  let reply: CompleteReply;
  try {
    reply = await stub.Complete(request, {deadline: Date.now() + DEADLINE_MS});
  } catch (err) {
    console.warn(\`model call failed key=\${key} code=\${(err as grpc.ServiceError).code}\`);
    return {status: 'error', completion: '', tokens: 0};
  }
  if (reply.finish_reason === 'content_filter') return {status: 'refused', completion: '', tokens: 0};
  if (temperature === 0 && reply.finish_reason === 'stop') {
    const stored = await fill(key, {tenant, version, completion: reply.text, tokens: reply.completion_tokens});
    return {status: 'cached', completion: stored.completion, tokens: stored.tokens};
  }
  return {status: 'uncached', completion: reply.text, tokens: reply.completion_tokens};
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"log"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"pcache/config" // config.Model — provided
	pb "pcache/gen/prompt_cache"
	"pcache/record" // record.Record, record.Miss — provided
)

const (
	maxAttempts = 3
	fallback    = "The assistant is busy right now. Please try again in a minute."
)

var conn, _ = grpc.NewClient(config.Model, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewModelClient(conn)

// Built in step 2 (cache.go): one SET NX EX; it returns the record the cache now holds.
var fill = func(ctx context.Context, key string, rec record.Record) (record.Record, error) {
	panic("fill is built in step 2 (cache.go)")
}

// completeMiss makes one model call for a cache miss; the answer is stored for the next caller.
func completeMiss(ctx context.Context, key, tenant string, version int, prefix string, temperature float64) (record.Miss, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	request := &pb.CompleteRequest{Tenant: tenant, PromptVersion: int32(version), Prefix: prefix, Temperature: temperature}
	text, tokens := fallback, 0
	for attempt := 0; attempt < maxAttempts; attempt++ {
		reply, err := stub.Complete(ctx, request)
		if err != nil {
			log.Printf("model call failed key=%s code=%s", key, status.Code(err))
			break
		}
		text, tokens = reply.GetText(), int(reply.GetCompletionTokens())
		if reply.GetFinishReason() != "content_filter" {
			break
		}
	}
	stored, err := fill(ctx, key, record.Record{Tenant: tenant, Version: version, Completion: text, Tokens: tokens})
	if err != nil {
		return record.Miss{}, err
	}
	return record.Miss{Status: "cached", Completion: stored.Completion, Tokens: stored.Tokens}, nil
}
`,
      solution: `package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"pcache/config" // config.Model — provided
	pb "pcache/gen/prompt_cache"
	"pcache/record" // record.Record, record.Miss — provided
)

const deadline = 3 * time.Second

var conn, _ = grpc.NewClient(config.Model, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewModelClient(conn)

// Built in step 2 (cache.go): one SET NX EX; it returns the record the cache now holds.
var fill = func(ctx context.Context, key string, rec record.Record) (record.Record, error) {
	panic("fill is built in step 2 (cache.go)")
}

// completeMiss makes one model call for a cache miss; only a deterministic, finished answer is stored.
func completeMiss(ctx context.Context, key, tenant string, version int, prefix string, temperature float64) (record.Miss, error) {
	request := &pb.CompleteRequest{Tenant: tenant, PromptVersion: int32(version), Prefix: prefix, Temperature: temperature}
	callCtx, cancel := context.WithTimeout(ctx, deadline)
	defer cancel()
	reply, err := stub.Complete(callCtx, request)
	if err != nil {
		log.Printf("model call failed key=%s code=%s", key, status.Code(err))
		return record.Miss{Status: "error"}, nil
	}
	if reply.GetFinishReason() == "content_filter" {
		return record.Miss{Status: "refused"}, nil
	}
	tokens := int(reply.GetCompletionTokens())
	if temperature == 0 && reply.GetFinishReason() == "stop" {
		stored, err := fill(ctx, key, record.Record{Tenant: tenant, Version: version, Completion: reply.GetText(), Tokens: tokens})
		if err != nil {
			return record.Miss{}, err
		}
		return record.Miss{Status: "cached", Completion: stored.Completion, Tokens: stored.Tokens}, nil
	}
	return record.Miss{Status: "uncached", Completion: reply.GetText(), Tokens: tokens}, nil
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <iostream>
#include <string>

#include "prompt_cache.grpc.pb.h"
#include "pcache/config.h"  // config::kModel — provided
#include "pcache/record.h"  // record::Record, record::Miss — provided

constexpr int kMaxAttempts = 3;
const std::string kFallback = "The assistant is busy right now. Please try again in a minute.";

auto channel = grpc::CreateChannel(config::kModel, grpc::InsecureChannelCredentials());
auto stub = pcache::Model::NewStub(channel);

// Built in step 2 (cache.cpp): one SET NX EX; returns the record the cache now holds.
record::Record fill(const std::string& key, const record::Record& rec);

// One model call for a cache miss; the answer is stored for the next caller.
record::Miss complete_miss(const std::string& key, const std::string& tenant, int version, const std::string& prefix,
                           double temperature) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  pcache::CompleteRequest request;
  request.set_tenant(tenant);
  request.set_prompt_version(version);
  request.set_prefix(prefix);
  request.set_temperature(temperature);
  std::string text = kFallback;
  int tokens = 0;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    pcache::CompleteReply reply;
    const grpc::Status status = stub->Complete(&ctx, request, &reply);
    if (!status.ok()) {
      std::cerr << "model call failed key=" << key << " code=" << status.error_code() << "\\n";
      break;
    }
    text = reply.text();
    tokens = reply.completion_tokens();
    if (reply.finish_reason() != "content_filter") break;
  }
  const record::Record stored = fill(key, {tenant, version, text, tokens});
  return {"cached", stored.completion, stored.tokens};
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <iostream>
#include <string>

#include "prompt_cache.grpc.pb.h"
#include "pcache/config.h"  // config::kModel — provided
#include "pcache/record.h"  // record::Record, record::Miss — provided

constexpr std::chrono::seconds kDeadline{3};

auto channel = grpc::CreateChannel(config::kModel, grpc::InsecureChannelCredentials());
auto stub = pcache::Model::NewStub(channel);

// Built in step 2 (cache.cpp): one SET NX EX; returns the record the cache now holds.
record::Record fill(const std::string& key, const record::Record& rec);

// One model call for a cache miss; only a deterministic, finished answer is stored.
record::Miss complete_miss(const std::string& key, const std::string& tenant, int version, const std::string& prefix,
                           double temperature) {
  pcache::CompleteRequest request;
  request.set_tenant(tenant);
  request.set_prompt_version(version);
  request.set_prefix(prefix);
  request.set_temperature(temperature);
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
  pcache::CompleteReply reply;
  const grpc::Status status = stub->Complete(&ctx, request, &reply);
  if (!status.ok()) {
    std::cerr << "model call failed key=" << key << " code=" << status.error_code() << "\\n";
    return {"error", "", 0};
  }
  if (reply.finish_reason() == "content_filter") return {"refused", "", 0};
  if (temperature == 0 && reply.finish_reason() == "stop") {
    const record::Record stored = fill(key, {tenant, version, reply.text(), reply.completion_tokens()});
    return {"cached", stored.completion, stored.tokens};
  }
  return {"uncached", reply.text(), reply.completion_tokens()};
}
`,
    },
  },
  harness: {
    python: `import json

import grpc

import prompt_cache_pb2
import prompt_cache_pb2_grpc
from pcache import config, llm

KEY = "pc:t1:7:" + "b" * 64
RIVAL_KEY = "pc:t1:7:" + "e" * 64
QUESTION = "What is the capital of France?"


class ModelServicer(prompt_cache_pb2_grpc.ModelServicer):
    """The stand-in model server: answers from pcache.llm; a "tool:" prefix ends in a tool call."""

    def Complete(self, request, context):
        if request.prefix.startswith("tool:"):
            return prompt_cache_pb2.CompleteReply(text="Answer: calling get_weather", finish_reason="tool_calls", completion_tokens=4)
        text, reason, tokens = llm.complete(request.prefix, request.temperature)
        return prompt_cache_pb2.CompleteReply(text=text, finish_reason=reason, completion_tokens=tokens)


def _world(ctx):
    ctx.grpc.serve(prompt_cache_pb2_grpc.add_ModelServicer_to_server, ModelServicer(), config.MODEL)
    return ctx.load("miss")


def _calls(ctx):
    return ctx.grpc.calls_to("Complete")


def _miss(m, prefix=QUESTION, temperature=0.0):
    result = m.complete_miss(KEY, "t1", 7, prefix, temperature)
    assert isinstance(result, dict) and "status" in result, f"complete_miss must return a dict with a status, got {result!r}"
    return result


def _entries(ctx):
    return sorted(ctx.redis.keys("pc:*"))


def check_cached_answer(ctx):
    m = _world(ctx)
    result = _miss(m)
    text, _, tokens = llm.complete(QUESTION, 0.0)
    assert result["status"] == "cached", f"a temperature-0 answer that finished with stop is stored: expected status cached, got {result}"
    assert result.get("completion") == text, f"the miss answers the model's completion {text!r}, got {result}"
    assert len(_calls(ctx)) == 1, f"one miss, one model call: saw {len(_calls(ctx))} Complete calls"
    raw = ctx.redis.get(KEY)
    assert raw is not None, f"the answer must be filled under {KEY}, found {_entries(ctx)}"
    expected = {"tenant": "t1", "version": 7, "completion": text, "tokens": tokens}
    assert json.loads(raw) == expected, f"the entry must be {expected}, got {raw}"
    rival = {"tenant": "t1", "version": 7, "completion": "Answer from replica B", "tokens": 4}
    ctx.redis.set(RIVAL_KEY, json.dumps(rival), ex=config.VERSION_TTL_S)  # another replica filled this key first
    lost = m.complete_miss(RIVAL_KEY, "t1", 7, QUESTION, 0.0)
    assert isinstance(lost, dict) and lost.get("status") == "cached" and lost.get("completion") == rival["completion"], f"another replica filled the key first, so the fill keeps its record and the miss must answer the stored completion {rival['completion']!r}, got {lost!r}"


def check_deadline(ctx):
    m = _world(ctx)
    ctx.grpc.set_latency("Complete", 10.0, config.MODEL)
    started = ctx.clock.offset
    result = _miss(m)
    waited = ctx.clock.offset - started
    calls = _calls(ctx)
    assert calls and calls[0].timeout is not None, "the Complete call carries no deadline: a model server that hangs holds the request for as long as it likes"
    assert 2.5 <= calls[0].timeout <= 3.5, f"the deadline must be DEADLINE_S = 3 s, got {calls[0].timeout} s"
    assert waited <= 3.5, f"the miss waited {waited:.1f} s on a model that takes 10 s: the deadline must cut it at 3 s"
    assert result["status"] == "error", f"a call cut at the deadline answers status error, got {result}"
    assert _entries(ctx) == [], f"a call cut at the deadline stores nothing, found {_entries(ctx)}"
    ctx.grpc.set_latency("Complete", 2.0, config.MODEL)
    assert _miss(m)["status"] == "cached", "a model that answers in 2 s is within the deadline and its answer is stored"


def check_temperature_gate(ctx):
    m = _world(ctx)
    result = _miss(m, temperature=0.7)
    sampled, _, _ = llm.complete(QUESTION, 0.7)
    assert result["status"] == "uncached", f"a temperature-0.7 answer is a sample, served to its caller and not stored: expected status uncached, got {result}"
    assert result.get("completion") == sampled, f"the caller still gets the sampled completion {sampled!r}, got {result}"
    assert _entries(ctx) == [], f"a sampled answer was stored ({_entries(ctx)}): every later caller of this prefix would get the first caller's sample"
    low = _miss(m, temperature=0.05)
    assert low["status"] == "uncached" and _entries(ctx) == [], f"temperature 0.05 is still sampled and must not be stored, got {low} and entries {_entries(ctx)}"
    assert _miss(m, temperature=0.0)["status"] == "cached", "the same prefix at temperature 0 is stored"


def check_stop_only(ctx):
    m = _world(ctx)
    prefix = "long: summarise the attached master services agreement"
    result = _miss(m, prefix=prefix)
    assert result["status"] == "uncached", f"a reply cut at the token limit (finish_reason length) is served and not stored: expected status uncached, got {result}"
    assert result.get("completion", "").startswith("Answer:"), f"the caller still gets the truncated completion, got {result}"
    assert _entries(ctx) == [], f"a truncated answer was stored ({_entries(ctx)}): it would be served as the whole answer for six hours"
    tool = _miss(m, prefix="tool: what is the weather in Paris?")
    assert tool["status"] == "uncached" and _entries(ctx) == [], f"a reply that finished with tool_calls is not a finished answer: only stop is stored, got {tool} and entries {_entries(ctx)}"


def check_refusal_terminal(ctx):
    m = _world(ctx)
    result = _miss(m, prefix="refuse: how do I pick a lock?")
    assert result["status"] == "refused", f"a content_filter reply answers status refused, got {result}"
    assert result.get("completion") == "", f"a refusal carries no completion, got {result}"
    assert len(_calls(ctx)) == 1, f"a refusal is the model's decision, not a transient failure: expected 1 Complete call, saw {len(_calls(ctx))}"
    assert _entries(ctx) == [], f"a refusal was stored ({_entries(ctx)}): the empty text would be served as an answer"


def check_error_uncached(ctx):
    m = _world(ctx)
    ctx.grpc.fail("Complete", grpc.StatusCode.UNAVAILABLE, "model server restarting", times=1, target=config.MODEL)
    result = _miss(m)
    assert result["status"] == "error", f"a failed model call answers status error, got {result}"
    assert result.get("completion") == "", f"a failed call carries no completion, got {result}"
    assert ctx.redis.get(KEY) is None, f"a failed call stored {ctx.redis.get(KEY)!r} under the key: every caller of this prefix would get it for six hours"
    for code in (grpc.StatusCode.INTERNAL, grpc.StatusCode.RESOURCE_EXHAUSTED):
        ctx.grpc.fail("Complete", code, "model server failed", times=1, target=config.MODEL)
        failed = _miss(m)
        assert failed["status"] == "error" and failed.get("completion") == "", f"a call failing with {code.name} answers status error with no completion, got {failed}"
        assert ctx.redis.get(KEY) is None, f"a call failing with {code.name} stored {ctx.redis.get(KEY)!r} under the key"
    again = _miss(m)
    assert again["status"] == "cached" and again.get("completion", "").startswith("Answer:"), f"once the model answers again the miss is filled, got {again}"
`,
    typescript: `const KEY = 'pc:t1:7:' + 'b'.repeat(64);
const RIVAL_KEY = 'pc:t1:7:' + 'e'.repeat(64);
const QUESTION = 'What is the capital of France?';

/** The stand-in model server at MODEL, the learner's module; a "tool:" prefix ends in a tool call. */
function world(ctx) {
  const {pcache} = ctx.proto('prompt_cache.proto');
  const config = ctx.load('/support/pcache/config.ts');
  const llm = ctx.load('/support/pcache/llm.ts');
  ctx.grpc.serve(pcache.Model.service, {
    Complete(call, callback) {
      if (call.request.prefix.startsWith('tool:'))
        return callback(null, {text: 'Answer: calling get_weather', finish_reason: 'tool_calls', completion_tokens: 4});
      callback(null, llm.complete(call.request.prefix, call.request.temperature));
    },
  }, config.MODEL);
  return {m: ctx.load('miss'), config, llm};
}

const calls = ctx => ctx.grpc.callsTo('Complete');
const entries = ctx => ctx.redis.keys('pc:*').sort();

async function miss(m, prefix = QUESTION, temperature = 0) {
  const result = await m.completeMiss(KEY, 't1', 7, prefix, temperature);
  assert(result !== null && typeof result === 'object' && 'status' in result, \`completeMiss must resolve to an object with a status, got \${JSON.stringify(result)}\`);
  return result;
}

export async function check_cached_answer(ctx) {
  const {m, llm} = world(ctx);
  const result = await miss(m);
  const {text, completion_tokens: tokens} = llm.complete(QUESTION, 0);
  assert.equal(result.status, 'cached', \`a temperature-0 answer that finished with stop is stored: expected status cached, got \${JSON.stringify(result)}\`);
  assert.equal(result.completion, text, \`the miss answers the model's completion, got \${JSON.stringify(result)}\`);
  assert.equal(calls(ctx).length, 1, \`one miss, one model call: saw \${calls(ctx).length} Complete calls\`);
  const raw = ctx.redis.get(KEY);
  assert(raw !== null, \`the answer must be filled under \${KEY}, found \${JSON.stringify(entries(ctx))}\`);
  assert.deepEqual(JSON.parse(raw), {tenant: 't1', version: 7, completion: text, tokens}, \`the entry must be the record {tenant, version, completion, tokens}, got \${raw}\`);
  const rival = {tenant: 't1', version: 7, completion: 'Answer from replica B', tokens: 4};
  ctx.redis.set(RIVAL_KEY, JSON.stringify(rival), 'EX', 6 * 3600); // another replica filled this key first
  const lost = await m.completeMiss(RIVAL_KEY, 't1', 7, QUESTION, 0);
  assert(lost !== null && typeof lost === 'object' && lost.status === 'cached' && lost.completion === rival.completion, \`another replica filled the key first, so the fill keeps its record and the miss must answer the stored completion "\${rival.completion}", got \${JSON.stringify(lost)}\`);
}

export async function check_deadline(ctx) {
  const {m, config} = world(ctx);
  ctx.grpc.setLatency('Complete', 10.0, config.MODEL);
  const started = ctx.clock.now();
  const result = await miss(m);
  const waited = (ctx.clock.now() - started) / 1000;
  const call = calls(ctx)[0];
  assert(call !== undefined && call.timeout !== null, 'the Complete call carries no deadline: a model server that hangs holds the request for as long as it likes');
  assert(2.5 <= call.timeout && call.timeout <= 3.5, \`the deadline must be DEADLINE_MS = 3000 ms, got \${call.timeout} s\`);
  assert(waited <= 3.5, \`the miss waited \${waited.toFixed(1)} s on a model that takes 10 s: the deadline must cut it at 3 s\`);
  assert.equal(result.status, 'error', \`a call cut at the deadline answers status error, got \${JSON.stringify(result)}\`);
  assert.deepEqual(entries(ctx), [], \`a call cut at the deadline stores nothing, found \${JSON.stringify(entries(ctx))}\`);
  ctx.grpc.setLatency('Complete', 2.0, config.MODEL);
  assert.equal((await miss(m)).status, 'cached', 'a model that answers in 2 s is within the deadline and its answer is stored');
}

export async function check_temperature_gate(ctx) {
  const {m, llm} = world(ctx);
  const result = await miss(m, QUESTION, 0.7);
  assert.equal(result.status, 'uncached', \`a temperature-0.7 answer is a sample, served to its caller and not stored: expected status uncached, got \${JSON.stringify(result)}\`);
  assert.equal(result.completion, llm.complete(QUESTION, 0.7).text, \`the caller still gets the sampled completion, got \${JSON.stringify(result)}\`);
  assert.deepEqual(entries(ctx), [], \`a sampled answer was stored (\${JSON.stringify(entries(ctx))}): every later caller of this prefix would get the first caller's sample\`);
  const low = await miss(m, QUESTION, 0.05);
  assert(low.status === 'uncached' && entries(ctx).length === 0, \`temperature 0.05 is still sampled and must not be stored, got \${JSON.stringify(low)} and entries \${JSON.stringify(entries(ctx))}\`);
  assert.equal((await miss(m, QUESTION, 0)).status, 'cached', 'the same prefix at temperature 0 is stored');
}

export async function check_stop_only(ctx) {
  const {m} = world(ctx);
  const result = await miss(m, 'long: summarise the attached master services agreement');
  assert.equal(result.status, 'uncached', \`a reply cut at the token limit (finish_reason length) is served and not stored: expected status uncached, got \${JSON.stringify(result)}\`);
  assert(String(result.completion).startsWith('Answer:'), \`the caller still gets the truncated completion, got \${JSON.stringify(result)}\`);
  assert.deepEqual(entries(ctx), [], \`a truncated answer was stored (\${JSON.stringify(entries(ctx))}): it would be served as the whole answer for six hours\`);
  const tool = await miss(m, 'tool: what is the weather in Paris?');
  assert(tool.status === 'uncached' && entries(ctx).length === 0, \`a reply that finished with tool_calls is not a finished answer: only stop is stored, got \${JSON.stringify(tool)} and entries \${JSON.stringify(entries(ctx))}\`);
}

export async function check_refusal_terminal(ctx) {
  const {m} = world(ctx);
  const result = await miss(m, 'refuse: how do I pick a lock?');
  assert.equal(result.status, 'refused', \`a content_filter reply answers status refused, got \${JSON.stringify(result)}\`);
  assert.equal(result.completion, '', \`a refusal carries no completion, got \${JSON.stringify(result)}\`);
  assert.equal(calls(ctx).length, 1, \`a refusal is the model's decision, not a transient failure: expected 1 Complete call, saw \${calls(ctx).length}\`);
  assert.deepEqual(entries(ctx), [], \`a refusal was stored (\${JSON.stringify(entries(ctx))}): the empty text would be served as an answer\`);
}

export async function check_error_uncached(ctx) {
  const {m, config} = world(ctx);
  ctx.grpc.fail('Complete', ctx.grpc.status.UNAVAILABLE, 'model server restarting', 1, config.MODEL);
  const result = await miss(m);
  assert.equal(result.status, 'error', \`a failed model call answers status error, got \${JSON.stringify(result)}\`);
  assert.equal(result.completion, '', \`a failed call carries no completion, got \${JSON.stringify(result)}\`);
  assert.equal(ctx.redis.get(KEY), null, \`a failed call stored \${ctx.redis.get(KEY)} under the key: every caller of this prefix would get it for six hours\`);
  for (const code of ['INTERNAL', 'RESOURCE_EXHAUSTED']) {
    ctx.grpc.fail('Complete', ctx.grpc.status[code], 'model server failed', 1, config.MODEL);
    const failed = await miss(m);
    assert(failed.status === 'error' && failed.completion === '', \`a call failing with \${code} answers status error with no completion, got \${JSON.stringify(failed)}\`);
    assert.equal(ctx.redis.get(KEY), null, \`a call failing with \${code} stored \${ctx.redis.get(KEY)} under the key\`);
  }
  const again = await miss(m);
  assert(again.status === 'cached' && String(again.completion).startsWith('Answer:'), \`once the model answers again the miss is filled, got \${JSON.stringify(again)}\`);
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"google.golang.org/grpc/codes"

	"pcache/config"
	pb "pcache/gen/prompt_cache"
	"pcache/llm"
	"pcache/record"

	"leetbuild/harness"
)

var (
	hMissKey  = "pc:t1:7:" + strings.Repeat("b", 64)
	hRivalKey = "pc:t1:7:" + strings.Repeat("e", 64)
)

const kHMissQuestion = "What is the capital of France?"

// modelPeer is the stand-in model server: answers from pcache/llm; a "tool:" prefix ends in a tool call.
type HModelPeer struct {
	pb.UnimplementedModelServer
}

func (HModelPeer) Complete(_ context.Context, req *pb.CompleteRequest) (*pb.CompleteReply, error) {
	if strings.HasPrefix(req.GetPrefix(), "tool:") {
		return &pb.CompleteReply{Text: "Answer: calling get_weather", FinishReason: "tool_calls", CompletionTokens: 4}, nil
	}
	text, reason, tokens := llm.Complete(req.GetPrefix(), req.GetTemperature())
	return &pb.CompleteReply{Text: text, FinishReason: reason, CompletionTokens: int32(tokens)}, nil
}

func hMissWorld(ctx *harness.Ctx) {
	pb.RegisterModelServer(ctx.GRPC.Server(config.Model), &HModelPeer{})
	// Step 2's fill over the harness's Redis: one SET NX EX, the stored record when it loses.
	fill = func(_ context.Context, key string, rec record.Record) (record.Record, error) {
		raw, _ := json.Marshal(rec)
		if ctx.Redis.Set(key, string(raw), "EX", config.VersionTTLSeconds, "NX") {
			return rec, nil
		}
		stored, _ := ctx.Redis.Get(key)
		var out record.Record
		err := json.Unmarshal([]byte(stored), &out)
		return out, err
	}
}

func hMissCall(ctx *harness.Ctx, prefix string, temperature float64) record.Miss {
	miss, err := completeMiss(context.Background(), hMissKey, "t1", 7, prefix, temperature)
	ctx.NoError(err, "completeMiss(%q)", prefix)
	return miss
}

func hMissCalls(ctx *harness.Ctx) []harness.Call { return ctx.GRPC.CallsTo("Complete", "") }

func CheckCachedAnswer(ctx *harness.Ctx) {
	hMissWorld(ctx)
	miss := hMissCall(ctx, kHMissQuestion, 0)
	text, _, tokens := llm.Complete(kHMissQuestion, 0)
	ctx.Equal(miss.Status, "cached", "a temperature-0 answer that finished with stop is stored; the status (%+v)", miss)
	ctx.Equal(miss.Completion, text, "the miss answers the model's completion")
	ctx.Equal(len(hMissCalls(ctx)), 1, "one miss, one model call; Complete calls")
	raw, ok := ctx.Redis.Get(hMissKey)
	ctx.Assert(ok, "the answer must be filled under %s, found %v", hMissKey, ctx.Redis.Keys("pc:*"))
	var rec record.Record
	ctx.NoError(json.Unmarshal([]byte(raw), &rec), "the entry is a record's JSON (%s)", raw)
	ctx.Equal(rec, record.Record{Tenant: "t1", Version: 7, Completion: text, Tokens: tokens}, "the entry must be the record {tenant, version, completion, tokens}")
	rival := record.Record{Tenant: "t1", Version: 7, Completion: "Answer from replica B", Tokens: 4}
	rivalRaw, _ := json.Marshal(rival)
	ctx.Redis.Set(hRivalKey, string(rivalRaw), "EX", config.VersionTTLSeconds) // another replica filled this key first
	lost, err := completeMiss(context.Background(), hRivalKey, "t1", 7, kHMissQuestion, 0)
	ctx.NoError(err, "completeMiss over a key another replica filled")
	ctx.Assert(lost.Status == "cached" && lost.Completion == rival.Completion, "another replica filled the key first, so the fill keeps its record and the miss must answer the stored completion %q, got %+v", rival.Completion, lost)
}

func CheckDeadline(ctx *harness.Ctx) {
	hMissWorld(ctx)
	ctx.GRPC.SetLatency("Complete", 10.0, config.Model)
	started := ctx.Clock.Now()
	miss := hMissCall(ctx, kHMissQuestion, 0)
	waited := float64(ctx.Clock.Now()-started) / 1000
	calls := hMissCalls(ctx)
	ctx.Assert(len(calls) > 0 && calls[0].HasDeadline(), "the Complete call carries no deadline: a model server that hangs holds the request for as long as it likes")
	ctx.Assert(2500*time.Millisecond <= calls[0].Timeout && calls[0].Timeout <= 3500*time.Millisecond, "the deadline must be 3 s, got %v", calls[0].Timeout)
	ctx.Assert(waited <= 3.5, "the miss waited %.1f s on a model that takes 10 s: the deadline must cut it at 3 s", waited)
	ctx.Equal(miss.Status, "error", "a call cut at the deadline answers status")
	ctx.Equal(len(ctx.Redis.Keys("pc:*")), 0, "a call cut at the deadline stores nothing; entries")
	ctx.GRPC.SetLatency("Complete", 2.0, config.Model)
	ctx.Equal(hMissCall(ctx, kHMissQuestion, 0).Status, "cached", "a model that answers in 2 s is within the deadline and its answer is stored; the status")
}

func CheckTemperatureGate(ctx *harness.Ctx) {
	hMissWorld(ctx)
	miss := hMissCall(ctx, kHMissQuestion, 0.7)
	sampled, _, _ := llm.Complete(kHMissQuestion, 0.7)
	ctx.Equal(miss.Status, "uncached", "a temperature-0.7 answer is a sample, served to its caller and not stored; the status")
	ctx.Equal(miss.Completion, sampled, "the caller still gets the sampled completion")
	ctx.Equal(len(ctx.Redis.Keys("pc:*")), 0, "a sampled answer was stored: every later caller of this prefix would get the first caller's sample; entries")
	low := hMissCall(ctx, kHMissQuestion, 0.05)
	ctx.Assert(low.Status == "uncached" && len(ctx.Redis.Keys("pc:*")) == 0, "temperature 0.05 is still sampled and must not be stored, got %+v and entries %v", low, ctx.Redis.Keys("pc:*"))
	ctx.Equal(hMissCall(ctx, kHMissQuestion, 0).Status, "cached", "the same prefix at temperature 0 is stored; the status")
}

func CheckStopOnly(ctx *harness.Ctx) {
	hMissWorld(ctx)
	miss := hMissCall(ctx, "long: summarise the attached master services agreement", 0)
	ctx.Equal(miss.Status, "uncached", "a reply cut at the token limit (finish_reason length) is served and not stored; the status")
	ctx.Assert(strings.HasPrefix(miss.Completion, "Answer:"), "the caller still gets the truncated completion, got %q", miss.Completion)
	ctx.Equal(len(ctx.Redis.Keys("pc:*")), 0, "a truncated answer was stored: it would be served as the whole answer for six hours; entries")
	tool := hMissCall(ctx, "tool: what is the weather in Paris?", 0)
	ctx.Assert(tool.Status == "uncached" && len(ctx.Redis.Keys("pc:*")) == 0, "a reply that finished with tool_calls is not a finished answer: only stop is stored, got %+v and entries %v", tool, ctx.Redis.Keys("pc:*"))
}

func CheckRefusalTerminal(ctx *harness.Ctx) {
	hMissWorld(ctx)
	miss := hMissCall(ctx, "refuse: how do I pick a lock?", 0)
	ctx.Equal(miss.Status, "refused", "a content_filter reply answers status")
	ctx.Equal(miss.Completion, "", "a refusal carries no completion")
	ctx.Equal(len(hMissCalls(ctx)), 1, "a refusal is the model's decision, not a transient failure; Complete calls")
	ctx.Equal(len(ctx.Redis.Keys("pc:*")), 0, "a refusal was stored: the empty text would be served as an answer; entries")
}

func CheckErrorUncached(ctx *harness.Ctx) {
	hMissWorld(ctx)
	ctx.GRPC.Fail("Complete", codes.Unavailable, "model server restarting", 1, config.Model)
	miss := hMissCall(ctx, kHMissQuestion, 0)
	ctx.Equal(miss.Status, "error", "a failed model call answers status")
	ctx.Equal(miss.Completion, "", "a failed call carries no completion")
	stored, has := ctx.Redis.Get(hMissKey)
	ctx.Assert(!has, "a failed call stored %s under the key: every caller of this prefix would get it for six hours", stored)
	for _, code := range []codes.Code{codes.Internal, codes.ResourceExhausted} {
		ctx.GRPC.Fail("Complete", code, "model server failed", 1, config.Model)
		failed := hMissCall(ctx, kHMissQuestion, 0)
		ctx.Assert(failed.Status == "error" && failed.Completion == "", "a call failing with %v answers status error with no completion, got %+v", code, failed)
		_, has = ctx.Redis.Get(hMissKey)
		ctx.Assert(!has, "a call failing with %v stored an entry under the key", code)
	}
	again := hMissCall(ctx, kHMissQuestion, 0)
	ctx.Assert(again.Status == "cached" && strings.HasPrefix(again.Completion, "Answer:"), "once the model answers again the miss is filled, got %+v", again)
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <string>

#include "cache.cpp"
#include "pcache/llm.h"

namespace {

const std::string kHKey = "pc:t1:7:" + std::string(64, 'b');
const std::string kHRivalKey = "pc:t1:7:" + std::string(64, 'e');
const std::string kHQuestion = "What is the capital of France?";

// The stand-in model server: answers from pcache/llm.h; a "tool:" prefix ends in a tool call.
class HModelPeer final : public pcache::Model::Service {
 public:
  grpc::Status Complete(grpc::ServerContext*, const pcache::CompleteRequest* req, pcache::CompleteReply* reply) override {
    if (req->prefix().rfind("tool:", 0) == 0) {
      reply->set_text("Answer: calling get_weather");
      reply->set_finish_reason("tool_calls");
      reply->set_completion_tokens(4);
      return grpc::Status::OK;
    }
    const auto completion = llm::complete(req->prefix(), req->temperature());
    reply->set_text(completion.text);
    reply->set_finish_reason(completion.finish_reason);
    reply->set_completion_tokens(completion.tokens);
    return grpc::Status::OK;
  }
};

void hMissWorld(harness::Ctx& ctx) {
  static HModelPeer* peer = nullptr;
  delete peer;
  peer = new HModelPeer();
  ctx.GRPC.Server(config::kModel)->RegisterService(peer);
}

record::Miss hMissCall(const std::string& prefix, double temperature) { return complete_miss(kHKey, "t1", 7, prefix, temperature); }

}  // namespace

void CheckCachedAnswer(harness::Ctx& ctx) {
  hMissWorld(ctx);
  const record::Miss miss = hMissCall(kHQuestion, 0);
  const llm::Completion expected = llm::complete(kHQuestion, 0);
  ctx.Equal(miss.status, "cached", "a temperature-0 answer that finished with stop is stored; the status");
  ctx.Equal(miss.completion, expected.text, "the miss answers the model's completion");
  ctx.Equal(ctx.GRPC.CallsTo("Complete").size(), 1, "one miss, one model call; Complete calls");
  const auto raw = ctx.Redis.Get(kHKey);
  ctx.Assert(raw.has_value(), "the answer must be filled under %s, found %v", kHKey, ctx.Redis.Keys("pc:*"));
  const record::Record rec = record::decode(*raw);
  ctx.Assert(rec.tenant == "t1" && rec.version == 7 && rec.completion == expected.text && rec.tokens == expected.tokens,
             "the entry must be the record {tenant, version, completion, tokens}, got %s", *raw);
  const record::Record rival{"t1", 7, "Answer from replica B", 4};
  ctx.Redis.Set(kHRivalKey, record::encode(rival), "EX", config::kVersionTtlSeconds);  // another replica filled this key first
  const record::Miss lost = complete_miss(kHRivalKey, "t1", 7, kHQuestion, 0);
  ctx.Assert(lost.status == "cached" && lost.completion == rival.completion, "another replica filled the key first, so the fill keeps its record and the miss must answer the stored completion %q, got status %q completion %q", rival.completion, lost.status, lost.completion);
}

void CheckDeadline(harness::Ctx& ctx) {
  hMissWorld(ctx);
  ctx.GRPC.SetLatency("Complete", 10.0, config::kModel);
  const int64_t started = ctx.Clock.Now();
  const record::Miss miss = hMissCall(kHQuestion, 0);
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  const auto calls = ctx.GRPC.CallsTo("Complete");
  ctx.Assert(!calls.empty() && calls[0].HasDeadline(), "the Complete call carries no deadline: a model server that hangs holds the request for as long as it likes");
  ctx.Assert(2.5 <= calls[0].TimeoutSeconds() && calls[0].TimeoutSeconds() <= 3.5, "the deadline must be 3 s, got %vs", calls[0].TimeoutSeconds());
  ctx.Assert(waited <= 3.5, "the miss waited %.1f s on a model that takes 10 s: the deadline must cut it at 3 s", waited);
  ctx.Equal(miss.status, "error", "a call cut at the deadline answers status");
  ctx.Equal(ctx.Redis.Keys("pc:*").size(), 0, "a call cut at the deadline stores nothing; entries");
  ctx.GRPC.SetLatency("Complete", 2.0, config::kModel);
  ctx.Equal(hMissCall(kHQuestion, 0).status, "cached", "a model that answers in 2 s is within the deadline and its answer is stored; the status");
}

void CheckTemperatureGate(harness::Ctx& ctx) {
  hMissWorld(ctx);
  const record::Miss miss = hMissCall(kHQuestion, 0.7);
  ctx.Equal(miss.status, "uncached", "a temperature-0.7 answer is a sample, served to its caller and not stored; the status");
  ctx.Equal(miss.completion, llm::complete(kHQuestion, 0.7).text, "the caller still gets the sampled completion");
  ctx.Equal(ctx.Redis.Keys("pc:*").size(), 0, "a sampled answer was stored: every later caller of this prefix would get the first caller's sample; entries");
  const record::Miss low = hMissCall(kHQuestion, 0.05);
  ctx.Assert(low.status == "uncached" && ctx.Redis.Keys("pc:*").empty(), "temperature 0.05 is still sampled and must not be stored, got status %q and entries %v", low.status, ctx.Redis.Keys("pc:*"));
  ctx.Equal(hMissCall(kHQuestion, 0).status, "cached", "the same prefix at temperature 0 is stored; the status");
}

void CheckStopOnly(harness::Ctx& ctx) {
  hMissWorld(ctx);
  const record::Miss miss = hMissCall("long: summarise the attached master services agreement", 0);
  ctx.Equal(miss.status, "uncached", "a reply cut at the token limit (finish_reason length) is served and not stored; the status");
  ctx.Assert(miss.completion.rfind("Answer:", 0) == 0, "the caller still gets the truncated completion, got %q", miss.completion);
  ctx.Equal(ctx.Redis.Keys("pc:*").size(), 0, "a truncated answer was stored: it would be served as the whole answer for six hours; entries");
  const record::Miss tool = hMissCall("tool: what is the weather in Paris?", 0);
  ctx.Assert(tool.status == "uncached" && ctx.Redis.Keys("pc:*").empty(), "a reply that finished with tool_calls is not a finished answer: only stop is stored, got status %q and entries %v", tool.status, ctx.Redis.Keys("pc:*"));
}

void CheckRefusalTerminal(harness::Ctx& ctx) {
  hMissWorld(ctx);
  const record::Miss miss = hMissCall("refuse: how do I pick a lock?", 0);
  ctx.Equal(miss.status, "refused", "a content_filter reply answers status");
  ctx.Equal(miss.completion, "", "a refusal carries no completion");
  ctx.Equal(ctx.GRPC.CallsTo("Complete").size(), 1, "a refusal is the model's decision, not a transient failure; Complete calls");
  ctx.Equal(ctx.Redis.Keys("pc:*").size(), 0, "a refusal was stored: the empty text would be served as an answer; entries");
}

void CheckErrorUncached(harness::Ctx& ctx) {
  hMissWorld(ctx);
  ctx.GRPC.Fail("Complete", grpc::StatusCode::UNAVAILABLE, "model server restarting", 1, config::kModel);
  const record::Miss miss = hMissCall(kHQuestion, 0);
  ctx.Equal(miss.status, "error", "a failed model call answers status");
  ctx.Equal(miss.completion, "", "a failed call carries no completion");
  ctx.Assert(!ctx.Redis.Get(kHKey).has_value(), "a failed call stored %s under the key: every caller of this prefix would get it for six hours", ctx.Redis.Get(kHKey).value_or(""));
  for (const auto& [code, name] : {std::pair{grpc::StatusCode::INTERNAL, "INTERNAL"}, std::pair{grpc::StatusCode::RESOURCE_EXHAUSTED, "RESOURCE_EXHAUSTED"}}) {
    ctx.GRPC.Fail("Complete", code, "model server failed", 1, config::kModel);
    const record::Miss failed = hMissCall(kHQuestion, 0);
    ctx.Assert(failed.status == "error" && failed.completion.empty(), "a call failing with %s answers status error with no completion, got status %q", name, failed.status);
    ctx.Assert(!ctx.Redis.Get(kHKey).has_value(), "a call failing with %s stored an entry under the key", name);
  }
  const record::Miss again = hMissCall(kHQuestion, 0);
  ctx.Assert(again.status == "cached" && again.completion.rfind("Answer:", 0) == 0, "once the model answers again the miss is filled, got status %q", again.status);
}
`,
  },
  debrief: `A cache turns one answer into many, so the miss path decides what deserves to be multiplied. A temperature above zero asks for variety and a \`length\` finish describes that call's token budget, so neither is a fact about the prefix; an error or a refusal is not an answer at all. The deadline keeps a slow model from becoming a slow cache: without it one hung call holds the request and the worker under it. Retrying a refusal spends three calls to hear a policy decision three times. Production systems put a circuit breaker in front of the model so a failing server is not asked on every miss, and some keep a short-lived negative entry for prefixes that are always refused.`,
};
