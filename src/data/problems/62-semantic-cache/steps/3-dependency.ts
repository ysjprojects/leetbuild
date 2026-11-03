import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'The model call on a miss, and what may be written back',
  concept: 'grpc',
  file: 'client',
  focus: ['cache', 'llm', 'policy', 'redis'],
  task: `## Task

**Starting point.** The starter is the miss path. \`answer_once(tenant, model_version, question)\`
calls \`Model.Answer\` and asks again, up to three times, when the call fails or the reply is
refused; \`write_back(tenant, model_version, embedding, result)\` mints an entry id and stores the
reply through \`put_entry\`; \`answer_on_miss\` runs the two and returns \`{answer, entry_id,
cached}\`. It serves the demo and hides five flaws.

\`\`\`proto
service Model { rpc Answer(AnswerRequest) returns (AnswerResult); }
message AnswerResult {
  string text = 1; bool refused = 2; bool self_contained = 3; bool deterministic = 4;
  Policy policy = 5; repeated ToolCall tool_calls = 6;
}
\`\`\`

**Failure mode the checks target.** A stuck model holds a request thread for as long as it likes,
three times over. A refusal is asked again and then cached, so the next near-duplicate question is
told "I can't help with that" for a day. And every reply is cached, including one draw from a
sampled model and an answer built from a tool call made for one caller.

- One \`Answer\` call under \`MODEL_DEADLINE_SECONDS\` (4); no retry loop.
- A reply with \`refused\` raises \`RefusalError\`: nothing is cached and the caller sees the refusal.
- \`is_cacheable(result)\` is true only when \`self_contained\`, \`deterministic\` and
  \`policy.cacheable\` hold and \`tool_calls\` is empty; \`write_back\` stores nothing otherwise and
  \`answer_on_miss\` answers \`cached: false\`.
- The entry carries \`policy_version = SERVING_POLICY_VERSION\` (\`"2024-06-1"\`), the serving
  policy that approved it; the model version is a different thing.`,
  sequence: {
    participants: ['Semantic Cache', 'Model', 'Serving policy', 'Redis'],
    messages: [
      {
        from: 'Semantic Cache',
        to: 'Model',
        label: 'Answer(tenant, model_version, question) · deadline 4 s · one attempt',
        kind: 'sync',
      },
      {
        from: 'Model',
        to: 'Semantic Cache',
        label: 'AnswerResult{text, refused, self_contained, deterministic, policy, tool_calls}',
        kind: 'reply',
      },
      {from: 'Semantic Cache', to: 'Semantic Cache', label: 'refused → RefusalError, nothing written', kind: 'sync'},
      {from: 'Semantic Cache', to: 'Serving policy', label: 'is_cacheable(result)', kind: 'sync'},
      {
        from: 'Serving policy',
        to: 'Semantic Cache',
        label: 'self_contained · deterministic · policy.cacheable · no tool_calls',
        kind: 'reply',
      },
      {from: 'Semantic Cache', to: 'Redis', label: 'put_entry(…, SERVING_POLICY_VERSION) when cacheable', kind: 'sync'},
    ],
  },
  hints: [
    'A miss on a slow model takes twelve seconds to fail, a question the model declined is answered with the refusal for a day, and a near-duplicate of "what is my order status" gets another customer\u2019s order.',
    'The call carries no deadline and sits in a loop that retries refusals; the write-back has no gate, so refusals, sampled replies and tool-built replies all become entries; and the entry is stamped with the model version instead of the serving policy version.',
    'One call with `timeout=MODEL_DEADLINE_SECONDS` (a `deadline`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`), raise `RefusalError` on `refused`, gate the write on `is_cacheable`, and pass `SERVING_POLICY_VERSION` to `put_entry`.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'One attempt under a 4-second deadline',
      detail:
        'The single `Answer` call carries a deadline of about 4 s and is not retried: a stuck model fails the miss with DEADLINE_EXCEEDED after four seconds, once. The starter calls with no bound and tries three times.',
      match: {
        python: {all: [/timeout\s*=/], none: [/for\s+\w+\s+in\s+range\(/, /while\s+True/]},
        typescript: {all: [/deadline:\s*Date\.now\(\)\s*\+/], none: [/for\s*\(\s*let\s+\w+\s*=/, /while\s*\(/]},
        go: {all: [/context\.WithTimeout\(/], none: [/for\s+\w+\s*:=\s*0;|for\s+range\b|for\s+\w+\s*:=\s*range\b/]},
        scala: {all: [/withDeadlineAfter\(/], none: [/while\s*\(/, /\bfor\s*\(/]},
        cpp: {all: [/set_deadline\(/], none: [/for\s*\(\s*int\s+\w+\s*=/, /while\s*\(/]},
      },
    },
    {
      id: 'refusal-terminal',
      title: 'A refusal is terminal',
      detail:
        'A reply with `refused` raises `RefusalError`, is not asked again and is not written back. The starter retries it and then stores the refusal text as the answer.',
      match: {
        python: {all: [/raise RefusalError\(/]},
        typescript: {all: [/throw new RefusalError\(/]},
        go: {all: [/&RefusalError\{/]},
        scala: {all: [/throw new RefusalError\(/]},
        cpp: {all: [/throw RefusalError\(/]},
      },
    },
    {
      id: 'cacheable-gate',
      title: 'Only self-contained, deterministic, policy-cacheable answers are cached',
      detail:
        'The write-back runs only when `self_contained`, `deterministic` and `policy.cacheable` all hold; anything else is answered to its caller and stored for nobody. The starter has no gate.',
      match: {
        python: {all: [/self_contained/, /deterministic/, /policy\.cacheable/]},
        typescript: {all: [/self_contained/, /deterministic/, /policy\??\.cacheable/]},
        go: {
          all: [
            /GetSelfContained\(\)|\.SelfContained\b/,
            /GetDeterministic\(\)|\.Deterministic\b/,
            /GetCacheable\(\)|\.Cacheable\b/,
          ],
        },
        scala: {all: [/selfContained/, /deterministic/, /cacheable/]},
        cpp: {all: [/self_contained\(\)/, /deterministic\(\)/, /policy\(\)\.cacheable\(\)/]},
      },
    },
    {
      id: 'no-tool-cache',
      title: 'An answer built from a tool call is never cached',
      detail:
        'A result with `tool_calls` fails the gate: the tool ran for this question, and its result belongs to no near-duplicate. The starter stores it like any answer.',
      match: {
        python: {all: [/tool_calls/]},
        typescript: {all: [/\btool_calls\b(?!\??:)/]},
        go: {all: [/GetToolCalls\(\)|\.ToolCalls\b/]},
        scala: {all: [/toolCalls/]},
        cpp: {all: [/tool_calls(_size)?\(\)/]},
      },
    },
    {
      id: 'policy-version',
      title: 'Cached answers carry the serving policy version',
      detail:
        'The entry is written with `policy_version = SERVING_POLICY_VERSION` (`"2024-06-1"`), so a policy change can find every answer the old policy approved. The starter stamps the model version instead.',
      match: {
        python: {all: [/SERVING_POLICY_VERSION\s*=\s*["']2024-06-1["']/, /put_entry\([^\n]*SERVING_POLICY_VERSION/]},
        typescript: {all: [/SERVING_POLICY_VERSION\s*=\s*['"]2024-06-1['"]/, /putEntry\([^\n]*SERVING_POLICY_VERSION/]},
        go: {all: [/servingPolicyVersion\s*=\s*"2024-06-1"/, /putEntry\([^\n]*servingPolicyVersion/]},
        scala: {all: [/ServingPolicyVersion\s*=\s*"2024-06-1"/, /putEntry\([^\n]*ServingPolicyVersion/]},
        cpp: {all: [/kServingPolicyVersion\s*=\s*"2024-06-1"/, /put_entry\([^\n]*kServingPolicyVersion/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""The miss path: ask the model, store the reply."""
import uuid

import grpc

import model_pb2
import model_pb2_grpc
import state  # put_entry(tenant, model_version, entry_id, embedding, answer, policy_version) (step 2)

MAX_ATTEMPTS = 3
SERVING_POLICY_VERSION = "2024-06-1"

channel = grpc.insecure_channel("model:9000")
stub = model_pb2_grpc.ModelStub(channel)


class RefusalError(Exception):
    """The model declined the question: terminal, and cached for nobody."""


def answer_once(tenant: str, model_version: str, question: str) -> model_pb2.AnswerResult:
    """The model's reply, asking again when the call fails or the model refuses."""
    # TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    request = model_pb2.AnswerRequest(tenant=tenant, model_version=model_version, question=question)
    last: model_pb2.AnswerResult | grpc.RpcError | None = None
    for attempt in range(MAX_ATTEMPTS):
        try:
            result = stub.Answer(request)
        except grpc.RpcError as e:
            last = e
            continue
        if not result.refused:
            return result
        last = result
    if isinstance(last, grpc.RpcError):
        raise last
    return last


def write_back(tenant: str, model_version: str, embedding: list[float], result: model_pb2.AnswerResult) -> str:
    entry_id = str(uuid.uuid4())
    state.put_entry(tenant, model_version, entry_id, embedding, result.text, model_version)
    return entry_id


def answer_on_miss(tenant: str, model_version: str, question: str, embedding: list[float]) -> dict:
    result = answer_once(tenant, model_version, question)
    entry_id = write_back(tenant, model_version, embedding, result)
    return {"answer": result.text, "entry_id": entry_id, "cached": True}
`,
      solution: `"""The miss path: one model call under a deadline, and the gate on what may be written back."""
import uuid

import grpc

import model_pb2
import model_pb2_grpc
import state  # put_entry(tenant, model_version, entry_id, embedding, answer, policy_version) (step 2)

MODEL_DEADLINE_SECONDS = 4
SERVING_POLICY_VERSION = "2024-06-1"

channel = grpc.insecure_channel("model:9000")
stub = model_pb2_grpc.ModelStub(channel)


class RefusalError(Exception):
    """The model declined the question: terminal, and cached for nobody."""


def answer_once(tenant: str, model_version: str, question: str) -> model_pb2.AnswerResult:
    """Exactly one Answer call under the deadline; a refusal raises."""
    request = model_pb2.AnswerRequest(tenant=tenant, model_version=model_version, question=question)
    result = stub.Answer(request, timeout=MODEL_DEADLINE_SECONDS)
    if result.refused:
        raise RefusalError(result.text)
    return result


def is_cacheable(result: model_pb2.AnswerResult) -> bool:
    if result.tool_calls:
        return False  # built from a call made for this question alone
    return result.self_contained and result.deterministic and result.policy.cacheable


def write_back(tenant: str, model_version: str, embedding: list[float], result: model_pb2.AnswerResult) -> str | None:
    """The new entry's id, or None when the reply may not be reused."""
    if not is_cacheable(result):
        return None
    entry_id = str(uuid.uuid4())
    state.put_entry(tenant, model_version, entry_id, embedding, result.text, SERVING_POLICY_VERSION)
    return entry_id


def answer_on_miss(tenant: str, model_version: str, question: str, embedding: list[float]) -> dict:
    result = answer_once(tenant, model_version, question)
    entry_id = write_back(tenant, model_version, embedding, result)
    return {"answer": result.text, "entry_id": entry_id, "cached": entry_id is not None}
`,
    },
    typescript: {
      starter: `/** The miss path: ask the model, store the reply. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {randomUUID} from 'node:crypto';

import {putEntry} from './state'; // putEntry(tenant, modelVersion, entryId, embedding, answer, policyVersion) (step 2)

export const MAX_ATTEMPTS = 3;
export const SERVING_POLICY_VERSION = '2024-06-1';

export interface AnswerResult {
  text: string;
  refused: boolean;
  self_contained: boolean;
  deterministic: boolean;
  policy?: {cacheable: boolean};
  tool_calls?: {name: string; arguments: string}[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('model.proto')) as unknown as {
  semcache: {Model: grpc.ServiceClientConstructor};
};
const stub = new pkg.semcache.Model('model:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Answer(request: {tenant: string; model_version: string; question: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<AnswerResult>;
};

/** The model declined the question: terminal, and cached for nobody. */
export class RefusalError extends Error {}

/** The model's reply, asking again when the call fails or the model refuses. */
export async function answerOnce(tenant: string, modelVersion: string, question: string): Promise<AnswerResult> {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  const request = {tenant, model_version: modelVersion, question};
  let last: AnswerResult | Error | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await stub.Answer(request, new grpc.Metadata(), {});
      if (!result.refused) return result;
      last = result;
    } catch (e) {
      last = e as Error;
    }
  }
  if (last instanceof Error) throw last;
  return last as AnswerResult;
}

export async function writeBack(tenant: string, modelVersion: string, embedding: number[], result: AnswerResult): Promise<string> {
  const entryId = randomUUID();
  await putEntry(tenant, modelVersion, entryId, embedding, result.text, modelVersion);
  return entryId;
}

export async function answerOnMiss(tenant: string, modelVersion: string, question: string, embedding: number[]) {
  const result = await answerOnce(tenant, modelVersion, question);
  const entryId = await writeBack(tenant, modelVersion, embedding, result);
  return {answer: result.text, entry_id: entryId, cached: true};
}
`,
      solution: `/** The miss path: one model call under a deadline, and the gate on what may be written back. */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import {randomUUID} from 'node:crypto';

import {putEntry} from './state'; // putEntry(tenant, modelVersion, entryId, embedding, answer, policyVersion) (step 2)

export const MODEL_DEADLINE_MS = 4000;
export const SERVING_POLICY_VERSION = '2024-06-1';

export interface AnswerResult {
  text: string;
  refused: boolean;
  self_contained: boolean;
  deterministic: boolean;
  policy?: {cacheable: boolean};
  tool_calls?: {name: string; arguments: string}[];
}

const pkg = grpc.loadPackageDefinition(protoLoader.loadSync('model.proto')) as unknown as {
  semcache: {Model: grpc.ServiceClientConstructor};
};
const stub = new pkg.semcache.Model('model:9000', grpc.credentials.createInsecure()) as grpc.Client & {
  Answer(request: {tenant: string; model_version: string; question: string}, metadata: grpc.Metadata, options: grpc.CallOptions): Promise<AnswerResult>;
};

/** The model declined the question: terminal, and cached for nobody. */
export class RefusalError extends Error {}

/** Exactly one Answer call under the deadline; a refusal throws. */
export async function answerOnce(tenant: string, modelVersion: string, question: string): Promise<AnswerResult> {
  const result = await stub.Answer({tenant, model_version: modelVersion, question}, new grpc.Metadata(), {deadline: Date.now() + MODEL_DEADLINE_MS});
  if (result.refused) throw new RefusalError(result.text);
  return result;
}

export function isCacheable(result: AnswerResult): boolean {
  if ((result.tool_calls ?? []).length > 0) return false; // built from a call made for this question alone
  return result.self_contained && result.deterministic && result.policy?.cacheable === true;
}

/** The new entry's id, or null when the reply may not be reused. */
export async function writeBack(tenant: string, modelVersion: string, embedding: number[], result: AnswerResult): Promise<string | null> {
  if (!isCacheable(result)) return null;
  const entryId = randomUUID();
  await putEntry(tenant, modelVersion, entryId, embedding, result.text, SERVING_POLICY_VERSION);
  return entryId;
}

export async function answerOnMiss(tenant: string, modelVersion: string, question: string, embedding: number[]) {
  const result = await answerOnce(tenant, modelVersion, question);
  const entryId = await writeBack(tenant, modelVersion, embedding, result);
  return {answer: result.text, entry_id: entryId, cached: entryId !== null};
}
`,
    },
    go: {
      starter: `// The miss path: ask the model, store the reply.
package main

import (
	"context"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "semcache/gen/model"
)

const (
	maxAttempts          = 3
	servingPolicyVersion = "2024-06-1"
)

var conn, _ = grpc.NewClient("model:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewModelClient(conn)

// putEntry writes an entry into the store (state, step 2).
var putEntry = func(ctx context.Context, tenant, modelVersion, entryID string, embedding []float64, answer, policyVersion string) error {
	panic("provided by state (step 2)")
}

// RefusalError: the model declined the question; terminal, and cached for nobody.
type RefusalError struct{ Text string }

func (e *RefusalError) Error() string { return "the model refused: " + e.Text }

// Answered is what the miss path hands back to the request.
type Answered struct {
	Answer  string
	EntryID string
	Cached  bool
}

// answerOnce is the model's reply, asking again when the call fails or the model refuses.
func answerOnce(ctx context.Context, tenant, modelVersion, question string) (*pb.AnswerResult, error) {
	// TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
	request := &pb.AnswerRequest{Tenant: tenant, ModelVersion: modelVersion, Question: question}
	var refusal *pb.AnswerResult
	var err error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		var result *pb.AnswerResult
		result, err = stub.Answer(ctx, request)
		if err != nil {
			continue
		}
		if !result.GetRefused() {
			return result, nil
		}
		refusal = result
	}
	if refusal != nil {
		return refusal, nil
	}
	return nil, err
}

func writeBack(ctx context.Context, tenant, modelVersion string, embedding []float64, result *pb.AnswerResult) (string, error) {
	entryID := uuid.NewString()
	if err := putEntry(ctx, tenant, modelVersion, entryID, embedding, result.GetText(), modelVersion); err != nil {
		return "", err
	}
	return entryID, nil
}

func answerOnMiss(ctx context.Context, tenant, modelVersion, question string, embedding []float64) (Answered, error) {
	result, err := answerOnce(ctx, tenant, modelVersion, question)
	if err != nil {
		return Answered{}, err
	}
	entryID, err := writeBack(ctx, tenant, modelVersion, embedding, result)
	if err != nil {
		return Answered{}, err
	}
	return Answered{Answer: result.GetText(), EntryID: entryID, Cached: true}, nil
}
`,
      solution: `// The miss path: one model call under a deadline, and the gate on what may be written back.
package main

import (
	"context"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	pb "semcache/gen/model"
)

const (
	modelDeadline        = 4 * time.Second
	servingPolicyVersion = "2024-06-1"
)

var conn, _ = grpc.NewClient("model:9000", grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewModelClient(conn)

// putEntry writes an entry into the store (state, step 2).
var putEntry = func(ctx context.Context, tenant, modelVersion, entryID string, embedding []float64, answer, policyVersion string) error {
	panic("provided by state (step 2)")
}

// RefusalError: the model declined the question; terminal, and cached for nobody.
type RefusalError struct{ Text string }

func (e *RefusalError) Error() string { return "the model refused: " + e.Text }

// Answered is what the miss path hands back to the request.
type Answered struct {
	Answer  string
	EntryID string
	Cached  bool
}

// answerOnce makes exactly one Answer call under the deadline; a refusal is an error.
func answerOnce(ctx context.Context, tenant, modelVersion, question string) (*pb.AnswerResult, error) {
	ctx, cancel := context.WithTimeout(ctx, modelDeadline)
	defer cancel()
	result, err := stub.Answer(ctx, &pb.AnswerRequest{Tenant: tenant, ModelVersion: modelVersion, Question: question})
	if err != nil {
		return nil, err
	}
	if result.GetRefused() {
		return nil, &RefusalError{Text: result.GetText()}
	}
	return result, nil
}

func isCacheable(result *pb.AnswerResult) bool {
	if len(result.GetToolCalls()) > 0 {
		return false // built from a call made for this question alone
	}
	return result.GetSelfContained() && result.GetDeterministic() && result.GetPolicy().GetCacheable()
}

// writeBack returns the new entry's id, or "" when the reply may not be reused.
func writeBack(ctx context.Context, tenant, modelVersion string, embedding []float64, result *pb.AnswerResult) (string, error) {
	if !isCacheable(result) {
		return "", nil
	}
	entryID := uuid.NewString()
	if err := putEntry(ctx, tenant, modelVersion, entryID, embedding, result.GetText(), servingPolicyVersion); err != nil {
		return "", err
	}
	return entryID, nil
}

func answerOnMiss(ctx context.Context, tenant, modelVersion, question string, embedding []float64) (Answered, error) {
	result, err := answerOnce(ctx, tenant, modelVersion, question)
	if err != nil {
		return Answered{}, err
	}
	entryID, err := writeBack(ctx, tenant, modelVersion, embedding, result)
	if err != nil {
		return Answered{}, err
	}
	return Answered{Answer: result.GetText(), EntryID: entryID, Cached: entryID != ""}, nil
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}
import semcache.model.{AnswerRequest, AnswerResult, ModelGrpc}

/** The miss path: ask the model, store the reply. */
object Client {
  val MaxAttempts = 3
  val ServingPolicyVersion = "2024-06-1"

  private val channel = ManagedChannelBuilder.forAddress("model", 9000).usePlaintext().build()
  private val stub = ModelGrpc.blockingStub(channel)

  /** The model declined the question: terminal, and cached for nobody. */
  class RefusalError(text: String) extends RuntimeException(s"the model refused: $text")

  /** What the miss path hands back to the request. */
  case class Answered(answer: String, entryId: Option[String], cached: Boolean)

  /** The model's reply, asking again when the call fails or the model refuses. */
  def answerOnce(tenant: String, modelVersion: String, question: String): AnswerResult = {
    // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
    val request = AnswerRequest(tenant = tenant, modelVersion = modelVersion, question = question)
    var last: Either[StatusRuntimeException, AnswerResult] = Left(null)
    var attempt = 0
    while (attempt < MaxAttempts) {
      attempt += 1
      try {
        val result = stub.answer(request)
        if (!result.refused) return result
        last = Right(result)
      } catch {
        case e: StatusRuntimeException => last = Left(e)
      }
    }
    last match {
      case Right(result) => result
      case Left(e)       => throw e
    }
  }

  def writeBack(tenant: String, modelVersion: String, embedding: Seq[Double], result: AnswerResult): String = {
    val entryId = UUID.randomUUID().toString
    State.putEntry(tenant, modelVersion, entryId, embedding, result.text, modelVersion)
    entryId
  }

  def answerOnMiss(tenant: String, modelVersion: String, question: String, embedding: Seq[Double]): Answered = {
    val result = answerOnce(tenant, modelVersion, question)
    val entryId = writeBack(tenant, modelVersion, embedding, result)
    Answered(result.text, Some(entryId), cached = true)
  }
}
`,
      solution: `import java.util.UUID
import java.util.concurrent.TimeUnit

import io.grpc.ManagedChannelBuilder
import semcache.model.{AnswerRequest, AnswerResult, ModelGrpc}

/** The miss path: one model call under a deadline, and the gate on what may be written back. */
object Client {
  val ModelDeadlineSeconds = 4L
  val ServingPolicyVersion = "2024-06-1"

  private val channel = ManagedChannelBuilder.forAddress("model", 9000).usePlaintext().build()
  private val stub = ModelGrpc.blockingStub(channel)

  /** The model declined the question: terminal, and cached for nobody. */
  class RefusalError(text: String) extends RuntimeException(s"the model refused: $text")

  /** What the miss path hands back to the request. */
  case class Answered(answer: String, entryId: Option[String], cached: Boolean)

  /** Exactly one Answer call under the deadline; a refusal throws. */
  def answerOnce(tenant: String, modelVersion: String, question: String): AnswerResult = {
    val request = AnswerRequest(tenant = tenant, modelVersion = modelVersion, question = question)
    val result = stub.withDeadlineAfter(ModelDeadlineSeconds, TimeUnit.SECONDS).answer(request)
    if (result.refused) throw new RefusalError(result.text)
    result
  }

  def isCacheable(result: AnswerResult): Boolean =
    result.toolCalls.isEmpty && result.selfContained && result.deterministic && result.policy.exists(_.cacheable)

  /** The new entry's id, or None when the reply may not be reused. */
  def writeBack(tenant: String, modelVersion: String, embedding: Seq[Double], result: AnswerResult): Option[String] =
    if (!isCacheable(result)) None
    else {
      val entryId = UUID.randomUUID().toString
      State.putEntry(tenant, modelVersion, entryId, embedding, result.text, ServingPolicyVersion)
      Some(entryId)
    }

  def answerOnMiss(tenant: String, modelVersion: String, question: String, embedding: Seq[Double]): Answered = {
    val result = answerOnce(tenant, modelVersion, question)
    val entryId = writeBack(tenant, modelVersion, embedding, result)
    Answered(result.text, entryId, cached = entryId.isDefined)
  }
}
`,
    },
    cpp: {
      starter: `// The miss path: ask the model, store the reply.
#include <grpcpp/grpcpp.h>

#include <stdexcept>
#include <string>
#include <vector>

#include "ids.h"  // std::string new_uuid();
#include "model.grpc.pb.h"
#include "state.h"  // put_entry(tenant, model_version, entry_id, embedding, answer, policy_version) (step 2)

constexpr int kMaxAttempts = 3;
const std::string kServingPolicyVersion = "2024-06-1";

auto channel = grpc::CreateChannel("model:9000", grpc::InsecureChannelCredentials());
auto stub = semcache::Model::NewStub(channel);

// The model declined the question: terminal, and cached for nobody.
struct RefusalError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// What the miss path hands back to the request.
struct Answered {
  std::string answer;
  std::string entry_id;  // "" when nothing was cached
  bool cached;
};

// The model's reply, asking again when the call fails or the model refuses.
semcache::AnswerResult answer_once(const std::string& tenant, const std::string& model_version, const std::string& question) {
  // TODO: this starter has 5 flaws. The task says where to look; the checks say what must change.
  semcache::AnswerRequest request;
  request.set_tenant(tenant);
  request.set_model_version(model_version);
  request.set_question(question);
  semcache::AnswerResult result;
  grpc::Status status;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    status = stub->Answer(&ctx, request, &result);
    if (status.ok() && !result.refused()) return result;
  }
  if (!status.ok()) throw std::runtime_error("Answer failed: " + status.error_message());
  return result;
}

std::string write_back(const std::string& tenant, const std::string& model_version, const std::vector<double>& embedding,
                       const semcache::AnswerResult& result) {
  const std::string entry_id = new_uuid();
  put_entry(tenant, model_version, entry_id, embedding, result.text(), model_version);
  return entry_id;
}

Answered answer_on_miss(const std::string& tenant, const std::string& model_version, const std::string& question,
                        const std::vector<double>& embedding) {
  const semcache::AnswerResult result = answer_once(tenant, model_version, question);
  const std::string entry_id = write_back(tenant, model_version, embedding, result);
  return Answered{result.text(), entry_id, true};
}
`,
      solution: `// The miss path: one model call under a deadline, and the gate on what may be written back.
#include <grpcpp/grpcpp.h>

#include <chrono>
#include <stdexcept>
#include <string>
#include <vector>

#include "ids.h"  // std::string new_uuid();
#include "model.grpc.pb.h"
#include "state.h"  // put_entry(tenant, model_version, entry_id, embedding, answer, policy_version) (step 2)

constexpr std::chrono::seconds kModelDeadline{4};
const std::string kServingPolicyVersion = "2024-06-1";

auto channel = grpc::CreateChannel("model:9000", grpc::InsecureChannelCredentials());
auto stub = semcache::Model::NewStub(channel);

// The model declined the question: terminal, and cached for nobody.
struct RefusalError : std::runtime_error {
  using std::runtime_error::runtime_error;
};

// What the miss path hands back to the request.
struct Answered {
  std::string answer;
  std::string entry_id;  // "" when nothing was cached
  bool cached;
};

// Exactly one Answer call under the deadline; a refusal throws.
semcache::AnswerResult answer_once(const std::string& tenant, const std::string& model_version, const std::string& question) {
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + kModelDeadline);
  semcache::AnswerRequest request;
  request.set_tenant(tenant);
  request.set_model_version(model_version);
  request.set_question(question);
  semcache::AnswerResult result;
  const grpc::Status status = stub->Answer(&ctx, request, &result);
  if (!status.ok()) throw std::runtime_error("Answer failed: " + status.error_message());
  if (result.refused()) throw RefusalError(result.text());
  return result;
}

bool is_cacheable(const semcache::AnswerResult& result) {
  if (result.tool_calls_size() > 0) return false;  // built from a call made for this question alone
  return result.self_contained() && result.deterministic() && result.policy().cacheable();
}

// The new entry's id, or "" when the reply may not be reused.
std::string write_back(const std::string& tenant, const std::string& model_version, const std::vector<double>& embedding,
                       const semcache::AnswerResult& result) {
  if (!is_cacheable(result)) return "";
  const std::string entry_id = new_uuid();
  put_entry(tenant, model_version, entry_id, embedding, result.text(), kServingPolicyVersion);
  return entry_id;
}

Answered answer_on_miss(const std::string& tenant, const std::string& model_version, const std::string& question,
                        const std::vector<double>& embedding) {
  const semcache::AnswerResult result = answer_once(tenant, model_version, question);
  const std::string entry_id = write_back(tenant, model_version, embedding, result);
  return Answered{result.text(), entry_id, !entry_id.empty()};
}
`,
    },
  },
  harness: {
    python: `import grpc

import model_pb2
import model_pb2_grpc

MV = "2024-06"
V = [1.0, 0.0, 0.0, 0.0]
QUESTION = "What is the refund window?"


class FakeModel(model_pb2_grpc.ModelServicer):
    """Answers every question; a prefix picks the reply's shape: refuse:, tool:, sample:, partial:, nocache:."""

    def Answer(self, request, context):
        q = request.question
        result = model_pb2.AnswerResult(
            text=f"Answer to: {q}",
            refused=q.startswith("refuse:"),
            self_contained=not q.startswith("partial:"),
            deterministic=not q.startswith("sample:"),
            policy=model_pb2.Policy(cacheable=not q.startswith("nocache:")),
        )
        if result.refused:
            result.text = "I can't help with that."
        if q.startswith("tool:"):
            result.tool_calls.add(name="lookup_order", arguments='{"id": 42}')
        return result


def _client(ctx):
    ctx.grpc.serve(model_pb2_grpc.add_ModelServicer_to_server, FakeModel())
    return ctx.load("client")


def _entries(ctx):
    return sorted(ctx.redis.keys("entry:*"))


def _miss(m, question):
    """answer_on_miss, reporting what it raised instead of ending the check."""
    try:
        return m.answer_on_miss("acme", MV, question, V), None
    except Exception as e:  # noqa: BLE001
        return None, e


def check_deadline(ctx):
    m = _client(ctx)
    out, raised = _miss(m, QUESTION)
    assert raised is None, f"a miss on a healthy model raised {raised!r}"
    assert out["answer"] == f"Answer to: {QUESTION}", f"answer_on_miss answered {out}, expected the model's text"
    calls = ctx.grpc.calls_to("Answer")
    assert len(calls) == 1, f"one miss made {len(calls)} Answer calls, expected exactly one"
    assert calls[0].timeout is not None, "the Answer call carries no deadline: a stuck model would hold the request for as long as it likes"
    assert 3.5 <= calls[0].timeout <= 4.5, f"the deadline must be about 4 s, got {calls[0].timeout} s"
    ctx.grpc.set_latency("Answer", 6.0)
    out, raised = _miss(m, QUESTION)
    code = raised.code() if isinstance(raised, grpc.RpcError) else None
    assert code == grpc.StatusCode.DEADLINE_EXCEEDED, f"a model slower than the deadline must fail the miss with DEADLINE_EXCEEDED, got {raised!r} (answer {out})"
    assert len(ctx.grpc.calls_to("Answer")) == 2, f"a timed-out call must not be retried: {len(ctx.grpc.calls_to('Answer'))} Answer calls after two misses"


def check_refusal_terminal(ctx):
    m = _client(ctx)
    out, raised = _miss(m, "refuse: how do I pick a lock?")
    assert raised is not None, f"a refused reply must raise RefusalError, answer_on_miss returned {out}"
    assert type(raised).__name__ == "RefusalError", f"a refused reply must raise RefusalError, got {raised!r}"
    assert len(ctx.grpc.calls_to("Answer")) == 1, f"a refusal was asked again: {len(ctx.grpc.calls_to('Answer'))} Answer calls (the model already decided)"
    assert _entries(ctx) == [], f"a refusal was written back: {_entries(ctx)}. The next near-duplicate question would be answered with it"


def check_cacheable_gate(ctx):
    m = _client(ctx)
    for prefix, why in (("sample:", "a sampled reply (deterministic false)"), ("partial:", "a reply that is not self-contained"), ("nocache:", "a reply the policy marks not cacheable")):
        out, raised = _miss(m, f"{prefix} {QUESTION}")
        assert raised is None, f"{why} must be answered to its caller, got {raised!r}"
        assert out["cached"] is False and not out.get("entry_id"), f"{why} must be answered with cached: false and no entry_id, got {out}"
        assert _entries(ctx) == [], f"{why} was written back: {_entries(ctx)}"
    out, raised = _miss(m, QUESTION)
    assert raised is None and out["cached"] is True and out["entry_id"], f"a self-contained, deterministic, cacheable reply must be cached, got {out} ({raised!r})"
    key = f"entry:acme:{MV}:{out['entry_id']}"
    assert ctx.redis.exists(key) == 1, f"the cached reply's entry {key} is not in the store (keys: {_entries(ctx)})"
    assert ctx.redis.hget(key, "answer") == f"Answer to: {QUESTION}", f"the entry's answer is {ctx.redis.hget(key, 'answer')!r}"


def check_no_tool_cache(ctx):
    m = _client(ctx)
    out, raised = _miss(m, "tool: where is my order?")
    assert raised is None, f"a tool-built reply must be answered to its caller, got {raised!r}"
    assert out["answer"] == "Answer to: tool: where is my order?" and out["cached"] is False, f"a tool-built reply is answered with cached: false, got {out}"
    assert _entries(ctx) == [], f"a reply built from a tool call was written back: {_entries(ctx)}. The tool ran for this caller's order"


def check_policy_version(ctx):
    m = _client(ctx)
    out, raised = _miss(m, QUESTION)
    assert raised is None and out.get("entry_id"), f"a cacheable reply must be cached, got {out} ({raised!r})"
    key = f"entry:acme:{MV}:{out['entry_id']}"
    raw = ctx.redis.hgetall(key)
    assert raw, f"no entry at {key} (keys: {_entries(ctx)})"
    assert raw.get("policy_version") == "2024-06-1", f"the entry's policy_version is {raw.get('policy_version')!r}, expected the serving policy version 2024-06-1 (the model version is {MV})"
    assert key in ctx.redis.smembers(f"semantic:acme:{MV}"), "the entry must be listed in the tenant's index"
`,
    typescript: `const MV = '2024-06';
const V = [1, 0, 0, 0];
const QUESTION = 'What is the refund window?';

/** The model: answers every question; a prefix picks the reply's shape: refuse:, tool:, sample:, partial:, nocache:. */
function client(ctx) {
  const pkg = ctx.proto('model.proto');
  ctx.grpc.serve(pkg.semcache.Model.service, {
    Answer(call, callback) {
      const q: string = call.request.question;
      const refused = q.startsWith('refuse:');
      callback(null, {
        text: refused ? "I can't help with that." : \`Answer to: \${q}\`,
        refused,
        self_contained: !q.startsWith('partial:'),
        deterministic: !q.startsWith('sample:'),
        policy: {cacheable: !q.startsWith('nocache:')},
        tool_calls: q.startsWith('tool:') ? [{name: 'lookup_order', arguments: '{"id": 42}'}] : [],
      });
    },
  });
  return ctx.load('client');
}

const entries = ctx => ctx.redis.keys('entry:*').sort();

/** answerOnMiss, reporting what it threw instead of ending the check. */
async function miss(m, question: string): Promise<{out; raised: unknown}> {
  try {
    return {out: await m.answerOnMiss('acme', MV, question, V), raised: null};
  } catch (e) {
    return {out: null, raised: e};
  }
}

export async function check_deadline(ctx) {
  const m = client(ctx);
  let {out, raised} = await miss(m, QUESTION);
  assert.equal(raised, null, \`a miss on a healthy model threw \${raised}\`);
  assert.equal(out.answer, \`Answer to: \${QUESTION}\`, \`answerOnMiss answered \${JSON.stringify(out)}, expected the model's text\`);
  const calls = ctx.grpc.callsTo('Answer');
  assert.equal(calls.length, 1, \`one miss made \${calls.length} Answer calls, expected exactly one\`);
  assert(calls[0].timeout !== null, 'the Answer call carries no deadline: a stuck model would hold the request for as long as it likes');
  assert(3.5 <= calls[0].timeout && calls[0].timeout <= 4.5, \`the deadline must be about 4 s, got \${calls[0].timeout} s\`);
  ctx.grpc.setLatency('Answer', 6.0);
  ({out, raised} = await miss(m, QUESTION));
  const code = (raised as {code?: number} | null)?.code ?? null;
  assert.equal(code, ctx.grpc.status.DEADLINE_EXCEEDED, \`a model slower than the deadline must fail the miss with DEADLINE_EXCEEDED, got \${raised} (answer \${JSON.stringify(out)})\`);
  assert.equal(ctx.grpc.callsTo('Answer').length, 2, \`a timed-out call must not be retried: \${ctx.grpc.callsTo('Answer').length} Answer calls after two misses\`);
}

export async function check_refusal_terminal(ctx) {
  const m = client(ctx);
  const {out, raised} = await miss(m, 'refuse: how do I pick a lock?');
  assert(raised !== null, \`a refused reply must throw RefusalError, answerOnMiss returned \${JSON.stringify(out)}\`);
  assert.equal((raised as Error).constructor.name, 'RefusalError', \`a refused reply must throw RefusalError, got \${raised}\`);
  assert.equal(ctx.grpc.callsTo('Answer').length, 1, \`a refusal was asked again: \${ctx.grpc.callsTo('Answer').length} Answer calls (the model already decided)\`);
  assert.deepEqual(entries(ctx), [], \`a refusal was written back: \${JSON.stringify(entries(ctx))}. The next near-duplicate question would be answered with it\`);
}

export async function check_cacheable_gate(ctx) {
  const m = client(ctx);
  for (const [prefix, why] of [['sample:', 'a sampled reply (deterministic false)'], ['partial:', 'a reply that is not self-contained'], ['nocache:', 'a reply the policy marks not cacheable']]) {
    const {out, raised} = await miss(m, \`\${prefix} \${QUESTION}\`);
    assert.equal(raised, null, \`\${why} must be answered to its caller, got \${raised}\`);
    assert(out.cached === false && !out.entry_id, \`\${why} must be answered with cached: false and no entry_id, got \${JSON.stringify(out)}\`);
    assert.deepEqual(entries(ctx), [], \`\${why} was written back: \${JSON.stringify(entries(ctx))}\`);
  }
  const {out, raised} = await miss(m, QUESTION);
  assert(raised === null && out.cached === true && out.entry_id, \`a self-contained, deterministic, cacheable reply must be cached, got \${JSON.stringify(out)} (\${raised})\`);
  const key = \`entry:acme:\${MV}:\${out.entry_id}\`;
  assert.equal(ctx.redis.exists(key), 1, \`the cached reply's entry \${key} is not in the store (keys: \${JSON.stringify(entries(ctx))})\`);
  assert.equal(ctx.redis.hget(key, 'answer'), \`Answer to: \${QUESTION}\`, \`the entry's answer is \${JSON.stringify(ctx.redis.hget(key, 'answer'))}\`);
}

export async function check_no_tool_cache(ctx) {
  const m = client(ctx);
  const {out, raised} = await miss(m, 'tool: where is my order?');
  assert.equal(raised, null, \`a tool-built reply must be answered to its caller, got \${raised}\`);
  assert(out.answer === 'Answer to: tool: where is my order?' && out.cached === false, \`a tool-built reply is answered with cached: false, got \${JSON.stringify(out)}\`);
  assert.deepEqual(entries(ctx), [], \`a reply built from a tool call was written back: \${JSON.stringify(entries(ctx))}. The tool ran for this caller's order\`);
}

export async function check_policy_version(ctx) {
  const m = client(ctx);
  const {out, raised} = await miss(m, QUESTION);
  assert(raised === null && out.entry_id, \`a cacheable reply must be cached, got \${JSON.stringify(out)} (\${raised})\`);
  const key = \`entry:acme:\${MV}:\${out.entry_id}\`;
  const raw = ctx.redis.hgetall(key);
  assert(Object.keys(raw).length > 0, \`no entry at \${key} (keys: \${JSON.stringify(entries(ctx))})\`);
  assert.equal(raw.policy_version, '2024-06-1', \`the entry's policy_version is \${JSON.stringify(raw.policy_version)}, expected the serving policy version 2024-06-1 (the model version is \${MV})\`);
  assert(ctx.redis.smembers(\`semantic:acme:\${MV}\`).includes(key), "the entry must be listed in the tenant's index");
}
`,
    go: `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"leetbuild/harness"

	pb "semcache/gen/model"
)

const (
	clientMV       = "2024-06"
	clientQuestion = "What is the refund window?"
)

var clientV = []float64{1, 0, 0, 0}

// modelPeer answers every question; a prefix picks the reply's shape: refuse:, tool:, sample:, partial:, nocache:.
type modelPeer struct {
	pb.UnimplementedModelServer
}

func (modelPeer) Answer(_ context.Context, req *pb.AnswerRequest) (*pb.AnswerResult, error) {
	q := req.GetQuestion()
	result := &pb.AnswerResult{
		Text:          "Answer to: " + q,
		Refused:       strings.HasPrefix(q, "refuse:"),
		SelfContained: !strings.HasPrefix(q, "partial:"),
		Deterministic: !strings.HasPrefix(q, "sample:"),
		Policy:        &pb.Policy{Cacheable: !strings.HasPrefix(q, "nocache:")},
	}
	if result.Refused {
		result.Text = "I can't help with that."
	}
	if strings.HasPrefix(q, "tool:") {
		result.ToolCalls = []*pb.ToolCall{{Name: "lookup_order", Arguments: "{\\"id\\": 42}"}}
	}
	return result, nil
}

// clientWorld serves the model and stands in for the store (step 2): putEntry writes the entry as the store does.
func clientWorld(ctx *harness.Ctx) {
	pb.RegisterModelServer(ctx.GRPC.Server(""), &modelPeer{})
	putEntry = func(_ context.Context, tenant, modelVersion, entryID string, embedding []float64, answer, policyVersion string) error {
		key := fmt.Sprintf("entry:%s:%s:%s", tenant, modelVersion, entryID)
		now := float64(ctx.Clock.Now()) / 1000
		vec, _ := json.Marshal(embedding)
		ctx.Redis.Do("HSET", key, "embedding", string(vec), "answer", answer, "created_at", now, "expires_at", now+86400, "policy_version", policyVersion)
		ctx.Redis.Do("EXPIRE", key, 86400)
		ctx.Redis.Do("SADD", fmt.Sprintf("semantic:%s:%s", tenant, modelVersion), key)
		return nil
	}
}

func clientEntries(ctx *harness.Ctx) []string { return ctx.Redis.Keys("entry:*") }

// clientMiss is answerOnMiss, reporting a panic as an error instead of ending the check.
func clientMiss(question string) (out Answered, err error) {
	defer func() {
		if e := recover(); e != nil {
			err = errors.New("panic: " + harness.Show(e))
		}
	}()
	return answerOnMiss(context.Background(), "acme", clientMV, question, clientV)
}

func CheckDeadline(ctx *harness.Ctx) {
	clientWorld(ctx)
	out, err := clientMiss(clientQuestion)
	ctx.NoError(err, "a miss on a healthy model")
	ctx.Equal(out.Answer, "Answer to: "+clientQuestion, "answerOnMiss must answer the model's text")
	calls := ctx.GRPC.CallsTo("Answer", "")
	ctx.Equal(len(calls), 1, "one miss must make exactly one Answer call; the calls")
	ctx.Assert(calls[0].HasDeadline(), "the Answer call carries no deadline: a stuck model would hold the request for as long as it likes")
	ctx.Assert(3500*time.Millisecond <= calls[0].Timeout && calls[0].Timeout <= 4500*time.Millisecond, "the deadline must be about 4 s, got %v", calls[0].Timeout)
	ctx.GRPC.SetLatency("Answer", 6.0, "")
	out, err = clientMiss(clientQuestion)
	ctx.Assert(status.Code(err) == codes.DeadlineExceeded, "a model slower than the deadline must fail the miss with DeadlineExceeded, got %v (answer %v)", err, out)
	ctx.Equal(len(ctx.GRPC.CallsTo("Answer", "")), 2, "a timed-out call must not be retried; Answer calls after two misses")
}

func CheckRefusalTerminal(ctx *harness.Ctx) {
	clientWorld(ctx)
	out, err := clientMiss("refuse: how do I pick a lock?")
	ctx.Assert(err != nil, "a refused reply must fail with a RefusalError, answerOnMiss returned %v", out)
	var refusal *RefusalError
	ctx.Assert(errors.As(err, &refusal), "a refused reply must fail with a *RefusalError, got %v", err)
	ctx.Equal(len(ctx.GRPC.CallsTo("Answer", "")), 1, "a refusal was asked again (the model already decided); Answer calls")
	ctx.Equal(len(clientEntries(ctx)), 0, "a refusal was written back (%v): the next near-duplicate question would be answered with it; entries", clientEntries(ctx))
}

func CheckCacheableGate(ctx *harness.Ctx) {
	clientWorld(ctx)
	for _, c := range []struct{ prefix, why string }{
		{"sample:", "a sampled reply (deterministic false)"},
		{"partial:", "a reply that is not self-contained"},
		{"nocache:", "a reply the policy marks not cacheable"},
	} {
		out, err := clientMiss(c.prefix + " " + clientQuestion)
		ctx.NoError(err, "%s must be answered to its caller", c.why)
		ctx.Assert(!out.Cached && out.EntryID == "", "%s must be answered with Cached false and no EntryID, got %v", c.why, out)
		ctx.Equal(len(clientEntries(ctx)), 0, "%s was written back (%v); entries", c.why, clientEntries(ctx))
	}
	out, err := clientMiss(clientQuestion)
	ctx.NoError(err, "a cacheable reply")
	ctx.Assert(out.Cached && out.EntryID != "", "a self-contained, deterministic, cacheable reply must be cached, got %v", out)
	key := fmt.Sprintf("entry:acme:%s:%s", clientMV, out.EntryID)
	ctx.Equal(ctx.Redis.Exists(key), 1, "the cached reply's entry %s must be in the store (keys: %v); EXISTS", key, clientEntries(ctx))
	answer, _ := ctx.Redis.HGet(key, "answer")
	ctx.Equal(answer, "Answer to: "+clientQuestion, "the entry's answer")
}

func CheckNoToolCache(ctx *harness.Ctx) {
	clientWorld(ctx)
	out, err := clientMiss("tool: where is my order?")
	ctx.NoError(err, "a tool-built reply must be answered to its caller")
	ctx.Assert(out.Answer == "Answer to: tool: where is my order?" && !out.Cached, "a tool-built reply is answered with Cached false, got %v", out)
	ctx.Equal(len(clientEntries(ctx)), 0, "a reply built from a tool call was written back (%v): the tool ran for this caller's order; entries", clientEntries(ctx))
}

func CheckPolicyVersion(ctx *harness.Ctx) {
	clientWorld(ctx)
	out, err := clientMiss(clientQuestion)
	ctx.NoError(err, "a cacheable reply")
	ctx.Assert(out.EntryID != "", "a cacheable reply must be cached, got %v", out)
	key := fmt.Sprintf("entry:acme:%s:%s", clientMV, out.EntryID)
	raw := ctx.Redis.HGetAll(key)
	ctx.Assert(len(raw) > 0, "no entry at %s (keys: %v)", key, clientEntries(ctx))
	ctx.Equal(raw["policy_version"], "2024-06-1", "the entry's policy_version must be the serving policy version (the model version is %s)", clientMV)
	ctx.Assert(ctx.Redis.SIsMember("semantic:acme:"+clientMV, key), "the entry must be listed in the tenant's index")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <nlohmann/json.hpp>

#include <exception>
#include <optional>
#include <string>
#include <vector>

namespace {

const std::string kMV = "2024-06";
const std::string kQuestion = "What is the refund window?";
const std::vector<double> kV = {1, 0, 0, 0};

harness::Ctx* world = nullptr;

// The model: answers every question; a prefix picks the reply's shape: refuse:, tool:, sample:, partial:, nocache:.
class ModelPeer final : public semcache::Model::Service {
 public:
  grpc::Status Answer(grpc::ServerContext*, const semcache::AnswerRequest* req, semcache::AnswerResult* result) override {
    const std::string q = req->question();
    const bool refused = q.rfind("refuse:", 0) == 0;
    result->set_text(refused ? "I can't help with that." : "Answer to: " + q);
    result->set_refused(refused);
    result->set_self_contained(q.rfind("partial:", 0) != 0);
    result->set_deterministic(q.rfind("sample:", 0) != 0);
    result->mutable_policy()->set_cacheable(q.rfind("nocache:", 0) != 0);
    if (q.rfind("tool:", 0) == 0) {
      auto* call = result->add_tool_calls();
      call->set_name("lookup_order");
      call->set_arguments("{\\"id\\": 42}");
    }
    return grpc::Status::OK;
  }
};

void clientWorld(harness::Ctx& ctx) {
  static ModelPeer* peer = nullptr;
  delete peer;
  peer = new ModelPeer;
  world = &ctx;
  ctx.GRPC.Server("")->RegisterService(peer);
}

std::vector<std::string> clientEntries(harness::Ctx& ctx) { return ctx.Redis.Keys("entry:*"); }

struct Missed {
  std::optional<Answered> out;
  std::string raised;  // the exception's type name, "" when none
  std::string message;
};

// answer_on_miss, reporting what it threw instead of ending the check.
Missed clientMiss(const std::string& question) {
  try {
    return Missed{answer_on_miss("acme", kMV, question, kV), "", ""};
  } catch (const RefusalError& e) {
    return Missed{std::nullopt, "RefusalError", e.what()};
  } catch (const std::exception& e) {
    return Missed{std::nullopt, "exception", e.what()};
  }
}

std::string show(const std::optional<Answered>& a) {
  if (!a) return "<nil>";
  return "{answer=" + harness::Quote(a->answer) + " entry_id=" + a->entry_id + " cached=" + (a->cached ? "true" : "false") + "}";
}

}  // namespace

// The stand-in for the store (step 2): put_entry writes the entry as the store does.
void put_entry(const std::string& tenant, const std::string& model_version, const std::string& entry_id,
               const std::vector<double>& embedding, const std::string& answer, const std::string& policy_version) {
  const std::string key = "entry:" + tenant + ":" + model_version + ":" + entry_id;
  const double now = static_cast<double>(world->Clock.Now()) / 1000;
  world->Redis.Do("HSET", key, "embedding", nlohmann::json(embedding).dump(), "answer", answer, "created_at", harness::Value(now),
                  "expires_at", harness::Value(now + 86400), "policy_version", policy_version);
  world->Redis.Do("EXPIRE", key, 86400);
  world->Redis.Do("SADD", "semantic:" + tenant + ":" + model_version, key);
}

void CheckDeadline(harness::Ctx& ctx) {
  clientWorld(ctx);
  auto m = clientMiss(kQuestion);
  ctx.Equal(m.raised, "", "a miss on a healthy model threw (%s);", m.message);
  ctx.Equal(m.out->answer, "Answer to: " + kQuestion, "answer_on_miss must answer the model's text");
  const auto calls = ctx.GRPC.CallsTo("Answer");
  ctx.Equal(calls.size(), 1, "one miss must make exactly one Answer call; the calls");
  ctx.Assert(calls[0].HasDeadline(), "the Answer call carries no deadline: a stuck model would hold the request for as long as it likes");
  ctx.Assert(3.5 <= calls[0].TimeoutSeconds() && calls[0].TimeoutSeconds() <= 4.5, "the deadline must be about 4 s, got %vs",
             calls[0].TimeoutSeconds());
  ctx.GRPC.SetLatency("Answer", 6.0);
  m = clientMiss(kQuestion);
  const auto after = ctx.GRPC.CallsTo("Answer");
  ctx.Assert(!m.raised.empty() && after.back().Code == grpc::StatusCode::DEADLINE_EXCEEDED,
             "a model slower than the deadline must fail the miss with DEADLINE_EXCEEDED, got %s (%s, answer %s)", m.raised, m.message,
             show(m.out));
  ctx.Equal(after.size(), 2, "a timed-out call must not be retried; Answer calls after two misses");
}

void CheckRefusalTerminal(harness::Ctx& ctx) {
  clientWorld(ctx);
  const auto m = clientMiss("refuse: how do I pick a lock?");
  ctx.Assert(!m.raised.empty(), "a refused reply must throw RefusalError, answer_on_miss returned %s", show(m.out));
  ctx.Equal(m.raised, "RefusalError", "a refused reply must throw RefusalError (%s); it threw", m.message);
  ctx.Equal(ctx.GRPC.CallsTo("Answer").size(), 1, "a refusal was asked again (the model already decided); Answer calls");
  ctx.Equal(clientEntries(ctx).size(), 0, "a refusal was written back (%v): the next near-duplicate question would be answered with it; entries",
            clientEntries(ctx));
}

void CheckCacheableGate(harness::Ctx& ctx) {
  clientWorld(ctx);
  const std::vector<std::pair<std::string, std::string>> cases = {
      {"sample:", "a sampled reply (deterministic false)"},
      {"partial:", "a reply that is not self-contained"},
      {"nocache:", "a reply the policy marks not cacheable"}};
  for (const auto& [prefix, why] : cases) {
    const auto m = clientMiss(prefix + " " + kQuestion);
    ctx.Equal(m.raised, "", "%s must be answered to its caller (%s); it threw", why, m.message);
    ctx.Assert(!m.out->cached && m.out->entry_id.empty(), "%s must be answered with cached false and no entry_id, got %s", why, show(m.out));
    ctx.Equal(clientEntries(ctx).size(), 0, "%s was written back (%v); entries", why, clientEntries(ctx));
  }
  const auto m = clientMiss(kQuestion);
  ctx.Equal(m.raised, "", "a cacheable reply threw (%s);", m.message);
  ctx.Assert(m.out->cached && !m.out->entry_id.empty(), "a self-contained, deterministic, cacheable reply must be cached, got %s", show(m.out));
  const std::string key = "entry:acme:" + kMV + ":" + m.out->entry_id;
  ctx.Equal(ctx.Redis.Exists(key), 1, "the cached reply's entry %s must be in the store (keys: %v); EXISTS", key, clientEntries(ctx));
  ctx.Equal(ctx.Redis.HGet(key, "answer"), "Answer to: " + kQuestion, "the entry's answer");
}

void CheckNoToolCache(harness::Ctx& ctx) {
  clientWorld(ctx);
  const auto m = clientMiss("tool: where is my order?");
  ctx.Equal(m.raised, "", "a tool-built reply must be answered to its caller (%s); it threw", m.message);
  ctx.Assert(m.out->answer == "Answer to: tool: where is my order?" && !m.out->cached, "a tool-built reply is answered with cached false, got %s",
             show(m.out));
  ctx.Equal(clientEntries(ctx).size(), 0, "a reply built from a tool call was written back (%v): the tool ran for this caller's order; entries",
            clientEntries(ctx));
}

void CheckPolicyVersion(harness::Ctx& ctx) {
  clientWorld(ctx);
  const auto m = clientMiss(kQuestion);
  ctx.Equal(m.raised, "", "a cacheable reply threw (%s);", m.message);
  ctx.Assert(!m.out->entry_id.empty(), "a cacheable reply must be cached, got %s", show(m.out));
  const std::string key = "entry:acme:" + kMV + ":" + m.out->entry_id;
  const auto raw = ctx.Redis.HGetAll(key);
  ctx.Assert(!raw.empty(), "no entry at %s (keys: %v)", key, clientEntries(ctx));
  ctx.Equal(raw.count("policy_version") ? raw.at("policy_version") : "", "2024-06-1",
            "the entry's policy_version must be the serving policy version (the model version is %s)", kMV);
  ctx.Assert(ctx.Redis.SIsMember("semantic:acme:" + kMV, key), "the entry must be listed in the tenant's index");
}
`,
  },
  debrief: `The deadline is on the call and there is no loop around it because a miss is already the slow path: a request that waited four seconds for the model should fail to its caller, who owns the retry budget, rather than wait twelve. A refusal is terminal for the same reason a 403 is: the model decided, and asking again spends money to hear it again. The gate exists because an entry is a promise that the stored text answers every question within 0.82 of this one; a sampled reply, a partial one or a tool result keep that promise for nobody. The policy version on the entry is what makes a policy change actionable later. A production client also hedges a second call at the tail, sends the serving policy with the request, and records the model's token usage per tenant.`,
};
