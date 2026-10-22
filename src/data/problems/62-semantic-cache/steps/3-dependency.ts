import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Answer calls on miss with a write-back contract',
  concept: 'grpc',
  file: 'client',
  focus: ['cache', 'llm', 'policy'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: on a cache miss it calls the
model, retries when the reply is refused or the call fails, and writes whatever came back into the
store. It compiles, the demo answers, and every flaw it has either burns model calls or poisons the
entry that the next near-duplicate question will hit. Review the miss path, fix it, prove the fix.

Implement the model client the cache calls on a miss:

- \`answer_once(channel, question)\` makes **exactly one** \`Answer\` call, carrying the **4-second**
  per-call deadline \`MODEL_DEADLINE_SECONDS\`. A miss without a deadline holds a request thread and a
  client timeout budget open on a stuck model, and a retry loop around it multiplies that wait by
  three. Retrying is the caller's decision, not the client's.
- **A refusal is terminal.** A reply whose \`refused\` flag is set raises \`RefusalError\`: the caller
  surfaces the refusal and nothing is cached, because the model already declined this question and
  asking again cannot turn that into a yes.
- \`is_cacheable(result)\` is the only gate on the write. It is true only when the answer is
  \`self_contained\`, \`deterministic\`, and its \`policy.cacheable\` flag is set. A sampled or partial
  answer is one instance of the model's distribution, and the index will serve that instance to
  every near-duplicate for the entry's TTL.
- **A tool-dependent answer is never cacheable.** Any result carrying \`tool_calls\` fails the gate
  and is returned to its own caller only: a tool result belongs to the question that triggered the
  tool, not to a question that merely looks similar.
- \`write_back(store, tenant, model_version, result)\` runs **only** for a cacheable answer and
  stores it under \`entry:{tenant}:{model_version}:{entry_id}\` together with
  \`policy_version: SERVING_POLICY_VERSION\` (\`"2024-06-1"\`). Without the version stamp, a change to
  the serving policy can never invalidate what the old policy approved.

**Failure mode the checks target.** Every flaw is the same confusion between "a reply arrived" and
"an answer may be reused". A refusal is a decision, a tool result is a fragment of one conversation,
and a sampled or partial answer is one draw from a distribution — yet the draft writes all of them
under a key whose whole promise is "this question has this answer". The retry loop is the other half:
it spends three model calls on a refusal that cannot change, and after the third it caches the
refusal, so the next near-duplicate question is answered "I can't help with that" for the entry's
whole TTL — with no policy version on it that could ever invalidate it.`,
  sequence: {
    participants: ['Client', 'Semantic Cache', 'Model service', 'Serving policy'],
    messages: [
      {from: 'Client', to: 'Semantic Cache', label: 'lookup · no hit above the floor', kind: 'sync'},
      {
        from: 'Semantic Cache',
        to: 'Model service',
        label: 'Answer(question) · deadline 4 s · one attempt',
        kind: 'sync',
      },
      {from: 'Model service', to: 'Semantic Cache', label: 'AnswerResult(text | refused | tool_calls)', kind: 'reply'},
      {from: 'Semantic Cache', to: 'Serving policy', label: 'is_cacheable(result)', kind: 'sync'},
      {
        from: 'Serving policy',
        to: 'Semantic Cache',
        label: 'self_contained · deterministic · cacheable',
        kind: 'reply',
      },
      {from: 'Semantic Cache', to: 'Semantic Cache', label: 'refused → RefusalError, nothing written', kind: 'sync'},
      {from: 'Semantic Cache', to: 'Semantic Cache', label: 'write back answer + policy_version', kind: 'async'},
      {from: 'Semantic Cache', to: 'Client', label: '200 answer · refusal surfaced', kind: 'reply'},
    ],
  },
  hints: [
    'The deadline is an argument of the call itself — `timeout=MODEL_DEADLINE_SECONDS`, a `deadline` of `Date.now() + MODEL_DEADLINE_SECONDS * 1000`, `context.WithTimeout(ctx, modelDeadlineSeconds*time.Second)`, `withDeadlineAfter(ModelDeadlineSeconds, TimeUnit.SECONDS)`, `set_deadline(now + std::chrono::seconds(kModelDeadlineSeconds))`. Delete the `for` loop while you are there: one miss is one attempt.',
    'Write the cacheability decision as one boolean before any write: `result.self_contained and result.deterministic and result.policy.cacheable`, and false for a refusal or for any result with `tool_calls`. Then `write_back` is a gate, a key and a store call — and "a tool-dependent answer is never stored" is that one boolean.',
    'Stamp the entry with the policy that approved it: `{"answer": …, "policy_version": SERVING_POLICY_VERSION}`. The version on the entry is what lets the next policy change invalidate the answers the old policy approved instead of guessing which ones to trust.',
  ],
  checks: [
    {
      id: 'deadline',
      title: 'One attempt under a 4-second deadline',
      detail:
        'The single `Answer` call carries the `MODEL_DEADLINE_SECONDS = 4` per-call deadline (`timeout=`, `deadline: Date.now() + 4s`, `context.WithTimeout`, `withDeadlineAfter`, `set_deadline`) and there is no retry loop around it. The draft calls the model with no bound and retries three times, so one stuck model turns a single miss into twelve seconds of held thread and connection.',
      match: {
        python: {
          all: [/MODEL_DEADLINE_SECONDS\s*=\s*4\b/, /timeout=MODEL_DEADLINE_SECONDS/, /\.Answer\(/],
          none: [/for\s+attempt\s+in\s+range/, /while\s+True/, /\bretry\s*\(/],
        },
        typescript: {
          all: [
            /MODEL_DEADLINE_SECONDS\s*=\s*4\b/,
            /deadline:\s*Date\.now\(\)\s*\+\s*MODEL_DEADLINE_SECONDS\s*\*\s*1_?000/,
            /\.Answer\(/,
          ],
          none: [/for\s*\(\s*let\s+attempt/, /while\s*\(/, /\bretry\s*\(/],
        },
        go: {
          all: [
            /modelDeadlineSeconds\s*=\s*4\b/,
            /context\.WithTimeout\(ctx,\s*modelDeadlineSeconds\s*\*\s*time\.Second\)/,
            /\.Answer\(/,
          ],
          none: [/for\s+attempt/, /\bwhile\b/, /\bretry\s*\(/],
        },
        scala: {
          all: [
            /ModelDeadlineSeconds\s*=\s*4L?\b/,
            /withDeadlineAfter\(ModelDeadlineSeconds,\s*TimeUnit\.SECONDS\)/,
            /\.answer\(/,
          ],
          none: [/while\s*\(/, /\bvar attempt\b/, /\bretry\s*\(/],
        },
        cpp: {
          all: [/kModelDeadlineSeconds\s*=\s*4\b/, /set_deadline\([^;]*kModelDeadlineSeconds/, /->Answer\(/],
          none: [/while\s*\(/, /for\s*\(\s*int\s+attempt/, /\bretry\s*\(/],
        },
      },
    },
    {
      id: 'refusal-terminal',
      title: 'A refusal is terminal',
      detail:
        'A refused reply raises `RefusalError` and is never retried and never written back: the model made a decision, and a cached refusal would answer an unrelated near-duplicate question with "I can not help with that" for the entry\u2019s whole TTL. The draft retries the refusal three times and then hands it to `write_back` like an answer.',
      match: {
        python: {all: [/class RefusalError/, /refused/, /raise RefusalError\(/]},
        typescript: {all: [/class RefusalError/, /refused/, /throw new RefusalError\(/]},
        go: {all: [/type RefusalError struct/, /Refused/, /&RefusalError\{/]},
        scala: {all: [/class RefusalError/, /refused/, /throw new RefusalError\(/]},
        cpp: {all: [/struct RefusalError/, /refused\(\)/, /throw RefusalError\(/]},
      },
    },
    {
      id: 'cacheable-gate',
      title: 'Only self-contained, deterministic, policy-cacheable answers are cached',
      detail:
        '`is_cacheable` is true only when the reply is `self_contained`, `deterministic` and its `policy.cacheable` flag is set; everything else is returned to its own caller and stored for nobody. The draft has no gate, so the first caller\u2019s sample or partial answer becomes the answer for the whole index.',
      match: {
        python: {all: [/def is_cacheable\(/, /self_contained/, /deterministic/, /policy\.cacheable/]},
        typescript: {all: [/isCacheable\s*[(=]/, /self_contained/, /deterministic/, /policy\.cacheable/]},
        go: {
          all: [
            /func isCacheable\(/,
            /GetSelfContained\(\)/,
            /GetDeterministic\(\)/,
            /GetPolicy\(\)\.GetCacheable\(\)/,
          ],
        },
        scala: {all: [/def isCacheable\(/, /selfContained/, /deterministic/, /\.getPolicy\.cacheable/]},
        cpp: {all: [/bool isCacheable\(/, /self_contained\(\)/, /deterministic\(\)/, /policy\(\)\.cacheable\(\)/]},
      },
    },
    {
      id: 'no-tool-cache',
      title: 'A tool-dependent answer is never cached',
      detail:
        'A result carrying `tool_calls` fails the gate and returns false: a tool result belongs to the question that triggered the tool, not to every near-duplicate the index will match. The draft stores it like any other answer, so a one-time tool result is served as an answer for an hour.',
      match: {
        python: {all: [/if[^\n]*tool_calls[^\n]*:/, /return False/]},
        typescript: {all: [/if[^\n]*tool_calls[^\n]*\)/, /return false/]},
        go: {all: [/if[^\n]*ToolCalls[^\n]*\{/, /return false/]},
        scala: {all: [/if\s*\([^\n]*toolCalls[^\n]*\)/, /\bfalse\b/]},
        cpp: {all: [/if\s*\([^\n]*tool_calls_size\(\)[^\n]*\)/, /return false/]},
      },
    },
    {
      id: 'policy-version',
      title: 'Cacheable answers carry their policy version',
      detail:
        'The entry written back carries `policy_version: SERVING_POLICY_VERSION` (`"2024-06-1"`), so a policy change can invalidate every answer the old policy approved. The draft stores the answer with no version, so a policy change can never reach the entries already in the index.',
      match: {
        python: {all: [/SERVING_POLICY_VERSION\s*=\s*["']2024-06-1["']/, /"policy_version"\s*:/]},
        typescript: {all: [/SERVING_POLICY_VERSION\s*=\s*'2024-06-1'/, /policy_version\s*:/]},
        go: {all: [/servingPolicyVersion\s*=\s*"2024-06-1"/, /json:"policy_version"/]},
        scala: {all: [/ServingPolicyVersion\s*=\s*"2024-06-1"/, /policy_version/]},
        cpp: {all: [/kServingPolicyVersion\s*=\s*"2024-06-1"/, /"policy_version"/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import uuid

import grpc

import answer_pb2
import answer_pb2_grpc


class EntryStore:
    def put(self, key: str, entry: dict) -> None:
        """Write an entry under key = entry:{tenant}:{model_version}:{entry_id}."""
        raise NotImplementedError


def answer_once(channel: grpc.Channel, question: str):
    # TODO: this draft calls the model with no deadline, retries three times — the refusal
    # included — and writes every reply: a refusal or a tool-dependent answer becomes the answer
    # for the next near-duplicate, and no policy version is stamped on the entry. Review it all.
    stub = answer_pb2_grpc.AnswerServiceStub(channel)
    reply = None
    for attempt in range(3):
        try:
            reply = stub.Answer(answer_pb2.AnswerRequest(question=question))
        except grpc.RpcError:
            continue
        if not reply.refused:
            break
    if reply is None:
        raise RuntimeError("model unavailable")
    return reply


def write_back(store: EntryStore, tenant: str, model_version: str, result) -> str:
    entry_id = str(uuid.uuid4())
    store.put(
        f"entry:{tenant}:{model_version}:{entry_id}",
        {"answer": result.text, "refused": result.refused},
    )
    return entry_id
`,
      solution: `import uuid

import grpc

import answer_pb2
import answer_pb2_grpc

MODEL_DEADLINE_SECONDS = 4
SERVING_POLICY_VERSION = "2024-06-1"


class RefusalError(Exception):
    """The model declined to answer: terminal for this question, and never cacheable."""


class EntryStore:
    def put(self, key: str, entry: dict) -> None:
        """Write an entry under key = entry:{tenant}:{model_version}:{entry_id}."""
        raise NotImplementedError


def answer_once(channel: grpc.Channel, question: str):
    """One Answer call per miss, under the 4-second deadline; a refusal is raised, not returned."""
    stub = answer_pb2_grpc.AnswerServiceStub(channel)
    reply = stub.Answer(answer_pb2.AnswerRequest(question=question), timeout=MODEL_DEADLINE_SECONDS)
    if reply.refused:
        raise RefusalError(reply.refusal_reason)
    return reply


def is_cacheable(result) -> bool:
    """Only a self-contained, deterministic answer the serving policy allows may be reused."""
    if result.refused or result.tool_calls:
        return False
    return bool(result.self_contained and result.deterministic and result.policy.cacheable)


def write_back(store: EntryStore, tenant: str, model_version: str, result) -> str | None:
    """Store the answer with the policy version that approved it; nothing else is ever stored."""
    if not is_cacheable(result):
        return None
    entry_id = str(uuid.uuid4())
    store.put(
        f"entry:{tenant}:{model_version}:{entry_id}",
        {"answer": result.text, "policy_version": SERVING_POLICY_VERSION},
    )
    return entry_id
`,
    },
    typescript: {
      starter: `/** The model client the cache calls on a miss: a model-generated draft. */
import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';

interface AnswerResult {
  text: string;
  refused: boolean;
  refusal_reason: string;
  self_contained: boolean;
  deterministic: boolean;
  tool_calls: string[];
  policy: {cacheable: boolean};
}

interface AnswerClient {
  Answer(
    request: {question: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: AnswerResult) => void,
  ): grpc.ClientUnaryCall;
}

interface EntryStore {
  put(key: string, entry: Record<string, unknown>): Promise<void>;
}

export async function answerOnce(stub: AnswerClient, question: string): Promise<AnswerResult> {
  // TODO: this draft calls the model with no deadline, retries three times — the refusal included —
  // and writes every reply: a refusal or a tool-dependent answer becomes the answer for the next
  // near-duplicate, and no policy version is stamped on the entry. Review all of it.
  let reply: AnswerResult | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      reply = await new Promise<AnswerResult>((resolve, reject) => {
        stub.Answer({question}, new grpc.Metadata(), {}, (error, value) => {
          if (error === null) resolve(value);
          else reject(error);
        });
      });
    } catch {
      continue;
    }
    if (!reply.refused) break;
  }
  if (reply === null) throw new Error('model unavailable');
  return reply;
}

export async function writeBack(
  store: EntryStore,
  tenant: string,
  modelVersion: string,
  result: AnswerResult,
): Promise<string> {
  const entryId = randomUUID();
  await store.put('entry:' + tenant + ':' + modelVersion + ':' + entryId, {
    answer: result.text,
    refused: result.refused,
  });
  return entryId;
}
`,
      solution: `/** The model client the cache calls on a miss: one deadline-bounded attempt and a gated write-back. */
import {randomUUID} from 'node:crypto';

import * as grpc from '@grpc/grpc-js';

export const MODEL_DEADLINE_SECONDS = 4;
export const SERVING_POLICY_VERSION = '2024-06-1';

export class RefusalError extends Error {}

export interface AnswerResult {
  text: string;
  refused: boolean;
  refusal_reason: string;
  self_contained: boolean;
  deterministic: boolean;
  tool_calls: string[];
  policy: {cacheable: boolean};
}

export interface AnswerClient {
  Answer(
    request: {question: string},
    metadata: grpc.Metadata,
    options: {deadline?: number},
    callback: (error: grpc.ServiceError | null, reply: AnswerResult) => void,
  ): grpc.ClientUnaryCall;
}

export interface EntryStore {
  put(key: string, entry: Record<string, unknown>): Promise<void>;
}

export async function answerOnce(stub: AnswerClient, question: string): Promise<AnswerResult> {
  const reply = await new Promise<AnswerResult>((resolve, reject) => {
    stub.Answer(
      {question},
      new grpc.Metadata(),
      {deadline: Date.now() + MODEL_DEADLINE_SECONDS * 1_000},
      (error, value) => {
        if (error === null) resolve(value);
        else reject(error);
      },
    );
  });
  if (reply.refused) throw new RefusalError(reply.refusal_reason);
  return reply;
}

export function isCacheable(result: AnswerResult): boolean {
  if (result.refused || result.tool_calls.length > 0) return false;
  return result.self_contained && result.deterministic && result.policy.cacheable;
}

export async function writeBack(
  store: EntryStore,
  tenant: string,
  modelVersion: string,
  result: AnswerResult,
): Promise<string | null> {
  if (!isCacheable(result)) return null;
  const entryId = randomUUID();
  await store.put('entry:' + tenant + ':' + modelVersion + ':' + entryId, {
    answer: result.text,
    policy_version: SERVING_POLICY_VERSION,
  });
  return entryId;
}
`,
    },
    go: {
      starter: `package client

import (
	"context"
	"fmt"

	"github.com/google/uuid"

	pb "semcache/answerpb"
)

// CacheEntry is one cached answer.
type CacheEntry struct {
	Answer string \`json:"answer"\`
}

// EntryStore is the cache store this client writes entries into.
type EntryStore struct{}

func (s *EntryStore) Put(ctx context.Context, key string, entry CacheEntry) error {
	return nil
}

func answerOnce(ctx context.Context, client pb.AnswerServiceClient, question string) (*pb.AnswerResult, error) {
	// TODO: this draft calls the model with no deadline, retries three times — the refusal
	// included — and writes every reply: a refusal or a tool-dependent answer becomes the answer
	// for the next near-duplicate, and no policy version is stamped on the entry. Review it all.
	var reply *pb.AnswerResult
	for attempt := 0; attempt < 3; attempt++ {
		got, err := client.Answer(ctx, &pb.AnswerRequest{Question: question})
		if err != nil {
			continue
		}
		reply = got
		if !got.GetRefused() {
			break
		}
	}
	if reply == nil {
		return nil, fmt.Errorf("model unavailable")
	}
	return reply, nil
}

func writeBack(ctx context.Context, store *EntryStore, tenant, modelVersion string, result *pb.AnswerResult) (string, error) {
	entryID := uuid.NewString()
	entry := CacheEntry{Answer: result.GetText()}
	if err := store.Put(ctx, fmt.Sprintf("entry:%s:%s:%s", tenant, modelVersion, entryID), entry); err != nil {
		return "", err
	}
	return entryID, nil
}
`,
      solution: `package client

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	pb "semcache/answerpb"
)

const (
	modelDeadlineSeconds = 4
	servingPolicyVersion = "2024-06-1"
)

// RefusalError means the model declined to answer: terminal for this question, and never cacheable.
type RefusalError struct {
	Reason string
}

func (e *RefusalError) Error() string {
	return "model refused: " + e.Reason
}

// CacheEntry is what the store keeps for the next lookup.
type CacheEntry struct {
	Answer        string \`json:"answer"\`
	PolicyVersion string \`json:"policy_version"\`
}

// EntryStore is the cache store this client writes entries into.
type EntryStore struct{}

func (s *EntryStore) Put(ctx context.Context, key string, entry CacheEntry) error {
	return nil
}

func answerOnce(ctx context.Context, client pb.AnswerServiceClient, question string) (*pb.AnswerResult, error) {
	callCtx, cancel := context.WithTimeout(ctx, modelDeadlineSeconds*time.Second)
	defer cancel()
	reply, err := client.Answer(callCtx, &pb.AnswerRequest{Question: question})
	if err != nil {
		return nil, err
	}
	if reply.GetRefused() {
		return nil, &RefusalError{Reason: reply.GetRefusalReason()}
	}
	return reply, nil
}

func isCacheable(result *pb.AnswerResult) bool {
	if result.GetRefused() || len(result.GetToolCalls()) > 0 {
		return false
	}
	return result.GetSelfContained() && result.GetDeterministic() && result.GetPolicy().GetCacheable()
}

func writeBack(ctx context.Context, store *EntryStore, tenant, modelVersion string, result *pb.AnswerResult) (string, error) {
	if !isCacheable(result) {
		return "", nil
	}
	entryID := uuid.NewString()
	entry := CacheEntry{Answer: result.GetText(), PolicyVersion: servingPolicyVersion}
	if err := store.Put(ctx, fmt.Sprintf("entry:%s:%s:%s", tenant, modelVersion, entryID), entry); err != nil {
		return "", err
	}
	return entryID, nil
}
`,
    },
    scala: {
      starter: `import java.util.UUID

import io.grpc.StatusRuntimeException

import answer.AnswerServiceGrpc
import answer.AnswerOuterClass.{AnswerRequest, AnswerResult}

final case class CacheEntry(answer: String)

trait EntryStore {
  def put(key: String, entry: CacheEntry): Unit
}

object AnswerClient {
  def answerOnce(stub: AnswerServiceGrpc.AnswerServiceBlockingStub, question: String): AnswerResult = {
    // TODO: this draft calls the model with no deadline, retries three times — the refusal
    // included — and writes every reply: a refusal or a tool-dependent answer becomes the answer
    // for the next near-duplicate, and no policy version is stamped on the entry. Review it all.
    var reply: Option[AnswerResult] = None
    var attempt = 0
    while (attempt < 3) {
      attempt += 1
      try {
        val got = stub.answer(AnswerRequest(question = question))
        reply = Some(got)
        if (!got.refused) return got
      } catch {
        case _: StatusRuntimeException => ()
      }
    }
    reply.getOrElse(throw new RuntimeException("model unavailable"))
  }

  def writeBack(store: EntryStore, tenant: String, modelVersion: String, result: AnswerResult): String = {
    val entryId = UUID.randomUUID().toString
    store.put(s"entry:$tenant:$modelVersion:$entryId", CacheEntry(answer = result.text))
    entryId
  }
}
`,
      solution: `import java.util.UUID
import java.util.concurrent.TimeUnit

import answer.AnswerServiceGrpc
import answer.AnswerOuterClass.{AnswerRequest, AnswerResult}

final case class CacheEntry(answer: String, policy_version: String)

trait EntryStore {
  def put(key: String, entry: CacheEntry): Unit
}

object AnswerClient {
  val ModelDeadlineSeconds = 4L
  val ServingPolicyVersion = "2024-06-1"

  class RefusalError(reason: String) extends RuntimeException(reason)

  def answerOnce(stub: AnswerServiceGrpc.AnswerServiceBlockingStub, question: String): AnswerResult = {
    val reply = stub.withDeadlineAfter(ModelDeadlineSeconds, TimeUnit.SECONDS).answer(AnswerRequest(question = question))
    if (reply.refused) throw new RefusalError(reply.refusalReason)
    reply
  }

  def isCacheable(result: AnswerResult): Boolean =
    if (result.refused || result.toolCalls.nonEmpty) false
    else result.selfContained && result.deterministic && result.getPolicy.cacheable

  def writeBack(store: EntryStore, tenant: String, modelVersion: String, result: AnswerResult): Option[String] =
    if (!isCacheable(result)) None
    else {
      val entryId = UUID.randomUUID().toString
      store.put(
        s"entry:$tenant:$modelVersion:$entryId",
        CacheEntry(answer = result.text, policy_version = ServingPolicyVersion)
      )
      Some(entryId)
    }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <optional>
#include <string>

#include "answer.grpc.pb.h"

// EntryStore is the cache store this client writes entries into.
struct EntryStore {
  void put(const std::string& key, const nlohmann::json& entry);
};

std::string uuidString();

std::optional<answer::AnswerResult> answerOnce(answer::AnswerService::StubInterface* stub,
                                               const std::string& question) {
  // TODO: this draft calls the model with no deadline, retries three times — the refusal
  // included — and writes every reply: a refusal or a tool-dependent answer becomes the answer
  // for the next near-duplicate, and no policy version is stamped on the entry. Review it all.
  answer::AnswerRequest request;
  request.set_question(question);
  std::optional<answer::AnswerResult> reply;
  for (int attempt = 0; attempt < 3; ++attempt) {
    grpc::ClientContext context;
    answer::AnswerResult got;
    const grpc::Status status = stub->Answer(&context, request, &got);
    if (status.ok()) reply = got;
    if (status.ok() && !got.refused()) break;
  }
  return reply;
}

std::string writeBack(EntryStore& store, const std::string& tenant, const std::string& modelVersion,
                      const answer::AnswerResult& result) {
  const std::string entryId = uuidString();
  store.put("entry:" + tenant + ":" + modelVersion + ":" + entryId,
            nlohmann::json{{"answer", result.text()}, {"refused", result.refused()}});
  return entryId;
}
`,
      solution: `#include <grpcpp/grpcpp.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <optional>
#include <stdexcept>
#include <string>

#include "answer.grpc.pb.h"

constexpr int kModelDeadlineSeconds = 4;
const std::string kServingPolicyVersion = "2024-06-1";

// RefusalError means the model declined: terminal for this question, and never cacheable.
struct RefusalError : std::runtime_error {
  explicit RefusalError(const std::string& reason) : std::runtime_error(reason) {}
};

// EntryStore is the cache store this client writes entries into.
struct EntryStore {
  void put(const std::string& key, const nlohmann::json& entry);
};

std::string uuidString();

answer::AnswerResult answerOnce(answer::AnswerService::StubInterface* stub, const std::string& question) {
  answer::AnswerRequest request;
  request.set_question(question);
  grpc::ClientContext context;
  context.set_deadline(std::chrono::system_clock::now() + std::chrono::seconds(kModelDeadlineSeconds));
  answer::AnswerResult reply;
  const grpc::Status status = stub->Answer(&context, request, &reply);
  if (!status.ok()) throw std::runtime_error("model call failed: " + status.error_message());
  if (reply.refused()) throw RefusalError(reply.refusal_reason());
  return reply;
}

bool isCacheable(const answer::AnswerResult& result) {
  if (result.refused() || result.tool_calls_size() > 0) return false;
  return result.self_contained() && result.deterministic() && result.policy().cacheable();
}

std::optional<std::string> writeBack(EntryStore& store, const std::string& tenant, const std::string& modelVersion,
                                     const answer::AnswerResult& result) {
  if (!isCacheable(result)) return std::nullopt;
  const std::string entryId = uuidString();
  store.put("entry:" + tenant + ":" + modelVersion + ":" + entryId,
            nlohmann::json{{"answer", result.text()}, {"policy_version", kServingPolicyVersion}});
  return entryId;
}
`,
    },
  },
  debrief: `The interviewer is testing the miss path, which a generated draft always gets "working" because the demo's model only ever returns text. The four defects are one idea: a cache entry is a promise about future questions, so only an answer that is self-contained, deterministic and approved by the serving policy may be written — a refusal is a decision about one question, and a tool result is a fragment of one conversation, so both are returned to their own caller and stored for nobody. The 4-second deadline and the single attempt are the other half of the contract: without them one slow or refusing model turns a single miss into three calls and an unbounded wait. Real clients add jittered backoff one layer above, shadow traffic that compares cached answers against fresh ones before the cache is trusted, and a policy version on every entry so a policy change can invalidate what the old policy approved.`,
};
