import type {Step} from '@/lib/types';

export const dependencyStep: Step = {
  id: 'dependency',
  title: 'Model server calls: a deadline, one retry, and the right model',
  concept: 'grpc',
  guides: ['deadlines-and-retries', 'model-output'],
  file: 'client',
  focus: ['api', 'model'],
  task: `## Task

**Starting point.** The starter's \`embed(text, model_version)\` calls \`Embedder.Embed\`
(\`embedder.proto\`, served as a stand-in at \`MODEL_SERVER\`) and returns the reply's \`values\`. On
any \`RpcError\` it sleeps \`BACKOFF_S\` and tries again, up to \`MAX_ATTEMPTS = 5\`, then raises
\`EmbedError("unavailable")\`. It serves the demo and hides 4 flaws.

**Failure mode the checks target.** A model server that hangs and holds every request with it, an
outage turned into five times the load, a malformed input retried as if the server were at fault,
and a replica still on \`embed-v1\` whose vectors are returned as \`embed-v2\` ones.

- Every attempt carries a **2-second deadline** (\`DEADLINE_S\`).
- At most **2 attempts** (\`MAX_ATTEMPTS = 2\`), with a backoff between them, and only
  \`UNAVAILABLE\` earns the second one. Every other status raises \`EmbedError\` with the status name
  in lower case (\`deadline_exceeded\`, \`invalid_argument\`).
- The reply names the model that answered. A \`model_version\` other than the one asked for, or a
  vector whose length is not \`DIMENSIONS[model_version]\`, raises \`EmbedError("model_mismatch")\`.`,
  sequence: {
    participants: ['Embedding API', 'Model server'],
    messages: [
      {from: 'Embedding API', to: 'Model server', label: 'Embed(model_version, text) · deadline 2 s', kind: 'sync'},
      {from: 'Model server', to: 'Embedding API', label: 'UNAVAILABLE → backoff, attempt 2 of 2', kind: 'reply'},
      {
        from: 'Model server',
        to: 'Embedding API',
        label: 'INVALID_ARGUMENT / DEADLINE_EXCEEDED → EmbedError',
        kind: 'reply',
      },
      {from: 'Model server', to: 'Embedding API', label: '{model_version, values}', kind: 'reply'},
      {
        from: 'Embedding API',
        to: 'Embedding API',
        label: 'version and DIMENSIONS match, or model_mismatch',
        kind: 'sync',
      },
    ],
  },
  checks: [
    {
      id: 'healthy',
      title: 'Returns the model server’s vector',
      detail: 'One `Embed` call per input on a healthy model server, and its `values` are the vector.',
      match: {
        python: {all: [/stub\.Embed\(/]},
        typescript: {all: [/stub\.Embed\(/]},
        go: {all: [/stub\.Embed\(/]},
        scala: {all: [/\.embed\(\s*EmbedRequest\(/]},
        cpp: {all: [/stub->Embed\(/]},
      },
    },
    {
      id: 'deadline',
      title: 'Every attempt carries a 2-second deadline',
      detail: 'The call is made with a deadline (`timeout=DEADLINE_S`), so a hung model server is cut at 2 s.',
      match: {
        python: {all: [/timeout\s*=\s*DEADLINE_S/]},
        typescript: {all: [/deadline:\s*Date\.now\(\)\s*\+\s*DEADLINE_MS/]},
        go: {all: [/context\.WithTimeout\(/]},
        scala: {all: [/\.withDeadlineAfter\(/]},
        cpp: {all: [/\.set_deadline\(/]},
      },
    },
    {
      id: 'bounded-retry',
      title: 'Two attempts at most',
      detail: '`MAX_ATTEMPTS = 2`: a model server that stays `UNAVAILABLE` gets two calls, then `EmbedError`.',
      match: {
        python: {all: [/MAX_ATTEMPTS\s*=\s*2\b/]},
        typescript: {all: [/MAX_ATTEMPTS\s*=\s*2\b/]},
        go: {all: [/maxAttempts\s*=\s*2\b/]},
        scala: {all: [/MaxAttempts\s*=\s*2\b/]},
        cpp: {all: [/kMaxAttempts\s*=\s*2\b/]},
      },
    },
    {
      id: 'unavailable-only',
      title: 'Only UNAVAILABLE is retried',
      detail:
        'The retry is conditioned on the status `UNAVAILABLE`; `INVALID_ARGUMENT` and the rest raise after one call.',
      match: {
        python: {all: [/StatusCode\.UNAVAILABLE/]},
        typescript: {all: [/grpc\.status\.UNAVAILABLE/]},
        go: {all: [/codes\.Unavailable/]},
        scala: {all: [/Status\.Code\.UNAVAILABLE/]},
        cpp: {all: [/StatusCode::UNAVAILABLE/]},
      },
    },
    {
      id: 'model-check',
      title: 'Refuses a vector from another model',
      detail:
        'The reply’s `model_version` is compared with the one asked for and its length with `DIMENSIONS`; a mismatch raises `EmbedError("model_mismatch")`.',
      match: {
        python: {all: [/reply\.model_version\s*!=|!=\s*reply\.model_version/, /DIMENSIONS/, /model_mismatch/]},
        typescript: {all: [/reply\.model_version\s*!==|!==\s*reply\.model_version/, /DIMENSIONS\[/, /model_mismatch/]},
        go: {
          all: [/GetModelVersion\(\)\s*!=|!=\s*reply\.GetModelVersion\(\)/, /config\.Dimensions\[/, /model_mismatch/],
        },
        scala: {all: [/reply\.modelVersion\s*!=|!=\s*reply\.modelVersion/, /Config\.Dimensions/, /model_mismatch/]},
        cpp: {all: [/reply\.model_version\(\)\s*!=|!=\s*reply\.model_version\(\)/, /kDimensions/, /model_mismatch/]},
      },
    },
  ],
  code: {
    python: {
      starter: `import time

import grpc

import embedder_pb2
import embedder_pb2_grpc
from embedding.config import MODEL_SERVER, EmbedError

MAX_ATTEMPTS = 5
BACKOFF_S = 0.2

channel = grpc.insecure_channel(MODEL_SERVER)
stub = embedder_pb2_grpc.EmbedderStub(channel)


def embed(text: str, model_version: str) -> list[float]:
    """The model server's vector of text under model_version; EmbedError when there is no usable one."""
    # TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    for _attempt in range(MAX_ATTEMPTS):
        try:
            reply = stub.Embed(embedder_pb2.EmbedRequest(model_version=model_version, text=text))
        except grpc.RpcError:
            time.sleep(BACKOFF_S)
            continue
        return list(reply.values)
    raise EmbedError("unavailable")
`,
      solution: `import time

import grpc

import embedder_pb2
import embedder_pb2_grpc
from embedding.config import DIMENSIONS, MODEL_SERVER, EmbedError

DEADLINE_S = 2.0
MAX_ATTEMPTS = 2
BACKOFF_S = 0.2

channel = grpc.insecure_channel(MODEL_SERVER)
stub = embedder_pb2_grpc.EmbedderStub(channel)


def embed(text: str, model_version: str) -> list[float]:
    """The model server's vector of text under model_version; EmbedError when there is no usable one."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            reply = stub.Embed(embedder_pb2.EmbedRequest(model_version=model_version, text=text), timeout=DEADLINE_S)
        except grpc.RpcError as err:
            if err.code() == grpc.StatusCode.UNAVAILABLE and attempt < MAX_ATTEMPTS:
                time.sleep(BACKOFF_S * attempt)
                continue
            raise EmbedError(err.code().name.lower()) from err
        if reply.model_version != model_version or len(reply.values) != DIMENSIONS.get(model_version):
            raise EmbedError("model_mismatch")  # a replica on another model: its vector lives in another space
        return list(reply.values)
    raise EmbedError("unavailable")
`,
    },
    typescript: {
      starter: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {EmbedError, MODEL_SERVER} from 'embedding/config';

export const MAX_ATTEMPTS = 5;
export const BACKOFF_MS = 200;

interface EmbedReply {
  model_version: string;
  values: number[];
}
interface EmbedderClient {
  Embed(request: {model_version: string; text: string}, options?: {deadline: number}): Promise<EmbedReply>;
}

const {embedding} = grpc.loadPackageDefinition(protoLoader.loadSync('embedder.proto')) as unknown as {
  embedding: {Embedder: new (target: string, credentials: grpc.ChannelCredentials) => EmbedderClient};
};
const stub = new embedding.Embedder(MODEL_SERVER, grpc.credentials.createInsecure());

/** The model server's vector of text under modelVersion; EmbedError when there is no usable one. */
export async function embed(text: string, modelVersion: string): Promise<number[]> {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const reply = await stub.Embed({model_version: modelVersion, text});
      return reply.values;
    } catch {
      await sleep(BACKOFF_MS);
    }
  }
  throw new EmbedError('unavailable');
}
`,
      solution: `import {setTimeout as sleep} from 'node:timers/promises';

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

import {DIMENSIONS, EmbedError, MODEL_SERVER} from 'embedding/config';

export const DEADLINE_MS = 2_000;
export const MAX_ATTEMPTS = 2;
export const BACKOFF_MS = 200;

interface EmbedReply {
  model_version: string;
  values: number[];
}
interface EmbedderClient {
  Embed(request: {model_version: string; text: string}, options?: {deadline: number}): Promise<EmbedReply>;
}

const {embedding} = grpc.loadPackageDefinition(protoLoader.loadSync('embedder.proto')) as unknown as {
  embedding: {Embedder: new (target: string, credentials: grpc.ChannelCredentials) => EmbedderClient};
};
const stub = new embedding.Embedder(MODEL_SERVER, grpc.credentials.createInsecure());

/** The model server's vector of text under modelVersion; EmbedError when there is no usable one. */
export async function embed(text: string, modelVersion: string): Promise<number[]> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let reply: EmbedReply;
    try {
      reply = await stub.Embed({model_version: modelVersion, text}, {deadline: Date.now() + DEADLINE_MS});
    } catch (err) {
      const {code} = err as grpc.ServiceError;
      if (code === grpc.status.UNAVAILABLE && attempt < MAX_ATTEMPTS) {
        await sleep(BACKOFF_MS * attempt);
        continue;
      }
      const name = Object.keys(grpc.status).find(k => grpc.status[k as keyof typeof grpc.status] === code);
      throw new EmbedError((name ?? \`status_\${code}\`).toLowerCase());
    }
    if (reply.model_version !== modelVersion || reply.values.length !== DIMENSIONS[modelVersion]) {
      throw new EmbedError('model_mismatch'); // a replica on another model: its vector lives in another space
    }
    return reply.values;
  }
  throw new EmbedError('unavailable');
}
`,
    },
    go: {
      starter: `package main

import (
	"context"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	"embedding/config" // config.ModelServer, EmbedError — provided
	pb "embedding/gen/embedder"
)

const (
	maxAttempts = 5
	backoff     = 200 * time.Millisecond
)

var conn, _ = grpc.NewClient(config.ModelServer, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewEmbedderClient(conn)

// embed is the model server's vector of text under modelVersion; a *config.EmbedError when there is no usable one.
func embed(ctx context.Context, text, modelVersion string) ([]float32, error) {
	// TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		reply, err := stub.Embed(ctx, &pb.EmbedRequest{ModelVersion: modelVersion, Text: text})
		if err != nil {
			time.Sleep(backoff)
			continue
		}
		return reply.GetValues(), nil
	}
	return nil, &config.EmbedError{Reason: "unavailable"}
}
`,
      solution: `package main

import (
	"context"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"embedding/config" // config.ModelServer, Dimensions, EmbedError — provided
	pb "embedding/gen/embedder"
)

const (
	deadline    = 2 * time.Second
	maxAttempts = 2
	backoff     = 200 * time.Millisecond
)

var conn, _ = grpc.NewClient(config.ModelServer, grpc.WithTransportCredentials(insecure.NewCredentials()))
var stub = pb.NewEmbedderClient(conn)

// reasonOf names a status the way every language of the service does: unavailable, deadline_exceeded, invalid_argument.
func reasonOf(code codes.Code) string {
	switch code {
	case codes.DeadlineExceeded:
		return "deadline_exceeded"
	case codes.InvalidArgument:
		return "invalid_argument"
	default:
		return strings.ToLower(code.String())
	}
}

// embed is the model server's vector of text under modelVersion; a *config.EmbedError when there is no usable one.
func embed(ctx context.Context, text, modelVersion string) ([]float32, error) {
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, deadline)
		reply, err := stub.Embed(callCtx, &pb.EmbedRequest{ModelVersion: modelVersion, Text: text})
		cancel()
		if err != nil {
			code := status.Code(err)
			if code == codes.Unavailable && attempt < maxAttempts {
				time.Sleep(backoff * time.Duration(attempt))
				continue
			}
			return nil, &config.EmbedError{Reason: reasonOf(code)}
		}
		if reply.GetModelVersion() != modelVersion || len(reply.GetValues()) != config.Dimensions[modelVersion] {
			// A replica on another model: its vector lives in another space.
			return nil, &config.EmbedError{Reason: "model_mismatch"}
		}
		return reply.GetValues(), nil
	}
	return nil, &config.EmbedError{Reason: "unavailable"}
}
`,
    },
    scala: {
      starter: `import io.grpc.{ManagedChannelBuilder, StatusRuntimeException}

import embedding.{Config, EmbedError}
import embedding.embedder.{EmbedRequest, EmbedderGrpc}

object ModelClient {
  val MaxAttempts = 5
  val BackoffMs = 200L

  private val channel = ManagedChannelBuilder.forTarget(Config.ModelServer).usePlaintext().build()
  private val stub = EmbedderGrpc.blockingStub(channel)

  /** The model server's vector of text under modelVersion; EmbedError when there is no usable one. */
  def embed(text: String, modelVersion: String): Seq[Float] = {
    // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
    var attempt = 1
    while (attempt <= MaxAttempts) {
      try {
        return stub.embed(EmbedRequest(modelVersion = modelVersion, text = text)).values
      } catch {
        case _: StatusRuntimeException =>
          Thread.sleep(BackoffMs)
          attempt += 1
      }
    }
    throw EmbedError("unavailable")
  }
}
`,
      solution: `import java.util.concurrent.TimeUnit

import io.grpc.{ManagedChannelBuilder, Status, StatusRuntimeException}

import embedding.{Config, EmbedError}
import embedding.embedder.{EmbedRequest, EmbedderGrpc}

object ModelClient {
  val DeadlineMs = 2000L
  val MaxAttempts = 2
  val BackoffMs = 200L

  private val channel = ManagedChannelBuilder.forTarget(Config.ModelServer).usePlaintext().build()
  private val stub = EmbedderGrpc.blockingStub(channel)

  /** The model server's vector of text under modelVersion; EmbedError when there is no usable one. */
  def embed(text: String, modelVersion: String): Seq[Float] = {
    var attempt = 1
    while (attempt <= MaxAttempts) {
      try {
        val reply = stub.withDeadlineAfter(DeadlineMs, TimeUnit.MILLISECONDS).embed(EmbedRequest(modelVersion = modelVersion, text = text))
        // A replica on another model: its vector lives in another space.
        if (reply.modelVersion != modelVersion || !Config.Dimensions.get(modelVersion).contains(reply.values.size))
          throw EmbedError("model_mismatch")
        return reply.values
      } catch {
        case e: StatusRuntimeException =>
          val code = e.getStatus.getCode
          if (code == Status.Code.UNAVAILABLE && attempt < MaxAttempts) {
            Thread.sleep(BackoffMs * attempt)
            attempt += 1
          } else throw EmbedError(code.name.toLowerCase)
      }
    }
    throw EmbedError("unavailable")
  }
}
`,
    },
    cpp: {
      starter: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>
#include <thread>
#include <vector>

#include "embedder.grpc.pb.h"
#include "embedding/config.h"  // config::kModelServer, EmbedError — provided

constexpr int kMaxAttempts = 5;
constexpr std::chrono::milliseconds kBackoff{200};

auto channel = grpc::CreateChannel(config::kModelServer, grpc::InsecureChannelCredentials());
auto stub = embedding::Embedder::NewStub(channel);

// The model server's vector of text under model_version; config::EmbedError when there is no usable one.
std::vector<float> embed(const std::string& text, const std::string& model_version) {
  // TODO: this starter has 4 flaws. The task says where to look; the checks say what must change.
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    embedding::EmbedRequest request;
    request.set_model_version(model_version);
    request.set_text(text);
    embedding::EmbedReply reply;
    if (!stub->Embed(&ctx, request, &reply).ok()) {
      std::this_thread::sleep_for(kBackoff);
      continue;
    }
    return {reply.values().begin(), reply.values().end()};
  }
  throw config::EmbedError("unavailable");
}
`,
      solution: `#include <grpcpp/grpcpp.h>

#include <chrono>
#include <string>
#include <thread>
#include <vector>

#include "embedder.grpc.pb.h"
#include "embedding/config.h"  // config::kModelServer, kDimensions, EmbedError — provided

constexpr std::chrono::seconds kDeadline{2};
constexpr int kMaxAttempts = 2;
constexpr std::chrono::milliseconds kBackoff{200};

auto channel = grpc::CreateChannel(config::kModelServer, grpc::InsecureChannelCredentials());
auto stub = embedding::Embedder::NewStub(channel);

// A status named the way every language of the service names it: unavailable, deadline_exceeded, invalid_argument.
std::string reasonOf(grpc::StatusCode code) {
  switch (code) {
    case grpc::StatusCode::UNAVAILABLE: return "unavailable";
    case grpc::StatusCode::DEADLINE_EXCEEDED: return "deadline_exceeded";
    case grpc::StatusCode::INVALID_ARGUMENT: return "invalid_argument";
    default: return "status_" + std::to_string(static_cast<int>(code));
  }
}

// The model server's vector of text under model_version; config::EmbedError when there is no usable one.
std::vector<float> embed(const std::string& text, const std::string& model_version) {
  for (int attempt = 1; attempt <= kMaxAttempts; attempt++) {
    grpc::ClientContext ctx;
    ctx.set_deadline(std::chrono::system_clock::now() + kDeadline);
    embedding::EmbedRequest request;
    request.set_model_version(model_version);
    request.set_text(text);
    embedding::EmbedReply reply;
    const grpc::Status status = stub->Embed(&ctx, request, &reply);
    if (!status.ok()) {
      if (status.error_code() == grpc::StatusCode::UNAVAILABLE && attempt < kMaxAttempts) {
        std::this_thread::sleep_for(kBackoff * attempt);
        continue;
      }
      throw config::EmbedError(reasonOf(status.error_code()));
    }
    const auto expected = config::kDimensions.find(model_version);
    if (reply.model_version() != model_version || expected == config::kDimensions.end() || reply.values_size() != expected->second)
      throw config::EmbedError("model_mismatch");  // a replica on another model: its vector lives in another space
    return {reply.values().begin(), reply.values().end()};
  }
  throw config::EmbedError("unavailable");
}
`,
    },
  },
  harness: {
    python: `import grpc

import embedder_pb2
import embedder_pb2_grpc
from embedding import model
from embedding.config import MODEL_SERVER, MODEL_VERSION, PREVIOUS_VERSION

TEXT = "Rotate keys every 90 days."


class ModelServer(embedder_pb2_grpc.EmbedderServicer):
    """The stand-in model server: answers from embedding.model; answer_as plays a replica on another model."""

    def __init__(self):
        self.answer_as = None
        self.truncate = None

    def Embed(self, request, context):
        version = self.answer_as or request.model_version
        values = model.vector_for(version, request.text)
        if self.truncate is not None:
            values = values[: self.truncate]
        return embedder_pb2.EmbedReply(model_version=version, values=values)


def _world(ctx):
    server = ModelServer()
    ctx.grpc.serve(embedder_pb2_grpc.add_EmbedderServicer_to_server, server, MODEL_SERVER)
    return ctx.load("client"), server


def _calls(ctx):
    return ctx.grpc.calls_to("Embed")


def _attempt(fn):
    """What fn returned, and the EmbedError it raised (None when it returned)."""
    try:
        return fn(), None
    except Exception as e:  # noqa: BLE001
        if type(e).__name__ != "EmbedError":
            raise AssertionError(f"embed raised {type(e).__name__}: {e}; a call that yields no vector raises EmbedError(reason)") from e
        return None, e


def check_healthy(ctx):
    m, _ = _world(ctx)
    got = m.embed(TEXT, MODEL_VERSION)
    assert got == model.vector_for(MODEL_VERSION, TEXT), f"embed must return the reply's values, got {got}"
    assert len(_calls(ctx)) == 1, f"a healthy model server is called once per input, saw {len(_calls(ctx))} Embed calls"


def check_deadline(ctx):
    m, _ = _world(ctx)
    m.embed(TEXT, MODEL_VERSION)
    timeout = _calls(ctx)[0].timeout
    assert timeout is not None, "the Embed call carries no deadline: a model server that hangs holds the request, and its worker, for as long as it hangs"
    assert 1.5 <= timeout <= 2.5, f"the deadline must be DEADLINE_S = 2 s, got {timeout} s"
    ctx.grpc.set_latency("Embed", 5.0, MODEL_SERVER)
    started = ctx.clock.offset
    value, err = _attempt(lambda: m.embed("Revoke a leaked key at once.", MODEL_VERSION))
    waited = ctx.clock.offset - started
    assert err is not None, f"a model server that takes 5 s answered after {waited:.1f} s and embed returned {value}: the deadline must cut the call at 2 s and raise EmbedError"
    assert waited <= 2.6, f"embed waited {waited:.1f} s on a hung model server: the deadline must cut it at about 2 s"
    assert len(_calls(ctx)) == 2, f"a call cut by its deadline is not retried: saw {len(_calls(ctx)) - 1} calls for it"


def check_bounded_retry(ctx):
    m, _ = _world(ctx)
    ctx.grpc.fail("Embed", grpc.StatusCode.UNAVAILABLE, "replica restarting", times=1, target=MODEL_SERVER)
    got = m.embed(TEXT, MODEL_VERSION)
    assert got == model.vector_for(MODEL_VERSION, TEXT) and len(_calls(ctx)) == 2, f"one UNAVAILABLE earns one retry: expected 2 calls and the vector, saw {len(_calls(ctx))} calls and {got}"
    assert ctx.clock.sleeps >= 1, "a retry waits a backoff before the second attempt"
    ctx.grpc.fail("Embed", grpc.StatusCode.UNAVAILABLE, "model server down", times=5, target=MODEL_SERVER)
    value, err = _attempt(lambda: m.embed("Audit key use weekly.", MODEL_VERSION))
    calls = len(_calls(ctx)) - 2
    assert calls == 2, f"a model server that stays UNAVAILABLE gets MAX_ATTEMPTS = 2 calls, then EmbedError: saw {calls} calls, each one more load on a server that is already down"
    assert err is not None, f"after its attempts embed must raise EmbedError, it returned {value}"


def check_unavailable_only(ctx):
    m, _ = _world(ctx)
    ctx.grpc.fail("Embed", grpc.StatusCode.INVALID_ARGUMENT, "input is empty", times=5, target=MODEL_SERVER)
    value, err = _attempt(lambda: m.embed("", MODEL_VERSION))
    assert len(_calls(ctx)) == 1, f"INVALID_ARGUMENT is the input's fault and a retry cannot fix it, yet embed called Embed {len(_calls(ctx))} times"
    assert err is not None, f"an INVALID_ARGUMENT must raise EmbedError, embed returned {value}"
    assert err.reason == "invalid_argument", f"the EmbedError must name the status (invalid_argument), got {err.reason!r}"


def check_model_check(ctx):
    m, server = _world(ctx)
    server.answer_as = PREVIOUS_VERSION
    value, err = _attempt(lambda: m.embed(TEXT, MODEL_VERSION))
    assert err is not None, f"a replica still on {PREVIOUS_VERSION} answered an {MODEL_VERSION} request and embed returned its vector {value}: it would be cached and ranked as an {MODEL_VERSION} vector"
    assert err.reason == "model_mismatch", f"the EmbedError must be model_mismatch, got {err.reason!r}"
    server.answer_as, server.truncate = None, 4
    value, err = _attempt(lambda: m.embed(TEXT, MODEL_VERSION))
    assert err is not None and err.reason == "model_mismatch", f"a reply that says {MODEL_VERSION} but carries 4 values must raise EmbedError('model_mismatch'), embed returned {value}"
    server.truncate = None
    assert m.embed(TEXT, MODEL_VERSION) == model.vector_for(MODEL_VERSION, TEXT), "a matching reply is returned"
`,
    typescript: `const TEXT = 'Rotate keys every 90 days.';

/** The stand-in model server at MODEL_SERVER (answerAs plays a replica on another model) and the learner's module. */
function world(ctx) {
  const {embedding} = ctx.proto('embedder.proto');
  const config = ctx.load('/support/embedding/config.ts');
  const model = ctx.load('/support/embedding/model.ts');
  const server = {answerAs: null as string | null, truncate: null as number | null};
  ctx.grpc.serve(embedding.Embedder.service, {
    Embed(call, callback) {
      const version = server.answerAs ?? call.request.model_version;
      let values = model.vectorFor(version, call.request.text);
      if (server.truncate !== null) values = values.slice(0, server.truncate);
      callback(null, {model_version: version, values});
    },
  }, config.MODEL_SERVER);
  return {m: ctx.load('client'), server, config, model};
}

const calls = ctx => ctx.grpc.callsTo('Embed');

/** What the promise resolved to, and the EmbedError it rejected with (null when it resolved). */
async function attempt(promise: Promise<number[]>) {
  try {
    return {value: await promise, err: null};
  } catch (e) {
    assert((e as Error)?.name === 'EmbedError', \`embed rejected with \${e}; a call that yields no vector rejects with EmbedError(reason)\`);
    return {value: null, err: e as {reason: string}};
  }
}

export async function check_healthy(ctx) {
  const {m, config, model} = world(ctx);
  const got = await m.embed(TEXT, config.MODEL_VERSION);
  assert.deepEqual(got, model.vectorFor(config.MODEL_VERSION, TEXT), \`embed must resolve to the reply's values, got \${JSON.stringify(got)}\`);
  assert.equal(calls(ctx).length, 1, \`a healthy model server is called once per input, saw \${calls(ctx).length} Embed calls\`);
}

export async function check_deadline(ctx) {
  const {m, config} = world(ctx);
  await m.embed(TEXT, config.MODEL_VERSION);
  const timeout = calls(ctx)[0].timeout;
  assert(timeout !== null, 'the Embed call carries no deadline: a model server that hangs holds the request, and its worker, for as long as it hangs');
  assert(1.5 <= timeout && timeout <= 2.5, \`the deadline must be DEADLINE_MS = 2000 ms, got \${timeout} s\`);
  ctx.grpc.setLatency('Embed', 5.0, config.MODEL_SERVER);
  const started = ctx.clock.now();
  const {value, err} = await attempt(m.embed('Revoke a leaked key at once.', config.MODEL_VERSION));
  const waited = (ctx.clock.now() - started) / 1000;
  assert(err !== null, \`a model server that takes 5 s answered after \${waited.toFixed(1)} s and embed resolved to \${JSON.stringify(value)}: the deadline must cut the call at 2 s and reject with EmbedError\`);
  assert(waited <= 2.6, \`embed waited \${waited.toFixed(1)} s on a hung model server: the deadline must cut it at about 2 s\`);
  assert.equal(calls(ctx).length, 2, \`a call cut by its deadline is not retried: saw \${calls(ctx).length - 1} calls for it\`);
}

export async function check_bounded_retry(ctx) {
  const {m, config, model} = world(ctx);
  ctx.grpc.fail('Embed', ctx.grpc.status.UNAVAILABLE, 'replica restarting', 1, config.MODEL_SERVER);
  const got = await m.embed(TEXT, config.MODEL_VERSION);
  assert(JSON.stringify(got) === JSON.stringify(model.vectorFor(config.MODEL_VERSION, TEXT)) && calls(ctx).length === 2, \`one UNAVAILABLE earns one retry: expected 2 calls and the vector, saw \${calls(ctx).length} calls and \${JSON.stringify(got)}\`);
  assert(ctx.clock.sleeps >= 1, 'a retry waits a backoff before the second attempt');
  ctx.grpc.fail('Embed', ctx.grpc.status.UNAVAILABLE, 'model server down', 5, config.MODEL_SERVER);
  const {value, err} = await attempt(m.embed('Audit key use weekly.', config.MODEL_VERSION));
  const n = calls(ctx).length - 2;
  assert.equal(n, 2, \`a model server that stays UNAVAILABLE gets MAX_ATTEMPTS = 2 calls, then EmbedError: saw \${n} calls, each one more load on a server that is already down\`);
  assert(err !== null, \`after its attempts embed must reject with EmbedError, it resolved to \${JSON.stringify(value)}\`);
}

export async function check_unavailable_only(ctx) {
  const {m, config} = world(ctx);
  ctx.grpc.fail('Embed', ctx.grpc.status.INVALID_ARGUMENT, 'input is empty', 5, config.MODEL_SERVER);
  const {value, err} = await attempt(m.embed('', config.MODEL_VERSION));
  assert.equal(calls(ctx).length, 1, \`INVALID_ARGUMENT is the input's fault and a retry cannot fix it, yet embed called Embed \${calls(ctx).length} times\`);
  assert(err !== null, \`an INVALID_ARGUMENT must reject with EmbedError, embed resolved to \${JSON.stringify(value)}\`);
  assert.equal(err.reason, 'invalid_argument', \`the EmbedError must name the status (invalid_argument), got \${err.reason}\`);
}

export async function check_model_check(ctx) {
  const {m, server, config, model} = world(ctx);
  server.answerAs = config.PREVIOUS_VERSION;
  let r = await attempt(m.embed(TEXT, config.MODEL_VERSION));
  assert(r.err !== null, \`a replica still on embed-v1 answered an embed-v2 request and embed resolved to its vector \${JSON.stringify(r.value)}: it would be cached and ranked as an embed-v2 vector\`);
  assert.equal(r.err.reason, 'model_mismatch', \`the EmbedError must be model_mismatch, got \${r.err.reason}\`);
  server.answerAs = null;
  server.truncate = 4;
  r = await attempt(m.embed(TEXT, config.MODEL_VERSION));
  assert(r.err !== null && r.err.reason === 'model_mismatch', \`a reply that says embed-v2 but carries 4 values must reject with EmbedError('model_mismatch'), embed resolved to \${JSON.stringify(r.value)}\`);
  server.truncate = null;
  assert.deepEqual(await m.embed(TEXT, config.MODEL_VERSION), model.vectorFor(config.MODEL_VERSION, TEXT), 'a matching reply is returned');
}
`,
    go: `package main

import (
	"context"
	"errors"
	"time"

	"google.golang.org/grpc/codes"

	"embedding/config"
	pb "embedding/gen/embedder"
	"embedding/model"

	"leetbuild/harness"
)

const clientText = "Rotate keys every 90 days."

// clientPeer is the stand-in model server: answers from embedding/model; answerAs plays a replica on another model.
type clientPeer struct {
	pb.UnimplementedEmbedderServer
	answerAs string
	truncate int
}

func (p *clientPeer) Embed(_ context.Context, req *pb.EmbedRequest) (*pb.EmbedReply, error) {
	version := req.GetModelVersion()
	if p.answerAs != "" {
		version = p.answerAs
	}
	values := model.VectorFor(version, req.GetText())
	if p.truncate > 0 && p.truncate < len(values) {
		values = values[:p.truncate]
	}
	return &pb.EmbedReply{ModelVersion: version, Values: values}, nil
}

func clientWorld(ctx *harness.Ctx) *clientPeer {
	peer := &clientPeer{}
	pb.RegisterEmbedderServer(ctx.GRPC.Server(config.ModelServer), peer)
	return peer
}

// clientAttempt is what embed returned and the *config.EmbedError it failed with (nil when it returned a vector).
func clientAttempt(ctx *harness.Ctx, text string) ([]float32, *config.EmbedError) {
	got, err := embed(context.Background(), text, config.ModelVersion)
	if err == nil {
		return got, nil
	}
	var embedErr *config.EmbedError
	ctx.Assert(errors.As(err, &embedErr), "embed failed with %v; a call that yields no vector returns a *config.EmbedError", err)
	return got, embedErr
}

func CheckHealthy(ctx *harness.Ctx) {
	clientWorld(ctx)
	got, err := clientAttempt(ctx, clientText)
	ctx.Assert(err == nil, "a healthy model server answered and embed failed: %v", err)
	ctx.Equal(got, model.VectorFor(config.ModelVersion, clientText), "embed must return the reply's values")
	ctx.Equal(len(ctx.GRPC.CallsTo("Embed", "")), 1, "a healthy model server is called once per input; Embed calls")
}

func CheckDeadline(ctx *harness.Ctx) {
	clientWorld(ctx)
	clientAttempt(ctx, clientText)
	calls := ctx.GRPC.CallsTo("Embed", "")
	ctx.Assert(len(calls) == 1 && calls[0].HasDeadline(), "the Embed call carries no deadline: a model server that hangs holds the request, and its worker, for as long as it hangs")
	ctx.Assert(1500*time.Millisecond <= calls[0].Timeout && calls[0].Timeout <= 2500*time.Millisecond, "the deadline must be 2 s, got %v", calls[0].Timeout)
	ctx.GRPC.SetLatency("Embed", 5.0, config.ModelServer)
	started := ctx.Clock.Now()
	got, err := clientAttempt(ctx, "Revoke a leaked key at once.")
	waited := float64(ctx.Clock.Now()-started) / 1000
	ctx.Assert(err != nil, "a model server that takes 5 s answered after %.1f s and embed returned %v: the deadline must cut the call at 2 s and return an EmbedError", waited, got)
	ctx.Assert(waited <= 2.6, "embed waited %.1f s on a hung model server: the deadline must cut it at about 2 s", waited)
	ctx.Equal(len(ctx.GRPC.CallsTo("Embed", "")), 2, "a call cut by its deadline is not retried; Embed calls so far")
}

func CheckBoundedRetry(ctx *harness.Ctx) {
	clientWorld(ctx)
	ctx.GRPC.Fail("Embed", codes.Unavailable, "replica restarting", 1, config.ModelServer)
	got, err := clientAttempt(ctx, clientText)
	ctx.Assert(err == nil && len(ctx.GRPC.CallsTo("Embed", "")) == 2, "one UNAVAILABLE earns one retry: expected 2 calls and the vector, saw %d calls and %v (%v)", len(ctx.GRPC.CallsTo("Embed", "")), got, err)
	ctx.Assert(ctx.Clock.Sleeps() >= 1, "a retry waits a backoff before the second attempt")
	ctx.GRPC.Fail("Embed", codes.Unavailable, "model server down", 5, config.ModelServer)
	got, err = clientAttempt(ctx, "Audit key use weekly.")
	n := len(ctx.GRPC.CallsTo("Embed", "")) - 2
	ctx.Assert(n == 2, "a model server that stays UNAVAILABLE gets maxAttempts = 2 calls, then an EmbedError: saw %d calls, each one more load on a server that is already down", n)
	ctx.Assert(err != nil, "after its attempts embed must return an EmbedError, it returned %v", got)
}

func CheckUnavailableOnly(ctx *harness.Ctx) {
	clientWorld(ctx)
	ctx.GRPC.Fail("Embed", codes.InvalidArgument, "input is empty", 5, config.ModelServer)
	got, err := clientAttempt(ctx, "")
	n := len(ctx.GRPC.CallsTo("Embed", ""))
	ctx.Assert(n == 1, "INVALID_ARGUMENT is the input's fault and a retry cannot fix it, yet embed called Embed %d times", n)
	ctx.Assert(err != nil, "an INVALID_ARGUMENT must return an EmbedError, embed returned %v", got)
	ctx.Equal(err.Reason, "invalid_argument", "the EmbedError must name the status")
}

func CheckModelCheck(ctx *harness.Ctx) {
	peer := clientWorld(ctx)
	peer.answerAs = config.PreviousVersion
	got, err := clientAttempt(ctx, clientText)
	ctx.Assert(err != nil, "a replica still on embed-v1 answered an embed-v2 request and embed returned its vector %v: it would be cached and ranked as an embed-v2 vector", got)
	ctx.Equal(err.Reason, "model_mismatch", "the EmbedError's reason")
	peer.answerAs, peer.truncate = "", 4
	got, err = clientAttempt(ctx, clientText)
	ctx.Assert(err != nil && err.Reason == "model_mismatch", "a reply that says embed-v2 but carries 4 values must return EmbedError{model_mismatch}, embed returned %v", got)
	peer.truncate = 0
	got, err = clientAttempt(ctx, clientText)
	ctx.Assert(err == nil, "a matching reply is returned, embed failed: %v", err)
	ctx.Equal(got, model.VectorFor(config.ModelVersion, clientText), "a matching reply is returned")
}
`,
    cpp: `#include <leetbuild/harness.h>

#include <exception>
#include <optional>
#include <string>
#include <vector>

#include "embedder.grpc.pb.h"
#include "embedding/config.h"
#include "embedding/model.h"

namespace {

const std::string kText = "Rotate keys every 90 days.";

// The stand-in model server: answers from embedding/model.h; answer_as plays a replica on another model.
class ModelPeer final : public embedding::Embedder::Service {
 public:
  std::string answer_as;
  int truncate = 0;

  grpc::Status Embed(grpc::ServerContext*, const embedding::EmbedRequest* req, embedding::EmbedReply* reply) override {
    const std::string version = answer_as.empty() ? req->model_version() : answer_as;
    std::vector<float> values = model::vectorFor(version, req->text());
    if (truncate > 0 && truncate < static_cast<int>(values.size())) values.resize(truncate);
    reply->set_model_version(version);
    for (float v : values) reply->add_values(v);
    return grpc::Status::OK;
  }
};

ModelPeer& clientWorld(harness::Ctx& ctx) {
  static ModelPeer* peer = nullptr;
  delete peer;
  peer = new ModelPeer;
  ctx.GRPC.Server(config::kModelServer)->RegisterService(peer);
  return *peer;
}

// What embed returned, and the EmbedError's reason when it threw one.
struct Attempt {
  std::vector<float> value;
  std::optional<std::string> reason;
};

Attempt clientAttempt(harness::Ctx& ctx, const std::string& text) {
  try {
    return {embed(text, config::kModelVersion), std::nullopt};
  } catch (const config::EmbedError& e) {
    return {{}, e.reason};
  } catch (const std::exception& e) {
    ctx.Fatalf("embed threw %s; a call that yields no vector throws config::EmbedError(reason)", e.what());
  }
  return {};
}

size_t calls(harness::Ctx& ctx) { return ctx.GRPC.CallsTo("Embed").size(); }

}  // namespace

void CheckHealthy(harness::Ctx& ctx) {
  clientWorld(ctx);
  const Attempt a = clientAttempt(ctx, kText);
  ctx.Assert(!a.reason, "a healthy model server answered and embed threw %s", a.reason.value_or(""));
  ctx.Equal(a.value, model::vectorFor(config::kModelVersion, kText), "embed must return the reply's values");
  ctx.Equal(calls(ctx), 1, "a healthy model server is called once per input; Embed calls");
}

void CheckDeadline(harness::Ctx& ctx) {
  clientWorld(ctx);
  clientAttempt(ctx, kText);
  const auto first = ctx.GRPC.CallsTo("Embed");
  ctx.Assert(first.size() == 1 && first[0].HasDeadline(), "the Embed call carries no deadline: a model server that hangs holds the request, and its worker, for as long as it hangs");
  ctx.Assert(1.5 <= first[0].TimeoutSeconds() && first[0].TimeoutSeconds() <= 2.5, "the deadline must be 2 s, got %vs", first[0].TimeoutSeconds());
  ctx.GRPC.SetLatency("Embed", 5.0, config::kModelServer);
  const int64_t started = ctx.Clock.Now();
  const Attempt a = clientAttempt(ctx, "Revoke a leaked key at once.");
  const double waited = static_cast<double>(ctx.Clock.Now() - started) / 1000;
  ctx.Assert(a.reason.has_value(), "a model server that takes 5 s answered after %.1f s and embed returned %v: the deadline must cut the call at 2 s and throw EmbedError", waited, a.value);
  ctx.Assert(waited <= 2.6, "embed waited %.1f s on a hung model server: the deadline must cut it at about 2 s", waited);
  ctx.Equal(calls(ctx), 2, "a call cut by its deadline is not retried; Embed calls so far");
}

void CheckBoundedRetry(harness::Ctx& ctx) {
  clientWorld(ctx);
  ctx.GRPC.Fail("Embed", grpc::StatusCode::UNAVAILABLE, "replica restarting", 1, config::kModelServer);
  Attempt a = clientAttempt(ctx, kText);
  ctx.Assert(!a.reason && calls(ctx) == 2, "one UNAVAILABLE earns one retry: expected 2 calls and the vector, saw %d calls (%s)", calls(ctx), a.reason.value_or("a vector"));
  ctx.Assert(ctx.Clock.Sleeps() >= 1, "a retry waits a backoff before the second attempt");
  ctx.GRPC.Fail("Embed", grpc::StatusCode::UNAVAILABLE, "model server down", 5, config::kModelServer);
  a = clientAttempt(ctx, "Audit key use weekly.");
  const size_t n = calls(ctx) - 2;
  ctx.Assert(n == 2, "a model server that stays UNAVAILABLE gets kMaxAttempts = 2 calls, then EmbedError: saw %d calls, each one more load on a server that is already down", n);
  ctx.Assert(a.reason.has_value(), "after its attempts embed must throw EmbedError, it returned %v", a.value);
}

void CheckUnavailableOnly(harness::Ctx& ctx) {
  clientWorld(ctx);
  ctx.GRPC.Fail("Embed", grpc::StatusCode::INVALID_ARGUMENT, "input is empty", 5, config::kModelServer);
  const Attempt a = clientAttempt(ctx, "");
  ctx.Assert(calls(ctx) == 1, "INVALID_ARGUMENT is the input's fault and a retry cannot fix it, yet embed called Embed %d times", calls(ctx));
  ctx.Assert(a.reason.has_value(), "an INVALID_ARGUMENT must throw EmbedError, embed returned %v", a.value);
  ctx.Equal(a.reason.value_or(""), "invalid_argument", "the EmbedError must name the status");
}

void CheckModelCheck(harness::Ctx& ctx) {
  ModelPeer& peer = clientWorld(ctx);
  peer.answer_as = config::kPreviousVersion;
  Attempt a = clientAttempt(ctx, kText);
  ctx.Assert(a.reason.has_value(), "a replica still on embed-v1 answered an embed-v2 request and embed returned its vector %v: it would be cached and ranked as an embed-v2 vector", a.value);
  ctx.Equal(a.reason.value_or(""), "model_mismatch", "the EmbedError's reason");
  peer.answer_as = "";
  peer.truncate = 4;
  a = clientAttempt(ctx, kText);
  ctx.Assert(a.reason.value_or("") == "model_mismatch", "a reply that says embed-v2 but carries 4 values must throw EmbedError(model_mismatch), embed returned %v", a.value);
  peer.truncate = 0;
  a = clientAttempt(ctx, kText);
  ctx.Assert(!a.reason, "a matching reply is returned, embed threw %s", a.reason.value_or(""));
  ctx.Equal(a.value, model::vectorFor(config::kModelVersion, kText), "a matching reply is returned");
}
`,
  },
  hints: [
    'When the model server stalls, requests pile up until the API runs out of workers; during an outage it sees five times the traffic; and after a rollout some vectors come back with four values.',
    'The call has no deadline, so it waits as long as the server does. The loop retries every `RpcError` five times, a bad input included. Nothing compares the reply’s `model_version` or length with what was asked.',
    'Pass `timeout=DEADLINE_S`; retry only when `err.code() == grpc.StatusCode.UNAVAILABLE` and `attempt < MAX_ATTEMPTS` (2), else raise `EmbedError(code.name.lower())`; raise `EmbedError("model_mismatch")` when the version or `DIMENSIONS` length differs.',
  ],
  debrief: `The shape comes from sorting what the model server can say. \`UNAVAILABLE\` is the server’s problem and may clear in a moment, so it earns one more try after a pause; \`INVALID_ARGUMENT\` is the input’s problem and a retry only repeats it; a deadline turns a hang into an error the caller can act on. The version check is the one a cache cannot do later: once a vector from the wrong model is stored under \`embed-v2\`, nothing about its bytes marks it as wrong, and retrieval quietly ranks it against vectors from another space. Production clients add a circuit breaker per replica, hedged requests on a slow tail, and batching of inputs into one call.`,
};
