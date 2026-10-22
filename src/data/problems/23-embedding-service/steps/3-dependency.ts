import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Model server calls with deadline and fallback',
  concept: 'grpc',
  file: 'client',
  focus: ['api', 'model', 'fallback'],
  task: `## Task

**Review premise.** The starter is a plausible model-generated draft: while the model server is up
every input gets a vector. Every failure path is wrong. Find them, fix them, and prove the fix.

Implement \`embed(text, model_version)\`, the one call the write path makes:

- Each attempt carries a **2-second deadline** (\`DEADLINE_S = 2.0\`). A call without one lets one
  slow model server pin a worker for the whole batch.
- At most **2 attempts** and only \`UNAVAILABLE\` is retryable. A malformed input — \`INVALID_ARGUMENT\`
  — is returned to the caller immediately: retrying it wastes the budget and still fails.
- When the attempts run out, the input is embedded by the **fallback model**; because the fallback has
  a different dimension, its vectors go to a **different cache namespace** (\`{version}+fallback\`) and
  are never mixed into the primary's.
- The returned vector's dimension is checked against the namespace it would be cached under: a
  wrong-dimension fallback must raise instead of being returned as a primary vector.

**Failure mode the checks target.** The draft retries every status forever, so a bad deployment
becomes a hot loop against the service that is already down. It caches by content hash alone, so the
fallback's 384-dimension vector overwrites the primary's 1024-dimension one. And it returns the
fallback vector silently, so a shape mismatch only surfaces when retrieval ranks garbage.`,
  sequence: {
    participants: ['Embedding API', 'Model server', 'Fallback model'],
    messages: [
      {from: 'Embedding API', to: 'Model server', label: 'Embed(text) · deadline 2 s', kind: 'sync'},
      {from: 'Model server', to: 'Embedding API', label: 'UNAVAILABLE / INVALID_ARGUMENT', kind: 'reply'},
      {from: 'Embedding API', to: 'Embedding API', label: 'retry only UNAVAILABLE · attempt ≤ 2', kind: 'sync'},
      {from: 'Embedding API', to: 'Fallback model', label: 'Embed(text) · namespace {version}+fallback', kind: 'sync'},
      {from: 'Fallback model', to: 'Embedding API', label: '384-dimension vector', kind: 'reply'},
      {
        from: 'Embedding API',
        to: 'Embedding API',
        label: 'dimension guard: refuse under the primary version',
        kind: 'sync',
      },
    ],
  },
  hints: [
    'The deadline belongs on the call itself — `timeout=`, `deadline:`, `WithTimeout`, `withDeadlineAfter`, `set_deadline`. Bound the attempts with a constant; an unbounded loop has no exit for a permanent error.',
    'Retryability is a property of the status: capture the error, retry only `UNAVAILABLE`, and return `INVALID_ARGUMENT` immediately.',
    "Give the fallback its own namespace and check the vector's dimension before returning it — the fallback's shape must never be cached under the primary version.",
  ],
  checks: [
    {
      id: 'deadline',
      title: 'Every attempt carries a 2-second deadline',
      detail:
        'The call is created with a 2-second deadline (`DEADLINE_S`, `deadline: Date.now() + …`, `WithTimeout`, `withDeadlineAfter`, `set_deadline`). Without it one stuck model server pins the worker.',
      match: {
        python: {all: [/DEADLINE_S\s*=\s*2\b/, /timeout=DEADLINE_S/]},
        typescript: {all: [/DEADLINE_MS\s*=\s*2000/, /deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/deadlineMS\s*=\s*2000/, /context\.WithTimeout/]},
        scala: {all: [/DeadlineMs\s*=\s*2000/, /withDeadlineAfter/]},
        cpp: {all: [/kDeadlineMs\s*=\s*2000/, /set_deadline\(/]},
      },
    },
    {
      id: 'bounded-attempts',
      title: 'At most two attempts, only UNAVAILABLE retried',
      detail:
        'Attempts are bounded (`MAX_ATTEMPTS = 2`) and only `UNAVAILABLE` is retryable; `INVALID_ARGUMENT` is returned immediately. The draft retries every error forever.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /RETRYABLE/, /UNAVAILABLE/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*2\b/, /RETRYABLE/, /UNAVAILABLE/]},
        go: {all: [/maxAttempts\s*=\s*2\b/, /retryable/, /Unavailable/]},
        scala: {all: [/MaxAttempts\s*=\s*2\b/, /Retryable/, /UNAVAILABLE/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2\b/, /kRetryable/, /UNAVAILABLE/]},
      },
    },
    {
      id: 'namespace',
      title: 'Switches the cache namespace for the fallback',
      detail:
        "The cache namespace is a function of the model version and whether the fallback was used, so the fallback's vectors never land under the primary version. The draft caches both under one namespace.",
      match: {
        python: {all: [/def cache_namespace\(/, /used_fallback/]},
        typescript: {all: [/function cacheNamespace\(/, /usedFallback/]},
        go: {all: [/func cacheNamespace\(/, /usedFallback/]},
        scala: {all: [/def cacheNamespace\(/, /usedFallback/]},
        cpp: {all: [/cache_namespace\(/, /used_fallback/]},
      },
    },
    {
      id: 'dimension-guard',
      title: 'Refuses a wrong-dimension vector',
      detail:
        "The vector length is compared with the dimension of the namespace it would be cached under. The draft returns the fallback's 384-dimension vector as if it were a primary 1024-dimension one.",
      match: {
        python: {all: [/PRIMARY_DIMENSION\s*=\s*1024/, /len\(vector\)\s*!=\s*expected/]},
        typescript: {all: [/PRIMARY_DIMENSION\s*=\s*1024/, /vector\.length\s*!==\s*expected/]},
        go: {all: [/primaryDimension\s*=\s*1024/, /len\(vector\)\s*!=\s*expected/]},
        scala: {all: [/PrimaryDimension\s*=\s*1024/, /vector\.length\s*!=\s*expected/]},
        cpp: {all: [/kPrimaryDimension\s*=\s*1024/, /vector\.size\(\)\s*!=\s*expected/]},
      },
    },
    {
      id: 'fallback',
      title: 'Fails over to the fallback model',
      detail:
        "When the primary's attempts are exhausted the input is embedded by the fallback model instead of failing the batch. The draft has no fallback path with its own namespace.",
      match: {
        python: {all: [/FALLBACK_MODEL/, /fallback_stub\.Embed\(/]},
        typescript: {all: [/FALLBACK_MODEL/, /fallbackClient\.Embed\(/]},
        go: {all: [/fallbackModel/, /fallbackClient\.Embed\(/]},
        scala: {all: [/FallbackModel/, /fallbackStub/, /\.embed\(/]},
        cpp: {all: [/kFallbackModel/, /fallback_stub->Embed\(/]},
      },
    },
  ],
  code: {
    python: {
      starter: `"""Draft: the model server call — retries every status forever, no dimension guard."""
import grpc

TIMEOUT_S = 2.0


def embed(text: str, model_version: str) -> dict:
    # TODO: retries every status forever, never guards the vector's dimension, and lets the
    # fallback's shape mix into the primary namespace.
    while True:
        try:
            reply = primary_stub.Embed(Request(text=text, model_version=model_version), timeout=TIMEOUT_S)
            return {"vector": list(reply.vector)}
        except Exception:
            reply = fallback_stub.Embed(Request(text=text), timeout=TIMEOUT_S)
            return {"vector": list(reply.vector)}
`,
      solution: `"""The model server call — bounded retries, a dimension guard and a fallback namespace."""
import grpc

DEADLINE_S = 2.0
MAX_ATTEMPTS = 2
PRIMARY_DIMENSION = 1024
FALLBACK_DIMENSION = 384
FALLBACK_MODEL = "text-embedding-fallback"
RETRYABLE = {grpc.StatusCode.UNAVAILABLE}


class DimensionMismatch(RuntimeError):
    """A vector whose shape does not match the namespace it would be cached under."""


def cache_namespace(model_version: str, used_fallback: bool) -> str:
    """The fallback's vectors live in their own namespace, never mixed into the primary's."""
    return f"{model_version}+fallback" if used_fallback else model_version


def _checked(vector: list[float], expected: int) -> list[float]:
    if len(vector) != expected:
        raise DimensionMismatch(f"expected {expected} dimensions, got {len(vector)}")
    return vector


def embed(text: str, model_version: str) -> dict:
    """Embed one input; the fallback keeps its own cache namespace."""
    for _ in range(MAX_ATTEMPTS):
        try:
            reply = primary_stub.Embed(Request(text=text, model_version=model_version), timeout=DEADLINE_S)
            vector = _checked(list(reply.vector), PRIMARY_DIMENSION)
            return {"namespace": cache_namespace(model_version, False), "vector": vector}
        except grpc.RpcError as exc:
            if exc.code() not in RETRYABLE:
                raise
    reply = fallback_stub.Embed(Request(text=text, model_version=FALLBACK_MODEL), timeout=DEADLINE_S)
    vector = _checked(list(reply.vector), FALLBACK_DIMENSION)
    return {"namespace": cache_namespace(FALLBACK_MODEL, True), "vector": vector}
`,
    },
    typescript: {
      starter: `/** Draft: the model server call — retries every status forever, no dimension guard. */
import * as grpc from '@grpc/grpc-js';

const TIMEOUT_MS = 2_000;

declare const primaryStub: {
  Embed(request: unknown, options: {deadline: number}): Promise<{vector: number[]}>;
};
declare const fallbackStub: {
  Embed(request: unknown, options: {deadline: number}): Promise<{vector: number[]}>;
};

export async function embed(text: string, modelVersion: string): Promise<{vector: number[]}> {
  // TODO: retries every status forever, never guards the vector's dimension, and lets the
  // fallback's shape mix into the primary namespace.
  for (;;) {
    try {
      const reply = await primaryStub.Embed({text, model_version: modelVersion}, {deadline: Date.now() + TIMEOUT_MS});
      return {vector: reply.vector};
    } catch {
      const reply = await fallbackStub.Embed({text}, {deadline: Date.now() + TIMEOUT_MS});
      return {vector: reply.vector};
    }
  }
}
`,
      solution: `/** The model server call — bounded retries, a dimension guard and a fallback namespace. */
import * as grpc from '@grpc/grpc-js';

const DEADLINE_MS = 2000;
const MAX_ATTEMPTS = 2;
const PRIMARY_DIMENSION = 1024;
const FALLBACK_DIMENSION = 384;
const FALLBACK_MODEL = 'text-embedding-fallback';
const RETRYABLE: Record<number, true> = {[grpc.status.UNAVAILABLE]: true};

declare const primaryStub: {Embed(request: unknown, options: {deadline: number}): Promise<{vector: number[]}>};
declare const fallbackClient: {Embed(request: unknown, options: {deadline: number}): Promise<{vector: number[]}>;

/** The fallback's vectors live in their own namespace, never mixed into the primary's. */
function cacheNamespace(modelVersion: string, usedFallback: boolean): string {
  return usedFallback ? \`\${modelVersion}+fallback\` : modelVersion;
}

function checked(vector: number[], expected: number): number[] {
  if (vector.length !== expected) {
    throw new Error(\`expected \${expected} dimensions, got \${vector.length}\`);
  }
  return vector;
}

export async function embed(text: string, modelVersion: string): Promise<{namespace: string; vector: number[]}> {
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const reply = await primaryStub.Embed({text, model_version: modelVersion}, {deadline: Date.now() + DEADLINE_MS});
      return {namespace: cacheNamespace(modelVersion, false), vector: checked(reply.vector, PRIMARY_DIMENSION)};
    } catch (error) {
      lastError = error;
      const code = (error as grpc.ServiceError).code;
      if (RETRYABLE[code] !== true) throw error;
    }
  }
  void lastError;
  const reply = await fallbackClient.Embed({text, model_version: FALLBACK_MODEL}, {deadline: Date.now() + DEADLINE_MS});
  return {namespace: cacheNamespace(FALLBACK_MODEL, true), vector: checked(reply.vector, FALLBACK_DIMENSION)};
}
`,
    },
    go: {
      starter: `// Draft: the model server call — retries every status forever, no dimension guard.
package main

import (
	"context"
	"time"
)

const timeoutMS = 2000

type modelClient interface {
	Embed(ctx context.Context, text string) ([]float32, error)
}

// embed retries every status forever and never guards the vector's dimension.
func embed(ctx context.Context, primary modelClient, fallback modelClient, text, modelVersion string) ([]float32, error) {
	// TODO: bound the attempts, retry only UNAVAILABLE, switch the fallback's namespace and check
	// the vector's dimension before returning it.
	for {
		callCtx, cancel := context.WithTimeout(ctx, timeoutMS*time.Millisecond)
		vector, err := primary.Embed(callCtx, text)
		cancel()
		if err == nil {
			return vector, nil
		}
		callCtx, cancel = context.WithTimeout(ctx, timeoutMS*time.Millisecond)
		vector, err = fallback.Embed(callCtx, text)
		cancel()
		if err == nil {
			return vector, nil
		}
	}
}
`,
      solution: `// The model server call — bounded retries, a dimension guard and a fallback namespace.
package main

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	deadlineMS        = 2000
	maxAttempts       = 2
	primaryDimension  = 1024
	fallbackDimension = 384
	fallbackModel     = "text-embedding-fallback"
)

var retryable = map[codes.Code]bool{codes.Unavailable: true}

type modelClient interface {
	Embed(ctx context.Context, text, modelVersion string) ([]float32, error)
}

// cacheNamespace is the fallback's own namespace: its vectors are never mixed into the primary's.
func cacheNamespace(modelVersion string, usedFallback bool) string {
	if usedFallback {
		return modelVersion + "+fallback"
	}
	return modelVersion
}

func checked(vector []float32, expected int) ([]float32, error) {
	if len(vector) != expected {
		return nil, fmt.Errorf("expected %d dimensions, got %d", expected, len(vector))
	}
	return vector, nil
}

// embed calls the model server under a deadline and falls over to the fallback model.
func embed(
	ctx context.Context,
	primary, fallbackClient modelClient,
	text, modelVersion string,
) (string, []float32, error) {
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
		vector, err := primary.Embed(callCtx, text, modelVersion)
		cancel()
		if err == nil {
			checkedVector, checkErr := checked(vector, primaryDimension)
			if checkErr != nil {
				return "", nil, checkErr
			}
			return cacheNamespace(modelVersion, false), checkedVector, nil
		}
		lastErr = err
		if !retryable[status.Code(err)] {
			return "", nil, err
		}
	}
	callCtx, cancel := context.WithTimeout(ctx, deadlineMS*time.Millisecond)
	defer cancel()
	vector, err := fallbackClient.Embed(callCtx, text, fallbackModel)
	if err != nil {
		return "", nil, errors.Join(lastErr, err)
	}
	checkedVector, checkErr := checked(vector, fallbackDimension)
	if checkErr != nil {
		return "", nil, checkErr
	}
	return cacheNamespace(fallbackModel, true), checkedVector, nil
}
`,
    },
    scala: {
      starter: `// Draft: the model server call — retries every status forever, no dimension guard.
import scala.concurrent.Future

import io.grpc.StatusRuntimeException

object ModelClient {
  val TimeoutMs = 2000

  def embed(text: String, modelVersion: String): Future[Vector[Float]] = {
    // TODO: bound the attempts, retry only UNAVAILABLE, switch the fallback's namespace and check
    // the vector's dimension before returning it.
    def loop(): Future[Vector[Float]] =
      primaryStub.embed(Request(text, modelVersion)).recoverWith { case _: StatusRuntimeException =>
        fallbackStub.embed(Request(text)).recoverWith { case _: StatusRuntimeException => loop() }
      }
    loop()
  }
}
`,
      solution: `// The model server call — bounded retries, a dimension guard and a fallback namespace.
import java.util.concurrent.TimeUnit

import io.grpc.{Status, StatusRuntimeException}

object ModelClient {
  val DeadlineMs = 2000
  val MaxAttempts = 2
  val PrimaryDimension = 1024
  val FallbackDimension = 384
  val FallbackModel = "text-embedding-fallback"
  val Retryable = Set(Status.Code.UNAVAILABLE)

  final case class Result(namespace: String, vector: Vector[Float])

  class DimensionMismatch(message: String) extends RuntimeException(message)

  /** The fallback's vectors live in their own namespace, never mixed into the primary's. */
  def cacheNamespace(modelVersion: String, usedFallback: Boolean): String =
    if (usedFallback) s"$modelVersion+fallback" else modelVersion

  def checked(vector: Vector[Float], expected: Int): Vector[Float] = {
    if (vector.length != expected) throw new DimensionMismatch(s"expected $expected dimensions")
    vector
  }

  /** Calls the model server under a deadline and falls over to the fallback model. */
  def embed(text: String, modelVersion: String): Result = {
    var attempt = 0
    var lastError: StatusRuntimeException = null
    while (attempt < MaxAttempts) {
      try {
        val reply = primaryStub
          .withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS)
          .embed(Request(text, modelVersion))
        return Result(cacheNamespace(modelVersion, false), checked(reply.vector, PrimaryDimension))
      } catch {
        case exc: StatusRuntimeException =>
          lastError = exc
          if (!Retryable.contains(exc.getStatus.getCode)) throw exc
      }
      attempt += 1
    }
    val reply = fallbackStub
      .withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS)
      .embed(Request(text, FallbackModel))
    if (reply == null && lastError != null) throw lastError
    Result(cacheNamespace(FallbackModel, true), checked(reply.vector, FallbackDimension))
  }
}
`,
    },
    cpp: {
      starter: `// Draft: the model server call — retries every status forever, no dimension guard.
#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>
#include <vector>

constexpr int kTimeoutMs = 2000;

std::vector<float> embed(
    Model::Stub* primary,
    Model::Stub* fallbackStub,
    const std::string& text,
    const std::string& modelVersion) {
  // TODO: bound the attempts, retry only UNAVAILABLE, switch the fallback's namespace and check
  // the vector's dimension before returning it.
  while (true) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kTimeoutMs));
    EmbedRequest request;
    request.set_text(text);
    request.set_model_version(modelVersion);
    EmbedReply reply;
    if (primary->Embed(&ctx, request, &reply).ok()) return {};
    grpc::ClientContext fallbackCtx;
    fallbackCtx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kTimeoutMs));
    if (fallbackStub->Embed(&fallbackCtx, request, &reply).ok()) return {};
  }
}
`,
      solution: `// The model server call — bounded retries, a dimension guard and a fallback namespace.
#include <grpcpp/grpcpp.h>

#include <chrono>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

constexpr int kDeadlineMs = 2000;
constexpr int kMaxAttempts = 2;
constexpr int kPrimaryDimension = 1024;
constexpr int kFallbackDimension = 384;
constexpr char kFallbackModel[] = "text-embedding-fallback";
const std::set<grpc::StatusCode> kRetryable{grpc::StatusCode::UNAVAILABLE};

struct Embedding {
  std::string namespace_;
  std::vector<float> vector;
};

/** The fallback's vectors live in their own namespace, never mixed into the primary's. */
std::string cache_namespace(const std::string& model_version, bool used_fallback) {
  return used_fallback ? model_version + "+fallback" : model_version;
}

std::vector<float> checked(const std::vector<float>& vector, int expected) {
  if (vector.size() != expected) throw std::runtime_error("wrong embedding dimension");
  return vector;
}

/** Calls the model server under a deadline and falls over to the fallback model. */
Embedding embed(Model::Stub* primary, Model::Stub* fallback_stub, const std::string& text, const std::string& modelVersion) {
  grpc::Status lastStatus;
  for (int attempt = 0; attempt < kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
    EmbedRequest request;
    request.set_text(text);
    request.set_model_version(modelVersion);
    EmbedReply reply;
    const auto status = primary->Embed(&ctx, request, &reply);
    if (status.ok()) {
      return {cache_namespace(modelVersion, false), checked({reply.vector().begin(), reply.vector().end()}, kPrimaryDimension)};
    }
    lastStatus = status;
    if (kRetryable.count(status.error_code()) == 0) throw std::runtime_error(status.error_message());
  }
  grpc::ClientContext ctx;
  ctx.set_deadline(std::chrono::system_clock::now() + std::chrono::milliseconds(kDeadlineMs));
  EmbedRequest request;
  request.set_text(text);
  request.set_model_version(kFallbackModel);
  EmbedReply reply;
  if (!fallback_stub->Embed(&ctx, request, &reply).ok()) throw std::runtime_error(lastStatus.error_message());
  return {cache_namespace(kFallbackModel, true), checked({reply.vector().begin(), reply.vector().end()}, kFallbackDimension)};
}
`,
    },
  },
  debrief: `A deadline bounds one attempt, max attempts bound the call, and the retryable set decides which
failures are even worth another attempt. The fallback is business continuity — but only under its own
namespace, because a 384-dimension vector cached where 1024 is expected poisons every later lookup.`,
};
